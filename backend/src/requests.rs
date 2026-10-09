//! Request lifecycle (DESIGN §4–§5): drafts, submit, the 3-step route,
//! needs_information / respond / revise, withdraw, amendment, cancellation,
//! reassign, actual-period confirm/adjust, paper requests, attachments,
//! expected_version checks and Idempotency-Key helpers.
//!
//! Every mutating call runs inside `db::write_tx` (BEGIN IMMEDIATE) and writes
//! audit + outbox notifications in the same transaction. Submitted revisions
//! are immutable: a change always produces a NEW revision.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::Date;

use crate::audit;
use crate::authz::{self, Action, Actor, AttachmentCtx, RequestCtx, Resource};
use crate::calendar::{self, ComputedDay};
use crate::clock::Clock;
use crate::error::DomainError;
use crate::files::{self, FileStore};
use crate::ledger::{self, DayAllocation};
use crate::model::{
    self, date_s, LeaveRequest, Part, RequestKind, RequestStatus, Revision, Step, StepKind,
};
use crate::notify;
use crate::Res;

// ------------------------------------------------------------------ inputs

/// Fields of a draft (and of a material revision).
#[derive(Clone, Debug)]
pub struct DraftInput {
    /// HR only (paper entry); None = the actor's own employee record.
    pub employee_id: Option<i64>,
    pub leave_type_id: i64,
    pub start_date: Date,
    pub end_date: Date,
    pub start_part: Part,
    pub end_part: Part,
    pub note: Option<String>,
    /// `source='paper'`: entered by HR on behalf of the employee.
    pub paper: bool,
    pub paper_received_date: Option<Date>,
    /// Link to a rejected/withdrawn request this one supersedes.
    pub previous_request_id: Option<i64>,
}

/// A material change inside `respond` (dates/type/parts) — restarts the route.
#[derive(Clone, Debug)]
pub struct ReviseInput {
    pub leave_type_id: i64,
    pub start_date: Date,
    pub end_date: Date,
    pub start_part: Part,
    pub end_part: Part,
    pub note: Option<String>,
    pub change_reason: String,
}

/// What `submit` reports (also the stored idempotent response).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Submitted {
    pub request_id: i64,
    pub number: String,
    pub version: i64,
}

/// Outcome payload of amend/cancel (idempotent response).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChildCreated {
    pub request_id: i64,
    pub number: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Warn {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    pub details: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct BalanceAfter {
    pub period_year: i64,
    pub available_before: i64,
    pub available_after: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RouteStep {
    pub kind: String,
    /// "Olga Berg" / "Any HR officer" / NULL when unassigned.
    pub who: Option<String>,
    pub problem: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub days: Vec<ComputedDay>,
    pub total_minutes: i64,
    pub allocations: Vec<DayAllocationView>,
    pub balance_after: Vec<BalanceAfter>,
    pub route: Vec<RouteStep>,
    pub warnings: Vec<Warn>,
    /// Errors that block submit (no_schedule, overlap, insufficient_balance…).
    pub errors: Vec<PreviewError>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DayAllocationView {
    pub date: String,
    pub account_id: i64,
    pub period_year: i64,
    pub minutes: i64,
    pub carryover: bool,
}

// ------------------------------------------------------------------ helpers

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Look up a stored idempotent response. `Ok(Some(json))` = replay it;
/// key reuse with a different body is a 422.
fn idem_check(
    conn: &Connection,
    user_id: i64,
    key: Option<&str>,
    request_hash: &str,
) -> Res<Option<String>> {
    let Some(key) = key else { return Ok(None) };
    let row = conn
        .query_row(
            "SELECT request_hash, response_json FROM idempotency_keys
             WHERE user_id=?1 AND key=?2",
            params![user_id, key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((h, resp)) => {
            if h == request_hash {
                Ok(Some(resp))
            } else {
                Err(DomainError::IdempotencyKeyReused)
            }
        }
    }
}

fn idem_store(
    conn: &Connection,
    user_id: i64,
    key: Option<&str>,
    request_hash: &str,
    response_json: &str,
    now_ts: &str,
) -> Res<()> {
    if let Some(key) = key {
        conn.execute(
            "INSERT OR IGNORE INTO idempotency_keys(key, user_id, request_hash, response_json, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![key, user_id, request_hash, response_json, now_ts],
        )?;
    }
    Ok(())
}

/// Facts authz needs about a request.
pub fn request_ctx(conn: &Connection, req: &LeaveRequest, today: Date) -> Res<RequestCtx> {
    let emp = model::load_employee(conn, req.employee_id)?;
    let org_unit_id = model::unit_of(conn, req.employee_id, today)?;
    let revision_id = if req.kind == RequestKind::Leave
        && matches!(
            req.status,
            RequestStatus::Approved | RequestStatus::Cancelled
        ) {
        req.effective_revision_id
    } else {
        req.current_revision_id
    };
    let sensitive = match revision_id {
        Some(r) => model::revision_leave_type(conn, r)?.sensitive,
        None => false,
    };
    Ok(RequestCtx {
        id: req.id,
        employee_id: req.employee_id,
        employee_user_id: emp.user_id,
        entered_by_user_id: req.entered_by_user_id,
        org_unit_id,
        sensitive_type: sensitive,
        kind: req.kind.as_str().to_string(),
        status: req.status.as_str().to_string(),
    })
}

/// Authz context for an attachment (permission re-checked at request time).
pub fn attachment_ctx(conn: &Connection, attachment_id: i64, today: Date) -> Res<AttachmentCtx> {
    let a = conn
        .query_row(
            "SELECT id, request_id, uploaded_by, sensitivity, scan_status
             FROM attachments WHERE id=?1",
            [attachment_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| DomainError::not_found(format!("attachment {attachment_id}")))?;
    let req = model::load_request(conn, a.1)?;
    Ok(AttachmentCtx {
        id: a.0,
        request: request_ctx(conn, &req, today)?,
        uploaded_by: a.2,
        sensitivity: a.3,
        scan_status: a.4,
    })
}

/// Resolve the employee of a new draft + enforce self vs paper rules.
fn resolve_employee(
    conn: &Connection,
    actor: &Actor,
    input: &DraftInput,
) -> Res<(i64, &'static str)> {
    let own = actor.employee_id;
    let target = input
        .employee_id
        .or(own)
        .ok_or_else(|| DomainError::forbidden("no employee record linked to this account"))?;
    let unit = model::unit_of(conn, target, actor.today)?;
    if Some(target) == own {
        if input.paper {
            // HR may file a paper request even for themselves.
            authz::require(
                conn,
                actor,
                Action::CreatePaper,
                &Resource::Employee {
                    employee_id: target,
                    org_unit_id: unit,
                },
            )?;
            return Ok((target, "paper"));
        }
        authz::require(conn, actor, Action::CreateDraft, &Resource::Global)?;
        Ok((target, "self"))
    } else {
        if !input.paper {
            return Err(DomainError::forbidden(
                "requests for another employee need source=paper",
            ));
        }
        authz::require(
            conn,
            actor,
            Action::CreatePaper,
            &Resource::Employee {
                employee_id: target,
                org_unit_id: unit,
            },
        )?;
        Ok((target, "paper"))
    }
}

fn validate_range(
    conn: &Connection,
    leave_type_id: i64,
    start: Date,
    end: Date,
    start_part: Part,
    end_part: Part,
) -> Res<()> {
    let lt = model::load_leave_type(conn, leave_type_id)?;
    if !lt.active {
        return Err(DomainError::validation(format!(
            "leave type {} is inactive",
            lt.code
        )));
    }
    if end < start {
        return Err(DomainError::validation("end_date before start_date"));
    }
    if start == end && start_part != end_part {
        return Err(DomainError::validation(
            "single-day request: start_part and end_part must match",
        ));
    }
    Ok(())
}

fn validate_change_input(
    conn: &Connection,
    attachment_request: i64,
    input: &ReviseInput,
    today: Date,
) -> Res<()> {
    validate_range(
        conn,
        input.leave_type_id,
        input.start_date,
        input.end_date,
        input.start_part,
        input.end_part,
    )?;
    let lt = model::leave_type_on(conn, input.leave_type_id, today)?;
    if lt.requires_attachment {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM attachments WHERE request_id=?1 OR request_id=(SELECT parent_request_id FROM leave_requests WHERE id=?1)", [attachment_request], |r| r.get(0))?;
        if count == 0 {
            return Err(DomainError::validation(format!(
                "{} requires an attachment",
                lt.code
            )));
        }
    }
    Ok(())
}

/// Past days in force must stay identical; corrections follow the HR adjustment route.
fn validate_past_change(
    conn: &Connection,
    effective_revision: i64,
    new_type: i64,
    days: &[ComputedDay],
    today: Date,
) -> Res<()> {
    let old = model::load_revision(conn, effective_revision)?;
    let old_days = model::revision_days(conn, effective_revision)?;
    let old_past: BTreeMap<_, _> = old_days
        .iter()
        .filter(|d| d.date < today && d.minutes > 0)
        .map(|d| (d.date, (d.part.as_str(), d.minutes)))
        .collect();
    let new_past: BTreeMap<_, _> = days
        .iter()
        .filter(|d| d.date < today && d.minutes > 0)
        .map(|d| (d.date, (d.part.as_str(), d.minutes)))
        .collect();
    if old_past != new_past || (!old_past.is_empty() && old.leave_type_id != new_type) {
        return Err(DomainError::PastDatesNeedHrCorrection);
    }
    Ok(())
}

/// Next request number `NLD-<year>-<5 digits>` (year = business year).
fn next_number(conn: &Connection, today: Date) -> Res<String> {
    let prefix = format!("NLD-{}-", today.year());
    let like = format!("{prefix}%");
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(CAST(substr(number, ?2) AS INTEGER)) FROM leave_requests
         WHERE number LIKE ?1",
        params![like, prefix.len() as i64 + 1],
        |r| r.get(0),
    )?;
    Ok(format!("{prefix}{:05}", max.unwrap_or(0) + 1))
}

/// Insert the computed day rows for a revision; returns new day ids in order.
fn store_days(conn: &Connection, revision_id: i64, days: &[ComputedDay]) -> Res<Vec<i64>> {
    let mut ids = Vec::with_capacity(days.len());
    for d in days {
        let id = conn.query_row(
            "INSERT INTO request_days
             (revision_id, date, part, scheduled_minutes, minutes,
              schedule_version_id, exception_id, period_year, explanation)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) RETURNING id",
            params![
                revision_id,
                date_s(&d.date),
                d.part,
                d.scheduled_minutes,
                d.minutes,
                d.schedule_version_id,
                d.exception_id,
                d.period_year,
                d.explanation
            ],
            |r| r.get(0),
        )?;
        ids.push(id);
    }
    Ok(ids)
}

/// Persist allocation rows (day_index → day_id).
fn store_allocations(
    conn: &Connection,
    revision_id: i64,
    day_ids: &[i64],
    allocs: &[DayAllocation],
) -> Res<()> {
    for a in allocs {
        conn.execute(
            "INSERT INTO revision_allocations(revision_id, day_id, account_id, minutes)
             VALUES (?1,?2,?3,?4)",
            params![revision_id, day_ids[a.day_index], a.account_id, a.minutes],
        )?;
    }
    Ok(())
}

fn alloc_totals(allocs: &[DayAllocation]) -> BTreeMap<i64, i64> {
    let mut t = BTreeMap::new();
    for a in allocs {
        *t.entry(a.account_id).or_default() += a.minutes;
    }
    t
}

/// Create one reservation row per (account, minutes>0).
fn create_reservations(
    conn: &Connection,
    request_id: i64,
    revision_id: i64,
    totals: &BTreeMap<i64, i64>,
    now_ts: &str,
    today: Date,
) -> Res<()> {
    for (acc, minutes) in totals {
        if *minutes > 0 {
            ledger::create_reservation(
                conn,
                request_id,
                revision_id,
                *acc,
                *minutes,
                now_ts,
                today,
            )?;
        }
    }
    Ok(())
}

/// Create the standard 3-step route. Step 1 = manager (assignee set when the
/// employee has a manager with a login), steps 2–3 wait.
fn create_route(
    conn: &Connection,
    request_id: i64,
    revision_id: i64,
    employee_id: i64,
    today: Date,
    now_ts: &str,
) -> Res<()> {
    let manager_user = model::manager_at(conn, employee_id, today)?.and_then(|m| m.user_id);
    for (seq, kind, status, assignee) in [
        (
            1i64,
            StepKind::ManagerRecommendation,
            "pending",
            manager_user,
        ),
        (2, StepKind::HrCheck, "waiting", None),
        (3, StepKind::FinalDecision, "waiting", None),
    ] {
        conn.execute(
            "INSERT INTO approval_steps(request_id, revision_id, seq, kind, assignee_user_id, status, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![request_id, revision_id, seq, kind.as_str(), assignee, status, now_ts],
        )?;
    }
    Ok(())
}

fn notify_employee(
    conn: &Connection,
    req: &LeaveRequest,
    revision_id: i64,
    event: &str,
    subject: &str,
    body: &str,
    now_ts: &str,
) -> Res<()> {
    if let Some(r) = notify::recipient_for_employee(conn, req.employee_id)? {
        notify::enqueue(conn, now_ts, event, req.id, revision_id, &r, subject, body)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn notify_user(
    conn: &Connection,
    req: &LeaveRequest,
    revision_id: i64,
    event: &str,
    user_id: i64,
    subject: &str,
    body: &str,
    now_ts: &str,
) -> Res<()> {
    if let Some(r) = notify::recipient_for_user(conn, user_id)? {
        notify::enqueue(conn, now_ts, event, req.id, revision_id, &r, subject, body)?;
    }
    Ok(())
}

fn subject_for(number: &str) -> String {
    format!("Leave request {number}: update")
}

// ------------------------------------------------------------------ drafts

/// Create a draft request (own, or paper entry by HR). The revision row holds
/// the input; days/allocations are only frozen at submit.
pub fn create_draft(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    input: &DraftInput,
) -> Res<i64> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let (employee_id, source) = resolve_employee(tx, actor, input)?;
        validate_range(
            tx,
            input.leave_type_id,
            input.start_date,
            input.end_date,
            input.start_part,
            input.end_part,
        )?;
        if source == "paper" && input.paper_received_date.is_none() {
            return Err(DomainError::validation(
                "paper request needs paper_received_date",
            ));
        }
        let id: i64 = tx.query_row(
            "INSERT INTO leave_requests
             (number, employee_id, kind, status, source, paper_received_date,
              entered_by_user_id, previous_request_id, version, created_at, updated_at)
             VALUES ('DRAFT', ?1, 'leave', 'draft', ?2, ?3, ?4, ?5, 1, ?6, ?6)
             RETURNING id",
            params![
                employee_id,
                source,
                input.paper_received_date.map(|d| date_s(&d)),
                actor.user_id,
                input.previous_request_id,
                now_ts
            ],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE leave_requests SET number=?2 WHERE id=?1",
            params![id, format!("DRAFT-{id}")],
        )?;
        let rev_id: i64 = tx.query_row(
            "INSERT INTO request_revisions
             (request_id, rev_no, leave_type_id, start_date, end_date,
              start_part, end_part, note, total_minutes, created_by, created_at)
             VALUES (?1,1,?2,?3,?4,?5,?6,?7,0,?8,?9) RETURNING id",
            params![
                id,
                input.leave_type_id,
                date_s(&input.start_date),
                date_s(&input.end_date),
                input.start_part.as_str(),
                input.end_part.as_str(),
                input.note,
                actor.user_id,
                now_ts
            ],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE leave_requests SET current_revision_id=?2 WHERE id=?1",
            params![id, rev_id],
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.create",
            "request",
            Some(id),
            serde_json::json!({"employee_id": employee_id, "source": source}),
        )?;
        Ok(id)
    })
}

/// Edit a draft (replaces the draft revision's fields).
pub fn update_draft(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    input: &DraftInput,
    expected_version: i64,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        if req.status != RequestStatus::Draft || req.kind != RequestKind::Leave {
            return Err(DomainError::validation("only drafts can be edited"));
        }
        model::check_version(&req, expected_version)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::EditDraft, &Resource::Request(&ctx))?;
        validate_range(
            tx,
            input.leave_type_id,
            input.start_date,
            input.end_date,
            input.start_part,
            input.end_part,
        )?;
        tx.execute(
            "UPDATE request_revisions SET leave_type_id=?2, start_date=?3, end_date=?4,
             start_part=?5, end_part=?6, note=?7 WHERE id=?1 AND submitted_at IS NULL",
            params![
                req.current_revision_id,
                input.leave_type_id,
                date_s(&input.start_date),
                date_s(&input.end_date),
                input.start_part.as_str(),
                input.end_part.as_str(),
                input.note
            ],
        )?;
        model::bump_version(tx, request_id, &now_ts)?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.update",
            "request",
            Some(request_id),
            serde_json::json!({}),
        )?;
        Ok(())
    })
}

