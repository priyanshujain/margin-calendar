import { describe, expect, it } from "vitest";
import {
  defaultCalendar,
  defaultStart,
  formatDuration,
  matchCalendar,
  parseEventInput,
  previewText,
  toDraft,
  type CalendarLike,
} from "./parse";

// Monday 10 August 2026, 09:00 local. Every expectation below is relative to this and to nothing
// else, which is why the parser takes `now` rather than reading the clock.
const NOW = new Date(2026, 7, 10, 9, 0, 0).getTime();

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 7, day, hour, minute, 0, 0).getTime();

describe("parseEventInput", () => {
  it("takes a day, a time and a duration and leaves the rest as the title", () => {
    const parsed = parseEventInput("lunch with sam tue 1pm 45m", NOW);
    expect(parsed.title).toBe("lunch with sam");
    expect(parsed.startMs).toBe(at(11, 13));
    expect(parsed.endMs).toBe(at(11, 13, 45));
    expect(parsed.minutes).toBe(45);
    expect(parsed.allDay).toBe(false);
    expect(parsed.dated).toBe(true);
    expect(parsed.ambiguous).toBeNull();
  });

  it("reads a bare time range as both ends", () => {
    const parsed = parseEventInput("standup 9-10am", NOW);
    expect(parsed.title).toBe("standup");
    expect(parsed.startMs).toBe(at(10, 9));
    expect(parsed.endMs).toBe(at(10, 10));
    expect(parsed.minutes).toBe(60);
    expect(parsed.ambiguous).toBeNull();
  });

  it("reads a spelled range across a day", () => {
    const parsed = parseEventInput("dentist friday 3pm to 4:30pm", NOW);
    expect(parsed.startMs).toBe(at(14, 15));
    expect(parsed.endMs).toBe(at(14, 16, 30));
    expect(parsed.minutes).toBe(90);
  });

  it("pulls #calendar out of the title", () => {
    const parsed = parseEventInput("1:1 with dana wed 2pm #work", NOW);
    expect(parsed.calendarHint).toBe("work");
    expect(parsed.title).toBe("1:1 with dana");
    expect(parsed.startMs).toBe(at(12, 14));
  });

  it("pulls at <place> out of the title", () => {
    const parsed = parseEventInput("coffee with jo thu 4pm at blue bottle", NOW);
    expect(parsed.location).toBe("blue bottle");
    expect(parsed.title).toBe("coffee with jo");
    expect(parsed.startMs).toBe(at(13, 16));
  });

  it("does not mistake a time for a place", () => {
    const parsed = parseEventInput("coffee at 5pm", NOW);
    expect(parsed.location).toBeNull();
    expect(parsed.title).toBe("coffee");
    expect(parsed.startMs).toBe(at(10, 17));
  });

  it("flags an hour that could be am or pm rather than guessing", () => {
    const parsed = parseEventInput("standup at 5", NOW);
    expect(parsed.ambiguous).toBe("5 could be am or pm");
    expect(parsed.title).toBe("standup");
  });

  it("flags two dates rather than picking one silently", () => {
    const parsed = parseEventInput("chat 3pm friday and 4pm monday", NOW);
    expect(parsed.ambiguous).toBe("more than one date in that");
  });

  it("flags a range and a duration together", () => {
    const parsed = parseEventInput("review 9-10am 45m", NOW);
    expect(parsed.ambiguous).toBe("a range and a duration");
    expect(parsed.minutes).toBe(60);
  });

  it("keeps everything it does not recognise in the title", () => {
    const parsed = parseEventInput(
      "quarterly planning with the whole team about q4 roadmap next tuesday 10am 90m #work at the big room",
      NOW,
    );
    expect(parsed.title).toBe("quarterly planning with the whole team about q4 roadmap");
    expect(parsed.calendarHint).toBe("work");
    expect(parsed.location).toBe("the big room");
    expect(parsed.startMs).toBe(at(18, 10));
    expect(parsed.minutes).toBe(90);
  });

  it("makes a day with no time an all-day event", () => {
    const parsed = parseEventInput("review tue", NOW);
    expect(parsed.allDay).toBe(true);
    expect(parsed.startMs).toBe(at(11, 0));
    expect(parsed.endMs).toBe(at(12, 0));
    expect(parsed.minutes).toBe(0);
  });

  it("honours an explicit all-day flag", () => {
    const parsed = parseEventInput("sam is away friday all day", NOW);
    expect(parsed.allDay).toBe(true);
    expect(parsed.title).toBe("sam is away");
    expect(parsed.startMs).toBe(at(14, 0));
  });

  it("falls back to a slot when nothing is date-like", () => {
    const parsed = parseEventInput("buy milk", NOW, at(10, 17));
    expect(parsed.dated).toBe(false);
    expect(parsed.title).toBe("buy milk");
    expect(parsed.startMs).toBe(at(10, 17));
    expect(parsed.endMs).toBe(at(10, 18));
    expect(parsed.ambiguous).toBeNull();
  });

  it("reads 1h30 as ninety minutes", () => {
    const parsed = parseEventInput("sprint planning monday 10am 1h30", NOW);
    expect(parsed.minutes).toBe(90);
    expect(parsed.title).toBe("sprint planning");
  });

  it("drops a dangling preposition left behind by the cut", () => {
    const parsed = parseEventInput("catch up with tue 11am", NOW);
    expect(parsed.title).toBe("catch up");
  });

  it("is empty rather than wrong on an empty input", () => {
    const parsed = parseEventInput("   ", NOW, at(10, 17));
    expect(parsed.title).toBe("");
    expect(parsed.dated).toBe(false);
  });
});

