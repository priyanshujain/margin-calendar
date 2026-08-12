// The write half: local writes land in SQLite dirty and queued, and the push to Google happens
// behind them.
//
// The queue is drained oldest first. Offline is not a failure, so the entry keeps its attempt count
// and waits for the network. A 412 is a lost race, so the entry is kept and surfaced but never
// retried with the etag dropped, because dropping it is exactly the clobber the check exists to
// prevent. Anything else counts an attempt, and past MAX_ATTEMPTS the entry stops being retried so
// one poisoned write cannot spin the queue forever.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use rusqlite::Connection;
use serde_json::Value;

use crate::dto::{EventDraft, Instance, Scope};
use crate::google::api::ApiError;
use crate::recur::EditPlan;
use crate::store::read;
use crate::store::write::{self, EventRow, OutboxRow, Tx};
use crate::store::Store;

use super::model;
use super::transport::Transport;
use super::{with_conn, Outcome};

/// Enough attempts to ride out a transient rejection, few enough that a write Google will never
/// accept stops being sent.
pub const MAX_ATTEMPTS: i64 = 5;
const BATCH: u32 = 20;

// -- local writes ------------------------------------------------------------------------------

pub fn create(conn: &Connection, draft: &EventDraft) -> Result<Instance, String> {
    let calendar = read::calendars(conn)?
        .into_iter()
        .find(|calendar| calendar.id == draft.calendar_id)
        .ok_or_else(|| format!("no such calendar: {}", draft.calendar_id))?;

    let zone = (!calendar.time_zone.is_empty()).then(|| calendar.time_zone.clone());
    let id = model::new_event_id();
    let mut row = model::draft_row(draft, &id, &calendar.account_id);
    row.start_tz = zone.clone();
    row.end_tz = zone.clone();

    let tx = Tx::begin(conn)?;
    write::upsert_event_dirty(conn, &row)?;
    queue(
        conn,
        "create",
        &draft.calendar_id,
        Some(&id),
        None,
        None,
        Some(model::draft_body(draft, &id, zone.as_deref(), zone.as_deref())),
        None,
    )?;
    tx.commit()?;

    Ok(model::pending_instance(
        &row,
        &calendar.color_hex,
        !model::writable(&calendar.access_role),
    ))
}

