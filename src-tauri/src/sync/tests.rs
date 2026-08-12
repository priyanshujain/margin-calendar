// The state machine against a stubbed transport and an in-memory database. Nothing here touches
// Google, and nothing here can: the engine only ever speaks through `Transport`.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use tauri::async_runtime::block_on;

use crate::dto::SyncStatus;
use crate::google::api::{ApiError, CalendarListPage, EventDateTime, EventsPage, RawEvent};
use crate::store::write::{self, CalendarRow, OutboxRow};
use crate::store::{read, schema, Store};

use super::transport::Transport;
use super::{pull, push, with_conn, Sink};

// -- the stub ----------------------------------------------------------------------------------

#[derive(Default)]
struct Stub {
    events: Mutex<HashMap<String, VecDeque<Result<EventsPage, ApiError>>>>,
    calendars: Mutex<VecDeque<Result<CalendarListPage, ApiError>>>,
    writes: Mutex<VecDeque<Result<RawEvent, ApiError>>>,
    deletes: Mutex<VecDeque<Result<(), ApiError>>>,
    instances: Mutex<VecDeque<Result<Vec<RawEvent>, ApiError>>>,
    calls: Mutex<Vec<String>>,
}

impl Stub {
    fn record(&self, call: String) {
        self.calls.lock().expect("calls").push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }

    fn script_events(&self, calendar_id: &str, replies: Vec<Result<EventsPage, ApiError>>) {
        self.events
            .lock()
            .expect("events")
            .insert(calendar_id.to_string(), replies.into());
    }

    fn script_calendars(&self, replies: Vec<Result<CalendarListPage, ApiError>>) {
        *self.calendars.lock().expect("calendars") = replies.into();
    }

    fn script_writes(&self, replies: Vec<Result<RawEvent, ApiError>>) {
        *self.writes.lock().expect("writes") = replies.into();
    }
}

fn shown(value: Option<&str>) -> &str {
    value.unwrap_or("-")
}

