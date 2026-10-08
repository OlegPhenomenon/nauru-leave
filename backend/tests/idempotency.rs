//! ACCEPTANCE B1/B7/B8 — idempotency keys, accrual/close reruns, and
//! append-only tables enforced by triggers.

mod common;

use common::W;
use nauru_leave::error::DomainError;
use nauru_leave::ledger;
use nauru_leave::model;
use nauru_leave::requests;

/// B1 — replaying `submit` with the same Idempotency-Key returns the stored
/// response and does not double the reservation; the same key with a
/// different body is a 422.
#[test]
fn idempotent_submit() {
    let mut w = W::new();
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let input = w.input(w.annual, "2026-11-09", "2026-11-10");
    let id = requests::create_draft(&mut w.conn, &clock, &alexei, &input).unwrap();

    let s1 = requests::submit(&mut w.conn, &clock, &alexei, id, 1, Some("submit-1")).unwrap();
    let s2 = requests::submit(&mut w.conn, &clock, &alexei, id, 1, Some("submit-1")).unwrap();
    assert_eq!(s1.request_id, s2.request_id);
    assert_eq!(s1.number, s2.number);
    // exactly one reservation exists
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 960, 8640));

    // same key, different body -> idempotency_key_reused
    let err = requests::submit(&mut w.conn, &clock, &alexei, id, 2, Some("submit-1")).unwrap_err();
    assert!(matches!(err, DomainError::IdempotencyKeyReused));
}

/// B1 — same for a step decision.
#[test]
fn idempotent_decide() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    let step = w.pending(req);
    let v = w.req(req).version;
    let clock = w.clock();
    let olga = w.actor(w.u_olga);

    requests::decide(
        &mut w.conn, &clock, &olga, req, step.id,
        "recommend_approve", None, None, v, Some("decide-1"),
    )
    .unwrap();
    let v_after = w.req(req).version;
    // replay: no second decision, no route skip, no version bump
    requests::decide(
        &mut w.conn, &clock, &olga, req, step.id,
        "recommend_approve", None, None, v, Some("decide-1"),
    )
    .unwrap();
    assert_eq!(w.req(req).version, v_after);
    assert_eq!(model::decisions_of(&w.conn, req).unwrap().len(), 1);
    assert_eq!(w.pending(req).kind.as_str(), "hr_check");

    // same key, different body -> 422
    let err = requests::decide(
        &mut w.conn, &clock, &olga, req, step.id,
        "recommend_reject", Some("x"), None, v, Some("decide-1"),
    )
    .unwrap_err();
    assert!(matches!(err, DomainError::IdempotencyKeyReused));
}

/// B7 — re-running an accrual posts nothing twice; period close is
/// idempotent and burns expired carryover.
#[test]
fn accrual_idempotent() {
    let mut w = W::new();
    let clock = w.clock();
    let maria = w.actor(w.u_maria);

    // ANNUAL 2027 accrual is allowed from 2026-10-01 (advance 3 months)
    let run = ledger::run_accrual(&mut w.conn, &clock, &maria, w.annual, 2027, None).unwrap();
    assert!(run.posted > 0);
    assert_eq!(run.skipped_existing, 0);
    let run2 = ledger::run_accrual(&mut w.conn, &clock, &maria, w.annual, 2027, None).unwrap();
    assert_eq!(run2.posted, 0);
    assert_eq!(run2.skipped_existing, run.posted);

    // too-early accrual is refused
    let err = ledger::run_accrual(&mut w.conn, &clock, &maria, w.annual, 2029, None).unwrap_err();
    assert_eq!(err.code(), "validation");

    // CARRY policy: carryover expires after 3 months of 2026
    ledger::post_opening(
        &w.conn,
        w.alexei,
        w.carry,
        2025,
        960,
        common::d("2025-01-01"),
        "test opening",
        None,
        "2025-01-01T09:00:00Z",
    )
    .unwrap();
    let acc = w.account(w.alexei, w.carry, 2025);
    assert_eq!(ledger::balance_at(&w.conn, acc, w.today).unwrap(), 960);

    // period close burns the expired balance, idempotently
    let posted = ledger::close_period(&mut w.conn, &clock, &maria, w.carry, 2025).unwrap();
    assert_eq!(posted, 1);
    assert_eq!(ledger::balance_at(&w.conn, acc, w.today).unwrap(), 0);
    assert_eq!(
        ledger::close_period(&mut w.conn, &clock, &maria, w.carry, 2025).unwrap(),
        0
    );
    // ANNUAL carryover never expires -> nothing to post
    assert_eq!(
        ledger::close_period(&mut w.conn, &clock, &maria, w.annual, 2025).unwrap(),
        0
    );
}

/// B8 — ledger entries, decisions and audit events reject UPDATE/DELETE.
#[test]
fn ledger_immutable() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    w.approve_all(req); // posts consumption entries + decisions + audit rows

    assert!(w
        .conn
        .execute("UPDATE ledger_entries SET minutes=0 WHERE id=1", [])
        .is_err());
    assert!(w.conn.execute("DELETE FROM ledger_entries", []).is_err());
    assert!(w
        .conn
        .execute("UPDATE decisions SET outcome='reject' WHERE id=1", [])
        .is_err());
    assert!(w.conn.execute("DELETE FROM decisions", []).is_err());
    assert!(w
        .conn
        .execute("UPDATE audit_events SET action='x' WHERE id=1", [])
        .is_err());
    assert!(w.conn.execute("DELETE FROM audit_events", []).is_err());
}
