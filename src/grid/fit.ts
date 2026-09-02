// Vertical fit. The grid never scrolls, so the row height is derived from the window and the
// visible range: whatever you are looking at fits exactly.
//
// Everything here is pure. Times are minutes from local midnight, bounds and folds are whole
// hours, and the only clock reading is `new Date(ms)` to get an event's local wall time. The
// localStorage side of folds lives in `./folds`.

import { MINUTES_PER_DAY, isSameDay, minutesFromMidnight } from "../time";

/** Matches `--strip-h`. A folded band is this tall whatever it contains. */
export const STRIP_H = 22;

/** Matches `--row-h-min`. Below this the grid gives up and scrolls. */
export const ROW_H_MIN = 22;

export const MIN_SPAN_HOURS = 8;

/** A contraction smaller than this is ignored, so the axis holds still while you navigate. */
export const CONTRACT_HOURS = 2;

/** Cold start, before any event has been seen. */
export const DEFAULT_BOUNDS: Bounds = { start: 8, end: 20 };

/** Half-open, in whole hours from local midnight. `end` is exclusive of nothing: 24 is midnight. */
export interface HourRange {
  start: number;
  end: number;
}

export type Bounds = HourRange;
export type Fold = HourRange;

/** The shape the fit needs from an event. `Instance` satisfies it. */
export interface FitEvent {
  startMs: number;
  endMs: number;
  allDay?: boolean;
}

export type SegmentKind = "hours" | "strip";

/**
 * One vertical band of the day. Segments tile `[0, 1440)` in order, so their heights sum to
 * `totalHeight`. An `hours` segment is drawn at `rowHeight` per hour; a `strip` is a folded band
 * drawn at `stripHeight` whatever it spans.
 */
export interface Segment {
  kind: SegmentKind;
  /** Minutes from local midnight, `end` exclusive. */
  start: number;
  end: number;
  y: number;
  height: number;
}

export interface FitInput {
  /** Everything visible in the current span. All-day events are ignored. */
  events?: readonly FitEvent[];
  /** The bounds adopted last pass. Hysteresis and the empty-span fallback need them. */
  previous?: Bounds;
  /** Interior bands the user folded with `z`, in hours. Order and overlap do not matter. */
  folds?: readonly Fold[];
  /** Pixels available to the grid body, below the day bar and the all-day band. */
  viewportHeight: number;
  /** Pins the axis, skipping both the event scan and hysteresis. Still clamped and widened. */
  bounds?: Bounds;
  stripHeight?: number;
  minRowHeight?: number;
}

export interface FitLayout {
  bounds: Bounds;
  rowHeight: number;
  stripHeight: number;
  segments: Segment[];
  /** Hours drawn at `rowHeight`, which is what the row height was solved for. */
  unfoldedHours: number;
  totalHeight: number;
  viewportHeight: number;
  /** The row height hit its floor, so the content is taller than the viewport. Let it scroll. */
  overflow: boolean;
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/**
 * Clamps to `[0, 24]` and widens to the eight hour minimum, splitting the shortfall between the
 * two ends. An odd shortfall gives the extra hour to the later end, where the day actually is,
 * and a widening that would run past midnight pushes into the other end instead.
 */
export function widen(start: number, end: number): Bounds {
  let s = clamp(Math.floor(start), 0, 24);
  let e = clamp(Math.ceil(end), 0, 24);
  if (e < s) e = s;

  const need = MIN_SPAN_HOURS - (e - s);
  if (need > 0) {
    s -= Math.floor(need / 2);
    e += Math.ceil(need / 2);
    if (s < 0) {
      e -= s;
      s = 0;
    }
    if (e > 24) {
      s -= e - 24;
      e = 24;
    }
    s = Math.max(0, s);
  }
  return { start: s, end: e };
}

/**
 * The tightest minute range the timed events cover, or null when there are none.
 *
 * An event that crosses local midnight covers both ends of the day, so it returns the whole day.
 * Multi-day timed events belong in the all-day band; drop them before calling if you render them
 * there, otherwise they pin the axis open.
 */
export function eventSpan(events: readonly FitEvent[]): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;

