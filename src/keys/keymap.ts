// One capture-phase listener for the whole app, and a context stack that decides what it is
// allowed to do.
//
// The stack starts empty, which means the view's keymap. An overlay pushes a frame and the whole
// `view` context is shadowed until it pops, so the panel on screen owns the keyboard without any
// component having to remember to unbind anything. Escape is not part of this: `src/escape.ts`
// already stacks Escape handlers and knows about nested confirmations, so this listener steps over
// the key entirely rather than racing it.
//
// A key is never taken from a text field. The grid's in-place create input is a text field the
// keymap cannot see, so `gridCommands.isEditing()` stands in for it.

import { useEffect } from "react";
import { gridCommands } from "../components/GridStore";
import { useOverlays, type Overlay } from "../store/useOverlays";
import {
  BINDINGS,
  normalizeCombo,
  primaryHeld,
  secondaryHeld,
  type Binding,
  type KeyContext,
} from "./bindings";
import { runCommand } from "./commands";

const index = new Map<string, Binding[]>();
for (const binding of BINDINGS) {
  for (const key of binding.keys) {
    const combo = normalizeCombo(key);
    const found = index.get(combo);
    if (found) found.push(binding);
    else index.set(combo, [binding]);
  }
}

interface Frame {
  context: KeyContext;
}

const stack: Frame[] = [];

const activeContext = (): KeyContext => stack[stack.length - 1]?.context ?? "view";

/** Takes the keyboard until the returned function is called. Frames are identity, never by name. */
export function pushContext(context: KeyContext): () => void {
  const frame: Frame = { context };
  stack.push(frame);
  return () => {
    const at = stack.indexOf(frame);
    if (at !== -1) stack.splice(at, 1);
  };
}

/** The hook form, for a component that owns the keyboard while it is on screen. */
export function useKeyContext(context: KeyContext, active = true): void {
  useEffect(() => {
    if (!active) return;
    return pushContext(context);
  }, [context, active]);
}

function comboOf(e: KeyboardEvent): string {
  const mods =
    (primaryHeld(e) ? "cmd+" : "") + (secondaryHeld(e) ? "ctrl+" : "") + (e.altKey ? "alt+" : "");
  return mods ? `${mods}${e.key.toLowerCase()}` : e.key;
}

function resolve(combo: string): Binding | null {
  const candidates = index.get(combo);
  if (!candidates) return null;
  const top = activeContext();
  return (
    candidates.find((b) => b.context === top) ??
    candidates.find((b) => b.context === "global") ??
    null
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * A button the user can tab to activates itself on Enter, so the keymap leaves that alone. An
 * event block is `tabIndex={-1}` and only ever focused by a click, and it is the keymap's job to
 * open it, so the test is the tab index rather than the tag.
 */
function isActivatable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string" || el.tabIndex < 0) return false;
  return (
    el.tagName === "BUTTON" ||
    el.tagName === "A" ||
    el.tagName === "SUMMARY" ||
    el.getAttribute("role") === "button"
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.defaultPrevented) return;
  if (e.key === "Escape") return;
  if ((e.key === "Enter" || e.key === " ") && isActivatable(e.target)) return;

  const binding = resolve(comboOf(e));
  if (!binding || binding.command === null) return;

  if (!binding.allowInInput) {
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    if (gridCommands.isEditing()) return;
  }

  e.preventDefault();
  e.stopPropagation();
  runCommand(binding.command);
}

let overlayFrame: (() => void) | null = null;

// Every overlay is summoned through `useOverlays`, so the frame is synced here rather than asked
// of each panel: a panel that forgot to push one would silently leave the grid's keys live under
// it. Exactly one overlay is open at a time, so there is exactly one frame.
function syncOverlayFrame(open: Overlay | null): void {
  if (open && !overlayFrame) overlayFrame = pushContext("overlay");
  else if (!open && overlayFrame) {
    overlayFrame();
    overlayFrame = null;
  }
}

let installs = 0;
let stopWatching: (() => void) | null = null;

/** Installs the one listener. Reference counted, so React's double effect in dev is harmless. */
export function installKeymap(): () => void {
  installs += 1;
  if (installs === 1) {
    window.addEventListener("keydown", onKeyDown, true);
    syncOverlayFrame(useOverlays.getState().open);
    stopWatching = useOverlays.subscribe((s) => syncOverlayFrame(s.open));
  }
  return () => {
    installs -= 1;
    if (installs > 0) return;
    window.removeEventListener("keydown", onKeyDown, true);
    stopWatching?.();
    stopWatching = null;
    syncOverlayFrame(null);
  };
}

/** Mount once, at the top of the tree. */
export function useKeymap(): void {
  useEffect(() => installKeymap(), []);
}
