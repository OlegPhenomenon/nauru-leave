//! CSV import (preview/commit) and the transfer export (DESIGN §9).
//!
//! - Imports are two-phase: `preview` parses+validates into `import_batches`
//!   (status='previewed', `preview_json` holds resolved rows + per-row errors);
//!   `commit` is all-or-nothing inside one `BEGIN IMMEDIATE` tx.
//! - Idempotency: ledger `op_key`s (`opening:{emp}:{type}:{year}`,
//!   `hist:{emp}:{type}:{start}:{end}`) plus the `import_once` index — one
//!   committed batch per (kind, sha256(file)).
//! - `historical_leave` needs a file-level `mode` ('already_in_opening' |
//!   'post_movements'); a `mode` column inside the CSV is rejected.
//! - The formula-safe `csv_field`/writer is shared with reports (any value
//!   starting with = + - @ TAB CR gets a leading ').

use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::Date;

use crate::audit;
use crate::authz::{self, Action, Actor, Resource};
use crate::calendar;
use crate::clock::Clock;
use crate::error::DomainError;
use crate::ledger::{self, PostEntry};
use crate::model::{self, date_s, parse_date, Part};
use crate::Res;

// ------------------------------------------------------------------ CSV safety

/// Formula-safe CSV field: prefix a leading ' when the value could be
/// interpreted as a formula by spreadsheet apps (DESIGN §9).
pub fn csv_field(value: &str) -> String {
    match value.chars().next() {
        Some('=') | Some('+') | Some('-') | Some('@') | Some('\t') | Some('\r') => {
            format!("'{value}")
        }
        _ => value.to_string(),
    }
}

/// Serialize rows to UTF-8 CSV with a header and formula-safe values.
/// Shared by exports and `format=csv` reports.
pub fn write_csv(header: &[&str], rows: &[Vec<String>]) -> Res<Vec<u8>> {
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record(header.iter().map(|h| csv_field(h)))?;
    for row in rows {
        w.write_record(row.iter().map(|c| csv_field(c)))?;
    }
    let inner = w
        .into_inner()
        .map_err(|e| DomainError::Internal(anyhow::anyhow!("csv: {e}")))?;
    Ok(inner)
}

// ------------------------------------------------------------------ imports

