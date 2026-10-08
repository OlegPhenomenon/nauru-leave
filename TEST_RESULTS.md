# Test results

Run on 2026-10-08, macOS arm64, Rust 1.98.1, Node 23.10 (Docker build uses Node 22 and Rust 1.98.0).
Every item below was executed; output is pasted from the actual run. Items not executed are listed at the end.

## 1. Automated backend tests — `cd backend && cargo test`

All tests use real SQLite databases and the real domain functions (no mocks of business logic).

```text
     Running unittests src/lib.rs        test result: ok. 8 passed; 0 failed
     Running tests/authz_tests.rs        test result: ok. 7 passed; 0 failed
     Running tests/http.rs               test result: ok. 28 passed; 0 failed
     Running tests/idempotency.rs        test result: ok. 4 passed; 0 failed
     Running tests/lifecycle.rs          test result: ok. 10 passed; 0 failed
     Running tests/provisioning.rs       test result: ok. 2 passed; 0 failed
     Running tests/regressions.rs        test result: ok. 18 passed; 0 failed
     Running tests/scenario.rs           test result: ok. 9 passed; 0 failed
     Running tests/system.rs             test result: ok. 5 passed; 0 failed
```

Total **91 passed, 0 failed**. `cargo clippy --all-targets -- -D warnings`: clean.

### Acceptance checklist ([docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)) → tests

| ID | Check | Test(s) | Result |
|---|---|---|---|
| A1 | 20 → 15 (reserve 5) → 15 → amend → 17 → period ended, still 17 | `scenario::main_scenario`; browser: `e2e/main-scenario.spec.ts` | pass |
| A2 | Full history and transfer CSV with number + revision | `http::main_scenario_export` | pass |
| A3 | Second user has no access (request, lists, calendar, reports, exports, files) | `http::isolation_other_employee`, `scenario::isolation_other_employee` | pass |
| A4 | Backup → restore into a clean directory, same data and files | `system::backup_restore_roundtrip`; manual run §4 | pass |
| B1 | Idempotent submit / decide | `idempotency::idempotent_submit`, `idempotency::idempotent_decide` | pass |
| B2 | Two parallel requests for the last days | `scenario::concurrent_last_days` | pass |
| B3 | Year boundary split across accounts | `scenario::year_boundary_allocation`, `regressions::seed_builds` | pass |
| B4 | Insufficient balance blocked | `scenario::insufficient_blocks` | pass |
| B5 | Half day 240/480, weekends/holidays 0, part-time 360 | `scenario::half_day_and_holidays`, `scenario::part_time_schedule` | pass |
| B6 | Withdraw releases; partial cancel returns only cancelled days | `lifecycle::withdraw_releases`, `lifecycle::partial_cancel` | pass |
| B7 | Accrual / period close / import replays do not duplicate | `idempotency::accrual_idempotent`, `http::import_idempotent` | pass |
| B8 | Ledger and audit cannot be updated or deleted | `idempotency::ledger_immutable` | pass |
| B9 | Amendment reserves positive delta per account | `lifecycle::amendment_per_account_delta` | pass |
| C1 | No self-approval, including via delegation | `authz_tests::no_self_approval` | pass |
| C2 | Delegation only within its dates; real author kept | `authz_tests::delegation_window` | pass |
| C3 | Material change → new revision, route restarted, reservation recalculated | `lifecycle::revise_restarts_route`, `regressions::revise_tight_balance` | pass |
| C4 | Stale `expected_version` → 409 | `lifecycle::stale_version` | pass |
| C5 | Unassigned step visible to HR, not skipped | `lifecycle::unassigned_step_visible` | pass |
| C6 | Transfer: old manager loses access | `authz_tests::transfer_access` | pass |
| C7 | Medical file access; colleagues see "Away" | `authz_tests::medical_access`, `http::medical_access` | pass |
| C8 | Technical admin cannot change balances or read files | `authz_tests::tech_admin_limits` | pass |
| C9 | Adjustment proposer ≠ approver | `authz_tests::adjustment_two_person` | pass |
| C10 | Overlaps blocked; am + pm allowed; am + pm + am blocked | `scenario::overlap_rules` | pass |
| D1 | CSV import preview reports every error kind | `http::import_preview_errors` | pass |
| D2 | CSV formula injection neutralised | `http::csv_formula_safe` | pass |
| D3 | Email failure does not roll back; retry/backoff/manual retry | `system::notification_retry` | pass |
| D4 | Wrong file type rejected; EICAR quarantined, not downloadable | `http::upload_checks`, `system::upload_checks` | pass |
| D5 | Emails carry no leave type or reasons | `system::email_minimal` | pass |
| E1 | Demo sandboxes isolated from each other | `http::sandbox_isolation` | pass |
| E2 | Demo-only endpoints absent in production | `http::production_has_no_demo_routes` | pass |
| E3 | Docker image builds and serves the UI | manual run §5 | pass |
| E4 | Mutation without CSRF token → 403 | `http::csrf_required` | pass |

