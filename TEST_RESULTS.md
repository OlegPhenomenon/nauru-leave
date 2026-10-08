# HTTP server verification report

The HTTP server is implemented across all documented endpoint families. The route inventory contains 72 API paths / 86 method-path pairs (seven demo-only paths), plus GET /up and embedded frontend routes. Domain request lifecycle changes remain deferred to the separate reviewer run requested by the user.

## Implemented behavior

- Bounded spawn_blocking database work, persistent sandbox registry, explicit creation/reset generations, TTL cleanup, rolling creation limits, per-IP request token buckets and file quotas.
- Password/Argon2 login, privileged-user and manager TOTP, lockout, rotating sessions, CSRF/origin checks, security headers and API no-store.
- Authorized request actions and projections, privacy filtering, current-permission checks on idempotency replay and attachment/export downloads.
- Multipart file validation and quarantine; atomic CSV import preview/commit with business-key and committed-hash idempotency; formula-safe reports/transfer exports.
- Settings/directory/adjustments/accrual/period closure, audit viewer, operations/retry endpoints, one background notification worker, demo mailbox and production SMTP with rustls.
- Embedded static frontend, SPA fallback, hashed-asset cache, missing-build fallback; serve/jobs/backup/restore CLI and Docker/Compose packaging.

## Automated tests

`cd backend && cargo test --locked --release` — **68 passed, 0 failed**, including 25 HTTP tests. Tests use real SQLite databases and actual domain functions; external SMTP delivery is exercised against a local SMTP server.

