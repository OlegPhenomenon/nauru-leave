//! Day computation per DESIGN §2 and absence-overlap detection.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use time::Date;

use crate::error::DomainError;
use crate::model::{self, Part};
use crate::Res;

/// One computed day of a request (the snapshot later stored in request_days).
#[derive(Clone, Debug, Serialize)]
pub struct ComputedDay {
    pub date: Date,
    /// full | am | pm | none (none = non-working day inside the range)
    pub part: String,
    pub scheduled_minutes: i64,
    pub minutes: i64,
    pub period_year: i64,
    pub schedule_version_id: Option<i64>,
    pub exception_id: Option<i64>,
    pub explanation: String,
}

/// `compute_days(employee, leave_type, start, end, start_part, end_part)`
/// per DESIGN §2. Errors: `no_schedule`, `validation` (bad range / half days
/// not allowed).
pub fn compute_days(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    start: Date,
    end: Date,
    start_part: Part,
    end_part: Part,
) -> Res<Vec<ComputedDay>> {
    compute_days_on(
        conn,
        employee_id,
        leave_type_id,
        start,
        end,
        start_part,
        end_part,
        start,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn compute_days_on(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    start: Date,
    end: Date,
    start_part: Part,
    end_part: Part,
    on: Date,
) -> Res<Vec<ComputedDay>> {
    if end < start {
        return Err(DomainError::validation("end_date before start_date"));
    }
    let lt = model::leave_type_on(conn, leave_type_id, on)?;

    let mut out = Vec::new();
    let mut d = start;
    while d <= end {
        let (version_id, sched_name, scheduled) = schedule_on(conn, employee_id, d)?;
        let (exception_id, exception_name, scheduled) =
            apply_exception(conn, version_id, d, scheduled)?;

        let mut part = "full".to_string();
        let mut minutes = scheduled;
        if scheduled == 0 {
            part = "none".to_string();
            minutes = 0;
        } else {
            // Day-part halving (§2.4).
            let half = if start == end {
                start_part != Part::Full
            } else {
                (d == start && start_part == Part::Pm) || (d == end && end_part == Part::Am)
            };
            if half {
                if !lt.allow_half_day {
                    return Err(DomainError::validation(format!(
                        "leave type {} does not allow half days",
                        lt.code
                    )));
                }
                minutes = scheduled / 2;
                part = if start == end {
                    start_part.as_str().to_string()
                } else if d == start {
                    "pm".to_string()
                } else {
                    "am".to_string()
                };
            }
        }

        let explanation = explain(d, scheduled, &part, minutes, &sched_name, &exception_name);
        out.push(ComputedDay {
            date: d,
            part,
            scheduled_minutes: scheduled,
            minutes,
            period_year: d.year() as i64,
            schedule_version_id: version_id,
            exception_id,
            explanation,
        });
        d = d
            .next_day()
            .ok_or_else(|| DomainError::validation("date overflow"))?;
    }

    // Reject a range that contains no working time at all.
    if !out.iter().any(|x| x.minutes > 0) {
        return Err(DomainError::validation("range contains no working days"));
    }
    Ok(out)
}

/// (schedule_version_id, schedule_name, weekday minutes) for `d` —
/// what the *current* schedule says. Used by the schedule-drift report to
/// compare against frozen request days.
pub fn scheduled_on(
    conn: &Connection,
    employee_id: i64,
    d: Date,
) -> Res<(Option<i64>, String, i64)> {
    let (version, name, minutes) = schedule_on(conn, employee_id, d)?;
    let (_, _, minutes) = apply_exception(conn, version, d, minutes)?;
    Ok((version, name, minutes))
}

/// Current schedule/exception identifiers and minutes, compared with a frozen day snapshot.
pub fn snapshot_on(
    conn: &Connection,
    employee_id: i64,
    d: Date,
) -> Res<(Option<i64>, Option<i64>, i64)> {
    let (version, _, minutes) = schedule_on(conn, employee_id, d)?;
    let (exception, _, minutes) = apply_exception(conn, version, d, minutes)?;
    Ok((version, exception, minutes))
}

/// (schedule_version_id, schedule_name, weekday minutes) for `d`.
fn schedule_on(conn: &Connection, employee_id: i64, d: Date) -> Res<(Option<i64>, String, i64)> {
    let row = conn
        .query_row(
            "SELECT sv.id, s.name, sv.mon_min, sv.tue_min, sv.wed_min, sv.thu_min,
                    sv.fri_min, sv.sat_min, sv.sun_min
             FROM employee_schedules es
             JOIN schedule_versions sv ON sv.schedule_id = es.schedule_id
             JOIN schedules s ON s.id = es.schedule_id
             WHERE es.employee_id=?1 AND es.valid_from<=?2
               AND (es.valid_to IS NULL OR es.valid_to>=?2)
               AND sv.valid_from<=?2 AND (sv.valid_to IS NULL OR sv.valid_to>=?2)
             ORDER BY es.valid_from DESC, sv.valid_from DESC LIMIT 1",
            params![employee_id, model::date_s(&d)],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    vec![
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, i64>(8)?,
                    ],
                ))
            },
        )
        .ok();
    match row {
        Some((vid, name, week)) => {
            let idx = match d.weekday() {
                time::Weekday::Monday => 0,
                time::Weekday::Tuesday => 1,
                time::Weekday::Wednesday => 2,
                time::Weekday::Thursday => 3,
                time::Weekday::Friday => 4,
                time::Weekday::Saturday => 5,
                time::Weekday::Sunday => 6,
            };
            Ok((Some(vid), name, week[idx]))
        }
        None => Err(DomainError::NoSchedule {
            employee_id,
            date: model::date_s(&d),
        }),
    }
}

