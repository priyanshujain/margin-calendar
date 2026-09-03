// Pure model helpers for the grid: slicing instances into days, mapping a calendar colour onto
// the eight muted hues, and the small amount of geometry that is not already in `src/grid`.
//
// Nothing here holds state or touches the DOM. It is a `.tsx` file only because the grid owns
// `Grid*.tsx` and nothing else.

import type { CSSProperties } from "react";
import type { Bounds, Fold } from "../grid/fit";
import type { Instance, InstanceKey } from "../ipc";
import { MINUTES_PER_DAY, addDays, isSameDay, minutesFromMidnight } from "../time";

/** Inline custom properties. The geometry is CSS's job; JS only hands it the numbers. */
export const vars = (style: Record<string, string | number | undefined>): CSSProperties =>
  style as CSSProperties;

/** Drags land on a quarter hour. Fine enough to be useful, coarse enough to be predictable. */
export const SNAP_MINUTES = 15;

/** Nothing shorter than this can be dragged into existence, or resized down to. */
export const MIN_EVENT_MINUTES = 15;

/** Matches `--event-min-h`. A five minute event still has to be a bar you can hit. */
export const MIN_BLOCK_H = 12;

/** Start and end in epoch milliseconds, which is all the geometry ever needs from an event. */
export interface Times {
  startMs: number;
  endMs: number;
}

/** One event placed on a day column, with any optimistic override already applied. */
export interface Placed extends Times {
  instance: Instance;
  id: string;
}

export const keyOf = (i: Instance): InstanceKey => ({
  eventId: i.eventId,
  originalStart: i.originalStart,
});

/** Stable string form of an `InstanceKey`, for map keys and React keys. */
export const keyId = (k: InstanceKey): string => `${k.eventId}\0${k.originalStart ?? ""}`;

export const sameKey = (a: InstanceKey | null, b: InstanceKey | null): boolean =>
  a !== null && b !== null && a.eventId === b.eventId && a.originalStart === b.originalStart;

/**
 * True when the event covers more than one local day. Those go in the all-day band, because they
 * genuinely occupy midnight and would otherwise pin the axis open at both ends.
 */
export function isMultiDay(t: Times): boolean {
  const last = t.endMs > t.startMs ? t.endMs - 1 : t.startMs;
  return !isSameDay(t.startMs, last);
}

/** All-day and multi-day events live in the band under the day headers, never on the axis. */
export const inBand = (i: Instance, t: Times = i): boolean => i.allDay || isMultiDay(t);

export const isVisible = (i: Instance): boolean => i.status !== "cancelled";

/** The event's minutes from local midnight on `dayStart`, clipped to the day. */
export function dayMinutes(t: Times, dayStart: number): { startMin: number; endMin: number } {
  const dayEnd = addDays(dayStart, 1);
  const startMin = t.startMs <= dayStart ? 0 : Math.min(MINUTES_PER_DAY, minutesFromMidnight(t.startMs));
  const endMin =
    t.endMs >= dayEnd ? MINUTES_PER_DAY : Math.max(startMin, minutesFromMidnight(t.endMs));
  return { startMin, endMin };
}

/** Wall-clock minutes back to an instant, so a drag across a DST boundary keeps the clock time. */
export function minutesToMs(dayStart: number, minutes: number): number {
  const d = new Date(dayStart);
  d.setMinutes(Math.round(minutes));
  return d.getTime();
}

export const clampMinutes = (minutes: number): number =>
  minutes < 0 ? 0 : minutes > MINUTES_PER_DAY ? MINUTES_PER_DAY : minutes;

export const snapMinutes = (minutes: number, step = SNAP_MINUTES): number =>
  clampMinutes(Math.round(minutes / step) * step);

export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? "am" : "pm";
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
}

export function rangeLabel(range: Bounds): string {
  return `${hourLabel(range.start)} to ${hourLabel(range.end)}`;
}

// The hue of each --cal-N in the light palette. Both palettes keep the same order, so a slot
// chosen here still reads as the same calendar after a theme switch.
const CAL_HUES = [256, 155, 18, 216, 36, 344, 193, 74];

