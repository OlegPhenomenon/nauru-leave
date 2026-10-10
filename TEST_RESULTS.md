# Test results

Backend results were recorded on 2026-10-09; frontend and browser results were refreshed on 2026-10-10. macOS arm64, Rust 1.98.1, Node 23.10 (the Docker build uses Node 22 and Rust 1.98.0).
Every result below comes from an actual run; the complete, unedited logs are in [`docs/test-logs/`](docs/test-logs/):

| Log | Command | Result |
|---|---|---|
| [cargo-test.log](docs/test-logs/cargo-test.log) | `cd backend && cargo test` | **156 passed, 0 failed** |
| [cargo-clippy.log](docs/test-logs/cargo-clippy.log) | `cargo clippy --all-targets -- -D warnings` | clean |
| [frontend.log](docs/test-logs/frontend.log) | `npx tsc --noEmit && npx vitest run && npx vite build` | tsc clean, **58 passed**, build OK |
| [e2e-playwright.log](docs/test-logs/e2e-playwright.log) | `E2E_BASE=… npx playwright test` against the release backend in demo mode, fresh sandboxes | **31 passed, 0 failed** |
| [release-build.log](docs/test-logs/release-build.log) | `touch build.rs && cargo build --release` after frontend build | release build OK |
| [n36-backup-restore.log](docs/test-logs/n36-backup-restore.log) | production install → backup → restore into an empty directory → continue the request | all checks as expected |

Backend suites: lib 8 · audit_fixes_a 25 · audit_fixes_b 12 · audit_round2 16 · authz_tests 7 · http 28 ·
idempotency 4 · lifecycle 10 · original_acceptance 3 · provisioning 2 · reaudit_regressions 9 · regressions 18 · scenario 9 · system 5.
All tests use real SQLite databases and the real domain code; HTTP tests go through the real axum router.

Browser specs (Playwright, headless Chromium, release binary in demo mode):
- `e2e/main-scenario.spec.ts` — 20 → 15 (5 reserved) → 15 → amend to 3 days → 17 → *Period ended*, still 17; then
  opens the **original** request and its print view and checks that the in-force dates (9–11 Nov, 3 days) are shown
  and the original 9–13 Nov range appears only as history.
- `e2e/new-scenario.spec.ts` — everything created through the UI, no seeded requests: new employee, new fictional
  leave type and policy, opening balance by CSV import, paper request 5 days, three decisions, amendment to 3 days,
  original request + print, a second request with an actual-period correction applied by a second person, team
  calendar, approved-absence report, transfer export, mark transferred, "changes since export".
- `e2e/audit-fixes.spec.ts`, `e2e/audit-round2.spec.ts` — monthly accrual through the UI, carry-over "never" vs
  "after 0 months", carry-over limit, delegated final decision and its revocation, technical-admin limits, loss of
  access after an HR grant is revoked, revoking a used holiday, a dropped response retried once, EICAR upload,
  leave-type/schedule edits with version checks, export scope.

- `e2e/reaudit.spec.ts` — three fresh sandboxes: first October monthly policy through Settings and Balances (October–December); pending/applied correction disables the same date and a forced second command cannot return more minutes; quarantined-only evidence blocks final approval, then a clean upload allows the same route to complete.

- `frontend/e2e/click-budget.spec.ts` — four tests measure thirteen task budgets and reject internal labels in visible body text. A fifth test checks employee/user context across People shortcuts, the shared import dialog and the Operations redirect. Measured click counts are printed in the browser log.
- `frontend/e2e/review-regressions.spec.ts` — five tests: amendment balance, returned days, child rows and partial-cancellation dates agree with the server; the manager's pending question and the answer; nav badges follow decisions; admin shortcuts within three clicks; year defaults; chronological absence rows; payroll file in three clicks.
- `F05 round2: actual correction confirms second approval and preserves adjustment identity` replaces the old display-ID test name in `audit-round2.spec.ts`: the UI confirmation uses plain wording, while the created adjustment ID and amount are verified through the real API. Existing lifecycle, permission, privacy, ledger and retry assertions remain covered through the redesigned controls.

L07 supporting-document notes: final approval uses the submitted revision's frozen requirement and checks clean-file presence independently of download authority. Router tests `r03_required_evidence_cannot_be_satisfied_only_by_quarantined_file`, `r03_pending_failed_quarantined_and_lost_clean_gate_frozen_rule` and `r03_failed_document_clean_replacement_parent_evidence_and_medical_privacy` cover pending, quarantined, scan-failed, lost-clean and replacement files, parent evidence and medical metadata/download denial. The UI explains the blocking requirement and disables final approval until a clean document exists.

Recorded walkthrough of the new-scenario spec: [docs/media/demo-walkthrough.webm](docs/media/demo-walkthrough.webm).

## Original acceptance checks N01–N38