`tests/regressions.rs` holds one regression test per finding of the independent code review (revision
self-competition, amendment overlap with its parent, am+pm+am overlap, draft deletion, HR self-escalation via step
reassignment, preview authorisation, scoped HR jobs, masking of amended sensitive types, carry-over expiry, past-date
changes, cancellation responses, auditor comments, medical uploader access, validation of amendments, stale
authorisation snapshot, rejection while information is requested, transfer scope).

## 2. Frontend — `cd frontend`

```text
npx tsc --noEmit        → no output (pass)
npm test                → 9 passed (duration formatting incl. ½ day and part-time 6 h days)
npm run build           → dist/assets/index-*.js 405 kB │ gzip: 112.9 kB
```

## 3. End-to-end in a real browser — `npm run e2e`

Against the release binary in demo mode (fresh data directory), headless Chromium:

```text
  ✓  1 e2e/main-scenario.spec.ts:59:1 › main scenario steps 1–5: balance, request, approval, amendment, time travel (24.1s)
  1 passed (24.7s)
```

The run asserts: 20 days and the "Fictional demo rule — not Nauru law" label; the 5-day / 40 h preview with route
and the named team-overlap warning; 15 days and a reservation after submit; 15 after approval by Olga → Maria →
Elena; 17 after the approved amendment; "Period ended" and still 17 after time travel to 12 Nov 2026.
Recorded walkthrough: [docs/media/demo-walkthrough.webm](docs/media/demo-walkthrough.webm).

Additionally walked through by the integration run (screenshots, not committed): print card, approved-absence CSV,
transfer export, Tom's "You don't have access" page, restricted medical document and "Away" in the calendar,
withdraw, cancellation, HR paper request for Sam, demo mailbox, failed email to `@unreachable.demo` and manual retry,
390 px phone layout of My leave and New request.

## 4. Self-installation (production mode) and restore on a clean directory

Executed with the release binary, `NLD_MODE=production`:

```text
$ nauru-leave init-production --data-dir /tmp/nld-prod
Production database ready: /tmp/nld-prod/main.sqlite
$ printf '…\n' | nauru-leave user create --email maria@example.org --name "Maria Santos" --role hr --role hr_medical --password-stdin
TOTP secret: <redacted>
$ nauru-leave serve            # NLD_SMTP_URL is mandatory: without it → "NLD_SMTP_URL is required in production"
POST /api/auth/login  → 200 {"needs_totp": true}
POST /api/auth/totp   → 200 roles: hr, hr_medical (whole service)
POST /api/auth/totp with the same code again → 403 "TOTP code already used"
GET  /api/demo/personas → 404 (demo routes not registered)
POST /api/org-units, /api/schedules, /api/employees → 200 (NPS-9001 created)
$ nauru-leave gen-backup-key --out key && nauru-leave backup … --out nld.backup
backup written: /tmp/nld.backup
$ nauru-leave restore --in nld.backup --key-file key --data-dir /tmp/nld-restore
restored into /tmp/nld-restore
serve on the restored directory → login with password + TOTP → GET /api/employees → [("NPS-9001", "Test Person")]
restore with a wrong key file → exit 1 "backup key file /dev/null must be exactly 32 bytes"
```

## 5. Docker image

```text
$ docker build -t nauru-leave:local .        → success (Node 22 → Rust 1.98.0 → debian:bookworm-slim, uid 10001)
image size: 119 MB
$ docker run -p 127.0.0.1:18095:8080 -e NLD_MODE=demo --memory 256m nauru-leave:local
GET /up          → ok
GET /api/config  → {"app_version":"0.1.0","business_date":"2026-10-08","mode":"demo"}
GET /            → <title>Nauru Leave Desk
VmRSS (idle)     → 7612 kB
```

Release binary: 7.1 MB. Idle RSS of the native binary: ~6.5 MB.

## Not executed

- Delivery through a real external SMTP provider (no credentials; SMTP transport is tested against a local SMTP
  server in `tests/http.rs`).
- A real antivirus engine (the demo detects only the EICAR test string, by design).
- Independent security assessment.