/// Delete a draft (audit remains).
pub fn delete_draft(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    expected_version: i64,
) -> Res<Vec<String>> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        if req.status != RequestStatus::Draft {
            return Err(DomainError::validation("only drafts can be deleted"));
        }
        model::check_version(&req, expected_version)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::DeleteDraft, &Resource::Request(&ctx))?;
        let mut statement =
            tx.prepare("SELECT storage_key FROM attachments WHERE request_id=?1")?;
        let keys: Vec<String> = statement
            .query_map([request_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        tx.execute("UPDATE leave_requests SET current_revision_id=NULL, effective_revision_id=NULL WHERE id=?1", [request_id])?;
        for rev in [req.current_revision_id, req.effective_revision_id]
            .into_iter()
            .flatten()
        {
            tx.execute(
                "DELETE FROM revision_allocations WHERE day_id IN
                 (SELECT id FROM request_days WHERE revision_id=?1)",
                [rev],
            )?;
            tx.execute("DELETE FROM request_days WHERE revision_id=?1", [rev])?;
            tx.execute("DELETE FROM request_revisions WHERE id=?1", [rev])?;
        }
        tx.execute("DELETE FROM attachments WHERE request_id=?1", [request_id])?;
        tx.execute("DELETE FROM messages WHERE request_id=?1", [request_id])?;
        tx.execute("DELETE FROM leave_requests WHERE id=?1", [request_id])?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.delete",
            "request",
            Some(request_id),
            serde_json::json!({}),
        )?;
        notify::record_change(tx, clock, actor.user_id, "request.delete")?;
        Ok(keys)
    })
}

