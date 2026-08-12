// The sync engine: the poll loop, the pull, the outbox and the quit flush.
//
// events.list with a stored syncToken, singleEvents=false, showDeleted=true, maxResults=2500, and
// the parameter set byte-identical on every call in a chain including the first, which `api` owns
// so it cannot drift. timeMin/timeMax are rejected alongside syncToken, so there is no windowed
// incremental sync and the initial pull is the whole calendar history. That is only tolerable
// because singleEvents=false collapses a series to one row, and the mitigation for a slow first
// pull is `sync-progress`, not a window.
//
// Polling, not webhooks: watch channels need a publicly verified HTTPS callback and expire every
// few days. Sixty seconds focused, five minutes unfocused.
//
// Everything the engine does to Google goes through `transport::Transport`. That seam is what makes
// pagination, 410 recovery and the outbox drain testable against a stub and an in-memory database.

mod model;
mod pull;
mod push;
mod transport;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use tauri::{Emitter, Listener, Manager};

use crate::dto::{EventDraft, EventPatch, Instance, InstanceKey, Scope, SyncStatus};
use crate::store::write::EventRow;
use crate::store::{read, write, Store};

pub const POLL_FOCUSED_SECS: u64 = 60;
pub const POLL_UNFOCUSED_SECS: u64 = 300;

/// The first pass runs a couple of seconds after launch rather than a poll interval later, so a
/// cold start shows fresh data.
const FIRST_PASS_SECS: u64 = 2;
/// How long a pass gives the outbox before it moves on to the pull. A deeper queue drains further
/// on the next tick rather than holding the pull up.
const PUSH_BUDGET_SECS: u64 = 20;
/// Quit is racing a timeout on the frontend, so the flush takes what it can get and returns.
const FLUSH_BUDGET_SECS: u64 = 4;
/// Widened by a day either side, this is the window that finds a series' stored exceptions. The
/// store has no read for "the rows of one series", and this is the read that comes closest.
const DAY_MS: i64 = 86_400_000;

const LAST_SYNC_KEY: &str = "last-sync";

#[derive(Default)]
pub struct SyncState {
    pub status: Mutex<SyncStatus>,
    /// Held for the duration of a sync pass so the poll tick and a manual sync_now cannot overlap.
    pub running: tokio::sync::Mutex<()>,
    /// Wakes the poll loop early. A new account or a local write should not wait out the interval.
    wake: Arc<tokio::sync::Notify>,
}

/// What one half of a pass did. `offline` is deliberately not an error: it is the expected state on
/// a plane, and surfacing it as a failure would train the user to ignore the failure indicator.
#[derive(Debug, Default)]
pub struct Outcome {
    pub changed: bool,
    pub error: Option<String>,
    pub offline: bool,
}

/// Where progress goes. The engine is written against this rather than against `AppHandle` so the
/// tests can run a whole pass with nothing but a recorder.
pub trait Sink: Sync {
    /// Merged into the stored status and emitted as `sync-progress`.
    fn message(&self, text: &str);
    fn status(&self, status: &SyncStatus);
    /// Purely an invalidation signal: the frontend re-requests its visible range and nothing here
    /// tries to describe what moved.
    fn changed(&self, reason: &str);
}

struct AppSink {
    app: tauri::AppHandle,
}

impl Sink for AppSink {
    fn message(&self, text: &str) {
        let status = match self.app.try_state::<SyncState>() {
            Some(state) => {
                let Ok(mut current) = state.status.lock() else {
                    return;
                };
                current.phase = "syncing".to_string();
                current.message = Some(text.to_string());
                current.clone()
            }
            None => return,
        };
        let _ = self.app.emit("sync-progress", status);
    }

    fn status(&self, status: &SyncStatus) {
        if let Some(state) = self.app.try_state::<SyncState>() {
            if let Ok(mut current) = state.status.lock() {
                *current = status.clone();
            }
        }
        let _ = self.app.emit("sync-progress", status.clone());
    }

    fn changed(&self, reason: &str) {
        crate::emit_store_changed(&self.app, reason);
    }
}

/// Takes the store's connection for one synchronous unit of work. Nothing inside may await: the
/// guard is a std one, so holding it across a suspension point would make the future non-Send.
fn with_conn<T>(
    store: &Store,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    f(&conn)
}

