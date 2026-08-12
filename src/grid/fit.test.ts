import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOUNDS,
  ROW_H_MIN,
  STRIP_H,
  addFold,
  adoptBounds,
  computeBounds,
  computeFit,
  eventSpan,
  foldAt,
  isFolded,
  normalizeFolds,
  rawBounds,
  removeFoldAt,
  timeToY,
  widen,
  yToTime,
  type FitEvent,
} from "./fit";

/** Local wall clock on a fixed weekday, which is the only clock the fit engine reads. */
const at = (hour: number, minute = 0, day = 5) =>
  new Date(2026, 0, day, hour, minute, 0, 0).getTime();

const ev = (
  from: [number, number],
  to: [number, number],
  extra: Partial<FitEvent> = {},
): FitEvent => ({
  startMs: at(from[0], from[1]),
  endMs: at(to[0], to[1]),
  ...extra,
});

describe("eventSpan", () => {
  it("ignores all-day events, which live in their own band", () => {
    expect(eventSpan([ev([9, 0], [10, 0], { allDay: true })])).toBeNull();
    expect(eventSpan([])).toBeNull();
  });

  it("takes the earliest start and the latest end", () => {
    const span = eventSpan([ev([13, 30], [14, 0]), ev([9, 15], [10, 0]), ev([11, 0], [16, 45])]);
    expect(span).toEqual({ lo: 9 * 60 + 15, hi: 16 * 60 + 45 });
  });

  it("reads an event ending at midnight as ending at 24:00 the day before", () => {
    expect(eventSpan([{ startMs: at(22, 0), endMs: at(0, 0, 6) }])).toEqual({
      lo: 22 * 60,
      hi: 1440,
    });
  });

  it("opens the whole day for an event that crosses midnight", () => {
    expect(eventSpan([{ startMs: at(22, 0), endMs: at(2, 0, 6) }])).toEqual({ lo: 0, hi: 1440 });
  });

  it("keeps a zero-length event as a point", () => {
    expect(eventSpan([ev([9, 30], [9, 30])])).toEqual({ lo: 570, hi: 570 });
  });
});

describe("rawBounds", () => {
  it("floors an hour below the earliest start and ceils one above the latest end", () => {
    expect(rawBounds([ev([10, 15], [17, 5])])).toEqual({ start: 9, end: 19 });
  });

  it("widens a short day symmetrically to the eight hour minimum", () => {
    // 10:00 to 14:00 pads to 9..15, six hours, so one hour goes on each end.
    expect(rawBounds([ev([10, 0], [14, 0])])).toEqual({ start: 8, end: 16 });
    expect(widen(11, 15)).toEqual({ start: 9, end: 17 });
    expect(widen(12, 12)).toEqual({ start: 8, end: 16 });
  });

  it("gives an odd hour to the later end", () => {
    expect(widen(11, 14)).toEqual({ start: 9, end: 17 });
  });

  it("clamps at midnight and pushes the widening into the other end", () => {
    expect(rawBounds([ev([0, 10], [0, 30])])).toEqual({ start: 0, end: 8 });
    expect(rawBounds([ev([23, 0], [23, 59])])).toEqual({ start: 16, end: 24 });
  });

  it("never runs past either end of the day", () => {
    const full = rawBounds([{ startMs: at(22, 0), endMs: at(2, 0, 6) }]);
    expect(full).toEqual({ start: 0, end: 24 });
    expect(widen(-5, 30)).toEqual({ start: 0, end: 24 });
  });

  it("is null with nothing visible", () => {
    expect(rawBounds([])).toBeNull();
  });
});

describe("adoptBounds", () => {
  const previous = { start: 8, end: 20 };

  it("adopts an expansion immediately", () => {
    expect(adoptBounds(previous, { start: 7, end: 20 })).toEqual({ start: 7, end: 20 });
    expect(adoptBounds(previous, { start: 8, end: 22 })).toEqual({ start: 8, end: 22 });
    expect(adoptBounds(previous, { start: 6, end: 23 })).toEqual({ start: 6, end: 23 });
  });

  it("rejects a one hour contraction", () => {
    expect(adoptBounds(previous, { start: 9, end: 20 })).toEqual(previous);
    expect(adoptBounds(previous, { start: 8, end: 19 })).toEqual(previous);
  });

  it("adopts a two hour contraction", () => {
    expect(adoptBounds(previous, { start: 10, end: 20 })).toEqual({ start: 10, end: 20 });
    expect(adoptBounds(previous, { start: 9, end: 19 })).toEqual({ start: 9, end: 19 });
  });

  it("keeps the growth and holds the trim when a pass does both", () => {
    // Grows an hour at the top, gives up one at the bottom: not worth a reflow.
    expect(adoptBounds(previous, { start: 7, end: 19 })).toEqual({ start: 7, end: 20 });
    // Same growth, but now the bottom gives up three hours, so take the new range whole.
    expect(adoptBounds(previous, { start: 7, end: 17 })).toEqual({ start: 7, end: 17 });
  });
});

