# Nauru Leave Desk

An independent, open-source prototype of electronic leave management for a public service: an employee asks for
time away, the manager recommends, HR checks the record, an authorised person decides — and the balance, calendar
and history stay correct and explainable.

> **Status: prototype.** All people, organisations, leave rules and numbers in the demo are **fictional test data**.
> The software has not been commissioned, reviewed or adopted by the Government of Nauru. Email, antivirus and
> second-factor codes are simulated in the demo. There is **no** integration with any government system; the
> finance hand-over is a generic CSV. See [ASSUMPTIONS.md](ASSUMPTIONS.md).

- Live demo: <https://nauru.shelfcompass.com> — every visitor gets a private copy of the demo data (deleted after
  24 h of inactivity). Please do not upload real personnel documents.
- Short walkthrough video: [docs/media/demo-walkthrough.webm](docs/media/demo-walkthrough.webm)
- Employee guide: the in-app **Help** page.

## Using the desk

Choose **Start demo**, then a person. The demo strip identifies fictional data and rules. Use its person menu to switch roles; **Demo tools** contains the mailbox, **Move date forward…**, and **Reset demo…**.

- **Request leave:** on **My leave**, check **Days left**, choose **Request leave**, enter dates and select morning or afternoon for a half day. **Send request** starts approval. **Show day by day** explains the calculation.
- **Answer or change a request:** answer a question directly on **My leave**. Open a request for **Change dates**, **Cancel days**, documents and messages. **More → Print** opens the printable record; **Changes** and **History** contain earlier records.
- **Review leave:** open a row in **Approvals**, read its documents, then **Recommend approval**, **Mark as checked**, or **Approve** for your step. Refusals and questions reveal a text field in the same card.
- **Manage staff:** HR uses **People → Add person**. The person's row menu offers changes to their manager or work pattern, a paper form, balance correction, access and a stand-in. The **Units** tab manages units; **More → Import people…** opens CSV import.
- **Manage leave amounts:** **Balances** shows days left and corrections awaiting a second HR officer. Use **Correct balance…**, **Add entitlement…**, **Close year…**, or **Import…**. **How is this worked out?** explains an employee's balance.
- **Set rules:** **Settings** opens leave types, work patterns, public holidays, the approval route, users and access, and stand-ins. **System** shows email delivery and retry controls.
- **Download a report:** **Reports** lets you choose a unit and month, then **Download CSV**. **Payroll files** creates a hand-over file and records when it was sent. **Calendar** shows who's away; restricted leave says **Away**.
- **Trace a request:** auditors land on **History**. Search its request number and open the result to see that request's history.

For the main example, Alexei requests Annual leave on 9–13 November 2026: five working days leave 15 days available. Olga recommends, Maria checks and Elena approves. Change the dates to 9–11 November and repeat approval: 17 days remain. Moving the demo date beyond the leave does not deduct it again.

## How balances are calculated

All amounts are integer **minutes** (a standard day in the demo is 480 minutes). Every movement is an immutable
ledger entry with a unique operation key, so retries never post twice.

- **Ledger balance** = sum of entries effective on or before the date (opening, accruals, approved consumption,
  returns, adjustments, expiries).
- **Available for a new request** = ledger balance − active reservations.
- Submitting a request **reserves** its minutes. Final approval replaces the reservation with a consumption entry in
  the same transaction. Rejection or withdrawal releases the reservation.
- An amendment reserves only the **extra** minutes per account; returns are posted only when the amendment is
  approved, and always to the account that originally paid.
- Each day belongs to the leave year of its date, so a December–January request is split across two accounts.
- When a period ends nothing is deducted again: past days are a reporting indicator, not a second charge.

| Event | Ledger | Reserved | Available |
|---|---|---|---|
| Opening 20 days | 20 | 0 | 20 |
| Submit 5 days | 20 | 5 | 15 |
| Approve | 15 | 0 | 15 |
| Ask to shorten to 3 days | 15 | 0 | 15 |
| Approve shortening | 17 | 0 | 17 |
| The three days pass | 17 | 0 | 17 |

## Architecture

- `backend/` — one Rust binary (`nauru-leave`): axum HTTP server, SQLite (bundled, WAL), background worker,
  CLI for provisioning, backup and restore. The React build is embedded into the binary.
- `frontend/` — Vite + React + TypeScript, no UI framework (a single embedded frontend bundle).
- Every mutation: server-side permission check, `BEGIN IMMEDIATE` transaction, version check, audit event and
  notification outbox in the same transaction.
- Demo mode gives each visitor a separate SQLite file copied from a seeded template; production mode uses one
  database and has no persona login, time travel or mailbox viewer.
- Footprint: ~7 MB binary, ~7 MB RAM when idle.

Design notes for developers (in Russian): [docs/DESIGN.md](docs/DESIGN.md), HTTP contract: [docs/API.md](docs/API.md),
demo data: [docs/DEMO_DATA.md](docs/DEMO_DATA.md), acceptance checklist: [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md),
test evidence: [TEST_RESULTS.md](TEST_RESULTS.md).

