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

/**
 * The policy version that applies to an accrual run for `periodYear`: the
 * latest version whose `valid_from` falls inside or before that year. Versions
 * that only start later are ignored (they are not in force for the period).
 * Returns null when no version can apply — the server then answers no_policy.
 */
export function accrualPolicyForYear(
  type: Pick<LeaveType, 'policy'> & { policies?: PolicyVersion[] },
  periodYear: number,
): PolicyVersion | null {
  const versions = type.policies?.length ? type.policies : type.policy ? [type.policy] : [];
  const yearEnd = `${periodYear}-12-31`;
  let best: PolicyVersion | null = null;
  for (const v of versions) {
    if (v.valid_from <= yearEnd && (!best || v.valid_from > best.valid_from)) best = v;
  }
  return best;
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
