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
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
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
            reserved_minutes: reserved(conn, acc)?,
            available_minutes: available(conn, acc, today)?,
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
    Ok(PostOutcome { entry_id: id, inserted: n > 0 })
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
    let lt = model::load_leave_type(conn, leave_type_id)?;
    if !lt.uses_balance {
        return Ok(Vec::new());
    }
    let policy = model::policy_for(conn, leave_type_id, today)?
        .ok_or_else(|| DomainError::validation(format!("no policy for {}", lt.code)))?;

    // Capacity per account = balance(today) − active reservations + extra − already taken here.
    let mut taken: BTreeMap<i64, i64> = BTreeMap::new();
    let mut out = Vec::new();

    for (idx, day) in days.iter().enumerate() {
        if day.minutes <= 0 {
            continue;
        }
        let mut need = day.minutes;
        let year = day.period_year;

        // own-year account first
        let own = ensure_account(conn, employee_id, leave_type_id, year)?;
        let mut give = take_from(
            conn, own, need, today, &mut taken, extra_available,
        )?;
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
                if carryover_expired(&policy, acc.1, today) {
                    continue;
                }
                give = take_from(conn, acc.0, need, today, &mut taken, extra_available)?;
                if give > 0 {
                    out.push(DayAllocation {
                        day_index: idx,
                        account_id: acc.0,
                        period_year: acc.1,
                        minutes: give,
                        carryover: true,
                    });
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
    Ok(available(conn, account_id, today)?
        + extra.get(&account_id).copied().unwrap_or(0)
        - taken.get(&account_id).copied().unwrap_or(0))
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
                Date::from_calendar_date((from_year + 1) as i32, time::Month::January, 1)
                    .unwrap(),
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
) -> Res<()> {
    conn.execute(
        "INSERT INTO reservations(request_id, revision_id, account_id, minutes, active, created_at)
         VALUES (?1,?2,?3,?4,1,?5)",
        params![request_id, revision_id, account_id, minutes, now_ts],
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
) -> Res<usize> {
    let n = conn.execute(
        "UPDATE reservations SET active=0, released_at=?2, release_reason=?3
         WHERE request_id=?1 AND active=1",
        params![request_id, now_ts, reason],
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
        let lt = model::load_leave_type(tx, leave_type_id)?;
        if !lt.uses_balance {
            return Err(DomainError::validation(format!(
                "{} does not use balances",
                lt.code
            )));
        }
        let policy = model::policy_for(tx, leave_type_id, today)?
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
                    return Err(DomainError::validation(
                        "annual_upfront takes no month",
                    ));
                }
                let earliest = add_months(
                    Date::from_calendar_date(period_year as i32, time::Month::January, 1)
                        .unwrap(),
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
                let m = month.ok_or_else(|| {
                    DomainError::validation("monthly accrual requires month")
                })?;
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

        let mut run = AccrualRun { posted: 0, skipped_existing: 0 };
        let mut st = tx.prepare(
            "SELECT id FROM employees WHERE active=1
               AND start_date<=?1 AND (end_date IS NULL OR end_date>=?2)",
        )?;
        let emps: Vec<i64> = st
            .query_map(
                params![
                    date_s(&Date::from_calendar_date(
                        period_year as i32,
                        time::Month::December,
                        31
                    )
                    .unwrap()),
                    date_s(&Date::from_calendar_date(
                        period_year as i32,
                        time::Month::January,
                        1
                    )
                    .unwrap())
                ],
                |r| r.get(0),
            )?
            .collect::<rusqlite::Result<Vec<i64>>>()?;

        for emp in emps {
            let acc = ensure_account(tx, emp, leave_type_id, period_year)?;
            let (minutes, op_key) = match policy.accrual_mode.as_str() {
                "annual_upfront" => (
                    policy.annual_entitlement_min,
                    format!("accrual:{}:{}:{}", policy.id, emp, period_year),
                ),
                _ => {
                    let m = month.unwrap();
                    let slice =
                        policy.annual_entitlement_min * m / 12 - policy.annual_entitlement_min * (m - 1) / 12;
                    (slice, format!("accrual:{}:{}:{}:{}", policy.id, emp, period_year, m))
                }
            };
            let outcome = post_entry(
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
                    basis: format!("Accrual {} (policy #{})", lt.code, policy.id),
                    author_user_id: Some(actor.user_id),
                    op_key,
                },
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
        Ok(run)
    })
}

/// Close a period: write `carryover_expiry` entries for accounts whose policy
/// sets `carryover_expiry_months` and whose grace window has ended. Idempotent.
pub fn close_period(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    leave_type_id: i64,
    period_year: i64,
) -> Res<usize> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        authz::require(tx, actor, Action::ClosePeriod, &Resource::Global)?;
        let policy = model::policy_for(tx, leave_type_id, today)?
            .ok_or_else(|| DomainError::validation("no policy"))?;
        let Some(expiry) = carryover_expiry_date(&policy, period_year) else {
            return Ok(0); // no expiry configured -> nothing burns
        };
        if today < expiry {
            return Err(DomainError::validation(format!(
                "period {period_year} carryover expires on {}",
                date_s(&expiry)
            )));
        }
        let mut st = tx.prepare(
            "SELECT id FROM leave_accounts WHERE leave_type_id=?1 AND period_year=?2",
        )?;
        let accs: Vec<i64> = st
            .query_map(params![leave_type_id, period_year], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?;
        let mut posted = 0;
        for acc in accs {
            let bal = (balance_at(tx, acc, today)? - reserved(tx, acc)?).max(0);
            if bal <= 0 {
                continue;
            }
            let op_key = format!("expiry:{}:{}", acc, date_s(&expiry));
            let outcome = post_entry(
                tx,
                &PostEntry {
                    account_id: acc,
                    minutes: -bal,
                    kind: "carryover_expiry",
                    effective_date: expiry,
                    request_id: None,
                    revision_id: None,
                    reverses_entry_id: None,
                    adjustment_id: None,
                    import_batch_id: None,
                    basis: format!("Carryover of {period_year} expired"),
                    author_user_id: Some(actor.user_id),
                    op_key,
                },
                &now_ts,
            )?;
            if outcome.inserted {
                posted += 1;
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
            serde_json::json!({"period_year": period_year, "expired_accounts": posted}),
        )?;
        Ok(posted)
    })
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
            tx, actor, employee_id, leave_type_id, period_year, minutes, reason,
            basis_document, request_id, &now_ts,
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
        &Resource::Employee { employee_id, org_unit_id: unit },
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
            &Resource::Employee { employee_id, org_unit_id: unit },
        )?;
        if adj.proposed_by == actor.user_id {
            return Err(DomainError::forbidden(
                "the proposer cannot decide their own adjustment",
            ));
        }
        if apply {
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
            if apply { "adjustment.apply" } else { "adjustment.reject" },
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
