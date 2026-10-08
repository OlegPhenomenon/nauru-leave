# Backend core — public API summary

Domain library `nauru-leave` (crate root `backend/src/lib.rs`). Everything the
HTTP layer needs lives here; no HTTP code exists yet. All types are `i64`
minutes — never floats. `Res<T> = Result<T, DomainError>`; map errors with
`err.code()` / `err.http_status()` (1:1 to DESIGN §12 codes).

General calling convention for mutations:

```rust
let clock = Clock::demo();                    // or Clock::production()
let today = clock.today(&conn)?;              // business date
let actor = Actor::load(&conn, user_id, today)?;  // roles, manages, delegations
// then call the domain function with (&mut conn, &clock, &actor, ...)
```

Every mutating function below already does: `BEGIN IMMEDIATE` transaction,
authorization via `authz`, `expected_version` optimistic check, audit event,
outbox notification — the handler only needs session→user_id resolution.

## `db` — connections & transactions

```rust
pub fn open(path: &Path) -> Res<Connection>           // WAL, foreign_keys, busy_timeout 5000
pub fn open_memory() -> Res<Connection>
pub fn schema_version(conn: &Connection) -> Res<u32>
pub fn migrate(conn: &Connection) -> Res<u32>         // applies embedded migrations
pub fn write_tx<T>(conn: &mut Connection, f: impl FnOnce(&Transaction) -> Res<T>) -> Res<T>
```

## `clock`

```rust
pub enum Mode { Demo, Production }
pub struct Clock { /* opaque */ }
impl Clock {
    pub fn demo() -> Self;                            // business date = settings.demo_today
    pub fn production() -> Self;                      // real UTC date
    pub fn fixed(today: Date) -> Self;                // tests / seed time-travel
    pub fn fixed_at(today: Date, now: OffsetDateTime) -> Self;
    pub fn today(&self, conn: &Connection) -> Res<Date>;
    pub fn now(&self) -> OffsetDateTime;
    pub fn now_ts(&self) -> String;                   // RFC3339 UTC for created_at
}
```

## `model` — row types & loaders

Enums: `Part { Full, Am, Pm }` (`as_str`/`parse`/`overlaps`),
`RequestStatus` (draft→…→cancelled, `is_open`), `RequestKind`
(`leave|amendment|cancellation`), `StepKind` (`manager_recommendation`,
`hr_check`, `final_decision`; `valid_outcomes()`, `delegation_scope()`).
`outcome_needs_reason(outcome) -> bool`.

Structs (plain field bags): `LeaveType, Policy, Employee, User, Assignment,
RoleGrant, Delegation, LeaveRequest, Revision, RequestDay, Allocation,
Reservation, Step, Decision, Attachment, Adjustment`.

```rust
pub fn parse_date(s: &str) -> Res<Date>;  pub fn date_s(d: &Date) -> String;
pub fn add_months(d: Date, months: i64) -> Date;
pub fn load_leave_type / load_employee / load_user / load_request /
    load_revision / load_step  (conn, id) -> Res<T>
pub fn policy_for(conn, leave_type_id, on: Date) -> Res<Option<Policy>>
pub fn assignment_at(conn, employee_id, date) -> Res<Option<Assignment>>
pub fn manager_at(conn, employee_id, date) -> Res<Option<Employee>>
pub fn unit_of(conn, employee_id, date) -> Res<Option<i64>>
pub fn direct_reports(conn, manager_employee_id, date) -> Res<Vec<i64>>
pub fn unit_in_scope(conn, scope: Option<i64>, unit_id: Option<i64>) -> Res<bool>
pub fn valid_grants(conn, user_id, date) -> Res<Vec<RoleGrant>>
pub fn delegations_to(conn, user_id, date) -> Res<Vec<Delegation>>
pub fn has_delegation(conn, from_user, to_user, scope, date) -> Res<Option<Delegation>>
pub fn revision_days(conn, revision_id) -> Res<Vec<RequestDay>>
pub fn revision_allocations(conn, revision_id) -> Res<Vec<Allocation>>
pub fn allocation_totals(conn, revision_id) -> Res<BTreeMap<i64 /*account*/, i64 /*min*/>>
pub fn steps_of(conn, request_id) -> Res<Vec<Step>>
pub fn decisions_of(conn, request_id) -> Res<Vec<Decision>>
pub fn bump_version(conn, request_id, now_ts) -> Res<()>
pub fn check_version(req, expected: i64) -> Res<()>            // StaleVersion
pub fn open_child(conn, parent_id) -> Res<Option<LeaveRequest>>
pub fn family_ids(conn, request_id) -> Res<Vec<i64>>           // parent + amendments/cancellations
```

## `authz` — the single gate

