// Owns expansion, exception merging and the three edit scopes.
//
// Expansion takes a window and the masters overlapping it, runs `rrule` to generate occurrences,
// drops any occurrence whose original start matches an exception, then merges the exception
// events back in at their moved times.
//
// A cancelled instance is only guaranteed to carry id, recurringEventId, originalStartTime and
// status, so expansion must key on (recurring_event_id, original_start) and must never depend on
// another field being populated.
//
// All-day events are date-only and must never be shifted into a timezone. DST makes a local day
// 23 or 25 hours; the grid is a wall-clock axis, so positions come from local wall-clock time and
// an event spanning a transition renders at a height that does not match its true duration. That
// is correct for this kind of grid.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat,
             TimeZone};
use rrule::{RRuleSet, Tz};

use crate::dto::{Attendee, Conference, EventDraft, EventPatch, Instance, InstanceKey, Scope};
use crate::store::write::{epoch_ms, EventRow};

/// Per series, per window. The widest view is a month, so this only bites a rule no human wrote.
const MAX_OCCURRENCES: u16 = 10_000;

/// The seam between recurrence and the write path. The recurrence agent decides what a scoped
/// edit costs in API calls; the sync agent performs them and enqueues them in the outbox.
#[derive(Debug, Clone)]
pub enum EditPlan {
    /// `This`. The concrete instance is resolved through `events.instances` with `originalStart`
    /// rather than by constructing the instance id by hand.
    PatchInstance {
        calendar_id: String,
        event_id: String,
        original_start: Option<String>,
        patch: EventPatch,
    },
    /// `All`.
    PatchMaster {
        calendar_id: String,
        event_id: String,
        patch: EventPatch,
    },
    /// `Following`. The API has no native split, so truncate the master's RRULE with an UNTIL at
    /// the split point and create a new master from there.
    ///
    /// Two calls, in this order: patch `event_id` with `truncate_recurrence(master.recurrence,
    /// until)`, then insert `draft`. `EventDraft` carries an offset but no zone, so the insert has
    /// to send the master's own `start_tz`/`end_tz` as `start.timeZone`/`end.timeZone`. Without
    /// them Google files the new series under the calendar's zone and the tail drifts an hour away
    /// from the head at the next DST transition.
    Split {
        calendar_id: String,
        event_id: String,
        until: String,
        draft: EventDraft,
    },
    CancelInstance {
        calendar_id: String,
        event_id: String,
        original_start: Option<String>,
    },
    TruncateMaster {
        calendar_id: String,
        event_id: String,
        until: String,
    },
    DeleteMaster {
        calendar_id: String,
        event_id: String,
    },
}

/// What a calendar contributes to every instance on it. None of it lives on `EventRow` and all of
/// it is on `Instance`, so `instances_range` joins the calendars in and hands this down.
#[derive(Debug, Clone, Default)]
pub struct CalendarFacts {
    pub color_hex: String,
    pub time_zone: String,
    pub read_only: bool,
}

impl CalendarFacts {
    pub fn from_calendar(calendar: &crate::dto::Calendar) -> CalendarFacts {
        CalendarFacts {
            color_hex: calendar.color_hex.clone(),
            time_zone: calendar.time_zone.clone(),
            read_only: !matches!(calendar.access_role.as_str(), "writer" | "owner"),
        }
    }
}

/// Google's per-event palette, by `colorId`. These are Google's own hex values, so a colour set
/// here shows the same in both apps; the eight-hue mapping in the UI is what keeps the grid calm.
const EVENT_COLORS: [(&str, &str); 11] = [
    ("1", "#7986cb"),
    ("2", "#33b679"),
    ("3", "#8e24aa"),
    ("4", "#e67c73"),
    ("5", "#f6bf26"),
    ("6", "#f4511e"),
    ("7", "#039be5"),
    ("8", "#616161"),
    ("9", "#3f51b5"),
    ("10", "#0b8043"),
    ("11", "#d50000"),
];

pub fn event_color(color_id: Option<&str>) -> Option<&'static str> {
    let id = color_id?.trim();
    EVENT_COLORS
        .iter()
        .find(|(key, _)| *key == id)
        .map(|(_, hex)| *hex)
}

/// Expand `rows` into concrete occurrences overlapping `[from_ms, to_ms)`, in the local zone.
///
/// `instances_range` goes through `expand_in` instead, so it can pass the calendar facts and a
/// pinned zone down. This stays as the plain entry point, which is what the tests drive.
#[allow(dead_code)]
pub fn expand(rows: &[EventRow], from_ms: i64, to_ms: i64) -> Result<Vec<Instance>, String> {
    expand_in(rows, from_ms, to_ms, Tz::LOCAL, &HashMap::new())
}

/// The body of `expand` with the machine's own zone made an argument. A test that cannot pin the
/// local zone cannot prove an all-day event does not drift, and `TZ` is process-global while tests
/// are not.
fn expand_in(
    rows: &[EventRow],
    from_ms: i64,
    to_ms: i64,
    local: Tz,
    calendars: &HashMap<String, CalendarFacts>,
) -> Result<Vec<Instance>, String> {
    // Keyed on the instant, never on the string: two spellings of one moment have to collide, and a
    // cancelled row carries nothing else to key on.
    let mut overridden: HashSet<(&str, &str, i64)> = HashSet::new();
    for row in rows {
        if let (Some(master), Some(original)) = (&row.recurring_event_id, &row.original_start) {
            if let Some(at) = epoch_ms(original, false) {
                overridden.insert((row.calendar_id.as_str(), master.as_str(), at));
            }
        }
    }

    let mut out: Vec<Instance> = Vec::new();
    for row in rows {
        if row.status == "cancelled" {
            continue;
        }
        let facts = calendars.get(&row.calendar_id).cloned().unwrap_or_default();

        // An exception, at whatever time it was dragged to. Its own row carries the times, so this
        // path never touches the series' zone.
        if row.recurring_event_id.is_some() {
            if let Some(spot) = placement(row) {
                push(&mut out, row, &row.id, &facts, true, row.original_start.clone(), spot,
                     local, from_ms, to_ms);
            }
            continue;
        }

        if row.recurrence.is_empty() {
            if let Some(spot) = placement(row) {
                push(&mut out, row, &row.id, &facts, false, None, spot, local, from_ms, to_ms);
            }
            continue;
        }

        let zone = series_zone(row, &facts, local);
        // A rule the crate will not read costs one series. Returning an error here would cost the
        // whole window, and a blank month is a worse answer than a missing series.
        let Ok(series) = build_series(row, zone) else { continue };
        for at in occurrences(&series, from_ms, to_ms) {
            let (spot, original, key) = spot_of(&series, at);
            if overridden.contains(&(row.calendar_id.as_str(), row.id.as_str(), key)) {
                continue;
            }
            push(&mut out, row, &row.id, &facts, true, Some(original), spot, local, from_ms, to_ms);
        }
    }

    out.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| a.event_id.cmp(&b.event_id))
            .then_with(|| a.original_start.cmp(&b.original_start))
    });
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn push(
    out: &mut Vec<Instance>,
    row: &EventRow,
    event_id: &str,
    facts: &CalendarFacts,
    recurring: bool,
    original_start: Option<String>,
    spot: Spot,
    local: Tz,
    from_ms: i64,
    to_ms: i64,
) {
    let (start_ms, end_ms) = spot.millis(local);
    if !overlaps(start_ms, end_ms, from_ms, to_ms) {
        return;
    }
    let (start, end) = spot.strings(local);
    out.push(Instance {
        event_id: event_id.to_string(),
        calendar_id: row.calendar_id.clone(),
        account_id: row.account_id.clone(),
        original_start,
        start,
        end,
        start_ms,
        end_ms,
        all_day: matches!(spot, Spot::Day { .. }),
        summary: row.summary.clone(),
        description: row.description.clone(),
        location: row.location.clone(),
        status: row.status.clone(),
        recurring,
        // The event's own colour wins over its calendar's, which is what Google does.
        color_hex: event_color(row.color_id.as_deref())
            .unwrap_or(&facts.color_hex)
            .to_string(),
        color_id: row.color_id.clone(),
        etag: row.etag.clone(),
        organizer: organizer(row.attendees.as_deref()),
        attendees: attendees(row.attendees.as_deref()),
        conference: conference(row.conference.as_deref()),
        read_only: facts.read_only,
        pending: row.dirty,
    });
}

