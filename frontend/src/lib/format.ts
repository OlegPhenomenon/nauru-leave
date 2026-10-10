// Duration and date formatting. All durations are integer minutes;
// minutes_per_day comes from the employee's schedule (default 480).
//
// User-facing rules: durations render in days (½-day steps), sub-day
// remainders in hours — never in minutes. Timestamps render in
// Pacific/Nauru local time with no zone suffix. Bare YYYY-MM-DD dates
// are calendar dates and never shift with the viewer's timezone.

const NAURU_ZONE = 'Pacific/Nauru';

export function fmtHours(minutes: number): string {
  const m = Math.abs(minutes);
  const sign = minutes < 0 ? '−' : '';
  if (m === 0) return '0 h';
  if (m % 60 === 0) return `${sign}${m / 60} h`;
  return `${sign}${(m / 60).toFixed(1)} h`;
}

function pluralDays(d: number): string {
  return d === 1 ? 'day' : 'days';
}

/** "one day", "two days" — for prose sentences. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  const form = n === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${n} ${form}`;
}

export function fmtDays(minutes: number, minutesPerDay = 480): string {
  const days = minutes / minutesPerDay;
  return `${days.toLocaleString('en', { maximumFractionDigits: 2 })} ${Math.abs(days) === 1 ? 'day' : 'days'}`;
}


/**
 * Render minutes as days/hours for a schedule day length.
 * 2400 @480 → "5 days"; 240 @480 → "½ day"; 4560 @480 → "9½ days";
 * 600 @480 → "1 day 2 h"; 0 → "0 days".
 * Never renders minutes to normal users; keeps the sign for corrections.
 */

export function fmtDuration(minutes: number, minutesPerDay = 480): string {
  const sign = minutes < 0 ? '−' : '';
  const m = Math.abs(minutes);
  if (m === 0) return '0 days';
  if (m === minutesPerDay * 0.5) return `${sign}½ day`;
  const days = Math.floor(m / minutesPerDay);
  const rem = m % minutesPerDay;
  if (rem === 0) return `${sign}${days} ${pluralDays(days)}`;
  if (rem * 2 === minutesPerDay) {
    return `${sign}${days}½ ${days === 0 ? 'day' : 'days'}`;
  }
  // Sub-day remainder: hours, never minutes. Whole hours when possible,
  // one decimal otherwise (90 min → "1.5 h").
  const remH = rem / 60;
  const remStr = Number.isInteger(remH) ? `${remH} h` : `${Math.round(remH * 10) / 10} h`;
  if (days === 0) return `${sign}${remStr}`;
  return `${sign}${days} ${pluralDays(days)} ${remStr}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDay(iso: string): { y: number; m: number; d: number } | null {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

/** "2026-11-09" → "9 Nov 2026". Input is a bare date, no timezone shift. */
export function fmtDate(iso: string): string {
  const p = parseDay(iso);
  if (!p) return iso;
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** "2026-11-09" → "Mon" */
export function fmtWeekday(iso: string): string {
  const p = parseDay(iso);
  if (!p) return '';
  return WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] ?? '';
}

/** "2026-11-09" → "Mon 9 Nov 2026" */
export function fmtDateFull(iso: string): string {
  const w = fmtWeekday(iso);
  return w ? `${w} ${fmtDate(iso)}` : fmtDate(iso);
}

/** "2026-10-19" → "Mon 19 Oct" — compact day label for lists. */
export function fmtDay(iso: string): string {
  const p = parseDay(iso);
  if (!p) return iso;
  const w = fmtWeekday(iso);
  return `${w ? `${w} ` : ''}${p.d} ${MONTHS[p.m - 1]}`;
}

/**
 * Date range: "2–13 Nov 2026" (same month/year),
 * "28 Oct – 2 Nov 2026" (same year), "30 Dec 2026 – 2 Jan 2027",
 * "9 Nov 2026" for a single day.
 */
export function fmtRange(from: string, to: string): string {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return `${from} – ${to}`;
  if (from === to) return fmtDate(from);
  const tail = b.d === a.d && b.m === a.m && b.y === a.y;
  if (tail) return fmtDate(to);
  const end = `${b.d} ${MONTHS[b.m - 1]}${b.y !== a.y ? ` ${b.y}` : ''}`;
  if (a.y === b.y && a.m === b.m) {
    return `${a.d}–${end} ${b.y}`;
  }
  const start = `${a.d} ${MONTHS[a.m - 1]}${a.y !== b.y ? ` ${a.y}` : ''}`;
  return `${start} – ${end}${a.y === b.y ? ` ${a.y}` : ''}`;
}

const nauruFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: NAURU_ZONE,
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** RFC3339 timestamp → "9 Nov 2026, 14:05" in Pacific/Nauru local time. */
export function fmtDateTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const parts = Object.fromEntries(
    nauruFmt.formatToParts(d).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const month = MONTHS[Number(parts['month']) - 1] ?? parts['month'];
  const hh = parts['hour'] === '24' ? '00' : parts['hour'];
  return `${Number(parts['day'])} ${month} ${parts['year']}, ${hh}:${parts['minute']}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whole days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(pb[0]!, pb[1]! - 1, pb[2]!) - Date.UTC(pa[0]!, pa[1]! - 1, pa[2]!)) / 86400000,
  );
}

