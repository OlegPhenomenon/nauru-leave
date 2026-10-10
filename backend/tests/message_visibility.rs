mod b_http_support;

use axum::http::StatusCode;
use b_http_support::{Client, Fixture};
use nauru_leave::clock::Mode;
use serde_json::{json, Value};

async fn detail(c: &mut Client, id: i64) -> Value {
    c.ok("GET", &format!("/api/requests/{id}"), json!({})).await
}

fn bodies(d: &Value) -> Vec<&str> {
    d["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["body"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn sensitive_questions_and_replies_are_visible_only_to_their_asker_and_owner_or_hr() {
    let f = Fixture::new(Mode::Demo).await;
    let mut c = f.client();
    c.start().await;
    c.login("Alexei Novak").await;
    let types = c.ok("GET", "/api/leave-types", json!({})).await;
    let sick = types
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["code"] == "SICK")
        .unwrap()["id"]
        .clone();
    let draft = c.ok("POST", "/api/requests", json!({"leave_type_id":sick,"start_date":"2026-11-09","end_date":"2026-11-10","note":"Private leave reason"})).await;
    let id = draft["id"].as_i64().unwrap();
    c.ok(
        "POST",
        &format!("/api/requests/{id}/submit"),
        json!({"expected_version":draft["version"]}),
    )
    .await;
    c.ok(
        "POST",
        &format!("/api/requests/{id}/messages"),
        json!({"body":"Private employee comment"}),
    )
    .await;
    let (status, _) = c
        .upload(
            &format!("/api/requests/{id}/attachments"),
            "private.pdf",
            b"%PDF-1.4\nPrivate medical evidence",
            &[("sensitivity", "medical")],
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let olga = c.login("Olga Berg").await;
    let tom = c
        .ok("GET", "/api/demo/personas", json!({}))
        .await
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["display_name"] == "Tom Reed")
        .unwrap()["user_id"]
        .clone();
    c.ok("POST", "/api/delegations", json!({"from_user_id":olga["user"]["id"],"to_user_id":tom,"scope":"manager_recommendation","valid_from":"2026-10-08","valid_to":"2026-10-20","reason":"Coverage"})).await;
    let d = detail(&mut c, id).await;
    let command = json!({"expected_version":d["version"],"step_id":d["decidable_step"]["id"],"outcome":"needs_information","reason":"Which dates are confirmed?"});
    let (status, asked, _) = c
        .raw(
            "POST",
            &format!("/api/requests/{id}/decide"),
            command.to_string().into_bytes(),
            "application/json",
            Some("ask-private"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{asked}");
    assert_eq!(bodies(&asked), ["Which dates are confirmed?"]);
    c.ok(
        "POST",
        &format!("/api/requests/{id}/messages"),
        json!({"body":"Private manager comment"}),
    )
    .await;

    c.login("Tom Reed").await;
    assert!(bodies(&detail(&mut c, id).await).is_empty());
    c.login("Nia Fox").await;
    assert_eq!(
        c.call("GET", &format!("/api/requests/{id}"), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    c.login("Elena Ward").await;
    let d = detail(&mut c, id).await;
    assert!(bodies(&d).is_empty());
    assert!(d["current_revision"]["note"].is_null());
    assert!(d["decisions"][0]["reason"].is_null());
    assert_eq!(d["attachments"][0]["restricted"], true);

    c.login("Alexei Novak").await;
    let d = detail(&mut c, id).await;
    assert_eq!(
        bodies(&d),
        [
            "Private employee comment",
            "Which dates are confirmed?",
            "Private manager comment"
        ]
    );
    c.ok(
        "POST",
        &format!("/api/requests/{id}/respond"),
        json!({"expected_version":d["version"],"body":"Both dates are confirmed."}),
    )
    .await;
    c.login("Olga Berg").await;
    let d = detail(&mut c, id).await;
    assert_eq!(
        bodies(&d),
        ["Which dates are confirmed?", "Both dates are confirmed."]
    );
    assert!(d["current_revision"]["note"].is_null());
    assert!(d["decisions"][0]["reason"].is_null());
    assert_eq!(d["attachments"][0]["restricted"], true);
    let (status, replay, _) = c
        .raw(
            "POST",
            &format!("/api/requests/{id}/decide"),
            command.to_string().into_bytes(),
            "application/json",
            Some("ask-private"),
            true,
            Some("http://localhost"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bodies(&replay), ["Which dates are confirmed?"]); // saved receipt, no later answer added

    c.login("Tom Reed").await;
    let d = detail(&mut c, id).await;
    assert!(bodies(&d).is_empty());
    c.ok("POST", &format!("/api/requests/{id}/decide"), json!({"expected_version":d["version"],"step_id":d["decidable_step"]["id"],"outcome":"needs_information","reason":"Can you confirm again?"})).await;
    c.login("Alexei Novak").await;
    let d = detail(&mut c, id).await;
    c.ok(
        "POST",
        &format!("/api/requests/{id}/respond"),
        json!({"expected_version":d["version"],"body":"Confirmed again."}),
    )
    .await;
    c.login("Tom Reed").await;
    assert_eq!(
        bodies(&detail(&mut c, id).await),
        ["Can you confirm again?", "Confirmed again."]
    );
    c.login("Olga Berg").await;
    assert_eq!(
        bodies(&detail(&mut c, id).await),
        ["Which dates are confirmed?", "Both dates are confirmed."]
    );
    c.login("Maria Santos").await;
    assert_eq!(bodies(&detail(&mut c, id).await).len(), 6);
    c.login("Alexei Novak").await;
    assert_eq!(bodies(&detail(&mut c, id).await).len(), 6);
    let d = detail(&mut c, id).await;
    c.ok("POST", &format!("/api/requests/{id}/respond"), json!({"expected_version":d["version"],"body":"Please revise as annual leave.","changes":{"leave_type_id":1,"start_date":"2026-11-09","end_date":"2026-11-10","start_part":"full","end_part":"full","change_reason":"Reclassified as annual leave"}})).await;
    c.login("Olga Berg").await;
    let d = detail(&mut c, id).await;
    assert_eq!(d["leave_type_name"], "Annual leave");
    assert_eq!(
        bodies(&d),
        ["Which dates are confirmed?", "Both dates are confirmed."]
    );
}