/// Finish file cleanup after the enclosing transaction commits (including HTTP receipts).
pub fn finish_draft_deletion(conn: &Connection, store: &FileStore, keys: &[String]) -> Res<()> {
    if !conn.is_autocommit() {
        return Err(DomainError::validation(
            "draft file cleanup requires a committed transaction",
        ));
    }
    for key in keys {
        let referenced: i64 = conn.query_row(
            "SELECT COUNT(*) FROM attachments WHERE storage_key=?1",
            [key],
            |r| r.get(0),
        )?;
        if referenced == 0 {
            store.remove(key)?;
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ preview

/// Preview a request: days, allocation, resulting balances, route, warnings
/// and blocking errors. Read-only (internal writes are rolled back).
pub fn preview(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    input: &DraftInput,
    amend_of: Option<i64>,
    cancel_of: Option<(i64, Date, Date)>,
) -> Res<Preview> {
    let today = clock.today(conn)?;
    let tx = conn.transaction()?;
    let result = preview_in(&tx, clock, actor, input, amend_of, cancel_of, today);
    drop(tx); // rollback: preview must not persist lazily-created accounts
    result
}

fn preview_in(
    conn: &Connection,
    _clock: &Clock,
    actor: &Actor,
    input: &DraftInput,
    amend_of: Option<i64>,
    cancel_of: Option<(i64, Date, Date)>,
    today: Date,
) -> Res<Preview> {
    let employee_id = input.employee_id.or(actor.employee_id);
    if let Some(employee_id) = employee_id {
        if Some(employee_id) != actor.employee_id {
            authz::require(
                conn,
                actor,
                Action::CreatePaper,
                &Resource::Employee {
                    employee_id,
                    org_unit_id: model::unit_of(conn, employee_id, today)?,
                },
            )?;
        }
    }
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut days = Vec::new();
    let mut alloc_views = Vec::new();
    let mut balance_after = Vec::new();
    let mut total_minutes = 0i64;

    if let Some((parent_id, from, to)) = cancel_of {
        // ---- cancellation preview: show freed minutes
        let parent = model::load_request(conn, parent_id)?;
        let ctx = request_ctx(conn, &parent, today)?;
        authz::require(conn, actor, Action::ViewRequest, &Resource::Request(&ctx))?;
        let eff = parent
            .effective_revision_id
            .ok_or_else(|| DomainError::validation("request has no approved revision"))?;
        let eff_days = model::revision_days(conn, eff)?;
        let mut freed: BTreeMap<i64, i64> = BTreeMap::new();
        let cancelled_numbers = next_number_preview(conn, today)?;
        for d in &eff_days {
            let hit = d.date >= from && d.date <= to && d.minutes > 0;
            days.push(ComputedDay {
                date: d.date,
                part: if hit { "none".into() } else { d.part.clone() },
                scheduled_minutes: d.scheduled_minutes,
                minutes: if hit { 0 } else { d.minutes },
                period_year: d.period_year,
                schedule_version_id: d.schedule_version_id,
                exception_id: d.exception_id,
                explanation: if hit {
                    format!("Cancelled by {cancelled_numbers}")
                } else {
                    d.explanation.clone()
                },
            });
        }
        let keep = surviving_alloc(conn, eff, &eff_days, from, to)?;
        let eff_totals = model::allocation_totals(conn, eff)?;
        for (acc, m) in &eff_totals {
            let f = m - keep.get(acc).copied().unwrap_or(0);
            if f > 0 {
                freed.insert(*acc, f);
            }
        }
        total_minutes = days.iter().map(|d| d.minutes).sum();
        for (acc, f) in &freed {
            let before = ledger::available(conn, *acc, today)?;
            let year = account_year(conn, *acc)?;
            balance_after.push(BalanceAfter {
                period_year: year,
                available_before: before,
                available_after: before + f,
            });
        }
        if from < today {
            errors.push(PreviewError {
                code: "past_dates_need_hr_correction".into(),
                message: "past dates need an HR correction, not a cancellation".into(),
            });
        }
    } else {
        // ---- leave / amendment preview
        let employee_id = employee_id.ok_or_else(|| DomainError::forbidden("no employee"))?;
        let mut exclude: Vec<i64> = Vec::new();
        let mut extra: BTreeMap<i64, i64> = BTreeMap::new();
        let mut credit_revision = None;
        if let Some(parent_id) = amend_of {
            let parent = model::load_request(conn, parent_id)?;
            let ctx = request_ctx(conn, &parent, today)?;
            authz::require(conn, actor, Action::Amend, &Resource::Request(&ctx))?;
            if parent.employee_id != employee_id {
                return Err(DomainError::validation(
                    "amendment employee does not match parent",
                ));
            }
            if let Some(eff) = parent.effective_revision_id {
                extra = model::allocation_totals(conn, eff)?;
                credit_revision = Some(eff);
            }
            exclude.push(parent_id);
        }
        match calendar::compute_days_on(
            conn,
            employee_id,
            input.leave_type_id,
            input.start_date,
            input.end_date,
            input.start_part,
            input.end_part,
            today,
        ) {
            Ok(d) => {
                days = d;
                total_minutes = days.iter().map(|x| x.minutes).sum();
            }
            Err(e) => errors.push(PreviewError {
                code: e.code().into(),
                message: e.message(),
            }),
        }
        if !days.is_empty() {
            match calendar::find_overlap(conn, employee_id, &days, &exclude)? {
                Some(hit) => errors.push(PreviewError {
                    code: "overlap".into(),
                    message: format!(
                        "overlaps request {} on {}",
                        hit.request_number,
                        date_s(&hit.date)
                    ),
                }),
                None => {
                    match ledger::allocate_with_credit(
                        conn,
                        employee_id,
                        input.leave_type_id,
                        &days,
                        today,
                        &extra,
                        credit_revision,
                    ) {
                        Ok(allocs) => {
                            // balance_after per touched account/year
                            let mut touched: BTreeMap<i64, i64> = BTreeMap::new();
                            for a in &allocs {
                                alloc_views.push(DayAllocationView {
                                    date: date_s(&days[a.day_index].date),
                                    account_id: a.account_id,
                                    period_year: a.period_year,
                                    minutes: a.minutes,
                                    carryover: a.carryover,
                                });
                                *touched.entry(a.account_id).or_default() += a.minutes;
                            }
                            for (acc, used) in &touched {
                                let before = ledger::available(conn, *acc, today)?;
                                balance_after.push(BalanceAfter {
                                    period_year: account_year(conn, *acc)?,
                                    available_before: before,
                                    available_after: before - used,
                                });
                            }
                        }
                        Err(e) => errors.push(PreviewError {
                            code: e.code().into(),
                            message: e.message(),
                        }),
                    }
                }
            }
        }
        // warnings
        let lt = model::leave_type_on(conn, input.leave_type_id, today)?;
        if lt.min_notice_days > 0
            && input.start_date < today + time::Duration::days(lt.min_notice_days)
        {
            warnings.push(Warn {
                code: "late_notice".into(),
                message: format!(
                    "submitted less than {} days before the start date",
                    lt.min_notice_days
                ),
                details: serde_json::json!({"min_notice_days": lt.min_notice_days}),
            });
        }
        if let Some(w) = team_overlap(conn, employee_id, input.start_date, input.end_date, today)? {
            warnings.push(w);
        }
        if model::manager_at(conn, employee_id, today)?
            .and_then(|m| m.user_id)
            .is_none()
        {
            warnings.push(Warn {
                code: "unassigned_step".into(),
                message: "no manager with a login — the first step will be unassigned".into(),
                details: serde_json::json!({}),
            });
        }
    }

    let emp_for_route = employee_id.or_else(|| {
        cancel_of
            .and_then(|(p, _, _)| model::load_request(conn, p).ok())
            .map(|r| r.employee_id)
    });
    let route = route_preview(conn, emp_for_route, today)?;

    Ok(Preview {
        days,
        total_minutes,
        allocations: alloc_views,
        balance_after,
        route,
        warnings,
        errors,
    })
}

fn next_number_preview(conn: &Connection, today: Date) -> Res<String> {
    next_number(conn, today)
}

fn account_year(conn: &Connection, account_id: i64) -> Res<i64> {
    Ok(conn.query_row(
        "SELECT period_year FROM leave_accounts WHERE id=?1",
        [account_id],
        |r| r.get(0),
    )?)
}

/// Minutes of `eff` that survive a cancellation of [from, to], per account.
fn surviving_alloc(
    conn: &Connection,
    eff: i64,
    eff_days: &[model::RequestDay],
    from: Date,
    to: Date,
) -> Res<BTreeMap<i64, i64>> {
    let cancelled: std::collections::BTreeSet<i64> = eff_days
        .iter()
        .filter(|d| d.date >= from && d.date <= to)
        .map(|d| d.id)
        .collect();
    let mut keep = BTreeMap::new();
    for a in model::revision_allocations(conn, eff)? {
        if !cancelled.contains(&a.day_id) {
            *keep.entry(a.account_id).or_default() += a.minutes;
        }
    }
    Ok(keep)
}

/// Teammates (same org unit today) with absences overlapping [start, end].
pub fn team_overlap(
    conn: &Connection,
    employee_id: i64,
    start: Date,
    end: Date,
    today: Date,
) -> Res<Option<Warn>> {
    let Some(unit) = model::unit_of(conn, employee_id, today)? else {
        return Ok(None);
    };
    let mut st = conn.prepare(
        "SELECT DISTINCT e.full_name, MIN(rd.date), MAX(rd.date)
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN request_revisions rr ON rr.id =
             CASE WHEN lr.status='approved' THEN lr.effective_revision_id ELSE lr.current_revision_id END
         JOIN request_days rd ON rd.revision_id = rr.id
         JOIN employment_assignments ea ON ea.employee_id = lr.employee_id
            AND ea.org_unit_id = ?2
            AND ea.valid_from <= ?3 AND (ea.valid_to IS NULL OR ea.valid_to >= ?3)
         WHERE lr.employee_id != ?1
           AND lr.status IN ('submitted','needs_information','under_review','approved')
           AND rd.date BETWEEN ?4 AND ?5
           AND rd.minutes > 0
         GROUP BY e.id",
    )?;
    let rows = st.query_map(
        params![
            employee_id,
            unit,
            date_s(&today),
            date_s(&start),
            date_s(&end)
        ],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )?;
    let list: Vec<serde_json::Value> = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(name, from, to)| serde_json::json!({"name": name, "from": from, "to": to}))
        .collect();
    if list.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Warn {
            code: "team_overlap".into(),
            message: format!("{} teammate(s) are absent in this period", list.len()),
            details: serde_json::json!(list),
        }))
    }
}