/// Half-open at both ends, with a zero-length event kept when it sits on the opening bound.
fn overlaps(start_ms: i64, end_ms: i64, from_ms: i64, to_ms: i64) -> bool {
    start_ms < to_ms && (end_ms > from_ms || (end_ms <= start_ms && start_ms >= from_ms))
}

// -- placement ---------------------------------------------------------------------------------

/// Where something sits on the axis. `Day` is date-only and never carries a zone; its `end` is
/// exclusive, exactly as Google sends it.
#[derive(Debug, Clone, Copy)]
enum Spot {
    Day { start: NaiveDate, end: NaiveDate },
    Timed { start: DateTime<Tz>, end: DateTime<Tz> },
}

impl Spot {
    /// All-day events pin to local midnight, which is the one place a date is allowed to meet a
    /// zone, and only so the grid has a number to lay it out against.
    fn millis(&self, local: Tz) -> (i64, i64) {
        match self {
            Spot::Day { start, end } => (
                resolve(local, start.and_time(NaiveTime::MIN)).timestamp_millis(),
                resolve(local, end.and_time(NaiveTime::MIN)).timestamp_millis(),
            ),
            Spot::Timed { start, end } => (start.timestamp_millis(), end.timestamp_millis()),
        }
    }

    fn strings(&self, local: Tz) -> (String, String) {
        match self {
            Spot::Day { start, end } => (
                start.format("%Y-%m-%d").to_string(),
                end.format("%Y-%m-%d").to_string(),
            ),
            Spot::Timed { start, end } => (rfc3339(*start, local), rfc3339(*end, local)),
        }
    }
}

fn rfc3339(at: DateTime<Tz>, zone: Tz) -> String {
    at.with_timezone(&zone)
        .to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// A row's own times, whatever produced the row. A moved exception and a one-off are both read
/// straight off the row, so neither needs a recurrence rule or a series zone to be placed.
fn placement(row: &EventRow) -> Option<Spot> {
    let start_at = row.start_at.trim();
    if start_at.is_empty() {
        return None;
    }
    if row.all_day || (start_at.len() == 10 && !start_at.contains('T')) {
        let start = NaiveDate::parse_from_str(start_at, "%Y-%m-%d").ok()?;
        let end = NaiveDate::parse_from_str(row.end_at.trim(), "%Y-%m-%d")
            .unwrap_or(start + Duration::days(1));
        let end = if end <= start { start + Duration::days(1) } else { end };
        return Some(Spot::Day { start, end });
    }
    let start = instant(start_at)?;
    let end = instant(row.end_at.trim()).unwrap_or(start);
    Some(Spot::Timed {
        start,
        end: if end < start { start } else { end },
    })
}

fn instant(value: &str) -> Option<DateTime<Tz>> {
    DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|at| at.with_timezone(&Tz::UTC))
}

/// A wall clock into an instant. The repeated hour takes the earlier reading; the skipped hour
/// lands on the transition itself, because a series must not lose an occurrence to a clock change.
fn resolve(zone: Tz, naive: NaiveDateTime) -> DateTime<Tz> {
    match zone.from_local_datetime(&naive) {
        LocalResult::Single(at) => at,
        LocalResult::Ambiguous(first, _) => first,
        LocalResult::None => match zone.from_local_datetime(&(naive + Duration::hours(1))) {
            LocalResult::Single(at) | LocalResult::Ambiguous(at, _) => at - Duration::hours(1),
            LocalResult::None => Tz::UTC.from_utc_datetime(&naive).with_timezone(&zone),
        },
    }
}

fn zone_named(name: Option<&str>, fallback: Tz) -> Tz {
    match name.map(str::trim) {
        Some(name) if !name.is_empty() => name
            .parse::<chrono_tz::Tz>()
            .map(Tz::Tz)
            .unwrap_or(fallback),
        _ => fallback,
    }
}

/// The series' own zone, then the calendar's, then the machine's. An all-day series has no zone at
/// all: expanding it in UTC keeps every occurrence on the date the rule names and keeps DST out of
/// an arithmetic that has no business seeing it.
fn series_zone(row: &EventRow, facts: &CalendarFacts, local: Tz) -> Tz {
    if row.all_day || (row.start_at.trim().len() == 10 && !row.start_at.contains('T')) {
        return Tz::UTC;
    }
    zone_named(
        row.start_tz.as_deref(),
        zone_named(Some(facts.time_zone.as_str()), local),
    )
}

/// The zone a plan is made in, where there is no calendar to fall back through.
fn row_zone(row: &EventRow) -> Tz {
    series_zone(row, &CalendarFacts::default(), Tz::LOCAL)
}

// -- expansion ---------------------------------------------------------------------------------

struct Series {
    zone: Tz,
    all_day: bool,
    /// Start to end as wall clock, applied to every occurrence's start in wall-clock terms.
    span: Duration,
    set: RRuleSet,
}

fn build_series(row: &EventRow, zone: Tz) -> Result<Series, String> {
    let spot = placement(row).ok_or_else(|| format!("{}: no usable start", row.id))?;
    let (start, span, all_day) = match spot {
        Spot::Day { start, end } => (
            Tz::UTC.from_utc_datetime(&start.and_time(NaiveTime::MIN)),
            Duration::days((end - start).num_days().max(1)),
            true,
        ),
        Spot::Timed { start, end } => {
            let start = start.with_timezone(&zone);
            let end = end.with_timezone(&zone);
            let span = end.naive_local().signed_duration_since(start.naive_local());
            (start, span, false)
        }
    };
    // DTSTART is built, not parsed: a series that starts inside a DST gap or a repeated hour is a
    // parse error to the crate, and we already know the exact instant it starts at.
    let set = RRuleSet::new(start)
        .set_from_string(&normalise(&row.recurrence, zone, all_day)?)
        .map_err(|e| format!("{}: {e}", row.id))?;
    Ok(Series {
        zone,
        all_day,
        span,
        set,
    })
}

/// Bounds are padded by the event's own span at the front, so an occurrence that starts before the
/// window but runs into it survives, and by a day either side because an all-day occurrence sits at
/// UTC midnight here and at local midnight by the time it is measured.
fn occurrences(series: &Series, from_ms: i64, to_ms: i64) -> Vec<DateTime<Tz>> {
    let slack = Duration::days(1) + series.span.max(Duration::zero());
    let (Some(lower), Some(upper)) = (
        Tz::UTC.timestamp_millis_opt(from_ms).single(),
        Tz::UTC.timestamp_millis_opt(to_ms).single(),
    ) else {
        return Vec::new();
    };
    series
        .set
        .clone()
        .after(lower - slack)
        .before(upper + Duration::days(1))
        .all(MAX_OCCURRENCES)
        .dates
}

/// An occurrence's placement, the string form of its unmoved start, and the instant that start is
/// keyed by when it is matched against an exception.
fn spot_of(series: &Series, at: DateTime<Tz>) -> (Spot, String, i64) {
    if series.all_day {
        let start = at.with_timezone(&Tz::UTC).date_naive();
        let end = start + Duration::days(series.span.num_days().max(1));
        let key = Tz::UTC
            .from_utc_datetime(&start.and_time(NaiveTime::MIN))
            .timestamp_millis();
        (
            Spot::Day { start, end },
            start.format("%Y-%m-%d").to_string(),
            key,
        )
    } else {
        let start = at.with_timezone(&series.zone);
        let end = resolve(series.zone, start.naive_local() + series.span);
        (
            Spot::Timed { start, end },
            rfc3339(start, series.zone),
            start.timestamp_millis(),
        )
    }
}

