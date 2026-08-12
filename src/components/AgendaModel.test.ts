import { describe, expect, it } from "vitest";
import type { Instance } from "../ipc";
import { addDays, startOfDay, toDateOnly, toOffsetIso } from "../time";
import {
  buildAgenda,
  buildSearch,
  countItems,
  gapDates,
  gapLabel,
  instanceRange,
  matchesQuery,
  queryTerms,
  splitMatch,
  timeLabel,
  type AgendaDay,
  type AgendaGap,
} from "./AgendaModel";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function timed(id: string, startMs: number, endMs: number, over: Partial<Instance> = {}): Instance {
  return {
    colorId: null,
    eventId: id,
    calendarId: "cal",
    accountId: "acc",
    originalStart: null,
    start: toOffsetIso(startMs),
    end: toOffsetIso(endMs),
    startMs,
    endMs,
    allDay: false,
    summary: id,
    description: null,
    location: null,
    status: "confirmed",
    recurring: false,
    colorHex: "#7986cb",
    etag: null,
    organizer: null,
    attendees: [],
    conference: null,
    readOnly: false,
    pending: false,
    ...over,
  };
}

function whole(id: string, from: number, days = 1, over: Partial<Instance> = {}): Instance {
  const startMs = startOfDay(from);
  const endMs = addDays(startMs, days);
  return timed(id, startMs, endMs, {
    allDay: true,
    start: toDateOnly(startMs),
    end: toDateOnly(endMs),
    ...over,
  });
}

const days = (sections: readonly { kind: string }[]) => sections.filter((s) => s.kind === "day") as AgendaDay[];
const gaps = (sections: readonly { kind: string }[]) => sections.filter((s) => s.kind === "gap") as AgendaGap[];

describe("buildAgenda", () => {
  const monday = at(2026, 8, 10);

  it("gives every day of the span a section, in order", () => {
    const sections = buildAgenda([timed("a", at(2026, 8, 10, 9), at(2026, 8, 10, 10))], monday, addDays(monday, 3));
    expect(sections.map((s) => s.kind)).toEqual(["day", "gap", "gap"]);
    expect(gaps(sections).map((g) => g.days)).toEqual([1, 1]);
  });

  it("collapses a run of three or more empty days into one row", () => {
    const sections = buildAgenda(
      [
        timed("a", at(2026, 8, 10, 9), at(2026, 8, 10, 10)),
        timed("b", at(2026, 8, 16, 9), at(2026, 8, 16, 10)),
      ],
      monday,
      addDays(monday, 7),
    );
    expect(sections.map((s) => s.kind)).toEqual(["day", "gap", "day"]);
    const [gap] = gaps(sections);
    expect(gap.days).toBe(5);
    expect(gap.from).toBe(addDays(monday, 1));
    expect(gap.to).toBe(addDays(monday, 6));
    expect(gap.next).toBe(addDays(monday, 6));
    expect(gapLabel(gap)).toBe("nothing until Sunday");
  });

  it("leaves a run that reaches the end of the span with nowhere to point at", () => {
    const sections = buildAgenda([timed("a", at(2026, 8, 10, 9), at(2026, 8, 10, 10))], monday, addDays(monday, 5));
    const [gap] = gaps(sections);
    expect(gap.next).toBeNull();
    expect(gap.days).toBe(4);
    expect(gapLabel(gap)).toBe("nothing for 4 days");
  });

  it("sorts all-day before timed, then by start, then longest first", () => {
    const sections = buildAgenda(
      [
        timed("noon", at(2026, 8, 10, 12), at(2026, 8, 10, 13)),
        timed("morning", at(2026, 8, 10, 9), at(2026, 8, 10, 10)),
        timed("long", at(2026, 8, 10, 9), at(2026, 8, 10, 17)),
        whole("holiday", monday),
      ],
      monday,
      addDays(monday, 1),
    );
    expect(days(sections)[0].items.map((i) => i.instance.eventId)).toEqual([
      "holiday",
      "long",
      "morning",
      "noon",
    ]);
  });

  it("repeats a multi-day event under each day it covers, clipped", () => {
    const sections = buildAgenda([whole("trip", monday, 3)], monday, addDays(monday, 5));
    expect(sections.map((s) => s.kind)).toEqual(["day", "day", "day", "gap", "gap"]);
    const middle = days(sections)[1].items[0];
    expect(middle.continued).toBe(true);
    expect(middle.continues).toBe(true);
    expect(middle.startMs).toBe(addDays(monday, 1));
    expect(timeLabel(middle)).toBe("all day");
  });

  it("puts an event that crosses midnight on both days", () => {
    const sections = buildAgenda(
      [timed("late", at(2026, 8, 10, 22), at(2026, 8, 11, 1))],
      monday,
      addDays(monday, 2),
    );
    const [first, second] = days(sections);
    expect(timeLabel(first.items[0])).toBe("from 10pm");
    expect(timeLabel(second.items[0])).toBe("until 1am");
  });

  it("drops cancelled instances, so a day holding only one reads as empty", () => {
    const sections = buildAgenda(
      [timed("gone", at(2026, 8, 10, 9), at(2026, 8, 10, 10), { status: "cancelled" })],
      monday,
      addDays(monday, 1),
    );
    expect(sections.map((s) => s.kind)).toEqual(["gap"]);
  });

  it("names the month on the first section and again when it changes", () => {
    const start = at(2026, 8, 30);
    const sections = buildAgenda(
      [
        timed("a", at(2026, 8, 30, 9), at(2026, 8, 30, 10)),
        timed("b", at(2026, 9, 1, 9), at(2026, 9, 1, 10)),
      ],
      start,
      addDays(start, 3),
    );
    expect(sections.map((s) => s.showMonth)).toEqual([true, false, true]);
  });

  it("survives an empty span", () => {
    expect(buildAgenda([], monday, monday)).toEqual([]);
  });
});

