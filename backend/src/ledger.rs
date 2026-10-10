//! Leave accounts and the immutable movement ledger (DESIGN §3).
//!
//! - account = (employee, leave_type, period_year), created lazily
//! - balance_at(date) = SUM(minutes) WHERE effective_date <= date
//! - reserved = SUM(active reservations)
//! - available = balance − reserved
//! - every posting carries a deterministic op_key; replay is a no-op.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use time::Date;

use crate::audit;
use crate::authz::{self, Action, Actor, Resource};
use crate::calendar::ComputedDay;
use crate::clock::Clock;
use crate::error::DomainError;
use crate::model::{self, add_months, date_s, Adjustment};
use crate::Res;

// ------------------------------------------------------------------ accounts

/// Lazily create the (employee, leave_type, year) account.
pub fn ensure_account(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    period_year: i64,
) -> Res<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO leave_accounts(employee_id, leave_type_id, period_year)
         VALUES (?1, ?2, ?3)",
        params![employee_id, leave_type_id, period_year],
    )?;
    let id = conn.query_row(
        "SELECT id FROM leave_accounts
         WHERE employee_id=?1 AND leave_type_id=?2 AND period_year=?3",
        params![employee_id, leave_type_id, period_year],
        |r| r.get(0),
    )?;
    Ok(id)
}

/// Ledger balance of the account on `date` (applied movements only).
pub fn balance_at(conn: &Connection, account_id: i64, date: Date) -> Res<i64> {
    let v: Option<i64> = conn.query_row(
        "SELECT SUM(minutes) FROM ledger_entries
         WHERE account_id=?1 AND effective_date<=?2",
        params![account_id, date_s(&date)],
        |r| r.get(0),
    )?;
    Ok(v.unwrap_or(0))
}

/// Minutes currently reserved on the account.
pub fn reserved(conn: &Connection, account_id: i64) -> Res<i64> {
    let v: Option<i64> = conn.query_row(
        "SELECT SUM(minutes) FROM reservations WHERE account_id=?1 AND active=1",
        [account_id],
        |r| r.get(0),
    )?;
    Ok(v.unwrap_or(0))
}

pub fn reserved_at(conn: &Connection, account_id: i64, on: Date) -> Res<i64> {
    Ok(conn.query_row("SELECT COALESCE(SUM(minutes),0) FROM reservations WHERE account_id=?1 AND reserved_on<=?2 AND (released_on IS NULL OR released_on>?2)",params![account_id,date_s(&on)],|r|r.get(0))?)
}

/// Available for a new request on `today`.
pub fn available(conn: &Connection, account_id: i64, today: Date) -> Res<i64> {
    Ok(balance_at(conn, account_id, today)? - reserved(conn, account_id)?)
}

