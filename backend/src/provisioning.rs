//! Trusted local operator provisioning. Credentials are never exposed through HTTP.
use crate::{audit, authz, clock::Clock, db, model, notify, people, DomainError, Res};
use argon2::{Argon2, PasswordHasher};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

fn reject_demo(data_dir: &Path) -> Res<()> {
    if std::env::var("NLD_MODE").as_deref() == Ok("demo")
        || ["template.sqlite", "sandboxes.sqlite", "sandboxes"]
            .iter()
            .any(|p| data_dir.join(p).exists())
    {
        return Err(DomainError::validation(
            "production provisioning refuses demo mode or demo data",
        ));
    }
    Ok(())
}

pub fn init_production(data_dir: &Path) -> Res<()> {
    reject_demo(data_dir)?;
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join("main.sqlite");
    let mut conn = db::open(&path)?;
    // A seeded main database must not be relabelled as production.
    if db::schema_version(&conn)? > 0 {
        authz::require_operator(&conn)?;
    }
    db::migrate(&conn)?;
    db::write_tx(&mut conn, |tx| {
        authz::require_operator(tx)?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES('mode','production')",
            [],
        )?;
        if inserted > 0 {
            operator_event(tx, None, "cli.init-production", serde_json::json!({}))?;
        }
        Ok(())
    })?;
    std::fs::create_dir_all(data_dir.join("files/main"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700))?;
        for file in ["main.sqlite", "main.sqlite-wal", "main.sqlite-shm"] {
            let p = data_dir.join(file);
            if p.exists() {
                std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))?;
            }
        }
    }
    Ok(())
}

pub fn open_production(data_dir: &Path) -> Res<Connection> {
    reject_demo(data_dir)?;
    if !data_dir.join("main.sqlite").exists() {
        return Err(DomainError::validation("run init-production first"));
    }
    let conn = db::open(&data_dir.join("main.sqlite"))?;
    authz::require_operator(&conn)?;
    Ok(conn)
}

fn password_hash(password: &str) -> Res<String> {
    if password.chars().count() < 12 {
        return Err(DomainError::validation(
            "password must contain at least 12 characters",
        ));
    }
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| DomainError::Internal(anyhow::anyhow!("argon2: {e}")))
}

pub struct Enrollment {
    pub secret: String,
    pub uri: String,
}
fn enrollment(email: &str) -> Enrollment {
    let secret = totp_rs::Secret::from(rand::random::<[u8; 20]>()).to_base32();
    fn encode(s: &str) -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }
    let uri = format!(
        "otpauth://totp/{}:{}?secret={secret}&issuer={}&algorithm=SHA1&digits=6&period=30",
        encode("Nauru Leave Desk"),
        encode(email),
        encode("Nauru Leave Desk")
    );
    Enrollment { secret, uri }
}
fn user_id(conn: &Connection, email: &str) -> Res<i64> {
    conn.query_row("SELECT id FROM users WHERE email=?1", [email], |r| r.get(0))
        .optional()?
        .ok_or_else(|| DomainError::not_found("user"))
}
fn role_spec(conn: &Connection, spec: &str) -> Res<(String, Option<i64>)> {
    let (role, unit) = spec
        .split_once(':')
        .map_or((spec, None), |(r, u)| (r, Some(u)));
    if ![
        "hr",
        "hr_medical",
        "final_approver",
        "adjustment_approver",
        "tech_admin",
        "auditor",
    ]
    .contains(&role)
    {
        return Err(DomainError::validation("unknown role"));
    }
    let unit = unit
        .map(|code| {
            conn.query_row(
                "SELECT id FROM org_units WHERE code=?1 AND active=1",
                [code],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| DomainError::validation("unknown or inactive org unit"))
        })
        .transpose()?;
    Ok((role.into(), unit))
}
fn operator_event(
    conn: &Connection,
    user: Option<i64>,
    action: &str,
    mut details: serde_json::Value,
) -> Res<()> {
    details["actor"] = serde_json::json!("cli");
    let clock = Clock::production();
    audit::log(
        conn,
        &clock.now_ts(),
        None,
        None,
        action,
        "user",
        user,
        details,
    )?;
    if let Some(user) = user {
        notify::record_change(conn, &clock, user, action)?;
    }
    Ok(())
}
fn revoke_sessions_in(conn: &Connection, user: i64) -> Res<()> {
    conn.execute(
        "UPDATE sessions SET revoked_at=?2 WHERE user_id=?1 AND revoked_at IS NULL",
        params![user, Clock::production().now_ts()],
    )?;
    Ok(())
}