export function todayPlus(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return t.toISOString().slice(0, 10);
}

/** Strip the display-only "(demo)" suffix seed data used to carry. */
export function orgUnitName(name: string): string {
  return name.replace(/\s*\(demo\)\s*$/, '');
}

/* ------------------------------------------------------------------ */
/* Label maps — internal enums → plain words. Never render a raw enum.  */
/* ------------------------------------------------------------------ */

const ROLE_LABELS: Record<string, string> = {
  employee: 'Employee',
  manager: 'Manager',
  hr: 'HR officer',
  hr_medical: 'HR (medical)',
  final_approver: 'Final approver',
  adjustment_approver: 'Second approver for corrections',
  tech_admin: 'Technical administrator',
  auditor: 'Auditor',
};
export function roleLabel(r: string): string {
  return ROLE_LABELS[r] ?? r.replaceAll('_', ' ');
}

const KIND_LABELS: Record<string, string> = {
  leave: 'Leave',
  amendment: 'Change request',
  cancellation: 'Cancellation request',
  change: 'Change request',
};
export function kindLabel(k: string): string {
  return KIND_LABELS[k] ?? k.replaceAll('_', ' ');
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  under_review: 'Waiting for approval',
  needs_information: 'Waiting for answer',
  approved: 'Approved',
  rejected: 'Refused',
  withdrawn: 'Withdrawn',
  cancelled: 'Cancelled',
  closed: 'Closed',
};
export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s.replaceAll('_', ' ');
}

const STEP_LABELS: Record<string, string> = {
  manager_recommendation: "Manager's recommendation",
  hr_check: 'HR check',
  final_decision: 'Final decision',
};
export function stepLabel(k: string): string {
  return STEP_LABELS[k] ?? k.replaceAll('_', ' ');
}

/** Outcome as an action verb for buttons ("Approve", "Refuse", "Ask a question"). */
const OUTCOME_ACTION_LABELS: Record<string, string> = {
  recommend_approve: 'Recommend approval',
  recommend_reject: 'Recommend refusal',
  checked_ok: 'Check — OK',
  checked_problem: 'Check — problem noted',
  approve: 'Approve',
  reject: 'Refuse',
  needs_information: 'Ask a question',
};
export function outcomeActionLabel(o: string): string {
  return OUTCOME_ACTION_LABELS[o] ?? o.replaceAll('_', ' ');
}

/** Outcome as past tense for timelines/history. */
const OUTCOME_HISTORY_LABELS: Record<string, string> = {
  recommend_approve: 'Recommended approval',
  recommend_reject: 'Recommended refusal',
  checked_ok: 'Checked — OK',
  checked_problem: 'Checked — problem noted',
  approve: 'Approved',
  reject: 'Refused',
  needs_information: 'Asked a question',
};
export function outcomeHistoryLabel(o: string): string {
  return OUTCOME_HISTORY_LABELS[o] ?? o.replaceAll('_', ' ');
}

/** Back-compat alias: past-tense outcome text. */
export function outcomeLabel(o: string): string {
  return outcomeHistoryLabel(o);
}

const PART_LABELS: Record<string, string> = {
  full: 'Full day',
  am: 'Morning',
  pm: 'Afternoon',
  none: 'Non-working',
};
export function partLabel(p: string): string {
  return PART_LABELS[p] ?? p.replaceAll('_', ' ');
}

const ACCRUAL_MODE_LABELS: Record<string, string> = {
  annual_upfront: 'Whole year on 1 January',
  monthly: 'Monthly',
  none: 'No allowance',
};
export function accrualModeLabel(m: string): string {
  return ACCRUAL_MODE_LABELS[m] ?? m.replaceAll('_', ' ');
}

