# Frontend notes — assumptions about the API

`docs/API.md` pins down the core domain types and endpoints exactly. Where it is
silent, the frontend made the following assumptions. If the backend diverges, the
affected screen is named so the mismatch is easy to find.

## List envelope

API.md defines `{ items, total }` for paginated lists but does not say which
endpoints use it. The client accepts either `{items|rows: []}` or a bare array
(`unwrapList` in `src/api/client.ts`). Affected: `employees`, `org-units`,
`schedules`, `calendar-exceptions`, `users`, `delegations`, `adjustments`,
`exports`, `imports`, `ops/notifications`, `audit`, report endpoints.

## Assumed response field shapes

- `GET /api/employees` items: `EmployeeRef & { email: string|null, start_date,
  end_date: string|null, active: bool, manager: EmployeeRef|null,
  schedule: {id,name}|null, has_login: bool }`.
- `GET /api/employees/:id` adds `assignments[]` (org_unit, manager, valid_from,
  valid_to), `schedules[]` (schedule ref, valid_from, valid_to), `user`
  (UserRef+email or null), `balances?: BalanceSummary[]`.
- `OrgUnit`: `{ id, code, name, parent_id: number|null, active: bool }`.
- `PolicyVersion`: fields from the POST body plus `id`, `status`
  (`'demo_fictional'|'verified'|…`) and `in_force` (false for versions whose
  `valid_from` is still in the future — shown as “Not yet in force”). The
  versioned conditions (`paid`, `uses_balance`, `allow_half_day`,
  `requires_attachment`, `min_notice_days`) live here, not on the leave type.
  `carryover_expiry_months`: null = never expires, 0 = expires at the start of
  the next year. `carryover_limit_min`: null = no limit; the policy form edits
  it in days and converts to minutes (`STANDARD_DAY_MINUTES` = 480, the demo
  full-time day — no org-level day length is exposed to the client).
  The Settings tab shows the “Fictional demo rule” badge when
  `status === 'demo_fictional'` and a Verify button when it is not `'verified'`.
- `BalanceSummary` (from `GET /api/balances/me` and
  `GET /api/balances/:employee_id`) carries `policy: PolicyVersion | null`;
  `POST /api/requests/preview` also returns `policy`. Every surface that shows
  a policy uses `PolicyBadge` (`src/components/ui.tsx`): a fictional demo rule
  is always labelled “Fictional demo rule — not Nauru law”.
- Preview `warnings` for `code: 'team_overlap'` carry
  `details: [{ name, from, to }]` — rendered as a sub-list naming the absent
  teammates (`WarnList` in `src/components/ui.tsx`).
- Calendar absence cells: `label` is the leave type name, or the literal
  `"Away"` when the absence is restricted (e.g. medical). Cells render the
  word “Away” whenever the label is masked, linked only if `request_id` is
  present.
- `GET /api/requests/:id` returns 403 `forbidden` for requests outside the
  caller's scope (another unit, sensitive leave). `RequestDetail` renders a
  friendly “You don’t have access to this request” page with a way back —
  not the generic error box.
- `Schedule`: `{ id, name, versions?: ScheduleVersion[] }`;
  `ScheduleVersion.week` is either `{mon..sun: minutes}` or `number[7]`
  (both rendered). POST `/api/schedules` body is
  `{ name, valid_from, week }`; POST `/api/schedules/:id/versions` is
  `{ valid_from, week }`.
- `CalendarException`: `{ id, date, minutes, name, schedule_id|null,
  revoked_at?, revoked_by?, revoke_reason? }`. There is no delete —
  `POST /api/calendar-exceptions/:id/revoke { reason }` keeps the row as
  history; revoked rows render dimmed with their reason. Create/revoke
  responses may include `affected_future_requests[]` — shown as a notice with
  request numbers when present.
- `UserListItem`: `{ id, email, display_name, active, employee|null,
  roles: { id, role, scope_org_unit_id, scope_name }[], version,
  allowed: { grant_roles: Role[], link_employee: boolean } }`. The role
  grant/revoke buttons and the employee-link dialog render only for actions
  listed in `allowed` — the UI does not infer permissions from the viewer's
  role. Role deletion is `DELETE /api/role-grants/:id` using `role.id`;
  linking sends `PUT /api/users/:id { employee_id, expected_version }`.
- `Delegation`: `{ id, from_user: UserRef, to_user: UserRef, scope, valid_from,
  valid_to, reason|null, revoked_at|null }`. Scope values offered in the form:
  `manager_recommendation`, `hr_check`, `final_decision`, `all_approvals`.
- `Adjustment`: `{ id, employee, leave_type, period_year, minutes, reason,
  basis_document, status: 'proposed'|'applied'|'rejected', balance_before,
  balance_after_if_applied, proposed_by, decided_by, decided_at, created_at,
  minutes_per_day? }` (mpd defaults to 480 when absent).
- `ExportBatch`: `{ id, from, to, org_unit: {id,name}|null, row_count, sha256,
  created_at, status?, transferred_at?, transferred_by? }` — `org_unit` null
  means the export covered the whole service; the list shows the scope and the
  transferred state. `POST /api/exports` takes `{ from, to, org_unit_id? }`
  and `changes-since-export` takes `org_unit_id`.
