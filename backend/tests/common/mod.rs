//! Shared fixture: a miniature copy of the demo world from docs/DEMO_DATA.md,
//! built directly through `people::` writers (the demo seed is exercised by
//! `seed_builds` in system.rs). Business date is driven by `settings.demo_today`
//! (`Clock::demo`) so tests exercise the same code path as the CLI.
#![allow(dead_code)]

use std::path::PathBuf;

use nauru_leave::authz::Actor;
use nauru_leave::clock::Clock;
use nauru_leave::files::FileStore;
use nauru_leave::model::{self, parse_date, Part, Step};
use nauru_leave::requests::{self, DraftInput, ReviseInput};
use nauru_leave::{db, ledger, people};
use rusqlite::{params, Connection};
use time::Date;

pub fn d(s: &str) -> Date {
    parse_date(s).unwrap()
}

/// A throwaway directory under the OS temp dir (no tempfile dep — the
/// allowed crate list is fixed).
pub struct TmpDir(pub PathBuf);

impl TmpDir {
    pub fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("nauru-test-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    pub fn path(&self) -> PathBuf {
        self.0.clone()
    }
}

impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The demo-shaped world at business date 2026-10-08.
pub struct W {
    pub tmp: TmpDir,
    pub conn: Connection,
    pub today: Date,

    pub annual: i64,
    pub sick: i64,
    pub family: i64,
    pub unpaid: i64,
    /// Type with `carryover_expiry_months=3` for period-close tests.
    pub carry: i64,

    pub chr: i64,
    pub iu: i64,
    pub csu: i64,
    pub std_sched: i64,
    pub pt_sched: i64,

    // employees
    pub alexei: i64,
    pub olga: i64,
    pub tom: i64,
    pub lina: i64,
    pub sam: i64,
    pub rita: i64,
    pub ben: i64,
    pub nia: i64,
    pub maria: i64,
    pub elena: i64,
    pub david: i64,
    pub pavel: i64,
    pub grace: i64,

    // users
    pub u_alexei: i64,
    pub u_olga: i64,
    pub u_tom: i64,
    pub u_lina: i64,
    pub u_rita: i64,
    pub u_ben: i64,
    pub u_nia: i64,
    pub u_maria: i64,
    pub u_elena: i64,
    pub u_david: i64,
    pub u_pavel: i64,
    pub u_grace: i64,
}

const NOW: &str = "2025-01-02T09:00:00Z";

