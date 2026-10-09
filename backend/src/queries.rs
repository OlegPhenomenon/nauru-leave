//! Read-side queries shared by the HTTP layer. Everything here is a pure
//! read (no transactions needed) and returns plain serializable values;
//! authorization is still enforced by the caller via `authz`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use time::Date;

use crate::model::{self, date_s};
use crate::{ledger, Res};

// ------------------------------------------------------------------ schedules

/// The employee's "day unit": max non-zero weekday minutes of the schedule
/// valid on `on` (default 480 when no schedule).
pub fn minutes_per_day(conn: &Connection, employee_id: i64, on: Date) -> Res<i64> {
    let week: Option<Vec<i64>> = conn
        .query_row(
            "SELECT sv.mon_min, sv.tue_min, sv.wed_min, sv.thu_min,
                    sv.fri_min, sv.sat_min, sv.sun_min
             FROM employee_schedules es
             JOIN schedule_versions sv ON sv.schedule_id = es.schedule_id
             WHERE es.employee_id=?1 AND es.valid_from<=?2
               AND (es.valid_to IS NULL OR es.valid_to>=?2)
               AND sv.valid_from<=?2 AND (sv.valid_to IS NULL OR sv.valid_to>=?2)
             ORDER BY sv.valid_from DESC, sv.id DESC LIMIT 1",
            params![employee_id, date_s(&on)],
            |r| {
                Ok(vec![
                    r.get::<_, i64>(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ])
            },
        )
        .optional()?;
    let mpd = week.and_then(|w| w.into_iter().max()).filter(|m| *m > 0);
    Ok(mpd.unwrap_or(480))
}

// ------------------------------------------------------------------ balances

#[derive(Clone, Debug, Serialize)]
pub struct LeaveTypeRef {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub uses_balance: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct AccountRow {
    pub account_id: i64,
    pub leave_type: LeaveTypeRef,
    pub period_year: i64,
    pub ledger_minutes: i64,
    pub reserved_minutes: i64,
    pub available_minutes: i64,
    pub minutes_per_day: i64,
}

/// Reporting indicators over effective revisions of approved leave:
/// minutes on days >= `today` (upcoming) vs days < `today` (taken).
/// These are informational — the ledger is the source of truth.
pub fn report_indicators(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    today: Date,
) -> Res<(i64, i64)> {
    let (up, taken): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN rd.date >= ?3 THEN rd.minutes ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN rd.date <  ?3 THEN rd.minutes ELSE 0 END),0)
         FROM leave_requests lr
         JOIN request_revisions rr ON rr.id = lr.effective_revision_id
         JOIN request_days rd ON rd.revision_id = rr.id
         WHERE lr.employee_id=?1 AND rr.leave_type_id=?2
           AND lr.kind='leave' AND lr.status='approved' AND rd.minutes>0",
        params![employee_id, leave_type_id, date_s(&today)],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((up, taken))
}

