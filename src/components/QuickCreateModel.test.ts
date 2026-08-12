import { describe, expect, it } from "vitest";
import { parseEventInput } from "../palette/parse";
import {
  allDaySlot,
  draftOf,
  placeCard,
  slotFromParse,
  timedSlot,
  withEnd,
  withStart,
  type Box,
  type Fields,
  type Slot,
} from "./QuickCreateModel";

// Monday 10 August 2026, 09:00 local, the same instant `parse.test.ts` pins itself to.
const NOW = new Date(2026, 7, 10, 9, 0, 0).getTime();

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 7, day, hour, minute, 0, 0).getTime();

/** The 9:00 to 9:30 the complaint is about. */
const DRAGGED: Slot = { startMs: at(10, 9), endMs: at(10, 9, 30), allDay: false };

describe("slotFromParse", () => {
  it("says nothing about a bare title, so the drag holds", () => {
    expect(slotFromParse(parseEventInput("standup", NOW, DRAGGED.startMs), DRAGGED)).toBeNull();
  });

  it("takes a dated phrase whole", () => {
    const parsed = parseEventInput("lunch with sam tue 1pm 45m", NOW, DRAGGED.startMs);
    expect(slotFromParse(parsed, DRAGGED)).toEqual({
      startMs: at(11, 13),
      endMs: at(11, 13, 45),
      allDay: false,
    });
  });

  it("moves only the end when all the text said was a length", () => {
    const parsed = parseEventInput("standup 45m", NOW, DRAGGED.startMs);
    expect(slotFromParse(parsed, DRAGGED)).toEqual({
      startMs: at(10, 9),
      endMs: at(10, 9, 45),
      allDay: false,
    });
  });

  it("turns an undated all-day flag into the whole of the dragged day", () => {
    const parsed = parseEventInput("dentist all day", NOW, DRAGGED.startMs);
    expect(slotFromParse(parsed, DRAGGED)).toEqual({
      startMs: at(10, 0),
      endMs: at(11, 0),
      allDay: true,
    });
  });
});

describe("all day", () => {
  it("ends at the midnight after the last day it touches", () => {
    expect(allDaySlot(DRAGGED)).toEqual({ startMs: at(10, 0), endMs: at(11, 0), allDay: true });
  });

  it("comes back at the time of day the drag had", () => {
    expect(timedSlot(allDaySlot(DRAGGED), DRAGGED)).toEqual(DRAGGED);
  });
});

describe("time fields", () => {
  it("drags the end along when the start moves", () => {
    expect(withStart(DRAGGED, at(10, 11), 15)).toEqual({
      startMs: at(10, 11),
      endMs: at(10, 11, 30),
      allDay: false,
    });
  });

  it("holds the end open by the minimum rather than letting it precede the start", () => {
    expect(withEnd(DRAGGED, at(10, 8), 15).endMs).toBe(at(10, 9, 15));
  });
});

describe("draftOf", () => {
  const fields = (over: Partial<Fields> = {}): Fields => ({
    calendarId: "cal-1",
    summary: "standup",
    location: null,
    description: null,
    colorId: null,
    ...over,
  });

  it("writes a timed event with an offset", () => {
    const draft = draftOf(DRAGGED, fields());
    expect(draft.allDay).toBe(false);
    expect(draft.start).toMatch(/^2026-08-10T09:00:00[+-]\d\d:\d\d$/);
    expect(draft.summary).toBe("standup");
  });

  it("writes an all-day event as dates that cannot cross a zone", () => {
    const draft = draftOf(allDaySlot(DRAGGED), fields({ summary: "", location: "the cafe" }));
    expect(draft).toMatchObject({
      allDay: true,
      start: "2026-08-10",
      end: "2026-08-11",
      summary: "Untitled",
      location: "the cafe",
    });
  });

  it("carries the description as written, and nothing when it is empty", () => {
    expect(draftOf(DRAGGED, fields({ description: "bring the laptop" }))).toMatchObject({
      description: "bring the laptop",
    });
    expect(draftOf(DRAGGED, fields()).description).toBeNull();
  });

  it("sends a chosen colour and leaves the field out when the event follows its calendar", () => {
    expect(draftOf(DRAGGED, fields({ colorId: "11" })).colorId).toBe("11");
    expect("colorId" in draftOf(DRAGGED, fields())).toBe(false);
  });
});

describe("placeCard", () => {
  const bounds: Box = { left: 0, top: 0, right: 1000, bottom: 600 };
  const card = { width: 300, height: 200 };
  const range: Box = { left: 300, top: 100, right: 400, bottom: 160 };

  it("sits beside the range and level with its top", () => {
    expect(placeCard(range, card, bounds, 8)).toEqual({ left: 408, top: 100, side: "right" });
  });

  it("flips to the other side rather than leaving the bounds", () => {
    const last: Box = { left: 850, top: 100, right: 950, bottom: 160 };
    expect(placeCard(last, card, bounds, 8)).toEqual({ left: 542, top: 100, side: "left" });
  });

  it("drops below when neither side has room", () => {
    const narrow: Box = { left: 0, top: 0, right: 420, bottom: 600 };
    const middle: Box = { left: 150, top: 100, right: 250, bottom: 160 };
    expect(placeCard(middle, card, narrow, 8)).toEqual({ left: 120, top: 168, side: "below" });
  });

  it("goes above when there is no room below either", () => {
    const narrow: Box = { left: 0, top: 0, right: 420, bottom: 400 };
    const low: Box = { left: 150, top: 260, right: 250, bottom: 320 };
    expect(placeCard(low, card, narrow, 8)).toEqual({ left: 120, top: 52, side: "above" });
  });

  it("never hangs off the bottom, whatever the range does", () => {
    const low: Box = { left: 300, top: 560, right: 400, bottom: 600 };
    expect(placeCard(low, card, bounds, 8)).toEqual({ left: 408, top: 400, side: "right" });
  });
});
