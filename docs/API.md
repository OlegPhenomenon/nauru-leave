# Nauru Leave Desk — HTTP API contract

Authoritative contract between `backend/` and `frontend/`. Rules: `docs/DESIGN.md`. Schema: `backend/migrations/0001_init.sql` plus ordered migrations.

Conventions
- JSON over `/api/*`. Dates `YYYY-MM-DD`; timestamps RFC3339 UTC. Durations are **integer minutes**; every
  balance object also carries `minutes_per_day` (from the employee's schedule, default 480) so the UI renders days/hours.
- Mutations (POST/PUT/DELETE) require header `X-CSRF-Token: <me.csrf_token>`; cookies are sent automatically
  (`credentials: 'same-origin'`).
- Request actions take `expected_version` in the body → 409 `stale_version` if it changed.
- `Idempotency-Key: <uuid>` is optional on POST `/api/requests`, request `/submit`, `/decide`, `/amend`, `/cancel`,
  `/respond`, `/actual`, `/attachments`, `/api/adjustments`, adjustment `/decide`, `/api/accruals/run`,
  `/api/periods/close`, import `/commit`, and `/api/exports`. A repeated command returns its saved result after
  checking current access; a changed body returns 422 `idempotency_key_reused`. Multipart fields, filename and
  file content define the command; boundary and field order do not. Result and receipt commit together.
- Error body: `{"error":{"code":"...","message":"...","details":{}}}` (codes in DESIGN §12).
- Lists: `?limit=&offset=`; response `{ "items": [...], "total": n }`.
- `allowed_actions` on resources is computed by the server; the UI shows only those buttons but the server
  re-checks everything.

## Types (TypeScript notation)

```ts
type Role = 'hr'|'hr_medical'|'final_approver'|'adjustment_approver'|'tech_admin'|'auditor';
type Part = 'full'|'am'|'pm';
type Status = 'draft'|'submitted'|'needs_information'|'under_review'|'approved'|'rejected'|'withdrawn'|'cancelled';
type Kind = 'leave'|'amendment'|'cancellation';
type DatePhase = 'upcoming'|'in_progress'|'period_ended';   // derived from dates, separate from status
type StepKind = 'manager_recommendation'|'hr_check'|'final_decision';
type Outcome = 'recommend_approve'|'recommend_reject'|'checked_ok'|'checked_problem'|'approve'|'reject'|'needs_information';

interface UserRef { id: number; display_name: string }
interface EmployeeRef { id: number; service_id: string; full_name: string; org_unit: { id: number; name: string } | null }

interface Me {
  user: UserRef & { email: string };
  employee: EmployeeRef | null;
  roles: { role: Role; scope_org_unit_id: number | null; scope_name: string }[];
  is_manager: boolean;                       // has direct reports today
  acting_for: { delegation_id: number; from: UserRef; scope: string; valid_to: string }[];
  csrf_token: string;
  totp_ok: boolean;
}

interface AppConfig { mode: 'demo'|'production'; business_date: string; app_version: string; sandbox_id?: string }

interface AccountBalance {
  account_id: number; leave_type: { id: number; code: string; name: string }; period_year: number;
  ledger_minutes: number; reserved_minutes: number; available_minutes: number; minutes_per_day: number;
}
interface BalanceSummary {                      // per leave type, all periods combined
  leave_type: { id: number; code: string; name: string; uses_balance: boolean };
  ledger_minutes: number; reserved_minutes: number; available_minutes: number;
  approved_upcoming_minutes: number; taken_minutes: number;   // reporting indicators (dates), not deductions
  minutes_per_day: number; accounts: AccountBalance[];
  policy: PolicyVersion | null;
}
interface PolicyVersion {
  id: number; valid_from: string; annual_entitlement_min: number;
  accrual_mode: string; advance_publish_months: number; carryover_allowed: boolean;
  carryover_expiry_months: number | null; // null = never; 0 = next 1 January
  carryover_limit_min: number | null; // null = unlimited
  paid: boolean; uses_balance: boolean; allow_half_day: boolean;
  requires_attachment: boolean; min_notice_days: number; allow_negative: boolean;
  status: 'demo_fictional'|'unverified'|'verified'; explanation: string;
}
interface LedgerEntry {
  id: number; account_id: number; period_year: number; minutes: number;
  kind: 'opening'|'accrual'|'consumption'|'return'|'adjustment'|'carryover_expiry'|'historical';
  effective_date: string; basis: string; request_number: string | null; revision_no: number | null;
  author: UserRef | null; created_at: string; running_total: number;
}
interface Reservation { id: number; account_id: number; period_year: number; minutes: number; request_number: string; revision_no: number; created_at: string }

interface DayRow {
  date: string; part: Part | 'none'; scheduled_minutes: number; minutes: number;
  period_year: number; explanation: string;           // e.g. "Mon, 480 min (Standard Mon–Fri)", "Holiday: Constitution Day"
  allocations: { account_id: number; period_year: number; minutes: number; carryover: boolean }[];
}
interface Revision {
  request: { id: number; number: string }; // owning request, including amendment history
  policy_version_id: number | null; policy_snapshot: Record<string, unknown> | null;
  id: number; rev_no: number; leave_type: { id: number; code: string; name: string; sensitive: boolean } | null; // null when restricted
  start_date: string; end_date: string; start_part: Part; end_part: Part;
  note: string | null; change_reason: string | null; total_minutes: number;
  created_by: UserRef; created_at: string; submitted_at: string | null; days: DayRow[];
}
interface Step {
  id: number; seq: number; kind: StepKind; revision_no: number;
  status: 'waiting'|'pending'|'done'|'superseded'|'closed';
  assignee: UserRef | null; eligible_description: string;   // "Olga Petrova (manager)" / "Any HR officer for Infrastructure Unit"
  problem: string | null;                                    // e.g. "No manager assigned"
  outcome: Outcome | null; completed_at: string | null;
}
interface Decision {
  id: number; step_id: number; step_kind: StepKind; revision_no: number;
  revision_id: number; request: { id: number; number: string } | null;
  actor: UserRef; acting_for: UserRef | null; authority: string;
  outcome: Outcome; reason: string | null; basis_document: string | null; created_at: string;
}
interface Message { id: number; kind: 'comment'|'question'|'answer'|'system'; author: UserRef | null; body: string; created_at: string }
interface AttachmentMeta {
  id: number; filename: string; content_type: string; size_bytes: number; sensitivity: 'normal'|'medical';
  scan_status: 'pending'|'clean'|'quarantined'|'scan_failed'; scan_note: string | null;
  uploaded_by: UserRef; created_at: string; can_download: boolean;   // medical files hidden entirely if no access: listed as {restricted:true}
}
interface RequestSummary {
  id: number; number: string; kind: Kind; status: Status; status_label: string;   // words, not colour
  date_phase: DatePhase | null; employee: EmployeeRef;
  leave_type_name: string;                    // "Leave (details restricted)" for sensitive types without access
  start_date: string; end_date: string; total_minutes: number; minutes_per_day: number;
  next_action: string | null;                 // "Waiting for HR check (any HR officer)" / "Answer the question from Olga"
  source: 'self'|'paper'; updated_at: string; version: number;
}
interface RequestDetail extends RequestSummary {
  parent: { id: number; number: string } | null;
  children: { id: number; number: string; kind: Kind; status: Status }[];   // amendments/cancellations
  previous_request: { id: number; number: string } | null;
  entered_by: UserRef; paper_received_date: string | null;
  current_revision: Revision; effective_revision: Revision | null; revisions: Revision[];
  in_force_revision: Revision | null; parent_in_force_revision: Revision | null;
  adjustment_ids?: number[];
  steps: Step[]; decisions: Decision[]; messages: Message[];
  attachments: (AttachmentMeta | { id: number; restricted: true })[];
  reservations: Reservation[]; ledger_entries: LedgerEntry[];
  actual_corrections: { date: string; account_id: number; applied_minutes: number; pending_minutes: number }[]; // empty for restricted views
  supporting_document_required: boolean; // rule frozen in the current revision
  supporting_document_ready: boolean;    // eligible clean file exists; no download authority implied
  actual: { confirmed_by: UserRef; confirmed_at: string; note: string | null } | null;
  warnings: Warning[];
  allowed_actions: ('edit'|'delete'|'submit'|'withdraw'|'respond'|'revise'|'decide'|'amend'|'cancel'|'comment'
                   |'upload'|'reassign'|'confirm_actual'|'propose_actual_adjustment'|'print')[];
  decidable_step: { id: number; kind: StepKind; outcomes: Outcome[]; acting_for: UserRef | null } | null;
  audit: AuditEvent[];
}
interface Warning { code: 'late_notice'|'team_overlap'|'schedule_drift'|'unassigned_step'; message: string; details?: any }
interface AuditEvent { id: number; at: string; actor: UserRef | null; acting_for: UserRef | null; action: string; entity: string; entity_id: number | null; details: any }
interface DraftInput {
  employee_id?: number;   // HR only (paper); default = own employee
  leave_type_id: number; start_date: string; end_date: string; start_part: Part; end_part: Part; note?: string;
  source?: 'self'|'paper'; paper_received_date?: string; previous_request_id?: number;
}
interface Preview {
  days: DayRow[]; total_minutes: number; minutes_per_day: number;
  balance_after: { period_year: number; available_before: number; available_after: number }[];
  route: { kind: StepKind; who: string; problem: string | null }[];
  warnings: Warning[]; errors: { code: string; message: string }[];   // errors block submit
  policy: PolicyVersion | null;
}
```

## Endpoints

### Session & demo
| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/config` | → `AppConfig` (no auth) |
| GET | `/api/demo/status` | → `{ has_sandbox: boolean, sandbox_id?: string, created_at?: string }` |
| POST | `/api/demo/start` | → `{ sandbox_id }` sets `nld_sbx`. 503 `demo_full`, 429 `rate_limited`. |
| POST | `/api/demo/reset` | → `{ sandbox_id }` new generation, logs out. |
| GET | `/api/demo/personas` | → `{ user_id, display_name, title, roles: string[], story: string }[]` |
| POST | `/api/demo/login` | `{ user_id }` → `Me` |
| POST | `/api/demo/clock` | `{ date }` (≥ current business date, ≤ 2028-12-31) → `AppConfig` |
| GET | `/api/demo/mailbox` | → `{ items: { id, to_email, subject, body, delivered_at }[] }` (whole sandbox; demo only) |
| POST | `/api/auth/login` | `{ email, password }` → `{ needs_totp: boolean }` |
| POST | `/api/auth/totp` | `{ code }` → `Me` |
| POST | `/api/auth/logout` | → 204 |
| GET | `/api/me` | → `Me` (401 if none) |

The demo-only endpoints return 404 in production.

### My leave & requests
| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/leave-types` | → `{ id, code, name, sensitive, paid, uses_balance, allow_half_day, requires_attachment, min_notice_days, active, version, policy: PolicyVersion | null, policies: (PolicyVersion & {in_force: boolean})[] }[]` |
| GET | `/api/balances/me` | → `BalanceSummary[]` |
| GET | `/api/balances/:employee_id` | → `BalanceSummary[]` (self, manager: no; hr/auditor in scope) |
| GET | `/api/balances/:employee_id/explain?leave_type_id=` | → `{ entries: LedgerEntry[], reservations: Reservation[], summary: BalanceSummary }` |
| GET | `/api/requests?scope=mine|team|all&status=&employee_id=&from=&to=` | → list of `RequestSummary` |
| POST | `/api/requests/preview` | `DraftInput & { amend_of?: number; cancel_of?: number }` → `Preview` |
| POST | `/api/requests` | `DraftInput` → `RequestDetail` (draft) |
| PUT | `/api/requests/:id` | `DraftInput & { expected_version }` → `RequestDetail` (draft only) |
| DELETE | `/api/requests/:id?expected_version=` | → 204 (draft only) |
| GET | `/api/requests/:id` | → `RequestDetail` |
| POST | `/api/requests/:id/submit` | `{ expected_version }` → `RequestDetail` |
| POST | `/api/requests/:id/withdraw` | `{ expected_version, reason? }` → `RequestDetail` |
| POST | `/api/requests/:id/decide` | `{ expected_version, step_id, outcome, reason?, basis_document? }` → `RequestDetail` (reason required for reject, recommend_reject, needs_information, checked_problem) |
| POST | `/api/requests/:id/messages` | `{ body }` → `RequestDetail` (comment) |
| POST | `/api/requests/:id/respond` | `{ expected_version, body, changes?: DraftInput & { change_reason } }` → `RequestDetail` |
| POST | `/api/requests/:id/amend` | `{ expected_version, leave_type_id, start_date, end_date, start_part, end_part, change_reason }` → `RequestDetail` (the new amendment request) |
| POST | `/api/requests/:id/cancel` | `{ expected_version, from_date, to_date, change_reason }` (whole range = full cancel) → `RequestDetail` (new cancellation request) |
| POST | `/api/requests/:id/reassign` | `{ expected_version, step_id, assignee_user_id }` → `RequestDetail` (hr) |
| POST | `/api/requests/:id/actual` | `{ expected_version, action: 'confirm'|'propose_adjustment', note, worked_dates?: string[], basis_document? }` → `RequestDetail` with `adjustment_ids` (hr; after period ended; worked dates and a basis document required for proposals; returns go to original paying accounts and need a second approver; pending/applied guided corrections reserve those date/account minutes; already covered dates return 422) |
| POST | `/api/requests/:id/attachments` | multipart `file`, `sensitivity` → `AttachmentMeta` |
| GET | `/api/attachments/:id` | → file bytes (permission-checked each time) |
| GET | `/api/approvals` | → `{ items: (RequestSummary & { step: Step; acting_for: UserRef | null; warnings: Warning[] })[], problems: (RequestSummary & { problem: string })[] }` (problems for hr: unassigned steps) |

On a sensitive request, the employee and HR/medical HR within scope see all messages. Other authorized
viewers see only questions they authored and answers following those questions. An answer belongs to the
latest preceding question by message id on that request; comments/system updates do not change the pairing.
Each new question starts a new pair, including when asked by a stand-in. Authorship does not grant request
access. Other questions, answers, comments (including the viewer's own) and system messages stay hidden.
Earlier sensitive revisions keep this restriction even if a later revision changes the leave type.
Cached mutation receipts apply the same current access check and message filter to their saved messages;
they do not acquire messages posted after the receipt. This exception grants no access to leave reasons or
medical documents. Non-HR final approvers and auditors retain request access with restricted sensitive
details, including masked revision notes/change reasons and decision reasons/references; the question
exception applies only to the messages array. Medical documents still require ownership or medical HR.

### Team calendar
`GET /api/calendar?org_unit_id=&from=&to=` →
`{ from, to, org_units: {id,name}[], people: { employee: EmployeeRef, absences: { date: string, part: Part, state: 'approved'|'pending', label: string, request_id: number|null }[] }[], counts: { date: string, approved: number, pending: number }[] }`
— `label` is the leave type name or `"Away"` for sensitive types / when viewer has no access; `request_id` null
when viewer may not open the request.

### People (L01)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/org-units` | `{ code, name, parent_id }` |
| PUT | `/api/org-units/:id` | incl. `active` |
| GET | `/api/employees?q=&org_unit_id=&include_inactive=` | `EmployeeRef & { email, start_date, end_date, active, manager: EmployeeRef|null, schedule: {id,name}|null, has_login: boolean }` |
| POST | `/api/employees` | `{ service_id, full_name, email?, start_date, org_unit_id, manager_employee_id?, schedule_id }` |
| GET | `/api/employees/:id` | detail + `assignments[]`, `schedules[]`, `user`, `balances` (if allowed) |
| PUT | `/api/employees/:id` | `{ expected_version, full_name, email, end_date, active }` (deactivate never deletes requests) |
| POST | `/api/employees/:id/transfer` | `{ org_unit_id, manager_employee_id, valid_from, reassign_open_steps: boolean }` |
| POST | `/api/employees/:id/schedule` | `{ expected_version, schedule_id, valid_from }` → also returns `affected_future_requests[]` |

### Balances & adjustments (L04, L11)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/balances?org_unit_id=&leave_type_id=&date=` | `{ items: { employee: EmployeeRef, summary: BalanceSummary }[] }` |
| POST | `/api/adjustments` | `{ employee_id, leave_type_id, period_year, minutes, reason, basis_document }` → proposed |
| GET | `/api/adjustments?status=` | list with old/new values `{ ..., balance_before, balance_after_if_applied, proposed_by, decided_by }` |
| POST | `/api/adjustments/:id/decide` | `{ decision: 'apply'|'reject', note }` (adjustment_approver ≠ proposer) |
| POST | `/api/accruals/run` | `{ leave_type_id, period_year, month? }` → `{ posted: n, skipped_existing: n }` (idempotent) |
| GET | `/api/periods/close?leave_type_id=&period_year=` | → `ClosePreview` (same service-wide HR authorization as close; finished years only; read-only) |
| POST | `/api/periods/close` | `{ leave_type_id, period_year }` → `ClosePreview & { posted }`; expire excess above the carry-over limit when closing, then the remaining unreserved balance at expiry; idempotent |

`ClosePreview` is `{ leave_type_id, period_year, already_closed, items: [{ account_id, employee_id,
service_id, full_name, minutes_per_day, left_minutes, carried_minutes, removed_minutes, already_closed }] }`.
Rows cover existing accounts for that type/year, including inactive employees. All amounts are integer minutes;
the UI divides by each employee's current `minutes_per_day` to show days. `left_minutes` is the nonnegative,
unreserved balance now. `carried_minutes` is what remains after this close; carry-over stays in its original
account. Preview and commit share the calculation; POST returns the plan used inside its transaction. Changes
between GET and POST are recomputed by POST. `already_closed` uses `period_closures` and legacy ledger op_keys,
not the number of postings; when no accounts exist, a previous close audit fact identifies closure. The overall
flag is true when all accounts were closed. Existing accounts can still expire on a later repeat, and newly
created accounts can still be closed; the UI disables a new close when all accounts are already closed.

### Reports & export (L10, L12)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/reports/balances?date=&org_unit_id=&format=json|csv` | balance at date; employees employed on that date are included even if currently inactive |
| GET | `/api/reports/absences?from=&to=&org_unit_id=&format=` | approved absences, counts + hours, rows link to request |
| GET | `/api/reports/pending?format=` | requests awaiting action with age |
| GET | `/api/reports/changes-since-export?org_unit_id=&format=` | new, changed and removed approved days compared with saved rows of the most recent transferred export covering each employee/date |
| GET | `/api/reports/schedule-drift` | future approved/pending days whose frozen schedule differs from current |
| POST | `/api/exports` | `{ from, to, org_unit_id? }` → `{ id, from, to, org_unit_id, row_count, sha256, created_at }`; stores exact rows and scope; baseline selection checks the employee’s assignment on each exported day |
| GET | `/api/exports` / `/api/exports/:id/download` | CSV, formula-safe |
| POST | `/api/exports/:id/mark-transferred` | `{ note }` |
| POST | `/api/imports/preview` | multipart `file`, `kind`, `mode?` → `{ batch_id, rows: { line, data, errors: string[] }[], rows_total, rows_valid }` |
| POST | `/api/imports/:id/commit` | → `{ applied: n, skipped_duplicates: n }` (409 if any row invalid — all-or-nothing) |
| GET | `/api/imports` | history |

Opening-balance CSV accepts `staff_number,leave_type,year,days,basis`. `staff_number` aliases
`service_id` for all three import kinds; `year` aliases `period_year` for opening balances. Opening
`leave_type` matches a trimmed code or name case-insensitively. Exactly one amount header, `minutes` or
`days`, is allowed per file; a missing/both amount header is reported on each row. Days must be nonnegative
whole or half-days (e.g. `12`, `12.5`) and are parsed as integer half-days, then converted with the same current
employee schedule day length as balances (`minutes_per_day`, default 480). Unrepresentable/overflowing amounts
are row errors. Legacy headers, type codes and integer-minute files remain supported, including their legacy
error wording. Plain-column errors include “Unknown staff number NPS-9999” and “Days must be a number like
12 or 12.5”. The dialog template uses a leave type name and half-day example; uploads are sent unchanged.

### Settings (L02, L03, L09)
| Method | Path | Notes |
|---|---|---|
| POST/PUT | `/api/leave-types`, `/api/leave-types/:id` | hr |
| POST | `/api/leave-types/:id/policies` | returns the new `PolicyVersion` and `affected_future_requests`; request detail warns when its saved policy differs from the policy now in force. Body: `{ valid_from, annual_entitlement_min, accrual_mode, advance_publish_months, carryover_allowed, carryover_expiry_months, carryover_limit_min, paid, uses_balance, allow_half_day, requires_attachment, min_notice_days, allow_negative, explanation }` |
| POST | `/api/policies/:id/verify` | hr marks rule verified (production requirement) |
| GET/POST | `/api/schedules`, `/api/schedules/:id/versions` | schedules and versions include `version`; creating a version requires `{ expected_version, valid_from, week }` with the schedule version counter |
| GET/POST | `/api/calendar-exceptions` | holidays; POST response includes `affected_future_requests` |
| POST | `/api/calendar-exceptions/:id/revoke` | `{ reason }`; retains frozen day references, excludes exception from new calculations; response includes `affected_future_requests` |
| GET/POST/PUT | `/api/users`, `/api/users/:id` | Account administration: tech_admin or HR; `{ email, display_name, active, employee_id? }`. PUT also requires `expected_version`; response includes `version`. Changing employee linkage requires HR scope on affected employees and a different actor from the target user. Deactivation revokes sessions. GET items include `allowed: {grant_roles: Role[], link_employee: boolean}`. |
| POST/DELETE | `/api/users/:id/roles`, `/api/role-grants/:id` | Business roles: service-wide HR, different from the grantee; hr_medical additionally requires the granter to hold hr_medical. tech_admin can grant/revoke only tech_admin on another user. CLI operator may provision roles. |
| GET/POST | `/api/delegations` | `{ from_user_id, to_user_id, scope, valid_from, valid_to, reason }` (delegator or service-wide HR) |
| POST | `/api/delegations/:id/revoke` | |

### Operations & audit (L13)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/ops/notifications?status=` | `{ id, to_email(masked for non-tech-admin), recipient_name: string|null, request_number: string|null, request_id: number|null, subject, status, attempts, last_error, next_attempt_at, created_at, sent_at }` — no body; existing visibility filter applies before identity lookup; request number/link only when the viewer may open that request; tech-admin address stays unmasked |
| POST | `/api/ops/notifications/:id/retry` | tech_admin / hr |
| GET | `/api/ops/summary` | counts: queued/failed/gave_up, quarantined files, active reservations total, sandbox info |
| GET | `/api/audit?entity=&entity_id=&actor_user_id=&limit=` | auditor, hr (scope), tech_admin (no PII details) |

A current pending-step delegate can read that request, its normal files and its item in `/api/approvals`.
Sensitive details are masked; medical files require independent ownership or hr_medical. Step completion,
revocation and delegation expiry remove this access. A decision that ends the actor's read access returns
`{id,status,version}`. Entry/upload authorship is history and never provides permanent access.

Production uploads require `NLD_CLAMD_ADDR`; without it they return 503 `scanner_unavailable`.
ClamAV INSTREAM uses `NLD_CLAMD_TIMEOUT_MS` (default 10000). FOUND means `quarantined`; errors, timeout or
closed connections produce stored `scan_failed` files with a `scan_note`. Only `clean` files are downloadable.
Operations summary includes `scanner` and `scan_failed_files`; demo uses its built-in EICAR check.

### Printable card
`GET /api/requests/:id/card` → `RequestDetail` subset; frontend route `/requests/:id/print` renders a print stylesheet
with: number, employee, dates per day, revision, every decision (actor, acting-for, authority, time), footer
"Record of decision in Nauru Leave Desk — not a government electronic signature."

## Deviations and implementation clarifications

- Bootstrap mutations (`/api/demo/start`, `/api/demo/login`, `/api/auth/login`, `/api/auth/totp`) require a matching
  `Origin` (or same-origin `Referer`); they cannot require a CSRF token before a complete session exists.
  `/api/demo/reset` also requires the session CSRF token when the sandbox has a valid complete session. Every other
  mutation requires both the session token and the origin check. This supports the existing persona-switch flow.
- Session cookies are Secure in production and on HTTPS demos. Local HTTP demos omit Secure. Cookies remain
  HttpOnly, SameSite=Lax, host-only. Production is intended to run behind HTTPS.
- Calendar exceptions are revoked with a reason; the list includes `revoked_at`, `revoked_by`, and `reason`. Schedule versions
  support GET as well as POST at `/api/schedules/:id/versions`.
- Balance summaries and request previews include `policy` so the client can display its status and explanation.
  Demo policies remain `demo_fictional` with “Fictional demo rule — not Nauru law”; verifying a fictional demo
  policy is refused. No government integration is present; transfer exports are generic CSV.
- Report JSON uses `{items,total}` with `limit`/`offset`; absences also includes `total_days` and `total_minutes`
  calculated over all authorized filtered rows before pagination. Durations remain integer minutes. CSV includes
  all authorized filtered rows. Sensitive absence types are labelled `Away`; transfer CSV uses `RESTRICTED`.
- Multipart uploads accept one `file` per request. Attachments are limited to 1 MiB in demo / 2 MiB in production,
  five per leave request, twenty stored attachments per demo sandbox (including seeded files), and 10 MiB per
  sandbox. Imports accept one UTF-8 CSV up to 8 MiB. See DESIGN §9 for file-level historical import modes.
- `POST /api/accruals/run` requires integer `month` (1–12) for monthly policies and rejects it for annual policies. Accrual fact keys do not contain the policy id; legacy keys also prevent duplicates. Service-wide settings, accrual and period
  closure require service-wide HR; directory changes and import/export rows respect the actor's organizational scope.
- Idempotency replay preserves the saved response and re-checks current access, including medical redaction.
- The CSP permits existing React inline style attributes through `style-src-attr 'unsafe-inline'`; scripts and
  stylesheet sources remain restricted to self. Password and TOTP enrollment are outside this HTTP contract;
  production accounts require operator provisioning (see `OPEN_ISSUES.md`).

- Settings updates to leave types, units, employees and users, employee schedule changes, and new schedule versions require `expected_version`; stale forms receive 409 `stale_version`. Lists and mutation responses include `version` (schedule version creation returns the schedule's updated version). Leave-type updates change identity/presentation; dated policy versions change business conditions.
- Submitted revisions preserve `policy_version_id` and `policy_snapshot`; future policy versions are never used for submission or preview before their effective date (`no_policy`, 422, if none is in force). Sensitivity remains restrictive for saved material.
- Leave summaries, calendar, reports and printable data use the effective revision. Detail keeps the request's own `current_revision` and history (own revisions plus approved child revisions; pending/rejected child proposals are excluded), adds `in_force_revision` and `parent_in_force_revision`, and links approved amendment/cancellation decisions to their originating requests. Fully cancelled leave has zero effective minutes and retains its dates as history.
- Date-specific balances and their explanations use `reserved_on <= date` and `released_on > date` (or no release). Balance lists select employees with `start_date <= date` and no end date before it, independent of current activation; their unit filter also uses that date. Absence reports keep inactive employees and use assignments on each absence day; access is checked with current permissions.
- On upgrade, old reservation dates are inferred from their saved timestamps; older business clock values cannot be recovered. Legacy export rows are recovered from CSV, with employee scope reconstructed from the creator's dated HR grants. Existing revision minutes and carry-over expiry values are preserved.

- Accrual policy lookup uses the first day of the selected month, or January 1 for an annual run, with highest policy id breaking equal effective-date ties. An annual accrual fact covers every month of that year. Existing monthly facts prevent a later full annual credit; differences require an explicit adjustment. Legacy annual and monthly keys follow the same rules.
- Carry-over limits apply across all requests drawing later-year days from an account: approved effective allocations and active reservation deltas share one allowance; a pending amendment’s positive carry-over delta also counts when its account total is unchanged. Amendments replace their parent's allocation rather than count it twice. Closing caps free carry-over after that usage; later releases and returns cannot make more than the remaining allowance spendable.
- Export lists and mutation responses retain `org_unit_id` and return `transferred_by: UserRef | null`. Changes compare against the latest transferred export whose scope covers the employee's assignment on the particular day.
- A delegation cannot have the same sender and recipient. HR cannot create a delegation from another user to itself. Active delegates need TOTP in production, including when a delegation is granted after password login. A medical role grant must be within the granter's current medical scope (whole-service grants require whole-service medical authority).
- Scanning and file storage run outside the database dispatch lock. Recording reloads the session and actor, checks authorization and quotas, then saves the attachment and receipt atomically. Upload receipt replay requires current upload authority and returns redacted attachment metadata; it does not require medical viewing authority.
- Migration creates an initial non-accruing policy for legacy leave types without policies, preserving their condition flags from the earliest supported date. These rules remain unverified outside demo databases.
- Leave-type PUT includes `code`; employee-link PUT includes the user's `email`, `display_name`, `active`, `employee_id` and `expected_version`.

- Guided actual-period corrections persist each selected day and original paying account in `actual_correction_allocations`. Pending and applied proposals reduce the remaining refundable allocation inside `BEGIN IMMEDIATE`; rejected proposals release it. Applying a guided proposal rechecks the original allocation ceiling under the same writer lock. Ordinary manual adjustments remain independent. Upgrade recovers earlier guided links from recorded audit dates and adjustment ids.
- An attachment row allows a required-document request to enter review, including while its scan is pending. Final approval of leave or an amendment requires a linked `clean` attachment on the request or its parent if the submitted revision's frozen `requires_attachment` rule is true. Pending, quarantined and scan-failed files do not satisfy final approval (422: `A readable supporting document is required`). The readiness booleans expose presence only; medical file metadata/content and download permissions remain separately restricted.
- The accrual form always offers year and month before resolving policy. Monthly runs use the selected month's first day, including a first policy beginning in October. Annual runs retain January lookup and omit the month in the API command. Missing/future-only policies disable the run; server accrual rules are unchanged.

- `GET /api/accruals/preview?leave_type_id=…&period_year=…[&month=…]` requires the same service-wide HR authority as an accrual run. It returns `eligible`, `skipped_existing` and integer `entitlement_minutes`, without creating accounts or postings. Annual facts also cover monthly previews; preview counts remain advisory because a commit rechecks facts under the writer lock.
- Payroll CSVs retain their transfer columns and append `Leave type (sick leave details are hidden)`. Sensitive types remain masked as `RESTRICTED` in the transfer code and `Away` in the readable column.
- An opening-balance import cannot initialize an account that already has an opening or an accrual fact. This guard is rechecked when committing, so an entitlement granted after preview cannot be doubled by the import.
