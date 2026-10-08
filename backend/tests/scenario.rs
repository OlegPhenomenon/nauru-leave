//! ACCEPTANCE §A1/B2–B5/C10 — the main balance scenario, calendar math,
//! allocation across years, insufficient balance and overlaps.

mod common;

use common::{d, W};
use nauru_leave::calendar;
use nauru_leave::error::DomainError;
use nauru_leave::model::{self, Part, RequestStatus, StepKind};
use nauru_leave::requests::{self};

/// A1 — Alexei: 20/0/20 → submit 5 days → 20/5/15 → approve → 15/0/15 →
/// amend to 3 days → 15/0/15 → approve → 17/0/17 → time travel → 17,
/// "period ended". All values in minutes (480/day).
#[test]
fn main_scenario() {
    let mut w = W::new();
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 0, 9600));

    // submit 2026-11-09 .. 11-13 (Mon–Fri, 5 days = 2400 min)
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 2400, 7200));

    // route: Olga recommend -> Maria checked -> Elena approve
    w.decide_pending(w.u_olga, req, "recommend_approve", None);
    assert_eq!(w.req(req).status, RequestStatus::UnderReview);
    w.decide_pending(w.u_maria, req, "checked_ok", None);
    w.decide_pending(w.u_elena, req, "approve", None);
    let r = w.req(req);
    assert_eq!(r.status, RequestStatus::Approved);
    assert_eq!(w.totals(w.alexei, w.annual), (7200, 0, 7200));

    // amendment: shorten to 9–11.11 (3 days = 1440) — only a negative delta
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let rev_input = w.revise(w.annual, "2026-11-09", "2026-11-11", "plans changed");
    let parent_v = w.req(req).version;
    let amend = requests::amend(
        &mut w.conn,
        &clock,
        &alexei,
        req,
        &rev_input,
        parent_v,
        None,
    )
    .unwrap();
    assert_eq!(w.totals(w.alexei, w.annual), (7200, 0, 7200));
    // the amendment reserves nothing (delta per account is <= 0)
    assert!(w.reservations(amend.request_id).is_empty());

    w.approve_all(amend.request_id);
    assert_eq!(w.req(amend.request_id).status, RequestStatus::Approved);
    // 960 returned -> 17 days available
    assert_eq!(w.totals(w.alexei, w.annual), (8160, 0, 8160));
    // the parent's effective revision switched to the amendment's revision
    let parent = w.req(req);
    let child = w.req(amend.request_id);
    assert_eq!(parent.effective_revision_id, child.current_revision_id);

    // time travel past the period
    w.set_today("2026-11-12");
    assert_eq!(w.totals(w.alexei, w.annual), (8160, 0, 8160));
    let eff = model::load_revision(&w.conn, w.req(req).effective_revision_id.unwrap()).unwrap();
    assert_eq!(
        requests::date_phase(&w.req(req), &eff, w.today),
        Some("period_ended")
    );
}

/// A3 — a colleague cannot view the request at all.
#[test]
fn isolation_other_employee() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    let ctx = requests::request_ctx(&w.conn, &w.req(req), w.today).unwrap();
    let tom = w.actor(w.u_tom);
    let err = nauru_leave::authz::view_level(&w.conn, &tom, &ctx).unwrap_err();
    assert_eq!(err.code(), "forbidden");
    // the request's own participants do see it
    let olga = w.actor(w.u_olga);
    assert!(nauru_leave::authz::view_level(&w.conn, &olga, &ctx).is_ok());
}