/// All accounts of an employee (+type filter optional).
pub fn accounts_of(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: Option<i64>,
) -> Res<Vec<(i64, i64, i64)>> {
    // (account_id, leave_type_id, period_year)
    let sql = match leave_type_id {
        Some(_) => {
            "SELECT id, leave_type_id, period_year FROM leave_accounts
             WHERE employee_id=?1 AND leave_type_id=?2 ORDER BY period_year"
        }
        None => {
            "SELECT id, leave_type_id, period_year FROM leave_accounts
             WHERE employee_id=?1 AND ?2 IS NULL ORDER BY leave_type_id, period_year"
        }
    };
    let mut st = conn.prepare(sql)?;
    let rows = st.query_map(params![employee_id, leave_type_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[derive(Clone, Debug, Serialize)]
pub struct AccountBalance {
    pub account_id: i64,
    pub period_year: i64,
    pub ledger_minutes: i64,
    pub reserved_minutes: i64,
    pub available_minutes: i64,
}

/// Per-account balances of one leave type for an employee.
pub fn balance_summary(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    today: Date,
) -> Res<Vec<AccountBalance>> {
    let mut out = Vec::new();
    for (acc, _lt, year) in accounts_of(conn, employee_id, Some(leave_type_id))? {
        out.push(AccountBalance {
            account_id: acc,
            period_year: year,
            ledger_minutes: balance_at(conn, acc, today)?,
            reserved_minutes: reserved_at(conn, acc, today)?,
            available_minutes: balance_at(conn, acc, today)? - reserved_at(conn, acc, today)?,
        });
    }
    Ok(out)
}

/// Convenience: totals across an employee's accounts of one type.
pub fn totals(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    today: Date,
) -> Res<(i64, i64, i64)> {
    let mut t = (0, 0, 0);
    for b in balance_summary(conn, employee_id, leave_type_id, today)? {
        t.0 += b.ledger_minutes;
        t.1 += b.reserved_minutes;
        t.2 += b.available_minutes;
    }
    Ok(t)
}

// ------------------------------------------------------------------ posting

#[derive(Clone)]
pub struct PostEntry<'a> {
    pub account_id: i64,
    pub minutes: i64,
    pub kind: &'a str,
    pub effective_date: Date,
    pub request_id: Option<i64>,
    pub revision_id: Option<i64>,
    pub reverses_entry_id: Option<i64>,
    pub adjustment_id: Option<i64>,
    pub import_batch_id: Option<i64>,
    pub basis: String,
    pub author_user_id: Option<i64>,
    pub op_key: String,
}

pub struct PostOutcome {
    pub entry_id: i64,
    /// false = the op_key already existed (replay is a no-op).
    pub inserted: bool,
}

/// Insert an immutable ledger entry. `INSERT OR IGNORE` on op_key makes a
/// replay a no-op; `inserted` reports whether a row was actually written.
pub fn post_entry(conn: &Connection, e: &PostEntry, now_ts: &str) -> Res<PostOutcome> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO ledger_entries
         (account_id, minutes, kind, effective_date, request_id, revision_id,
          reverses_entry_id, adjustment_id, import_batch_id, basis, author_user_id,
          op_key, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            e.account_id,
            e.minutes,
            e.kind,
            date_s(&e.effective_date),
            e.request_id,
            e.revision_id,
            e.reverses_entry_id,
            e.adjustment_id,
            e.import_batch_id,
            e.basis,
            e.author_user_id,
            e.op_key,
            now_ts,
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM ledger_entries WHERE op_key=?1",
        [&e.op_key],
        |r| r.get(0),
    )?;
    Ok(PostOutcome {
        entry_id: id,
        inserted: n > 0,
    })
}

// ------------------------------------------------------------------ allocate

/// Planned allocation of one computed day: which account pays how much.
#[derive(Clone, Debug)]
pub struct DayAllocation {
    pub day_index: usize,
    pub account_id: i64,
    pub period_year: i64,
    pub minutes: i64,
    /// true when the account's period differs from the day's year.
    pub carryover: bool,
}

/// Distribute `days` minutes across accounts per DESIGN §3: the day's own-year
/// account first, then earlier accounts oldest-first when carryover is allowed
/// and unexpired. `extra_available` credits accounts (used by amendments to
/// add the parent's current allocation back into the capacity pool).
/// `uses_balance=0` types produce no allocation at all.
pub fn allocate(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    days: &[ComputedDay],
    today: Date,
    extra_available: &BTreeMap<i64, i64>,
) -> Res<Vec<DayAllocation>> {
    allocate_with_credit(
        conn,
        employee_id,
        leave_type_id,
        days,
        today,
        extra_available,
        None,
    )
}

/// Reallocating an amendment replaces its parent's effective allocation.
/// Only that revision's carry-over usage is credited back against the limit.
#[allow(clippy::too_many_arguments)]
pub fn allocate_with_credit(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    days: &[ComputedDay],
    today: Date,
    extra_available: &BTreeMap<i64, i64>,
    credit_revision: Option<i64>,
) -> Res<Vec<DayAllocation>> {
    let lt = model::leave_type_on(conn, leave_type_id, today)?;
    if !lt.uses_balance {
        return Ok(Vec::new());
    }
    let policy = model::policy_for(conn, leave_type_id, today)?
        .ok_or_else(|| DomainError::NoPolicy(lt.code.clone()))?;

    // Capacity per account = balance(today) − active reservations + extra − already taken here.
    let mut taken: BTreeMap<i64, i64> = BTreeMap::new();
    let mut carry_taken: BTreeMap<i64, i64> = BTreeMap::new();
    let mut out = Vec::new();

    for (idx, day) in days.iter().enumerate() {
        if day.minutes <= 0 {
            continue;
        }
        let mut need = day.minutes;
        let year = day.period_year;

        // own-year account first
        let own = ensure_account(conn, employee_id, leave_type_id, year)?;
        let mut give = take_from(conn, own, need, today, &mut taken, extra_available)?;
        if give > 0 {
            out.push(DayAllocation {
                day_index: idx,
                account_id: own,
                period_year: year,
                minutes: give,
                carryover: false,
            });
            need -= give;
        }

        // then older accounts if carryover allowed and unexpired
        if need > 0 && policy.carryover_allowed {
            for acc in earlier_accounts(conn, employee_id, leave_type_id, year)? {
                let close_policy: Option<i64> = conn
                    .query_row(
                        "SELECT policy_version_id FROM period_closures WHERE account_id=?1",
                        [acc.0],
                        |r| r.get(0),
                    )
                    .optional()?;
                let carry_policy = close_policy
                    .map(|id| model::policy_by_id(conn, id))
                    .transpose()?
                    .unwrap_or_else(|| policy.clone());
                if !carry_policy.carryover_allowed || carryover_expired(&carry_policy, acc.1, today)
                {
                    continue;
                }
                let capacity = carryover_capacity(
                    conn,
                    acc.0,
                    &carry_policy,
                    today,
                    &taken,
                    extra_available,
                    &carry_taken,
                    credit_revision,
                )?;
                give = take_from(
                    conn,
                    acc.0,
                    need.min(capacity),
                    today,
                    &mut taken,
                    extra_available,
                )?;
                if give > 0 {
                    out.push(DayAllocation {
                        day_index: idx,
                        account_id: acc.0,
                        period_year: acc.1,
                        minutes: give,
                        carryover: true,
                    });
                    *carry_taken.entry(acc.0).or_default() += give;
                    need -= give;
                    if need == 0 {
                        break;
                    }
                }
            }
        }

        if need > 0 {
            if !policy.allow_negative {
                let avail = account_available_now(conn, own, today, &taken, extra_available)?;
                return Err(DomainError::InsufficientBalance(format!(
                    "{}: need {} more minutes for {}, available {} on {} account",
                    lt.code,
                    need,
                    date_s(&day.date),
                    avail.max(0),
                    year
                )));
            }
            out.push(DayAllocation {
                day_index: idx,
                account_id: own,
                period_year: year,
                minutes: need,
                carryover: false,
            });
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn carryover_capacity(
    conn: &Connection,
    acc: i64,
    policy: &model::Policy,
    today: Date,
    taken: &BTreeMap<i64, i64>,
    extra: &BTreeMap<i64, i64>,
    carry_taken: &BTreeMap<i64, i64>,
    credit_revision: Option<i64>,
) -> Res<i64> {
    let capacity = account_available_now(conn, acc, today, taken, extra)?.max(0);
    let Some(limit) = policy.carryover_limit_min else {
        return Ok(capacity);
    };
    let used = carryover_used(conn, acc, credit_revision)?;
    Ok(capacity.min((limit - used - carry_taken.get(&acc).copied().unwrap_or(0)).max(0)))
}

/// Approved effective days plus the carry-over portion of active reservations.
/// A pending amendment reserves only its positive delta over the parent.
fn carryover_used(conn: &Connection, acc: i64, credit_revision: Option<i64>) -> Res<i64> {
    let approved: i64 = conn.query_row(
        "SELECT COALESCE(SUM(ra.minutes),0) FROM revision_allocations ra
         JOIN request_days rd ON rd.id=ra.day_id
         JOIN leave_accounts ac ON ac.id=ra.account_id
         JOIN leave_requests lr ON lr.effective_revision_id=ra.revision_id
         WHERE ra.account_id=?1 AND rd.period_year>ac.period_year
         AND lr.kind='leave' AND lr.status IN ('approved','cancelled')
         AND (?2 IS NULL OR ra.revision_id<>?2)",
        params![acc, credit_revision],
        |r| r.get(0),
    )?;
    let pending: i64 = conn.query_row(
        "SELECT COALESCE(SUM(MIN(r.minutes,
         (SELECT COALESCE(SUM(ra.minutes),0) FROM revision_allocations ra
          JOIN request_days rd ON rd.id=ra.day_id
          WHERE ra.revision_id=r.revision_id AND ra.account_id=r.account_id AND rd.period_year>ac.period_year)
         )),0) FROM reservations r
         JOIN leave_accounts ac ON ac.id=r.account_id JOIN leave_requests lr ON lr.id=r.request_id
         WHERE r.account_id=?1 AND r.active=1 AND lr.kind='leave'",[acc],|r|r.get(0))?;
    // Moving an own-year day into a later year can reserve carry-over allowance
    // without increasing the account total. Count that delta even when no new
    // financial reservation is needed. Revisions of this same parent replace it.
    let amendment_delta: i64 = conn.query_row(
        "SELECT COALESCE(SUM(MAX(0,
         (SELECT COALESCE(SUM(ra.minutes),0) FROM revision_allocations ra
          JOIN request_days rd ON rd.id=ra.day_id
          WHERE ra.revision_id=lr.current_revision_id AND ra.account_id=?1 AND rd.period_year>ac.period_year)
         - (SELECT COALESCE(SUM(ra.minutes),0) FROM revision_allocations ra
          JOIN request_days rd ON rd.id=ra.day_id
          WHERE ra.revision_id=parent.effective_revision_id AND ra.account_id=?1 AND rd.period_year>ac.period_year)
         )),0) FROM leave_requests lr
         JOIN leave_requests parent ON parent.id=lr.parent_request_id
         JOIN leave_accounts ac ON ac.id=?1
         WHERE lr.kind='amendment' AND lr.status IN ('submitted','under_review','needs_information')
         AND (?2 IS NULL OR parent.effective_revision_id<>?2)",params![acc,credit_revision],|r|r.get(0))?;
    Ok(approved + pending + amendment_delta)
}

