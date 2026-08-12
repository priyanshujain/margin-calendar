// Typed wrapper over the Google Calendar REST API.
//
// Everything the sync engine and the write path need:
//   calendar_list(access, sync_token, page_token)          -> CalendarListPage
//   events_list(access, calendar_id, sync_token, page)     -> EventsPage  (one page; caller pages)
//   events_insert / events_patch / events_delete, all carrying If-Match where an etag is known
//   events_instances(access, calendar_id, event_id, original_start) -> Vec<RawEvent>
//
// The sync chain constraint: `singleEvents=false`, `showDeleted=true`, `maxResults=2500`, and the
// parameter set byte-identical on every call in a chain including the first. `timeMin`/`timeMax`
// are rejected alongside `syncToken`.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::google::auth::HTTP;

const BASE: &str = "https://www.googleapis.com/calendar/v3";

/// One page of events. Google caps this at 2500 and the value is part of the sync chain, so it is
/// a constant rather than an argument.
pub const MAX_RESULTS: &str = "2500";

/// A Google event exactly as returned, before flattening into the store.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEvent {
    pub id: String,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub start: Option<EventDateTime>,
    #[serde(default)]
    pub end: Option<EventDateTime>,
    #[serde(default)]
    pub recurrence: Option<Vec<String>>,
    #[serde(default)]
    pub recurring_event_id: Option<String>,
    #[serde(default)]
    pub original_start_time: Option<EventDateTime>,
    #[serde(default)]
    pub organizer: Option<serde_json::Value>,
    #[serde(default)]
    pub attendees: Option<serde_json::Value>,
    #[serde(default)]
    pub conference_data: Option<serde_json::Value>,
    #[serde(default)]
    pub updated: Option<String>,
    #[serde(default)]
    pub transparency: Option<String>,
    #[serde(default)]
    pub color_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDateTime {
    /// Date-only, for an all-day event. Never shift this into a zone.
    #[serde(default)]
    pub date: Option<String>,
    /// RFC3339 with an offset.
    #[serde(default)]
    pub date_time: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
}

/// One page of `events.list`. `next_sync_token` is present only on the final page.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsPage {
    #[serde(default)]
    pub items: Vec<RawEvent>,
    #[serde(default)]
    pub next_page_token: Option<String>,
    #[serde(default)]
    pub next_sync_token: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCalendar {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub background_color: Option<String>,
    #[serde(default)]
    pub access_role: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub primary: Option<bool>,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub deleted: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarListPage {
    #[serde(default)]
    pub items: Vec<RawCalendar>,
    #[serde(default)]
    pub next_page_token: Option<String>,
    #[serde(default)]
    pub next_sync_token: Option<String>,
}

/// One page of `events.instances`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstancesPage {
    #[serde(default)]
    items: Vec<RawEvent>,
}

/// A sync token that Google has expired. The caller drops that one calendar's rows and cursor and
/// full-resyncs it alone.
#[derive(Debug, Clone)]
pub enum ApiError {
    /// HTTP 410, the sync token is dead.
    SyncTokenExpired,
    /// HTTP 412, the etag did not match, so someone else won.
    PreconditionFailed,
    /// Network reachability, as opposed to a rejection from Google.
    Offline(String),
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::SyncTokenExpired => write!(f, "sync token expired"),
            ApiError::PreconditionFailed => write!(f, "the event changed elsewhere"),
            ApiError::Offline(e) => write!(f, "offline: {e}"),
            ApiError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> String {
        e.to_string()
    }
}

/// A failure to reach Google at all is Offline. Anything reqwest raises after a response has
/// arrived is a real error and keeps its text.
impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> ApiError {
        if e.is_connect() || e.is_timeout() || e.is_request() || e.is_body() {
            ApiError::Offline(e.to_string())
        } else {
            ApiError::Other(e.to_string())
        }
    }
}

/// Google's error body is a wall of JSON carrying the same sentence three times over. The one
/// useful line is `error.message`, so pull it out and keep the rest out of the user's face. A body
/// that will not parse is truncated rather than pasted whole.
fn explain(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return message.to_string();
        }
    }
    let trimmed = body.trim();
    match trimmed.char_indices().nth(200) {
        Some((end, _)) => format!("{}…", &trimmed[..end]),
        None => trimmed.to_string(),
    }
}