/// B2 — two requests racing for the last days: exactly one wins, the other
/// gets `insufficient_balance`. Two threads, two connections, one file.
#[test]
fn concurrent_last_days() {
    let mut w = W::new();
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    // two 11-day drafts (5280 each); the account holds only 9600
    let in1 = w.input(w.annual, "2026-11-02", "2026-11-16");
    let in2 = w.input(w.annual, "2026-11-17", "2026-12-01");
    let d1 = requests::create_draft(&mut w.conn, &clock, &alexei, &in1).unwrap();
    let d2 = requests::create_draft(&mut w.conn, &clock, &alexei, &in2).unwrap();
    let db = w.db_path();
    let uid = w.u_alexei;

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let run = |draft_id: i64| {
        let barrier = barrier.clone();
        let db = db.clone();
        std::thread::spawn(move || {
            let mut conn = nauru_leave::db::open(&db).unwrap();
            let clock = nauru_leave::clock::Clock::demo();
            let today = clock.today(&conn).unwrap();
            let actor = nauru_leave::authz::Actor::load(&conn, uid, today).unwrap();
            barrier.wait();
            requests::submit(&mut conn, &clock, &actor, draft_id, 1, None)
        })
    };
    let h1 = run(d1);
    let h2 = run(d2);
    let r1 = h1.join().unwrap();
    let r2 = h2.join().unwrap();

    let oks = [&r1, &r2].iter().filter(|r| r.is_ok()).count();
    assert_eq!(oks, 1, "exactly one submission must win: {r1:?} {r2:?}");
    let loser = if r1.is_err() { r1 } else { r2 };
    assert!(matches!(
        loser.unwrap_err(),
        DomainError::InsufficientBalance(_)
    ));
    // only the winner's reservation exists: 5280 of 9600
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 5280, 4320));
}

/// B3 — a request across New Year allocates each day to the account of its
/// own year (Tom has both 2025 and 2026 accounts).
#[test]
fn year_boundary_allocation() {
    let mut w = W::new();
    // Tom: 2025 accrual exists; 2025-12-29..2026-01-07 (all parts full)
    let req = w.submit_leave(w.u_tom, w.annual, "2025-12-29", "2026-01-07");
    let r = w.req(req);
    let rev = r.current_revision_id.unwrap();
    // days: Dec 29,30,31 (3×480 on 2025), Jan 2,5,6,7 (4×480 on 2026);
    // Jan 1 is a holiday (0).
    let totals = model::allocation_totals(&w.conn, rev).unwrap();
    let acc2025 = w.account(w.tom, w.annual, 2025);
    let acc2026 = w.account(w.tom, w.annual, 2026);
    assert_eq!(totals.get(&acc2025), Some(&1440));
    assert_eq!(totals.get(&acc2026), Some(&1920));
    let res = w.reservations(req);
    assert_eq!(res.len(), 2);
}

/// B4 — a request bigger than the available balance is blocked at submit.
#[test]
fn insufficient_blocks() {
    let mut w = W::new();
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    // 25 workdays (12000 > 9600)
    let input = w.input(w.annual, "2026-11-02", "2026-12-04");
    let id = requests::create_draft(&mut w.conn, &clock, &alexei, &input).unwrap();
    let err = requests::submit(&mut w.conn, &clock, &alexei, id, 1, None).unwrap_err();
    assert!(matches!(err, DomainError::InsufficientBalance(_)));
    // stays a draft, nothing reserved
    assert_eq!(w.req(id).status, RequestStatus::Draft);
    assert!(w.reservations(id).is_empty());
    // and the preview reports the error without blocking callers
    let input = w.input(w.annual, "2026-11-02", "2026-12-04");
    let p = requests::preview(&mut w.conn, &clock, &alexei, &input, None, None).unwrap();
    assert!(p.errors.iter().any(|e| e.code == "insufficient_balance"));
}