fn take_from(
    conn: &Connection,
    account_id: i64,
    need: i64,
    today: Date,
    taken: &mut BTreeMap<i64, i64>,
    extra: &BTreeMap<i64, i64>,
) -> Res<i64> {
    let avail = account_available_now(conn, account_id, today, taken, extra)?;
    let give = need.min(avail.max(0));
    if give > 0 {
        *taken.entry(account_id).or_default() += give;
    }
    Ok(give)
}

fn account_available_now(
    conn: &Connection,
    account_id: i64,
    today: Date,
    taken: &BTreeMap<i64, i64>,
    extra: &BTreeMap<i64, i64>,
) -> Res<i64> {
    Ok(
        available(conn, account_id, today)? + extra.get(&account_id).copied().unwrap_or(0)
            - taken.get(&account_id).copied().unwrap_or(0),
    )
}

/// Earlier-year accounts of the same type, oldest first.
fn earlier_accounts(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    year: i64,
) -> Res<Vec<(i64, i64)>> {
    let mut st = conn.prepare(
        "SELECT id, period_year FROM leave_accounts
         WHERE employee_id=?1 AND leave_type_id=?2 AND period_year<?3
         ORDER BY period_year",
    )?;
    let rows = st.query_map(params![employee_id, leave_type_id, year], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Is balance carried out of `from_year` expired on `today`?
/// expiry = first day of month `carryover_expiry_months` + 1 of the next year
/// (N months of grace), NULL = never expires.
pub fn carryover_expired(policy: &model::Policy, from_year: i64, today: Date) -> bool {
    match policy.carryover_expiry_months {
        None => false,
        Some(m) => {
            let expiry = add_months(
                Date::from_calendar_date((from_year + 1) as i32, time::Month::January, 1).unwrap(),
                m,
            );
            today >= expiry
        }
    }
}

/// Expiry date of a year's carryover balance (used by period close).
pub fn carryover_expiry_date(policy: &model::Policy, from_year: i64) -> Option<Date> {
    policy.carryover_expiry_months.map(|m| {
        add_months(
            Date::from_calendar_date((from_year + 1) as i32, time::Month::January, 1).unwrap(),
            m,
        )
    })
}

// ------------------------------------------------------------------ reservations

pub fn create_reservation(
    conn: &Connection,
    request_id: i64,
    revision_id: i64,
    account_id: i64,
    minutes: i64,
    now_ts: &str,
    today: Date,
) -> Res<()> {
    conn.execute(
        "INSERT INTO reservations(request_id, revision_id, account_id, minutes, active, created_at,reserved_on)
         VALUES (?1,?2,?3,?4,1,?5,?6)",
        params![request_id, revision_id, account_id, minutes, now_ts,date_s(&today)],
    )?;
    Ok(())
}

/// Release all active reservations of a request (`approved` releases by
/// revision — see callers). Returns released count.
pub fn release_reservations(
    conn: &Connection,
    request_id: i64,
    reason: &str,
    now_ts: &str,
    today: Date,
) -> Res<usize> {
    let n = conn.execute(
        "UPDATE reservations SET active=0, released_at=?2, release_reason=?3,released_on=?4
         WHERE request_id=?1 AND active=1",
        params![request_id, now_ts, reason, date_s(&today)],
    )?;
    Ok(n)
}

// ------------------------------------------------------------------ accrual / close

#[derive(Debug)]
pub struct AccrualRun {
    pub posted: usize,
    pub skipped_existing: usize,
}

/// Run an accrual for `period_year` for every employee active in that year.
/// `annual_upfront`: whole entitlement, allowed from `advance_publish_months`
/// before Jan 1 of the year; `monthly`: `month` (1..=12) required, posts the
/// cumulative-slice for that month. Idempotent via op_key
/// `accrual:{policy}:{emp}:{year}(:{month})`.
pub fn run_accrual(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    leave_type_id: i64,
    period_year: i64,
    month: Option<i64>,
) -> Res<AccrualRun> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        authz::require(tx, actor, Action::RunAccrual, &Resource::Global)?;
        if month.is_some_and(|m| !(1..=12).contains(&m)) {
            return Err(DomainError::validation("month must be 1..=12"));
        }
        let period_start = Date::from_calendar_date(
            period_year as i32,
            time::Month::try_from(month.unwrap_or(1) as u8)
                .map_err(|_| DomainError::validation("invalid month"))?,
            1,
        )
        .map_err(|_| DomainError::validation("invalid period year"))?;
        let lt = model::leave_type_on(tx, leave_type_id, period_start)?;
        if !lt.uses_balance {
            return Err(DomainError::validation(format!(
                "{} does not use balances",
                lt.code
            )));
        }
        let policy = model::policy_for(tx, leave_type_id, period_start)?
            .ok_or_else(|| DomainError::validation("no policy"))?;

        match policy.accrual_mode.as_str() {
            "none" => {
                return Err(DomainError::validation(format!(
                    "{} has accrual_mode none",
                    lt.code
                )))
            }
            "annual_upfront" => {
                if month.is_some() {
                    return Err(DomainError::validation("annual_upfront takes no month"));
                }
                let earliest = add_months(
                    Date::from_calendar_date(period_year as i32, time::Month::January, 1).unwrap(),
                    -policy.advance_publish_months,
                );
                if today < earliest {
                    return Err(DomainError::validation(format!(
                        "accrual for {period_year} allowed from {}",
                        date_s(&earliest)
                    )));
                }
            }
            "monthly" => {
                let m = month
                    .ok_or_else(|| DomainError::validation("monthly accrual requires month"))?;
                if !(1..=12).contains(&m) {
                    return Err(DomainError::validation("month must be 1..=12"));
                }
                // may run at most in the target month itself
                let first = Date::from_calendar_date(
                    period_year as i32,
                    time::Month::try_from(m as u8).unwrap(),
                    1,
                )
                .unwrap();
                if today < first {
                    return Err(DomainError::validation(format!(
                        "accrual for {period_year}-{m} allowed from {}",
                        date_s(&first)
                    )));
                }
            }
            other => return Err(DomainError::validation(format!("bad accrual_mode {other}"))),
        }

        let mut run = AccrualRun {
            posted: 0,
            skipped_existing: 0,
        };
        let mut st = tx.prepare(
            "SELECT id FROM employees WHERE active=1
               AND start_date<=?1 AND (end_date IS NULL OR end_date>=?2)",
        )?;
        let emps: Vec<i64> = st
            .query_map(
                params![
                    date_s(
                        &Date::from_calendar_date(period_year as i32, time::Month::December, 31)
                            .unwrap()
                    ),
                    date_s(
                        &Date::from_calendar_date(period_year as i32, time::Month::January, 1)
                            .unwrap()
                    )
                ],
                |r| r.get(0),
            )?
            .collect::<rusqlite::Result<Vec<i64>>>()?;

        for emp in emps {
            let acc = ensure_account(tx, emp, leave_type_id, period_year)?;
            let minutes = match month {
                Some(m) => policy.annual_entitlement_min * m / 12 - policy.annual_entitlement_min * (m - 1) / 12,
                None => policy.annual_entitlement_min,
            };
            if accrual_granted(tx, acc, emp, leave_type_id, period_year, month)? {
                run.skipped_existing += 1;
                continue;
            }
            let outcome = post_accrual_fact(
                tx,
                &PostEntry {
                    account_id: acc,
                    minutes,
                    kind: "accrual",
                    effective_date: today,
                    request_id: None,
                    revision_id: None,
                    reverses_entry_id: None,
                    adjustment_id: None,
                    import_batch_id: None,
                    basis: format!("{} entitlement {period_year}", lt.name),
                    author_user_id: Some(actor.user_id),
                    op_key: String::new(),
                },
                month,
                &now_ts,
            )?;
            if outcome.inserted {
                run.posted += 1;
            } else {
                run.skipped_existing += 1;
            }
        }
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "accrual.run",
            "leave_type",
            Some(leave_type_id),
            serde_json::json!({"period_year": period_year, "month": month, "posted": run.posted}),
        )?;
        crate::notify::record_change(tx, clock, actor.user_id, "accrual.run")?;
        Ok(run)
    })
}

