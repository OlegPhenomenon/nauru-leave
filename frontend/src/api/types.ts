// Types mirroring docs/API.md. Fields marked with (assumed) are not pinned down
// by the contract; see docs/FRONTEND_NOTES.md.

export type Role =
  | 'hr'
  | 'hr_medical'
  | 'final_approver'
  | 'adjustment_approver'
  | 'tech_admin'
  | 'auditor';
export type Part = 'full' | 'am' | 'pm';
export type Status =
  | 'draft'
  | 'submitted'
  | 'needs_information'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'cancelled';
export type Kind = 'leave' | 'amendment' | 'cancellation';
export type DatePhase = 'upcoming' | 'in_progress' | 'period_ended';
export type StepKind = 'manager_recommendation' | 'hr_check' | 'final_decision';
export type Outcome =
  | 'recommend_approve'
  | 'recommend_reject'
  | 'checked_ok'
  | 'checked_problem'
  | 'approve'
  | 'reject'
  | 'needs_information';

export interface UserRef {
  id: number;
  display_name: string;
}
export interface EmployeeRef {
  id: number;
  service_id: string;
  full_name: string;
  org_unit: { id: number; name: string } | null;
}

export interface Me {
  user: UserRef & { email: string };
  employee: EmployeeRef | null;
  roles: { role: Role; scope_org_unit_id: number | null; scope_name: string }[];
  is_manager: boolean;
  acting_for: { delegation_id: number; from: UserRef; scope: string; valid_to: string }[];
  csrf_token: string;
  totp_ok: boolean;
}

export interface AppConfig {
  mode: 'demo' | 'production';
  business_date: string;
  app_version: string;
  sandbox_id?: string;
}

export interface LeaveTypeRef {
  id: number;
  code: string;
  name: string;
}

export interface AccountBalance {
  account_id: number;
  leave_type: LeaveTypeRef;
  period_year: number;
  ledger_minutes: number;
  reserved_minutes: number;
  available_minutes: number;
  minutes_per_day: number;
}

export interface BalanceSummary {
  leave_type: LeaveTypeRef & { uses_balance: boolean };
  ledger_minutes: number;
  reserved_minutes: number;
  available_minutes: number;
  approved_upcoming_minutes: number;
  taken_minutes: number;
  minutes_per_day: number;
  accounts: AccountBalance[];
  policy: PolicyVersion | null;
}

export type LedgerKind =
  | 'opening'
  | 'accrual'
  | 'consumption'
  | 'return'
  | 'adjustment'
  | 'carryover_expiry'
  | 'historical';

export interface LedgerEntry {
  id: number;
  account_id: number;
  period_year: number;
  minutes: number;
  kind: LedgerKind;
  effective_date: string;
  basis: string;
  request_number: string | null;
  revision_no: number | null;
  author: UserRef | null;
  created_at: string;
  running_total: number;
}

export interface Reservation {
  id: number;
  account_id: number;
  period_year: number;
  minutes: number;
  request_number: string;
  revision_no: number;
  created_at: string;
}

export interface DayRow {
  date: string;
  part: Part | 'none';
  scheduled_minutes: number;
  minutes: number;
  period_year: number;
  explanation: string;
  allocations: {
    account_id: number;
    period_year: number;
    minutes: number;
    carryover: boolean;
  }[];
}

export interface Revision {
  id: number;
  rev_no: number;
  leave_type: (LeaveTypeRef & { sensitive: boolean }) | null;
  start_date: string;
  end_date: string;
  start_part: Part;
  end_part: Part;
  note: string | null;
  change_reason: string | null;
  total_minutes: number;
  created_by: UserRef;
  created_at: string;
  submitted_at: string | null;
  days: DayRow[];
}

export interface Step {
  id: number;
  seq: number;
  kind: StepKind;
  revision_no: number;
  status: 'waiting' | 'pending' | 'done' | 'superseded' | 'closed';
  assignee: UserRef | null;
  eligible_description: string;
  problem: string | null;
  outcome: Outcome | null;
  completed_at: string | null;
}

export interface Decision {
  id: number;
  step_id: number;
  step_kind: StepKind;
  revision_no: number;
  actor: UserRef;
  acting_for: UserRef | null;
  authority: string;
  outcome: Outcome;
  reason: string | null;
  basis_document: string | null;
  created_at: string;
}

export interface Message {
  id: number;
  kind: 'comment' | 'question' | 'answer' | 'system';
  author: UserRef | null;
  body: string;
  created_at: string;
}

export interface AttachmentMeta {
  id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  sensitivity: 'normal' | 'medical';
  scan_status: 'pending' | 'clean' | 'quarantined' | 'scan_failed';
  scan_note: string | null;
  uploaded_by: UserRef;
  created_at: string;
  can_download: boolean;
}
export type AttachmentItem = AttachmentMeta | { id: number; restricted: true };

