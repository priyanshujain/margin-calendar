// Pure model for the agenda: cutting a span into day sections, collapsing runs of empty days into
// one line, and the substring matching that search results are marked with.
//
// Nothing here holds state or touches the DOM. It is a `.tsx` file only because the agenda owns
// `Agenda*.tsx` and nothing else, which is the same reason `GridModel.tsx` is one.

import type { Instance } from "../ipc";
import { addDays, dayName, formatTime, monthName, parseDateOnly, startOfDay } from "../time";
import { keyId, keyOf } from "./GridModel";

/**
 * A run of empty days this long or longer collapses into a single line. One and two day runs stay
 * as a row each, because a quiet weekend is a shape you want to keep seeing; a fortnight of
 * nothing is one fact and deserves one row.
 */
export const COLLAPSE_DAYS = 3;

/** One instance as it appears on one day, clipped to that day. */
export interface AgendaItem {
  instance: Instance;
  id: string;
  /** Clipped to the day this row sits under. */
  startMs: number;
  endMs: number;
  /** It started before this day. */
  continued: boolean;
  /** It runs past the end of this day. */
  continues: boolean;
}

export interface AgendaDay {
  kind: "day";
  key: string;
  dayStart: number;
  items: AgendaItem[];
  /** The month changed here, so the heading says which one. */
  showMonth: boolean;
}

/** A run of days with nothing in them. A run is information, so it gets a row rather than a skip. */
export interface AgendaGap {
  kind: "gap";
  key: string;
  from: number;
  /** Exclusive, at local midnight. */
  to: number;
  days: number;
  /** The next day in the span that has something, or null when the span simply ends. */
  next: number | null;
  showMonth: boolean;
}

export type AgendaSection = AgendaDay | AgendaGap;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The half-open span an instance covers, in epoch milliseconds. All-day boundaries are read back
 * out of the date-only strings, which are the authoritative ones and must never be shifted into a
 * zone; anything that is not date-only falls back to the epoch fields.
 */
export function instanceRange(i: Instance): { startMs: number; endMs: number } {
  if (i.allDay && DATE_ONLY.test(i.start)) {
    const startMs = parseDateOnly(i.start);
    const endMs = DATE_ONLY.test(i.end) ? parseDateOnly(i.end) : startMs;
    return { startMs, endMs: endMs > startMs ? endMs : addDays(startMs, 1) };
  }
  return { startMs: i.startMs, endMs: i.endMs };
}

/** All-day first, then anything covering the whole day, then by start, longest first. */
function rank(item: AgendaItem): number {
  return item.instance.allDay || (item.continued && item.continues) ? 0 : 1;
}