/// One fact path for seeded entitlements and ordinary accrual runs.
pub(crate) fn post_accrual_fact(conn: &Connection, entry: &PostEntry, month: Option<i64>, now: &str) -> Res<PostOutcome> {
    let (emp, lt, year): (i64, i64, i64) = conn.query_row("SELECT employee_id,leave_type_id,period_year FROM leave_accounts WHERE id=?1", [entry.account_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let mut fact = entry.clone();
    fact.kind = "accrual";
    fact.op_key = accrual_key(emp, lt, year, month);
    post_entry(conn, &fact, now)
}

fn accrual_key(emp: i64, leave_type_id: i64, period_year: i64, month: Option<i64>) -> String {
    match month {
        Some(m) => format!("accrual:{emp}:{leave_type_id}:{period_year}-{m:02}"),
        None => format!("accrual:{emp}:{leave_type_id}:{period_year}"),
    }
}

fn accrual_granted(conn: &Connection, acc: i64, emp: i64, leave_type_id: i64, period_year: i64, month: Option<i64>) -> Res<bool> {
    let op_key = accrual_key(emp, leave_type_id, period_year, month);
    let legacy_pattern = match month {
        Some(m) => format!("accrual:%:{emp}:{period_year}:{m}"),
        None => format!("accrual:%:{emp}:{period_year}"),
    };
    let existing:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM ledger_entries WHERE account_id=?1 AND kind='accrual' AND (op_key=?2 OR (op_key LIKE ?3 AND length(op_key)-length(replace(op_key,':',''))=?4)))",params![acc,op_key,legacy_pattern,if month.is_some(){4}else{3}],|r|r.get(0))?;
    let annual_key = format!("accrual:{emp}:{leave_type_id}:{period_year}");
    let legacy_annual = format!("accrual:%:{emp}:{period_year}");
    let covered: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ledger_entries WHERE account_id=?1 AND kind='accrual' AND
         (op_key=?2 OR (op_key LIKE ?3 AND length(op_key)-length(replace(op_key,':',''))=3)
         OR (?4 IS NULL AND (op_key LIKE ?5 OR (op_key LIKE ?6 AND length(op_key)-length(replace(op_key,':',''))=4)))))",
        params![acc,annual_key,legacy_annual,month,format!("{annual_key}-%"),format!("accrual:%:{emp}:{period_year}:%")], |r|r.get(0))?;
    Ok(existing || covered)
}

