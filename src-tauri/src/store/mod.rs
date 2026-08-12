// schema.rs  table definitions and migrations
// read.rs    row-level reads: accounts, calendars, masters overlapping a window, outbox depth
// write.rs   row-level writes: upserts from sync, optimistic local writes, outbox enqueue/drain

pub mod read;
pub mod schema;
pub mod write;

use std::sync::Mutex;

use rusqlite::Connection;

use crate::dto::Calendar;

/// One connection behind a Mutex. Every caller is either a Tauri command or the sync loop, and
/// neither is hot enough to want a pool.
pub struct Store {
    pub conn: Mutex<Connection>,
}

impl Store {
    pub fn open(app: &tauri::AppHandle) -> Result<Store, String> {
        let path = crate::library::app_data_dir(app)?.join("calendar.sqlite3");
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        schema::migrate(&conn)?;
        Ok(Store { conn: Mutex::new(conn) })
    }
}

#[tauri::command]
pub fn calendars_list(store: tauri::State<'_, Store>) -> Result<Vec<Calendar>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    read::calendars(&conn)
}

#[tauri::command]
pub fn calendar_set_selected(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    calendar_id: String,
    selected: bool,
) -> Result<(), String> {
    {
        let conn = store.conn.lock().map_err(|e| e.to_string())?;
        write::set_calendar_selected(&conn, &calendar_id, selected)?;
    }
    crate::emit_store_changed(&app, "calendar-selection");
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::write::{CalendarRow, EventRow, OutboxRow};
    use super::{read, schema, write};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database");
        schema::migrate(&conn).expect("migrate");
        conn
    }

    fn ms(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .expect("a timestamp")
            .timestamp_millis()
    }

    fn calendar(conn: &Connection, id: &str, account_id: &str) {
        write::upsert_calendar(
            conn,
            &CalendarRow {
                id: id.to_string(),
                account_id: account_id.to_string(),
                summary: id.to_string(),
                color_hex: "#4285f4".to_string(),
                access_role: "owner".to_string(),
                time_zone: "Europe/London".to_string(),
                selected: true,
                ..Default::default()
            },
        )
        .expect("upsert calendar");
    }

    fn event(id: &str, calendar_id: &str, start: &str, end: &str) -> EventRow {
        EventRow {
            id: id.to_string(),
            calendar_id: calendar_id.to_string(),
            account_id: "acct".to_string(),
            status: "confirmed".to_string(),
            summary: id.to_string(),
            start_at: start.to_string(),
            end_at: end.to_string(),
            ..Default::default()
        }
    }

    fn ids(rows: &[EventRow]) -> Vec<&str> {
        rows.iter().map(|r| r.id.as_str()).collect()
    }

    /// A calendar shared with two connected accounts is listed by both. If the second claimed the
    /// row, the owner would flip on every pass, and since a sync token is issued per user, each
    /// flip would invalidate it and force a full resync of that calendar for ever.
    #[test]
    fn a_shared_calendar_keeps_the_account_that_saw_it_first() {
        let conn = db();
        calendar(&conn, "shared", "first");
        write::set_calendar_sync_token(&conn, "shared", Some("cursor")).expect("set token");

        calendar(&conn, "shared", "second");

        let rows = read::calendars(&conn).expect("calendars");
        let row = rows.iter().find(|c| c.id == "shared").expect("the shared calendar");
        assert_eq!(row.account_id, "first");
        assert_eq!(
            write::calendar_sync_token(&conn, "shared").expect("token"),
            Some("cursor".to_string())
        );
    }

    #[test]
    fn migrate_runs_twice_without_complaint() {
        let conn = db();
        schema::migrate(&conn).expect("second migrate");

        let version: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0))
            .expect("a recorded version");
        assert_eq!(version, schema::VERSION.to_string());

        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
                   AND name IN ('meta', 'accounts', 'calendars', 'events', 'outbox')",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(tables, 5);
    }

    #[test]
    fn migrate_refuses_a_database_from_a_newer_build() {
        let conn = db();
        write::meta_set(&conn, "schema_version", "99").expect("bump");
        assert!(schema::migrate(&conn).is_err());
    }

    #[test]
    fn wiping_an_account_takes_its_calendars_events_and_queued_writes() {
        let conn = db();
        write::upsert_account(&conn, "acct", "a@example.com", Some("ref")).expect("account");
        write::upsert_account(&conn, "other", "b@example.com", Some("ref")).expect("account");
        calendar(&conn, "cal-a", "acct");
        calendar(&conn, "cal-b", "other");
        write::meta_set(
            &conn,
            &write::account_meta_key("acct", "calendar-list-token"),
            "tok",
        )
        .expect("meta");

        write::upsert_event(
            &conn,
            &event("one", "cal-a", "2026-08-10T09:00:00Z", "2026-08-10T10:00:00Z"),
        )
        .expect("event");
        let mut kept = event("two", "cal-b", "2026-08-10T09:00:00Z", "2026-08-10T10:00:00Z");
        kept.account_id = "other".to_string();
        write::upsert_event(&conn, &kept).expect("event");

        for calendar_id in ["cal-a", "cal-b"] {
            write::enqueue(
                &conn,
                &OutboxRow {
                    op: "patch".to_string(),
                    calendar_id: calendar_id.to_string(),
                    event_id: Some("one".to_string()),
                    ..Default::default()
                },
            )
            .expect("enqueue");
        }

        write::wipe_account(&conn, "acct").expect("wipe");

        assert_eq!(read::accounts(&conn).expect("accounts").len(), 1);
        assert_eq!(read::calendars(&conn).expect("calendars").len(), 1);
        assert_eq!(read::pending_writes(&conn).expect("outbox"), 1);
        assert!(read::event(&conn, "cal-a", "one").expect("read").is_none());
        assert!(read::event(&conn, "cal-b", "two").expect("read").is_some());
        let meta = write::meta_get(&conn, &write::account_meta_key("acct", "calendar-list-token"));
        assert_eq!(meta.expect("meta"), None);
    }

    #[test]
    fn clearing_one_calendar_leaves_the_others_alone() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");
        calendar(&conn, "cal-b", "acct");
        write::set_calendar_sync_token(&conn, "cal-a", Some("token-a")).expect("token");
        write::set_calendar_sync_token(&conn, "cal-b", Some("token-b")).expect("token");
        write::upsert_event(
            &conn,
            &event("one", "cal-a", "2026-08-10T09:00:00Z", "2026-08-10T10:00:00Z"),
        )
        .expect("event");
        write::upsert_event(
            &conn,
            &event("two", "cal-b", "2026-08-10T09:00:00Z", "2026-08-10T10:00:00Z"),
        )
        .expect("event");

        write::clear_calendar(&conn, "cal-a").expect("clear");

        assert!(read::event(&conn, "cal-a", "one").expect("read").is_none());
        assert!(read::event(&conn, "cal-b", "two").expect("read").is_some());
        assert_eq!(write::calendar_sync_token(&conn, "cal-a").expect("token"), None);
        assert_eq!(
            write::calendar_sync_token(&conn, "cal-b").expect("token"),
            Some("token-b".to_string())
        );
        assert_eq!(read::calendars(&conn).expect("calendars").len(), 2);
    }

    #[test]
    fn a_calendar_refresh_does_not_re_tick_an_unticked_calendar() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");
        write::set_calendar_selected(&conn, "cal-a", false).expect("unselect");
        write::set_calendar_sync_token(&conn, "cal-a", Some("token-a")).expect("token");
        calendar(&conn, "cal-a", "acct");

        let calendars = read::calendars(&conn).expect("calendars");
        assert!(!calendars[0].selected);
        assert_eq!(
            write::calendar_sync_token(&conn, "cal-a").expect("token"),
            Some("token-a".to_string())
        );
    }

    #[test]
    fn the_window_read_keeps_an_exception_whose_own_times_fall_outside_it() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");

        let mut master = event(
            "series",
            "cal-a",
            "2026-08-03T09:00:00Z",
            "2026-08-03T10:00:00Z",
        );
        master.recurrence = vec!["RRULE:FREQ=WEEKLY;BYDAY=MO".to_string()];
        write::upsert_event(&conn, &master).expect("master");

        // Dragged out of the window entirely.
        let mut moved = event(
            "series_20260810T090000Z",
            "cal-a",
            "2026-09-20T09:00:00Z",
            "2026-09-20T10:00:00Z",
        );
        moved.recurring_event_id = Some("series".to_string());
        moved.original_start = Some("2026-08-10T09:00:00Z".to_string());
        write::upsert_event(&conn, &moved).expect("moved");

        // Cancelled, so it carries no times at all.
        let mut cancelled = event("series_20260817T090000Z", "cal-a", "", "");
        cancelled.status = "cancelled".to_string();
        cancelled.recurring_event_id = Some("series".to_string());
        cancelled.original_start = Some("2026-08-17T09:00:00Z".to_string());
        write::upsert_event(&conn, &cancelled).expect("cancelled");

        // Nothing to do with the window.
        write::upsert_event(
            &conn,
            &event("elsewhere", "cal-a", "2027-01-01T09:00:00Z", "2027-01-01T10:00:00Z"),
        )
        .expect("single");

        let rows = read::masters_overlapping(
            &conn,
            ms("2026-08-10T00:00:00Z"),
            ms("2026-08-17T00:00:00Z"),
        )
        .expect("window");

        let found = ids(&rows);
        assert!(found.contains(&"series"), "the master: {found:?}");
        assert!(found.contains(&"series_20260810T090000Z"), "the moved instance: {found:?}");
        assert!(found.contains(&"series_20260817T090000Z"), "the cancelled instance: {found:?}");
        assert!(!found.contains(&"elsewhere"), "an unrelated single: {found:?}");
    }

    #[test]
    fn the_window_read_drops_a_series_that_has_already_ended() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");

        let mut ended = event("ended", "cal-a", "2025-01-06T09:00:00Z", "2025-01-06T10:00:00Z");
        ended.recurrence = vec!["RRULE:FREQ=WEEKLY;UNTIL=20250201T000000Z".to_string()];
        write::upsert_event(&conn, &ended).expect("ended");

        let mut endless = event("endless", "cal-a", "2025-01-06T09:00:00Z", "2025-01-06T10:00:00Z");
        endless.recurrence = vec!["RRULE:FREQ=WEEKLY;COUNT=500".to_string()];
        write::upsert_event(&conn, &endless).expect("endless");

        let rows = read::masters_overlapping(
            &conn,
            ms("2026-08-10T00:00:00Z"),
            ms("2026-08-17T00:00:00Z"),
        )
        .expect("window");

        let found = ids(&rows);
        assert!(!found.contains(&"ended"), "{found:?}");
        assert!(found.contains(&"endless"), "COUNT cannot be resolved in SQL: {found:?}");
    }

    #[test]
    fn the_window_read_ignores_unselected_calendars() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");
        calendar(&conn, "cal-b", "acct");
        write::set_calendar_selected(&conn, "cal-b", false).expect("unselect");
        write::upsert_event(
            &conn,
            &event("one", "cal-a", "2026-08-11T09:00:00Z", "2026-08-11T10:00:00Z"),
        )
        .expect("event");
        write::upsert_event(
            &conn,
            &event("two", "cal-b", "2026-08-11T09:00:00Z", "2026-08-11T10:00:00Z"),
        )
        .expect("event");

        let rows = read::masters_overlapping(
            &conn,
            ms("2026-08-10T00:00:00Z"),
            ms("2026-08-17T00:00:00Z"),
        )
        .expect("window");
        assert_eq!(ids(&rows), vec!["one"]);
    }

    #[test]
    fn an_all_day_event_survives_the_window_bounds() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");
        let mut all_day = event("holiday", "cal-a", "2026-08-11", "2026-08-12");
        all_day.all_day = true;
        write::upsert_event(&conn, &all_day).expect("event");

        let rows = read::masters_overlapping(
            &conn,
            ms("2026-08-10T00:00:00Z"),
            ms("2026-08-17T00:00:00Z"),
        )
        .expect("window");
        assert_eq!(ids(&rows), vec!["holiday"]);
    }

    #[test]
    fn the_outbox_drains_in_the_order_it_was_filled() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");
        let first = write::enqueue(
            &conn,
            &OutboxRow {
                op: "create".to_string(),
                calendar_id: "cal-a".to_string(),
                created_at: 10,
                ..Default::default()
            },
        )
        .expect("enqueue");
        let second = write::enqueue(
            &conn,
            &OutboxRow {
                op: "patch".to_string(),
                calendar_id: "cal-a".to_string(),
                created_at: 20,
                ..Default::default()
            },
        )
        .expect("enqueue");

        let queued = write::peek_outbox(&conn, 10).expect("peek");
        assert_eq!(
            queued.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![first, second]
        );
        assert_eq!(read::pending_writes(&conn).expect("depth"), 2);

        write::mark_attempt_failed(&conn, first, "offline").expect("failed");
        let queued = write::peek_outbox(&conn, 10).expect("peek");
        assert_eq!(queued[0].attempts, 1);
        assert_eq!(queued[0].last_error.as_deref(), Some("offline"));

        write::dequeue(&conn, first).expect("dequeue");
        assert_eq!(read::pending_writes(&conn).expect("depth"), 1);
    }

    #[test]
    fn a_local_write_is_dirty_until_it_lands() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");
        let row = event("one", "cal-a", "2026-08-11T09:00:00Z", "2026-08-11T10:00:00Z");
        write::upsert_event_dirty(&conn, &row).expect("write");
        assert!(read::event(&conn, "cal-a", "one").expect("read").expect("row").dirty);

        write::clear_dirty(&conn, "cal-a", "one").expect("clear");
        assert!(!read::event(&conn, "cal-a", "one").expect("read").expect("row").dirty);
    }

    #[test]
    fn the_same_event_id_can_live_in_two_calendars() {
        let conn = db();
        calendar(&conn, "cal-a", "acct");
        calendar(&conn, "cal-b", "acct");
        write::upsert_events(
            &conn,
            &[
                event("shared", "cal-a", "2026-08-11T09:00:00Z", "2026-08-11T10:00:00Z"),
                event("shared", "cal-b", "2026-08-11T09:00:00Z", "2026-08-11T10:00:00Z"),
            ],
        )
        .expect("write");

        write::delete_event(&conn, "cal-a", "shared").expect("delete");
        assert!(read::event(&conn, "cal-a", "shared").expect("read").is_none());
        assert!(read::event(&conn, "cal-b", "shared").expect("read").is_some());
    }
}
