import { describe, expect, it } from "vitest";
import {
  badgesOf,
  conferenceLabel,
  isStrandedAnchor,
  orderGuests,
  place,
  type Bounds,
} from "./EventDetailsModel";
import type { Attendee, Instance } from "../ipc";

const bounds: Bounds = { top: 54, left: 8, right: 1192, bottom: 792 };
const card = { width: 336, height: 300 };

describe("place", () => {
  it("prefers the right of the block, aligned to its top", () => {
    const at = place({ top: 200, left: 300, width: 120, height: 40 }, card, bounds);
    expect(at).toEqual({ top: 200, left: 430, side: "right" });
  });

  it("flips to the left when the right would not fit", () => {
    const at = place({ top: 200, left: 1000, width: 150, height: 40 }, card, bounds);
    expect(at).toEqual({ top: 200, left: 654, side: "left" });
  });

  it("goes below when neither side fits, centred across the block", () => {
    const narrow: Bounds = { top: 54, left: 8, right: 420, bottom: 792 };
    const at = place({ top: 100, left: 120, width: 160, height: 40 }, card, narrow);
    expect(at.side).toBe("below");
    expect(at.top).toBe(150);
    expect(at.left).toBe(32);
  });

  it("goes above when there is no room below", () => {
    const shallow: Bounds = { top: 54, left: 8, right: 420, bottom: 600 };
    const at = place({ top: 500, left: 120, width: 160, height: 40 }, card, shallow);
    expect(at).toEqual({ top: 190, left: 32, side: "above" });
  });

  it("never lets the card hang off the top or the bottom", () => {
    const high = place({ top: 30, left: 300, width: 120, height: 60 }, { width: 336, height: 700 }, bounds);
    expect(high.top).toBe(54);
    const low = place({ top: 700, left: 300, width: 120, height: 20 }, card, bounds);
    expect(low.top).toBe(492);
    expect(low.top + card.height).toBeLessThanOrEqual(bounds.bottom);
  });

  it("takes the middle of the window when the anchor has no size", () => {
    const at = place({ top: 400, left: 600, width: 0, height: 0 }, card, bounds);
    expect(at.side).toBe("centre");
    expect(at.left).toBe(432);
    expect(at.top).toBe(273);
  });

  it("takes the middle of the window when there is no anchor at all", () => {
    expect(place(null, card, bounds).side).toBe("centre");
  });

  it("stays inside bounds smaller than the card itself", () => {
    const tiny: Bounds = { top: 54, left: 8, right: 200, bottom: 200 };
    const at = place({ top: 100, left: 20, width: 40, height: 10 }, card, tiny);
    expect(at.top).toBe(54);
    expect(at.left).toBe(8);
  });
});

describe("isStrandedAnchor", () => {
  it("catches a rectangle scrolled off the top", () => {
    expect(isStrandedAnchor({ top: -80, left: 300, width: 100, height: 40 }, bounds)).toBe(true);
  });

  it("catches a rectangle past the right edge", () => {
    expect(isStrandedAnchor({ top: 200, left: 1400, width: 100, height: 40 }, bounds)).toBe(true);
  });

  it("accepts a rectangle only partly on screen", () => {
    expect(isStrandedAnchor({ top: 20, left: 300, width: 100, height: 80 }, bounds)).toBe(false);
  });
});

const instance = (over: Partial<Instance> = {}): Instance => ({
  colorId: null,
  eventId: "ev-1",
  calendarId: "cal-1",
  accountId: "acct-1",
  originalStart: null,
  start: "2026-08-11T09:00:00+05:30",
  end: "2026-08-11T09:30:00+05:30",
  startMs: 0,
  endMs: 0,
  allDay: false,
  summary: "Stand-up",
  description: null,
  location: null,
  status: "confirmed",
  recurring: false,
  colorHex: "#6f6194",
  etag: null,
  organizer: null,
  attendees: [],
  conference: null,
  readOnly: false,
  pending: false,
  ...over,
});

describe("badgesOf", () => {
  it("says nothing about an ordinary event", () => {
    expect(badgesOf(instance())).toEqual([]);
  });

  it("names everything unusual about the occurrence", () => {
    expect(badgesOf(instance({ status: "tentative", recurring: true, pending: true, readOnly: true }))).toEqual([
      "tentative",
      "repeats",
      "not synced yet",
      "read only",
    ]);
  });
});

describe("conferenceLabel", () => {
  it("prefers the label Google sent", () => {
    const c = { kind: "hangoutsMeet", uri: "https://meet.google.com/a", label: "meet.google.com/a" };
    expect(conferenceLabel(instance({ conference: c }))).toBe("meet.google.com/a");
  });

  it("names Meet when there is no label", () => {
    const c = { kind: "hangoutsMeet", uri: "https://meet.google.com/a", label: null };
    expect(conferenceLabel(instance({ conference: c }))).toBe("Google Meet");
  });

  it("is empty when there is no conference", () => {
    expect(conferenceLabel(instance())).toBe("");
  });
});

const guest = (over: Partial<Attendee>): Attendee => ({
  email: "a@example.com",
  displayName: null,
  responseStatus: "needsAction",
  organizer: false,
  self: false,
  optional: false,
  ...over,
});

describe("orderGuests", () => {
  it("puts the organiser first and the declines last", () => {
    const list = [
      guest({ email: "no@example.com", responseStatus: "declined" }),
      guest({ email: "yes@example.com", responseStatus: "accepted" }),
      guest({ email: "boss@example.com", responseStatus: "needsAction", organizer: true }),
      guest({ email: "maybe@example.com", responseStatus: "tentative" }),
    ];
    expect(orderGuests(list).map((a) => a.email)).toEqual([
      "boss@example.com",
      "yes@example.com",
      "maybe@example.com",
      "no@example.com",
    ]);
  });

  it("does not mutate what it was handed", () => {
    const list = [guest({ email: "b@example.com", responseStatus: "declined" }), guest({ email: "a@example.com" })];
    orderGuests(list);
    expect(list[0].email).toBe("b@example.com");
  });
});