fn error_for(status: u16, context: &str, body: &str) -> ApiError {
    match status {
        410 => ApiError::SyncTokenExpired,
        412 => ApiError::PreconditionFailed,
        _ => ApiError::Other(format!("{context} failed ({status}): {}", explain(body))),
    }
}

/// The same body-to-String-first shape as `auth::read_json`, so Google's error payload survives
/// into the message, but keeping the status so the sync engine can tell a 410 from a 412.
async fn read<T: DeserializeOwned>(resp: reqwest::Response, context: &str) -> Result<T, ApiError> {
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if !(200..300).contains(&status) {
        return Err(error_for(status, context, &text));
    }
    serde_json::from_str(&text)
        .map_err(|e| ApiError::Other(format!("{context}: could not parse response: {e}")))
}

/// Calendar ids are email shaped and can carry a '#', so they are percent-encoded into the path.
/// Not `form_urlencoded`, which would turn a space into a '+'.
fn path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The one definition of the sync chain's parameter set. Every call in a chain, including the
/// first, sends exactly this, which is what makes the chain valid.
fn events_params() -> Vec<(&'static str, &'static str)> {
    vec![
        ("singleEvents", "false"),
        ("showDeleted", "true"),
        ("maxResults", MAX_RESULTS),
    ]
}

fn calendar_params() -> Vec<(&'static str, &'static str)> {
    vec![
        ("showDeleted", "true"),
        ("showHidden", "true"),
        ("maxResults", "250"),
    ]
}

pub async fn calendar_list(
    access_token: &str,
    sync_token: Option<&str>,
    page_token: Option<&str>,
) -> Result<CalendarListPage, ApiError> {
    let mut query = calendar_params();
    if let Some(token) = sync_token {
        query.push(("syncToken", token));
    }
    if let Some(token) = page_token {
        query.push(("pageToken", token));
    }
    let resp = HTTP
        .get(format!("{BASE}/users/me/calendarList"))
        .bearer_auth(access_token)
        .query(&query)
        .send()
        .await?;
    read(resp, "Google calendar list").await
}

/// One page. The caller walks `next_page_token` to exhaustion, because `next_sync_token` only
/// appears on the final page and nothing may be committed before it does. Both tokens are passed
/// through when both are given, which is what the official clients do with `list_next`.
pub async fn events_list(
    access_token: &str,
    calendar_id: &str,
    sync_token: Option<&str>,
    page_token: Option<&str>,
) -> Result<EventsPage, ApiError> {
    let mut query = events_params();
    if let Some(token) = sync_token {
        query.push(("syncToken", token));
    }
    if let Some(token) = page_token {
        query.push(("pageToken", token));
    }
    let resp = HTTP
        .get(format!(
            "{BASE}/calendars/{}/events",
            path_segment(calendar_id)
        ))
        .bearer_auth(access_token)
        .query(&query)
        .send()
        .await?;
    read(resp, "Google events list").await
}

pub async fn events_insert(
    access_token: &str,
    calendar_id: &str,
    body: &serde_json::Value,
) -> Result<RawEvent, ApiError> {
    let resp = HTTP
        .post(format!(
            "{BASE}/calendars/{}/events",
            path_segment(calendar_id)
        ))
        .bearer_auth(access_token)
        .json(body)
        .send()
        .await?;
    read(resp, "Google event create").await
}

/// `etag` becomes an If-Match, so a 412 tells the caller someone else changed the event first
/// rather than the write silently clobbering them.
pub async fn events_patch(
    access_token: &str,
    calendar_id: &str,
    event_id: &str,
    body: &serde_json::Value,
    etag: Option<&str>,
) -> Result<RawEvent, ApiError> {
    let mut request = HTTP
        .patch(format!(
            "{BASE}/calendars/{}/events/{}",
            path_segment(calendar_id),
            path_segment(event_id)
        ))
        .bearer_auth(access_token)
        .json(body);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_MATCH, etag);
    }
    let resp = request.send().await?;
    read(resp, "Google event update").await
}

