# Agent guide — Nauru Leave Desk

Read first: `docs/DESIGN.md` (rules, Russian), `docs/API.md` (HTTP contract), `backend/migrations/` (schema,
authoritative, applied in order), `docs/DEMO_DATA.md`, `docs/ACCEPTANCE.md`. The original spec is private and kept
outside git in `.private/spec/` (local checkouts only).

## Layout
- `backend/` — Rust crate `nauru-leave` (binary + lib). `cargo` commands run from `backend/`.
- `frontend/` — Vite + React + TypeScript. `npm` commands run from `frontend/`.
- `docs/` — development docs in Russian; `README.md`, user guide in English.

## Hard rules
- Disk is limited (~15 GB free). Use exactly one Cargo target dir (`backend/target`). Never `cargo clean` other
  projects, never install toolchains, never use `cargo install`. Dev profile uses `debug = "line-tables-only"`.
- Pin dependency versions (Cargo.lock, package-lock.json committed). No `latest` tags in Docker.
- No mocks of business logic. Only external integrations are simulated (email → mailbox table, antivirus → EICAR
  check, SMS/TOTP shown on screen in demo, finance export → generic CSV).
- All durations are integer minutes. No floats in balance math.
- Every mutation: server-side authz (`authz` module), `BEGIN IMMEDIATE` transaction, `expected_version` check,
  audit event, outbox notification inside the same transaction.
- UI language English. Statuses always have text labels, never colour only.
- Do not commit; the orchestrator commits. Do not edit files outside your assigned area unless the task says so.
- No placeholder/TODO stubs. If something is impossible, write it in `docs/OPEN_ISSUES.md` with the reason.