fn route_preview(conn: &Connection, employee_id: Option<i64>, today: Date) -> Res<Vec<RouteStep>> {
    let mut out = Vec::new();
    let (manager_label, manager_problem) = match employee_id {
        Some(e) => match model::manager_at(conn, e, today)? {
            Some(m) => match m.user_id {
                Some(uid) => (model::load_user(conn, uid)?.display_name, None),
                None => (
                    "manager".to_string(),
                    Some("Manager has no login".to_string()),
                ),
            },
            None => (
                "manager".to_string(),
                Some("No manager assigned".to_string()),
            ),
        },
        None => ("manager".to_string(), Some("No employee".to_string())),
    };
    out.push(RouteStep {
        kind: "manager_recommendation".into(),
        who: if manager_problem.is_none() {
            Some(manager_label)
        } else {
            None
        },
        problem: manager_problem,
    });
    let unit = employee_id
        .and_then(|e| model::unit_of(conn, e, today).ok())
        .flatten();
    let unit_name = unit
        .and_then(|u| {
            conn.query_row("SELECT name FROM org_units WHERE id=?1", [u], |r| r.get(0))
                .ok()
        })
        .unwrap_or_else(|| "the service".to_string());
    out.push(RouteStep {
        kind: "hr_check".into(),
        who: Some(format!("Any HR officer for {unit_name}")),
        problem: None,
    });
    out.push(RouteStep {
        kind: "final_decision".into(),
        who: Some(format!("Any final approver for {unit_name}")),
        problem: None,
    });
    Ok(out)
}

// ------------------------------------------------------------------ submit

/// Submit a draft: freeze the revision, compute & store days + allocations,
/// create reservations and the 3-step route, notify — all in one tx.
/// `idempotency_key` replays the stored response for the same body.
pub fn submit(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    expected_version: i64,
    idempotency_key: Option<&str>,
) -> Res<Submitted> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    let hash = sha256_hex(&format!("submit:{request_id}:{expected_version}"));
    crate::db::write_tx(conn, |tx| {
        if let Some(resp) = idem_check(tx, actor.user_id, idempotency_key, &hash)? {
            let s: Submitted = serde_json::from_str(&resp)?;
            return Ok(s);
        }
        let req = model::load_request(tx, request_id)?;
        if req.status != RequestStatus::Draft || req.kind != RequestKind::Leave {
            return Err(DomainError::validation("only a draft can be submitted"));
        }
        model::check_version(&req, expected_version)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::Submit, &Resource::Request(&ctx))?;
        let rev = model::load_revision(tx, req.current_revision_id.unwrap())?;

        let days = calendar::compute_checked_on(
            tx,
            req.employee_id,
            rev.leave_type_id,
            rev.start_date,
            rev.end_date,
            rev.start_part,
            rev.end_part,
            &[req.id],
            today,
        )?;
        let lt = model::leave_type_on(tx, rev.leave_type_id, today)?;
        if lt.requires_attachment {
            let n: i64 = tx.query_row(
                "SELECT COUNT(*) FROM attachments WHERE request_id=?1",
                [req.id],
                |r| r.get(0),
            )?;
            if n == 0 {
                return Err(DomainError::validation(format!(
                    "{} requires an attachment",
                    lt.code
                )));
            }
        }
        let allocs = ledger::allocate(
            tx,
            req.employee_id,
            rev.leave_type_id,
            &days,
            today,
            &BTreeMap::new(),
        )?;
        model::snapshot_policy(tx, rev.id, today)?;
        let day_ids = store_days(tx, rev.id, &days)?;
        store_allocations(tx, rev.id, &day_ids, &allocs)?;
        create_reservations(tx, req.id, rev.id, &alloc_totals(&allocs), &now_ts, today)?;
        let total: i64 = days.iter().map(|d| d.minutes).sum();
        tx.execute(
            "UPDATE request_revisions SET submitted_at=?2, total_minutes=?3 WHERE id=?1",
            params![rev.id, now_ts, total],
        )?;
        let number = next_number(tx, today)?;
        tx.execute(
            "UPDATE leave_requests SET number=?2, status='submitted' WHERE id=?1",
            params![req.id, number],
        )?;
        create_route(tx, req.id, rev.id, req.employee_id, today, &now_ts)?;
        model::bump_version(tx, req.id, &now_ts)?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.submit",
            "request",
            Some(req.id),
            serde_json::json!({"number": number, "revision": rev.rev_no, "minutes": total}),
        )?;
        let subject = subject_for(&number);
        notify_employee(
            tx,
            &req,
            rev.id,
            "submitted",
            &subject,
            &format!(
                "Your leave request {number} was submitted. Open: /requests/{}",
                req.id
            ),
            &now_ts,
        )?;
        if let Some(assignee) = step_assignee(tx, req.id, 1)? {
            notify_user(
                tx,
                &req,
                rev.id,
                "step_pending",
                assignee,
                &subject,
                &format!(
                    "A leave request awaits your recommendation. Open: /requests/{}",
                    req.id
                ),
                &now_ts,
            )?;
        }
        let out = Submitted {
            request_id: req.id,
            number,
            version: req.version + 1,
        };
        idem_store(
            tx,
            actor.user_id,
            idempotency_key,
            &hash,
            &serde_json::to_string(&out)?,
            &now_ts,
        )?;
        Ok(out)
    })
}

fn step_assignee(conn: &Connection, request_id: i64, seq: i64) -> Res<Option<i64>> {
    conn.query_row(
        "SELECT assignee_user_id FROM approval_steps WHERE request_id=?1 AND seq=?2",
        params![request_id, seq],
        |r| r.get(0),
    )
    .optional()
    .map(|o| o.flatten())
    .map_err(Into::into)
}

// ------------------------------------------------------------------ decide