## Run the demo locally

With Docker:

```sh
cp .env.example .env
docker compose up --build
# open http://127.0.0.1:8080
```

From source (Rust 1.98, Node 22+):

```sh
cd frontend && npm ci && npm run build && cd ..
cd backend && cargo build --release
NLD_MODE=demo ./target/release/nauru-leave serve      # http://127.0.0.1:8080
```

## Configuration

All settings are environment variables; see [.env.example](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `NLD_MODE` | `demo` | `demo` or `production` |
| `NLD_BIND` | `127.0.0.1:8080` | listen address |
| `NLD_DATA_DIR` | `./data` | databases and private files |
| `NLD_PUBLIC_URL` | `http://127.0.0.1:8080` | browser-visible origin (used for CSRF origin checks and email links) |
| `NLD_SMTP_URL` | — | required in production |
| `NLD_CLAMD_ADDR`, `NLD_CLAMD_TIMEOUT_MS` | —, `10000` | ClamAV `clamd` (host:port) for scanning uploads; without it production refuses uploads. The demo uses a built-in test-only check (file signature + EICAR) |
| `NLD_BACKUP_KEY_FILE` | — | 32-byte key for encrypted backups |
| `NLD_MAX_SANDBOXES`, `NLD_SANDBOX_TTL_HOURS` | `300`, `24` | demo capacity |
| `NLD_RATE_PER_SEC`, `NLD_SANDBOX_CREATIONS_PER_HOUR` | `30`, `30` | per-IP limits |
| `NLD_TRUST_PROXY_HEADERS` | `false` | use `X-Forwarded-For` behind a trusted proxy |

## Production installation

Production mode needs HTTPS (session cookies are `Secure`), SMTP and, for attachments, a ClamAV `clamd` service
(uploads fail closed without it; scanner errors leave the file blocked). There are no default users or passwords.

```sh
export NLD_MODE=production
export NLD_DATA_DIR=/var/lib/nauru-leave
export NLD_PUBLIC_URL=https://leave.example.org
export NLD_SMTP_URL=smtps://username:password@smtp.example.org:465
export NLD_CLAMD_ADDR=127.0.0.1:3310

nauru-leave init-production --data-dir "$NLD_DATA_DIR"
nauru-leave user create --email admin@example.org --name "Technical administrator" --role tech_admin
nauru-leave user create --email hr@example.org --name "HR officer" --role hr --role hr_medical
nauru-leave user create --email approver@example.org --name "Final approver" --role final_approver
nauru-leave serve
```

`init-production` applies migrations without demo data, can be repeated, and refuses directories that contain demo
data. `user create` asks for a password twice (minimum 12 characters; `--password-stdin` for automation), stores an
Argon2id hash, and prints a TOTP secret and `otpauth://` URI **once** — enrol it in an authenticator app. Roles:
`hr`, `hr_medical`, `final_approver`, `adjustment_approver`, `tech_admin`, `auditor`; `--role hr:IU` limits a role
to one org unit. Managers are not a role: they follow from the employee's assignment.

```sh
nauru-leave user list
nauru-leave user create --email employee@example.org --name "Employee" --employee-service-id NPS-1001
nauru-leave user grant-role --email hr@example.org --role hr:IU
nauru-leave user revoke-role --email hr@example.org --role hr
nauru-leave user reset-password --email employee@example.org
nauru-leave user reset-totp --email employee@example.org
nauru-leave user revoke-sessions --email employee@example.org
```

Then, signed in as HR: create org units, schedules, holidays, leave types and **confirmed** policies (Settings),
import employees and opening balances from CSV (Reports → Imports; preview first, then commit), and link logins
with `--employee-service-id`. Employees without a login can be served by HR through paper requests.

### Backup and restore

```sh
nauru-leave gen-backup-key --out /secure/nauru-backup.key      # keep away from the backups
nauru-leave backup --db "$NLD_DATA_DIR/main.sqlite" --files-dir "$NLD_DATA_DIR/files/main" \
  --key-file /secure/nauru-backup.key --out nauru-$(date +%F).enc
nauru-leave restore --in nauru-2026-10-08.enc --key-file /secure/nauru-backup.key --data-dir /new/data/dir
```

The archive (database snapshot + attachments) is encrypted with XChaCha20-Poly1305. Restore into an empty
directory, then start the server with `NLD_DATA_DIR` pointing at it.

### Upgrading

1. Take a backup (above).
2. Replace the binary or image with the new version.
3. Start it: migrations are applied automatically at start-up (`nauru-leave migrate` applies them explicitly).
4. If anything goes wrong, restore the backup into a fresh directory and run the previous version.

## Tests

```sh
cd backend && cargo test                 # domain + HTTP tests on real SQLite databases
cd frontend && npm test && npm run build # unit tests and type-checked build
# end-to-end (needs a running demo server):
cd frontend && E2E_BASE=http://127.0.0.1:8080 npm run e2e
```

## Licence

Application code: [MIT](LICENSE). Third-party components and their licences:
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). Security policy: [SECURITY.md](SECURITY.md).
