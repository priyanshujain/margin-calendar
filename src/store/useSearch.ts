// Search reads a corpus of its own rather than whatever the current view happens to have loaded.
// The view's span is nine days in week view, which is narrow enough that search reads as broken.
//
// There is no search command in the IPC contract and the contract is frozen, so this widens the
// window through the existing `instances_range` instead. It is one fetch when the overlay opens,
// held until something writes to the store.

import { create } from "zustand";
import { instancesRange } from "../api/instances";
import { live, type Instance } from "../ipc";
import { addDays, today } from "../time";

/** People search forward more than back, so the window is not symmetric. */
const DAYS_BACK = 180;
const DAYS_FORWARD = 365;

interface SearchState {
  instances: Instance[];
  phase: "idle" | "loading" | "error";
  error: string | null;
  loadedAt: number | null;
  /** Fetches once and holds. Call on every open; it is cheap when the corpus is warm. */
  ensure: () => Promise<void>;
  invalidate: () => void;
}

export const useSearch = create<SearchState>((set, get) => ({
  instances: [],
  phase: "idle",
  error: null,
  loadedAt: null,
  ensure: async () => {
    if (!live() || get().phase === "loading" || get().loadedAt !== null) return;
    const anchor = today();
    set({ phase: "loading", error: null });
    try {
      const instances = await instancesRange(
        addDays(anchor, -DAYS_BACK),
        addDays(anchor, DAYS_FORWARD),
      );
      set({ instances, phase: "idle", loadedAt: Date.now() });
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },
  invalidate: () => set({ loadedAt: null }),
}));