/// Decide a pending step. Outcomes per kind; `needs_information` keeps the
/// step pending while the request waits for the employee. Final `approve`
/// converts reservations to consumption (leave) or posts deltas and switches
/// `parent.effective_revision_id` (amendment/cancellation) — in one tx.
#[allow(clippy::too_many_arguments)]
pub fn decide(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    step_id: i64,
    outcome: &str,
    reason: Option<&str>,
    basis_document: Option<&str>,
    expected_version: i64,
    idempotency_key: Option<&str>,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    let hash = sha256_hex(&format!(
        "decide:{request_id}:{step_id}:{outcome}:{:?}:{:?}:{expected_version}",
        reason, basis_document
    ));
    crate::db::write_tx(conn, |tx| {
        if idem_check(tx, actor.user_id, idempotency_key, &hash)?.is_some() {
            return Ok(());
        }
        let req = model::load_request(tx, request_id)?;
        if !matches!(
            req.status,
            RequestStatus::Submitted | RequestStatus::UnderReview
        ) && !(req.status == RequestStatus::NeedsInformation && outcome == "reject")
        {
            return Err(DomainError::validation(format!(
                "request is {}, no step is decidable",
                req.status.as_str()
            )));
        }
        model::check_version(&req, expected_version)?;
        let step = model::load_step(tx, step_id)?;
        if step.request_id != req.id {
            return Err(DomainError::not_found("step of another request"));
        }
        if step.status != "pending" {
            return Err(DomainError::validation("step is not pending"));
        }
        if Some(step.revision_id) != req.current_revision_id {
            return Err(DomainError::validation("step belongs to an old revision"));
        }
        if !step.kind.valid_outcomes().contains(&outcome) {
            return Err(DomainError::validation(format!(
                "outcome {outcome} not valid for {}",
                step.kind.as_str()
            )));
        }
        if model::outcome_needs_reason(outcome) && reason.map(|r| r.is_empty()).unwrap_or(true) {
            return Err(DomainError::validation(
                "reason is required for this outcome",
            ));
        }
        let ctx = request_ctx(tx, &req, today)?;
        let authority = authz::decide_authority(tx, actor, &ctx, &step)?;

        tx.execute(
            "INSERT INTO decisions
             (request_id, revision_id, step_id, actor_user_id, acting_for_user_id,
              authority, outcome, reason, basis_document, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                req.id,
                step.revision_id,
                step.id,
                actor.user_id,
                authority.acting_for_user_id,
                authority.label,
                outcome,
                reason,
                basis_document,
                now_ts
            ],
        )?;

        if outcome == "needs_information" {
            tx.execute(
                "UPDATE approval_steps SET outcome=?2 WHERE id=?1",
                params![step.id, outcome],
            )?;
            tx.execute(
                "UPDATE leave_requests SET status='needs_information' WHERE id=?1",
                [req.id],
            )?;
            if let Some(r) = reason {
                tx.execute(
                    "INSERT INTO messages(request_id, author_user_id, kind, body, created_at)
                     VALUES (?1,?2,'question',?3,?4)",
                    params![req.id, actor.user_id, r, now_ts],
                )?;
            }
            let subject = subject_for(&req.number);
            notify_employee(
                tx,
                &req,
                step.revision_id,
                "question",
                &subject,
                &format!(
                    "A question was asked on your request {}. Open: /requests/{}",
                    req.number, req.id
                ),
                &now_ts,
            )?;
        } else {
            tx.execute(
                "UPDATE approval_steps SET status='done', outcome=?2, completed_at=?3 WHERE id=?1",
                params![step.id, outcome, now_ts],
            )?;
            if step.kind == StepKind::FinalDecision {
                match outcome {
                    "approve" => apply_final_approval(tx, actor, &req, &step, today, &now_ts)?,
                    "reject" => {
                        release_and_close(tx, &req, "rejected", &now_ts, today)?;
                        tx.execute(
                            "UPDATE leave_requests SET status='rejected' WHERE id=?1",
                            [req.id],
                        )?;
                    }
                    _ => unreachable!("validated above"),
                }
                let subject = subject_for(&req.number);
                notify_employee(
                    tx,
                    &req,
                    step.revision_id,
                    "decision",
                    &subject,
                    &format!(
                        "Your leave request {} has a new decision. Open: /requests/{}",
                        req.number, req.id
                    ),
                    &now_ts,
                )?;
            } else {
                // advance the route
                tx.execute(
                    "UPDATE leave_requests SET status='under_review' WHERE id=?1",
                    [req.id],
                )?;
                let next: Option<(i64, Option<i64>)> = tx
                    .query_row(
                        "SELECT id, assignee_user_id FROM approval_steps
                         WHERE request_id=?1 AND status='waiting' ORDER BY seq LIMIT 1",
                        [req.id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((next_id, assignee)) = next {
                    tx.execute(
                        "UPDATE approval_steps SET status='pending' WHERE id=?1",
                        [next_id],
                    )?;
                    if let Some(u) = assignee {
                        let subject = subject_for(&req.number);
                        notify_user(
                            tx,
                            &req,
                            step.revision_id,
                            "step_pending",
                            u,
                            &subject,
                            &format!(
                                "A leave request awaits your action. Open: /requests/{}",
                                req.id
                            ),
                            &now_ts,
                        )?;
                    }
                }
            }
        }
        model::bump_version(tx, req.id, &now_ts)?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            authority.acting_for_user_id,
            "step.decide",
            "request",
            Some(req.id),
            serde_json::json!({"step": step.kind.as_str(), "outcome": outcome, "revision": step.revision_id}),
        )?;
        idem_store(tx, actor.user_id, idempotency_key, &hash, "{}", &now_ts)?;
        Ok(())
    })
}

fn release_and_close(
    conn: &Connection,
    req: &LeaveRequest,
    reason: &str,
    now_ts: &str,
    today: Date,
) -> Res<()> {
    ledger::release_reservations(conn, req.id, reason, now_ts, today)?;
    conn.execute(
        "UPDATE approval_steps SET status='closed' WHERE request_id=?1 AND status IN ('pending','waiting')",
        [req.id],
    )?;
    Ok(())
}

/// Final approval: post ledger movements per request kind.
fn apply_final_approval(
    conn: &Connection,
    actor: &Actor,
    req: &LeaveRequest,
    step: &Step,
    today: Date,
    now_ts: &str,
) -> Res<()> {
    match req.kind {
        RequestKind::Leave => {
            // reservations -> consumptions, effective revision = current
            let mut st = conn.prepare(
                "SELECT account_id, minutes FROM reservations
                 WHERE request_id=?1 AND revision_id=?2 AND active=1",
            )?;
            let rows: Vec<(i64, i64)> = st
                .query_map(params![req.id, step.revision_id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (acc, minutes) in rows {
                ledger::post_entry(
                    conn,
                    &ledger::PostEntry {
                        account_id: acc,
                        minutes: -minutes,
                        kind: "consumption",
                        effective_date: today,
                        request_id: Some(req.id),
                        revision_id: Some(step.revision_id),
                        reverses_entry_id: None,
                        adjustment_id: None,
                        import_batch_id: None,
                        basis: format!("Approved leave {}", req.number),
                        author_user_id: Some(actor.user_id),
                        op_key: format!("consume:{}:{}", step.revision_id, acc),
                    },
                    now_ts,
                )?;
            }
            ledger::release_reservations(conn, req.id, "approved", now_ts, today)?;
            conn.execute(
                "UPDATE leave_requests SET status='approved', effective_revision_id=?2 WHERE id=?1",
                params![req.id, step.revision_id],
            )?;
            conn.execute(
                "UPDATE approval_steps SET status='closed' WHERE request_id=?1 AND status IN ('pending','waiting')",
                [req.id],
            )?;
        }
        RequestKind::Amendment => {
            apply_change_approval(conn, actor, req, step.revision_id, today, now_ts, false)?;
        }
        RequestKind::Cancellation => {
            apply_change_approval(conn, actor, req, step.revision_id, today, now_ts, true)?;
        }
    }
    Ok(())
}

/// Approve an amendment or cancellation: post per-account deltas against the
/// parent's effective revision, then switch `parent.effective_revision_id`.
fn apply_change_approval(
    conn: &Connection,
    actor: &Actor,
    change: &LeaveRequest,
    change_rev: i64,
    today: Date,
    now_ts: &str,
    is_cancel: bool,
) -> Res<()> {
    let parent_id = change
        .parent_request_id
        .ok_or_else(|| DomainError::Internal(anyhow::anyhow!("change without parent")))?;
    let parent = model::load_request(conn, parent_id)?;
    let eff = parent
        .effective_revision_id
        .ok_or_else(|| DomainError::validation("parent has no effective revision"))?;
    let new_revision = model::load_revision(conn, change_rev)?;
    let new_days: Vec<ComputedDay> = model::revision_days(conn, change_rev)?
        .into_iter()
        .map(|d| ComputedDay {
            date: d.date,
            part: d.part,
            scheduled_minutes: d.scheduled_minutes,
            minutes: d.minutes,
            period_year: d.period_year,
            schedule_version_id: d.schedule_version_id,
            exception_id: d.exception_id,
            explanation: d.explanation,
        })
        .collect();
    validate_past_change(conn, eff, new_revision.leave_type_id, &new_days, today)?;
    let eff_totals = model::allocation_totals(conn, eff)?;
    let new_totals = model::allocation_totals(conn, change_rev)?;
    let mut accounts: std::collections::BTreeSet<i64> = eff_totals.keys().copied().collect();
    accounts.extend(new_totals.keys().copied());
    for acc in accounts {
        let delta =
            new_totals.get(&acc).copied().unwrap_or(0) - eff_totals.get(&acc).copied().unwrap_or(0);
        if delta > 0 {
            ledger::post_entry(
                conn,
                &ledger::PostEntry {
                    account_id: acc,
                    minutes: -delta,
                    kind: "consumption",
                    effective_date: today,
                    request_id: Some(change.id),
                    revision_id: Some(change_rev),
                    reverses_entry_id: None,
                    adjustment_id: None,
                    import_batch_id: None,
                    basis: format!("Approved change {}", change.number),
                    author_user_id: Some(actor.user_id),
                    op_key: format!("consume:{}:{}", change_rev, acc),
                },
                now_ts,
            )?;
        } else if delta < 0 {
            let reverses = ledger::find_consumption_entry(conn, parent.id, acc)?;
            ledger::post_entry(
                conn,
                &ledger::PostEntry {
                    account_id: acc,
                    minutes: -delta, // positive return
                    kind: "return",
                    effective_date: today,
                    request_id: Some(change.id),
                    revision_id: Some(change_rev),
                    reverses_entry_id: reverses,
                    adjustment_id: None,
                    import_batch_id: None,
                    basis: format!(
                        "Returned by {} {}",
                        if is_cancel {
                            "cancellation"
                        } else {
                            "amendment"
                        },
                        change.number
                    ),
                    author_user_id: Some(actor.user_id),
                    op_key: format!("return:{}:{}", change_rev, acc),
                },
                now_ts,
            )?;
        }
    }
    ledger::release_reservations(conn, change.id, "approved", now_ts, today)?;
    conn.execute(
        "UPDATE leave_requests SET status='approved' WHERE id=?1",
        [change.id],
    )?;
    conn.execute(
        "UPDATE approval_steps SET status='closed' WHERE request_id=?1 AND status IN ('pending','waiting')",
        [change.id],
    )?;
    // switch the parent's effective revision; full cancellation closes parent
    let remaining: i64 = conn.query_row(
        "SELECT total_minutes FROM request_revisions WHERE id=?1",
        [change_rev],
        |r| r.get(0),
    )?;
    let new_status = if is_cancel && remaining == 0 {
        "cancelled"
    } else {
        "approved"
    };
    conn.execute(
        "UPDATE leave_requests SET effective_revision_id=?2, status=?3,
         version=version+1, updated_at=?4 WHERE id=?1",
        params![parent.id, change_rev, new_status, now_ts],
    )?;
    Ok(())
}

// ------------------------------------------------------------------ respond / revise

/// Answer a needs_information question. `body` is stored as an `answer`
/// message. `changes` = a material change → a new revision is created, the
/// old one superseded, the route restarts at `submitted`.
pub fn respond(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    expected_version: i64,
    body: &str,
    changes: Option<ReviseInput>,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        if !matches!(
            req.status,
            RequestStatus::NeedsInformation | RequestStatus::Submitted | RequestStatus::UnderReview
        ) {
            return Err(DomainError::validation(format!(
                "cannot respond while request is {}",
                req.status.as_str()
            )));
        }
        model::check_version(&req, expected_version)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::Respond, &Resource::Request(&ctx))?;
        if !body.is_empty() {
            tx.execute(
                "INSERT INTO messages(request_id, author_user_id, kind, body, created_at)
                 VALUES (?1,?2,'answer',?3,?4)",
                params![req.id, actor.user_id, body, now_ts],
            )?;
        }
        match changes {
            None => {
                // text-only: back to the status before needs_information —
                // derived from whether an earlier step already finished.
                let done: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM approval_steps
                     WHERE request_id=?1 AND revision_id=?2 AND status='done'",
                    params![req.id, req.current_revision_id],
                    |r| r.get(0),
                )?;
                let back = if done > 0 {
                    "under_review"
                } else {
                    "submitted"
                };
                tx.execute(
                    "UPDATE leave_requests SET status=?2 WHERE id=?1",
                    params![req.id, back],
                )?;
                audit::log(
                    tx,
                    &now_ts,
                    Some(actor.user_id),
                    None,
                    "request.respond",
                    "request",
                    Some(req.id),
                    serde_json::json!({}),
                )?;
            }
            Some(ch) => {
                revise_in(tx, actor, &req, &ctx, &ch, today, &now_ts)?;
            }
        }
        model::bump_version(tx, req.id, &now_ts)?;
        Ok(())
    })
}