```rust
pub struct Actor { user_id, employee_id, roles, manages, delegations_in, today }
impl Actor {
    pub fn load(conn: &Connection, user_id: i64, today: Date) -> Res<Actor>;
    pub fn has_role(&self, role: &str) -> bool;
    pub fn role_in_scope(&self, conn, role: &str, unit_id: Option<i64>) -> Res<bool>;
    pub fn any_role_in_scope(&self, conn, roles: &[&str], unit_id: Option<i64>) -> Res<bool>;
    pub fn is_manager_of(&self, employee_id: i64) -> bool;
}
pub enum Action { ViewRequest, CreateDraft, CreatePaper, EditDraft, DeleteDraft,
    Submit, Withdraw, Respond, Revise, DecideStep, Amend, CancelRequest, Comment,
    UploadAttachment, DownloadAttachment, ReassignStep, ConfirmActual,
    ProposeAdjustment, DecideAdjustment, RunAccrual, ClosePeriod, ViewBalances,
    TransferEmployee, ManageDelegations, RetryNotification, ViewAudit }
pub enum Resource<'a> { Request(&'a RequestCtx),
    Step { request: &'a RequestCtx, step: &'a Step },
    Attachment(&'a AttachmentCtx),
    Employee { employee_id: i64, org_unit_id: Option<i64> }, Global }
pub fn can(conn, actor, action, res) -> Res<()>          // Err = 403/self_approval_forbidden
pub fn require(conn, actor, action, res) -> Res<()>      // alias of can
pub fn view_level(conn, actor, req: &RequestCtx) -> Res<ViewLevel>   // Full|Restricted
pub struct Authority { pub acting_for_user_id: Option<i64>, pub label: String }
pub fn decide_authority(conn, actor, req: &RequestCtx, step: &Step) -> Res<Authority>
```

`RequestCtx`/`AttachmentCtx` are built by `requests::request_ctx` /
`requests::attachment_ctx`. `decide_authority` returns *how* the actor may
decide (assignee / unassigned-kind rule / delegation) and enforces the
self-approval ban including delegation (`SelfApprovalForbidden`).

## `requests` — the lifecycle (DESIGN §4–§5)

```rust
pub struct DraftInput { employee_id: Option<i64>, leave_type_id, start_date,
    end_date, start_part: Part, end_part: Part, note: Option<String>,
    paper: bool, paper_received_date: Option<Date>, previous_request_id: Option<i64> }
pub struct ReviseInput { leave_type_id, start_date, end_date, start_part,
    end_part, note: Option<String>, change_reason: String }
pub struct Submitted  { request_id, number, version }          // serde
pub struct ChildCreated { request_id, number }                 // serde
pub struct Preview { days: Vec<ComputedDay>, total_minutes,
    allocations: Vec<DayAllocationView>, balance_after: Vec<BalanceAfter>,
    route: Vec<RouteStep>, warnings: Vec<Warn>, errors: Vec<PreviewError> }

pub fn request_ctx(conn, req: &LeaveRequest, today) -> Res<RequestCtx>
pub fn attachment_ctx(conn, attachment_id, today) -> Res<AttachmentCtx>

pub fn create_draft(conn, clock, actor, input: &DraftInput) -> Res<i64>
pub fn update_draft(conn, clock, actor, request_id, input: &DraftInput, expected_version) -> Res<()>
pub fn delete_draft(conn, clock, actor, request_id, expected_version) -> Res<()>
pub fn preview(conn, clock, actor, input: &DraftInput,
    amend_of: Option<i64>, cancel_of: Option<(i64, Date, Date)>) -> Res<Preview>
pub fn submit(conn, clock, actor, request_id, expected_version,
    idempotency_key: Option<&str>) -> Res<Submitted>
pub fn decide(conn, clock, actor, request_id, step_id, outcome: &str,
    reason: Option<&str>, basis_document: Option<&str>, expected_version,
    idempotency_key: Option<&str>) -> Res<()>
pub fn respond(conn, clock, actor, request_id, expected_version, body: &str,
    changes: Option<ReviseInput>) -> Res<()>
pub fn withdraw(conn, clock, actor, request_id, reason: Option<&str>, expected_version) -> Res<()>
pub fn amend(conn, clock, actor, parent_id, input: &ReviseInput, expected_version,
    idempotency_key: Option<&str>) -> Res<ChildCreated>
pub fn cancel(conn, clock, actor, parent_id, from_date: Date, to_date: Date,
    change_reason: &str, expected_version, idempotency_key: Option<&str>) -> Res<ChildCreated>
pub fn reassign(conn, clock, actor, request_id, step_id,
    assignee_user_id: Option<i64>, expected_version) -> Res<()>
pub fn comment(conn, clock, actor, request_id, body: &str) -> Res<()>
pub fn upload_attachment(conn, clock, actor, store: &FileStore, request_id,
    filename: &str, bytes: &[u8], sensitivity: &str) -> Res<i64>   // "normal"|"medical"
pub fn actual_period(conn, clock, actor, request_id,
    action: &str /* "confirm"|"propose_adjustment" */, note: &str,
    minutes_delta: Option<i64>, basis_document: Option<&str>, expected_version)
    -> Res<Option<i64>>                                          // adjustment id
pub fn unassigned_steps(conn) -> Res<Vec<(request_id, step_id, kind)>>
pub fn date_phase(req, eff: &Revision, today) -> Option<&'static str>
    // "upcoming" | "in_progress" | "period_ended"
pub fn pending_step(conn, request_id) -> Res<Option<Step>>
```