#[derive(Clone, Debug, Serialize)]
pub struct BalanceSummaryRow {
    pub leave_type: LeaveTypeRef,
    pub ledger_minutes: i64,
    pub reserved_minutes: i64,
    pub available_minutes: i64,
    pub approved_upcoming_minutes: i64,
    pub taken_minutes: i64,
    pub minutes_per_day: i64,
    /// Demo rule labelling (DESIGN §1/§3): status + explanation of the
    /// effective policy so the UI can show the fictional-rule warning.
    pub policy: Option<PolicyRef>,
    pub accounts: Vec<AccountRow>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PolicyRef {
    pub id: i64,
    pub valid_from: String,
    pub annual_entitlement_min: i64,
    pub accrual_mode: String,
    pub advance_publish_months: i64,
    pub carryover_allowed: bool,
    pub carryover_expiry_months: Option<i64>,
    pub carryover_limit_min: Option<i64>,
    pub paid: bool,
    pub uses_balance: bool,
    pub allow_half_day: bool,
    pub requires_attachment: bool,
    pub min_notice_days: i64,
    pub allow_negative: bool,
    pub status: String,
    pub explanation: String,
}

pub fn policy_ref(conn: &Connection, leave_type_id: i64, on: Date) -> Res<Option<PolicyRef>> {
    let Some(p) = model::policy_for(conn, leave_type_id, on)? else {
        return Ok(None);
    };
    let explanation: String = conn.query_row(
        "SELECT explanation FROM policy_versions WHERE id=?1",
        [p.id],
        |r| r.get(0),
    )?;
    Ok(Some(PolicyRef {
        id: p.id,
        valid_from: date_s(&p.valid_from),
        annual_entitlement_min: p.annual_entitlement_min,
        accrual_mode: p.accrual_mode,
        advance_publish_months: p.advance_publish_months,
        carryover_allowed: p.carryover_allowed,
        carryover_expiry_months: p.carryover_expiry_months,
        carryover_limit_min: p.carryover_limit_min,
        paid: p.paid,
        uses_balance: p.uses_balance,
        allow_half_day: p.allow_half_day,
        requires_attachment: p.requires_attachment,
        min_notice_days: p.min_notice_days,
        allow_negative: p.allow_negative,
        status: p.status,
        explanation,
    }))
}

/// Balance summaries for every active leave type (accounts may be empty for
/// types the employee has never used).
pub fn balance_summaries(
    conn: &Connection,
    employee_id: i64,
    today: Date,
) -> Res<Vec<BalanceSummaryRow>> {
    let mpd = minutes_per_day(conn, employee_id, today)?;
    let mut st =
        conn.prepare("SELECT id, code, name FROM leave_types WHERE active=1 ORDER BY code")?;
    let types: Vec<(i64, String, String)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::new();
    for (lt_id, code, name) in types {
        let uses_balance = model::policy_for(conn, lt_id, today)?.is_some_and(|p| p.uses_balance);
        let mut accounts = Vec::new();
        let (mut led, mut resv, mut av) = (0i64, 0i64, 0i64);
        for b in ledger::balance_summary(conn, employee_id, lt_id, today)? {
            led += b.ledger_minutes;
            resv += b.reserved_minutes;
            av += b.available_minutes;
            accounts.push(AccountRow {
                account_id: b.account_id,
                leave_type: LeaveTypeRef {
                    id: lt_id,
                    code: code.clone(),
                    name: name.clone(),
                    uses_balance,
                },
                period_year: b.period_year,
                ledger_minutes: b.ledger_minutes,
                reserved_minutes: b.reserved_minutes,
                available_minutes: b.available_minutes,
                minutes_per_day: mpd,
            });
        }
        let (up, taken) = report_indicators(conn, employee_id, lt_id, today)?;
        out.push(BalanceSummaryRow {
            leave_type: LeaveTypeRef {
                id: lt_id,
                code,
                name,
                uses_balance,
            },
            ledger_minutes: led,
            reserved_minutes: resv,
            available_minutes: av,
            approved_upcoming_minutes: up,
            taken_minutes: taken,
            minutes_per_day: mpd,
            policy: policy_ref(conn, lt_id, today)?,
            accounts,
        });
    }
    Ok(out)
}

// ------------------------------------------------------------------ explain

#[derive(Clone, Debug, Serialize)]
pub struct LedgerEntryRow {
    pub id: i64,
    pub account_id: i64,
    pub period_year: i64,
    pub minutes: i64,
    pub kind: String,
    pub effective_date: String,
    pub basis: String,
    pub request_number: Option<String>,
    pub revision_no: Option<i64>,
    pub author_id: Option<i64>,
    pub author_name: Option<String>,
    pub created_at: String,
    pub running_total: i64,
}

/// Full ledger history of one (employee, leave_type) with a running total.
pub fn ledger_history(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    as_of: Date,
) -> Res<Vec<LedgerEntryRow>> {
    let mut st = conn.prepare(
        "SELECT le.id, le.account_id, la.period_year, le.minutes, le.kind,
                le.effective_date, le.basis, lr.number, rr.rev_no,
                le.author_user_id, u.display_name, le.created_at
         FROM ledger_entries le
         JOIN leave_accounts la ON la.id = le.account_id
         LEFT JOIN leave_requests lr ON lr.id = le.request_id
         LEFT JOIN request_revisions rr ON rr.id = le.revision_id
         LEFT JOIN users u ON u.id = le.author_user_id
         WHERE la.employee_id=?1 AND la.leave_type_id=?2 AND le.effective_date<=?3
         ORDER BY le.effective_date, le.id",
    )?;
    let rows = st.query_map(params![employee_id, leave_type_id, date_s(&as_of)], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<i64>>(8)?,
            r.get::<_, Option<i64>>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, String>(11)?,
        ))
    })?;
    let mut running = 0i64;
    let mut out = Vec::new();
    for r in rows {
        let r = r?;
        running += r.3;
        out.push(LedgerEntryRow {
            id: r.0,
            account_id: r.1,
            period_year: r.2,
            minutes: r.3,
            kind: r.4,
            effective_date: r.5,
            basis: r.6,
            request_number: r.7,
            revision_no: r.8,
            author_id: r.9,
            author_name: r.10,
            created_at: r.11,
            running_total: running,
        });
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize)]
pub struct ReservationRow {
    pub id: i64,
    pub account_id: i64,
    pub period_year: i64,
    pub minutes: i64,
    pub request_number: String,
    pub revision_no: i64,
    pub created_at: String,
}

