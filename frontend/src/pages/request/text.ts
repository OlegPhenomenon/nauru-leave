// Plain-English sentences for the request page and the decision card.
// Everything here is built from structured fields — never from the
// server's `next_action`, `eligible_description` or `authority` strings.

import type {
  AuditEvent,
  Decision,
  Outcome,
  RequestDetail,
  Revision,
  Step,
  StepKind,
  UserRef,
  Warning,
} from '../../api/types';
import {
  fmtDate,
  fmtDateTime,
  fmtDay,
  fmtDuration,
  fmtPhase,
  fmtRange,
  outcomeHistoryLabel,
  partLabel,
  stepLabel,
} from '../../lib/format';
import { inForceRevision } from '../../lib/domain';

export type Viewer = 'owner' | 'reviewer';

/* ------------------------------------------------------------------ */
/* Who a step is waiting on                                             */
/* ------------------------------------------------------------------ */

/** "Olga Berg" / "your manager" / "an HR officer" / "the final approver". */
export function stepAssigneeWords(step: Step, viewer: Viewer): string {
  if (step.assignee) return step.assignee.display_name;
  switch (step.kind) {
    case 'manager_recommendation':
      return viewer === 'owner' ? 'your manager' : 'the manager';
    case 'hr_check':
      return 'an HR officer';
    case 'final_decision':
      return 'the final approver';
  }
}

function stepWaitVerb(kind: StepKind): string {
  switch (kind) {
    case 'manager_recommendation':
      return 'to recommend';
    case 'hr_check':
      return 'to check';
    case 'final_decision':
      return 'to approve';
  }
}

/** First name for warm copy ("Waiting for Lina to answer"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/* ------------------------------------------------------------------ */
/* Status sentence — what happens next, in plain words                  */
/* ------------------------------------------------------------------ */

function latestQuestion(d: RequestDetail) {
  for (let i = d.messages.length - 1; i >= 0; i--) {
    const m = d.messages[i]!;
    if (m.kind === 'question') return m;
  }
  return null;
}

function finalDecision(d: RequestDetail, outcomes: Outcome[]): Decision | null {
  for (let i = d.decisions.length - 1; i >= 0; i--) {
    const x = d.decisions[i]!;
    if (outcomes.includes(x.outcome)) return x;
  }
  return null;
}

const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const NAURU_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Pacific/Nauru',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** RFC3339 timestamp → "8 Oct 2026" in Pacific/Nauru local time (date only). */
export function fmtStampDay(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return fmtDate(ts.slice(0, 10));
  const parts = NAURU_DAY.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value;
  return fmtDate(`${get('year')}-${get('month')}-${get('day')}`);
}

/**
 * One sentence describing where the request stands, composed client-side
 * from status + steps + decisions. Never the backend `next_action`.
 */
export function statusSentence(d: RequestDetail, viewer: Viewer, today: string): string {
  const phase = fmtPhase(d.date_phase, revOf(d).start_date, today);
  switch (d.status) {
    case 'draft':
      return viewer === 'owner'
        ? 'Draft — send it when you are ready.'
        : 'Draft — not sent yet.';
    case 'needs_information': {
      const q = latestQuestion(d);
      return viewer === 'owner'
        ? `${q?.author?.display_name ?? 'A reviewer'} asked a question. Send your answer below.`
        : `Waiting for ${firstName(d.employee.full_name)} to answer${q ? `: “${q.body}”` : '.'}`;
    }
    case 'submitted':
    case 'under_review': {
      const s = pendingStep(d);
      if (!s) return 'Waiting for a decision.';
      if (s.problem) return `${stepLabel(s.kind)} — nobody is assigned yet. HR needs to assign someone.`;
      const who = d.decidable_step?.id === s.id ? 'you' : stepAssigneeWords(s, viewer);
      const acting = d.decidable_step?.acting_for
        ? ` (you are standing in for ${d.decidable_step.acting_for.display_name})`
        : '';
      return `Waiting for ${who} ${stepWaitVerb(s.kind)}${acting}.`;
    }
    case 'approved': {
      const dec = finalDecision(d, ['approve']);
      const base = dec
        ? `Approved by ${dec.actor.display_name} on ${fmtStampDay(dec.created_at)}.`
        : 'Approved.';
      return phase ? `${base.slice(0, -1)} · ${phase}.` : base;
    }
    case 'rejected': {
      const dec = finalDecision(d, ['reject', 'recommend_reject', 'checked_problem']);
      if (!dec) return 'Refused.';
      const reason = dec.reason ? `: “${dec.reason}”` : '';
      return `Refused by ${dec.actor.display_name} on ${fmtStampDay(dec.created_at)}${reason}.`;
    }
    case 'withdrawn':
      return '';
    case 'cancelled':
      return '';
  }
}

