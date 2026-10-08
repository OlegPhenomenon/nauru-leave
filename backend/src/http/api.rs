use super::{
    runtime::{self, AppState, Database},
    Config,
};
use crate::{
    admin,
    authz::{self, Action, Actor, Resource},
    clock::Mode,
    db,
    files::FileStore,
    imports_exports as ie, ledger,
    model::{self, date_s, Part},
    presentation as view, queries, requests, sessions, DomainError, Res,
};
use axum::{
    body::to_bytes,
    extract::{FromRequest, Multipart, Query, Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    net::IpAddr,
    sync::Arc,
};
use time::Date;
#[derive(Default)]
struct Input {
    json: Value,
    fields: HashMap<String, String>,
    file: Option<(String, Vec<u8>)>,
    raw: Vec<u8>,
}
struct Output {
    body: Value,
    bytes: Option<Vec<u8>>,
    content_type: String,
    filename: Option<String>,
    cookies: Vec<String>,
    status: StatusCode,
}
impl Output {
    fn json(body: Value) -> Self {
        Self {
            body,
            bytes: None,
            content_type: "application/json".into(),
            filename: None,
            cookies: vec![],
            status: StatusCode::OK,
        }
    }
    fn empty() -> Self {
        let mut o = Self::json(Value::Null);
        o.status = StatusCode::NO_CONTENT;
        o
    }
    fn file(bytes: Vec<u8>, mime: &str, name: &str) -> Self {
        let mut o = Self::json(Value::Null);
        o.bytes = Some(bytes);
        o.content_type = mime.into();
        o.filename = Some(name.into());
        o
    }
}
impl IntoResponse for Output {
    fn into_response(self) -> Response {
        let mut response = if let Some(bytes) = self.bytes {
            (self.status, bytes).into_response()
        } else if self.status == StatusCode::NO_CONTENT {
            self.status.into_response()
        } else {
            (self.status, Json(self.body)).into_response()
        };
        response
            .headers_mut()
            .insert("content-type", self.content_type.parse().unwrap());
        for cookie in self.cookies {
            response
                .headers_mut()
                .append("set-cookie", cookie.parse().unwrap());
        }
        if let Some(filename) = self.filename {
            let safe = filename
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.'))
                .take(150)
                .collect::<String>();
            response.headers_mut().insert(
                "content-disposition",
                format!("attachment; filename=\"{safe}\"").parse().unwrap(),
            );
            response
                .headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            response
                .headers_mut()
                .insert("cache-control", "no-store".parse().unwrap());
        }
        response
    }
}
fn set_cookie(config: &Config, name: &str, value: &str) -> String {
    format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax{}{}",
        if config.mode == Mode::Production || config.public_url.starts_with("https://") {
            "; Secure"
        } else {
            ""
        },
        if value.is_empty() { "; Max-Age=0" } else { "" }
    )
}
fn origin(headers: &HeaderMap, config: &Config) -> Res<()> {
    let expected = config.public_url.trim_end_matches('/');
    let valid = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s == expected)
        .unwrap_or_else(|| {
            headers
                .get("referer")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|s| {
                    s == expected || s.strip_prefix(expected).is_some_and(|s| s.starts_with('/'))
                })
        });
    if valid {
        Ok(())
    } else {
        Err(DomainError::forbidden(
            "Origin does not match NLD_PUBLIC_URL",
        ))
    }
}
fn csrf(headers: &HeaderMap, session: &sessions::Session) -> Res<()> {
    if headers.get("x-csrf-token").and_then(|h| h.to_str().ok()) == Some(&session.csrf_token) {
        Ok(())
    } else {
        Err(DomainError::forbidden("CSRF token required"))
    }
}
pub(super) async fn handle(State(state): State<Arc<AppState>>, req: Request) -> Response {
    match handle_inner(state, req).await {
        Ok(o) => o.into_response(),
        Err(e) => e.into_response(),
    }
}
async fn handle_inner(state: Arc<AppState>, req: Request) -> Res<Output> {
    let path = req.uri().path().trim_start_matches("/api/").to_string();
    let method = req.method().clone();
    let headers = req.headers().clone();
    let ip = runtime::client_ip(&req, state.config.trust_proxy_headers);
    let query = Query::<HashMap<String, String>>::try_from_uri(req.uri())
        .map_err(|e| DomainError::validation(e.to_string()))?
        .0;
    if method != Method::GET {
        origin(&headers, &state.config)?;
    }
    // Reject unauthorized mutations before buffering large multipart bodies.
    if method != Method::GET
        && ![
            "demo/start",
            "demo/reset",
            "demo/login",
            "auth/login",
            "auth/totp",
        ]
        .contains(&path.as_str())
    {
        let preflight = headers.clone();
        state
            .blocking(move |s| {
                let lock = s
                    .lock(&runtime::cookie(&preflight, "nld_sbx").unwrap_or_else(|| "main".into()));
                let _guard = lock.lock().unwrap();
                let database = s.resolve(&preflight)?;
                let conn = db::open(&database.path)?;
                let token = runtime::cookie(&preflight, "nld_session")
                    .ok_or(DomainError::Unauthenticated)?;
                let session = sessions::load(&conn, &token, true)?;
                csrf(&preflight, &session)
            })
            .await?;
    }
    let mut input = Input::default();
    if method != Method::GET && method != Method::DELETE {
        if headers
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| s.starts_with("multipart/form-data"))
        {
            let mut multipart = Multipart::from_request(req, &state)
                .await
                .map_err(|e| DomainError::validation(e.to_string()))?;
            while let Some(field) = multipart
                .next_field()
                .await
                .map_err(|e| DomainError::validation(e.to_string()))?
            {
                let name = field.name().unwrap_or("").to_string();
                let filename = field.file_name().map(str::to_owned);
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| DomainError::validation(e.to_string()))?;
                if name == "file" {
                    if input.file.is_some() {
                        return Err(DomainError::validation("one file per upload"));
                    }
                    input.file = Some((filename.unwrap_or_else(|| "upload".into()), data.to_vec()));
                } else {
                    if data.len() > 4096 {
                        return Err(DomainError::validation("multipart field too large"));
                    }
                    input.fields.insert(
                        name,
                        String::from_utf8(data.to_vec())
                            .map_err(|_| DomainError::validation("field must be UTF-8"))?,
                    );
                }
            }
        } else {
            input.raw = to_bytes(req.into_body(), 256 * 1024)
                .await
                .map_err(|_| DomainError::validation("JSON body too large"))?
                .to_vec();
            input.json = if input.raw.is_empty() {
                json!({})
            } else {
                serde_json::from_slice(&input.raw)
                    .map_err(|e| DomainError::validation(format!("invalid JSON: {e}")))?
            };
        }
    }
    state
        .blocking(move |s| dispatch(s, &method, &path, &headers, &query, input, ip))
        .await
}
fn app_config(config: &Config, db: Option<&Database>, conn: Option<&Connection>) -> Res<Value> {
    let today = if let Some(conn) = conn {
        config.clock().today(conn)?
    } else if config.mode == Mode::Demo {
        model::parse_date("2026-10-08")?
    } else {
        time::OffsetDateTime::now_utc().date()
    };
    let mut v = json!({"mode":if config.mode==Mode::Demo{"demo"}else{"production"},"business_date":date_s(&today),"app_version":env!("CARGO_PKG_VERSION")});
    if let Some(id) = db.and_then(|d| d.sandbox_id.as_ref()) {
        v["sandbox_id"] = json!(id);
    }
    Ok(v)
}
fn dispatch(
    state: &AppState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    q: &HashMap<String, String>,
    input: Input,
    ip: IpAddr,
) -> Res<Output> {
    let config = &state.config;
    if path == "demo/start" || path == "demo/reset" {
        let reset = if path.ends_with("reset") {
            Some(runtime::cookie(headers, "nld_sbx").ok_or(DomainError::Unauthenticated)?)
        } else {
            None
        };
        if reset.is_some() {
            if let Ok(database) = state.resolve(headers) {
                let conn = db::open(&database.path)?;
                if let Some(token) = runtime::cookie(headers, "nld_session") {
                    if let Ok(session) = sessions::load(&conn, &token, true) {
                        csrf(headers, &session)?;
                    }
                }
            }
        }
        let database = state.start(ip, reset.as_deref())?;
        let id = database.sandbox_id.unwrap();
        let mut out = Output::json(json!({"sandbox_id":id}));
        out.cookies.push(set_cookie(config, "nld_sbx", &id));
        out.cookies.push(set_cookie(config, "nld_session", ""));
        return Ok(out);
    }
    // The same lock is held from generation resolution until the connection closes.
    let lock = state.lock(&runtime::cookie(headers, "nld_sbx").unwrap_or_else(|| "main".into()));
    let _guard = lock.lock().unwrap();
    let database = state.resolve(headers);
    if path == "demo/status" {
        return Ok(Output::json(match database {
            Ok(ref d) => {
                let created: i64 = state.registry()?.query_row(
                    "SELECT created_at FROM sandboxes WHERE id=?1",
                    [d.sandbox_id.as_ref().unwrap()],
                    |r| r.get(0),
                )?;
                json!({"has_sandbox":true,"sandbox_id":d.sandbox_id,"created_at":time::OffsetDateTime::from_unix_timestamp(created).unwrap().format(&time::format_description::well_known::Rfc3339).unwrap()})
            }
            Err(_) => json!({"has_sandbox":false}),
        }));
    }
    if path == "config" && database.is_err() {
        return Ok(Output::json(app_config(config, None, None)?));
    }
    let database = database?;
    let mut conn = db::open(&database.path)?;
    let clock = config.clock();
    if path == "config" {
        return Ok(Output::json(app_config(
            config,
            Some(&database),
            Some(&conn),
        )?));
    }
    let old = runtime::cookie(headers, "nld_session");
    if path == "demo/personas" {
        let titles = [
            (
                "Alexei Novak",
                "Employee — start here",
                "Submit leave, follow approvals, then amend it.",
            ),
            ("Olga Berg", "Manager", "Review your team's requests."),
            (
                "Maria Santos",
                "HR officer",
                "Check requests and inspect a medical file.",
            ),
            ("Elena Ward", "Final approver", "Record the final decision."),
            (
                "David Hale",
                "HR · second approver for adjustments",
                "Apply a correction proposed by another officer.",
            ),
            (
                "Pavel Grant",
                "Technical admin",
                "Manage users and retry notifications.",
            ),
            ("Grace Lin", "Auditor", "Read the audit trail."),
            (
                "Nia Fox",
                "Employee with a medical file",
                "Open your medical certificate.",
            ),
            (
                "Tom Reed",
                "Employee, acting manager in December",
                "Try time travel and the delegation.",
            ),
        ];
        let mut out = Vec::new();
        for (name, title, story) in titles {
            let id: i64 =
                conn.query_row("SELECT id FROM users WHERE display_name=?1", [name], |r| {
                    r.get(0)
                })?;
            let actor = Actor::load(&conn, id, clock.today(&conn)?)?;
            out.push(json!({"user_id":id,"display_name":name,"title":title,"roles":actor.roles.iter().map(|r|&r.role).collect::<Vec<_>>(),"story":story}));
        }
        return Ok(Output::json(json!(out)));
    }
    if path == "demo/login" {
        let uid = admin::integer(&input.json, "user_id")?;
        let token = sessions::create(&mut conn, uid, true, old.as_deref())?;
        let session = sessions::load(&conn, &token, true)?;
        let actor = Actor::load(&conn, uid, clock.today(&conn)?)?;
        let mut out = Output::json(view::me(&conn, &actor, &session)?);
        out.cookies.push(set_cookie(config, "nld_session", &token));
        return Ok(out);
    }
    if path == "auth/login" {
        let (token, needs) = sessions::password_login(
            &mut conn,
            &clock,
            admin::text(&input.json, "email")?,
            admin::text(&input.json, "password")?,
            old.as_deref(),
        )?;
        let mut out = Output::json(json!({"needs_totp":needs}));
        out.cookies.push(set_cookie(config, "nld_session", &token));
        return Ok(out);
    }
    let session = sessions::load(
        &conn,
        old.as_deref().ok_or(DomainError::Unauthenticated)?,
        path != "auth/totp",
    )?;
    if path == "auth/totp" {
        let token = sessions::totp(&mut conn, &session, admin::text(&input.json, "code")?)?;
        let session = sessions::load(&conn, &token, true)?;
        let actor = Actor::load(&conn, session.user_id, clock.today(&conn)?)?;
        let mut out = Output::json(view::me(&conn, &actor, &session)?);
        out.cookies.push(set_cookie(config, "nld_session", &token));
        return Ok(out);
    }
    if method != Method::GET {
        csrf(headers, &session)?;
    }
    let actor = Actor::load(&conn, session.user_id, clock.today(&conn)?)?;
    if path == "me" {
        return Ok(Output::json(view::me(&conn, &actor, &session)?));
    }
    if path == "auth/logout" {
        sessions::logout(&mut conn, &session)?;
        let mut out = Output::empty();
        out.cookies.push(set_cookie(config, "nld_session", ""));
        return Ok(out);
    }
    if path == "demo/mailbox" {
        return Ok(Output::json(
            json!({"items":view::rows(&conn,"SELECT id,to_email,subject,body,delivered_at FROM mailbox ORDER BY id DESC",&[])?}),
        ));
    }
    if path == "demo/clock" {
        crate::admin::set_demo_clock(&mut conn, &clock, &actor, admin::date(&input.json, "date")?)?;
        return Ok(Output::json(app_config(
            config,
            Some(&database),
            Some(&conn),
        )?));
    }
    let segments = path.split('/').collect::<Vec<_>>();
    if method == Method::GET {
        return read(&conn, &actor, &database, &segments, q);
    }
    if path == "requests/preview" {
        let draft = draft(&input.json)?;
        return Ok(Output::json(crate::presentation::preview(
            &mut conn,
            &clock,
            &actor,
            &draft,
            input.json["amend_of"].as_i64(),
            input.json["cancel_of"].as_i64(),
        )?));
    }
    if path == "imports/preview" {
        let (name, bytes) = input
            .file
            .ok_or_else(|| DomainError::validation("file required"))?;
        return Ok(Output::json(serde_json::to_value(ie::import_preview(
            &mut conn,
            &clock,
            &actor,
            input
                .fields
                .get("kind")
                .map(String::as_str)
                .ok_or_else(|| DomainError::validation("kind required"))?,
            input.fields.get("mode").map(String::as_str),
            &name,
            &bytes,
        )?)?));
    }
    if segments.first() == Some(&"requests") && segments.get(2) == Some(&"attachments") {
        let id = parse_id(segments[1])?;
        let (name, bytes) = input
            .file
            .ok_or_else(|| DomainError::validation("file required"))?;
        let store = FileStore::new(&database.files)?;
        let aid = crate::admin::upload(
            &mut conn,
            &clock,
            &actor,
            &store,
            id,
            &name,
            &bytes,
            input
                .fields
                .get("sensitivity")
                .map(String::as_str)
                .unwrap_or("normal"),
            config.mode == Mode::Demo,
        )?;
        if let Some(id) = &database.sandbox_id {
            let bytes: i64 = conn.query_row(
                "SELECT COALESCE(SUM(size_bytes),0) FROM attachments",
                [],
                |r| r.get(0),
            )?;
            state.registry()?.execute(
                "UPDATE sandboxes SET bytes=?2 WHERE id=?1",
                params![id, bytes],
            )?;
        }
        return Ok(Output::json(view::attachment(&conn, &actor, aid)?));
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    if key.as_ref().is_some_and(|k| k.is_empty() || k.len() > 200) {
        return Err(DomainError::validation("invalid Idempotency-Key"));
    }
    let idempotent = segments[0] == "requests"
        && matches!(
            segments.get(2),
            Some(&"submit" | &"decide" | &"amend" | &"cancel")
        );
    let receipt = key.filter(|_| idempotent);
    let hash = hex::encode(Sha256::digest(
        [
            method.as_str().as_bytes(),
            b"/api/",
            path.as_bytes(),
            b"\n",
            &input.raw,
        ]
        .concat(),
    ));
    let value = db::atomic(&mut conn, |conn| {
        if let Some(key) = &receipt {
            if let Some((h,body))=conn.query_row("SELECT request_hash,response_json FROM idempotency_keys WHERE user_id=?1 AND key=?2",params![actor.user_id,format!("http:{key}")],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?{
                if h!=hash{return Err(DomainError::IdempotencyKeyReused);}
                let mut v:Value=serde_json::from_str(&body)?;let id=v["id"].as_i64().ok_or_else(||DomainError::validation("invalid receipt"))?;
                let request=model::load_request(conn,id)?;let ctx=requests::request_ctx(conn,&request,actor.today)?;authz::require(conn,&actor,Action::ViewRequest,&Resource::Request(&ctx))?;
                crate::presentation::redact_cached(conn,&actor,&mut v)?;
                return Ok(v);
            }
        }
        let pending_before: i64 =
            conn.query_row("SELECT COALESCE(MAX(id),0) FROM notifications", [], |r| {
                r.get(0)
            })?;
        let v = write(
            conn,
            &actor,
            &clock,
            config.mode,
            &segments,
            method.as_str(),
            q,
            &input.json,
        )?;
        let pending_after: i64 =
            conn.query_row("SELECT COALESCE(MAX(id),0) FROM notifications", [], |r| {
                r.get(0)
            })?;
        if pending_before == pending_after {
            crate::notify::record_change(conn, &clock, actor.user_id, path)?;
        }
        if let Some(key) = &receipt {
            conn.execute("INSERT INTO idempotency_keys(key,user_id,request_hash,response_json,created_at) VALUES(?1,?2,?3,?4,?5)",params![format!("http:{key}"),actor.user_id,hash,v.to_string(),clock.now_ts()])?;
        }
        Ok(v)
    })?;
    if method == Method::DELETE && segments[0] == "requests" {
        Ok(Output::empty())
    } else {
        Ok(Output::json(value))
    }
}
fn parse_id(s: &str) -> Res<i64> {
    s.parse().map_err(|_| DomainError::validation("invalid id"))
}
fn qid(q: &HashMap<String, String>, name: &str) -> Res<Option<i64>> {
    q.get(name).map(|s| parse_id(s)).transpose()
}
fn qdate(q: &HashMap<String, String>, name: &str, default: Date) -> Res<Date> {
    q.get(name)
        .map(|s| model::parse_date(s))
        .transpose()
        .map(|d| d.unwrap_or(default))
}
fn paginate(mut items: Vec<Value>, q: &HashMap<String, String>) -> Res<Value> {
    let total = items.len();
    let offset = qid(q, "offset")?.unwrap_or(0);
    let limit = qid(q, "limit")?.unwrap_or(100);
    if offset < 0 || limit < 0 {
        return Err(DomainError::validation("pagination cannot be negative"));
    }
    let items = items
        .drain(..)
        .skip(offset as usize)
        .take(limit.min(500) as usize)
        .collect::<Vec<_>>();
    Ok(json!({"items":items,"total":total}))
}
fn draft(v: &Value) -> Res<requests::DraftInput> {
    Ok(requests::DraftInput {
        employee_id: v["employee_id"].as_i64(),
        leave_type_id: admin::integer(v, "leave_type_id")?,
        start_date: admin::date(v, "start_date")?,
        end_date: admin::date(v, "end_date")?,
        start_part: Part::parse(v["start_part"].as_str().unwrap_or("full"))?,
        end_part: Part::parse(v["end_part"].as_str().unwrap_or("full"))?,
        note: admin::optional(v, "note").map(str::to_owned),
        paper: v["source"] == "paper",
        paper_received_date: admin::optional(v, "paper_received_date")
            .map(model::parse_date)
            .transpose()?,
        previous_request_id: v["previous_request_id"].as_i64(),
    })
}
fn revise(v: &Value) -> Res<requests::ReviseInput> {
    let d = draft(v)?;
    Ok(requests::ReviseInput {
        leave_type_id: d.leave_type_id,
        start_date: d.start_date,
        end_date: d.end_date,
        start_part: d.start_part,
        end_part: d.end_part,
        note: d.note,
        change_reason: admin::text(v, "change_reason")?.into(),
    })
}
fn write(
    conn: &mut Connection,
    a: &Actor,
    clock: &crate::clock::Clock,
    mode: Mode,
    p: &[&str],
    method: &str,
    q: &HashMap<String, String>,
    v: &Value,
) -> Res<Value> {
    let id = p
        .get(1)
        .filter(|_| !["accruals", "periods", "ops"].contains(&p[0]))
        .map(|s| parse_id(s))
        .transpose()?;
    if p[0] == "requests" {
        let result_id = if let Some(id) = id {
            let version = || admin::integer(v, "expected_version");
            match (method, p.get(2).copied()) {
                ("PUT", None) => {
                    requests::update_draft(conn, clock, a, id, &draft(v)?, version()?)?
                }
                ("DELETE", None) => {
                    requests::delete_draft(
                        conn,
                        clock,
                        a,
                        id,
                        qid(q, "expected_version")?
                            .ok_or_else(|| DomainError::validation("expected_version required"))?,
                    )?;
                    return Ok(Value::Null);
                }
                ("POST", Some("submit")) => {
                    requests::submit(conn, clock, a, id, version()?, None)?;
                }
                ("POST", Some("withdraw")) => requests::withdraw(
                    conn,
                    clock,
                    a,
                    id,
                    admin::optional(v, "reason"),
                    version()?,
                )?,
                ("POST", Some("decide")) => requests::decide(
                    conn,
                    clock,
                    a,
                    id,
                    admin::integer(v, "step_id")?,
                    admin::text(v, "outcome")?,
                    admin::optional(v, "reason"),
                    admin::optional(v, "basis_document"),
                    version()?,
                    None,
                )?,
                ("POST", Some("messages")) => {
                    requests::comment(conn, clock, a, id, admin::text(v, "body")?)?
                }
                ("POST", Some("respond")) => requests::respond(
                    conn,
                    clock,
                    a,
                    id,
                    version()?,
                    admin::text(v, "body")?,
                    if v["changes"].is_object() {
                        Some(revise(&v["changes"])?)
                    } else {
                        None
                    },
                )?,
                ("POST", Some("amend")) => {
                    let child = requests::amend(conn, clock, a, id, &revise(v)?, version()?, None)?;
                    return view::detail(conn, a, child.request_id);
                }
                ("POST", Some("cancel")) => {
                    let child = requests::cancel(
                        conn,
                        clock,
                        a,
                        id,
                        admin::date(v, "from_date")?,
                        admin::date(v, "to_date")?,
                        admin::text(v, "change_reason")?,
                        version()?,
                        None,
                    )?;
                    return view::detail(conn, a, child.request_id);
                }
                ("POST", Some("reassign")) => requests::reassign(
                    conn,
                    clock,
                    a,
                    id,
                    admin::integer(v, "step_id")?,
                    v["assignee_user_id"].as_i64(),
                    version()?,
                )?,
                ("POST", Some("actual")) => {
                    requests::actual_period(
                        conn,
                        clock,
                        a,
                        id,
                        admin::text(v, "action")?,
                        admin::text(v, "note")?,
                        v["minutes_delta"].as_i64(),
                        admin::optional(v, "basis_document"),
                        version()?,
                    )?;
                }
                _ => return Err(DomainError::not_found("request action")),
            }
            id
        } else {
            requests::create_draft(conn, clock, a, &draft(v)?)?
        };
        return view::detail(conn, a, result_id);
    }
    match (p[0], id, p.get(2).copied()) {
        ("employees", Some(id), Some("transfer")) => {
            crate::people::transfer(
                conn,
                clock,
                a,
                id,
                admin::integer(v, "org_unit_id")?,
                v["manager_employee_id"].as_i64(),
                admin::date(v, "valid_from")?,
                v["reassign_open_steps"].as_bool().unwrap_or(false),
            )?;
            employee_detail(conn, a, id)
        }
        ("adjustments", None, _) => {
            let id = ledger::propose_adjustment(
                conn,
                clock,
                a,
                admin::integer(v, "employee_id")?,
                admin::integer(v, "leave_type_id")?,
                admin::period_year(v)?,
                admin::integer(v, "minutes")?,
                admin::text(v, "reason")?,
                admin::text(v, "basis_document")?,
                None,
            )?;
            adjustments(conn, a)?
                .into_iter()
                .find(|r| r["id"] == id)
                .ok_or_else(|| DomainError::not_found("adjustment"))
        }
        ("adjustments", Some(id), Some("decide")) => {
            let decision = admin::text(v, "decision")?;
            if !["apply", "reject"].contains(&decision) {
                return Err(DomainError::validation("decision must be apply or reject"));
            }
            ledger::decide_adjustment(
                conn,
                clock,
                a,
                id,
                decision == "apply",
                admin::text(v, "note")?,
            )?;
            Ok(json!({"id":id}))
        }
        ("accruals", _, _) => {
            let r = ledger::run_accrual(
                conn,
                clock,
                a,
                admin::integer(v, "leave_type_id")?,
                admin::period_year(v)?,
                v["month"].as_i64(),
            )?;
            Ok(json!({"posted":r.posted,"skipped_existing":r.skipped_existing}))
        }
        ("periods", _, _) => Ok(
            json!({"posted":ledger::close_period(conn,clock,a,admin::integer(v,"leave_type_id")?,admin::period_year(v)?)?}),
        ),
        ("exports", None, _) => {
            let r = ie::create_export(
                conn,
                clock,
                a,
                admin::date(v, "from")?,
                admin::date(v, "to")?,
            )?;
            Ok(export_record(r))
        }
        ("exports", Some(id), Some("mark-transferred")) => {
            ie::mark_transferred(conn, clock, a, id, admin::optional(v, "note"))?;
            Ok(export_record(ie::load_export(conn, id)?.0))
        }
        ("imports", Some(id), Some("commit")) => Ok(serde_json::to_value(ie::import_commit(
            conn, clock, a, id,
        )?)?),
        ("delegations", None, _) => {
            let id = crate::people::create_delegation(
                conn,
                clock,
                a,
                admin::integer(v, "from_user_id")?,
                admin::integer(v, "to_user_id")?,
                admin::text(v, "scope")?,
                admin::date(v, "valid_from")?,
                admin::date(v, "valid_to")?,
                admin::text(v, "reason")?,
            )?;
            Ok(json!({"id":id}))
        }
        ("delegations", Some(id), Some("revoke")) => {
            crate::people::revoke_delegation(conn, clock, a, id)?;
            Ok(json!({"id":id}))
        }
        ("ops", _, _) if p.get(1) == Some(&"notifications") && p.get(3) == Some(&"retry") => {
            let id = parse_id(p[2])?;
            crate::notify::retry(conn, clock, a, id)?;
            Ok(json!({"id":id}))
        }
        _ => admin::mutate(conn, clock, a, mode, method, p, v),
    }
}
fn export_record(r: ie::ExportRecord) -> Value {
    json!({"id":r.id,"from":r.period_from,"to":r.period_to,"row_count":r.row_count,"sha256":r.sha256,"created_at":r.created_at,"transferred_at":r.transferred_at,"transferred_by":r.transferred_by})
}
fn read(
    conn: &Connection,
    a: &Actor,
    database: &Database,
    p: &[&str],
    q: &HashMap<String, String>,
) -> Res<Output> {
    let id = p.get(1).and_then(|s| s.parse::<i64>().ok());
    let on = qdate(q, "date", a.today)?;
    let result = match (p[0], id, p.get(2).copied()) {
        ("leave-types", _, _) => {
            json!(
                view::ids(conn, "SELECT id FROM leave_types ORDER BY code", &[])?
                    .into_iter()
                    .map(|id| view::leave_type(conn, id, a.today))
                    .collect::<Res<Vec<_>>>()?
            )
        }
        ("balances", _, _) => {
            let employee = if p.get(1) == Some(&"me") {
                Some(
                    a.employee_id
                        .ok_or_else(|| DomainError::forbidden("no employee record"))?,
                )
            } else {
                id
            };
            if let Some(employee) = employee {
                view::can_balance(conn, a, employee)?;
                if p.get(2) == Some(&"explain") {
                    let lt = qid(q, "leave_type_id")?
                        .ok_or_else(|| DomainError::validation("leave_type_id required"))?;
                    let summary = queries::balance_summaries(conn, employee, on)?
                        .into_iter()
                        .find(|s| s.leave_type.id == lt)
                        .ok_or_else(|| DomainError::not_found("leave type"))?;
                    json!({"entries":view::ledger_entries(conn,employee,lt,on)?,"reservations":queries::reservations_of(conn,employee,lt)?,"summary":summary})
                } else {
                    serde_json::to_value(queries::balance_summaries(conn, employee, on)?)?
                }
            } else {
                let mut out = Vec::new();
                for id in view::ids(conn, "SELECT id FROM employees WHERE active=1", &[])? {
                    if view::can_balance(conn, a, id).is_err() {
                        continue;
                    }
                    if !unit_filter(conn, id, q, a.today)? {
                        continue;
                    }
                    for s in queries::balance_summaries(conn, id, on)? {
                        if qid(q, "leave_type_id")?.is_some_and(|i| i != s.leave_type.id) {
                            continue;
                        }
                        out.push(json!({"employee":view::employee(conn,id,a.today)?,"summary":s}));
                    }
                }
                paginate(out, q)?
            }
        }
        ("requests", Some(id), _) => view::detail(conn, a, id)?,
        ("requests", None, _) => {
            let scope = q.get("scope").map(String::as_str).unwrap_or("mine");
            if !["mine", "team", "all"].contains(&scope) {
                return Err(DomainError::validation("invalid request scope"));
            }
            let mut out = Vec::new();
            for id in view::ids(conn, "SELECT id FROM leave_requests ORDER BY id DESC", &[])? {
                let r = model::load_request(conn, id)?;
                if scope == "mine" && a.employee_id != Some(r.employee_id) {
                    continue;
                }
                if scope == "team" && !a.is_manager_of(r.employee_id) && a.delegations_in.is_empty()
                {
                    continue;
                }
                if q.get("status").is_some_and(|s| s != r.status.as_str())
                    || qid(q, "employee_id")?.is_some_and(|i| i != r.employee_id)
                {
                    continue;
                }
                if let Ok(s) = view::summary(conn, a, id) {
                    if q.get("from")
                        .is_some_and(|d| s["end_date"].as_str().unwrap_or("") < d.as_str())
                        || q.get("to")
                            .is_some_and(|d| s["start_date"].as_str().unwrap_or("") > d.as_str())
                    {
                        continue;
                    }
                    out.push(s);
                }
            }
            paginate(out, q)?
        }
        ("attachments", Some(id), _) => {
            let (bytes, mime, name) =
                crate::admin::download(conn, a, &FileStore::new(&database.files)?, id)?;
            return Ok(Output::file(bytes, &mime, &name));
        }
        ("approvals", _, _) => {
            let mut items = Vec::new();
            let mut problems = Vec::new();
            for id in view::ids(conn,"SELECT id FROM leave_requests WHERE status IN ('submitted','under_review','needs_information')",&[])? {
                let r=model::load_request(conn,id)?;let ctx=requests::request_ctx(conn,&r,a.today)?;
                if let Some(s)=requests::pending_step(conn,id)? {
                    if let Ok(authority)=authz::decide_authority(conn,a,&ctx,&s) {let mut v=view::summary(conn,a,id)?;v["step"]=view::step(conn,&s)?;v["acting_for"]=view::user(conn,authority.acting_for_user_id)?;v["warnings"]=view::detail(conn,a,id)?["warnings"].clone();items.push(v);}
                    if s.kind==model::StepKind::ManagerRecommendation && s.assignee_user_id.is_none() && a.role_in_scope(conn,"hr",ctx.org_unit_id)? {let mut v=view::summary(conn,a,id)?;v["problem"]=json!("No manager assigned");problems.push(v);}
                }
            }
            json!({"items":items,"problems":problems})
        }
        ("calendar", _, _) => calendar(conn, a, q)?,
        ("org-units", _, _) => {
            let mut out = view::rows(
                conn,
                "SELECT id,code,name,parent_id,active FROM org_units ORDER BY name",
                &[],
            )?;
            for v in &mut out {
                v["active"] = json!(v["active"] == 1);
            }
            paginate(out, q)?
        }
        ("employees", Some(id), _) => employee_detail(conn, a, id)?,
        ("employees", None, _) => {
            let mut out = Vec::new();
            for id in view::ids(conn, "SELECT id FROM employees ORDER BY service_id", &[])? {
                if !directory_access(conn, a, id)? {
                    continue;
                }
                let v = employee_item(conn, a, id)?;
                if v["active"] == false
                    && q.get("include_inactive").map(String::as_str) != Some("true")
                {
                    continue;
                }
                if !unit_filter(conn, id, q, a.today)? {
                    continue;
                }
                if let Some(search) = q.get("q") {
                    let search = search.to_lowercase();
                    if !v["full_name"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&search)
                        && !v["service_id"]
                            .as_str()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&search)
                    {
                        continue;
                    }
                }
                out.push(v);
            }
            paginate(out, q)?
        }
        ("adjustments", _, _) => {
            let rows = adjustments(conn, a)?
                .into_iter()
                .filter(|v| {
                    q.get("status")
                        .is_none_or(|s| v["status"].as_str() == Some(s))
                })
                .collect();
            paginate(rows, q)?
        }
        ("reports", _, _) => {
            let rows = report(conn, a, p.get(1).copied().unwrap_or(""), q)?;
            if q.get("format").map(String::as_str) == Some("csv") {
                return Ok(Output::file(
                    json_csv(&rows)?,
                    "text/csv; charset=utf-8",
                    "report.csv",
                ));
            }
            let mut response = paginate(rows.clone(), q)?;
            if p.get(1) == Some(&"absences") {
                response["total_days"] = json!(rows.len());
                response["total_minutes"] = json!(rows
                    .iter()
                    .filter_map(|r| r["minutes"].as_i64())
                    .sum::<i64>());
            }
            response
        }
        ("exports", Some(id), Some("download")) => {
            authz::require(conn, a, Action::ManageImportsExports, &Resource::Global)?;
            let (_, bytes) = ie::authorized_export(conn, a, id)?;
            return Ok(Output::file(
                bytes,
                "text/csv; charset=utf-8",
                "transfer.csv",
            ));
        }
        ("exports", None, _) => {
            let out =
                if authz::can(conn, a, Action::ManageImportsExports, &Resource::Global).is_ok() {
                    ie::list_exports(conn)?
                        .into_iter()
                        .filter(|r| ie::authorized_export(conn, a, r.id).is_ok())
                        .map(export_record)
                        .collect()
                } else {
                    vec![]
                };
            paginate(out, q)?
        }
        ("imports", _, _) => {
            authz::require(conn, a, Action::ManageImportsExports, &Resource::Global)?;
            let rows = ie::list_imports(conn)?
                .into_iter()
                .filter(|r| {
                    a.role_in_scope(conn, "hr", None).unwrap_or(false)
                        || conn
                            .query_row(
                                "SELECT created_by FROM import_batches WHERE id=?1",
                                [r["id"].as_i64().unwrap_or(0)],
                                |r| r.get::<_, i64>(0),
                            )
                            .ok()
                            == Some(a.user_id)
                })
                .collect();
            paginate(rows, q)?
        }
        ("schedules", Some(id), Some("versions")) => {
            let mut versions = view::rows(
                conn,
                "SELECT * FROM schedule_versions WHERE schedule_id=?1 ORDER BY valid_from",
                &[&id],
            )?;
            for v in &mut versions {
                v["week"] = json!([
                    v["mon_min"],
                    v["tue_min"],
                    v["wed_min"],
                    v["thu_min"],
                    v["fri_min"],
                    v["sat_min"],
                    v["sun_min"]
                ]);
            }
            paginate(versions, q)?
        }
        ("schedules", _, _) => {
            let mut rows = view::rows(conn, "SELECT id,name FROM schedules ORDER BY id", &[])?;
            for s in &mut rows {
                let id = s["id"].as_i64().unwrap();
                let mut versions = view::rows(
                    conn,
                    "SELECT * FROM schedule_versions WHERE schedule_id=?1 ORDER BY valid_from",
                    &[&id],
                )?;
                for v in &mut versions {
                    v["week"] = json!([
                        v["mon_min"],
                        v["tue_min"],
                        v["wed_min"],
                        v["thu_min"],
                        v["fri_min"],
                        v["sat_min"],
                        v["sun_min"]
                    ]);
                }
                s["versions"] = json!(versions);
            }
            paginate(rows, q)?
        }
        ("calendar-exceptions", _, _) => paginate(
            view::rows(
                conn,
                "SELECT id,date,name,minutes,schedule_id FROM calendar_exceptions ORDER BY date",
                &[],
            )?,
            q,
        )?,
        ("users", _, _) => {
            authz::require(conn, a, Action::ManageUsers, &Resource::Global)?;
            let mut out = view::rows(
                conn,
                "SELECT id,email,display_name,active FROM users ORDER BY id",
                &[],
            )?;
            for u in &mut out {
                let id = u["id"].as_i64().unwrap();
                u["active"] = json!(u["active"] == 1);
                let emp: Option<i64> = conn
                    .query_row("SELECT id FROM employees WHERE user_id=?1", [id], |r| {
                        r.get(0)
                    })
                    .optional()?;
                u["employee"] = emp
                    .map(|id| view::employee(conn, id, a.today))
                    .transpose()?
                    .unwrap_or(Value::Null);
                u["roles"]=json!(view::rows(conn,"SELECT r.id,r.role,r.scope_org_unit_id,COALESCE(o.name,'Whole service') AS scope_name FROM role_grants r LEFT JOIN org_units o ON o.id=r.scope_org_unit_id WHERE r.user_id=?1 AND r.valid_from<=?2 AND (r.valid_to IS NULL OR r.valid_to>=?2)",&[&id,&date_s(&a.today)])?);
            }
            paginate(out, q)?
        }
        ("delegations", _, _) => {
            let mut rows = view::rows(conn, "SELECT * FROM delegations ORDER BY id DESC", &[])?;
            rows.retain(|d| {
                d["from_user_id"] == a.user_id
                    || d["to_user_id"] == a.user_id
                    || a.has_role("hr")
                    || a.has_role("tech_admin")
            });
            for d in &mut rows {
                d["from_user"] = view::user(conn, d["from_user_id"].as_i64())?;
                d["to_user"] = view::user(conn, d["to_user_id"].as_i64())?;
            }
            paginate(rows, q)?
        }
        ("ops", _, _) => {
            authz::require(conn, a, Action::ViewOperations, &Resource::Global)?;
            if p.get(1) == Some(&"notifications") {
                let mut rows=view::rows(conn,"SELECT id,to_email,subject,status,attempts,last_error,next_attempt_at,created_at,sent_at,recipient_user_id,link_path FROM notifications WHERE (?1 IS NULL OR status=?1) ORDER BY id DESC",&[&q.get("status")])?;
                if !a.has_role("tech_admin") {
                    rows.retain(|n| {
                        n["link_path"]
                            .as_str()
                            .and_then(|s| s.strip_prefix("/requests/"))
                            .and_then(|s| s.parse::<i64>().ok())
                            .map(|id| view::summary(conn, a, id).is_ok())
                            .unwrap_or(
                                n["recipient_user_id"] == a.user_id
                                    || a.role_in_scope(conn, "hr", None).unwrap_or(false),
                            )
                    });
                    for n in &mut rows {
                        n["to_email"] = json!("***@***");
                    }
                }
                for n in &mut rows {
                    n.as_object_mut().unwrap().remove("recipient_user_id");
                    n.as_object_mut().unwrap().remove("link_path");
                }
                paginate(rows, q)?
            } else {
                let counts = view::rows(
                    conn,
                    "SELECT status,COUNT(*) AS count FROM notifications GROUP BY status",
                    &[],
                )?;
                json!({"notifications":counts,"quarantined_files":conn.query_row("SELECT COUNT(*) FROM attachments WHERE scan_status='quarantined'",[],|r|r.get::<_,i64>(0))?,"active_reservation_minutes":conn.query_row("SELECT COALESCE(SUM(minutes),0) FROM reservations WHERE active=1",[],|r|r.get::<_,i64>(0))?,"sandbox_id":database.sandbox_id,"generation":database.generation})
            }
        }
        ("audit", _, _) => {
            authz::require(conn, a, Action::ViewAudit, &Resource::Global)?;
            paginate(
                view::audit_rows(
                    conn,
                    a,
                    q.get("entity").map(String::as_str),
                    qid(q, "entity_id")?,
                    qid(q, "actor_user_id")?,
                )?,
                q,
            )?
        }
        _ => return Err(DomainError::not_found("route")),
    };
    Ok(Output::json(result))
}
fn unit_filter(conn: &Connection, id: i64, q: &HashMap<String, String>, on: Date) -> Res<bool> {
    Ok(qid(q, "org_unit_id")?
        .is_none_or(|unit| model::unit_of(conn, id, on).ok().flatten() == Some(unit)))
}
fn directory_access(conn: &Connection, a: &Actor, id: i64) -> Res<bool> {
    Ok(a.employee_id == Some(id)
        || a.is_manager_of(id)
        || a.has_role("tech_admin")
        || a.any_role_in_scope(
            conn,
            &["hr", "hr_medical", "final_approver", "auditor"],
            model::unit_of(conn, id, a.today)?,
        )?)
}
fn employee_item(conn: &Connection, a: &Actor, id: i64) -> Res<Value> {
    let mut v = view::employee(conn, id, a.today)?;
    let fields = view::rows(
        conn,
        "SELECT email,start_date,end_date,active,user_id FROM employees WHERE id=?1",
        &[&id],
    )?
    .pop()
    .ok_or_else(|| DomainError::not_found("employee"))?;
    for key in ["email", "start_date", "end_date"] {
        v[key] = fields[key].clone();
    }
    v["active"] = json!(fields["active"] == 1);
    v["has_login"] = json!(!fields["user_id"].is_null());
    v["manager"] = model::manager_at(conn, id, a.today)?
        .map(|m| view::employee(conn, m.id, a.today))
        .transpose()?
        .unwrap_or(Value::Null);
    v["schedule"]=view::rows(conn,"SELECT s.id,s.name FROM employee_schedules es JOIN schedules s ON s.id=es.schedule_id WHERE es.employee_id=?1 AND es.valid_from<=?2 AND (es.valid_to IS NULL OR es.valid_to>=?2) ORDER BY es.valid_from DESC LIMIT 1",&[&id,&date_s(&a.today)])?.pop().unwrap_or(Value::Null);
    Ok(v)
}
fn employee_detail(conn: &Connection, a: &Actor, id: i64) -> Res<Value> {
    if !directory_access(conn, a, id)? {
        return Err(DomainError::forbidden("no employee access"));
    }
    let mut v = employee_item(conn, a, id)?;
    let e = model::load_employee(conn, id)?;
    let mut assignments=view::rows(conn,"SELECT org_unit_id,manager_employee_id,valid_from,valid_to FROM employment_assignments WHERE employee_id=?1 ORDER BY valid_from",&[&id])?;
    for x in &mut assignments {
        x["org_unit"] = view::unit(conn, x["org_unit_id"].as_i64())?;
        x["manager"] = x["manager_employee_id"]
            .as_i64()
            .map(|i| view::employee(conn, i, a.today))
            .transpose()?
            .unwrap_or(Value::Null);
    }
    v["assignments"] = json!(assignments);
    v["schedules"]=json!(view::rows(conn,"SELECT s.id,s.name,es.valid_from,es.valid_to FROM employee_schedules es JOIN schedules s ON s.id=es.schedule_id WHERE es.employee_id=?1 ORDER BY es.valid_from",&[&id])?);
    v["user"] = view::user(conn, e.user_id)?;
    if let Some(uid) = e.user_id {
        v["user"]["email"] = json!(model::load_user(conn, uid)?.email);
    }
    if view::can_balance(conn, a, id).is_ok() {
        v["balances"] = serde_json::to_value(queries::balance_summaries(conn, id, a.today)?)?;
    }
    Ok(v)
}
fn adjustments(conn: &Connection, a: &Actor) -> Res<Vec<Value>> {
    let mut rows = queries::list_adjustments(conn, None, a.today)?;
    rows.retain(|r| {
        r["employee"]["id"].as_i64().is_some_and(|id| {
            a.any_role_in_scope(
                conn,
                &["hr", "adjustment_approver", "auditor"],
                model::unit_of(conn, id, a.today).ok().flatten(),
            )
            .unwrap_or(false)
        })
    });
    for v in &mut rows {
        v["proposed_by"] = view::user(conn, v["proposed_by"].as_i64())?;
        v["decided_by"] = view::user(conn, v["decided_by"].as_i64())?;
        let id = v["employee"]["id"].as_i64().unwrap();
        v["employee"] = view::employee(conn, id, a.today)?;
        v["minutes_per_day"] = json!(queries::minutes_per_day(conn, id, a.today)?);
    }
    Ok(rows)
}
fn calendar(conn: &Connection, a: &Actor, q: &HashMap<String, String>) -> Res<Value> {
    let from = qdate(q, "from", a.today)?;
    let to = qdate(q, "to", from + time::Duration::days(31))?;
    if to < from || (to - from).whole_days() > 366 {
        return Err(DomainError::validation(
            "calendar range must be 0..366 days",
        ));
    }
    let mut people = BTreeMap::<i64, Value>::new();
    let mut counts = BTreeMap::<String, (i64, i64)>::new();
    for day in queries::absence_days(conn, qid(q, "org_unit_id")?, from, to)? {
        let request = model::load_request(conn, day.request_id)?;
        let ctx = requests::request_ctx(conn, &request, a.today)?;
        let level = authz::view_level(conn, a, &ctx);
        let readable = level.is_ok();
        let full = matches!(level, Ok(authz::ViewLevel::Full));
        let person = people.entry(day.employee_id).or_insert(
            json!({"employee":view::employee(conn,day.employee_id,a.today)?,"absences":[]}),
        );
        person["absences"].as_array_mut().unwrap().push(json!({"date":date_s(&day.date),"part":day.part,"state":day.state,"label":if day.sensitive || !full {"Away"}else{&day.leave_type_name},"request_id":if readable{Some(day.request_id)}else{None}}));
        let count = counts.entry(date_s(&day.date)).or_default();
        if day.state == "approved" {
            count.0 += 1;
        } else {
            count.1 += 1;
        }
    }
    Ok(
        json!({"from":date_s(&from),"to":date_s(&to),"org_units":view::rows(conn,"SELECT id,name FROM org_units WHERE active=1 ORDER BY name",&[])?,"people":people.into_values().collect::<Vec<_>>(),"counts":counts.into_iter().map(|(date,(approved,pending))|json!({"date":date,"approved":approved,"pending":pending})).collect::<Vec<_>>()}),
    )
}
fn report(
    conn: &Connection,
    a: &Actor,
    name: &str,
    q: &HashMap<String, String>,
) -> Res<Vec<Value>> {
    let from = qdate(q, "from", a.today)?;
    let to = qdate(q, "to", from + time::Duration::days(31))?;
    match name {
        "balances" => {
            let on = qdate(q, "date", a.today)?;
            let mut out = Vec::new();
            for id in view::ids(conn, "SELECT id FROM employees WHERE active=1", &[])? {
                if view::can_balance(conn, a, id).is_err() || !unit_filter(conn, id, q, on)? {
                    continue;
                }
                let e = model::load_employee(conn, id)?;
                for s in queries::balance_summaries(conn, id, on)? {
                    if s.accounts.is_empty() {
                        continue;
                    }
                    out.push(json!({"service_id":e.service_id,"employee":e.full_name,"leave_type_code":s.leave_type.code,"leave_type":s.leave_type.name,"ledger_minutes":s.ledger_minutes,"reserved_minutes":s.reserved_minutes,"available_minutes":s.available_minutes,"minutes_per_day":s.minutes_per_day,"policy":s.policy}));
                }
            }
            Ok(out)
        }
        "absences" => {
            if to < from || (to - from).whole_days() > 3660 {
                return Err(DomainError::validation("invalid report range"));
            }
            let rows = queries::report_absences(conn, from, to, qid(q, "org_unit_id")?)?["rows"]
                .as_array()
                .unwrap()
                .clone();
            Ok(rows
                .into_iter()
                .filter(|v| {
                    v["request_id"]
                        .as_i64()
                        .is_some_and(|id| view::summary(conn, a, id).is_ok())
                })
                .collect())
        }
        "pending" => Ok(queries::report_pending(conn, a.today)?
            .into_iter()
            .filter(|v| {
                v["request_id"]
                    .as_i64()
                    .is_some_and(|id| view::summary(conn, a, id).is_ok())
            })
            .collect()),
        "changes-since-export" => {
            let mut out = Vec::new();
            for r in ie::changes_since_export(conn)? {
                let sid = r["employee_service_id"].as_str().unwrap_or("");
                let id: i64 =
                    conn.query_row("SELECT id FROM employees WHERE service_id=?1", [sid], |r| {
                        r.get(0)
                    })?;
                if view::can_balance(conn, a, id).is_ok() {
                    out.push(r);
                }
            }
            Ok(out)
        }
        "schedule-drift" => Ok(queries::schedule_drift(conn, a.today)?
            .into_iter()
            .filter(|r| view::summary(conn, a, r.request_id).is_ok())
            .map(|r| serde_json::to_value(r).map_err(Into::into))
            .collect::<Res<Vec<_>>>()?),
        _ => Err(DomainError::not_found("report")),
    }
}
fn json_csv(rows: &[Value]) -> Res<Vec<u8>> {
    let mut header = std::collections::BTreeSet::new();
    for row in rows {
        if let Some(obj) = row.as_object() {
            header.extend(obj.keys().cloned());
        }
    }
    let header = header.into_iter().collect::<Vec<_>>();
    let data = rows
        .iter()
        .map(|r| {
            header
                .iter()
                .map(|k| match &r[k] {
                    Value::Null => String::new(),
                    Value::String(s) => s.clone(),
                    v => v.to_string(),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    ie::write_csv(
        &header.iter().map(String::as_str).collect::<Vec<_>>(),
        &data,
    )
}
