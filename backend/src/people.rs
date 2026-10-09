//! People directory: org units, users, employees, assignments, schedules,
//! role grants, delegations and transfers (L01, L09).
//!
//! The plain `create_*`/`assign`/`grant_role` functions are trusted writers
//! used by the seed and test fixtures; they take no `Actor`. `transfer` and
//! `create_delegation`/`revoke_delegation` are user-facing operations and run
//! `authz` checks inside `write_tx`.

use argon2::{Argon2, PasswordHasher};
use rusqlite::{params, Connection, OptionalExtension};
use time::Date;

use crate::audit;
use crate::authz::{self, Action, Actor, Resource};
use crate::clock::Clock;
use crate::error::DomainError;
use crate::model::{self, date_s};
use crate::Res;

// ------------------------------------------------------------------ trusted writers (seed / tests)

pub fn create_org_unit(
    conn: &Connection,
    code: &str,
    name: &str,
    parent_id: Option<i64>,
) -> Res<i64> {
    Ok(conn.query_row(
        "INSERT INTO org_units(code, name, parent_id) VALUES (?1,?2,?3) RETURNING id",
        params![code, name, parent_id],
        |r| r.get(0),
    )?)
}

/// Create a user. `password` is hashed with argon2id; None = no password login.
pub fn create_user(
    conn: &Connection,
    email: &str,
    display_name: &str,
    password: Option<&str>,
    now_ts: &str,
) -> Res<i64> {
    let hash = match password {
        // argon2 0.6 generates a random salt internally (getrandom feature)
        Some(p) => Some(
            Argon2::default()
                .hash_password(p.as_bytes())
                .map_err(|e| DomainError::Internal(anyhow::anyhow!("argon2: {e}")))?
                .to_string(),
        ),
        None => None,
    };
    Ok(conn.query_row(
        "INSERT INTO users(email, display_name, password_hash, created_at)
         VALUES (?1,?2,?3,?4) RETURNING id",
        params![email, display_name, hash, now_ts],
        |r| r.get(0),
    )?)
}

/// Create an employee and their initial assignment + schedule.
#[allow(clippy::too_many_arguments)]
pub fn create_employee(
    conn: &Connection,
    service_id: &str,
    full_name: &str,
    email: Option<&str>,
    user_id: Option<i64>,
    start_date: Date,
    org_unit_id: i64,
    manager_employee_id: Option<i64>,
    schedule_id: i64,
    schedule_from: Date,
    now_ts: &str,
) -> Res<i64> {
    let id: i64 = conn.query_row(
        "INSERT INTO employees(service_id, full_name, email, user_id, start_date, created_at)
         VALUES (?1,?2,?3,?4,?5,?6) RETURNING id",
        params![
            service_id,
            full_name,
            email,
            user_id,
            date_s(&start_date),
            now_ts
        ],
        |r| r.get(0),
    )?;
    assign(conn, id, org_unit_id, manager_employee_id, start_date)?;
    set_schedule(conn, id, schedule_id, schedule_from)?;
    Ok(id)
}

/// Add an employment assignment row (history-preserving; callers close the
/// previous row themselves — see `transfer`).
pub fn assign(
    conn: &Connection,
    employee_id: i64,
    org_unit_id: i64,
    manager_employee_id: Option<i64>,
    valid_from: Date,
) -> Res<i64> {
    Ok(conn.query_row(
        "INSERT INTO employment_assignments(employee_id, org_unit_id, manager_employee_id, valid_from)
         VALUES (?1,?2,?3,?4) RETURNING id",
        params![employee_id, org_unit_id, manager_employee_id, date_s(&valid_from)],
        |r| r.get(0),
    )?)
}

pub fn set_schedule(
    conn: &Connection,
    employee_id: i64,
    schedule_id: i64,
    valid_from: Date,
) -> Res<i64> {
    Ok(conn.query_row(
        "INSERT INTO employee_schedules(employee_id, schedule_id, valid_from)
         VALUES (?1,?2,?3) RETURNING id",
        params![employee_id, schedule_id, date_s(&valid_from)],
        |r| r.get(0),
    )?)
}