// -- rule text ---------------------------------------------------------------------------------

/// Splits a content line into its property name, its parameters and its value. A line with no
/// colon is an RRULE body, which is what the crate assumes too.
fn split_line(line: &str) -> (String, Option<&str>, &str) {
    let Some(colon) = line.find(':') else {
        return ("RRULE".to_string(), None, line);
    };
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    match head.find(';') {
        Some(semi) => (
            head[..semi].to_uppercase(),
            Some(&head[semi + 1..]),
            value,
        ),
        None => (head.to_uppercase(), None, value),
    }
}

fn param<'a>(params: Option<&'a str>, key: &str) -> Option<&'a str> {
    params?.split(';').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        name.trim().eq_ignore_ascii_case(key).then(|| value.trim())
    })
}

/// Rewrites a master's rule lines into the form the crate reads the way RFC5545 means it.
///
/// Two of its defaults are wrong for this data. A floating UNTIL or EXDATE is read in the machine's
/// zone rather than the series', and once DTSTART carries a named zone an UNTIL in anything but UTC
/// is rejected outright, which is exactly what an all-day series from Google looks like
/// (`UNTIL=20260301`). Everything datelike therefore leaves here as a UTC instant.
fn normalise(lines: &[String], zone: Tz, all_day: bool) -> Result<String, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in lines {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (name, params, value) = split_line(line);
        match name.as_str() {
            // Ours wins: it came from the row, where the offset is unambiguous.
            "DTSTART" => continue,
            "RRULE" | "EXRULE" => out.push(format!("{name}:{}", rewrite_until(value, zone)?)),
            "EXDATE" | "RDATE" => {
                let value_zone = value_zone(params, zone, all_day);
                let mut dates = Vec::new();
                for part in value.split(',') {
                    if part.trim().is_empty() {
                        continue;
                    }
                    dates.push(ical_utc(part, value_zone)?);
                }
                if !dates.is_empty() {
                    out.push(format!("{name}:{}", dates.join(",")));
                }
            }
            _ => out.push(line.to_string()),
        }
    }
    Ok(out.join("\n"))
}

/// A date-only value on an all-day series is that date whatever TZID rides along with it, and an
/// all-day series expands in UTC, so the parameter is deliberately ignored there.
fn value_zone(params: Option<&str>, zone: Tz, all_day: bool) -> Tz {
    if all_day {
        zone
    } else {
        zone_named(param(params, "TZID"), zone)
    }
}

fn rewrite_until(value: &str, zone: Tz) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    for part in value.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match part.split_once('=') {
            Some((key, raw)) if key.trim().eq_ignore_ascii_case("UNTIL") => {
                parts.push(format!("UNTIL={}", ical_utc(raw, zone)?));
            }
            _ => parts.push(part.to_string()),
        }
    }
    Ok(parts.join(";"))
}

fn ical_instant(raw: &str, zone: Tz) -> Result<DateTime<Tz>, String> {
    let raw = raw.trim();
    let (body, zulu) = match raw.strip_suffix('Z').or_else(|| raw.strip_suffix('z')) {
        Some(body) => (body, true),
        None => (raw, false),
    };
    let naive = if body.len() == 8 {
        NaiveDate::parse_from_str(body, "%Y%m%d")
            .map_err(|_| format!("not a date: {raw}"))?
            .and_time(NaiveTime::MIN)
    } else {
        NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S")
            .map_err(|_| format!("not a date-time: {raw}"))?
    };
    Ok(if zulu {
        Tz::UTC.from_utc_datetime(&naive)
    } else {
        resolve(zone, naive)
    })
}

fn ical_utc(raw: &str, zone: Tz) -> Result<String, String> {
    Ok(ical_instant(raw, zone)?
        .with_timezone(&Tz::UTC)
        .format("%Y%m%dT%H%M%SZ")
        .to_string())
}

/// The head of a split: the master's lines with an UNTIL that stops the series before the split.
/// The `until` on `EditPlan::Split` and `EditPlan::TruncateMaster` is a value, not a rule, and this
/// is how it becomes one.
///
/// COUNT goes, because RFC5545 forbids it alongside UNTIL. An RDATE past the cut goes too, because
/// UNTIL bounds a rule and not a date list, so one left behind would put an occurrence back after
/// the split. An EXDATE past the cut stays: it excludes nothing either way, and leaving it alone is
/// one fewer thing to get wrong.
pub fn truncate_recurrence(recurrence: &[String], until: &str) -> Vec<String> {
    let cut = ical_instant(until, Tz::UTC)
        .map(|at| at.timestamp_millis())
        .ok();
    let mut out: Vec<String> = Vec::new();
    for raw in recurrence {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (name, params, value) = split_line(line);
        match name.as_str() {
            "DTSTART" => continue,
            "RRULE" | "EXRULE" => {
                let mut parts: Vec<String> = value
                    .split(';')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .filter(|part| !starts_with_key(part, "UNTIL") && !starts_with_key(part, "COUNT"))
                    .map(str::to_string)
                    .collect();
                parts.push(format!("UNTIL={until}"));
                out.push(format!("{name}:{}", parts.join(";")));
            }
            "RDATE" => {
                let kept = filter_dates(value, params, Tz::UTC, |at| {
                    cut.is_none_or(|cut| at <= cut)
                });
                if !kept.is_empty() {
                    out.push(rebuild(&name, params, &kept));
                }
            }
            _ => out.push(line.to_string()),
        }
    }
    out
}

fn starts_with_key(part: &str, key: &str) -> bool {
    part.split_once('=')
        .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case(key))
}

fn filter_dates(
    value: &str,
    params: Option<&str>,
    zone: Tz,
    keep: impl Fn(i64) -> bool,
) -> String {
    let value_zone = zone_named(param(params, "TZID"), zone);
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .filter(|part| {
            ical_instant(part, value_zone)
                .map(|at| keep(at.timestamp_millis()))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn rebuild(name: &str, params: Option<&str>, value: &str) -> String {
    match params {
        Some(params) => format!("{name};{params}:{value}"),
        None => format!("{name}:{value}"),
    }
}

/// The tail of a split: the same rule from the split point on. UNTIL stays, because the tail keeps
/// the original end; COUNT comes down by whatever the head consumed; anything dated before the
/// split goes, because it belongs to the head.
fn tail_recurrence(row: &EventRow, zone: Tz, split_ms: i64) -> Vec<String> {
    let counted = row
        .recurrence
        .iter()
        .any(|line| line.to_uppercase().contains("COUNT="));
    let consumed = if counted { count_before(row, zone, split_ms) } else { 0 };

    let mut out: Vec<String> = Vec::new();
    for raw in &row.recurrence {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (name, params, value) = split_line(line);
        match name.as_str() {
            "DTSTART" => continue,
            "RRULE" | "EXRULE" => {
                let parts: Vec<String> = value
                    .split(';')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .map(|part| match part.split_once('=') {
                        Some((key, total)) if key.trim().eq_ignore_ascii_case("COUNT") => {
                            let total: usize = total.trim().parse().unwrap_or(0);
                            format!("COUNT={}", total.saturating_sub(consumed).max(1))
                        }
                        _ => part.to_string(),
                    })
                    .collect();
                out.push(format!("{name}:{}", parts.join(";")));
            }
            "RDATE" => {
                let kept = filter_dates(value, params, zone, |at| at >= split_ms);
                if !kept.is_empty() {
                    out.push(rebuild(&name, params, &kept));
                }
            }
            _ => out.push(line.to_string()),
        }
    }
    out
}

fn count_before(row: &EventRow, zone: Tz, split_ms: i64) -> usize {
    let Ok(series) = build_series(row, zone) else { return 0 };
    let Some(upper) = Tz::UTC.timestamp_millis_opt(split_ms - 1).single() else { return 0 };
    series.set.before(upper).all(MAX_OCCURRENCES).dates.len()
}

// -- scoped edits ------------------------------------------------------------------------------

/// The row a plan is made against, which is always the master, plus the occurrence it applies to.
struct Target<'a> {
    row: &'a EventRow,
    original_start: Option<String>,
}

fn target<'a>(rows: &'a [EventRow], key: &InstanceKey) -> Result<Target<'a>, String> {
    let row = rows
        .iter()
        .find(|row| row.id == key.event_id)
        .ok_or_else(|| format!("no such event: {}", key.event_id))?;
    let Some(master_id) = row.recurring_event_id.as_deref() else {
        return Ok(Target {
            row,
            original_start: key.original_start.clone(),
        });
    };
    // Expansion emits the master's id for every occurrence of a series, so landing here means the
    // caller held a concrete instance id. Either way the plan is made against the master.
    match rows
        .iter()
        .find(|other| other.id == master_id && other.calendar_id == row.calendar_id)
    {
        Some(master) => Ok(Target {
            row: master,
            original_start: key
                .original_start
                .clone()
                .or_else(|| row.original_start.clone()),
        }),
        // An exception whose master is not in the window is still a real event; patch it by id.
        None => Ok(Target {
            row,
            original_start: None,
        }),
    }
}

