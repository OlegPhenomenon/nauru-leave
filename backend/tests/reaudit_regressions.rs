//! Router regressions for accrual, actual corrections and supporting documents.
mod b_http_support;
use axum::http::StatusCode;
use b_http_support::{Client, Fixture};
use nauru_leave::clock::Mode;
use serde_json::{json, Value};

fn db_for(f: &Fixture, c: &Client) -> rusqlite::Connection {
    nauru_leave::db::open(
        &f.dir
            .join(format!("sandboxes/{}-g1.sqlite", c.cookies["nld_sbx"])),
    )
    .unwrap()
}

async fn post_key(c: &mut Client, path: &str, value: Value, key: &str) -> (StatusCode, Value) {
    let (s, v, _) = c
        .raw(
            "POST",
            path,
            value.to_string().into_bytes(),
            "application/json",
            Some(key),
            true,
            Some("http://localhost"),
        )
        .await;
    (s, v)
}

/// R02: applying the same actual worked date through a NEW user intent must not
/// refund that physical day's leave twice. This is not same-key HTTP replay.
#[tokio::test]
async fn r02_same_worked_day_cannot_refund_twice_with_new_commands() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-09", "2026-11-09").await;
    let id = r["id"].as_i64().unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.approve(id).await;
    c.login("Maria Santos").await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2026-11-10"}))
        .await;
    let path = format!("/api/requests/{id}/actual");
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let body = json!({"expected_version":r["version"],"action":"propose_adjustment",
        "note":"Synthetic attendance correction", "worked_dates":["2026-11-09"],
        "basis_document":"Fictional attendance record"});
    let (s, first) = post_key(&mut c, &path, body, "r02-first-intent").await;
    assert!(s.is_success(), "first correction: {s} {first}");
    c.login("David Hale").await;
    for adjustment in first["adjustment_ids"].as_array().unwrap() {
        c.ok(
            "POST",
            &format!("/api/adjustments/{adjustment}/decide"),
            json!({"decision":"apply","note":"First worked date checked"}),
        )
        .await;
    }
    let conn = db_for(&f, &c);
    let refunded = || -> i64 {
        conn.query_row("SELECT COALESCE(SUM(minutes),0) FROM ledger_entries WHERE request_id=?1 AND kind='adjustment'",
            [id], |row| row.get(0)).unwrap()
    };
    assert_eq!(
        refunded(),
        480,
        "first correction must return the actual day's 480 minutes"
    );

    c.login("Maria Santos").await;
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    // Fresh version + fresh key + fresh note: this is a separate action in the UI.
    let (s, second) = post_key(
        &mut c,
        &path,
        json!({"expected_version":r["version"],
        "action":"propose_adjustment", "note":"A second attempt to correct the same date",
        "worked_dates":["2026-11-09"], "basis_document":"Same fictional attendance record"}),
        "r02-second-distinct-intent",
    )
    .await;
    if s.is_success() {
        // A future implementation may explicitly produce a no-op. If it creates
        // proposals, attempting to apply them must still not double-credit.
        c.login("David Hale").await;
        for adjustment in second["adjustment_ids"].as_array().unwrap() {
            let (ds, result) = c
                .call(
                    "POST",
                    &format!("/api/adjustments/{adjustment}/decide"),
                    json!({"decision":"apply","note":"Second proposal reviewed"}),
                )
                .await;
            assert!(
                ds.is_success()
                    || ds == StatusCode::CONFLICT
                    || ds == StatusCode::UNPROCESSABLE_ENTITY,
                "unexpected failure path: {ds} {result}"
            );
        }
    } else {
        assert!(
            s == StatusCode::CONFLICT || s == StatusCode::UNPROCESSABLE_ENTITY,
            "expected a meaningful duplicate-date conflict, not unrelated failure: {s} {second}"
        );
    }
    assert_eq!(
        refunded(),
        480,
        "one worked date was deducted once: guided actual correction must not return it twice"
    );
}