const ADJUSTMENT_STATUS_LABELS: Record<string, string> = {
  proposed: 'Waiting for a second approver',
  applied: 'Applied',
  rejected: 'Refused',
};
export function adjustmentStatusLabel(s: string): string {
  return ADJUSTMENT_STATUS_LABELS[s] ?? s.replaceAll('_', ' ');
}

const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  queued: 'Waiting to send',
  retrying: 'Retrying',
  sent: 'Sent',
  failed: 'Failed — will retry',
  gave_up: 'Not delivered',
};
export function notificationStatusLabel(s: string): string {
  return NOTIFICATION_STATUS_LABELS[s] ?? s.replaceAll('_', ' ');
}

const IMPORT_KIND_LABELS: Record<string, string> = {
  employees: 'People',
  opening_balances: 'Opening balances',
  historical_leave: 'Historical leave',
};
export function importKindLabel(k: string): string {
  return IMPORT_KIND_LABELS[k] ?? k.replaceAll('_', ' ');
}

const IMPORT_STATUS_LABELS: Record<string, string> = {
  previewed: 'Checked',
  committed: 'Imported',
  discarded: 'Discarded',
  failed: 'Failed',
  duplicate: 'Duplicate — skipped',
};
export function importStatusLabel(s: string): string {
  return IMPORT_STATUS_LABELS[s] ?? s.replaceAll('_', ' ');
}

const DELEGATION_SCOPE_LABELS: Record<string, string> = {
  manager_recommendation: "Manager's recommendations",
  hr_check: 'HR checks',
  final_decision: 'Final decisions',
  all_approvals: 'All approvals',
};
export function delegationScopeLabel(s: string): string {
  return DELEGATION_SCOPE_LABELS[s] ?? s.replaceAll('_', ' ');
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  transferred: 'Transferred',
  previewed: 'Checked',
  committed: 'Imported',
  discarded: 'Discarded',
};
export function batchStatusLabel(s: string): string {
  return BATCH_STATUS_LABELS[s] ?? s.replaceAll('_', ' ');
}

/** Internal ledger/audit event kinds → plain balance wording. */
const LEDGER_KIND_LABELS: Record<string, string> = {
  accrual: 'Allowance added',
  carryover: 'Carried over',
  reservation: 'On hold — waiting for approval',
  release: 'Hold released',
  consumption: 'Leave taken',
  adjustment: 'Correction',
  correction: 'Correction',
  expiry: 'Expired',
};
export function ledgerKindLabel(k: string): string {
  return LEDGER_KIND_LABELS[k] ?? k.replaceAll('_', ' ');
}

/**
 * Date phase of a request → a short phrase, e.g. "starts in 11 days".
 * `phase` is the backend date_phase value; pass startDate + today to get
 * the "in N days" wording for upcoming leave.
 */