function compareItems(a: AgendaItem, b: AgendaItem): number {
  return (
    rank(a) - rank(b) ||
    a.startMs - b.startMs ||
    b.endMs - b.startMs - (a.endMs - a.startMs) ||
    a.instance.summary.localeCompare(b.instance.summary) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const monthKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}`;
};

/** A heading names its month only when it is not the month the line above was already in. */
function withMonths(sections: AgendaSection[]): AgendaSection[] {
  let last = "";
  for (const section of sections) {
    const first = section.kind === "day" ? section.dayStart : section.from;
    const end = section.kind === "day" ? section.dayStart : addDays(section.to, -1);
    section.showMonth = monthKey(first) !== last;
    last = monthKey(end);
  }
  return sections;
}

function itemFor(instance: Instance, dayStart: number, dayEnd: number): AgendaItem {
  const range = instanceRange(instance);
  return {
    instance,
    id: keyId(keyOf(instance)),
    startMs: Math.max(range.startMs, dayStart),
    endMs: Math.min(range.endMs, dayEnd),
    continued: range.startMs < dayStart,
    continues: range.endMs > dayEnd,
  };
}

/**
 * Every day of `[from, to)` in order, days with something in them carrying their events and runs
 * of empty days collapsed. An event covering several days appears under each of them, clipped,
 * because a week-long holiday does not make the days it covers empty.
 */
export function buildAgenda(
  instances: readonly Instance[],
  from: number,
  to: number,
): AgendaSection[] {
  const days: number[] = [];
  for (let d = startOfDay(from); d < to; d = addDays(d, 1)) days.push(d);
  if (days.length === 0) return [];

  const ends = days.map((d) => addDays(d, 1));
  const buckets: AgendaItem[][] = days.map(() => []);
  for (const instance of instances) {
    if (instance.status === "cancelled") continue;
    const range = instanceRange(instance);
    // A zero length event still happens somewhere, so it counts as covering its own instant.
    const covered = Math.max(range.endMs, range.startMs + 1);
    for (let i = 0; i < days.length; i++) {
      if (range.startMs >= ends[i]) continue;
      if (covered <= days[i]) break;
      buckets[i].push(itemFor(instance, days[i], ends[i]));
    }
  }
  for (const bucket of buckets) bucket.sort(compareItems);

  const sections: AgendaSection[] = [];
  let i = 0;
  while (i < days.length) {
    if (buckets[i].length > 0) {
      sections.push({
        kind: "day",
        key: `d${days[i]}`,
        dayStart: days[i],
        items: buckets[i],
        showMonth: false,
      });
      i++;
      continue;
    }
    let j = i;
    while (j < days.length && buckets[j].length === 0) j++;
    const next = j < days.length ? days[j] : null;
    if (j - i >= COLLAPSE_DAYS) {
      sections.push({
        kind: "gap",
        key: `g${days[i]}`,
        from: days[i],
        to: ends[j - 1],
        days: j - i,
        next,
        showMonth: false,
      });
    } else {
      for (let k = i; k < j; k++) {
        sections.push({
          kind: "gap",
          key: `g${days[k]}`,
          from: days[k],
          to: ends[k],
          days: 1,
          next,
          showMonth: false,
        });
      }
    }
    i = j;
  }
  return withMonths(sections);
}

/** The matches, grouped by the day they start on. No gap rows: a gap between hits says nothing. */
export function buildSearch(instances: readonly Instance[], query: string): AgendaSection[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const buckets = new Map<number, AgendaItem[]>();
  for (const instance of instances) {
    if (instance.status === "cancelled") continue;
    if (!matchesQuery(instance, terms)) continue;
    // A hit appears once, on the day it starts, so a long event does not fill the results.
    const dayStart = startOfDay(instanceRange(instance).startMs);
    const item = itemFor(instance, dayStart, addDays(dayStart, 1));
    const bucket = buckets.get(dayStart);
    if (bucket) bucket.push(item);
    else buckets.set(dayStart, [item]);
  }

  const sections: AgendaSection[] = [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((dayStart) => ({
      kind: "day" as const,
      key: `d${dayStart}`,
      dayStart,
      items: (buckets.get(dayStart) as AgendaItem[]).sort(compareItems),
      showMonth: false,
    }));
  return withMonths(sections);
}

export const countItems = (sections: readonly AgendaSection[]): number =>
  sections.reduce((n, section) => n + (section.kind === "day" ? section.items.length : 0), 0);

/* Labels
   ----------------------------------------------------------------------------------------- */

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The agenda has no time axis, so this line is the only thing saying when. */
export function timeLabel(item: AgendaItem): string {
  const { instance } = item;
  if (instance.allDay || (item.continued && item.continues)) return "all day";
  if (item.continued) return `until ${formatTime(item.endMs)}`;
  if (item.continues) return `from ${formatTime(item.startMs)}`;
  if (item.endMs <= item.startMs) return formatTime(item.startMs);
  return `${formatTime(item.startMs)} to ${formatTime(item.endMs)}`;
}

/** The date or dates a gap covers, in the same shape a day heading uses. */
export function gapDates(gap: AgendaGap): string {
  const head = `${dayName(gap.from)} ${new Date(gap.from).getDate()}`;
  if (gap.days === 1) return gap.showMonth ? `${head} ${monthName(gap.from)}` : head;
  const last = addDays(gap.to, -1);
  const tail = `${dayName(last)} ${new Date(last).getDate()} ${monthName(last)}`;
  return monthKey(gap.from) === monthKey(last) ? `${head} to ${tail}` : `${head} ${monthName(gap.from)} to ${tail}`;
}

export function gapLabel(gap: AgendaGap): string {
  if (gap.days === 1) return "nothing";
  if (gap.next !== null) return `nothing until ${weekdays[new Date(gap.next).getDay()]}`;
  return `nothing for ${gap.days} days`;
}

/* Search matching
   ----------------------------------------------------------------------------------------- */

export const queryTerms = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

/** Every term has to land somewhere, so a second word narrows rather than widens. */
export function matchesQuery(instance: Instance, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const hay = `${instance.summary}\n${instance.location ?? ""}\n${instance.description ?? ""}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

export interface MatchPart {
  text: string;
  hit: boolean;
}

/** `text` cut around every occurrence of any term, longest term winning at a given position. */
export function splitMatch(text: string, terms: readonly string[]): MatchPart[] {
  const clean = terms.filter((term) => term.length > 0);
  if (clean.length === 0 || text.length === 0) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const parts: MatchPart[] = [];
  let plain = 0;
  let at = 0;
  while (at < text.length) {
    let width = 0;
    for (const term of clean) {
      if (term.length > width && hay.startsWith(term, at)) width = term.length;
    }
    if (width === 0) {
      at++;
      continue;
    }
    if (at > plain) parts.push({ text: text.slice(plain, at), hit: false });
    parts.push({ text: text.slice(at, at + width), hit: true });
    at += width;
    plain = at;
  }
  if (plain < text.length) parts.push({ text: text.slice(plain), hit: false });
  return parts;
}
