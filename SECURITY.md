# Security

## Reporting a vulnerability
Please report suspected vulnerabilities privately via GitHub security advisories on this repository
("Report a vulnerability"). Do not open a public issue. Do not test against other visitors' demo sandboxes.

## What the application does
| Area | Control |
|---|---|
| Authorisation | Every read and write is checked on the server in one module (`backend/src/authz.rs`): records, files, search, calendar, reports and exports. The UI only hides buttons; it is not the security boundary. |
| Self-approval | Nobody can decide a step on their own request, whatever roles or delegations they hold. |
| Concurrency | Every mutation runs in one SQLite `BEGIN IMMEDIATE` transaction that re-checks permission, status, version, overlap and balance before writing. Two parallel requests cannot spend the same minutes. |
| Replays | `Idempotency-Key` on submit/decide/amend/cancel; ledger entries carry a unique operation key, so retries never post twice. Reusing a key with a different body is rejected. |
| Stale tabs | Request actions carry `expected_version`; a changed record returns 409 instead of silently overwriting. |
| Sessions | Random token, stored hashed; `HttpOnly`, `Secure` (production), `SameSite=Lax`, host-only cookie. Logout and account deactivation revoke sessions. |
| CSRF | Mutations need the per-session `X-CSRF-Token` header and a matching `Origin`/`Referer`. |
| Passwords / 2FA | Argon2id hashes; TOTP second factor for service roles; lockout after repeated failures (production mode). |
| Files | Type detected from content (PDF/PNG/JPEG only), size and count limits, stored under random names outside the web root, served only through a permission-checked endpoint with `Content-Disposition: attachment`, `nosniff`, `no-store`. No long-lived links: revoking access takes effect on the next request. |
| Medical documents | Visible only to the employee and HR staff explicitly granted `hr_medical` in scope. Never in the team calendar, emails or exports. |
| Emails | Minimal content (request number and a link behind login); no leave type, reasons or diagnoses. |
| CSV | Cells starting with `= + - @`, tab or CR are prefixed to stop spreadsheet formula execution. |
| Headers | CSP `default-src 'self'`, `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, `Cache-Control: no-store` for API responses. |
| Audit | Append-only `audit_events`; SQLite triggers reject UPDATE/DELETE. Ledger entries and decisions are immutable in the same way. |
| Backups | `nauru-leave backup` produces an XChaCha20-Poly1305-encrypted archive of the database and files; the key is a separate file that must be stored apart from the archives. |

## Honest limits
- The audit log is protected against ordinary users, **not** against someone with direct access to the database
  file or the server. Operating-system access, backups and keys need their own controls.
- The demo antivirus only detects the EICAR test string. A real installation should connect a real scanner.
- In **demo mode** there are no passwords: visitors pick a fictional persona. Demo mode must never hold real data.
  Demo-only endpoints (persona login, time travel, mailbox) are not registered in production mode.
- Rate limits are in-memory per process; put the service behind a reverse proxy that also limits abusive clients.
- The prototype has not had an independent security assessment.

## Secrets
No secrets live in the repository. Configuration comes from environment variables (see `.env.example`). The backup
key is generated with `nauru-leave gen-backup-key` and kept outside the data directory.