/// R03: a blocked-only attachment set does not fulfil a mandatory evidence rule.
/// It is acceptable to receive the request provisionally, but final approval must
/// not silently treat the inaccessible file as usable evidence. No actual virus
/// is uploaded: EICAR is the program's existing inert demo-scanner test string.
#[tokio::test]
async fn r03_required_evidence_cannot_be_satisfied_only_by_quarantined_file() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let conn = db_for(&f, &c);
    // Fixture setup only, before the tested application is submitted.
    conn.execute(
        "UPDATE policy_versions SET requires_attachment=1 WHERE leave_type_id=1",
        [],
    )
    .unwrap();
    let r = c.annual("2026-11-09", "2026-11-09").await;
    let id = r["id"].as_i64().unwrap();
    let (missing_status, _) = c
        .call(
            "POST",
            &format!("/api/requests/{id}/submit"),
            json!({"expected_version":r["version"]}),
        )
        .await;
    assert_eq!(
        missing_status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "fixture must actually require an attachment"
    );
    let bytes = format!("%PDF-1.4 {}", nauru_leave::files::EICAR);
    let (us, attachment) = c
        .upload(
            &format!("/api/requests/{id}/attachments"),
            "fictional-scanner-test.pdf",
            bytes.as_bytes(),
            &[],
        )
        .await;
    assert!(
        us.is_success(),
        "upload should be retained in quarantine: {us} {attachment}"
    );
    assert_eq!(attachment["scan_status"], "quarantined");
    let (download, _) = c
        .call(
            "GET",
            &format!("/api/attachments/{}", attachment["id"]),
            json!({}),
        )
        .await;
    assert_eq!(download, StatusCode::FORBIDDEN);
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let (submitted, reply) = c
        .call(
            "POST",
            &format!("/api/requests/{id}/submit"),
            json!({"expected_version":r["version"]}),
        )
        .await;
    if submitted.is_success() {
        for (name, outcome) in [
            ("Olga Berg", "recommend_approve"),
            ("Maria Santos", "checked_ok"),
            ("Elena Ward", "approve"),
        ] {
            c.login(name).await;
            let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
            if r["decidable_step"].is_null() {
                break;
            }
            let (s, v) = c.call("POST", &format!("/api/requests/{id}/decide"),
                json!({"expected_version":r["version"],"step_id":r["decidable_step"]["id"],"outcome":outcome})).await;
            if !s.is_success() {
                assert!(
                    s == StatusCode::UNPROCESSABLE_ENTITY || s == StatusCode::CONFLICT,
                    "unexpected error: {s} {v}"
                );
                break;
            }
        }
    } else {
        assert!(
            submitted == StatusCode::UNPROCESSABLE_ENTITY || submitted == StatusCode::CONFLICT,
            "unexpected refusal: {submitted} {reply}"
        );
    }
    let status: String = conn
        .query_row(
            "SELECT status FROM leave_requests WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(
        status, "approved",
        "the only mandatory attachment is unreadable and no explicit waiver was granted"
    );
}

