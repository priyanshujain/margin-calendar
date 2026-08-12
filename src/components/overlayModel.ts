// Pure helpers for the overlays: the mini-month's calendar maths, the conversions between an
// `Instance` and the native date and time inputs, and the small vocabulary the panels use for
// access roles and RSVP states.
//
// Nothing here holds state or touches the DOM, which is what makes it testable in a node run.

import type { Attendee, Instance } from "../ipc";
import {
  addDays,
  formatRange,
  formatTime,
  isSameDay,
  monthName,
  parseDateOnly,
  startOfDay,
  startOfWeek,
  toDateOnly,
  weekStartDay,
} from "../time";

/** Local midnight on the first of the month `ms` falls in. */
export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Months only: the day is normalised to the first, so December never lands on the 31st of nowhere. */
export function addMonths(ms: number, delta: number): number {
  const d = new Date(startOfMonth(ms));
  d.setMonth(d.getMonth() + delta);
  return d.getTime();
}

/** Six weeks of local midnights covering the month, from the configured first day of the week. */
export function monthGrid(ms: number): number[] {
  const first = startOfWeek(startOfMonth(ms));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export const monthLabel = (ms: number): string => `${monthName(ms)} ${new Date(ms).getFullYear()}`;

export const isSameMonth = (a: number, b: number): boolean => startOfMonth(a) === startOfMonth(b);

const SHORT_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function weekdayHeads(): string[] {
  const start = weekStartDay();
  return Array.from({ length: 7 }, (_, i) => SHORT_DAYS[(start + i) % 7]);
}

/** `HH:MM` in local terms, which is what an `<input type="time">` wants back. */
export function toTimeOnly(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The instant the two native inputs describe, in local wall-clock terms. NaN if either is blank. */
export function fromDateTime(date: string, time: string): number {
  if (!date) return NaN;
  const day = parseDateOnly(date);
  if (Number.isNaN(day)) return NaN;
  const [h, m] = time.split(":").map(Number);
  const d = new Date(day);
  d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  return d.getTime();
}

/**
 * All-day ends are exclusive on the wire, the way Google sends them, and inclusive in the panel,
 * because nobody thinks of a one-day event as ending tomorrow.
 */
export const allDayEndInput = (endMs: number): string => toDateOnly(addDays(endMs, -1));

export const allDayEndWire = (lastDay: string): string => toDateOnly(addDays(parseDateOnly(lastDay), 1));

/** A sensible slot for a new event: the next half hour when the anchor is today, else 9am. */
export function defaultRange(anchor: number, now = Date.now()): { startMs: number; endMs: number } {
  const start = new Date(isSameDay(anchor, now) ? now : startOfDay(anchor));
  if (isSameDay(anchor, now)) start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
  else start.setHours(9, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setMinutes(end.getMinutes() + 60);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** The one sentence a read-only event gets for its dates. */
export function whenText(instance: Instance): string {
  const { startMs, endMs, allDay } = instance;
  if (allDay) return `${formatRange(startMs, addDays(endMs, -1))}, all day`;
  if (isSameDay(startMs, endMs)) {
    return `${formatRange(startMs, startMs)}, ${formatTime(startMs)} to ${formatTime(endMs)}`;
  }
  return (
    `${formatRange(startMs, startMs)}, ${formatTime(startMs)}` +
    ` to ${formatRange(endMs, endMs)}, ${formatTime(endMs)}`
  );
}

/** Null for `owner`, which is the unremarkable case and does not deserve a badge. */
export function roleLabel(role: string): string | null {
  switch (role) {
    case "owner":
      return null;
    case "writer":
      return "can edit";
    case "reader":
      return "read only";
    case "freeBusyReader":
      return "busy only";
    default:
      return role;
  }
}

export const canWrite = (role: string): boolean => role === "owner" || role === "writer";

export function responseLabel(status: Attendee["responseStatus"]): string {
  switch (status) {
    case "accepted":
      return "accepted";
    case "declined":
      return "declined";
    case "tentative":
      return "maybe";
    default:
      return "no reply";
  }
}

/** "3 of 5 accepted", or null when nobody was invited. */
export function attendeeTally(attendees: readonly Attendee[]): string | null {
  if (attendees.length === 0) return null;
  const yes = attendees.filter((a) => a.responseStatus === "accepted").length;
  return `${yes} of ${attendees.length} accepted`;
}
