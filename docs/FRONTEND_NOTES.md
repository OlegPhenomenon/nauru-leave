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
- `PolicyVersion`: fields from the POST body plus `id` and `status`
  (`'demo_fictional'|'verified'|…`). The Settings tab shows the
  “Fictional demo rule” badge when `status === 'demo_fictional'` and a Verify
  button when it is not `'verified'`.
- `Schedule`: `{ id, name, versions?: ScheduleVersion[] }`;
  `ScheduleVersion.week` is either `{mon..sun: minutes}` or `number[7]`
  (both rendered). POST `/api/schedules` body is
  `{ name, valid_from, week }`; POST `/api/schedules/:id/versions` is
  `{ valid_from, week }`.
- `CalendarException`: `{ id, date, minutes, name, schedule_id|null }`.
  POST/DELETE responses may include `affected_future_requests[]` — shown as a
  notice with request numbers when present.
- `UserListItem`: `{ id, email, display_name, active, employee|null,
  roles: { id, role, scope_org_unit_id, scope_name }[] }`. Role deletion is
  `DELETE /api/role-grants/:id` using `role.id`.
- `Delegation`: `{ id, from_user: UserRef, to_user: UserRef, scope, valid_from,
  valid_to, reason|null, revoked_at|null }`. Scope values offered in the form:
  `manager_recommendation`, `hr_check`, `final_decision`, `all_approvals`.
- `Adjustment`: `{ id, employee, leave_type, period_year, minutes, reason,
  basis_document, status: 'proposed'|'applied'|'rejected', balance_before,
  balance_after_if_applied, proposed_by, decided_by, decided_at, created_at,
  minutes_per_day? }` (mpd defaults to 480 when absent).
- `ExportBatch`: `{ id, from, to, row_count, sha256, created_at,
  transferred_at?, transferred_by? }` — “Mark transferred” hidden once
  `transferred_at` is set.
- `ImportBatch` history rows: `{ id, kind, status, rows_total?, applied?,
  created_at }` — missing fields render as `—`.
- `GET /api/ops/summary`: rendered generically (key/value tree) since no shape
  is pinned.
- Report JSON responses (`/api/reports/*?format=json`): rows are rendered in a
  generic table built from the keys of the returned objects
  (`GenericTable`, `extractRows`). If the shape changes the report still works,
  only column headings change.

## Behavioural assumptions

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
