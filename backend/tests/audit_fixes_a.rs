mod common;
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use common::{d, W};
use http_body_util::BodyExt;
use nauru_leave::{
    clock::Mode,
    http::{self, AppState, Config},
};
use nauru_leave::{ledger, model, people, presentation, requests};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};
use tower::ServiceExt;
static IPS: AtomicU32 = AtomicU32::new(1);
#[allow(dead_code)]
struct Fixture {
    dir: PathBuf,
    state: Arc<AppState>,
    router: Router,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
impl Fixture {
    async fn new(mode: Mode) -> Self {
        let dir = std::env::temp_dir().join(format!("nld-http-{}", uuid::Uuid::new_v4()));
        let config = Config {
            mode,
            bind: "127.0.0.1:0".into(),
            data_dir: dir.clone(),
            public_url: "http://localhost".into(),
            max_sandboxes: 300,
            max_db_tasks: 16,
            sandbox_ttl_hours: 24,
            smtp_url: None,
            backup_key_file: None,
            trust_proxy_headers: false,
            requests_per_sec: 30,
            sandbox_creations_per_hour: 5,
            clamd_addr: None,
            clamd_timeout_ms: 10000,
        };
        let state = AppState::new(config).await.unwrap();
        let router = http::router(state.clone());
        Self { dir, state, router }
    }
    fn client(&self) -> Client {
        Client {
            router: self.router.clone(),
            cookies: BTreeMap::new(),
            csrf: None,
        }
    }
}
struct Client {
    router: Router,
    cookies: BTreeMap<String, String>,
    csrf: Option<String>,
}
#[allow(dead_code)]
impl Client {
    #[allow(clippy::too_many_arguments)]
    async fn raw(
        &mut self,
        method: &str,
        path: &str,
        bytes: Vec<u8>,
        content_type: &str,
        key: Option<&str>,
        csrf: bool,
        origin: Option<&str>,
    ) -> (StatusCode, Value, Vec<u8>) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", content_type);
        if let Some(origin) = origin {
            req = req.header("origin", origin);
        }
        if let Some(key) = key {
            req = req.header("idempotency-key", key);
        }
        if csrf {
            if let Some(token) = &self.csrf {
                req = req.header("x-csrf-token", token);
            }
        }
        let cookie = self
            .cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        req = req.header("cookie", cookie);
        let mut req = req.body(Body::from(bytes)).unwrap();
        let ip = IPS.fetch_add(1, Ordering::Relaxed);
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from((
            [10, 1, (ip / 250) as u8, (ip % 250) as u8],
            1000,
        ))));
        let response = self.router.clone().oneshot(req).await.unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            if path.starts_with("/api/") {
                Some("no-store")
            } else {
                response
                    .headers()
                    .get("cache-control")
                    .and_then(|v| v.to_str().ok())
            }
        );
        for cookie in response.headers().get_all("set-cookie") {
            let c = cookie.to_str().unwrap().split(';').next().unwrap();
            if let Some((k, v)) = c.split_once('=') {
                self.cookies.insert(k.into(), v.into());
            }
        }
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json, bytes)
    }
    async fn call(&mut self, method: &str, path: &str, v: Value) -> (StatusCode, Value) {
        let (s, v, _) = self
            .raw(
                method,
                path,
                v.to_string().into_bytes(),
                "application/json",
                None,
                true,
                Some("http://localhost"),
            )
            .await;
        (s, v)
    }
    async fn ok(&mut self, method: &str, path: &str, v: Value) -> Value {
        let (s, v) = self.call(method, path, v).await;
        assert!(s.is_success(), "{method} {path}: {s} {v}");
        v
    }
    async fn start(&mut self) {
        self.ok("POST", "/api/demo/start", json!({})).await;
    }
    async fn login(&mut self, name: &str) -> Value {
        let p = self.ok("GET", "/api/demo/personas", json!({})).await;
        let id = p
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["display_name"].as_str() == Some(name))
            .unwrap()["user_id"]
            .clone();
        let me = self
            .ok("POST", "/api/demo/login", json!({"user_id":id}))
            .await;
        self.csrf = me["csrf_token"].as_str().map(str::to_owned);
        me
    }
    async fn upload(
        &mut self,
        path: &str,
        name: &str,
        bytes: &[u8],
        fields: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut body = Vec::new();
        for (k, v) in fields {
            body.extend(
                format!(
                    "--BOUNDARY\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n"
                )
                .as_bytes(),
            );
        }
        body.extend(format!("--BOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend(bytes);
        body.extend(b"\r\n--BOUNDARY--\r\n");
        let (s, v, _) = self
            .raw(
                "POST",
                path,
                body,
                "multipart/form-data; boundary=BOUNDARY",
                None,
                true,
                Some("http://localhost"),
            )
            .await;
        (s, v)
    }
    async fn annual(&mut self, start: &str, end: &str) -> Value {
        self.ok("POST","/api/requests",json!({"leave_type_id":1,"start_date":start,"end_date":end,"start_part":"full","end_part":"full"})).await
    }
    async fn approve(&mut self, id: i64) -> Value {
        let mut last = Value::Null;
        for (name, outcome) in [
            ("Olga Berg", "recommend_approve"),
            ("Maria Santos", "checked_ok"),
            ("Elena Ward", "approve"),
        ] {
            self.login(name).await;
            let r = self
                .ok("GET", &format!("/api/requests/{id}"), json!({}))
                .await;
            assert!(!r["decidable_step"].is_null(), "{name}: {r}");
            last=self.ok("POST",&format!("/api/requests/{id}/decide"),json!({"expected_version":r["version"],"step_id":r["decidable_step"]["id"],"outcome":outcome})).await;
        }
        last
    }
}

#[test]
fn f04_same_period_new_wording_must_not_credit_full_entitlement_again() {
    let mut w = W::new();
    let clock = w.clock();
    let hr = w.actor(w.u_maria);
    ledger::run_accrual(&mut w.conn, &clock, &hr, w.annual, 2027, None).unwrap();
    let acc = w.account(w.alexei, w.annual, 2027);
    let before = ledger::balance_at(&w.conn, acc, w.today).unwrap();
    assert_eq!(before, 9600);
    people::create_policy(
        &w.conn,
        w.annual,
        w.today,
        9600,
        "annual_upfront",
        3,
        true,
        None,
        false,
        "Same allowance; explanatory wording corrected",
        "demo_fictional",
        Some(w.u_maria),
        "2026-10-08T10:00:00Z",
    )
    .unwrap();
    // A clear refusal or a no-op is acceptable; a second full credit is not.
    let _ = ledger::run_accrual(&mut w.conn, &clock, &hr, w.annual, 2027, None);
    assert_eq!(ledger::balance_at(&w.conn, acc, w.today).unwrap(), before);
}

#[test]
fn f11_future_policy_is_not_an_effective_current_policy() {
    let w = W::new();
    // Only future versions exist for this type.
    w.conn
        .execute(
            "UPDATE policy_versions SET valid_from='2027-01-01' WHERE leave_type_id=?1",
            [w.annual],
        )
        .unwrap();
    assert!(
        model::policy_for(&w.conn, w.annual, d("2026-10-08"))
            .unwrap()
            .is_none(),
        "No current policy is not permission to silently apply a future policy"
    );
}

#[test]
fn f01_in_force_revision_and_parent_are_visible() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    w.approve_all(id);
    let clock = w.clock();
    let actor = w.actor(w.u_alexei);
    let input = nauru_leave::requests::ReviseInput {
        leave_type_id: w.annual,
        start_date: d("2026-11-09"),
        end_date: d("2026-11-11"),
        start_part: model::Part::Full,
        end_part: model::Part::Full,
        note: None,
        change_reason: "Shorter leave".into(),
    };
    let version = w.req(id).version;
    let child = requests::amend(&mut w.conn, &clock, &actor, id, &input, version, None)
        .unwrap()
        .request_id;
    let proposed = presentation::detail(&w.conn, &actor, child).unwrap();
    assert_eq!(proposed["parent_in_force_revision"]["total_minutes"], 2400);
    w.approve_all(child);
    let v = presentation::detail(&w.conn, &actor, id).unwrap();
    assert_eq!(v["total_minutes"], 1440);
    assert_eq!(v["in_force_revision"]["total_minutes"], 1440);
    assert_eq!(v["current_revision"]["total_minutes"], 2400);
    assert_eq!(v["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(v["decisions"].as_array().unwrap().len(), 6);
    assert!(v["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|decision| decision["request"]["id"] == child && decision["outcome"] == "approve"));
}

#[tokio::test]
async fn f02_month_is_validated_by_http() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    // Non-integer month must not be silently treated as absent for annual accrual.
    for month in [json!("5"), json!(0), json!(13)] {
        let (s, v) = c
            .call(
                "POST",
                "/api/accruals/run",
                json!({"leave_type_id":1,"period_year":2027,"month":month}),
            )
            .await;
        assert_eq!(s, 422, "{v}");
    }
}

#[tokio::test]
async fn f03_null_never_and_zero_period_start_remain_distinct() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    for expiry in [Value::Null, json!(0)] {
        let p=c.ok("POST","/api/leave-types/1/policies",json!({"valid_from":"2026-10-08","annual_entitlement_min":9600,"accrual_mode":"annual_upfront","advance_publish_months":3,"carryover_allowed":true,"carryover_expiry_months":expiry,"allow_negative":false,"explanation":"Fictional test"})).await;
        assert_eq!(p["carryover_expiry_months"], expiry);
    }
}

#[tokio::test]
async fn f05_actual_worked_dates_return_original_accounts() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-12-30", "2027-01-05").await;
    let id = r["id"].as_i64().unwrap();
    c.login("Maria Santos").await;
    c.ok(
        "POST",
        "/api/accruals/run",
        json!({"leave_type_id":1,"period_year":2027}),
    )
    .await;
    c.login("Alexei Novak").await;
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.approve(id).await;
    c.login("Maria Santos").await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2027-01-06"}))
        .await;
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let result=c.ok("POST",&format!("/api/requests/{id}/actual"),json!({"expected_version":r["version"],"action":"propose_adjustment","note":"Worked across years","worked_dates":["2026-12-31","2027-01-04"],"basis_document":"attendance","minutes_delta":960})).await;
    let conn = db_for(&f, &c);
    let amounts:Vec<(i64,i64)>=conn.prepare("SELECT la.period_year,a.minutes FROM adjustments a JOIN leave_accounts la ON la.id=a.account_id WHERE a.request_id=?1 ORDER BY la.period_year").unwrap().query_map([id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(amounts, vec![(2026, 480), (2027, 480)]);
    assert_eq!(result["adjustment_ids"].as_array().map(Vec::len), Some(2));

    let ids = result["adjustment_ids"].as_array().unwrap();
    for adjustment in ids {
        assert_eq!(
            c.call(
                "POST",
                &format!("/api/adjustments/{adjustment}/decide"),
                json!({"decision":"apply","note":"Proposer cannot apply"})
            )
            .await
            .0,
            403
        );
    }
    c.login("David Hale").await;
    for adjustment in ids {
        c.ok(
            "POST",
            &format!("/api/adjustments/{adjustment}/decide"),
            json!({"decision":"apply","note":"Attendance checked"}),
        )
        .await;
    }
    let applied:i64=conn.query_row("SELECT SUM(le.minutes) FROM ledger_entries le WHERE le.kind='adjustment' AND le.request_id=?1",[id],|r|r.get(0)).unwrap();
    assert_eq!(applied, 960);
}
fn db_for(f: &Fixture, c: &Client) -> rusqlite::Connection {
    nauru_leave::db::open(
        &f.dir
            .join(format!("sandboxes/{}-g1.sqlite", c.cookies["nld_sbx"])),
    )
    .unwrap()
}

#[tokio::test]
async fn f06_reopened_balance_report_uses_business_reservation_dates() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-09", "2026-11-13").await;
    let id = r["id"].as_i64().unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.login("Maria Santos").await;
    let before = c
        .ok("GET", "/api/reports/balances?date=2026-10-08", json!({}))
        .await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2026-10-09"}))
        .await;
    c.approve(id).await;
    c.login("Maria Santos").await;
    let after = c
        .ok("GET", "/api/reports/balances?date=2026-10-08", json!({}))
        .await;
    let find = |v: Value| {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["service_id"] == "NPS-1001" && r["leave_type_code"] == "ANNUAL")
            .unwrap()
            .clone()
    };
    assert_eq!(find(before), find(after));
}

#[tokio::test]
async fn f07_export_snapshot_survives_later_transfer_and_other_scope() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-23", "2026-11-23").await;
    let id = r["id"].as_i64().unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.approve(id).await;
    c.login("Maria Santos").await;
    let e = c
        .ok(
            "POST",
            "/api/exports",
            json!({"from":"2026-11-01","to":"2026-11-30","org_unit_id":2}),
        )
        .await;
    db_for(&f, &c)
        .execute(
            "UPDATE export_batches SET created_at='2026-10-08T09:00:00Z' WHERE id=?1",
            [e["id"].as_i64().unwrap()],
        )
        .unwrap();
    c.login("Alexei Novak").await;
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let child=c.ok("POST",&format!("/api/requests/{id}/amend"),json!({"expected_version":r["version"],"leave_type_id":1,"start_date":"2026-11-24","end_date":"2026-11-24","change_reason":"Changed dates at 09:05"})).await;
    approve_at(
        &f,
        &c,
        child["id"].as_i64().unwrap(),
        time::macros::datetime!(2026-10-08 09:05 UTC),
    );
    c.login("Maria Santos").await;
    c.ok(
        "POST",
        &format!("/api/exports/{}/mark-transferred", e["id"]),
        json!({"note":"Transferred at 09:10"}),
    )
    .await;
    db_for(&f, &c)
        .execute(
            "UPDATE export_batches SET transferred_at='2026-10-08T09:10:00Z' WHERE id=?1",
            [e["id"].as_i64().unwrap()],
        )
        .unwrap();
    let other = c
        .ok(
            "POST",
            "/api/exports",
            json!({"from":"2026-11-01","to":"2026-11-30","org_unit_id":3}),
        )
        .await;
    c.ok(
        "POST",
        &format!("/api/exports/{}/mark-transferred", other["id"]),
        json!({}),
    )
    .await;
    let changes = c
        .ok(
            "GET",
            "/api/reports/changes-since-export?org_unit_id=2",
            json!({}),
        )
        .await;
    let rows = changes["items"].as_array().unwrap();
    assert!(
        rows.iter()
            .any(|r| r["date"] == "2026-11-23" && r["kind"] == "removed"),
        "{changes}"
    );
    assert!(
        rows.iter()
            .any(|r| r["date"] == "2026-11-24" && r["kind"] == "new"),
        "{changes}"
    );
}

