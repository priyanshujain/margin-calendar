// The native macOS menu emits `menu-action` with the item id it was built with. Those ids are
// command ids, so this is a guard and a lookup rather than a second dispatch table: a menu item
// and a keystroke run the same function or the build fails.
//
// The Tauri listener itself is mounted at the top of the tree; this is what it calls.

import { runCommand, type CommandId } from "./commands";

/** Exactly the ids `src-tauri/src/lib.rs` emits. */
const MENU_IDS: readonly CommandId[] = [
  "new-event",
  "command-palette",
  "sync-now",
  "accounts",
  "check-updates",
  "settings",
  "search",
  "today",
  "shortcuts",
  "view-day",
  "view-week",
  "view-agenda",
  "report-issue",
];

const known = new Set<string>(MENU_IDS);

export function handleMenuAction(id: string): void {
  if (known.has(id)) runCommand(id as CommandId);
}
