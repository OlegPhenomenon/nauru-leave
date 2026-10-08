//! Notification outbox (DESIGN §8). Enqueue happens inside the business
//! transaction via `enqueue`; `deliver_due` is the worker pass with
//! 1/5/25-minute backoff and gave_up after 5 attempts.

use rusqlite::{params, Connection, OptionalExtension};
use time::{Duration, OffsetDateTime};

use crate::clock::Clock;
use crate::error::DomainError;
use crate::Res;

const MAX_ATTEMPTS: i64 = 5;
/// Backoff minutes after attempt #1, #2, #3, #4 (5th failure → gave_up).
const BACKOFF_MIN: [i64; 4] = [1, 5, 25, 25];

#[derive(Clone, Debug)]
pub struct Notification {
    pub id: i64,
    pub recipient_user_id: Option<i64>,
    pub to_email: String,
    pub subject: String,
    pub body: String,
    pub link_path: String,
    pub status: String,
    pub attempts: i64,
}

/// Enqueue a notification. `dedupe_key` = `{event}:{request}:{revision}:{recipient}`
/// makes the insert idempotent inside retries of the same action.
/// The body must never carry leave types or reasons (§6).
#[allow(clippy::too_many_arguments)]
pub fn enqueue(
    conn: &Connection,
    now_ts: &str,
    event: &str,
    request_id: i64,
    revision_id: i64,
    recipient: &Recipient,
    subject: &str,
    body: &str,
) -> Res<()> {
    let recipient_tag = recipient
        .user_id
        .map(|u| u.to_string())
        .unwrap_or_else(|| recipient.email.clone());
    let dedupe = format!("{event}:{request_id}:{revision_id}:{recipient_tag}");
    conn.execute(
        "INSERT OR IGNORE INTO notifications
         (recipient_user_id, to_email, subject, body, link_path, status,
          next_attempt_at, dedupe_key, created_at)
         VALUES (?1,?2,?3,?4,?5,'queued',?6,?7,?8)",
        params![
            recipient.user_id,
            recipient.email,
            subject,
            body,
            format!("/requests/{request_id}"),
            now_ts,
            dedupe,
            now_ts
        ],
    )?;
    Ok(())
}

pub struct Recipient {
    pub user_id: Option<i64>,
    pub email: String,
}

/// Recipient for the request's employee: their user, else just the email
/// (e.g. a no-login employee).
pub fn recipient_for_employee(
    conn: &Connection,
    employee_id: i64,
) -> Res<Option<Recipient>> {
    let row = conn
        .query_row(
            "SELECT e.email, u.id, u.email FROM employees e
             LEFT JOIN users u ON u.id = e.user_id AND u.active=1
             WHERE e.id=?1",
            [employee_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(emp_email, uid, user_email)| {
        let email = user_email.or(emp_email)?;
        Some(Recipient { user_id: uid, email })
    }))
}

/// Recipient for a user account.
pub fn recipient_for_user(conn: &Connection, user_id: i64) -> Res<Option<Recipient>> {
    Ok(conn
        .query_row(
            "SELECT email FROM users WHERE id=?1 AND active=1",
            [user_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .map(|email| Recipient { user_id: Some(user_id), email }))
}

// ------------------------------------------------------------------ delivery

/// A delivery transport. The demo transport writes to `mailbox`.
pub trait Transport {
    /// Deliver `n`. Called inside the delivery transaction.
    fn deliver(&self, conn: &Connection, n: &Notification) -> Res<()>;
}

/// Demo transport: inserts into `mailbox`; any address ending
/// `@unreachable.demo` always fails (demo failure showcase).
pub struct MailboxTransport;

impl Transport for MailboxTransport {
    fn deliver(&self, conn: &Connection, n: &Notification) -> Res<()> {
        if n.to_email.ends_with("@unreachable.demo") {
            return Err(DomainError::Internal(anyhow::anyhow!(
                "delivery failed: unreachable recipient"
            )));
        }
        conn.execute(
            "INSERT OR IGNORE INTO mailbox(notification_id, to_email, subject, body, delivered_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![
                n.id,
                n.to_email,
                n.subject,
                n.body,
                now_rfc3339(OffsetDateTime::now_utc())
            ],
        )?;
        Ok(())
    }
}

fn now_rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Take due notifications and attempt delivery. Returns attempted count.
/// `now` is injectable for deterministic tests.
pub fn deliver_due(
    conn: &mut Connection,
    transport: &dyn Transport,
    now: OffsetDateTime,
) -> Res<usize> {
    crate::db::write_tx(conn, |tx| {
        let mut st = tx.prepare(
            "SELECT id, recipient_user_id, to_email, subject, body, link_path, status, attempts
             FROM notifications
             WHERE status IN ('queued','failed') AND next_attempt_at<=?1
             ORDER BY id",
        )?;
        let due: Vec<Notification> = st
            .query_map([now_rfc3339(now)], |r| {
                Ok(Notification {
                    id: r.get(0)?,
                    recipient_user_id: r.get(1)?,
                    to_email: r.get(2)?,
                    subject: r.get(3)?,
                    body: r.get(4)?,
                    link_path: r.get(5)?,
                    status: r.get(6)?,
                    attempts: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let n_done = due.len();
        for n in due {
            match transport.deliver(tx, &n) {
                Ok(()) => {
                    tx.execute(
                        "UPDATE notifications SET status='sent', sent_at=?2, attempts=attempts+1
                         WHERE id=?1",
                        params![n.id, now_rfc3339(now)],
                    )?;
                }
                Err(e) => {
                    let attempts = n.attempts + 1;
                    if attempts >= MAX_ATTEMPTS {
                        tx.execute(
                            "UPDATE notifications SET status='gave_up', attempts=?2,
                             last_error=?3 WHERE id=?1",
                            params![n.id, attempts, e.message()],
                        )?;
                    } else {
                        let delay = BACKOFF_MIN[(attempts - 1) as usize];
                        let next = now + Duration::minutes(delay);
                        tx.execute(
                            "UPDATE notifications SET status='failed', attempts=?2,
                             last_error=?3, next_attempt_at=?4 WHERE id=?1",
                            params![n.id, attempts, e.message(), now_rfc3339(next)],
                        )?;
                    }
                }
            }
        }
        Ok(n_done)
    })
}

/// Manual retry from Operations: re-queue with a fresh attempt budget.
pub fn retry(
    conn: &mut Connection,
    clock: &Clock,
    actor: &crate::authz::Actor,
    notification_id: i64,
) -> Res<()> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        crate::authz::require(
            tx,
            actor,
            crate::authz::Action::RetryNotification,
            &crate::authz::Resource::Global,
        )?;
        let n = tx.execute(
            "UPDATE notifications SET status='queued', attempts=0,
             next_attempt_at=?2, last_error=NULL
             WHERE id=?1 AND status IN ('failed','gave_up','sent')",
            params![notification_id, now_ts],
        )?;
        if n == 0 {
            return Err(DomainError::not_found(format!(
                "notification {notification_id}"
            )));
        }
        crate::audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "notification.retry",
            "notification",
            Some(notification_id),
            serde_json::json!({}),
        )?;
        Ok(())
    })
}
