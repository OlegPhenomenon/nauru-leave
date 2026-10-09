mod b_http_support;
mod common;
use axum::http::StatusCode;
use b_http_support::*;
use common::{d, W};
use nauru_leave::{authz, people, requests};
use nauru_leave::{clock::Mode, db, sessions};
use serde_json::{json, Value};
#[test]
fn f08_final_delegate_must_be_able_to_read_the_request_they_must_decide() {
    let mut w = W::new();
    let req_id = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    w.decide_pending(w.u_olga, req_id, "recommend_approve", None);
    w.decide_pending(w.u_maria, req_id, "checked_ok", None);
    let clock = w.clock();
    let principal = w.actor(w.u_elena);
    people::create_delegation(
        &mut w.conn,
        &clock,
        &principal,
        w.u_elena,
        w.u_tom,
        "final_decision",
        w.today,
        d("2026-10-15"),
        "Temporary cover",
    )
    .unwrap();
    let delegate = w.actor(w.u_tom);
    let req = w.req(req_id);
    let ctx = requests::request_ctx(&w.conn, &req, w.today).unwrap();
    let step = w.pending(req_id);
    assert!(authz::decide_authority(&w.conn, &delegate, &ctx, &step).is_ok());
    assert!(
        authz::view_level(&w.conn, &delegate, &ctx).is_ok(),
        "eligible delegate needs a request view"
    );
}

#[test]
fn f10_paper_entry_authorship_must_not_keep_access_after_hr_scope_is_revoked() {
    let mut w = W::new();
    let clock = w.clock();
    let hr = w.actor(w.u_maria);
    let mut input = w.input(w.annual, "2026-11-09", "2026-11-10");
    input.employee_id = Some(w.sam);
    input.paper = true;
    input.paper_received_date = Some(w.today);
    let id = requests::create_draft(&mut w.conn, &clock, &hr, &input).unwrap();
    w.conn
        .execute("DELETE FROM role_grants WHERE user_id=?1", [w.u_maria])
        .unwrap();
    let former_hr = w.actor(w.u_maria);
    let req = w.req(id);
    let ctx = requests::request_ctx(&w.conn, &req, w.today).unwrap();
    assert!(
        authz::view_level(&w.conn, &former_hr, &ctx).is_err(),
        "former HR must lose access"
    );
}