/// Performs the plans `recur` handed back: the optimistic local write, then the queued request.
pub fn apply_plans(conn: &Connection, rows: &[EventRow], plans: &[EditPlan]) -> Result<(), String> {
    let tx = Tx::begin(conn)?;
    for plan in plans {
        match plan {
            EditPlan::PatchInstance {
                calendar_id,
                event_id,
                original_start,
                patch,
            } => {
                // Only an occurrence that is already an exception has a row to write to. The rest
                // exist solely as a rule until Google materialises them, which it does at push
                // time, so the local half of the write waits for the next sync.
                let existing = exception(rows, calendar_id, event_id, original_start.as_deref());
                if let Some(row) = existing {
                    let mut updated = row.clone();
                    model::apply_patch(&mut updated, patch);
                    write::upsert_event_dirty(conn, &updated)?;
                }
                let master = read::event(conn, calendar_id, event_id)?;
                let shape = existing.or(master.as_ref());
                queue(
                    conn,
                    "patch",
                    calendar_id,
                    Some(event_id),
                    original_start.as_deref(),
                    Some(Scope::This),
                    Some(body_for(patch, shape)),
                    existing.and_then(|row| row.etag.as_deref()),
                )?;
            }
            EditPlan::PatchMaster {
                calendar_id,
                event_id,
                patch,
            } => {
                let existing = read::event(conn, calendar_id, event_id)?;
                if let Some(row) = &existing {
                    let mut updated = row.clone();
                    model::apply_patch(&mut updated, patch);
                    write::upsert_event_dirty(conn, &updated)?;
                }
                queue(
                    conn,
                    "patch",
                    calendar_id,
                    Some(event_id),
                    None,
                    Some(Scope::All),
                    Some(body_for(patch, existing.as_ref())),
                    existing.as_ref().and_then(|row| row.etag.as_deref()),
                )?;
            }
            EditPlan::Split {
                calendar_id,
                event_id,
                until,
                draft,
            } => {
                let master = truncate(conn, calendar_id, event_id, until, Scope::Following)?;
                let calendar = calendar_of(conn, &draft.calendar_id);
                let zone = calendar
                    .as_ref()
                    .map(|calendar| calendar.time_zone.clone())
                    .filter(|zone| !zone.is_empty());

                let id = model::new_event_id();
                let account_id = master
                    .as_ref()
                    .map(|row| row.account_id.clone())
                    .or_else(|| calendar.map(|calendar| calendar.account_id))
                    .unwrap_or_default();
                let mut row = model::draft_row(draft, &id, &account_id);
                // The tail inherits the head's zones. `EventDraft` carries an offset and no zone,
                // and an offset alone lets Google file the new series under the calendar's zone,
                // which puts the two halves an hour apart at the next DST transition.
                row.start_tz = master
                    .as_ref()
                    .and_then(|master| master.start_tz.clone())
                    .or_else(|| zone.clone());
                row.end_tz = master
                    .as_ref()
                    .and_then(|master| master.end_tz.clone())
                    .or(zone);
                write::upsert_event_dirty(conn, &row)?;
                queue(
                    conn,
                    "create",
                    &draft.calendar_id,
                    Some(&id),
                    None,
                    Some(Scope::Following),
                    Some(model::draft_body(
                        draft,
                        &id,
                        row.start_tz.as_deref(),
                        row.end_tz.as_deref(),
                    )),
                    None,
                )?;
            }
            EditPlan::CancelInstance {
                calendar_id,
                event_id,
                original_start,
            } => {
                let existing = exception(rows, calendar_id, event_id, original_start.as_deref());
                if let Some(row) = existing {
                    let mut updated = row.clone();
                    updated.status = "cancelled".to_string();
                    write::upsert_event_dirty(conn, &updated)?;
                }
                queue(
                    conn,
                    "delete",
                    calendar_id,
                    Some(event_id),
                    original_start.as_deref(),
                    Some(Scope::This),
                    None,
                    existing.and_then(|row| row.etag.as_deref()),
                )?;
            }
            EditPlan::TruncateMaster {
                calendar_id,
                event_id,
                until,
            } => {
                truncate(conn, calendar_id, event_id, until, Scope::Following)?;
            }
            EditPlan::DeleteMaster {
                calendar_id,
                event_id,
            } => {
                let existing = read::event(conn, calendar_id, event_id)?;
                write::delete_event(conn, calendar_id, event_id)?;
                queue(
                    conn,
                    "delete",
                    calendar_id,
                    Some(event_id),
                    None,
                    Some(Scope::All),
                    None,
                    existing.as_ref().and_then(|row| row.etag.as_deref()),
                )?;
            }
        }
    }
    tx.commit()
}

/// Rewrites the master's rule to stop at `until` and queues that patch. Returns the row it found,
/// which is where a split gets the account for the new master.
fn truncate(
    conn: &Connection,
    calendar_id: &str,
    event_id: &str,
    until: &str,
    scope: Scope,
) -> Result<Option<EventRow>, String> {
    let existing = read::event(conn, calendar_id, event_id)?;
    let recurrence = existing
        .as_ref()
        .map(|row| crate::recur::truncate_recurrence(&row.recurrence, until))
        .unwrap_or_default();
    if let Some(row) = &existing {
        let mut updated = row.clone();
        updated.recurrence = recurrence.clone();
        write::upsert_event_dirty(conn, &updated)?;
    }
    queue(
        conn,
        "patch",
        calendar_id,
        Some(event_id),
        None,
        Some(scope),
        Some(model::recurrence_body(&recurrence)),
        existing.as_ref().and_then(|row| row.etag.as_deref()),
    )?;
    Ok(existing)
}

