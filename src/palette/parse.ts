// Natural language event entry, the thing that makes the palette more than a command list.
//
// Pure by construction: no React, no Tauri, and no clock. `now` is passed in, so the preview the
// user sees and the tests that pin it are the same code path.
//
// The order of the passes is load-bearing. `#calendar`, the all-day flag and the duration come out
// first, because chrono reads `45m` as a quarter to ten and would otherwise invent a second date.
// chrono runs next and its match is cut out by the offsets it reports, never by searching for its
// own text again. `at <place>` runs last on what is left, which is what stops it stealing the `5`
// out of `coffee at 5`. Everything still standing is the title.

import { parse as parseDates } from "chrono-node";
import type { EventDraft } from "../ipc";
import { addDays, dayName, formatTime, monthName, startOfDay, toDateOnly, toOffsetIso } from "../time";

const DEFAULT_MINUTES = 60;
const MIN_MINUTES = 5;

export interface Parsed {
  /** Everything the parser did not recognise, whitespace collapsed. */
  title: string;
  startMs: number;
  /** Exclusive. For an all-day event this is local midnight after the last day, as the wire wants. */
  endMs: number;
  allDay: boolean;
  /** Zero for an all-day event. */
  minutes: number;
  /** The `#work` token without its hash, still unresolved against the calendar list. */
  calendarHint: string | null;
  location: string | null;
  /** Why the parse is not certain, in the words the preview shows. Null when it is certain. */
  ambiguous: string | null;
  /** False when nothing date-like was recognised and the fallback slot was used. */
  dated: boolean;
}

/** The slot a bare title lands in: the next half hour on today, otherwise nine in the morning. */
export function defaultStart(anchor: number, now: number): number {
  const sameDay = startOfDay(anchor) === startOfDay(now);
  const d = new Date(sameDay ? now : startOfDay(anchor));
  if (sameDay) d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
  else d.setHours(9, 0, 0, 0);
  return d.getTime();
}

const CALENDAR = /(?:^|\s)#([a-z0-9][\w-]*)/i;
const ALL_DAY = /(?:^|\s)all[- ]day(?=\s|$)/i;
const HOURS = /(?:^|\s)(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?:\s*(\d{1,2})\s*(?:m|min|mins|minute|minutes)?)?(?=\s|$)/i;
const MINUTES = /(?:^|\s)(?:for\s+)?(\d+)\s*(?:m|min|mins|minute|minutes)(?=\s|$)/i;
const LOCATION = /(?:^|\s)at\s+(\S.*)$/i;
// No leading \b: the meridiem in `10am` sits against a digit, which is not a word boundary.
const MERIDIEM_WORD = /(a\.?m|p\.?m)\b|\b(noon|midday|midnight|morning|afternoon|evening|tonight|night)\b/i;
const TRAILING_JOIN = /[\s,;:.\-]*\b(?:on|at|from|by|for|with)$/i;

/** Replaces a span with one space, so cutting the middle of a phrase never welds two words. */
function cut(text: string, start: number, end: number): string {
  return `${text.slice(0, start)} ${text.slice(end)}`;
}

function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.replace(TRAILING_JOIN, "").replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "").trim();
}

interface Take {
  rest: string;
  value: string | null;
}

function takeFirst(text: string, pattern: RegExp, group: number): Take {
  const m = pattern.exec(text);
  if (!m) return { rest: text, value: null };
  const start = m.index + (/^\s/.test(m[0]) ? 1 : 0);
  return { rest: cut(text, start, m.index + m[0].length), value: m[group] ?? "" };
}

function takeDuration(text: string): { rest: string; minutes: number | null } {
  const hours = HOURS.exec(text);
  if (hours) {
    const minutes = Math.round(Number(hours[1]) * 60) + Number(hours[2] ?? 0);
    const start = hours.index + (/^\s/.test(hours[0]) ? 1 : 0);
    return { rest: cut(text, start, hours.index + hours[0].length), minutes };
  }
  const mins = MINUTES.exec(text);
  if (mins) {
    const start = mins.index + (/^\s/.test(mins[0]) ? 1 : 0);
    return { rest: cut(text, start, mins.index + mins[0].length), minutes: Number(mins[1]) };
  }
  return { rest: text, minutes: null };
}

/**
 * @param now Reference instant, in epoch milliseconds. Everything relative resolves against it.
 * @param fallbackStart Where an undated title lands. Defaults to the next half hour after `now`.
 */
