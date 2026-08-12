// The IPC contract. Every type here mirrors a struct in src-tauri/src/dto.rs. Both sides are
// frozen once written: implementation modules add bodies, not fields.
//
// Typed per-command wrappers live in src/api/, grouped by domain.

import { invoke } from "@tauri-apps/api/core";

/** A Tauri build of any shape, phone included. There is a Rust backend behind this. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const isMobileOs =
  typeof navigator !== "undefined" &&
  (/android|iphone|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac and gives itself away only by having a touchscreen.
    (/ipad|macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/**
 * A Tauri build with a real window behind it: something to drag by its title bar, a maximize to
 * toggle, a close to intercept before it happens.
 *
 * The difference from `isTauri` is not cosmetic and this is not "am I in the app". `core:window:*`
 * sits in the desktop-only capability, so on a phone those commands are not no-ops, they are
 * refused, and calling one is a rejected IPC command rather than nothing happening.
 */
export const isDesktop = isTauri && !isMobileOs;

/**
 * The one window whose title bar has the traffic lights inside the page. `titleBarStyle: "Overlay"`
 * in tauri.conf.json is a macOS-only setting, so on Linux, Windows and every mobile build the
 * header has nothing to leave room for.
 */
export const isMacDesktop =
  isDesktop && typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

/**
 * True when there is a backend to answer a command: Tauri, or the dev fixture in a browser.
 * Data-loading actions gate on this. Anything touching a window API must gate on `isDesktop`
 * instead, and anything listening for a Tauri event on `isTauri`, because a phone emits those too.
 */
export const live = (): boolean => isTauri || import.meta.env.DEV;

export interface Account {
  id: string;
  email: string;
  connected: boolean;
}

export interface Calendar {
  id: string;
  accountId: string;
  summary: string;
  description: string | null;
  colorHex: string;
  selected: boolean;
  accessRole: string;
  timeZone: string;
  primary: boolean;
}

export interface Attendee {
  email: string;
  displayName: string | null;
  responseStatus: "needsAction" | "declined" | "tentative" | "accepted";
  organizer: boolean;
  self: boolean;
  optional: boolean;
}

export interface Conference {
  kind: string;
  uri: string | null;
  label: string | null;
}

/** Identifies one occurrence of a series, stable across syncs. */
export interface InstanceKey {
  eventId: string;
  originalStart: string | null;
}

/**
 * One event occurrence, already expanded and already converted to the local zone.
 *
 * `start` and `end` are RFC3339 with an offset, except when `allDay`, where they are date-only
 * `YYYY-MM-DD` and must never be shifted into a zone. `startMs` and `endMs` are epoch
 * milliseconds, with all-day events pinned to local midnight, and `endMs` is exclusive.
 */
export interface Instance {
  eventId: string;
  calendarId: string;
  accountId: string;
  originalStart: string | null;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  summary: string;
  description: string | null;
  location: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  recurring: boolean;
  /** Resolved for rendering: the event's own colour when it has one, else its calendar's. */
  colorHex: string;
  /** Google's per-event colour id, "1" to "11". Null means the event follows its calendar. */
  colorId: string | null;
  etag: string | null;
  organizer: string | null;
  attendees: Attendee[];
  conference: Conference | null;
  readOnly: boolean;
  /** Written locally and still sitting in the outbox. */
  pending: boolean;
}

export interface EventDraft {
  calendarId: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  start: string;
  end: string;
  allDay: boolean;
  /** Raw RFC5545 lines (RRULE/RDATE/EXDATE), omitted for a one-off. */
  recurrence?: string[];
  /** Google's per-event colour id, "1" to "11". Omit to follow the calendar. */
  colorId?: string;
}

/** An absent field means unchanged. An empty string on `description` or `location` clears it. */
export interface EventPatch {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  calendarId?: string;
  recurrence?: string[];
  /** An empty string clears it back to the calendar's colour. */
  colorId?: string;
}

export type Scope = "this" | "following" | "all";

/**
 * Google's per-event palette, keyed by `colorId`. These are Google's own hex values, so a colour
 * chosen here reads the same in both apps. Rendering maps them onto this app's own hues.
 */
export const EVENT_COLORS: { id: string; hex: string; name: string }[] = [
  { id: "1", hex: "#7986cb", name: "Lavender" },
  { id: "2", hex: "#33b679", name: "Sage" },
  { id: "3", hex: "#8e24aa", name: "Grape" },
  { id: "4", hex: "#e67c73", name: "Flamingo" },
  { id: "5", hex: "#f6bf26", name: "Banana" },
  { id: "6", hex: "#f4511e", name: "Tangerine" },
  { id: "7", hex: "#039be5", name: "Peacock" },
  { id: "8", hex: "#616161", name: "Graphite" },
  { id: "9", hex: "#3f51b5", name: "Blueberry" },
  { id: "10", hex: "#0b8043", name: "Basil" },
  { id: "11", hex: "#d50000", name: "Tomato" },
];

export interface SyncStatus {
  phase: "idle" | "syncing" | "error";
  /** Epoch milliseconds of the last successful sync. */
  lastSync: number | null;
  error: string | null;
  pendingWrites: number;
  message: string | null;
}

/** Payload of the `auth` event. */
export interface AuthEvent {
  ok: boolean;
  error: string | null;
  accountId: string | null;
  email: string | null;
  /** The consent browser was closed by hand. Not `ok`, but not a failure to report either. */
  cancelled: boolean;
}

/** Payload of `sync-progress`. `store-changed` carries a plain reason string. */
export type SyncProgress = SyncStatus;

/**
 * In Tauri this is `invoke`. Opened in a browser during development it is served from the dev
 * fixture instead, so the real UI can be driven and looked at without a Google account. The
 * branch is compiled out of a production bundle, and `isTauri` means it can never shadow the
 * real backend inside the app, on a desktop or on a phone.
 */
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV && !isTauri) {
    return import("./dev/mockIpc").then((m) => m.mockCall<T>(command, args));
  }
  return invoke<T>(command, args);
}
