import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Header } from "./components/Header";
import { PhoneMenu, PhoneTabBar, PhoneTopBar } from "./components/PhoneBar";
import { GridView } from "./components/GridView";
import { AgendaView } from "./components/AgendaView";
import { FirstRun } from "./components/FirstRun";
import { MiniMonthOverlay } from "./components/MiniMonth";
import { CalendarList } from "./components/CalendarList";
import { EventEditor } from "./components/EventEditor";
import { EventDetails } from "./components/EventDetails";
import { Settings } from "./components/Settings";
import { Accounts } from "./components/Accounts";
import { CommandPalette } from "./palette/CommandPalette";
import { ShortcutsSheet } from "./keys/Shortcuts";
import { Toast } from "./components/Toast";
import { SearchOverlay } from "./components/SearchOverlay";

import { useKeymap } from "./keys/keymap";
import { handleMenuAction } from "./keys/menu";
import { useAccounts } from "./store/useAccounts";
import { useCalendarView } from "./store/useCalendarView";
import { useSearch } from "./store/useSearch";
import { useSync } from "./store/useSync";
import { notify } from "./store/useToast";
import { useCompact, usePhone, useTouch } from "./useMedia";
import { syncFlush } from "./api/sync";
import { isDesktop, isTauri, live, type AuthEvent, type SyncStatus } from "./ipc";

/** Long enough for sync_flush's own 1s lock wait plus its 4s drain budget. */
const FLUSH_TIMEOUT_MS = 5500;

function App() {
  useCompact();
  const phone = usePhone();
  useTouch();
  useKeymap();

  useEffect(() => {
    if (!live()) return;
    void useAccounts.getState().refresh();
    void useCalendarView.getState().load();
    void useSync.getState().refresh();
  }, []);

  // `isTauri`, not `isDesktop`. A phone emits every one of these and needs `auth` most of all: the
  // mobile consent flow ends with a deep link into Rust, and this listener is the only thing that
  // ever learns it worked. Gating on `isDesktop` here left sign-in hanging on the spinner forever.
  useEffect(() => {
    if (!isTauri) return;
    const menu = listen<string>("menu-action", (event) => handleMenuAction(event.payload));
    const auth = listen<AuthEvent>("auth", (event) => {
      void useAccounts
        .getState()
        .handleAuthEvent(event.payload.ok, event.payload.error, event.payload.cancelled);
    });
    // A pass that fails in the background used to set the error and say nothing, so a calendar
    // that never arrived looked like a calendar you do not have. Surface it once per distinct
    // message rather than every sixty seconds.
    let lastError: string | null = null;
    const progress = listen<SyncStatus>("sync-progress", (event) => {
      useSync.getState().apply(event.payload);
      const error = event.payload.error;
      if (error && error !== lastError) notify(`Sync failed: ${error}`);
      if (error !== lastError) lastError = error;
    });
    // Purely an invalidation signal: re-request the visible range rather than trying to read the
    // reason. The account list is only worth refetching when the accounts themselves moved.
    const changed = listen<string>("store-changed", (event) => {
      void useCalendarView.getState().load();
      void useSync.getState().refresh();
      useSearch.getState().invalidate();
      const reason = event.payload ?? "";
      if (reason.includes("account") || reason.includes("calendar")) {
        void useAccounts.getState().refresh();
      }
    });
    return () => {
      void menu.then((stop) => stop());
      void auth.then((stop) => stop());
      void progress.then((stop) => stop());
      void changed.then((stop) => stop());
    };
  }, []);

  // Drain the outbox before quitting, racing a timeout so a deep queue or a dead network cannot
  // hold the window open. Same shape as margin's close-request hook.
  //
  // `isDesktop` genuinely means desktop here: there is no close to intercept on a phone, and the
  // window commands live in a capability that platform does not get, so this would be a rejected
  // IPC call rather than a no-op. The outbox still drains on the next launch either way.
  useEffect(() => {
    if (!isDesktop) return;
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      if (useSync.getState().pendingWrites === 0) return;
      event.preventDefault();
      await Promise.race([
        syncFlush().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
      void win.destroy();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return (
    <div className="app">
      {/* One row of chrome or two, never both: the phone's bars replace the header rather than
          hiding it, so nothing off screen is still holding a drag region or the keyboard. */}
      {phone ? <PhoneTopBar /> : <Header />}
      <main className="stage">
        <GridView />
        <AgendaView />
        <FirstRun />
      </main>
      {phone ? <PhoneTabBar /> : null}
      <PhoneMenu />
      <MiniMonthOverlay />
      <CalendarList />
      <EventDetails />
      <EventEditor />
      <Settings />
      <Accounts />
      <SearchOverlay />
      <CommandPalette />
      <ShortcutsSheet />
      <Toast />
    </div>
  );
}

export default App;