#[tokio::test]
async fn f11_settings_reject_stale_version() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let (s, v) = c
        .call(
            "PUT",
            "/api/leave-types/1",
            json!({"expected_version":999,"code":"ANNUAL","name":"Changed"}),
        )
        .await;
    assert_eq!(s, 409, "{v}");
    assert_eq!(v["error"]["code"], "stale_version");
}

#[tokio::test]
async fn f11_submitted_conditions_are_frozen_and_future_is_not_used() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-23", "2026-11-23").await;
    let id = r["id"].as_i64().unwrap();
    let r = c
        .ok(
            "POST",
            &format!("/api/requests/{id}/submit"),
            json!({"expected_version":r["version"]}),
        )
        .await;
    assert_eq!(r["current_revision"]["policy_snapshot"]["paid"], true);
    c.login("Maria Santos").await;
    c.ok("POST","/api/leave-types/1/policies",json!({"valid_from":"2027-01-01","annual_entitlement_min":9600,"accrual_mode":"annual_upfront","advance_publish_months":3,"carryover_allowed":true,"paid":false,"uses_balance":false,"allow_half_day":false,"requires_attachment":true,"min_notice_days":30,"explanation":"Fictional future conditions"})).await;
    let types = c.ok("GET", "/api/leave-types", json!({})).await;
    let t = types
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == 1)
        .unwrap();
    assert_eq!(t["paid"], true);
    let old = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    assert_eq!(
        old["current_revision"]["policy_snapshot"],
        r["current_revision"]["policy_snapshot"]
    );
}

