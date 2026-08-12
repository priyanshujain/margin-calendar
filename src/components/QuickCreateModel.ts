// The pure half of the quick create card: where the card sits next to the range it is about to
// create, and what that range actually is once the parser has had its say.
//
// Nothing here holds state or touches the DOM, which is what lets the placement maths be pinned in
// a node run the way `overlayModel.ts` pins the editor's conversions.

import type { EventDraft } from "../ipc";
import { previewText, type Parsed } from "../palette/parse";
import { addDays, minutesFromMidnight, startOfDay, toDateOnly, toOffsetIso } from "../time";
import { minutesToMs } from "./GridModel";

/** The range the card will create, in epoch milliseconds. `endMs` is exclusive. */
export interface Slot {
  startMs: number;
  endMs: number;
  allDay: boolean;
}

export const minutesOf = (slot: Slot): number => Math.round((slot.endMs - slot.startMs) / 60_000);

/**
 * `DEFAULT_MINUTES` from `parse.ts`, which is not exported. It is only used to tell a duration the
 * user typed from the one the parser assumes, and being wrong about that costs the dragged length,
 * never the event.
 */
const PARSER_DEFAULT_MINUTES = 60;

/**
 * What the typed text says about when, or null when it says nothing and the drag still holds.
 *
 * A chrono hit is taken whole, because `tue 1pm` is unambiguously a new time. A bare duration with
 * no date only moves the end: that is the one other thing the parser knows which the drag does not.
 */
export function slotFromParse(parsed: Parsed, current: Slot): Slot | null {
  if (parsed.dated) return { startMs: parsed.startMs, endMs: parsed.endMs, allDay: parsed.allDay };
  if (parsed.allDay) return allDaySlot(current);
  if (parsed.minutes > 0 && parsed.minutes !== PARSER_DEFAULT_MINUTES) {
    return { startMs: current.startMs, endMs: current.startMs + parsed.minutes * 60_000, allDay: false };
  }
  return null;
}

/** Midnight to the midnight after the last day it touches, which is the exclusive end the wire wants. */
export function allDaySlot(slot: Slot): Slot {
  const startMs = startOfDay(slot.startMs);
  const last = startOfDay(Math.max(slot.endMs - 1, slot.startMs));
  return { startMs, endMs: addDays(last, 1), allDay: true };
}

/** All-day back to a time: the same day, at the time of day and the length `template` has. */
export function timedSlot(slot: Slot, template: Slot): Slot {
  const day = startOfDay(slot.startMs);
  const startMin = Math.round(minutesFromMidnight(template.startMs));
  const minutes = Math.max(1, minutesOf(template));
  return {
    startMs: minutesToMs(day, startMin),
    endMs: minutesToMs(day, startMin + minutes),
    allDay: false,
  };
}

/** A time field edited: the start drags its end along, the end never lands before its start. */
export function withStart(slot: Slot, startMs: number, minMinutes: number): Slot {
  if (!Number.isFinite(startMs)) return slot;
  return { ...slot, startMs, endMs: startMs + Math.max(minMinutes, minutesOf(slot)) * 60_000 };
}

export function withEnd(slot: Slot, endMs: number, minMinutes: number): Slot {
  if (!Number.isFinite(endMs)) return slot;
  return { ...slot, endMs: Math.max(endMs, slot.startMs + minMinutes * 60_000) };
}

/** Everything the card knows about the event that is not when it is. */
export interface Fields {
  calendarId: string;
  summary: string;
  location: string | null;
  description: string | null;
  /** Google's per-event colour id, or null to follow the calendar. */
  colorId: string | null;
}

/** Built with `toOffsetIso` and `toDateOnly` so an all-day boundary never crosses a zone. */
export function draftOf(slot: Slot, fields: Fields): EventDraft {
  const bounds = slot.allDay
    ? { start: toDateOnly(slot.startMs), end: toDateOnly(slot.endMs) }
    : { start: toOffsetIso(slot.startMs), end: toOffsetIso(slot.endMs) };
  return {
    calendarId: fields.calendarId,
    summary: fields.summary || "Untitled",
    location: fields.location,
    description: fields.description,
    allDay: slot.allDay,
    ...bounds,
    // Left out entirely rather than sent empty when the event follows its calendar: an absent id
    // is what the wire reads as "no override", and an empty one is not a colour.
    ...(fields.colorId ? { colorId: fields.colorId } : {}),
  };
}

/**
 * The palette's own sentence, told about the slot the card will really create rather than the one
 * the text described. The two differ the moment a time field is touched, and the sentence is only
 * worth having if it is the one that is true.
 */
export function sentenceFor(
  parsed: Parsed,
  slot: Slot,
  title: string,
  location: string | null,
  calendarName: string | null,
): string {
  return previewText(
    {
      ...parsed,
      title,
      location,
      startMs: slot.startMs,
      endMs: slot.endMs,
      allDay: slot.allDay,
      minutes: slot.allDay ? 0 : minutesOf(slot),
    },
    calendarName,
  );
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Side = "right" | "left" | "below" | "above";

export interface Placement {
  left: number;
  top: number;
  side: Side;
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/**
 * Beside the range if there is room, under or over it if there is not, and never outside `bounds`.
 *
 * Covering the range is the one thing it must not do. The range is the only thing the user has said
 * so far, and a card sitting on top of it hides the answer to "what did I just drag?".
 */
export function placeCard(anchor: Box, card: Size, bounds: Box, gap: number): Placement {
  const beside = clamp(anchor.top, bounds.top, Math.max(bounds.top, bounds.bottom - card.height));
  if (anchor.right + gap + card.width <= bounds.right) {
    return { left: anchor.right + gap, top: beside, side: "right" };
  }
  if (anchor.left - gap - card.width >= bounds.left) {
    return { left: anchor.left - gap - card.width, top: beside, side: "left" };
  }
  const left = clamp(anchor.left, bounds.left, Math.max(bounds.left, bounds.right - card.width));
  if (anchor.bottom + gap + card.height <= bounds.bottom) {
    return { left, top: anchor.bottom + gap, side: "below" };
  }
  if (anchor.top - gap - card.height >= bounds.top) {
    return { left, top: anchor.top - gap - card.height, side: "above" };
  }
  // Nothing fits. Hang off the top of the range rather than centring on it, so the edge still shows.
  const top = clamp(anchor.top + gap, bounds.top, Math.max(bounds.top, bounds.bottom - card.height));
  return { left, top, side: "below" };
}
