import { describe, expect, it } from "vitest";
import { MIN_SLOT_MS, packEvents, type Packed } from "./packing";

interface Ev {
  id: string;
  startMs: number;
  endMs: number;
}

const at = (hour: number, minute = 0) => new Date(2026, 0, 5, hour, minute, 0, 0).getTime();

const ev = (id: string, from: [number, number], to: [number, number]): Ev => ({
  id,
  startMs: at(from[0], from[1]),
  endMs: at(to[0], to[1]),
});

const byId = (packed: Packed<Ev>[]) => new Map(packed.map((p) => [p.event.id, p]));

/** Same rule the engine uses, so a zero-length event counts as colliding. */
const collides = (a: Ev, b: Ev) => {
  const ae = Math.max(a.endMs, a.startMs + MIN_SLOT_MS);
  const be = Math.max(b.endMs, b.startMs + MIN_SLOT_MS);
  return a.startMs < be && b.startMs < ae;
};

/** The invariant the whole model exists for: two events in the same minute never share a pixel. */
function expectNoVisualOverlap(packed: Packed<Ev>[]) {
  for (let i = 0; i < packed.length; i++) {
    for (let j = i + 1; j < packed.length; j++) {
      const a = packed[i];
      const b = packed[j];
      if (!collides(a.event, b.event)) continue;
      const apart = a.left + a.width <= b.left + 1e-9 || b.left + b.width <= a.left + 1e-9;
      expect(apart, `${a.event.id} and ${b.event.id} overlap in time and in space`).toBe(true);
    }
  }
}

function expectSane(packed: Packed<Ev>[]) {
  for (const p of packed) {
    expect(Number.isFinite(p.left)).toBe(true);
    expect(Number.isFinite(p.width)).toBe(true);
    expect(p.width).toBeGreaterThan(0);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left + p.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(p.span).toBeGreaterThanOrEqual(1);
    expect(p.columns).toBeGreaterThanOrEqual(1);
  }
  expectNoVisualOverlap(packed);
}

