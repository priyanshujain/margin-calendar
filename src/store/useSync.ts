import { create } from "zustand";
import { syncNow, syncStatus } from "../api/sync";
import { live, type SyncStatus } from "../ipc";
import { notify } from "./useToast";

interface SyncState {
  phase: SyncStatus["phase"];
  lastSync: number | null;
  error: string | null;
  pendingWrites: number;
  message: string | null;
  apply: (status: SyncStatus) => void;
  refresh: () => Promise<void>;
  run: (silent?: boolean) => Promise<void>;
}

export const useSync = create<SyncState>((set, get) => ({
  phase: "idle",
  lastSync: null,
  error: null,
  pendingWrites: 0,
  message: null,
  apply: (status) =>
    set({
      phase: status.phase,
      lastSync: status.lastSync,
      error: status.error,
      pendingWrites: status.pendingWrites,
      message: status.message,
    }),
  refresh: async () => {
    if (!live()) return;
    try {
      get().apply(await syncStatus());
    } catch {}
  },
  run: async (silent = false) => {
    if (!live() || get().phase === "syncing") return;
    set({ phase: "syncing", error: null });
    try {
      get().apply(await syncNow());
    } catch (e) {
      set({ phase: "error", error: String(e) });
      if (!silent) notify(`Sync failed: ${e}`);
    }
  },
}));