async fn approved_leave(c: &mut Client, start: &str, end: &str, today: &str) -> i64 {
    c.login("Alexei Novak").await;
    let r = c.annual(start, end).await;
    let id = r["id"].as_i64().unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.approve(id).await;
    c.login("Maria Santos").await;
    c.ok("POST", "/api/demo/clock", json!({"date":today})).await;
    id
}
async fn correction(c: &mut Client, id: i64, dates: &[&str], key: &str) -> (StatusCode, Value) {
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    post_key(c, &format!("/api/requests/{id}/actual"), json!({"expected_version":r["version"],"action":"propose_adjustment","note":key,"worked_dates":dates,"basis_document":"Attendance"}), key).await
}
async fn decide_adjustments(c: &mut Client, proposal: &Value, decision: &str) {
    c.login("David Hale").await;
    for id in proposal["adjustment_ids"].as_array().unwrap() {
        c.ok(
            "POST",
            &format!("/api/adjustments/{id}/decide"),
            json!({"decision":decision,"note":"Attendance checked"}),
        )
        .await;
    }
    c.login("Maria Santos").await;
}
#[tokio::test]
async fn r02_pending_rejected_different_days_and_manual_adjustments() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    let id = approved_leave(&mut c, "2026-11-09", "2026-11-10", "2026-11-11").await;
    let (s, first) = correction(&mut c, id, &["2026-11-09"], "pending-first").await;
    assert!(s.is_success());
    assert_eq!(
        correction(&mut c, id, &["2026-11-09"], "pending-duplicate")
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let detail = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    assert_eq!(detail["actual_corrections"][0]["pending_minutes"], 480);
    let (s, other) = correction(&mut c, id, &["2026-11-10"], "other-day").await;
    assert!(s.is_success());
    decide_adjustments(&mut c, &first, "reject").await;
    let (s, retry) = correction(&mut c, id, &["2026-11-09"], "after-rejection").await;
    assert!(s.is_success());
    decide_adjustments(&mut c, &retry, "apply").await;
    decide_adjustments(&mut c, &other, "apply").await;
    let conn = db_for(&f, &c);
    let refunded: i64 = conn
        .query_row(
            "SELECT SUM(minutes) FROM ledger_entries WHERE request_id=?1 AND kind='adjustment'",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(refunded, 960);
    let employee: i64 = conn
        .query_row(
            "SELECT employee_id FROM leave_requests WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    for key in ["manual-one", "manual-two"] {
        let (s, a) = post_key(&mut c, "/api/adjustments", json!({"employee_id":employee,"leave_type_id":1,"period_year":2026,"minutes":480,"reason":key,"basis_document":"Separate basis","request_id":id}), key).await;
        assert!(s.is_success(), "{s} {a}");
        c.login("David Hale").await;
        c.ok(
            "POST",
            &format!("/api/adjustments/{}/decide", a["id"]),
            json!({"decision":"apply","note":"Independent adjustment"}),
        )
        .await;
        c.login("Maria Santos").await;
    }
}
#[tokio::test]
async fn r02_year_boundary_and_parallel_proposals_reserve_original_minutes() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    c.ok(
        "POST",
        "/api/accruals/run",
        json!({"leave_type_id":1,"period_year":2027}),
    )
    .await;
    let id = approved_leave(&mut c, "2026-12-31", "2027-01-04", "2027-01-05").await;
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let body = json!({"expected_version":r["version"],"action":"propose_adjustment","note":"Parallel intent","worked_dates":["2026-12-31"],"basis_document":"Attendance"});
    let mut other = c.clone();
    let path = format!("/api/requests/{id}/actual");
    let (a, b) = tokio::join!(
        post_key(&mut c, &path, body.clone(), "parallel-one"),
        post_key(&mut other, &path, body, "parallel-two")
    );
    assert_eq!(
        usize::from(a.0.is_success()) + usize::from(b.0.is_success()),
        1
    );
    let first = if a.0.is_success() { a.1 } else { b.1 };
    assert_eq!(
        correction(&mut c, id, &["2026-12-31"], "fresh-pending")
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (s, january) = correction(&mut c, id, &["2027-01-04"], "january-day").await;
    assert!(s.is_success());
    decide_adjustments(&mut c, &first, "apply").await;
    decide_adjustments(&mut c, &january, "apply").await;
    assert_eq!(
        correction(&mut c, id, &["2026-12-31"], "fresh-applied")
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let conn = db_for(&f, &c);
    let totals: Vec<(i64,i64)> = conn.prepare("SELECT la.period_year,SUM(le.minutes) FROM ledger_entries le JOIN leave_accounts la ON la.id=le.account_id WHERE le.request_id=?1 AND le.kind='adjustment' GROUP BY la.period_year ORDER BY la.period_year").unwrap().query_map([id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(totals, vec![(2026, 480), (2027, 480)]);
}
async fn clean_document(c: &mut Client, id: i64) -> i64 {
    let (s, a) = c
        .upload(
            &format!("/api/requests/{id}/attachments"),
            "support.pdf",
            b"%PDF-1.4\nFictional supporting document",
            &[],
        )
        .await;
    assert!(s.is_success(), "{s} {a}");
    assert_eq!(a["scan_status"], "clean");
    a["id"].as_i64().unwrap()
}
async fn decision(c: &mut Client, id: i64, name: &str, outcome: &str) -> (StatusCode, Value) {
    c.login(name).await;
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    c.call("POST", &format!("/api/requests/{id}/decide"), json!({"expected_version":r["version"],"step_id":r["decidable_step"]["id"],"outcome":outcome})).await
}
#[tokio::test]
async fn r03_pending_failed_quarantined_and_lost_clean_gate_frozen_rule() {
    for final_scan in ["pending", "scan_failed", "quarantined"] {
        let f = Fixture::new(Mode::Demo).await;
        let mut c = f.client();
        c.start().await;
        c.login("Alexei Novak").await;
        let conn = db_for(&f, &c);
        conn.execute(
            "UPDATE policy_versions SET requires_attachment=1 WHERE leave_type_id=1",
            [],
        )
        .unwrap();
        let r = c.annual("2026-11-09", "2026-11-09").await;
        let id = r["id"].as_i64().unwrap();
        let file = clean_document(&mut c, id).await;
        if final_scan == "pending" {
            conn.execute(
                "UPDATE attachments SET scan_status='pending' WHERE id=?1",
                [file],
            )
            .unwrap();
        }
        c.ok(
            "POST",
            &format!("/api/requests/{id}/submit"),
            json!({"expected_version":r["version"]}),
        )
        .await;
        conn.execute(
            "UPDATE policy_versions SET requires_attachment=0 WHERE leave_type_id=1",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE attachments SET scan_status=?2 WHERE id=?1",
            rusqlite::params![file, final_scan],
        )
        .unwrap();
        assert!(decision(&mut c, id, "Olga Berg", "recommend_approve")
            .await
            .0
            .is_success());
        assert!(decision(&mut c, id, "Maria Santos", "checked_ok")
            .await
            .0
            .is_success());
        let (s, err) = decision(&mut c, id, "Elena Ward", "approve").await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            err["error"]["message"],
            "A readable supporting document is required"
        );
        let detail = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
        assert_eq!(detail["supporting_document_required"], true);
        assert_eq!(detail["supporting_document_ready"], false);
        assert_ne!(detail["status"], "approved");
        c.login("Alexei Novak").await;
        clean_document(&mut c, id).await;
        assert!(decision(&mut c, id, "Elena Ward", "approve")
            .await
            .0
            .is_success());
    }
}
#[tokio::test]
async fn r03_failed_document_clean_replacement_parent_evidence_and_medical_privacy() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let conn = db_for(&f, &c);
    conn.execute(
        "UPDATE policy_versions SET requires_attachment=1 WHERE leave_type_id=1",
        [],
    )
    .unwrap();
    let r = c.annual("2026-11-09", "2026-11-10").await;
    let id = r["id"].as_i64().unwrap();
    let file = clean_document(&mut c, id).await;
    conn.execute(
        "UPDATE attachments SET scan_status='scan_failed' WHERE id=?1",
        [file],
    )
    .unwrap();
    assert!(!nauru_leave::requests::has_supporting_document(&conn, id, true).unwrap());
    let clean = clean_document(&mut c, id).await;
    conn.execute(
        "UPDATE attachments SET sensitivity='medical' WHERE request_id=?1",
        [id],
    )
    .unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.login("Olga Berg").await;
    let detail = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    assert_eq!(detail["supporting_document_ready"], true);
    for a in detail["attachments"].as_array().unwrap() {
        assert_eq!(a["restricted"], true);
        assert!(a.get("filename").is_none());
    }
    assert_eq!(
        c.call("GET", &format!("/api/attachments/{clean}"), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    c.approve(id).await;
    c.login("Alexei Novak").await;
    let detail = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let amendment = c.ok("POST", &format!("/api/requests/{id}/amend"), json!({"expected_version":detail["version"],"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-09","start_part":"full","end_part":"full","change_reason":"Shorten leave"})).await;
    let amendment_id = amendment["id"].as_i64().unwrap();
    assert!(
        decision(&mut c, amendment_id, "Olga Berg", "recommend_approve")
            .await
            .0
            .is_success()
    );
    assert!(decision(&mut c, amendment_id, "Maria Santos", "checked_ok")
        .await
        .0
        .is_success());
    conn.execute(
        "UPDATE attachments SET scan_status='quarantined' WHERE id=?1",
        [clean],
    )
    .unwrap();
    assert_eq!(
        decision(&mut c, amendment_id, "Elena Ward", "approve")
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    c.login("Alexei Novak").await;
    clean_document(&mut c, id).await;
    assert!(decision(&mut c, amendment_id, "Elena Ward", "approve")
        .await
        .0
        .is_success());
}

#[tokio::test]
async fn r01_first_october_policy_accrues_october_to_december_once() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let t = c
        .ok(
            "POST",
            "/api/leave-types",
            json!({"code":"OCT_MONTH","name":"October monthly demonstration","sensitive":false}),
        )
        .await;
    let id = t["id"].as_i64().unwrap();
    c.ok("POST", &format!("/api/leave-types/{id}/policies"), json!({"valid_from":"2026-10-01","annual_entitlement_min":7200,"accrual_mode":"monthly","advance_publish_months":0,"carryover_allowed":false,"carryover_expiry_months":null,"carryover_limit_min":null,"allow_negative":false,"paid":true,"uses_balance":true,"allow_half_day":true,"requires_attachment":false,"min_notice_days":0,"explanation":"Fictional monthly policy"})).await;
    assert_eq!(
        c.call(
            "POST",
            "/api/accruals/run",
            json!({"leave_type_id":id,"period_year":2026,"month":9})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    c.ok("POST", "/api/demo/clock", json!({"date":"2026-12-01"}))
        .await;
    for month in [10, 11, 12] {
        let body = json!({"leave_type_id":id,"period_year":2026,"month":month});
        let first = c.ok("POST", "/api/accruals/run", body.clone()).await;
        assert!(first["posted"].as_i64().unwrap() > 0);
        let repeat = c.ok("POST", "/api/accruals/run", body).await;
        assert_eq!(repeat["posted"], 0);
        assert_eq!(repeat["skipped_existing"], first["posted"]);
    }
    let conn = db_for(&f, &c);
    let amounts: Vec<i64> = conn.prepare("SELECT le.minutes FROM ledger_entries le JOIN leave_accounts la ON la.id=le.account_id WHERE la.leave_type_id=?1 AND le.kind='accrual'").unwrap().query_map([id],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    assert!(amounts.iter().all(|m| *m == 600));
}

#[tokio::test]
async fn r02_upgrade_recovers_day_links_and_apply_checks_legacy_duplicates() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    let id = approved_leave(&mut c, "2026-11-09", "2026-11-09", "2026-11-10").await;
    let (s, first) = correction(&mut c, id, &["2026-11-09"], "before-upgrade").await;
    assert!(s.is_success());
    let conn = db_for(&f, &c);
    // Reconstruct the previous schema, whose only day links were in the audit.
    conn.execute_batch("DROP TABLE actual_correction_allocations; UPDATE settings SET value='2' WHERE key='schema_version';").unwrap();
    assert_eq!(nauru_leave::db::migrate(&conn).unwrap(), 1);
    assert_eq!(
        correction(&mut c, id, &["2026-11-09"], "after-upgrade")
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let first_id = first["adjustment_ids"][0].as_i64().unwrap();
    // Two older proposals could already exist. Their application is capped too.
    let duplicate: i64 = conn.query_row("INSERT INTO adjustments(account_id,minutes,reason,basis_document,request_id,status,proposed_by,proposed_at) SELECT account_id,minutes,'Older duplicate',basis_document,request_id,status,proposed_by,proposed_at FROM adjustments WHERE id=?1 RETURNING id",[first_id],|r|r.get(0)).unwrap();
    conn.execute("INSERT INTO actual_correction_allocations SELECT ?2,request_id,day_id,date,account_id,minutes FROM actual_correction_allocations WHERE adjustment_id=?1",rusqlite::params![first_id,duplicate]).unwrap();
    decide_adjustments(&mut c, &first, "apply").await;
    c.login("David Hale").await;
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/adjustments/{duplicate}/decide"),
            json!({"decision":"apply","note":"Second older proposal"})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let refunded: i64 = conn
        .query_row(
            "SELECT SUM(minutes) FROM ledger_entries WHERE kind='adjustment' AND request_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(refunded, 480);
}

#[tokio::test]
async fn r02_split_account_rejection_leaves_only_the_uncorrected_part() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let conn = db_for(&f, &c);
    let employee: i64 = conn
        .query_row(
            "SELECT id FROM employees WHERE full_name='Alexei Novak'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    nauru_leave::ledger::post_opening(
        &conn,
        employee,
        1,
        2027,
        240,
        nauru_leave::model::parse_date("2026-10-08").unwrap(),
        "Split account fixture",
        None,
        "2026-10-08T00:00:00Z",
    )
    .unwrap();
    let id = approved_leave(&mut c, "2027-01-04", "2027-01-04", "2027-01-05").await;
    let (s, first) = correction(&mut c, id, &["2027-01-04"], "split-first").await;
    assert!(s.is_success());
    let ids = first["adjustment_ids"].as_array().unwrap();
    assert_eq!(ids.len(), 2);
    c.login("David Hale").await;
    for (index, adjustment) in ids.iter().enumerate() {
        c.ok(
            "POST",
            &format!("/api/adjustments/{adjustment}/decide"),
            json!({"decision":if index==0 {"apply"} else {"reject"},"note":"Partial correction"}),
        )
        .await;
    }
    c.login("Maria Santos").await;
    let (s, remaining) = correction(&mut c, id, &["2027-01-04"], "split-remainder").await;
    assert!(s.is_success());
    assert_eq!(remaining["adjustment_ids"].as_array().unwrap().len(), 1);
    decide_adjustments(&mut c, &remaining, "apply").await;
    let total: i64 = conn
        .query_row(
            "SELECT SUM(minutes) FROM ledger_entries WHERE kind='adjustment' AND request_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(total, 480);
}
