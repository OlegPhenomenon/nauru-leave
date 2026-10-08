//! Append-only audit log (DESIGN §11). Every significant mutation calls
//! `log` inside the same transaction as the change.

use rusqlite::{params, Connection};

use crate::Res;

/// Append one audit event.
#[allow(clippy::too_many_arguments)]
pub fn log(
    conn: &Connection,
    now_ts: &str,
    actor_user_id: Option<i64>,
    acting_for_user_id: Option<i64>,
    action: &str,
    entity: &str,
    entity_id: Option<i64>,
    details: serde_json::Value,
) -> Res<()> {
    conn.execute(
        "INSERT INTO audit_events
         (at, actor_user_id, acting_for_user_id, action, entity, entity_id, details_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            now_ts,
            actor_user_id,
            acting_for_user_id,
            action,
            entity,
            entity_id,
            details.to_string()
        ],
    )?;
    Ok(())
}