```text
Running unittests src/lib.rs (target/release/deps/nauru_leave-d4988cbc408e8947)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s
Running unittests src/main.rs (target/release/deps/nauru_leave-82bc2e864062e7ea)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
Running tests/authz_tests.rs (target/release/deps/authz_tests-64e66ad6d9724eb1)
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.17s
Running tests/http.rs (target/release/deps/http-8c1111fb15d3dfc3)
test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.07s
Running tests/idempotency.rs (target/release/deps/idempotency-dc9d7376b0ed83d2)
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s
Running tests/lifecycle.rs (target/release/deps/lifecycle-30ca0f9dabf7bd8b)
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.14s
Running tests/scenario.rs (target/release/deps/scenario-ad45df8164008261)
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.14s
Running tests/system.rs (target/release/deps/system-17c1821aa9102e9f)
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s
Doc-tests nauru_leave
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

HTTP coverage includes all requested named tests: sandbox_isolation, production_has_no_demo_routes, csrf_required, isolation_other_employee, medical_access, upload_checks, import_preview_errors, import_idempotent, csv_formula_safe, main_scenario_export, every_api_route_is_registered. Additional HTTP coverage checks TOTP/lockout/replay, scope revocation, restart/TTL/generations, caps and creation rates, SMTP outside transactions, notification markers, backups, settings/drift, stale versions, contract projections and atomic comment audit/outbox.

The A1 HTTP test verifies 20 → 20/5/15 → 15/0/15 → amendment approval 17/0/17 → business date 2026-11-12 / period_ended, exact Idempotency-Key replay, rejected key/body reuse, final transfer rows with effective revision and period year, mark-transferred and changes-since-export.

## Frontend and release builds

`cd frontend && npm ci && npm run build` — passed. No frontend source changes. Local npm reported a Node 23.10 engine warning for Vitest; the actual Vite build succeeded, and the Docker frontend build uses the required Node 22 image.

```text
vite v8.3.1
44 modules transformed
dist/index.html                   0.52 kB | gzip: 0.33 kB
dist/assets/index-C_kuVEqE.css   11.05 kB | gzip: 3.14 kB
dist/assets/index-C4yG5RHp.js   403.49 kB | gzip: 112.35 kB
```

`cd backend && cargo build --locked --release` — passed. Exactly one Cargo target directory, backend/target. Missing frontend/dist was temporarily tested: the release build succeeded and GET / served the short “Frontend not built” page. Restoring dist produces the embedded React frontend; build.rs watches its parent to detect reappearance even with preserved file timestamps.

- Local macOS release binary: **7,126,080 bytes** (6.80 MiB).
- Local idle RSS, measured with `ps -o rss= -p <pid>` after the demo walkthrough and worker interval: **6,496 KiB**.
- GET /up: 200 `ok`; static root, SPA deep link, immutable hashed asset cache and API no-store: passed.
- SIGTERM graceful shutdown: passed; verification server stopped.
- CLI gen-backup-key → backup using NLD_DATA_DIR/main.sqlite + files/main → restore --in to an empty directory: passed; restored requests and all referenced attachment SHA-256 values match. One seeded attachment restored.

## Docker and Compose

`docker build --progress plain --tag nauru-leave:http-local .` — passed with Node 22, Rust 1.98.0 and the prescribed Debian Bookworm runtime.

- Image: `sha256:6e2cde8aef3a1e948d58dd8f67a23d5fe3ee0365cfd9e00c30e39d9c3f9b0508`.
- Uncompressed image size (`docker image inspect .Size`): **118,580,596 bytes** (113.09 MiB); exceeds DESIGN's 40 MB target with the required Debian base.
- Linux release binary inside the image: **6,510,632 bytes** (6.21 MiB).
- Container idle RSS (`/proc/1/status`, VmRSS): **7,468 KiB**.
- Runtime user: `10001:10001`; memory limit: `268,435,456` bytes (256 MiB).
- `docker compose config --quiet` and `docker compose up -d --no-build`: passed; health became `healthy`, `/up` returned `ok`, and `/` served the built React HTML.
- Validation used an isolated Compose project, `.env.example` in place of a secret `.env`, and a free loopback port through a temporary override. The shipped Compose service, named volume, healthcheck, restart policy, and memory limit were exercised. `docker compose down --volumes` removed the verification service/network/volume.

## Live curl walkthrough

The release server ran on `52884` with a temporary data directory and matching NLD_PUBLIC_URL. Every following command returned HTTP 200. Cookie jar and Origin header were used; this disposable demo session has been stopped. Exact JSON values below are reformatted for readability.

```sh
BASE=http://127.0.0.1:52884
curl -sS "$BASE/api/config"
curl -sS -X POST -H "Origin: $BASE" -c cookies.txt "$BASE/api/demo/start"
curl -sS -b cookies.txt "$BASE/api/demo/personas"
curl -sS -X POST -H "Origin: $BASE" -H "Content-Type: application/json" -b cookies.txt -c cookies.txt --data '{"user_id":8}' "$BASE/api/demo/login"
curl -sS -b cookies.txt "$BASE/api/balances/me"
```

### GET /api/config

```json
{
  "app_version": "0.1.0",
  "business_date": "2026-10-08",
  "mode": "demo"
}
```

### POST /api/demo/start

```json
{
  "sandbox_id": "361525691f601c691ab69a27c77e528d"
}
```

### GET /api/demo/personas

```json
[
  {
    "display_name": "Alexei Novak",
    "roles": [],
    "story": "Submit leave, follow approvals, then amend it.",
    "title": "Employee — start here",
    "user_id": 8
  },
  {
    "display_name": "Olga Berg",
    "roles": [],
    "story": "Review your team's requests.",
    "title": "Manager",
    "user_id": 6
  },
  {
    "display_name": "Maria Santos",
    "roles": [
      "hr",
      "hr_medical"
    ],
    "story": "Check requests and inspect a medical file.",
    "title": "HR officer",
    "user_id": 2
  },
  {
    "display_name": "Elena Ward",
    "roles": [
      "final_approver"
    ],
    "story": "Record the final decision.",
    "title": "Final approver",
    "user_id": 1
  },
  {
    "display_name": "David Hale",
    "roles": [
      "hr",
      "adjustment_approver"
    ],
    "story": "Apply a correction proposed by another officer.",
    "title": "HR · second approver for adjustments",
    "user_id": 3
  },
  {
    "display_name": "Pavel Grant",
    "roles": [
      "tech_admin"
    ],
    "story": "Manage users and retry notifications.",
    "title": "Technical admin",
    "user_id": 4
  },
  {
    "display_name": "Grace Lin",
    "roles": [
      "auditor"
    ],
    "story": "Read the audit trail.",
    "title": "Auditor",
    "user_id": 5
  },
  {
    "display_name": "Nia Fox",
    "roles": [],
    "story": "Open your medical certificate.",
    "title": "Employee with a medical file",
    "user_id": 12
  },
  {
    "display_name": "Tom Reed",
    "roles": [],
    "story": "Try time travel and the delegation.",
    "title": "Employee, acting manager in December",
    "user_id": 9
  }
]
```

### POST /api/demo/login

```json
{
  "acting_for": [],
  "csrf_token": "31b02c06778e4bd6c5ffb03752b69e50fd1309b69a67305c6ca246b84973e4ab",
  "employee": {
    "full_name": "Alexei Novak",
    "id": 8,
    "org_unit": {
      "id": 2,
      "name": "Infrastructure Unit (demo)"
    },
    "service_id": "NPS-1001"
  },
  "is_manager": false,
  "roles": [],
  "totp_ok": true,
  "user": {
    "display_name": "Alexei Novak",
    "email": "alexei.novak@nauru.example",
    "id": 8
  }
}
```

### GET /api/balances/me

```json
[
  {
    "accounts": [
      {
        "account_id": 1,
        "available_minutes": 9600,
        "leave_type": {
          "code": "ANNUAL",
          "id": 1,
          "name": "Annual leave",
          "uses_balance": true
        },
        "ledger_minutes": 9600,
        "minutes_per_day": 480,
        "period_year": 2026,
        "reserved_minutes": 0
      }
    ],
    "approved_upcoming_minutes": 0,
    "available_minutes": 9600,
    "leave_type": {
      "code": "ANNUAL",
      "id": 1,
      "name": "Annual leave",
      "uses_balance": true
    },
    "ledger_minutes": 9600,
    "minutes_per_day": 480,
    "policy": {
      "accrual_mode": "annual_upfront",
      "advance_publish_months": 3,
      "allow_negative": false,
      "annual_entitlement_min": 9600,
      "carryover_allowed": true,
      "carryover_expiry_months": null,
      "explanation": "Fictional demo rule — not Nauru law. Must be confirmed by the responsible HR officer before real use.",
      "id": 1,
      "status": "demo_fictional",
      "valid_from": "2025-01-01"
    },
    "reserved_minutes": 0,
    "taken_minutes": 0
  },
  {
    "accounts": [
      {
        "account_id": 3,
        "available_minutes": 2400,
        "leave_type": {
          "code": "FAMILY",
          "id": 3,
          "name": "Family responsibility leave",
          "uses_balance": true
        },
        "ledger_minutes": 2400,
        "minutes_per_day": 480,
        "period_year": 2026,
        "reserved_minutes": 0
      }
    ],
    "approved_upcoming_minutes": 0,
    "available_minutes": 2400,
    "leave_type": {
      "code": "FAMILY",
      "id": 3,
      "name": "Family responsibility leave",
      "uses_balance": true
    },
    "ledger_minutes": 2400,
    "minutes_per_day": 480,
    "policy": {
      "accrual_mode": "annual_upfront",
      "advance_publish_months": 3,
      "allow_negative": false,
      "annual_entitlement_min": 2400,
      "carryover_allowed": false,
      "carryover_expiry_months": null,
      "explanation": "Fictional demo rule — not Nauru law. Must be confirmed by the responsible HR officer before real use.",
      "id": 3,
      "status": "demo_fictional",
      "valid_from": "2025-01-01"
    },
    "reserved_minutes": 0,
    "taken_minutes": 0
  },
  {
    "accounts": [
      {
        "account_id": 2,
        "available_minutes": 4800,
        "leave_type": {
          "code": "SICK",
          "id": 2,
          "name": "Sick leave",
          "uses_balance": true
        },
        "ledger_minutes": 4800,
        "minutes_per_day": 480,
        "period_year": 2026,
        "reserved_minutes": 0
      }
    ],
    "approved_upcoming_minutes": 0,
    "available_minutes": 4800,
    "leave_type": {
      "code": "SICK",
      "id": 2,
      "name": "Sick leave",
      "uses_balance": true
    },
    "ledger_minutes": 4800,
    "minutes_per_day": 480,
    "policy": {
      "accrual_mode": "annual_upfront",
      "advance_publish_months": 3,
      "allow_negative": false,
      "annual_entitlement_min": 4800,
      "carryover_allowed": false,
      "carryover_expiry_months": null,
      "explanation": "Fictional demo rule — not Nauru law. Must be confirmed by the responsible HR officer before real use.",
      "id": 2,
      "status": "demo_fictional",
      "valid_from": "2025-01-01"
    },
    "reserved_minutes": 0,
    "taken_minutes": 0
  },
  {
    "accounts": [],
    "approved_upcoming_minutes": 0,
    "available_minutes": 0,
    "leave_type": {
      "code": "UNPAID",
      "id": 4,
      "name": "Unpaid leave",
      "uses_balance": false
    },
    "ledger_minutes": 0,
    "minutes_per_day": 480,
    "policy": {
      "accrual_mode": "none",
      "advance_publish_months": 3,
      "allow_negative": false,
      "annual_entitlement_min": 0,
      "carryover_allowed": false,
      "carryover_expiry_months": null,
      "explanation": "Fictional demo rule — not Nauru law. Must be confirmed by the responsible HR officer before real use.",
      "id": 4,
      "status": "demo_fictional",
      "valid_from": "2025-01-01"
    },
    "reserved_minutes": 0,
    "taken_minutes": 0
  }
]
```

## Endpoint inventory

Paths below use axum `{id}` notation; API.md and the frontend use `:id` notation. Demo routes are registered only in demo mode. GET /up performs no database work.

| Method(s) | Path |
|---|---|
| GET | `/api/demo/status` |
| POST | `/api/demo/start` |
| POST | `/api/demo/reset` |
| GET | `/api/demo/personas` |
| POST | `/api/demo/login` |
| POST | `/api/demo/clock` |
| GET | `/api/demo/mailbox` |
| GET | `/api/config` |
| POST | `/api/auth/login` |
| POST | `/api/auth/totp` |
| POST | `/api/auth/logout` |
| GET | `/api/me` |
| GET, POST | `/api/leave-types` |
| GET | `/api/balances/me` |
| GET | `/api/balances/{employee_id}` |
| GET | `/api/balances/{employee_id}/explain` |
| GET | `/api/balances` |
| GET, POST | `/api/requests` |
| POST | `/api/requests/preview` |
| GET, PUT, DELETE | `/api/requests/{id}` |
| POST | `/api/requests/{id}/submit` |
| POST | `/api/requests/{id}/withdraw` |
| POST | `/api/requests/{id}/decide` |
| POST | `/api/requests/{id}/messages` |
| POST | `/api/requests/{id}/respond` |
| POST | `/api/requests/{id}/amend` |
| POST | `/api/requests/{id}/cancel` |
| POST | `/api/requests/{id}/reassign` |
| POST | `/api/requests/{id}/actual` |
| POST | `/api/requests/{id}/attachments` |
| GET | `/api/requests/{id}/card` |
| GET | `/api/attachments/{id}` |
| GET | `/api/approvals` |
| GET | `/api/calendar` |
| GET, POST | `/api/org-units` |
| PUT | `/api/org-units/{id}` |
| GET, POST | `/api/employees` |
| GET, PUT | `/api/employees/{id}` |
| POST | `/api/employees/{id}/transfer` |
| POST | `/api/employees/{id}/schedule` |
| GET, POST | `/api/adjustments` |
| POST | `/api/adjustments/{id}/decide` |
| POST | `/api/accruals/run` |
| POST | `/api/periods/close` |
| GET | `/api/reports/balances` |
| GET | `/api/reports/absences` |
| GET | `/api/reports/pending` |
| GET | `/api/reports/changes-since-export` |
| GET | `/api/reports/schedule-drift` |
| GET, POST | `/api/exports` |
| GET | `/api/exports/{id}/download` |
| POST | `/api/exports/{id}/mark-transferred` |
| GET | `/api/imports` |
| POST | `/api/imports/preview` |
| POST | `/api/imports/{id}/commit` |
| PUT | `/api/leave-types/{id}` |
| POST | `/api/leave-types/{id}/policies` |
| POST | `/api/policies/{id}/verify` |
| GET, POST | `/api/schedules` |
| GET, POST | `/api/schedules/{id}/versions` |
| GET, POST | `/api/calendar-exceptions` |
| DELETE | `/api/calendar-exceptions/{id}` |
| GET, POST | `/api/users` |
| PUT | `/api/users/{id}` |
| POST | `/api/users/{id}/roles` |
| DELETE | `/api/role-grants/{id}` |
| GET, POST | `/api/delegations` |
| POST | `/api/delegations/{id}/revoke` |
| GET | `/api/ops/notifications` |
| POST | `/api/ops/notifications/{id}/retry` |
| GET | `/api/ops/summary` |
| GET | `/api/audit` |

## Contract differences and open issues

See [API.md — Deviations and implementation clarifications](docs/API.md#deviations-and-implementation-clarifications) for bootstrap CSRF/origin handling, cookie flags, DELETE holiday paths, policy labels, report envelopes/totals, upload/import limits, scope restrictions, monthly accrual and CSP style attributes.

[OPEN_ISSUES.md](docs/OPEN_ISSUES.md) records production account/password/TOTP provisioning absent from the HTTP contract, the lack of versions on non-versioned API mutations, the required Debian image exceeding the 40 MB design target, unverified live SMTP-provider delivery, and the separately assigned request-domain review. No government-system integration, real SMS or government SSO was added.

No commits were made. No Kamal configuration or frontend source was edited. The pre-existing SECURITY.md was left untouched. Verification containers and their temporary Compose volume were removed.