pub const IMPORT_KINDS: [&str; 3] = ["employees", "opening_balances", "historical_leave"];
pub const HIST_MODES: [&str; 2] = ["already_in_opening", "post_movements"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreviewRow {
    pub line: usize,
    pub data: serde_json::Value,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewResult {
    pub batch_id: i64,
    pub rows: Vec<PreviewRow>,
    pub rows_total: usize,
    pub rows_valid: usize,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

struct Csv {
    header: Vec<String>,
    rows: Vec<(usize, Vec<String>)>, // (line number, cells)
}

fn parse_csv(bytes: &[u8]) -> Res<Csv> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| DomainError::validation("CSV must be UTF-8"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text); // BOM
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(text.as_bytes());
    let header = rdr
        .headers()
        .map_err(|e| DomainError::validation(format!("bad CSV header: {e}")))?
        .iter()
        .map(|h| h.trim().to_string())
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    for (i, rec) in rdr.records().enumerate() {
        let rec = rec.map_err(|e| DomainError::validation(format!("bad CSV record: {e}")))?;
        if rec.iter().all(|c| c.trim().is_empty()) {
            continue; // skip blank lines
        }
        rows.push((i + 2, rec.iter().map(|c| c.trim().to_string()).collect()));
    }
    Ok(Csv { header, rows })
}

impl Csv {
    fn col(&self, name: &str) -> Option<usize> {
        self.header.iter().position(|h| h == name)
    }
    fn require(&self, names: &[&str]) -> Res<()> {
        for n in names {
            if self.col(n).is_none() {
                return Err(DomainError::validation(format!("missing column '{n}'")));
            }
        }
        Ok(())
    }
}

fn cell(row: &[String], idx: Option<usize>) -> String {
    idx.and_then(|i| row.get(i).cloned()).unwrap_or_default()
}

/// A row normalized to typed fields (stored in preview_json `data`).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct EmpRow {
    service_id: String,
    full_name: String,
    email: Option<String>,
    start_date: String,
    org_unit_id: i64,
    schedule_id: i64,
    manager_service_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct OpeningRow {
    service_id: String,
    leave_type_id: i64,
    period_year: i64,
    minutes: i64,
    basis: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct HistRow {
    service_id: String,
    leave_type_id: i64,
    start_date: String,
    end_date: String,
}

fn employee_by_service_id(conn: &Connection, sid: &str) -> Res<Option<i64>> {
    conn.query_row("SELECT id FROM employees WHERE service_id=?1", [sid], |r| {
        r.get(0)
    })
    .optional()
    .map_err(Into::into)
}

fn leave_type_by_code(conn: &Connection, code: &str) -> Res<Option<model::LeaveType>> {
    let id: Option<i64> = conn
        .query_row("SELECT id FROM leave_types WHERE code=?1", [code], |r| {
            r.get(0)
        })
        .optional()?;
    match id {
        Some(i) => model::load_leave_type(conn, i).map(Some),
        None => Ok(None),
    }
}

fn opening_posted(conn: &Connection, employee_id: i64, leave_type_id: i64, year: i64) -> Res<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ledger_entries WHERE op_key=?1",
        [format!("opening:{employee_id}:{leave_type_id}:{year}")],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Validate + persist an import preview. `actor` must be hr in any scope.
pub fn import_preview(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    kind: &str,
    mode: Option<&str>,
    filename: &str,
    bytes: &[u8],
) -> Res<PreviewResult> {
    let today = clock.today(conn)?;
    let now_ts = clock.now_ts();
    authz::require(conn, actor, Action::ManageImportsExports, &Resource::Global)?;
    if !IMPORT_KINDS.contains(&kind) {
        return Err(DomainError::validation(format!(
            "unknown import kind '{kind}'"
        )));
    }
    let mode = match kind {
        "historical_leave" => {
            let m = mode.ok_or_else(|| {
                DomainError::validation(
                    "historical_leave requires mode=already_in_opening|post_movements",
                )
            })?;
            if !HIST_MODES.contains(&m) {
                return Err(DomainError::validation(format!(
                    "bad historical mode '{m}'"
                )));
            }
            Some(m.to_string())
        }
        _ => None,
    };
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(DomainError::validation("import file too large (8 MB max)"));
    }
    let csv = parse_csv(bytes)?;
    if kind == "historical_leave" && csv.col("mode").is_some() {
        return Err(DomainError::validation(
            "a 'mode' column inside the CSV is not allowed — the mode is per file",
        ));
    }

    let mut rows: Vec<PreviewRow> = Vec::new();
    match kind {
        "employees" => validate_employees(conn, &csv, &mut rows)?,
        "opening_balances" => validate_openings(conn, &csv, &mut rows)?,
        "historical_leave" => validate_history(conn, &csv, mode.as_deref().unwrap(), &mut rows)?,
        _ => unreachable!(),
    }

    let digest = sha256_bytes(bytes);
    let committed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM import_batches WHERE kind=?1 AND sha256=?2 AND status='committed'",
        params![kind, digest],
        |r| r.get(0),
    )?;
    if committed > 0 {
        for row in &mut rows {
            row.errors.clear();
        }
    }
    for row in &mut rows {
        if import_row_scope(conn, actor, kind, &row.data, today).is_err() {
            row.errors = vec!["row is outside your HR scope".into()];
        }
    }
    let rows_total = rows.len();
    let rows_valid = rows.iter().filter(|r| r.errors.is_empty()).count();
    let preview_json = serde_json::to_string(&rows)?;
    let batch_id: i64 = crate::db::write_tx(conn, |tx| {
        authz::require(tx, actor, Action::ManageImportsExports, &Resource::Global)?;
        let id: i64 = tx.query_row(
            "INSERT INTO import_batches
             (kind, mode, filename, sha256, status, rows_total, rows_valid, preview_json,
              created_by, created_at)
             VALUES (?1,?2,?3,?4,'previewed',?5,?6,?7,?8,?9) RETURNING id",
            params![
                kind,
                mode,
                filename,
                digest,
                rows_total as i64,
                rows_valid as i64,
                preview_json,
                actor.user_id,
                now_ts
            ],
            |r| r.get(0),
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "import.preview",
            "import_batch",
            Some(id),
            serde_json::json!({"kind": kind, "rows_total": rows_total, "rows_valid": rows_valid}),
        )?;
        crate::notify::record_change(tx, clock, actor.user_id, "import.preview")?;
        Ok(id)
    })?;
    Ok(PreviewResult {
        batch_id,
        rows,
        rows_total,
        rows_valid,
    })
}

fn validate_employees(conn: &Connection, csv: &Csv, out: &mut Vec<PreviewRow>) -> Res<()> {
    csv.require(&[
        "service_id",
        "full_name",
        "start_date",
        "org_unit",
        "schedule",
    ])?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let file_sids: BTreeSet<String> = csv
        .rows
        .iter()
        .map(|(_, r)| cell(r, csv.col("service_id")))
        .collect();
    for (line, r) in &csv.rows {
        let mut errors = Vec::new();
        let service_id = cell(r, csv.col("service_id"));
        let full_name = cell(r, csv.col("full_name"));
        let email = cell(r, csv.col("email"));
        let start_s = cell(r, csv.col("start_date"));
        let unit_code = cell(r, csv.col("org_unit"));
        let sched_name = cell(r, csv.col("schedule"));
        let mgr_sid = cell(r, csv.col("manager_service_id"));

        if service_id.is_empty() {
            errors.push("missing service_id".to_string());
        } else if !seen.insert(service_id.clone()) {
            errors.push(format!("duplicate service_id '{service_id}' in file"));
        }
        if full_name.is_empty() {
            errors.push("missing full_name".to_string());
        }
        let start_date = if start_s.is_empty() {
            errors.push("missing start_date".to_string());
            None
        } else {
            match parse_date(&start_s) {
                Ok(d) => Some(d),
                Err(_) => {
                    errors.push(format!("bad date '{start_s}'"));
                    None
                }
            }
        };
        let org_unit_id: Option<i64> = if unit_code.is_empty() {
            errors.push("missing org_unit".to_string());
            None
        } else {
            match conn
                .query_row(
                    "SELECT id FROM org_units WHERE code=?1",
                    [&unit_code],
                    |r| r.get(0),
                )
                .optional()?
            {
                Some(id) => Some(id),
                None => {
                    errors.push(format!("unknown org_unit '{unit_code}'"));
                    None
                }
            }
        };
        let schedule_id: Option<i64> = if sched_name.is_empty() {
            errors.push("missing schedule".to_string());
            None
        } else {
            match conn
                .query_row(
                    "SELECT id FROM schedules WHERE name=?1",
                    [&sched_name],
                    |r| r.get(0),
                )
                .optional()?
            {
                Some(id) => Some(id),
                None => {
                    errors.push(format!("unknown schedule '{sched_name}'"));
                    None
                }
            }
        };
        if !mgr_sid.is_empty()
            && employee_by_service_id(conn, &mgr_sid)?.is_none()
            && !file_sids.contains(&mgr_sid)
        {
            errors.push(format!("unknown manager_service_id '{mgr_sid}'"));
        }
        if errors.is_empty() {
            let data = EmpRow {
                service_id,
                full_name,
                email: if email.is_empty() { None } else { Some(email) },
                start_date: date_s(&start_date.unwrap()),
                org_unit_id: org_unit_id.unwrap(),
                schedule_id: schedule_id.unwrap(),
                manager_service_id: if mgr_sid.is_empty() {
                    None
                } else {
                    Some(mgr_sid)
                },
            };
            out.push(PreviewRow {
                line: *line,
                data: serde_json::to_value(&data)?,
                errors,
            });
        } else {
            out.push(PreviewRow {
                line: *line,
                data: serde_json::json!({
                    "service_id": service_id, "full_name": full_name,
                    "email": email, "start_date": start_s,
                    "org_unit": unit_code, "schedule": sched_name,
                    "manager_service_id": mgr_sid,
                }),
                errors,
            });
        }
    }
    Ok(())
}

fn validate_openings(conn: &Connection, csv: &Csv, out: &mut Vec<PreviewRow>) -> Res<()> {
    csv.require(&["service_id", "leave_type", "period_year", "minutes"])?;
    let mut seen: BTreeSet<(String, String, i64)> = BTreeSet::new();
    for (line, r) in &csv.rows {
        let mut errors = Vec::new();
        let service_id = cell(r, csv.col("service_id"));
        let lt_code = cell(r, csv.col("leave_type"));
        let year_s = cell(r, csv.col("period_year"));
        let min_s = cell(r, csv.col("minutes"));
        let basis = cell(r, csv.col("basis"));

        let emp = if service_id.is_empty() {
            errors.push("missing service_id".to_string());
            None
        } else {
            match employee_by_service_id(conn, &service_id)? {
                Some(id) => Some(id),
                None => {
                    errors.push(format!("unknown service_id '{service_id}'"));
                    None
                }
            }
        };
        let lt = if lt_code.is_empty() {
            errors.push("missing leave_type".to_string());
            None
        } else {
            match leave_type_by_code(conn, &lt_code)? {
                Some(t) => Some(t),
                None => {
                    errors.push(format!("unknown leave_type '{lt_code}'"));
                    None
                }
            }
        };
        let year = match year_s.parse::<i64>() {
            Ok(y) if (1900..=2200).contains(&y) => Some(y),
            _ => {
                errors.push(format!("bad period_year '{year_s}'"));
                None
            }
        };
        let minutes = match min_s.parse::<i64>() {
            Ok(m) if m < 0 => {
                errors.push("negative value".to_string());
                None
            }
            Ok(m) => Some(m),
            Err(_) => {
                errors.push(format!("bad minutes '{min_s}'"));
                None
            }
        };
        if let (Some(s), Some(t), Some(y)) = (emp.as_ref().map(|_| &service_id), lt.as_ref(), year)
        {
            let key = (s.clone(), t.code.clone(), y);
            if !seen.insert(key) {
                errors.push(format!(
                    "duplicate row in file ({service_id}/{}/{y})",
                    t.code
                ));
            }
        }
        if let (Some(e), Some(t), Some(y)) = (emp, lt.as_ref(), year) {
            if opening_posted(conn, e, t.id, y)? {
                errors.push(format!(
                    "opening already posted for {service_id}/{}/{y}",
                    t.code
                ));
            }
        }
        let data = match (&emp, &lt, year, minutes) {
            (Some(_e), Some(t), Some(y), Some(m)) => serde_json::to_value(&OpeningRow {
                service_id: service_id.clone(),
                leave_type_id: t.id,
                period_year: y,
                minutes: m,
                basis: if basis.is_empty() {
                    None
                } else {
                    Some(basis.clone())
                },
            })?,
            _ => serde_json::json!({
                "service_id": service_id, "leave_type": lt_code,
                "period_year": year_s, "minutes": min_s, "basis": basis,
                "employee_id": emp,
            }),
        };
        out.push(PreviewRow {
            line: *line,
            data,
            errors,
        });
    }
    Ok(())
}

fn validate_history(
    conn: &Connection,
    csv: &Csv,
    mode: &str,
    out: &mut Vec<PreviewRow>,
) -> Res<()> {
    csv.require(&["service_id", "leave_type", "start_date", "end_date"])?;
    let mut seen: BTreeSet<(String, String, String, String)> = BTreeSet::new();
    for (line, r) in &csv.rows {
        let mut errors = Vec::new();
        let service_id = cell(r, csv.col("service_id"));
        let lt_code = cell(r, csv.col("leave_type"));
        let start_s = cell(r, csv.col("start_date"));
        let end_s = cell(r, csv.col("end_date"));

        let emp = if service_id.is_empty() {
            errors.push("missing service_id".to_string());
            None
        } else {
            match employee_by_service_id(conn, &service_id)? {
                Some(id) => Some(id),
                None => {
                    errors.push(format!("unknown service_id '{service_id}'"));
                    None
                }
            }
        };
        let lt = if lt_code.is_empty() {
            errors.push("missing leave_type".to_string());
            None
        } else {
            match leave_type_by_code(conn, &lt_code)? {
                Some(t) => Some(t),
                None => {
                    errors.push(format!("unknown leave_type '{lt_code}'"));
                    None
                }
            }
        };
        let start = match parse_date(&start_s) {
            Ok(d) => Some(d),
            Err(_) => {
                errors.push(format!("bad date '{start_s}'"));
                None
            }
        };
        let end = match parse_date(&end_s) {
            Ok(d) => Some(d),
            Err(_) => {
                errors.push(format!("bad date '{end_s}'"));
                None
            }
        };
        if let (Some(s), Some(e)) = (start, end) {
            if e < s {
                errors.push("end_date before start_date".to_string());
            }
        }
        if errors.is_empty() {
            let key = (
                service_id.clone(),
                lt_code.clone(),
                start_s.clone(),
                end_s.clone(),
            );
            if !seen.insert(key) {
                errors.push("duplicate row in file".to_string());
            }
            // post_movements needs a schedule on the historical dates.
            if mode == "post_movements" && errors.is_empty() {
                if let (Some(e), Some(t)) = (emp, lt.as_ref()) {
                    if let Err(e2) = calendar::compute_days(
                        conn,
                        e,
                        t.id,
                        start.unwrap(),
                        end.unwrap(),
                        Part::Full,
                        Part::Full,
                    ) {
                        errors.push(e2.message());
                    }
                }
            }
        }
        let data = match (&lt, start, end) {
            (Some(t), Some(s), Some(e)) => serde_json::to_value(&HistRow {
                service_id: service_id.clone(),
                leave_type_id: t.id,
                start_date: date_s(&s),
                end_date: date_s(&e),
            })?,
            _ => serde_json::json!({
                "service_id": service_id, "leave_type": lt_code,
                "start_date": start_s, "end_date": end_s,
            }),
        };
        out.push(PreviewRow {
            line: *line,
            data,
            errors,
        });
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub struct CommitResult {
    pub applied: i64,
    pub skipped_duplicates: i64,
}

/// Commit a previewed batch — all-or-nothing inside one transaction.
/// A batch with invalid rows → 409 `import_invalid`. A file already committed
/// (same kind+sha256) → the batch is discarded and every row counts as a
/// skipped duplicate (the op_key ledger keys are the deeper guarantee).
pub fn import_commit(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    batch_id: i64,
) -> Res<CommitResult> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        authz::require(tx, actor, Action::ManageImportsExports, &Resource::Global)?;
        let (kind, mode, rows_total, rows_valid, preview_json, sha, status): (
            String,
            Option<String>,
            i64,
            i64,
            String,
            String,
            String,
        ) = tx
            .query_row(
                "SELECT kind, mode, rows_total, rows_valid, preview_json, sha256, status
                 FROM import_batches WHERE id=?1",
                [batch_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| DomainError::not_found(format!("import batch {batch_id}")))?;
        let owner: i64 = tx.query_row(
            "SELECT created_by FROM import_batches WHERE id=?1",
            [batch_id],
            |r| r.get(0),
        )?;
        if owner != actor.user_id && !actor.role_in_scope(tx, "hr", None)? {
            return Err(DomainError::forbidden("import belongs to another HR scope"));
        }
        if status != "previewed" {
            return Err(DomainError::validation(format!(
                "import batch {batch_id} is already {status}"
            )));
        }
        if rows_valid < rows_total {
            return Err(DomainError::ImportInvalid(format!(
                "import batch {batch_id} has {} invalid row(s) — nothing applied",
                rows_total - rows_valid
            )));
        }
        // committed-file hash guard: the same file may only be committed once.
        let dup: Option<i64> = tx
            .query_row(
                "SELECT id FROM import_batches
                 WHERE kind=?1 AND sha256=?2 AND status='committed' AND id<>?3",
                params![kind, sha, batch_id],
                |r| r.get(0),
            )
            .optional()?;
        if dup.is_some() {
            tx.execute(
                "UPDATE import_batches SET status='discarded', committed_at=?2 WHERE id=?1",
                params![batch_id, now_ts],
            )?;
            audit::log(
                tx,
                &now_ts,
                Some(actor.user_id),
                None,
                "import.duplicate",
                "import_batch",
                Some(batch_id),
                serde_json::json!({}),
            )?;
            crate::notify::record_change(tx, clock, actor.user_id, "import.duplicate")?;
            return Ok(CommitResult {
                applied: 0,
                skipped_duplicates: rows_total,
            });
        }

        let rows: Vec<PreviewRow> = serde_json::from_str(&preview_json)?;
        for row in &rows {
            import_row_scope(tx, actor, &kind, &row.data, clock.today(tx)?)?;
        }
        let mut applied = 0i64;
        let mut skipped = 0i64;
        match kind.as_str() {
            "employees" => {
                let mut sid_to_id: std::collections::BTreeMap<String, i64> =
                    std::collections::BTreeMap::new();
                let mut pending_mgr: Vec<(i64, String)> = Vec::new();
                for row in &rows {
                    let d: EmpRow = serde_json::from_value(row.data.clone())?;
                    if employee_by_service_id(tx, &d.service_id)?.is_some() {
                        skipped += 1;
                        continue;
                    }
                    let start = parse_date(&d.start_date)?;
                    let mgr = match &d.manager_service_id {
                        Some(s) => {
                            employee_by_service_id(tx, s)?.or_else(|| sid_to_id.get(s).copied())
                        }
                        None => None,
                    };
                    let emp_id: i64 = tx.query_row(
                        "INSERT INTO employees(service_id, full_name, email, start_date, created_at)
                         VALUES (?1,?2,?3,?4,?5) RETURNING id",
                        params![d.service_id, d.full_name, d.email, d.start_date, now_ts],
                        |r| r.get(0),
                    )?;
                    crate::people::assign(tx, emp_id, d.org_unit_id, mgr, start)?;
                    crate::people::set_schedule(tx, emp_id, d.schedule_id, start)?;
                    if mgr.is_none() {
                        if let Some(s) = &d.manager_service_id {
                            pending_mgr.push((emp_id, s.clone()));
                        }
                    }
                    sid_to_id.insert(d.service_id.clone(), emp_id);
                    applied += 1;
                }
                // manager may be defined on a later row of the same file
                for (emp_id, sid) in pending_mgr {
                    if let Some(mgr) = sid_to_id.get(&sid).copied() {
                        tx.execute(
                            "UPDATE employment_assignments SET manager_employee_id=?2
                             WHERE employee_id=?1",
                            params![emp_id, mgr],
                        )?;
                    }
                }
            }
            "opening_balances" => {
                for row in &rows {
                    let d: OpeningRow = serde_json::from_value(row.data.clone())?;
                    let emp = employee_by_service_id(tx, &d.service_id)?
                        .ok_or_else(|| DomainError::validation("service_id vanished"))?;
                    let acc = ledger::ensure_account(tx, emp, d.leave_type_id, d.period_year)?;
                    let out = ledger::post_entry(
                        tx,
                        &PostEntry {
                            account_id: acc,
                            minutes: d.minutes,
                            kind: "opening",
                            effective_date: Date::from_calendar_date(
                                d.period_year as i32,
                                time::Month::January,
                                1,
                            )
                            .unwrap(),
                            request_id: None,
                            revision_id: None,
                            reverses_entry_id: None,
                            adjustment_id: None,
                            import_batch_id: Some(batch_id),
                            basis: d.basis.clone().unwrap_or_else(|| {
                                format!("Opening balance {} (import)", d.period_year)
                            }),
                            author_user_id: Some(actor.user_id),
                            op_key: format!(
                                "opening:{}:{}:{}",
                                emp, d.leave_type_id, d.period_year
                            ),
                        },
                        &now_ts,
                    )?;
                    if out.inserted {
                        applied += 1;
                    } else {
                        skipped += 1;
                    }
                }
            }
            "historical_leave" => {
                let mode = mode.as_deref().unwrap_or("already_in_opening");
                for row in &rows {
                    let d: HistRow = serde_json::from_value(row.data.clone())?;
                    let emp = employee_by_service_id(tx, &d.service_id)?
                        .ok_or_else(|| DomainError::validation("service_id vanished"))?;
                    let start = parse_date(&d.start_date)?;
                    let end = parse_date(&d.end_date)?;
                    if mode == "already_in_opening" {
                        let acc =
                            ledger::ensure_account(tx, emp, d.leave_type_id, start.year() as i64)?;
                        let out = ledger::post_entry(
                            tx,
                            &PostEntry {
                                account_id: acc,
                                minutes: 0,
                                kind: "historical",
                                effective_date: start,
                                request_id: None,
                                revision_id: None,
                                reverses_entry_id: None,
                                adjustment_id: None,
                                import_batch_id: Some(batch_id),
                                basis: format!(
                                    "Historical leave {}..{} (already in opening)",
                                    d.start_date, d.end_date
                                ),
                                author_user_id: Some(actor.user_id),
                                op_key: format!(
                                    "hist:{}:{}:{}:{}",
                                    emp, d.leave_type_id, d.start_date, d.end_date
                                ),
                            },
                            &now_ts,
                        )?;
                        if out.inserted {
                            applied += 1;
                        } else {
                            skipped += 1;
                        }
                    } else {
                        // post_movements: real consumption per period year
                        let days = calendar::compute_days(
                            tx,
                            emp,
                            d.leave_type_id,
                            start,
                            end,
                            Part::Full,
                            Part::Full,
                        )?;
                        let mut by_year: std::collections::BTreeMap<i64, (i64, Date)> =
                            std::collections::BTreeMap::new();
                        for day in &days {
                            if day.minutes <= 0 {
                                continue;
                            }
                            let e = by_year.entry(day.period_year).or_insert((0, day.date));
                            e.0 += day.minutes;
                            e.1 = day.date;
                        }
                        for (year, (minutes, last_day)) in by_year {
                            let acc = ledger::ensure_account(tx, emp, d.leave_type_id, year)?;
                            let out = ledger::post_entry(
                                tx,
                                &PostEntry {
                                    account_id: acc,
                                    minutes: -minutes,
                                    kind: "consumption",
                                    effective_date: last_day,
                                    request_id: None,
                                    revision_id: None,
                                    reverses_entry_id: None,
                                    adjustment_id: None,
                                    import_batch_id: Some(batch_id),
                                    basis: format!(
                                        "Historical leave {}..{} (import)",
                                        d.start_date, d.end_date
                                    ),
                                    author_user_id: Some(actor.user_id),
                                    op_key: format!(
                                        "hist:{}:{}:{}:{}:{}",
                                        emp, d.leave_type_id, year, d.start_date, d.end_date
                                    ),
                                },
                                &now_ts,
                            )?;
                            if out.inserted {
                                applied += 1;
                            } else {
                                skipped += 1;
                            }
                        }
                    }
                }
            }
            _ => return Err(DomainError::validation("unknown import kind")),
        }
        tx.execute(
            "UPDATE import_batches SET status='committed', committed_at=?2 WHERE id=?1",
            params![batch_id, now_ts],
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "import.commit",
            "import_batch",
            Some(batch_id),
            serde_json::json!({"kind": kind, "applied": applied, "skipped": skipped}),
        )?;
        crate::notify::record_change(tx, clock, actor.user_id, "import.commit")?;
        Ok(CommitResult {
            applied,
            skipped_duplicates: skipped,
        })
    })
}

/// Import batch history rows.
pub fn list_imports(conn: &Connection) -> Res<Vec<serde_json::Value>> {
    let mut st = conn.prepare(
        "SELECT id, kind, mode, filename, status, rows_total, rows_valid, created_at, committed_at
         FROM import_batches ORDER BY id DESC",
    )?;
    let rows = st.query_map([], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_, i64>(0)?,
            "kind": r.get::<_, String>(1)?,
            "mode": r.get::<_, Option<String>>(2)?,
            "filename": r.get::<_, String>(3)?,
            "status": r.get::<_, String>(4)?,
            "rows_total": r.get::<_, i64>(5)?,
            "rows_valid": r.get::<_, i64>(6)?,
            "created_at": r.get::<_, String>(7)?,
            "committed_at": r.get::<_, Option<String>>(8)?,
        }))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ------------------------------------------------------------------ export

