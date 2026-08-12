// What the palette is holding between keystrokes. It lives here rather than in `src/store/`
// because nothing outside the palette has any business reading a half-typed query.

import { create } from "zustand";

interface PaletteState {
  query: string;
  /** Highlighted row. Clamped against the row count on every move, never trusted blindly. */
  index: number;
  setQuery: (query: string) => void;
  setIndex: (index: number) => void;
  move: (delta: number, count: number) => void;
  reset: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  query: "",
  index: 0,
  setQuery: (query) => set({ query, index: 0 }),
  setIndex: (index) => set({ index }),
  move: (delta, count) =>
    set((s) => {
      if (count === 0) return {};
      const at = Math.min(Math.max(s.index, 0), count - 1);
      return { index: (at + delta + count) % count };
    }),
  reset: () => set({ query: "", index: 0 }),
}));
