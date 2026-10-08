use super::ratelimit::RateLimiter;
use crate::{
    clock::{Clock, Mode},
    db, DomainError, Res,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};
use time::OffsetDateTime;
#[derive(Clone, Debug)]
pub struct Config {
    pub mode: Mode,
    pub bind: String,
    pub data_dir: PathBuf,
    pub public_url: String,
    pub max_sandboxes: usize,
    pub max_db_tasks: usize,
    pub sandbox_ttl_hours: i64,
    pub smtp_url: Option<String>,
    pub backup_key_file: Option<PathBuf>,
    pub trust_proxy_headers: bool,
}
impl Config {
    pub fn from_env() -> Res<Self> {
        let env = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.into());
        let number = |key: &str, default: &str| -> Res<usize> {
            env(key, default)
                .parse()
                .map_err(|_| DomainError::validation(format!("invalid {key}")))
        };
        let mode = match env("NLD_MODE", "demo").as_str() {
            "demo" => Mode::Demo,
            "production" => Mode::Production,
            _ => {
                return Err(DomainError::validation(
                    "NLD_MODE must be demo or production",
                ))
            }
        };
        let config = Self {
            mode,
            bind: env("NLD_BIND", "127.0.0.1:8080"),
            data_dir: env("NLD_DATA_DIR", "./data").into(),
            public_url: env("NLD_PUBLIC_URL", "http://127.0.0.1:8080")
                .trim_end_matches('/')
                .into(),
            max_sandboxes: number("NLD_MAX_SANDBOXES", "300")?,
            max_db_tasks: number("NLD_MAX_DB_TASKS", "16")?,
            sandbox_ttl_hours: number("NLD_SANDBOX_TTL_HOURS", "24")? as i64,
            smtp_url: std::env::var("NLD_SMTP_URL").ok().filter(|s| !s.is_empty()),
            backup_key_file: std::env::var_os("NLD_BACKUP_KEY_FILE")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            trust_proxy_headers: env("NLD_TRUST_PROXY_HEADERS", "false") == "true",
        };
        if config.max_db_tasks == 0 || config.max_sandboxes == 0 || config.sandbox_ttl_hours <= 0 {
            return Err(DomainError::validation("limits must be positive"));
        }
        let url: axum::http::Uri = config
            .public_url
            .parse()
            .map_err(|_| DomainError::validation("NLD_PUBLIC_URL must be an HTTP(S) origin"))?;
        if !matches!(url.scheme_str(), Some("http" | "https"))
            || url.authority().is_none()
            || url.path() != "/"
            || url.query().is_some()
            || url.authority().is_some_and(|a| a.as_str().contains('@'))
        {
            return Err(DomainError::validation(
                "NLD_PUBLIC_URL must be an HTTP(S) origin without a path",
            ));
        }
        if mode == Mode::Production && config.smtp_url.is_none() {
            return Err(DomainError::validation(
                "NLD_SMTP_URL is required in production",
            ));
        }
        if let Some(url) = &config.smtp_url {
            crate::notify::SmtpTransport::new(url, &config.public_url)?;
        }
        Ok(config)
    }
    pub fn clock(&self) -> Clock {
        if self.mode == Mode::Demo {
            Clock::demo()
        } else {
            Clock::production()
        }
    }
}
pub struct AppState {
    pub config: Config,
    pub(crate) permits: Arc<tokio::sync::Semaphore>,
    pub(crate) requests: RateLimiter,
    locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}