/// B5 — half day = 240 of 480; a holiday and weekends inside the range = 0.
#[test]
fn half_day_and_holidays() {
    let w = W::new();
    // single half-day: Monday 2026-11-09, am only
    let days = calendar::compute_days(
        &w.conn,
        w.alexei,
        w.annual,
        d("2026-11-09"),
        d("2026-11-09"),
        Part::Am,
        Part::Am,
    )
    .unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].part, "am");
    assert_eq!(days[0].minutes, 240);

    // range containing Angam Day (2026-10-26, Mon) and a weekend
    let days = calendar::compute_days(
        &w.conn,
        w.alexei,
        w.annual,
        d("2026-10-23"),
        d("2026-10-30"),
        Part::Full,
        Part::Full,
    )
    .unwrap();
    let holiday = days.iter().find(|x| x.date == d("2026-10-26")).unwrap();
    assert_eq!(holiday.minutes, 0);
    assert_eq!(holiday.part, "none");
    assert!(holiday.explanation.contains("Angam"));
    let sat = days.iter().find(|x| x.date == d("2026-10-24")).unwrap();
    assert_eq!(sat.minutes, 0);
    let total: i64 = days.iter().map(|x| x.minutes).sum();
    assert_eq!(total, 5 * 480); // Fri 23 + Tue–Fri 27–30
}

/// B5 — part-time schedule: 360/day, Friday off.
#[test]
fn part_time_schedule() {
    let w = W::new();
    let days = calendar::compute_days(
        &w.conn,
        w.lina,
        w.annual,
        d("2026-11-02"),
        d("2026-11-06"),
        Part::Full,
        Part::Full,
    )
    .unwrap();
    assert_eq!(days.len(), 5);
    let total: i64 = days.iter().map(|x| x.minutes).sum();
    assert_eq!(total, 4 * 360);
    let friday = days.iter().find(|x| x.date == d("2026-11-06")).unwrap();
    assert_eq!(friday.minutes, 0);
    assert_eq!(friday.part, "none");
}

/// C10 — overlapping absences of one employee are blocked; am+pm on the same
/// day are allowed.
#[test]
fn overlap_rules() {
    let mut w = W::new();
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");

    // overlapping range -> overlap error at submit
    let bad_input = w.input(w.annual, "2026-11-11", "2026-11-15");
    let bad = requests::create_draft(&mut w.conn, &clock, &alexei, &bad_input).unwrap();
    let err = requests::submit(&mut w.conn, &clock, &alexei, bad, 1, None).unwrap_err();
    assert!(matches!(err, DomainError::Overlap(_)));

    // am on Nov 16, then pm on the same day — no conflict
    let mut am_input = w.input(w.annual, "2026-11-16", "2026-11-16");
    am_input.start_part = Part::Am;
    am_input.end_part = Part::Am;
    let am = requests::create_draft(&mut w.conn, &clock, &alexei, &am_input).unwrap();
    requests::submit(&mut w.conn, &clock, &alexei, am, 1, None).unwrap();
    let mut pm_input = w.input(w.annual, "2026-11-16", "2026-11-16");
    pm_input.start_part = Part::Pm;
    pm_input.end_part = Part::Pm;
    let pm = requests::create_draft(&mut w.conn, &clock, &alexei, &pm_input).unwrap();
    requests::submit(&mut w.conn, &clock, &alexei, pm, 1, None).unwrap();

    let duplicate = requests::create_draft(&mut w.conn, &clock, &alexei, &am_input).unwrap();
    assert!(matches!(
        requests::submit(&mut w.conn, &clock, &alexei, duplicate, 1, None),
        Err(DomainError::Overlap(_))
    ));

    // full day on top of the am half -> conflict
    let full_input = w.input(w.annual, "2026-11-16", "2026-11-16");
    let full = requests::create_draft(&mut w.conn, &clock, &alexei, &full_input).unwrap();
    let err = requests::submit(&mut w.conn, &clock, &alexei, full, 1, None).unwrap_err();
    assert!(matches!(err, DomainError::Overlap(_)));
}

/// Step outcome validation: a manager cannot "approve", only recommend.
#[test]
fn step_outcomes_validated() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    let step = w.pending(req);
    assert_eq!(step.kind, StepKind::ManagerRecommendation);
    let v = w.req(req).version;
    let clock = w.clock();
    let olga = w.actor(w.u_olga);
    let err = requests::decide(
        &mut w.conn,
        &clock,
        &olga,
        req,
        step.id,
        "approve",
        None,
        None,
        v,
        None,
    )
    .unwrap_err();
    assert_eq!(err.code(), "validation");
}
