// Serves the IPC surface from the dev fixture when the app is opened in a browser rather than in
// Tauri. This exists so the real UI can be driven and looked at, by a person or by Playwright,
// without a Google account and without a build of the Rust side.
//
// It is reachable only when `import.meta.env.DEV` is true and `isDesktop` is false, so it is
// absent from a production bundle and can never shadow the real backend inside the app.

import { EVENT_COLORS, type Calendar, type EventDraft, type Instance, type InstanceKey, type SyncStatus } from "../ipc";
import { devAccounts, devCalendars, devInstances } from "./fixture";

const calendars: Calendar[] = devCalendars.map((c) => ({ ...c }));
const created: Instance[] = [];
const patched = new Map<string, Partial<Instance>>();
const deleted = new Set<string>();

const keyOf = (key: InstanceKey) => `${key.eventId}|${key.originalStart ?? ""}`;

function apply(list: Instance[]): Instance[] {
  return list
    .filter((i) => !deleted.has(keyOf({ eventId: i.eventId, originalStart: i.originalStart })))
    .map((i) => {
      const patch = patched.get(keyOf({ eventId: i.eventId, originalStart: i.originalStart }));
      return patch ? { ...i, ...patch } : i;
    });
}

export async function mockCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const a = (args ?? {}) as Record<string, never>;
  switch (command) {
    case "accounts_list":
      return devAccounts as unknown as T;
    case "calendars_list":
      return calendars as unknown as T;
    case "calendar_set_selected": {
      const id = a.calendarId as unknown as string;
      const selected = a.selected as unknown as boolean;
      const found = calendars.find((c) => c.id === id);
      if (found) found.selected = selected;
      return undefined as T;
    }
    case "instances_range": {
      const from = a.fromUtc as unknown as number;
      const to = a.toUtc as unknown as number;
      const selected = new Set(calendars.filter((c) => c.selected).map((c) => c.id));
      const live = [...devInstances(from, to), ...created].filter(
        (i) => selected.has(i.calendarId) && i.endMs > from && i.startMs < to,
      );
      return apply(live) as unknown as T;
    }
    case "event_create": {
      const draft = a.draft as unknown as EventDraft;
      const calendar = calendars.find((c) => c.id === draft.calendarId) ?? calendars[0];
      const startMs = draft.allDay ? Date.parse(`${draft.start}T00:00:00`) : Date.parse(draft.start);
      const endMs = draft.allDay ? Date.parse(`${draft.end}T00:00:00`) : Date.parse(draft.end);
      const instance: Instance = {
        eventId: `new-${created.length + 1}`,
        calendarId: calendar.id,
        accountId: calendar.accountId,
        originalStart: null,
        start: draft.start,
        end: draft.end,
        startMs,
        endMs,
        allDay: draft.allDay,
        summary: draft.summary,
        description: draft.description ?? null,
        location: draft.location ?? null,
        status: "confirmed",
        recurring: (draft.recurrence?.length ?? 0) > 0,
        colorHex: EVENT_COLORS.find((c) => c.id === draft.colorId)?.hex ?? calendar.colorHex,
        colorId: draft.colorId ?? null,
        etag: `"new-${created.length + 1}"`,
        organizer: null,
        attendees: [],
        conference: null,
        readOnly: false,
        pending: false,
      };
      created.push(instance);
      return instance as unknown as T;
    }
    case "event_update": {
      const key = a.key as unknown as InstanceKey;
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      // The grid positions from startMs/endMs, so a patch that moves only the strings snaps the
      // block straight back. Derive the milliseconds whenever the wire times change.
      const merged: Partial<Instance> = { ...(patch as Partial<Instance>) };
      const allDay = (patch.allDay as boolean | undefined) ?? undefined;
      if (typeof patch.start === "string") {
        merged.startMs = allDay ? Date.parse(`${patch.start}T00:00:00`) : Date.parse(patch.start);
      }
      if (typeof patch.end === "string") {
        merged.endMs = allDay ? Date.parse(`${patch.end}T00:00:00`) : Date.parse(patch.end);
      }
      const previous = patched.get(keyOf(key)) ?? {};
      patched.set(keyOf(key), { ...previous, ...merged });
      return undefined as T;
    }
    case "event_delete": {
      deleted.add(keyOf(a.key as unknown as InstanceKey));
      return undefined as T;
    }
    case "sync_now":
    case "sync_status":
      return {
        phase: "idle",
        lastSync: Date.now(),
        error: null,
        pendingWrites: 0,
        message: null,
      } satisfies SyncStatus as unknown as T;
    case "sync_flush":
    case "account_disconnect":
      return undefined as T;
    case "account_connect":
      return "https://accounts.google.com/o/oauth2/auth?dev=1" as unknown as T;
    default:
      throw new Error(`dev mock has no handler for ${command}`);
  }
}