function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) {
    const [r, g, b] = hex.split("").map((c) => parseInt(c + c, 16));
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  if (hex.length !== 6) return null;
  const n = parseInt(hex, 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A colour in HSL, with the hue left at zero when it is too grey to have one. */
function hexHsl(value: string | null | undefined): { h: number; s: number; l: number } | null {
  if (!value) return null;
  const rgb = parseHex(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = ((max + min) / 2) * 100;
  if (d < 0.08) return { h: 0, s: 0, l };
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: (d / (1 - Math.abs((max + min) - 1))) * 100, l };
}

/** Hue in degrees, or null when the colour is unparseable or too grey to have one. */
function hexHue(value: string | null | undefined): number | null {
  const hsl = hexHsl(value);
  return hsl === null || hsl.s === 0 ? null : hsl.h;
}

function hashSlot(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % CAL_HUES.length) + 1;
}

/**
 * Google's palette is louder than warm paper can carry, so a calendar's colour picks the nearest
 * of the eight muted hues rather than being used raw. Greys and missing colours fall back to a
 * stable hash of the calendar id, so at least two calendars rarely collide.
 */
export function calSlot(colorHex: string | null | undefined, seed: string): number {
  const hue = hexHue(colorHex);
  if (hue === null) return hashSlot(seed);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < CAL_HUES.length; i++) {
    const raw = Math.abs(hue - CAL_HUES[i]) % 360;
    const d = raw > 180 ? 360 - raw : raw;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best + 1;
}

/**
 * The hue angle a block is drawn at: the same slot `calSlot` picks, as the one number grid.css
 * needs to build a whole pill out of.
 *
 * The blocks take the angle rather than `var(--cal-N)` because every surface and every piece of
 * type on a filled pill is a different lightness of the same hue, and a colour derived with
 * `color-mix()` or `oklch()` is not a legacy sRGB colour: it computes to `color(srgb ...)`, which
 * nothing compositing the layers behind a block can read. `hsl()` with a substituted hue still
 * computes to plain `rgb()`. Since both palettes keep the same order, the angle names the same
 * calendar in either theme.
 */
export const calHue = (colorHex: string | null | undefined, seed: string): number =>
  CAL_HUES[calSlot(colorHex, seed) - 1];

/** Everything grid.css needs to paint one block. See `calTint`. */
export interface CalTint {
  /** Hue angle in degrees. */
  h: number;
  /** Multiplier on every level's saturation. Zero for a colour with no hue, so a grey stays grey. */
  sat: number;
  /** Lightness offset in points, positive towards the paper, negative away from it. */
  lift: number;
}

const clampLift = (n: number): number => Math.max(-6, Math.min(6, Math.round(n)));

/**
 * How a block is painted: the hue, how much of it, and how deep.
 *
 * A calendar's colour is snapped to one of the eight, because the overwhelming majority of events
 * follow their calendar and eight muted hues is what keeps a week readable. An event that carries
 * its own `colorId` is not snapped: picking Tangerine and getting Tomato is the feature not
 * working, and Google's eleven do not fall into eight buckets. Six of them share a hue with
 * another to within a few degrees, so hue alone would not tell Lavender from Blueberry or Sage
 * from Basil either. What separates those pairs in Google's palette is depth, not hue, so depth is
 * carried across as well: how saturated the source is scales the block's saturation, how dark it
 * is moves the block away from the paper. That is the harmonising step. The eleven are never
 * painted at their own lightness, which is far louder than this grid can carry; they land in the
 * same band as the eight, at their own hue and their own depth within it.
 */
export function calTint(
  colorHex: string | null | undefined,
  colorId: string | null | undefined,
  seed: string,
): CalTint {
  if (!colorId) return { h: calHue(colorHex, seed), sat: 1, lift: 0 };
  const own = hexHsl(colorHex);
  if (own === null) return { h: calHue(colorHex, seed), sat: 1, lift: 0 };
  const lift = clampLift((own.l - 50) * 0.45);
  // Graphite is the one Google offers with no hue at all, and it has to come out grey.
  if (own.s === 0) return { h: 0, sat: 0, lift };
  return {
    h: Math.round(own.h),
    sat: Math.round((0.65 + (own.s / 100) * 0.45) * 100) / 100,
    lift,
  };
}

/** The custom properties a block hands CSS. The whole pill is built from these three numbers. */
export function calVars(i: {
  colorHex: string | null;
  colorId: string | null;
  calendarId: string;
}): Record<string, number> {
  const tint = calTint(i.colorHex, i.colorId, i.calendarId);
  return { "--cal-h": tint.h, "--cal-sat": tint.sat, "--cal-lift": tint.lift };
}

/**
 * What an event with no summary reads as.
 *
 * A calendar shared at `freeBusyReader` returns every event with an empty summary, and on a real
 * account that is most of them. They are not untitled events, they are the shape of someone
 * else's day, so they say what they mean.
 */
export const BUSY_LABEL = "Busy";

/** True when Google gave us no title, which is the free/busy case rather than a missing one. */
export const isBusy = (i: Instance): boolean => i.summary.trim() === "";

export const eventTitle = (i: Instance): string => i.summary.trim() || BUSY_LABEL;

/** An invitation this account turned down. Still on the grid, plainly not happening. */
export const isDeclined = (i: Instance): boolean =>
  i.attendees.some((a) => a.self && a.responseStatus === "declined");

export type BlockSize = "bar" | "short" | "full";

// The ladder is tuned against the type scale, because the block has to decide what it can show
// before the browser has laid any of it out. --t-2 at line-height 1.25 is 15px, --t-1 at 1.2 is
// 13px, and the block keeps 2px of padding at each end. Moving those in grid.css moves these.
const PAD_Y = 4;
const TITLE_LINE = 15;
const META_LINE = 13;

/** More than this is a column of fragments rather than a title, however tall the block is. */
const MAX_LINES = 3;

/**
 * How much of itself a block can show at this height: a title with the time and place under it,
 * a title alone, or a compact bar. Never nothing: a five minute event still has to say what it
 * is, so `bar` carries a single small line rather than being a featureless sliver.
 */
export function blockSize(height: number): BlockSize {
  if (height >= PAD_Y + TITLE_LINE + META_LINE) return "full";
  if (height >= PAD_Y + TITLE_LINE) return "short";
  return "bar";
}

/**
 * Lines the title may wrap to. Capped, because a narrow column breaks a long title into one word
 * per line and eight of those are less readable than one line and an ellipsis. Width does the
 * rest of the clamping, in grid.css, where the block's own width is knowable.
 */
export function titleLines(height: number, meta: boolean): number {
  const room = height - PAD_Y - (meta ? META_LINE : 0);
  return Math.max(1, Math.min(MAX_LINES, Math.floor(room / TITLE_LINE)));
}

/** Which whole hours of the day any of these events touch. */
export function busyHours(items: readonly Placed[]): boolean[] {
  const busy = new Array<boolean>(24).fill(false);
  for (const item of items) {
    const day = new Date(item.startMs);
    day.setHours(0, 0, 0, 0);
    const { startMin, endMin } = dayMinutes(item, day.getTime());
    const from = Math.floor(startMin / 60);
    const to = Math.min(24, Math.max(from + 1, Math.ceil(endMin / 60)));
    for (let h = from; h < to; h++) busy[h] = true;
  }
  return busy;
}

/**
 * The hours the grid keeps at full scale whatever fold or bound covers them: every hour an event
 * touches, and the hour it is now when today is one of the columns. This is the one definition,
 * and everything that hides an hour or offers to hide one goes through it.
 */
export function heldHours(items: readonly Placed[], nowHour: number | null): boolean[] {
  const held = busyHours(items);
  if (nowHour !== null && nowHour >= 0 && nowHour < 24) held[nowHour] = true;
  return held;
}

/**
 * The band `z` would fold at this hour: the whole empty run around it, stopped by the held hours
 * and the bounds. Null on a held hour, since a fold hides empty time and a fold over an hour with
 * an event in it, or the hour it is now, would come straight back. Interior gaps never fold
 * themselves, so this only runs on demand.
 */
export function bandAt(held: readonly boolean[], bounds: Bounds, hour: number): Fold | null {
  if (held[hour]) return null;
  let start = hour;
  let end = hour + 1;
  while (start > bounds.start && !held[start - 1]) start--;
  while (end < bounds.end && !held[end]) end++;
  return { start, end };
}

/** One all-day or multi-day event, spanning `[from, to)` of the visible day columns. */
export interface BandItem {
  instance: Instance;
  id: string;
  from: number;
  to: number;
}

export function bandItems(instances: readonly Instance[], days: readonly number[]): BandItem[] {
  const items: BandItem[] = [];
  if (days.length === 0) return items;
  const spanEnd = addDays(days[days.length - 1], 1);
  for (const instance of instances) {
    if (instance.startMs >= spanEnd || instance.endMs <= days[0]) continue;
    let from = 0;
    let to = days.length;
    for (let i = 0; i < days.length; i++) {
      if (instance.startMs >= addDays(days[i], 1)) from = i + 1;
      if (instance.endMs > days[i]) to = i + 1;
    }
    if (from < to) items.push({ instance, id: keyId(keyOf(instance)), from, to });
  }
  items.sort(
    (a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || a.instance.startMs - b.instance.startMs,
  );
  return items;
}

/** Greedy rows: the first row where nothing already covers those columns. */
export function bandRows(items: readonly BandItem[]): BandItem[][] {
  const rows: BandItem[][] = [];
  for (const item of items) {
    let row = rows.find((r) => r.every((o) => o.to <= item.from || o.from >= item.to));
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(item);
  }
  return rows;
}