/// Material revision: new revision + days/allocations/reservations, old
/// reservations released 'superseded', old steps 'superseded', route restarts.
fn revise_in(
    conn: &Connection,
    actor: &Actor,
    req: &LeaveRequest,
    _ctx: &RequestCtx,
    ch: &ReviseInput,
    today: Date,
    now_ts: &str,
) -> Res<()> {
    let old_rev_id = req
        .current_revision_id
        .ok_or_else(|| DomainError::Internal(anyhow::anyhow!("no current revision")))?;
    if req.kind == RequestKind::Cancellation {
        return Err(DomainError::validation(
            "cancellation responses must be text-only",
        ));
    }
    validate_change_input(conn, req.id, ch, today)?;
    let mut exclude = vec![req.id];
    if let Some(parent) = req.parent_request_id {
        exclude.push(parent);
    }
    let days = calendar::compute_checked_on(
        conn,
        req.employee_id,
        ch.leave_type_id,
        ch.start_date,
        ch.end_date,
        ch.start_part,
        ch.end_part,
        &exclude,
        today,
    )?;
    // an amendment revises against the parent's effective minutes as capacity
    let mut extra: BTreeMap<i64, i64> = BTreeMap::new();
    let mut credit_revision = None;
    if req.kind == RequestKind::Amendment {
        if let Some(parent_id) = req.parent_request_id {
            let parent = model::load_request(conn, parent_id)?;
            if let Some(eff) = parent.effective_revision_id {
                extra = model::allocation_totals(conn, eff)?;
                credit_revision = Some(eff);
            }
        }
    }
    if req.kind == RequestKind::Amendment {
        let parent = model::load_request(conn, req.parent_request_id.unwrap())?;
        validate_past_change(
            conn,
            parent.effective_revision_id.unwrap(),
            ch.leave_type_id,
            &days,
            today,
        )?;
    }
    ledger::release_reservations(conn, req.id, "superseded", now_ts, today)?;
    let allocs = ledger::allocate_with_credit(
        conn,
        req.employee_id,
        ch.leave_type_id,
        &days,
        today,
        &extra,
        credit_revision,
    )?;
    let rev_no: i64 = conn.query_row(
        "SELECT COALESCE(MAX(rev_no),0)+1 FROM request_revisions WHERE request_id=?1",
        [req.id],
        |r| r.get(0),
    )?;
    let total: i64 = days.iter().map(|d| d.minutes).sum();
    let new_rev: i64 = conn.query_row(
        "INSERT INTO request_revisions
         (request_id, rev_no, leave_type_id, start_date, end_date, start_part, end_part,
          note, change_reason, total_minutes, created_by, created_at, submitted_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12) RETURNING id",
        params![
            req.id,
            rev_no,
            ch.leave_type_id,
            date_s(&ch.start_date),
            date_s(&ch.end_date),
            ch.start_part.as_str(),
            ch.end_part.as_str(),
            ch.note,
            ch.change_reason,
            total,
            actor.user_id,
            now_ts
        ],
        |r| r.get(0),
    )?;
    model::snapshot_policy(conn, new_rev, today)?;
    let day_ids = store_days(conn, new_rev, &days)?;
    store_allocations(conn, new_rev, &day_ids, &allocs)?;
    // supersede old reservations + steps, then create the fresh reservation set
    conn.execute(
        "UPDATE approval_steps SET status='superseded'
         WHERE request_id=?1 AND revision_id=?2 AND status IN ('pending','waiting')",
        params![req.id, old_rev_id],
    )?;
    let reserve_totals = if req.kind == RequestKind::Amendment {
        // reserve only the positive per-account delta vs the parent's effective allocation
        let eff = model::load_request(conn, req.parent_request_id.unwrap())?
            .effective_revision_id
            .unwrap();
        let eff_totals = model::allocation_totals(conn, eff)?;
        let mut delta = alloc_totals(&allocs);
        for (acc, m) in eff_totals {
            let e = delta.entry(acc).or_default();
            *e -= m;
        }
        delta.retain(|_, m| *m > 0);
        delta
    } else {
        alloc_totals(&allocs)
    };
    create_reservations(conn, req.id, new_rev, &reserve_totals, now_ts, today)?;
    conn.execute(
        "UPDATE leave_requests SET current_revision_id=?2, status='submitted' WHERE id=?1",
        params![req.id, new_rev],
    )?;
    create_route(conn, req.id, new_rev, req.employee_id, today, now_ts)?;
    audit::log(
        conn,
        now_ts,
        Some(actor.user_id),
        None,
        "request.revise",
        "request",
        Some(req.id),
        serde_json::json!({"revision": rev_no, "reason": ch.change_reason}),
    )?;
    Ok(())
}

// ------------------------------------------------------------------ withdraw

/// Withdraw an open request (employee, the entering HR officer, or hr scope).
pub fn withdraw(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    reason: Option<&str>,
    expected_version: i64,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        if !req.status.is_open() {
            return Err(DomainError::validation(format!(
                "cannot withdraw a {} request",
                req.status.as_str()
            )));
        }
        model::check_version(&req, expected_version)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::Withdraw, &Resource::Request(&ctx))?;
        release_and_close(tx, &req, "withdrawn", &now_ts, today)?;
        tx.execute(
            "UPDATE leave_requests SET status='withdrawn' WHERE id=?1",
            [req.id],
        )?;
        if let Some(r) = reason {
            tx.execute(
                "INSERT INTO messages(request_id, author_user_id, kind, body, created_at)
                 VALUES (?1,?2,'system',?3,?4)",
                params![req.id, actor.user_id, format!("Withdrawn: {r}"), now_ts],
            )?;
        }
        model::bump_version(tx, req.id, &now_ts)?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.withdraw",
            "request",
            Some(req.id),
            serde_json::json!({"reason": reason}),
        )?;
        Ok(())
    })
}

// ------------------------------------------------------------------ amend / cancel

/// File an amendment against an approved request. The amendment is submitted
/// immediately (own revision, own route); only the positive per-account delta
/// is reserved. `expected_version` is the parent's.
pub fn amend(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    parent_id: i64,
    input: &ReviseInput,
    expected_version: i64,
    idempotency_key: Option<&str>,
) -> Res<ChildCreated> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    let hash = sha256_hex(&format!(
        "amend:{parent_id}:{}:{}:{}:{}:{}:{}:{expected_version}",
        input.leave_type_id,
        date_s(&input.start_date),
        date_s(&input.end_date),
        input.start_part.as_str(),
        input.end_part.as_str(),
        input.change_reason
    ));
    crate::db::write_tx(conn, |tx| {
        if let Some(resp) = idem_check(tx, actor.user_id, idempotency_key, &hash)? {
            return Ok(serde_json::from_str(&resp)?);
        }
        let parent = model::load_request(tx, parent_id)?;
        check_changeable_parent(tx, actor, &parent, expected_version, today, Action::Amend)?;
        let eff = parent.effective_revision_id.unwrap();
        let eff_totals = model::allocation_totals(tx, eff)?;
        validate_change_input(tx, parent.id, input, today)?;
        let days = calendar::compute_checked_on(
            tx,
            parent.employee_id,
            input.leave_type_id,
            input.start_date,
            input.end_date,
            input.start_part,
            input.end_part,
            &[parent.id],
            today,
        )?;
        validate_past_change(tx, eff, input.leave_type_id, &days, today)?;
        let allocs = ledger::allocate_with_credit(
            tx,
            parent.employee_id,
            input.leave_type_id,
            &days,
            today,
            &eff_totals,
            Some(eff),
        )?;
        let total: i64 = days.iter().map(|d| d.minutes).sum();
        let number = next_number(tx, today)?;
        let child_id = insert_child(
            tx,
            &parent,
            RequestKind::Amendment,
            &number,
            actor,
            input,
            total,
            &now_ts,
        )?;
        let rev_id: i64 = tx.query_row(
            "SELECT current_revision_id FROM leave_requests WHERE id=?1",
            [child_id],
            |r| r.get(0),
        )?;
        model::snapshot_policy(tx, rev_id, today)?;
        let day_ids = store_days(tx, rev_id, &days)?;
        store_allocations(tx, rev_id, &day_ids, &allocs)?;
        // positive delta per account -> reservation
        let mut delta = alloc_totals(&allocs);
        for (acc, m) in &eff_totals {
            *delta.entry(*acc).or_default() -= m;
        }
        delta.retain(|_, m| *m > 0);
        create_reservations(tx, child_id, rev_id, &delta, &now_ts, today)?;
        create_route(tx, child_id, rev_id, parent.employee_id, today, &now_ts)?;
        model::bump_version(tx, parent.id, &now_ts)?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.amend",
            "request",
            Some(child_id),
            serde_json::json!({"parent": parent.id, "minutes": total}),
        )?;
        let subject = subject_for(&number);
        notify_employee(
            tx,
            &parent,
            rev_id,
            "amendment",
            &subject,
            &format!(
                "An amendment to your request {} was submitted. Open: /requests/{}",
                parent.number, child_id
            ),
            &now_ts,
        )?;
        let out = ChildCreated {
            request_id: child_id,
            number,
        };
        idem_store(
            tx,
            actor.user_id,
            idempotency_key,
            &hash,
            &serde_json::to_string(&out)?,
            &now_ts,
        )?;
        Ok(out)
    })
}