describe("packEvents", () => {
  it("gives a lone event the full width", () => {
    const packed = packEvents([ev("a", [9, 0], [10, 0])]);
    expect(packed).toHaveLength(1);
    expect(packed[0]).toMatchObject({ column: 0, span: 1, columns: 1, left: 0, width: 1 });
  });

  it("handles an empty day", () => {
    expect(packEvents([])).toEqual([]);
  });

  it("splits two fully overlapping events down the middle", () => {
    const packed = packEvents([ev("a", [9, 0], [10, 0]), ev("b", [9, 0], [10, 0])]);
    const by = byId(packed);
    expect(by.get("a")).toMatchObject({ left: 0, width: 0.5 });
    expect(by.get("b")).toMatchObject({ left: 0.5, width: 0.5 });
    expectSane(packed);
  });

  it("gives three mutually overlapping events a third each", () => {
    const packed = packEvents([
      ev("a", [9, 0], [10, 0]),
      ev("b", [9, 15], [10, 15]),
      ev("c", [9, 30], [10, 30]),
    ]);
    const by = byId(packed);
    for (const id of ["a", "b", "c"]) expect(by.get(id)?.width).toBeCloseTo(1 / 3, 12);
    expect(by.get("a")?.left).toBeCloseTo(0, 12);
    expect(by.get("b")?.left).toBeCloseTo(1 / 3, 12);
    expect(by.get("c")?.left).toBeCloseTo(2 / 3, 12);
    expectSane(packed);
  });

  it("keeps a chain in one cluster where A meets B and B meets C but A misses C", () => {
    const packed = packEvents([
      ev("a", [9, 0], [10, 0]),
      ev("b", [9, 30], [10, 30]),
      ev("c", [10, 15], [11, 0]),
    ]);
    const by = byId(packed);
    expect(new Set(packed.map((p) => p.cluster)).size).toBe(1);
    expect(by.get("a")?.columns).toBe(2);
    // A and C never collide, so they can share a column.
    expect(by.get("a")?.column).toBe(0);
    expect(by.get("c")?.column).toBe(0);
    expect(by.get("b")?.column).toBe(1);
    for (const id of ["a", "b", "c"]) expect(by.get(id)?.width).toBe(0.5);
    expectSane(packed);
  });

  it("gives non-overlapping events the full width and a cluster each", () => {
    const packed = packEvents([
      ev("a", [9, 0], [10, 0]),
      ev("b", [10, 0], [11, 0]),
      ev("c", [11, 0], [12, 0]),
    ]);
    expect(packed.map((p) => p.width)).toEqual([1, 1, 1]);
    expect(packed.map((p) => p.cluster)).toEqual([0, 1, 2]);
    expectSane(packed);
  });

  it("expands rightward so a brief collision still takes most of the width", () => {
    // A, B and C stack three deep early on. D only clips C, so it keeps the two free columns.
    const packed = packEvents([
      ev("a", [9, 0], [9, 20]),
      ev("b", [9, 5], [9, 25]),
      ev("c", [9, 10], [9, 30]),
      ev("d", [9, 25], [10, 30]),
    ]);
    const by = byId(packed);
    expect(by.get("d")).toMatchObject({ column: 0, span: 2, columns: 3 });
    expect(by.get("d")?.width).toBeCloseTo(2 / 3, 12);
    for (const id of ["a", "b", "c"]) expect(by.get(id)?.width).toBeCloseTo(1 / 3, 12);
    expectSane(packed);
  });

  it("lets a late event take the whole width when its columns are free for its whole run", () => {
    const packed = packEvents([
      ev("a", [9, 0], [9, 30]),
      ev("b", [9, 15], [10, 0]),
      ev("c", [9, 30], [10, 0]),
      ev("d", [10, 0], [11, 0]),
    ]);
    const by = byId(packed);
    // D starts a fresh cluster, so nothing constrains it.
    expect(by.get("d")).toMatchObject({ width: 1, columns: 1 });
    expectSane(packed);
  });

  it("puts the longer of two events that start together on the left", () => {
    const packed = packEvents([ev("short", [9, 0], [9, 30]), ev("long", [9, 0], [11, 0])]);
    const by = byId(packed);
    expect(by.get("long")?.column).toBe(0);
    expect(by.get("short")?.column).toBe(1);
    expect(packed.map((p) => p.event.id)).toEqual(["long", "short"]);
  });

  it("does not touch an event that ends exactly where the next begins", () => {
    const packed = packEvents([ev("a", [9, 0], [10, 0]), ev("b", [10, 0], [11, 0])]);
    expect(packed.every((p) => p.width === 1)).toBe(true);
  });

  it("gives a zero-length event a real block instead of NaN", () => {
    const packed = packEvents([ev("point", [9, 0], [9, 0]), ev("hour", [9, 0], [10, 0])]);
    const by = byId(packed);
    expect(by.get("point")?.width).toBe(0.5);
    expect(by.get("hour")?.width).toBe(0.5);
    expectSane(packed);
  });

  it("keeps identical events apart", () => {
    const packed = packEvents([
      ev("a", [9, 0], [9, 0]),
      ev("b", [9, 0], [9, 0]),
      ev("c", [9, 0], [9, 0]),
    ]);
    expect(packed.map((p) => p.width)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expectSane(packed);
  });

  it("survives a broken range", () => {
    const packed = packEvents([
      { id: "backwards", startMs: at(10, 0), endMs: at(9, 0) },
      { id: "nan", startMs: NaN, endMs: NaN },
    ]);
    expectSane(packed);
  });

  it("returns every event once, in start order", () => {
    const input = [
      ev("c", [11, 0], [12, 0]),
      ev("a", [9, 0], [10, 0]),
      ev("b", [9, 30], [10, 30]),
    ];
    const packed = packEvents(input);
    expect(packed.map((p) => p.event.id)).toEqual(["a", "b", "c"]);
  });

  it("holds its invariants on a messy day", () => {
    // A fixed LCG, so a failure is reproducible.
    let seed = 20260105;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let round = 0; round < 40; round++) {
      const events: Ev[] = [];
      for (let i = 0; i < 30; i++) {
        const start = Math.floor(rand() * 96) * 15;
        const length = Math.floor(rand() * 8) * 15;
        events.push({
          id: `e${i}`,
          startMs: at(0, 0) + start * 60_000,
          endMs: at(0, 0) + (start + length) * 60_000,
        });
      }
      const packed = packEvents(events);
      expect(packed).toHaveLength(events.length);
      expect(new Set(packed.map((p) => p.event.id)).size).toBe(events.length);
      expectSane(packed);
    }
  });
});