#[tokio::test]
async fn f13_revoke_used_exception_keeps_frozen_days() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let ex = c
        .ok(
            "POST",
            "/api/calendar-exceptions",
            json!({"date":"2026-11-24","name":"Fictional holiday","minutes":0}),
        )
        .await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-23", "2026-11-25").await;
    let id = r["id"].as_i64().unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.login("Maria Santos").await;
    let (status, error) = c
        .call(
            "DELETE",
            &format!("/api/calendar-exceptions/{}", ex["id"]),
            json!({}),
        )
        .await;
    assert_eq!(status, 404, "{error}");
    let (s, v) = c
        .call(
            "POST",
            &format!("/api/calendar-exceptions/{}/revoke", ex["id"]),
            json!({"reason":"Holiday withdrawn"}),
        )
        .await;
    assert_eq!(s, 200, "{v}");
    assert!(!v["affected_future_requests"].as_array().unwrap().is_empty());
    let old = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    assert_eq!(old["current_revision"]["total_minutes"], 960);
    c.login("Tom Reed").await;
    let preview = c
        .ok(
            "POST",
            "/api/requests/preview",
            json!({"leave_type_id":1,"start_date":"2026-11-24","end_date":"2026-11-24"}),
        )
        .await;
    assert_eq!(preview["total_minutes"], 480);
}

