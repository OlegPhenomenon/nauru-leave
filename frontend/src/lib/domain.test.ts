import { describe, expect, it } from 'vitest';
import type { DayRow, LeaveType, PolicyVersion, Revision } from '../api/types';
import {
  IntentKeys,
  accrualPolicyForYear,
  daysToMinutes,
  inForceRevision,
  minutesToDays,
  workedMinutesByAccount,
} from './domain';

function rev(partial: Partial<Revision>): Revision {
  return {
    id: 1,
    rev_no: 1,
    leave_type: null,
    start_date: '2026-11-09',
    end_date: '2026-11-13',
    start_part: 'full',
    end_part: 'full',
    note: null,
    change_reason: null,
    total_minutes: 2400,
    created_by: { id: 1, display_name: 'A' },
    created_at: '2026-10-01T00:00:00Z',
    submitted_at: null,
    days: [],
    ...partial,
  };
}

function policy(partial: Partial<PolicyVersion>): PolicyVersion {
  return {
    id: 1,
    valid_from: '2026-01-01',
    annual_entitlement_min: 9600,
    accrual_mode: 'annual_upfront',
    advance_publish_months: 0,
    carryover_allowed: false,
    carryover_expiry_months: null,
    carryover_limit_min: null,
    allow_negative: false,
    paid: true,
    uses_balance: true,
    allow_half_day: true,
    requires_attachment: false,
    min_notice_days: 0,
    in_force: true,
    explanation: '',
    status: 'verified',
    ...partial,
  };
}

describe('f01_inForceRevision', () => {
  it('returns the in-force revision when present (amended leave)', () => {
    const orig = rev({ id: 10, end_date: '2026-11-13', total_minutes: 2400 });
    const amended = rev({ id: 20, end_date: '2026-11-11', total_minutes: 1440 });
    const d = { current_revision: orig, in_force_revision: amended };
    expect(inForceRevision(d).id).toBe(20);
    // The card and the day table must use the same revision — no 9–13 dates
    // next to a 3-day total.
    expect(inForceRevision(d).end_date).toBe('2026-11-11');
    expect(inForceRevision(d).total_minutes).toBe(1440);
  });

  it('falls back to the current revision when nothing is in force', () => {
    const cur = rev({ id: 10 });
    expect(inForceRevision({ current_revision: cur, in_force_revision: null }).id).toBe(10);
  });
});

describe('f02_accrualPolicyForYear', () => {
  const t = (policies: PolicyVersion[]): LeaveType =>
    ({ policies, policy: policies[policies.length - 1] ?? null }) as LeaveType;

  it('is monthly when the version in force for the year is monthly', () => {
    const lt = t([
      policy({ id: 1, valid_from: '2025-01-01', accrual_mode: 'annual_upfront' }),
      policy({ id: 2, valid_from: '2027-01-01', accrual_mode: 'monthly', in_force: false }),
    ]);
    expect(accrualPolicyForYear(lt, 2026)?.accrual_mode).toBe('annual_upfront');
    expect(accrualPolicyForYear(lt, 2027)?.accrual_mode).toBe('monthly');
  });

  it('ignores versions that start after the asked year', () => {
    const lt = t([policy({ id: 1, valid_from: '2027-06-01', accrual_mode: 'monthly' })]);
    expect(accrualPolicyForYear(lt, 2026)).toBeNull();
    expect(accrualPolicyForYear(lt, 2027)).toBeNull();
  });

  it('selects January 1 and highest id on ties during a midyear mode change', () => {
    const lt = t([policy({ id: 1 }), policy({ id: 2, accrual_mode: 'monthly' }), policy({ id: 3, valid_from: '2027-07-01', accrual_mode: 'none' })]);
    expect(accrualPolicyForYear(lt, 2027)?.id).toBe(2);
  });

  it('checks the selected month on its first day', () => {
    const lt = t([policy({ id: 1, accrual_mode: 'monthly' }), policy({ id: 2, valid_from: '2027-07-01', accrual_mode: 'annual_upfront' })]);
    expect(accrualPolicyForYear(lt, 2027, 6)?.accrual_mode).toBe('monthly');
    expect(accrualPolicyForYear(lt, 2027, 7)?.accrual_mode).toBe('annual_upfront');
  });

  it('falls back to the single in-force policy when policies[] is absent', () => {
    const lt = { policies: [], policy: policy({ accrual_mode: 'monthly' }) } as unknown as LeaveType;
    expect(accrualPolicyForYear(lt, 2026)?.accrual_mode).toBe('monthly');
  });
});

describe('g01_carryover_limit_days_minutes', () => {
  it('converts whole and half days using the schedule day length', () => {
    expect(daysToMinutes(3, 480)).toBe(1440);
    expect(daysToMinutes(2.5, 480)).toBe(1200);
    expect(daysToMinutes(1, 360)).toBe(360);
  });

  it('converts minutes back to days for form reopen', () => {
    expect(minutesToDays(1440, 480)).toBe(3);
    expect(minutesToDays(1200, 480)).toBe(2.5);
    expect(minutesToDays(null, 480)).toBeNull();
  });
});

describe('f05_workedMinutesByAccount', () => {
  const days: DayRow[] = [
    {
      date: '2026-12-30',
      part: 'full',
      scheduled_minutes: 480,
      minutes: 480,
      period_year: 2026,
      explanation: '',
      allocations: [{ account_id: 7, period_year: 2026, minutes: 480, carryover: false }],
    },
    {
      date: '2027-01-04',
      part: 'full',
      scheduled_minutes: 480,
      minutes: 480,
      period_year: 2027,
      explanation: '',
      allocations: [{ account_id: 9, period_year: 2027, minutes: 480, carryover: false }],
    },
    {
      date: '2027-01-05',
      part: 'full',
      scheduled_minutes: 480,
      minutes: 480,
      period_year: 2027,
      explanation: '',
      allocations: [
        { account_id: 9, period_year: 2027, minutes: 240, carryover: false },
        { account_id: 7, period_year: 2026, minutes: 240, carryover: true },
      ],
    },
  ];

  it('returns the per-account minutes only for the ticked dates', () => {
    const rows = workedMinutesByAccount(days, ['2027-01-05']);
    expect(rows).toEqual([
      { period_year: 2026, minutes: 240 },
      { period_year: 2027, minutes: 240 },
    ]);
  });

  it('sums several worked dates per account and sorts by year', () => {
    const rows = workedMinutesByAccount(days, ['2026-12-30', '2027-01-04', '2027-01-05']);
    expect(rows).toEqual([
      { period_year: 2026, minutes: 720 },
      { period_year: 2027, minutes: 720 },
    ]);
  });
});

describe('f12_intentKeys', () => {
  it('reuses the same key until the intent is reset', () => {
    const keys = new IntentKeys();
    const a = keys.forIntent('accrual');
    expect(keys.forIntent('accrual')).toBe(a);
    keys.reset('accrual');
    expect(keys.forIntent('accrual')).not.toBe(a);
  });

  it('keeps independent keys per intent id', () => {
    const keys = new IntentKeys();
    expect(keys.forIntent(1)).not.toBe(keys.forIntent(2));
    keys.reset(1);
    expect(keys.forIntent(2)).toBe(keys.forIntent(2));
  });
});