  for (const e of events) {
    if (e.allDay) continue;
    if (!Number.isFinite(e.startMs) || !Number.isFinite(e.endMs)) continue;

    const start = e.startMs;
    const end = Math.max(e.endMs, start);
    const endsAtMidnight = end > start && minutesFromMidnight(end) === 0;
    // `endMs` is exclusive, so an event ending at midnight ends on the day before.
    const lastDay = endsAtMidnight ? end - 1 : end;

    let a: number;
    let b: number;
    if (isSameDay(start, lastDay)) {
      a = minutesFromMidnight(start);
      b = endsAtMidnight ? MINUTES_PER_DAY : minutesFromMidnight(end);
    } else {
      a = 0;
      b = MINUTES_PER_DAY;
    }

    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }

  return lo === Infinity ? null : { lo, hi };
}

/**
 * Hysteresis. Any expansion is adopted at once; a contraction is adopted only when it gives up
 * two hours or more. The two are measured together, so a pass that grows one end and trims the
 * other by an hour keeps the growth and holds the trim.
 */
export function adoptBounds(previous: Bounds, next: Bounds): Bounds {
  const merged = {
    start: Math.min(previous.start, next.start),
    end: Math.max(previous.end, next.end),
  };
  const given = merged.end - merged.start - (next.end - next.start);
  return given >= CONTRACT_HOURS ? next : merged;
}

/**
 * Floor to the hour below the earliest start, ceil above the latest end, widen to the minimum.
 * Null when nothing is visible, which is the caller's cue to keep what it had.
 */
export function rawBounds(events: readonly FitEvent[]): Bounds | null {
  const span = eventSpan(events);
  if (!span) return null;
  return widen(Math.floor(span.lo / 60) - 1, Math.ceil(span.hi / 60) + 1);
}

/** `rawBounds` with the empty-span fallback and the hysteresis applied. */
export function computeBounds(events: readonly FitEvent[], previous: Bounds): Bounds {
  const held = widen(previous.start, previous.end);
  const raw = rawBounds(events);
  return raw ? adoptBounds(held, raw) : held;
}

/** Sorted, with overlapping and touching ranges merged. */
function mergeRanges(ranges: readonly HourRange[]): HourRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: HourRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** Drops the junk, clips to `[0, 24]`, merges what touches. Fold state is a set, not a list. */
export function normalizeFolds(folds: readonly Fold[]): Fold[] {
  const clean = folds
    .filter((f) => Number.isFinite(f.start) && Number.isFinite(f.end))
    .map((f) => ({ start: clamp(f.start, 0, 24), end: clamp(f.end, 0, 24) }));
  return mergeRanges(clean);
}

export function addFold(folds: readonly Fold[], range: Fold): Fold[] {
  return normalizeFolds([...folds, range]);
}

/**
 * The folds with the busy hours taken out of them. A fold hides empty time and nothing else, so
 * an event landing in a folded hour gives that hour back at once, and a fold with an event in
 * the middle of it shows as two strips. The range itself is kept as it was: page to a span where
 * the hour is empty again and it folds back.
 */
export function trimFolds(folds: readonly Fold[], busy: readonly boolean[]): Fold[] {
  const out: Fold[] = [];
  for (const f of normalizeFolds(folds)) {
    let start = f.start;
    for (let h = f.start; h < f.end; h++) {
      if (!busy[h]) continue;
      if (h > start) out.push({ start, end: h });
      start = h + 1;
    }
    if (f.end > start) out.push({ start, end: f.end });
  }
  return out;
}

const overlaps = (a: HourRange, b: HourRange): boolean => a.start < b.end && a.end > b.start;

/**
 * Takes an expanded strip out of the folds. The fold it came from keeps the other strips it was
 * showing and nothing else: the hours an event was covering go too, so expanding a strip never
 * leaves a piece of fold behind that could come back on its own once the event moves.
 */
export function unfoldStrip(folds: readonly Fold[], busy: readonly boolean[], strip: Fold): Fold[] {
  const out: Fold[] = [];
  for (const f of normalizeFolds(folds)) {
    if (!overlaps(f, strip)) {
      out.push(f);
      continue;
    }
    for (const piece of trimFolds([f], busy)) if (!overlaps(piece, strip)) out.push(piece);
  }
  return out;
}