impl W {
    pub fn new() -> W {
        let tmp = TmpDir::new("world");
        let db_path = tmp.path().join("main.sqlite");
        let mut conn = db::open(&db_path).unwrap();
        db::migrate(&conn).unwrap();
        let c = &mut conn;

        // org units
        let chr = people::create_org_unit(c, "CHR", "Central HR Office (demo)", None).unwrap();
        let iu = people::create_org_unit(c, "IU", "Infrastructure Unit (demo)", None).unwrap();
        let csu = people::create_org_unit(c, "CSU", "Community Services Unit (demo)", None).unwrap();

        // schedules
        let (std_sched, _) = people::create_schedule(
            c,
            "Standard Mon–Fri 8h",
            d("2025-01-01"),
            [480, 480, 480, 480, 480, 0, 0],
            None,
        )
        .unwrap();
        let (pt_sched, _) = people::create_schedule(
            c,
            "Part-time Mon–Thu 6h",
            d("2025-01-01"),
            [360, 360, 360, 360, 0, 0, 0],
            None,
        )
        .unwrap();

        // holidays (same list as the demo template)
        for (date, name) in [
            ("2025-12-25", "Christmas Day"),
            ("2025-12-26", "Christmas holiday"),
            ("2026-01-01", "New Year's Day"),
            ("2026-01-31", "Independence Day"),
            ("2026-05-17", "Constitution Day"),
            ("2026-10-26", "Angam Day"),
            ("2026-12-25", "Christmas Day"),
            ("2026-12-28", "Christmas substitute (fictional)"),
            ("2027-01-01", "New Year's Day"),
        ] {
            people::create_calendar_exception(c, d(date), name, 0, None, NOW).unwrap();
        }

        // leave types + policies (valid from 2025)
        let annual =
            people::create_leave_type(c, "ANNUAL", "Annual leave", false, true, true, true, false, 5)
                .unwrap();
        let sick =
            people::create_leave_type(c, "SICK", "Sick leave", true, true, true, true, false, 0)
                .unwrap();
        let family = people::create_leave_type(
            c,
            "FAMILY",
            "Family responsibility leave",
            false,
            true,
            true,
            true,
            false,
            0,
        )
        .unwrap();
        let unpaid = people::create_leave_type(
            c,
            "UNPAID",
            "Unpaid leave",
            false,
            false,
            false,
            false,
            false,
            10,
        )
        .unwrap();
        let carry = people::create_leave_type(
            c,
            "CARRY",
            "Carryover with expiry (test)",
            false,
            true,
            true,
            true,
            false,
            0,
        )
        .unwrap();
        people::create_policy(c, annual, d("2025-01-01"), 9600, "annual_upfront", 3, true, None, false, "demo", "demo_fictional", None, NOW).unwrap();
        people::create_policy(c, sick, d("2025-01-01"), 4800, "annual_upfront", 3, false, None, false, "demo", "demo_fictional", None, NOW).unwrap();
        people::create_policy(c, family, d("2025-01-01"), 2400, "annual_upfront", 3, false, None, false, "demo", "demo_fictional", None, NOW).unwrap();
        people::create_policy(c, unpaid, d("2025-01-01"), 0, "none", 0, false, None, false, "demo", "demo_fictional", None, NOW).unwrap();
        people::create_policy(c, carry, d("2025-01-01"), 0, "none", 0, true, Some(3), false, "demo", "demo_fictional", None, NOW).unwrap();

        // people — managers created before their reports
        let mk = |sid: &str, name: &str, unit: i64, mgr: Option<i64>, sched: i64| -> (i64, i64) {
            let email = format!("{}@nauru.example", name.to_lowercase().replace(' ', "."));
            let u = people::create_user(c, &email, name, None, NOW).unwrap();
            let e = people::create_employee(
                c,
                sid,
                name,
                Some(&email),
                Some(u),
                d("2020-01-01"),
                unit,
                mgr,
                sched,
                d("2020-01-01"),
                NOW,
            )
            .unwrap();
            (e, u)
        };
        let (elena, u_elena) = mk("NPS-0002", "Elena Ward", chr, None, std_sched);
        let (maria, u_maria) = mk("NPS-0001", "Maria Santos", chr, Some(elena), std_sched);
        let (david, u_david) = mk("NPS-0003", "David Hale", chr, Some(elena), std_sched);
        let (pavel, u_pavel) = mk("NPS-0004", "Pavel Grant", chr, Some(elena), std_sched);
        let (grace, u_grace) = mk("NPS-0005", "Grace Lin", chr, Some(elena), std_sched);
        let (olga, u_olga) = mk("NPS-1002", "Olga Berg", iu, Some(elena), std_sched);
        let (rita, u_rita) = mk("NPS-2001", "Rita Moss", csu, Some(elena), std_sched);
        let (alexei, u_alexei) = mk("NPS-1001", "Alexei Novak", iu, Some(olga), std_sched);
        let (tom, u_tom) = mk("NPS-1003", "Tom Reed", iu, Some(olga), std_sched);
        let (lina, u_lina) = mk("NPS-1004", "Lina Cole", iu, Some(olga), pt_sched);
        let (ben, u_ben) = mk("NPS-2002", "Ben Carter", csu, Some(rita), std_sched);
        let (nia, u_nia) = mk("NPS-2003", "Nia Fox", csu, Some(rita), std_sched);
        let sam = people::create_employee(
            c,
            "NPS-1005",
            "Sam Oduya",
            Some("sam.oduya@unreachable.demo"),
            None,
            d("2020-01-01"),
            iu,
            Some(olga),
            std_sched,
            d("2020-01-01"),
            NOW,
        )
        .unwrap();

        // roles (scope NULL = all units)
        for (u, role) in [
            (u_maria, "hr"),
            (u_maria, "hr_medical"),
            (u_elena, "final_approver"),
            (u_david, "hr"),
            (u_david, "adjustment_approver"),
            (u_pavel, "tech_admin"),
            (u_grace, "auditor"),
        ] {
            people::grant_role(c, u, role, None, d("2025-01-01"), None, None, NOW).unwrap();
        }

        // opening balances for 2026 + Tom's carryover year 2025
        for e in [alexei, olga, tom, lina, sam, rita, ben, nia, maria, elena, david, pavel, grace] {
            ledger::post_opening(c, e, annual, 2026, 9600, d("2026-01-01"), "Opening 2026", Some(u_maria), "2026-01-01T09:00:00Z").unwrap();
            ledger::post_opening(c, e, sick, 2026, 4800, d("2026-01-01"), "Opening 2026", Some(u_maria), "2026-01-01T09:00:00Z").unwrap();
            ledger::post_opening(c, e, family, 2026, 2400, d("2026-01-01"), "Opening 2026", Some(u_maria), "2026-01-01T09:00:00Z").unwrap();
        }
        ledger::post_opening(c, tom, annual, 2025, 9600, d("2025-01-01"), "Opening 2025", Some(u_maria), "2025-01-01T09:00:00Z").unwrap();

        let today = d("2026-10-08");
        c.execute(
            "INSERT INTO settings(key, value) VALUES ('demo_today', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![model::date_s(&today)],
        )
        .unwrap();
        c.execute(
            "INSERT INTO settings(key, value) VALUES ('mode', 'demo')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [],
        )
        .unwrap();

        W {
            tmp,
            conn,
            today,
            annual,
            sick,
            family,
            unpaid,
            carry,
            chr,
            iu,
            csu,
            std_sched,
            pt_sched,
            alexei,
            olga,
            tom,
            lina,
            sam,
            rita,
            ben,
            nia,
            maria,
            elena,
            david,
            pavel,
            grace,
            u_alexei,
            u_olga,
            u_tom,
            u_lina,
            u_rita,
            u_ben,
            u_nia,
            u_maria,
            u_elena,
            u_david,
            u_pavel,
            u_grace,
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.tmp.path().join("main.sqlite")
    }

    pub fn files_dir(&self) -> PathBuf {
        self.tmp.path().join("files")
    }

    pub fn store(&self) -> FileStore {
        FileStore::new(self.files_dir()).unwrap()
    }

    pub fn clock(&self) -> Clock {
        Clock::demo()
    }

    pub fn set_today(&mut self, s: &str) {
        self.today = d(s);
        self.conn
            .execute(
                "INSERT INTO settings(key, value) VALUES ('demo_today', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![s],
            )
            .unwrap();
    }

    pub fn actor(&self, user_id: i64) -> Actor {
        Actor::load(&self.conn, user_id, self.today).unwrap()
    }

    pub fn req(&self, id: i64) -> model::LeaveRequest {
        model::load_request(&self.conn, id).unwrap()
    }

    /// draft input for an own leave request
    pub fn input(&self, lt: i64, start: &str, end: &str) -> DraftInput {
        DraftInput {
            employee_id: None,
            leave_type_id: lt,
            start_date: d(start),
            end_date: d(end),
            start_part: Part::Full,
            end_part: Part::Full,
            note: Some("please".into()),
            paper: false,
            paper_received_date: None,
            previous_request_id: None,
        }
    }

    /// create + submit an own leave request; returns the request id.
    pub fn submit_leave(&mut self, user: i64, lt: i64, start: &str, end: &str) -> i64 {
        self.submit_leave_parts(user, lt, start, end, Part::Full, Part::Full)
    }

    pub fn submit_leave_parts(
        &mut self,
        user: i64,
        lt: i64,
        start: &str,
        end: &str,
        sp: Part,
        ep: Part,
    ) -> i64 {
        let clock = self.clock();
        let actor = self.actor(user);
        let mut input = self.input(lt, start, end);
        input.start_part = sp;
        input.end_part = ep;
        let id = requests::create_draft(&mut self.conn, &clock, &actor, &input).unwrap();
        requests::submit(&mut self.conn, &clock, &actor, id, 1, None).unwrap();
        id
    }

    /// The request's currently pending approval step.
    pub fn pending(&self, req_id: i64) -> Step {
        requests::pending_step(&self.conn, req_id)
            .unwrap()
            .expect("no pending step")
    }

    /// Decide the pending step as `user`.
    pub fn decide_pending(&mut self, user: i64, req_id: i64, outcome: &str, reason: Option<&str>) {
        let step = self.pending(req_id);
        let v = self.req(req_id).version;
        let clock = self.clock();
        let actor = self.actor(user);
        requests::decide(
            &mut self.conn,
            &clock,
            &actor,
            req_id,
            step.id,
            outcome,
            reason,
            None,
            v,
            None,
        )
        .unwrap();
    }

    /// Drive a request through the whole 3-step route to `approve`.
    /// `manager_user` decides step 1 (assignee or current manager).
    pub fn approve_all(&mut self, req_id: i64) {
        for _ in 0..3 {
            let req = self.req(req_id);
            if !req.status.is_open() {
                return;
            }
            let Some(step) = requests::pending_step(&self.conn, req_id).unwrap() else {
                return;
            };
            let who = match step.kind {
                model::StepKind::ManagerRecommendation => step.assignee_user_id.unwrap(),
                model::StepKind::HrCheck => self.u_maria,
                model::StepKind::FinalDecision => self.u_elena,
            };
            let outcome = match step.kind {
                model::StepKind::ManagerRecommendation => "recommend_approve",
                model::StepKind::HrCheck => "checked_ok",
                model::StepKind::FinalDecision => "approve",
            };
            self.decide_pending(who, req_id, outcome, None);
        }
    }

    /// (ledger, reserved, available) totals for an employee+type.
    pub fn totals(&self, emp: i64, lt: i64) -> (i64, i64, i64) {
        ledger::totals(&self.conn, emp, lt, self.today).unwrap()
    }

    /// Active reservation rows (account_id, minutes) of a request.
    pub fn reservations(&self, req_id: i64) -> Vec<(i64, i64)> {
        let mut st = self
            .conn
            .prepare("SELECT account_id, minutes FROM reservations WHERE request_id=?1 AND active=1")
            .unwrap();
        st.query_map([req_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// Account id for (employee, type, year).
    pub fn account(&self, emp: i64, lt: i64, year: i64) -> i64 {
        ledger::ensure_account(&self.conn, emp, lt, year).unwrap()
    }

    pub fn account_of(&self, emp: i64, lt: i64, year: i64) -> Option<i64> {
        self.conn
            .query_row(
                "SELECT id FROM leave_accounts WHERE employee_id=?1 AND leave_type_id=?2 AND period_year=?3",
                params![emp, lt, year],
                |r| r.get(0),
            )
            .ok()
    }

    /// Per-year available on one leave type: Vec<(year, ledger, reserved, available)>.
    pub fn by_year(&self, emp: i64, lt: i64) -> Vec<(i64, i64, i64, i64)> {
        ledger::balance_summary(&self.conn, emp, lt, self.today)
            .unwrap()
            .into_iter()
            .map(|b| (b.period_year, b.ledger_minutes, b.reserved_minutes, b.available_minutes))
            .collect()
    }

    pub fn revise(&self, lt: i64, start: &str, end: &str, reason: &str) -> ReviseInput {
        ReviseInput {
            leave_type_id: lt,
            start_date: d(start),
            end_date: d(end),
            start_part: Part::Full,
            end_part: Part::Full,
            note: None,
            change_reason: reason.into(),
        }
    }
}
