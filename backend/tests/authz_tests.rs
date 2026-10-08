//! ACCEPTANCE C1/C2/C6–C9 — authorization: self-approval ban, delegation
//! windows, transfer, medical files, tech_admin limits, two-person rule.

mod common;

use common::W;
use nauru_leave::authz::{self, Action, Resource};
use nauru_leave::error::DomainError;
use nauru_leave::model;
use nauru_leave::people;
use nauru_leave::requests;

const PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Pages 2 0 R>>endobj\n2 0 obj<</Kids[]>>endobj\n%%EOF\n";

/// C1 — nobody may decide their own request, whatever roles they hold, and
/// the same applies to a decision taken through a delegation.
#[test]
fn no_self_approval() {
    let mut w = W::new();
    // Tom also holds final_approver -> he still cannot approve his own request
    people::grant_role(
        &w.conn, w.u_tom, "final_approver", None,
        common::d("2025-01-01"), None, None, "2025-01-01T00:00:00Z",
    )
    .unwrap();
    let req = w.submit_leave(w.u_tom, w.annual, "2026-11-09", "2026-11-10");
    w.decide_pending(w.u_olga, req, "recommend_approve", None);
    w.decide_pending(w.u_maria, req, "checked_ok", None);
    let step = w.pending(req);
    let v = w.req(req).version;
    let clock = w.clock();
    let tom = w.actor(w.u_tom);
    let err = requests::decide(
        &mut w.conn, &clock, &tom, req, step.id, "approve", None, None, v, None,
    )
    .unwrap_err();
    assert!(matches!(err, DomainError::SelfApprovalForbidden));

    // via delegation: Elena (employee of her own request) delegates
    // final_decision to David; David acting for Elena is still banned.
    let ereq = w.submit_leave(w.u_elena, w.annual, "2026-11-09", "2026-11-10");
    // step1 is unassigned (Elena has no manager): HR reassigns it to Maria
    let step1 = w.pending(ereq);
    let maria = w.actor(w.u_maria);
    let ev = w.req(ereq).version;
    requests::reassign(&mut w.conn, &clock, &maria, ereq, step1.id, Some(w.u_maria), ev).unwrap();
    w.decide_pending(w.u_maria, ereq, "recommend_approve", None);
    w.decide_pending(w.u_maria, ereq, "checked_ok", None);

    let elena = w.actor(w.u_elena);
    people::create_delegation(
        &mut w.conn, &clock, &elena, w.u_elena, w.u_david,
        "final_decision", w.today, common::d("2026-10-20"), "coverage",
    )
    .unwrap();
    let step3 = w.pending(ereq);
    let v = w.req(ereq).version;
    let david = w.actor(w.u_david);
    let err = requests::decide(
        &mut w.conn, &clock, &david, ereq, step3.id, "approve", None, None, v, None,
    )
    .unwrap_err();
    assert!(matches!(err, DomainError::SelfApprovalForbidden));
}

/// C2 — delegations work only inside their date window; the decision records
/// the real actor and `acting_for`.
#[test]
fn delegation_window() {
    let mut w = W::new();
    let clock = w.clock();

    // expired delegation Rita -> Ben (September): Ben cannot act in October
    let rita = w.actor(w.u_rita);
    people::create_delegation(
        &mut w.conn, &clock, &rita, w.u_rita, w.u_ben,
        "manager_recommendation", common::d("2026-09-01"), common::d("2026-09-15"),
        "September coverage",
    )
    .unwrap();
    let nreq = w.submit_leave(w.u_nia, w.annual, "2026-11-09", "2026-11-10");
    let step = w.pending(nreq);
    let v = w.req(nreq).version;
    let ben = w.actor(w.u_ben);
    let err = requests::decide(
        &mut w.conn, &clock, &ben, nreq, step.id, "recommend_approve",
        None, None, v, None,
    )
    .unwrap_err();
    assert_eq!(err.code(), "forbidden");

    // active delegation Olga -> Tom covering today: Tom decides, the decision
    // names Tom as actor and Olga as acting_for.
    let olga = w.actor(w.u_olga);
    people::create_delegation(
        &mut w.conn, &clock, &olga, w.u_olga, w.u_tom,
        "manager_recommendation", common::d("2026-10-07"), common::d("2026-10-15"),
        "acting manager",
    )
    .unwrap();
    let areq = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    let step = w.pending(areq);
    let v = w.req(areq).version;
    let tom = w.actor(w.u_tom);
    requests::decide(
        &mut w.conn, &clock, &tom, areq, step.id, "recommend_approve",
        None, None, v, None,
    )
    .unwrap();
    let dec = model::decisions_of(&w.conn, areq).unwrap().pop().unwrap();
    assert_eq!(dec.actor_user_id, w.u_tom);
    assert_eq!(dec.acting_for_user_id, Some(w.u_olga));

    // after the window Tom may not act any more
    w.set_today("2026-10-20");
    let lreq = w.submit_leave(w.u_lina, w.annual, "2026-11-09", "2026-11-10");
    let step = w.pending(lreq);
    let v = w.req(lreq).version;
    let tom = w.actor(w.u_tom);
    let clock = w.clock();
    let err = requests::decide(
        &mut w.conn, &clock, &tom, lreq, step.id, "recommend_approve",
        None, None, v, None,
    )
    .unwrap_err();
    assert_eq!(err.code(), "forbidden");
}

