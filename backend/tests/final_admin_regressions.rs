mod common;
use nauru_leave::{authz::Actor, clock::Clock, db, ledger, seed};
use rusqlite::Connection;

fn account_totals(conn: &Connection) -> Vec<(i64, i64)> {
    conn.prepare("SELECT account_id,SUM(minutes) FROM ledger_entries GROUP BY account_id ORDER BY account_id")
        .unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        .collect::<Result<_, _>>().unwrap()
}

#[test]
fn seeded_entitlements_replay_without_changing_any_balance() {
    let tmp = common::TmpDir::new("entitlement-replay");
    let mut conn = db::open(&tmp.path().join("main.sqlite")).unwrap();
    db::migrate(&conn).unwrap();
    seed::seed_template(&mut conn, &tmp.path().join("files")).unwrap();
    let today = common::d("2026-10-08");
    let clock = Clock::fixed(today);
    let hr: i64 = conn.query_row("SELECT id FROM users WHERE display_name='Maria Santos'", [], |r| r.get(0)).unwrap();
    let actor = Actor::load(&conn, hr, today).unwrap();
    let before = account_totals(&conn);
    let facts: i64 = conn.query_row("SELECT COUNT(*) FROM ledger_entries WHERE kind='accrual' AND op_key LIKE 'accrual:%:2026'", [], |r| r.get(0)).unwrap();
    assert_eq!(facts, 39);
    let opening: i64 = conn.query_row("SELECT COUNT(*) FROM ledger_entries WHERE kind='opening'", [], |r| r.get(0)).unwrap();
    assert_eq!(opening, 1);
    for code in ["ANNUAL", "SICK", "FAMILY"] {
        let lt: i64 = conn.query_row("SELECT id FROM leave_types WHERE code=?1", [code], |r| r.get(0)).unwrap();
        let accounts_before: i64 = conn.query_row("SELECT COUNT(*) FROM leave_accounts", [], |r| r.get(0)).unwrap();
        let preview = ledger::preview_accrual(&conn, &actor, lt, 2026, None).unwrap();
        assert_eq!((preview.eligible, preview.skipped_existing), (0, 13));
        let next = ledger::preview_accrual(&conn, &actor, lt, 2027, None).unwrap();
        assert_eq!((next.eligible, next.skipped_existing), (13, 0));
        assert_eq!(accounts_before, conn.query_row("SELECT COUNT(*) FROM leave_accounts", [], |r| r.get::<_,i64>(0)).unwrap());
        let run = ledger::run_accrual(&mut conn, &clock, &actor, lt, 2026, None).unwrap();
        assert_eq!((run.posted, run.skipped_existing), (0, 13));
    }
    assert_eq!(before, account_totals(&conn));
    let lina: i64 = conn.query_row("SELECT SUM(l.minutes) FROM ledger_entries l JOIN leave_accounts a ON a.id=l.account_id JOIN employees e ON e.id=a.employee_id JOIN leave_types t ON t.id=a.leave_type_id WHERE e.service_id='NPS-1004' AND t.code='ANNUAL'", [], |r| r.get(0)).unwrap();
    assert_eq!(lina, 7200);
    let alexei: i64 = conn.query_row("SELECT SUM(l.minutes) FROM ledger_entries l JOIN leave_accounts a ON a.id=l.account_id JOIN employees e ON e.id=a.employee_id JOIN leave_types t ON t.id=a.leave_type_id WHERE e.service_id='NPS-1001' AND t.code='ANNUAL'", [], |r| r.get(0)).unwrap();
    assert_eq!(alexei, 9600);
    let employee: i64 = conn.query_row("SELECT id FROM users WHERE display_name='Alexei Novak'", [], |r| r.get(0)).unwrap();
    let employee_actor = Actor::load(&conn, employee, today).unwrap();
    let annual: i64 = conn.query_row("SELECT id FROM leave_types WHERE code='ANNUAL'", [], |r| r.get(0)).unwrap();
    assert!(ledger::preview_accrual(&conn, &employee_actor, annual, 2027, None).is_err());
    let run = ledger::run_accrual(&mut conn, &clock, &actor, annual, 2027, None).unwrap();
    assert_eq!((run.posted, run.skipped_existing), (13, 0));
    let preview = ledger::preview_accrual(&conn, &actor, annual, 2027, None).unwrap();
    assert_eq!((preview.eligible, preview.skipped_existing), (0, 13));
    let import = nauru_leave::imports_exports::import_preview(&mut conn, &clock, &actor, "opening_balances", None, "opening.csv", b"service_id,leave_type,period_year,minutes\nNPS-1001,ANNUAL,2026,480\n").unwrap();
    assert_eq!(import.rows_valid, 0);
}