/// Idempotent by design: Google answers 410 for an event that is already gone, and a delete of
/// something already deleted is the outcome the caller wanted. That is the one place where a 410
/// is not a dead sync token.
pub async fn events_delete(
    access_token: &str,
    calendar_id: &str,
    event_id: &str,
    etag: Option<&str>,
) -> Result<(), ApiError> {
    let mut request = HTTP
        .delete(format!(
            "{BASE}/calendars/{}/events/{}",
            path_segment(calendar_id),
            path_segment(event_id)
        ))
        .bearer_auth(access_token);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_MATCH, etag);
    }
    let resp = request.send().await?;
    let status = resp.status().as_u16();
    if (200..300).contains(&status) || status == 404 || status == 410 {
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    Err(error_for(status, "Google event delete", &text))
}

/// Resolves the concrete instance of a series at `original_start`, which is how a "this occurrence"
/// edit finds its event rather than constructing the instance id by hand. The filter narrows the
/// result to that one occurrence, so there is nothing to paginate.
pub async fn events_instances(
    access_token: &str,
    calendar_id: &str,
    event_id: &str,
    original_start: &str,
) -> Result<Vec<RawEvent>, ApiError> {
    let resp = HTTP
        .get(format!(
            "{BASE}/calendars/{}/events/{}/instances",
            path_segment(calendar_id),
            path_segment(event_id)
        ))
        .bearer_auth(access_token)
        .query(&[
            ("originalStart", original_start),
            ("showDeleted", "true"),
            ("maxResults", "250"),
        ])
        .send()
        .await?;
    let page: InstancesPage = read(resp, "Google event instances").await?;
    Ok(page.items)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real 403 body that reached the UI as a wall of JSON: the same sentence repeated in
    /// `errors`, `details` and a localised copy. Only the first sentence is worth showing.
    #[test]
    fn a_google_error_body_is_reduced_to_its_message() {
        let body = r#"{"error":{"code":403,
            "message":"Google Calendar API has not been used in project 205537985128 before or it is disabled.",
            "errors":[{"message":"Google Calendar API has not been used in project 205537985128 before or it is disabled.","domain":"usageLimits","reason":"accessNotConfigured"}],
            "status":"PERMISSION_DENIED",
            "details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"SERVICE_DISABLED"}]}}"#;
        let ApiError::Other(message) = error_for(403, "Google calendar list", body) else {
            panic!("a 403 is an Other");
        };
        assert_eq!(
            message,
            "Google calendar list failed (403): Google Calendar API has not been used in project 205537985128 before or it is disabled."
        );
        assert!(!message.contains("PERMISSION_DENIED"));
    }

    #[test]
    fn an_unparseable_body_is_truncated_rather_than_pasted_whole() {
        let body = "x".repeat(5000);
        let ApiError::Other(message) = error_for(500, "Google events list", &body) else {
            panic!("a 500 is an Other");
        };
        assert!(message.chars().count() < 260, "was {}", message.chars().count());
        assert!(message.ends_with('…'));
    }

    #[test]
    fn a_410_is_a_dead_sync_token() {
        assert!(matches!(
            error_for(410, "Google events list", "{}"),
            ApiError::SyncTokenExpired
        ));
    }

    #[test]
    fn a_412_is_a_lost_race() {
        assert!(matches!(
            error_for(412, "Google event update", "{}"),
            ApiError::PreconditionFailed
        ));
    }

    #[test]
    fn anything_else_carries_googles_own_body() {
        let error = error_for(403, "Google events list", "rateLimitExceeded");
        match error {
            ApiError::Other(message) => {
                assert!(message.contains("403"), "{message}");
                assert!(message.contains("rateLimitExceeded"), "{message}");
            }
            other => panic!("expected Other, got {other:?}"),
        }
    }

    #[test]
    fn the_sync_chain_parameters_are_fixed_and_carry_no_window() {
        let params = events_params();
        assert_eq!(
            params,
            vec![
                ("singleEvents", "false"),
                ("showDeleted", "true"),
                ("maxResults", "2500"),
            ]
        );
        assert!(params.iter().all(|(key, _)| *key != "timeMin" && *key != "timeMax"));
    }

    #[test]
    fn calendar_ids_are_percent_encoded_into_the_path() {
        assert_eq!(
            path_segment("a.person@example.com"),
            "a.person%40example.com"
        );
        assert_eq!(
            path_segment("en.uk#holiday@group.v.calendar.google.com"),
            "en.uk%23holiday%40group.v.calendar.google.com"
        );
        assert_eq!(path_segment("primary"), "primary");
    }
}