describe("labels", () => {
  const monday = at(2026, 8, 10);

  it("says when without an axis", () => {
    const sections = buildAgenda(
      [
        timed("a", at(2026, 8, 10, 9), at(2026, 8, 10, 10, 30)),
        timed("point", at(2026, 8, 10, 14), at(2026, 8, 10, 14)),
      ],
      monday,
      addDays(monday, 1),
    );
    const items = days(sections)[0].items;
    expect(timeLabel(items[0])).toBe("9am to 10:30am");
    expect(timeLabel(items[1])).toBe("2pm");
  });

  it("writes a gap's dates the way a heading would", () => {
    const start = at(2026, 8, 30);
    const sections = buildAgenda([timed("a", at(2026, 9, 3, 9), at(2026, 9, 3, 10))], start, addDays(start, 5));
    const [gap] = gaps(sections);
    expect(gapDates(gap)).toBe("Sun 30 August to Wed 2 September");
  });

  it("drops the month from a single quiet day already under its heading", () => {
    const sections = buildAgenda(
      [timed("a", at(2026, 8, 10, 9), at(2026, 8, 10, 10))],
      monday,
      addDays(monday, 2),
    );
    const [gap] = gaps(sections);
    expect(gap.showMonth).toBe(false);
    expect(gapDates(gap)).toBe("Tue 11");
    expect(gapLabel(gap)).toBe("nothing");
  });
});

describe("instanceRange", () => {
  it("reads an all-day boundary out of the date-only strings", () => {
    const instance = whole("holiday", at(2026, 8, 10), 2);
    expect(instanceRange(instance)).toEqual({ startMs: at(2026, 8, 10), endMs: at(2026, 8, 12) });
  });

  it("falls back to the epoch fields when the date-only strings are not there", () => {
    const instance = timed("a", at(2026, 8, 10, 9), at(2026, 8, 10, 10), { allDay: true, start: "", end: "" });
    expect(instanceRange(instance)).toEqual({ startMs: at(2026, 8, 10, 9), endMs: at(2026, 8, 10, 10) });
  });
});

describe("search", () => {
  const monday = at(2026, 8, 10);
  const set = [
    timed("a", at(2026, 8, 10, 9), at(2026, 8, 10, 10), { summary: "Lunch with Sam" }),
    timed("b", at(2026, 8, 12, 9), at(2026, 8, 12, 10), { summary: "Standup", location: "Sam's desk" }),
    timed("c", at(2026, 8, 12, 11), at(2026, 8, 12, 12), { summary: "Retro", description: "with sam" }),
    timed("d", at(2026, 8, 13, 9), at(2026, 8, 13, 10), { summary: "Dentist" }),
    timed("e", at(2026, 8, 14, 9), at(2026, 8, 14, 10), { summary: "Sam", status: "cancelled" }),
  ];

  it("matches summary, location and description, and groups by day", () => {
    const sections = buildSearch(set, "sam");
    expect(sections.map((s) => (s as AgendaDay).dayStart)).toEqual([monday, at(2026, 8, 12)]);
    expect(countItems(sections)).toBe(3);
  });

  it("narrows with a second term rather than widening", () => {
    expect(countItems(buildSearch(set, "sam lunch"))).toBe(1);
    expect(countItems(buildSearch(set, "sam dentist"))).toBe(0);
  });

  it("has nothing to show for an empty query", () => {
    expect(buildSearch(set, "   ")).toEqual([]);
    expect(matchesQuery(set[0], queryTerms(""))).toBe(false);
  });

  it("shows a multi-day hit once, on the day it starts", () => {
    const sections = buildSearch([whole("trip", monday, 4, { summary: "Trip to Rome" })], "rome");
    expect(sections).toHaveLength(1);
    expect(countItems(sections)).toBe(1);
  });
});

describe("splitMatch", () => {
  it("cuts around every occurrence, keeping the original case", () => {
    expect(splitMatch("Sam and sam", ["sam"])).toEqual([
      { text: "Sam", hit: true },
      { text: " and ", hit: false },
      { text: "sam", hit: true },
    ]);
  });

  it("prefers the longest term at a position", () => {
    expect(splitMatch("standup", ["stand", "standup"])).toEqual([{ text: "standup", hit: true }]);
  });

  it("leaves text alone when nothing matches", () => {
    expect(splitMatch("Dentist", ["sam"])).toEqual([{ text: "Dentist", hit: false }]);
    expect(splitMatch("Dentist", [])).toEqual([{ text: "Dentist", hit: false }]);
    expect(splitMatch("", ["sam"])).toEqual([{ text: "", hit: false }]);
  });
});