#[tokio::test]
async fn g01_carryover_limit_expires_excess_once() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    c.ok("POST","/api/leave-types/1/policies",json!({"valid_from":"2026-10-08","annual_entitlement_min":9600,"accrual_mode":"annual_upfront","advance_publish_months":3,"carryover_allowed":true,"carryover_expiry_months":null,"carryover_limit_min":480,"explanation":"Fictional limit"})).await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2027-01-01"}))
        .await;
    let close = c
        .ok(
            "POST",
            "/api/periods/close",
            json!({"leave_type_id":1,"period_year":2026}),
        )
        .await;
    assert!(close["posted"].as_i64().unwrap() > 0, "{close}");
    let conn = db_for(&f, &c);
    let account:i64=conn.query_row("SELECT id FROM leave_accounts WHERE employee_id=(SELECT id FROM employees WHERE service_id='NPS-1001') AND leave_type_id=1 AND period_year=2026",[],|r|r.get(0)).unwrap();
    assert_eq!(
        ledger::balance_at(&conn, account, d("2027-01-01")).unwrap(),
        480
    );
    let again = c
        .ok(
            "POST",
            "/api/periods/close",
            json!({"leave_type_id":1,"period_year":2026}),
        )
        .await;
    assert_eq!(again["posted"], 0);
}

fn approve_at(f: &Fixture, c: &Client, id: i64, at: time::OffsetDateTime) {
    let mut conn = db_for(f, c);
    let clock = nauru_leave::clock::Clock::fixed_at(d("2026-10-08"), at);
    for (name, outcome) in [
        ("Olga Berg", "recommend_approve"),
        ("Maria Santos", "checked_ok"),
        ("Elena Ward", "approve"),
    ] {
        let user = conn
            .query_row("SELECT id FROM users WHERE display_name=?1", [name], |r| {
                r.get(0)
            })
            .unwrap();
        let actor = nauru_leave::authz::Actor::load(&conn, user, d("2026-10-08")).unwrap();
        let request = model::load_request(&conn, id).unwrap();
        let step = requests::pending_step(&conn, id).unwrap().unwrap();
        requests::decide(
            &mut conn,
            &clock,
            &actor,
            id,
            step.id,
            outcome,
            None,
            None,
            request.version,
            None,
        )
        .unwrap();
    }
}

#[tokio::test]
async fn f02_monthly_http_requires_month_and_preserves_fact() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let policy = json!({"valid_from":"2026-01-01","annual_entitlement_min":7200,"accrual_mode":"monthly","advance_publish_months":0,"carryover_allowed":false,"explanation":"Fictional monthly rule"});
    c.ok("POST", "/api/leave-types/3/policies", policy.clone())
        .await;
    for month in [Value::Null, json!(0), json!(13), json!("1")] {
        assert_eq!(
            c.call(
                "POST",
                "/api/accruals/run",
                json!({"leave_type_id":3,"period_year":2026,"month":month})
            )
            .await
            .0,
            422
        );
    }
    let first = c
        .ok(
            "POST",
            "/api/accruals/run",
            json!({"leave_type_id":3,"period_year":2026,"month":9}),
        )
        .await;
    assert_eq!(first["posted"], 13);
    c.ok("POST", "/api/leave-types/3/policies", policy).await;
    let replay = c
        .ok(
            "POST",
            "/api/accruals/run",
            json!({"leave_type_id":3,"period_year":2026,"month":9}),
        )
        .await;
    assert_eq!(replay["posted"], 0);
    assert_eq!(replay["skipped_existing"], 13);
    let conn = db_for(&f, &c);
    let sum: i64 = conn
        .query_row(
            "SELECT SUM(minutes) FROM ledger_entries WHERE op_key LIKE 'accrual:%:3:2026-09'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sum, 13 * 600);
}

#[test]
fn f04_legacy_policy_key_is_already_accrued() {
    let mut w = W::new();
    let acc = w.account(w.alexei, w.annual, 2027);
    let old_policy = model::policy_for(&w.conn, w.annual, w.today)
        .unwrap()
        .unwrap();
    ledger::post_entry(
        &w.conn,
        &ledger::PostEntry {
            account_id: acc,
            minutes: 9600,
            kind: "accrual",
            effective_date: w.today,
            request_id: None,
            revision_id: None,
            reverses_entry_id: None,
            adjustment_id: None,
            import_batch_id: None,
            basis: "Legacy annual accrual".into(),
            author_user_id: Some(w.u_maria),
            op_key: format!("accrual:{}:{}:2027", old_policy.id, w.alexei),
        },
        "2026-10-08T09:00:00Z",
    )
    .unwrap();
    let clock = w.clock();
    let actor = w.actor(w.u_maria);
    let run = ledger::run_accrual(&mut w.conn, &clock, &actor, w.annual, 2027, None).unwrap();
    assert_eq!(run.skipped_existing, 1);
    assert_eq!(ledger::balance_at(&w.conn, acc, w.today).unwrap(), 9600);
}