impl Transport for Stub {
    fn calendar_list(
        &self,
        account_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> impl std::future::Future<Output = Result<CalendarListPage, ApiError>> + Send {
        async move {
            self.record(format!(
                "calendar_list {account_id} sync={} page={}",
                shown(sync_token),
                shown(page_token)
            ));
            self.calendars
                .lock()
                .expect("calendars")
                .pop_front()
                .unwrap_or_else(|| Err(ApiError::Other("unscripted calendar_list".to_string())))
        }
    }

    fn events_list(
        &self,
        _account_id: &str,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> impl std::future::Future<Output = Result<EventsPage, ApiError>> + Send {
        async move {
            self.record(format!(
                "events_list {calendar_id} sync={} page={}",
                shown(sync_token),
                shown(page_token)
            ));
            self.events
                .lock()
                .expect("events")
                .get_mut(calendar_id)
                .and_then(|replies| replies.pop_front())
                .unwrap_or_else(|| Err(ApiError::Other("unscripted events_list".to_string())))
        }
    }

    fn events_insert(
        &self,
        _account_id: &str,
        calendar_id: &str,
        body: &serde_json::Value,
    ) -> impl std::future::Future<Output = Result<RawEvent, ApiError>> + Send {
        async move {
            let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("-");
            self.record(format!("events_insert {calendar_id} {id}"));
            self.writes
                .lock()
                .expect("writes")
                .pop_front()
                .unwrap_or_else(|| Err(ApiError::Other("unscripted events_insert".to_string())))
        }
    }

    fn events_patch(
        &self,
        _account_id: &str,
        calendar_id: &str,
        event_id: &str,
        _body: &serde_json::Value,
        etag: Option<&str>,
    ) -> impl std::future::Future<Output = Result<RawEvent, ApiError>> + Send {
        async move {
            self.record(format!(
                "events_patch {calendar_id} {event_id} etag={}",
                shown(etag)
            ));
            self.writes
                .lock()
                .expect("writes")
                .pop_front()
                .unwrap_or_else(|| Err(ApiError::Other("unscripted events_patch".to_string())))
        }
    }

    fn events_delete(
        &self,
        _account_id: &str,
        calendar_id: &str,
        event_id: &str,
        etag: Option<&str>,
    ) -> impl std::future::Future<Output = Result<(), ApiError>> + Send {
        async move {
            self.record(format!(
                "events_delete {calendar_id} {event_id} etag={}",
                shown(etag)
            ));
            self.deletes
                .lock()
                .expect("deletes")
                .pop_front()
                .unwrap_or(Ok(()))
        }
    }

    fn events_instances(
        &self,
        _account_id: &str,
        calendar_id: &str,
        event_id: &str,
        original_start: &str,
    ) -> impl std::future::Future<Output = Result<Vec<RawEvent>, ApiError>> + Send {
        async move {
            self.record(format!(
                "events_instances {calendar_id} {event_id} at={original_start}"
            ));
            self.instances
                .lock()
                .expect("instances")
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }
    }
}

#[derive(Default)]
struct Recorder {
    messages: Mutex<Vec<String>>,
    reasons: Mutex<Vec<String>>,
    statuses: Mutex<Vec<SyncStatus>>,
}

impl Sink for Recorder {
    fn message(&self, text: &str) {
        self.messages.lock().expect("messages").push(text.to_string());
    }

    fn status(&self, status: &SyncStatus) {
        self.statuses.lock().expect("statuses").push(status.clone());
    }

    fn changed(&self, reason: &str) {
        self.reasons.lock().expect("reasons").push(reason.to_string());
    }
}

// -- fixtures ----------------------------------------------------------------------------------

fn db() -> Store {
    let conn = Connection::open_in_memory().expect("in-memory database");
    schema::migrate(&conn).expect("migrate");
    Store {
        conn: Mutex::new(conn),
    }
}

/// The calendarList cursor is seeded so a pull runs incremental. A full list is the whole truth and
/// would prune calendars a test set up by hand.
fn account(store: &Store, id: &str) {
    with_conn(store, |conn| {
        write::upsert_account(conn, id, &format!("{id}@example.test"), Some("keychain"))?;
        write::meta_set(
            conn,
            &write::account_meta_key(id, "calendar-list-token"),
            "cl-0",
        )
    })
    .expect("account");
}

fn calendar(store: &Store, id: &str, account_id: &str, sync_token: Option<&str>) {
    with_conn(store, |conn| {
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
        )?;
        write::set_calendar_sync_token(conn, id, sync_token)
    })
    .expect("calendar");
}

fn stored_event(store: &Store, id: &str, calendar_id: &str) {
    with_conn(store, |conn| {
        write::upsert_event(
            conn,
            &crate::store::write::EventRow {
                id: id.to_string(),
                calendar_id: calendar_id.to_string(),
                account_id: "acct".to_string(),
                status: "confirmed".to_string(),
                summary: id.to_string(),
                start_at: "2026-08-10T09:00:00Z".to_string(),
                end_at: "2026-08-10T10:00:00Z".to_string(),
                etag: Some(format!("etag-{id}")),
                ..Default::default()
            },
        )
    })
    .expect("event");
}

fn when(value: &str) -> EventDateTime {
    EventDateTime {
        date_time: Some(value.to_string()),
        ..Default::default()
    }
}

fn raw(id: &str) -> RawEvent {
    RawEvent {
        id: id.to_string(),
        etag: Some(format!("etag-{id}")),
        status: Some("confirmed".to_string()),
        summary: Some(id.to_string()),
        start: Some(when("2026-08-10T09:00:00Z")),
        end: Some(when("2026-08-10T10:00:00Z")),
        ..Default::default()
    }
}

fn page(items: Vec<RawEvent>, next_page: Option<&str>, next_sync: Option<&str>) -> EventsPage {
    EventsPage {
        items,
        next_page_token: next_page.map(str::to_string),
        next_sync_token: next_sync.map(str::to_string),
    }
}

fn calendar_page(next_sync: &str) -> CalendarListPage {
    CalendarListPage {
        items: Vec::new(),
        next_page_token: None,
        next_sync_token: Some(next_sync.to_string()),
    }
}

fn token_of(store: &Store, calendar_id: &str) -> Option<String> {
    with_conn(store, |conn| write::calendar_sync_token(conn, calendar_id)).expect("token")
}

fn has_event(store: &Store, calendar_id: &str, event_id: &str) -> bool {
    with_conn(store, |conn| read::event(conn, calendar_id, event_id))
        .expect("read")
        .is_some()
}

fn queued(store: &Store) -> Vec<OutboxRow> {
    with_conn(store, |conn| write::peek_outbox(conn, 50)).expect("peek")
}

fn enqueue(store: &Store, op: &str, event_id: &str, payload: Option<&str>, etag: Option<&str>) {
    with_conn(store, |conn| {
        write::enqueue(
            conn,
            &OutboxRow {
                op: op.to_string(),
                calendar_id: "cal-a".to_string(),
                event_id: Some(event_id.to_string()),
                payload: payload.map(str::to_string),
                etag: etag.map(str::to_string),
                ..Default::default()
            },
        )
    })
    .expect("enqueue");
}

fn drain(store: &Store, stub: &Stub) -> super::Outcome {
    block_on(push::drain(
        store,
        stub,
        Instant::now() + Duration::from_secs(30),
    ))
}

// -- the pull ----------------------------------------------------------------------------------

#[test]
fn pagination_walks_to_exhaustion_and_commits_the_token_from_the_final_page() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));

    let stub = Stub::default();
    stub.script_calendars(vec![Ok(calendar_page("cl-1"))]);
    stub.script_events(
        "cal-a",
        vec![
            Ok(page(vec![raw("one")], Some("page-2"), None)),
            Ok(page(vec![raw("two")], Some("page-3"), None)),
            Ok(page(vec![raw("three")], None, Some("final"))),
        ],
    );

    let outcome = block_on(pull::sync_all(&store, &stub, &Recorder::default()));

    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert!(has_event(&store, "cal-a", "one"));
    assert!(has_event(&store, "cal-a", "three"));
    assert_eq!(token_of(&store, "cal-a"), Some("final".to_string()));
    assert_eq!(
        stub.calls(),
        vec![
            "calendar_list acct sync=cl-0 page=-",
            "events_list cal-a sync=start page=-",
            "events_list cal-a sync=start page=page-2",
            "events_list cal-a sync=start page=page-3",
        ]
    );
}