#[derive(Serialize)]
pub struct AccrualPreview {
    pub eligible: usize,
    pub skipped_existing: usize,
    pub entitlement_minutes: i64,
}

/// Read-only preview uses the same fact coverage test as the committing run.
pub fn preview_accrual(conn: &Connection, actor: &Actor, leave_type_id: i64, year: i64, month: Option<i64>) -> Res<AccrualPreview> {
    authz::require(conn, actor, Action::RunAccrual, &Resource::Global)?;
    if !(2000..=2100).contains(&year) || month.is_some_and(|m| !(1..=12).contains(&m)) {
        return Err(DomainError::validation("invalid entitlement period"));
    }
    let first = Date::from_calendar_date(year as i32, time::Month::try_from(month.unwrap_or(1) as u8).unwrap(), 1).unwrap();
    let policy = model::policy_for(conn, leave_type_id, first)?.ok_or_else(|| DomainError::validation("no policy"))?;
    if !policy.uses_balance || policy.accrual_mode == "none" || (policy.accrual_mode == "monthly") != month.is_some() {
        return Err(DomainError::validation("choose an entitlement period matching the leave rules"));
    }
    let mut st = conn.prepare("SELECT e.id, a.id FROM employees e LEFT JOIN leave_accounts a ON a.employee_id=e.id AND a.leave_type_id=?1 AND a.period_year=?2 WHERE e.active=1 AND e.start_date<=?3 AND (e.end_date IS NULL OR e.end_date>=?4)")?;
    let people = st.query_map(params![leave_type_id, year, format!("{year}-12-31"), format!("{year}-01-01")], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,Option<i64>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut skipped = 0;
    for (emp, acc) in &people {
        if let Some(acc) = acc {
            if accrual_granted(conn, *acc, *emp, leave_type_id, year, month)? { skipped += 1; }
        }
    }
    let minutes = month.map_or(policy.annual_entitlement_min, |m| policy.annual_entitlement_min*m/12-policy.annual_entitlement_min*(m-1)/12);
    Ok(AccrualPreview { eligible: people.len()-skipped, skipped_existing: skipped, entitlement_minutes: minutes })
}

#[derive(Clone, Debug, Serialize)]
pub struct CloseRow {
    pub account_id: i64,
    pub employee_id: i64,
    pub service_id: String,
    pub full_name: String,
    pub minutes_per_day: i64,
    pub left_minutes: i64,
    pub carried_minutes: i64,
    pub removed_minutes: i64,
    pub already_closed: bool,
    #[serde(skip)]
    limit_removed: i64,
    #[serde(skip)]
    expiry_removed: i64,
    #[serde(skip)]
    cap: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClosePreview {
    pub leave_type_id: i64,
    pub period_year: i64,
    pub already_closed: bool,
    pub items: Vec<CloseRow>,
}

#[derive(Serialize)]
pub struct CloseResult {
    pub posted: usize,
    #[serde(flatten)]
    pub preview: ClosePreview,
}

// The same pure arithmetic drives both the preview and the real postings.
fn close_amounts(
    free: i64,
    used: i64,
    policy: &model::Policy,
    limit_applied: bool,
    expired: bool,
    expiry_posted: bool,
) -> (i64, i64, i64) {
    let cap = if policy.carryover_allowed {
        policy
            .carryover_limit_min
            .map(|limit| free.min((limit - used).max(0)))
            .unwrap_or(free)
    } else {
        0
    };
    let limit_removed = if limit_applied { 0 } else { free - cap };
    let expiry_removed = if expired && !expiry_posted {
        free - limit_removed
    } else {
        0
    };
    (cap, limit_removed, expiry_removed)
}

fn close_plan(
    conn: &Connection,
    today: Date,
    leave_type_id: i64,
    period_year: i64,
) -> Res<(ClosePreview, model::Policy, Option<Date>)> {
    let year =
        i32::try_from(period_year).map_err(|_| DomainError::validation("invalid period year"))?;
    let end = Date::from_calendar_date(year, time::Month::December, 31)
        .map_err(|_| DomainError::validation("invalid period year"))?;
    if today <= end {
        return Err(DomainError::validation("period has not ended"));
    }
    let policy = model::policy_for(conn, leave_type_id, end)?
        .ok_or_else(|| DomainError::NoPolicy(format!("type {leave_type_id}")))?;
    let expiry = if policy.carryover_allowed {
        carryover_expiry_date(&policy, period_year)
    } else {
        end.next_day()
    };
    let mut st = conn.prepare("SELECT ac.id,e.id,e.service_id,e.full_name FROM leave_accounts ac JOIN employees e ON e.id=ac.employee_id WHERE ac.leave_type_id=?1 AND ac.period_year=?2 ORDER BY e.full_name,e.id")?;
    let accounts = st.query_map(params![leave_type_id, period_year], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut items = Vec::new();
    for account in accounts {
        let (acc, employee_id, service_id, full_name) = account?;
        let free = (balance_at(conn, acc, today)? - reserved(conn, acc)?).max(0);
        let (closure_exists, limit_posted, legacy_expiry): (bool, bool, bool) = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM period_closures WHERE account_id=?1),
             EXISTS(SELECT 1 FROM ledger_entries WHERE op_key=?2),
             EXISTS(SELECT 1 FROM ledger_entries WHERE account_id=?1 AND op_key LIKE ?3)",
            params![
                acc,
                format!("carryover-limit:{acc}"),
                format!("expiry:{acc}:%")
            ],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let already_closed = closure_exists || limit_posted || legacy_expiry;
        let expiry_posted: bool = match expiry {
            Some(date) => conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ledger_entries WHERE op_key=?1)",
                [format!("expiry:{acc}:{}", date_s(&date))],
                |r| r.get(0),
            )?,
            None => false,
        };
        let (cap, limit_removed, expiry_removed) = close_amounts(
            free,
            carryover_used(conn, acc, None)?,
            &policy,
            closure_exists || limit_posted,
            expiry.is_some_and(|date| today >= date),
            expiry_posted,
        );
        items.push(CloseRow {
            account_id: acc,
            employee_id,
            service_id,
            full_name,
            minutes_per_day: crate::queries::minutes_per_day(conn, employee_id, today)?,
            left_minutes: free,
            carried_minutes: free - limit_removed - expiry_removed,
            removed_minutes: limit_removed + expiry_removed,
            already_closed,
            limit_removed,
            expiry_removed,
            cap,
        });
    }
    let already_closed = if items.is_empty() {
        conn.query_row("SELECT EXISTS(SELECT 1 FROM audit_events WHERE action='period.close' AND entity_id=?1 AND json_extract(details_json,'$.period_year')=?2)",params![leave_type_id,period_year],|r|r.get(0))?
    } else {
        items.iter().all(|row| row.already_closed)
    };
    Ok((
        ClosePreview {
            leave_type_id,
            period_year,
            already_closed,
            items,
        },
        policy,
        expiry,
    ))
}

