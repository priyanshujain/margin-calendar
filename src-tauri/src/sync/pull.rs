// The read half of a pass: the calendarList for every connected account, then `events.list` for
// every calendar, incremental where there is a cursor and full where there is not.
//
// The one rule that everything else hangs off: `nextSyncToken` appears only on the final page, so
// pages are walked to exhaustion and nothing at all is written until the walk is over. Committing a
// token from the middle of a chain corrupts the cursor silently, and the next incremental sync
// returns changes since the middle of a page rather than since the last pass.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::google::api::{ApiError, RawCalendar, RawEvent};
use crate::store::read::{self, SyncTarget};
use crate::store::write::{self, Tx};
use crate::store::Store;

use super::model;
use super::transport::Transport;
use super::{with_conn, Outcome, Sink};

/// A calendar with more pages than this is a runaway, not a calendar. 2500 events a page puts the
/// ceiling well past any real history and stops a repeated `pageToken` looping forever.
const MAX_PAGES: usize = 2_000;

const CALENDAR_LIST_TOKEN: &str = "calendar-list-token";

pub async fn sync_all(
    store: &Store,
    transport: &impl Transport,
    sink: &impl Sink,
) -> Outcome {
    let mut outcome = Outcome::default();

    let accounts = match with_conn(store, read::accounts) {
        Ok(accounts) => accounts,
        Err(error) => {
            outcome.error = Some(error);
            return outcome;
        }
    };
    let connected: HashSet<String> = accounts
        .iter()
        .filter(|account| account.connected)
        .map(|account| account.id.clone())
        .collect();

    for account_id in &connected {
        match sync_calendar_list(store, transport, account_id).await {
            Ok(changed) => outcome.changed |= changed,
            Err(ApiError::Offline(_)) => {
                outcome.offline = true;
                return outcome;
            }
            Err(error) => {
                outcome.error.get_or_insert(error.to_string());
            }
        }
    }
    if outcome.changed {
        sink.changed("calendars");
    }

    let targets = match with_conn(store, read::sync_targets) {
        Ok(targets) => targets,
        Err(error) => {
            outcome.error = Some(error);
            return outcome;
        }
    };
    let targets: Vec<SyncTarget> = targets
        .into_iter()
        .filter(|target| connected.contains(&target.account_id))
        .collect();

    let total = targets.len();
    for (index, target) in targets.iter().enumerate() {
        sink.message(&format!("Syncing calendar {} of {total}", index + 1));
        match sync_calendar(store, transport, target).await {
            Ok(changed) => {
                if changed {
                    outcome.changed = true;
                    // Emitted per calendar rather than once at the end, so a long initial pull
                    // renders as it lands instead of after it.
                    sink.changed("sync");
                }
            }
            Err(ApiError::Offline(_)) => {
                outcome.offline = true;
                return outcome;
            }
            // One calendar failing is not the pass failing: a shared calendar the user lost access
            // to would otherwise stop every other calendar from ever syncing again.
            Err(error) => {
                outcome
                    .error
                    .get_or_insert(format!("{}: {error}", target.calendar_id));
            }
        }
    }

    outcome
}