#[test]
fn a_token_from_the_middle_of_a_chain_is_never_stored() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));

    let stub = Stub::default();
    stub.script_calendars(vec![Ok(calendar_page("cl-1"))]);
    stub.script_events(
        "cal-a",
        vec![
            // A token on a page that is not the last one is not the end of the chain, whatever it
            // says, and committing it would leave the cursor pointing at the middle of a page.
            Ok(page(vec![raw("one")], Some("page-2"), Some("middle"))),
            Err(ApiError::Other("Google events list failed (503)".to_string())),
        ],
    );

    let outcome = block_on(pull::sync_all(&store, &stub, &Recorder::default()));

    assert!(outcome.error.is_some());
    assert_eq!(token_of(&store, "cal-a"), Some("start".to_string()));
    assert!(!has_event(&store, "cal-a", "one"), "a partial chain is not a commit");
}

#[test]
fn a_dead_token_clears_that_calendar_alone() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("dead"));
    calendar(&store, "cal-b", "acct", Some("live"));
    stored_event(&store, "stale-a", "cal-a");
    stored_event(&store, "kept-b", "cal-b");

    let stub = Stub::default();
    stub.script_calendars(vec![Ok(calendar_page("cl-1"))]);
    stub.script_events(
        "cal-a",
        vec![
            Err(ApiError::SyncTokenExpired),
            Ok(page(vec![raw("fresh-a")], None, Some("a-2"))),
        ],
    );
    stub.script_events("cal-b", vec![Ok(page(Vec::new(), None, Some("b-2")))]);

    let outcome = block_on(pull::sync_all(&store, &stub, &Recorder::default()));

    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert!(!has_event(&store, "cal-a", "stale-a"), "the dead calendar is dropped");
    assert!(has_event(&store, "cal-a", "fresh-a"));
    assert_eq!(token_of(&store, "cal-a"), Some("a-2".to_string()));

    assert!(has_event(&store, "cal-b", "kept-b"), "the healthy calendar is untouched");
    assert_eq!(token_of(&store, "cal-b"), Some("b-2".to_string()));

    assert_eq!(
        stub.calls()
            .into_iter()
            .filter(|call| call.starts_with("events_list"))
            .collect::<Vec<_>>(),
        vec![
            "events_list cal-a sync=dead page=-",
            "events_list cal-a sync=- page=-",
            "events_list cal-b sync=live page=-",
        ]
    );
}

