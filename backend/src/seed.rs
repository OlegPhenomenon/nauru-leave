//! Demo template seed (docs/DEMO_DATA.md). All requests go through the real
//! domain functions with the business clock moved back to plausible dates —
//! the ledger, reservations, steps, audit and outbox are consistent by
//! construction. Finishes with `demo_today = 2026-10-08`.

use std::path::Path;

use rusqlite::{params, Connection};
use time::Date;

use crate::authz::Actor;
use crate::clock::Clock;
use crate::error::DomainError;
use crate::files::FileStore;
use crate::ledger;
use crate::model::{self, Part};
use crate::notify::{self, MailboxTransport};
use crate::people;
use crate::requests::{self, DraftInput};
use crate::Res;

fn d(s: &str) -> Date {
    model::parse_date(s).unwrap()
}

fn at(s: &str) -> Clock {
    Clock::fixed(d(s))
}

#[allow(dead_code)]
struct Ids {
    annual: i64,
    sick: i64,
    family: i64,
    unpaid: i64,
    alexei: i64,
    olga: i64,
    tom: i64,
    lina: i64,
    sam_emp: i64,
    rita: i64,
    ben: i64,
    nia: i64,
    maria: i64,
    elena: i64,
    david: i64,
    pavel: i64,
    grace: i64,
    u_alexei: i64,
    u_olga: i64,
    u_tom: i64,
    u_lina: i64,
    u_rita: i64,
    u_ben: i64,
    u_nia: i64,
    u_maria: i64,
    u_elena: i64,
    u_david: i64,
    u_pavel: i64,
    u_grace: i64,
}

