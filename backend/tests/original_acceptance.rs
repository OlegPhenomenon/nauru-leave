//! Original acceptance checks that had no dedicated test: N04 (custom weekend schedule) and N16 (increasing an
//! approved leave, then rejecting the increase).
mod common;
use common::{d, W};
use nauru_leave::{calendar, model::Part, people, requests};

/// N04 — a schedule with 360 minutes on Saturday and 0 on Sunday counts Saturday as 360, not 480, and Sunday as 0.
#[test]
fn n04_saturday_360_sunday_0() {
    let w = W::new();
    let (sched, _) = people::create_schedule(
        &w.conn,
        "Tue-Sat with short Saturday (demo)",
        d("2026-01-01"),
        [0, 480, 480, 480, 480, 360, 0],
        None,
    )
    .unwrap();
    w.conn
        .execute(
            "UPDATE employee_schedules SET valid_to='2026-10-31' WHERE employee_id=?1",
            [w.alexei],
        )
        .unwrap();
    people::set_schedule(&w.conn, w.alexei, sched, d("2026-11-01")).unwrap();

    let days = calendar::compute_days(
        &w.conn,
        w.alexei,
        w.annual,
        d("2026-11-13"), // Friday
        d("2026-11-16"), // Monday
        Part::Full,
        Part::Full,
    )
    .unwrap();
    let minutes: Vec<(String, i64)> = days.iter().map(|x| (x.date.to_string(), x.minutes)).collect();
    assert_eq!(
        minutes,
        vec![
            ("2026-11-13".into(), 480),
            ("2026-11-14".into(), 360),
            ("2026-11-15".into(), 0),
            ("2026-11-16".into(), 0),
        ]
    );
    assert_eq!(days.iter().map(|x| x.minutes).sum::<i64>(), 840);
}

/// N16 — approved 5 days, ask for 2 more: only the extra 960 minutes are reserved while the amendment is
/// reviewed; on rejection the reservation is released and the original 5-day decision stays in force.
#[test]
fn n16_increase_reserves_only_delta_and_rejection_keeps_original() {
    let mut w = W::new();
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    w.approve_all(req);
    assert_eq!(w.totals(w.alexei, w.annual), (7200, 0, 7200));
    let original = w.req(req).effective_revision_id;

    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let input = w.revise(w.annual, "2026-11-09", "2026-11-17", "two more days");
    let pv = w.req(req).version;
    let amend = requests::amend(&mut w.conn, &clock, &alexei, req, &input, pv, None).unwrap();

    let reserved: i64 = w.reservations(amend.request_id).iter().map(|r| r.1).sum();
    assert_eq!(reserved, 960, "only the additional two days are reserved");
    assert_eq!(w.totals(w.alexei, w.annual), (7200, 960, 6240));

    w.decide_pending(w.u_olga, amend.request_id, "recommend_approve", None);
    w.decide_pending(w.u_maria, amend.request_id, "checked_ok", None);
    w.decide_pending(w.u_elena, amend.request_id, "reject", Some("Team cover not available"));

    assert!(w.reservations(amend.request_id).is_empty());
    assert_eq!(w.totals(w.alexei, w.annual), (7200, 0, 7200));
    let parent = w.req(req);
    assert_eq!(parent.effective_revision_id, original, "the original decision stays in force");
    assert_eq!(parent.status.as_str(), "approved");
}

/// N06 — a saved draft does not touch the balance; submitting reserves its minutes.
#[test]
fn n06_draft_does_not_reserve_submit_does() {
    let mut w = W::new();
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let input = w.input(w.annual, "2026-11-09", "2026-11-13");
    let id = requests::create_draft(&mut w.conn, &clock, &alexei, &input).unwrap();
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 0, 9600));
    let v = w.req(id).version;
    requests::submit(&mut w.conn, &clock, &alexei, id, v, None).unwrap();
    assert_eq!(w.totals(w.alexei, w.annual), (9600, 2400, 7200));
}
