// Row-level writes: upserts from sync, optimistic local writes, the outbox, and the two destructive
// paths that have to be surgical (a 410 drops one calendar, a disconnect drops one account).
//
// Every function takes `&Connection` rather than `&mut Connection` so callers can work straight off
// the `MutexGuard` in `Store`. Multi-row work runs under `Tx`, which rolls back on drop.

use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};

/// The flattened Google event shape as stored. `recurrence` keeps the raw RFC5545 lines so the
/// expander can hand them to the rrule crate untouched.
#[derive(Debug, Clone, Default)]
pub struct EventRow {
    pub id: String,
    pub calendar_id: String,
    pub account_id: String,
    pub etag: Option<String>,
    pub status: String,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    /// RFC3339 with offset, or YYYY-MM-DD when all_day. Empty when the row is a cancelled
    /// instance, which Google returns carrying nothing but its id, master and original start.
    pub start_at: String,
    pub start_tz: Option<String>,
    pub end_at: String,
    pub end_tz: Option<String>,
    pub all_day: bool,
    pub recurrence: Vec<String>,
    pub recurring_event_id: Option<String>,
    pub original_start: Option<String>,
    pub attendees: Option<String>,
    pub conference: Option<String>,
    pub updated_at: Option<String>,
    /// Google's per-event colour id, 1 to 11, overriding the calendar's colour when set.
    pub color_id: Option<String>,
    pub dirty: bool,
}

/// One pending write. `payload` is JSON the sync agent defines; the store never reads it.
#[derive(Debug, Clone, Default)]
pub struct OutboxRow {
    pub id: i64,
    /// create | patch | delete
    pub op: String,
    pub calendar_id: String,
    pub event_id: Option<String>,
    pub original_start: Option<String>,
    /// this | following | all
    pub scope: Option<String>,
    pub payload: Option<String>,
    pub etag: Option<String>,
    pub attempts: i64,
    pub created_at: i64,
    /// Recorded for diagnosis, never branched on. The drain decides from the live ApiError.
    #[allow(dead_code)]
    pub last_error: Option<String>,
}

/// A transaction that does not need `&mut Connection`. Rolls back unless committed, so an early
/// `?` cannot leave a half-applied sync page behind.
pub struct Tx<'a> {
    conn: &'a Connection,
    done: bool,
}

impl<'a> Tx<'a> {
    pub fn begin(conn: &'a Connection) -> Result<Tx<'a>, String> {
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(|e| e.to_string())?;
        Ok(Tx { conn, done: false })
    }

    pub fn commit(mut self) -> Result<(), String> {
        self.done = true;
        self.conn.execute_batch("COMMIT;").map_err(|e| e.to_string())
    }
}

impl Drop for Tx<'_> {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.conn.execute_batch("ROLLBACK;");
        }
    }
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Epoch milliseconds for a stored timestamp. An all-day date is pinned to UTC midnight, which is
/// wrong by up to a zone offset on purpose: these columns only ever coarsen a window query, and
/// `read::masters_overlapping` pads the window by a day to cover it. The exact local placement
/// happens in `recur`, which is the only code allowed to interpret an all-day date.
pub fn epoch_ms(value: &str, all_day: bool) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if all_day || value.len() == 10 {
        return NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|dt| Utc.from_utc_datetime(&dt).timestamp_millis());
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// The last instant a series can produce, when the rule says so without being evaluated. None
/// means "assume it runs forever": COUNT needs the rule expanded to resolve, and an RDATE can put
/// an occurrence past any UNTIL, so both fall back to None and the expander does the real work.
fn series_until_ms(recurrence: &[String]) -> Option<i64> {
    if recurrence.is_empty() {
        return None;
    }
    let mut latest: Option<i64> = None;
    for line in recurrence {
        let upper = line.trim().to_uppercase();
        if upper.starts_with("RDATE") {
            return None;
        }
        if !upper.starts_with("RRULE") {
            continue;
        }
        let body = upper.strip_prefix("RRULE:").unwrap_or(&upper);
        let until = body
            .split(';')
            .find_map(|part| part.trim().strip_prefix("UNTIL="))?;
        let ms = parse_until(until)?;
        latest = Some(latest.map_or(ms, |current: i64| current.max(ms)));
    }
    latest
}