/// File a cancellation (full or partial) against an approved request.
/// The cancellation's own revision covers the parent's effective range with
/// days in [from_date, to_date] rewritten as part='none', minutes=0.
/// On approval the freed minutes are returned per account and the parent's
/// effective revision switches to the cancellation's revision.
#[allow(clippy::too_many_arguments)]
pub fn cancel(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    parent_id: i64,
    from_date: Date,
    to_date: Date,
    change_reason: &str,
    expected_version: i64,
    idempotency_key: Option<&str>,
) -> Res<ChildCreated> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    let hash = sha256_hex(&format!(
        "cancel:{parent_id}:{}:{}:{change_reason}:{expected_version}",
        date_s(&from_date),
        date_s(&to_date)
    ));
    crate::db::write_tx(conn, |tx| {
        if let Some(resp) = idem_check(tx, actor.user_id, idempotency_key, &hash)? {
            return Ok(serde_json::from_str(&resp)?);
        }
        if to_date < from_date {
            return Err(DomainError::validation("to_date before from_date"));
        }
        if from_date < today {
            return Err(DomainError::PastDatesNeedHrCorrection);
        }
        let parent = model::load_request(tx, parent_id)?;
        check_changeable_parent(
            tx,
            actor,
            &parent,
            expected_version,
            today,
            Action::CancelRequest,
        )?;
        let eff_id = parent.effective_revision_id.unwrap();
        let eff_rev = model::load_revision(tx, eff_id)?;
        let eff_days = model::revision_days(tx, eff_id)?;
        let affected = eff_days
            .iter()
            .filter(|d| d.date >= from_date && d.date <= to_date && d.minutes > 0)
            .count();
        if affected == 0 {
            return Err(DomainError::validation(
                "the range contains no active leave days to cancel",
            ));
        }
        let number = next_number(tx, today)?;
        // the cancellation revision covers the parent's effective range
        let input = ReviseInput {
            leave_type_id: eff_rev.leave_type_id,
            start_date: eff_rev.start_date,
            end_date: eff_rev.end_date,
            start_part: eff_rev.start_part,
            end_part: eff_rev.end_part,
            note: eff_rev.note.clone(),
            change_reason: change_reason.to_string(),
        };
        let remaining: i64 = eff_days
            .iter()
            .filter(|d| !(d.date >= from_date && d.date <= to_date))
            .map(|d| d.minutes)
            .sum();
        let child_id = insert_child(
            tx,
            &parent,
            RequestKind::Cancellation,
            &number,
            actor,
            &input,
            remaining,
            &now_ts,
        )?;
        let rev_id: i64 = tx.query_row(
            "SELECT current_revision_id FROM leave_requests WHERE id=?1",
            [child_id],
            |r| r.get(0),
        )?;
        tx.execute("UPDATE request_revisions SET policy_version_id=(SELECT policy_version_id FROM request_revisions WHERE id=?2),policy_snapshot=(SELECT policy_snapshot FROM request_revisions WHERE id=?2) WHERE id=?1",params![rev_id,eff_id])?;
        // copy the effective day rows; cancelled days become part='none'/0
        let mut old_to_new_day: BTreeMap<i64, i64> = BTreeMap::new();
        for d in &eff_days {
            let cancelled = d.date >= from_date && d.date <= to_date && d.minutes > 0;
            let new_day: i64 = tx.query_row(
                "INSERT INTO request_days
                 (revision_id, date, part, scheduled_minutes, minutes,
                  schedule_version_id, exception_id, period_year, explanation)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) RETURNING id",
                params![
                    rev_id,
                    date_s(&d.date),
                    if cancelled { "none" } else { d.part.as_str() },
                    d.scheduled_minutes,
                    if cancelled { 0 } else { d.minutes },
                    d.schedule_version_id,
                    d.exception_id,
                    d.period_year,
                    if cancelled {
                        format!("Cancelled by {number}")
                    } else {
                        d.explanation.clone()
                    }
                ],
                |r| r.get(0),
            )?;
            old_to_new_day.insert(d.id, new_day);
        }
        // surviving day allocations keep paying their accounts
        for a in model::revision_allocations(tx, eff_id)? {
            if let Some(new_day) = old_to_new_day.get(&a.day_id) {
                let still_active = eff_days
                    .iter()
                    .find(|d| d.id == a.day_id)
                    .map(|d| !(d.date >= from_date && d.date <= to_date && d.minutes > 0))
                    .unwrap_or(false);
                if still_active {
                    tx.execute(
                        "INSERT INTO revision_allocations(revision_id, day_id, account_id, minutes)
                         VALUES (?1,?2,?3,?4)",
                        params![rev_id, new_day, a.account_id, a.minutes],
                    )?;
                }
            }
        }
        create_route(tx, child_id, rev_id, parent.employee_id, today, &now_ts)?;
        model::bump_version(tx, parent.id, &now_ts)?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.cancel",
            "request",
            Some(child_id),
            serde_json::json!({"parent": parent.id, "from": date_s(&from_date), "to": date_s(&to_date)}),
        )?;
        let subject = subject_for(&number);
        notify_employee(
            tx,
            &parent,
            rev_id,
            "cancellation",
            &subject,
            &format!(
                "A cancellation of your request {} was submitted. Open: /requests/{}",
                parent.number, child_id
            ),
            &now_ts,
        )?;
        let out = ChildCreated {
            request_id: child_id,
            number,
        };
        idem_store(
            tx,
            actor.user_id,
            idempotency_key,
            &hash,
            &serde_json::to_string(&out)?,
            &now_ts,
        )?;
        Ok(out)
    })
}

fn check_changeable_parent(
    conn: &Connection,
    actor: &Actor,
    parent: &LeaveRequest,
    expected_version: i64,
    today: Date,
    action: Action,
) -> Res<()> {
    if parent.kind != RequestKind::Leave {
        return Err(DomainError::validation("changes apply to leave requests"));
    }
    if parent.status != RequestStatus::Approved {
        return Err(DomainError::validation(format!(
            "request is {}, only approved requests can be changed",
            parent.status.as_str()
        )));
    }
    model::check_version(parent, expected_version)?;
    if model::open_child(conn, parent.id)?.is_some() {
        return Err(DomainError::ChangePending);
    }
    let ctx = request_ctx(conn, parent, today)?;
    authz::require(conn, actor, action, &Resource::Request(&ctx))?;
    Ok(())
}

/// Insert a submitted amendment/cancellation request + its rev 1.
#[allow(clippy::too_many_arguments)]
fn insert_child(
    conn: &Connection,
    parent: &LeaveRequest,
    kind: RequestKind,
    number: &str,
    actor: &Actor,
    input: &ReviseInput,
    total: i64,
    now_ts: &str,
) -> Res<i64> {
    let child: i64 = conn.query_row(
        "INSERT INTO leave_requests
         (number, employee_id, kind, parent_request_id, status, source,
          entered_by_user_id, version, created_at, updated_at)
         VALUES (?1,?2,?3,?4,'submitted',?5,?6,1,?7,?7) RETURNING id",
        params![
            number,
            parent.employee_id,
            kind.as_str(),
            parent.id,
            parent.source,
            actor.user_id,
            now_ts
        ],
        |r| r.get(0),
    )?;
    let rev: i64 = conn.query_row(
        "INSERT INTO request_revisions
         (request_id, rev_no, leave_type_id, start_date, end_date, start_part, end_part,
          note, change_reason, total_minutes, created_by, created_at, submitted_at)
         VALUES (?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11) RETURNING id",
        params![
            child,
            input.leave_type_id,
            date_s(&input.start_date),
            date_s(&input.end_date),
            input.start_part.as_str(),
            input.end_part.as_str(),
            input.note,
            input.change_reason,
            total,
            actor.user_id,
            now_ts
        ],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE leave_requests SET current_revision_id=?2 WHERE id=?1",
        params![child, rev],
    )?;
    Ok(child)
}

// ------------------------------------------------------------------ other actions

/// HR reassigns (or unassigns, NULL) a step's concrete executor.
pub fn reassign(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    step_id: i64,
    assignee_user_id: Option<i64>,
    expected_version: i64,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        model::check_version(&req, expected_version)?;
        let step = model::load_step(tx, step_id)?;
        if step.request_id != req.id {
            return Err(DomainError::not_found("step of another request"));
        }
        if step.status != "pending" && step.status != "waiting" {
            return Err(DomainError::validation("step already finished"));
        }
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::ReassignStep, &Resource::Request(&ctx))?;
        if let Some(who) = assignee_user_id {
            let assignee = Actor::load(tx, who, today)?;
            if ctx.employee_user_id == Some(who) {
                return Err(DomainError::SelfApprovalForbidden);
            }
            let role = match step.kind {
                StepKind::HrCheck => Some("hr"),
                StepKind::FinalDecision => Some("final_approver"),
                StepKind::ManagerRecommendation => None,
            };
            if let Some(role) = role {
                if !assignee.role_in_scope(tx, role, ctx.org_unit_id)? {
                    return Err(DomainError::forbidden(
                        "assignee lacks required role in scope",
                    ));
                }
            }
        }
        tx.execute(
            "UPDATE approval_steps SET assignee_user_id=?2 WHERE id=?1",
            params![step_id, assignee_user_id],
        )?;
        model::bump_version(tx, req.id, &now_ts)?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "step.reassign",
            "request",
            Some(req.id),
            serde_json::json!({"step_id": step_id, "assignee": assignee_user_id}),
        )?;
        Ok(())
    })
}

