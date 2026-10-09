//! SQLite connection handling, embedded migrations, write transactions.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior};

use crate::{DomainError, Res};

/// Embedded migrations, in order. Each file runs once, recorded in
/// `settings.schema_version` (count of applied migrations).
static MIGRATIONS: &[(&str, &str)] = &[("0001_init", include_str!("../migrations/0001_init.sql")), ("0002_audit_fixes", include_str!("../migrations/0002_audit_fixes.sql"))];

/// Open (or create) a database file with the required pragmas.
pub fn open(path: &Path) -> Res<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// In-memory database, same pragmas (tests).
pub fn open_memory() -> Res<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Res<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    Ok(())
}

/// Current schema version (0 = empty database).
pub fn schema_version(conn: &Connection) -> Res<u32> {
    let has_settings: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !has_settings {
        return Ok(0);
    }
    let v: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "0".to_string());
    v.parse::<u32>()
        .map_err(|e| DomainError::Internal(anyhow::anyhow!("bad schema_version: {e}")))
}

/// Apply pending migrations; returns how many were applied.
pub fn migrate(conn: &Connection) -> Res<u32> {
    let current = schema_version(conn)? as usize;
    let mut applied = 0u32;
    for (idx, (name, sql)) in MIGRATIONS.iter().enumerate() {
        if idx < current {
            continue;
        }
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let result = conn.execute_batch(sql);
        match result {
            Ok(()) => {
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES('schema_version', ?1)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    [&(idx + 1).to_string()],
                )?;
                conn.execute_batch("COMMIT;")?;
                applied += 1;
                tracing::info!(migration = name, "applied");
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(DomainError::Internal(anyhow::anyhow!(
                    "migration {name} failed: {e}"
                )));
            }
        }
    }
    Ok(applied)
}

/// Run `f` inside `BEGIN IMMEDIATE` ... `COMMIT`; rollback on error.
/// All mutating domain operations must go through this.
pub fn write_tx<T>(conn: &mut Connection, f: impl FnOnce(&Connection) -> Res<T>) -> Res<T> {
    if !conn.is_autocommit() {
        let savepoint = conn.savepoint()?;
        let value = f(&savepoint)?;
        savepoint.commit()?;
        return Ok(value);
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match f(&tx) {
        Ok(v) => {
            tx.commit()?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback();
            Err(e)
        }
    }
}

/// Compose existing domain writers and an HTTP receipt in one transaction.
/// Each nested writer uses a savepoint, so any failure rolls back the action and receipt.
pub fn atomic<T>(conn: &mut Connection, f: impl FnOnce(&mut Connection) -> Res<T>) -> Res<T> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    match f(conn) {
        Ok(value) => {
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