/** The step currently waiting for a decision, if any. */
export function pendingStep(d: RequestDetail): Step | null {
  return d.steps.find((s) => s.status === 'pending') ?? null;
}

/** The revision whose dates/minutes the page should lead with. */
export function revOf(d: RequestDetail): Revision {
  return inForceRevision(d);
}

/* ------------------------------------------------------------------ */
/* What-changes lines for amendment / cancellation requests             */
/* ------------------------------------------------------------------ */

function daySet(rev: Revision): Set<string> {
  return new Set(rev.days.filter((x) => x.minutes > 0).map((x) => x.date));
}

function minutesOn(rev: Revision, dates: Set<string>): number {
  return rev.days.filter((x) => x.minutes > 0 && dates.has(x.date)).reduce((a, x) => a + x.minutes, 0);
}

function rangeOf(dates: string[]): string {
  const sorted = [...dates].sort();
  if (!sorted.length) return '';
  return fmtRange(sorted[0]!, sorted[sorted.length - 1]!);
}

/** Cancelled dates retain their original schedule even after approval. */
export function cancellationDays(d: RequestDetail): { date: string; minutes: number }[] {
  const rev = d.current_revision;
  return rev.days.filter(day => day.explanation === `Cancelled by ${d.number}`).map(day => {
    const before = d.parent_in_force_revision?.days.find(w => w.date === day.date && w.minutes > 0);
    const half = (day.date === rev.start_date && rev.start_part !== 'full') ||
      (day.date === rev.end_date && rev.end_part !== 'full');
    return { date: day.date, minutes: before?.minutes ?? (half ? Math.trunc(day.scheduled_minutes / 2) : day.scheduled_minutes) };
  });
}

export interface ChangeSummary {
  /** "Now approved: 2–3 Nov (2 days) → Asked for: 2–4 Nov (3 days)." */
  headline: string;
  /** "Added: Wed 4 Nov." / "Removed: Fri 6 Nov." */
  detail: string | null;
  /** For cancellation pages: the range being cancelled, for the title. */
  cancelledRange: string | null;
}

/** Compute the amendment/cancellation diff from the parent in-force revision. */
export function changeSummary(d: RequestDetail): ChangeSummary | null {
  if (d.kind === 'leave' || !d.parent_in_force_revision) return null;
  const was = d.parent_in_force_revision;
  const now = d.current_revision;
  const mpd = d.minutes_per_day;

  if (d.kind === 'amendment') {
    const before = daySet(was);
    const after = daySet(now);
    const added = now.days.filter((x) => x.minutes > 0 && !before.has(x.date)).map((x) => x.date);
    const removed = was.days.filter((x) => x.minutes > 0 && !after.has(x.date)).map((x) => x.date);
    const adjusted = now.days.filter(x => x.minutes > 0 && was.days.some(w => w.date === x.date && w.minutes > 0 && (w.minutes !== x.minutes || w.part !== x.part)));
    const bits: string[] = [];
    if (added.length) bits.push(`Added: ${added.map(fmtDay).join(', ')}`);
    if (removed.length) bits.push(`Removed: ${removed.map(fmtDay).join(', ')}`);
    if (adjusted.length) bits.push(`Changed: ${adjusted.map(x => `${fmtDay(x.date)} (${partLabel(x.part)}, ${fmtDuration(x.minutes, mpd)})`).join(', ')}`);
    if (was.leave_type?.id !== now.leave_type?.id) bits.push(`Leave type: ${was.leave_type?.name ?? 'Leave'} → ${now.leave_type?.name ?? 'Leave'}`);
    if (d.status === 'approved' && was.id === now.id) return { headline: `Approved change: ${fmtRange(now.start_date, now.end_date)} (${fmtDuration(now.total_minutes, mpd)}).`, detail: null, cancelledRange: null };
    return {
      headline: `Now approved: ${fmtRange(was.start_date, was.end_date)} (${fmtDuration(was.total_minutes, mpd)}) → Asked for: ${fmtRange(now.start_date, now.end_date)} (${fmtDuration(now.total_minutes, mpd)}).`,
      detail: bits.length ? `${bits.join('. ')}.` : null,
      cancelledRange: null,
    };
  }

  // cancellation: the days in force now minus what stays after approval
  const stays = daySet(now);
  const going = was.days.filter(x => x.minutes > 0 && !stays.has(x.date)).map(x => x.date);
  if (!going.length) going.push(...now.days.filter(x => x.explanation === `Cancelled by ${d.number}`).map(x => x.date));
  const goingMinutes = minutesOn(was, new Set(going)) || now.days.filter(x => going.includes(x.date)).reduce((n, x) => n + (x.date === now.start_date && now.start_part !== 'full' || x.date === now.end_date && now.end_part !== 'full' ? Math.trunc(x.scheduled_minutes / 2) : x.scheduled_minutes), 0);
  const cancelledRange = rangeOf(going);
  const remaining = stays.size;
  const headline =
    remaining === 0
      ? `Cancel the whole ${fmtRange(was.start_date, was.end_date)} leave (${fmtDuration(goingMinutes, mpd)}).`
      : `Cancel ${cancelledRange} (${fmtDuration(goingMinutes, mpd)}) — ${fmtDuration(now.total_minutes, mpd)} would stay.`;
  return {
    headline: d.status === 'approved' ? `Cancelled ${cancelledRange} (${fmtDuration(goingMinutes, mpd)}) · ${fmtDuration(now.total_minutes, mpd)} remain.` : headline,
    detail: null,
    cancelledRange: cancelledRange || null,
  };
}

