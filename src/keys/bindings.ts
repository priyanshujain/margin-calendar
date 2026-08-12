// The keymap, declared once. `keymap.ts` dispatches from this table and `Shortcuts.tsx` renders
// the `?` sheet from it, so a binding that exists but is undocumented is not something you can
// write: the sheet is generated, never maintained.
//
// A combo is canonical: modifiers in `cmd+ctrl+alt` order, then `KeyboardEvent.key` verbatim.
// `cmd` means the platform's primary modifier, Command on macOS and Control everywhere else, which
// is what the native menu's `CmdOrCtrl` accelerators mean too. Shift is not a modifier here: it is
// already baked into the key, so `H` is the shifted `h` and reads that way in the table.
//
// Nothing is chorded and nothing is modal. Two keys never combine into a third meaning.

import type { CommandId } from "./commands";

/**
 * Which frame of the context stack a binding belongs to. `overlay` carries no bindings of its own:
 * pushing it is how an open panel shadows the whole view keymap while leaving `global` reachable.
 */
export type KeyContext = "global" | "view" | "overlay";

export type BindingGroup = "Navigation" | "Views" | "Events" | "App";

interface BindingBase {
  /** Every combo that runs it. The sheet shows them all; the dispatcher accepts any. */
  keys: readonly string[];
  context: KeyContext;
  group: BindingGroup;
  /** Off by default: a key must never be stolen from an input. */
  allowInInput?: boolean;
}

export interface CommandBinding extends BindingBase {
  command: CommandId;
}

/** A key the keymap deliberately does not own, documented so the sheet is not a half-truth. */
export interface NoteBinding extends BindingBase {
  command: null;
  label: string;
}

export type Binding = CommandBinding | NoteBinding;

export const BINDINGS: readonly Binding[] = [
  { keys: ["h"], command: "day-prev", context: "view", group: "Navigation" },
  { keys: ["l"], command: "day-next", context: "view", group: "Navigation" },
  { keys: ["H"], command: "week-prev", context: "view", group: "Navigation" },
  { keys: ["L"], command: "week-next", context: "view", group: "Navigation" },
  { keys: ["t", "cmd+t"], command: "today", context: "view", group: "Navigation" },
  { keys: ["j"], command: "select-next", context: "view", group: "Navigation" },
  { keys: ["k"], command: "select-prev", context: "view", group: "Navigation" },
  { keys: ["m"], command: "mini-month", context: "view", group: "Navigation" },

  { keys: ["d", "cmd+1"], command: "view-day", context: "view", group: "Views" },
  { keys: ["w", "cmd+2"], command: "view-week", context: "view", group: "Views" },
  { keys: ["a", "cmd+3"], command: "view-agenda", context: "view", group: "Views" },
  { keys: ["z"], command: "fold", context: "view", group: "Views" },
  { keys: ["Z"], command: "unfold-all", context: "view", group: "Views" },

  { keys: ["c", "cmd+n"], command: "new-event", context: "view", group: "Events" },
  { keys: ["Enter"], command: "open-selection", context: "view", group: "Events" },
  { keys: ["e"], command: "edit-selection", context: "view", group: "Events" },
  { keys: ["x"], command: "delete-selection", context: "view", group: "Events" },
  { keys: ["/", "cmd+f"], command: "search", context: "view", group: "Events" },

  // The palette is the one thing a text field may not swallow: it is how you get out of anywhere.
  { keys: ["cmd+k"], command: "command-palette", context: "global", group: "App", allowInInput: true },
  { keys: ["?", "cmd+/"], command: "shortcuts", context: "view", group: "App" },
  // Escape unwinds the layer stack in `src/escape.ts`, which knows about nested confirmations.
  { keys: ["Escape"], command: null, label: "Dismiss whatever is open", context: "global", group: "App" },
  { keys: ["cmd+r"], command: "sync-now", context: "view", group: "App" },
  { keys: ["cmd+,"], command: "settings", context: "view", group: "App" },
];

export const GROUPS: readonly BindingGroup[] = ["Navigation", "Views", "Events", "App"];

const isMac =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgent ?? "");

/** The primary modifier as the platform names it. */
export const PRIMARY_LABEL = isMac ? "⌘" : "Ctrl+";

/** True when the event holds the platform's primary modifier, whatever the hardware calls it. */
export const primaryHeld = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  isMac ? e.metaKey : e.ctrlKey;

export const secondaryHeld = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  isMac ? e.ctrlKey : e.metaKey;

/** `Cmd+K` and `cmd+k` are the same binding; the table may be written either way. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const prefix = ["cmd", "ctrl", "alt"].filter((m) => mods.has(m)).join("+");
  return prefix ? `${prefix}+${key.toLowerCase()}` : key;
}

const NAMED: Record<string, string> = {
  Enter: "↩",
  Escape: "⎋",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Tab: "⇥",
  " ": "Space",
};

/** `cmd+k` becomes ⌘K, `H` becomes ⇧H. What the sheet and the palette both print. */
export function keyLabel(combo: string): string {
  const parts = normalizeCombo(combo).split("+");
  const key = parts.pop() ?? "";
  const mods = parts
    .map((m) => (m === "cmd" ? PRIMARY_LABEL : m === "ctrl" ? "⌃" : "⌥"))
    .join("");
  const named = NAMED[key];
  if (named) return `${mods}${named}`;
  if (mods) return `${mods}${key.toUpperCase()}`;
  return /^[A-Z]$/.test(key) ? `⇧${key}` : key;
}

export const bindingLabel = (binding: Binding, labelOf: (id: CommandId) => string): string =>
  binding.command === null ? binding.label : labelOf(binding.command);

/** The combos a command answers to, for a palette row or a button's title attribute. */
export function keysFor(id: CommandId): readonly string[] {
  return BINDINGS.find((b) => b.command === id)?.keys ?? [];
}