fn pending_writes(store: &Store) -> u32 {
    with_conn(store, read::pending_writes).unwrap_or(0)
}

fn last_sync(store: &Store) -> Option<i64> {
    with_conn(store, |conn| write::meta_get(conn, LAST_SYNC_KEY))
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
}

/// Push first, then pull, so a write that has just landed comes back as the server's own row in the
/// same pass rather than a tick later.
async fn run_pass(
    store: &Store,
    transport: &impl transport::Transport,
    sink: &impl Sink,
) -> SyncStatus {
    let mut status = SyncStatus {
        phase: "syncing".to_string(),
        last_sync: last_sync(store),
        error: None,
        pending_writes: pending_writes(store),
        message: None,
    };
    sink.status(&status);

    let deadline = Instant::now() + Duration::from_secs(PUSH_BUDGET_SECS);
    let pushed = push::drain(store, transport, deadline).await;
    if pushed.changed {
        sink.changed("outbox");
    }

    let pulled = if pushed.offline {
        Outcome::default()
    } else {
        pull::sync_all(store, transport, sink).await
    };

    status.pending_writes = pending_writes(store);
    status.message = None;
    match pushed.error.or(pulled.error) {
        Some(error) => {
            status.phase = "error".to_string();
            status.error = Some(error);
        }
        None => {
            status.phase = "idle".to_string();
            status.error = None;
            if pushed.offline || pulled.offline {
                status.message = Some("Offline".to_string());
            } else {
                let now = write::now_ms();
                let _ = with_conn(store, |conn| {
                    write::meta_set(conn, LAST_SYNC_KEY, &now.to_string())
                });
                status.last_sync = Some(now);
            }
        }
    }
    sink.status(&status);
    status
}

/// Spawned from `setup`. Ticks on the focused interval while the window has focus and the
/// unfocused one otherwise, and wakes early when something has just been queued or connected.
pub fn start_loop(app: tauri::AppHandle) {
    let wake = match app.try_state::<SyncState>() {
        Some(state) => state.wake.clone(),
        None => return,
    };

    // A freshly connected account should not sit unsynced for a poll interval. `store-changed` is
    // the only signal the connect flow emits, and its reason distinguishes this from our own.
    let listener = wake.clone();
    app.listen("store-changed", move |event| {
        if event.payload().contains("account-connected") {
            listener.notify_one();
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_secs(FIRST_PASS_SECS);
        loop {
            let _ = tokio::time::timeout(delay, wake.notified()).await;
            tick(&app).await;
            delay = Duration::from_secs(if focused(&app) {
                POLL_FOCUSED_SECS
            } else {
                POLL_UNFOCUSED_SECS
            });
        }
    });
}

fn focused(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false))
}

async fn tick(app: &tauri::AppHandle) {
    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    let state = app.state::<SyncState>();
    // A manual sync is already in flight, and this tick has nothing to add to it.
    let Ok(_guard) = state.running.try_lock() else {
        return;
    };
    let transport = transport::Google { app: app.clone() };
    let sink = AppSink { app: app.clone() };
    run_pass(&store, &transport, &sink).await;
}

fn kick(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SyncState>() {
        state.wake.notify_one();
    }
}

/// The queue depth is half of the optimistic story: a write that has not left yet should say so
/// before the next pass gets round to saying it.
fn note_pending(app: &tauri::AppHandle, store: &Store) {
    let Some(state) = app.try_state::<SyncState>() else {
        return;
    };
    let count = pending_writes(store);
    let status = {
        let Ok(mut current) = state.status.lock() else {
            return;
        };
        current.pending_writes = count;
        current.clone()
    };
    let _ = app.emit("sync-progress", status);
}