fn exception<'a>(
    rows: &'a [EventRow],
    calendar_id: &str,
    event_id: &str,
    original_start: Option<&str>,
) -> Option<&'a EventRow> {
    rows.iter().find(|row| {
        row.calendar_id == calendar_id
            && row.recurring_event_id.as_deref() == Some(event_id)
            && row.original_start.as_deref() == original_start
    })
}

fn calendar_of(conn: &Connection, calendar_id: &str) -> Option<crate::dto::Calendar> {
    read::calendars(conn)
        .ok()?
        .into_iter()
        .find(|calendar| calendar.id == calendar_id)
}

/// A patch keeps the shape of the row it is patching: its all-day flag and its zones, neither of
/// which the patch itself is obliged to restate.
fn body_for(patch: &crate::dto::EventPatch, row: Option<&EventRow>) -> Value {
    model::patch_body(
        patch,
        row.map(|row| row.all_day).unwrap_or(false),
        row.and_then(|row| row.start_tz.as_deref()),
        row.and_then(|row| row.end_tz.as_deref()),
    )
}

fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::This => "this",
        Scope::Following => "following",
        Scope::All => "all",
    }
}

#[allow(clippy::too_many_arguments)]
fn queue(
    conn: &Connection,
    op: &str,
    calendar_id: &str,
    event_id: Option<&str>,
    original_start: Option<&str>,
    scope: Option<Scope>,
    payload: Option<Value>,
    etag: Option<&str>,
) -> Result<(), String> {
    write::enqueue(
        conn,
        &OutboxRow {
            op: op.to_string(),
            calendar_id: calendar_id.to_string(),
            event_id: event_id.map(str::to_string),
            original_start: original_start.map(str::to_string),
            scope: scope.map(|scope| scope_name(scope).to_string()),
            payload: payload.map(|value| value.to_string()),
            etag: etag.map(str::to_string),
            ..Default::default()
        },
    )?;
    Ok(())
}

// -- the drain ---------------------------------------------------------------------------------

pub async fn drain(store: &Store, transport: &impl Transport, deadline: Instant) -> Outcome {
    let mut outcome = Outcome::default();
    let accounts = match with_conn(store, calendar_accounts) {
        Ok(accounts) => accounts,
        Err(error) => {
            outcome.error = Some(error);
            return outcome;
        }
    };

    // One attempt per entry per drain. Without this a queue that is making progress would burn a
    // failing entry's whole attempt budget in a single pass.
    let mut attempted: HashSet<i64> = HashSet::new();

    while Instant::now() < deadline {
        let queued = match with_conn(store, |conn| write::peek_outbox(conn, BATCH)) {
            Ok(queued) => queued,
            Err(error) => {
                outcome.error = Some(error);
                return outcome;
            }
        };
        let pending: Vec<OutboxRow> = queued
            .into_iter()
            .filter(|row| row.attempts < MAX_ATTEMPTS && !attempted.contains(&row.id))
            .collect();
        if pending.is_empty() {
            break;
        }

        for row in pending {
            if Instant::now() >= deadline {
                return outcome;
            }
            attempted.insert(row.id);

            let Some(account_id) = accounts.get(&row.calendar_id) else {
                // The calendar is gone, so the write has nowhere to land and nothing to retry
                // against.
                let _ = with_conn(store, |conn| write::dequeue(conn, row.id));
                continue;
            };

            match push_one(store, transport, account_id, &row).await {
                Ok(()) => {
                    let _ = with_conn(store, |conn| write::dequeue(conn, row.id));
                    outcome.changed = true;
                }
                Err(ApiError::Offline(_)) => {
                    // Not a failure, so no attempt is counted and nothing is surfaced. The queue is
                    // the reason this app works on a plane.
                    outcome.offline = true;
                    return outcome;
                }
                Err(error) => {
                    let message = error.to_string();
                    let _ =
                        with_conn(store, |conn| write::mark_attempt_failed(conn, row.id, &message));
                    outcome.error.get_or_insert(message);
                }
            }
        }
    }

    outcome
}

