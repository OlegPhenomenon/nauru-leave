//! Authentication state, real-clock expiry, lockout and one-use TOTP steps.
use crate::{audit, authz::Actor, clock::Clock, db, model, DomainError, Res};
use argon2::{Argon2, PasswordVerifier};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
#[derive(Clone)]
pub struct Session {
    pub user_id: i64,
    pub csrf_token: String,
    pub totp_ok: bool,
    pub hash: String,
}
pub fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
fn timestamp(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap()
}
pub fn load(conn: &Connection, token: &str, full: bool) -> Res<Session> {
    let session=conn.query_row("SELECT s.user_id,s.csrf_token,s.totp_ok FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.revoked_at IS NULL AND s.expires_at>?2 AND u.active=1",params![hash(token),timestamp(OffsetDateTime::now_utc())],|r|Ok(Session{user_id:r.get(0)?,csrf_token:r.get(1)?,totp_ok:r.get::<_,i64>(2)?!=0,hash:hash(token)})).optional()?.ok_or(DomainError::Unauthenticated)?;
    if full && !session.totp_ok {
        let actor = Actor::load(conn, session.user_id, OffsetDateTime::now_utc().date())?;
        if !actor.roles.is_empty() || !actor.manages.is_empty() {
            return Err(DomainError::Unauthenticated);
        }
    }
    Ok(session)
}
pub fn create(
    conn: &mut Connection,
    user_id: i64,
    totp_ok: bool,
    old: Option<&str>,
) -> Res<String> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    let csrf = hex::encode(rand::random::<[u8; 32]>());
    let now = OffsetDateTime::now_utc();
    let actor = Actor::load(conn, user_id, now.date())?;
    let complete = totp_ok || (actor.roles.is_empty() && actor.manages.is_empty());
    db::write_tx(conn, |tx| {
        model::load_user(tx, user_id).and_then(|u| {
            if u.active {
                Ok(())
            } else {
                Err(DomainError::Unauthenticated)
            }
        })?;
        if let Some(old) = old {
            tx.execute(
                "UPDATE sessions SET revoked_at=?2 WHERE token_hash=?1",
                params![hash(old), timestamp(now)],
            )?;
        }
        tx.execute("INSERT INTO sessions(token_hash,user_id,csrf_token,totp_ok,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",params![hash(&token),user_id,csrf,totp_ok as i64,timestamp(now),timestamp(now+if complete {Duration::hours(12)} else {Duration::minutes(10)})])?;
        audit::log(
            tx,
            &timestamp(now),
            Some(user_id),
            None,
            "session.create",
            "user",
            Some(user_id),
            serde_json::json!({"totp_ok":totp_ok}),
        )?;
        crate::notify::record_change(tx, &Clock::production(), user_id, "session.create")?;
        Ok(())
    })?;
    Ok(token)
}
fn failure(conn: &Connection, user_id: i64, now: OffsetDateTime) -> Res<()> {
    conn.execute("UPDATE users SET failed_logins=CASE WHEN locked_until IS NOT NULL AND locked_until<=?2 THEN 1 ELSE failed_logins+1 END,locked_until=CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until<=?2 THEN 0 ELSE failed_logins END)>=4 THEN ?3 ELSE NULL END WHERE id=?1",params![user_id,timestamp(now),timestamp(now+Duration::minutes(15))])?;
    audit::log(
        conn,
        &timestamp(now),
        Some(user_id),
        None,
        "session.login_failed",
        "user",
        Some(user_id),
        serde_json::json!({}),
    )?;
    crate::notify::record_change(conn, &Clock::production(), user_id, "session.login_failed")?;
    Ok(())
}
pub fn password_login(
    conn: &mut Connection,
    clock: &Clock,
    email: &str,
    password: &str,
    old: Option<&str>,
) -> Res<(String, bool)> {
    let record: Option<(i64, Option<String>, Option<String>, bool)> = conn
        .query_row(
            "SELECT id,password_hash,locked_until,active FROM users WHERE email=?1",
            [email],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)),
        )
        .optional()?;
    let (uid, password_hash, locked, active) = record.ok_or(DomainError::Unauthenticated)?;
    let now = OffsetDateTime::now_utc();
    if !active || locked.as_ref().is_some_and(|t| t > &timestamp(now)) {
        return Err(DomainError::Unauthenticated);
    }
    if !password_hash.as_ref().is_some_and(|h| {
        Argon2::default()
            .verify_password(password.as_bytes(), h.as_str())
            .is_ok()
    }) {
        db::write_tx(conn, |tx| failure(tx, uid, now))?;
        return Err(DomainError::Unauthenticated);
    }
    let actor = Actor::load(conn, uid, clock.today(conn)?)?;
    let needs_totp = !actor.roles.is_empty() || !actor.manages.is_empty();
    let token = db::atomic(conn, |conn| {
        if !needs_totp {
            conn.execute(
                "UPDATE users SET failed_logins=0,locked_until=NULL WHERE id=?1",
                [uid],
            )?;
        }
        create(conn, uid, false, old)
    })?;
    Ok((token, needs_totp))
}
pub fn totp(conn: &mut Connection, session: &Session, code: &str) -> Res<String> {
    if session.totp_ok {
        return Err(DomainError::validation("TOTP step already completed"));
    }
    let now = OffsetDateTime::now_utc();
    let (secret, locked): (Option<String>, Option<String>) = conn.query_row(
        "SELECT totp_secret,locked_until FROM users WHERE id=?1",
        [session.user_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if locked.is_some_and(|s| s > timestamp(now)) {
        return Err(DomainError::Unauthenticated);
    }
    let secret = secret.ok_or_else(|| {
        DomainError::forbidden("TOTP is required; ask an administrator to provision it")
    })?;
    let secret = totp_rs::Secret::try_from_base32(&secret)
        .map_err(|_| DomainError::forbidden("invalid TOTP configuration"))?;
    let totp = totp_rs::Builder::new()
        .with_secret(secret)
        .build()
        .map_err(|_| DomainError::forbidden("invalid TOTP configuration"))?;
    let Some(step) = totp.check_current(code) else {
        db::write_tx(conn, |tx| failure(tx, session.user_id, now))?;
        return Err(DomainError::Unauthenticated);
    };
    let key = format!("totp_step:{}", session.user_id);
    db::atomic(conn, |conn| {
        db::write_tx(conn, |tx| {
            let previous: Option<String> = tx
                .query_row("SELECT value FROM settings WHERE key=?1", [&key], |r| {
                    r.get(0)
                })
                .optional()?;
            if previous
                .and_then(|s| s.parse::<u64>().ok())
                .is_some_and(|p| p >= step)
            {
                return Err(DomainError::forbidden("TOTP code already used"));
            }
            tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,step.to_string()])?;
            tx.execute(
                "UPDATE users SET failed_logins=0,locked_until=NULL WHERE id=?1",
                [session.user_id],
            )?;
            tx.execute(
                "UPDATE sessions SET revoked_at=?2 WHERE token_hash=?1",
                params![session.hash, timestamp(now)],
            )?;
            audit::log(
                tx,
                &timestamp(now),
                Some(session.user_id),
                None,
                "session.totp",
                "user",
                Some(session.user_id),
                serde_json::json!({}),
            )?;
            Ok(())
        })?;
        create(conn, session.user_id, true, None)
    })
}
pub fn logout(conn: &mut Connection, session: &Session) -> Res<()> {
    db::write_tx(conn, |tx| {
        let now = timestamp(OffsetDateTime::now_utc());
        tx.execute(
            "UPDATE sessions SET revoked_at=?2 WHERE token_hash=?1",
            params![session.hash, now],
        )?;
        audit::log(
            tx,
            &now,
            Some(session.user_id),
            None,
            "session.logout",
            "user",
            Some(session.user_id),
            serde_json::json!({}),
        )?;
        crate::notify::record_change(tx, &Clock::production(), session.user_id, "session.logout")
    })
}
