//! Authorized settings and directory mutations, wrapping trusted core writers.
use crate::{
    audit,
    authz::{self, Action, Actor, Resource},
    clock::{Clock, Mode},
    db,
    model::{self, date_s},
    notify, people, presentation as view, queries, DomainError, Res,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use time::Date;
pub fn text<'a>(v: &'a Value, k: &str) -> Res<&'a str> {
    v[k].as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| DomainError::validation(format!("{k} is required")))
}
pub fn integer(v: &Value, k: &str) -> Res<i64> {
    v[k].as_i64()
        .ok_or_else(|| DomainError::validation(format!("{k} must be integer")))
}
pub fn period_year(v: &Value) -> Res<i64> {
    let year = integer(v, "period_year")?;
    if !(1900..=2200).contains(&year) {
        return Err(DomainError::validation("period_year must be 1900..2200"));
    }
    Ok(year)
}
pub fn optional<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v[k].as_str()
}
pub fn date(v: &Value, k: &str) -> Res<Date> {
    model::parse_date(text(v, k)?)
}
fn boolean(v: &Value, k: &str, default: bool) -> Res<bool> {
    if v[k].is_null() {
        Ok(default)
    } else {
        v[k].as_bool()
            .ok_or_else(|| DomainError::validation(format!("{k} must be boolean")))
    }
}
pub fn nullable_integer(v: &Value, key: &str) -> Res<Option<i64>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| DomainError::validation(format!("{key} must be an integer or null"))),
    }
}
fn week(v: &Value) -> Res<[i64; 7]> {
    let mut week = [0; 7];
    for (i, key) in ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        .iter()
        .enumerate()
    {
        week[i] = if v["week"].is_array() {
            v["week"][i].as_i64()
        } else {
            v["week"][key].as_i64()
        }
        .filter(|n| *n >= 0 && *n <= 1440)
        .ok_or_else(|| {
            DomainError::validation("week must contain seven minute values in 0..1440")
        })?;
    }
    Ok(week)
}
fn affected(conn: &Connection, employee: Option<i64>, from: Date) -> Res<Value> {
    Ok(json!(queries::affected_future_requests(
        conn, employee, from
    )?
    .into_iter()
    .map(|(id, number)| json!({"id":id,"number":number}))
    .collect::<Vec<_>>()))
}
/// Compare the resource version inside the caller's write transaction.
pub fn check_setting_version(conn: &Connection, table: &str, id: i64, body: &Value) -> Res<()> {
    if ![
        "leave_types",
        "org_units",
        "employees",
        "users",
        "schedules",
        "schedule_versions",
    ]
    .contains(&table)
    {
        return Err(DomainError::validation("invalid setting"));
    }
    let actual = conn
        .query_row(
            &format!("SELECT version FROM {table} WHERE id=?1"),
            [id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| DomainError::not_found(table))?;
    if integer(body, "expected_version")? != actual {
        return Err(DomainError::StaleVersion);
    }
    Ok(())
}
pub fn mutate(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    mode: Mode,
    method: &str,
    path: &[&str],
    body: &Value,
) -> Res<Value> {
    let today = clock.today(conn)?;
    let now = clock.now_ts();
    let id = path.get(1).and_then(|s| s.parse::<i64>().ok());
    let action = match path[0] {
        "users" | "role-grants" => Action::ManageUsers,
        "employees" => Action::ManagePeople,
        _ => Action::ManageSettings,
    };
    db::write_tx(conn, |tx| {
        let resource = if path[0] == "employees" {
            Resource::Employee {
                employee_id: id.unwrap_or(0),
                org_unit_id: if let Some(id) = id {
                    model::unit_of(tx, id, today)?
                } else {
                    body["org_unit_id"].as_i64()
                },
            }
        } else {
            Resource::Global
        };
        authz::require(tx, actor, action, &resource)?;
        let version_table = match (path[0], method, path.get(2).copied()) {
            ("leave-types", "PUT", _) => Some("leave_types"),
            ("org-units", "PUT", _) => Some("org_units"),
            ("employees", "PUT", _) | ("employees", "POST", Some("schedule")) => Some("employees"),
            ("users", "PUT", _) => Some("users"),
            ("schedules", "POST", Some("versions")) => Some("schedules"),
            _ => None,
        };
        if let (Some(table), Some(id)) = (version_table, id) {
            check_setting_version(tx, table, id, body)?;
        }
        let mut result = match (path[0], method, id, path.get(2).copied()) {
            ("org-units", "POST", None, _) => {
                json!({"id":people::create_org_unit(tx,text(body,"code")?,text(body,"name")?,body["parent_id"].as_i64())?})
            }
            ("org-units", "PUT", Some(id), _) => {
                if body["parent_id"].as_i64() == Some(id) {
                    return Err(DomainError::validation("unit cannot parent itself"));
                }
                tx.execute(
                    "UPDATE org_units SET code=?2,name=?3,parent_id=?4,active=?5 WHERE id=?1",
                    params![
                        id,
                        text(body, "code")?,
                        text(body, "name")?,
                        body["parent_id"].as_i64(),
                        boolean(body, "active", true)?
                    ],
                )?;
                json!({"id":id})
            }
            ("employees", "POST", None, _) => {
                let start = date(body, "start_date")?;
                json!({"id":people::create_employee(tx,text(body,"service_id")?,text(body,"full_name")?,optional(body,"email"),None,start,integer(body,"org_unit_id")?,body["manager_employee_id"].as_i64(),integer(body,"schedule_id")?,start,&now)?})
            }
            ("employees", "PUT", Some(id), _) => {
                model::load_employee(tx, id)?;
                if let Some(end) = optional(body, "end_date") {
                    model::parse_date(end)?;
                }
                tx.execute(
                    "UPDATE employees SET full_name=?2,email=?3,end_date=?4,active=?5 WHERE id=?1",
                    params![
                        id,
                        text(body, "full_name")?,
                        optional(body, "email"),
                        optional(body, "end_date"),
                        boolean(body, "active", true)?
                    ],
                )?;
                json!({"id":id})
            }
            ("employees", "POST", Some(id), Some("schedule")) => {
                let from = date(body, "valid_from")?;
                let schedule = integer(body, "schedule_id")?;
                let latest: Option<String> = tx.query_row(
                    "SELECT MAX(valid_from) FROM employee_schedules WHERE employee_id=?1",
                    [id],
                    |r| r.get(0),
                )?;
                if latest.is_some_and(|s| s >= date_s(&from)) {
                    return Err(DomainError::validation(
                        "schedule valid_from must follow the last assignment",
                    ));
                }
                tx.execute("UPDATE employee_schedules SET valid_to=?2 WHERE employee_id=?1 AND valid_to IS NULL",params![id,date_s(&from.previous_day().ok_or_else(||DomainError::validation("date overflow"))?)])?;
                people::set_schedule(tx, id, schedule, from)?;
                json!({"id":id,"affected_future_requests":affected(tx,Some(id),from)?})
            }
            ("leave-types", "POST", None, _) => {
                json!({"id":people::create_leave_type(tx, text(body,"code")?, text(body,"name")?, boolean(body,"sensitive",false)?)?})
            }
            ("leave-types", "PUT", Some(id), _) => {
                model::load_leave_type(tx, id)?;
                tx.execute(
                    "UPDATE leave_types SET code=?2,name=?3,sensitive=?4,active=?5 WHERE id=?1",
                    params![
                        id,
                        text(body, "code")?,
                        text(body, "name")?,
                        boolean(body, "sensitive", false)?,
                        boolean(body, "active", true)?
                    ],
                )?;
                json!({"id":id})
            }
            ("leave-types", "POST", Some(id), Some("policies")) => {
                let entitlement = integer(body, "annual_entitlement_min")?;
                let advance = integer(body, "advance_publish_months")?;
                let expiry = nullable_integer(body, "carryover_expiry_months")?;
                if entitlement < 0 || advance < 0 || expiry.is_some_and(|i| i < 0) {
                    return Err(DomainError::validation(
                        "policy quantities cannot be negative",
                    ));
                }
                let accrual = text(body, "accrual_mode")?;
                if !["none", "annual_upfront", "monthly"].contains(&accrual) {
                    return Err(DomainError::validation("invalid accrual mode"));
                }
                let explanation = text(body, "explanation")?;
                let explanation = if mode == Mode::Demo {
                    format!("Fictional demo rule — not Nauru law. {explanation}")
                } else {
                    explanation.into()
                };
                let current = model::policy_for(tx, id, date(body, "valid_from")?)?;
                let policy = people::create_policy(
                    tx,
                    id,
                    date(body, "valid_from")?,
                    entitlement,
                    accrual,
                    advance,
                    boolean(body, "carryover_allowed", false)?,
                    expiry,
                    boolean(body, "allow_negative", false)?,
                    &explanation,
                    if mode == Mode::Demo {
                        "demo_fictional"
                    } else {
                        "unverified"
                    },
                    Some(actor.user_id),
                    &now,
                )?;
                let t = model::load_leave_type(tx, id)?;
                let limit = nullable_integer(body, "carryover_limit_min")?;
                if limit.is_some_and(|i| i < 0) {
                    return Err(DomainError::validation(
                        "carryover limit cannot be negative",
                    ));
                }
                let notice = body["min_notice_days"].as_i64().unwrap_or_else(|| {
                    current
                        .as_ref()
                        .map_or(t.min_notice_days, |p| p.min_notice_days)
                });
                if notice < 0 {
                    return Err(DomainError::validation("notice cannot be negative"));
                }
                tx.execute("UPDATE policy_versions SET carryover_limit_min=?2,paid=?3,uses_balance=?4,allow_half_day=?5,requires_attachment=?6,min_notice_days=?7 WHERE id=?1",params![policy,limit,boolean(body,"paid",current.as_ref().map_or(t.paid,|p|p.paid))?,boolean(body,"uses_balance",current.as_ref().map_or(t.uses_balance,|p|p.uses_balance))?,boolean(body,"allow_half_day",current.as_ref().map_or(t.allow_half_day,|p|p.allow_half_day))?,boolean(body,"requires_attachment",current.as_ref().map_or(t.requires_attachment,|p|p.requires_attachment))?,notice])?;
                let mut result = rows_one(tx, "SELECT * FROM policy_versions WHERE id=?1", policy)?;
                for key in [
                    "paid",
                    "uses_balance",
                    "allow_half_day",
                    "requires_attachment",
                    "carryover_allowed",
                    "allow_negative",
                ] {
                    result[key] = json!(result[key].as_i64() == Some(1));
                }
                result["in_force"] =
                    json!(model::policy_for(tx, id, today)?.is_some_and(|p| p.id == policy));
                let from = date(body, "valid_from")?.max(today);
                result["affected_future_requests"] =
                    json!(queries::affected_future_requests(tx, None, from)?
                        .into_iter()
                        .filter(|(request, _)| model::load_request(tx, *request)
                            .and_then(|r| model::load_revision(
                                tx,
                                r.effective_revision_id
                                    .or(r.current_revision_id)
                                    .ok_or_else(|| DomainError::not_found("revision"))?
                            ))
                            .is_ok_and(|r| r.leave_type_id == id))
                        .map(|(id, number)| json!({"id":id,"number":number}))
                        .collect::<Vec<_>>());
                result
            }
            ("policies", "POST", Some(id), Some("verify")) => {
                if mode == Mode::Demo {
                    return Err(DomainError::validation(
                        "fictional demo rules cannot be verified",
                    ));
                }
                if tx.execute(
                    "UPDATE policy_versions SET status='verified',verified_by=?2 WHERE id=?1",
                    params![id, actor.user_id],
                )? == 0
                {
                    return Err(DomainError::not_found("policy"));
                }
                json!({"id":id,"status":"verified"})
            }
            ("schedules", "POST", None, _) => {
                let (id, _) = people::create_schedule(
                    tx,
                    text(body, "name")?,
                    date(body, "valid_from")?,
                    week(body)?,
                    optional(body, "note"),
                )?;
                json!({"id":id})
            }
            ("schedules", "POST", Some(id), Some("versions")) => {
                let from = date(body, "valid_from")?;
                let week = week(body)?;
                let latest: Option<String> = tx.query_row(
                    "SELECT MAX(valid_from) FROM schedule_versions WHERE schedule_id=?1",
                    [id],
                    |r| r.get(0),
                )?;
                if latest.is_none() {
                    return Err(DomainError::not_found("schedule"));
                }
                if latest.is_some_and(|s| s >= date_s(&from)) {
                    return Err(DomainError::validation(
                        "valid_from must follow the last version",
                    ));
                }
                tx.execute("UPDATE schedule_versions SET valid_to=?2 WHERE schedule_id=?1 AND valid_to IS NULL",params![id,date_s(&from.previous_day().unwrap())])?;
                let version:i64=tx.query_row("INSERT INTO schedule_versions(schedule_id,valid_from,mon_min,tue_min,wed_min,thu_min,fri_min,sat_min,sun_min,note) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING id",params![id,date_s(&from),week[0],week[1],week[2],week[3],week[4],week[5],week[6],optional(body,"note")],|r|r.get(0))?;
                json!({"id":version,"affected_future_requests":affected(tx,None,from)?})
            }
            ("calendar-exceptions", "POST", None, _) => {
                let d = date(body, "date")?;
                let minutes = integer(body, "minutes")?;
                if !(0..=1440).contains(&minutes) {
                    return Err(DomainError::validation("minutes must be in 0..1440"));
                }
                let schedule = body["schedule_id"].as_i64();
                let n: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM calendar_exceptions WHERE revoked_at IS NULL AND date=?1 AND schedule_id IS ?2",
                    params![date_s(&d), schedule],
                    |r| r.get(0),
                )?;
                if n > 0 {
                    return Err(DomainError::validation("exception already exists"));
                }
                let id = people::create_calendar_exception(
                    tx,
                    d,
                    text(body, "name")?,
                    minutes,
                    schedule,
                    &now,
                )?;
                json!({"id":id,"affected_future_requests":affected(tx,None,d)?})
            }
            ("calendar-exceptions", "POST", Some(id), Some("revoke")) => {
                let d: String = tx
                    .query_row(
                        "SELECT date FROM calendar_exceptions WHERE id=?1",
                        [id],
                        |r| r.get(0),
                    )
                    .map_err(|_| DomainError::not_found("calendar exception"))?;
                let reason = text(body, "reason")?;
                if reason.trim().is_empty() {
                    return Err(DomainError::validation("reason required"));
                }
                tx.execute("UPDATE calendar_exceptions SET revoked_at=?2,revoked_by=?3,reason=?4 WHERE id=?1 AND revoked_at IS NULL",params![id,now,actor.user_id,reason])?;
                json!({"affected_future_requests":affected(tx,None,model::parse_date(&d)?)?})
            }
            ("users", "POST", None, _) => {
                let id = people::create_user(
                    tx,
                    text(body, "email")?,
                    text(body, "display_name")?,
                    None,
                    &now,
                )?;
                tx.execute(
                    "UPDATE users SET active=?2 WHERE id=?1",
                    params![id, boolean(body, "active", true)?],
                )?;
                if let Some(e) = body["employee_id"].as_i64() {
                    model::load_employee(tx, e)?;
                    tx.execute(
                        "UPDATE employees SET user_id=?2 WHERE id=?1",
                        params![e, id],
                    )?;
                }
                json!({"id":id})
            }
            ("users", "PUT", Some(id), _) => {
                model::load_user(tx, id)?;
                let active = boolean(body, "active", true)?;
                tx.execute(
                    "UPDATE users SET email=?2,display_name=?3,active=?4 WHERE id=?1",
                    params![
                        id,
                        text(body, "email")?,
                        text(body, "display_name")?,
                        active
                    ],
                )?;
                if body.get("employee_id").is_some() {
                    tx.execute("UPDATE employees SET user_id=NULL WHERE user_id=?1", [id])?;
                    if let Some(e) = body["employee_id"].as_i64() {
                        tx.execute(
                            "UPDATE employees SET user_id=?2 WHERE id=?1",
                            params![e, id],
                        )?;
                    }
                }
                if !active {
                    tx.execute(
                        "UPDATE sessions SET revoked_at=?2 WHERE user_id=?1 AND revoked_at IS NULL",
                        params![id, now],
                    )?;
                }
                json!({"id":id})
            }
            ("users", "POST", Some(id), Some("roles")) => {
                let role = text(body, "role")?;
                if id == actor.user_id && ["final_approver", "adjustment_approver"].contains(&role)
                {
                    return Err(DomainError::forbidden("cannot grant this role to yourself"));
                }
                if ![
                    "hr",
                    "hr_medical",
                    "final_approver",
                    "adjustment_approver",
                    "tech_admin",
                    "auditor",
                ]
                .contains(&role)
                {
                    return Err(DomainError::validation("invalid role"));
                }
                let from = optional(body, "valid_from")
                    .map(model::parse_date)
                    .transpose()?
                    .unwrap_or(today);
                let to = optional(body, "valid_to")
                    .map(model::parse_date)
                    .transpose()?;
                if to.is_some_and(|d| d < from) {
                    return Err(DomainError::validation("valid_to before valid_from"));
                }
                json!({"id":people::grant_role(tx,id,role,body["scope_org_unit_id"].as_i64(),from,to,Some(actor.user_id),&now)?})
            }
            ("role-grants", "DELETE", Some(id), _) => {
                if tx.execute("DELETE FROM role_grants WHERE id=?1", [id])? == 0 {
                    return Err(DomainError::not_found("role grant"));
                }
                json!({"id":id})
            }
            _ => return Err(DomainError::not_found("settings action")),
        };
        if let (Some(table), Some(id)) = (version_table, id) {
            tx.execute(
                &format!("UPDATE {table} SET version=version+1 WHERE id=?1"),
                [id],
            )?;
            result["version"] = json!(tx.query_row(
                &format!("SELECT version FROM {table} WHERE id=?1"),
                [id],
                |r| r.get::<_, i64>(0)
            )?);
        } else if [
            "org-units",
            "employees",
            "leave-types",
            "users",
            "schedules",
        ]
        .contains(&path[0])
            && id.is_none()
        {
            result["version"] = json!(1);
        }
        let entity = path[0].trim_end_matches('s');
        let object = result["id"].as_i64().or(id);
        audit::log(
            tx,
            &now,
            Some(actor.user_id),
            None,
            &format!("{entity}.{}", method.to_lowercase()),
            entity,
            object,
            json!({}),
        )?;
        notify::record_change(tx, clock, actor.user_id, entity)?;
        Ok(result)
    })
}
fn rows_one(conn: &Connection, sql: &str, id: i64) -> Res<Value> {
    view::rows(conn, sql, &[&id])?
        .pop()
        .ok_or_else(|| DomainError::not_found("record"))
}
/// Demo business-date mutation still requires a real authenticated actor.
pub fn set_demo_clock(conn: &mut Connection, clock: &Clock, actor: &Actor, date: Date) -> Res<()> {
    db::write_tx(conn, |tx| {
        crate::model::load_user(tx, actor.user_id)?;
        if date < clock.today(tx)? || date > model::parse_date("2028-12-31")? {
            return Err(DomainError::validation(
                "date must be forward and no later than 2028-12-31",
            ));
        }
        tx.execute("INSERT INTO settings(key,value) VALUES('demo_today',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[date_s(&date)])?;
        audit::log(
            tx,
            &clock.now_ts(),
            Some(actor.user_id),
            None,
            "demo.clock",
            "settings",
            None,
            json!({"date":date_s(&date)}),
        )?;
        notify::record_change(tx, clock, actor.user_id, "demo.clock")?;
        Ok(())
    })
}
#[allow(clippy::too_many_arguments)]
pub fn upload(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    store: &crate::files::FileStore,
    id: i64,
    name: &str,
    bytes: &[u8],
    sensitivity: &str,
    demo: bool,
) -> Res<i64> {
    let request = model::load_request(conn, id)?;
    let ctx = crate::requests::request_ctx(conn, &request, clock.today(conn)?)?;
    authz::require(
        conn,
        actor,
        Action::UploadAttachment,
        &Resource::Request(&ctx),
    )?;
    if demo {
        if bytes.len() > 1024 * 1024 {
            return Err(DomainError::validation("demo file too large (1 MB max)"));
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))?;
        if count >= 20 {
            return Err(DomainError::validation(
                "demo upload limit reached (20 files)",
            ));
        }
        let mut used = 0u64;
        for file in std::fs::read_dir(&store.dir)? {
            let file = file?;
            if file.file_type()?.is_file() {
                used += file.metadata()?.len();
            }
        }
        if used + bytes.len() as u64 > 10 * 1024 * 1024 {
            return Err(DomainError::validation(
                "sandbox file quota exceeded (10 MB)",
            ));
        }
    }
    crate::requests::upload_attachment(conn, clock, actor, store, id, name, bytes, sensitivity)
}

