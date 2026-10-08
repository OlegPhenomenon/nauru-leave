mod common;
use common::TmpDir;
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
fn cli(dir: &Path, args: &[&str], password: Option<&str>) -> std::process::Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_nauru-leave"));
    cmd.env("NLD_MODE", "production")
        .env("NLD_DATA_DIR", dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    if let Some(p) = password {
        child.stdin.take().unwrap().write_all(p.as_bytes()).unwrap();
    }
    child.wait_with_output().unwrap()
}
fn ok(dir: &Path, args: &[&str], password: Option<&str>) -> String {
    let o = cli(dir, args, password);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap()
}
#[test]
fn operator_user_lifecycle_is_atomic_audited_and_secret_safe() {
    let tmp = TmpDir::new("provisioning");
    let dir = tmp.path();
    ok(
        &dir,
        &["init-production", "--data-dir", dir.to_str().unwrap()],
        None,
    );
    let conn = nauru_leave::db::open(&dir.join("main.sqlite")).unwrap();
    let unit = nauru_leave::people::create_org_unit(&conn, "IU", "IU", None).unwrap();
    let schedule = nauru_leave::people::create_schedule(
        &conn,
        "standard",
        common::d("2020-01-01"),
        [480; 7],
        None,
    )
    .unwrap()
    .0;
    nauru_leave::people::create_employee(
        &conn,
        "EMP-1",
        "Employee",
        Some("employee@example.test"),
        None,
        common::d("2020-01-01"),
        unit,
        None,
        schedule,
        common::d("2020-01-01"),
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    let created = ok(
        &dir,
        &[
            "user",
            "create",
            "--email",
            "operator@example.test",
            "--name",
            "Operator",
            "--employee-service-id",
            "EMP-1",
            "--role",
            "hr:IU",
            "--password-stdin",
        ],
        Some("long-test-password\n"),
    );
    assert_eq!(created.matches("TOTP secret:").count(), 1);
    assert!(created.contains("otpauth://"));
    let (uid, hash, secret): (i64, String, String) = conn
        .query_row("SELECT id,password_hash,totp_secret FROM users", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(!hash.contains("long-test-password"));
    let linked: i64 = conn
        .query_row(
            "SELECT user_id FROM employees WHERE service_id='EMP-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(linked, uid);
    let list = ok(&dir, &["user", "list"], None);
    assert!(list.contains("operator@example.test"));
    assert!(!list.contains(&hash));
    assert!(!list.contains(&secret));
    ok(
        &dir,
        &[
            "user",
            "grant-role",
            "--email",
            "operator@example.test",
            "--role",
            "final_approver:IU",
        ],
        None,
    );
    ok(
        &dir,
        &[
            "user",
            "revoke-role",
            "--email",
            "operator@example.test",
            "--role",
            "hr:IU",
        ],
        None,
    );
    let token = nauru_leave::sessions::create(
        &mut nauru_leave::db::open(&dir.join("main.sqlite")).unwrap(),
        uid,
        true,
        None,
    )
    .unwrap();
    ok(
        &dir,
        &[
            "user",
            "revoke-sessions",
            "--email",
            "operator@example.test",
        ],
        None,
    );
    assert!(nauru_leave::sessions::load(&conn, &token, true).is_err());
    ok(
        &dir,
        &[
            "user",
            "reset-password",
            "--email",
            "operator@example.test",
            "--password-stdin",
        ],
        Some("replacement-password\n"),
    );
    ok(
        &dir,
        &["user", "reset-totp", "--email", "operator@example.test"],
        None,
    );
    let updated: String = conn
        .query_row("SELECT totp_secret FROM users", [], |r| r.get(0))
        .unwrap();
    assert_ne!(secret, updated);
    let events: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM audit_events WHERE json_extract(details_json,'$.actor')='cli'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(events >= 7);
    let outbox: i64 = conn
        .query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))
        .unwrap();
    assert!(outbox >= 6);
    let short = cli(
        &dir,
        &[
            "user",
            "create",
            "--email",
            "short@example.test",
            "--name",
            "Short",
            "--password-stdin",
        ],
        Some("short\n"),
    );
    assert!(!short.status.success());
    let bad = cli(
        &dir,
        &[
            "user",
            "create",
            "--email",
            "bad@example.test",
            "--name",
            "Bad",
            "--role",
            "hr:UNKNOWN",
            "--password-stdin",
        ],
        Some("long-test-password\n"),
    );
    assert!(!bad.status.success());
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn production_init_refuses_demo_data_and_is_idempotent() {
    let tmp = TmpDir::new("init");
    let dir = tmp.path();
    let o = Command::new(env!("CARGO_BIN_EXE_nauru-leave"))
        .env("NLD_MODE", "demo")
        .args(["init-production", "--data-dir", dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert!(!dir.join("main.sqlite").exists());
    std::fs::write(dir.join("template.sqlite"), b"demo").unwrap();
    assert!(!cli(
        &dir,
        &["init-production", "--data-dir", dir.to_str().unwrap()],
        None
    )
    .status
    .success());
    std::fs::remove_file(dir.join("template.sqlite")).unwrap();
    for _ in 0..2 {
        ok(
            &dir,
            &["init-production", "--data-dir", dir.to_str().unwrap()],
            None,
        );
    }
    let conn = nauru_leave::db::open(&dir.join("main.sqlite")).unwrap();
    assert_eq!(nauru_leave::db::schema_version(&conn).unwrap(), 1);
    conn.execute("UPDATE settings SET value='demo' WHERE key='mode'", [])
        .unwrap();
    assert!(!cli(&dir, &["user", "list"], None).status.success());
}