| ID | Check | Evidence (test or log) | Result |
|---|---|---|---|
| N01 | 9–13 Nov, 480-minute days → 2400 min / 5 days | `scenario::main_scenario`; e2e main-scenario (preview "5 working days", real API confirms 2400 minutes) | PASS |
| N02 | Half day 240 / full 480; same morning blocked, other half allowed | `scenario::half_day_and_holidays`, `scenario::overlap_rules` (am+pm allowed, am+pm+am blocked) | PASS |
| N03 | A day off inside the range is not counted and explained | `scenario::half_day_and_holidays` (holiday → 0 with its name), `audit_fixes_a::f13_revoke_used_exception_keeps_frozen_days`; e2e F13 | PASS |
| N04 | Saturday 360, Sunday 0 | `original_acceptance::n04_saturday_360_sunday_0` | PASS |
| N05 | Bad dates and overlaps; amendment does not clash with its own leave | `scenario::overlap_rules`, `regressions::amend_and_revise_validate_type_range_and_attachment`, `regressions::amendment_revision_excludes_parent_and_own_delta` | PASS |
| N06 | Draft keeps 9600 available; submit → 9600 / 2400 / 7200 | `original_acceptance::n06_draft_does_not_reserve_submit_does` | PASS |
| N07 | Same idempotency key twice → one request, one reservation | `idempotency::idempotent_submit`, `http::stale_version_and_decision_replay`, `audit_fixes_b::f12_*` | PASS |
| N08 | Manager → HR → final; only the final decision approves | `scenario::main_scenario`, `scenario::step_outcomes_validated`; e2e main-scenario | PASS |
| N09 | Approval converts the reservation once; replay changes nothing | `scenario::main_scenario`, `idempotency::idempotent_decide` | PASS |
| N10 | Two parallel requests for the last days | `scenario::concurrent_last_days` (two threads, two connections) | PASS |
| N11 | Question, then a date change → new revision, route restarted | `lifecycle::revise_restarts_route`, `regressions::revise_tight_balance`, `lifecycle::respond_text_only` | PASS |
| N12 | No self-approval with any roles or delegation | `authz_tests::no_self_approval`, `audit_fixes_b::f08_http_delegates_have_only_current_step_access` | PASS |
| N13 | Delegation before / during / after / revoked | `authz_tests::delegation_window`, `audit_fixes_b::f08_*`; e2e F08 | PASS |
| N14 | Reject and withdraw release the reservation once | `lifecycle::reject_releases`, `lifecycle::withdraw_releases` | PASS |
| N15 | Shorten approved 5 → 3: 15 before, 17 after, old version kept | `scenario::main_scenario`, `audit_fixes_a::f01_in_force_revision_and_parent_are_visible`; e2e main- and new-scenario | PASS |
| N16 | Add 2 days to an approved 5: only 960 reserved; rejection keeps the original | `original_acceptance::n16_increase_reserves_only_delta_and_rejection_keeps_original` | PASS |
| N17 | Full future cancellation; past part only via HR correction | `lifecycle::full_cancel_closes_parent`, `lifecycle::partial_cancel`, `regressions::cancellation_approval_rechecks_past_days`, `regressions::past_amendment_requires_hr_correction`, `audit_fixes_a::f05_actual_worked_dates_return_original_accounts`, `reaudit_regressions::r02_*` (pending/applied/rejected, different dates, year boundary, split accounts, upgrade); e2e R02 | PASS |
| N18 | Time passes the end: period ended, no new deduction | `scenario::main_scenario`; e2e main-scenario | PASS |
| N19 | 30 Dec–5 Jan: 960 on 2026, 1440 on 2027 | `scenario::year_boundary_allocation`, `scenario::insufficient_blocks` | PASS |
| N20 | Monthly accrual of 600 run twice → one entry | `audit_fixes_a::f02_monthly_http_requires_month_and_preserves_fact`, `audit_fixes_a::f04_*`, `audit_round2::f04_*`, `idempotency::accrual_idempotent`; `reaudit_regressions::r01_first_october_policy_accrues_october_to_december_once`, Vitest `r01 selected accrual period` (five cases); e2e F02 and R01 | PASS |
| N21 | Carry-over with limit and expiry; close twice; old correction to the original account | `audit_fixes_a::g01_*`, `audit_round2::g01_*`, `audit_fixes_a::f03_*`, `regressions::close_period_preserves_reserved_and_later_consumed_minutes`; e2e G01, F03 | PASS |
| N22 | Schedule/holiday change does not silently recalculate; affected requests listed | `audit_fixes_a::f11_*`, `audit_fixes_a::f13_revoke_used_exception_keeps_frozen_days`, `http::settings_mutations_and_drift`; e2e F13 | PASS |
| N23 | +480 adjustment: self-approval blocked, second person applies once | `authz_tests::adjustment_two_person`, `audit_fixes_b::f12_parallel_adjustment_commands_are_one_intent`; `reaudit_regressions::r02_same_worked_day_cannot_refund_twice_with_new_commands`, `r02_year_boundary_and_parallel_proposals_reserve_original_minutes`, `r02_pending_rejected_different_days_and_manual_adjustments`, `r02_upgrade_recovers_day_links_and_apply_checks_legacy_duplicates`, `r02_split_account_rejection_leaves_only_the_uncorrected_part`; e2e F12 and R02 | PASS |
| N24 | Historical leave already in the opening balance is not deducted again | `imports_exports::tests::historical_modes` | PASS |
| N25 | Import preview errors; repeated import does not duplicate | `imports_exports::tests::import_preview_errors`, `imports_exports::tests::import_idempotent`, `http::import_preview_errors`, `http::import_idempotent` | PASS |
| N26 | Transfer and deactivation | `authz_tests::transfer_access`, `regressions::transfer_requires_target_scope_and_defers_future_reassign`, `audit_fixes_a::f06_absence_history_includes_inactive_employee_and_day_assignment`, `audit_fixes_b::f09_http_accounts_linking_and_independent_grants` (deactivation ends the session) | PASS |
| N27 | Someone else's request, file, export, search, report numbers | `http::isolation_other_employee`, `scenario::isolation_other_employee`, `regressions::scoped_staff_and_colleague_cannot_access_other_unit_files`, `http::scoped_hr_import_export_and_download_recheck` | PASS |
| N28 | Medical file only for the assigned people; never in the team calendar | `authz_tests::medical_access`, `http::medical_access`, `http::colleague_calendar_masks_sensitive_leave_as_away`, `regressions::medical_uploader_needs_medical_role`, `audit_fixes_a::f11_sensitive_snapshot_does_not_unmask_old_material` | PASS |
| N29 | Saved file URL stops working after access ends | `audit_fixes_b::f10_http_former_hr_loses_all_paper_access_and_receipts`, `audit_fixes_b::f08_http_delegates_have_only_current_step_access`, `regressions::stale_actor_cannot_use_revoked_grant_or_delegation`; e2e F10, F08 | PASS |
| N30 | Two editors: the second gets a version conflict | `lifecycle::stale_version`, `audit_fixes_a::f11_settings_versions_increment_and_conflict_without_overwrite`, `audit_fixes_a::f11_settings_reject_stale_version` | PASS |
| N31 | Mail failure: decision saved once, notification retried | `system::notification_retry`, `http::smtp_delivery_happens_outside_database_transaction`, `http::notification_worker_and_registry_marker` | PASS |
| N32 | CSV formula injection; transfer mark is not a payroll import | `http::csv_formula_safe`, `http::main_scenario_export`, `audit_fixes_a::f07_*`, `audit_round2::f07_*` | PASS |
| N33 | Disguised executable, oversize file, archive, scanner failure | `http::upload_checks`, `system::upload_checks`, `audit_fixes_b::p01_*`, `audit_round2::p01_slow_clamd_does_not_block_concurrent_get`; `reaudit_regressions::r03_*` (frozen rule, missing/pending/quarantined/failed/clean, loss of eligibility, parent evidence, medical privacy); e2e P01 and R03 | PASS |
| N34 | Second factor, session revocation, brute force, CSRF, direct status change | `http::csrf_required`, `http::production_password_totp_and_lockout`, `http::new_privileges_require_fresh_totp`, `audit_round2::f08_delegation_only_*`, `scenario::step_outcomes_validated` | PASS |
| N35 | Demo sessions isolated; no external email; no demo login in production | `http::sandbox_isolation`, `http::production_has_no_demo_routes`, `system::email_minimal` | PASS |
| N36 | Backup, restore on an empty installation, same data and files, continue the request | `system::backup_restore_roundtrip`, `http::server_backup_restore_file_layout`; manual run [n36-backup-restore.log](docs/test-logs/n36-backup-restore.log) | PASS |
| N37 | Clone the public repository into a clean directory and run it from the README | manual run below | PASS |
| N38 | New employee and new leave type through the UI, full cycle | e2e `new-scenario.spec.ts` | PASS |