/// Post a comment on a request (participants with write access).
pub fn comment(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    body: &str,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::Comment, &Resource::Request(&ctx))?;
        tx.execute(
            "INSERT INTO messages(request_id, author_user_id, kind, body, created_at)
             VALUES (?1,?2,'comment',?3,?4)",
            params![req.id, actor.user_id, body, now_ts],
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "request.comment",
            "request",
            Some(req.id),
            serde_json::json!({}),
        )?;
        notify::record_change(tx, clock, actor.user_id, "request.comment")?;
        Ok(())
    })
}

pub const MAX_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_REQUEST: i64 = 5;

/// Upload an attachment: magic-byte type check, size/count limits, and scanner
/// verdict. The file is written before the DB row commits (DESIGN §10).
#[allow(clippy::too_many_arguments)]
pub fn upload_attachment(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    store: &FileStore,
    request_id: i64,
    filename: &str,
    bytes: &[u8],
    sensitivity: &str,
) -> Res<i64> {
    let req = model::load_request(conn, request_id)?;
    let ctx = request_ctx(conn, &req, clock.today(conn)?)?;
    authz::require(
        conn,
        actor,
        Action::UploadAttachment,
        &Resource::Request(&ctx),
    )?;
    let prepared = prepare_attachment(store, bytes, sensitivity)?;
    let result = record_attachment(
        conn,
        clock,
        actor,
        request_id,
        filename,
        sensitivity,
        &prepared,
    );
    if result.is_err() {
        let _ = store.remove(&prepared.storage_key);
    }
    result
}

pub struct PreparedAttachment {
    pub storage_key: String,
    content_type: &'static str,
    size_bytes: i64,
    digest: String,
    scan_status: &'static str,
    scan_note: Option<String>,
}
pub fn prepare_attachment(
    store: &FileStore,
    bytes: &[u8],
    sensitivity: &str,
) -> Res<PreparedAttachment> {
    let content_type = files::sniff(bytes)
        .ok_or_else(|| DomainError::validation("unsupported file type (PDF/PNG/JPEG only)"))?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(DomainError::validation("file too large"));
    }
    if sensitivity != "normal" && sensitivity != "medical" {
        return Err(DomainError::validation("bad sensitivity"));
    }
    let scan = store.scan(bytes)?;
    let digest = hex::encode(Sha256::digest(bytes));
    // file first, then the row (crash-safe ordering)
    let storage_key = store.put(bytes)?;
    Ok(PreparedAttachment {
        content_type,
        size_bytes: bytes.len() as i64,
        digest,
        storage_key,
        scan_status: scan.status,
        scan_note: scan.note,
    })
}

pub fn record_attachment(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    filename: &str,
    sensitivity: &str,
    prepared: &PreparedAttachment,
) -> Res<i64> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(
            tx,
            actor,
            Action::UploadAttachment,
            &Resource::Request(&ctx),
        )?;
        let n: i64 = tx.query_row(
            "SELECT COUNT(*) FROM attachments WHERE request_id=?1",
            [request_id],
            |r| r.get(0),
        )?;
        if n >= MAX_ATTACHMENTS_PER_REQUEST {
            return Err(DomainError::validation("too many attachments"));
        }
        let id: i64 = tx.query_row(
            "INSERT INTO attachments
             (request_id, uploaded_by, filename, content_type, size_bytes, sha256,
              storage_key, sensitivity, scan_status, scan_note, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) RETURNING id",
            params![
                request_id,
                actor.user_id,
                filename,
                prepared.content_type,
                prepared.size_bytes,
                prepared.digest,
                prepared.storage_key,
                sensitivity,
                prepared.scan_status,
                prepared.scan_note,
                now_ts
            ],
            |r| r.get(0),
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "attachment.upload",
            "attachment",
            Some(id),
            serde_json::json!({"request_id": request_id, "scan_status": prepared.scan_status}),
        )?;
        notify::record_change(tx, clock, actor.user_id, "attachment.upload")?;
        Ok(id)
    })
}

/// After an approved period ended: HR confirms the actual period or proposes
/// an adjustment (decided by a different adjustment_approver).
/// Returns the adjustment id for `propose_adjustment`.
#[allow(clippy::too_many_arguments)]
pub fn actual_period(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    request_id: i64,
    action: &str, // 'confirm' | 'propose_adjustment'
    note: &str,
    worked_dates: Option<&[Date]>,
    basis_document: Option<&str>,
    expected_version: i64,
) -> Res<Vec<i64>> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let req = model::load_request(tx, request_id)?;
        if req.kind != RequestKind::Leave || req.status != RequestStatus::Approved {
            return Err(DomainError::validation(
                "actual period applies to approved leave",
            ));
        }
        model::check_version(&req, expected_version)?;
        let ctx = request_ctx(tx, &req, today)?;
        authz::require(tx, actor, Action::ConfirmActual, &Resource::Request(&ctx))?;
        let eff = model::load_revision(tx, req.effective_revision_id.unwrap())?;
        if eff.end_date >= today {
            return Err(DomainError::validation(
                "the leave period has not ended yet",
            ));
        }
        match action {
            "confirm" => {
                tx.execute(
                    "UPDATE leave_requests SET actual_confirmed_by=?2, actual_confirmed_at=?3,
                     actual_note=?4 WHERE id=?1",
                    params![req.id, actor.user_id, now_ts, note],
                )?;
                audit::log(
                    tx,
                    &now_ts,
                    Some(actor.user_id),
                    None,
                    "request.confirm_actual",
                    "request",
                    Some(req.id),
                    serde_json::json!({"note": note}),
                )?;
                model::bump_version(tx, req.id, &now_ts)?;
                notify_employee(
                    tx,
                    &req,
                    eff.id,
                    "actual.confirm",
                    &subject_for(&req.number),
                    "The actual leave period was confirmed.",
                    &now_ts,
                )?;
                Ok(Vec::new())
            }
            "propose_adjustment" => {
                let worked = worked_dates
                    .filter(|dates| !dates.is_empty())
                    .ok_or_else(|| DomainError::validation("worked_dates required"))?;
                let basis = basis_document
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| DomainError::validation("basis_document required"))?;
                let dates: std::collections::BTreeSet<Date> = worked.iter().copied().collect();
                if dates.len() != worked.len() {
                    return Err(DomainError::validation("worked_dates must be unique"));
                }
                let days = model::revision_days(tx, eff.id)?;
                for date in &dates {
                    if !days.iter().any(|day| day.date == *date && day.minutes > 0) {
                        return Err(DomainError::validation(
                            "worked_dates must be working leave days in the in-force revision",
                        ));
                    }
                }
                let mut amounts: BTreeMap<i64, i64> = BTreeMap::new();
                for alloc in model::revision_allocations(tx, eff.id)? {
                    if days
                        .iter()
                        .any(|day| day.id == alloc.day_id && dates.contains(&day.date))
                    {
                        *amounts.entry(alloc.account_id).or_default() += alloc.minutes;
                    }
                }
                if amounts.values().sum::<i64>()
                    != days
                        .iter()
                        .filter(|day| dates.contains(&day.date))
                        .map(|day| day.minutes)
                        .sum::<i64>()
                {
                    return Err(DomainError::validation(
                        "worked days have no balance allocation to return",
                    ));
                }
                let mut ids = Vec::new();
                for (account, minutes) in amounts {
                    let (leave_type, year): (i64, i64) = tx.query_row(
                        "SELECT leave_type_id,period_year FROM leave_accounts WHERE id=?1",
                        [account],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?;
                    ids.push(ledger::propose_adjustment_in(
                        tx,
                        actor,
                        req.employee_id,
                        leave_type,
                        year,
                        minutes,
                        &format!("Actual-period correction {}: {}", req.number, note),
                        basis,
                        Some(req.id),
                        &now_ts,
                    )?);
                }
                audit::log(
                    tx,
                    &now_ts,
                    Some(actor.user_id),
                    None,
                    "request.propose_actual_adjustment",
                    "request",
                    Some(req.id),
                    serde_json::json!({"adjustment_ids":ids,"worked_dates":dates.iter().map(date_s).collect::<Vec<_>>()}),
                )?;
                model::bump_version(tx, req.id, &now_ts)?;
                notify_employee(
                    tx,
                    &req,
                    eff.id,
                    "actual.correction",
                    &subject_for(&req.number),
                    "An actual-period correction was proposed.",
                    &now_ts,
                )?;
                Ok(ids)
            }
            _ => Err(DomainError::validation(
                "action must be confirm|propose_adjustment",
            )),
        }
    })
}

// ------------------------------------------------------------------ queries

/// Requests with unassigned pending/waiting steps — the HR "problems" list.
pub fn unassigned_steps(conn: &Connection) -> Res<Vec<(i64, i64, String)>> {
    let mut st = conn.prepare(
        "SELECT s.request_id, s.id, s.kind FROM approval_steps s
         JOIN leave_requests lr ON lr.id = s.request_id
         WHERE s.assignee_user_id IS NULL AND s.status IN ('pending','waiting')
           AND lr.status IN ('submitted','needs_information','under_review')
         ORDER BY s.request_id, s.seq",
    )?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Date phase for an approved request (derived, never stored).
pub fn date_phase(req: &LeaveRequest, eff: &Revision, today: Date) -> Option<&'static str> {
    if req.status != RequestStatus::Approved {
        return None;
    }
    Some(if eff.end_date < today {
        "period_ended"
    } else if eff.start_date > today {
        "upcoming"
    } else {
        "in_progress"
    })
}

/// The currently pending step of a request (if the actor may decide it, the
/// HTTP layer additionally attaches `decidable_step`).
pub fn pending_step(conn: &Connection, request_id: i64) -> Res<Option<Step>> {
    let steps = model::steps_of(conn, request_id)?;
    Ok(steps.into_iter().find(|s| s.status == "pending"))
}