/* ------------------------------------------------------------------ */
/* Effect on balance — one sentence                                     */
/* ------------------------------------------------------------------ */

/** "Holds 3 days of 2026 annual leave until decided." / "Took 2 days of 2026 annual leave." */
export function effectSentence(d: RequestDetail): string | null {
  const mpd = d.minutes_per_day;
  const type = d.leave_type_name;

  const rev = inForceRevision(d);
  if (d.kind === 'leave' && (d.status === 'approved' || d.status === 'cancelled')) {
    const byYear = new Map<number, number>();
    for (const day of rev.days) for (const a of day.allocations) byYear.set(a.period_year, (byYear.get(a.period_year) ?? 0) + a.minutes);
    if (!byYear.size) return d.status === 'cancelled' ? 'All booked days have been returned.' : null;
    const parts = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, m]) => `${fmtDuration(m, mpd)} from ${year}`);
    return `Booked ${parts.join(' and ')} ${type.toLowerCase()}.`;
  }
  const returned = d.ledger_entries.filter(e => e.kind === 'return').reduce((n, e) => n + e.minutes, 0);
  if (returned > 0) return `${fmtDuration(returned, mpd)} returned to the leave balance.`;
  if (d.kind !== 'leave' && d.parent_in_force_revision && ['submitted', 'under_review', 'needs_information'].includes(d.status)) {
    const giveBack = d.parent_in_force_revision.total_minutes - d.current_revision.total_minutes;
    if (giveBack > 0) return `${fmtDuration(giveBack, mpd)} will be returned once this ${d.kind === 'cancellation' ? 'cancellation' : 'change'} is approved.`;
  }

  const held = d.reservations;
  if (held.length && ['submitted', 'under_review', 'needs_information'].includes(d.status)) {
    const byYear = new Map<number, number>();
    for (const r of held) byYear.set(r.period_year, (byYear.get(r.period_year) ?? 0) + r.minutes);
    const parts = [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([y, m]) => `${fmtDuration(m, mpd)} of ${y}`);
    return `Holds ${parts.join(' and ')} ${type.toLowerCase()} until decided.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Decision/step history lines                                          */
/* ------------------------------------------------------------------ */

/** Decision matching a finished step, if any. */
export function decisionForStep(d: RequestDetail, step: Step): Decision | null {
  return [...d.decisions].reverse().find(x => x.step_id === step.id && x.outcome !== 'needs_information') ?? null;
}

/** "Olga Berg recommended approval — 'Covered by Tom'" for earlier-step lines. */
export function earlierStepLine(x: Decision): string {
  const acting = x.acting_for ? ` (for ${x.acting_for.display_name})` : '';
  const reason = x.reason ? ` — “${x.reason}”` : '';
  return `${x.actor.display_name}${acting} ${lcFirst(outcomeHistoryLabel(x.outcome))}${reason}`;
}

/* ------------------------------------------------------------------ */
/* Things-to-know lines (warnings + document requirement)               */
/* ------------------------------------------------------------------ */

interface OverlapEntry {
  name?: string;
  from?: string;
  to?: string;
}

/** Warning objects → short sentences for the decision card / page. */
export function thingsToKnow(d: RequestDetail): string[] {
  const out: string[] = [];
  for (const w of d.warnings) {
    out.push(warningSentence(w));
  }
  if (d.supporting_document_required && !d.supporting_document_ready) {
    out.push('A readable supporting document is needed before approval.');
  }
  return out;
}

function warningSentence(w: Warning): string {
  switch (w.code) {
    case 'team_overlap': {
      const list = Array.isArray(w.details) ? (w.details as OverlapEntry[]) : [];
      const named = list.filter((o) => o.name);
      if (named.length === 1) {
        const o = named[0]!;
        return `${o.name} is also away${o.from && o.to ? ` ${fmtRange(o.from, o.to)}` : ''}.`;
      }
      if (named.length > 1) {
        return `${named.map((o) => o.name).join(', ')} are also away in this period.`;
      }
      return 'A teammate is also away in this period.';
    }
    case 'late_notice': {
      const det = w.details as { min_notice_days?: number } | undefined;
      return det?.min_notice_days
        ? `Asked less than ${det.min_notice_days} days ahead.`
        : 'This is short notice.';
    }
    case 'unassigned_step':
      return 'No one is assigned to a step yet — HR needs to assign it.';
    case 'schedule_drift':
      return 'The work pattern changed after this was submitted — the days may need checking.';
    default:
      return 'Some dates need checking before approval.';
  }
}

/* ------------------------------------------------------------------ */
/* Decision wording (buttons, toasts)                                   */
/* ------------------------------------------------------------------ */

export interface StepVerbs {
  /** Filled primary button: "Recommend approval" / "Mark as checked" / "Approve". */
  positive: Outcome;
  positiveLabel: string;
  /** "…" refusal/problem outcome, if allowed for this step. */
  refuse: Outcome | null;
  refuseLabel: string; // "Recommend refusal…" / "Note a problem…" / "Refuse…"
  refuseConfirm: string; // button inside the open panel
  /** "…" question outcome. */
  question: Outcome | null;
  questionLabel: string;
  questionConfirm: string;
  /** Row-level "your step" phrase on the queue. */
  yourStep: string;
}

const VERBS: Record<StepKind, StepVerbs> = {
  manager_recommendation: {
    positive: 'recommend_approve',
    positiveLabel: 'Recommend approval',
    refuse: 'recommend_reject',
    refuseLabel: 'Recommend refusal…',
    refuseConfirm: 'Recommend refusal',
    question: 'needs_information',
    questionLabel: 'Ask a question…',
    questionConfirm: 'Send question',
    yourStep: 'Needs your recommendation',
  },
  hr_check: {
    positive: 'checked_ok',
    positiveLabel: 'Mark as checked',
    refuse: 'checked_problem',
    refuseLabel: 'Note a problem…',
    refuseConfirm: 'Note the problem',
    question: 'needs_information',
    questionLabel: 'Ask a question…',
    questionConfirm: 'Send question',
    yourStep: 'Needs your HR check',
  },
  final_decision: {
    positive: 'approve',
    positiveLabel: 'Approve',
    refuse: 'reject',
    refuseLabel: 'Refuse…',
    refuseConfirm: 'Refuse',
    question: 'needs_information',
    questionLabel: 'Ask a question…',
    questionConfirm: 'Send question',
    yourStep: 'Needs your final decision',
  },
};

export function verbsFor(kind: StepKind, outcomes: Outcome[]): StepVerbs {
  const v = VERBS[kind];
  return {
    ...v,
    positive: outcomes.includes(v.positive) ? v.positive : (outcomes[0] ?? v.positive),
    refuse: v.refuse && outcomes.includes(v.refuse) ? v.refuse : null,
    question: v.question && outcomes.includes(v.question) ? v.question : null,
  };
}

/** Toast text after a decision is recorded. */
export function decisionToast(outcome: Outcome, employeeName: string, kind: RequestDetail['kind'] = 'leave'): string {
  switch (outcome) {
    case 'recommend_approve':
      return `Recommendation sent for ${employeeName}.`;
    case 'recommend_reject':
      return `Refusal recommended for ${employeeName}.`;
    case 'checked_ok':
      return `Marked as checked for ${employeeName}.`;
    case 'checked_problem':
      return `Problem noted for ${employeeName}.`;
    case 'approve':
      return kind === 'leave' ? `${employeeName}'s leave approved.` : `${kind === 'cancellation' ? 'Cancellation' : 'Date change'} approved for ${employeeName}.`;
    case 'reject':
      return `${employeeName}'s leave refused.`;
    case 'needs_information':
      return `Question sent to ${employeeName}.`;
  }
}

/* ------------------------------------------------------------------ */
/* Audit helpers                                                        */
/* ------------------------------------------------------------------ */

export function auditHasDetails(e: AuditEvent): boolean {
  return e.details !== null && e.details !== undefined;
}

/** Request number for links inside sentences, when present in details. */
export function auditRequestNumber(e: AuditEvent): string | null {
  const det = e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  return typeof det['number'] === 'string' ? (det['number'] as string) : null;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                 */
/* ------------------------------------------------------------------ */

export { fmtDate, fmtDateTime, fmtDay, fmtDuration, fmtRange, outcomeHistoryLabel, stepLabel };
export type { UserRef };