/// One row of the transfer export (DESIGN §9): approved leave days in the
/// period — the payroll-facing handover. Sensitive leave-type codes are
/// masked as 'RESTRICTED'.
pub struct TransferRow {
    pub employee_id: i64,
    pub request_id: i64,
    pub revision_id: i64,
    pub employee_service_id: String,
    pub request_number: String,
    pub revision_no: i64,
    pub leave_type_code: String,
    pub date: String,
    pub minutes: i64,
    pub period_year: i64,
    pub decision_at: String,
}

pub fn transfer_rows(conn: &Connection, from: Date, to: Date) -> Res<Vec<TransferRow>> {
    let mut st = conn.prepare(
        "SELECT e.service_id, lr.number, rr.rev_no, lt.code, (lt.sensitive OR COALESCE(json_extract(rr.policy_snapshot,'$.sensitive'),0)),
                rd.date, rd.minutes, rd.period_year, rr.id,e.id,lr.id
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN request_revisions rr ON rr.id = lr.effective_revision_id
         JOIN request_days rd ON rd.revision_id = rr.id
         JOIN leave_types lt ON lt.id = rr.leave_type_id
         WHERE lr.kind='leave' AND lr.status IN ('approved','cancelled')
           AND rd.minutes > 0 AND rd.date BETWEEN ?1 AND ?2
         ORDER BY e.service_id, rd.date",
    )?;
    let rows = st.query_map(params![date_s(&from), date_s(&to)], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, i64>(8)?,
            r.get::<_, i64>(9)?,
            r.get::<_, i64>(10)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            sid,
            number,
            rev_no,
            lt_code,
            sensitive,
            date,
            minutes,
            year,
            rev_id,
            employee_id,
            request_id,
        ) = row?;
        let decision_at: Option<String> = conn
            .query_row(
                "SELECT created_at FROM decisions
                 WHERE revision_id=?1 AND outcome='approve' ORDER BY id DESC LIMIT 1",
                [rev_id],
                |r| r.get(0),
            )
            .optional()?;
        out.push(TransferRow {
            employee_id,
            request_id,
            revision_id: rev_id,
            employee_service_id: sid,
            request_number: number,
            revision_no: rev_no,
            leave_type_code: if sensitive != 0 {
                "RESTRICTED".to_string()
            } else {
                lt_code
            },
            date,
            minutes,
            period_year: year,
            decision_at: decision_at.unwrap_or_default(),
        });
    }
    Ok(out)
}

