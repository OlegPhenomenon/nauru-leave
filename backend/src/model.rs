//! Row structs mirroring `migrations/0001_init.sql` plus shared loaders.
//! Dates are TEXT 'YYYY-MM-DD', timestamps RFC3339 UTC TEXT, minutes INTEGER.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use time::macros::format_description;
use time::Date;

use crate::error::DomainError;
use crate::Res;

// ------------------------------------------------------------------ helpers

const DATE_FMT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]");

pub fn parse_date(s: &str) -> Res<Date> {
    Date::parse(s, DATE_FMT).map_err(|e| DomainError::Validation(format!("bad date '{s}': {e}")))
}

pub fn date_s(d: &Date) -> String {
    d.to_string() // time::Date Display = ISO 8601
}

/// Add (or subtract) calendar months, clamped to a valid day.
pub fn add_months(d: Date, months: i64) -> Date {
    let total = d.year() as i64 * 12 + (d.month() as i64 - 1) + months;
    let y = total.div_euclid(12) as i32;
    let m = time::Month::try_from((total.rem_euclid(12) + 1) as u8).unwrap();
    let mut day = d.day();
    while day > 0 {
        if let Ok(nd) = Date::from_calendar_date(y, m, day) {
            return nd;
        }
        day -= 1;
    }
    unreachable!()
}

pub fn weekday_short(d: Date) -> &'static str {
    match d.weekday() {
        time::Weekday::Monday => "Mon",
        time::Weekday::Tuesday => "Tue",
        time::Weekday::Wednesday => "Wed",
        time::Weekday::Thursday => "Thu",
        time::Weekday::Friday => "Fri",
        time::Weekday::Saturday => "Sat",
        time::Weekday::Sunday => "Sun",
    }
}

pub fn weekday_long(d: Date) -> &'static str {
    match d.weekday() {
        time::Weekday::Monday => "Monday",
        time::Weekday::Tuesday => "Tuesday",
        time::Weekday::Wednesday => "Wednesday",
        time::Weekday::Thursday => "Thursday",
        time::Weekday::Friday => "Friday",
        time::Weekday::Saturday => "Saturday",
        time::Weekday::Sunday => "Sunday",
    }
}

// ------------------------------------------------------------------ enums

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    Full,
    Am,
    Pm,
}

impl Part {
    pub fn as_str(&self) -> &'static str {
        match self {
            Part::Full => "full",
            Part::Am => "am",
            Part::Pm => "pm",
        }
    }
    pub fn parse(s: &str) -> Res<Part> {
        match s {
            "full" => Ok(Part::Full),
            "am" => Ok(Part::Am),
            "pm" => Ok(Part::Pm),
            _ => Err(DomainError::validation(format!("bad part '{s}'"))),
        }
    }
    /// Do two day-parts occupy the same time? `full` overlaps everything;
    /// `am` and `pm` never overlap each other.
    pub fn overlaps(&self, other: &Part) -> bool {
        *self == Part::Full || *other == Part::Full || self == other
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestStatus {
    Draft,
    Submitted,
    NeedsInformation,
    UnderReview,
    Approved,
    Rejected,
    Withdrawn,
    Cancelled,
}

impl RequestStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Submitted => "submitted",
            Self::NeedsInformation => "needs_information",
            Self::UnderReview => "under_review",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Withdrawn => "withdrawn",
            Self::Cancelled => "cancelled",
        }
    }
    pub fn parse(s: &str) -> Res<Self> {
        Ok(match s {
            "draft" => Self::Draft,
            "submitted" => Self::Submitted,
            "needs_information" => Self::NeedsInformation,
            "under_review" => Self::UnderReview,
            "approved" => Self::Approved,
            "rejected" => Self::Rejected,
            "withdrawn" => Self::Withdrawn,
            "cancelled" => Self::Cancelled,
            _ => return Err(DomainError::validation(format!("bad status '{s}'"))),
        })
    }
    pub fn is_open(&self) -> bool {
        matches!(
            self,
            Self::Submitted | Self::NeedsInformation | Self::UnderReview
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestKind {
    Leave,
    Amendment,
    Cancellation,
}

impl RequestKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Leave => "leave",
            Self::Amendment => "amendment",
            Self::Cancellation => "cancellation",
        }
    }
    pub fn parse(s: &str) -> Res<Self> {
        Ok(match s {
            "leave" => Self::Leave,
            "amendment" => Self::Amendment,
            "cancellation" => Self::Cancellation,
            _ => return Err(DomainError::validation(format!("bad kind '{s}'"))),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepKind {
    ManagerRecommendation,
    HrCheck,
    FinalDecision,
}

impl StepKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ManagerRecommendation => "manager_recommendation",
            Self::HrCheck => "hr_check",
            Self::FinalDecision => "final_decision",
        }
    }
    pub fn parse(s: &str) -> Res<Self> {
        Ok(match s {
            "manager_recommendation" => Self::ManagerRecommendation,
            "hr_check" => Self::HrCheck,
            "final_decision" => Self::FinalDecision,
            _ => return Err(DomainError::validation(format!("bad step kind '{s}'"))),
        })
    }
    /// Outcomes this step kind accepts.
    pub fn valid_outcomes(&self) -> &'static [&'static str] {
        match self {
            Self::ManagerRecommendation => {
                &["recommend_approve", "recommend_reject", "needs_information"]
            }
            Self::HrCheck => &["checked_ok", "checked_problem", "needs_information"],
            Self::FinalDecision => &["approve", "reject", "needs_information"],
        }
    }
    /// Delegation scope that covers this step.
    pub fn delegation_scope(&self) -> &'static str {
        match self {
            Self::ManagerRecommendation => "manager_recommendation",
            Self::HrCheck => "hr_check",
            Self::FinalDecision => "final_decision",
        }
    }
}

