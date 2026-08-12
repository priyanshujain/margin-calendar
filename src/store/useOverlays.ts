import { create } from "zustand";

/**
 * Which overlay is on screen. Nothing here is resident: an overlay is summoned by a key or a
 * hover and dismissed with Escape. Only one is open at a time, so the keymap's context stack has
 * exactly one frame to shadow the grid's bindings with.
 *
 * `trail` is where you came from. Settings opens Accounts, and without it that panel is a dead end
 * whose only way out is closing everything and starting again.
 */
export type Overlay =
  | "palette"
  | "search"
  | "calendars"
  | "mini-month"
  | "editor"
  | "accounts"
  | "settings"
  | "shortcuts"
  /** The phone's overflow sheet. A desktop reaches all of this from the header row or a key. */
  | "menu";

interface OverlayState {
  open: Overlay | null;
  /** The panels behind this one, outermost first. Empty when the current one was opened directly. */
  trail: Overlay[];
  /** Opens one on its own. Anything you were in is gone, not remembered. */
  show: (overlay: Overlay) => void;
  /** Opens one from inside another, so `back` can return to it. */
  push: (overlay: Overlay) => void;
  /** Returns to the panel that opened this one, or closes when there is nowhere to go. */
  back: () => void;
  /**
   * Records where the panel that is already open was reached from.
   *
   * `push` cannot do this job for a panel opened by a command, because a command calls `show` and
   * has no idea anything summoned it. The phone menu is exactly that case: it dispatches the same
   * commands a key does, so without this, closing Settings from the menu drops you on the grid
   * rather than back at the menu you were reading a moment ago.
   */
  reachedFrom: (previous: Overlay) => void;
  toggle: (overlay: Overlay) => void;
  close: () => void;
}

export const useOverlays = create<OverlayState>((set) => ({
  open: null,
  trail: [],
  show: (overlay) => set({ open: overlay, trail: [] }),
  push: (overlay) =>
    set((s) => (s.open === null ? { open: overlay, trail: [] } : { open: overlay, trail: [...s.trail, s.open] })),
  back: () =>
    set((s) => {
      const trail = s.trail.slice();
      const previous = trail.pop() ?? null;
      return { open: previous, trail };
    }),
  // Nothing to go back to when nothing is open, and a panel is not its own way out.
  reachedFrom: (previous) =>
    set((s) => (s.open === null || s.open === previous ? {} : { trail: [previous] })),
  toggle: (overlay) =>
    set((s) => (s.open === overlay ? { open: null, trail: [] } : { open: overlay, trail: [] })),
  close: () => set({ open: null, trail: [] }),
}));
