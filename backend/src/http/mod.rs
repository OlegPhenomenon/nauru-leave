//! HTTP transport and shared bounded blocking runtime.
mod api;
mod ratelimit;
mod runtime;
pub use runtime::{AppState, Config};

use crate::DomainError;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use rust_embed::RustEmbed;
use std::sync::Arc;

impl IntoResponse for DomainError {
    fn into_response(self) -> Response {
        let message = if matches!(self, Self::Internal(_)) {
            tracing::error!(error=%self, "request failed");
            "An internal error occurred".to_string()
        } else {
            self.message()
        };
        (StatusCode::from_u16(self.http_status()).unwrap(), axum::Json(serde_json::json!({"error":{"code":self.code(),"message":message,"details":self.details()}}))).into_response()
    }
}
#[derive(RustEmbed)]
#[folder = "$NLD_EMBED_DIR/"]
struct Frontend;
async fn static_file(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    if path.starts_with("api/") {
        return DomainError::not_found("API route").into_response();
    }
    let (name, file) = if let Some(f) = Frontend::get(path) {
        (path, f)
    } else if path.starts_with("assets/") {
        return StatusCode::NOT_FOUND.into_response();
    } else {
        ("index.html", Frontend::get("index.html").unwrap())
    };
    let mut response = Body::from(file.data.into_owned()).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        mime_guess::from_path(name)
            .first_or_octet_stream()
            .as_ref()
            .parse()
            .unwrap(),
    );
    let hashed = name.starts_with("assets/")
        && name
            .rsplit('/')
            .next()
            .unwrap_or("")
            .split('.')
            .next()
            .unwrap_or("")
            .rsplit_once('-')
            .is_some_and(|(_, h)| {
                h.len() >= 8 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            });
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        if hashed {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }
        .parse()
        .unwrap(),
    );
    response
}
async fn guard(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let api = req.uri().path().starts_with("/api/");
    // Only API calls are limited; static assets are cheap and a page load fetches several of them.
    let mut response = if api
        && !state
            .requests
            .check(runtime::client_ip(&req, state.config.trust_proxy_headers))
    {
        DomainError::RateLimited.into_response()
    } else {
        next.run(req).await
    };
    if api && response.status() == StatusCode::METHOD_NOT_ALLOWED {
        response=(StatusCode::METHOD_NOT_ALLOWED,axum::Json(serde_json::json!({"error":{"code":"method_not_allowed","message":"This HTTP method is not allowed","details":{}}}))).into_response();
    }
    let h = response.headers_mut();
    h.insert(
        "content-security-policy",
        "default-src 'self'; frame-ancestors 'none'; object-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'"
            .parse()
            .unwrap(),
    );
    h.insert("referrer-policy", "same-origin".parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert("x-frame-options", "DENY".parse().unwrap());
    if api {
        h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    response
}
pub fn router(state: Arc<AppState>) -> Router {
    let mut router = Router::new().route("/up", get(|| async { "ok" }));
    for (path, methods) in ROUTES {
        let mut route = axum::routing::MethodRouter::new();
        for method in methods.split('|') {
            route = route.on(
                match method {
                    "GET" => axum::routing::MethodFilter::GET,
                    "POST" => axum::routing::MethodFilter::POST,
                    "PUT" => axum::routing::MethodFilter::PUT,
                    "DELETE" => axum::routing::MethodFilter::DELETE,
                    _ => unreachable!(),
                },
                api::handle,
            );
        }
        router = router.route(path, route);
    }
    if state.config.mode == crate::clock::Mode::Demo {
        for (path, method) in DEMO_ROUTES {
            router = router.route(
                path,
                if *method == "GET" {
                    axum::routing::get(api::handle)
                } else {
                    axum::routing::post(api::handle)
                },
            );
        }
    }
    router
        .fallback(static_file)
        .layer(axum::extract::DefaultBodyLimit::max(9 * 1024 * 1024))
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}
pub async fn serve(config: Config) -> crate::Res<()> {
    let state = AppState::new(config).await?;
    let worker_state = state.clone();
    let worker = tokio::spawn(async move {
        let mut ticks = tokio::time::interval(std::time::Duration::from_secs(5));
        let mut count = 0u64;
        loop {
            ticks.tick().await;
            if let Err(e) = worker_state.jobs(count.is_multiple_of(120)).await {
                tracing::error!(error=%e,"background jobs");
            }
            count += 1;
        }
    });
    let listener = tokio::net::TcpListener::bind(&state.config.bind).await?;
    tracing::info!(address=%listener.local_addr()?,mode=?state.config.mode,"listening");
    let result = axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await;
    worker.abort();
    result?;
    Ok(())
}

/// Explicit route inventory, also exercised by the HTTP contract smoke test.
pub const DEMO_ROUTES: &[(&str, &str)] = &[
    ("/api/demo/status", "GET"),
    ("/api/demo/start", "POST"),
    ("/api/demo/reset", "POST"),
    ("/api/demo/personas", "GET"),
    ("/api/demo/login", "POST"),
    ("/api/demo/clock", "POST"),
    ("/api/demo/mailbox", "GET"),
];
pub const ROUTES: &[(&str, &str)] = &[
    ("/api/config", "GET"),
    ("/api/auth/login", "POST"),
    ("/api/auth/totp", "POST"),
    ("/api/auth/logout", "POST"),
    ("/api/me", "GET"),
    ("/api/leave-types", "GET|POST"),
    ("/api/balances/me", "GET"),
    ("/api/balances/{employee_id}", "GET"),
    ("/api/balances/{employee_id}/explain", "GET"),
    ("/api/balances", "GET"),
    ("/api/requests", "GET|POST"),
    ("/api/requests/preview", "POST"),
    ("/api/requests/{id}", "GET|PUT|DELETE"),
    ("/api/requests/{id}/submit", "POST"),
    ("/api/requests/{id}/withdraw", "POST"),
    ("/api/requests/{id}/decide", "POST"),
    ("/api/requests/{id}/messages", "POST"),
    ("/api/requests/{id}/respond", "POST"),
    ("/api/requests/{id}/amend", "POST"),
    ("/api/requests/{id}/cancel", "POST"),
    ("/api/requests/{id}/reassign", "POST"),
    ("/api/requests/{id}/actual", "POST"),
    ("/api/requests/{id}/attachments", "POST"),
    ("/api/requests/{id}/card", "GET"),
    ("/api/attachments/{id}", "GET"),
    ("/api/approvals", "GET"),
    ("/api/calendar", "GET"),
    ("/api/org-units", "GET|POST"),
    ("/api/org-units/{id}", "PUT"),
    ("/api/employees", "GET|POST"),
    ("/api/employees/{id}", "GET|PUT"),
    ("/api/employees/{id}/transfer", "POST"),
    ("/api/employees/{id}/schedule", "POST"),
    ("/api/adjustments", "GET|POST"),
    ("/api/adjustments/{id}/decide", "POST"),
    ("/api/accruals/run", "POST"),
    ("/api/accruals/preview", "GET"),
    ("/api/periods/close", "GET|POST"),
    ("/api/reports/balances", "GET"),
    ("/api/reports/absences", "GET"),
    ("/api/reports/pending", "GET"),
    ("/api/reports/changes-since-export", "GET"),
    ("/api/reports/schedule-drift", "GET"),
    ("/api/exports", "GET|POST"),
    ("/api/exports/{id}/download", "GET"),
    ("/api/exports/{id}/mark-transferred", "POST"),
    ("/api/imports", "GET"),
    ("/api/imports/preview", "POST"),
    ("/api/imports/{id}/commit", "POST"),
    ("/api/leave-types/{id}", "PUT"),
    ("/api/leave-types/{id}/policies", "POST"),
    ("/api/policies/{id}/verify", "POST"),
    ("/api/schedules", "GET|POST"),
    ("/api/schedules/{id}/versions", "GET|POST"),
    ("/api/calendar-exceptions", "GET|POST"),
    ("/api/calendar-exceptions/{id}/revoke", "POST"),
    ("/api/users", "GET|POST"),
    ("/api/users/{id}", "PUT"),
    ("/api/users/{id}/roles", "POST"),
    ("/api/role-grants/{id}", "DELETE"),
    ("/api/delegations", "GET|POST"),
    ("/api/delegations/{id}/revoke", "POST"),
    ("/api/ops/notifications", "GET"),
    ("/api/ops/notifications/{id}/retry", "POST"),
    ("/api/ops/summary", "GET"),
    ("/api/audit", "GET"),
];

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