/// Read-only: no lazy account creation, audit, outbox or idempotency receipt.
pub fn preview_close_period(
    conn: &Connection,
    clock: &Clock,
    actor: &Actor,
    leave_type_id: i64,
    period_year: i64,
) -> Res<ClosePreview> {
    authz::require(conn, actor, Action::ClosePeriod, &Resource::Global)?;
    Ok(close_plan(conn, clock.today(conn)?, leave_type_id, period_year)?.0)
}

/// Close a period atomically using precisely the plan returned by preview.
pub fn close_period_with_preview(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    leave_type_id: i64,
    period_year: i64,
) -> Res<CloseResult> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        authz::require(tx, actor, Action::ClosePeriod, &Resource::Global)?;
        let (preview, policy, expiry) = close_plan(tx, today, leave_type_id, period_year)?;
        let mut posted = 0;
        for row in &preview.items {
            let acc = row.account_id;
            tx.execute("INSERT OR IGNORE INTO period_closures(account_id,closed_on,policy_version_id,carryover_min) VALUES(?1,?2,?3,?4)",params![acc,date_s(&today),policy.id,row.cap])?;
            for (minutes, effective_date, basis, op_key) in [
                (
                    row.limit_removed,
                    today,
                    format!("Carryover limit for {period_year} (policy #{})", policy.id),
                    format!("carryover-limit:{acc}"),
                ),
                (
                    row.expiry_removed,
                    expiry.unwrap_or(today),
                    format!("Carryover of {period_year} expired (policy #{})", policy.id),
                    format!("expiry:{acc}:{}", date_s(&expiry.unwrap_or(today))),
                ),
            ] {
                if minutes > 0 {
                    let result = post_entry(
                        tx,
                        &PostEntry {
                            account_id: acc,
                            minutes: -minutes,
                            kind: "carryover_expiry",
                            effective_date,
                            request_id: None,
                            revision_id: None,
                            reverses_entry_id: None,
                            adjustment_id: None,
                            import_batch_id: None,
                            basis,
                            author_user_id: Some(actor.user_id),
                            op_key,
                        },
                        &now_ts,
                    )?;
                    posted += usize::from(result.inserted);
                }
            }
        }
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "period.close",
            "leave_type",
            Some(leave_type_id),
            serde_json::json!({"period_year":period_year,"expired_accounts":posted}),
        )?;
        crate::notify::record_change(tx, clock, actor.user_id, "period.close")?;
        Ok(CloseResult { posted, preview })
    })
}

