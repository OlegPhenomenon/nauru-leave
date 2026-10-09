use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use nauru_leave::{
    clock::Mode,
    http::{self, AppState, Config},
};
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
            clamd_addr: None,
            clamd_timeout_ms: 10000,
            backup_key_file: None,
            trust_proxy_headers: false,
            requests_per_sec: 30,
            sandbox_creations_per_hour: 5,
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
fn annual(v: &Value) -> &Value {
    v.as_array()
        .unwrap()
        .iter()
        .find(|r| r["leave_type"]["code"] == "ANNUAL")
        .unwrap()
}
#[tokio::test]
async fn sandbox_isolation() {
    let f = Fixture::new(Mode::Demo).await;
    let mut a = f.client();
    let mut b = f.client();
    a.start().await;
    b.start().await;
    a.login("Alexei Novak").await;
    b.login("Alexei Novak").await;
    let r = a.annual("2026-11-09", "2026-11-13").await;
    let list = b.ok("GET", "/api/requests?scope=mine", json!({})).await;
    assert!(!list["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["number"] == r["number"]));
    a.ok("POST", "/api/demo/clock", json!({"date":"2026-11-12"}))
        .await;
    assert_eq!(
        b.ok("GET", "/api/config", json!({})).await["business_date"],
        "2026-10-08"
    );
    a.ok("POST", "/api/demo/reset", json!({})).await;
    assert_eq!(a.call("GET", "/api/me", json!({})).await.0, 401);
    a.login("Alexei Novak").await;
    assert_eq!(
        a.ok("GET", "/api/requests?scope=mine", json!({})).await["total"],
        0
    );
}
#[tokio::test]
async fn production_has_no_demo_routes() {
    let f = Fixture::new(Mode::Production).await;
    let mut c = f.client();
    for (path, method) in http::DEMO_ROUTES {
        assert_eq!(c.call(method, path, json!({})).await.0, 404, "{path}");
    }
    assert!(!f.dir.join("template.sqlite").exists());
    assert_eq!(c.call("GET", "/up", Value::Null).await.0, 200);
}
#[tokio::test]
async fn csrf_required() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let body = json!({"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-13"})
        .to_string()
        .into_bytes();
    assert_eq!(
        c.raw(
            "POST",
            "/api/requests",
            body.clone(),
            "application/json",
            None,
            false,
            Some("http://localhost")
        )
        .await
        .0,
        403
    );
    assert_eq!(
        c.raw(
            "POST",
            "/api/requests",
            body.clone(),
            "application/json",
            None,
            true,
            Some("http://evil.example")
        )
        .await
        .0,
        403
    );
    assert_eq!(
        c.raw(
            "POST",
            "/api/requests",
            body,
            "application/json",
            None,
            true,
            None
        )
        .await
        .0,
        403
    );
}
#[tokio::test]
async fn main_scenario_export() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let b = c.ok("GET", "/api/balances/me", json!({})).await;
    assert_eq!(annual(&b)["ledger_minutes"], 9600);
    assert_eq!(annual(&b)["policy"]["status"], "demo_fictional");
    let preview = c
        .ok(
            "POST",
            "/api/requests/preview",
            json!({"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-13"}),
        )
        .await;
    assert_eq!(preview["days"][0]["date"], "2026-11-09");
    assert_eq!(preview["policy"]["status"], "demo_fictional");
    let r = c.annual("2026-11-09", "2026-11-13").await;
    let id = r["id"].as_i64().unwrap();
    let path = format!("/api/requests/{id}/submit");
    let body = json!({"expected_version":r["version"]})
        .to_string()
        .into_bytes();
    let (s, first, _) = c
        .raw(
            "POST",
            &path,
            body.clone(),
            "application/json",
            Some("submit-1"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(s, 200, "{first}");
    let (s, replay, _) = c
        .raw(
            "POST",
            &path,
            body,
            "application/json",
            Some("submit-1"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(first, replay);
    let (s, _, _) = c
        .raw(
            "POST",
            &path,
            b"{\"expected_version\":999}".to_vec(),
            "application/json",
            Some("submit-1"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(s, 422);
    let b = c.ok("GET", "/api/balances/me", json!({})).await;
    assert_eq!(
        (
            annual(&b)["ledger_minutes"].as_i64(),
            annual(&b)["reserved_minutes"].as_i64(),
            annual(&b)["available_minutes"].as_i64()
        ),
        (Some(9600), Some(2400), Some(7200))
    );
    let approved = c.approve(id).await;
    assert_eq!(approved["status"], "approved");
    c.login("Alexei Novak").await;
    assert_eq!(
        annual(&c.ok("GET", "/api/balances/me", json!({})).await)["ledger_minutes"],
        7200
    );
    let child=c.ok("POST",&format!("/api/requests/{id}/amend"),json!({"expected_version":approved["version"],"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-11","change_reason":"Shorter trip","start_part":"full","end_part":"full"})).await;
    assert_eq!(
        annual(&c.ok("GET", "/api/balances/me", json!({})).await)["reserved_minutes"],
        0
    );
    let child_id = child["id"].as_i64().unwrap();
    c.approve(child_id).await;
    c.login("Alexei Novak").await;
    let b = c.ok("GET", "/api/balances/me", json!({})).await;
    assert_eq!(annual(&b)["ledger_minutes"], 8160);
    c.ok("POST", "/api/demo/clock", json!({"date":"2026-11-12"}))
        .await;
    assert_eq!(
        c.ok("GET", &format!("/api/requests/{id}"), json!({})).await["date_phase"],
        "period_ended"
    );
    c.login("Maria Santos").await;
    let export = c
        .ok(
            "POST",
            "/api/exports",
            json!({"from":"2026-11-09","to":"2026-11-13"}),
        )
        .await;
    let (_, _, bytes) = c
        .raw(
            "GET",
            &format!("/api/exports/{}/download", export["id"]),
            vec![],
            "application/json",
            None,
            true,
            None,
        )
        .await;
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("employee_service_id,request_number,revision_no,leave_type_code,date,minutes,period_year,decision_at"));
    let alex = text
        .lines()
        .filter(|l| l.starts_with("NPS-1001,"))
        .collect::<Vec<_>>();
    assert_eq!(alex.len(), 3, "{text}");
    assert!(
        alex[0].contains(&format!(
            ",{},1,ANNUAL,2026-11-09,480,2026,",
            first["number"].as_str().unwrap()
        )),
        "expected submitted number {}, actual {}",
        first["number"],
        alex[0]
    );
    c.ok(
        "POST",
        &format!("/api/exports/{}/mark-transferred", export["id"]),
        json!({"note":"Accepted"}),
    )
    .await;
    assert_eq!(
        c.ok("GET", "/api/reports/changes-since-export", json!({}))
            .await["total"],
        0
    );
}
#[tokio::test]
async fn isolation_other_employee() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-09", "2026-11-13").await;
    let id = r["id"].as_i64().unwrap();
    let (_, attach) = c
        .upload(
            &format!("/api/requests/{id}/attachments"),
            "normal.pdf",
            b"%PDF-1.4 normal",
            &[("sensitivity", "normal")],
        )
        .await;
    assert!(attach["id"].is_number(), "{attach}");
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.approve(id).await;
    c.login("Tom Reed").await;
    assert_eq!(
        c.call("GET", &format!("/api/requests/{id}"), json!({}))
            .await
            .0,
        403
    );
    for path in [
        "/api/requests?scope=all",
        "/api/reports/absences?from=2026-11-09&to=2026-11-13",
        "/api/reports/pending",
        "/api/reports/changes-since-export",
        "/api/exports",
    ] {
        let v = c.ok("GET", path, json!({})).await;
        assert!(
            !v.to_string().contains(r["number"].as_str().unwrap()),
            "{path}: {v}"
        );
    }
    let cal = c
        .ok(
            "GET",
            "/api/calendar?from=2026-11-09&to=2026-11-13",
            json!({}),
        )
        .await;
    let alex = cal["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["employee"]["full_name"] == "Alexei Novak")
        .unwrap();
    assert!(alex["absences"]
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["request_id"].is_null() && d["label"] == "Away"));
    assert_eq!(
        c.call(
            "GET",
            &format!("/api/attachments/{}", attach["id"]),
            json!({})
        )
        .await
        .0,
        403
    );
}
#[tokio::test]
async fn medical_access() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Nia Fox").await;
    let list = c.ok("GET", "/api/requests?scope=mine", json!({})).await;
    let id = list["items"][0]["id"].as_i64().unwrap();
    let detail = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let aid = detail["attachments"][0]["id"].as_i64().unwrap();
    for name in ["Nia Fox", "Maria Santos"] {
        c.login(name).await;
        assert_eq!(
            c.call("GET", &format!("/api/attachments/{aid}"), json!({}))
                .await
                .0,
            200
        );
    }
    for name in ["Olga Berg", "Elena Ward", "Pavel Grant"] {
        c.login(name).await;
        assert_eq!(
            c.call("GET", &format!("/api/attachments/{aid}"), json!({}))
                .await
                .0,
            403
        );
        let cal = c
            .ok(
                "GET",
                "/api/calendar?from=2026-10-01&to=2026-10-02",
                json!({}),
            )
            .await;
        assert!(cal.to_string().contains("Away"));
        assert!(!cal.to_string().contains("Sick leave"));
    }
}
#[tokio::test]
async fn upload_checks() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-09", "2026-11-13").await;
    let id = r["id"].as_i64().unwrap();
    let path = format!("/api/requests/{id}/attachments");
    assert_eq!(c.upload(&path, "fake.pdf", b"not pdf", &[]).await.0, 422);
    let eicar = format!("%PDF-1.4 {}", nauru_leave::files::EICAR);
    let (s, v) = c.upload(&path, "virus.pdf", eicar.as_bytes(), &[]).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["scan_status"], "quarantined");
    assert_eq!(
        c.call("GET", &format!("/api/attachments/{}", v["id"]), json!({}))
            .await
            .0,
        403
    );
    let mut large = vec![0u8; 2 * 1024 * 1024 + 1];
    large[..5].copy_from_slice(b"%PDF-");
    assert_eq!(c.upload(&path, "large.pdf", &large, &[]).await.0, 422);
    for _ in 0..4 {
        assert_eq!(
            c.upload(&path, "clean.pdf", b"%PDF-1.4 test", &[]).await.0,
            200
        );
    }
    assert_eq!(
        c.upload(&path, "sixth.pdf", b"%PDF-1.4 test", &[]).await.0,
        422
    );
}
#[tokio::test]
async fn import_preview_errors() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let csv=b"service_id,leave_type,period_year,minutes\nUNKNOWN,ANNUAL,2026,480\nNPS-1001,ANNUAL,2026,480\nNPS-1001,ANNUAL,2026,480\nNPS-1002,ANNUAL,no,480\nNPS-1002,ANNUAL,2025,-5\n";
    let (s, v) = c
        .upload(
            "/api/imports/preview",
            "bad.csv",
            csv,
            &[("kind", "opening_balances")],
        )
        .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["rows_valid"], 0);
    assert_eq!(v["rows_total"], 5);
    assert!(v.to_string().contains("unknown service_id"));
    assert!(v.to_string().contains("duplicate"));
    assert!(v.to_string().contains("opening already posted"));
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/imports/{}/commit", v["batch_id"]),
            json!({})
        )
        .await
        .0,
        409
    );
    let (s, v) = c
        .upload(
            "/api/imports/preview",
            "dates.csv",
            b"service_id,leave_type,start_date,end_date\nNPS-1001,ANNUAL,not-date,2026-02-02\n",
            &[("kind", "historical_leave"), ("mode", "post_movements")],
        )
        .await;
    assert_eq!(s, 200);
    assert!(v.to_string().contains("bad date"));
}
#[tokio::test]
async fn import_idempotent() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let csv = b"service_id,leave_type,period_year,minutes\nNPS-1001,FAMILY,2025,1200\n";
    let (_, p) = c
        .upload(
            "/api/imports/preview",
            "o.csv",
            csv,
            &[("kind", "opening_balances")],
        )
        .await;
    let first = c
        .ok(
            "POST",
            &format!("/api/imports/{}/commit", p["batch_id"]),
            json!({}),
        )
        .await;
    assert_eq!(first["applied"], 1);
    let (_, p) = c
        .upload(
            "/api/imports/preview",
            "o2.csv",
            csv,
            &[("kind", "opening_balances")],
        )
        .await;
    let (s, second) = c
        .call(
            "POST",
            &format!("/api/imports/{}/commit", p["batch_id"]),
            json!({}),
        )
        .await;
    assert_eq!(s, 200, "{second}");
    assert_eq!(second["skipped_duplicates"], 1);
    let (_, p) = c
        .upload(
            "/api/imports/preview",
            "o3.csv",
            b"service_id,leave_type,period_year,minutes\nNPS-1001,FAMILY,2025,1300\n",
            &[("kind", "opening_balances")],
        )
        .await;
    assert_eq!(p["rows_valid"], 0);
}
#[tokio::test]
async fn csv_formula_safe() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let employees = c.ok("GET", "/api/employees?q=NPS-1001", json!({})).await;
    let id = employees["items"][0]["id"].as_i64().unwrap();
    c.ok(
        "PUT",
        &format!("/api/employees/{id}"),
        json!({"full_name":"=HYPERLINK(\"evil\")","email":"test@x.example","active":true}),
    )
    .await;
    let (s, _, bytes) = c
        .raw(
            "GET",
            "/api/reports/balances?format=csv",
            vec![],
            "application/json",
            None,
            true,
            None,
        )
        .await;
    assert_eq!(s, 200);
    let text = String::from_utf8(bytes).unwrap();
    let mut csv = csv::Reader::from_reader(text.as_bytes());
    let fields = csv
        .records()
        .flat_map(|r| r.unwrap().iter().map(str::to_owned).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    assert!(fields.iter().any(|s| s.starts_with("'=HYPERLINK")));
}
#[tokio::test]
async fn every_api_route_is_registered() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    let contract = include_str!("../../docs/API.md");
    for (path, methods) in http::ROUTES.iter().chain(http::DEMO_ROUTES) {
        let doc_path = path
            .replace("{employee_id}", ":employee_id")
            .replace("{id}", ":id");
        assert!(
            contract.contains(&doc_path),
            "inventory route not in docs: {doc_path}"
        );
        let concrete = path.replace("{employee_id}", "1").replace("{id}", "1");
        for method in methods.split('|') {
            let (status, _, _) = c
                .raw(
                    method,
                    &concrete,
                    b"{}".to_vec(),
                    "application/json",
                    None,
                    false,
                    Some("http://localhost"),
                )
                .await;
            assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "{method} {path}");
            assert_ne!(status, StatusCode::NOT_FOUND, "{method} {path}");
        }
    }
}
#[tokio::test]
async fn production_password_totp_and_lockout() {
    let f = Fixture::new(Mode::Production).await;
    let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    {
        let mut conn = nauru_leave::db::open(&f.dir.join("main.sqlite")).unwrap();
        nauru_leave::db::write_tx(&mut conn, |tx| {
            let uid = nauru_leave::people::create_user(
                tx,
                "admin@example.test",
                "Admin",
                Some("test-password"),
                "2026-01-01T00:00:00Z",
            )?;
            nauru_leave::people::grant_role(
                tx,
                uid,
                "tech_admin",
                None,
                nauru_leave::model::parse_date("2025-01-01")?,
                None,
                None,
                "2026-01-01T00:00:00Z",
            )?;
            tx.execute(
                "UPDATE users SET totp_secret=?2 WHERE id=?1",
                rusqlite::params![uid, secret],
            )?;
            nauru_leave::people::create_user(
                tx,
                "locked@example.test",
                "Locked",
                Some("test-password"),
                "2026-01-01T00:00:00Z",
            )?;
            Ok(())
        })
        .unwrap();
    }
    let mut c = f.client();
    let login = c
        .ok(
            "POST",
            "/api/auth/login",
            json!({"email":"admin@example.test","password":"test-password"}),
        )
        .await;
    assert_eq!(login["needs_totp"], true);
    assert_eq!(c.call("GET", "/api/users", json!({})).await.0, 401);
    let totp = totp_rs::Builder::new()
        .with_secret(totp_rs::Secret::try_from_base32(secret).unwrap())
        .build()
        .unwrap();
    let code = totp.generate_current().to_string();
    let me = c.ok("POST", "/api/auth/totp", json!({"code":code})).await;
    c.csrf = me["csrf_token"].as_str().map(str::to_owned);
    assert_eq!(me["totp_ok"], true);
    assert!(c.ok("GET", "/api/users", json!({})).await["items"].is_array());
    c.ok("POST", "/api/auth/logout", json!({})).await;
    assert_eq!(c.call("GET", "/api/me", json!({})).await.0, 401);
    c.ok(
        "POST",
        "/api/auth/login",
        json!({"email":"admin@example.test","password":"test-password"}),
    )
    .await;
    assert_eq!(
        c.call("POST", "/api/auth/totp", json!({"code":code}))
            .await
            .0,
        403
    );
    for _ in 0..5 {
        assert_eq!(
            c.call(
                "POST",
                "/api/auth/login",
                json!({"email":"locked@example.test","password":"wrong"})
            )
            .await
            .0,
            401
        );
    }
    assert_eq!(
        c.call(
            "POST",
            "/api/auth/login",
            json!({"email":"locked@example.test","password":"test-password"})
        )
        .await
        .0,
        401
    );
    let conn = nauru_leave::db::open(&f.dir.join("main.sqlite")).unwrap();
    let locked: String = conn
        .query_row(
            "SELECT locked_until FROM users WHERE email='locked@example.test'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!locked.is_empty());
}
#[tokio::test]
async fn lifecycle_survives_restart_and_sweeps() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let id = c.cookies["nld_sbx"].clone();
    let old = c.cookies["nld_session"].clone();
    c.ok("POST", "/api/demo/reset", json!({})).await;
    c.cookies.insert("nld_session".into(), old);
    assert_eq!(c.call("GET", "/api/me", json!({})).await.0, 401);
    let restarted = AppState::new(f.state.config.clone()).await.unwrap();
    c.router = http::router(restarted.clone());
    assert_eq!(
        c.ok("GET", "/api/demo/status", json!({})).await["has_sandbox"],
        true
    );
    restarted.jobs(true).await.unwrap();
    assert!(!f.dir.join(format!("sandboxes/{id}-g1.sqlite")).exists());
    assert!(f.dir.join(format!("sandboxes/{id}-g2.sqlite")).exists());
    let registry = nauru_leave::db::open(&f.dir.join("sandboxes.sqlite")).unwrap();
    registry
        .execute("UPDATE sandboxes SET last_seen_at=0", [])
        .unwrap();
    drop(registry);
    restarted.jobs(true).await.unwrap();
    assert!(!f.dir.join(format!("sandboxes/{id}-g2.sqlite")).exists());
    assert_eq!(
        c.ok("GET", "/api/demo/status", json!({})).await["has_sandbox"],
        false
    );
}
#[tokio::test]
async fn creation_limit_and_cap() {
    let f = Fixture::new(Mode::Demo).await;
    for _ in 0..5 {
        let req = Request::builder()
            .method("POST")
            .uri("/api/demo/start")
            .header("origin", "http://localhost")
            .body(Body::empty())
            .unwrap();
        assert_eq!(f.router.clone().oneshot(req).await.unwrap().status(), 200);
    }
    let req = Request::builder()
        .method("POST")
        .uri("/api/demo/start")
        .header("origin", "http://localhost")
        .body(Body::empty())
        .unwrap();
    assert_eq!(f.router.clone().oneshot(req).await.unwrap().status(), 429);
    let mut config = f.state.config.clone();
    config.max_sandboxes = 5;
    let state = AppState::new(config).await.unwrap();
    let mut c = f.client();
    c.router = http::router(state);
    assert_eq!(c.call("POST", "/api/demo/start", json!({})).await.0, 503);
}
#[tokio::test]
async fn preview_cannot_read_another_employee() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let me = c.login("Tom Reed").await;
    let body = json!({"employee_id":1,"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-13"});
    assert_ne!(me["employee"]["id"], 1);
    assert_eq!(c.call("POST", "/api/requests/preview", body).await.0, 403);
}
#[tokio::test]
async fn server_backup_restore_file_layout() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Nia Fox").await;
    let id = c.cookies["nld_sbx"].clone();
    let db = f.dir.join(format!("sandboxes/{id}-g1.sqlite"));
    let files = f.dir.join(format!("files/{id}-g1"));
    std::fs::write(files.join("orphan"), b"orphan").unwrap();
    let backup = f.dir.join("snapshot.enc");
    let key = [7u8; 32];
    nauru_leave::backup::backup(&db, &files, &key, &backup).unwrap();
    let restored = f.dir.join("restored");
    nauru_leave::backup::restore_main(&backup, &key, &restored).unwrap();
    assert!(restored.join("main.sqlite").exists());
    assert!(!restored.join("files/main/orphan").exists());
    let mut config = f.state.config.clone();
    config.mode = Mode::Production;
    config.data_dir = restored;
    let state = AppState::new(config).await.unwrap();
    assert_eq!(state.config.mode, Mode::Production);
    let conn = nauru_leave::db::open(&state.config.data_dir.join("main.sqlite")).unwrap();
    let key: String = conn
        .query_row("SELECT storage_key FROM attachments LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(state.config.data_dir.join("files/main").join(key).exists());
}
#[tokio::test]
async fn authenticated_read_routes_return_contract_shapes() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    let me = c.login("Maria Santos").await;
    for path in [
        "/api/leave-types",
        "/api/balances",
        "/api/requests?scope=all",
        "/api/approvals",
        "/api/org-units",
        "/api/employees",
        "/api/adjustments",
        "/api/reports/balances",
        "/api/reports/absences?from=2025-12-01&to=2026-12-31",
        "/api/reports/pending",
        "/api/reports/changes-since-export",
        "/api/reports/schedule-drift",
        "/api/exports",
        "/api/imports",
        "/api/schedules",
        "/api/calendar-exceptions",
        "/api/delegations",
        "/api/ops/notifications",
        "/api/ops/summary",
        "/api/audit",
        "/api/demo/mailbox",
    ] {
        c.ok("GET", path, json!({})).await;
    }
    let eid = me["employee"]["id"].as_i64().unwrap();
    let report = c
        .ok(
            "GET",
            "/api/reports/absences?from=2025-12-01&to=2026-12-31&limit=1",
            json!({}),
        )
        .await;
    assert_eq!(report["total_days"], report["total"]);
    assert!(report["total_minutes"].is_i64());
    assert!(report["items"].as_array().unwrap().len() <= 1);
    c.ok("GET", &format!("/api/employees/{eid}"), json!({}))
        .await;
    c.ok(
        "GET",
        &format!("/api/balances/{eid}/explain?leave_type_id=1"),
        json!({}),
    )
    .await;
    c.login("Pavel Grant").await;
    c.ok("GET", "/api/users", json!({})).await;
    assert_eq!(
        c.call(
            "POST",
            "/api/accruals/run",
            json!({"leave_type_id":1,"period_year":2027})
        )
        .await
        .0,
        403
    );
}
#[tokio::test]
async fn scoped_hr_import_export_and_download_recheck() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    let me = c.login("Maria Santos").await;
    let export = c
        .ok(
            "POST",
            "/api/exports",
            json!({"from":"2026-01-01","to":"2026-12-31"}),
        )
        .await;
    let id = c.cookies["nld_sbx"].clone();
    let conn = nauru_leave::db::open(&f.dir.join(format!("sandboxes/{id}-g1.sqlite"))).unwrap();
    conn.execute("UPDATE role_grants SET scope_org_unit_id=(SELECT id FROM org_units WHERE code='IU') WHERE user_id=?1 AND role='hr'",[me["user"]["id"].as_i64().unwrap()]).unwrap();
    drop(conn);
    assert_eq!(
        c.call(
            "GET",
            &format!("/api/exports/{}/download", export["id"]),
            json!({})
        )
        .await
        .0,
        403
    );
    let scoped = c
        .ok(
            "POST",
            "/api/exports",
            json!({"from":"2026-01-01","to":"2026-12-31"}),
        )
        .await;
    let (s, _, bytes) = c
        .raw(
            "GET",
            &format!("/api/exports/{}/download", scoped["id"]),
            vec![],
            "application/json",
            None,
            true,
            None,
        )
        .await;
    assert_eq!(s, 200);
    let csv = String::from_utf8(bytes).unwrap();
    assert!(!csv.contains("NPS-200"), "{csv}");
    assert!(csv.contains("NPS-1003"));
    let (s, p) = c
        .upload(
            "/api/imports/preview",
            "scope.csv",
            b"service_id,leave_type,period_year,minutes\nNPS-2003,FAMILY,2025,480\n",
            &[("kind", "opening_balances")],
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(p["rows_valid"], 0);
    assert!(p.to_string().contains("outside your HR scope"));
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/imports/{}/commit", p["batch_id"]),
            json!({})
        )
        .await
        .0,
        409
    );
}
#[tokio::test]
async fn notification_worker_and_registry_marker() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    f.state.jobs(false).await.unwrap();
    let v = c.ok("GET", "/api/demo/mailbox", json!({})).await;
    assert!(!v["items"].as_array().unwrap().is_empty());
    let registry = nauru_leave::db::open(&f.dir.join("sandboxes.sqlite")).unwrap();
    let marker: i64 = registry
        .query_row("SELECT has_pending FROM sandboxes LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(marker, 1);
    let ops = c.ok("GET", "/api/ops/notifications", json!({})).await;
    assert!(ops["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["status"] == "failed"));
}
#[tokio::test]
async fn settings_mutations_and_drift() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    let unit = c
        .ok(
            "POST",
            "/api/org-units",
            json!({"code":"TEST","name":"Test unit"}),
        )
        .await;
    c.ok(
        "PUT",
        &format!("/api/org-units/{}", unit["id"]),
        json!({"code":"TEST","name":"Renamed unit","active":true}),
    )
    .await;
    let schedule = c
        .ok(
            "POST",
            "/api/schedules",
            json!({"name":"Test week","valid_from":"2026-01-01","week":[480,480,480,480,480,0,0]}),
        )
        .await;
    c.ok(
        "POST",
        &format!("/api/schedules/{}/versions", schedule["id"]),
        json!({"valid_from":"2026-11-01","week":[360,360,360,360,360,0,0]}),
    )
    .await;
    let exception = c
        .ok(
            "POST",
            "/api/calendar-exceptions",
            json!({"date":"2026-11-10","name":"Test holiday","minutes":0}),
        )
        .await;
    assert!(!exception["affected_future_requests"]
        .as_array()
        .unwrap()
        .is_empty());
    let drift = c.ok("GET", "/api/reports/schedule-drift", json!({})).await;
    assert!(drift["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["date"] == "2026-11-10" && d["current_minutes"] == 0));
    c.ok(
        "DELETE",
        &format!("/api/calendar-exceptions/{}", exception["id"]),
        json!({}),
    )
    .await;
    c.ok(
        "POST",
        "/api/accruals/run",
        json!({"leave_type_id":1,"period_year":2027}),
    )
    .await;
    let again = c
        .ok(
            "POST",
            "/api/accruals/run",
            json!({"leave_type_id":1,"period_year":2027}),
        )
        .await;
    assert_eq!(again["posted"], 0);
    let pavel = c.login("Pavel Grant").await;
    let user = c
        .ok(
            "POST",
            "/api/users",
            json!({"email":"extra@example.test","display_name":"Extra"}),
        )
        .await;
    assert_eq!(c.call("POST", &format!("/api/users/{}/roles", user["id"]), json!({"role":"hr"})).await.0, 403);
    c.login("Maria Santos").await;
    let grant = c
        .ok(
            "POST",
            &format!("/api/users/{}/roles", user["id"]),
            json!({"role":"hr","valid_from":"2026-01-01"}),
        )
        .await;
    c.ok(
        "DELETE",
        &format!("/api/role-grants/{}", grant["id"]),
        json!({}),
    )
    .await;
    c.login("Pavel Grant").await;
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/users/{}/roles", pavel["user"]["id"]),
            json!({"role":"final_approver"})
        )
        .await
        .0,
        403
    );
}
#[tokio::test]
async fn idempotency_replay_rechecks_medical_permissions() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    let maria = c.login("Maria Santos").await;
    let employees = c.ok("GET", "/api/employees?q=NPS-2003", json!({})).await;
    let nia = employees["items"][0]["id"].clone();
    let r=c.ok("POST","/api/requests",json!({"employee_id":nia,"leave_type_id":2,"start_date":"2026-11-02","end_date":"2026-11-03","source":"paper","paper_received_date":"2026-10-08"})).await;
    let id = r["id"].as_i64().unwrap();
    c.login("Nia Fox").await;
    let (s, _) = c
        .upload(
            &format!("/api/requests/{id}/attachments"),
            "private-medical.pdf",
            b"%PDF-1.4 confidential",
            &[("sensitivity", "medical")],
        )
        .await;
    assert_eq!(s, 200);
    c.login("Maria Santos").await;
    let path = format!("/api/requests/{id}/submit");
    let bytes = json!({"expected_version":r["version"]})
        .to_string()
        .into_bytes();
    let (s, first, _) = c
        .raw(
            "POST",
            &path,
            bytes.clone(),
            "application/json",
            Some("medical-replay"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(s, 200, "{first}");
    assert_eq!(first["attachments"][0]["filename"], "private-medical.pdf");
    let sbx = c.cookies["nld_sbx"].clone();
    let conn = nauru_leave::db::open(&f.dir.join(format!("sandboxes/{sbx}-g1.sqlite"))).unwrap();
    conn.execute(
        "DELETE FROM role_grants WHERE user_id=?1 AND role='hr_medical'",
        [maria["user"]["id"].as_i64().unwrap()],
    )
    .unwrap();
    drop(conn);
    let (s, replay, _) = c
        .raw(
            "POST",
            &path,
            bytes,
            "application/json",
            Some("medical-replay"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(s, 200, "{replay}");
    assert_eq!(replay["attachments"][0]["restricted"], true);
    assert!(!replay.to_string().contains("private-medical.pdf"));
}
#[tokio::test]
async fn new_privileges_require_fresh_totp() {
    let f = Fixture::new(Mode::Production).await;
    let conn = nauru_leave::db::open(&f.dir.join("main.sqlite")).unwrap();
    let uid = nauru_leave::people::create_user(
        &conn,
        "employee@example.test",
        "Employee",
        Some("test-password"),
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    drop(conn);
    let mut c = f.client();
    let v = c
        .ok(
            "POST",
            "/api/auth/login",
            json!({"email":"employee@example.test","password":"test-password"}),
        )
        .await;
    assert_eq!(v["needs_totp"], false);
    assert_eq!(c.ok("GET", "/api/me", json!({})).await["totp_ok"], false);
    let conn = nauru_leave::db::open(&f.dir.join("main.sqlite")).unwrap();
    nauru_leave::people::grant_role(
        &conn,
        uid,
        "tech_admin",
        None,
        nauru_leave::model::parse_date("2026-01-01").unwrap(),
        None,
        None,
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    drop(conn);
    assert_eq!(c.call("GET", "/api/me", json!({})).await.0, 401);
}
#[tokio::test]
async fn stale_version_and_decision_replay() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-09", "2026-11-13").await;
    let id = r["id"].as_i64().unwrap();
    assert_eq!(c.call("PUT",&format!("/api/requests/{id}"),json!({"expected_version":999,"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-13"})).await.0,409);
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":r["version"]}),
    )
    .await;
    c.login("Olga Berg").await;
    let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
    let body=json!({"expected_version":r["version"],"step_id":r["decidable_step"]["id"],"outcome":"recommend_approve"}).to_string().into_bytes();
    let path = format!("/api/requests/{id}/decide");
    let (s, first, _) = c
        .raw(
            "POST",
            &path,
            body.clone(),
            "application/json",
            Some("decision-replay"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(s, 200);
    let (s, second, _) = c
        .raw(
            "POST",
            &path,
            body,
            "application/json",
            Some("decision-replay"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(first, second);
    assert_eq!(second["decisions"].as_array().unwrap().len(), 1);
}
#[test]
fn smtp_delivery_happens_outside_database_transaction() {
    use nauru_leave::notify::{self, Transport};
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        stream.write_all(b"220 localhost SMTP\r\n").unwrap();
        let mut body = String::new();
        let mut in_data = false;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            if in_data {
                if line == ".\r\n" {
                    in_data = false;
                    stream.write_all(b"250 queued\r\n").unwrap();
                } else {
                    body.push_str(&line);
                }
            } else if line.starts_with("EHLO") || line.starts_with("HELO") {
                stream
                    .write_all(b"250-localhost\r\n250 8BITMIME\r\n")
                    .unwrap();
            } else if line.starts_with("DATA") {
                in_data = true;
                stream.write_all(b"354 send data\r\n").unwrap();
            } else if line.starts_with("QUIT") {
                stream.write_all(b"221 goodbye\r\n").unwrap();
                break;
            } else {
                stream.write_all(b"250 ok\r\n").unwrap();
            }
        }
        body
    });
    struct Probe(notify::SmtpTransport);
    impl Transport for Probe {
        fn external(&self) -> bool {
            true
        }
        fn deliver(
            &self,
            c: &rusqlite::Connection,
            n: &notify::Notification,
        ) -> nauru_leave::Res<()> {
            assert!(c.is_autocommit());
            self.0.deliver(c, n)
        }
    }
    let transport = Probe(
        notify::SmtpTransport::new(&format!("smtp://{addr}"), "https://leave.example.test")
            .unwrap(),
    );
    let mut c = nauru_leave::db::open_memory().unwrap();
    nauru_leave::db::migrate(&c).unwrap();
    notify::enqueue(
        &c,
        "2026-01-01T00:00:00Z",
        "test",
        1,
        1,
        &notify::Recipient {
            user_id: None,
            email: "recipient@example.test".into(),
        },
        "Request updated",
        "Open your request to review the decision.",
    )
    .unwrap();
    assert_eq!(
        notify::deliver_due(&mut c, &transport, time::OffsetDateTime::now_utc()).unwrap(),
        1
    );
    let status: String = c
        .query_row("SELECT status FROM notifications", [], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "sent");
    drop(transport);
    let body = server.join().unwrap();
    assert!(body.contains("https://leave.example.test/requests/1"));
    assert!(!body.contains("Sick leave"));
}

#[tokio::test]
async fn comment_is_audited_and_notifies() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let r = c.annual("2026-11-09", "2026-11-13").await;
    let id = r["id"].as_i64().unwrap();
    let sbx = &c.cookies["nld_sbx"];
    let conn = nauru_leave::db::open(&f.dir.join(format!("sandboxes/{sbx}-g1.sqlite"))).unwrap();
    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))
        .unwrap();
    let detail = c
        .ok(
            "POST",
            &format!("/api/requests/{id}/messages"),
            json!({"body":"private comment text"}),
        )
        .await;
    assert!(detail["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["body"] == "private comment text"));
    let audit: String = conn
        .query_row(
            "SELECT details_json FROM audit_events WHERE action='request.comment' AND entity_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!audit.contains("private comment text"));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM notifications", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        before + 1
    );
    c.login("Tom Reed").await;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE request_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        c.call(
            "POST",
            &format!("/api/requests/{id}/messages"),
            json!({"body":"unauthorized"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE request_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        count
    );
}

#[tokio::test]
async fn delete_draft_removes_attachment_after_commit() {
    let f=Fixture::new(Mode::Demo).await; let mut c=f.client();c.start().await;c.login("Alexei Novak").await;
    let r=c.annual("2026-11-02","2026-11-03").await;let id=r["id"].as_i64().unwrap();
    assert_eq!(c.upload(&format!("/api/requests/{id}/attachments"),"draft.pdf",b"%PDF-1.4 draft",&[("sensitivity","normal")]).await.0,200);
    let sbx=&c.cookies["nld_sbx"];let conn=nauru_leave::db::open(&f.dir.join(format!("sandboxes/{sbx}-g1.sqlite"))).unwrap();
    let key:String=conn.query_row("SELECT storage_key FROM attachments WHERE request_id=?1",[id],|r|r.get(0)).unwrap();
    let path=f.dir.join(format!("files/{sbx}-g1")).join(key);assert!(path.exists());
    let (status,_)=c.call("DELETE",&format!("/api/requests/{id}?expected_version={}",r["version"]),json!({})).await;
    assert_eq!(status,204);assert!(!path.exists());
}

#[tokio::test]
async fn colleague_calendar_masks_sensitive_leave_as_away() {
    let f=Fixture::new(Mode::Demo).await;let mut c=f.client();c.start().await;c.login("Tom Reed").await;
    let calendar=c.ok("GET","/api/calendar?from=2026-10-01&to=2026-10-02",json!({})).await;
    let text=calendar.to_string();assert!(text.contains("Away"),"{text}");assert!(!text.contains("Sick leave"));
}

#[tokio::test]
async fn cli_create_logs_in_with_password_and_totp_in_production() {
    use std::{io::Write,process::{Command,Stdio}};
    let f=Fixture::new(Mode::Production).await;
    let mut child=Command::new(env!("CARGO_BIN_EXE_nauru-leave")).env("NLD_MODE","production").env("NLD_DATA_DIR",&f.dir).args(["user","create","--email","cli@example.test","--name","CLI User","--role","tech_admin","--password-stdin"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"production-test-password\n").unwrap();let output=child.wait_with_output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let conn=nauru_leave::db::open(&f.dir.join("main.sqlite")).unwrap();let secret:String=conn.query_row("SELECT totp_secret FROM users WHERE email='cli@example.test'",[],|r|r.get(0)).unwrap();
    let code=totp_rs::Builder::new().with_secret(totp_rs::Secret::try_from_base32(&secret).unwrap()).build().unwrap().generate_current().to_string();
    let mut c=f.client();let login=c.ok("POST","/api/auth/login",json!({"email":"cli@example.test","password":"production-test-password"})).await;assert_eq!(login["needs_totp"],true);
    assert_eq!(c.call("GET","/api/me",json!({})).await.0,401);
    c.ok("POST","/api/auth/totp",json!({"code":code})).await;let me=c.ok("GET","/api/me",json!({})).await;assert_eq!(me["user"]["email"],"cli@example.test");assert_eq!(me["totp_ok"],true);
}
