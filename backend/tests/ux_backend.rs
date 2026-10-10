mod b_http_support;
use axum::http::StatusCode;
use b_http_support::{Client, Fixture};
use nauru_leave::{clock::Mode, db, ledger, model, people, sessions};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn connection(f: &Fixture, c: &Client) -> Connection {
    db::open(
        &f.dir
            .join("sandboxes")
            .join(format!("{}-g1.sqlite", c.cookies["nld_sbx"])),
    )
    .unwrap()
}
async fn hr() -> (Fixture, Client) {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Maria Santos").await;
    (f, c)
}
async fn preview(c: &mut Client, kind: &str, csv: &str) -> Value {
    let fields = if kind == "historical_leave" {
        vec![("kind", kind), ("mode", "already_in_opening")]
    } else {
        vec![("kind", kind)]
    };
    let (status, result) = c
        .upload(
            "/api/imports/preview",
            "balances.csv",
            csv.as_bytes(),
            &fields,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result
}
async fn commit(c: &mut Client, p: &Value) -> Value {
    c.ok(
        "POST",
        &format!("/api/imports/{}/commit", p["batch_id"]),
        json!({}),
    )
    .await
}

#[tokio::test]
async fn plain_days_name_half_day_and_part_time_post_integer_minutes() {
    let (f, mut c) = hr().await;
    let p = preview(&mut c, "opening_balances", "staff_number,leave_type,year,days,basis\nNPS-1001,  aNnUaL LeAvE  ,2027,12.5,Opening sheet\nNPS-1004,annual,2027,12.5,Opening sheet\nNPS-1002,Annual leave,2027,12,Opening sheet\n").await;
    assert_eq!(p["rows_valid"], 3);
    assert_eq!(p["rows"][0]["data"]["minutes"], 6000);
    assert_eq!(p["rows"][1]["data"]["minutes"], 4500);
    assert_eq!(commit(&mut c, &p).await["applied"], 3);
    let conn = connection(&f, &c);
    let amounts: Vec<i64> = conn.prepare("SELECT le.minutes FROM ledger_entries le JOIN leave_accounts ac ON ac.id=le.account_id WHERE ac.period_year=2027 AND le.kind='opening' ORDER BY le.minutes").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(amounts, vec![4500, 5760, 6000]);
}

#[tokio::test]
async fn bad_days_and_unknown_staff_are_row_errors() {
    let (_f, mut c) = hr().await;
    for bad in [
        "12.25",
        "-1",
        "abc",
        "",
        "NaN",
        "1e2",
        "9223372036854775808",
        "12.",
    ] {
        let p = preview(
            &mut c,
            "opening_balances",
            &format!("staff_number,leave_type,year,days\nNPS-1001,Annual leave,2027,{bad}\n"),
        )
        .await;
        assert_eq!(p["rows_valid"], 0, "{p}");
        assert!(
            p["rows"][0]["errors"]
                .to_string()
                .contains("Days must be a number like 12 or 12.5"),
            "{p}"
        );
    }
    let p = preview(
        &mut c,
        "opening_balances",
        "staff_number,leave_type,year,days\nNPS-9999,Annual leave,2027,12\n",
    )
    .await;
    assert_eq!(p["rows"][0]["errors"][0], "Unknown staff number NPS-9999");
    for columns in ["minutes,days", "basis"] {
        let amounts = if columns == "basis" { "sheet" } else { "480,1" };
        let p = preview(
            &mut c,
            "opening_balances",
            &format!(
                "staff_number,leave_type,year,{columns}\nNPS-1001,Annual leave,2027,{amounts}\n"
            ),
        )
        .await;
        assert_eq!(
            p["rows"][0]["errors"][0],
            "Use exactly one of the minutes or days columns"
        );
    }
}

#[tokio::test]
async fn legacy_headers_and_staff_alias_on_people_and_history_work() {
    let (_f, mut c) = hr().await;
    let p = preview(
        &mut c,
        "opening_balances",
        "service_id,leave_type,period_year,minutes,basis\nNPS-1001,ANNUAL,2027,6000,Legacy\n",
    )
    .await;
    assert_eq!(p["rows_valid"], 1);
    assert_eq!(commit(&mut c, &p).await["applied"], 1);
    let p = preview(&mut c, "employees", "staff_number,full_name,start_date,org_unit,schedule\nNPS-3001,Kim Tao,2026-01-01,IU,Standard Mon–Fri 8h\n").await;
    assert_eq!(p["rows_valid"], 1, "{p}");
    assert_eq!(commit(&mut c, &p).await["applied"], 1);
    let p = preview(
        &mut c,
        "historical_leave",
        "staff_number,leave_type,start_date,end_date\nNPS-3001,ANNUAL,2026-03-02,2026-03-03\n",
    )
    .await;
    assert_eq!(p["rows_valid"], 1, "{p}");
    assert_eq!(commit(&mut c, &p).await["applied"], 1);
}

fn snapshot(conn: &Connection) -> Vec<(String, i64)> {
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    tables
        .into_iter()
        .map(|table| {
            let n = conn
                .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
                    r.get(0)
                })
                .unwrap();
            (table, n)
        })
        .collect()
}