async fn push_one(
    store: &Store,
    transport: &impl Transport,
    account_id: &str,
    row: &OutboxRow,
) -> Result<(), ApiError> {
    match row.op.as_str() {
        "create" => {
            let body = payload(row)?;
            match transport
                .events_insert(account_id, &row.calendar_id, &body)
                .await
            {
                Ok(raw) => land(store, &row.calendar_id, account_id, &raw),
                // The id was chosen locally, so a retry of a create whose response never arrived
                // collides with itself. The event is there, which is what was wanted.
                Err(ApiError::Other(message)) if message.contains("(409)") => clear(store, row),
                Err(error) => Err(error),
            }
        }
        "patch" => {
            let body = payload(row)?;
            let (event_id, etag) = resolve(transport, account_id, row).await?;
            let raw = transport
                .events_patch(
                    account_id,
                    &row.calendar_id,
                    &event_id,
                    &body,
                    etag.as_deref(),
                )
                .await?;
            land(store, &row.calendar_id, account_id, &raw)?;
            clear(store, row)
        }
        "delete" => {
            let (event_id, etag) = resolve(transport, account_id, row).await?;
            transport
                .events_delete(account_id, &row.calendar_id, &event_id, etag.as_deref())
                .await?;
            with_conn(store, |conn| {
                write::delete_event(conn, &row.calendar_id, &event_id)
            })
            .map_err(ApiError::Other)?;
            clear(store, row)
        }
        other => Err(ApiError::Other(format!("unknown queued write: {other}"))),
    }
}

/// `EditPlan::PatchInstance` carries the original start rather than an instance id because the id
/// is Google's to give. This is where it is asked for, at push time, rather than assembled by hand.
async fn resolve(
    transport: &impl Transport,
    account_id: &str,
    row: &OutboxRow,
) -> Result<(String, Option<String>), ApiError> {
    let event_id = row
        .event_id
        .clone()
        .ok_or_else(|| ApiError::Other("a queued write with no event".to_string()))?;
    let Some(original_start) = row.original_start.as_deref() else {
        return Ok((event_id, row.etag.clone()));
    };
    let instances = transport
        .events_instances(account_id, &row.calendar_id, &event_id, original_start)
        .await?;
    let instance = instances.into_iter().next().ok_or_else(|| {
        ApiError::Other(format!(
            "that occurrence of {event_id} is no longer in the series"
        ))
    })?;
    let etag = row.etag.clone().or_else(|| instance.etag.clone());
    Ok((instance.id, etag))
}

fn payload(row: &OutboxRow) -> Result<Value, ApiError> {
    let raw = row
        .payload
        .as_deref()
        .ok_or_else(|| ApiError::Other(format!("the queued {} carries no body", row.op)))?;
    serde_json::from_str(raw).map_err(|e| ApiError::Other(e.to_string()))
}

/// The response is the truth, so it replaces the optimistic row rather than merely clearing its
/// dirty flag: Google fills in the etag, the id normalisation and anything it rewrote.
fn land(
    store: &Store,
    calendar_id: &str,
    account_id: &str,
    raw: &crate::google::api::RawEvent,
) -> Result<(), ApiError> {
    let row = model::event_row(raw, calendar_id, account_id);
    with_conn(store, |conn| write::upsert_event(conn, &row)).map_err(ApiError::Other)
}

fn clear(store: &Store, row: &OutboxRow) -> Result<(), ApiError> {
    let Some(event_id) = row.event_id.as_deref() else {
        return Ok(());
    };
    with_conn(store, |conn| {
        write::clear_dirty(conn, &row.calendar_id, event_id)
    })
    .map_err(ApiError::Other)
}

fn calendar_accounts(conn: &Connection) -> Result<HashMap<String, String>, String> {
    Ok(read::calendars(conn)?
        .into_iter()
        .map(|calendar| (calendar.id, calendar.account_id))
        .collect())
}