## Clean installation from the public repository (N37)

Executed on 2026-10-09 against commit `c932ddb` on GitHub (the code of the delivered version; later commits only
update this file), following the README "Run the demo locally" section. The N36 log was also re-run on this code.

```text
$ git clone https://github.com/OlegPhenomenon/nauru-leave.git /tmp/nld-clone && cd /tmp/nld-clone
$ cp .env.example .env
$ docker compose -p nldclean up -d --build
 Container nldclean-nauru-leave-1 Started
$ docker compose -p nldclean ps        → nldclean-nauru-leave-1 Up 6 seconds (healthy)
GET /up                                → ok
GET /api/config                        → {"app_version":"0.1.0","business_date":"2026-10-08","mode":"demo"}
GET /                                  → <title>Nauru Leave Desk
POST /api/demo/start                   → {"sandbox_id":"91418379…"}
GET /api/demo/personas                 → 9 personas
VmRSS of the running server            → 8008 kB
```

No licence server, activation key, expiry timer or call to the author's domain exists in the code (searched
`backend/src` and `frontend/src`); the demo domain is only a deployment setting in `config/deploy.yml`.

## Not executed

- Delivery through a real external SMTP provider (no credentials; the SMTP transport is tested against a local
  SMTP server).
- A real ClamAV engine. The clamd client is tested against a local server speaking the INSTREAM protocol
  (clean, infected, error, timeout, closed connection, slow scanner).
- Independent security assessment.