/// C6 — after a transfer the old manager no longer sees NEW requests of the
/// employee; open steps on old requests keep their access.
#[test]
fn transfer_access() {
    let mut w = W::new();
    let old_req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");

    let clock = w.clock();
    let maria = w.actor(w.u_maria);
    people::transfer(
        &mut w.conn, &clock, &maria, w.alexei, w.csu, Some(w.rita),
        w.today, false,
    )
    .unwrap();

    // old request: Olga still sees it (she is the open step's assignee)
    let old_ctx = requests::request_ctx(&w.conn, &w.req(old_req), w.today).unwrap();
    let olga = w.actor(w.u_olga);
    assert!(authz::view_level(&w.conn, &olga, &old_ctx).is_ok());

    // new request: goes to Rita; Olga is locked out
    let new_req = w.submit_leave(w.u_alexei, w.annual, "2026-11-16", "2026-11-17");
    let step = w.pending(new_req);
    assert_eq!(step.assignee_user_id, Some(w.u_rita));
    let new_ctx = requests::request_ctx(&w.conn, &w.req(new_req), w.today).unwrap();
    let err = authz::view_level(&w.conn, &olga, &new_ctx).unwrap_err();
    assert_eq!(err.code(), "forbidden");
    let rita = w.actor(w.u_rita);
    assert!(authz::view_level(&w.conn, &rita, &new_ctx).is_ok());
}

/// C7 — a medical attachment opens for the employee and hr_medical only;
/// manager, final approver and tech_admin get 403. Normal files are wider.
#[test]
fn medical_access() {
    let mut w = W::new();
    let clock = w.clock();
    let store = w.store();
    let nia = w.actor(w.u_nia);
    let req = w.submit_leave(w.u_nia, w.sick, "2026-11-09", "2026-11-10");
    let att = requests::upload_attachment(
        &mut w.conn, &clock, &nia, &store, req, "cert.pdf", PDF, "medical",
    )
    .unwrap();
    let ctx = requests::attachment_ctx(&w.conn, att, w.today).unwrap();

    let can = |w: &W, user: i64| {
        let actor = w.actor(user);
        authz::can(&w.conn, &actor, Action::DownloadAttachment, &Resource::Attachment(&ctx))
            .is_ok()
    };
    assert!(can(&w, w.u_nia)); // owner
    assert!(can(&w, w.u_maria)); // hr_medical
    assert!(!can(&w, w.u_rita)); // manager, not hr_medical
    assert!(!can(&w, w.u_elena)); // final approver
    assert!(!can(&w, w.u_pavel)); // tech_admin

    // a normal attachment on Ben's request is visible to his manager
    let breq = w.submit_leave(w.u_ben, w.annual, "2026-11-09", "2026-11-10");
    let ben = w.actor(w.u_ben);
    let batt = requests::upload_attachment(
        &mut w.conn, &clock, &ben, &store, breq, "note.pdf", PDF, "normal",
    )
    .unwrap();
    let bctx = requests::attachment_ctx(&w.conn, batt, w.today).unwrap();
    let rita = w.actor(w.u_rita);
    assert!(
        authz::can(&w.conn, &rita, Action::DownloadAttachment, &Resource::Attachment(&bctx))
            .is_ok()
    );
}

