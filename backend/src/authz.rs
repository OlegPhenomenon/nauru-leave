//! Single authorization module (DESIGN §6). `can(ctx, action, resource)` is
//! the only gate; every mutation and every sensitive read calls it.

use rusqlite::Connection;
use serde::Serialize;
use time::Date;

use crate::error::DomainError;
use crate::model::{self, Delegation, RoleGrant, Step, StepKind};
use crate::Res;

/// An authenticated actor with everything needed for decisions:
/// user, linked employee, role grants valid today, current direct reports
/// and active inbound delegations.
#[derive(Clone, Debug)]
pub struct Actor {
    pub user_id: i64,
    pub employee_id: Option<i64>,
    pub roles: Vec<RoleGrant>,
    /// Employee ids this actor manages per today's assignments.
    pub manages: Vec<i64>,
    /// Active delegations to this user.
    pub delegations_in: Vec<Delegation>,
    pub today: Date,
}

impl Actor {
    /// Load the full actor context for `user_id` on `today`.
    pub fn load(conn: &Connection, user_id: i64, today: Date) -> Res<Actor> {
        let user = model::load_user(conn, user_id)?;
        if !user.active {
            return Err(DomainError::Unauthenticated);
        }
        let employee_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM employees WHERE user_id=?1",
                [user_id],
                |r| r.get(0),
            )
            .ok();
        let manages = match employee_id {
            Some(e) => model::direct_reports(conn, e, today)?,
            None => Vec::new(),
        };
        Ok(Actor {
            user_id,
            employee_id,
            roles: model::valid_grants(conn, user_id, today)?,
            manages,
            delegations_in: model::delegations_to(conn, user_id, today)?,
            today,
        })
    }

    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|g| g.role == role)
    }

    /// Does the actor hold `role` covering `unit_id` (scope NULL = all)?
    pub fn role_in_scope(&self, conn: &Connection, role: &str, unit_id: Option<i64>) -> Res<bool> {
        for g in model::valid_grants(conn, self.user_id, self.today)? {
            if g.role == role && model::unit_in_scope(conn, g.scope_org_unit_id, unit_id)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Any of `roles` in scope.
    pub fn any_role_in_scope(
        &self,
        conn: &Connection,
        roles: &[&str],
        unit_id: Option<i64>,
    ) -> Res<bool> {
        for r in roles {
            if self.role_in_scope(conn, r, unit_id)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn is_manager_of(&self, employee_id: i64) -> bool {
        self.manages.contains(&employee_id)
    }
}

// ------------------------------------------------------------------ actions

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    ViewRequest,
    CreateDraft, // own request
    CreatePaper, // on behalf of another employee
    EditDraft,
    DeleteDraft,
    Submit,
    Withdraw,
    Respond,
    Revise,
    DecideStep,
    Amend,
    CancelRequest,
    Comment,
    UploadAttachment,
    DownloadAttachment,
    ViewAttachment,
    ReassignStep,
    ConfirmActual,
    ProposeAdjustment,
    DecideAdjustment,
    RunAccrual,
    ClosePeriod,
    ViewBalances, // another employee's balances
    TransferEmployee,
    ManageDelegations,
    RetryNotification,
    ViewAudit,
    ManageSettings,
    ManagePeople,
    ManageUsers,
    ViewOperations,
    ManageImportsExports,
}

/// What an action operates on.
pub enum Resource<'a> {
    Request(&'a RequestCtx),
    /// A step of a request (decide / reassign).
    Step {
        request: &'a RequestCtx,
        step: &'a Step,
    },
    Attachment(&'a AttachmentCtx),
    Employee {
        employee_id: i64,
        org_unit_id: Option<i64>,
    },
    Global,
}

/// Facts about a request needed for authorization.
#[derive(Clone, Debug)]
pub struct RequestCtx {
    pub id: i64,
    pub employee_id: i64,
    pub employee_user_id: Option<i64>,
    pub entered_by_user_id: i64,
    pub org_unit_id: Option<i64>,
    pub sensitive_type: bool,
    pub kind: String,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct AttachmentCtx {
    pub id: i64,
    pub request: RequestCtx,
    pub uploaded_by: i64,
    pub sensitivity: String,
    pub scan_status: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewLevel {
    /// Everything except medical attachments unless hr_medical.
    Full,
    /// Sensitive leave type masked as "Leave (details restricted)".
    Restricted,
}

pub fn require(conn: &Connection, actor: &Actor, action: Action, res: &Resource) -> Res<()> {
    can(conn, actor, action, res)
}

/// The gate. Returns Err(Forbidden/SelfApprovalForbidden) when denied.
pub fn can(conn: &Connection, actor: &Actor, action: Action, res: &Resource) -> Res<()> {
    let fresh = Actor::load(conn, actor.user_id, actor.today)?;
    let actor = &fresh;
    match action {
        Action::ManageSettings => {
            if actor.role_in_scope(conn, "hr", None)? {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs service-wide hr scope"))
            }
        }
        Action::ManageImportsExports => {
            if actor.has_role("hr") {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs hr role"))
            }
        }
        Action::ManagePeople => {
            let unit = match res {
                Resource::Employee { org_unit_id, .. } => *org_unit_id,
                _ => None,
            };
            if actor.role_in_scope(conn, "hr", unit)? {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs hr scope"))
            }
        }
        Action::ManageUsers => {
            if actor.has_role("tech_admin") || actor.has_role("hr") {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs tech_admin or hr"))
            }
        }
        Action::ViewOperations => {
            if actor.has_role("hr") || actor.has_role("tech_admin") {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs hr or tech_admin"))
            }
        }
        Action::ViewRequest => view_level(conn, actor, req_of(res)).map(|_| ()),
        Action::CreateDraft => {
            if actor.employee_id.is_some() {
                Ok(())
            } else {
                Err(DomainError::forbidden("no employee record"))
            }
        }
        Action::CreatePaper => {
            let Resource::Employee {
                employee_id: _,
                org_unit_id,
            } = res
            else {
                unreachable!()
            };
            if actor.role_in_scope(conn, "hr", *org_unit_id)? {
                Ok(())
            } else {
                Err(DomainError::forbidden("paper entry needs hr scope"))
            }
        }
        Action::EditDraft
        | Action::DeleteDraft
        | Action::Submit
        | Action::Withdraw
        | Action::Respond
        | Action::Revise
        | Action::Amend
        | Action::CancelRequest
        | Action::UploadAttachment => {
            let req = req_of(res);
            // Current ownership or HR scope; authorship is historical.
            if actor.employee_id == Some(req.employee_id)
                || actor.role_in_scope(conn, "hr", req.org_unit_id)?
            {
                Ok(())
            } else {
                Err(DomainError::forbidden("not the owner"))
            }
        }
        Action::Comment => {
            if (actor.has_role("auditor") || actor.has_role("tech_admin"))
                && actor.employee_id != Some(req_of(res).employee_id)
            {
                return Err(DomainError::forbidden("read-only role cannot comment"));
            }
            view_level(conn, actor, req_of(res)).map(|_| ())
        }
        Action::DecideStep => match res {
            Resource::Step { request, step } => {
                decide_authority(conn, actor, request, step).map(|_| ())
            }
            _ => unreachable!(),
        },
        Action::ViewAttachment => match res {
            Resource::Attachment(a) => {
                if a.sensitivity == "medical" {
                    if actor.employee_id == Some(a.request.employee_id)
                        || actor.role_in_scope(conn, "hr_medical", a.request.org_unit_id)?
                    {
                        Ok(())
                    } else {
                        Err(DomainError::forbidden("medical file"))
                    }
                } else {
                    view_level(conn, actor, &a.request).map(|_| ())
                }
            }
            _ => unreachable!(),
        },
        Action::DownloadAttachment => match res {
            Resource::Attachment(a) => {
                if a.scan_status != "clean" {
                    return Err(DomainError::forbidden("file has not passed scanning"));
                }
                if a.sensitivity == "medical" {
                    let owner = actor.employee_id == Some(a.request.employee_id);
                    if owner || actor.role_in_scope(conn, "hr_medical", a.request.org_unit_id)? {
                        Ok(())
                    } else {
                        Err(DomainError::forbidden("medical file"))
                    }
                } else {
                    view_level(conn, actor, &a.request).map(|_| ())
                }
            }
            _ => unreachable!(),
        },
        Action::ReassignStep | Action::ConfirmActual => {
            let req = req_of(res);
            if actor.role_in_scope(conn, "hr", req.org_unit_id)? {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs hr scope"))
            }
        }
        Action::ProposeAdjustment => match res {
            Resource::Employee { org_unit_id, .. } => {
                if actor.role_in_scope(conn, "hr", *org_unit_id)? {
                    Ok(())
                } else {
                    Err(DomainError::forbidden("needs hr scope"))
                }
            }
            _ => unreachable!(),
        },
        Action::DecideAdjustment => match res {
            Resource::Employee { org_unit_id, .. } => {
                if actor.role_in_scope(conn, "adjustment_approver", *org_unit_id)? {
                    Ok(())
                } else {
                    Err(DomainError::forbidden("needs adjustment_approver scope"))
                }
            }
            _ => unreachable!(),
        },
        Action::RunAccrual | Action::ClosePeriod => {
            if actor.role_in_scope(conn, "hr", None)? {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs hr role"))
            }
        }
        Action::ViewBalances => match res {
            Resource::Employee {
                employee_id,
                org_unit_id,
            } => {
                if actor.employee_id == Some(*employee_id)
                    || actor.any_role_in_scope(
                        conn,
                        &["hr", "hr_medical", "final_approver", "auditor"],
                        *org_unit_id,
                    )?
                {
                    Ok(())
                } else {
                    Err(DomainError::forbidden("no access to balances"))
                }
            }
            _ => unreachable!(),
        },
        Action::TransferEmployee => match res {
            Resource::Employee { org_unit_id, .. } => {
                if actor.role_in_scope(conn, "hr", *org_unit_id)? {
                    Ok(())
                } else {
                    Err(DomainError::forbidden("needs hr scope"))
                }
            }
            _ => unreachable!(),
        },
        Action::ManageDelegations | Action::RetryNotification => {
            if actor.any_role_in_scope(conn, &["hr", "tech_admin"], None)? {
                Ok(())
            } else {
                Err(DomainError::forbidden("needs hr or tech_admin"))
            }
        }
        Action::ViewAudit => {
            if actor.has_role("hr") || actor.has_role("auditor") || actor.has_role("tech_admin") {
                Ok(())
            } else {
                Err(DomainError::forbidden("no audit access"))
            }
        }
    }
}

fn req_of<'a>(res: &'a Resource<'a>) -> &'a RequestCtx {
    match res {
        Resource::Request(r) => r,
        Resource::Step { request, .. } => request,
        Resource::Attachment(a) => &a.request,
        _ => unreachable!(),
    }
}

/// Visibility of a request for the actor. Err = no access at all.
pub fn view_level(conn: &Connection, actor: &Actor, req: &RequestCtx) -> Res<ViewLevel> {
    let fresh = Actor::load(conn, actor.user_id, actor.today)?;
    let actor = &fresh;
    let masked = if req.sensitive_type {
        ViewLevel::Restricted
    } else {
        ViewLevel::Full
    };
    // The employee retains access independently of their staff roles.
    if actor.employee_id == Some(req.employee_id) {
        return Ok(ViewLevel::Full);
    }
    // staff roles in scope
    if actor.any_role_in_scope(
        conn,
        &["hr", "hr_medical", "final_approver", "auditor"],
        req.org_unit_id,
    )? {
        return Ok(ViewLevel::Full); // staff see the type; medical files are a separate gate
    }
    if actor.is_manager_of(req.employee_id) {
        return Ok(masked);
    }
    // Visibility through a step uses exactly the current decision authority.
    if let Some(step) = crate::requests::pending_step(conn, req.id)? {
        if matches!(
            req.status.as_str(),
            "submitted" | "under_review" | "needs_information"
        ) && decide_authority(conn, actor, req, &step).is_ok()
        {
            return Ok(masked);
        }
    }
    Err(DomainError::forbidden("no access to this request"))
}

// ------------------------------------------------------------------ decisions

/// Result of an eligibility check for `decide`: who the actor acts for.
pub struct Authority {
    /// Set when acting under a delegation.
    pub acting_for_user_id: Option<i64>,
    /// Human label for the decision record, e.g. "manager of IU".
    pub label: String,
}

/// Check that `actor` may decide `step` of `request`; returns the authority
/// the decision will be recorded under. Enforces the self-approval ban —
/// also through a delegation.
pub fn decide_authority(
    conn: &Connection,
    actor: &Actor,
    req: &RequestCtx,
    step: &Step,
) -> Res<Authority> {
    let fresh = Actor::load(conn, actor.user_id, actor.today)?;
    let actor = &fresh;
    // self-approval ban: the employee can never decide their own request,
    // whatever roles or delegations they hold.
    if Some(actor.user_id) == req.employee_user_id {
        return Err(DomainError::SelfApprovalForbidden);
    }
    // direct eligibility
    if let Some(a) = direct_authority(conn, actor, req, step, None)? {
        return Ok(a);
    }
    // eligibility through an active delegation to the actor
    let mut blocked_self = false;
    for d in &actor.delegations_in {
        if d.scope != "all_approvals" && d.scope != step.kind.delegation_scope() {
            continue;
        }
        // the delegator may not be the request's employee either —
        // that is still the self-approval ban, not a plain 403
        if Some(d.from_user_id) == req.employee_user_id {
            blocked_self = true;
            continue;
        }
        if let Some(mut a) = direct_authority(conn, actor, req, step, Some(d.from_user_id))? {
            a.acting_for_user_id = Some(d.from_user_id);
            a.label = format!("delegation #{}", d.id);
            return Ok(a);
        }
    }
    if blocked_self {
        return Err(DomainError::SelfApprovalForbidden);
    }
    Err(DomainError::forbidden("not eligible for this step"))
}

/// Direct eligibility: the actor (or `principal` when checking a delegation)
/// must be the step's assignee, or — for unassigned steps — satisfy the kind:
/// manager = today's manager of the employee, hr_check = hr in scope,
/// final_decision = final_approver in scope.
fn direct_authority(
    conn: &Connection,
    actor: &Actor,
    req: &RequestCtx,
    step: &Step,
    principal: Option<i64>,
) -> Res<Option<Authority>> {
    let who = principal.unwrap_or(actor.user_id);
    if !model::load_user(conn, who)?.active {
        return Ok(None);
    }
    if let Some(assignee) = step.assignee_user_id {
        if assignee != who {
            return Ok(None);
        }
        let required_role = match step.kind {
            StepKind::ManagerRecommendation => None,
            StepKind::HrCheck => Some("hr"),
            StepKind::FinalDecision => Some("final_approver"),
        };
        if let Some(role) = required_role {
            if !role_in_scope_for(conn, who, &[role], req.org_unit_id, actor.today)? {
                return Ok(None);
            }
        }
        let label = assignee_label(conn, req, step, who)?;
        return Ok(Some(Authority {
            acting_for_user_id: None,
            label,
        }));
    }
    // unassigned step
    match step.kind {
        StepKind::ManagerRecommendation => {
            let mgr = model::manager_at(conn, req.employee_id, actor.today)?;
            if let Some(m) = mgr {
                if m.user_id == Some(who) {
                    let unit = model::unit_of(conn, req.employee_id, actor.today)?;
                    let name = unit_name(conn, unit);
                    return Ok(Some(Authority {
                        acting_for_user_id: None,
                        label: format!("manager of {name}"),
                    }));
                }
            }
            Ok(None)
        }
        StepKind::HrCheck => {
            if role_in_scope_for(conn, who, &["hr"], req.org_unit_id, actor.today)? {
                return Ok(Some(Authority {
                    acting_for_user_id: None,
                    label: "hr scope".to_string(),
                }));
            }
            Ok(None)
        }
        StepKind::FinalDecision => {
            if role_in_scope_for(conn, who, &["final_approver"], req.org_unit_id, actor.today)? {
                return Ok(Some(Authority {
                    acting_for_user_id: None,
                    label: "final_approver".to_string(),
                }));
            }
            Ok(None)
        }
    }
}

fn assignee_label(conn: &Connection, req: &RequestCtx, step: &Step, _who: i64) -> Res<String> {
    Ok(match step.kind {
        StepKind::ManagerRecommendation => {
            format!("manager of {}", unit_name(conn, req.org_unit_id))
        }
        StepKind::HrCheck => "hr".to_string(),
        StepKind::FinalDecision => "final_approver".to_string(),
    })
}

fn unit_name(conn: &Connection, unit: Option<i64>) -> String {
    unit.and_then(|u| {
        conn.query_row("SELECT name FROM org_units WHERE id=?1", [u], |r| r.get(0))
            .ok()
    })
    .unwrap_or_else(|| "service".to_string())
}

/// Does `user_id` hold any of `roles` covering `unit` on `date`?
fn role_in_scope_for(
    conn: &Connection,
    user_id: i64,
    roles: &[&str],
    unit: Option<i64>,
    date: Date,
) -> Res<bool> {
    for g in model::valid_grants(conn, user_id, date)? {
        if roles.contains(&g.role.as_str())
            && model::unit_in_scope(conn, g.scope_org_unit_id, unit)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// CLI callers are trusted by local OS access; refuse to mutate a demo database.
pub fn require_operator(conn: &Connection) -> Res<()> {
    let demo: i64 = conn.query_row("SELECT COUNT(*) FROM settings WHERE (key='mode' AND value!='production') OR key='demo_today'", [], |r| r.get(0))?;
    if demo > 0 {
        return Err(DomainError::forbidden(
            "operator provisioning requires a production database",
        ));
    }
    Ok(())
}

/// Business role administration is independent of account administration.
pub fn grantable_roles(conn: &Connection, actor: &Actor, grantee: i64) -> Res<Vec<&'static str>> {
    let actor = Actor::load(conn, actor.user_id, actor.today)?;
    if actor.user_id == grantee {
        return Ok(vec![]);
    }
    let mut roles = vec![];
    if actor.has_role("tech_admin") {
        roles.push("tech_admin");
    }
    if actor.role_in_scope(conn, "hr", None)? {
        roles.extend(["hr", "final_approver", "adjustment_approver", "auditor"]);
        if actor.has_role("hr_medical") {
            roles.push("hr_medical");
        }
    }
    Ok(roles)
}
pub fn require_role_administration(
    conn: &Connection,
    actor: &Actor,
    grantee: i64,
    role: &str,
) -> Res<()> {
    if grantable_roles(conn, actor, grantee)?.contains(&role) {
        Ok(())
    } else {
        Err(DomainError::forbidden(
            "role administration needs independent business authority",
        ))
    }
}
pub fn require_employee_link(
    conn: &Connection,
    actor: &Actor,
    user: i64,
    employee: i64,
) -> Res<()> {
    if user == actor.user_id {
        return Err(DomainError::forbidden(
            "cannot change your own employee link",
        ));
    }
    model::load_employee(conn, employee)?;
    require(
        conn,
        actor,
        Action::ManagePeople,
        &Resource::Employee {
            employee_id: employee,
            org_unit_id: model::unit_of(conn, employee, actor.today)?,
        },
    )
}
