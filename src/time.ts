// Local wall-clock date maths. The grid renders in the local zone, so everything here works in
// terms of the browser's local time and epoch milliseconds, never UTC components.
//
// All-day events are date-only and must never be shifted into a zone: use `parseDateOnly` and
// `toDateOnly` for those, never `new Date(isoString)`, which would drag them across a boundary.

export const MINUTES_PER_DAY = 1440;

const WEEK_START_KEY = "margincal-week-start";

/**
 * 0 is Sunday, 1 is Monday, defaulting to Monday. Compared as a string on purpose: an absent key
 * reads as null, and `Number(null)` is 0, which would silently make Sunday the default.
 */
export function weekStartDay(): number {
  return localStorage.getItem(WEEK_START_KEY) === "0" ? 0 : 1;
}

export function setWeekStartDay(day: 0 | 1): void {
  localStorage.setItem(WEEK_START_KEY, String(day));
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * The first column of a week view. It is simply wherever the anchor is, because the anchor is
 * already parked on a week boundary by `jumpTo`, `goToday` and switching into the view.
 *
 * Snapping here instead would make a one-day step invisible six times out of seven. Keeping it
 * raw is what lets `h`/`l` and the single chevrons slide the window a day at a time as a temporary
 * look, without changing which day a week starts on.
 */
export function weekAnchor(ms: number): number {
  return startOfDay(ms);
}

/** Anchored to the configured first day of the week, at local midnight. */
export function startOfWeek(ms: number): number {
  const start = weekStartDay();
  const d = new Date(startOfDay(ms));
  const shift = (d.getDay() - start + 7) % 7;
  d.setDate(d.getDate() - shift);
  return d.getTime();
}

export function today(): number {
  return startOfDay(Date.now());
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** Minutes from local midnight. A DST day is 23 or 25 hours, so this can exceed 1440. */
export function minutesFromMidnight(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** `YYYY-MM-DD` in local terms, for an all-day boundary. */
export function toDateOnly(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Local midnight of a `YYYY-MM-DD` string, never parsed as UTC. */
export function parseDateOnly(value: string): number {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
}

/** RFC3339 with the local offset, which is what the Rust side expects for a timed event. */
export function toOffsetIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const dayName = (ms: number) => dayNames[new Date(ms).getDay()];
export const monthName = (ms: number) => monthNames[new Date(ms).getMonth()];

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}

/** The header's date range, collapsed where the two ends share a month or a year. */
export function formatRange(from: number, to: number): string {
  const a = new Date(from);
  const b = new Date(to);
  if (isSameDay(from, to)) return `${dayName(from)} ${a.getDate()} ${monthName(from)} ${a.getFullYear()}`;
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear())
    return `${a.getDate()} to ${b.getDate()} ${monthName(from)} ${a.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear())
    return `${a.getDate()} ${monthName(from)} to ${b.getDate()} ${monthName(to)} ${a.getFullYear()}`;
  return `${a.getDate()} ${monthName(from)} ${a.getFullYear()} to ${b.getDate()} ${monthName(to)} ${b.getFullYear()}`;
}
