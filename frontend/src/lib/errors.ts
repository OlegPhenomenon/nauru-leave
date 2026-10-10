// Turns ApiError / network failures into plain, human sentences.
// The raw server message is kept only as `technical` detail — ErrBox
// shows it behind a collapsed disclosure, never as the main message.

import { ApiError } from '../api/client';

export interface DescribedError {
  message: string;
  technical?: string | undefined;
}

const FALLBACK =
  "Something went wrong. Nothing was changed. Try again, or contact HR.";

const NETWORK =
  'The connection to the server was lost. If you were saving something, check whether it took effect before trying again.';

/* Field names seen in server validation messages → words users see. */
const FIELD_LABELS: Record<string, string> = {
  service_id: 'the staff number',
  full_name: 'the name',
  email: 'the email address',
  start_date: 'a start date',
  end_date: 'an end date',
  from_date: 'a start date',
  to_date: 'an end date',
  from_user_id: 'the absent person',
  to_user_id: 'the stand-in',
  employee_id: 'a person',
  org_unit_id: 'a unit',
  schedule_id: 'a work pattern',
  leave_type_id: 'a leave type',
  manager_employee_id: 'a manager',
  period_year: 'the year',
  month: 'a month',
  valid_from: 'the start date',
  valid_to: 'the end date',
  reason: 'a reason',
  change_reason: 'a reason for the change',
  basis_document: 'the document this is based on',
  minutes: 'an amount',
  note: 'a note',
  name: 'a name',
  code: 'a code',
  date: 'a date',
};

/** snake_case field name → "a name" / "the email address". */
function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? `the ${field.replaceAll('_', ' ')}`;
}

/* Ordered matches against the raw validation message. First hit wins. */
const VALIDATION_RULES: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/bad date|invalid date|malformed date/i, 'Enter a full date (day, month, 4-digit year).'],
  [
    /end_date before start_date|to before from|to_date before from_date|valid_to before valid_from|end before start/i,
    'The end date must be on or after the start date.',
  ],
  [/date must be forward|must be in the future|cannot move.*back/i, "Pick a date after today's demo date, up to 31 Dec 2028."],
  [/no working days/i, 'These dates have no working days for this person.'],
  [/change_reason is required|reason (is )?required/i, 'Add a reason.'],
  [/basis_document (is )?required/i, 'Add the document this is based on, e.g. the paper form number.'],
  [
    /too large/i,
    (m) => {
      const size = (m.input ?? m[0]).match(/\b\d+(?:\.\d+)?\s*MB\b/i)?.[0];
      return size ? `The file is too large (limit ${size}).` : 'The file is too large.';
    },
  ],
  [/unsupported file type/i, 'Upload a PDF, PNG or JPEG file.'],
  [/too many attachments|one file per upload/i, 'Upload one file at a time — the attachment limit is reached.'],
  [/email already exists/i, 'Someone already uses this email address.'],
  [/exception already exists/i, 'There is already an exception for this date.'],
  [/adjustment of 0 minutes/i, 'Enter an amount other than zero.'],
  [/adjustment already decided/i, 'This correction has already been decided.'],
  [/only a draft|only drafts/i, "This request has already been sent, so it can't be changed this way."],
  [/step already finished|step is not pending|old revision/i, 'This step was already decided or the request changed. Reload to see the latest.'],
  [/period has not ended/i, 'You can close a year only after it has ended.'],
  [/monthly accrual requires month|invalid month|month must be/i, 'Choose a month.'],
  [/annual_upfront takes no month/i, 'This rule adds the whole year at once — no month needed.'],
  [/unknown or inactive org unit|inactive org unit/i, 'Choose a unit that is still active.'],
  [/unit cannot parent itself|cannot.*parent.*itself/i, "A unit can't be placed inside itself."],
  [/minutes must be in 0\.\.1440|week must contain seven|between 0 and 24/i, "Each day's hours must be between 0 and 24."],
  [/notice cannot be negative|limits? must be positive|cannot be negative/i, 'Enter a positive number.'],
  [/must be UTF-8|not UTF-8/i, 'Save the file as CSV (UTF-8) and upload it again.'],
  [/single-day request.*part.*match|start_part.*end_part.*match/i, 'For a single day, the start and end must be the same part of day.'],
  [/bad minutes|minutes must be (an? )?integer|must be.*minutes/i, 'Enter a valid amount.'],
  [/missing column '([^']+)'/i, (m) => `The file is missing the column ${m[1]}. Download the template.`],
  [/from_date is required/i, 'Choose a start date.'],
  [/to_date is required/i, 'Choose an end date.'],
  [/leave_type_id is required/i, 'Choose a leave type.'],
  [/employee_id is required/i, 'Choose a person.'],
  [/([a-z][a-z0-9_]*) is required/i, (m) => `Fill in ${fieldLabel(m[1]!)}.`],
  [/([a-z][a-z0-9_]*) must be (an? )?integer/i, (m) => `Choose ${fieldLabel(m[1]!)}.`],
];

