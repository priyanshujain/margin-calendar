// Pure helpers for the details card: where it goes, and the small amount of vocabulary its
// content needs. Nothing here holds state or touches the DOM, which is what makes it testable in
// a node run.
//
// The placement is the only genuinely fiddly part. The card is anchored to the block that was
// clicked rather than centred, so it has to find a side that fits and then stay inside the window
// whatever happens, including when the anchor is offscreen, has no size at all, or the card is
// taller than the space it was given.

import type { Attendee, Instance } from "../ipc";

/** Viewport coordinates, the same shape `useDetails` stores and a DOMRect satisfies. */
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The region the card is allowed to occupy, in viewport coordinates. */
export interface Bounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Which side of the anchor the card ended up on. `centre` means it gave up and took the window. */
export type Side = "right" | "left" | "below" | "above" | "centre";

export interface Placement {
  top: number;
  left: number;
  side: Side;
}

/** The breathing room between the block and the card. */
export const ANCHOR_GAP = 10;

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return value < low ? low : value > high ? high : value;
}

/**
 * True when the rectangle is not worth aiming at: absent, sizeless, or entirely outside the
 * region the card may occupy. `openDetailsFor` hands over a zero-size rect at the middle of the
 * window when it had no element to measure, and that is exactly the case this catches.
 */
export function isStrandedAnchor(anchor: Rect | null, bounds: Bounds): boolean {
  if (!anchor) return true;
  if (anchor.width <= 0 && anchor.height <= 0) return true;
  return (
    anchor.left + anchor.width <= bounds.left ||
    anchor.left >= bounds.right ||
    anchor.top + anchor.height <= bounds.top ||
    anchor.top >= bounds.bottom
  );
}

/**
 * Right of the block, then left, then below, then above, then the middle of the window. The first
 * side the card fits on wins, and the cross axis is clamped rather than allowed to hang off an
 * edge, so the card is always whole and always on screen.
 */
export function place(anchor: Rect | null, card: Size, bounds: Bounds, gap = ANCHOR_GAP): Placement {
  const middle = (): Placement => ({
    top: clamp(Math.round((bounds.top + bounds.bottom - card.height) / 2), bounds.top, bounds.bottom - card.height),
    left: clamp(Math.round((bounds.left + bounds.right - card.width) / 2), bounds.left, bounds.right - card.width),
    side: "centre",
  });

  if (isStrandedAnchor(anchor, bounds)) return middle();
  const a = anchor as Rect;

  const beside = (left: number, side: Side): Placement => ({
    top: clamp(Math.round(a.top), bounds.top, bounds.bottom - card.height),
    left: Math.round(left),
    side,
  });

  const right = a.left + a.width + gap;
  if (right + card.width <= bounds.right) return beside(right, "right");

  const left = a.left - gap - card.width;
  if (left >= bounds.left) return beside(left, "left");

  const across = clamp(
    Math.round(a.left + a.width / 2 - card.width / 2),
    bounds.left,
    bounds.right - card.width,
  );

  const below = a.top + a.height + gap;
  if (below + card.height <= bounds.bottom) return { top: Math.round(below), left: across, side: "below" };

  const above = a.top - gap - card.height;
  if (above >= bounds.top) return { top: Math.round(above), left: across, side: "above" };

  return middle();
}

const RESPONSE_ORDER: Record<Attendee["responseStatus"], number> = {
  accepted: 0,
  tentative: 1,
  needsAction: 2,
  declined: 3,
};

/** The organiser first, then who is coming, then who is not. Read-only: v1 has no RSVP flow. */
export function orderGuests(attendees: readonly Attendee[]): Attendee[] {
  return attendees
    .slice()
    .sort(
      (a, b) =>
        Number(b.organizer) - Number(a.organizer) ||
        RESPONSE_ORDER[a.responseStatus] - RESPONSE_ORDER[b.responseStatus] ||
        (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email),
    );
}

/** What to call the conference link, falling back through label, kind, then something honest. */
export function conferenceLabel(instance: Instance): string {
  const conference = instance.conference;
  if (!conference) return "";
  if (conference.label) return conference.label;
  if (conference.kind === "hangoutsMeet") return "Google Meet";
  return conference.kind || "Join";
}

/** The badges under the title: everything unusual about this occurrence, and nothing else. */
export function badgesOf(instance: Instance): string[] {
  const out: string[] = [];
  if (instance.status === "tentative") out.push("tentative");
  if (instance.recurring) out.push("repeats");
  if (instance.pending) out.push("not synced yet");
  if (instance.readOnly) out.push("read only");
  return out;
}
