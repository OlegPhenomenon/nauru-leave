mod b_http_support;
mod common;
use b_http_support::{Client, Fixture};
use common::{d, W};
use nauru_leave::{
    admin, clock::Mode, db, imports_exports as ie, ledger, model, people, presentation, requests,
    sessions,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn connection(f: &Fixture, c: &Client) -> rusqlite::Connection {
    db::open(&if f.state.config.mode == Mode::Production {
        f.dir.join("main.sqlite")
    } else {
        f.dir
            .join("sandboxes")
            .join(format!("{}-g1.sqlite", c.cookies["nld_sbx"]))
    })
    .unwrap()
}
fn session(c: &mut Client, conn: &mut rusqlite::Connection, name: &str) {
    let id = conn
        .query_row("SELECT id FROM users WHERE display_name=?1", [name], |r| {
            r.get(0)
        })
        .unwrap();
    let token = sessions::create(conn, id, true, None).unwrap();
    c.csrf = Some(sessions::load(conn, &token, true).unwrap().csrf_token);
    c.cookies.insert("nld_session".into(), token);
}
#[test]
fn g01_two_requests_share_carryover_limit_before_and_after_close() {
    for close in [false, true] {
        let mut w = W::new();
        w.conn.execute("UPDATE policy_versions SET carryover_limit_min=480,carryover_expiry_months=NULL WHERE leave_type_id=?1",[w.carry]).unwrap();
        ledger::post_opening(
            &w.conn,
            w.alexei,
            w.carry,
            2026,
            960,
            d("2026-01-01"),
            "opening",
            None,
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        if close {
            w.set_today("2027-01-01");
            let clock = w.clock();
            let hr = w.actor(w.u_maria);
            ledger::close_period(&mut w.conn, &clock, &hr, w.carry, 2026).unwrap();
        }
        let a = w.submit_leave(w.u_alexei, w.carry, "2027-01-04", "2027-01-04");
        for approved in [false, true] {
            if approved {
                w.approve_all(a);
            }
            let days = nauru_leave::calendar::compute_days(
                &w.conn,
                w.alexei,
                w.carry,
                d("2027-01-05"),
                d("2027-01-05"),
                model::Part::Full,
                model::Part::Full,
            )
            .unwrap();
            assert!(
                ledger::allocate(&w.conn, w.alexei, w.carry, &days, w.today, &BTreeMap::new())
                    .is_err(),
                "second request exceeds limit (close={close},approved={approved})"
            );
        }
    }
}
#[test]
fn g01_released_reservation_and_return_cannot_expand_closed_limit() {
    for returned in [false, true] {
        let mut w = W::new();
        w.conn.execute("UPDATE policy_versions SET carryover_limit_min=480,carryover_expiry_months=NULL WHERE leave_type_id=?1",[w.carry]).unwrap();
        ledger::post_opening(
            &w.conn,
            w.alexei,
            w.carry,
            2026,
            1440,
            d("2026-01-01"),
            "opening",
            None,
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let old = w.submit_leave(w.u_alexei, w.carry, "2026-12-30", "2026-12-30");
        if returned {
            w.approve_all(old);
        }
        w.set_today("2027-01-01");
        let clock = w.clock();
        let hr = w.actor(w.u_maria);
        ledger::close_period(&mut w.conn, &clock, &hr, w.carry, 2026).unwrap();
        if returned {
            let correction = ledger::propose_adjustment(
                &mut w.conn,
                &clock,
                &hr,
                w.alexei,
                w.carry,
                2026,
                480,
                "December day worked",
                "attendance",
                Some(old),
            )
            .unwrap();
            let approver = w.actor(w.u_david);
            ledger::decide_adjustment(&mut w.conn, &clock, &approver, correction, true, "")
                .unwrap();
        } else {
            let owner = w.actor(w.u_alexei);
            let version = w.req(old).version;
            requests::withdraw(&mut w.conn, &clock, &owner, old, None, version).unwrap();
        }
        let a = w.submit_leave(w.u_alexei, w.carry, "2027-01-04", "2027-01-04");
        w.approve_all(a);
        let days = nauru_leave::calendar::compute_days(
            &w.conn,
            w.alexei,
            w.carry,
            d("2027-01-05"),
            d("2027-01-05"),
            model::Part::Full,
            model::Part::Full,
        )
        .unwrap();
        assert!(
            ledger::allocate(&w.conn, w.alexei, w.carry, &days, w.today, &BTreeMap::new()).is_err()
        );
    }
}
#[test]
fn f04_annual_fact_covers_months_after_mode_switch() {
    for legacy in [false, true] {
        let mut w = W::new();
        let clock = w.clock();
        let hr = w.actor(w.u_maria);
        ledger::run_accrual(&mut w.conn, &clock, &hr, w.annual, 2027, None).unwrap();
        if legacy {
            w.conn
                .execute_batch("DROP TRIGGER ledger_no_update")
                .unwrap();
            w.conn.execute("UPDATE ledger_entries SET op_key='accrual:99:'|| (SELECT employee_id FROM leave_accounts WHERE id=account_id) || ':2027' WHERE kind='accrual'",[]).unwrap();
        }
        people::create_policy(
            &w.conn,
            w.annual,
            d("2027-07-01"),
            9600,
            "monthly",
            0,
            true,
            None,
            false,
            "new mode",
            "unverified",
            None,
            "2026-10-08T00:00:00Z",
        )
        .unwrap();
        w.set_today("2027-12-31");
        let hr = w.actor(w.u_maria);
        for m in 7..=12 {
            let run =
                ledger::run_accrual(&mut w.conn, &clock, &hr, w.annual, 2027, Some(m)).unwrap();
            assert_eq!(run.posted, 0, "month {m}, legacy={legacy}");
            assert!(run.skipped_existing > 0);
        }
    }
}
#[test]
fn f11_migration_preserves_policyless_type_conditions() {
    let conn = db::open_memory().unwrap();
    conn.execute_batch(include_str!("../migrations/0001_init.sql"))
        .unwrap();
    conn.execute_batch("INSERT INTO settings VALUES('schema_version','1'); INSERT INTO leave_types(code,name,paid,uses_balance,allow_half_day,requires_attachment,min_notice_days) VALUES('UNPAID','Unpaid',0,0,0,1,12);").unwrap();
    db::migrate(&conn).unwrap();
    let p = model::policy_for(&conn, 1, d("2020-01-01"))
        .unwrap()
        .expect("initial policy");
    assert!(!p.paid && !p.uses_balance && !p.allow_half_day && p.requires_attachment);
    assert_eq!(p.min_notice_days, 12);
    assert_eq!(p.accrual_mode, "none");
    assert_eq!(p.status, "unverified");
    assert_eq!(db::migrate(&conn).unwrap(), 0);
}
#[test]
fn f01_history_excludes_child_proposals_until_approved() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    w.approve_all(id);
    let actor = w.actor(w.u_alexei);
    let clock = w.clock();
    let v = w.req(id).version;
    let input = w.revise(w.annual, "2026-11-09", "2026-11-11", "shorter");
    let child = requests::amend(&mut w.conn, &clock, &actor, id, &input, v, None).unwrap();
    let history = || {
        presentation::detail(&w.conn, &w.actor(w.u_maria), id).unwrap()["revisions"]
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(history(), 1, "pending proposal is not superseded history");
    w.decide_pending(w.u_olga, child.request_id, "recommend_approve", None);
    w.decide_pending(w.u_maria, child.request_id, "checked_ok", None);
    w.decide_pending(
        w.u_elena,
        child.request_id,
        "reject",
        Some("Keep original dates"),
    );
    assert_eq!(
        presentation::detail(&w.conn, &w.actor(w.u_maria), id).unwrap()["revisions"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "rejected proposal is not superseded history"
    );
    let version = w.req(id).version;
    let child = requests::amend(&mut w.conn, &clock, &actor, id, &input, version, None).unwrap();
    w.approve_all(child.request_id);
    assert_eq!(
        presentation::detail(&w.conn, &w.actor(w.u_maria), id).unwrap()["revisions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn f09_hr_cannot_delegate_another_users_authority_to_itself() {
    let mut w = W::new();
    let hr = w.actor(w.u_maria);
    let clock = w.clock();
    for (from, to) in [(w.u_elena, w.u_maria), (w.u_maria, w.u_maria)] {
        assert!(people::create_delegation(
            &mut w.conn,
            &clock,
            &hr,
            from,
            to,
            "final_decision",
            w.today,
            d("2099-12-31"),
            "cover"
        )
        .is_err());
    }
}
#[test]
fn f09_medical_grants_stay_within_granters_medical_scope() {
    let mut w = W::new();
    w.conn
        .execute(
            "UPDATE role_grants SET scope_org_unit_id=?1 WHERE user_id=?2 AND role='hr_medical'",
            params![w.iu, w.u_maria],
        )
        .unwrap();
    let hr = w.actor(w.u_maria);
    let clock = w.clock();
    for scope in [Value::Null, json!(w.csu)] {
        assert!(admin::mutate(
            &mut w.conn,
            &clock,
            &hr,
            Mode::Demo,
            "POST",
            &["users", &w.u_tom.to_string(), "roles"],
            &json!({"role":"hr_medical","scope_org_unit_id":scope})
        )
        .is_err());
    }
    assert!(admin::mutate(
        &mut w.conn,
        &clock,
        &hr,
        Mode::Demo,
        "POST",
        &["users", &w.u_tom.to_string(), "roles"],
        &json!({"role":"hr_medical","scope_org_unit_id":w.iu})
    )
    .is_ok());
}
#[test]
fn f08_delegation_only_session_requires_totp_even_after_login() {
    let mut w = W::new();
    let today = time::OffsetDateTime::now_utc().date();
    let clock = w.clock();
    let hr = w.actor(w.u_maria);
    let token = sessions::create(&mut w.conn, w.u_tom, false, None).unwrap();
    assert!(sessions::load(&w.conn, &token, true).is_ok());
    people::create_delegation(
        &mut w.conn,
        &clock,
        &hr,
        w.u_elena,
        w.u_tom,
        "final_decision",
        today,
        today,
        "cover",
    )
    .unwrap();
    assert!(sessions::load(&w.conn, &token, true).is_err());
    let token = sessions::create(&mut w.conn, w.u_tom, false, None).unwrap();
    assert!(sessions::load(&w.conn, &token, true).is_err());
}
#[test]
fn f07_other_units_export_does_not_replace_day_baseline() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-20", "2026-11-20");
    w.approve_all(id);
    w.conn
        .execute(
            "UPDATE employment_assignments SET valid_to='2026-11-15' WHERE employee_id=?1",
            [w.alexei],
        )
        .unwrap();
    w.conn.execute("INSERT INTO employment_assignments(employee_id,org_unit_id,valid_from) VALUES(?1,?2,'2026-11-16')",params![w.alexei,w.csu]).unwrap();
    let hr = w.actor(w.u_maria);
    let clock = w.clock();
    let a = ie::create_export_scoped(
        &mut w.conn,
        &clock,
        &hr,
        d("2026-11-01"),
        d("2026-11-30"),
        Some(w.csu),
    )
    .unwrap();
    ie::mark_transferred(&mut w.conn, &clock, &hr, a.id, None).unwrap();
    let b = ie::create_export_scoped(
        &mut w.conn,
        &clock,
        &hr,
        d("2026-11-01"),
        d("2026-11-30"),
        Some(w.iu),
    )
    .unwrap();
    ie::mark_transferred(&mut w.conn, &clock, &hr, b.id, None).unwrap();
    assert!(
        ie::changes_since_export_scoped(&w.conn, Some(w.csu))
            .unwrap()
            .is_empty(),
        "unchanged day"
    );
    let owner = w.actor(w.u_alexei);
    let version = w.req(id).version;
    let cancellation = requests::cancel(
        &mut w.conn,
        &clock,
        &owner,
        id,
        d("2026-11-20"),
        d("2026-11-20"),
        "Cancel day",
        version,
        None,
    )
    .unwrap();
    w.approve_all(cancellation.request_id);
    let changes = ie::changes_since_export_scoped(&w.conn, Some(w.csu)).unwrap();
    assert!(changes
        .iter()
        .any(|v| v["request_id"] == id && v["kind"] == "removed"));
}
#[tokio::test]
async fn f06_past_balances_keep_deactivated_staff_and_dated_reservations() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let before = c
        .ok("GET", "/api/reports/balances?date=2026-10-08", json!({}))
        .await;
    let conn = connection(&f, &c);
    conn.execute(
        "UPDATE employees SET active=0,end_date='2026-10-15' WHERE service_id='NPS-1001'",
        [],
    )
    .unwrap();
    assert_eq!(
        c.ok("GET", "/api/reports/balances?date=2026-10-08", json!({}))
            .await,
        before
    );
    let balances = c
        .ok("GET", "/api/balances?date=2026-10-08", json!({}))
        .await;
    assert!(balances["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["employee"]["service_id"] == "NPS-1001"));
    // Seeded Lina request's reserve was created before the report date; release it later.
    conn.execute("UPDATE reservations SET active=0,released_on='2026-10-15' WHERE account_id IN (SELECT id FROM leave_accounts WHERE employee_id=9)",[]).unwrap();
    let explained = c
        .ok(
            "GET",
            "/api/balances/9/explain?date=2026-10-08&leave_type_id=1",
            json!({}),
        )
        .await;
    assert!(!explained["reservations"].as_array().unwrap().is_empty());
}
#[tokio::test]
async fn f12_medical_upload_replays_redacted_receipt_without_view_permission() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("David Hale").await;
    let r=c.ok("POST","/api/requests",json!({"employee_id":8,"source":"paper","paper_received_date":"2026-10-08","leave_type_id":2,"start_date":"2026-11-09","end_date":"2026-11-09"})).await;
    let path = format!("/api/requests/{}/attachments", r["id"]);
    let first = c
        .upload_key(
            &path,
            "medical.pdf",
            b"%PDF-1.4 medical",
            &[("sensitivity", "medical")],
            Some("medical"),
        )
        .await;
    assert_eq!(first.0, 200);
    assert_eq!(first.1["restricted"], true);
    assert_eq!(
        c.upload_key(
            &path,
            "medical.pdf",
            b"%PDF-1.4 medical",
            &[("sensitivity", "medical")],
            Some("medical")
        )
        .await,
        first
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p01_slow_clamd_does_not_block_concurrent_get() {
    use std::io::{Read, Write};
    use std::time::Duration;
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = server.local_addr().unwrap().to_string();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        let mut command = [0; 10];
        stream.read_exact(&mut command).unwrap();
        assert_eq!(&command, b"zINSTREAM\0");
        loop {
            let mut len = [0; 4];
            stream.read_exact(&mut len).unwrap();
            let len = u32::from_be_bytes(len) as usize;
            if len == 0 {
                break;
            }
            let mut data = vec![0; len];
            stream.read_exact(&mut data).unwrap();
        }
        started_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        stream.write_all(b"stream: OK\0").unwrap();
    });
    let f = Fixture::with_scanner(Mode::Production, Some(addr), 5000).await;
    let mut c = f.client();
    let mut conn = connection(&f, &c);
    nauru_leave::seed::seed_template(&mut conn, &f.dir.join("files/main")).unwrap();
    session(&mut c, &mut conn, "Alexei Novak");
    let r = c.annual("2026-11-09", "2026-11-09").await;
    let path = format!("/api/requests/{}/attachments", r["id"]);
    let mut uploader = c.clone();
    let upload = tokio::spawn(async move {
        uploader
            .upload(&path, "test.pdf", b"%PDF-1.4 scanner test", &[])
            .await
    });
    started_rx.await.unwrap();
    let read = tokio::time::timeout(
        Duration::from_millis(300),
        c.call("GET", "/api/me", json!({})),
    )
    .await;
    release_tx.send(()).unwrap();
    assert_eq!(upload.await.unwrap().0, 200);
    thread.join().unwrap();
    assert!(read.is_ok(), "GET waited for clamd");
}

#[test]
fn f04_monthly_fact_prevents_annual_recredit_after_reverse_switch() {
    let mut w = W::new();
    w.conn.execute("UPDATE policy_versions SET accrual_mode='monthly',advance_publish_months=0 WHERE leave_type_id=?1",[w.annual]).unwrap();
    let clock = w.clock();
    let hr = w.actor(w.u_maria);
    let first = ledger::run_accrual(&mut w.conn, &clock, &hr, w.annual, 2026, Some(1)).unwrap();
    assert!(first.posted > 0);
    people::create_policy(
        &w.conn,
        w.annual,
        d("2025-01-01"),
        9600,
        "annual_upfront",
        3,
        true,
        None,
        false,
        "annual mode",
        "unverified",
        None,
        "2026-10-08T00:00:00Z",
    )
    .unwrap();
    let annual = ledger::run_accrual(&mut w.conn, &clock, &hr, w.annual, 2026, None).unwrap();
    assert_eq!(annual.posted, 0);
    assert_eq!(annual.skipped_existing, first.posted);
}
#[test]
fn g01_amendment_reuses_only_its_parent_carryover_allowance() {
    let mut w = W::new();
    w.conn.execute("UPDATE policy_versions SET carryover_limit_min=480,carryover_expiry_months=NULL WHERE leave_type_id=?1",[w.carry]).unwrap();
    ledger::post_opening(
        &w.conn,
        w.alexei,
        w.carry,
        2026,
        1440,
        d("2026-01-01"),
        "opening",
        None,
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    let id = w.submit_leave(w.u_alexei, w.carry, "2027-01-04", "2027-01-04");
    w.approve_all(id);
    let actor = w.actor(w.u_alexei);
    let clock = w.clock();
    let version = w.req(id).version;
    let input = w.revise(w.carry, "2027-01-05", "2027-01-05", "move day");
    let child = requests::amend(&mut w.conn, &clock, &actor, id, &input, version, None).unwrap();
    w.approve_all(child.request_id);
    let days = nauru_leave::calendar::compute_days(
        &w.conn,
        w.alexei,
        w.carry,
        d("2027-01-06"),
        d("2027-01-06"),
        model::Part::Full,
        model::Part::Full,
    )
    .unwrap();
    assert!(
        ledger::allocate(&w.conn, w.alexei, w.carry, &days, w.today, &BTreeMap::new()).is_err()
    );
}
#[test]
fn f08_delegation_only_password_login_requests_second_factor() {
    let mut w = W::new();
    let today = time::OffsetDateTime::now_utc().date();
    let clock = nauru_leave::clock::Clock::production();
    let hr = w.actor(w.u_maria);
    let user = people::create_user(
        &w.conn,
        "delegate@example.test",
        "Delegate",
        Some("test password"),
        &clock.now_ts(),
    )
    .unwrap();
    people::create_delegation(
        &mut w.conn,
        &clock,
        &hr,
        w.u_elena,
        user,
        "final_decision",
        today,
        today,
        "cover",
    )
    .unwrap();
    let (token, needs) = sessions::password_login(
        &mut w.conn,
        &clock,
        "delegate@example.test",
        "test password",
        None,
    )
    .unwrap();
    assert!(needs);
    assert!(sessions::load(&w.conn, &token, true).is_err());
}

#[test]
fn g01_amendment_carryover_delta_shares_limit_without_money_reservation() {
    let mut w = W::new();
    w.conn.execute("UPDATE policy_versions SET carryover_limit_min=480,carryover_expiry_months=NULL WHERE leave_type_id=?1",[w.carry]).unwrap();
    ledger::post_opening(
        &w.conn,
        w.alexei,
        w.carry,
        2026,
        1440,
        d("2026-01-01"),
        "opening",
        None,
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    let parent = w.submit_leave(w.u_alexei, w.carry, "2026-12-30", "2026-12-30");
    w.approve_all(parent);
    let owner = w.actor(w.u_alexei);
    let clock = w.clock();
    let version = w.req(parent).version;
    let input = w.revise(w.carry, "2027-01-04", "2027-01-04", "move into next year");
    let child =
        requests::amend(&mut w.conn, &clock, &owner, parent, &input, version, None).unwrap();
    assert!(
        w.reservations(child.request_id).is_empty(),
        "same account total, no extra money reserve"
    );
    let days = nauru_leave::calendar::compute_days(
        &w.conn,
        w.alexei,
        w.carry,
        d("2027-01-05"),
        d("2027-01-05"),
        model::Part::Full,
        model::Part::Full,
    )
    .unwrap();
    assert!(
        ledger::allocate(&w.conn, w.alexei, w.carry, &days, w.today, &BTreeMap::new()).is_err(),
        "pending amendment already uses the carry-over allowance"
    );
}
