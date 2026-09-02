import { describe, expect, it } from "vitest";
import type { Instance } from "../ipc";
import { bandAt, busyHours, type Placed } from "./GridModel";

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

describe("bandAt", () => {
  const items = [placed([9, 0], [9, 30]), placed([18, 0], [18, 30])];
  const bounds = { start: 7, end: 20 };

  it("is the whole empty run around the hour, stopped by the events and the bounds", () => {
    expect(bandAt(items, bounds, 12)).toEqual({ start: 10, end: 18 });
    expect(bandAt(items, bounds, 19)).toEqual({ start: 19, end: 20 });
  });

  it("offers nothing on a busy hour, since a fold there would come straight back", () => {
    expect(bandAt(items, bounds, 9)).toBeNull();
  });
});
