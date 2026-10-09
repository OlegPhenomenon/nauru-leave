#![allow(dead_code)]
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
pub struct Fixture {
    pub dir: PathBuf,
    pub state: Arc<AppState>,
    pub router: Router,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
impl Fixture {
    pub async fn new(mode: Mode) -> Self {
        Self::with_scanner(mode, None, 10000).await
    }
    pub async fn with_scanner(
        mode: Mode,
        clamd_addr: Option<String>,
        clamd_timeout_ms: usize,
    ) -> Self {
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
            clamd_addr,
            clamd_timeout_ms,
            backup_key_file: None,
            trust_proxy_headers: false,
            requests_per_sec: 30,
            sandbox_creations_per_hour: 5,
        };
        let state = AppState::new(config).await.unwrap();
        let router = http::router(state.clone());
        Self { dir, state, router }
    }
    pub fn client(&self) -> Client {
        Client {
            router: self.router.clone(),
            cookies: BTreeMap::new(),
            csrf: None,
        }
    }
}
#[derive(Clone)]
pub struct Client {
    pub router: Router,
    pub cookies: BTreeMap<String, String>,
    pub csrf: Option<String>,
}
impl Client {
    #[allow(clippy::too_many_arguments)]
    pub async fn raw(
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
    pub async fn call(&mut self, method: &str, path: &str, v: Value) -> (StatusCode, Value) {
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
    pub async fn ok(&mut self, method: &str, path: &str, v: Value) -> Value {
        let (s, v) = self.call(method, path, v).await;
        assert!(s.is_success(), "{method} {path}: {s} {v}");
        v
    }
    pub async fn start(&mut self) {
        self.ok("POST", "/api/demo/start", json!({})).await;
    }
    pub async fn login(&mut self, name: &str) -> Value {
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
    pub async fn upload(
        &mut self,
        path: &str,
        name: &str,
        bytes: &[u8],
        fields: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        self.upload_key(path, name, bytes, fields, None).await
    }
    pub async fn upload_key(
        &mut self,
        path: &str,
        name: &str,
        bytes: &[u8],
        fields: &[(&str, &str)],
        key: Option<&str>,
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
                key,
                true,
                Some("http://localhost"),
            )
            .await;
        (s, v)
    }
    pub async fn annual(&mut self, start: &str, end: &str) -> Value {
        self.ok("POST","/api/requests",json!({"leave_type_id":1,"start_date":start,"end_date":end,"start_part":"full","end_part":"full"})).await
    }
    pub async fn approve(&mut self, id: i64) -> Value {
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