export interface RequestSummary {
  id: number;
  number: string;
  kind: Kind;
  status: Status;
  status_label: string;
  date_phase: DatePhase | null;
  employee: EmployeeRef;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  total_minutes: number;
  minutes_per_day: number;
  next_action: string | null;
  source: 'self' | 'paper';
  updated_at: string;
  version: number;
}

export type AllowedAction =
  | 'edit'
  | 'delete'
  | 'submit'
  | 'withdraw'
  | 'respond'
  | 'revise'
  | 'decide'
  | 'amend'
  | 'cancel'
  | 'comment'
  | 'upload'
  | 'reassign'
  | 'confirm_actual'
  | 'propose_actual_adjustment'
  | 'print';

export interface Warning {
  code: 'late_notice' | 'team_overlap' | 'schedule_drift' | 'unassigned_step';
  message: string;
  details?: unknown;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor: UserRef | null;
  acting_for: UserRef | null;
  action: string;
  entity: string;
  entity_id: number | null;
  details: unknown;
}

export interface RequestDetail extends RequestSummary {
  parent: { id: number; number: string } | null;
  children: { id: number; number: string; kind: Kind; status: Status }[];
  previous_request: { id: number; number: string } | null;
  entered_by: UserRef;
  paper_received_date: string | null;
  current_revision: Revision;
  effective_revision: Revision | null;
  // Revision actually in force for an approved/cancelled leave request
  // (may belong to an approved amendment); null otherwise.
  in_force_revision: Revision | null;
  // For amendment/cancellation requests: the parent's in-force revision,
  // shown next to this request's own "proposed" revision.
  parent_in_force_revision: Revision | null;
  revisions: Revision[];
  steps: Step[];
  decisions: Decision[];
  messages: Message[];
  attachments: AttachmentItem[];
  reservations: Reservation[];
  ledger_entries: LedgerEntry[];
  actual: { confirmed_by: UserRef; confirmed_at: string; note: string | null } | null;
  warnings: Warning[];
  allowed_actions: AllowedAction[];
  decidable_step: {
    id: number;
    kind: StepKind;
    outcomes: Outcome[];
    acting_for: UserRef | null;
  } | null;
  audit: AuditEvent[];
}

export interface DraftInput {
  employee_id?: number;
  leave_type_id: number;
  start_date: string;
  end_date: string;
  start_part: Part;
  end_part: Part;
  note?: string;
  source?: 'self' | 'paper';
  paper_received_date?: string;
  previous_request_id?: number;
}

export interface Preview {
  days: DayRow[];
  total_minutes: number;
  minutes_per_day: number;
  balance_after: {
    period_year: number;
    available_before: number;
    available_after: number;
  }[];
  route: { kind: StepKind; who: string; problem: string | null }[];
  warnings: Warning[];
  errors: { code: string; message: string }[];
  policy: PolicyVersion | null;
}

// --- Session & demo ---

export interface DemoStatus {
  has_sandbox: boolean;
  sandbox_id?: string;
  created_at?: string;
}

export interface Persona {
  user_id: number;
  display_name: string;
  title: string;
  roles: string[];
  story: string;
}

export interface MailboxItem {
  id: number;
  to_email: string;
  subject: string;
  body: string;
  delivered_at: string;
}

export interface ExplainResponse {
  entries: LedgerEntry[];
  reservations: Reservation[];
  summary: BalanceSummary;
}

export interface ListResp<T> {
  items: T[];
  total: number;
}

export interface ApprovalsResp {
  items: (RequestSummary & {
    step: Step;
    acting_for: UserRef | null;
    warnings: Warning[];
  })[];
  problems: (RequestSummary & { problem: string })[];
}

// --- Team calendar ---

export interface CalendarAbsence {
  date: string;
  part: Part;
  state: 'approved' | 'pending';
  label: string;
  request_id: number | null;
}
export interface CalendarResp {
  from: string;
  to: string;
  org_units: { id: number; name: string }[];
  people: { employee: EmployeeRef; absences: CalendarAbsence[] }[];
  counts: { date: string; approved: number; pending: number }[];
}

// --- People (assumed shapes where API.md is silent) ---

export interface OrgUnit {
  id: number;
  code: string;
  name: string;
  parent_id: number | null;
  active: boolean;
  version?: number;
}

export interface EmployeeListItem extends EmployeeRef {
  email: string | null;
  start_date: string;
  end_date: string | null;
  active: boolean;
  manager: EmployeeRef | null;
  schedule: { id: number; name: string } | null;
  has_login: boolean;
}