#[derive(Clone, Debug)]
pub(crate) struct Database {
    pub path: PathBuf,
    pub files: PathBuf,
    pub sandbox_id: Option<String>,
    pub generation: i64,
}
pub(crate) fn cookie(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .find_map(|s| {
            s.trim()
                .split_once('=')
                .filter(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        })
}
pub(crate) fn client_ip(req: &axum::extract::Request, trust: bool) -> IpAddr {
    if trust {
        if let Some(ip) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.split(',').next())
            .and_then(|s| s.trim().parse().ok())
        {
            return ip;
        }
    }
    req.extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|a| a.0.ip())
        .unwrap_or_else(|| "127.0.0.1".parse().unwrap())
}
impl AppState {
    pub async fn new(config: Config) -> Res<Arc<Self>> {
        let state = Arc::new(Self {
            permits: Arc::new(tokio::sync::Semaphore::new(config.max_db_tasks)),
            config,
            requests: RateLimiter::per_second(20.0, 40.0),
            locks: Mutex::new(HashMap::new()),
        });
        state.blocking(|s| s.initialize()).await?;
        Ok(state)
    }
    pub(crate) async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&Self) -> Res<T> + Send + 'static,
    ) -> Res<T> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| DomainError::Internal(e.into()))?;
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f(&state)
        })
        .await
        .map_err(|e| DomainError::Internal(e.into()))?
    }
    pub(crate) fn lock(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap();
        locks.retain(|_, v| v.strong_count() > 0);
        if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(id.into(), Arc::downgrade(&lock));
        lock
    }
    fn initialize(&self) -> Res<()> {
        std::fs::create_dir_all(&self.config.data_dir)?;
        if self.config.mode == Mode::Production {
            std::fs::create_dir_all(self.config.data_dir.join("files/main"))?;
            db::migrate(&db::open(&self.config.data_dir.join("main.sqlite"))?)?;
            return Ok(());
        }
        std::fs::create_dir_all(self.config.data_dir.join("sandboxes"))?;
        let registry = self.registry()?;
        registry.execute_batch("CREATE TABLE IF NOT EXISTS sandboxes(id TEXT PRIMARY KEY, generation INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, has_pending INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS retired(id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(id,generation));
            CREATE TABLE IF NOT EXISTS creation_events(ip TEXT NOT NULL,at INTEGER NOT NULL);")?;
        let template = self.config.data_dir.join("template.sqlite");
        if !template.exists() {
            crate::seed::build_template(&template, &self.config.data_dir.join("files/template"))?;
        }
        Ok(())
    }
    pub(crate) fn registry(&self) -> Res<Connection> {
        db::open(&self.config.data_dir.join("sandboxes.sqlite"))
    }
    fn database(&self, id: &str, generation: i64) -> Database {
        Database {
            path: self
                .config
                .data_dir
                .join(format!("sandboxes/{id}-g{generation}.sqlite")),
            files: self
                .config
                .data_dir
                .join(format!("files/{id}-g{generation}")),
            sandbox_id: Some(id.into()),
            generation,
        }
    }
    pub(crate) fn resolve(&self, headers: &axum::http::HeaderMap) -> Res<Database> {
        if self.config.mode == Mode::Production {
            return Ok(Database {
                path: self.config.data_dir.join("main.sqlite"),
                files: self.config.data_dir.join("files/main"),
                sandbox_id: None,
                generation: 0,
            });
        }
        let id = cookie(headers, "nld_sbx")
            .filter(|id| id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()))
            .ok_or(DomainError::Unauthenticated)?;
        let mut registry = self.registry()?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let generation = db::write_tx(&mut registry, |tx| {
            let generation: Option<i64> = tx
                .query_row(
                    "SELECT generation FROM sandboxes WHERE id=?1 AND last_seen_at>=?2",
                    params![id, now - self.config.sandbox_ttl_hours * 3600],
                    |r| r.get(0),
                )
                .optional()?;
            let generation = generation.ok_or(DomainError::Unauthenticated)?;
            // Set before touching the DB: crash-safe conservative notification marker.
            tx.execute(
                "UPDATE sandboxes SET last_seen_at=?2,has_pending=1 WHERE id=?1",
                params![id, now],
            )?;
            Ok(generation)
        })?;
        Ok(self.database(&id, generation))
    }
    pub(crate) fn start(&self, ip: IpAddr, reset: Option<&str>) -> Res<Database> {
        let id = reset
            .map(str::to_owned)
            .unwrap_or_else(|| hex::encode(rand::random::<[u8; 16]>()));
        let lock = self.lock(&id);
        let _guard = lock.lock().unwrap();
        let mut registry = self.registry()?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        db::write_tx(&mut registry, |tx| {
            tx.execute("DELETE FROM creation_events WHERE at<=?1", [now - 3600])?;
            let n: i64 = tx.query_row(
                "SELECT COUNT(*) FROM creation_events WHERE ip=?1",
                [ip.to_string()],
                |r| r.get(0),
            )?;
            if n >= 5 {
                return Err(DomainError::RateLimited);
            }
            let old: Option<i64> = tx
                .query_row(
                    "SELECT generation FROM sandboxes WHERE id=?1 AND last_seen_at>=?2",
                    params![id, now - self.config.sandbox_ttl_hours * 3600],
                    |r| r.get(0),
                )
                .optional()?;
            if reset.is_some() && old.is_none() {
                return Err(DomainError::Unauthenticated);
            }
            if reset.is_none() {
                let n: i64 = tx.query_row("SELECT COUNT(*) FROM sandboxes", [], |r| r.get(0))?;
                if n >= self.config.max_sandboxes as i64 {
                    return Err(DomainError::DemoFull);
                }
            }
            let generation = old.map(|g| g + 1).unwrap_or(1);
            let target = self.database(&id, generation);
            copy_files(&self.config.data_dir.join("files/template"), &target.files)?;
            std::fs::copy(self.config.data_dir.join("template.sqlite"), &target.path)?;
            if let Some(old) = old {
                tx.execute("INSERT INTO retired VALUES(?1,?2)", params![id, old])?;
            }
            tx.execute("INSERT INTO sandboxes(id,generation,created_at,last_seen_at) VALUES(?1,?2,?3,?3) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,last_seen_at=excluded.last_seen_at,bytes=0,has_pending=1",params![id,generation,now])?;
            tx.execute(
                "INSERT INTO creation_events VALUES(?1,?2)",
                params![ip.to_string(), now],
            )?;
            Ok(target)
        })
    }
    pub async fn jobs(self: &Arc<Self>, sweep: bool) -> Res<()> {
        self.blocking(move |s| s.run_jobs(sweep)).await
    }
    fn run_jobs(&self, sweep: bool) -> Res<()> {
        if self.config.mode == Mode::Production {
            let lock = self.lock("main");
            let _guard = lock.lock().unwrap();
            let mut conn = db::open(&self.config.data_dir.join("main.sqlite"))?;
            if let Some(url) = &self.config.smtp_url {
                crate::notify::deliver_due(
                    &mut conn,
                    &crate::notify::SmtpTransport::new(url, &self.config.public_url)?,
                    OffsetDateTime::now_utc(),
                )?;
            }
            return Ok(());
        }
        let mut registry = self.registry()?;
        if sweep {
            let now = OffsetDateTime::now_utc().unix_timestamp();
            let expired: Vec<String> = {
                let mut st = registry.prepare("SELECT id FROM sandboxes WHERE last_seen_at<?1")?;
                let rows = st
                    .query_map([now - self.config.sandbox_ttl_hours * 3600], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                rows
            };
            for id in expired {
                let lock = self.lock(&id);
                let _guard = lock.lock().unwrap();
                db::write_tx(&mut registry, |tx| {
                    tx.execute("INSERT OR IGNORE INTO retired SELECT id,generation FROM sandboxes WHERE id=?1 AND last_seen_at<?2",params![id,now-self.config.sandbox_ttl_hours*3600])?;
                    tx.execute(
                        "DELETE FROM sandboxes WHERE id=?1 AND last_seen_at<?2",
                        params![id, now - self.config.sandbox_ttl_hours * 3600],
                    )?;
                    Ok(())
                })?;
            }
            let retired: Vec<(String, i64)> = {
                let mut st = registry.prepare("SELECT id,generation FROM retired")?;
                let rows = st
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                rows
            };
            for (id, generation) in retired {
                let lock = self.lock(&id);
                let _guard = lock.lock().unwrap();
                let target = self.database(&id, generation);
                for suffix in ["", "-wal", "-shm"] {
                    let path = PathBuf::from(format!("{}{suffix}", target.path.display()));
                    if path.exists() {
                        std::fs::remove_file(path)?;
                    }
                }
                if target.files.exists() {
                    std::fs::remove_dir_all(target.files)?;
                }
                registry.execute(
                    "DELETE FROM retired WHERE id=?1 AND generation=?2",
                    params![id, generation],
                )?;
            }
        }
        let pending: Vec<(String, i64)> = {
            let mut st =
                registry.prepare("SELECT id,generation FROM sandboxes WHERE has_pending=1")?;
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        for (id, generation) in pending {
            let lock = self.lock(&id);
            let _guard = lock.lock().unwrap();
            let current: Option<i64> = registry
                .query_row("SELECT generation FROM sandboxes WHERE id=?1", [&id], |r| {
                    r.get(0)
                })
                .optional()?;
            if current != Some(generation) {
                continue;
            }
            let mut conn = db::open(&self.database(&id, generation).path)?;
            crate::notify::deliver_due(
                &mut conn,
                &crate::notify::MailboxTransport,
                OffsetDateTime::now_utc(),
            )?;
            let pending: i64 = conn.query_row(
                "SELECT COUNT(*) FROM notifications WHERE status IN ('queued','failed')",
                [],
                |r| r.get(0),
            )?;
            registry.execute(
                "UPDATE sandboxes SET has_pending=?2 WHERE id=?1 AND generation=?3",
                params![id, (pending > 0) as i64, generation],
            )?;
        }
        Ok(())
    }
}
fn copy_files(src: &Path, dst: &Path) -> Res<()> {
    std::fs::create_dir_all(dst)?;
    if src.exists() {
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
            }
        }
    }
    Ok(())
}