#[test]
fn a_cancelled_single_is_dropped_while_a_cancelled_occurrence_is_kept() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));
    stored_event(&store, "single", "cal-a");

    let mut cancelled = raw("single");
    cancelled.status = Some("cancelled".to_string());

    // Everything a cancelled occurrence is guaranteed to carry, and nothing else.
    let occurrence = RawEvent {
        id: "series_20260817T090000Z".to_string(),
        status: Some("cancelled".to_string()),
        recurring_event_id: Some("series".to_string()),
        original_start_time: Some(when("2026-08-17T09:00:00Z")),
        ..Default::default()
    };

    let stub = Stub::default();
    stub.script_calendars(vec![Ok(calendar_page("cl-1"))]);
    stub.script_events(
        "cal-a",
        vec![Ok(page(vec![cancelled, occurrence], None, Some("next")))],
    );

    block_on(pull::sync_all(&store, &stub, &Recorder::default()));

    assert!(!has_event(&store, "cal-a", "single"));
    assert!(has_event(&store, "cal-a", "series_20260817T090000Z"));
}

// -- the outbox --------------------------------------------------------------------------------

#[test]
fn the_outbox_drains_in_the_order_it_was_filled() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));
    stored_event(&store, "two", "cal-a");
    stored_event(&store, "three", "cal-a");

    enqueue(&store, "create", "one", Some(r#"{"id":"one"}"#), None);
    enqueue(&store, "patch", "two", Some(r#"{"summary":"moved"}"#), Some("etag-two"));
    enqueue(&store, "delete", "three", None, Some("etag-three"));

    let stub = Stub::default();
    stub.script_writes(vec![Ok(raw("one")), Ok(raw("two"))]);

    let outcome = drain(&store, &stub);

    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert!(outcome.changed);
    assert_eq!(
        stub.calls(),
        vec![
            "events_insert cal-a one",
            "events_patch cal-a two etag=etag-two",
            "events_delete cal-a three etag=etag-three",
        ]
    );
    assert!(queued(&store).is_empty(), "everything landed");
    assert!(has_event(&store, "cal-a", "one"), "the server's row replaces the local one");
    assert!(!has_event(&store, "cal-a", "three"), "a delete that landed is gone locally");
    let row = with_conn(&store, |conn| read::event(conn, "cal-a", "one"))
        .expect("read")
        .expect("row");
    assert!(!row.dirty, "a landed write is no longer pending");
}

#[test]
fn a_lost_race_keeps_the_entry_and_surfaces_rather_than_clobbering() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));
    stored_event(&store, "two", "cal-a");
    enqueue(&store, "patch", "two", Some(r#"{"summary":"mine"}"#), Some("etag-two"));

    let stub = Stub::default();
    stub.script_writes(vec![Err(ApiError::PreconditionFailed)]);

    let outcome = drain(&store, &stub);

    assert!(outcome.error.is_some(), "a 412 is surfaced");
    let entries = queued(&store);
    assert_eq!(entries.len(), 1, "the entry is kept");
    assert_eq!(entries[0].attempts, 1);
    assert_eq!(entries[0].etag.as_deref(), Some("etag-two"));
    assert!(entries[0]
        .last_error
        .as_deref()
        .expect("an error")
        .contains("changed elsewhere"));
    // One attempt, and never a second one with the etag quietly dropped.
    assert_eq!(stub.calls(), vec!["events_patch cal-a two etag=etag-two"]);
}

#[test]
fn offline_keeps_the_entry_queued_without_recording_a_failure() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));
    stored_event(&store, "two", "cal-a");
    enqueue(&store, "patch", "two", Some(r#"{"summary":"mine"}"#), Some("etag-two"));

    let stub = Stub::default();
    stub.script_writes(vec![Err(ApiError::Offline("no route to host".to_string()))]);

    let outcome = drain(&store, &stub);

    assert!(outcome.offline);
    assert!(outcome.error.is_none(), "being on a plane is not a failure");
    let entries = queued(&store);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].attempts, 0, "no attempt is spent on being offline");
    assert_eq!(entries[0].last_error, None);
}

