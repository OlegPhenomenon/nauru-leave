//! ACCEPTANCE B6/B9/C3–C5 — withdraw, partial/full cancellation, per-account
//! amendment deltas, needs_information → revise, version conflicts, and the
//! unassigned-step problem list.

mod common;

use common::W;
use nauru_leave::error::DomainError;
use nauru_leave::model::{self, RequestKind, RequestStatus};
use nauru_leave::requests::{self};

/// B6 — withdrawing an open request releases its reservation.
#[test]
fn withdraw_releases() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 960, 8640));

    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let v = w.req(req).version;
    requests::withdraw(&mut w.conn, &clock, &alexei, req, Some("changed plans"), v).unwrap();
    assert_eq!(w.req(req).status, RequestStatus::Withdrawn);
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 0, 9600));

    // the dates are free again
    w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
}

/// B6 — partial cancellation after approval returns only the cancelled days;
/// the cancellation is its own immutable revision, parent days untouched.
#[test]
fn partial_cancel() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    w.approve_all(req);
    assert_eq!(w.totals(w.alexei, w.annual), (7200, 0, 7200));
    let parent_eff = w.req(req).effective_revision_id.unwrap();

    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let pv = w.req(req).version;
    // cancel Thursday+Friday (Nov 12–13, 960 min)
    let child = requests::cancel(
        &mut w.conn,
        &clock,
        &alexei,
        req,
        common::d("2026-11-12"),
        common::d("2026-11-13"),
        "back early",
        pv,
        None,
    )
    .unwrap();
    let creq = w.req(child.request_id);
    assert_eq!(creq.kind, RequestKind::Cancellation);
    assert_eq!(creq.status, RequestStatus::Submitted);

    // cancellation revision covers the parent's whole effective range; the
    // cancelled days are part='none', minutes=0, with the reason baked in.
    let crev = creq.current_revision_id.unwrap();
    let days = model::revision_days(&w.conn, crev).unwrap();
    assert_eq!(days.len(), 5);
    let cancelled: Vec<_> = days
        .iter()
        .filter(|x| x.date >= common::d("2026-11-12"))
        .collect();
    assert_eq!(cancelled.len(), 2);
    for x in &cancelled {
        assert_eq!(x.part, "none");
        assert_eq!(x.minutes, 0);
        assert_eq!(x.explanation, format!("Cancelled by {}", creq.number));
    }
    // the parent's effective revision is immutable — still 5 full days
    let parent_days = model::revision_days(&w.conn, parent_eff).unwrap();
    assert_eq!(parent_days.iter().map(|x| x.minutes).sum::<i64>(), 2400);

    // nothing changes in the ledger until the cancellation is approved
    assert_eq!(w.totals(w.alexei, w.annual), (7200, 0, 7200));
    w.approve_all(child.request_id);

    // +960 returned; parent stays approved with the cancellation revision
    assert_eq!(w.totals(w.alexei, w.annual), (8160, 0, 8160));
    let parent = w.req(req);
    assert_eq!(parent.status, RequestStatus::Approved);
    assert_eq!(parent.effective_revision_id, Some(crev));

    // freed days no longer block a new absence
    w.submit_leave(w.u_alexei, w.annual, "2026-11-12", "2026-11-13");
}

/// B6 — a full cancellation closes the parent request.
#[test]
fn full_cancel_closes_parent() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    w.approve_all(req);
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let pv = w.req(req).version;
    let child = requests::cancel(
        &mut w.conn,
        &clock,
        &alexei,
        req,
        common::d("2026-11-09"),
        common::d("2026-11-10"),
        "not needed",
        pv,
        None,
    )
    .unwrap();
    w.approve_all(child.request_id);
    assert_eq!(w.req(req).status, RequestStatus::Cancelled);
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 0, 9600));
}

/// Cancelling past dates is refused — HR must post a correction instead.
#[test]
fn cancel_past_dates_refused() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    w.approve_all(req);
    w.set_today("2026-11-20"); // the whole period is in the past
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let pv = w.req(req).version;
    let err = requests::cancel(
        &mut w.conn,
        &clock,
        &alexei,
        req,
        common::d("2026-11-09"),
        common::d("2026-11-10"),
        "too late",
        pv,
        None,
    )
    .unwrap_err();
    assert!(matches!(err, DomainError::PastDatesNeedHrCorrection));
}

/// B9 — moving leave days into another year reserves only the positive
/// per-account delta.
#[test]
fn amendment_per_account_delta() {
    let mut w = W::new();
    // accrue ANNUAL 2027 first so the delta lands on the 2027 account
    let clock = w.clock();
    let maria = w.actor(w.u_maria);
    nauru_leave::ledger::run_accrual(&mut w.conn, &clock, &maria, w.annual, 2027, None).unwrap();

    // Tom takes Dec 29–31 2026 (1440 on the 2026 account)
    let req = w.submit_leave(w.u_tom, w.annual, "2026-12-29", "2026-12-31");
    w.approve_all(req);
    let acc2026 = w.account(w.tom, w.annual, 2026);
    let acc2027 = w.account(w.tom, w.annual, 2027);
    assert_eq!(
        ledger_available(&w, acc2026),
        9600 - 1440
    );

    // amendment moves the whole period to Jan 4–6 2027 (1440 on acc2027)
    let tom = w.actor(w.u_tom);
    let input = w.revise(w.annual, "2027-01-04", "2027-01-06", "postponed");
    let pv = w.req(req).version;
    let amend = requests::amend(&mut w.conn, &clock, &tom, req, &input, pv, None).unwrap();

    // only the positive delta (acc2027 +1440) is reserved; acc2026 frees
    let res = w.reservations(amend.request_id);
    assert_eq!(res, vec![(acc2027, 1440)]);

    w.approve_all(amend.request_id);
    // acc2026 returned in full, acc2027 consumed
    assert_eq!(ledger_available(&w, acc2026), 9600);
    assert_eq!(ledger_available(&w, acc2027), 9600 - 1440);
    let parent = w.req(req);
    assert_eq!(
        parent.effective_revision_id,
        w.req(amend.request_id).current_revision_id
    );
}