/// Build the demo template into `conn` (fresh, migrated) with attachment
/// files stored under `files_dir`.
pub fn seed_template(conn: &mut Connection, files_dir: &Path) -> Res<()> {
    let now_ts = "2025-01-01T09:00:00Z";

    // ------------------------------------------------------------- org units
    let chr = people::create_org_unit(conn, "CHR", "Central HR Office", None)?;
    let iu = people::create_org_unit(conn, "IU", "Infrastructure Unit", None)?;
    let csu = people::create_org_unit(conn, "CSU", "Community Services Unit", None)?;
    let _ = (chr, iu, csu);

    // ------------------------------------------------------------- schedules
    let (standard, _) = people::create_schedule(
        conn,
        "Standard Mon–Fri 8h",
        d("2025-01-01"),
        [480, 480, 480, 480, 480, 0, 0],
        Some("Demo schedule — fictional"),
    )?;
    let (part_time, _) = people::create_schedule(
        conn,
        "Part-time Mon–Thu 6h",
        d("2025-01-01"),
        [360, 360, 360, 360, 0, 0, 0],
        Some("Demo schedule — fictional"),
    )?;

    // ------------------------------------------------------------- holidays
    for (date, name) in [
        ("2025-12-25", "Christmas Day"),
        ("2025-12-26", "Christmas holiday"),
        ("2026-01-01", "New Year's Day"),
        ("2026-01-31", "Independence Day"),
        ("2026-05-17", "Constitution Day"),
        ("2026-10-26", "Angam Day"),
        ("2026-12-25", "Christmas Day"),
        ("2026-12-28", "Christmas substitute"),
        ("2027-01-01", "New Year's Day"),
    ] {
        people::create_calendar_exception(conn, d(date), name, 0, None, now_ts)?;
    }

    // ------------------------------------------------------------- leave types + policies
    const EXPLANATION: &str = "Fictional demo rule — not Nauru law. \
        Must be confirmed by the responsible HR officer before real use.";
    let annual = people::create_leave_type(conn, "ANNUAL", "Annual leave", false)?;
    let sick = people::create_leave_type(conn, "SICK", "Sick leave", true)?;
    let family = people::create_leave_type(conn, "FAMILY", "Family responsibility leave", false)?;
    let unpaid = people::create_leave_type(conn, "UNPAID", "Unpaid leave", false)?;
    for (lt, entitlement, carryover, accrual) in [
        (annual, 9600, true, "annual_upfront"),
        (sick, 4800, false, "annual_upfront"),
        (family, 2400, false, "annual_upfront"),
        (unpaid, 0, false, "none"),
    ] {
        people::create_policy(
            conn, lt, d("2025-01-01"), entitlement, accrual, 3, carryover, None,
            false, EXPLANATION, "demo_fictional", None, now_ts,
        )?;
    }

    conn.execute("UPDATE policy_versions SET carryover_limit_min=4800,min_notice_days=5 WHERE leave_type_id=?1",[annual])?;
    conn.execute("UPDATE policy_versions SET paid=0,uses_balance=0,allow_half_day=0,min_notice_days=10 WHERE leave_type_id=?1",[unpaid])?;

    // ------------------------------------------------------------- people
    let mk = |conn: &Connection, sid: &str, name: &str, unit: i64, mgr: Option<i64>, sched: i64| -> Res<(i64, i64)> {
        let email = format!(
            "{}@nauru.example",
            name.to_lowercase().replace(' ', ".")
        );
        let user = people::create_user(conn, &email, name, None, now_ts)?;
        let emp = people::create_employee(
            conn, sid, name, Some(&email), Some(user),
            d("2020-01-01"), unit, mgr, sched, d("2020-01-01"), now_ts,
        )?;
        Ok((emp, user))
    };

    // users must exist before employees that reference managers; managers are
    // referenced by employee id, so create in an order where the manager row
    // already exists — Elena first (no manager), then the rest.
    let (elena, u_elena) = mk(conn, "NPS-0002", "Elena Ward", chr, None, standard)?;
    let (maria, u_maria) = mk(conn, "NPS-0001", "Maria Santos", chr, Some(elena), standard)?;
    let (david, u_david) = mk(conn, "NPS-0003", "David Hale", chr, Some(elena), standard)?;
    let (pavel, u_pavel) = mk(conn, "NPS-0004", "Pavel Grant", chr, Some(elena), standard)?;
    let (grace, u_grace) = mk(conn, "NPS-0005", "Grace Lin", chr, Some(elena), standard)?;
    let (olga, u_olga) = mk(conn, "NPS-1002", "Olga Berg", iu, Some(elena), standard)?;
    let (rita, u_rita) = mk(conn, "NPS-2001", "Rita Moss", csu, Some(elena), standard)?;
    let (alexei, u_alexei) = mk(conn, "NPS-1001", "Alexei Novak", iu, Some(olga), standard)?;
    let (tom, u_tom) = mk(conn, "NPS-1003", "Tom Reed", iu, Some(olga), standard)?;
    let (lina, u_lina) = mk(conn, "NPS-1004", "Lina Cole", iu, Some(olga), part_time)?;
    let (ben, u_ben) = mk(conn, "NPS-2002", "Ben Carter", csu, Some(rita), standard)?;
    let (nia, u_nia) = mk(conn, "NPS-2003", "Nia Fox", csu, Some(rita), standard)?;
    // Sam has no login; unreachable.demo email shows a failing notification.
    let sam_emp = people::create_employee(
        conn, "NPS-1005", "Sam Oduya", Some("sam.oduya@unreachable.demo"), None,
        d("2020-01-01"), iu, Some(olga), standard, d("2020-01-01"), now_ts,
    )?;

    let ids = Ids {
        annual, sick, family, unpaid,
        alexei, olga, tom, lina, sam_emp, rita, ben, nia,
        maria, elena, david, pavel, grace,
        u_alexei, u_olga, u_tom, u_lina, u_rita, u_ben, u_nia,
        u_maria, u_elena, u_david, u_pavel, u_grace,
    };

    // ------------------------------------------------------------- roles (scope NULL = all)
    for (user, role) in [
        (u_maria, "hr"),
        (u_maria, "hr_medical"),
        (u_elena, "final_approver"),
        (u_david, "hr"),
        (u_david, "adjustment_approver"),
        (u_pavel, "tech_admin"),
        (u_grace, "auditor"),
    ] {
        people::grant_role(conn, user, role, None, d("2025-01-01"), None, None, now_ts)?;
    }

    // ------------------------------------------------------------- delegations
    // future: Olga -> Tom for December (demo shows "acting for" later)
    conn.execute(
        "INSERT INTO delegations(from_user_id, to_user_id, scope, valid_from, valid_to, reason, created_by, created_at)
         VALUES (?1,?2,'manager_recommendation','2026-12-14','2026-12-31','Acting manager during December leave',?1,'2026-10-01T09:00:00Z')",
        params![u_olga, u_tom],
    )?;
    // expired: Rita -> Ben in September
    conn.execute(
        "INSERT INTO delegations(from_user_id, to_user_id, scope, valid_from, valid_to, reason, created_by, created_at)
         VALUES (?1,?2,'manager_recommendation','2026-09-01','2026-09-15','September coverage',?1,'2026-08-25T09:00:00Z')",
        params![u_rita, u_ben],
    )?;

    // ------------------------------------------------------------- opening balances
    for emp in [alexei, olga, tom, sam_emp, rita, ben, nia, maria, elena, david, pavel, grace] {
        ledger::post_opening(conn, emp, annual, 2026, 9600, if emp == tom { d("2025-12-10") } else { d("2026-01-01") },
            "Opening balance 2026 (20 days)", Some(u_maria), "2026-01-01T09:00:00Z")?;
        ledger::post_opening(conn, emp, sick, 2026, 4800, d("2026-01-01"),
            "Opening balance 2026", Some(u_maria), "2026-01-01T09:00:00Z")?;
        ledger::post_opening(conn, emp, family, 2026, 2400, d("2026-01-01"),
            "Opening balance 2026", Some(u_maria), "2026-01-01T09:00:00Z")?;
    }
    // Lina works the part-time Mon–Thu 6 h schedule (360 min/day), so her
    // openings are posted in her own days, not full-time minutes.
    ledger::post_opening(conn, lina, annual, 2026, 7200, d("2026-01-01"),
        "Opening balance 2026 (20 days), pro-rated to the part-time schedule (fictional demo rule)", Some(u_maria), "2026-01-01T09:00:00Z")?;
    ledger::post_opening(conn, lina, sick, 2026, 3600, d("2026-01-01"),
        "Opening balance 2026 (10 days), pro-rated to the part-time schedule (fictional demo rule)", Some(u_maria), "2026-01-01T09:00:00Z")?;
    ledger::post_opening(conn, lina, family, 2026, 1800, d("2026-01-01"),
        "Opening balance 2026 (5 days), pro-rated to the part-time schedule (fictional demo rule)", Some(u_maria), "2026-01-01T09:00:00Z")?;
    ledger::post_opening(conn, tom, annual, 2025, 9600, d("2025-01-01"),
        "Opening balance 2025 (20 days)", Some(u_maria), "2025-01-01T09:00:00Z")?;

    run_scenarios(conn, files_dir, &ids)?;

    // ------------------------------------------------------------- finish
    conn.execute(
        "INSERT INTO settings(key, value) VALUES ('demo_today', '2026-10-08')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [],
    )?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES ('mode', 'demo')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [],
    )?;
    // flush the outbox once: everything lands in `mailbox`, Sam's address fails
    notify::deliver_due(conn, &MailboxTransport, at("2026-10-08").now())?;
    Ok(())
}