describe("computeBounds", () => {
  it("falls back to the previous bounds on an empty span", () => {
    const previous = { start: 6, end: 21 };
    expect(computeBounds([], previous)).toEqual(previous);
    expect(computeBounds([ev([9, 0], [10, 0], { allDay: true })], previous)).toEqual(previous);
  });

  it("does not collapse to the default when a quiet week goes by", () => {
    let bounds = computeBounds([ev([9, 0], [17, 0])], DEFAULT_BOUNDS);
    expect(bounds).toEqual({ start: 8, end: 18 });
    for (let i = 0; i < 5; i++) bounds = computeBounds([], bounds);
    expect(bounds).toEqual({ start: 8, end: 18 });
  });

  it("holds still across a one hour wobble and moves on a real contraction", () => {
    const start = computeBounds([ev([9, 0], [17, 0])], DEFAULT_BOUNDS);
    expect(start).toEqual({ start: 8, end: 18 });
    const wobble = computeBounds([ev([10, 0], [17, 0])], start);
    expect(wobble).toEqual(start);
    const real = computeBounds([ev([12, 0], [14, 0])], start);
    expect(real).toEqual({ start: 9, end: 17 });
  });
});

describe("folds", () => {
  it("merges overlapping and touching ranges", () => {
    expect(
      normalizeFolds([
        { start: 14, end: 16 },
        { start: 9, end: 11 },
        { start: 10, end: 12 },
        { start: 12, end: 13 },
      ]),
    ).toEqual([
      { start: 9, end: 13 },
      { start: 14, end: 16 },
    ]);
  });

  it("drops empty and unusable ranges", () => {
    expect(
      normalizeFolds([
        { start: 10, end: 10 },
        { start: 12, end: 11 },
        { start: NaN, end: 4 },
      ]),
    ).toEqual([]);
  });

  it("adds and removes by the hour under the cursor", () => {
    const folds = addFold([{ start: 9, end: 11 }], { start: 14, end: 16 });
    expect(folds).toHaveLength(2);
    expect(foldAt(folds, 15)).toEqual({ start: 14, end: 16 });
    expect(foldAt(folds, 16)).toBeNull();
    expect(removeFoldAt(folds, 15)).toEqual([{ start: 9, end: 11 }]);
    expect(removeFoldAt(folds, 13)).toEqual(folds);
  });
});

describe("computeFit", () => {
  it("folds the bands outside the bounds into one strip at each end", () => {
    const layout = computeFit({ bounds: { start: 8, end: 20 }, viewportHeight: 600 });
    const strips = layout.segments.filter((s) => s.kind === "strip");
    expect(strips.map((s) => [s.start, s.end])).toEqual([
      [0, 480],
      [1200, 1440],
    ]);
    expect(layout.unfoldedHours).toBe(12);
    expect(layout.rowHeight).toBeCloseTo((600 - 2 * STRIP_H) / 12, 10);
    expect(layout.totalHeight).toBeCloseTo(600, 10);
    expect(layout.overflow).toBe(false);
  });

  it("drops the end strips when the bounds are the whole day", () => {
    const layout = computeFit({ bounds: { start: 0, end: 24 }, viewportHeight: 960 });
    expect(layout.segments).toHaveLength(1);
    expect(layout.rowHeight).toBe(40);
    expect(layout.totalHeight).toBe(960);
  });

  it("takes an interior fold out of the unfolded total and adds a strip", () => {
    const plain = computeFit({ bounds: { start: 8, end: 20 }, viewportHeight: 600 });
    const folded = computeFit({
      bounds: { start: 8, end: 20 },
      folds: [{ start: 12, end: 14 }],
      viewportHeight: 600,
    });

    expect(folded.unfoldedHours).toBe(plain.unfoldedHours - 2);
    expect(folded.segments.filter((s) => s.kind === "strip")).toHaveLength(3);
    expect(folded.rowHeight).toBeCloseTo((600 - 3 * STRIP_H) / 10, 10);
    expect(folded.rowHeight).toBeGreaterThan(plain.rowHeight);
    expect(folded.totalHeight).toBeCloseTo(600, 10);
    expect(folded.segments.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["strip", 0, 480],
      ["hours", 480, 720],
      ["strip", 720, 840],
      ["hours", 840, 1200],
      ["strip", 1200, 1440],
    ]);
  });

  it("clips a fold to the bounds and merges it into the end strip when it touches", () => {
    const layout = computeFit({
      bounds: { start: 8, end: 20 },
      folds: [{ start: 6, end: 10 }],
      viewportHeight: 600,
    });
    expect(layout.segments.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["strip", 0, 600],
      ["hours", 600, 1200],
      ["strip", 1200, 1440],
    ]);
    expect(layout.unfoldedHours).toBe(10);
  });

  it("ignores a fold that sits entirely outside the bounds", () => {
    const layout = computeFit({
      bounds: { start: 8, end: 20 },
      folds: [{ start: 2, end: 4 }],
      viewportHeight: 600,
    });
    expect(layout.segments.filter((s) => s.kind === "strip")).toHaveLength(2);
    expect(layout.unfoldedHours).toBe(12);
  });

  it("floors the row height and reports overflow on a short window", () => {
    const layout = computeFit({ bounds: { start: 0, end: 24 }, viewportHeight: 300 });
    expect(layout.rowHeight).toBe(ROW_H_MIN);
    expect(layout.totalHeight).toBe(24 * ROW_H_MIN);
    expect(layout.overflow).toBe(true);
  });

  it("survives a viewport shorter than the strips themselves", () => {
    const layout = computeFit({ bounds: { start: 8, end: 20 }, viewportHeight: 10 });
    expect(layout.rowHeight).toBe(ROW_H_MIN);
    expect(Number.isFinite(layout.totalHeight)).toBe(true);
    expect(layout.overflow).toBe(true);
  });

  it("does not blow up when a fold swallows the whole visible range", () => {
    const layout = computeFit({
      bounds: { start: 8, end: 20 },
      folds: [{ start: 8, end: 20 }],
      viewportHeight: 600,
    });
    expect(layout.unfoldedHours).toBe(0);
    expect(layout.segments).toEqual([
      { kind: "strip", start: 0, end: 1440, y: 0, height: STRIP_H },
    ]);
    expect(layout.rowHeight).toBe(ROW_H_MIN);
    expect(layout.totalHeight).toBe(STRIP_H);
    expect(layout.overflow).toBe(false);
    expect(timeToY(layout, 600)).toBe(0);
    expect(yToTime(layout, 10)).toBe(0);
  });

  it("derives its bounds from the events when none are pinned", () => {
    const layout = computeFit({
      events: [ev([9, 30], [10, 0]), ev([15, 0], [16, 30])],
      previous: DEFAULT_BOUNDS,
      viewportHeight: 800,
    });
    expect(layout.bounds).toEqual({ start: 8, end: 18 });
  });
});

