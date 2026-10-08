# Nauru Leave Desk — architecture brief (draft for review)

Full spec (Russian): docs/spec/SPEC_RU.txt. Goal: public, open-source DEMO prototype to show Nauru
public-service HR how electronic leave management would work. Integrations (email, AV scan, 2FA SMS,
finance export) are mocked but behaviour must be real (persisted, transactional, permission-checked).
Hosted as subdomain of shelfcompass.com on a small shared server. Must be resource-cheap.

Constraints from owner: backend Rust, DB SQLite, frontend React. Dev machine has ~16 GB free disk.

## Draft decisions
- Single binary `nauru-leave` (axum 0.8 + tokio + rusqlite bundled). React (Vite + TS, no UI kit) built
  to static files and embedded into binary (rust-embed). Docker multi-stage, tiny runtime image.
- SQLite per tenant. Demo isolation: each visitor gets a sandbox = copy of a seeded template DB file
  (`data/sandboxes/<random-id>.sqlite`), cookie-bound, TTL 24h, global cap (e.g. 300), reset button
  re-copies template. Production mode = one DB, no sandboxes, no persona switcher.
- All money-like quantities = integer minutes. Ledger entries immutable, unique op_key.
  Available = sum(applied ledger entries at date) − active reservations. Approval converts reservation
  into consumption in one transaction. Writes use `BEGIN IMMEDIATE` (SQLite writer lock) → no double
  spend under concurrency.
- Request → immutable revisions; per-day rows (date, minutes, schedule snapshot, accounting period).
  Approval route: manager recommendation → HR check → final decision (separate authority).
  Amendment/cancellation = separate request linked to approved one; reserve only positive delta.
- Auth: argon2 passwords + TOTP for service roles; in demo mode a persona picker logs in instantly
  and TOTP is shown on screen. Session cookie HttpOnly SameSite=Strict + CSRF header check.
- Notifications: outbox table + background tokio worker → "local mailbox" table viewable in UI (demo);
  retries with backoff, manual retry; a fake failing domain demonstrates the Operations screen.
- Files: private dir, served only via permission-checked endpoint, magic-byte type check (PDF/PNG/JPG),
  size cap, mock AV scanner (EICAR → quarantine), medical files need explicit grant.
- Import CSV (employees, opening balances) with preview + confirm, idempotent by service id + hash.
  Export CSV with formula-injection escaping; generic transfer format (not "TechnologyOne").
- Backup/restore CLI subcommands: VACUUM INTO + files → tar → encrypted with key from env file.
- Audit events table (append-only, triggers forbid UPDATE/DELETE).

## Questions for you
1. Any flaw in the sandbox-per-visitor SQLite approach (memory, file handles, abuse)? Better alternative?
2. rusqlite+spawn_blocking vs sqlx for this size? Connection strategy per sandbox?
3. Ledger/reservation model: holes regarding amendments, year boundary, partial cancel, concurrency?
4. Top risks that would make the demo unconvincing to a government HR audience, and how to avoid them.
5. Anything to cut or simplify without violating the spec's L01–L14 so it stays cheap and maintainable.
Be concrete and short (≤ 700 words).
