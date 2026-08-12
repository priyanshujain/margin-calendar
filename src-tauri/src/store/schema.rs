// Tables and migrations. `migrate` is idempotent and forward-only: it runs the steps between the
// version recorded in `meta` and VERSION, and refuses to open a database written by a newer build
// rather than silently misreading it.
//
// No table declares a FOREIGN KEY. The auth agent writes `accounts` with INSERT OR REPLACE, and a
// REPLACE deletes the conflicting row first, which under `foreign_keys=ON` would either cascade
// away every calendar and event for that account or be rejected outright. Referential integrity is
// enforced by `write::wipe_account` and `write::clear_calendar` instead, which is the only place it
// actually matters.

use rusqlite::{Connection, OptionalExtension};

use crate::store::write::Tx;

pub const VERSION: i32 = 2;

/// The key `meta` carries the schema version under. Every other key belongs to a caller; account
/// scoped ones go through `write::account_meta_key` so `wipe_account` can find them again.
const VERSION_KEY: &str = "schema_version";

// `start_ms`, `end_ms` and `series_until_ms` are not in Google's shape. `start_at` is RFC3339 with
// an offset, or a bare YYYY-MM-DD when all-day, and neither form sorts or compares against an
// epoch-millisecond window in SQL. They are derived on every write from the columns beside them,
// so they are a cache, never a source of truth, and `read::masters_overlapping` is the only reader.
const V1: &str = "
CREATE TABLE IF NOT EXISTS accounts (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    keychain_ref TEXT,
    created_at   INTEGER
);

CREATE TABLE IF NOT EXISTS calendars (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    description TEXT,
    color_hex   TEXT NOT NULL DEFAULT '',
    selected    INTEGER NOT NULL DEFAULT 1,
    access_role TEXT NOT NULL DEFAULT 'reader',
    time_zone   TEXT NOT NULL DEFAULT '',
    primary_cal INTEGER NOT NULL DEFAULT 0,
    sync_token  TEXT,
    deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id                 TEXT NOT NULL,
    calendar_id        TEXT NOT NULL,
    account_id         TEXT NOT NULL,
    etag               TEXT,
    status             TEXT NOT NULL DEFAULT 'confirmed',
    summary            TEXT NOT NULL DEFAULT '',
    description        TEXT,
    location           TEXT,
    start_at           TEXT,
    start_tz           TEXT,
    end_at             TEXT,
    end_tz             TEXT,
    all_day            INTEGER NOT NULL DEFAULT 0,
    recurrence         TEXT NOT NULL DEFAULT '[]',
    recurring_event_id TEXT,
    original_start     TEXT,
    attendees          TEXT,
    conference         TEXT,
    updated_at         TEXT,
    dirty              INTEGER NOT NULL DEFAULT 0,
    start_ms           INTEGER,
    end_ms             INTEGER,
    series_until_ms    INTEGER,
    color_id           TEXT,
    PRIMARY KEY (id, calendar_id)
);

CREATE TABLE IF NOT EXISTS outbox (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    op             TEXT NOT NULL,
    calendar_id    TEXT NOT NULL,
    event_id       TEXT,
    original_start TEXT,
    scope          TEXT,
    payload        TEXT,
    etag           TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_calendar_start ON events (calendar_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_events_series ON events (recurring_event_id, original_start);
CREATE INDEX IF NOT EXISTS idx_events_account ON events (account_id);
CREATE INDEX IF NOT EXISTS idx_calendars_account ON calendars (account_id);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox (created_at, id);
";

// Google's per-event colour, which overrides the calendar's. Stored as the id rather than a hex so
// it round-trips to `colorId` on the wire unchanged.
const V2: &str = "ALTER TABLE events ADD COLUMN color_id TEXT;";

pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(|e| e.to_string())?;

    let found = version(conn)?;
    if found > VERSION {
        return Err(format!(
            "this calendar database is at schema {found}, which is newer than this build understands ({VERSION})"
        ));
    }
    if found == VERSION {
        return Ok(());
    }

    let tx = Tx::begin(conn)?;
    if found < 1 {
        conn.execute_batch(V1).map_err(|e| e.to_string())?;
    } else if found < 2 {
        // Only for a database that predates the column; V1 already declares it.
        conn.execute_batch(V2).map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![VERSION_KEY, VERSION.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit()
}

fn version(conn: &Connection) -> Result<i32, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [VERSION_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(raw.and_then(|v| v.parse::<i32>().ok()).unwrap_or(0))
}