#[tokio::test]
async fn accrual_preview_route_is_read_only_and_requires_service_hr() {
    let (f, mut c) = hr().await;
    let conn = connection(&f, &c);
    let before = snapshot(&conn);
    let granted = c.ok("GET", "/api/accruals/preview?leave_type_id=1&period_year=2026", json!({})).await;
    assert_eq!((granted["eligible"].as_u64(), granted["skipped_existing"].as_u64()), (Some(0), Some(13)));
    let next = c.ok("GET", "/api/accruals/preview?leave_type_id=1&period_year=2027", json!({})).await;
    assert_eq!(next["eligible"], 13);
    assert_eq!(next["entitlement_minutes"], 9600);
    assert_eq!(before, snapshot(&conn));
    c.login("Alexei Novak").await;
    assert_eq!(c.call("GET", "/api/accruals/preview?leave_type_id=1&period_year=2027", json!({})).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn close_preview_matches_commit_writes_nothing_and_detects_closed() {
    let (f, mut c) = hr().await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2027-01-02"}))
        .await;
    let conn = connection(&f, &c);
    // Full-time / part-time, capped / no carry-over / expired / unlimited.
    for (type_id, allowed, expiry, limit) in [
        (1, true, None, Some(4800)),
        (2, false, None, None),
        (3, true, Some(0), Some(960)),
        (1, true, None, None),
    ] {
        conn.execute("UPDATE policy_versions SET carryover_allowed=?2,carryover_expiry_months=?3,carryover_limit_min=?4 WHERE leave_type_id=?1",params![type_id,allowed,expiry,limit]).unwrap();
        let before = snapshot(&conn);
        let version: i64 = conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        let path = format!("/api/periods/close?leave_type_id={type_id}&period_year=2026");
        let p = c.ok("GET", &path, json!({})).await;
        assert_eq!(snapshot(&conn), before);
        assert_eq!(
            conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            version
        );
        if type_id == 1 && limit.is_some() {
            let lina = p["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["service_id"] == "NPS-1004")
                .unwrap();
            assert_eq!(lina["minutes_per_day"], 360);
            assert_eq!(lina["carried_minutes"], 4800);
            assert_eq!(lina["left_minutes"], 6120);
            assert_eq!(lina["removed_minutes"], 1320);
        }
        let r = c
            .ok(
                "POST",
                "/api/periods/close",
                json!({"leave_type_id":type_id,"period_year":2026}),
            )
            .await;
        assert_eq!(r["items"], p["items"]);
        assert_eq!(r["already_closed"], p["already_closed"]);
        for row in p["items"].as_array().unwrap() {
            let after = ledger::balance_at(
                &conn,
                row["account_id"].as_i64().unwrap(),
                model::parse_date("2027-01-02").unwrap(),
            )
            .unwrap()
                - ledger::reserved(&conn, row["account_id"].as_i64().unwrap()).unwrap();
            assert_eq!(after.max(0), row["carried_minutes"].as_i64().unwrap());
        }
        assert_eq!(c.ok("GET", &path, json!({})).await["already_closed"], true);
    }
    // First close with zero accounts still has an audit fact; zero postings alone is not closure.
    let path = "/api/periods/close?leave_type_id=2&period_year=2025";
    assert_eq!(c.ok("GET", path, json!({})).await["already_closed"], false);
    assert_eq!(
        c.ok(
            "POST",
            "/api/periods/close",
            json!({"leave_type_id":2,"period_year":2025})
        )
        .await["posted"],
        0
    );
    assert_eq!(c.ok("GET", path, json!({})).await["already_closed"], true);
}

#[tokio::test]
async fn close_preview_obeys_close_authz_and_rejects_unfinished_year() {
    let (_f, mut c) = hr().await;
    assert_eq!(
        c.call(
            "GET",
            "/api/periods/close?leave_type_id=1&period_year=2026",
            json!({})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    c.login("Pavel Grant").await;
    assert_eq!(
        c.call(
            "GET",
            "/api/periods/close?leave_type_id=1&period_year=2025",
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    c.login("Alexei Novak").await;
    assert_eq!(
        c.call(
            "GET",
            "/api/periods/close?leave_type_id=1&period_year=2025",
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn notification_identity_only_for_visible_hr_rows_and_admin_address_unchanged() {
    let (f, mut c) = hr().await;
    let mut conn = connection(&f, &c);
    let today = model::parse_date("2026-10-08").unwrap();
    let unit: i64 = conn
        .query_row("SELECT id FROM org_units WHERE code='IU'", [], |r| r.get(0))
        .unwrap();
    let u = people::create_user(
        &conn,
        "unit.hr@example.test",
        "Unit HR",
        None,
        "2026-10-08T00:00:00Z",
    )
    .unwrap();
    people::grant_role(
        &conn,
        u,
        "hr",
        Some(unit),
        today,
        None,
        None,
        "2026-10-08T00:00:00Z",
    )
    .unwrap();
    let token = sessions::create(&mut conn, u, true, None).unwrap();
    c.csrf = Some(sessions::load(&conn, &token, true).unwrap().csrf_token);
    c.cookies.insert("nld_session".into(), token);
    let rows = c.ok("GET", "/api/ops/notifications", json!({})).await;
    let all_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))
        .unwrap();
    assert!(
        rows["total"].as_i64().unwrap() < all_count,
        "out-of-scope rows must be absent"
    );
    for row in rows["items"].as_array().unwrap() {
        assert_eq!(row["to_email"], "***@***");
        assert!(row.get("recipient_name").is_some());
        if let Some(id) = row["request_id"].as_i64() {
            let r = c.ok("GET", &format!("/api/requests/{id}"), json!({})).await;
            assert_eq!(row["request_number"], r["number"]);
        }
    }
    let sam = rows["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["recipient_name"] == "Sam Oduya")
        .unwrap();
    assert!(sam["request_number"].as_str().unwrap().starts_with("NLD-"));
    assert!(rows["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["recipient_name"] == "Olga Berg"));
    c.login("Pavel Grant").await;
    let admin = c
        .ok("GET", "/api/ops/notifications?limit=500", json!({}))
        .await;
    let admin_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))
        .unwrap();
    assert_eq!(admin["total"], admin_count);
    for n in admin["items"].as_array().unwrap() {
        let address: String = conn
            .query_row(
                "SELECT to_email FROM notifications WHERE id=?1",
                [n["id"].as_i64().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n["to_email"], address);
        assert!(n.get("body").is_none());
        assert!(n.get("recipient_user_id").is_none());
        assert!(n.get("link_path").is_none());
        assert!(n["request_id"].is_null());
    }
}

#[tokio::test]
async fn preview_tracks_grace_expiry_and_legacy_op_key_facts() {
    let (f, mut c) = hr().await;
    c.ok("POST", "/api/demo/clock", json!({"date":"2027-01-02"}))
        .await;
    let conn = connection(&f, &c);
    conn.execute("UPDATE policy_versions SET carryover_allowed=1,carryover_expiry_months=3,carryover_limit_min=960 WHERE leave_type_id=3", []).unwrap();
    let path = "/api/periods/close?leave_type_id=3&period_year=2026";
    let p = c.ok("GET", path, json!({})).await;
    assert_eq!(p["already_closed"], false);
    assert!(p["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["carried_minutes"] == 960));
    let r = c
        .ok(
            "POST",
            "/api/periods/close",
            json!({"leave_type_id":3,"period_year":2026}),
        )
        .await;
    assert_eq!(p["items"], r["items"]);
    // Existing ledger op_keys identify legacy closes even without period_closures.
    conn.execute("DELETE FROM period_closures WHERE account_id IN (SELECT id FROM leave_accounts WHERE leave_type_id=3 AND period_year=2026)", []).unwrap();
    assert_eq!(c.ok("GET", path, json!({})).await["already_closed"], true);
    c.ok("POST", "/api/demo/clock", json!({"date":"2027-04-01"}))
        .await;
    let p = c.ok("GET", path, json!({})).await;
    assert!(p["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["carried_minutes"] == 0 && row["removed_minutes"] == 960));
    let r = c
        .ok(
            "POST",
            "/api/periods/close",
            json!({"leave_type_id":3,"period_year":2026}),
        )
        .await;
    assert_eq!(p["items"], r["items"]);
    assert_eq!(r["posted"], p["items"].as_array().unwrap().len());
    assert_eq!(
        c.ok(
            "POST",
            "/api/periods/close",
            json!({"leave_type_id":3,"period_year":2026})
        )
        .await["posted"],
        0
    );
}