/// Where a series is cut and what the tail starts as.
struct Split {
    /// UTC `YYYYMMDDTHHMMSSZ`, or `YYYYMMDD` for an all-day series. Exclusive of the occurrence.
    until: String,
    spot: Spot,
    span: Duration,
    at_ms: i64,
    /// The cut lands on or before the series' own start, so there is no head to keep.
    whole_series: bool,
}

fn split_at(row: &EventRow, original_start: Option<&str>, zone: Tz) -> Result<Split, String> {
    let original = original_start
        .ok_or_else(|| "splitting a series needs the occurrence to split at".to_string())?;
    let spot = placement(row).ok_or_else(|| format!("{}: no usable start", row.id))?;
    match spot {
        Spot::Day { start: first, end } => {
            let at = NaiveDate::parse_from_str(original.trim(), "%Y-%m-%d")
                .or_else(|_| {
                    DateTime::parse_from_rfc3339(original.trim()).map(|at| at.date_naive())
                })
                .map_err(|_| format!("cannot read an original start: {original}"))?;
            let span = Duration::days((end - first).num_days().max(1));
            Ok(Split {
                until: (at - Duration::days(1)).format("%Y%m%d").to_string(),
                spot: Spot::Day {
                    start: at,
                    end: at + span,
                },
                span,
                at_ms: Tz::UTC
                    .from_utc_datetime(&at.and_time(NaiveTime::MIN))
                    .timestamp_millis(),
                whole_series: at <= first,
            })
        }
        Spot::Timed { start: first, end } => {
            let at = instant(original)
                .ok_or_else(|| format!("cannot read an original start: {original}"))?
                .with_timezone(&zone);
            let first = first.with_timezone(&zone);
            let span = end
                .with_timezone(&zone)
                .naive_local()
                .signed_duration_since(first.naive_local());
            Ok(Split {
                until: (at - Duration::seconds(1))
                    .with_timezone(&Tz::UTC)
                    .format("%Y%m%dT%H%M%SZ")
                    .to_string(),
                spot: Spot::Timed {
                    start: at,
                    end: resolve(zone, at.naive_local() + span),
                },
                span,
                at_ms: at.timestamp_millis(),
                whole_series: at <= first,
            })
        }
    }
}

/// The tail master. Everything the patch does not name is inherited, and a patched start with no
/// patched end keeps the original span rather than collapsing the event.
fn tail_draft(row: &EventRow, split: &Split, patch: &EventPatch, zone: Tz) -> EventDraft {
    let all_day = matches!(split.spot, Spot::Day { .. });
    let (inherited_start, inherited_end) = split.spot.strings(zone);
    let start = patch.start.clone().unwrap_or(inherited_start);
    let end = match (&patch.end, &patch.start) {
        (Some(end), _) => end.clone(),
        (None, Some(_)) => shifted(&start, split.span, all_day, zone).unwrap_or(inherited_end),
        (None, None) => inherited_end,
    };
    EventDraft {
        color_id: patch.color_id.clone().or_else(|| row.color_id.clone()),
        calendar_id: patch
            .calendar_id
            .clone()
            .unwrap_or_else(|| row.calendar_id.clone()),
        summary: patch.summary.clone().unwrap_or_else(|| row.summary.clone()),
        description: patch
            .description
            .clone()
            .or_else(|| row.description.clone()),
        location: patch.location.clone().or_else(|| row.location.clone()),
        start,
        end,
        all_day: patch.all_day.unwrap_or(all_day),
        recurrence: patch
            .recurrence
            .clone()
            .unwrap_or_else(|| tail_recurrence(row, zone, split.at_ms)),
    }
}

fn shifted(start: &str, span: Duration, all_day: bool, zone: Tz) -> Option<String> {
    if all_day {
        let start = NaiveDate::parse_from_str(start.trim(), "%Y-%m-%d").ok()?;
        return Some(
            (start + Duration::days(span.num_days().max(1)))
                .format("%Y-%m-%d")
                .to_string(),
        );
    }
    let at = instant(start)?.with_timezone(&zone);
    Some(rfc3339(resolve(zone, at.naive_local() + span), zone))
}

pub fn plan_edit(
    rows: &[EventRow],
    key: &InstanceKey,
    patch: &EventPatch,
    scope: Scope,
) -> Result<Vec<EditPlan>, String> {
    let target = target(rows, key)?;
    let row = target.row;
    let calendar_id = row.calendar_id.clone();
    let patch_master = || EditPlan::PatchMaster {
        calendar_id: calendar_id.clone(),
        event_id: row.id.clone(),
        patch: patch.clone(),
    };

    // A one-off has no scopes to choose between.
    if row.recurrence.is_empty() {
        return Ok(vec![patch_master()]);
    }

    match scope {
        Scope::All => Ok(vec![patch_master()]),
        Scope::This => {
            let original_start = target.original_start.ok_or_else(|| {
                "editing one occurrence needs the occurrence it applies to".to_string()
            })?;
            Ok(vec![EditPlan::PatchInstance {
                calendar_id,
                event_id: row.id.clone(),
                original_start: Some(original_start),
                patch: patch.clone(),
            }])
        }
        Scope::Following => {
            let zone = row_zone(row);
            let split = split_at(row, target.original_start.as_deref(), zone)?;
            // Splitting at the first occurrence leaves no head, which is an edit to the whole
            // series however the user got there.
            if split.whole_series {
                return Ok(vec![patch_master()]);
            }
            Ok(vec![EditPlan::Split {
                calendar_id,
                event_id: row.id.clone(),
                until: split.until.clone(),
                draft: tail_draft(row, &split, patch, zone),
            }])
        }
    }
}

pub fn plan_delete(
    rows: &[EventRow],
    key: &InstanceKey,
    scope: Scope,
) -> Result<Vec<EditPlan>, String> {
    let target = target(rows, key)?;
    let row = target.row;
    let calendar_id = row.calendar_id.clone();
    let delete_master = || EditPlan::DeleteMaster {
        calendar_id: calendar_id.clone(),
        event_id: row.id.clone(),
    };

    if row.recurrence.is_empty() {
        return Ok(vec![delete_master()]);
    }

    match scope {
        Scope::All => Ok(vec![delete_master()]),
        Scope::This => {
            let original_start = target.original_start.ok_or_else(|| {
                "deleting one occurrence needs the occurrence it applies to".to_string()
            })?;
            Ok(vec![EditPlan::CancelInstance {
                calendar_id,
                event_id: row.id.clone(),
                original_start: Some(original_start),
            }])
        }
        Scope::Following => {
            let zone = row_zone(row);
            let split = split_at(row, target.original_start.as_deref(), zone)?;
            if split.whole_series {
                return Ok(vec![delete_master()]);
            }
            Ok(vec![EditPlan::TruncateMaster {
                calendar_id,
                event_id: row.id.clone(),
                until: split.until,
            }])
        }
    }
}