/// Backwards-compatible domain entry point.
pub fn close_period(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    leave_type_id: i64,
    period_year: i64,
) -> Res<usize> {
    Ok(close_period_with_preview(conn, clock, actor, leave_type_id, period_year)?.posted)
}

// ------------------------------------------------------------------ adjustments

/// Propose a balance correction (two-person rule: another approver applies).
#[allow(clippy::too_many_arguments)]
pub fn propose_adjustment(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    employee_id: i64,
    leave_type_id: i64,
    period_year: i64,
    minutes: i64,
    reason: &str,
    basis_document: &str,
    request_id: Option<i64>,
) -> Res<i64> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        propose_adjustment_in(
            tx,
            actor,
            employee_id,
            leave_type_id,
            period_year,
            minutes,
            reason,
            basis_document,
            request_id,
            &now_ts,
        )
    })
}

/// Same as `propose_adjustment`, but callable inside an enclosing transaction
/// (`conn` may be a `Transaction`). `now_ts` comes from the caller's clock.
#[allow(clippy::too_many_arguments)]
pub fn propose_adjustment_in(
    conn: &Connection,
    actor: &Actor,
    employee_id: i64,
    leave_type_id: i64,
    period_year: i64,
    minutes: i64,
    reason: &str,
    basis_document: &str,
    request_id: Option<i64>,
    now_ts: &str,
) -> Res<i64> {
    let unit = model::unit_of(conn, employee_id, actor.today)?;
    authz::require(
        conn,
        actor,
        Action::ProposeAdjustment,
        &Resource::Employee {
            employee_id,
            org_unit_id: unit,
        },
    )?;
    if minutes == 0 {
        return Err(DomainError::validation("adjustment of 0 minutes"));
    }
    let acc = ensure_account(conn, employee_id, leave_type_id, period_year)?;
    let id = conn.query_row(
        "INSERT INTO adjustments
         (account_id, minutes, reason, basis_document, request_id, status,
          proposed_by, proposed_at)
         VALUES (?1,?2,?3,?4,?5,'proposed',?6,?7) RETURNING id",
        params![
            acc,
            minutes,
            reason,
            basis_document,
            request_id,
            actor.user_id,
            now_ts
        ],
        |r| r.get(0),
    )?;
    audit::log(
        conn,
        now_ts,
        Some(actor.user_id),
        None,
        "adjustment.propose",
        "adjustment",
        Some(id),
        serde_json::json!({"employee_id": employee_id, "minutes": minutes}),
    )?;
    Ok(id)
}

