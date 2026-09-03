import { describe, expect, it } from "vitest";
import type { Instance } from "../ipc";
import { bandAt, busyHours, heldHours, type Placed } from "./GridModel";

const at = (hour: number, minute = 0) => new Date(2026, 0, 5, hour, minute).getTime();

/** Only the times matter to the hour scan, so the instance behind them is left blank. */
const placed = (from: [number, number], to: [number, number]): Placed => ({
  instance: {} as Instance,
  id: `${from[0]}:${from[1]}`,
  startMs: at(...from),
  endMs: at(...to),
});

describe("busyHours", () => {
  it("marks every whole hour an event touches", () => {
    const busy = busyHours([placed([14, 30], [16, 0]), placed([16, 0], [16, 15])]);
    const hours = busy.flatMap((b, h) => (b ? [h] : []));
    expect(hours).toEqual([14, 15, 16]);
  });
});

describe("heldHours", () => {
  const items = [placed([9, 0], [9, 30])];
  const hours = (held: boolean[]) => held.flatMap((b, h) => (b ? [h] : []));

  it("is the busy hours plus the hour it is now", () => {
    expect(hours(heldHours(items, 1))).toEqual([1, 9]);
    expect(hours(heldHours(items, 9))).toEqual([9]);
  });

  it("is just the busy hours when today is not on screen", () => {
    expect(hours(heldHours(items, null))).toEqual([9]);
  });
});

describe("bandAt", () => {
  const items = [placed([9, 0], [9, 30]), placed([18, 0], [18, 30])];
  const bounds = { start: 7, end: 20 };
  const held = heldHours(items, null);

  it("is the whole empty run around the hour, stopped by the events and the bounds", () => {
    expect(bandAt(held, bounds, 12)).toEqual({ start: 10, end: 18 });
    expect(bandAt(held, bounds, 19)).toEqual({ start: 19, end: 20 });
  });

  it("offers nothing on a busy hour, since a fold there would come straight back", () => {
    expect(bandAt(held, bounds, 9)).toBeNull();
  });

  it("stops at the hour it is now and offers nothing on it", () => {
    const now = heldHours(items, 13);
    expect(bandAt(now, bounds, 12)).toEqual({ start: 10, end: 13 });
    expect(bandAt(now, bounds, 15)).toEqual({ start: 14, end: 18 });
    expect(bandAt(now, bounds, 13)).toBeNull();
  });
});
