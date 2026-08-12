// Every action the app can be asked to perform, in one table.
//
// A key, a menu item and a palette row all end up here, which is the point: the native menu emits
// an id and that id is a command, not a second code path. The label lives on the command rather
// than on the binding so the shortcut sheet, the palette and the menu cannot describe the same
// thing in three different ways.
//
// Nothing here holds state. Side effects go through the stores and through `gridCommands`, which
// is the imperative surface the grid publishes for exactly this.

import { openUrl } from "@tauri-apps/plugin-opener";
import { eventDelete } from "../api/events";
import { gridCommands } from "../components/GridStore";
import { useEditor } from "../components/useEditor";
import type { Instance } from "../ipc";
import { defaultStart } from "../palette/parse";
import { eventTitle } from "../components/GridModel";
import { useCalendarView } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { useSync } from "../store/useSync";
import { useTheme } from "../store/useTheme";
import { notify } from "../store/useToast";
import { minutesFromMidnight, startOfDay } from "../time";
import { checkForUpdates } from "./updates";

const ISSUES_URL = "https://github.com/priyanshujain/margin-calendar/issues";

/** New events start an hour long, whether they are dragged out or typed. */
const NEW_MINUTES = 60;

export type CommandId =
  | "day-prev"
  | "day-next"
  | "week-prev"
  | "week-next"
  | "today"
  | "select-next"
  | "select-prev"
  | "mini-month"
  | "view-day"
  | "view-week"
  | "view-agenda"
  | "fold"
  | "unfold-all"
  | "new-event"
  | "open-selection"
  | "edit-selection"
  | "delete-selection"
  | "search"
  | "command-palette"
  | "shortcuts"
  | "sync-now"
  | "calendars"
  | "accounts"
  | "settings"
  | "toggle-theme"
  | "check-updates"
  | "report-issue";

export interface Command {
  id: CommandId;
  /** The words the shortcut sheet, the palette and any tooltip all use. */
  label: string;
  /** Whether the palette lists it. Moving one day at a time is a key, not a menu entry. */
  palette: boolean;
  run: () => void;
}

const view = () => useCalendarView.getState();
const overlays = () => useOverlays.getState();

function selectedInstance(): Instance | null {
  const { instances, selected } = view();
  if (!selected) return null;
  return (
    instances.find(
      (i) => i.eventId === selected.eventId && i.originalStart === selected.originalStart,
    ) ?? null
  );
}

function openSelection(): void {
  const instance = selectedInstance();
  // Enter on nothing at all is a request for the first event of the day, not a mistake.
  if (!instance) {
    view().selectAdjacent(1);
    return;
  }
  useEditor.getState().edit({ eventId: instance.eventId, originalStart: instance.originalStart });
}

function editSelection(): void {
  const instance = selectedInstance();
  if (!instance) {
    notify("Nothing is selected");
    return;
  }
  useEditor.getState().edit({ eventId: instance.eventId, originalStart: instance.originalStart });
}

/**
 * `this` is the only scope a keystroke may pick: deleting a whole series is a decision that
 * belongs in the editor, behind a confirmation.
 */
async function deleteSelection(): Promise<void> {
  const instance = selectedInstance();
  if (!instance) {
    notify("Nothing is selected");
    return;
  }
  if (instance.readOnly) {
    notify("That calendar is read only");
    return;
  }
  const title = eventTitle(instance);
  try {
    await eventDelete(
      { eventId: instance.eventId, originalStart: instance.originalStart },
      "this",
    );
    view().select(null);
    await view().load();
    notify(instance.recurring ? `Deleted this occurrence of “${title}”` : `Deleted “${title}”`);
  } catch (e) {
    notify(`Could not delete “${title}”: ${e}`);
  }
}

/** The grid takes a typed-in-place draft when the day is on screen; the agenda has no column. */
function newEvent(): void {
  const startMs = defaultStart(view().anchor, Date.now());
  const dayStart = startOfDay(startMs);
  if (view().view !== "agenda" && gridCommands.days().includes(dayStart)) {
    gridCommands.draftOn(dayStart, Math.round(minutesFromMidnight(startMs)), NEW_MINUTES);
    return;
  }
  useEditor.getState().create({ startMs, endMs: startMs + NEW_MINUTES * 60_000 });
}

const TABLE: Record<CommandId, Omit<Command, "id">> = {
  "day-prev": { label: "Previous day", palette: false, run: () => view().moveDay(-1) },
  "day-next": { label: "Next day", palette: false, run: () => view().moveDay(1) },
  "week-prev": { label: "Previous week", palette: false, run: () => view().moveWeek(-1) },
  "week-next": { label: "Next week", palette: false, run: () => view().moveWeek(1) },
  today: { label: "Go to today", palette: true, run: () => view().goToday() },
  "select-next": { label: "Select the next event", palette: false, run: () => view().selectAdjacent(1) },
  "select-prev": { label: "Select the previous event", palette: false, run: () => view().selectAdjacent(-1) },
  "mini-month": { label: "Jump to a date", palette: true, run: () => overlays().show("mini-month") },

  "view-day": { label: "Day view", palette: true, run: () => view().setView("day") },
  "view-week": { label: "Week view", palette: true, run: () => view().setView("week") },
  "view-agenda": { label: "Agenda view", palette: true, run: () => view().setView("agenda") },
  fold: { label: "Fold or unfold the band under the cursor", palette: false, run: () => gridCommands.toggleFold() },
  "unfold-all": { label: "Unfold every band", palette: true, run: () => gridCommands.unfoldAll() },

  "new-event": { label: "New event", palette: true, run: newEvent },
  "open-selection": { label: "Open the selected event", palette: false, run: openSelection },
  "edit-selection": { label: "Edit the selected event", palette: false, run: editSelection },
  "delete-selection": {
    label: "Delete the selected event",
    palette: false,
    run: () => {
      void deleteSelection();
    },
  },

  search: { label: "Search events", palette: true, run: () => overlays().show("search") },
  "command-palette": { label: "Command palette", palette: false, run: () => overlays().show("palette") },
  shortcuts: { label: "Keyboard shortcuts", palette: true, run: () => overlays().show("shortcuts") },

  "sync-now": {
    label: "Sync now",
    palette: true,
    run: () => {
      void useSync.getState().run();
    },
  },
  calendars: { label: "Calendars", palette: true, run: () => overlays().show("calendars") },
  accounts: { label: "Accounts", palette: true, run: () => overlays().show("accounts") },
  settings: { label: "Settings", palette: true, run: () => overlays().show("settings") },
  "toggle-theme": { label: "Toggle dark mode", palette: true, run: () => useTheme.getState().toggle() },
  "check-updates": {
    label: "Check for updates",
    palette: true,
    run: () => {
      void checkForUpdates();
    },
  },
  "report-issue": {
    label: "Report an issue",
    palette: true,
    run: () => {
      openUrl(ISSUES_URL).catch(() => notify("Could not open the browser"));
    },
  },
};

/** Declaration order, which is the order the palette lists them in. */
export const COMMANDS: readonly Command[] = (Object.keys(TABLE) as CommandId[]).map((id) => ({
  id,
  ...TABLE[id],
}));

export const commandLabel = (id: CommandId): string => TABLE[id].label;

export function runCommand(id: CommandId): void {
  TABLE[id].run();
}

/** Case-insensitive subsequence, so `agv` finds "Agenda view" and `sync` finds "Sync now". */
export function commandMatches(label: string, query: string): boolean {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return true;
  const hay = label.toLowerCase();
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}