/// Apply a calendar exception if one exists for `d` — schedule-specific first,
/// then the global row (schedule_id IS NULL).
fn apply_exception(
    conn: &Connection,
    schedule_version_id: Option<i64>,
    d: Date,
    scheduled: i64,
) -> Res<(Option<i64>, Option<String>, i64)> {
    let schedule_id = match schedule_version_id {
        Some(v) => conn.query_row(
            "SELECT schedule_id FROM schedule_versions WHERE id=?1",
            [v],
            |r| r.get::<_, i64>(0),
        )?,
        None => return Ok((None, None, scheduled)),
    };
    let row = conn
        .query_row(
            "SELECT id, name, minutes FROM calendar_exceptions
             WHERE revoked_at IS NULL AND date=?1 AND (schedule_id=?2 OR schedule_id IS NULL)
             ORDER BY (schedule_id IS NULL), id LIMIT 1",
            params![model::date_s(&d), schedule_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .ok();
    match row {
        Some((id, name, minutes)) => Ok((Some(id), Some(name), minutes)),
        None => Ok((None, None, scheduled)),
    }
}

fn explain(
    d: Date,
    scheduled: i64,
    part: &str,
    minutes: i64,
    sched_name: &str,
    exception: &Option<String>,
) -> String {
    if let Some(name) = exception {
        if scheduled == 0 {
            return format!("Holiday: {name}");
        }
        return format!(
            "{}, {minutes} min (exception: {name})",
            model::weekday_short(d)
        );
    }
    if scheduled == 0 {
        return format!("{} — non-working", model::weekday_long(d));
    }
    let half = if part == "am" || part == "pm" {
        format!(" {part} half")
    } else {
        String::new()
    };
    format!(
        "{}, {minutes} min ({sched_name}{half})",
        model::weekday_short(d)
    )
}

// ------------------------------------------------------------------ overlap

/// A conflicting absence day of the same employee.
#[derive(Clone, Debug)]
pub struct OverlapHit {
    pub request_id: i64,
    pub request_number: String,
    pub date: Date,
}

/// Find the first overlap between `days` and the employee's active absences
/// (DESIGN §2 / L05). `full` overlaps everything; am vs pm does not.
/// `exclude_request_id` is skipped (its parent too) so a change never
/// conflicts with itself.
pub fn find_overlap(
    conn: &Connection,
    employee_id: i64,
    days: &[ComputedDay],
    exclude_request_ids: &[i64],
) -> Res<Option<OverlapHit>> {
    let mut blockers: BTreeMap<String, Vec<(String, i64, String)>> = BTreeMap::new();

    // Candidate requests: open leave/amendment (current revision) and
    // approved leave (effective revision).
    let mut st = conn.prepare(
        "SELECT lr.id, lr.number, lr.status, lr.current_revision_id, lr.effective_revision_id
         FROM leave_requests lr
         WHERE lr.employee_id=?1
           AND (
             (lr.kind IN ('leave','amendment')
               AND lr.status IN ('submitted','needs_information','under_review'))
             OR (lr.kind='leave' AND lr.status='approved')
           )",
    )?;
    let rows = st.query_map(params![employee_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<i64>>(4)?,
        ))
    })?;

    for row in rows {
        let (rid, number, status, cur, eff) = row?;
        if exclude_request_ids.contains(&rid) {
            continue;
        }
        let rev = if status == "approved" { eff } else { cur };
        let Some(rev_id) = rev else { continue };
        for day in model::revision_days(conn, rev_id)? {
            if day.part == "none" || day.minutes <= 0 {
                continue;
            }
            blockers.entry(model::date_s(&day.date)).or_default().push((
                day.part,
                rid,
                number.clone(),
            ));
        }
    }

    for d in days {
        if d.part == "none" || d.minutes <= 0 {
            continue;
        }
        let ds = model::date_s(&d.date);
        if let Some(blockers) = blockers.get(&ds) {
            for (part, rid, number) in blockers {
                let new_part = Part::parse(&d.part).unwrap_or(Part::Full);
                let old_part = Part::parse(part).unwrap_or(Part::Full);
                if new_part.overlaps(&old_part) {
                    return Ok(Some(OverlapHit {
                        request_id: *rid,
                        request_number: number.clone(),
                        date: d.date,
                    }));
                }
            }
        }
    }
    Ok(None)
}

/// Convenience wrapper: run compute_days and raise `overlap` if needed.
/// `exclude` lists request ids to ignore — the request itself and, for
/// amendments/cancellations, its parent (a change never fights itself).
#[allow(clippy::too_many_arguments)]
pub fn compute_checked(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    start: Date,
    end: Date,
    start_part: Part,
    end_part: Part,
    exclude: &[i64],
) -> Res<Vec<ComputedDay>> {
    compute_checked_on(
        conn,
        employee_id,
        leave_type_id,
        start,
        end,
        start_part,
        end_part,
        exclude,
        start,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn compute_checked_on(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    start: Date,
    end: Date,
    start_part: Part,
    end_part: Part,
    exclude: &[i64],
    on: Date,
) -> Res<Vec<ComputedDay>> {
    let days = compute_days_on(
        conn,
        employee_id,
        leave_type_id,
        start,
        end,
        start_part,
        end_part,
        on,
    )?;
    if let Some(hit) = find_overlap(conn, employee_id, &days, exclude)? {
        return Err(DomainError::Overlap(format!(
            "part '{}' on {} (request {})",
            days.iter()
                .find(|d| d.date == hit.date)
                .map(|d| d.part.as_str())
                .unwrap_or("full"),
            model::date_s(&hit.date),
            hit.request_number,
        )));
    }
    Ok(days)
}
