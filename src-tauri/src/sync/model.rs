// Conversions between Google's shape, the store's rows and the IPC DTOs. Nothing here reaches the
// network or the database, so every one of these is a pure function the tests can lean on.

use chrono::{Local, NaiveDate, TimeZone};
use serde_json::{json, Map, Value};

use crate::dto::{EventDraft, EventPatch, Instance};
use crate::google::api::{EventDateTime, RawCalendar, RawEvent};
use crate::store::write::{self, CalendarRow, EventRow};

/// A timestamp as stored: the RFC3339 form when there is one, the bare date when the event is
/// all-day. Never converted, because an all-day date shifted into a zone is the bug this whole
/// codebase is arranged to avoid.
fn stamp(value: &EventDateTime) -> Option<String> {
    value.date_time.clone().or_else(|| value.date.clone())
}

fn split(value: Option<&EventDateTime>) -> (String, Option<String>) {
    match value {
        Some(value) => (stamp(value).unwrap_or_default(), value.time_zone.clone()),
        None => (String::new(), None),
    }
}

pub fn is_cancelled(raw: &RawEvent) -> bool {
    raw.status.as_deref() == Some("cancelled")
}

pub fn event_row(raw: &RawEvent, calendar_id: &str, account_id: &str) -> EventRow {
    let all_day = raw
        .start
        .as_ref()
        .map(|start| start.date.is_some())
        .unwrap_or(false);
    let (start_at, start_tz) = split(raw.start.as_ref());
    let (end_at, end_tz) = split(raw.end.as_ref());
    EventRow {
        id: raw.id.clone(),
        calendar_id: calendar_id.to_string(),
        account_id: account_id.to_string(),
        etag: raw.etag.clone(),
        status: raw
            .status
            .clone()
            .unwrap_or_else(|| "confirmed".to_string()),
        summary: raw.summary.clone().unwrap_or_default(),
        description: raw.description.clone(),
        location: raw.location.clone(),
        start_at,
        start_tz,
        end_at,
        end_tz,
        all_day,
        recurrence: raw.recurrence.clone().unwrap_or_default(),
        recurring_event_id: raw.recurring_event_id.clone(),
        original_start: raw.original_start_time.as_ref().and_then(stamp),
        attendees: raw.attendees.as_ref().map(|v| v.to_string()),
        conference: raw.conference_data.as_ref().map(|v| v.to_string()),
        updated_at: raw.updated.clone(),
        color_id: raw.color_id.clone(),
        dirty: false,
    }
}

pub fn calendar_row(raw: &RawCalendar, account_id: &str) -> CalendarRow {
    CalendarRow {
        id: raw.id.clone(),
        account_id: account_id.to_string(),
        summary: raw.summary.clone().unwrap_or_else(|| raw.id.clone()),
        description: raw.description.clone(),
        color_hex: raw.background_color.clone().unwrap_or_default(),
        access_role: raw
            .access_role
            .clone()
            .unwrap_or_else(|| "reader".to_string()),
        time_zone: raw.time_zone.clone().unwrap_or_default(),
        primary: raw.primary.unwrap_or(false),
        deleted: raw.deleted.unwrap_or(false),
        // Google's own tick, so a calendar the user has hidden there starts hidden here rather
        // than dumping twenty calendars onto the grid on first sync. Insert only: once the row
        // exists, the local selection is the user's and a refresh must not overwrite it.
        selected: raw.selected.unwrap_or(true),
    }
}

pub fn writable(access_role: &str) -> bool {
    matches!(access_role, "owner" | "writer")
}

/// `{"date": ...}` for an all-day event, `{"dateTime": ...}` otherwise. A date-only string is
/// treated as all-day whatever the flag says, since sending one under `dateTime` is a 400.
///
/// The zone rides along on a timed event because the offset alone only pins the instant. A series
/// filed under the wrong zone drifts an hour away from itself at the next DST transition, and an
/// all-day date has no zone to be wrong about.
fn when(value: &str, all_day: bool, zone: Option<&str>) -> Value {
    if all_day || value.len() == 10 {
        return json!({ "date": value });
    }
    match zone.filter(|zone| !zone.is_empty()) {
        Some(zone) => json!({ "dateTime": value, "timeZone": zone }),
        None => json!({ "dateTime": value }),
    }
}

pub fn draft_body(
    draft: &EventDraft,
    id: &str,
    start_tz: Option<&str>,
    end_tz: Option<&str>,
) -> Value {
    let mut body = Map::new();
    body.insert("id".to_string(), json!(id));
    body.insert("summary".to_string(), json!(draft.summary));
    if let Some(value) = &draft.description {
        body.insert("description".to_string(), json!(value));
    }
    if let Some(value) = &draft.location {
        body.insert("location".to_string(), json!(value));
    }
    body.insert(
        "start".to_string(),
        when(&draft.start, draft.all_day, start_tz),
    );
    body.insert("end".to_string(), when(&draft.end, draft.all_day, end_tz));
    if !draft.recurrence.is_empty() {
        body.insert("recurrence".to_string(), json!(draft.recurrence));
    }
    if let Some(color) = draft.color_id.as_deref().filter(|c| !c.is_empty()) {
        body.insert("colorId".to_string(), json!(color));
    }
    Value::Object(body)
}