pub fn create_schedule(
    conn: &Connection,
    name: &str,
    valid_from: Date,
    week: [i64; 7], // mon..sun minutes
    note: Option<&str>,
) -> Res<(i64, i64)> {
    let schedule_id: i64 = conn.query_row(
        "INSERT INTO schedules(name) VALUES (?1) RETURNING id",
        [name],
        |r| r.get(0),
    )?;
    let version_id: i64 = conn.query_row(
        "INSERT INTO schedule_versions
         (schedule_id, valid_from, mon_min, tue_min, wed_min, thu_min, fri_min, sat_min, sun_min, note)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING id",
        params![
            schedule_id,
            date_s(&valid_from),
            week[0],
            week[1],
            week[2],
            week[3],
            week[4],
            week[5],
            week[6],
            note
        ],
        |r| r.get(0),
    )?;
    Ok((schedule_id, version_id))
}

pub fn create_calendar_exception(
    conn: &Connection,
    date: Date,
    name: &str,
    minutes: i64,
    schedule_id: Option<i64>,
    now_ts: &str,
) -> Res<i64> {
    Ok(conn.query_row(
        "INSERT INTO calendar_exceptions(date, name, minutes, schedule_id, created_at)
         VALUES (?1,?2,?3,?4,?5) RETURNING id",
        params![date_s(&date), name, minutes, schedule_id, now_ts],
        |r| r.get(0),
    )?)
}