// -- blobs -------------------------------------------------------------------------------------

/// Google's attendee array, read field by field. Deriving it would demand every optional key be
/// present, and Google sends whichever ones apply.
fn attendees(json: Option<&str>) -> Vec<Attendee> {
    let Some(items) = json
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|value| value.as_array().cloned())
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            Some(Attendee {
                email: item.get("email")?.as_str()?.to_string(),
                display_name: item
                    .get("displayName")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                response_status: item
                    .get("responseStatus")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("needsAction")
                    .to_string(),
                organizer: item
                    .get("organizer")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                is_self: item
                    .get("self")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                optional: item
                    .get("optional")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// The store keeps no organizer column, so the attendee flagged as one is the only source there is.
fn organizer(json: Option<&str>) -> Option<String> {
    attendees(json)
        .into_iter()
        .find(|attendee| attendee.organizer)
        .map(|attendee| attendee.email)
}

fn conference(json: Option<&str>) -> Option<Conference> {
    let value: serde_json::Value = serde_json::from_str(json?).ok()?;
    let kind = value
        .pointer("/conferenceSolution/key/type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let entry = value
        .get("entryPoints")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| {
                    item.get("entryPointType").and_then(serde_json::Value::as_str)
                        == Some("video")
                })
                .or_else(|| items.first())
        });
    let uri = entry
        .and_then(|entry| entry.get("uri"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    if kind.is_empty() && uri.is_none() {
        return None;
    }
    let label = entry
        .and_then(|entry| entry.get("label"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .pointer("/conferenceSolution/name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    Some(Conference { kind, uri, label })
}

/// Synchronous body behind an async command, which is margin's pdf.rs:90 trick for getting heavy
/// work off the main thread without hand-writing spawn_blocking.
#[tauri::command(async)]
pub fn instances_range(
    store: tauri::State<'_, crate::store::Store>,
    from_utc: i64,
    to_utc: i64,
) -> Result<Vec<Instance>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let rows = crate::store::read::masters_overlapping(&conn, from_utc, to_utc)?;
    let calendars = crate::store::read::calendars(&conn)?;
    drop(conn);
    let facts: HashMap<String, CalendarFacts> = calendars
        .iter()
        .map(|calendar| (calendar.id.clone(), CalendarFacts::from_calendar(calendar)))
        .collect();
    expand_in(&rows, from_utc, to_utc, Tz::LOCAL, &facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LONDON: Tz = Tz::Europe__London;
    const NEW_YORK: Tz = Tz::America__New_York;

    fn ms(rfc3339: &str) -> i64 {
        DateTime::parse_from_rfc3339(rfc3339)
            .expect("a timestamp")
            .timestamp_millis()
    }

    fn master(id: &str, start: &str, end: &str, zone: &str, rule: &[&str]) -> EventRow {
        EventRow {
            id: id.to_string(),
            calendar_id: "cal".to_string(),
            account_id: "acct".to_string(),
            status: "confirmed".to_string(),
            summary: id.to_string(),
            start_at: start.to_string(),
            start_tz: Some(zone.to_string()),
            end_at: end.to_string(),
            end_tz: Some(zone.to_string()),
            recurrence: rule.iter().map(|line| line.to_string()).collect(),
            ..Default::default()
        }
    }

    fn all_day_master(id: &str, start: &str, end: &str, rule: &[&str]) -> EventRow {
        EventRow {
            all_day: true,
            ..master(id, start, end, "America/New_York", rule)
        }
    }

    /// A moved occurrence, which carries its own times.
    fn moved(id: &str, of: &str, original_start: &str, start: &str, end: &str) -> EventRow {
        EventRow {
            recurring_event_id: Some(of.to_string()),
            original_start: Some(original_start.to_string()),
            ..master(id, start, end, "Europe/London", &[])
        }
    }

    /// Everything Google guarantees on a cancelled instance and not one field more. Any code that
    /// reads a summary or a start off one of these will fail here rather than in November.
    fn cancelled(id: &str, of: &str, original_start: &str) -> EventRow {
        EventRow {
            id: id.to_string(),
            calendar_id: "cal".to_string(),
            recurring_event_id: Some(of.to_string()),
            original_start: Some(original_start.to_string()),
            status: "cancelled".to_string(),
            ..Default::default()
        }
    }

    fn starts(instances: &[Instance]) -> Vec<&str> {
        instances.iter().map(|i| i.start.as_str()).collect()
    }

    fn expand_at(rows: &[EventRow], from: &str, to: &str, local: Tz) -> Vec<Instance> {
        expand_in(rows, ms(from), ms(to), local, &HashMap::new()).expect("expand")
    }

    #[test]
    fn a_weekly_series_drops_only_the_excluded_occurrence() {
        let rows = [master(
            "weekly",
            "2026-06-01T09:00:00+01:00",
            "2026-06-01T10:00:00+01:00",
            "Europe/London",
            &[
                "RRULE:FREQ=WEEKLY;BYDAY=MO",
                "EXDATE;TZID=Europe/London:20260615T090000",
            ],
        )];

        let found = expand_at(&rows, "2026-06-01T00:00:00+01:00", "2026-07-01T00:00:00+01:00", LONDON);

        assert_eq!(
            starts(&found),
            vec![
                "2026-06-01T09:00:00+01:00",
                "2026-06-08T09:00:00+01:00",
                "2026-06-22T09:00:00+01:00",
                "2026-06-29T09:00:00+01:00",
            ],
            "the 15th is excluded and its neighbours are not"
        );
        assert!(found.iter().all(|i| i.recurring));
        assert_eq!(
            found[1].original_start.as_deref(),
            Some("2026-06-08T09:00:00+01:00")
        );
    }

    #[test]
    fn an_exdate_without_a_zone_still_matches_its_occurrence() {
        // A floating EXDATE means the series' own zone, not the machine's, and the machine here is
        // eleven hours away from the series.
        let rows = [master(
            "weekly",
            "2026-06-01T09:00:00+01:00",
            "2026-06-01T10:00:00+01:00",
            "Europe/London",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20260615T090000"],
        )];

        let found = expand_at(
            &rows,
            "2026-06-01T00:00:00+01:00",
            "2026-07-01T00:00:00+01:00",
            Tz::Pacific__Auckland,
        );
        assert_eq!(found.len(), 4, "{:?}", starts(&found));
        assert!(!found
            .iter()
            .any(|i| i.original_start.as_deref() == Some("2026-06-15T09:00:00+01:00")));
    }

    #[test]
    fn a_monthly_by_day_series_lands_on_the_right_dates() {
        let rows = [master(
            "standup",
            "2026-01-20T09:00:00Z",
            "2026-01-20T09:30:00Z",
            "Europe/London",
            &["RRULE:FREQ=MONTHLY;BYDAY=3TU"],
        )];

        let found = expand_at(&rows, "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z", LONDON);

        let dates: Vec<String> = found.iter().map(|i| i.start[..10].to_string()).collect();
        assert_eq!(
            dates,
            vec!["2026-01-20", "2026-02-17", "2026-03-17", "2026-04-21", "2026-05-19"],
        );
        // The third Tuesday of April is in BST and the one in March is not, and both are 09:00.
        assert_eq!(found[2].start, "2026-03-17T09:00:00+00:00");
        assert_eq!(found[3].start, "2026-04-21T09:00:00+01:00");
    }

    #[test]
    fn a_weekly_series_stays_at_nine_across_a_spring_forward() {
        // New York moves to EDT at 02:00 on 8 March 2026.
        let rows = [master(
            "review",
            "2026-02-27T09:00:00-05:00",
            "2026-02-27T10:00:00-05:00",
            "America/New_York",
            &["RRULE:FREQ=WEEKLY;BYDAY=FR"],
        )];

        let found = expand_at(
            &rows,
            "2026-02-27T00:00:00-05:00",
            "2026-03-21T00:00:00-04:00",
            NEW_YORK,
        );

        assert_eq!(
            starts(&found),
            vec![
                "2026-02-27T09:00:00-05:00",
                "2026-03-06T09:00:00-05:00",
                "2026-03-13T09:00:00-04:00",
                "2026-03-20T09:00:00-04:00",
            ],
            "nine local on both sides of the transition"
        );
        // The week that swallows an hour is a real hour shorter, which is the point.
        assert_eq!(
            found[2].start_ms - found[1].start_ms,
            7 * 86_400_000 - 3_600_000
        );
        // Every occurrence keeps its hour, which is what an RRULE means.
        for instance in &found {
            assert_eq!(instance.end_ms - instance.start_ms, 3_600_000);
        }
    }

    #[test]
    fn a_spring_forward_series_holds_its_wall_clock_from_a_distant_machine() {
        let rows = [master(
            "review",
            "2026-02-27T09:00:00-05:00",
            "2026-02-27T10:00:00-05:00",
            "America/New_York",
            &["RRULE:FREQ=WEEKLY;BYDAY=FR"],
        )];

        let found = expand_at(
            &rows,
            "2026-02-27T00:00:00-05:00",
            "2026-03-21T00:00:00-04:00",
            Tz::Asia__Tokyo,
        );

        // 09:00 EST is 14:00 UTC and 09:00 EDT is 13:00 UTC, whatever the machine thinks.
        let utc: Vec<String> = found
            .iter()
            .map(|i| {
                Tz::UTC
                    .timestamp_millis_opt(i.start_ms)
                    .single()
                    .expect("an instant")
                    .format("%Y-%m-%dT%H:%M")
                    .to_string()
            })
            .collect();
        assert_eq!(
            utc,
            vec![
                "2026-02-27T14:00",
                "2026-03-06T14:00",
                "2026-03-13T13:00",
                "2026-03-20T13:00",
            ]
        );
    }

    #[test]
    fn a_weekly_series_stays_at_nine_across_a_fall_back() {
        // New York goes back to EST at 02:00 on 1 November 2026. This is the November hour.
        let rows = [master(
            "review",
            "2026-10-30T09:00:00-04:00",
            "2026-10-30T10:00:00-04:00",
            "America/New_York",
            &["RRULE:FREQ=WEEKLY;BYDAY=FR"],
        )];

        let found = expand_at(
            &rows,
            "2026-10-30T00:00:00-04:00",
            "2026-11-14T00:00:00-05:00",
            NEW_YORK,
        );

        assert_eq!(
            starts(&found),
            vec![
                "2026-10-30T09:00:00-04:00",
                "2026-11-06T09:00:00-05:00",
                "2026-11-13T09:00:00-05:00",
            ]
        );
        // The week that gains an hour is a real hour longer.
        assert_eq!(
            found[1].start_ms - found[0].start_ms,
            7 * 86_400_000 + 3_600_000
        );
    }

    #[test]
    fn an_occurrence_inside_the_repeated_hour_is_not_lost() {
        let rows = [master(
            "nightly",
            "2026-10-25T01:30:00-04:00",
            "2026-10-25T02:00:00-04:00",
            "America/New_York",
            &["RRULE:FREQ=WEEKLY;BYDAY=SU"],
        )];

        let found = expand_at(
            &rows,
            "2026-10-25T00:00:00-04:00",
            "2026-11-09T00:00:00-05:00",
            NEW_YORK,
        );

        // 1 November has two 01:30s. The occurrence takes the first and stays on the calendar.
        assert_eq!(
            starts(&found),
            vec![
                "2026-10-25T01:30:00-04:00",
                "2026-11-01T01:30:00-04:00",
                "2026-11-08T01:30:00-05:00",
            ]
        );
    }

    #[test]
    fn an_occurrence_spanning_a_transition_keeps_its_wall_clock_and_its_true_length() {
        let rows = [master(
            "vigil",
            "2026-10-25T00:30:00-04:00",
            "2026-10-25T02:00:00-04:00",
            "America/New_York",
            &["RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=2"],
        )];

        let found = expand_at(
            &rows,
            "2026-10-25T00:00:00-04:00",
            "2026-11-02T00:00:00-05:00",
            NEW_YORK,
        );

        assert_eq!(found.len(), 2);
        // Both read 00:30 to 02:00 on the wall, which is what the grid lays out against.
        for instance in &found {
            assert!(instance.start.contains("T00:30:00"), "{}", instance.start);
            assert!(instance.end.contains("T02:00:00"), "{}", instance.end);
        }
        // The one that swallows the repeated hour really is an hour longer, and the grid is
        // expected to render it at the height its wall clock says rather than compensate.
        assert_eq!(found[0].end_ms - found[0].start_ms, 90 * 60_000);
        assert_eq!(found[1].end_ms - found[1].start_ms, 150 * 60_000);
    }

    #[test]
    fn an_all_day_series_does_not_shift_a_day_from_any_machine() {
        let rows = [all_day_master(
            "holiday",
            "2026-03-05",
            "2026-03-06",
            &["RRULE:FREQ=DAILY;COUNT=5"],
        )];

        for local in [Tz::Pacific__Kiritimati, Tz::Pacific__Midway, Tz::UTC, NEW_YORK] {
            let found = expand_in(
                &rows,
                resolve(local, NaiveDate::from_ymd_opt(2026, 3, 1).unwrap().and_time(NaiveTime::MIN))
                    .timestamp_millis(),
                resolve(local, NaiveDate::from_ymd_opt(2026, 3, 15).unwrap().and_time(NaiveTime::MIN))
                    .timestamp_millis(),
                local,
                &HashMap::new(),
            )
            .expect("expand");

            assert_eq!(
                starts(&found),
                vec!["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"],
                "dates must not move in {local}"
            );
            assert!(found.iter().all(|i| i.all_day));
            assert_eq!(found[0].end, "2026-03-06", "the end date stays exclusive");

            // Pinned to local midnight, and exclusive at the end.
            for instance in &found {
                let start = resolve(
                    local,
                    NaiveDate::parse_from_str(&instance.start, "%Y-%m-%d")
                        .unwrap()
                        .and_time(NaiveTime::MIN),
                );
                assert_eq!(instance.start_ms, start.timestamp_millis(), "in {local}");
                assert!(instance.end_ms > instance.start_ms);
            }
        }
    }

    #[test]
    fn an_all_day_series_with_a_date_valued_until_still_expands() {
        // Google writes UNTIL without a zone for an all-day series, which the crate reads in the
        // machine's zone and then rejects against a zoned DTSTART unless it is normalised first.
        let rows = [all_day_master(
            "sprint",
            "2026-03-02",
            "2026-03-03",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260316"],
        )];

        let found = expand_at(&rows, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", Tz::Asia__Kolkata);
        assert_eq!(starts(&found), vec!["2026-03-02", "2026-03-09", "2026-03-16"]);
    }

    #[test]
    fn an_overridden_instance_appears_once_and_a_cancelled_one_never() {
        let rows = [
            master(
                "weekly",
                "2026-06-01T09:00:00+01:00",
                "2026-06-01T10:00:00+01:00",
                "Europe/London",
                &["RRULE:FREQ=WEEKLY;BYDAY=MO"],
            ),
            moved(
                "weekly_20260608T080000Z",
                "weekly",
                "2026-06-08T09:00:00+01:00",
                "2026-06-09T14:00:00+01:00",
                "2026-06-09T15:00:00+01:00",
            ),
            cancelled(
                "weekly_20260615T080000Z",
                "weekly",
                "2026-06-15T09:00:00+01:00",
            ),
        ];

        let found = expand_at(&rows, "2026-06-01T00:00:00+01:00", "2026-07-01T00:00:00+01:00", LONDON);

        assert_eq!(
            starts(&found),
            vec![
                "2026-06-01T09:00:00+01:00",
                "2026-06-09T14:00:00+01:00",
                "2026-06-22T09:00:00+01:00",
                "2026-06-29T09:00:00+01:00",
            ],
            "the moved one shows at its new time, at neither the old one nor the cancelled one"
        );
        let overridden = &found[1];
        assert!(overridden.recurring);
        assert_eq!(
            overridden.original_start.as_deref(),
            Some("2026-06-08T09:00:00+01:00")
        );
    }

    #[test]
    fn an_override_dragged_into_the_window_from_outside_it_still_shows() {
        let rows = [
            master(
                "weekly",
                "2026-05-04T09:00:00+01:00",
                "2026-05-04T10:00:00+01:00",
                "Europe/London",
                &["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4"],
            ),
            moved(
                "weekly_20260504T080000Z",
                "weekly",
                "2026-05-04T09:00:00+01:00",
                "2026-06-10T09:00:00+01:00",
                "2026-06-10T10:00:00+01:00",
            ),
        ];

        let found = expand_at(&rows, "2026-06-01T00:00:00+01:00", "2026-07-01T00:00:00+01:00", LONDON);
        assert_eq!(starts(&found), vec!["2026-06-10T09:00:00+01:00"]);
    }

    #[test]
    fn a_following_split_leaves_no_gap_and_no_duplicate() {
        let rows = [master(
            "weekly",
            "2026-06-01T09:00:00+01:00",
            "2026-06-01T10:00:00+01:00",
            "Europe/London",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5"],
        )];
        let key = InstanceKey {
            event_id: "weekly".to_string(),
            original_start: Some("2026-06-15T09:00:00+01:00".to_string()),
        };

        let plans = plan_edit(&rows, &key, &EventPatch::default(), Scope::Following).expect("plan");
        let (until, draft) = match &plans[..] {
            [EditPlan::Split { until, draft, .. }] => (until.clone(), draft.clone()),
            other => panic!("expected one split, got {other:?}"),
        };

        // 09:00 London on 15 June is 08:00 UTC, and the UNTIL is a second short of it.
        assert_eq!(until, "20260615T075959Z");
        assert_eq!(draft.start, "2026-06-15T09:00:00+01:00");
        assert_eq!(draft.end, "2026-06-15T10:00:00+01:00");
        assert_eq!(draft.recurrence, vec!["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3"]);

        // The two halves as the sync agent will write them back.
        let mut head = rows[0].clone();
        head.recurrence = truncate_recurrence(&head.recurrence, &until);
        assert_eq!(
            head.recurrence,
            vec!["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260615T075959Z"]
        );
        let mut tail = master(
            "weekly-2",
            &draft.start,
            &draft.end,
            "Europe/London",
            &draft.recurrence.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        tail.id = "weekly-2".to_string();

        let found = expand_at(
            &[head, tail],
            "2026-06-01T00:00:00+01:00",
            "2026-07-06T00:00:00+01:00",
            LONDON,
        );
        assert_eq!(
            starts(&found),
            vec![
                "2026-06-01T09:00:00+01:00",
                "2026-06-08T09:00:00+01:00",
                "2026-06-15T09:00:00+01:00",
                "2026-06-22T09:00:00+01:00",
                "2026-06-29T09:00:00+01:00",
            ],
            "every occurrence exactly once across the boundary"
        );
    }

    #[test]
    fn a_following_split_of_an_all_day_series_is_date_valued() {
        let rows = [all_day_master(
            "sprint",
            "2026-03-02",
            "2026-03-03",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        )];
        let key = InstanceKey {
            event_id: "sprint".to_string(),
            original_start: Some("2026-03-16".to_string()),
        };

        let plans = plan_edit(&rows, &key, &EventPatch::default(), Scope::Following).expect("plan");
        match &plans[..] {
            [EditPlan::Split { until, draft, .. }] => {
                assert_eq!(until, "20260315");
                assert!(draft.all_day);
                assert_eq!(draft.start, "2026-03-16");
                assert_eq!(draft.end, "2026-03-17");
            }
            other => panic!("expected one split, got {other:?}"),
        }
    }

    #[test]
    fn a_following_split_at_the_first_occurrence_is_the_whole_series() {
        let rows = [master(
            "weekly",
            "2026-06-01T09:00:00+01:00",
            "2026-06-01T10:00:00+01:00",
            "Europe/London",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        )];
        let key = InstanceKey {
            event_id: "weekly".to_string(),
            original_start: Some("2026-06-01T09:00:00+01:00".to_string()),
        };

        let plans = plan_edit(&rows, &key, &EventPatch::default(), Scope::Following).expect("plan");
        assert!(matches!(plans[..], [EditPlan::PatchMaster { .. }]));
        let plans = plan_delete(&rows, &key, Scope::Following).expect("plan");
        assert!(matches!(plans[..], [EditPlan::DeleteMaster { .. }]));
    }

    #[test]
    fn the_three_scopes_are_three_different_calls() {
        let rows = [master(
            "weekly",
            "2026-06-01T09:00:00+01:00",
            "2026-06-01T10:00:00+01:00",
            "Europe/London",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        )];
        let key = InstanceKey {
            event_id: "weekly".to_string(),
            original_start: Some("2026-06-15T09:00:00+01:00".to_string()),
        };
        let patch = EventPatch {
            summary: Some("moved".to_string()),
            ..Default::default()
        };

        match &plan_edit(&rows, &key, &patch, Scope::This).expect("plan")[..] {
            [EditPlan::PatchInstance {
                event_id,
                original_start,
                ..
            }] => {
                assert_eq!(event_id, "weekly", "the master, resolved through events.instances");
                assert_eq!(original_start.as_deref(), Some("2026-06-15T09:00:00+01:00"));
            }
            other => panic!("expected a patched instance, got {other:?}"),
        }
        assert!(matches!(
            plan_edit(&rows, &key, &patch, Scope::All).expect("plan")[..],
            [EditPlan::PatchMaster { .. }]
        ));
        assert!(matches!(
            plan_delete(&rows, &key, Scope::This).expect("plan")[..],
            [EditPlan::CancelInstance { .. }]
        ));
        assert!(matches!(
            plan_delete(&rows, &key, Scope::Following).expect("plan")[..],
            [EditPlan::TruncateMaster { .. }]
        ));
    }

    #[test]
    fn an_edit_reached_through_an_exception_is_planned_against_the_master() {
        let rows = [
            master(
                "weekly",
                "2026-06-01T09:00:00+01:00",
                "2026-06-01T10:00:00+01:00",
                "Europe/London",
                &["RRULE:FREQ=WEEKLY;BYDAY=MO"],
            ),
            moved(
                "weekly_20260608T080000Z",
                "weekly",
                "2026-06-08T09:00:00+01:00",
                "2026-06-09T14:00:00+01:00",
                "2026-06-09T15:00:00+01:00",
            ),
        ];
        let key = InstanceKey {
            event_id: "weekly_20260608T080000Z".to_string(),
            original_start: None,
        };

        match &plan_edit(&rows, &key, &EventPatch::default(), Scope::This).expect("plan")[..] {
            [EditPlan::PatchInstance {
                event_id,
                original_start,
                ..
            }] => {
                assert_eq!(event_id, "weekly");
                assert_eq!(original_start.as_deref(), Some("2026-06-08T09:00:00+01:00"));
            }
            other => panic!("expected a patched instance, got {other:?}"),
        }
    }

    #[test]
    fn a_one_off_ignores_the_scope_it_was_given() {
        let rows = [master(
            "lunch",
            "2026-06-01T12:00:00+01:00",
            "2026-06-01T13:00:00+01:00",
            "Europe/London",
            &[],
        )];
        let key = InstanceKey {
            event_id: "lunch".to_string(),
            original_start: None,
        };

        for scope in [Scope::This, Scope::Following, Scope::All] {
            assert!(matches!(
                plan_edit(&rows, &key, &EventPatch::default(), scope).expect("plan")[..],
                [EditPlan::PatchMaster { .. }]
            ));
            assert!(matches!(
                plan_delete(&rows, &key, scope).expect("plan")[..],
                [EditPlan::DeleteMaster { .. }]
            ));
        }
    }

    #[test]
    fn a_scoped_edit_without_an_occurrence_is_refused() {
        let rows = [master(
            "weekly",
            "2026-06-01T09:00:00+01:00",
            "2026-06-01T10:00:00+01:00",
            "Europe/London",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        )];
        let key = InstanceKey {
            event_id: "weekly".to_string(),
            original_start: None,
        };
        assert!(plan_edit(&rows, &key, &EventPatch::default(), Scope::This).is_err());
        assert!(plan_delete(&rows, &key, Scope::Following).is_err());
        assert!(plan_edit(
            &[],
            &key,
            &EventPatch::default(),
            Scope::All
        )
        .is_err());
    }

    #[test]
    fn truncating_drops_a_count_and_an_rdate_past_the_cut() {
        let lines = vec![
            "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10".to_string(),
            "RDATE:20260610T080000Z,20260710T080000Z".to_string(),
            "EXDATE;TZID=Europe/London:20260817T090000".to_string(),
        ];
        assert_eq!(
            truncate_recurrence(&lines, "20260615T075959Z"),
            vec![
                "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260615T075959Z",
                // The RDATE UNTIL cannot reach is gone; the EXDATE past the cut is harmless.
                "RDATE:20260610T080000Z",
                "EXDATE;TZID=Europe/London:20260817T090000",
            ]
        );
    }

    #[test]
    fn a_single_event_and_its_window_edges() {
        let rows = [master(
            "lunch",
            "2026-06-01T12:00:00+01:00",
            "2026-06-01T13:00:00+01:00",
            "Europe/London",
            &[],
        )];

        let inside = expand_at(&rows, "2026-06-01T00:00:00+01:00", "2026-06-02T00:00:00+01:00", LONDON);
        assert_eq!(inside.len(), 1);
        assert!(!inside[0].recurring);
        assert_eq!(inside[0].original_start, None);

        // The window opens exactly when the event ends, so it is over.
        let after = expand_at(&rows, "2026-06-01T13:00:00+01:00", "2026-06-02T00:00:00+01:00", LONDON);
        assert!(after.is_empty());

        // The window closes exactly when the event starts, so it has not begun.
        let before = expand_at(&rows, "2026-06-01T00:00:00+01:00", "2026-06-01T12:00:00+01:00", LONDON);
        assert!(before.is_empty());
    }

    #[test]
    fn an_event_running_into_the_window_from_before_it_is_kept() {
        let rows = [master(
            "overnight",
            "2026-06-01T22:00:00+01:00",
            "2026-06-02T07:00:00+01:00",
            "Europe/London",
            &["RRULE:FREQ=DAILY"],
        )];

        let found = expand_at(&rows, "2026-06-03T00:00:00+01:00", "2026-06-04T00:00:00+01:00", LONDON);
        assert_eq!(
            starts(&found),
            vec!["2026-06-02T22:00:00+01:00", "2026-06-03T22:00:00+01:00"]
        );
    }

    #[test]
    fn a_calendar_lends_its_colour_its_zone_and_its_access_role() {
        let mut row = master(
            "weekly",
            "2026-06-01T09:00:00+01:00",
            "2026-06-01T10:00:00+01:00",
            "Europe/London",
            &["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=1"],
        );
        row.start_tz = None;
        row.end_tz = None;
        let calendars = HashMap::from([(
            "cal".to_string(),
            CalendarFacts {
                color_hex: "#4285f4".to_string(),
                time_zone: "Europe/London".to_string(),
                read_only: true,
            },
        )]);

        let found = expand_in(
            &[row],
            ms("2026-06-01T00:00:00+01:00"),
            ms("2026-07-01T00:00:00+01:00"),
            Tz::Asia__Tokyo,
            &calendars,
        )
        .expect("expand");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].color_hex, "#4285f4");
        assert!(found[0].read_only);
        // The calendar's zone stands in for the missing one, so this is still 09:00 in London.
        assert_eq!(found[0].start_ms, ms("2026-06-01T09:00:00+01:00"));
    }

    #[test]
    fn attendees_survive_google_leaving_most_of_the_keys_out() {
        let json = r#"[
            {"email":"a@example.com","displayName":"A","responseStatus":"accepted","organizer":true},
            {"email":"b@example.com","responseStatus":"needsAction","self":true,"optional":true},
            {"displayName":"no address"}
        ]"#;
        let parsed = attendees(Some(json));
        assert_eq!(parsed.len(), 2, "an attendee with no address is not one");
        assert!(parsed[0].organizer && !parsed[0].optional);
        assert!(parsed[1].is_self && parsed[1].optional);
        assert_eq!(organizer(Some(json)).as_deref(), Some("a@example.com"));
        assert!(attendees(None).is_empty());
        assert!(attendees(Some("not json")).is_empty());
    }

    #[test]
    fn a_conference_is_read_down_to_its_video_entry_point() {
        let json = r#"{
            "conferenceSolution":{"key":{"type":"hangoutsMeet"},"name":"Google Meet"},
            "entryPoints":[
                {"entryPointType":"more","uri":"https://tel.meet/x"},
                {"entryPointType":"video","uri":"https://meet.google.com/abc","label":"meet.google.com/abc"}
            ]
        }"#;
        let parsed = conference(Some(json)).expect("a conference");
        assert_eq!(parsed.kind, "hangoutsMeet");
        assert_eq!(parsed.uri.as_deref(), Some("https://meet.google.com/abc"));
        assert_eq!(parsed.label.as_deref(), Some("meet.google.com/abc"));
        assert!(conference(Some("{}")).is_none());
        assert!(conference(None).is_none());
    }

    /// The public entry point, on whatever zone the machine running this happens to be in. Only
    /// facts that hold in every zone are asserted, which is the point: an instant is an instant and
    /// a date is a date.
    #[test]
    fn the_public_entry_point_agrees_wherever_it_runs() {
        let rows = [
            master(
                "review",
                "2026-03-06T09:00:00-05:00",
                "2026-03-06T10:00:00-05:00",
                "America/New_York",
                &["RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=2"],
            ),
            all_day_master("holiday", "2026-03-09", "2026-03-10", &["RRULE:FREQ=DAILY;COUNT=2"]),
        ];

        let found = expand(&rows, ms("2026-03-01T00:00:00Z"), ms("2026-03-20T00:00:00Z"))
            .expect("expand");

        let timed: Vec<i64> = found
            .iter()
            .filter(|i| !i.all_day)
            .map(|i| i.start_ms)
            .collect();
        assert_eq!(
            timed,
            vec![ms("2026-03-06T09:00:00-05:00"), ms("2026-03-13T09:00:00-04:00")],
            "nine in New York on both sides of the transition, read from anywhere"
        );

        let dates: Vec<&str> = found
            .iter()
            .filter(|i| i.all_day)
            .map(|i| i.start.as_str())
            .collect();
        assert_eq!(dates, vec!["2026-03-09", "2026-03-10"]);
    }

    #[test]
    fn a_rule_the_crate_cannot_read_costs_its_own_series_and_nothing_else() {
        let rows = [
            master(
                "broken",
                "2026-06-01T09:00:00+01:00",
                "2026-06-01T10:00:00+01:00",
                "Europe/London",
                &["RRULE:FREQ=NEVER"],
            ),
            master(
                "fine",
                "2026-06-01T11:00:00+01:00",
                "2026-06-01T12:00:00+01:00",
                "Europe/London",
                &["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=1"],
            ),
        ];

        let found = expand_at(&rows, "2026-06-01T00:00:00+01:00", "2026-06-08T00:00:00+01:00", LONDON);
        assert_eq!(starts(&found), vec!["2026-06-01T11:00:00+01:00"]);
    }
}