/// Authorize again at download time, including medical and scan gates.
/// SQLite reads/audit run on the request's blocking thread; file I/O precedes the audit transaction.
pub fn download(
    conn: &Connection,
    actor: &Actor,
    store: &crate::files::FileStore,
    id: i64,
) -> Res<(Vec<u8>, String, String)> {
    let ctx = crate::requests::attachment_ctx(conn, id, actor.today)?;
    authz::require(
        conn,
        actor,
        Action::DownloadAttachment,
        &Resource::Attachment(&ctx),
    )?;
    if ctx.scan_status != "clean" {
        return Err(DomainError::forbidden("file has not passed scanning"));
    }
    let (key, mime, name): (String, String, String) = conn.query_row(
        "SELECT storage_key,content_type,filename FROM attachments WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let bytes = store.get(&key)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Res<()> {
        let fresh = Actor::load(conn, actor.user_id, actor.today)?;
        authz::require(
            conn,
            &fresh,
            Action::DownloadAttachment,
            &Resource::Attachment(&ctx),
        )?;
        audit::log(
            conn,
            &Clock::production().now_ts(),
            Some(actor.user_id),
            None,
            "attachment.download",
            "attachment",
            Some(id),
            json!({"request_id":ctx.request.id}),
        )?;
        Ok(())
    })();
    if result.is_ok() {
        conn.execute_batch("COMMIT")?;
    } else {
        let _ = conn.execute_batch("ROLLBACK");
        result?;
    }
    Ok((bytes, mime, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_authorization_and_transaction() {
        let mut c = db::open_memory().unwrap();
        db::migrate(&c).unwrap();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        crate::seed::seed_template(&mut c, &dir).unwrap();
        let clock = Clock::demo();
        let alex = Actor::load(&c, 1, clock.today(&c).unwrap()).unwrap();
        assert!(mutate(
            &mut c,
            &clock,
            &alex,
            Mode::Demo,
            "POST",
            &["org-units"],
            &json!({"code":"X","name":"X"})
        )
        .is_err());
        let maria_id: i64 = c
            .query_row(
                "SELECT id FROM users WHERE display_name='Maria Santos'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let maria = Actor::load(&c, maria_id, clock.today(&c).unwrap()).unwrap();
        mutate(
            &mut c,
            &clock,
            &maria,
            Mode::Demo,
            "POST",
            &["org-units"],
            &json!({"code":"X","name":"X"}),
        )
        .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM audit_events WHERE entity='org-unit'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