- `ImportBatch` history rows: `{ id, kind, status, rows_total?, applied?,
  created_at }` — missing fields render as `—`.
- `GET /api/ops/summary`: rendered generically (key/value tree) since no shape
  is pinned.
- Report JSON responses (`/api/reports/*?format=json`): rows are rendered in a
  generic table built from the keys of the returned objects
  (`GenericTable`, `extractRows`). If the shape changes the report still works,
  only column headings change.

## Behavioural assumptions

- `RequestDetail.in_force_revision` (contract): the revision actually in
  force for an approved/cancelled leave request — it may live on an approved
  amendment, so it is not always in `revisions[]`. The detail page and the
  printable card render dates/days/totals from it (`inForceRevision` in
  `src/lib/domain.ts`), amendments/cancellations show their own proposal next
  to `parent_in_force_revision` (“Now in force”), and the superseded original
  appears only in the revision history table. The card also links the approved
  child request whose decisions brought the revision into force.
- `POST /api/requests/:id/actual` with `action: 'propose_adjustment'` sends
  `worked_dates: string[]` (days inside the in-force revision that were
  actually worked). The per-account minutes preview is computed client-side
  from `DayRow.allocations` (`workedMinutesByAccount`). The response is
  assumed to carry the created adjustment ids as `created_adjustment_ids` or
  `adjustments` — either is read for the confirmation notice.
- `POST /api/accruals/run` takes `month` (1–12) only when the policy version
  in force for `period_year` is `accrual_mode: 'monthly'`
  (`accrualPolicyForYear` in `src/lib/domain.ts`); for `annual_upfront`/
  `none` the field is omitted entirely.
- Idempotency-Key: every mutating POST that the contract lists sends a key
  generated once per user intent (per modal open / per form / per row action).
  The same key is reused only while the result is unconfirmed (network
  error, `ApiError.status === 0`); a definitive server error ends the intent
  and the next attempt gets a fresh key. `ErrBox` words status-0 failures as
  “We could not confirm the action — check whether it took effect before
  retrying”, never as a definite failure.
- `stale_version` (409) is shown as “Someone else changed this — reload the
  form and try again”; `expected_version` is sent on `PUT /api/leave-types/:id`,
  `PUT /api/employees/:id`, `PUT /api/users/:id` and all request mutations.
- Attachment `scan_status` renders in words: Clean / Quarantined — not
  downloadable / Scan failed — not downloadable / Scan pending. A 503
  `scanner_unavailable` is shown as “File scanning is unavailable, so uploads
  are refused for safety.”

- `revise` (allowed action on submitted/under_review) is implemented through
  `POST /requests/:id/respond` with `changes` — API.md only documents `changes`
  under `respond`, and lists `revise` as a separate allowed action.
- Reassign needs a user list. The dialog tries `GET /api/users`; if that is
  forbidden for the caller (e.g. HR is not tech_admin), it falls back to a
  numeric `assignee_user_id` input.
- “Age” on the Approvals queue is computed from `updated_at` against the
  business date (no `created_at` on `RequestSummary`).
- `POST /api/demo/login` is used both for the initial persona pick and for
  “Switch persona” while signed in.
- Attachments upload (`POST /requests/:id/attachments`) returns
  `AttachmentMeta`; the page reloads the request afterwards.
- `GET /api/requests/:id/card` returns a `RequestDetail` subset; the print page
  renders defensively around optional fields.
- CSV downloads (`/api/reports/*?format=csv`, `/api/exports/:id/download`) are
  plain `<a>`/`window.open` GETs — cookies are same-origin so no extra headers
  are needed.

## Deliberate product choices

- Team calendar is visible to every signed-in user (spec §10: colleagues see
  name + “Away”). The server still decides per-request visibility via
  `request_id` and the `label` field.
- Bundle is a single chunk (no code splitting) to keep the Rust binary embed
  simple; 112 KB gzipped JS.

## End-to-end test (Playwright)

`e2e/main-scenario.spec.ts` walks scenario steps 1–5 (balance → request →
three-step approval → amendment → time travel) against a **running** stack.
It is not part of `npm test`.

```bash
# 1. backend (fresh data dir so seeded balances start at 20 days)
NLD_MODE=demo NLD_BIND=127.0.0.1:18080 NLD_DATA_DIR=/tmp/nld-fe-data \
  NLD_PUBLIC_URL=http://127.0.0.1:5173 /tmp/nauru-leave-snapshot serve

# 2. dev server with the /api proxy pointed at that backend
cd frontend && NLD_API=http://127.0.0.1:18080 npx vite --host 127.0.0.1

# 3. in another shell
cd frontend && npm run e2e        # E2E_BASE=http://127.0.0.1:5173 by default
```

Browsers: `npx playwright install chromium` once if chromium is not cached.
The scenario mutates the sandbox (it creates/approves requests and moves the
business date to 2026-11-12), so re-run it only after `POST /api/demo/reset`
or a fresh `NLD_DATA_DIR`. The demo backend rate-limits bursts; the spec
waits and retries when it sees `rate_limited`.
