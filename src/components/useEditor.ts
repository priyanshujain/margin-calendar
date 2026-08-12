// What the event editor is pointed at. `useOverlays` models which overlay is open and nothing
// else, so the target lives here, next to the panel that reads it rather than in `src/store`.

import { create } from "zustand";
import type { InstanceKey } from "../ipc";
import { useOverlays } from "../store/useOverlays";

/** Everything a new event can be seeded with. Anything absent gets a sensible default. */
export interface EditorSeed {
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  calendarId?: string;
  summary?: string;
  /** Carried through from quick create, where `at <place>` may already have been parsed out. */
  location?: string;
  description?: string;
  /** Google's per-event colour id, so a colour picked in quick create survives the hand-off. */
  colorId?: string;
}

export type EditorTarget = { mode: "create"; seed: EditorSeed } | { mode: "edit"; key: InstanceKey };

interface EditorState {
  target: EditorTarget | null;
  create: (seed?: EditorSeed) => void;
  edit: (key: InstanceKey) => void;
  close: () => void;
}

export const useEditor = create<EditorState>((set) => ({
  target: null,
  create: (seed = {}) => {
    set({ target: { mode: "create", seed } });
    useOverlays.getState().show("editor");
  },
  edit: (key) => {
    set({ target: { mode: "edit", key } });
    useOverlays.getState().show("editor");
  },
  close: () => {
    set({ target: null });
    if (useOverlays.getState().open === "editor") useOverlays.getState().close();
  },
}));