pub fn create_leave_type(conn: &Connection, code: &str, name: &str, sensitive: bool) -> Res<i64> {
    Ok(conn.query_row(
        "INSERT INTO leave_types(code,name,sensitive,active) VALUES(?1,?2,?3,1) RETURNING id",
        params![code, name, sensitive],
        |r| r.get(0),
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn create_policy(
    conn: &Connection,
    leave_type_id: i64,
    valid_from: Date,
    annual_entitlement_min: i64,
    accrual_mode: &str,
    advance_publish_months: i64,
    carryover_allowed: bool,
    carryover_expiry_months: Option<i64>,
    allow_negative: bool,
    explanation: &str,
    status: &str,
    created_by: Option<i64>,
    now_ts: &str,
) -> Res<i64> {
    let previous = crate::model::policy_for(conn, leave_type_id, valid_from)?;
    let (paid, uses_balance, allow_half_day, requires_attachment, notice) =
        previous.map_or((true, true, true, false, 0), |p| {
            (
                p.paid,
                p.uses_balance,
                p.allow_half_day,
                p.requires_attachment,
                p.min_notice_days,
            )
        });
    Ok(conn.query_row(
        "INSERT INTO policy_versions
         (leave_type_id, valid_from, annual_entitlement_min, accrual_mode,
          advance_publish_months, carryover_allowed, carryover_expiry_months,
          allow_negative, explanation, status, created_by, created_at,paid,uses_balance,allow_half_day,requires_attachment,min_notice_days)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) RETURNING id",
        params![
            leave_type_id,
            date_s(&valid_from),
            annual_entitlement_min,
            accrual_mode,
            advance_publish_months,
            carryover_allowed as i64,
            carryover_expiry_months,
            allow_negative as i64,
            explanation,
            status,
            created_by,
            now_ts,paid,uses_balance,allow_half_day,requires_attachment,notice
        ],
        |r| r.get(0),
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn grant_role(
    conn: &Connection,
    user_id: i64,
    role: &str,
    scope_org_unit_id: Option<i64>,
    valid_from: Date,
    valid_to: Option<Date>,
    granted_by: Option<i64>,
    now_ts: &str,
) -> Res<i64> {
    Ok(conn.query_row(
        "INSERT INTO role_grants(user_id, role, scope_org_unit_id, valid_from, valid_to, granted_by, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7) RETURNING id",
        params![
            user_id,
            role,
            scope_org_unit_id,
            date_s(&valid_from),
            valid_to.map(|d| date_s(&d)),
            granted_by,
            now_ts
        ],
        |r| r.get(0),
    )?)
}

// ------------------------------------------------------------------ delegations

/// Create a delegation (`from` acts through `to` on [valid_from, valid_to]).
/// The delegator themselves or service-wide HR may create it.
#[allow(clippy::too_many_arguments)]
pub fn create_delegation(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    from_user_id: i64,
    to_user_id: i64,
    scope: &str,
    valid_from: Date,
    valid_to: Date,
    reason: &str,
) -> Res<i64> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        if ![
            "manager_recommendation",
            "hr_check",
            "final_decision",
            "all_approvals",
        ]
        .contains(&scope)
        {
            return Err(DomainError::validation("bad delegation scope"));
        }
        if valid_to < valid_from {
            return Err(DomainError::validation("valid_to before valid_from"));
        }
        if actor.user_id != from_user_id
            && !actor.role_in_scope(tx, "hr", None)?
        {
            return Err(DomainError::forbidden(
                "only the delegator or service-wide HR may create a delegation",
            ));
        }
        let id: i64 = tx.query_row(
            "INSERT INTO delegations
             (from_user_id, to_user_id, scope, valid_from, valid_to, reason, created_by, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id",
            params![
                from_user_id,
                to_user_id,
                scope,
                date_s(&valid_from),
                date_s(&valid_to),
                reason,
                actor.user_id,
                now_ts
            ],
            |r| r.get(0),
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "delegation.create",
            "delegation",
            Some(id),
            serde_json::json!({"from": from_user_id, "to": to_user_id, "scope": scope}),
        )?;
        Ok(id)
    })
}

pub fn revoke_delegation(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    delegation_id: i64,
) -> Res<()> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let from: i64 = tx
            .query_row(
                "SELECT from_user_id FROM delegations WHERE id=?1 AND revoked_at IS NULL",
                [delegation_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| DomainError::not_found(format!("delegation {delegation_id}")))?;
        if actor.user_id != from && !actor.role_in_scope(tx, "hr", None)? {
            return Err(DomainError::forbidden("cannot revoke this delegation"));
        }
        tx.execute(
            "UPDATE delegations SET revoked_at=?2 WHERE id=?1",
            params![delegation_id, now_ts],
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "delegation.revoke",
            "delegation",
            Some(delegation_id),
            serde_json::json!({}),
        )?;
        Ok(())
    })
}

// ------------------------------------------------------------------ transfer

/// Transfer an employee to a new org unit / manager on `valid_from`
/// (DESIGN §6: the old manager loses access to NEW requests; open steps on
/// old requests are explicitly reassigned when `reassign_open_steps`).
#[allow(clippy::too_many_arguments)]
pub fn transfer(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    employee_id: i64,
    org_unit_id: i64,
    manager_employee_id: Option<i64>,
    valid_from: Date,
    reassign_open_steps: bool,
) -> Res<()> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        let cur_unit = model::unit_of(tx, employee_id, today)?;
        authz::require(
            tx,
            actor,
            Action::TransferEmployee,
            &Resource::Employee {
                employee_id,
                org_unit_id: cur_unit,
            },
        )?;
        authz::require(
            tx,
            actor,
            Action::TransferEmployee,
            &Resource::Employee {
                employee_id,
                org_unit_id: Some(org_unit_id),
            },
        )?;
        // close the assignment valid today
        let day_before = valid_from
            .previous_day()
            .ok_or_else(|| DomainError::validation("valid_from too early"))?;
        tx.execute(
            "UPDATE employment_assignments SET valid_to=?2
             WHERE employee_id=?1 AND valid_from<=?3 AND (valid_to IS NULL OR valid_to>=?3)",
            params![employee_id, date_s(&day_before), date_s(&today)],
        )?;
        assign(
            tx,
            employee_id,
            org_unit_id,
            manager_employee_id,
            valid_from,
        )?;
        if reassign_open_steps && valid_from <= today {
            let new_manager_user = manager_employee_id
                .map(|m| model::load_employee(tx, m))
                .transpose()?
                .and_then(|m| m.user_id);
            tx.execute(
                "UPDATE approval_steps SET assignee_user_id=?2
                 WHERE kind='manager_recommendation' AND status IN ('pending','waiting')
                   AND request_id IN (SELECT id FROM leave_requests
                     WHERE employee_id=?1 AND status IN ('submitted','needs_information','under_review'))",
                params![employee_id, new_manager_user],
            )?;
        }
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "employee.transfer",
            "employee",
            Some(employee_id),
            serde_json::json!({"org_unit_id": org_unit_id, "valid_from": date_s(&valid_from)}),
        )?;
        Ok(())
    })
}
