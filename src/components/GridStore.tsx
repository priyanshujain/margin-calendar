// Grid state that outlives a render pass: the folds, the manually unfolded floor, the live drag
// and the in-place create draft. It also publishes the current layout so the keymap can act on
// the grid without the grid owning a global key listener.
//
// One store, no middleware, actions as inline arrow properties, following `src/store`. It lives
// under `components/` because it is the grid's own state and no other domain reads it.

import { create } from "zustand";
import {
  DEFAULT_BOUNDS,
  addFold,
  unfoldStrip,
  type Bounds,
  type FitLayout,
  type Fold,
} from "../grid/fit";
import { loadFolds, saveFolds } from "../grid/folds";
import { bandAt, heldHours } from "./GridModel";

export type DragMode = "create" | "move" | "resize-start" | "resize-end";

/** The gesture in flight. Only `GridGhost` subscribes, so a pointermove repaints one element. */
export interface Drag {
  mode: DragMode;
  /** The block being dragged, or null while dragging out a new one. */
  id: string | null;
  dayIndex: number;
  startMin: number;
  endMin: number;
  /** False until the pointer has travelled far enough to be a drag rather than a click. */
  moved: boolean;
}

/** A dragged-out range waiting for its title. */
export interface Draft {
  dayIndex: number;
  startMin: number;
  endMin: number;
}

interface GridState {
  folds: Fold[];
  /** Bands the user unfolded by hand, held open against the automatic bounds until refolded. */
  floor: Bounds | null;
  layout: FitLayout | null;
  days: number[];
  /** The hours no fold may hide: see `heldHours`. Published with the layout it was solved for. */
  held: boolean[];
  hoverHour: number | null;
  drag: Drag | null;
  draft: Draft | null;
  saving: boolean;
  publish: (layout: FitLayout, days: number[], held: boolean[]) => void;
  setHoverHour: (hour: number | null) => void;
  setDrag: (drag: Drag | null) => void;
  setDraft: (draft: Draft | null) => void;
  setSaving: (saving: boolean) => void;
  fold: (range: Fold) => void;
  unfold: (range: Fold) => void;
  /** `z`: fold the empty band under the cursor, or unfold the strip it is already in. */
  toggleFold: (hour?: number) => void;
  unfoldAll: () => void;
}

export const useGrid = create<GridState>((set, get) => ({
  folds: loadFolds(),
  floor: null,
  layout: null,
  days: [],
  held: heldHours([], null),
  hoverHour: null,
  drag: null,
  draft: null,
  saving: false,
  publish: (layout, days, held) => set({ layout, days, held }),
  setHoverHour: (hoverHour) => set((s) => (s.hoverHour === hoverHour ? {} : { hoverHour })),
  setDrag: (drag) => set({ drag }),
  setDraft: (draft) => set({ draft }),
  setSaving: (saving) => set({ saving }),
  fold: (range) => {
    const folds = saveFolds(addFold(get().folds, range));
    set({ folds });
  },
  unfold: (range) => {
    const folds = saveFolds(unfoldStrip(get().folds, get().held, range));
    // An out-of-bounds band has no fold to remove, so widening the floor is what holds it open.
    const base = get().floor ?? get().layout?.bounds ?? DEFAULT_BOUNDS;
    set({
      folds,
      floor: { start: Math.min(base.start, range.start), end: Math.max(base.end, range.end) },
    });
  },
  toggleFold: (hour) => {
    const { layout, hoverHour, held } = get();
    if (!layout) return;
    const at = hour ?? hoverHour;
    if (at === null || at === undefined) return;
    const h = Math.max(0, Math.min(23, Math.floor(at)));
    const segment = layout.segments.find((s) => h * 60 >= s.start && h * 60 < s.end);
    if (segment?.kind === "strip") {
      get().unfold({ start: segment.start / 60, end: segment.end / 60 });
      return;
    }
    const band = bandAt(held, layout.bounds, h);
    if (band) get().fold(band);
  },
  unfoldAll: () => {
    saveFolds([]);
    set({ folds: [], floor: { start: 0, end: 24 } });
  },
}));

/**
 * The imperative surface the keymap dispatches into. Every one of these is safe to call before
 * the grid has laid out, and none of them needs a React tree.
 */
export const gridCommands = {
  toggleFold: (hour?: number) => useGrid.getState().toggleFold(hour),
  unfoldAll: () => useGrid.getState().unfoldAll(),
  cancelDraft: () => {
    useGrid.setState({ draft: null, drag: null });
  },
  /** Opens the in-place create input, in minutes from local midnight on the given column. */
  draftAt: (dayIndex: number, startMin: number, endMin: number) =>
    useGrid.getState().setDraft({ dayIndex, startMin, endMin }),
  /** The same, addressed by local midnight rather than by column. Ignored off screen. */
  draftOn: (dayStart: number, startMin: number, minutes: number) => {
    const dayIndex = useGrid.getState().days.indexOf(dayStart);
    if (dayIndex === -1) return;
    useGrid.getState().setDraft({ dayIndex, startMin, endMin: startMin + minutes });
  },
  /** True while the grid owns the keyboard, so the keymap can stand back. */
  isEditing: () => useGrid.getState().draft !== null,
  layout: () => useGrid.getState().layout,
  days: () => useGrid.getState().days,
};