/**
 * Solves the row height for the viewport and lays the day out.
 *
 * The bands outside the bounds fold into a strip at each end, interior folds become strips where
 * they sit, and the hours left over share whatever height remains. When that share falls below
 * `minRowHeight` the row height sticks there and `overflow` says the grid has to scroll.
 */
export function computeFit(input: FitInput): FitLayout {
  const stripHeight = input.stripHeight ?? STRIP_H;
  const minRowHeight = input.minRowHeight ?? ROW_H_MIN;
  const viewportHeight = Math.max(0, input.viewportHeight);

  const bounds = input.bounds
    ? widen(input.bounds.start, input.bounds.end)
    : computeBounds(input.events ?? [], input.previous ?? DEFAULT_BOUNDS);

  const boundStart = bounds.start * 60;
  const boundEnd = bounds.end * 60;

  const interior = normalizeFolds(input.folds ?? []).map((f) => ({
    start: clamp(f.start * 60, boundStart, boundEnd),
    end: clamp(f.end * 60, boundStart, boundEnd),
  }));

  const folded = mergeRanges([
    { start: 0, end: boundStart },
    ...interior,
    { start: boundEnd, end: MINUTES_PER_DAY },
  ]);

  let foldedMinutes = 0;
  for (const f of folded) foldedMinutes += f.end - f.start;
  const unfoldedHours = (MINUTES_PER_DAY - foldedMinutes) / 60;

  const spare = viewportHeight - folded.length * stripHeight;
  let rowHeight = unfoldedHours > 0 ? spare / unfoldedHours : minRowHeight;
  if (!Number.isFinite(rowHeight) || rowHeight < minRowHeight) rowHeight = minRowHeight;

  const segments: Segment[] = [];
  let cursor = 0;
  let y = 0;
  const push = (kind: SegmentKind, start: number, end: number) => {
    const height = kind === "strip" ? stripHeight : ((end - start) / 60) * rowHeight;
    segments.push({ kind, start, end, y, height });
    y += height;
  };
  for (const f of folded) {
    if (f.start > cursor) push("hours", cursor, f.start);
    push("strip", f.start, f.end);
    cursor = f.end;
  }
  if (cursor < MINUTES_PER_DAY) push("hours", cursor, MINUTES_PER_DAY);

  const totalHeight = y;

  return {
    bounds,
    rowHeight,
    stripHeight,
    segments,
    unfoldedHours,
    totalHeight,
    viewportHeight,
    // Sub-pixel spill is float noise, not a reason to grow a scrollbar.
    overflow: totalHeight > viewportHeight + 0.5,
  };
}

function segmentAtTime(layout: FitLayout, minutes: number): Segment | null {
  for (const s of layout.segments) if (minutes >= s.start && minutes < s.end) return s;
  return null;
}

function segmentAtY(layout: FitLayout, y: number): Segment | null {
  for (const s of layout.segments) if (y >= s.y && y < s.y + s.height) return s;
  return null;
}

/**
 * Minutes from local midnight to a pixel offset from the top of the grid body.
 *
 * Exact inverse of `yToTime` anywhere in an unfolded band, including at its edges. A time inside
 * a folded band collapses to the top of its strip, so the mapping stays monotonic but loses the
 * minute: there is nowhere for it to go in 22 pixels.
 */
export function timeToY(layout: FitLayout, minutes: number): number {
  if (!(minutes > 0)) return 0;
  if (minutes >= MINUTES_PER_DAY) return layout.totalHeight;
  const s = segmentAtTime(layout, minutes);
  if (!s) return layout.totalHeight;
  if (s.kind === "strip") return s.y;
  return s.y + ((minutes - s.start) / 60) * layout.rowHeight;
}

/** Pixels back to minutes. A pixel inside a strip reads as the first minute the strip hides. */
export function yToTime(layout: FitLayout, y: number): number {
  if (!(y > 0)) return 0;
  if (y >= layout.totalHeight) return MINUTES_PER_DAY;
  const s = segmentAtY(layout, y);
  if (!s) return MINUTES_PER_DAY;
  if (s.kind === "strip") return s.start;
  return s.start + ((y - s.y) / layout.rowHeight) * 60;
}

/** True when the minute is hidden inside a strip, so a block there renders as a count. */
export function isFolded(layout: FitLayout, minutes: number): boolean {
  return segmentAtTime(layout, minutes)?.kind === "strip";
}