fn connection(f: &Fixture, c: &Client) -> rusqlite::Connection {
    let path = if f.state.config.mode == Mode::Production {
        f.dir.join("main.sqlite")
    } else {
        let id = &c.cookies["nld_sbx"];
        f.dir.join("sandboxes").join(format!("{id}-g1.sqlite"))
    };
    db::open(&path).unwrap()
}
async fn production() -> (Fixture, Client) {
    let f = Fixture::new(Mode::Production).await;
    let mut c = f.client();
    let mut conn = connection(&f, &c);
    nauru_leave::seed::seed_template(&mut conn, &f.dir.join("files/main")).unwrap();
    session(&mut c, &mut conn, "Pavel Grant");
    (f, c)
}
fn session(c: &mut Client, conn: &mut rusqlite::Connection, name: &str) -> i64 {
    let id = conn
        .query_row("SELECT id FROM users WHERE display_name=?1", [name], |r| {
            r.get(0)
        })
        .unwrap();
    let token = sessions::create(conn, id, true, None).unwrap();
    c.csrf = Some(sessions::load(conn, &token, true).unwrap().csrf_token);
    c.cookies.insert("nld_session".into(), token);
    id
}
async fn keyed(c: &mut Client, path: &str, v: Value, key: &str) -> (StatusCode, Value) {
    let (s, v, _) = c
        .raw(
            "POST",
            path,
            v.to_string().into_bytes(),
            "application/json",
            Some(key),
            true,
            Some("http://localhost"),
        )
        .await;
    (s, v)
}
#[tokio::test]
async fn f09_tech_admin_cannot_grant_business_roles() {
    let (f, mut c) = production().await;
    let conn = connection(&f, &c);
    let uid: i64 = conn
        .query_row(
            "SELECT id FROM users WHERE display_name='Pavel Grant'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    for role in [
        "hr",
        "hr_medical",
        "final_approver",
        "adjustment_approver",
        "auditor",
    ] {
        let (s, v) = c
            .call(
                "POST",
                &format!("/api/users/{uid}/roles"),
                json!({"role":role}),
            )
            .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{role}: {v}");
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f12_parallel_adjustment_commands_are_one_intent() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let body = json!({"employee_id":1,"leave_type_id":1,"period_year":2026,"minutes":480,"reason":"Correction","basis_document":"Paper record"});
    let mut other = c.clone();
    // Independent authenticated session; requests run on distinct blocking workers.
    other.login("Maria Santos").await;
    c.login("Maria Santos").await;
    let (a, b) = tokio::join!(
        keyed(&mut c, "/api/adjustments", body.clone(), "one"),
        keyed(&mut other, "/api/adjustments", body.clone(), "one")
    );
    assert_eq!(a.0, StatusCode::OK, "{:?}", a);
    assert_eq!(b.0, StatusCode::OK, "{:?}", b);
    assert_eq!(a.1["id"], b.1["id"], "two results for one command");
    let conn = connection(&f, &c);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM adjustments WHERE reason='Correction'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let mut different = body.clone();
    different["minutes"] = json!(960);
    assert_eq!(
        keyed(&mut c, "/api/adjustments", different, "one").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (s, second) = keyed(&mut c, "/api/adjustments", body, "two").await;
    assert_eq!(s, StatusCode::OK);
    assert_ne!(second["id"], a.1["id"]);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM adjustments WHERE reason='Correction'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE action='adjustment.propose' AND entity_id=?1",
            [a.1["id"].as_i64().unwrap()],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[tokio::test]
async fn p01_production_requires_scanner() {
    let (f, mut c) = production().await;
    let mut conn = connection(&f, &c);
    session(&mut c, &mut conn, "Alexei Novak");
    let r = c.annual("2026-11-09", "2026-11-10").await;
    let (s, v) = c
        .upload(
            &format!("/api/requests/{}/attachments", r["id"]),
            "plain.pdf",
            b"%PDF-1.4 clean",
            &[],
        )
        .await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert_eq!(v["error"]["code"], "scanner_unavailable");
}

#[tokio::test]
async fn f08_http_delegates_have_only_current_step_access() {
    for (stage, principal, outcome) in [
        (0, "Olga Berg", "recommend_approve"),
        (1, "Maria Santos", "checked_ok"),
        (2, "Elena Ward", "approve"),
    ] {
        for ending in ["decide", "revoke", "expire"] {
            let f = Fixture::new(Mode::Demo).await;
            let mut c = f.client();
            c.start().await;
            let owner = c.login("Alexei Novak").await;
            let r = c
                .ok(
                    "POST",
                    "/api/requests",
                    json!({"leave_type_id":2,"start_date":"2026-11-09","end_date":"2026-11-10"}),
                )
                .await;
            let id = r["id"].as_i64().unwrap();
            let path = format!("/api/requests/{id}");
            let (s, file) = c
                .upload(
                    &format!("{path}/attachments"),
                    "normal.pdf",
                    b"%PDF-1.4 normal",
                    &[],
                )
                .await;
            assert_eq!(s, 200);
            let (s, med) = c
                .upload(
                    &format!("{path}/attachments"),
                    "medical.pdf",
                    b"%PDF-1.4 medical",
                    &[("sensitivity", "medical")],
                )
                .await;
            assert_eq!(s, 200);
            c.ok(
                "POST",
                &format!("{path}/submit"),
                json!({"expected_version":r["version"]}),
            )
            .await;
            for (name, result) in [
                ("Olga Berg", "recommend_approve"),
                ("Maria Santos", "checked_ok"),
            ]
            .into_iter()
            .take(stage)
            {
                c.login(name).await;
                let r = c.ok("GET", &path, json!({})).await;
                c.ok("POST",&format!("{path}/decide"),json!({"expected_version":r["version"],"step_id":r["decidable_step"]["id"],"outcome":result})).await;
            }
            let principal_id = c.login(principal).await["user"]["id"].clone();
            let personas = c.ok("GET", "/api/demo/personas", json!({})).await;
            let tom = personas
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["display_name"] == "Tom Reed")
                .unwrap()["user_id"]
                .clone();
            let scope = ["manager_recommendation", "hr_check", "final_decision"][stage];
            let delegation=c.ok("POST","/api/delegations",json!({"from_user_id":principal_id,"to_user_id":tom,"scope":scope,"valid_from":"2026-10-08","valid_to":"2026-10-08","reason":"Cover"})).await;
            // The employee remains prohibited even when the principal delegates to them.
            let owner_id = owner["user"]["id"].clone();
            c.ok("POST","/api/delegations",json!({"from_user_id":principal_id,"to_user_id":owner_id,"scope":scope,"valid_from":"2026-10-08","valid_to":"2026-10-08","reason":"Self test"})).await;
            c.login("Alexei Novak").await;
            let own = c.ok("GET", &path, json!({})).await;
            let step = own["steps"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["status"] == "pending")
                .unwrap()["id"]
                .clone();
            let (s, v) = c
                .call(
                    "POST",
                    &format!("{path}/decide"),
                    json!({"expected_version":own["version"],"step_id":step,"outcome":outcome}),
                )
                .await;
            assert_eq!(s, 403);
            assert_eq!(v["error"]["code"], "self_approval_forbidden");
            c.login("Tom Reed").await;
            let queue = c.ok("GET", "/api/approvals", json!({})).await;
            assert!(
                queue["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["id"] == id),
                "{stage} {queue}"
            );
            let visible = c.ok("GET", &path, json!({})).await;
            assert_eq!(visible["leave_type_name"], "Leave (details restricted)");
            assert_eq!(
                c.call(
                    "GET",
                    &format!("/api/attachments/{}", file["id"]),
                    json!({})
                )
                .await
                .0,
                200
            );
            assert_eq!(
                c.call("GET", &format!("/api/attachments/{}", med["id"]), json!({}))
                    .await
                    .0,
                403
            );
            match ending {
                "decide" => {
                    c.ok("POST",&format!("{path}/decide"),json!({"expected_version":visible["version"],"step_id":visible["decidable_step"]["id"],"outcome":outcome})).await;
                }
                "revoke" => {
                    c.login(principal).await;
                    c.ok(
                        "POST",
                        &format!("/api/delegations/{}/revoke", delegation["id"]),
                        json!({}),
                    )
                    .await;
                    c.login("Tom Reed").await;
                }
                _ => {
                    c.ok("POST", "/api/demo/clock", json!({"date":"2026-10-09"}))
                        .await;
                }
            }
            assert_eq!(
                c.call("GET", &path, json!({})).await.0,
                403,
                "stage {stage} ending {ending}"
            );
            assert_eq!(
                c.call("GET", &format!("{path}/card"), json!({})).await.0,
                403
            );
            assert_eq!(
                c.call(
                    "GET",
                    &format!("/api/attachments/{}", file["id"]),
                    json!({})
                )
                .await
                .0,
                403
            );
            assert!(!c.ok("GET", "/api/approvals", json!({})).await["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["id"] == id));
        }
    }
}

#[tokio::test]
async fn f10_http_former_hr_loses_all_paper_access_and_receipts() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    let hr = c.login("Maria Santos").await;
    let uid = hr["user"]["id"].as_i64().unwrap();
    let employee: i64 = connection(&f, &c)
        .query_row(
            "SELECT id FROM employees WHERE service_id='NPS-1001'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let input = json!({"employee_id":employee,"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-10","source":"paper","paper_received_date":"2026-10-08"});
    let (s, r) = keyed(&mut c, "/api/requests", input.clone(), "paper").await;
    assert_eq!(s, 200);
    let id = r["id"].as_i64().unwrap();
    let path = format!("/api/requests/{id}");
    let (s, file) = c
        .upload_key(
            &format!("{path}/attachments"),
            "paper.pdf",
            b"%PDF-1.4 paper",
            &[],
            Some("paper-file"),
        )
        .await;
    assert_eq!(s, 200);
    let export = c
        .ok(
            "POST",
            "/api/exports",
            json!({"from":"2026-01-01","to":"2026-12-31"}),
        )
        .await;
    let conn = connection(&f, &c);
    conn.execute("DELETE FROM role_grants WHERE user_id=?1", [uid])
        .unwrap();
    for url in [
        path.clone(),
        format!("{path}/card"),
        format!("/api/attachments/{}", file["id"]),
        format!("/api/exports/{}/download", export["id"]),
    ] {
        assert_eq!(c.call("GET", &url, json!({})).await.0, 403, "{url}");
    }
    for url in [
        "/api/requests?scope=all",
        "/api/requests?scope=all&q=Alexei",
        "/api/reports/pending",
    ] {
        let rows = c.ok("GET", url, json!({})).await;
        assert!(!rows["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == id || r["request_id"] == id));
    }
    let search = c.ok("GET", "/api/employees?q=Alexei", json!({})).await;
    assert!(!search["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == employee));
    let (s, _, csv) = c
        .raw(
            "GET",
            "/api/reports/pending?format=csv",
            vec![],
            "application/json",
            None,
            true,
            None,
        )
        .await;
    assert_eq!(s, 200);
    assert!(!String::from_utf8(csv)
        .unwrap()
        .contains(r["number"].as_str().unwrap()));
    assert_eq!(keyed(&mut c, "/api/requests", input, "paper").await.0, 403);
    assert_eq!(
        c.upload_key(
            &format!("{path}/attachments"),
            "paper.pdf",
            b"%PDF-1.4 paper",
            &[],
            Some("paper-file")
        )
        .await
        .0,
        403
    );
    assert_eq!(
        c.call(
            "POST",
            &format!("{path}/submit"),
            json!({"expected_version":r["version"]})
        )
        .await
        .0,
        403
    );
    c.login("Alexei Novak").await;
    c.ok("GET", &path, json!({})).await;
    assert_eq!(
        c.call(
            "GET",
            &format!("/api/attachments/{}", file["id"]),
            json!({})
        )
        .await
        .0,
        200
    );
    c.login("David Hale").await;
    c.ok("GET", &path, json!({})).await;
    c.ok(
        "POST",
        &format!("{path}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
}

#[tokio::test]
async fn f09_http_accounts_linking_and_independent_grants() {
    let (f, mut c) = production().await;
    let mut conn = connection(&f, &c);
    let admin = session(&mut c, &mut conn, "Pavel Grant");
    let another = c
        .ok(
            "POST",
            "/api/users",
            json!({"email":"second@example.org","display_name":"Second"}),
        )
        .await["id"]
        .as_i64()
        .unwrap();
    for target in [admin, another] {
        for role in [
            "hr",
            "hr_medical",
            "final_approver",
            "adjustment_approver",
            "auditor",
        ] {
            assert_eq!(
                c.call(
                    "POST",
                    &format!("/api/users/{target}/roles"),
                    json!({"role":role})
                )
                .await
                .0,
                403
            );
        }
        let users = c.ok("GET", "/api/users", json!({})).await;
        let user = users["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["id"] == target)
            .unwrap();
        assert!(user["allowed"]["grant_roles"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r == "tech_admin"));
        assert_eq!(user["allowed"]["link_employee"], false);
        let employee: i64 = conn
            .query_row(
                "SELECT id FROM employees WHERE service_id='NPS-1001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(c.call("PUT",&format!("/api/users/{target}"),json!({"email":user["email"],"display_name":user["display_name"],"active":true,"employee_id":employee,"expected_version":user["version"]})).await.0,403);
    }
    let principal: i64 = conn
        .query_row(
            "SELECT id FROM users WHERE display_name='Maria Santos'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c.call("POST","/api/delegations",json!({"from_user_id":principal,"to_user_id":admin,"scope":"hr_check","valid_from":"2026-01-01","valid_to":"2027-12-31","reason":"Cover"})).await.0,403);
    let employee: i64 = conn
        .query_row(
            "SELECT id FROM employees WHERE service_id='NPS-1001'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        c.call(
            "POST",
            "/api/users",
            json!({"email":"linked@example.org","display_name":"Linked","employee_id":employee})
        )
        .await
        .0,
        403
    );
    let own = c.annual("2026-11-09", "2026-11-10").await;
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/requests/{}/submit", own["id"]),
            json!({"expected_version":own["version"]})
        )
        .await
        .0,
        200
    );
    c.ok(
        "POST",
        &format!("/api/requests/{}/messages", own["id"]),
        json!({"body":"My leave note"}),
    )
    .await;
    let tech = c
        .ok(
            "POST",
            &format!("/api/users/{another}/roles"),
            json!({"role":"tech_admin"}),
        )
        .await;
    c.ok(
        "DELETE",
        &format!("/api/role-grants/{}", tech["id"]),
        json!({}),
    )
    .await;
    c.ok("PUT",&format!("/api/users/{another}"),json!({"email":"second@example.org","display_name":"Second updated","active":false,"expected_version":1})).await;
    // Account deactivation invalidates an established session.
    let mut other = c.clone();
    conn.execute("UPDATE users SET active=1 WHERE id=?1", [another])
        .unwrap();
    let token = sessions::create(&mut conn, another, true, None).unwrap();
    other.csrf = Some(sessions::load(&conn, &token, true).unwrap().csrf_token);
    other.cookies.insert("nld_session".into(), token);
    c.ok("PUT",&format!("/api/users/{another}"),json!({"email":"second@example.org","display_name":"Second updated","active":false,"expected_version":2})).await;
    assert_eq!(other.call("GET", "/api/me", json!({})).await.0, 401);
    session(&mut c, &mut conn, "David Hale"); // HR without medical grant
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/users/{another}/roles"),
            json!({"role":"hr_medical"})
        )
        .await
        .0,
        403
    );
    let grant = c
        .ok(
            "POST",
            &format!("/api/users/{another}/roles"),
            json!({"role":"hr"}),
        )
        .await;
    session(&mut c, &mut conn, "Pavel Grant");
    assert_eq!(
        c.call(
            "DELETE",
            &format!("/api/role-grants/{}", grant["id"]),
            json!({})
        )
        .await
        .0,
        403
    );
    session(&mut c, &mut conn, "Maria Santos");
    c.ok(
        "POST",
        &format!("/api/users/{another}/roles"),
        json!({"role":"hr_medical"}),
    )
    .await;
    c.ok(
        "DELETE",
        &format!("/api/role-grants/{}", grant["id"]),
        json!({}),
    )
    .await;
    let own_hr: i64 = conn
        .query_row(
            "SELECT id FROM users WHERE display_name='Maria Santos'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/users/{own_hr}/roles"),
            json!({"role":"hr"})
        )
        .await
        .0,
        403
    );
    c.ok("PUT",&format!("/api/users/{another}"),json!({"email":"second@example.org","display_name":"Second updated","active":true,"employee_id":employee,"expected_version":3})).await;
    assert_eq!(c.call("PUT",&format!("/api/users/{another}"),json!({"email":"second@example.org","display_name":"Stale","active":true,"expected_version":3})).await.0,409);
}

#[tokio::test]
async fn f12_replays_draft_decision_actual_upload_and_import() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let draft = json!({"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-10"});
    let (s, r) = keyed(&mut c, "/api/requests", draft.clone(), "draft").await;
    assert_eq!(s, 200);
    let repeat = keyed(&mut c, "/api/requests", draft, "draft").await;
    assert_eq!(repeat.0, 200);
    assert_eq!(repeat.1, r);
    let id = r["id"].as_i64().unwrap();
    let path = format!("/api/requests/{id}");
    let (s, file) = c
        .upload_key(
            &format!("{path}/attachments"),
            "normal.pdf",
            b"%PDF-1.4 content",
            &[],
            Some("upload"),
        )
        .await;
    assert_eq!(s, 200);
    let repeat = c
        .upload_key(
            &format!("{path}/attachments"),
            "normal.pdf",
            b"%PDF-1.4 content",
            &[],
            Some("upload"),
        )
        .await;
    assert_eq!(repeat.0, 200);
    assert_eq!(repeat.1["id"], file["id"]);
    assert_eq!(
        c.upload_key(
            &format!("{path}/attachments"),
            "normal.pdf",
            b"%PDF-1.4 changed",
            &[],
            Some("upload")
        )
        .await
        .0,
        422
    );
    let conn = connection(&f, &c);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM attachments WHERE request_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE action='attachment.upload' AND entity_id=?1",
            [file["id"].as_i64().unwrap()],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    c.ok(
        "POST",
        &format!("{path}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.approve(id).await;
    c.login("Maria Santos").await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2026-11-11"}))
        .await;
    let r = c.ok("GET", &path, json!({})).await;
    let body = json!({"expected_version":r["version"],"action":"propose_adjustment","note":"Worked Monday","basis_document":"Attendance","worked_dates":["2026-11-09"],"minutes_delta":480});
    let a = keyed(&mut c, &format!("{path}/actual"), body.clone(), "actual").await;
    assert_eq!(a.0, 200, "{:?}", a);
    assert_eq!(
        keyed(&mut c, &format!("{path}/actual"), body, "actual").await,
        a
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM adjustments WHERE request_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    let adjust = json!({"employee_id":r["employee"]["id"],"leave_type_id":1,"period_year":2026,"minutes":480,"reason":"Independent correction","basis_document":"Attendance"});
    let (s, a) = keyed(&mut c, "/api/adjustments", adjust, "adjustment").await;
    assert_eq!(s, 200);
    let aid = a["id"].as_i64().unwrap();
    c.login("David Hale").await;
    let decide = json!({"decision":"apply","note":"Checked"});
    let first = keyed(
        &mut c,
        &format!("/api/adjustments/{aid}/decide"),
        decide.clone(),
        "adjustment-decide",
    )
    .await;
    assert_eq!(first.0, 200);
    assert_eq!(
        keyed(
            &mut c,
            &format!("/api/adjustments/{aid}/decide"),
            decide,
            "adjustment-decide"
        )
        .await,
        first
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM ledger_entries WHERE adjustment_id=?1",
            [aid],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT SUM(minutes) FROM ledger_entries WHERE adjustment_id=?1",
            [aid],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        480
    );
    c.login("Maria Santos").await;
    let (s, p) = c
        .upload(
            "/api/imports/preview",
            "opening.csv",
            b"service_id,leave_type,period_year,minutes\nNPS-1001,FAMILY,2025,1200\n",
            &[("kind", "opening_balances")],
        )
        .await;
    assert_eq!(s, 200);
    let import = format!("/api/imports/{}/commit", p["batch_id"]);
    let first = keyed(&mut c, &import, json!({}), "import").await;
    assert_eq!(first.0, 200);
    assert_eq!(first.1["applied"], 1);
    assert_eq!(keyed(&mut c, &import, json!({}), "import").await, first);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM ledger_entries WHERE import_batch_id=?1",
            [p["batch_id"].as_i64().unwrap()],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

fn clamd(reply: &'static [u8], delay: bool) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = server.local_addr().unwrap().to_string();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut command = [0; 10];
        stream.read_exact(&mut command).unwrap();
        assert_eq!(&command, b"zINSTREAM\0");
        let mut content = Vec::new();
        loop {
            let mut length = [0; 4];
            stream.read_exact(&mut length).unwrap();
            let length = u32::from_be_bytes(length) as usize;
            if length == 0 {
                break;
            }
            assert!(length <= 65536);
            let mut chunk = vec![0; length];
            stream.read_exact(&mut chunk).unwrap();
            content.extend(chunk);
        }
        assert_eq!(content, b"%PDF-1.4 scanner test");
        if delay {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        if !reply.is_empty() {
            let _ = stream.write_all(reply);
        }
    });
    (addr, thread)
}
#[tokio::test]
async fn p01_real_instream_verdicts_and_failures_are_enforced() {
    for (reply, delay, status) in [
        (b"stream: OK\0".as_slice(), false, "clean"),
        (b"stream: Test FOUND\0".as_slice(), false, "quarantined"),
        (b"stream: scanner ERROR\0".as_slice(), false, "scan_failed"),
        (b"".as_slice(), false, "scan_failed"),
        (b"stream: OK\0".as_slice(), true, "scan_failed"),
    ] {
        let (addr, thread) = clamd(reply, delay);
        let f = Fixture::with_scanner(Mode::Production, Some(addr), 100).await;
        let mut c = f.client();
        let mut conn = connection(&f, &c);
        nauru_leave::seed::seed_template(&mut conn, &f.dir.join("files/main")).unwrap();
        session(&mut c, &mut conn, "Alexei Novak");
        let r = c.annual("2026-11-09", "2026-11-10").await;
        let (s, file) = c
            .upload(
                &format!("/api/requests/{}/attachments", r["id"]),
                "normal.pdf",
                b"%PDF-1.4 scanner test",
                &[],
            )
            .await;
        assert_eq!(s, 200, "{file}");
        assert_eq!(file["scan_status"], status);
        assert_eq!(file["can_download"], status == "clean");
        let (s, _, bytes) = c
            .raw(
                "GET",
                &format!("/api/attachments/{}", file["id"]),
                vec![],
                "application/json",
                None,
                true,
                None,
            )
            .await;
        assert_eq!(
            s,
            if status == "clean" {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            }
        );
        if status == "clean" {
            assert_eq!(bytes, b"%PDF-1.4 scanner test");
        } else {
            assert!(!bytes.windows(10).any(|x| x == b"%PDF-1.4 s"));
        }
        if status == "scan_failed" {
            assert!(!file["scan_note"].is_null());
        }
        session(&mut c, &mut conn, "Pavel Grant");
        let ops = c.ok("GET", "/api/ops/summary", json!({})).await;
        assert_eq!(ops["scanner"], "ClamAV INSTREAM");
        assert_eq!(
            ops["scan_failed_files"],
            if status == "scan_failed" { 1 } else { 0 }
        );
        thread.join().unwrap();
    }
}
#[tokio::test]
async fn p01_demo_keeps_built_in_scan() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-09", "2026-11-10").await;
    let path = format!("/api/requests/{}/attachments", r["id"]);
    let (s, file) = c.upload(&path, "clean.pdf", b"%PDF-1.4 clean", &[]).await;
    assert_eq!(s, 200);
    assert_eq!(file["scan_status"], "clean");
    let bytes = format!("%PDF-1.4 {}", nauru_leave::files::EICAR);
    let (s, file) = c.upload(&path, "test.pdf", bytes.as_bytes(), &[]).await;
    assert_eq!(s, 200);
    assert_eq!(file["scan_status"], "quarantined");
    assert_eq!(
        c.call(
            "GET",
            &format!("/api/attachments/{}", file["id"]),
            json!({})
        )
        .await
        .0,
        403
    );
    assert_eq!(c.upload(&path, "bad.txt", b"plain text", &[]).await.0, 422);
}

// Regression: the UI's Apply/Reject sends `note: ""`; an empty decision note
// must not be rejected by the endpoint.
#[tokio::test]
async fn adjustment_decide_accepts_an_empty_note() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let adj = c
        .ok(
            "POST",
            "/api/adjustments",
            json!({"employee_id":8,"leave_type_id":1,"period_year":2026,"minutes":60,"reason":"decide-note","basis_document":"doc-1"}),
        )
        .await;
    c.login("David Hale").await;
    c.ok(
        "POST",
        &format!("/api/adjustments/{}/decide", adj["id"].as_i64().unwrap()),
        json!({"decision":"apply","note":""}),
    )
    .await;
    let conn = connection(&f, &c);
    assert_eq!(
        conn.query_row(
            "SELECT status FROM adjustments WHERE id=?1",
            [adj["id"].as_i64().unwrap()],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "applied"
    );
}
