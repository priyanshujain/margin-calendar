import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { accountConnect, accountDisconnect, accountsList } from "../api/accounts";
import { calendarSetSelected, calendarsList } from "../api/calendars";
import { live, type Account, type Calendar } from "../ipc";
import { notify } from "./useToast";

type Phase = "idle" | "connecting" | "working" | "error";

interface AccountsState {
  accounts: Account[];
  calendars: Calendar[];
  phase: Phase;
  error: string | null;
  authUrl: string | null;
  resolveConnect: ((ok: boolean) => void) | null;
  refresh: () => Promise<void>;
  connect: () => Promise<boolean>;
  cancelConnect: () => void;
  handleAuthEvent: (ok: boolean, error: string | null) => Promise<void>;
  openAuthUrl: () => void;
  copyAuthUrl: () => Promise<void>;
  disconnect: (accountId: string) => Promise<void>;
  setSelected: (calendarId: string, selected: boolean) => Promise<void>;
}

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [],
  calendars: [],
  phase: "idle",
  error: null,
  authUrl: null,
  resolveConnect: null,
  refresh: async () => {
    if (!live()) return;
    try {
      const [accounts, calendars] = await Promise.all([accountsList(), calendarsList()]);
      set({ accounts, calendars });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  // The promise holds its own resolver so a later Tauri `auth` event can settle it. Ported from
  // margin/src/store/useBackup.ts:70.
  connect: () =>
    new Promise<boolean>((resolve) => {
      get().resolveConnect?.(false);
      set({ phase: "connecting", error: null, authUrl: null, resolveConnect: resolve });
      accountConnect()
        .then((url) => set({ authUrl: url }))
        .catch((e) => {
          set({ phase: "error", error: String(e), resolveConnect: null });
          notify(`Could not connect: ${e}`);
          resolve(false);
        });
    }),
  cancelConnect: () => {
    const resolve = get().resolveConnect;
    set({ phase: "idle", authUrl: null, resolveConnect: null });
    resolve?.(false);
  },
  handleAuthEvent: async (ok, error) => {
    if (get().phase !== "connecting") return;
    const resolve = get().resolveConnect;
    if (ok) {
      await get().refresh();
      set({ phase: "idle", authUrl: null, error: null, resolveConnect: null });
      notify("Connected to Google Calendar");
    } else {
      const message = error ?? "authorization failed";
      set({ phase: "error", authUrl: null, error: message, resolveConnect: null });
      notify(`Could not connect: ${message}`);
    }
    resolve?.(ok);
  },
  openAuthUrl: () => {
    const url = get().authUrl;
    if (url) openUrl(url).catch(() => {});
  },
  copyAuthUrl: async () => {
    const url = get().authUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify("Authorization link copied");
    } catch {
      notify("Could not copy the link");
    }
  },
  disconnect: async (accountId) => {
    set({ phase: "working", error: null });
    try {
      await accountDisconnect(accountId);
      await get().refresh();
      set({ phase: "idle" });
      notify("Disconnected");
    } catch (e) {
      set({ phase: "error", error: String(e) });
      notify(`Could not disconnect: ${e}`);
    }
  },
  setSelected: async (calendarId, selected) => {
    set((s) => ({
      calendars: s.calendars.map((c) => (c.id === calendarId ? { ...c, selected } : c)),
    }));
    try {
      await calendarSetSelected(calendarId, selected);
    } catch (e) {
      await get().refresh();
      notify(`Could not update the calendar: ${e}`);
    }
  },
}));