/// C7/C3 — colleagues see a sensitive request only as restricted.
#[test]
fn sensitive_view_masked() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_nia, w.sick, "2026-11-09", "2026-11-10");
    let ctx = requests::request_ctx(&w.conn, &w.req(req), w.today).unwrap();
    assert!(ctx.sensitive_type);
    let rita = w.actor(w.u_rita);
    assert_eq!(
        authz::view_level(&w.conn, &rita, &ctx).unwrap(),
        authz::ViewLevel::Restricted
    );
}

/// C8 — tech_admin cannot touch balances, decisions or files.
#[test]
fn tech_admin_limits() {
    let mut w = W::new();
    let clock = w.clock();
    let pavel = w.actor(w.u_pavel);

    // cannot propose an adjustment
    let err = nauru_leave::ledger::propose_adjustment(
        &mut w.conn, &clock, &pavel, w.alexei, w.annual, 2026, 480, "test", "doc", None,
    )
    .unwrap_err();
    assert_eq!(err.code(), "forbidden");

    // cannot decide a step even if he somehow is pending
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    let step = w.pending(req);
    let v = w.req(req).version;
    let err = requests::decide(
        &mut w.conn, &clock, &pavel, req, step.id, "recommend_approve",
        None, None, v, None,
    )
    .unwrap_err();
    assert_eq!(err.code(), "forbidden");

    // cannot download an attachment
    let alexei = w.actor(w.u_alexei);
    let store = w.store();
    let att = requests::upload_attachment(
        &mut w.conn, &clock, &alexei, &store, req, "f.pdf", PDF, "normal",
    )
    .unwrap();
    let ctx = requests::attachment_ctx(&w.conn, att, w.today).unwrap();
    let err = authz::can(&w.conn, &pavel, Action::DownloadAttachment, &Resource::Attachment(&ctx))
        .unwrap_err();
    assert_eq!(err.code(), "forbidden");

    // but he may retry a failed notification (operations duty)
    let err = nauru_leave::notify::retry(&mut w.conn, &clock, &pavel, 99999).unwrap_err();
    assert_eq!(err.code(), "not_found"); // passed authz, id missing
}

/// C9 — adjustment needs a second person: proposer cannot apply their own.
#[test]
fn adjustment_two_person() {
    let mut w = W::new();
    let clock = w.clock();
    let maria = w.actor(w.u_maria);
    let adj = nauru_leave::ledger::propose_adjustment(
        &mut w.conn, &clock, &maria, w.alexei, w.annual, 2026, -240,
        "data fix", "HR-2026-117", None,
    )
    .unwrap();

    // Maria (hr but not adjustment_approver, and the proposer) cannot decide
    let err = nauru_leave::ledger::decide_adjustment(&mut w.conn, &clock, &maria, adj, true, "ok")
        .unwrap_err();
    assert_eq!(err.code(), "forbidden");

    // David (adjustment_approver) applies it
    let david = w.actor(w.u_david);
    nauru_leave::ledger::decide_adjustment(&mut w.conn, &clock, &david, adj, true, "ok").unwrap();
    assert_eq!(w.totals(w.alexei, w.annual).0, 9600 - 240);

    // deciding again is refused
    let err = nauru_leave::ledger::decide_adjustment(&mut w.conn, &clock, &david, adj, true, "again")
        .unwrap_err();
    assert_eq!(err.code(), "validation");

    // David cannot decide an adjustment he proposed himself
    let adj2 = nauru_leave::ledger::propose_adjustment(
        &mut w.conn, &clock, &david, w.alexei, w.annual, 2026, 120,
        "another fix", "HR-2026-118", None,
    )
    .unwrap();
    let err = nauru_leave::ledger::decide_adjustment(&mut w.conn, &clock, &david, adj2, true, "ok")
        .unwrap_err();
    assert_eq!(err.code(), "forbidden");
}