#[test]
fn a_write_google_keeps_rejecting_eventually_stops_being_retried() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));
    stored_event(&store, "two", "cal-a");
    enqueue(&store, "patch", "two", Some(r#"{"summary":"mine"}"#), Some("etag-two"));

    let stub = Stub::default();
    stub.script_writes(
        (0..20)
            .map(|_| Err(ApiError::Other("Google event update failed (400)".to_string())))
            .collect(),
    );

    for _ in 0..10 {
        drain(&store, &stub);
    }

    assert_eq!(
        stub.calls().len() as i64,
        push::MAX_ATTEMPTS,
        "the queue stops rather than spinning"
    );
    let entries = queued(&store);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].attempts, push::MAX_ATTEMPTS);
}

#[test]
fn one_entry_is_attempted_at_most_once_per_drain() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));
    stored_event(&store, "two", "cal-a");
    stored_event(&store, "three", "cal-a");
    enqueue(&store, "patch", "two", Some(r#"{"summary":"mine"}"#), Some("etag-two"));
    enqueue(&store, "delete", "three", None, Some("etag-three"));

    let stub = Stub::default();
    stub.script_writes(vec![Err(ApiError::Other("Google event update failed (400)".to_string()))]);

    drain(&store, &stub);

    assert_eq!(
        stub.calls(),
        vec![
            "events_patch cal-a two etag=etag-two",
            "events_delete cal-a three etag=etag-three",
        ],
        "a failure does not block the entries behind it, and is not retried in the same pass"
    );
    assert_eq!(queued(&store).len(), 1);
}

#[test]
fn a_scoped_edit_resolves_the_occurrence_at_push_time() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));

    with_conn(&store, |conn| {
        write::enqueue(
            conn,
            &OutboxRow {
                op: "patch".to_string(),
                calendar_id: "cal-a".to_string(),
                event_id: Some("series".to_string()),
                original_start: Some("2026-08-17T09:00:00Z".to_string()),
                scope: Some("this".to_string()),
                payload: Some(r#"{"summary":"just this one"}"#.to_string()),
                ..Default::default()
            },
        )
    })
    .expect("enqueue");

    let stub = Stub::default();
    *stub.instances.lock().expect("instances") =
        vec![Ok(vec![raw("series_20260817T090000Z")])].into();
    stub.script_writes(vec![Ok(raw("series_20260817T090000Z"))]);

    let outcome = drain(&store, &stub);

    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(
        stub.calls(),
        vec![
            "events_instances cal-a series at=2026-08-17T09:00:00Z",
            // The instance id came from Google rather than being assembled from the original start.
            "events_patch cal-a series_20260817T090000Z etag=etag-series_20260817T090000Z",
        ]
    );
    assert!(queued(&store).is_empty());
}

// -- the local write ---------------------------------------------------------------------------

#[test]
fn a_local_create_renders_before_google_has_seen_it() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));

    let draft = crate::dto::EventDraft {
        color_id: None,
        calendar_id: "cal-a".to_string(),
        summary: "Lunch".to_string(),
        description: None,
        location: None,
        start: "2026-08-11T12:00:00Z".to_string(),
        end: "2026-08-11T13:00:00Z".to_string(),
        all_day: false,
        recurrence: Vec::new(),
    };
    let instance = with_conn(&store, |conn| push::create(conn, &draft)).expect("create");

    assert!(instance.pending);
    assert_eq!(instance.color_hex, "#4285f4");
    let row = with_conn(&store, |conn| read::event(conn, "cal-a", &instance.event_id))
        .expect("read")
        .expect("row");
    assert!(row.dirty);

    let entries = queued(&store);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].op, "create");
    let body: serde_json::Value =
        serde_json::from_str(entries[0].payload.as_deref().expect("a body")).expect("json");
    assert_eq!(body["id"], instance.event_id);
    assert_eq!(body["start"]["dateTime"], "2026-08-11T12:00:00Z");
}

