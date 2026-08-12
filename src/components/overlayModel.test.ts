import { afterEach, describe, expect, it } from "vitest";
import {
  addMonths,
  allDayEndInput,
  allDayEndWire,
  attendeeTally,
  canWrite,
  defaultRange,
  fromDateTime,
  monthGrid,
  monthLabel,
  roleLabel,
  startOfMonth,
  toTimeOnly,
  weekdayHeads,
} from "./overlayModel";
import { parseDateOnly, toDateOnly } from "../time";
import type { Attendee } from "../ipc";

/** `time.ts` reads the week start from a bare `localStorage`, which a node run does not have. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const attendee = (responseStatus: Attendee["responseStatus"]): Attendee => ({
  email: `${responseStatus}@example.com`,
  displayName: null,
  responseStatus,
  organizer: false,
  self: false,
  optional: false,
});

describe("month maths", () => {
  it("normalises to the first, so a long month never overflows into the one after next", () => {
    const halloween = new Date(2026, 9, 31).getTime();
    expect(toDateOnly(addMonths(halloween, 1))).toBe("2026-11-01");
    expect(toDateOnly(addMonths(new Date(2026, 0, 31).getTime(), 1))).toBe("2026-02-01");
    expect(toDateOnly(addMonths(new Date(2026, 0, 15).getTime(), -1))).toBe("2025-12-01");
  });

  it("lays six weeks out from the configured first day of the week", () => {
    fakeStorage({ "margincal-week-start": "1" });
    const august = new Date(2026, 7, 12).getTime();
    const grid = monthGrid(august);
    expect(grid).toHaveLength(42);
    expect(toDateOnly(grid[0])).toBe("2026-07-27");
    expect(new Date(grid[0]).getDay()).toBe(1);
    expect(grid.some((d) => toDateOnly(d) === "2026-08-01")).toBe(true);
    expect(grid.some((d) => toDateOnly(d) === "2026-08-31")).toBe(true);

    fakeStorage({ "margincal-week-start": "0" });
    expect(new Date(monthGrid(august)[0]).getDay()).toBe(0);
  });

  it("rotates the weekday heads with the week start", () => {
    fakeStorage({ "margincal-week-start": "0" });
    expect(weekdayHeads()[0]).toBe("Su");
    fakeStorage({ "margincal-week-start": "1" });
    expect(weekdayHeads()[0]).toBe("Mo");
  });

  it("names the month and finds its first day at local midnight", () => {
    const ms = new Date(2026, 7, 12, 17, 30).getTime();
    expect(monthLabel(ms)).toBe("August 2026");
    expect(new Date(startOfMonth(ms)).getHours()).toBe(0);
    expect(toDateOnly(startOfMonth(ms))).toBe("2026-08-01");
  });
});

describe("input conversions", () => {
  it("round-trips a date and a time through the native inputs", () => {
    const ms = new Date(2026, 7, 12, 9, 5).getTime();
    expect(toTimeOnly(ms)).toBe("09:05");
    expect(fromDateTime(toDateOnly(ms), toTimeOnly(ms))).toBe(ms);
  });

  it("gives NaN for a half-filled pair rather than a silent midnight", () => {
    expect(Number.isNaN(fromDateTime("", "09:00"))).toBe(true);
    expect(fromDateTime("2026-08-12", "")).toBe(new Date(2026, 7, 12).getTime());
  });

  it("shows the last day an all-day event covers, and sends back the exclusive end", () => {
    const start = new Date(2026, 7, 12).getTime();
    const oneDay = new Date(2026, 7, 13).getTime();
    expect(allDayEndInput(oneDay)).toBe("2026-08-12");
    expect(allDayEndWire("2026-08-12")).toBe("2026-08-13");
    expect(parseDateOnly(allDayEndInput(oneDay))).toBe(start);

    const threeDays = new Date(2026, 7, 15).getTime();
    expect(allDayEndInput(threeDays)).toBe("2026-08-14");
    expect(allDayEndWire(allDayEndInput(threeDays))).toBe("2026-08-15");
  });
});

describe("a new event's default slot", () => {
  it("takes the next half hour when the anchor is today", () => {
    const now = new Date(2026, 7, 12, 10, 12).getTime();
    const { startMs, endMs } = defaultRange(new Date(2026, 7, 12).getTime(), now);
    expect(toTimeOnly(startMs)).toBe("10:30");
    expect(toTimeOnly(endMs)).toBe("11:30");
  });

  it("takes nine in the morning on any other day", () => {
    const now = new Date(2026, 7, 12, 10, 12).getTime();
    const { startMs, endMs } = defaultRange(new Date(2026, 7, 20).getTime(), now);
    expect(toDateOnly(startMs)).toBe("2026-08-20");
    expect(toTimeOnly(startMs)).toBe("09:00");
    expect(toTimeOnly(endMs)).toBe("10:00");
  });
});

describe("vocabulary", () => {
  it("says nothing about a calendar you own and something about every other kind", () => {
    expect(roleLabel("owner")).toBeNull();
    expect(roleLabel("reader")).toBe("read only");
    expect(canWrite("owner")).toBe(true);
    expect(canWrite("writer")).toBe(true);
    expect(canWrite("reader")).toBe(false);
    expect(canWrite("freeBusyReader")).toBe(false);
  });

  it("tallies acceptances, and stays quiet when nobody was invited", () => {
    expect(attendeeTally([])).toBeNull();
    expect(attendeeTally([attendee("accepted"), attendee("declined"), attendee("needsAction")])).toBe(
      "1 of 3 accepted",
    );
  });
});