Notes for the HTTP layer:

- `Idempotency-Key` header → `idempotency_key`; replay returns the stored
  response, same key + different body → `idempotency_key_reused` (422).
- `expected_version` comes from the client (`If-Match`/body); mismatch → 409.
- `decide` outcomes per step kind: `manager_recommendation` →
  `recommend_approve|recommend_reject|needs_information`; `hr_check` →
  `checked_ok|checked_problem|needs_information`; `final_decision` →
  `approve|reject|needs_information`. `needs_information` keeps the step
  pending and flips the request to `needs_information`; the employee's
  `respond` (text or material change → new immutable revision) resumes it.
- Amendments/cancellations are full requests with their own route; approving
  them posts per-account deltas and switches `parent.effective_revision_id`
  (or `parent.status='cancelled'` when nothing remains). Cancellations never
  mutate the parent's days — they carry their own revision where cancelled
  days are `part='none', minutes=0, explanation="Cancelled by <number>"`.
- Attachments: magic-byte check (PDF/PNG/JPEG), ≤2 MiB (`MAX_ATTACHMENT_BYTES`),
  ≤5 per request, EICAR → `quarantined` (undownloadable). The file is written
  via `FileStore` before the row commits.

## `ledger` — accounts, postings, accrual, adjustments (DESIGN §3)

```rust
pub fn ensure_account(conn, employee_id, leave_type_id, period_year) -> Res<i64>
pub fn balance_at(conn, account_id, date) -> Res<i64>      // SUM eff<=date
pub fn reserved(conn, account_id) -> Res<i64>              // active reservations
pub fn available(conn, account_id, today) -> Res<i64>      // balance − reserved
pub fn balance_summary(conn, employee_id, leave_type_id, today) -> Res<Vec<AccountBalance>>
pub fn totals(conn, employee_id, leave_type_id, today) -> Res<(ledger, reserved, available)>
pub fn allocate(conn, employee_id, leave_type_id, days: &[ComputedDay], today,
    extra_available: &BTreeMap<i64,i64>) -> Res<Vec<DayAllocation>>
    // own-year account first, then carryover oldest-first, else InsufficientBalance
pub fn post_entry(conn, e: &PostEntry, now_ts) -> Res<PostOutcome>   // op_key idempotent
pub fn create_reservation / release_reservations (conn, request_id, ...)
pub fn run_accrual(conn, clock, actor, leave_type_id, period_year,
    month: Option<i64>) -> Res<AccrualRun { posted, skipped_existing }>
pub fn close_period(conn, clock, actor, leave_type_id, period_year) -> Res<usize>
    // carryover_expiry entries once the grace window passed; idempotent
pub fn propose_adjustment(conn, clock, actor, employee_id, leave_type_id,
    period_year, minutes, reason, basis_document, request_id) -> Res<i64>
pub fn decide_adjustment(conn, clock, actor, adjustment_id, apply: bool, note) -> Res<()>
    // proposer != approver (two-person rule)
pub fn get_adjustment(conn, id) -> Res<Adjustment>
pub fn post_opening(conn, employee_id, leave_type_id, period_year, minutes,
    effective_date, basis, author, now_ts) -> Res<PostOutcome>
```

`PostEntry` fields: `account_id, minutes (signed), kind ("opening"|"accrual"|
"consumption"|"return"|"carryover_expiry"|"adjustment"|"import"), effective_date,
request_id, revision_id, reverses_entry_id, adjustment_id, import_batch_id,
basis, author_user_id, op_key`. `ledger_entries`, `decisions`,
`audit_events` reject UPDATE/DELETE by trigger.

## `calendar` — day math (DESIGN §2)

```rust
pub struct ComputedDay { date, part: String /* "full"|"am"|"pm"|"none" */,
    scheduled_minutes, minutes, period_year, schedule_version_id, exception_id,
    explanation: String }
pub fn compute_days(conn, employee_id, leave_type_id, start, end,
    start_part, end_part) -> Res<Vec<ComputedDay>>
pub fn find_overlap(conn, employee_id, days, exclude_request_ids)
    -> Res<Option<OverlapHit>>            // ignores part='none'/minutes=0
pub fn compute_checked(conn, employee_id, leave_type_id, start, end,
    start_part, end_part, exclude) -> Res<Vec<ComputedDay>>  // Err(Overlap)
```