/// Drains the outbox on quit. The frontend races this against a timeout before destroying the
/// window, the same shape as margin's App.tsx:45 close-request hook, so it returns on a budget
/// however deep the queue is.
#[tauri::command]
pub async fn sync_flush(app: tauri::AppHandle) -> Result<(), String> {
    let Some(store) = app.try_state::<Store>() else {
        return Ok(());
    };
    let state = app.state::<SyncState>();
    // Wait briefly for a pass in flight, then go anyway: the caller is on its way out.
    let _guard = tokio::time::timeout(Duration::from_secs(1), state.running.lock())
        .await
        .ok();

    let transport = transport::Google { app: app.clone() };
    let deadline = Instant::now() + Duration::from_secs(FLUSH_BUDGET_SECS);
    let outcome = push::drain(&store, &transport, deadline).await;
    if outcome.changed {
        crate::emit_store_changed(&app, "outbox");
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, SyncState>,
) -> Result<SyncStatus, String> {
    let _guard = state.running.lock().await;
    let store = app
        .try_state::<Store>()
        .ok_or("the local store is not open")?;
    let transport = transport::Google { app: app.clone() };
    let sink = AppSink { app: app.clone() };
    Ok(run_pass(&store, &transport, &sink).await)
}

#[tauri::command]
pub async fn sync_status(state: tauri::State<'_, SyncState>) -> Result<SyncStatus, String> {
    let status = state.status.lock().map_err(|e| e.to_string())?.clone();
    Ok(status)
}

#[tauri::command]
pub async fn event_create(app: tauri::AppHandle, draft: EventDraft) -> Result<Instance, String> {
    let store = app
        .try_state::<Store>()
        .ok_or("the local store is not open")?;
    let instance = with_conn(&store, |conn| push::create(conn, &draft))?;
    note_pending(&app, &store);
    crate::emit_store_changed(&app, "event-created");
    kick(&app);
    Ok(instance)
}

#[tauri::command]
pub async fn event_update(
    app: tauri::AppHandle,
    key: InstanceKey,
    patch: EventPatch,
    scope: Scope,
) -> Result<(), String> {
    let store = app
        .try_state::<Store>()
        .ok_or("the local store is not open")?;
    let rows = with_conn(&store, |conn| series_rows(conn, &key))?;
    let plans = crate::recur::plan_edit(&rows, &key, &patch, scope)?;
    with_conn(&store, |conn| push::apply_plans(conn, &rows, &plans))?;
    note_pending(&app, &store);
    crate::emit_store_changed(&app, "event-updated");
    kick(&app);
    Ok(())
}

#[tauri::command]
pub async fn event_delete(
    app: tauri::AppHandle,
    key: InstanceKey,
    scope: Scope,
) -> Result<(), String> {
    let store = app
        .try_state::<Store>()
        .ok_or("the local store is not open")?;
    let rows = with_conn(&store, |conn| series_rows(conn, &key))?;
    let plans = crate::recur::plan_delete(&rows, &key, scope)?;
    with_conn(&store, |conn| push::apply_plans(conn, &rows, &plans))?;
    note_pending(&app, &store);
    crate::emit_store_changed(&app, "event-deleted");
    kick(&app);
    Ok(())
}

/// The rows `recur` needs to plan an edit: the event the key names, its master if the key named an
/// exception, and every stored exception of that series. `InstanceKey` carries no calendar, and the
/// store has no read that fetches a series by id, so the event comes from a point lookup per
/// calendar and the exceptions come from the window read around the occurrence.
fn series_rows(conn: &Connection, key: &InstanceKey) -> Result<Vec<EventRow>, String> {
    let mut rows: Vec<EventRow> = Vec::new();
    let calendars = read::calendars(conn)?;
    for calendar in &calendars {
        if let Some(row) = read::event(conn, &calendar.id, &key.event_id)? {
            rows.push(row);
        }
    }

    let masters: Vec<(String, String)> = rows
        .iter()
        .filter_map(|row| {
            row.recurring_event_id
                .clone()
                .map(|master| (row.calendar_id.clone(), master))
        })
        .collect();
    for (calendar_id, master) in masters {
        if let Some(row) = read::event(conn, &calendar_id, &master)? {
            rows.push(row);
        }
    }

    let anchor = key
        .original_start
        .clone()
        .or_else(|| rows.first().map(|row| row.start_at.clone()));
    if let Some(anchor) = anchor {
        let all_day = anchor.len() == 10;
        if let Some(ms) = write::epoch_ms(&anchor, all_day) {
            for row in read::masters_overlapping(conn, ms - DAY_MS, ms + DAY_MS)? {
                let known = rows
                    .iter()
                    .any(|seen| seen.id == row.id && seen.calendar_id == row.calendar_id);
                let of_this_series = row
                    .recurring_event_id
                    .as_deref()
                    .is_some_and(|master| master == key.event_id);
                if of_this_series && !known {
                    rows.push(row);
                }
            }
        }
    }

    Ok(rows)
}