/// The whole write path for a scoped edit: the rows the command gathers, the plan `recur` makes of
/// them, the queue entry, and the request that entry becomes.
#[test]
fn a_this_occurrence_edit_goes_from_plan_to_queue_to_request() {
    let store = db();
    account(&store, "acct");
    calendar(&store, "cal-a", "acct", Some("start"));
    with_conn(&store, |conn| {
        write::upsert_event(
            conn,
            &crate::store::write::EventRow {
                id: "series".to_string(),
                calendar_id: "cal-a".to_string(),
                account_id: "acct".to_string(),
                status: "confirmed".to_string(),
                summary: "Standup".to_string(),
                start_at: "2026-08-03T09:00:00+01:00".to_string(),
                start_tz: Some("Europe/London".to_string()),
                end_at: "2026-08-03T09:15:00+01:00".to_string(),
                end_tz: Some("Europe/London".to_string()),
                recurrence: vec!["RRULE:FREQ=WEEKLY;BYDAY=MO".to_string()],
                etag: Some("etag-series".to_string()),
                ..Default::default()
            },
        )
    })
    .expect("master");

    let key = crate::dto::InstanceKey {
        event_id: "series".to_string(),
        original_start: Some("2026-08-17T09:00:00+01:00".to_string()),
    };
    let patch = crate::dto::EventPatch {
        summary: Some("Standup, moved".to_string()),
        ..Default::default()
    };

    let rows = with_conn(&store, |conn| super::series_rows(conn, &key)).expect("rows");
    let plans = crate::recur::plan_edit(&rows, &key, &patch, crate::dto::Scope::This).expect("plan");
    with_conn(&store, |conn| push::apply_plans(conn, &rows, &plans)).expect("apply");

    let entries = queued(&store);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].op, "patch");
    assert_eq!(entries[0].scope.as_deref(), Some("this"));
    assert_eq!(
        entries[0].original_start.as_deref(),
        Some("2026-08-17T09:00:00+01:00"),
        "the occurrence is named by its original start, not by a hand-built instance id"
    );

    let stub = Stub::default();
    *stub.instances.lock().expect("instances") = vec![Ok(vec![raw("series_20260817T080000Z")])].into();
    stub.script_writes(vec![Ok(raw("series_20260817T080000Z"))]);
    let outcome = drain(&store, &stub);

    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(
        stub.calls(),
        vec![
            "events_instances cal-a series at=2026-08-17T09:00:00+01:00",
            "events_patch cal-a series_20260817T080000Z etag=etag-series_20260817T080000Z",
        ]
    );
    assert!(queued(&store).is_empty());
}

#[test]
fn an_all_day_draft_never_becomes_a_timestamp() {
    let draft = crate::dto::EventDraft {
        color_id: None,
        calendar_id: "cal-a".to_string(),
        summary: "Holiday".to_string(),
        description: None,
        location: None,
        start: "2026-08-11".to_string(),
        end: "2026-08-12".to_string(),
        all_day: true,
        recurrence: Vec::new(),
    };
    let body = super::model::draft_body(&draft, "abcde", Some("Europe/London"), Some("Europe/London"));
    assert_eq!(body["start"]["date"], "2026-08-11");
    assert!(body["start"].get("dateTime").is_none());
    assert!(
        body["start"].get("timeZone").is_none(),
        "an all-day date has no zone to be wrong about"
    );
}

#[test]
fn a_timed_write_carries_the_zone_as_well_as_the_offset() {
    let draft = crate::dto::EventDraft {
        color_id: None,
        calendar_id: "cal-a".to_string(),
        summary: "Standup".to_string(),
        description: None,
        location: None,
        start: "2026-08-11T09:00:00+01:00".to_string(),
        end: "2026-08-11T09:15:00+01:00".to_string(),
        all_day: false,
        recurrence: vec!["RRULE:FREQ=DAILY".to_string()],
    };
    // An offset pins the instant but not the zone, and a series filed under the calendar's zone
    // rather than its own drifts an hour at the next transition.
    let body = super::model::draft_body(&draft, "abcde", Some("Europe/London"), Some("Europe/London"));
    assert_eq!(body["start"]["dateTime"], "2026-08-11T09:00:00+01:00");
    assert_eq!(body["start"]["timeZone"], "Europe/London");
}