/// An absent field stays absent, which is what makes this a patch. `all_day` and the zones come
/// from the row rather than the patch, because a patch that moves an event without restating its
/// all-day flag still has to send the right half of the union, and one that moves a series without
/// restating its zone must not let Google refile it under the calendar's.
pub fn patch_body(patch: &EventPatch, all_day: bool, start_tz: Option<&str>, end_tz: Option<&str>) -> Value {
    let mut body = Map::new();
    if let Some(value) = &patch.summary {
        body.insert("summary".to_string(), json!(value));
    }
    if let Some(value) = &patch.description {
        body.insert("description".to_string(), json!(value));
    }
    if let Some(value) = &patch.location {
        body.insert("location".to_string(), json!(value));
    }
    let all_day = patch.all_day.unwrap_or(all_day);
    if let Some(value) = &patch.start {
        body.insert("start".to_string(), when(value, all_day, start_tz));
    }
    if let Some(value) = &patch.end {
        body.insert("end".to_string(), when(value, all_day, end_tz));
    }
    if let Some(value) = &patch.recurrence {
        body.insert("recurrence".to_string(), json!(value));
    }
    // An empty string means "back to the calendar's colour", which Google spells as a null colorId.
    if let Some(value) = &patch.color_id {
        body.insert(
            "colorId".to_string(),
            if value.is_empty() { Value::Null } else { json!(value) },
        );
    }
    Value::Object(body)
}

pub fn recurrence_body(recurrence: &[String]) -> Value {
    json!({ "recurrence": recurrence })
}

pub fn draft_row(draft: &EventDraft, id: &str, account_id: &str) -> EventRow {
    EventRow {
        id: id.to_string(),
        calendar_id: draft.calendar_id.clone(),
        account_id: account_id.to_string(),
        status: "confirmed".to_string(),
        summary: draft.summary.clone(),
        description: draft.description.clone(),
        location: draft.location.clone(),
        start_at: draft.start.clone(),
        end_at: draft.end.clone(),
        all_day: draft.all_day,
        recurrence: draft.recurrence.clone(),
        color_id: draft.color_id.clone().filter(|c| !c.is_empty()),
        dirty: true,
        ..Default::default()
    }
}

pub fn apply_patch(row: &mut EventRow, patch: &EventPatch) {
    if let Some(value) = &patch.summary {
        row.summary = value.clone();
    }
    if let Some(value) = &patch.description {
        row.description = (!value.is_empty()).then(|| value.clone());
    }
    if let Some(value) = &patch.location {
        row.location = (!value.is_empty()).then(|| value.clone());
    }
    if let Some(value) = &patch.color_id {
        row.color_id = (!value.is_empty()).then(|| value.clone());
    }
    if let Some(value) = patch.all_day {
        row.all_day = value;
    }
    if let Some(value) = &patch.start {
        row.start_at = value.clone();
    }
    if let Some(value) = &patch.end {
        row.end_at = value.clone();
    }
    if let Some(value) = &patch.recurrence {
        row.recurrence = value.clone();
    }
}

/// Epoch milliseconds for the optimistic echo only. `recur` owns the real arithmetic; this exists
/// because an all-day event has to sit at local midnight rather than the UTC midnight the store's
/// window columns use, and the echo renders before the next read replaces it.
fn local_ms(value: &str, all_day: bool) -> i64 {
    if all_day || value.len() == 10 {
        return NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
            .and_then(|naive| Local.from_local_datetime(&naive).earliest())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
    }
    write::epoch_ms(value, false).unwrap_or(0)
}

/// The row a local write just made, as the frontend will render it until the next read. Attendees
/// and conferencing are Google's to fill in, so they are empty rather than guessed at.
pub fn pending_instance(row: &EventRow, color_hex: &str, read_only: bool) -> Instance {
    let color_hex = crate::recur::event_color(row.color_id.as_deref()).unwrap_or(color_hex);
    Instance {
        event_id: row.id.clone(),
        calendar_id: row.calendar_id.clone(),
        account_id: row.account_id.clone(),
        original_start: row.original_start.clone(),
        start: row.start_at.clone(),
        end: row.end_at.clone(),
        start_ms: local_ms(&row.start_at, row.all_day),
        end_ms: local_ms(&row.end_at, row.all_day),
        all_day: row.all_day,
        summary: row.summary.clone(),
        description: row.description.clone(),
        location: row.location.clone(),
        status: row.status.clone(),
        recurring: !row.recurrence.is_empty(),
        color_hex: color_hex.to_string(),
        color_id: row.color_id.clone(),
        etag: row.etag.clone(),
        organizer: None,
        attendees: Vec::new(),
        conference: None,
        read_only,
        pending: true,
    }
}

/// Google accepts a client-chosen event id in base32hex, which is what makes an optimistic create
/// idempotent: the row keeps the id it rendered with, and a retry of a request whose response was
/// lost collides with itself rather than creating a second event.
pub fn new_event_id() -> String {
    use rand::RngCore;
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuv";
    let mut bytes = [0u8; 26];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| ALPHABET[(byte & 0x1f) as usize] as char)
        .collect()
}