function describeValidation(message: string): string {
  for (const [re, out] of VALIDATION_RULES) {
    const m = message.match(re);
    if (m) return typeof out === 'string' ? out : out(m);
  }
  return "Some details aren't valid. Check the form and try again.";
}

const BY_CODE: Record<string, string> = {
  network: NETWORK,
  unauthenticated: 'Your session has ended. Sign in again.',
  forbidden: "You don't have permission to do this. Ask HR if you think you should.",
  self_approval_forbidden: "You can't decide on your own request. Another approver will handle it.",
  not_found: 'This item no longer exists. It may have been withdrawn or deleted.',
  stale_version: 'Someone else changed this. Reload and try again.',
  change_pending: 'A change to this request is already waiting for a decision. Wait for it or withdraw it first.',
  overlap: 'You already have leave on some of these days. Pick other dates or change the existing request.',
  insufficient_balance: "There isn't enough leave left for these dates.",
  no_schedule: 'This person has no work schedule for these dates. Ask HR to set one.',
  no_policy: 'No leave rule covers these dates yet. HR needs to add one.',
  past_dates_need_hr_correction: 'These dates are in the past. Ask HR to correct the record instead.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  idempotency_key_reused: 'This action was already sent with different details. Reload the page and try again.',
  import_invalid: 'The file has errors, so nothing was imported. Fix the rows listed below and upload again.',
  scanner_unavailable: 'File scanning is unavailable, so uploads are refused for safety. Try again later or contact the operator.',
  demo_full: 'The demo is full right now. Try again later.',
  internal: 'Something went wrong on our side. Nothing was saved. Try again in a moment.',
};

/**
 * Map any thrown value to { message, technical? }.
 * `message` is safe to show to users; `technical` is the raw server
 * text for the collapsed "Technical details" disclosure.
 */
export function describeError(e: unknown): DescribedError {
  if (e instanceof ApiError) {
    const technical = [e.code, e.message].filter(Boolean).join(': ');
    if (e.status === 0 || e.code === 'network') {
      return { message: NETWORK, technical };
    }
    if (e.code === 'validation') {
      // Some forbidden/validation payloads carry their own hint worth
      // keeping verbatim-ish; the rules table translates what it knows.
      const extra =
        e.details && typeof e.details === 'object'
          ? (e.details as Record<string, unknown>)['messages']
          : undefined;
      const first =
        Array.isArray(extra) && typeof extra[0] === 'string' ? extra[0] : e.message;
      return { message: describeValidation(first), technical };
    }
    if (e.code === 'forbidden' && /assignee lacks required role/i.test(e.message)) {
      return {
        message: "This person can't do this step. Choose someone from the list.",
        technical,
      };
    }
    const mapped = BY_CODE[e.code];
    if (mapped) return { message: mapped, technical };
    if (e.status >= 500) return { message: BY_CODE['internal']!, technical };
    return { message: FALLBACK, technical };
  }
  if (e instanceof Error) {
    return { message: FALLBACK, technical: e.message };
  }
  return { message: FALLBACK, technical: String(e) };
}

/** Strict YYYY-MM-DD check for form fields (shared with pages). */
export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}
