// The IPC contract. Every type here has a matching declaration in src/ipc.ts. Both sides are
// frozen once written: implementation modules add bodies, not fields.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: String,
    pub account_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub color_hex: String,
    pub selected: bool,
    pub access_role: String,
    pub time_zone: String,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub email: String,
    pub display_name: Option<String>,
    /// needsAction | declined | tentative | accepted
    pub response_status: String,
    pub organizer: bool,
    #[serde(rename = "self")]
    pub is_self: bool,
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conference {
    /// hangoutsMeet, addOn, and so on
    pub kind: String,
    pub uri: Option<String>,
    pub label: Option<String>,
}

/// Identifies one occurrence of a series, stable across syncs. `original_start` is None for a
/// single event and the unmoved start of the occurrence for anything recurring.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceKey {
    pub event_id: String,
    pub original_start: Option<String>,
}

/// One event occurrence, already expanded and already converted to the local zone. `start` and
/// `end` are RFC3339 with an offset, except when `all_day`, where they are date-only `YYYY-MM-DD`
/// and must never be shifted into a zone. `start_ms` and `end_ms` are epoch milliseconds, with
/// all-day events pinned to local midnight, and `end_ms` is exclusive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub event_id: String,
    pub calendar_id: String,
    pub account_id: String,
    pub original_start: Option<String>,
    pub start: String,
    pub end: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    /// confirmed | tentative | cancelled
    pub status: String,
    pub recurring: bool,
    /// Resolved for rendering: the event's own colour when it has one, else its calendar's.
    pub color_hex: String,
    /// Google's per-event colour id, 1 to 11. None means the event follows its calendar.
    pub color_id: Option<String>,
    pub etag: Option<String>,
    pub organizer: Option<String>,
    pub attendees: Vec<Attendee>,
    pub conference: Option<Conference>,
    pub read_only: bool,
    /// Written locally and still sitting in the outbox.
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub calendar_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    /// Raw RFC5545 lines (RRULE/RDATE/EXDATE), empty for a one-off.
    #[serde(default)]
    pub recurrence: Vec<String>,
    /// Google's per-event colour id, 1 to 11. Absent means follow the calendar.
    #[serde(default)]
    pub color_id: Option<String>,
}

/// An absent field means unchanged. An empty string on `description` or `location` clears it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPatch {
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub all_day: Option<bool>,
    #[serde(default)]
    pub calendar_id: Option<String>,
    #[serde(default)]
    pub recurrence: Option<Vec<String>>,
    /// An empty string clears it back to the calendar's colour.
    #[serde(default)]
    pub color_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    This,
    Following,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// idle | syncing | error
    pub phase: String,
    /// Epoch milliseconds of the last successful sync.
    pub last_sync: Option<i64>,
    pub error: Option<String>,
    pub pending_writes: u32,
    pub message: Option<String>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        SyncStatus {
            phase: "idle".to_string(),
            last_sync: None,
            error: None,
            pending_writes: 0,
            message: None,
        }
    }
}

/// Payload of the `auth` event, the same shape as margin's `gdrive-auth`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthEvent {
    pub ok: bool,
    pub error: Option<String>,
    pub account_id: Option<String>,
    pub email: Option<String>,
    /// The user closed the consent browser rather than anything going wrong. Still `ok: false`,
    /// because no account arrived, but changing your mind is not a failure and must not be
    /// reported as one.
    pub cancelled: bool,
}
