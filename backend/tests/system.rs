//! ACCEPTANCE A4/D3/D4/D5 + E-demo — notifications with retry/backoff,
//! minimal email content, upload checks, encrypted backup round-trip, and
//! the demo seed template.

mod common;

use common::W;
use nauru_leave::files::EICAR;
use nauru_leave::model;
use nauru_leave::notify::{self, MailboxTransport};
use nauru_leave::requests;
use nauru_leave::{backup, db, seed};
use rusqlite::params;
use time::OffsetDateTime;

fn notification_for(w: &W, email_substr: &str) -> (i64, String, i64, Option<String>) {
    w.conn
        .query_row(
            "SELECT id, status, attempts, next_attempt_at FROM notifications
             WHERE to_email LIKE ?1 ORDER BY id LIMIT 1",
            params![format!("%{email_substr}%")],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
}

/// D3 — a failing recipient does not roll the action back; retries follow
/// the 1/5/25-minute backoff and give up after 5 attempts; manual retry
/// re-queues.
#[test]
fn notification_retry() {
    let mut w = W::new();
    let clock = w.clock();
    let maria = w.actor(w.u_maria);
    // paper request for Sam (sam.oduya@unreachable.demo) -> notification fails
    let input = requests::DraftInput {
        employee_id: Some(w.sam),
        leave_type_id: w.annual,
        start_date: common::d("2026-10-20"),
        end_date: common::d("2026-10-21"),
        start_part: model::Part::Full,
        end_part: model::Part::Full,
        note: Some("paper".into()),
        paper: true,
        paper_received_date: Some(common::d("2026-10-05")),
        previous_request_id: None,
    };
    let id = requests::create_draft(&mut w.conn, &clock, &maria, &input).unwrap();
    requests::submit(&mut w.conn, &clock, &maria, id, 1, None).unwrap();
    // the submit succeeded even though the address is unreachable
    assert_eq!(w.req(id).status, model::RequestStatus::Submitted);

    // schedule is recorded in real UTC; follow it exactly
    let (nid, status, attempts, next) = notification_for(&w, "unreachable");
    assert_eq!(status, "queued");
    assert_eq!(attempts, 0);
    let t0 = OffsetDateTime::parse(
        &next.expect("queued notification has next_attempt_at"),
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();

    let attempted = notify::deliver_due(&mut w.conn, &MailboxTransport, t0).unwrap();
    assert!(attempted >= 1);
    let (_, status, attempts, _) = notification_for(&w, "unreachable");
    assert_eq!((status.as_str(), attempts), ("failed", 1));

    // not due yet (next attempt in +1 min)
    let n = notify::deliver_due(
        &mut w.conn,
        &MailboxTransport,
        t0 + time::Duration::seconds(30),
    )
    .unwrap();
    assert_eq!(n, 0);
    // due at +1min -> attempts=2, next in +5
    notify::deliver_due(
        &mut w.conn,
        &MailboxTransport,
        t0 + time::Duration::minutes(2),
    )
    .unwrap();
    let (_, status, attempts, _) = notification_for(&w, "unreachable");
    assert_eq!((status.as_str(), attempts), ("failed", 2));
    // attempt 3 at +5min mark, then 4, then gave_up on the 5th
    notify::deliver_due(
        &mut w.conn,
        &MailboxTransport,
        t0 + time::Duration::minutes(8),
    )
    .unwrap();
    notify::deliver_due(
        &mut w.conn,
        &MailboxTransport,
        t0 + time::Duration::minutes(40),
    )
    .unwrap();
    notify::deliver_due(
        &mut w.conn,
        &MailboxTransport,
        t0 + time::Duration::minutes(80),
    )
    .unwrap();
    let (_, status, attempts, _) = notification_for(&w, "unreachable");
    assert_eq!((status.as_str(), attempts), ("gave_up", 5));

    // manual retry re-queues
    let pavel = w.actor(w.u_pavel);
    notify::retry(&mut w.conn, &clock, &pavel, nid).unwrap();
    let (_, status, attempts, _) = notification_for(&w, "unreachable");
    assert_eq!((status.as_str(), attempts), ("queued", 0));

    // a reachable recipient succeeds and lands in the mailbox
    let areq = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");
    let _ = areq;
    notify::deliver_due(&mut w.conn, &MailboxTransport, OffsetDateTime::now_utc()).unwrap();
    let delivered: i64 = w
        .conn
        .query_row(
            "SELECT COUNT(*) FROM notifications n JOIN mailbox m ON m.notification_id=n.id
             WHERE n.to_email='alexei.novak@nauru.example'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(delivered > 0);
}

/// D5 — notification text never carries the leave type or reasons.
#[test]
fn email_minimal() {
    let mut w = W::new();
    let clock = w.clock();
    let alexei = w.actor(w.u_alexei);
    let mut input = w.input(w.annual, "2026-11-09", "2026-11-10");
    input.note = Some("my secret reason".into());
    let id = requests::create_draft(&mut w.conn, &clock, &alexei, &input).unwrap();
    requests::submit(&mut w.conn, &clock, &alexei, id, 1, None).unwrap();
    let number = w.req(id).number.clone();

    let mut st = w
        .conn
        .prepare("SELECT subject, body, link_path FROM notifications WHERE link_path LIKE ?1")
        .unwrap();
    let rows: Vec<(String, String, String)> = st
        .query_map(params![format!("/requests/{id}%")], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(!rows.is_empty());
    for (subject, body, link) in rows {
        for text in [&subject, &body] {
            assert!(!text.contains("Annual"), "type leaked: {text}");
            assert!(!text.contains("ANNUAL"), "type leaked: {text}");
            assert!(!text.contains("secret reason"), "reason leaked: {text}");
            assert!(!text.contains("please"), "note leaked: {text}");
        }
        assert!(link.starts_with("/requests/"));
        assert!(subject.contains(&number) || body.contains(&number));
    }
}

/// D4 — wrong signatures rejected; EICAR lands quarantined and undownloadable.
#[test]
fn upload_checks() {
    let mut w = W::new();
    let clock = w.clock();
    let store = w.store();
    let alexei = w.actor(w.u_alexei);
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-10");

    // not a pdf/png/jpeg
    let err = requests::upload_attachment(
        &mut w.conn,
        &clock,
        &alexei,
        &store,
        req,
        "x.bin",
        b"garbage bytes",
        "normal",
    )
    .unwrap_err();
    assert_eq!(err.code(), "validation");

    // EICAR content inside a pdf-looking file -> quarantined
    let mut infected = b"%PDF-1.4\n".to_vec();
    infected.extend_from_slice(EICAR.as_bytes());
    let att = requests::upload_attachment(
        &mut w.conn,
        &clock,
        &alexei,
        &store,
        req,
        "bad.pdf",
        &infected,
        "normal",
    )
    .unwrap();
    let ctx = requests::attachment_ctx(&w.conn, att, w.today).unwrap();
    assert_eq!(ctx.scan_status, "quarantined");
    let err = nauru_leave::authz::can(
        &w.conn,
        &alexei,
        nauru_leave::authz::Action::DownloadAttachment,
        &nauru_leave::authz::Resource::Attachment(&ctx),
    )
    .unwrap_err();
    assert_eq!(err.code(), "forbidden");
}

/// A4 — encrypted backup restores a byte-identical domain state (requests,
/// balances, files) into a clean directory.
#[test]
fn backup_restore_roundtrip() {
    let mut w = W::new();
    let clock = w.clock();
    let store = w.store();
    let alexei = w.actor(w.u_alexei);
    let req = w.submit_leave(w.u_alexei, w.annual, "2026-11-09", "2026-11-13");
    w.approve_all(req);
    let att = requests::upload_attachment(
        &mut w.conn,
        &clock,
        &alexei,
        &store,
        req,
        "a.pdf",
        b"%PDF-1.4\nbody\n",
        "normal",
    )
    .unwrap();
    let file_key: String = w
        .conn
        .query_row(
            "SELECT storage_key FROM attachments WHERE id=?1",
            [att],
            |r| r.get(0),
        )
        .unwrap();
    let file_bytes = store.get(&file_key).unwrap();
    let totals_before = w.totals(w.alexei, w.annual);
    let n_requests: i64 = w
        .conn
        .query_row("SELECT COUNT(*) FROM leave_requests", [], |r| r.get(0))
        .unwrap();
    let n_ledger: i64 = w
        .conn
        .query_row("SELECT COUNT(*) FROM ledger_entries", [], |r| r.get(0))
        .unwrap();

    // backup (VACUUM INTO works alongside the open fixture connection in WAL)
    let key_path = w.tmp.path().join("backup.key");
    backup::gen_key(&key_path).unwrap();
    let key = backup::read_key(&key_path).unwrap();
    let out = w.tmp.path().join("backup.nlb");
    backup::backup(&w.db_path(), &w.files_dir(), &key, &out).unwrap();

    // restore into a clean directory and verify domain state
    let target = w.tmp.path().join("restored");
    backup::restore(&out, &key, &target).unwrap();
    let rconn = db::open(&target.join("main.sqlite")).unwrap();
    db::migrate(&rconn).unwrap();
    let n: i64 = rconn
        .query_row("SELECT COUNT(*) FROM leave_requests", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, n_requests);
    let nl: i64 = rconn
        .query_row("SELECT COUNT(*) FROM ledger_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(nl, n_ledger);
    let totals_after = nauru_leave::ledger::totals(&rconn, w.alexei, w.annual, w.today).unwrap();
    assert_eq!(totals_before, totals_after);
    // attachment file came back byte-identical
    let restored = std::fs::read(target.join("files").join(&file_key)).unwrap();
    assert_eq!(restored, file_bytes);

    // a wrong key refuses to decrypt
    let bad_key = [7u8; 32];
    let err = backup::restore(&out, &bad_key, &w.tmp.path().join("restored2")).unwrap_err();
    assert_eq!(err.code(), "validation");
}

/// E-demo — the seed template builds through the domain functions and leaves
/// Alexei with exactly 9600 available ANNUAL minutes on 2026-10-08.
#[test]
fn seed_builds() {
    let tmp = common::TmpDir::new("seed");
    let conn = db::open(&tmp.path().join("main.sqlite")).unwrap();
    db::migrate(&conn).unwrap();
    let mut conn = conn;
    seed::seed_template(&mut conn, &tmp.path().join("files")).unwrap();

    let today = common::d("2026-10-08");
    let demo_today: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key='demo_today'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(demo_today, "2026-10-08");

    let alexei: i64 = conn
        .query_row(
            "SELECT id FROM employees WHERE service_id='NPS-1001'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let annual: i64 = conn
        .query_row("SELECT id FROM leave_types WHERE code='ANNUAL'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let (ledger_m, _reserved, available) =
        nauru_leave::ledger::totals(&conn, alexei, annual, today).unwrap();
    assert_eq!(ledger_m, 9600);
    assert_eq!(available, 9600);

    let mut st = conn.prepare("SELECT a.period_year,SUM(ra.minutes) FROM revision_allocations ra JOIN leave_accounts a ON a.id=ra.account_id JOIN request_revisions rr ON rr.id=ra.revision_id JOIN leave_requests lr ON lr.effective_revision_id=rr.id JOIN employees e ON e.id=lr.employee_id WHERE e.service_id='NPS-1003' AND lr.status='approved' GROUP BY a.period_year ORDER BY a.period_year").unwrap();
    let split: Vec<(i64, i64)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(split, vec![(2025, 1440), (2026, 1920)]);

    // the medical attachment exists, is clean and stored on disk
    let (storage_key, sensitivity, scan): (String, String, String) = conn
        .query_row(
            "SELECT storage_key, sensitivity, scan_status FROM attachments LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(sensitivity, "medical");
    assert_eq!(scan, "clean");
    let bytes = std::fs::read(tmp.path().join("files").join(&storage_key)).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));

    // Sam's unreachable notification shows as failed/gave_up in the outbox
    let failed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notifications WHERE to_email LIKE '%unreachable.demo'
             AND status IN ('failed','gave_up')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(failed > 0);
}