fn ledger_available(w: &W, account_id: i64) -> i64 {
    nauru_leave::ledger::available(&w.conn, account_id, w.today).unwrap()
}

/// C3 — a material change under needs_information creates a new revision,
/// supersedes the old steps and re-does the reservation.
#[test]
fn revise_restarts_route() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    let rev1 = w.req(req).current_revision_id.unwrap();
    w.decide_pending(w.u_olga, req, "recommend_approve", None);
    // Maria asks a question at hr_check
    w.decide_pending(w.u_maria, req, "needs_information", Some("can you shift to next week?"));
    assert_eq!(w.req(req).status, RequestStatus::NeedsInformation);
    // the hr step stays pending (not done) with its outcome recorded
    let steps = model::steps_of(&w.conn, req).unwrap();
    assert!(steps.iter().any(|s| s.outcome.as_deref() == Some("needs_information")));

    // Alexei answers with new dates — a material change
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let v = w.req(req).version;
    let ch = w.revise(w.annual, "2026-11-16", "2026-11-20", "moving to next week");
    requests::respond(&mut w.conn, &clock, &alexei, req, v, "sure, moved", Some(ch)).unwrap();

    let r = w.req(req);
    assert_eq!(r.status, RequestStatus::Submitted);
    let rev2 = r.current_revision_id.unwrap();
    assert_ne!(rev1, rev2);
    // old steps superseded, route restarted at step 1
    let steps = model::steps_of(&w.conn, req).unwrap();
    assert!(steps
        .iter()
        .filter(|s| s.revision_id == rev1)
        .all(|s| s.status == "superseded" || s.status == "done"));
    assert!(steps
        .iter()
        .any(|s| s.revision_id == rev2 && s.status == "pending" && s.seq == 1));
    // reservation re-done on the new revision only (not doubled)
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 2400, 7200));
}

/// A text-only answer under needs_information keeps the same revision and
/// resumes the route.
#[test]
fn respond_text_only() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    w.decide_pending(w.u_olga, req, "needs_information", Some("which week?"));
    assert_eq!(w.req(req).status, RequestStatus::NeedsInformation);
    let rev1 = w.req(req).current_revision_id.unwrap();

    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let v = w.req(req).version;
    requests::respond(&mut w.conn, &clock, &alexei, req, v, "the stated dates", None).unwrap();
    let r = w.req(req);
    // back to submitted (no step finished yet), same revision
    assert_eq!(r.status, RequestStatus::Submitted);
    assert_eq!(r.current_revision_id, Some(rev1));
    // and the answer is stored as a message
    let n: i64 = w
        .conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE request_id=?1 AND kind='answer'",
            [req],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

/// C4 — a stale expected_version is a 409 (`stale_version`), no change made.
#[test]
fn stale_version() {
    let mut w = W::new();
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let input = w.input(w.annual, "2026-11-09", "2026-11-10");
    let id = requests::create_draft(&mut w.conn, &clock, &alexei, &input).unwrap();
    let err = requests::submit(&mut w.conn, &clock, &alexei, id, 99, None).unwrap_err();
    assert!(matches!(err, DomainError::StaleVersion));
    // correct version works
    requests::submit(&mut w.conn, &clock, &alexei, id, 1, None).unwrap();

    // stale version on a decision too
    let step = w.pending(id);
    let olga = w.actor(w.u_olga);
    let err = requests::decide(
        &mut w.conn, &clock, &olga, id, step.id,
        "recommend_approve", None, None, 1, None, // v was 1, now 2
    )
    .unwrap_err();
    assert!(matches!(err, DomainError::StaleVersion));
}

/// C5 — an employee with no manager leaves step 1 unassigned; it shows up on
/// the HR problem list instead of being skipped.
#[test]
fn unassigned_step_visible() {
    let mut w = W::new();
    // Elena has no manager
    let req = w.submit_leave(w.u_elena, w.annual, "2026-11-09", "2026-11-10");
    let step = w.pending(req);
    assert_eq!(step.assignee_user_id, None);
    assert_eq!(step.kind.as_str(), "manager_recommendation");
    let unassigned = requests::unassigned_steps(&w.conn).unwrap();
    assert!(unassigned.iter().any(|(rid, sid, _)| *rid == req && *sid == step.id));
}

/// A rejection releases the reservation and closes the route.
#[test]
fn reject_releases() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    w.decide_pending(w.u_olga, req, "recommend_approve", None);
    w.decide_pending(w.u_maria, req, "checked_ok", None);
    w.decide_pending(w.u_elena, req, "reject", Some("peak season"));
    assert_eq!(w.req(req).status, RequestStatus::Rejected);
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 0, 9600));
}