export function parseEventInput(text: string, now: number, fallbackStart?: number): Parsed {
  const calendar = takeFirst(text, CALENDAR, 1);
  const allDayFlag = takeFirst(calendar.rest, ALL_DAY, 0);
  const duration = takeDuration(allDayFlag.rest);

  const results = parseDates(duration.rest, { instant: new Date(now) }, { forwardDate: true });
  const hit = results[0];
  const remainder = hit ? cut(duration.rest, hit.index, hit.index + hit.text.length) : duration.rest;

  const place = takeFirst(remainder, LOCATION, 1);

  const timed = hit ? hit.start.isCertain("hour") : false;
  const allDay = allDayFlag.value !== null || (hit ? !timed : false);
  const rangeEnd = hit?.end ? hit.end.date().getTime() : null;

  let startMs: number;
  let endMs: number;
  let minutes = 0;
  if (!hit) {
    startMs = fallbackStart ?? defaultStart(now, now);
    if (allDay) {
      startMs = startOfDay(startMs);
      endMs = addDays(startMs, 1);
    } else {
      minutes = duration.minutes ?? DEFAULT_MINUTES;
      endMs = startMs + minutes * 60_000;
    }
  } else if (allDay) {
    startMs = startOfDay(hit.date().getTime());
    endMs = addDays(startOfDay(rangeEnd ?? startMs), 1);
  } else {
    startMs = hit.date().getTime();
    const fromRange = rangeEnd === null ? null : Math.round((rangeEnd - startMs) / 60_000);
    minutes = Math.max(MIN_MINUTES, fromRange ?? duration.minutes ?? DEFAULT_MINUTES);
    endMs = startMs + minutes * 60_000;
  }

  return {
    title: tidy(place.rest),
    startMs,
    endMs,
    allDay,
    minutes: allDay ? 0 : minutes,
    calendarHint: calendar.value,
    location: place.value ? tidy(place.value) || null : null,
    ambiguous: reasonFor(results, hit, duration.minutes, allDay),
    dated: hit !== undefined,
  };
}

type Hit = ReturnType<typeof parseDates>[number];

/**
 * Ambiguity is reported, never resolved by guessing. `9-10am` is not ambiguous because the end
 * carries the meridiem for both, but `at 5` is, and saying so is the whole point.
 */
function reasonFor(
  results: readonly Hit[],
  hit: Hit | undefined,
  duration: number | null,
  allDay: boolean,
): string | null {
  if (results.length > 1) return "more than one date in that";
  if (!hit) return null;
  if (!allDay && !hit.start.isCertain("meridiem") && !MERIDIEM_WORD.test(hit.text)) {
    const hour = hit.start.get("hour");
    if (hour !== null && hour >= 1 && hour <= 11 && !hit.end?.isCertain("meridiem")) {
      return `${hour} could be am or pm`;
    }
  }
  if (hit.end && duration !== null) return "a range and a duration";
  return null;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** `Tue 11 Aug`. No year: the user is looking at a date they just typed. */
export function shortDate(ms: number): string {
  return `${dayName(ms)} ${new Date(ms).getDate()} ${monthName(ms).slice(0, 3)}`;
}

/** The plain sentence under the input. `calendarName` is null when nothing is connected. */
export function previewText(parsed: Parsed, calendarName: string | null): string {
  const title = parsed.title || "Untitled";
  const when = parsed.allDay
    ? `all day on ${allDaySpan(parsed)}`
    : `on ${shortDate(parsed.startMs)}, ${formatTime(parsed.startMs)} to ${formatTime(parsed.endMs)}` +
      `, ${formatDuration(parsed.minutes)}`;
  const parts = [`“${title}” ${when}`];
  if (calendarName) parts.push(`in ${calendarName}`);
  if (parsed.location) parts.push(`at ${parsed.location}`);
  return `${parts.join(", ")}.`;
}

function allDaySpan(parsed: Parsed): string {
  const last = addDays(parsed.endMs, -1);
  return startOfDay(last) === startOfDay(parsed.startMs)
    ? shortDate(parsed.startMs)
    : `${shortDate(parsed.startMs)} to ${shortDate(last)}`;
}

/** Built with `toOffsetIso` and `toDateOnly` so an all-day boundary never crosses a zone. */
export function toDraft(parsed: Parsed, calendarId: string): EventDraft {
  const base = {
    calendarId,
    summary: parsed.title || "Untitled",
    location: parsed.location,
    allDay: parsed.allDay,
  };
  return parsed.allDay
    ? { ...base, start: toDateOnly(parsed.startMs), end: toDateOnly(parsed.endMs) }
    : { ...base, start: toOffsetIso(parsed.startMs), end: toOffsetIso(parsed.endMs) };
}

export interface CalendarLike {
  id: string;
  summary: string;
  accessRole: string;
  selected: boolean;
  primary: boolean;
}

export const writable = (calendar: CalendarLike): boolean =>
  calendar.accessRole === "owner" || calendar.accessRole === "writer";

const fold = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `#work` against the calendar list: exact fold, then prefix, then substring. Writable only. */
export function matchCalendar(
  hint: string | null,
  calendars: readonly CalendarLike[],
): CalendarLike | null {
  if (!hint) return null;
  const needle = fold(hint);
  if (!needle) return null;
  const options = calendars.filter(writable);
  return (
    options.find((c) => fold(c.summary) === needle) ??
    options.find((c) => fold(c.summary).startsWith(needle)) ??
    options.find((c) => fold(c.summary).includes(needle)) ??
    null
  );
}

/** Where an event goes when nothing said otherwise: the primary calendar, else anything writable. */
export function defaultCalendar(calendars: readonly CalendarLike[]): CalendarLike | null {
  const options = calendars.filter(writable);
  return options.find((c) => c.primary && c.selected) ?? options.find((c) => c.primary) ?? options[0] ?? null;
}