describe("timeToY and yToTime", () => {
  const layout = computeFit({
    bounds: { start: 8, end: 20 },
    folds: [{ start: 12, end: 14 }],
    viewportHeight: 723,
  });

  const unfolded = (minutes: number) =>
    layout.segments.some((s) => s.kind === "hours" && minutes >= s.start && minutes < s.end);

  it("is an exact inverse everywhere the scale is linear", () => {
    for (let m = 0; m <= 1440; m += 1) {
      if (!unfolded(m)) continue;
      expect(yToTime(layout, timeToY(layout, m))).toBeCloseTo(m, 9);
    }
  });

  it("round trips fractional minutes too", () => {
    for (const m of [480.25, 600.5, 719.75, 840.1, 1199.9]) {
      expect(yToTime(layout, timeToY(layout, m))).toBeCloseTo(m, 9);
    }
  });

  it("round trips from pixels back to pixels", () => {
    for (let y = 0; y <= layout.totalHeight; y += 0.5) {
      const m = yToTime(layout, y);
      if (!unfolded(m)) continue;
      expect(timeToY(layout, m)).toBeCloseTo(y, 9);
    }
  });

  it("holds at the edge of every unfolded region", () => {
    for (const s of layout.segments) {
      if (s.kind !== "hours") continue;
      expect(timeToY(layout, s.start)).toBeCloseTo(s.y, 10);
      expect(yToTime(layout, timeToY(layout, s.start))).toBeCloseTo(s.start, 9);
      // The last minute belongs to the next segment, and both agree on the pixel.
      expect(timeToY(layout, s.end)).toBeCloseTo(s.y + s.height, 10);
      expect(yToTime(layout, timeToY(layout, s.end))).toBeCloseTo(s.end, 9);
    }
  });

  it("is linear inside an unfolded region, so twice as tall is twice as long", () => {
    const hour = timeToY(layout, 900) - timeToY(layout, 840);
    const twoHours = timeToY(layout, 960) - timeToY(layout, 840);
    expect(twoHours).toBeCloseTo(2 * hour, 9);
    expect(hour).toBeCloseTo(layout.rowHeight, 9);
  });

  it("collapses a time inside a folded band onto its strip", () => {
    const strip = layout.segments.filter((s) => s.kind === "strip")[1];
    expect(strip.start).toBe(720);
    expect(isFolded(layout, 750)).toBe(true);
    expect(timeToY(layout, 721)).toBe(strip.y);
    expect(timeToY(layout, 839)).toBe(strip.y);
    expect(yToTime(layout, strip.y + 10)).toBe(720);
  });

  it("never leaves the grid", () => {
    expect(timeToY(layout, -60)).toBe(0);
    expect(timeToY(layout, 0)).toBe(0);
    expect(timeToY(layout, 1440)).toBe(layout.totalHeight);
    expect(timeToY(layout, 5000)).toBe(layout.totalHeight);
    expect(yToTime(layout, -10)).toBe(0);
    expect(yToTime(layout, layout.totalHeight)).toBe(1440);
    expect(yToTime(layout, 1e6)).toBe(1440);
  });

  it("never goes backwards", () => {
    let last = -1;
    for (let m = 0; m <= 1440; m += 3) {
      const y = timeToY(layout, m);
      expect(y).toBeGreaterThanOrEqual(last);
      last = y;
    }
  });
});
