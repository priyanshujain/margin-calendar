import { call, type SyncStatus } from "../ipc";

export const syncNow = () => call<SyncStatus>("sync_now");

export const syncStatus = () => call<SyncStatus>("sync_status");

/** Drains the outbox. The close-request hook races this against a timeout. */
export const syncFlush = () => call<void>("sync_flush");