pub fn outcome_needs_reason(outcome: &str) -> bool {
    matches!(
        outcome,
        "recommend_reject" | "checked_problem" | "reject" | "needs_information"
    )
}

// ------------------------------------------------------------------ rows

#[derive(Clone, Debug)]
pub struct LeaveType {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub sensitive: bool,
    pub paid: bool,
    pub uses_balance: bool,
    pub allow_half_day: bool,
    pub requires_attachment: bool,
    pub min_notice_days: i64,
    pub active: bool,
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub carryover_limit_min: Option<i64>,
    pub paid: bool,
    pub uses_balance: bool,
    pub allow_half_day: bool,
    pub requires_attachment: bool,
    pub min_notice_days: i64,
    pub id: i64,
    pub leave_type_id: i64,
    pub valid_from: Date,
    pub annual_entitlement_min: i64,
    pub accrual_mode: String,
    pub advance_publish_months: i64,
    pub carryover_allowed: bool,
    pub carryover_expiry_months: Option<i64>,
    pub allow_negative: bool,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct Employee {
    pub id: i64,
    pub service_id: String,
    pub full_name: String,
    pub email: Option<String>,
    pub user_id: Option<i64>,
    pub active: bool,
}

#[derive(Clone, Debug)]
pub struct User {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    pub active: bool,
}

#[derive(Clone, Debug)]
pub struct Assignment {
    pub id: i64,
    pub employee_id: i64,
    pub org_unit_id: i64,
    pub manager_employee_id: Option<i64>,
    pub valid_from: Date,
    pub valid_to: Option<Date>,
}

#[derive(Clone, Debug)]
pub struct RoleGrant {
    pub id: i64,
    pub user_id: i64,
    pub role: String,
    pub scope_org_unit_id: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Delegation {
    pub id: i64,
    pub from_user_id: i64,
    pub to_user_id: i64,
    pub scope: String,
    pub valid_from: Date,
    pub valid_to: Date,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LeaveRequest {
    pub id: i64,
    pub number: String,
    pub employee_id: i64,
    pub kind: RequestKind,
    pub parent_request_id: Option<i64>,
    pub previous_request_id: Option<i64>,
    pub status: RequestStatus,
    pub current_revision_id: Option<i64>,
    pub effective_revision_id: Option<i64>,
    pub source: String,
    pub paper_received_date: Option<Date>,
    pub entered_by_user_id: i64,
    pub actual_confirmed_by: Option<i64>,
    pub actual_confirmed_at: Option<String>,
    pub actual_note: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct Revision {
    pub id: i64,
    pub request_id: i64,
    pub rev_no: i64,
    pub leave_type_id: i64,
    pub start_date: Date,
    pub end_date: Date,
    pub start_part: Part,
    pub end_part: Part,
    pub note: Option<String>,
    pub change_reason: Option<String>,
    pub total_minutes: i64,
    pub created_by: i64,
    pub submitted_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RequestDay {
    pub id: i64,
    pub revision_id: i64,
    pub date: Date,
    pub part: String, // full|am|pm|none
    pub scheduled_minutes: i64,
    pub minutes: i64,
    pub schedule_version_id: Option<i64>,
    pub exception_id: Option<i64>,
    pub period_year: i64,
    pub explanation: String,
}

#[derive(Clone, Debug)]
pub struct Allocation {
    pub id: i64,
    pub revision_id: i64,
    pub day_id: i64,
    pub account_id: i64,
    pub minutes: i64,
}

#[derive(Clone, Debug)]
pub struct Reservation {
    pub id: i64,
    pub request_id: i64,
    pub revision_id: i64,
    pub account_id: i64,
    pub minutes: i64,
    pub active: bool,
}

#[derive(Clone, Debug)]
pub struct Step {
    pub id: i64,
    pub request_id: i64,
    pub revision_id: i64,
    pub seq: i64,
    pub kind: StepKind,
    pub assignee_user_id: Option<i64>,
    pub status: String,
    pub outcome: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub id: i64,
    pub request_id: i64,
    pub revision_id: i64,
    pub step_id: i64,
    pub actor_user_id: i64,
    pub acting_for_user_id: Option<i64>,
    pub authority: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub basis_document: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct Attachment {
    pub id: i64,
    pub request_id: i64,
    pub uploaded_by: i64,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub storage_key: String,
    pub sensitivity: String,
    pub scan_status: String,
}

#[derive(Clone, Debug)]
pub struct Adjustment {
    pub id: i64,
    pub account_id: i64,
    pub minutes: i64,
    pub reason: String,
    pub basis_document: String,
    pub request_id: Option<i64>,
    pub status: String,
    pub proposed_by: i64,
    pub proposed_at: String,
    pub decided_by: Option<i64>,
    pub decided_at: Option<String>,
}

// ------------------------------------------------------------------ loaders

fn bool_i(v: i64) -> bool {
    v != 0
}

pub fn load_leave_type(conn: &Connection, id: i64) -> Res<LeaveType> {
    conn.query_row(
        "SELECT id,code,name,sensitive,active FROM leave_types WHERE id=?1",
        [id],
        |r| {
            Ok(LeaveType {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                sensitive: bool_i(r.get(3)?),
                paid: true,
                uses_balance: true,
                allow_half_day: true,
                requires_attachment: false,
                min_notice_days: 0,
                active: bool_i(r.get(4)?),
            })
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("leave type {id}")))
}

/// Latest policy that has actually entered into force.
pub fn policy_for(conn: &Connection, leave_type_id: i64, on: Date) -> Res<Option<Policy>> {
    conn.query_row(
        "SELECT id, leave_type_id, valid_from, annual_entitlement_min, accrual_mode,
                advance_publish_months, carryover_allowed, carryover_expiry_months,
                allow_negative, status,carryover_limit_min,paid,uses_balance,allow_half_day,requires_attachment,min_notice_days
         FROM policy_versions WHERE leave_type_id=?1 AND valid_from<=?2
         ORDER BY valid_from DESC,id DESC LIMIT 1",
        params![leave_type_id,date_s(&on)],map_policy,
    ).optional().map_err(Into::into)
}

pub fn leave_type_on(conn: &Connection, id: i64, on: Date) -> Res<LeaveType> {
    let mut t = load_leave_type(conn, id)?;
    let p = policy_for(conn, id, on)?.ok_or_else(|| DomainError::NoPolicy(t.code.clone()))?;
    t.paid = p.paid;
    t.uses_balance = p.uses_balance;
    t.allow_half_day = p.allow_half_day;
    t.requires_attachment = p.requires_attachment;
    t.min_notice_days = p.min_notice_days;
    Ok(t)
}

/// Conditions saved at submission; sensitivity may only become more restrictive.
pub fn revision_leave_type(conn: &Connection, revision_id: i64) -> Res<LeaveType> {
    let r = load_revision(conn, revision_id)?;
    let mut t = load_leave_type(conn, r.leave_type_id)?;
    let snapshot: Option<String> = conn.query_row(
        "SELECT policy_snapshot FROM request_revisions WHERE id=?1",
        [revision_id],
        |r| r.get(0),
    )?;
    if let Some(s) = snapshot {
        let v: serde_json::Value = serde_json::from_str(&s)?;
        t.paid = v["paid"].as_bool().unwrap_or(t.paid);
        t.uses_balance = v["uses_balance"].as_bool().unwrap_or(t.uses_balance);
        t.allow_half_day = v["allow_half_day"].as_bool().unwrap_or(t.allow_half_day);
        t.requires_attachment = v["requires_attachment"]
            .as_bool()
            .unwrap_or(t.requires_attachment);
        t.sensitive |= v["sensitive"].as_bool().unwrap_or(false);
        t.min_notice_days = v["min_notice_days"].as_i64().unwrap_or(t.min_notice_days);
    }
    Ok(t)
}

pub fn snapshot_policy(conn: &Connection, revision_id: i64, on: Date) -> Res<()> {
    let r = load_revision(conn, revision_id)?;
    let t = leave_type_on(conn, r.leave_type_id, on)?;
    let p = policy_for(conn, t.id, on)?.ok_or_else(|| DomainError::NoPolicy(t.code.clone()))?;
    let snapshot = serde_json::json!({"paid":t.paid,"uses_balance":t.uses_balance,"allow_half_day":t.allow_half_day,"requires_attachment":t.requires_attachment,"sensitive":t.sensitive,"min_notice_days":t.min_notice_days,"annual_entitlement_min":p.annual_entitlement_min,"accrual_mode":p.accrual_mode,"advance_publish_months":p.advance_publish_months,"carryover_allowed":p.carryover_allowed,"carryover_expiry_months":p.carryover_expiry_months,"carryover_limit_min":p.carryover_limit_min,"allow_negative":p.allow_negative,"status":p.status});
    conn.execute(
        "UPDATE request_revisions SET policy_version_id=?2,policy_snapshot=?3 WHERE id=?1",
        params![revision_id, p.id, snapshot.to_string()],
    )?;
    Ok(())
}

pub fn policy_by_id(conn: &Connection, id: i64) -> Res<Policy> {
    conn.query_row("SELECT id,leave_type_id,valid_from,annual_entitlement_min,accrual_mode,advance_publish_months,carryover_allowed,carryover_expiry_months,allow_negative,status,carryover_limit_min,paid,uses_balance,allow_half_day,requires_attachment,min_notice_days FROM policy_versions WHERE id=?1",[id],map_policy).optional()?.ok_or_else(||DomainError::not_found("policy"))
}

fn map_policy(r: &rusqlite::Row) -> rusqlite::Result<Policy> {
    Ok(Policy {
        id: r.get(0)?,
        leave_type_id: r.get(1)?,
        valid_from: parse_date(&r.get::<_, String>(2)?).map_err(|_| {
            rusqlite::Error::InvalidColumnType(2, "date".into(), rusqlite::types::Type::Text)
        })?,
        annual_entitlement_min: r.get(3)?,
        accrual_mode: r.get(4)?,
        advance_publish_months: r.get(5)?,
        carryover_allowed: bool_i(r.get(6)?),
        carryover_expiry_months: r.get(7)?,
        allow_negative: bool_i(r.get(8)?),
        status: r.get(9)?,
        carryover_limit_min: r.get(10)?,
        paid: bool_i(r.get(11)?),
        uses_balance: bool_i(r.get(12)?),
        allow_half_day: bool_i(r.get(13)?),
        requires_attachment: bool_i(r.get(14)?),
        min_notice_days: r.get(15)?,
    })
}

pub fn load_employee(conn: &Connection, id: i64) -> Res<Employee> {
    conn.query_row(
        "SELECT id, service_id, full_name, email, user_id, active FROM employees WHERE id=?1",
        [id],
        |r| {
            Ok(Employee {
                id: r.get(0)?,
                service_id: r.get(1)?,
                full_name: r.get(2)?,
                email: r.get(3)?,
                user_id: r.get(4)?,
                active: bool_i(r.get(5)?),
            })
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("employee {id}")))
}

pub fn load_user(conn: &Connection, id: i64) -> Res<User> {
    conn.query_row(
        "SELECT id, email, display_name, active FROM users WHERE id=?1",
        [id],
        |r| {
            Ok(User {
                id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                active: bool_i(r.get(3)?),
            })
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("user {id}")))
}

/// Assignment (org unit + manager) valid on `date`.
pub fn assignment_at(conn: &Connection, employee_id: i64, date: Date) -> Res<Option<Assignment>> {
    conn.query_row(
        "SELECT id, employee_id, org_unit_id, manager_employee_id, valid_from, valid_to
         FROM employment_assignments
         WHERE employee_id=?1 AND valid_from<=?2 AND (valid_to IS NULL OR valid_to>=?2)
         ORDER BY valid_from DESC, id DESC LIMIT 1",
        params![employee_id, date_s(&date)],
        |r| {
            Ok(Assignment {
                id: r.get(0)?,
                employee_id: r.get(1)?,
                org_unit_id: r.get(2)?,
                manager_employee_id: r.get(3)?,
                valid_from: parse_date(&r.get::<_, String>(4)?).unwrap(),
                valid_to: r
                    .get::<_, Option<String>>(5)?
                    .map(|s| parse_date(&s).unwrap()),
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Manager employee (per assignment valid on `date`), if any.
pub fn manager_at(conn: &Connection, employee_id: i64, date: Date) -> Res<Option<Employee>> {
    match assignment_at(conn, employee_id, date)? {
        Some(a) => match a.manager_employee_id {
            Some(m) => load_employee(conn, m).map(Some),
            None => Ok(None),
        },
        None => Ok(None),
    }
}

/// Employee's org unit on `date`, if assigned.
pub fn unit_of(conn: &Connection, employee_id: i64, date: Date) -> Res<Option<i64>> {
    Ok(assignment_at(conn, employee_id, date)?.map(|a| a.org_unit_id))
}

/// Employee ids directly managed by `manager_employee_id` on `date`.
pub fn direct_reports(conn: &Connection, manager_employee_id: i64, date: Date) -> Res<Vec<i64>> {
    let mut st = conn.prepare(
        "SELECT employee_id FROM employment_assignments
         WHERE manager_employee_id=?1 AND valid_from<=?2
           AND (valid_to IS NULL OR valid_to>=?2)",
    )?;
    let rows = st.query_map(params![manager_employee_id, date_s(&date)], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<i64>>>()?)
}

/// Is `unit_id` inside `scope`? scope NULL = whole service. Otherwise the
/// unit must equal the scope unit or descend from it.
pub fn unit_in_scope(conn: &Connection, scope: Option<i64>, unit_id: Option<i64>) -> Res<bool> {
    match scope {
        None => Ok(true),
        Some(scope_unit) => {
            let mut cur = match unit_id {
                Some(u) => u,
                None => return Ok(false),
            };
            for _ in 0..64 {
                if cur == scope_unit {
                    return Ok(true);
                }
                cur = match conn
                    .query_row("SELECT parent_id FROM org_units WHERE id=?1", [cur], |r| {
                        r.get::<_, Option<i64>>(0)
                    })
                    .optional()?
                {
                    Some(Some(p)) => p,
                    _ => return Ok(false),
                };
            }
            Ok(false)
        }
    }
}

pub fn valid_grants(conn: &Connection, user_id: i64, date: Date) -> Res<Vec<RoleGrant>> {
    let mut st = conn.prepare(
        "SELECT id, user_id, role, scope_org_unit_id FROM role_grants
         WHERE user_id=?1 AND valid_from<=?2 AND (valid_to IS NULL OR valid_to>=?2)",
    )?;
    let rows = st.query_map(params![user_id, date_s(&date)], |r| {
        Ok(RoleGrant {
            id: r.get(0)?,
            user_id: r.get(1)?,
            role: r.get(2)?,
            scope_org_unit_id: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Active delegations TO `user_id` on `date` (not revoked).
pub fn delegations_to(conn: &Connection, user_id: i64, date: Date) -> Res<Vec<Delegation>> {
    let mut st = conn.prepare(
        "SELECT id, from_user_id, to_user_id, scope, valid_from, valid_to, revoked_at
         FROM delegations
         WHERE to_user_id=?1 AND valid_from<=?2 AND valid_to>=?2 AND revoked_at IS NULL",
    )?;
    let rows = st.query_map(params![user_id, date_s(&date)], |r| {
        Ok(Delegation {
            id: r.get(0)?,
            from_user_id: r.get(1)?,
            to_user_id: r.get(2)?,
            scope: r.get(3)?,
            valid_from: parse_date(&r.get::<_, String>(4)?).unwrap(),
            valid_to: parse_date(&r.get::<_, String>(5)?).unwrap(),
            revoked_at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Does `delegator` have an active delegation to `actor` covering `scope`
/// ('all_approvals' covers everything)?
pub fn has_delegation(
    conn: &Connection,
    from_user: i64,
    to_user: i64,
    step_scope: &str,
    date: Date,
) -> Res<Option<i64>> {
    let id = conn
        .query_row(
            "SELECT id FROM delegations
             WHERE from_user_id=?1 AND to_user_id=?2
               AND (scope=?3 OR scope='all_approvals')
               AND valid_from<=?4 AND valid_to>=?4 AND revoked_at IS NULL
             ORDER BY id LIMIT 1",
            params![from_user, to_user, step_scope, date_s(&date)],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    Ok(id)
}

pub fn load_request(conn: &Connection, id: i64) -> Res<LeaveRequest> {
    conn.query_row(
        "SELECT id, number, employee_id, kind, parent_request_id, previous_request_id,
                status, current_revision_id, effective_revision_id, source,
                paper_received_date, entered_by_user_id,
                actual_confirmed_by, actual_confirmed_at, actual_note,
                version, created_at, updated_at
         FROM leave_requests WHERE id=?1",
        [id],
        |r| {
            Ok(LeaveRequest {
                id: r.get(0)?,
                number: r.get(1)?,
                employee_id: r.get(2)?,
                kind: RequestKind::parse(&r.get::<_, String>(3)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        3,
                        "kind".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                parent_request_id: r.get(4)?,
                previous_request_id: r.get(5)?,
                status: RequestStatus::parse(&r.get::<_, String>(6)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        6,
                        "status".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                current_revision_id: r.get(7)?,
                effective_revision_id: r.get(8)?,
                source: r.get(9)?,
                paper_received_date: r
                    .get::<_, Option<String>>(10)?
                    .map(|s| parse_date(&s).unwrap()),
                entered_by_user_id: r.get(11)?,
                actual_confirmed_by: r.get(12)?,
                actual_confirmed_at: r.get(13)?,
                actual_note: r.get(14)?,
                version: r.get(15)?,
                created_at: r.get(16)?,
                updated_at: r.get(17)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("request {id}")))
}

pub fn load_revision(conn: &Connection, id: i64) -> Res<Revision> {
    conn.query_row(
        "SELECT id, request_id, rev_no, leave_type_id, start_date, end_date,
                start_part, end_part, note, change_reason, total_minutes,
                created_by, submitted_at
         FROM request_revisions WHERE id=?1",
        [id],
        |r| {
            Ok(Revision {
                id: r.get(0)?,
                request_id: r.get(1)?,
                rev_no: r.get(2)?,
                leave_type_id: r.get(3)?,
                start_date: parse_date(&r.get::<_, String>(4)?).unwrap(),
                end_date: parse_date(&r.get::<_, String>(5)?).unwrap(),
                start_part: Part::parse(&r.get::<_, String>(6)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        6,
                        "part".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                end_part: Part::parse(&r.get::<_, String>(7)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        7,
                        "part".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                note: r.get(8)?,
                change_reason: r.get(9)?,
                total_minutes: r.get(10)?,
                created_by: r.get(11)?,
                submitted_at: r.get(12)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("revision {id}")))
}

pub fn revision_days(conn: &Connection, revision_id: i64) -> Res<Vec<RequestDay>> {
    let mut st = conn.prepare(
        "SELECT id, revision_id, date, part, scheduled_minutes, minutes,
                schedule_version_id, exception_id, period_year, explanation
         FROM request_days WHERE revision_id=?1 ORDER BY date",
    )?;
    let rows = st.query_map([revision_id], |r| {
        Ok(RequestDay {
            id: r.get(0)?,
            revision_id: r.get(1)?,
            date: parse_date(&r.get::<_, String>(2)?).unwrap(),
            part: r.get(3)?,
            scheduled_minutes: r.get(4)?,
            minutes: r.get(5)?,
            schedule_version_id: r.get(6)?,
            exception_id: r.get(7)?,
            period_year: r.get(8)?,
            explanation: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn revision_allocations(conn: &Connection, revision_id: i64) -> Res<Vec<Allocation>> {
    let mut st = conn.prepare(
        "SELECT id, revision_id, day_id, account_id, minutes
         FROM revision_allocations WHERE revision_id=?1",
    )?;
    let rows = st.query_map([revision_id], |r| {
        Ok(Allocation {
            id: r.get(0)?,
            revision_id: r.get(1)?,
            day_id: r.get(2)?,
            account_id: r.get(3)?,
            minutes: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Per-account allocated minutes for a revision.
pub fn allocation_totals(
    conn: &Connection,
    revision_id: i64,
) -> Res<std::collections::BTreeMap<i64, i64>> {
    let mut st = conn.prepare(
        "SELECT account_id, SUM(minutes) FROM revision_allocations
         WHERE revision_id=?1 GROUP BY account_id",
    )?;
    let rows = st.query_map([revision_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows
        .collect::<rusqlite::Result<Vec<(i64, i64)>>>()?
        .into_iter()
        .collect())
}

pub fn steps_of(conn: &Connection, request_id: i64) -> Res<Vec<Step>> {
    let mut st = conn.prepare(
        "SELECT id, request_id, revision_id, seq, kind, assignee_user_id, status, outcome, completed_at
         FROM approval_steps WHERE request_id=?1 ORDER BY seq",
    )?;
    let rows = st.query_map([request_id], |r| {
        Ok(Step {
            id: r.get(0)?,
            request_id: r.get(1)?,
            revision_id: r.get(2)?,
            seq: r.get(3)?,
            kind: StepKind::parse(&r.get::<_, String>(4)?).map_err(|_| {
                rusqlite::Error::InvalidColumnType(4, "kind".into(), rusqlite::types::Type::Text)
            })?,
            assignee_user_id: r.get(5)?,
            status: r.get(6)?,
            outcome: r.get(7)?,
            completed_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn load_step(conn: &Connection, id: i64) -> Res<Step> {
    conn.query_row(
        "SELECT id, request_id, revision_id, seq, kind, assignee_user_id, status, outcome, completed_at
         FROM approval_steps WHERE id=?1",
        [id],
        |r| {
            Ok(Step {
                id: r.get(0)?,
                request_id: r.get(1)?,
                revision_id: r.get(2)?,
                seq: r.get(3)?,
                kind: StepKind::parse(&r.get::<_, String>(4)?).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        4,
                        "kind".into(),
                        rusqlite::types::Type::Text,
                    )
                })?,
                assignee_user_id: r.get(5)?,
                status: r.get(6)?,
                outcome: r.get(7)?,
                completed_at: r.get(8)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("step {id}")))
}

pub fn decisions_of(conn: &Connection, request_id: i64) -> Res<Vec<Decision>> {
    let mut st = conn.prepare(
        "SELECT id, request_id, revision_id, step_id, actor_user_id, acting_for_user_id,
                authority, outcome, reason, basis_document, created_at
         FROM decisions WHERE request_id=?1 ORDER BY id",
    )?;
    let rows = st.query_map([request_id], |r| {
        Ok(Decision {
            id: r.get(0)?,
            request_id: r.get(1)?,
            revision_id: r.get(2)?,
            step_id: r.get(3)?,
            actor_user_id: r.get(4)?,
            acting_for_user_id: r.get(5)?,
            authority: r.get(6)?,
            outcome: r.get(7)?,
            reason: r.get(8)?,
            basis_document: r.get(9)?,
            created_at: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn bump_version(conn: &Connection, request_id: i64, now_ts: &str) -> Res<()> {
    conn.execute(
        "UPDATE leave_requests SET version=version+1, updated_at=?2 WHERE id=?1",
        params![request_id, now_ts],
    )?;
    Ok(())
}

pub fn check_version(req: &LeaveRequest, expected: i64) -> Res<()> {
    if req.version != expected {
        return Err(DomainError::StaleVersion);
    }
    Ok(())
}

/// Open amendment/cancellation child of a parent request, if any.
pub fn open_child(conn: &Connection, parent_id: i64) -> Res<Option<LeaveRequest>> {
    let id = conn
        .query_row(
            "SELECT id FROM leave_requests
             WHERE parent_request_id=?1
               AND status IN ('draft','submitted','needs_information','under_review')",
            [parent_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    match id {
        Some(i) => load_request(conn, i).map(Some),
        None => Ok(None),
    }
}

/// All request ids in the same family (root + direct children).
pub fn family_ids(conn: &Connection, request_id: i64) -> Res<Vec<i64>> {
    let req = load_request(conn, request_id)?;
    let root = req.parent_request_id.unwrap_or(req.id);
    let mut ids = vec![root];
    let mut st = conn.prepare("SELECT id FROM leave_requests WHERE parent_request_id=?1")?;
    let rows = st.query_map([root], |r| r.get::<_, i64>(0))?;
    for r in rows {
        ids.push(r?);
    }
    Ok(ids)
}