pub struct ExportRecord {
    pub org_unit_id: Option<i64>,
    pub id: i64,
    pub row_count: i64,
    pub sha256: String,
    pub created_at: String,
    pub transferred_at: Option<String>,
    pub transferred_by: Option<i64>,
    pub period_from: Option<String>,
    pub period_to: Option<String>,
}

/// Build + persist the transfer export for [from, to]. hr scope required.
pub fn create_export(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    from: Date,
    to: Date,
) -> Res<ExportRecord> {
    create_export_scoped(conn, clock, actor, from, to, None)
}

pub fn create_export_scoped(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    from: Date,
    to: Date,
    org_unit_id: Option<i64>,
) -> Res<ExportRecord> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        authz::require(tx, actor, Action::ManageImportsExports, &Resource::Global)?;
        if to < from {
            return Err(DomainError::validation("to before from"));
        }
        let mut rows = transfer_rows(tx, from, to)?;
        let today = clock.today(tx)?;
        let mut scoped = Vec::new();
        for row in rows.drain(..) {
            let employee = employee_by_service_id(tx, &row.employee_service_id)?
                .ok_or_else(|| DomainError::not_found("export employee"))?;
            if actor.role_in_scope(tx, "hr", model::unit_of(tx, employee, today)?)?
                && org_unit_id
                    .map(|unit| {
                        model::unit_in_scope(
                            tx,
                            Some(unit),
                            model::unit_of(tx, employee, model::parse_date(&row.date)?)?,
                        )
                    })
                    .transpose()?
                    .unwrap_or(true)
            {
                scoped.push(row);
            }
        }
        let rows = scoped;
        let csv_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|r| {
                vec![
                    r.employee_service_id.clone(),
                    r.request_number.clone(),
                    r.revision_no.to_string(),
                    r.leave_type_code.clone(),
                    r.date.clone(),
                    r.minutes.to_string(),
                    r.period_year.to_string(),
                    r.decision_at.clone(),
                ]
            })
            .collect();
        let content = write_csv(
            &[
                "employee_service_id",
                "request_number",
                "revision_no",
                "leave_type_code",
                "date",
                "minutes",
                "period_year",
                "decision_at",
            ],
            &csv_rows,
        )?;
        let sha = sha256_bytes(&content);
        let id: i64 = tx.query_row(
            "INSERT INTO export_batches
             (kind, period_from, period_to, row_count, sha256, content, created_by, created_at,org_unit_id)
             VALUES ('approved_leave_transfer', ?1, ?2, ?3, ?4, ?5, ?6, ?7,?8) RETURNING id",
            params![
                date_s(&from),
                date_s(&to),
                rows.len() as i64,
                sha,
                content,
                actor.user_id,
                now_ts,org_unit_id
            ],
            |r| r.get(0),
        )?;
        for row in &rows {
            tx.execute("INSERT INTO export_rows(export_id,employee_id,request_id,revision_id,date,minutes) VALUES(?1,?2,?3,?4,?5,?6)",params![id,row.employee_id,row.request_id,row.revision_id,row.date,row.minutes])?;
        }
        for employee in crate::presentation::ids(tx, "SELECT id FROM employees", &[])? {
            let current_unit = model::unit_of(tx, employee, today)?;
            // Include employees with zero exported days, so later approvals are new changes.
            if actor.role_in_scope(tx, "hr", current_unit)? {
                let belongs = if let Some(unit) = org_unit_id {
                    tx.query_row("SELECT EXISTS(SELECT 1 FROM employment_assignments WHERE employee_id=?1 AND org_unit_id IN (WITH RECURSIVE units(id) AS (SELECT ?2 UNION ALL SELECT o.id FROM org_units o JOIN units u ON o.parent_id=u.id) SELECT id FROM units) AND valid_from<=?4 AND (valid_to IS NULL OR valid_to>=?3))",params![employee,unit,date_s(&from),date_s(&to)],|r|r.get::<_,bool>(0))?
                } else {
                    true
                };
                if belongs {
                    tx.execute(
                        "INSERT INTO export_scope(export_id,employee_id) VALUES(?1,?2)",
                        params![id, employee],
                    )?;
                }
            }
        }
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "export.create",
            "export_batch",
            Some(id),
            serde_json::json!({"from": date_s(&from), "to": date_s(&to), "rows": rows.len()}),
        )?;
        crate::notify::record_change(tx, clock, actor.user_id, "export.create")?;
        Ok(ExportRecord {
            org_unit_id,
            id,
            row_count: rows.len() as i64,
            sha256: sha,
            created_at: now_ts,
            transferred_at: None,
            transferred_by: None,
            period_from: Some(date_s(&from)),
            period_to: Some(date_s(&to)),
        })
    })
}