// ------------------------------------------------------------------ scenarios

fn actor(conn: &Connection, user_id: i64, clock: &Clock) -> Res<Actor> {
    Actor::load(conn, user_id, clock.today(conn)?)
}

#[allow(clippy::too_many_arguments)]
fn draft(
    conn: &mut Connection,
    clock: &Clock,
    actor: &Actor,
    leave_type: i64,
    start: &str,
    end: &str,
    start_part: Part,
    end_part: Part,
    note: &str,
) -> Res<i64> {
    let input = DraftInput {
        employee_id: None,
        leave_type_id: leave_type,
        start_date: d(start),
        end_date: d(end),
        start_part,
        end_part,
        note: Some(note.to_string()),
        paper: false,
        paper_received_date: None,
        previous_request_id: None,
    };
    let id = requests::create_draft(conn, clock, actor, &input)?;
    let req = model::load_request(conn, id)?;
    requests::submit(conn, clock, actor, id, req.version, None)?;
    Ok(id)
}

/// Decide the currently pending step as `user_id`.
fn decide_next(
    conn: &mut Connection,
    clock: &Clock,
    user_id: i64,
    request_id: i64,
    outcome: &str,
    reason: Option<&str>,
) -> Res<()> {
    let a = actor(conn, user_id, clock)?;
    let req = model::load_request(conn, request_id)?;
    let step = requests::pending_step(conn, request_id)?
        .ok_or_else(|| DomainError::Internal(anyhow::anyhow!("no pending step")))?;
    requests::decide(
        conn, clock, &a, request_id, step.id, outcome, reason, None, req.version, None,
    )
}

