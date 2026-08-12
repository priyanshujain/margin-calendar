// Row-level reads. Nothing here interprets a timestamp: `masters_overlapping` narrows the rows
// with a deliberately loose window and `recur` does the exact work.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::dto::{Account, Calendar};
use crate::store::write::EventRow;

/// The window is padded by a day at each end before it touches SQL. All-day rows carry a `start_ms`
/// pinned to UTC midnight while the caller's bounds are local, so up to a zone offset of slack is
/// needed either side; over-returning costs the expander a comparison, under-returning loses an
/// event.
const DAY_MS: i64 = 86_400_000;

const EVENT_COLS: &str = "e.id, e.calendar_id, e.account_id, e.etag, e.status, e.summary, \
    e.description, e.location, e.start_at, e.start_tz, e.end_at, e.end_tz, e.all_day, \
    e.recurrence, e.recurring_event_id, e.original_start, e.attendees, e.conference, \
    e.updated_at, e.dirty, e.color_id";

const LIVE: &str = "JOIN calendars c ON c.id = e.calendar_id WHERE c.selected = 1 AND c.deleted = 0";

const IS_MASTER: &str = "(e.recurrence IS NOT NULL AND e.recurrence <> '' AND e.recurrence <> '[]')";

pub fn accounts(conn: &Connection) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare("SELECT id, email, keychain_ref FROM accounts ORDER BY created_at, email")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let keychain_ref: Option<String> = r.get(2)?;
            Ok(Account {
                id: r.get(0)?,
                email: r.get(1)?,
                // The store's view of connected is "there is a credential to go and fetch". Whether
                // that credential still refreshes is the auth agent's answer, not this one.
                connected: keychain_ref.is_some_and(|v| !v.is_empty()),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn calendars(conn: &Connection) -> Result<Vec<Calendar>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, summary, description, color_hex, selected, access_role,
                    time_zone, primary_cal
             FROM calendars WHERE deleted = 0
             ORDER BY primary_cal DESC, summary COLLATE NOCASE, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Calendar {
                id: r.get(0)?,
                account_id: r.get(1)?,
                summary: r.get(2)?,
                description: r.get(3)?,
                color_hex: r.get(4)?,
                selected: r.get::<_, i64>(5)? != 0,
                access_role: r.get(6)?,
                time_zone: r.get(7)?,
                primary: r.get::<_, i64>(8)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// One calendar the sync loop has to visit, with the cursor that belongs to it. Deleted rows are
/// left out; unselected ones are not, because selection is a display choice and a calendar that
/// stops syncing while it is unticked comes back stale.
#[derive(Debug, Clone)]
pub struct SyncTarget {
    pub calendar_id: String,
    pub account_id: String,
    pub sync_token: Option<String>,
}

pub fn sync_targets(conn: &Connection) -> Result<Vec<SyncTarget>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, sync_token FROM calendars WHERE deleted = 0
             ORDER BY account_id, primary_cal DESC, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SyncTarget {
                calendar_id: r.get(0)?,
                account_id: r.get(1)?,
                sync_token: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// A single row by its full key, for the outbox drain, which needs the stored etag to send an
/// If-Match. Ignores selection, unlike the window read.
pub fn event(
    conn: &Connection,
    calendar_id: &str,
    event_id: &str,
) -> Result<Option<EventRow>, String> {
    let sql = format!(
        "SELECT {EVENT_COLS} FROM events e WHERE e.id = ?1 AND e.calendar_id = ?2"
    );
    conn.query_row(&sql, params![event_id, calendar_id], map_event)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn pending_writes(conn: &Connection) -> Result<u32, String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(count.max(0) as u32)
}

/// Every event row that could contribute an occurrence to [from_ms, to_ms): singles overlapping
/// the window, every master with a recurrence rule that has not already ended, and every
/// exception instance pointing at one of those masters.
///
/// An RRULE cannot be evaluated in SQL, so the master test is loose on purpose: a series is
/// returned unless it starts after the window or its UNTIL has already passed. Everything else is
/// the expander's problem.
pub fn masters_overlapping(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<EventRow>, String> {
    let from = from_ms.saturating_sub(DAY_MS);
    let to = to_ms.saturating_add(DAY_MS);

    let mut out: Vec<EventRow> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    let sql = format!(
        "SELECT {EVENT_COLS} FROM events e {LIVE}
           AND e.start_ms IS NOT NULL AND e.start_ms < ?2
           AND (
                 (e.recurring_event_id IS NOT NULL AND (e.end_ms IS NULL OR e.end_ms >= ?1))
              OR (e.status <> 'cancelled' AND {IS_MASTER}
                  AND (e.series_until_ms IS NULL OR e.series_until_ms >= ?1))
              OR (e.status <> 'cancelled' AND e.recurring_event_id IS NULL AND NOT {IS_MASTER}
                  AND (e.end_ms IS NULL OR e.end_ms >= ?1))
           )
         ORDER BY e.start_ms, e.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from, to], map_event)
        .map_err(|e| e.to_string())?;
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        if seen.insert(key(&row)) {
            out.push(row);
        }
    }
    drop(stmt);

    // Every series the matched rows imply, whether the master matched on its own or only an
    // exception of it did.
    let mut series: Vec<(String, String)> = Vec::new();
    let mut wanted: HashSet<(String, String)> = HashSet::new();
    for row in &out {
        let series_key = match (&row.recurring_event_id, row.recurrence.is_empty()) {
            (Some(master), _) => (master.clone(), row.calendar_id.clone()),
            (None, false) => (row.id.clone(), row.calendar_id.clone()),
            (None, true) => continue,
        };
        if wanted.insert(series_key.clone()) {
            series.push(series_key);
        }
    }

    let master_sql = format!(
        "SELECT {EVENT_COLS} FROM events e {LIVE} AND e.id = ?1 AND e.calendar_id = ?2"
    );
    let mut stmt = conn.prepare(&master_sql).map_err(|e| e.to_string())?;
    for (event_id, calendar_id) in &series {
        if seen.contains(&(event_id.clone(), calendar_id.clone())) {
            continue;
        }
        let row = stmt
            .query_row(params![event_id, calendar_id], map_event)
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(row) = row {
            if seen.insert(key(&row)) {
                out.push(row);
            }
        }
    }
    drop(stmt);

    // Exceptions come back whatever their own times say. A moved instance can be dragged into the
    // window from outside it, and a cancelled one is only guaranteed to carry its id, its master,
    // its original start and its status, so it has no times to filter on at all.
    let exception_sql = format!(
        "SELECT {EVENT_COLS} FROM events e {LIVE}
           AND e.recurring_event_id = ?1 AND e.calendar_id = ?2"
    );
    let mut stmt = conn.prepare(&exception_sql).map_err(|e| e.to_string())?;
    for (event_id, calendar_id) in &series {
        let rows = stmt
            .query_map(params![event_id, calendar_id], map_event)
            .map_err(|e| e.to_string())?;
        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            if seen.insert(key(&row)) {
                out.push(row);
            }
        }
    }

    Ok(out)
}

fn key(row: &EventRow) -> (String, String) {
    (row.id.clone(), row.calendar_id.clone())
}

fn map_event(r: &Row<'_>) -> rusqlite::Result<EventRow> {
    let recurrence: String = r.get(13)?;
    Ok(EventRow {
        id: r.get(0)?,
        calendar_id: r.get(1)?,
        account_id: r.get(2)?,
        etag: r.get(3)?,
        status: r.get(4)?,
        summary: r.get(5)?,
        description: r.get(6)?,
        location: r.get(7)?,
        start_at: r.get::<_, Option<String>>(8)?.unwrap_or_default(),
        start_tz: r.get(9)?,
        end_at: r.get::<_, Option<String>>(10)?.unwrap_or_default(),
        end_tz: r.get(11)?,
        all_day: r.get::<_, i64>(12)? != 0,
        recurrence: serde_json::from_str(&recurrence).unwrap_or_default(),
        recurring_event_id: r.get(14)?,
        original_start: r.get(15)?,
        attendees: r.get(16)?,
        conference: r.get(17)?,
        updated_at: r.get(18)?,
        dirty: r.get::<_, i64>(19)? != 0,
        color_id: r.get(20)?,
    })
}
