//! Authorized resource projections shared by HTTP and reports.
use crate::{
    authz::{self, Action, Actor, Resource, ViewLevel},
    model::{self, date_s, RequestStatus},
    queries, requests, DomainError, Res,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use time::Date;
pub fn rows(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Res<Vec<Value>> {
    let mut st = conn.prepare(sql)?;
    let names = st
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let iter = st.query_map(args, |r| {
        let mut obj = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let v = match r.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(i) => json!(i),
                rusqlite::types::ValueRef::Real(f) => json!(f),
                rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                rusqlite::types::ValueRef::Blob(_) => Value::Null,
            };
            obj.insert(name.clone(), v);
        }
        Ok(Value::Object(obj))
    })?;
    Ok(iter.collect::<rusqlite::Result<_>>()?)
}
pub fn ids(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Res<Vec<i64>> {
    let mut st = conn.prepare(sql)?;
    let result = st
        .query_map(args, |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(result)
}
pub fn user(conn: &Connection, id: Option<i64>) -> Res<Value> {
    match id {
        None => Ok(Value::Null),
        Some(id) => {
            let u = model::load_user(conn, id)?;
            Ok(json!({"id":id,"display_name":u.display_name}))
        }
    }
}
pub fn unit(conn: &Connection, id: Option<i64>) -> Res<Value> {
    match id {
        None => Ok(Value::Null),
        Some(id) => Ok(
            json!({"id":id,"name":conn.query_row("SELECT name FROM org_units WHERE id=?1",[id],|r|r.get::<_,String>(0))?}),
        ),
    }
}
pub fn employee(conn: &Connection, id: i64, today: Date) -> Res<Value> {
    let e = model::load_employee(conn, id)?;
    Ok(
        json!({"id":id,"service_id":e.service_id,"full_name":e.full_name,"org_unit":unit(conn,model::unit_of(conn,id,today)?)?}),
    )
}
pub fn me(conn: &Connection, actor: &Actor, session: &crate::sessions::Session) -> Res<Value> {
    let u = model::load_user(conn, actor.user_id)?;
    let roles=actor.roles.iter().map(|r|Ok(json!({"role":r.role,"scope_org_unit_id":r.scope_org_unit_id,"scope_name":if r.scope_org_unit_id.is_some(){unit(conn,r.scope_org_unit_id)?["name"].as_str().unwrap_or("").to_string()}else{"Whole service".into()}}))).collect::<Res<Vec<_>>>()?;
    let acting=actor.delegations_in.iter().map(|d|Ok(json!({"delegation_id":d.id,"from":user(conn,Some(d.from_user_id))?,"scope":d.scope,"valid_to":date_s(&d.valid_to)}))).collect::<Res<Vec<_>>>()?;
    Ok(
        json!({"user":{"id":u.id,"display_name":u.display_name,"email":u.email},"employee":actor.employee_id.map(|id|employee(conn,id,actor.today)).transpose()?,"roles":roles,"is_manager":!actor.manages.is_empty(),"acting_for":acting,"csrf_token":session.csrf_token,"totp_ok":session.totp_ok}),
    )
}
pub fn leave_type(conn: &Connection, id: i64, today: Date) -> Res<Value> {
    let t = model::load_leave_type(conn, id)?;
    let p = model::policy_for(conn, id, today)?;
    let mut policies = rows(
        conn,
        "SELECT * FROM policy_versions WHERE leave_type_id=?1 ORDER BY valid_from,id",
        &[&id],
    )?;
    for v in &mut policies {
        v["in_force"] = json!(p.as_ref().is_some_and(|p| Some(p.id) == v["id"].as_i64()));
        for key in [
            "paid",
            "uses_balance",
            "allow_half_day",
            "requires_attachment",
            "allow_negative",
            "carryover_allowed",
        ] {
            v[key] = json!(v[key].as_i64() == Some(1));
        }
    }
    let version: i64 =
        conn.query_row("SELECT version FROM leave_types WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
    Ok(
        json!({"id":id,"code":t.code,"name":t.name,"sensitive":t.sensitive,"paid":p.as_ref().is_some_and(|p|p.paid),"uses_balance":p.as_ref().is_some_and(|p|p.uses_balance),"allow_half_day":p.as_ref().is_some_and(|p|p.allow_half_day),"requires_attachment":p.as_ref().is_some_and(|p|p.requires_attachment),"min_notice_days":p.as_ref().map_or(0,|p|p.min_notice_days),"active":t.active,"version":version,"policy":queries::policy_ref(conn,id,today)?,"policies":policies}),
    )
}
pub fn summary(conn: &Connection, actor: &Actor, id: i64) -> Res<Value> {
    let req = model::load_request(conn, id)?;
    let ctx = requests::request_ctx(conn, &req, actor.today)?;
    let level = authz::view_level(conn, actor, &ctx)?;
    let rev = model::load_revision(
        conn,
        req.effective_revision_id
            .or(req.current_revision_id)
            .ok_or_else(|| DomainError::not_found("revision"))?,
    )?;
    let t = model::revision_leave_type(conn, rev.id)?;
    let pending = requests::pending_step(conn, id)?;
    let next = if req.status == RequestStatus::NeedsInformation {
        Some("Answer the question".to_string())
    } else if let Some(s) = pending {
        let who = if let Some(uid) = s.assignee_user_id {
            user(conn, Some(uid))?["display_name"]
                .as_str()
                .unwrap_or("")
                .to_string()
        } else {
            format!("any eligible {}", s.kind.as_str().replace('_', " "))
        };
        Some(format!(
            "Waiting for {} ({who})",
            s.kind.as_str().replace('_', " ")
        ))
    } else {
        None
    };
    Ok(
        json!({"id":id,"number":req.number,"kind":req.kind.as_str(),"status":req.status.as_str(),"status_label":status_label(req.status),"date_phase":requests::date_phase(&req,&rev,actor.today),"employee":employee(conn,req.employee_id,actor.today)?,"leave_type_name":if level==ViewLevel::Restricted {"Leave (details restricted)"}else{&t.name},"start_date":date_s(&rev.start_date),"end_date":date_s(&rev.end_date),"total_minutes":rev.total_minutes,"minutes_per_day":queries::minutes_per_day(conn,req.employee_id,actor.today)?,"next_action":next,"source":req.source,"updated_at":req.updated_at,"version":req.version}),
    )
}
fn status_label(s: RequestStatus) -> &'static str {
    match s {
        RequestStatus::Draft => "Draft",
        RequestStatus::Submitted => "Submitted",
        RequestStatus::UnderReview => "Under review",
        RequestStatus::NeedsInformation => "Needs information",
        RequestStatus::Approved => "Approved",
        RequestStatus::Rejected => "Rejected",
        RequestStatus::Withdrawn => "Withdrawn",
        RequestStatus::Cancelled => "Cancelled",
    }
}
pub fn step(conn: &Connection, s: &model::Step) -> Res<Value> {
    let rev = model::load_revision(conn, s.revision_id)?;
    let description = if s.assignee_user_id.is_some() {
        user(conn, s.assignee_user_id)?["display_name"]
            .as_str()
            .unwrap_or("")
            .to_string()
    } else {
        match s.kind {
            model::StepKind::ManagerRecommendation => "Unassigned manager".into(),
            model::StepKind::HrCheck => "Any HR officer in scope".into(),
            model::StepKind::FinalDecision => "Any final approver in scope".into(),
        }
    };
    Ok(
        json!({"id":s.id,"seq":s.seq,"kind":s.kind.as_str(),"revision_no":rev.rev_no,"status":s.status,"assignee":user(conn,s.assignee_user_id)?,"eligible_description":description,"problem":if s.kind==model::StepKind::ManagerRecommendation && s.assignee_user_id.is_none(){Some("No manager assigned")}else{None},"outcome":s.outcome,"completed_at":s.completed_at}),
    )
}
fn revision(conn: &Connection, id: i64, restricted: bool) -> Res<Value> {
    let r = model::load_revision(conn, id)?;
    let t = model::revision_leave_type(conn, r.id)?;
    let created: String = conn.query_row(
        "SELECT created_at FROM request_revisions WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    let mut days = Vec::new();
    for d in model::revision_days(conn, id)? {
        let alloc=rows(conn,"SELECT ra.account_id,la.period_year,ra.minutes FROM revision_allocations ra JOIN leave_accounts la ON la.id=ra.account_id WHERE ra.day_id=?1",&[&d.id])?.into_iter().map(|mut v|{v["carryover"]=json!(v["period_year"].as_i64()!=Some(d.period_year));v}).collect::<Vec<_>>();
        days.push(json!({"date":date_s(&d.date),"part":d.part.as_str(),"scheduled_minutes":d.scheduled_minutes,"minutes":d.minutes,"period_year":d.period_year,"explanation":d.explanation,"allocations":alloc}));
    }
    let provenance = rows(
        conn,
        "SELECT policy_version_id,policy_snapshot FROM request_revisions WHERE id=?1",
        &[&id],
    )?
    .pop()
    .ok_or_else(|| DomainError::not_found("revision"))?;
    let snapshot = provenance["policy_snapshot"]
        .as_str()
        .map(serde_json::from_str::<Value>)
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(
        json!({"request":{"id":r.request_id,"number":model::load_request(conn,r.request_id)?.number},"policy_version_id":if restricted {Value::Null}else{provenance["policy_version_id"].clone()},"policy_snapshot":if restricted {Value::Null}else{snapshot},"id":id,"rev_no":r.rev_no,"leave_type":if restricted{Value::Null}else{json!({"id":t.id,"code":t.code,"name":t.name,"sensitive":t.sensitive})},"start_date":date_s(&r.start_date),"end_date":date_s(&r.end_date),"start_part":r.start_part,"end_part":r.end_part,"note":if restricted{None}else{r.note},"change_reason":if restricted{None}else{r.change_reason},"total_minutes":r.total_minutes,"created_by":user(conn,Some(r.created_by))?,"created_at":created,"submitted_at":r.submitted_at,"days":days}),
    )
}
pub fn attachment(conn: &Connection, actor: &Actor, id: i64) -> Res<Value> {
    let ctx = requests::attachment_ctx(conn, id, actor.today)?;
    if ctx.sensitivity == "medical"
        && authz::can(
            conn,
            actor,
            Action::ViewAttachment,
            &Resource::Attachment(&ctx),
        )
        .is_err()
    {
        return Ok(json!({"id":id,"restricted":true}));
    }
    let mut v=rows(conn,"SELECT id,filename,content_type,size_bytes,sensitivity,scan_status,scan_note,uploaded_by,created_at FROM attachments WHERE id=?1",&[&id])?.pop().ok_or_else(||DomainError::not_found("attachment"))?;
    v["uploaded_by"] = user(conn, v["uploaded_by"].as_i64())?;
    v["can_download"] = json!(
        ctx.scan_status == "clean"
            && authz::can(
                conn,
                actor,
                Action::DownloadAttachment,
                &Resource::Attachment(&ctx)
            )
            .is_ok()
    );
    Ok(v)
}
pub fn audit_rows(
    conn: &Connection,
    actor: &Actor,
    entity: Option<&str>,
    entity_id: Option<i64>,
    actor_filter: Option<i64>,
) -> Res<Vec<Value>> {
    let all=rows(conn,"SELECT id,at,actor_user_id,acting_for_user_id,action,entity,entity_id,details_json FROM audit_events WHERE (?1 IS NULL OR entity=?1) AND (?2 IS NULL OR entity_id=?2) AND (?3 IS NULL OR actor_user_id=?3) ORDER BY id DESC",&[&entity,&entity_id,&actor_filter])?;
    let mut out = Vec::new();
    for mut v in all {
        let e = v["entity"].as_str().unwrap_or("");
        let id = v["entity_id"].as_i64();
        let mut restricted = actor.has_role("tech_admin");
        let request_id = if e == "request" || e == "leave_request" {
            id
        } else if e == "attachment" {
            id.and_then(|i| {
                conn.query_row("SELECT request_id FROM attachments WHERE id=?1", [i], |r| {
                    r.get(0)
                })
                .ok()
            })
        } else {
            None
        };
        if let Some(id) = request_id {
            let req = match model::load_request(conn, id) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let ctx = requests::request_ctx(conn, &req, actor.today)?;
            if (actor.has_role("hr") || actor.has_role("auditor"))
                && !actor.has_role("tech_admin")
                && !actor.any_role_in_scope(conn, &["hr", "auditor"], ctx.org_unit_id)?
            {
                continue;
            }
            if e == "attachment" {
                if let Some(attachment) = v["entity_id"].as_i64() {
                    let ctx = requests::attachment_ctx(conn, attachment, actor.today)?;
                    if authz::can(
                        conn,
                        actor,
                        Action::ViewAttachment,
                        &Resource::Attachment(&ctx),
                    )
                    .is_err()
                    {
                        restricted = true;
                    }
                }
            }
            match authz::view_level(conn, actor, &ctx) {
                Ok(ViewLevel::Restricted) => restricted = true,
                Ok(_) => {}
                Err(_) => {
                    if actor.has_role("tech_admin") {
                        restricted = true;
                    } else {
                        continue;
                    }
                }
            }
        } else {
            let employee = if e == "employee" {
                id
            } else if e == "adjustment" {
                id.and_then(|id|conn.query_row("SELECT la.employee_id FROM adjustments a JOIN leave_accounts la ON la.id=a.account_id WHERE a.id=?1",[id],|r|r.get(0)).ok())
            } else {
                None
            };
            if let Some(id) = employee {
                if !actor.has_role("tech_admin")
                    && !actor.any_role_in_scope(
                        conn,
                        &["hr", "auditor"],
                        model::unit_of(conn, id, actor.today)?,
                    )?
                {
                    continue;
                }
            } else if !actor.any_role_in_scope(conn, &["hr", "auditor", "tech_admin"], None)? {
                continue;
            }
        }
        v["actor"] = user(conn, v["actor_user_id"].as_i64())?;
        v["acting_for"] = user(conn, v["acting_for_user_id"].as_i64())?;
        v["details"] = if restricted {
            json!({"restricted":true})
        } else {
            serde_json::from_str(v["details_json"].as_str().unwrap_or("{}")).unwrap_or(json!({}))
        };
        v.as_object_mut().unwrap().remove("details_json");
        v.as_object_mut().unwrap().remove("actor_user_id");
        v.as_object_mut().unwrap().remove("acting_for_user_id");
        out.push(v);
    }
    Ok(out)
}
pub fn detail(conn: &Connection, actor: &Actor, id: i64) -> Res<Value> {
    let mut v = summary(conn, actor, id)?;
    let req = model::load_request(conn, id)?;
    let ctx = requests::request_ctx(conn, &req, actor.today)?;
    let restricted = authz::view_level(conn, actor, &ctx)? == ViewLevel::Restricted;
    let revision_restricted = |i: i64| -> Res<bool> {
        let mut revision_ctx = ctx.clone();
        revision_ctx.sensitive_type = model::revision_leave_type(conn, i)?.sensitive;
        Ok(restricted
            || !matches!(
                authz::view_level(conn, actor, &revision_ctx),
                Ok(ViewLevel::Full)
            ))
    };
    let render_revision = |i: i64| -> Res<Value> { revision(conn, i, revision_restricted(i)?) };

    let link = |id: Option<i64>| -> Res<Value> {
        match id {
            None => Ok(Value::Null),
            Some(i) => {
                let r = model::load_request(conn, i)?;
                let c = requests::request_ctx(conn, &r, actor.today)?;
                if authz::can(conn, actor, Action::ViewRequest, &Resource::Request(&c)).is_err() {
                    return Ok(Value::Null);
                }
                Ok(json!({"id":i,"number":r.number}))
            }
        }
    };
    v["parent"] = link(req.parent_request_id)?;
    v["previous_request"] = link(req.previous_request_id)?;
    v["children"] = json!(ids(
        conn,
        "SELECT id FROM leave_requests WHERE parent_request_id=?1",
        &[&id]
    )?
    .into_iter()
    .filter_map(|i| summary(conn, actor, i).ok())
    .map(|r| json!({"id":r["id"],"number":r["number"],"kind":r["kind"],"status":r["status"]}))
    .collect::<Vec<_>>());
    v["entered_by"] = user(conn, Some(req.entered_by_user_id))?;
    v["paper_received_date"] = json!(req.paper_received_date.map(|d| date_s(&d)));
    v["current_revision"] = render_revision(
        req.current_revision_id
            .ok_or_else(|| DomainError::not_found("revision"))?,
    )?;
    v["effective_revision"] = req
        .effective_revision_id
        .map(render_revision)
        .transpose()?
        .unwrap_or(Value::Null);
    v["in_force_revision"] = if req.kind == model::RequestKind::Leave {
        v["effective_revision"].clone()
    } else {
        Value::Null
    };
    v["parent_in_force_revision"] = if let Some(parent) = req.parent_request_id {
        let p = model::load_request(conn, parent)?;
        p.effective_revision_id
            .map(render_revision)
            .transpose()?
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    v["revisions"] = json!(ids(
        conn,
        "SELECT rr.id FROM request_revisions rr JOIN leave_requests lr ON lr.id=rr.request_id WHERE lr.id=?1 OR (lr.parent_request_id=?1 AND lr.status='approved') ORDER BY rr.id",
        &[&id]
    )?
    .into_iter()
    .map(render_revision)
    .collect::<Res<Vec<_>>>()?);
    let steps = model::steps_of(conn, id)?;
    v["steps"] = json!(steps
        .iter()
        .map(|s| step(conn, s))
        .collect::<Res<Vec<_>>>()?);
    let family=ids(conn,"SELECT id FROM leave_requests WHERE id=?1 OR (parent_request_id=?1 AND status='approved') ORDER BY id",&[&id])?;
    let decisions=family.into_iter().map(|i|model::decisions_of(conn,i)).collect::<Res<Vec<_>>>()?.into_iter().flatten().collect::<Vec<_>>().iter().map(|d|Ok(json!({"request":link(Some(model::load_revision(conn,d.revision_id)?.request_id))?,"revision_id":d.revision_id,"id":d.id,"step_id":d.step_id,"step_kind":model::load_step(conn,d.step_id)?.kind.as_str(),"revision_no":model::load_revision(conn,d.revision_id)?.rev_no,"actor":user(conn,Some(d.actor_user_id))?,"acting_for":user(conn,d.acting_for_user_id)?,"authority":d.authority,"outcome":d.outcome,"reason":if revision_restricted(d.revision_id)?{None}else{d.reason.clone()},"basis_document":if revision_restricted(d.revision_id)?{None}else{d.basis_document.clone()},"created_at":d.created_at}))).collect::<Res<Vec<_>>>()?;
    v["decisions"] = json!(decisions);
    let messages = if restricted {
        vec![]
    } else {
        rows(conn,"SELECT id,kind,author_user_id,body,created_at FROM messages WHERE request_id=?1 ORDER BY id",&[&id])?.into_iter().map(|mut m|{m["author"]=user(conn,m["author_user_id"].as_i64())?;m.as_object_mut().unwrap().remove("author_user_id");Ok(m)}).collect::<Res<Vec<Value>>>()?
    };
    v["messages"] = json!(messages);
    v["attachments"] = json!(ids(
        conn,
        "SELECT id FROM attachments WHERE request_id=?1",
        &[&id]
    )?
    .into_iter()
    .map(|i| attachment(conn, actor, i))
    .collect::<Res<Vec<_>>>()?);
    let state_revision = req
        .effective_revision_id
        .or(req.current_revision_id)
        .unwrap();
    let t = model::load_revision(conn, state_revision)?.leave_type_id;
    v["reservations"] = serde_json::to_value(
        queries::reservations_of(conn, req.employee_id, t)?
            .into_iter()
            .filter(|r| r.request_number == req.number)
            .collect::<Vec<_>>(),
    )?;
    v["ledger_entries"] = json!(ledger_entries(conn, req.employee_id, t, actor.today)?
        .into_iter()
        .filter(|r| r["request_number"] == json!(req.number))
        .collect::<Vec<_>>());
    if restricted {
        v["reservations"] = json!([]);
        v["ledger_entries"] = json!([]);
    }
    v["actual"] = if let Some(uid) = req.actual_confirmed_by {
        json!({"confirmed_by":user(conn,Some(uid))?,"confirmed_at":req.actual_confirmed_at,"note":if restricted{None}else{req.actual_note.clone()}})
    } else {
        Value::Null
    };
    v["actual_corrections"] = if restricted {
        json!([])
    } else {
        json!(rows(conn, "SELECT c.date,c.account_id, SUM(CASE a.status WHEN 'applied' THEN c.minutes ELSE 0 END) AS applied_minutes, SUM(CASE a.status WHEN 'proposed' THEN c.minutes ELSE 0 END) AS pending_minutes FROM actual_correction_allocations c JOIN adjustments a ON a.id=c.adjustment_id WHERE c.request_id=?1 AND a.status IN ('applied','proposed') GROUP BY c.date,c.account_id", &[&id])?)
    };
    let current_revision = req.current_revision_id.unwrap();
    v["supporting_document_required"] = json!(
        req.kind != model::RequestKind::Cancellation
            && model::revision_leave_type(conn, current_revision)?.requires_attachment
    );
    v["supporting_document_ready"] = json!(requests::has_supporting_document(conn, id, true)?);
    let mut actions = Vec::new();
    let open = req.status.is_open();
    let draft = req.status == RequestStatus::Draft;
    let approved = req.status == RequestStatus::Approved && req.kind == model::RequestKind::Leave;
    for (name, action, valid) in [
        ("edit", Action::EditDraft, draft),
        ("delete", Action::DeleteDraft, draft),
        ("submit", Action::Submit, draft),
        ("withdraw", Action::Withdraw, open),
        (
            "respond",
            Action::Respond,
            req.status == RequestStatus::NeedsInformation,
        ),
        ("revise", Action::Revise, open),
        ("amend", Action::Amend, approved),
        ("cancel", Action::CancelRequest, approved),
        ("comment", Action::Comment, true),
        ("upload", Action::UploadAttachment, true),
        ("reassign", Action::ReassignStep, open),
        (
            "confirm_actual",
            Action::ConfirmActual,
            approved && v["date_phase"] == "period_ended",
        ),
        (
            "propose_actual_adjustment",
            Action::ConfirmActual,
            approved && v["date_phase"] == "period_ended",
        ),
    ] {
        if valid && authz::can(conn, actor, action, &Resource::Request(&ctx)).is_ok() {
            actions.push(name);
        }
    }
    if model::open_child(conn, id)?.is_some() {
        actions.retain(|s| *s != "amend" && *s != "cancel");
    }
    let decidable = steps.iter().find(|s| {
        s.status == "pending"
            && req.status != RequestStatus::NeedsInformation
            && authz::decide_authority(conn, actor, &ctx, s).is_ok()
    });
    v["decidable_step"] = if let Some(s) = decidable {
        actions.push("decide");
        json!({"id":s.id,"kind":s.kind.as_str(),"outcomes":s.kind.valid_outcomes(),"acting_for":user(conn,authz::decide_authority(conn,actor,&ctx,s)?.acting_for_user_id)?})
    } else {
        Value::Null
    };
    actions.push("print");
    v["allowed_actions"] = json!(actions);
    let mut warnings = Vec::new();
    for s in &steps {
        if s.kind == model::StepKind::ManagerRecommendation
            && s.assignee_user_id.is_none()
            && (s.status == "pending" || s.status == "waiting")
        {
            warnings.push(json!({"code":"unassigned_step","message":"No manager assigned"}));
        }
    }
    if queries::schedule_drift(conn, actor.today)?
        .iter()
        .any(|d| d.request_id == id)
    {
        warnings.push(
            json!({"code":"schedule_drift","message":"The schedule changed after submission"}),
        );
    }
    if let Some(w) = requests::team_overlap(
        conn,
        req.employee_id,
        model::load_revision(conn, state_revision)?.start_date,
        model::load_revision(conn, state_revision)?.end_date,
        actor.today,
    )? {
        warnings.push(serde_json::to_value(w)?);
    }
    let state = model::load_revision(conn, state_revision)?;
    let saved: Option<i64> = conn.query_row(
        "SELECT policy_version_id FROM request_revisions WHERE id=?1",
        [state_revision],
        |r| r.get(0),
    )?;
    if state.end_date >= actor.today
        && state.submitted_at.is_some()
        && model::policy_for(conn, state.leave_type_id, actor.today)?.map(|p| p.id) != saved
    {
        warnings.push(json!({"code":"policy_changed","message":"The policy changed after submission; the saved conditions remain in force until an explicit revision."}));
    }
    v["warnings"] = json!(warnings);
    v["audit"] = json!(audit_rows(conn, actor, Some("request"), Some(id), None)?);
    Ok(v)
}
pub fn ledger_entries(conn: &Connection, employee: i64, lt: i64, on: Date) -> Res<Vec<Value>> {
    queries::ledger_history(conn, employee, lt, on)?
        .into_iter()
        .map(|r| {
            let mut v = serde_json::to_value(&r)?;
            v["author"] = user(conn, r.author_id)?;
            v.as_object_mut().unwrap().remove("author_id");
            v.as_object_mut().unwrap().remove("author_name");
            Ok(v)
        })
        .collect()
}
pub fn can_balance(conn: &Connection, actor: &Actor, id: i64) -> Res<()> {
    authz::require(
        conn,
        actor,
        Action::ViewBalances,
        &Resource::Employee {
            employee_id: id,
            org_unit_id: model::unit_of(conn, id, actor.today)?,
        },
    )
}
pub fn preview(
    conn: &mut Connection,
    clock: &crate::clock::Clock,
    a: &Actor,
    input: &requests::DraftInput,
    amend: Option<i64>,
    cancel: Option<i64>,
) -> Res<Value> {
    let mut input = input.clone();
    if let Some(id) = amend.or(cancel) {
        let req = model::load_request(conn, id)?;
        let ctx = requests::request_ctx(conn, &req, a.today)?;
        authz::require(
            conn,
            a,
            if cancel.is_some() {
                Action::CancelRequest
            } else {
                Action::Amend
            },
            &Resource::Request(&ctx),
        )?;
        if input
            .employee_id
            .is_some_and(|employee| employee != req.employee_id)
        {
            return Err(DomainError::validation(
                "employee does not match parent request",
            ));
        }
        input.employee_id = Some(req.employee_id);
    }
    let employee = input
        .employee_id
        .or(a.employee_id)
        .ok_or_else(|| DomainError::forbidden("employee required"))?;
    if a.employee_id != Some(employee) {
        authz::require(
            conn,
            a,
            Action::CreatePaper,
            &Resource::Employee {
                employee_id: employee,
                org_unit_id: model::unit_of(conn, employee, a.today)?,
            },
        )?;
    } else {
        authz::require(conn, a, Action::CreateDraft, &Resource::Global)?;
    }
    let result = requests::preview(
        conn,
        clock,
        a,
        &input,
        amend,
        cancel.map(|id| (id, input.start_date, input.end_date)),
    )?;
    let employee = input
        .employee_id
        .or(a.employee_id)
        .ok_or_else(|| DomainError::forbidden("employee required"))?;
    let days=result.days.iter().map(|d|json!({"date":date_s(&d.date),"part":d.part,"scheduled_minutes":d.scheduled_minutes,"minutes":d.minutes,"period_year":d.period_year,"explanation":d.explanation,"allocations":result.allocations.iter().filter(|r|r.date==date_s(&d.date)).collect::<Vec<_>>()})).collect::<Vec<_>>();
    let route=result.route.iter().map(|r|json!({"kind":r.kind,"who":r.who.as_deref().unwrap_or("Unassigned"),"problem":r.problem})).collect::<Vec<_>>();
    Ok(
        json!({"days":days,"total_minutes":result.total_minutes,"minutes_per_day":queries::minutes_per_day(conn,employee,a.today)?,"balance_after":result.balance_after,"route":route,"warnings":result.warnings,"errors":result.errors,"policy":queries::policy_ref(conn,input.leave_type_id,a.today)?}),
    )
}
/// Replays keep the saved response, subject to current permissions and medical redaction.
pub fn redact_cached(conn: &Connection, actor: &Actor, value: &mut Value) -> Res<()> {
    let id = value["id"]
        .as_i64()
        .ok_or_else(|| DomainError::validation("invalid cached request"))?;
    let req = model::load_request(conn, id)?;
    let ctx = requests::request_ctx(conn, &req, actor.today)?;
    let current_restricted = authz::view_level(conn, actor, &ctx)? == ViewLevel::Restricted;
    let revision_restricted = |revision: i64| -> Res<bool> {
        let mut saved_ctx = ctx.clone();
        saved_ctx.sensitive_type = model::revision_leave_type(conn, revision)?.sensitive;
        Ok(!matches!(
            authz::view_level(conn, actor, &saved_ctx),
            Ok(ViewLevel::Full)
        ))
    };
    let saved_state = value["in_force_revision"]["id"]
        .as_i64()
        .or(value["effective_revision"]["id"].as_i64())
        .or(value["current_revision"]["id"].as_i64());
    let saved_restricted = saved_state
        .map(revision_restricted)
        .transpose()?
        .unwrap_or(false);
    if current_restricted || saved_restricted {
        value["leave_type_name"] = json!("Leave (details restricted)");
        for key in [
            "current_revision",
            "effective_revision",
            "in_force_revision",
            "parent_in_force_revision",
        ] {
            if value[key].is_object() {
                for field in [
                    "leave_type",
                    "note",
                    "change_reason",
                    "policy_version_id",
                    "policy_snapshot",
                ] {
                    value[key][field] = Value::Null;
                }
            }
        }
        if let Some(revisions) = value["revisions"].as_array_mut() {
            for revision in revisions {
                for field in [
                    "leave_type",
                    "note",
                    "change_reason",
                    "policy_version_id",
                    "policy_snapshot",
                ] {
                    revision[field] = Value::Null;
                }
            }
        }
        if let Some(decisions) = value["decisions"].as_array_mut() {
            for decision in decisions {
                decision["reason"] = Value::Null;
                decision["basis_document"] = Value::Null;
            }
        }
        for key in ["messages", "reservations", "ledger_entries"] {
            value[key] = json!([]);
        }
        if value["actual"].is_object() {
            value["actual"]["note"] = Value::Null;
        }
        if let Some(events) = value["audit"].as_array_mut() {
            for event in events {
                event["details"] = json!({"restricted":true});
            }
        }
    }
    // A receipt may contain previously visible history even when its header is
    // currently non-sensitive. Re-check each saved revision independently.
    for key in [
        "current_revision",
        "effective_revision",
        "in_force_revision",
        "parent_in_force_revision",
    ] {
        if value[key]["id"]
            .as_i64()
            .map(revision_restricted)
            .transpose()?
            .unwrap_or(false)
        {
            for field in [
                "leave_type",
                "note",
                "change_reason",
                "policy_version_id",
                "policy_snapshot",
            ] {
                value[key][field] = Value::Null;
            }
        }
    }
    if let Some(revisions) = value["revisions"].as_array_mut() {
        for revision in revisions {
            if revision["id"]
                .as_i64()
                .map(revision_restricted)
                .transpose()?
                .unwrap_or(false)
            {
                for field in [
                    "leave_type",
                    "note",
                    "change_reason",
                    "policy_version_id",
                    "policy_snapshot",
                ] {
                    revision[field] = Value::Null;
                }
            }
        }
    }
    if let Some(decisions) = value["decisions"].as_array_mut() {
        for decision in decisions {
            let revision = decision["revision_id"].as_i64().or(decision["step_id"]
                .as_i64()
                .map(|id| model::load_step(conn, id).map(|s| s.revision_id))
                .transpose()?);
            if revision
                .map(revision_restricted)
                .transpose()?
                .unwrap_or(false)
            {
                decision["reason"] = Value::Null;
                decision["basis_document"] = Value::Null;
            }
        }
    }
    if let Some(attachments) = value["attachments"].as_array_mut() {
        for attachment in attachments {
            if let Some(id) = attachment["id"].as_i64() {
                let ctx = requests::attachment_ctx(conn, id, actor.today)?;
                if ctx.sensitivity == "medical"
                    && authz::can(
                        conn,
                        actor,
                        Action::ViewAttachment,
                        &Resource::Attachment(&ctx),
                    )
                    .is_err()
                {
                    *attachment = json!({"id":id,"restricted":true});
                }
            }
        }
    }
    Ok(())
}
