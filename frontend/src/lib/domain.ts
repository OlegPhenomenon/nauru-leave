import { fmtDuration } from './format';
// Pure helpers shared by several pages. Behaviour is covered by domain.test.ts.
import type { DayRow, LeaveType, PolicyVersion, Revision } from '../api/types';
import { newIdempotencyKey } from '../api/client';

/**
 * The revision whose dates/minutes are currently in force. For an approved or
 * cancelled leave request this is `in_force_revision` (which may belong to an
 * approved amendment); for everything else it is the request's own current
 * revision. Cards and day tables must use this so old dates are never shown
 * next to the new total.
 */
export function inForceRevision(d: {
  current_revision: Revision;
  in_force_revision: Revision | null;
}): Revision {
  return d.in_force_revision ?? d.current_revision;
}

/** Move a bare YYYY-MM-DD date by whole months, keeping the day clamped by UTC. */
export function shiftMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d!, lastDay));
  return t.toISOString().slice(0, 10);
}

/**
 * The policy version in force on a bare date (YYYY-MM-DD): latest valid_from
 * on or before it, ties on the highest id — the same rule the server uses.
 */
export function policyInForceOn(
  type: Pick<LeaveType, 'policy'> & { policies?: PolicyVersion[] },
  on: string,
): PolicyVersion | null {
  const versions = type.policies?.length ? type.policies : type.policy ? [type.policy] : [];
  let best: PolicyVersion | null = null;
  for (const v of versions) {
    if (v.valid_from <= on && (!best || v.valid_from > best.valid_from || (v.valid_from === best.valid_from && v.id > best.id))) best = v;
  }
  return best;
}

/**
 * The policy version that applies to an accrual run for `periodYear`: the
 * version in force on January 1 (or on the selected month's first day).
 * Ties use the highest id, matching the server's policy lookup.
 * Returns null when no version can apply — the server then answers no_policy.
 */
export function accrualPolicyForYear(
  type: Pick<LeaveType, 'policy'> & { policies?: PolicyVersion[] },
  periodYear: number,
  month = 1,
): PolicyVersion | null {
  return policyInForceOn(type, `${periodYear}-${String(month).padStart(2, '0')}-01`);
}

/** Resolve the selected period before deciding whether the API needs a month. */
export function accrualPeriodPolicy(type: Pick<LeaveType, 'policy'> & { policies?: PolicyVersion[] }, year: number, month: number): PolicyVersion | null {
  const january = accrualPolicyForYear(type, year);
  const selected = accrualPolicyForYear(type, year, month);
  if (selected?.accrual_mode === 'monthly') return selected;
  return selected?.accrual_mode === 'annual_upfront' && january?.accrual_mode === 'annual_upfront' ? january : null;
}

export interface AccrualPlan {
  /** 'annual' → POST without month; 'monthly' → POST with the selected month. */
  kind: 'annual' | 'monthly';
  /** Earliest business date the server accepts this run (YYYY-MM-DD). */
  runnableFrom: string;
}

/**
 * What an "Add entitlement" run can post for a type in (year, month), and from
 * when. Mirrors the server rules: an annual entitlement may be published
 * `advance_publish_months` before 1 January; a monthly slice can be posted at
 * the earliest on the month's first day. Null when the period's policy adds
 * nothing (no policy, accrual 'none', or a non-balance rule).
 */
export function accrualPlanFor(
  type: Pick<LeaveType, 'policy'> & { policies?: PolicyVersion[] },
  year: number,
  month: number,
): AccrualPlan | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const p = accrualPeriodPolicy(type, year, month);
  if (!p || p.accrual_mode === 'none' || !p.uses_balance) return null;
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  if (p.accrual_mode === 'monthly') return { kind: 'monthly', runnableFrom: first };
  return { kind: 'annual', runnableFrom: shiftMonths(`${year}-01-01`, -p.advance_publish_months) };
}

/** Standard full-time schedule day used for the carry-over limit conversion. */
export const STANDARD_DAY_MINUTES = 480;