#[tokio::test]
async fn f06_absence_history_includes_inactive_employee_and_day_assignment() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-23", "2026-11-24").await;
    let id = r["id"].as_i64().unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.approve(id).await;
    let conn = db_for(&f, &c);
    let employee: i64 = conn
        .query_row(
            "SELECT employee_id FROM leave_requests WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute("UPDATE employment_assignments SET valid_to='2026-11-23' WHERE employee_id=?1 AND valid_to IS NULL",[employee]).unwrap();
    people::assign(&conn, employee, 3, None, d("2026-11-24")).unwrap();
    conn.execute(
        "UPDATE employees SET active=0,end_date='2026-11-24' WHERE id=?1",
        [employee],
    )
    .unwrap();
    c.login("Maria Santos").await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2026-12-01"}))
        .await;
    for (unit, date) in [(2, "2026-11-23"), (3, "2026-11-24")] {
        let report = c
            .ok(
                "GET",
                &format!("/api/reports/absences?from=2026-11-23&to=2026-11-24&org_unit_id={unit}"),
                json!({}),
            )
            .await;
        let rows = report["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["request_id"] == id)
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1, "{report}");
        assert_eq!(rows[0]["date"], date);
        assert_eq!(rows[0]["minutes"], 480);
    }
}

#[test]
fn f03_expiry_zero_and_never_have_different_business_effects() {
    for (expiry, expected) in [(None, 960), (Some(0), 0)] {
        let mut w = W::new();
        w.conn
            .execute(
                "UPDATE policy_versions SET carryover_expiry_months=?2 WHERE leave_type_id=?1",
                rusqlite::params![w.carry, expiry],
            )
            .unwrap();
        let account = w.account(w.alexei, w.carry, 2026);
        ledger::post_opening(
            &w.conn,
            w.alexei,
            w.carry,
            2026,
            960,
            d("2026-01-01"),
            "Test opening",
            None,
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        w.set_today("2027-01-01");
        let clock = w.clock();
        let actor = w.actor(w.u_maria);
        ledger::close_period(&mut w.conn, &clock, &actor, w.carry, 2026).unwrap();
        assert_eq!(
            ledger::balance_at(&w.conn, account, w.today).unwrap(),
            expected
        );
    }
}

#[test]
fn g01_limit_reservation_expiry_and_late_return() {
    let mut w = W::new();
    w.conn.execute("UPDATE policy_versions SET carryover_limit_min=480,carryover_expiry_months=3 WHERE leave_type_id=?1",[w.carry]).unwrap();
    ledger::post_opening(
        &w.conn,
        w.alexei,
        w.carry,
        2026,
        1440,
        d("2026-01-01"),
        "Test opening",
        None,
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    let account = w.account(w.alexei, w.carry, 2026);
    let request = w.submit_leave(w.u_alexei, w.carry, "2027-01-04", "2027-01-04");
    assert_eq!(ledger::reserved(&w.conn, account).unwrap(), 480);
    w.set_today("2027-01-01");
    let actor = w.actor(w.u_maria);
    let clock = w.clock();
    assert_eq!(
        ledger::close_period(&mut w.conn, &clock, &actor, w.carry, 2026).unwrap(),
        1
    );
    assert_eq!(ledger::balance_at(&w.conn, account, w.today).unwrap(), 960);
    assert_eq!(
        ledger::close_period(&mut w.conn, &clock, &actor, w.carry, 2026).unwrap(),
        0
    );
    w.approve_all(request);
    assert_eq!(ledger::balance_at(&w.conn, account, w.today).unwrap(), 480);
    w.set_today("2027-04-01");
    let actor = w.actor(w.u_maria);
    let clock = w.clock();
    assert_eq!(
        ledger::close_period(&mut w.conn, &clock, &actor, w.carry, 2026).unwrap(),
        1
    );
    assert_eq!(ledger::balance_at(&w.conn, account, w.today).unwrap(), 0);
    let adjustment = ledger::propose_adjustment(
        &mut w.conn,
        &clock,
        &actor,
        w.alexei,
        w.carry,
        2026,
        480,
        "Old leave correction",
        "attendance",
        Some(request),
    )
    .unwrap();
    let decider = w.actor(w.u_david);
    ledger::decide_adjustment(&mut w.conn, &clock, &decider, adjustment, true, "Apply").unwrap();
    assert_eq!(ledger::balance_at(&w.conn, account, w.today).unwrap(), 480);
    // A later rule cannot resurrect an expired account's returned minutes.
    people::create_policy(
        &w.conn,
        w.carry,
        w.today,
        0,
        "none",
        0,
        true,
        None,
        false,
        "Fictional later rule",
        "demo_fictional",
        None,
        "2027-04-01T09:00:00Z",
    )
    .unwrap();
    let days = nauru_leave::calendar::compute_days(
        &w.conn,
        w.alexei,
        w.carry,
        d("2027-04-05"),
        d("2027-04-05"),
        model::Part::Full,
        model::Part::Full,
    )
    .unwrap();
    assert!(
        ledger::allocate(&w.conn, w.alexei, w.carry, &days, w.today, &BTreeMap::new()).is_err()
    );
}

#[test]
fn migration_keeps_legacy_rows_and_export_contents() {
    let conn = nauru_leave::db::open_memory().unwrap();
    conn.execute_batch(include_str!("../migrations/0001_init.sql"))
        .unwrap();
    conn.execute_batch("INSERT INTO settings VALUES('schema_version','1');
        INSERT INTO settings VALUES('demo_today','2026-10-08');
        INSERT INTO users(id,email,display_name,created_at) VALUES(1,'test@example.test','Test HR','2025-01-01T00:00:00Z');
        INSERT INTO org_units VALUES(1,'TEST','Test unit',NULL,1);
        INSERT INTO role_grants(user_id,role,valid_from,created_at) VALUES(1,'hr','2025-01-01','2025-01-01T00:00:00Z');
        INSERT INTO schedules VALUES(1,'Test week');
        INSERT INTO schedule_versions(id,schedule_id,valid_from,mon_min,tue_min,wed_min,thu_min,fri_min,sat_min,sun_min) VALUES(1,1,'2025-01-01',480,480,480,480,480,0,0);
        INSERT INTO employees(id,service_id,full_name,user_id,start_date,created_at) VALUES(1,'T1','Test person',1,'2025-01-01','2025-01-01T00:00:00Z');
        INSERT INTO employment_assignments(employee_id,org_unit_id,valid_from) VALUES(1,1,'2025-01-01');
        INSERT INTO employee_schedules(employee_id,schedule_id,valid_from) VALUES(1,1,'2025-01-01');
        INSERT INTO leave_types(id,code,name,paid,allow_half_day) VALUES(1,'TEST','Test leave',0,0);
        INSERT INTO policy_versions(id,leave_type_id,valid_from,accrual_mode,carryover_allowed,carryover_expiry_months,explanation,status,created_at) VALUES(1,1,'2025-01-01','none',1,NULL,'Test never expiry','unverified','2025-01-01T00:00:00Z'),(2,1,'2027-01-01','none',1,0,'Test zero expiry','unverified','2026-10-01T00:00:00Z');
        INSERT INTO calendar_exceptions(id,date,name,minutes,schedule_id,created_at) VALUES(1,'2026-11-24','Test holiday',0,1,'2026-10-01T00:00:00Z');
        INSERT INTO leave_requests(id,number,employee_id,kind,status,source,entered_by_user_id,created_at,updated_at) VALUES(1,'T-1',1,'leave','approved','self',1,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
        INSERT INTO request_revisions(id,request_id,rev_no,leave_type_id,start_date,end_date,total_minutes,created_by,created_at,submitted_at) VALUES(1,1,1,1,'2026-11-23','2026-11-24',480,1,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
        UPDATE leave_requests SET current_revision_id=1,effective_revision_id=1 WHERE id=1;
        INSERT INTO request_days(id,revision_id,date,part,scheduled_minutes,minutes,schedule_version_id,exception_id,period_year,explanation) VALUES(1,1,'2026-11-23','full',480,480,1,NULL,2026,'Test working day'),(2,1,'2026-11-24','none',0,0,1,1,2026,'Test holiday');
        INSERT INTO leave_accounts VALUES(1,1,1,2026);
        INSERT INTO ledger_entries(account_id,minutes,kind,effective_date,basis,op_key,created_at) VALUES(1,9600,'opening','2026-01-01','Test opening','opening:1:1:2026','2026-01-01T00:00:00Z');
        INSERT INTO reservations(request_id,revision_id,account_id,minutes,active,created_at,released_at) VALUES(1,1,1,480,0,'2026-10-01T00:00:00Z','2026-10-02T00:00:00Z');").unwrap();
    let csv=b"employee_service_id,request_number,revision_no,leave_type_code,date,minutes,period_year,decision_at\nT1,T-1,1,TEST,2026-11-23,480,2026,\n";
    conn.execute("INSERT INTO export_batches(kind,period_from,period_to,row_count,sha256,content,created_by,created_at,transferred_by,transferred_at) VALUES('approved_leave_transfer','2026-11-01','2026-11-30',1,'test',?1,1,'2026-10-03T09:00:00Z',1,'2026-10-03T09:10:00Z')",[csv.as_slice()]).unwrap();
    assert_eq!(nauru_leave::db::migrate(&conn).unwrap(), 1);
    assert_eq!(nauru_leave::db::migrate(&conn).unwrap(), 0);
    let expiry: Vec<Option<i64>> = conn
        .prepare("SELECT carryover_expiry_months FROM policy_versions ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(expiry, vec![None, Some(0)]);
    assert_eq!(ledger::balance_at(&conn, 1, d("2026-10-08")).unwrap(), 9600);
    assert_eq!(ledger::reserved_at(&conn, 1, d("2026-10-01")).unwrap(), 480);
    assert_eq!(ledger::reserved_at(&conn, 1, d("2026-10-02")).unwrap(), 0);
    assert!(nauru_leave::imports_exports::changes_since_export(&conn)
        .unwrap()
        .is_empty());
    assert!(!model::revision_leave_type(&conn, 1).unwrap().paid);
    assert!(!model::revision_leave_type(&conn, 1).unwrap().allow_half_day);
    let actor = nauru_leave::authz::Actor::load(&conn, 1, d("2026-10-08")).unwrap();
    let mut conn = conn;
    nauru_leave::admin::mutate(
        &mut conn,
        &nauru_leave::clock::Clock::demo(),
        &actor,
        Mode::Demo,
        "POST",
        &["calendar-exceptions", "1", "revoke"],
        &json!({"reason":"Test revocation"}),
    )
    .unwrap();
    let new = people::create_calendar_exception(
        &conn,
        d("2026-11-24"),
        "New test exception",
        480,
        Some(1),
        "2026-10-08T10:00:00Z",
    )
    .unwrap();
    assert_ne!(new, 1);
    assert_eq!(
        model::revision_days(&conn, 1).unwrap()[1].exception_id,
        Some(1)
    );
    assert!(!conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert_eq!(
        conn.pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn g01_carryover_below_limit_and_unlimited_returns() {
    for (limit, opening, expected) in [
        (Some(480), 240, 240),
        (Some(480), 960, 480),
        (None, 960, 960),
    ] {
        let mut w = W::new();
        w.conn.execute("UPDATE policy_versions SET carryover_limit_min=?2,carryover_expiry_months=NULL WHERE leave_type_id=?1",rusqlite::params![w.carry,limit]).unwrap();
        ledger::post_opening(
            &w.conn,
            w.alexei,
            w.carry,
            2026,
            opening,
            d("2026-01-01"),
            "Test opening",
            None,
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let account = w.account(w.alexei, w.carry, 2026);
        w.set_today("2027-01-01");
        let clock = w.clock();
        let actor = w.actor(w.u_maria);
        ledger::close_period(&mut w.conn, &clock, &actor, w.carry, 2026).unwrap();
        assert_eq!(
            ledger::balance_at(&w.conn, account, w.today).unwrap(),
            expected
        );
        let adjustment = ledger::propose_adjustment(
            &mut w.conn,
            &clock,
            &actor,
            w.alexei,
            w.carry,
            2026,
            480,
            "Old leave returned",
            "attendance",
            None,
        )
        .unwrap();
        let decider = w.actor(w.u_david);
        ledger::decide_adjustment(&mut w.conn, &clock, &decider, adjustment, true, "Apply")
            .unwrap();
        let days = nauru_leave::calendar::compute_days(
            &w.conn,
            w.alexei,
            w.carry,
            d("2027-01-04"),
            d("2027-01-05"),
            model::Part::Full,
            model::Part::Full,
        )
        .unwrap();
        let allocation =
            ledger::allocate(&w.conn, w.alexei, w.carry, &days, w.today, &BTreeMap::new());
        assert_eq!(allocation.is_ok(), limit.is_none());
    }
}

#[tokio::test]
async fn f11_settings_versions_increment_and_conflict_without_overwrite() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let unit = c
        .ok(
            "POST",
            "/api/org-units",
            json!({"code":"VERSION","name":"Version unit"}),
        )
        .await;
    let changed = c
        .ok(
            "PUT",
            &format!("/api/org-units/{}", unit["id"]),
            json!({"expected_version":unit["version"],"code":"VERSION","name":"First edit"}),
        )
        .await;
    assert_eq!(changed["version"], 2);
    let (status, v) = c
        .call(
            "PUT",
            &format!("/api/org-units/{}", unit["id"]),
            json!({"expected_version":unit["version"],"code":"VERSION","name":"Stale edit"}),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(v["error"]["code"], "stale_version");
    let units = c.ok("GET", "/api/org-units", json!({})).await;
    assert!(units["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == unit["id"] && row["name"] == "First edit" && row["version"] == 2));
    for (method, path, body) in [
        (
            "PUT",
            "/api/employees/8",
            json!({"expected_version":999,"full_name":"Stale employee"}),
        ),
        (
            "POST",
            "/api/employees/8/schedule",
            json!({"expected_version":999,"schedule_id":1,"valid_from":"2026-11-01"}),
        ),
        (
            "POST",
            "/api/schedules/1/versions",
            json!({"expected_version":999,"valid_from":"2026-11-01","week":[480,480,480,480,480,0,0]}),
        ),
    ] {
        let (status, v) = c.call(method, path, body).await;
        assert_eq!(status, 409, "{v}");
        assert_eq!(v["error"]["code"], "stale_version");
    }
    c.login("Pavel Grant").await;
    let (status, v) = c
        .call(
            "PUT",
            "/api/users/1",
            json!({"expected_version":999,"email":"changed@example.test","display_name":"Changed"}),
        )
        .await;
    assert_eq!(status, 409, "{v}");
    assert_eq!(v["error"]["code"], "stale_version");
}

#[tokio::test]
async fn f11_future_only_policy_fails_preview_and_submit_over_http() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let leave = c
        .ok(
            "POST",
            "/api/leave-types",
            json!({"code":"FUTURE","name":"Future test leave"}),
        )
        .await;
    c.ok("POST",&format!("/api/leave-types/{}/policies",leave["id"]),json!({"valid_from":"2027-01-01","annual_entitlement_min":0,"accrual_mode":"none","advance_publish_months":0,"carryover_allowed":false,"uses_balance":false,"explanation":"Fictional future policy"})).await;
    c.login("Alexei Novak").await;
    let input =
        json!({"leave_type_id":leave["id"],"start_date":"2026-11-23","end_date":"2026-11-23"});
    let (status, v) = c.call("POST", "/api/requests/preview", input.clone()).await;
    assert_eq!(status, 422, "{v}");
    assert_eq!(v["error"]["code"], "no_policy");
    let draft = c.ok("POST", "/api/requests", input).await;
    let (status, v) = c
        .call(
            "POST",
            &format!("/api/requests/{}/submit", draft["id"]),
            json!({"expected_version":draft["version"]}),
        )
        .await;
    assert_eq!(status, 422, "{v}");
    assert_eq!(v["error"]["code"], "no_policy");
}

#[test]
fn f11_sensitive_snapshot_does_not_unmask_old_material() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.sick, "2026-11-02", "2026-11-03");
    w.approve_all(id);
    w.conn
        .execute("UPDATE leave_types SET sensitive=0 WHERE id=?1", [w.sick])
        .unwrap();
    let actor = w.actor(w.u_olga);
    let v = presentation::detail(&w.conn, &actor, id).unwrap();
    assert_eq!(v["leave_type_name"], "Leave (details restricted)");
    assert_eq!(v["current_revision"]["leave_type"], Value::Null);
    assert_eq!(v["current_revision"]["policy_snapshot"], Value::Null);
    let ctx = requests::request_ctx(&w.conn, &w.req(id), w.today).unwrap();
    assert!(ctx.sensitive_type);
}

#[test]
fn migration_upgrades_legacy_demo_template_with_request_history() {
    let tmp = common::TmpDir::new("legacy-template");
    let path = tmp.path().join("source.sqlite");
    nauru_leave::seed::build_template(&path, &tmp.path().join("files")).unwrap();
    let source = nauru_leave::db::open(&path).unwrap();
    let legacy = nauru_leave::db::open_memory().unwrap();
    legacy
        .execute_batch(include_str!("../migrations/0001_init.sql"))
        .unwrap();
    legacy
        .execute("ATTACH DATABASE ?1 AS src", [path.to_str().unwrap()])
        .unwrap();
    legacy.pragma_update(None, "foreign_keys", "OFF").unwrap();
    legacy.execute_batch("BEGIN IMMEDIATE").unwrap();
    let tables = presentation::rows(
        &legacy,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        &[],
    )
    .unwrap();
    for table in tables {
        let name = table["name"].as_str().unwrap();
        let columns =
            presentation::rows(&legacy, &format!("PRAGMA table_info({name})"), &[]).unwrap();
        let names = columns
            .iter()
            .map(|row| row["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        let expressions=names.iter().map(|column|{
            if name=="leave_types" && ["paid","uses_balance","allow_half_day","requires_attachment","min_notice_days"].contains(column) {
                format!("(SELECT {column} FROM src.policy_versions p WHERE p.leave_type_id=t.id ORDER BY p.id LIMIT 1)")
            } else {format!("t.{column}")}
        }).collect::<Vec<_>>();
        legacy
            .execute(
                &format!(
                    "INSERT INTO {name}({}) SELECT {} FROM src.{name} t",
                    names.join(","),
                    expressions.join(",")
                ),
                [],
            )
            .unwrap();
    }
    legacy
        .execute(
            "UPDATE settings SET value='1' WHERE key='schema_version'",
            [],
        )
        .unwrap();
    legacy.execute_batch("COMMIT; DETACH DATABASE src").unwrap();
    legacy.pragma_update(None, "foreign_keys", "ON").unwrap();
    assert_eq!(nauru_leave::db::migrate(&legacy).unwrap(), 1);
    assert!(!legacy
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    for table in [
        "ledger_entries",
        "request_revisions",
        "request_days",
        "revision_allocations",
        "reservations",
        "attachments",
        "decisions",
    ] {
        let count = |conn: &rusqlite::Connection| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        assert_eq!(count(&legacy), count(&source), "{table}");
    }
    for account in presentation::ids(&source, "SELECT id FROM leave_accounts", &[]).unwrap() {
        assert_eq!(
            ledger::balance_at(&legacy, account, d("2026-10-08")).unwrap(),
            ledger::balance_at(&source, account, d("2026-10-08")).unwrap()
        );
    }
    let unpaid = legacy
        .query_row("SELECT id FROM leave_types WHERE code='UNPAID'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        !model::leave_type_on(&legacy, unpaid, d("2026-10-08"))
            .unwrap()
            .uses_balance
    );
    let types = presentation::rows(&legacy, "PRAGMA table_info(leave_types)", &[]).unwrap();
    assert!(!types
        .iter()
        .any(|row| row["name"] == "paid" || row["name"] == "uses_balance"));
}

#[tokio::test]
async fn f11_rule_change_warns_without_rewriting_submitted_conditions() {
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
    c.login("Alexei Novak").await;
    let draft = c.annual("2027-01-11", "2027-01-11").await;
    let id = draft["id"].as_i64().unwrap();
    let old = c
        .ok(
            "POST",
            &format!("/api/requests/{id}/submit"),
            json!({"expected_version":draft["version"]}),
        )
        .await;
    c.login("Maria Santos").await;
    let policy=c.ok("POST","/api/leave-types/1/policies",json!({"valid_from":"2026-10-08","annual_entitlement_min":9600,"accrual_mode":"annual_upfront","advance_publish_months":3,"carryover_allowed":true,"carryover_expiry_months":null,"carryover_limit_min":4800,"paid":false,"uses_balance":false,"allow_half_day":false,"requires_attachment":true,"min_notice_days":30,"explanation":"Fictional changed conditions"})).await;
    assert!(policy["affected_future_requests"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == id));
    assert_eq!(policy["paid"], false);
    let current = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    assert_eq!(
        current["current_revision"]["policy_snapshot"],
        old["current_revision"]["policy_snapshot"]
    );
    assert!(current["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning["code"] == "policy_changed"));
    c.login("Tom Reed").await;
    let preview=c.ok("POST","/api/requests/preview",json!({"leave_type_id":1,"start_date":"2027-01-12","end_date":"2027-01-12","start_part":"am","end_part":"am"})).await;
    assert!(preview["errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|error| error["message"].as_str().unwrap().contains("half days")));
}

#[test]
fn f11_cached_sensitive_revision_stays_masked_after_reclassification() {
    let mut w = W::new();
    let id = w.submit_leave(w.u_alexei, w.sick, "2026-11-02", "2026-11-03");
    w.approve_all(id);
    let mut cached = presentation::detail(&w.conn, &w.actor(w.u_maria), id).unwrap();
    assert!(!cached["current_revision"]["leave_type"].is_null());
    let actor = w.actor(w.u_alexei);
    let clock = w.clock();
    let version = w.req(id).version;
    let input = w.revise(w.annual, "2026-11-02", "2026-11-03", "Reclassified");
    let child = requests::amend(&mut w.conn, &clock, &actor, id, &input, version, None).unwrap();
    w.approve_all(child.request_id);
    let manager = w.actor(w.u_olga);
    let current = presentation::detail(&w.conn, &manager, id).unwrap();
    assert_eq!(current["leave_type_name"], "Annual leave");
    assert!(current["current_revision"]["leave_type"].is_null());
    presentation::redact_cached(&w.conn, &manager, &mut cached).unwrap();
    assert_eq!(cached["leave_type_name"], "Leave (details restricted)");
    assert!(cached["current_revision"]["leave_type"].is_null());
}