export function fmtPhase(
  phase: string | null | undefined,
  startDate?: string,
  today?: string,
): string {
  if (phase === 'in_progress') return 'on leave now';
  if (phase === 'period_ended') return 'ended';
  if (phase === 'upcoming') {
    if (startDate && today) {
      const n = daysBetween(today, startDate);
      if (n > 0) return `starts in ${plural(n, 'day')}`;
      if (n === 0) return 'starts today';
    }
    return 'starts later';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Audit log → one plain sentence per entry                            */
/* ------------------------------------------------------------------ */

export interface AuditSentenceInput {
  actor: { display_name?: string | null } | null;
  acting_for?: { display_name?: string | null } | null | undefined;
  action: string;
  entity: string;
  details?: unknown | undefined;
}

const AUDIT_ACTION: Record<string, string> = {
  'request.create': 'created a request',
  'request.update': 'edited a draft request',
  'request.delete': 'deleted a draft request',
  'request.submit': 'submitted a request',
  'request.revise': 'sent a new version of a request',
  'request.withdraw': 'withdrew a request',
  'request.amend': 'asked to change a request',
  'request.cancel': 'asked to cancel days on a request',
  'request.respond': 'answered a question',
  'request.comment': 'commented on a request',
  'request.confirm_actual': 'confirmed the actual days taken',
  'request.propose_actual_adjustment': 'proposed a correction to the days taken',
  'step.reassign': 'reassigned an approval step',
  'accrual.run': 'added the yearly allowance',
  'period.close': 'closed the leave year',
  'adjustment.propose': 'proposed a balance correction',
  'adjustment.apply': 'approved a balance correction',
  'adjustment.reject': 'refused a balance correction',
  'attachment.upload': 'added a document',
  'attachment.download': 'opened a document',
  'delegation.create': 'appointed a stand-in',
  'delegation.revoke': 'ended a stand-in',
  'employee.transfer': 'moved an employee to another unit',
  'export.create': 'created a payroll file',
  'export.mark_transferred': 'marked a payroll file as transferred',
  'import.preview': 'checked an import file',
  'import.commit': 'imported a file',
  'import.duplicate': 'skipped a duplicate import',
  'notification.retry': 'retried an email',
  'session.create': 'signed in',
  'session.login_failed': 'failed to sign in',
  'session.logout': 'signed out',
  'session.totp': 'signed in with a two-factor code',
  'demo.clock': 'moved the demo date forward',
  'demo.reset': 'reset the demo',
  'demo.start': 'started the demo',
};

const AUDIT_ENTITY: Record<string, string> = {
  employee: 'an employee record',
  user: 'a user account',
  'org-unit': 'a unit',
  org_unit: 'a unit',
  'leave-type': 'a leave type',
  leave_type: 'a leave type',
  schedule: 'a work pattern',
  'calendar-exception': 'a holiday',
  calendar_exception: 'a holiday',
  delegation: 'a stand-in',
  policy: 'a leave rule',
  'role-grant': 'a role grant',
  role_grant: 'a role grant',
  notification: 'an email',
  settings: 'the settings',
  request: 'a request',
  adjustment: 'a correction',
  attachment: 'a document',
  export_batch: 'a payroll file',
  'export-batch': 'a payroll file',
  import_batch: 'an import file',
  'import-batch': 'an import file',
  account: 'a balance',
  ledger: 'a balance entry',
};

const AUDIT_METHOD: Record<string, string> = {
  post: 'added',
  put: 'changed',
  delete: 'removed',
  get: 'viewed',
};

/** Backend audit.action values, translated. Exported for filters/badges. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION[action] ?? action.replaceAll('_', ' ');
}

/**
 * One audit event → one plain sentence, e.g.
 * "Maria Santos submitted NLD-2026-00008."
 * "Alexei Petrov asked to change NLD-2026-00004, acting for Olga Renner."
 */
export function auditSentence(e: AuditSentenceInput): string {
  const who = e.actor?.display_name?.trim() || 'The system';
  const details =
    e.details && typeof e.details === 'object'
      ? (e.details as Record<string, unknown>)
      : {};
  const number = typeof details['number'] === 'string' ? details['number'] : null;

  const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  let what: string;
  if (e.action === 'step.decide') {
    const step = typeof details['step'] === 'string' ? details['step'] : null;
    const outcome = typeof details['outcome'] === 'string' ? details['outcome'] : null;
    const verb = outcome ? lc(outcomeHistoryLabel(outcome)) : 'made a decision';
    what = `${verb} on ${number ?? 'a request'}${step ? ` (${stepLabel(step)})` : ''}`;
  } else if (e.action === 'demo.clock') {
    const d = typeof details['date'] === 'string' ? details['date'] : null;
    what = d ? `moved the demo date to ${fmtDate(d)}` : 'moved the demo date forward';
  } else if (e.action === 'accrual.run') {
    const yr = details['period_year'];
    what = typeof yr === 'number' ? `added the allowance for ${yr}` : 'added the allowance';
  } else if (e.action === 'period.close') {
    const yr = details['period_year'];
    what = typeof yr === 'number' ? `closed the ${yr} leave year` : 'closed the leave year';
  } else if (AUDIT_ACTION[e.action]) {
    what = AUDIT_ACTION[e.action]!;
    // Prefer the request number over the generic "a request" wording.
    if (number) {
      what = what.replace(/\ba request\b/, number);
    }
  } else {
    const [entity, method] = e.action.split('.', 2);
    const entityName = AUDIT_ENTITY[entity ?? ''] ?? entity?.replaceAll('_', ' ') ?? 'an item';
    const verb = AUDIT_METHOD[method ?? ''];
    what = verb ? `${verb} ${entityName}` : `changed ${entityName}`;
  }

  const behalf = e.acting_for?.display_name?.trim()
    ? `, acting for ${e.acting_for.display_name.trim()}`
    : '';
  return `${who} ${what}${behalf}.`;
}