/** days (may be fractional, e.g. 2.5) → integer minutes. */
export function daysToMinutes(days: number, minutesPerDay: number): number {
  return Math.round(days * minutesPerDay);
}

/** integer minutes → days for form reopen; null stays null (no limit). */
export function minutesToDays(minutes: number | null, minutesPerDay: number): number | null {
  if (minutes === null) return null;
  return minutes / minutesPerDay;
}

/**
 * Minutes per account (keyed by period year) for the days an HR officer ticked
 * as "actually worked" in the actual-period correction. The server returns the
 * same minutes to the accounts that originally paid for those days.
 */
export function workedMinutesByAccount(
  days: DayRow[],
  workedDates: string[],
): { period_year: number; minutes: number }[] {
  const wanted = new Set(workedDates);
  const perYear = new Map<number, number>();
  for (const d of days) {
    if (!wanted.has(d.date)) continue;
    for (const a of d.allocations) {
      perYear.set(a.period_year, (perYear.get(a.period_year) ?? 0) + a.minutes);
    }
  }
  return [...perYear.entries()]
    .map(([period_year, minutes]) => ({ period_year, minutes }))
    .sort((x, y) => x.period_year - y.period_year);
}

/**
 * One Idempotency-Key per user intent: created lazily, reused when the same
 * intent is retried after a network failure, reset when the intent finishes or
 * its inputs change. Keys are namespaced per intent id (a modal, a row, a
 * form) so parallel intents never share a key.
 */
export class IntentKeys {
  private keys = new Map<string | number, string>();

  forIntent(id: string | number): string {
    let k = this.keys.get(id);
    if (!k) {
      k = newIdempotencyKey();
      this.keys.set(id, k);
    }
    return k;
  }

  reset(id: string | number): void {
    this.keys.delete(id);
  }
}

/** Remaining original allocations after guided corrections (manual entries do not count). */
export function correctableDays(days: DayRow[], corrections: { date: string; account_id: number; applied_minutes: number; pending_minutes: number }[]): DayRow[] {
  return days.map(day => ({
    ...day,
    allocations: day.allocations.map(a => {
      const c = corrections.find(c => c.date === day.date && c.account_id === a.account_id);
      return { ...a, minutes: Math.max(0, a.minutes - (c?.applied_minutes ?? 0) - (c?.pending_minutes ?? 0)) };
    }),
  }));
}

/** Range of days still counted by the server, preserving gaps after cancellation. */
export function remainingRanges(revision: Revision): [string, string][] {
  const days = revision.days.filter(d => d.minutes > 0).map(d => d.date).sort();
  const cancelled = new Set(revision.days.filter(d => d.part === 'none' && d.scheduled_minutes > 0).map(d => d.date));
  const ranges: [string, string][] = [];
  for (const date of days) {
    const last = ranges.at(-1);
    if (last && ![...cancelled].some(d => d > last[1] && d < date)) last[1] = date;
    else ranges.push([date, date]);
  }
  return ranges;
}

/** Preserve exact hours when the current pattern cannot express a whole/half day. */
export function fmtBalance(minutes: number, minutesPerDay = 480): string {
  if (minutesPerDay <= 0 || (minutes * 2) % minutesPerDay === 0) return fmtDuration(minutes, minutesPerDay);
  const halfDays = Math.round(minutes * 2 / minutesPerDay);
  const about = fmtDuration(halfDays * minutesPerDay / 2, minutesPerDay);
  const hours = Math.trunc(minutes / 60);
  const remainder = Math.abs(minutes % 60);
  return `${remainder ? (minutes / 60).toLocaleString('en', { maximumFractionDigits: 2 }) : hours} h, about ${about}`;
}

/** Earliest date that appends a work pattern without replacing its history. */
export function nextPatternDate(history: { valid_from: string }[], today: string): string {
  const latest = history.map(s => s.valid_from).sort().at(-1);
  if (!latest || latest < today) return today;
  const next = new Date(`${latest}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
