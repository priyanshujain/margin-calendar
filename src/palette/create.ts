// The write side of the palette. Kept out of `parse.ts` so the parser stays a pure module with a
// test suite that never touches Tauri.

import { eventCreate } from "../api/events";
import { useCalendarView } from "../store/useCalendarView";
import { notify } from "../store/useToast";
import { toDraft, type Parsed } from "./parse";

export async function createFromInput(parsed: Parsed, calendarId: string): Promise<void> {
  const title = parsed.title || "Untitled";
  try {
    await eventCreate(toDraft(parsed, calendarId));
    notify(`Created “${title}”`);
    // The write is optimistic in the store, so this is the fastest the grid can show it.
    await useCalendarView.getState().load();
  } catch (e) {
    notify(`Could not create “${title}”: ${e}`);
  }
}