export interface EmployeeDetail extends EmployeeListItem {
  version: number;
  assignments: {
    id: number;
    org_unit: { id: number; name: string } | null;
    manager: EmployeeRef | null;
    valid_from: string;
    valid_to: string | null;
  }[];
  schedules: {
    id: number;
    schedule: { id: number; name: string } | null;
    valid_from: string;
    valid_to: string | null;
  }[];
  user: (UserRef & { email: string }) | null;
  balances?: BalanceSummary[];
}

// --- Balances & adjustments ---

export interface BalanceRow {
  employee: EmployeeRef;
  summary: BalanceSummary;
}

export interface Adjustment {
  id: number;
  employee: EmployeeRef;
  leave_type: LeaveTypeRef;
  period_year: number;
  minutes: number;
  reason: string;
  basis_document: string | null;
  status: 'proposed' | 'applied' | 'rejected';
  balance_before: number;
  balance_after_if_applied: number;
  proposed_by: UserRef;
  decided_by: UserRef | null;
  decided_at: string | null;
  created_at: string;
  minutes_per_day: number;
}

// --- Leave types / policies / schedules / holidays ---

export interface PolicyVersion {
  id: number;
  valid_from: string;
  annual_entitlement_min: number;
  accrual_mode: string;
  advance_publish_months: number;
  carryover_allowed: boolean;
  // null = carry-over never expires; 0 = expires at the start of the next year.
  carryover_expiry_months: number | null;
  // null = no limit on the carry-over balance kept when a period closes.
  carryover_limit_min: number | null;
  allow_negative: boolean;
  // Versioned conditions (moved off the leave type; effective from valid_from).
  paid: boolean;
  uses_balance: boolean;
  allow_half_day: boolean;
  requires_attachment: boolean;
  min_notice_days: number;
  // false for versions whose valid_from is still in the future.
  in_force: boolean;
  explanation: string;
  status: string; // 'demo_fictional' | 'verified' | ...
  verified_by?: UserRef | null;
  verified_at?: string | null;
}

export interface LeaveType {
  id: number;
  code: string;
  name: string;
  sensitive: boolean;
  // Condition flags computed from the policy in force on the business date.
  paid: boolean;
  uses_balance: boolean;
  allow_half_day: boolean;
  requires_attachment: boolean;
  min_notice_days: number;
  active: boolean;
  version: number;
  policy: PolicyVersion | null;   // the version in force, if any
  policies: PolicyVersion[];      // all versions; future ones have in_force=false
}

export interface ScheduleWeek {
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
  sat: number;
  sun: number;
}
export interface ScheduleVersion {
  id: number;
  valid_from: string;
  week: ScheduleWeek | number[];
}
export interface Schedule {
  id: number;
  name: string;
  active?: boolean;
  versions?: ScheduleVersion[];
}

export interface CalendarException {
  id: number;
  date: string;
  minutes: number;
  name: string;
  schedule_id: number | null;
  // Revoked rows stay as history; new calculations ignore them.
  revoked_at?: string | null;
  revoked_by?: UserRef | null;
  revoke_reason?: string | null;
}
export interface ExceptionMutationResp {
  exception?: CalendarException;
  revoked?: boolean;
  affected_future_requests?: { id: number; number: string }[];
}

// --- Users & delegations ---

export interface RoleGrant {
  id: number;
  role: Role;
  scope_org_unit_id: number | null;
  scope_name: string;
}
export interface UserListItem {
  id: number;
  email: string;
  display_name: string;
  active: boolean;
  employee: EmployeeRef | null;
  roles: RoleGrant[];
  version: number;
  // What the current user may do TO this user (server-computed).
  allowed: { grant_roles: Role[]; link_employee: boolean };
}

export interface Delegation {
  id: number;
  from_user: UserRef;
  to_user: UserRef;
  scope: string;
  valid_from: string;
  valid_to: string;
  reason: string | null;
  revoked_at: string | null;
}

// --- Reports / exports / imports ---

export interface ExportBatch {
  id: number;
  from: string;
  to: string;
  // null = whole service; otherwise the export only covers this unit.
  org_unit?: { id: number; name: string } | null;
  row_count: number;
  sha256: string;
  created_at: string;
  status?: string;
  transferred_at?: string | null;
  transferred_by?: UserRef | null;
  note?: string | null;
}

export interface ImportRow {
  line: number;
  data: unknown;
  errors: string[];
}
export interface ImportPreview {
  batch_id: number;
  rows: ImportRow[];
  rows_total: number;
  rows_valid: number;
}
export interface ImportBatch {
  id: number;
  kind: string;
  status: string;
  filename?: string | null;
  rows_total?: number;
  rows_valid?: number;
  applied?: number;
  created_at: string;
}

// --- Operations ---

export interface NotificationItem {
  id: number;
  to_email: string;
  subject: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
}