## `people` — org/admin writers

```rust
pub fn create_org_unit(conn, code, name, parent_id) -> Res<i64>
pub fn create_user(conn, email, display_name, password: Option<&str>, now_ts) -> Res<i64>
pub fn create_employee(conn, service_id, full_name, email, user_id, start_date,
    org_unit_id, manager_employee_id, schedule_id, schedule_from, now_ts) -> Res<i64>
pub fn assign(conn, employee_id, org_unit_id, manager_employee_id, valid_from) -> Res<i64>
pub fn set_schedule(conn, employee_id, schedule_id, valid_from) -> Res<i64>
pub fn create_schedule(conn, name, valid_from, week: [i64;7], note) -> Res<(i64,i64)>
pub fn create_calendar_exception(conn, date, name, minutes, schedule_id, now_ts) -> Res<i64>
pub fn create_leave_type(conn, code, name, sensitive, paid, uses_balance,
    allow_half_day, requires_attachment, min_notice_days) -> Res<i64>
pub fn create_policy(conn, leave_type_id, valid_from, annual_entitlement_min,
    accrual_mode /* "annual_upfront"|"monthly"|"none" */, advance_publish_months,
    carryover_allowed, carryover_expiry_months: Option<i64>, allow_negative,
    explanation, status, created_by, now_ts) -> Res<i64>
pub fn grant_role(conn, user_id, role, scope_org_unit_id: Option<i64>,
    valid_from, valid_to: Option<Date>, granted_by, now_ts) -> Res<i64>
pub fn create_delegation(conn, clock, actor, from_user_id, to_user_id,
    scope, valid_from, valid_to, reason) -> Res<i64>
pub fn revoke_delegation(conn, clock, actor, delegation_id) -> Res<()>
pub fn transfer(conn, clock, actor, employee_id, org_unit_id,
    manager_employee_id: Option<i64>, valid_from, reassign_open_steps: bool) -> Res<()>
```

## `notify` — outbox (§8)

```rust
pub fn enqueue(conn, now_ts, event, request_id, revision_id,
    recipient: &Recipient, subject, body) -> Res<()>     // dedupe_key unique
pub fn recipient_for_employee(conn, employee_id) -> Res<Option<Recipient>>
pub fn recipient_for_user(conn, user_id) -> Res<Option<Recipient>>
pub trait Transport { fn deliver(&self, conn, n: &Notification) -> Res<()>; }
pub struct MailboxTransport;                              // demo: mailbox table;
                                                          // *@unreachable.demo fails
pub fn deliver_due(conn, transport: &dyn Transport, now: OffsetDateTime) -> Res<usize>
    // backoff 1/5/25/25 min, 5 attempts -> "gave_up"; failure never rolls back
pub fn retry(conn, clock, actor, notification_id) -> Res<()>   // hr/tech_admin
```

Notification bodies are deliberately minimal — never the leave type, reason or
dates; `link_path` is `/requests/<id>`.

## `audit` / `files`

```rust
pub fn audit::log(conn, now_ts, actor_user_id: Option<i64>,
    acting_for_user_id: Option<i64>, action, object_type, object_id: Option<i64>,
    data: serde_json::Value) -> Res<()>

pub fn files::sniff(bytes) -> Option<&'static str>       // magic bytes -> mime
pub const files::EICAR: &str;  pub fn files::looks_infected(bytes) -> bool
pub struct files::FileStore { pub dir: PathBuf }
impl FileStore { new(dir) / put(&bytes) -> Res<key> / get(key) / path(key) / remove(key) }
```

## `seed` / `backup`

```rust
pub fn seed::seed_template(conn: &mut Connection, files_dir: &Path) -> Res<()>
    // full demo template (docs/DEMO_DATA.md), ends at demo_today=2026-10-08

pub fn backup::gen_key(out: &Path) -> Res<()>            // 32 random bytes
pub fn backup::read_key(path: &Path) -> Res<[u8; 32]>
pub fn backup::backup(db_path, files_dir, key: &[u8;32], out) -> Res<()>
    // VACUUM INTO -> tar {db.sqlite, files/**} -> XChaCha20-Poly1305
pub fn backup::restore(archive, key: &[u8;32], target_dir) -> Res<()>
    // -> target_dir/main.sqlite + target_dir/files/**, clean dir required
```

## CLI (`src/bin` is `main.rs`)

```
nauru-leave migrate --db <path>
nauru-leave seed-template --out <db> [--files-dir <dir>]
nauru-leave gen-backup-key --out <file>
nauru-leave backup --db <path> --files-dir <dir> --key-file <f> --out <file>
nauru-leave restore --input <file> --key-file <f> --data-dir <dir>
```