/// Apply or reject a proposed adjustment. The decider must be a different
/// person holding `adjustment_approver` covering the employee's unit.
pub fn decide_adjustment(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    adjustment_id: i64,
    apply: bool,
    note: &str,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let adj = load_adjustment(tx, adjustment_id)?;
        if adj.status != "proposed" {
            return Err(DomainError::validation("adjustment already decided"));
        }
        let employee_id: i64 = tx.query_row(
            "SELECT employee_id FROM leave_accounts WHERE id=?1",
            [adj.account_id],
            |r| r.get(0),
        )?;
        let unit = model::unit_of(tx, employee_id, today)?;
        authz::require(
            tx,
            actor,
            Action::DecideAdjustment,
            &Resource::Employee {
                employee_id,
                org_unit_id: unit,
            },
        )?;
        if adj.proposed_by == actor.user_id {
            return Err(DomainError::forbidden(
                "the proposer cannot decide their own adjustment",
            ));
        }
        if apply {
            // Recheck under the writer lock, including proposals recovered by
            // migration. Only guided corrections participate in this ceiling.
            let mut st = tx.prepare("SELECT c.request_id,c.date,c.account_id,c.minutes,(SELECT SUM(ra.minutes) FROM revision_allocations ra WHERE ra.day_id=c.day_id AND ra.account_id=c.account_id) FROM actual_correction_allocations c WHERE c.adjustment_id=?1")?;
            let corrections = st
                .query_map([adj.id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (request, date, account, minutes, original) in &corrections {
                let applied: i64 = tx.query_row("SELECT COALESCE(SUM(c.minutes),0) FROM actual_correction_allocations c JOIN adjustments a ON a.id=c.adjustment_id WHERE c.request_id=?1 AND c.date=?2 AND c.account_id=?3 AND a.status='applied'",params![request,date,account],|r|r.get(0))?;
                if applied + minutes > *original {
                    return Err(DomainError::validation(
                        "The selected day is already corrected",
                    ));
                }
            }
            if !corrections.is_empty()
                && corrections.iter().map(|c| c.3).sum::<i64>() != adj.minutes
            {
                return Err(DomainError::validation(
                    "Correction allocations do not match the proposal",
                ));
            }
            let outcome = post_entry(
                tx,
                &PostEntry {
                    account_id: adj.account_id,
                    minutes: adj.minutes,
                    kind: "adjustment",
                    effective_date: today,
                    request_id: adj.request_id,
                    revision_id: None,
                    reverses_entry_id: None,
                    adjustment_id: Some(adj.id),
                    import_batch_id: None,
                    basis: format!("{} ({})", adj.reason, adj.basis_document),
                    author_user_id: Some(actor.user_id),
                    op_key: format!("adjust:{}", adj.id),
                },
                &now_ts,
            )?;
            let _ = outcome;
        }
        tx.execute(
            "UPDATE adjustments SET status=?2, decided_by=?3, decided_at=?4, decision_note=?5
             WHERE id=?1",
            params![
                adjustment_id,
                if apply { "applied" } else { "rejected" },
                actor.user_id,
                now_ts,
                note
            ],
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            if apply {
                "adjustment.apply"
            } else {
                "adjustment.reject"
            },
            "adjustment",
            Some(adjustment_id),
            serde_json::json!({"note": note}),
        )?;
        Ok(())
    })
}

fn load_adjustment(conn: &Connection, id: i64) -> Res<Adjustment> {
    conn.query_row(
        "SELECT id, account_id, minutes, reason, basis_document, request_id, status,
                proposed_by, proposed_at, decided_by, decided_at
         FROM adjustments WHERE id=?1",
        [id],
        |r| {
            Ok(Adjustment {
                id: r.get(0)?,
                account_id: r.get(1)?,
                minutes: r.get(2)?,
                reason: r.get(3)?,
                basis_document: r.get(4)?,
                request_id: r.get(5)?,
                status: r.get(6)?,
                proposed_by: r.get(7)?,
                proposed_at: r.get(8)?,
                decided_by: r.get(9)?,
                decided_at: r.get(10)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("adjustment {id}")))
}

pub fn get_adjustment(conn: &Connection, id: i64) -> Res<Adjustment> {
    load_adjustment(conn, id)
}

/// Find the consumption entry of `account_id` belonging to the request family
/// (`family` = root request id or any child). Used by amendment/cancellation
/// returns as `reverses_entry_id`.
pub fn find_consumption_entry(
    conn: &Connection,
    family_root_id: i64,
    account_id: i64,
) -> Res<Option<i64>> {
    conn.query_row(
        "SELECT le.id FROM ledger_entries le
         WHERE le.account_id=?1 AND le.kind='consumption'
           AND le.revision_id IN (
             SELECT r.id FROM request_revisions r
             WHERE r.request_id IN (
               SELECT id FROM leave_requests WHERE id=?2 OR parent_request_id=?2))
         ORDER BY le.id DESC LIMIT 1",
        params![account_id, family_root_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(Into::into)
}

/// Opening balance posting (seed / import). Idempotent via
/// `opening:{emp}:{type}:{year}`.
#[allow(clippy::too_many_arguments)]
pub fn post_opening(
    conn: &Connection,
    employee_id: i64,
    leave_type_id: i64,
    period_year: i64,
    minutes: i64,
    effective_date: Date,
    basis: &str,
    author: Option<i64>,
    now_ts: &str,
) -> Res<PostOutcome> {
    let acc = ensure_account(conn, employee_id, leave_type_id, period_year)?;
    post_entry(
        conn,
        &PostEntry {
            account_id: acc,
            minutes,
            kind: "opening",
            effective_date,
            request_id: None,
            revision_id: None,
            reverses_entry_id: None,
            adjustment_id: None,
            import_batch_id: None,
            basis: basis.to_string(),
            author_user_id: author,
            op_key: format!("opening:{}:{}:{}", employee_id, leave_type_id, period_year),
        },
        now_ts,
    )
}