pub fn list_exports(conn: &Connection) -> Res<Vec<ExportRecord>> {
    let mut st = conn.prepare(
        "SELECT id, row_count, sha256, created_at, transferred_at, transferred_by,
                period_from, period_to,org_unit_id
         FROM export_batches ORDER BY id DESC",
    )?;
    let rows = st.query_map([], |r| {
        Ok(ExportRecord {
            id: r.get(0)?,
            row_count: r.get(1)?,
            sha256: r.get(2)?,
            created_at: r.get(3)?,
            transferred_at: r.get(4)?,
            transferred_by: r.get(5)?,
            period_from: r.get(6)?,
            period_to: r.get(7)?,
            org_unit_id: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn load_export(conn: &Connection, id: i64) -> Res<(ExportRecord, Vec<u8>)> {
    conn.query_row(
        "SELECT id, row_count, sha256, created_at, transferred_at, transferred_by,
                period_from, period_to, content,org_unit_id
         FROM export_batches WHERE id=?1",
        [id],
        |r| {
            Ok((
                ExportRecord {
                    id: r.get(0)?,
                    row_count: r.get(1)?,
                    sha256: r.get(2)?,
                    created_at: r.get(3)?,
                    transferred_at: r.get(4)?,
                    transferred_by: r.get(5)?,
                    period_from: r.get(6)?,
                    period_to: r.get(7)?,
                    org_unit_id: r.get(9)?,
                },
                r.get::<_, Vec<u8>>(8)?,
            ))
        },
    )
    .optional()?
    .ok_or_else(|| DomainError::not_found(format!("export {id}")))
}

/// Mark an export transferred/accepted (separate action — DESIGN §9).
pub fn mark_transferred(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    export_id: i64,
    note: Option<&str>,
) -> Res<()> {
    let now_ts = clock.now_ts();
    crate::db::write_tx(conn, |tx| {
        authz::require(tx, actor, Action::ManageImportsExports, &Resource::Global)?;
        authorized_export(tx, actor, export_id)?;
        let exists: Option<i64> = tx
            .query_row(
                "SELECT id FROM export_batches WHERE id=?1",
                [export_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(DomainError::not_found(format!("export {export_id}")));
        }
        tx.execute(
            "UPDATE export_batches SET transferred_by=?2, transferred_at=?3, accepted_note=?4
             WHERE id=?1 AND transferred_at IS NULL",
            params![export_id, actor.user_id, now_ts, note],
        )?;
        audit::log(
            tx,
            &now_ts,
            Some(actor.user_id),
            None,
            "export.mark_transferred",
            "export_batch",
            Some(export_id),
            serde_json::json!({"note": note}),
        )?;
        crate::notify::record_change(tx, clock, actor.user_id, "export.mark_transferred")?;
        Ok(())
    })
}

/// Recover old exports from their immutable CSV bytes without recalculating their contents.
pub fn migrate_export_snapshots(conn: &Connection) -> Res<()> {
    for record in list_exports(conn)? {
        let (_, bytes) = load_export(conn, record.id)?;
        let mut csv = csv::Reader::from_reader(bytes.as_slice());
        for row in csv.records() {
            let row = row?;
            let cell = |i| row.get(i).unwrap_or("").trim_start_matches('\'');
            let employee = employee_by_service_id(conn, cell(0))?
                .ok_or_else(|| DomainError::validation("legacy export employee unavailable"))?;
            let request: i64 = conn.query_row(
                "SELECT id FROM leave_requests WHERE number=?1",
                [cell(1)],
                |r| r.get(0),
            )?;
            let revision:i64=conn.query_row("SELECT rr.id FROM request_revisions rr JOIN request_days rd ON rd.revision_id=rr.id WHERE rr.request_id IN (SELECT id FROM leave_requests WHERE id=?1 OR parent_request_id=?1) AND rr.rev_no=?2 AND rd.date=?3 AND rd.minutes=?4 AND rr.created_at<=?6 AND (?5='' OR EXISTS(SELECT 1 FROM decisions d WHERE d.revision_id=rr.id AND d.outcome='approve' AND d.created_at=?5)) ORDER BY rr.id DESC LIMIT 1",params![request,cell(2),cell(4),cell(5),cell(7),record.created_at],|r|r.get(0))?;
            conn.execute("INSERT OR IGNORE INTO export_rows(export_id,employee_id,request_id,revision_id,date,minutes) VALUES(?1,?2,?3,?4,?5,?6)",params![record.id,employee,request,revision,cell(4),cell(5)])?;
            conn.execute(
                "INSERT OR IGNORE INTO export_scope(export_id,employee_id) VALUES(?1,?2)",
                params![record.id, employee],
            )?;
        }
        // Old exports had no stored organizational scope. Recover the creator's
        // scope at creation for employees who had no rows in the file.
        let creator: i64 = conn.query_row(
            "SELECT created_by FROM export_batches WHERE id=?1",
            [record.id],
            |r| r.get(0),
        )?;
        let on = model::parse_date(&record.created_at[..10])?;
        if let Ok(actor) = Actor::load(conn, creator, on) {
            for emp in crate::presentation::ids(conn, "SELECT id FROM employees", &[])? {
                if actor.role_in_scope(conn, "hr", model::unit_of(conn, emp, on)?)? {
                    conn.execute(
                        "INSERT OR IGNORE INTO export_scope(export_id,employee_id) VALUES(?1,?2)",
                        params![record.id, emp],
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// Compare the approved day state to saved contents, never to transfer timestamps.
pub fn changes_since_export(conn: &Connection) -> Res<Vec<serde_json::Value>> {
    changes_since_export_scoped(conn, None)
}
pub fn changes_since_export_scoped(
    conn: &Connection,
    unit: Option<i64>,
) -> Res<Vec<serde_json::Value>> {
    let candidates=crate::presentation::rows(conn,"SELECT lr.employee_id,lr.id AS request_id,rd.date FROM leave_requests lr JOIN request_days rd ON rd.revision_id=lr.effective_revision_id WHERE lr.kind='leave' AND lr.status IN ('approved','cancelled') AND rd.minutes>0 UNION SELECT employee_id,request_id,date FROM export_rows",&[])?;
    let mut out = Vec::new();
    for row in candidates {
        let emp = row["employee_id"].as_i64().unwrap();
        let request = row["request_id"].as_i64().unwrap();
        let date = row["date"].as_str().unwrap();
        if let Some(unit) = unit {
            if !model::unit_in_scope(
                conn,
                Some(unit),
                model::unit_of(conn, emp, model::parse_date(date)?)?,
            )? {
                continue;
            }
        }
        let latest:Option<i64>=conn.query_row("SELECT b.id FROM export_batches b JOIN export_scope s ON s.export_id=b.id WHERE s.employee_id=?1 AND b.transferred_at IS NOT NULL AND b.period_from<=?2 AND b.period_to>=?2 ORDER BY b.created_at DESC,b.id DESC LIMIT 1",params![emp,date],|r|r.get(0)).optional()?;
        let before: Option<(i64, i64)> = if let Some(export) = latest {
            conn.query_row("SELECT revision_id,minutes FROM export_rows WHERE export_id=?1 AND request_id=?2 AND date=?3",params![export,request,date],|r|Ok((r.get(0)?,r.get(1)?))).optional()?
        } else {
            None
        };
        let after:Option<(i64,i64)>=conn.query_row("SELECT rr.id,rd.minutes FROM leave_requests lr JOIN request_revisions rr ON rr.id=lr.effective_revision_id JOIN request_days rd ON rd.revision_id=rr.id WHERE lr.id=?1 AND lr.kind='leave' AND lr.status IN ('approved','cancelled') AND rd.date=?2 AND rd.minutes>0",params![request,date],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if before == after {
            continue;
        }
        let kind = match (before, after) {
            (None, Some(_)) => "new",
            (Some(_), None) => "removed",
            _ => "changed",
        };
        let employee = model::load_employee(conn, emp)?;
        let req = model::load_request(conn, request)?;
        let revision = after.or(before).unwrap().0;
        let t = model::revision_leave_type(conn, revision)?;
        out.push(serde_json::json!({"employee_service_id":employee.service_id,"employee":employee.full_name,"request_id":request,"request_number":req.number,"date":date,"effective_date":date,"kind":kind,"minutes":after.map_or(0,|(_,m)|m),"previous_minutes":before.map_or(0,|(_,m)|m),"revision_id":after.map(|(r,_)|r),"previous_revision_id":before.map(|(r,_)|r),"export_id":latest,"leave_type_code":if t.sensitive {"RESTRICTED"}else{&t.code}}));
    }
    Ok(out)
}

// ------------------------------------------------------------------ tests

fn import_row_scope(
    conn: &Connection,
    actor: &Actor,
    kind: &str,
    row: &serde_json::Value,
    today: Date,
) -> Res<()> {
    // Invalid rows remain preview errors. Scope validation applies whenever an employee/unit can be resolved.
    if let Some(sid) = row["service_id"].as_str() {
        if let Some(employee) = employee_by_service_id(conn, sid)? {
            authz::require(
                conn,
                actor,
                Action::ManagePeople,
                &Resource::Employee {
                    employee_id: employee,
                    org_unit_id: model::unit_of(conn, employee, today)?,
                },
            )?;
        }
    }
    if kind == "employees" {
        if let Some(unit) = row["org_unit_id"].as_i64() {
            authz::require(
                conn,
                actor,
                Action::ManagePeople,
                &Resource::Employee {
                    employee_id: 0,
                    org_unit_id: Some(unit),
                },
            )?;
        }
    }
    Ok(())
}
/// Saved CSVs are re-authorized against the current employee assignments on each download/mark.
pub fn authorized_export(
    conn: &Connection,
    actor: &Actor,
    id: i64,
) -> Res<(ExportRecord, Vec<u8>)> {
    authz::require(conn, actor, Action::ManageImportsExports, &Resource::Global)?;
    let (record, bytes) = load_export(conn, id)?;
    let owner: i64 = conn.query_row(
        "SELECT created_by FROM export_batches WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    if owner != actor.user_id && !actor.role_in_scope(conn, "hr", None)? {
        return Err(DomainError::forbidden("export belongs to another HR scope"));
    }
    let mut csv = csv::Reader::from_reader(bytes.as_slice());
    for row in csv.records() {
        let row = row?;
        let sid = row
            .get(0)
            .unwrap_or("")
            .strip_prefix('\'')
            .unwrap_or(row.get(0).unwrap_or(""));
        let employee = employee_by_service_id(conn, sid)?
            .ok_or_else(|| DomainError::forbidden("export employee is unavailable"))?;
        authz::require(
            conn,
            actor,
            Action::ManagePeople,
            &Resource::Employee {
                employee_id: employee,
                org_unit_id: model::unit_of(conn, employee, actor.today)?,
            },
        )?;
    }
    Ok((record, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::Clock;
    use crate::{db, seed};
    use time::macros::date;

    fn fixture() -> (Connection, Actor, Clock) {
        let dir = std::env::temp_dir().join(format!("nld-imp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let files = dir.join("files");
        let mut conn = db::open_memory().unwrap();
        db::migrate(&conn).unwrap();
        seed::seed_template(&mut conn, &files).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let clock = Clock::demo();
        let today = clock.today(&conn).unwrap();
        // Maria = hr (scope all)
        let maria_user: i64 = conn
            .query_row(
                "SELECT user_id FROM employees WHERE service_id='NPS-0001'",
                [],
                |r| r.get::<_, Option<i64>>(0),
            )
            .unwrap()
            .unwrap();
        let actor = Actor::load(&conn, maria_user, today).unwrap();
        (conn, actor, clock)
    }

    #[test]
    fn import_preview_errors() {
        let (mut conn, actor, clock) = fixture();
        let csv = b"service_id,leave_type,period_year,minutes\n\
            NPS-9999,ANNUAL,2026,480\n\
            NPS-1001,ANNUAL,2026,480\n\
            NPS-1001,ANNUAL,2026,480\n\
            NPS-1002,ANNUAL,not-a-year,480\n\
            NPS-1002,ANNUAL,2026,-5\n\
            NPS-1002,MISSING,2026,480\n";
        let res = import_preview(
            &mut conn,
            &clock,
            &actor,
            "opening_balances",
            None,
            "openings.csv",
            csv,
        )
        .unwrap();
        assert_eq!(res.rows_total, 6);
        assert_eq!(res.rows_valid, 0);
        let errors: Vec<Vec<String>> = res.rows.iter().map(|r| r.errors.clone()).collect();
        assert!(
            errors[0].iter().any(|e| e.contains("unknown service_id")),
            "{:?}",
            errors[0]
        );
        // NPS-1001/ANNUAL/2026 has a seeded opening → conflict
        assert!(
            errors[1]
                .iter()
                .any(|e| e.contains("opening already posted")),
            "{:?}",
            errors[1]
        );
        assert!(
            errors[2].iter().any(|e| e.contains("duplicate")),
            "{:?}",
            errors[2]
        );
        assert!(
            errors[3].iter().any(|e| e.contains("period_year")),
            "{:?}",
            errors[3]
        );
        assert!(
            errors[4].iter().any(|e| e.contains("negative value")),
            "{:?}",
            errors[4]
        );
        assert!(
            errors[5].iter().any(|e| e.contains("unknown leave_type")),
            "{:?}",
            errors[5]
        );
        // all-or-nothing: commit refused
        let err = import_commit(&mut conn, &clock, &actor, res.batch_id).unwrap_err();
        assert_eq!(err.code(), "import_invalid");
    }

    #[test]
    fn import_idempotent() {
        let (mut conn, actor, clock) = fixture();
        let csv = b"service_id,leave_type,period_year,minutes\nNPS-1001,FAMILY,2025,1200\n";
        let p1 = import_preview(
            &mut conn,
            &clock,
            &actor,
            "opening_balances",
            None,
            "o.csv",
            csv,
        )
        .unwrap();
        let c1 = import_commit(&mut conn, &clock, &actor, p1.batch_id).unwrap();
        assert_eq!(c1.applied, 1);
        // re-commit same batch → refused
        assert!(import_commit(&mut conn, &clock, &actor, p1.batch_id).is_err());
        // same file again → hash guard: nothing applied, all skipped
        let p2 = import_preview(
            &mut conn,
            &clock,
            &actor,
            "opening_balances",
            None,
            "o2.csv",
            csv,
        )
        .unwrap();
        let c2 = import_commit(&mut conn, &clock, &actor, p2.batch_id).unwrap();
        assert_eq!(c2.applied, 0);
        assert_eq!(c2.skipped_duplicates, 1);
        // a *changed* file (different sha) still can't double-post: the
        // existing opening surfaces as a preview conflict
        let csv2 = b"service_id,leave_type,period_year,minutes\nNPS-1001,FAMILY,2025,1300\n";
        let p3 = import_preview(
            &mut conn,
            &clock,
            &actor,
            "opening_balances",
            None,
            "o3.csv",
            csv2,
        )
        .unwrap();
        assert_eq!(p3.rows_valid, 0);
        // balance unchanged: only the first opening applied
        let acc = ledger::accounts_of(
            &conn,
            employee_by_service_id(&conn, "NPS-1001").unwrap().unwrap(),
            None,
        )
        .unwrap()
        .into_iter()
        .find(|(_, lt, y)| {
            let t = model::load_leave_type(&conn, *lt).unwrap();
            t.code == "FAMILY" && *y == 2025
        })
        .unwrap();
        assert_eq!(
            ledger::balance_at(&conn, acc.0, date!(2030 - 01 - 01)).unwrap(),
            1200
        );
    }

    #[test]
    fn historical_modes() {
        let (mut conn, actor, clock) = fixture();
        // mode column inside the file is rejected
        let bad = b"service_id,leave_type,start_date,end_date,mode\nNPS-1001,ANNUAL,2026-03-02,2026-03-03,post_movements\n";
        assert!(import_preview(
            &mut conn,
            &clock,
            &actor,
            "historical_leave",
            Some("post_movements"),
            "h.csv",
            bad
        )
        .is_err());
        // missing mode is rejected
        let good =
            b"service_id,leave_type,start_date,end_date\nNPS-1001,ANNUAL,2026-03-02,2026-03-03\n";
        assert!(import_preview(
            &mut conn,
            &clock,
            &actor,
            "historical_leave",
            None,
            "h.csv",
            good
        )
        .is_err());
        // post_movements posts consumption (-960) on the 2026 ANNUAL account
        let p = import_preview(
            &mut conn,
            &clock,
            &actor,
            "historical_leave",
            Some("post_movements"),
            "h.csv",
            good,
        )
        .unwrap();
        assert_eq!(p.rows_valid, 1);
        let c = import_commit(&mut conn, &clock, &actor, p.batch_id).unwrap();
        assert_eq!(c.applied, 1);
        let emp = employee_by_service_id(&conn, "NPS-1001").unwrap().unwrap();
        let accs = ledger::accounts_of(&conn, emp, None).unwrap();
        let annual = conn
            .query_row("SELECT id FROM leave_types WHERE code='ANNUAL'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        let acc26 = accs
            .iter()
            .find(|a| a.1 == annual && a.2 == 2026)
            .unwrap()
            .0;
        assert_eq!(
            ledger::balance_at(&conn, acc26, date!(2026 - 10 - 08)).unwrap(),
            9600 - 960
        );
        let _ = annual;
        // already_in_opening: 0-minute historical record on another employee
        let rec =
            b"service_id,leave_type,start_date,end_date\nNPS-1003,ANNUAL,2026-04-01,2026-04-02\n";
        let p = import_preview(
            &mut conn,
            &clock,
            &actor,
            "historical_leave",
            Some("already_in_opening"),
            "h2.csv",
            rec,
        )
        .unwrap();
        let c = import_commit(&mut conn, &clock, &actor, p.batch_id).unwrap();
        assert_eq!(c.applied, 1);
        let tom = employee_by_service_id(&conn, "NPS-1003").unwrap().unwrap();
        let accs = ledger::accounts_of(&conn, tom, None).unwrap();
        let a26 = accs
            .iter()
            .find(|a| a.1 == annual && a.2 == 2026)
            .unwrap()
            .0;
        // Tom's seed leave consumed 1920 from 2026; historical adds 0
        assert_eq!(
            ledger::balance_at(&conn, a26, date!(2026 - 10 - 08)).unwrap(),
            9600 - 1920
        );
    }

    #[test]
    fn employees_import() {
        let (mut conn, actor, clock) = fixture();
        let csv = b"service_id,full_name,email,start_date,org_unit,schedule,manager_service_id\n\
            NPS-9001,Test Person,t.p@x.example,2026-01-05,IU,Standard Mon\xe2\x80\x93Fri 8h,NPS-1002\n\
            NPS-1001,Existing,e@x.example,2026-01-05,IU,Standard Mon\xe2\x80\x93Fri 8h,\n";
        let p = import_preview(&mut conn, &clock, &actor, "employees", None, "e.csv", csv).unwrap();
        assert_eq!(p.rows_valid, 2, "{:?}", p.rows);
        let c = import_commit(&mut conn, &clock, &actor, p.batch_id).unwrap();
        assert_eq!(c.applied, 1);
        assert_eq!(c.skipped_duplicates, 1);
        let new = employee_by_service_id(&conn, "NPS-9001").unwrap().unwrap();
        let emp = model::load_employee(&conn, new).unwrap();
        assert_eq!(emp.full_name, "Test Person");
        let mgr = model::manager_at(&conn, new, date!(2026 - 06 - 01))
            .unwrap()
            .unwrap();
        assert_eq!(mgr.service_id, "NPS-1002");
    }

    #[test]
    fn csv_formula_safe() {
        let out = write_csv(
            &["a", "b"],
            &[
                vec!["=1+1".to_string(), "x".to_string()],
                vec!["@cmd".to_string(), "-5".to_string()],
                vec!["+43".to_string(), "\ttab".to_string()],
                vec!["\rret".to_string(), "normal".to_string()],
            ],
        )
        .unwrap();
        let text = String::from_utf8(out).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next().unwrap(), "a,b");
        assert_eq!(lines.next().unwrap(), "'=1+1,x");
        assert_eq!(lines.next().unwrap(), "'@cmd,'-5");
        assert_eq!(lines.next().unwrap(), "'+43,'\ttab");
        let records = csv::Reader::from_reader(text.as_bytes())
            .records()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(&records[3][0], "'\rret");
    }
}