/// Returns whether anything landed. A 410 clears this one calendar and resyncs it alone; every
/// other calendar keeps its rows and its cursor.
async fn sync_calendar(
    store: &Store,
    transport: &impl Transport,
    target: &SyncTarget,
) -> Result<bool, ApiError> {
    let mut token = target.sync_token.clone();
    let mut recovered = false;

    loop {
        match collect_events(transport, target, token.as_deref()).await {
            Ok((items, next)) => {
                return with_conn(store, |conn| apply_events(conn, target, &items, &next))
                    .map_err(ApiError::Other);
            }
            Err(ApiError::SyncTokenExpired) if !recovered && token.is_some() => {
                recovered = true;
                token = None;
                with_conn(store, |conn| {
                    write::clear_calendar(conn, &target.calendar_id)
                })
                .map_err(ApiError::Other)?;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Walks to exhaustion and hands back everything at once, because the token that makes the pages
/// worth keeping only arrives with the last of them.
async fn collect_events(
    transport: &impl Transport,
    target: &SyncTarget,
    sync_token: Option<&str>,
) -> Result<(Vec<RawEvent>, String), ApiError> {
    let mut items: Vec<RawEvent> = Vec::new();
    let mut page_token: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let page = transport
            .events_list(
                &target.account_id,
                &target.calendar_id,
                sync_token,
                page_token.as_deref(),
            )
            .await?;
        items.extend(page.items);
        match page.next_page_token {
            Some(next) => page_token = Some(next),
            None => {
                let token = page.next_sync_token.ok_or_else(|| {
                    ApiError::Other(format!(
                        "{}: the last page of events carried no sync token",
                        target.calendar_id
                    ))
                })?;
                return Ok((items, token));
            }
        }
    }
    Err(ApiError::Other(format!(
        "{}: the event list did not end after {MAX_PAGES} pages",
        target.calendar_id
    )))
}

/// One transaction for the whole chain, so the rows and the cursor can never disagree.
fn apply_events(
    conn: &Connection,
    target: &SyncTarget,
    items: &[RawEvent],
    token: &str,
) -> Result<bool, String> {
    let tx = Tx::begin(conn)?;
    for raw in items {
        let row = model::event_row(raw, &target.calendar_id, &target.account_id);
        // A cancelled instance of a series is kept: it is how the expander knows to drop that
        // occurrence, and it carries nothing but its id, its master and its original start. A
        // cancelled anything else is simply gone.
        if model::is_cancelled(raw) && row.recurring_event_id.is_none() {
            write::delete_event(conn, &target.calendar_id, &row.id)?;
        } else {
            write::upsert_event(conn, &row)?;
        }
    }
    write::set_calendar_sync_token(conn, &target.calendar_id, Some(token))?;
    tx.commit()?;
    Ok(!items.is_empty())
}

/// The calendarList carries its own sync token, kept in `meta` because `calendars` has no row to
/// hang an account-wide cursor off.
async fn sync_calendar_list(
    store: &Store,
    transport: &impl Transport,
    account_id: &str,
) -> Result<bool, ApiError> {
    let key = write::account_meta_key(account_id, CALENDAR_LIST_TOKEN);
    let mut token = with_conn(store, |conn| write::meta_get(conn, &key)).map_err(ApiError::Other)?;
    let mut recovered = false;

    loop {
        match collect_calendars(transport, account_id, token.as_deref()).await {
            Ok((items, next)) => {
                let full = token.is_none();
                return with_conn(store, |conn| {
                    apply_calendars(conn, account_id, &items, &next, full)
                })
                .map_err(ApiError::Other);
            }
            Err(ApiError::SyncTokenExpired) if !recovered && token.is_some() => {
                recovered = true;
                token = None;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn collect_calendars(
    transport: &impl Transport,
    account_id: &str,
    sync_token: Option<&str>,
) -> Result<(Vec<RawCalendar>, String), ApiError> {
    let mut items: Vec<RawCalendar> = Vec::new();
    let mut page_token: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let page = transport
            .calendar_list(account_id, sync_token, page_token.as_deref())
            .await?;
        items.extend(page.items);
        match page.next_page_token {
            Some(next) => page_token = Some(next),
            None => {
                let token = page.next_sync_token.ok_or_else(|| {
                    ApiError::Other(
                        "the last page of the calendar list carried no sync token".to_string(),
                    )
                })?;
                return Ok((items, token));
            }
        }
    }
    Err(ApiError::Other(
        "the calendar list did not end".to_string(),
    ))
}

fn apply_calendars(
    conn: &Connection,
    account_id: &str,
    items: &[RawCalendar],
    token: &str,
    full: bool,
) -> Result<bool, String> {
    let mut changed = false;
    let rows: Vec<_> = items
        .iter()
        .map(|raw| model::calendar_row(raw, account_id))
        .collect();

    let live: Vec<_> = rows.iter().filter(|row| !row.deleted).cloned().collect();
    if !live.is_empty() {
        write::upsert_calendars(conn, &live)?;
        changed = true;
    }
    for row in rows.iter().filter(|row| row.deleted) {
        write::delete_calendar(conn, &row.id)?;
        changed = true;
    }

    // A full list is the whole truth, so anything local that is missing from it is a calendar the
    // account no longer has. An incremental page says nothing about what it did not mention.
    if full {
        let returned: HashSet<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        for calendar in read::calendars(conn)? {
            if calendar.account_id == account_id && !returned.contains(calendar.id.as_str()) {
                write::delete_calendar(conn, &calendar.id)?;
                changed = true;
            }
        }
    }

    write::meta_set(
        conn,
        &write::account_meta_key(account_id, CALENDAR_LIST_TOKEN),
        token,
    )?;
    Ok(changed)
}