pub fn reservations_of(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
) -> Res<Vec<ReservationRow>> {
    reservations_query(conn, employee_id, leave_type_id, None)
}

pub fn reservations_on(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    on: Date,
) -> Res<Vec<ReservationRow>> {
    reservations_query(conn, employee_id, leave_type_id, Some(on))
}

fn reservations_query(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    on: Option<Date>,
) -> Res<Vec<ReservationRow>> {
    let mut st = conn.prepare(
        "SELECT r.id, r.account_id, la.period_year, r.minutes, lr.number, rr.rev_no, r.created_at
         FROM reservations r
         JOIN leave_accounts la ON la.id = r.account_id
         JOIN leave_requests lr ON lr.id = r.request_id
         JOIN request_revisions rr ON rr.id = r.revision_id
         WHERE la.employee_id=?1 AND la.leave_type_id=?2 AND ((?3 IS NULL AND r.active=1) OR (?3 IS NOT NULL AND r.reserved_on<=?3 AND (r.released_on IS NULL OR r.released_on>?3)))
         ORDER BY r.id",
    )?;
    let rows = st.query_map(
        params![employee_id, leave_type_id, on.map(|d| date_s(&d))],
        |r| {
            Ok(ReservationRow {
                id: r.get(0)?,
                account_id: r.get(1)?,
                period_year: r.get(2)?,
                minutes: r.get(3)?,
                request_number: r.get(4)?,
                revision_no: r.get(5)?,
                created_at: r.get(6)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ------------------------------------------------------------------ calendar

#[derive(Clone, Debug)]
pub struct Absence {
    pub employee_id: i64,
    pub date: Date,
    pub part: String,
    pub state: &'static str, // 'approved' | 'pending'
    pub sensitive: bool,
    pub request_id: i64,
    pub leave_type_name: String,
    pub leave_type_code: String,
}

/// Absence days of active employees overlapping [from, to]; optional org unit
/// filter. Approved leave uses effective revisions; open leave/amendment
/// requests contribute 'pending' days from their current revision.
pub fn absence_days(
    conn: &Connection,
    org_unit_id: Option<i64>,
    from: Date,
    to: Date,
) -> Res<Vec<Absence>> {
    let mut st = conn.prepare(
        "SELECT lr.employee_id, rd.date, rd.part, lr.status,
                (lt.sensitive OR COALESCE(json_extract(rr.policy_snapshot,'$.sensitive'),0)), lr.id, lt.name, lt.code
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN request_revisions rr ON rr.id =
             CASE WHEN lr.status='approved' OR lr.status='cancelled'
                  THEN lr.effective_revision_id ELSE lr.current_revision_id END
         JOIN request_days rd ON rd.revision_id = rr.id
         JOIN leave_types lt ON lt.id = rr.leave_type_id
         WHERE (lr.kind='leave' OR (lr.kind='amendment' AND lr.status!='approved'))
           AND lr.status IN ('submitted','needs_information','under_review','approved')
           AND rd.minutes > 0 AND rd.date BETWEEN ?1 AND ?2
           AND (?3 IS NULL OR EXISTS (
                 SELECT 1 FROM employment_assignments ea
                 WHERE ea.employee_id = lr.employee_id AND ea.org_unit_id = ?3
                   AND ea.valid_from <= rd.date AND (ea.valid_to IS NULL OR ea.valid_to >= rd.date)))
         ORDER BY lr.employee_id, rd.date",
    )?;
    let rows = st.query_map(params![date_s(&from), date_s(&to), org_unit_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (emp, d, part, status, sens, rid, lt_name, lt_code) = r?;
        out.push(Absence {
            employee_id: emp,
            date: model::parse_date(&d)?,
            part,
            state: if status == "approved" {
                "approved"
            } else {
                "pending"
            },
            sensitive: sens != 0,
            request_id: rid,
            leave_type_name: lt_name,
            leave_type_code: lt_code,
        });
    }
    Ok(out)
}

// ------------------------------------------------------------------ drift

#[derive(Clone, Debug, Serialize)]
pub struct DriftRow {
    pub request_id: i64,
    pub request_number: String,
    pub employee_id: i64,
    pub employee_name: String,
    pub date: String,
    pub frozen_minutes: i64,
    pub current_minutes: i64,
}

/// Future frozen days whose stored schedule no longer matches what
/// `compute_days` would produce today (schedule version or exception changed).
pub fn schedule_drift(conn: &Connection, today: Date) -> Res<Vec<DriftRow>> {
    let mut st = conn.prepare(
        "SELECT rd.date, rd.scheduled_minutes, lr.id, lr.number,
                e.id, e.full_name,rd.schedule_version_id,rd.exception_id
         FROM request_days rd
         JOIN request_revisions rr ON rr.id = rd.revision_id
         JOIN leave_requests lr ON (lr.effective_revision_id=rr.id AND lr.kind='leave') OR (lr.current_revision_id=rr.id AND lr.status IN ('submitted','needs_information','under_review'))
         JOIN employees e ON e.id = lr.employee_id
         WHERE rd.date >= ?1
           AND ((lr.status IN ('submitted','needs_information','under_review') AND rr.id=lr.current_revision_id)
                OR (lr.status='approved' AND lr.kind='leave' AND rr.id = lr.effective_revision_id))
         ORDER BY rd.date",
    )?;
    let rows = st.query_map(params![date_s(&today)], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<i64>>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (d, frozen, rid, num, eid, ename, frozen_version, frozen_exception) = r?;
        let date = model::parse_date(&d)?;
        let cur = crate::calendar::snapshot_on(conn, eid, date)?;
        if cur.2 != frozen || cur.0 != frozen_version || cur.1 != frozen_exception {
            out.push(DriftRow {
                request_id: rid,
                request_number: num,
                employee_id: eid,
                employee_name: ename,
                date: d,
                frozen_minutes: frozen,
                current_minutes: cur.2,
            });
        }
    }
    Ok(out)
}

/// Requests whose future days would be affected by a schedule/exception
/// change (the `affected_future_requests` list on settings mutations).
pub fn affected_future_requests(
    conn: &Connection,
    employee_id: Option<i64>,
    from: Date,
) -> Res<Vec<(i64, String)>> {
    let mut st = conn.prepare(
        "SELECT DISTINCT lr.id, lr.number
         FROM leave_requests lr
         JOIN request_revisions rr ON rr.id =
             CASE WHEN lr.status IN ('approved','cancelled') THEN lr.effective_revision_id
                  ELSE lr.current_revision_id END
         JOIN request_days rd ON rd.revision_id = rr.id
         WHERE rd.date >= ?1
           AND lr.status IN ('submitted','needs_information','under_review','approved')
           AND (?2 IS NULL OR lr.employee_id = ?2)
         ORDER BY lr.id",
    )?;
    let rows = st.query_map(params![date_s(&from), employee_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ------------------------------------------------------------------ reports

/// Balance report at a date: one row per employee x leave type with an
/// account (or all types for the employee, zeroed).
pub fn report_balances(
    conn: &Connection,
    on: Date,
    org_unit_id: Option<i64>,
) -> Res<Vec<serde_json::Value>> {
    let mut emps = conn.prepare(
        "SELECT e.id, e.service_id, e.full_name FROM employees e
         WHERE e.active=1
           AND (?1 IS NULL OR EXISTS (
                 SELECT 1 FROM employment_assignments ea
                 WHERE ea.employee_id=e.id AND ea.org_unit_id=?1
                   AND ea.valid_from<=?2 AND (ea.valid_to IS NULL OR ea.valid_to>=?2)))
         ORDER BY e.service_id",
    )?;
    let emps: Vec<(i64, String, String)> = emps
        .query_map(params![org_unit_id, date_s(&on)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::new();
    for (eid, sid, name) in emps {
        let summaries = balance_summaries(conn, eid, on)?;
        for s in summaries {
            if s.accounts.is_empty() {
                continue;
            }
            out.push(serde_json::json!({
                "service_id": sid, "employee": name,
                "leave_type_code": s.leave_type.code,
                "leave_type": s.leave_type.name,
                "ledger_minutes": s.ledger_minutes,
                "reserved_minutes": s.reserved_minutes,
                "available_minutes": s.available_minutes,
            }));
        }
    }
    Ok(out)
}

/// Approved absences in [from, to] with totals.
pub fn report_absences(
    conn: &Connection,
    from: Date,
    to: Date,
    org_unit_id: Option<i64>,
) -> Res<serde_json::Value> {
    let days = absence_days(conn, org_unit_id, from, to)?
        .into_iter()
        .filter(|a| a.state == "approved")
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    let mut total_minutes = 0i64;
    for a in &days {
        let emp = model::load_employee(conn, a.employee_id)?;
        let req = model::load_request(conn, a.request_id)?;
        let minutes: i64 = conn.query_row(
            "SELECT minutes FROM request_days WHERE revision_id=?1 AND date=?2",
            params![req.effective_revision_id.unwrap_or(0), date_s(&a.date)],
            |r| r.get(0),
        )?;
        total_minutes += minutes;
        rows.push(serde_json::json!({
            "date": date_s(&a.date),
            "employee_service_id": emp.service_id,
            "employee": emp.full_name,
            "leave_type": if a.sensitive { "Away" } else { a.leave_type_name.as_str() },
            "leave_type_code": if a.sensitive { serde_json::Value::Null } else { serde_json::Value::String(a.leave_type_code.clone()) },
            "part": a.part,
            "minutes": minutes,
            "request_id": a.request_id,
            "request_number": req.number,
        }));
    }
    Ok(serde_json::json!({
        "from": date_s(&from), "to": date_s(&to),
        "total_days": days.len(), "total_minutes": total_minutes,
        "rows": rows,
    }))
}

/// Open requests awaiting action, with age in business days.
pub fn report_pending(conn: &Connection, today: Date) -> Res<Vec<serde_json::Value>> {
    let mut st = conn.prepare(
        "SELECT lr.id, lr.number, lr.status, lr.updated_at, e.service_id, e.full_name,
                (SELECT s.kind FROM approval_steps s
                  WHERE s.request_id=lr.id AND s.status='pending' ORDER BY s.seq LIMIT 1)
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         WHERE lr.status IN ('submitted','needs_information','under_review')
         ORDER BY lr.updated_at",
    )?;
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (id, number, status, updated, sid, name, step) = r?;
        let upd_date = model::parse_date(&updated[..10]).unwrap_or(today);
        out.push(serde_json::json!({
            "request_id": id, "request_number": number, "status": status,
            "employee_service_id": sid, "employee": name,
            "pending_step": step,
            "updated_at": updated,
            "age_days": (today - upd_date).whole_days(),
        }));
    }
    Ok(out)
}

// ------------------------------------------------------------------ adjustments

pub fn list_adjustments(
    conn: &Connection,
    status: Option<&str>,
    as_of: Date,
) -> Res<Vec<serde_json::Value>> {
    let mut st = conn.prepare(
        "SELECT a.id, a.account_id, a.minutes, a.reason, a.basis_document, a.request_id,
                a.status, a.proposed_by, a.proposed_at, a.decided_by, a.decided_at,
                a.decision_note, la.employee_id, la.leave_type_id, la.period_year
         FROM adjustments a JOIN leave_accounts la ON la.id = a.account_id
         WHERE (?1 IS NULL OR a.status=?1) ORDER BY a.id DESC",
    )?;
    let rows = st.query_map(params![status], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, Option<i64>>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, Option<String>>(11)?,
            r.get::<_, i64>(12)?,
            r.get::<_, i64>(13)?,
            r.get::<_, i64>(14)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let r = r?;
        let before = ledger::balance_at(conn, r.1, as_of)?;
        let emp = model::load_employee(conn, r.12)?;
        let lt = model::load_leave_type(conn, r.13)?;
        let name = |uid: Option<i64>| -> Res<Option<String>> {
            uid.map(|u| model::load_user(conn, u).map(|x| x.display_name))
                .transpose()
        };
        out.push(serde_json::json!({
            "id": r.0,
            "employee": { "id": emp.id, "service_id": emp.service_id, "full_name": emp.full_name },
            "leave_type": { "id": lt.id, "code": lt.code, "name": lt.name },
            "period_year": r.14,
            "minutes": r.2,
            "reason": r.3,
            "basis_document": r.4,
            "request_id": r.5,
            "status": r.6,
            "balance_before": before,
            "balance_after_if_applied": before + r.2,
            "proposed_by": r.7,
            "proposed_by_name": name(Some(r.7))?,
            "proposed_at": r.8,
            "decided_by": r.9,
            "decided_by_name": name(r.9)?,
            "decided_at": r.10,
            "decision_note": r.11,
            "created_at": r.8,
        }));
    }
    Ok(out)
}