pub fn create_user(
    conn: &mut Connection,
    email: &str,
    name: &str,
    employee_service_id: Option<&str>,
    roles: &[String],
    password: &str,
) -> Res<Enrollment> {
    if !email.contains('@')
        || email.contains(':')
        || email.chars().any(char::is_control)
        || name.trim().is_empty()
    {
        return Err(DomainError::validation(
            "a valid email and nonempty name are required",
        ));
    }
    let hash = password_hash(password)?;
    let enrollment = enrollment(email);
    db::write_tx(conn, |tx| {
        authz::require_operator(tx)?;
        let grants: Vec<_> = roles
            .iter()
            .map(|role| role_spec(tx, role))
            .collect::<Res<_>>()?;
        let employee = employee_service_id
            .map(|sid| {
                tx.query_row(
                    "SELECT id FROM employees WHERE service_id=?1 AND user_id IS NULL",
                    [sid],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| DomainError::validation("employee missing or already linked"))
            })
            .transpose()?;
        if tx.query_row("SELECT COUNT(*) FROM users WHERE email=?1", [email], |r| {
            r.get::<_, i64>(0)
        })? > 0
        {
            return Err(DomainError::validation("email already exists"));
        }
        let clock = Clock::production();
        let id = people::create_user(tx, email, name, None, &clock.now_ts())?;
        tx.execute(
            "UPDATE users SET password_hash=?2,totp_secret=?3 WHERE id=?1",
            params![id, hash, enrollment.secret],
        )?;
        if let Some(employee) = employee {
            tx.execute(
                "UPDATE employees SET user_id=?2 WHERE id=?1",
                params![employee, id],
            )?;
        }
        for (role, unit) in grants {
            people::grant_role(
                tx,
                id,
                &role,
                unit,
                clock.today(tx)?,
                None,
                None,
                &clock.now_ts(),
            )?;
        }
        operator_event(
            tx,
            Some(id),
            "cli.user.create",
            serde_json::json!({"roles":roles,"employee_service_id":employee_service_id}),
        )
    })?;
    Ok(enrollment)
}
pub fn reset_password(conn: &mut Connection, email: &str, password: &str) -> Res<()> {
    let hash = password_hash(password)?;
    db::write_tx(conn, |tx| {
        authz::require_operator(tx)?;
        let id = user_id(tx, email)?;
        tx.execute(
            "UPDATE users SET password_hash=?2,failed_logins=0,locked_until=NULL WHERE id=?1",
            params![id, hash],
        )?;
        revoke_sessions_in(tx, id)?;
        operator_event(
            tx,
            Some(id),
            "cli.user.reset-password",
            serde_json::json!({}),
        )
    })
}
pub fn reset_totp(conn: &mut Connection, email: &str) -> Res<Enrollment> {
    let enrollment = enrollment(email);
    db::write_tx(conn, |tx| {
        authz::require_operator(tx)?;
        let id = user_id(tx, email)?;
        tx.execute(
            "UPDATE users SET totp_secret=?2,failed_logins=0,locked_until=NULL WHERE id=?1",
            params![id, enrollment.secret],
        )?;
        tx.execute(
            "DELETE FROM settings WHERE key=?1",
            [format!("totp_step:{id}")],
        )?;
        revoke_sessions_in(tx, id)?;
        operator_event(tx, Some(id), "cli.user.reset-totp", serde_json::json!({}))
    })?;
    Ok(enrollment)
}
pub fn revoke_sessions(conn: &mut Connection, email: &str) -> Res<()> {
    db::write_tx(conn, |tx| {
        authz::require_operator(tx)?;
        let id = user_id(tx, email)?;
        revoke_sessions_in(tx, id)?;
        operator_event(
            tx,
            Some(id),
            "cli.user.revoke-sessions",
            serde_json::json!({}),
        )
    })
}
pub fn change_role(conn: &mut Connection, email: &str, spec: &str, grant: bool) -> Res<()> {
    db::write_tx(conn, |tx| {
        authz::require_operator(tx)?;
        let id = user_id(tx, email)?;
        let (role, unit) = role_spec(tx, spec)?;
        let clock = Clock::production();
        let today = model::date_s(&clock.today(tx)?);
        if grant {
            let present:i64=tx.query_row("SELECT COUNT(*) FROM role_grants WHERE user_id=?1 AND role=?2 AND scope_org_unit_id IS ?3 AND valid_from<=?4 AND (valid_to IS NULL OR valid_to>=?4)",params![id,role,unit,today],|r|r.get(0))?;
            if present == 0 {
                people::grant_role(
                    tx,
                    id,
                    &role,
                    unit,
                    clock.today(tx)?,
                    None,
                    None,
                    &clock.now_ts(),
                )?;
            }
        } else {
            // Remove current and future grants; immutable audit preserves the operator action.
            tx.execute("DELETE FROM role_grants WHERE user_id=?1 AND role=?2 AND scope_org_unit_id IS ?3 AND (valid_to IS NULL OR valid_to>=?4)",params![id,role,unit,today])?;
        }
        revoke_sessions_in(tx, id)?;
        operator_event(
            tx,
            Some(id),
            if grant {
                "cli.user.grant-role"
            } else {
                "cli.user.revoke-role"
            },
            serde_json::json!({"role":role,"scope_org_unit_id":unit}),
        )
    })
}
pub fn list_users(conn: &Connection) -> Res<serde_json::Value> {
    authz::require_operator(conn)?;
    let mut st = conn.prepare("SELECT id,email,display_name,active FROM users ORDER BY email")?;
    let users = st
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for (id, email, name, active) in users {
        let mut roles=conn.prepare("SELECT g.role,o.code,g.valid_from,g.valid_to FROM role_grants g LEFT JOIN org_units o ON o.id=g.scope_org_unit_id WHERE g.user_id=?1 ORDER BY g.id")?;
        let roles=roles.query_map([id],|r|Ok(serde_json::json!({"role":r.get::<_,String>(0)?,"org_unit_code":r.get::<_,Option<String>>(1)?,"valid_from":r.get::<_,String>(2)?,"valid_to":r.get::<_,Option<String>>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        result.push(
            serde_json::json!({"id":id,"email":email,"name":name,"active":active,"roles":roles}),
        );
    }
    Ok(serde_json::json!(result))
}