describe("defaultStart", () => {
  it("takes the next half hour on today", () => {
    expect(defaultStart(NOW, at(10, 9, 12))).toBe(at(10, 9, 30));
  });

  it("takes nine in the morning on any other day", () => {
    expect(defaultStart(at(14, 0), NOW)).toBe(at(14, 9));
  });
});

describe("toDraft", () => {
  it("writes a timed event with an offset", () => {
    const draft = toDraft(parseEventInput("lunch tue 1pm 45m", NOW), "cal-1");
    expect(draft.allDay).toBe(false);
    expect(draft.calendarId).toBe("cal-1");
    expect(draft.summary).toBe("lunch");
    expect(draft.start).toMatch(/^2026-08-11T13:00:00[+-]\d{2}:\d{2}$/);
    expect(draft.end).toMatch(/^2026-08-11T13:45:00[+-]\d{2}:\d{2}$/);
  });

  it("writes an all-day event date-only, with the exclusive end the wire wants", () => {
    const draft = toDraft(parseEventInput("review tue", NOW), "cal-1");
    expect(draft.allDay).toBe(true);
    expect(draft.start).toBe("2026-08-11");
    expect(draft.end).toBe("2026-08-12");
  });

  it("carries the location through", () => {
    const draft = toDraft(parseEventInput("coffee thu 4pm at blue bottle", NOW), "cal-1");
    expect(draft.location).toBe("blue bottle");
  });
});

const calendars: CalendarLike[] = [
  { id: "a", summary: "priyanshu@example.com", accessRole: "owner", selected: true, primary: true },
  { id: "b", summary: "Work Projects", accessRole: "writer", selected: true, primary: false },
  { id: "c", summary: "Holidays", accessRole: "reader", selected: true, primary: false },
];

describe("matchCalendar", () => {
  it("matches on a prefix, ignoring case and spacing", () => {
    expect(matchCalendar("work", calendars)?.id).toBe("b");
    expect(matchCalendar("workprojects", calendars)?.id).toBe("b");
  });

  it("never targets a calendar that cannot be written to", () => {
    expect(matchCalendar("holidays", calendars)).toBeNull();
  });

  it("is null without a hint or without a match", () => {
    expect(matchCalendar(null, calendars)).toBeNull();
    expect(matchCalendar("garden", calendars)).toBeNull();
  });

  it("falls back to the primary calendar", () => {
    expect(defaultCalendar(calendars)?.id).toBe("a");
    expect(defaultCalendar([])).toBeNull();
  });
});

describe("previewText", () => {
  it("says the date, the time, the duration and the calendar", () => {
    const parsed = parseEventInput("lunch with sam tue 1pm 45m at zoe's", NOW);
    expect(previewText(parsed, "Work")).toBe(
      "“lunch with sam” on Tue 11 Aug, 1pm to 1:45pm, 45m, in Work, at zoe's.",
    );
  });

  it("says all day when there is no time", () => {
    expect(previewText(parseEventInput("review tue", NOW), null)).toBe(
      "“review” all day on Tue 11 Aug.",
    );
  });

  it("spells a duration in hours and minutes", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(90)).toBe("1h 30m");
  });
});
