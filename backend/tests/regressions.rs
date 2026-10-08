mod common;
use common::{d, W};
use nauru_leave::{
    authz::{self, Action, Resource, ViewLevel},
    ledger,
    model::{self, Part, RequestStatus},
    people, requests,
};

fn respond(w: &mut W, id: i64, change: Option<requests::ReviseInput>) -> nauru_leave::Res<()> {
    let a = w.actor(w.u_alexei);
    let c = w.clock();
    let v = w.req(id).version;
    requests::respond(&mut w.conn, &c, &a, id, v, "answer", change)
}
fn amendment(w: &mut W, id: i64, end: &str) -> i64 {
    let a = w.actor(w.u_alexei);
    let c = w.clock();
    let v = w.req(id).version;
    let input = w.revise(w.annual, "2026-11-02", end, "change");
    requests::amend(&mut w.conn, &c, &a, id, &input, v, None)
        .unwrap()
        .request_id
}
#[test]
fn revise_tight_balance() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-27");
    w.decide_pending(w.u_olga, id, "needs_information", Some("shorten"));
    let ch = w.revise(w.annual, "2026-11-02", "2026-11-26", "shorter");
    respond(&mut w, id, Some(ch)).unwrap();
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 9120, 480));
    let before = w.req(id);
    let reservations = w.reservations(id);
    let ch = w.revise(w.annual, "2026-11-02", "2026-11-30", "too much");
    assert_eq!(
        respond(&mut w, id, Some(ch)).unwrap_err().code(),
        "insufficient_balance"
    );
    assert_eq!(w.req(id).version, before.version);
    assert_eq!(w.req(id).current_revision_id, before.current_revision_id);
    assert_eq!(w.reservations(id), reservations);
}
#[test]
fn amendment_revision_excludes_parent_and_own_delta() {
    let mut w = W::new();
    let parent = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    w.approve_all(parent);
    let id = amendment(&mut w, parent, "2026-11-27");
    assert_eq!(w.totals(w.alexei, w.annual), (8640, 8640, 0));
    w.decide_pending(w.u_olga, id, "needs_information", Some("shorten"));
    let ch = w.revise(w.annual, "2026-11-02", "2026-11-26", "shorter");
    respond(&mut w, id, Some(ch)).unwrap();
    assert_eq!(w.totals(w.alexei, w.annual), (8640, 8160, 480));
}
#[test]
fn delete_draft_breaks_revision_cycle() {
    let mut w = W::new();
    let a = w.actor(w.u_alexei);
    let c = w.clock();
    let input = w.input(w.annual, "2026-11-02", "2026-11-03");
    let id = requests::create_draft(&mut w.conn, &c, &a, &input).unwrap();
    let store = w.store();
    requests::upload_attachment(
        &mut w.conn,
        &c,
        &a,
        &store,
        id,
        "draft.pdf",
        b"%PDF-1.4 draft",
        "normal",
    )
    .unwrap();
    let keys = requests::delete_draft(&mut w.conn, &c, &a, id, 1).unwrap();
    assert!(store.path(&keys[0]).exists());
    requests::finish_draft_deletion(&w.conn, &store, &keys).unwrap();
    assert!(!store.path(&keys[0]).exists());
    assert!(model::load_request(&w.conn, id).is_err());
    let id = requests::create_draft(&mut w.conn, &c, &a, &input).unwrap();
    requests::upload_attachment(
        &mut w.conn,
        &c,
        &a,
        &store,
        id,
        "retained.pdf",
        b"%PDF-1.4 retained",
        "normal",
    )
    .unwrap();
    let result: nauru_leave::Res<()> = nauru_leave::db::atomic(&mut w.conn, |conn| {
        let keys = requests::delete_draft(conn, &c, &a, id, 1)?;
        assert!(requests::finish_draft_deletion(conn, &store, &keys).is_err());
        Err(nauru_leave::DomainError::validation("rollback"))
    });
    assert!(result.is_err());
    assert!(model::load_request(&w.conn, id).is_ok());
}
#[test]
fn reassign_cannot_escalate_hr() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    let step: i64 = w
        .conn
        .query_row(
            "SELECT id FROM approval_steps WHERE request_id=?1 AND kind='final_decision'",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let a = w.actor(w.u_maria);
    let c = w.clock();
    let v = w.req(id).version;
    assert!(requests::reassign(&mut w.conn, &c, &a, id, step, Some(w.u_maria), v).is_err());
    assert!(requests::reassign(&mut w.conn, &c, &a, id, step, Some(w.u_alexei), v).is_err());
    requests::reassign(&mut w.conn, &c, &a, id, step, Some(w.u_scoped_final), v).unwrap();
    w.decide_pending(w.u_olga, id, "recommend_approve", None);
    w.decide_pending(w.u_maria, id, "checked_ok", None);
    let stale = w.actor(w.u_scoped_final);
    w.conn
        .execute(
            "DELETE FROM role_grants WHERE user_id=?1",
            [w.u_scoped_final],
        )
        .unwrap();
    let v = w.req(id).version;
    assert!(requests::decide(
        &mut w.conn,
        &c,
        &stale,
        id,
        step,
        "approve",
        None,
        None,
        v,
        None
    )
    .is_err());
}
#[test]
fn preview_authorizes_employee_and_parent() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_tom, w.annual, "2026-11-02", "2026-11-03");
    w.approve_all(id);
    let a = w.actor(w.u_alexei);
    let c = w.clock();
    let mut input = w.input(w.annual, "2026-12-01", "2026-12-02");
    input.employee_id = Some(w.tom);
    assert!(requests::preview(&mut w.conn, &c, &a, &input, None, None).is_err());
    input.employee_id = None;
    assert!(requests::preview(&mut w.conn, &c, &a, &input, Some(id), None).is_err());
    let hr = w.actor(w.u_scoped_hr);
    input.employee_id = Some(w.tom);
    assert!(
        requests::preview(&mut w.conn, &c, &hr, &input, Some(id), None)
            .unwrap()
            .errors
            .is_empty()
    );
    input.employee_id = Some(w.nia);
    assert!(requests::preview(&mut w.conn, &c, &hr, &input, None, None).is_err());
}
#[test]
fn scoped_hr_cannot_run_global_jobs() {
    let mut w = W::new();
    let a = w.actor(w.u_scoped_hr);
    let c = w.clock();
    assert!(ledger::run_accrual(&mut w.conn, &c, &a, w.annual, 2027, None).is_err());
    assert!(ledger::close_period(&mut w.conn, &c, &a, w.carry, 2025).is_err());
}
#[test]
fn effective_revision_controls_masking() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    w.approve_all(id);
    let a = w.actor(w.u_alexei);
    let c = w.clock();
    let input = w.revise(w.sick, "2026-11-02", "2026-11-03", "illness");
    let v = w.req(id).version;
    let ch = requests::amend(&mut w.conn, &c, &a, id, &input, v, None).unwrap();
    w.approve_all(ch.request_id);
    let ctx = requests::request_ctx(&w.conn, &w.req(id), w.today).unwrap();
    assert_eq!(
        authz::view_level(&w.conn, &w.actor(w.u_olga), &ctx).unwrap(),
        ViewLevel::Restricted
    );
    let input = w.revise(w.annual, "2026-11-02", "2026-11-03", "reclassify");
    let v = w.req(id).version;
    let ch = requests::amend(&mut w.conn, &c, &a, id, &input, v, None).unwrap();
    w.approve_all(ch.request_id);
    let ctx = requests::request_ctx(&w.conn, &w.req(id), w.today).unwrap();
    assert_eq!(
        authz::view_level(&w.conn, &w.actor(w.u_olga), &ctx).unwrap(),
        ViewLevel::Full
    );
}
#[test]
fn close_period_preserves_reserved_and_later_consumed_minutes() {
    for approve_first in [false, true] {
        let mut w = W::new();
        w.set_today("2026-03-20");
        ledger::post_opening(
            &w.conn,
            w.alexei,
            w.carry,
            2025,
            960,
            d("2025-01-01"),
            "opening",
            Some(w.u_maria),
            "2025-01-01T00:00:00Z",
        )
        .unwrap();
        let id = w.submit_leave(w.u_alexei, w.carry, "2026-03-30", "2026-03-30");
        w.set_today("2026-04-05");
        if approve_first {
            w.approve_all(id);
        }
        let a = w.actor(w.u_maria);
        let c = w.clock();
        ledger::close_period(&mut w.conn, &c, &a, w.carry, 2025).unwrap();
        if !approve_first {
            w.approve_all(id);
        }
        assert_eq!(w.totals(w.alexei, w.carry), (0, 0, 0));
    }
}
#[test]
fn past_amendment_requires_hr_correction() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-06");
    w.approve_all(id);
    w.set_today("2026-11-20");
    let a = w.actor(w.u_alexei);
    let c = w.clock();
    let v = w.req(id).version;
    let ch = w.revise(w.annual, "2026-11-02", "2026-11-04", "shorten");
    assert_eq!(
        requests::amend(&mut w.conn, &c, &a, id, &ch, v, None)
            .unwrap_err()
            .code(),
        "past_dates_need_hr_correction"
    );
}
fn cancellation(w: &mut W) -> i64 {
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    w.approve_all(id);
    let a = w.actor(w.u_alexei);
    let c = w.clock();
    let v = w.req(id).version;
    requests::cancel(
        &mut w.conn,
        &c,
        &a,
        id,
        d("2026-11-02"),
        d("2026-11-03"),
        "cancel",
        v,
        None,
    )
    .unwrap()
    .request_id
}
#[test]
fn cancellation_approval_rechecks_past_days() {
    let mut w = W::new();
    let id = cancellation(&mut w);
    w.decide_pending(w.u_olga, id, "recommend_approve", None);
    w.decide_pending(w.u_maria, id, "checked_ok", None);
    w.set_today("2026-11-04");
    let a = w.actor(w.u_elena);
    let c = w.clock();
    let v = w.req(id).version;
    let step = w.pending(id);
    assert_eq!(
        requests::decide(
            &mut w.conn,
            &c,
            &a,
            id,
            step.id,
            "approve",
            None,
            None,
            v,
            None
        )
        .unwrap_err()
        .code(),
        "past_dates_need_hr_correction"
    );
    assert_eq!(w.totals(w.alexei, w.annual), (8640, 0, 8640));
}
#[test]
fn cancellation_response_is_text_only() {
    let mut w = W::new();
    let id = cancellation(&mut w);
    w.decide_pending(w.u_olga, id, "needs_information", Some("confirm"));
    let ch = w.revise(w.annual, "2026-12-01", "2026-12-02", "move");
    assert!(respond(&mut w, id, Some(ch)).is_err());
    respond(&mut w, id, None).unwrap();
}
#[test]
fn auditor_cannot_comment() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    let a = w.actor(w.u_grace);
    let c = w.clock();
    assert!(requests::comment(&mut w.conn, &c, &a, id, "comment").is_err());
}
#[test]
fn medical_uploader_needs_medical_role() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.sick, "2026-11-02", "2026-11-03");
    let a = w.actor(w.u_scoped_hr);
    let c = w.clock();
    let store = w.store();
    let file = requests::upload_attachment(
        &mut w.conn,
        &c,
        &a,
        &store,
        id,
        "scan.pdf",
        b"%PDF-1.4 scan",
        "medical",
    )
    .unwrap();
    let ctx = requests::attachment_ctx(&w.conn, file, w.today).unwrap();
    for action in [Action::DownloadAttachment, Action::ViewAttachment] {
        assert!(authz::can(&w.conn, &a, action, &Resource::Attachment(&ctx)).is_err());
    }
}
#[test]
fn amend_and_revise_validate_type_range_and_attachment() {
    for mode in ["inactive", "parts", "attachment"] {
        for revise in [false, true] {
            let mut w = W::new();
            let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
            if revise {
                w.decide_pending(w.u_olga, id, "needs_information", Some("change"));
            } else {
                w.approve_all(id);
            }
            let mut ch = w.revise(w.sick, "2026-11-02", "2026-11-02", "change");
            match mode {
                "inactive" => {
                    w.conn
                        .execute("UPDATE leave_types SET active=0 WHERE id=?1", [w.sick])
                        .unwrap();
                }
                "parts" => ch.end_part = Part::Am,
                _ => {
                    w.conn
                        .execute(
                            "UPDATE leave_types SET requires_attachment=1 WHERE id=?1",
                            [w.sick],
                        )
                        .unwrap();
                }
            }
            let result = if revise {
                respond(&mut w, id, Some(ch))
            } else {
                let a = w.actor(w.u_alexei);
                let c = w.clock();
                let v = w.req(id).version;
                requests::amend(&mut w.conn, &c, &a, id, &ch, v, None).map(|_| ())
            };
            assert_eq!(
                result.unwrap_err().code(),
                "validation",
                "{mode} revise={revise}"
            );
        }
    }
}
#[test]
fn stale_actor_cannot_use_revoked_grant_or_delegation() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    let a = w.actor(w.u_maria);
    let c = w.clock();
    let dg = people::create_delegation(
        &mut w.conn,
        &c,
        &a,
        w.u_olga,
        w.u_tom,
        "manager_recommendation",
        d("2026-01-01"),
        d("2026-12-31"),
        "cover",
    )
    .unwrap();
    let stale = w.actor(w.u_tom);
    people::revoke_delegation(&mut w.conn, &c, &a, dg).unwrap();
    let step = w.pending(id);
    let v = w.req(id).version;
    assert!(requests::decide(
        &mut w.conn,
        &c,
        &stale,
        id,
        step.id,
        "recommend_approve",
        None,
        None,
        v,
        None
    )
    .is_err());
    w.decide_pending(w.u_olga, id, "recommend_approve", None);
    let stale = w.actor(w.u_scoped_hr);
    w.conn
        .execute("DELETE FROM role_grants WHERE user_id=?1", [w.u_scoped_hr])
        .unwrap();
    let step = w.pending(id);
    let v = w.req(id).version;
    assert!(requests::decide(
        &mut w.conn,
        &c,
        &stale,
        id,
        step.id,
        "checked_ok",
        None,
        None,
        v,
        None
    )
    .is_err());
    assert!(requests::reassign(&mut w.conn, &c, &stale, id, step.id, Some(w.u_maria), v).is_err());
}
#[test]
fn final_rejects_while_needs_information() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    w.decide_pending(w.u_olga, id, "recommend_approve", None);
    w.decide_pending(w.u_maria, id, "checked_ok", None);
    w.decide_pending(w.u_elena, id, "needs_information", Some("confirm"));
    w.decide_pending(w.u_elena, id, "reject", Some("not eligible"));
    assert_eq!(w.req(id).status, RequestStatus::Rejected);
    assert!(w.reservations(id).is_empty());
}
#[test]
fn transfer_requires_target_scope_and_defers_future_reassign() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-02", "2026-11-03");
    let c = w.clock();
    let a = w.actor(w.u_scoped_hr);
    assert!(people::transfer(
        &mut w.conn,
        &c,
        &a,
        w.alexei,
        w.csu,
        Some(w.rita),
        d("2026-11-01"),
        true
    )
    .is_err());
    let a = w.actor(w.u_maria);
    people::transfer(
        &mut w.conn,
        &c,
        &a,
        w.alexei,
        w.csu,
        Some(w.rita),
        d("2026-11-01"),
        true,
    )
    .unwrap();
    assert_eq!(w.pending(id).assignee_user_id, Some(w.u_olga));
}
#[test]
fn scoped_staff_and_colleague_cannot_access_other_unit_files() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_nia, w.annual, "2026-11-02", "2026-11-03");
    let a = w.actor(w.u_nia);
    let c = w.clock();
    let store = w.store();
    let file = requests::upload_attachment(
        &mut w.conn,
        &c,
        &a,
        &store,
        id,
        "file.pdf",
        b"%PDF-1.4 private",
        "normal",
    )
    .unwrap();
    let ctx = requests::request_ctx(&w.conn, &w.req(id), w.today).unwrap();
    let f = requests::attachment_ctx(&w.conn, file, w.today).unwrap();
    let own_unit = w.submit_leave(w.u_alexei, w.annual, "2026-12-01", "2026-12-02");
    let own_ctx = requests::request_ctx(&w.conn, &w.req(own_unit), w.today).unwrap();
    for uid in [w.u_scoped_hr, w.u_scoped_final, w.u_scoped_auditor] {
        assert!(authz::view_level(&w.conn, &w.actor(uid), &own_ctx).is_ok());
    }
    for uid in [w.u_scoped_hr, w.u_scoped_final, w.u_scoped_auditor, w.u_tom] {
        let a = w.actor(uid);
        assert!(authz::view_level(&w.conn, &a, &ctx).is_err());
        assert!(authz::can(
            &w.conn,
            &a,
            Action::DownloadAttachment,
            &Resource::Attachment(&f)
        )
        .is_err());
    }
}