fn parse_until(value: &str) -> Option<i64> {
    let value = value.trim();
    for format in ["%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(value, format) {
            return Some(Utc.from_utc_datetime(&dt).timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(value, "%Y%m%d")
        .ok()
        .and_then(|d| d.and_hms_opt(23, 59, 59))
        .map(|dt| Utc.from_utc_datetime(&dt).timestamp_millis())
}

fn blank_to_none(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

// -- accounts ----------------------------------------------------------------------------------

/// Namespaced so `wipe_account` can delete every trace of an account by prefix. The calendarList
/// cursor belongs here rather than on `accounts`, whose columns the auth agent overwrites wholesale
/// with INSERT OR REPLACE.
pub fn account_meta_key(account_id: &str, name: &str) -> String {
    format!("account:{account_id}:{name}")
}

pub fn upsert_account(
    conn: &Connection,
    id: &str,
    email: &str,
    keychain_ref: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO accounts (id, email, keychain_ref, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, keychain_ref = excluded.keychain_ref",
        params![id, email, keychain_ref, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Everything that belongs to an account: its calendars, their events, their queued writes, its
/// meta keys and the account row itself. Disconnect calls this rather than clearing a token,
/// because a store still holding another account's remote ids is a store that will happily write
/// against them after a reconnect.
pub fn wipe_account(conn: &Connection, account_id: &str) -> Result<(), String> {
    let tx = Tx::begin(conn)?;
    conn.execute(
        "DELETE FROM outbox WHERE calendar_id IN (SELECT id FROM calendars WHERE account_id = ?1)",
        [account_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM events WHERE account_id = ?1
            OR calendar_id IN (SELECT id FROM calendars WHERE account_id = ?1)",
        [account_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM calendars WHERE account_id = ?1", [account_id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM meta WHERE key LIKE 'account:' || ?1 || ':%'",
        [account_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", [account_id])
        .map_err(|e| e.to_string())?;
    tx.commit()
}

// -- meta --------------------------------------------------------------------------------------

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// -- calendars ---------------------------------------------------------------------------------

/// A calendarList entry flattened. `selected` and `sync_token` are deliberately absent: selection
/// is the user's, held locally, and the cursor is the sync engine's.
#[derive(Debug, Clone, Default)]
pub struct CalendarRow {
    pub id: String,
    pub account_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub color_hex: String,
    pub access_role: String,
    pub time_zone: String,
    pub primary: bool,
    pub deleted: bool,
    /// Google's own tick for this calendar. Seeds the local selection on insert only.
    pub selected: bool,
}

/// Deliberately leaves `selected` and `sync_token` alone on an existing row, so a calendarList
/// refresh cannot re-tick a calendar the user unticked or discard a live cursor. On insert,
/// `selected` is seeded from Google's own setting, so a calendar hidden there starts hidden here.
///
/// `account_id` is left alone for the same reason. A calendar shared with two connected accounts
/// comes back in both calendarList responses, and letting the second one claim the row would flip
/// the owner on every pass. The sync token is issued per user, so each flip invalidates it and
/// forces a full resync of that calendar, for ever. First account to see it keeps it.
pub fn upsert_calendar(conn: &Connection, row: &CalendarRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO calendars
            (id, account_id, summary, description, color_hex, selected, access_role, time_zone,
             primary_cal, sync_token, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?10, ?6, ?7, ?8, NULL, ?9)
         ON CONFLICT(id) DO UPDATE SET
            summary     = excluded.summary,
            description = excluded.description,
            color_hex   = excluded.color_hex,
            access_role = excluded.access_role,
            time_zone   = excluded.time_zone,
            primary_cal = excluded.primary_cal,
            deleted     = excluded.deleted",
        params![
            row.id,
            row.account_id,
            row.summary,
            row.description,
            row.color_hex,
            row.access_role,
            row.time_zone,
            row.primary as i32,
            row.deleted as i32,
            row.selected as i32,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn upsert_calendars(conn: &Connection, rows: &[CalendarRow]) -> Result<(), String> {
    let tx = Tx::begin(conn)?;
    for row in rows {
        upsert_calendar(conn, row)?;
    }
    tx.commit()
}

pub fn set_calendar_selected(
    conn: &Connection,
    calendar_id: &str,
    selected: bool,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE calendars SET selected = ?2 WHERE id = ?1",
            params![calendar_id, selected as i32],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("no such calendar: {calendar_id}"));
    }
    Ok(())
}

/// Removes a calendar and everything hanging off it, for a calendarList entry Google reports as
/// deleted.
pub fn delete_calendar(conn: &Connection, calendar_id: &str) -> Result<(), String> {
    let tx = Tx::begin(conn)?;
    conn.execute("DELETE FROM outbox WHERE calendar_id = ?1", [calendar_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM events WHERE calendar_id = ?1", [calendar_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM calendars WHERE id = ?1", [calendar_id])
        .map_err(|e| e.to_string())?;
    tx.commit()
}

/// Store surface kept for symmetry with the setter. The pull reads cursors through
/// `read::sync_targets`, which fetches them for every calendar in one statement.
#[allow(dead_code)]
pub fn calendar_sync_token(conn: &Connection, calendar_id: &str) -> Result<Option<String>, String> {
    let token: Option<Option<String>> = conn
        .query_row(
            "SELECT sync_token FROM calendars WHERE id = ?1",
            [calendar_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(token.flatten())
}

pub fn set_calendar_sync_token(
    conn: &Connection,
    calendar_id: &str,
    token: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE calendars SET sync_token = ?2 WHERE id = ?1",
        params![calendar_id, token],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// -- events ------------------------------------------------------------------------------------

fn write_event(conn: &Connection, row: &EventRow, dirty: bool) -> Result<(), String> {
    let recurrence = serde_json::to_string(&row.recurrence).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO events
            (id, calendar_id, account_id, etag, status, summary, description, location,
             start_at, start_tz, end_at, end_tz, all_day, recurrence, recurring_event_id,
             original_start, attendees, conference, updated_at, dirty,
             start_ms, end_ms, series_until_ms, color_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                 ?19, ?20, ?21, ?22, ?23, ?24)",
        params![
            row.id,
            row.calendar_id,
            row.account_id,
            row.etag,
            row.status,
            row.summary,
            row.description,
            row.location,
            blank_to_none(&row.start_at),
            row.start_tz,
            blank_to_none(&row.end_at),
            row.end_tz,
            row.all_day as i32,
            recurrence,
            row.recurring_event_id,
            row.original_start,
            row.attendees,
            row.conference,
            row.updated_at,
            dirty as i32,
            epoch_ms(&row.start_at, row.all_day),
            epoch_ms(&row.end_at, row.all_day),
            series_until_ms(&row.recurrence),
            row.color_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn upsert_event(conn: &Connection, row: &EventRow) -> Result<(), String> {
    write_event(conn, row, row.dirty)
}

/// One transaction for a whole sync page, so a failure part way through leaves the cursor and the
/// rows consistent with each other.
/// Store surface kept for symmetry with `upsert_calendars`. The pull batches inside its own
/// transaction so the cursor commits with the rows.
#[allow(dead_code)]
pub fn upsert_events(conn: &Connection, rows: &[EventRow]) -> Result<(), String> {
    let tx = Tx::begin(conn)?;
    for row in rows {
        write_event(conn, row, row.dirty)?;
    }
    tx.commit()
}

/// The optimistic local write: the row lands marked dirty and renders before Google has seen it.
pub fn upsert_event_dirty(conn: &Connection, row: &EventRow) -> Result<(), String> {
    write_event(conn, row, true)
}

/// Called once a queued write has actually landed at Google.
pub fn clear_dirty(conn: &Connection, calendar_id: &str, event_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE events SET dirty = 0 WHERE id = ?1 AND calendar_id = ?2",
        params![event_id, calendar_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_event(conn: &Connection, calendar_id: &str, event_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM events WHERE id = ?1 AND calendar_id = ?2",
        params![event_id, calendar_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 410 recovery. Drops one calendar's rows and its cursor and nothing else, so the full resync that
/// follows is scoped to the calendar whose token died.
pub fn clear_calendar(conn: &Connection, calendar_id: &str) -> Result<(), String> {
    let tx = Tx::begin(conn)?;
    conn.execute("DELETE FROM events WHERE calendar_id = ?1", [calendar_id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE calendars SET sync_token = NULL WHERE id = ?1",
        [calendar_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit()
}

// -- outbox ------------------------------------------------------------------------------------

/// Returns the new row id. `created_at` is filled in here unless the caller has already set it, so
/// the drain order is the enqueue order.
pub fn enqueue(conn: &Connection, row: &OutboxRow) -> Result<i64, String> {
    let created_at = if row.created_at > 0 { row.created_at } else { now_ms() };
    conn.execute(
        "INSERT INTO outbox
            (op, calendar_id, event_id, original_start, scope, payload, etag, attempts,
             created_at, last_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, NULL)",
        params![
            row.op,
            row.calendar_id,
            row.event_id,
            row.original_start,
            row.scope,
            row.payload,
            row.etag,
            created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Oldest first. The drain takes a batch, pushes each in turn and dequeues what lands.
pub fn peek_outbox(conn: &Connection, limit: u32) -> Result<Vec<OutboxRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, op, calendar_id, event_id, original_start, scope, payload, etag,
                    attempts, created_at, last_error
             FROM outbox ORDER BY created_at, id LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(OutboxRow {
                id: r.get(0)?,
                op: r.get(1)?,
                calendar_id: r.get(2)?,
                event_id: r.get(3)?,
                original_start: r.get(4)?,
                scope: r.get(5)?,
                payload: r.get(6)?,
                etag: r.get(7)?,
                attempts: r.get(8)?,
                created_at: r.get(9)?,
                last_error: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn mark_attempt_failed(conn: &Connection, id: i64, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE outbox SET attempts = attempts + 1, last_error = ?2 WHERE id = ?1",
        params![id, error],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn dequeue(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM outbox WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