fn run_scenarios(conn: &mut Connection, files_dir: &Path, ids: &Ids) -> Res<()> {
    // -------- Tom: approved year-boundary leave 2025-12-29..2026-01-07
    {
        let c = at("2025-12-10");
        let t = actor(conn, ids.u_tom, &c)?;
        let r = draft(conn, &c, &t, ids.annual, "2025-12-29", "2026-01-07",
            Part::Full, Part::Full, "Family visit over the holidays")?;
        decide_next(conn, &at("2025-12-11"), ids.u_olga, r, "recommend_approve", None)?;
        decide_next(conn, &at("2025-12-12"), ids.u_maria, r, "checked_ok", None)?;
        decide_next(conn, &at("2025-12-15"), ids.u_elena, r, "approve", None)?;
        // actual period confirmed after it ended
        let c2 = at("2026-01-15");
        let m = actor(conn, ids.u_maria, &c2)?;
        let req = model::load_request(conn, r)?;
        requests::actual_period(
            conn, &c2, &m, r, "confirm", "Returned to work as planned", None, None, req.version,
        )?;
    }

    // -------- Ben: approved 2026-09-21..22 then fully cancelled
    {
        let c = at("2026-09-01");
        let b = actor(conn, ids.u_ben, &c)?;
        let r = draft(conn, &c, &b, ids.annual, "2026-09-21", "2026-09-22",
            Part::Full, Part::Full, "Short break")?;
        decide_next(conn, &at("2026-09-02"), ids.u_rita, r, "recommend_approve", None)?;
        decide_next(conn, &at("2026-09-03"), ids.u_maria, r, "checked_ok", None)?;
        decide_next(conn, &at("2026-09-04"), ids.u_elena, r, "approve", None)?;
        let c2 = at("2026-09-10");
        let b2 = actor(conn, ids.u_ben, &c2)?;
        let req = model::load_request(conn, r)?;
        let cancel = requests::cancel(
            conn, &c2, &b2, r, d("2026-09-21"), d("2026-09-22"),
            "Plans changed — no longer needed", req.version, None,
        )?;
        decide_next(conn, &at("2026-09-11"), ids.u_rita, cancel.request_id, "recommend_approve", None)?;
        decide_next(conn, &at("2026-09-12"), ids.u_maria, cancel.request_id, "checked_ok", None)?;
        decide_next(conn, &at("2026-09-14"), ids.u_elena, cancel.request_id, "approve", None)?;
    }

    // -------- Ben: rejected 2026-10-26..30 (Angam week)
    {
        let c = at("2026-09-28");
        let b = actor(conn, ids.u_ben, &c)?;
        let r = draft(conn, &c, &b, ids.annual, "2026-10-26", "2026-10-30",
            Part::Full, Part::Full, "Family trip")?;
        decide_next(conn, &at("2026-09-29"), ids.u_rita, r, "recommend_approve", None)?;
        decide_next(conn, &at("2026-09-30"), ids.u_maria, r, "checked_ok", None)?;
        decide_next(
            conn, &at("2026-10-02"), ids.u_elena, r, "reject",
            Some("Community programme week — please choose other dates"),
        )?;
    }

    // -------- Tom: withdrawn single day 2026-09-14
    {
        let c = at("2026-09-08");
        let t = actor(conn, ids.u_tom, &c)?;
        let r = draft(conn, &c, &t, ids.annual, "2026-09-14", "2026-09-14",
            Part::Full, Part::Full, "Personal errand")?;
        let c2 = at("2026-09-09");
        let t2 = actor(conn, ids.u_tom, &c2)?;
        let req = model::load_request(conn, r)?;
        requests::withdraw(conn, &c2, &t2, r, Some("No longer needed"), req.version)?;
    }

    // -------- Rita: approved half day 2026-10-16 am
    {
        let c = at("2026-10-01");
        let rita = actor(conn, ids.u_rita, &c)?;
        let r = draft(conn, &c, &rita, ids.annual, "2026-10-16", "2026-10-16",
            Part::Am, Part::Am, "Morning appointment")?;
        decide_next(conn, &at("2026-10-02"), ids.u_elena, r, "recommend_approve", None)?;
        decide_next(conn, &at("2026-10-02"), ids.u_maria, r, "checked_ok", None)?;
        decide_next(conn, &at("2026-10-03"), ids.u_elena, r, "approve", None)?;
    }

    // -------- Nia: approved SICK 2026-10-01..02 with a medical attachment
    {
        let c = at("2026-09-30");
        let n = actor(conn, ids.u_nia, &c)?;
        let input = DraftInput {
            employee_id: None,
            leave_type_id: ids.sick,
            start_date: d("2026-10-01"),
            end_date: d("2026-10-02"),
            start_part: Part::Full,
            end_part: Part::Full,
            note: Some("Sick leave".to_string()),
            paper: false,
            paper_received_date: None,
            previous_request_id: None,
        };
        let r = requests::create_draft(conn, &c, &n, &input)?;
        let store = FileStore::new(files_dir)?;
        requests::upload_attachment(
            conn, &c, &n, &store, r, "medical-certificate-demo.pdf",
            DEMO_MEDICAL_PDF, "medical",
        )?;
        let req = model::load_request(conn, r)?;
        requests::submit(conn, &c, &n, r, req.version, None)?;
        decide_next(conn, &at("2026-10-01"), ids.u_rita, r, "recommend_approve", None)?;
        decide_next(conn, &at("2026-10-01"), ids.u_maria, r, "checked_ok", None)?;
        decide_next(conn, &at("2026-10-02"), ids.u_elena, r, "approve", None)?;
    }

    // -------- Lina: submitted ANNUAL 2026-11-10..12 (waiting for Olga) — the
    // team_overlap warning for Alexei's November request
    {
        let c = at("2026-10-05");
        let l = actor(conn, ids.u_lina, &c)?;
        let _ = draft(conn, &c, &l, ids.annual, "2026-11-10", "2026-11-12",
            Part::Full, Part::Full, "Family visit")?;
    }

    // -------- Olga: FAMILY in needs_information (Maria's question)
    {
        let c = at("2026-10-03");
        let o = actor(conn, ids.u_olga, &c)?;
        let r = draft(conn, &c, &o, ids.family, "2026-10-15", "2026-10-15",
            Part::Full, Part::Full, "School event")?;
        decide_next(conn, &at("2026-10-04"), ids.u_elena, r, "recommend_approve", None)?;
        decide_next(
            conn, &at("2026-10-06"), ids.u_maria, r, "needs_information",
            Some("Please confirm whether the school event date is fixed."),
        )?;
    }

    // -------- Sam: paper request entered by Maria, under_review after Olga's
    // recommendation; notification to Sam fails (unreachable.demo)
    {
        let c = at("2026-10-06");
        let m = actor(conn, ids.u_maria, &c)?;
        let input = DraftInput {
            employee_id: Some(ids.sam_emp),
            leave_type_id: ids.annual,
            start_date: d("2026-10-20"),
            end_date: d("2026-10-21"),
            start_part: Part::Full,
            end_part: Part::Full,
            note: Some("Paper form received by post".to_string()),
            paper: true,
            paper_received_date: Some(d("2026-10-05")),
            previous_request_id: None,
        };
        let r = requests::create_draft(conn, &c, &m, &input)?;
        let req = model::load_request(conn, r)?;
        requests::submit(conn, &c, &m, r, req.version, None)?;
        decide_next(conn, &at("2026-10-07"), ids.u_olga, r, "recommend_approve", None)?;
        // Maria's proposed +480 correction awaits David (two-person rule)
        let c2 = at("2026-10-07");
        ledger::propose_adjustment(
            conn, &c2, &m, ids.sam_emp, ids.annual, 2026, 480,
            "Paper record correction", "HR file NPS-1005/2026-114", None,
        )?;
    }

    Ok(())
}

/// A tiny valid PDF carrying the demo medical text (DEMO_DATA.md).
const DEMO_MEDICAL_PDF: &[u8] = b"%PDF-1.4
% DEMO MEDICAL CERTIFICATE - ARTIFICIAL CONTENT
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 96>>stream
BT /F1 10 Tf 20 60 Td (DEMO MEDICAL CERTIFICATE - ARTIFICIAL CONTENT) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
";

/// Publish only a completely seeded, closed and checkpointed template.
pub fn build_template(path: &Path, files: &Path) -> Res<()> {
    let temporary = path.with_extension("building.sqlite");
    if temporary.exists() {
        std::fs::remove_file(&temporary)?;
    }
    if files.exists() {
        std::fs::remove_dir_all(files)?;
    }
    let mut conn = crate::db::open(&temporary)?;
    crate::db::migrate(&conn)?;
    seed_template(&mut conn, files)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
    drop(conn);
    std::fs::rename(temporary, path)?;
    Ok(())
}
