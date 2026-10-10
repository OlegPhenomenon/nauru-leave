import { describe, expect, it } from 'vitest';
import {
  auditSentence,
  accrualModeLabel,
  daysBetween,
  fmtDate,
  fmtDateTime,
  fmtDay,
  fmtDuration,
  fmtDays,
  fmtHours,
  fmtRange,
  fmtWeekday,
  orgUnitName,
  plural,
  roleLabel,
  statusLabel,
} from './format';

describe('fmtDuration', () => {
  it('renders whole days, including zero', () => {
    expect(fmtDuration(2400, 480)).toBe('5 days');
    expect(fmtDuration(480, 480)).toBe('1 day');
    expect(fmtDuration(0, 480)).toBe('0 days');
  });

  it('renders half days without an hours suffix', () => {
    expect(fmtDuration(240, 480)).toBe('½ day');
    expect(fmtDuration(2640, 480)).toBe('5½ days');
    expect(fmtDuration(4560, 480)).toBe('9½ days');
  });

  it('handles part-time schedules (360/day)', () => {
    expect(fmtDuration(360, 360)).toBe('1 day');
    expect(fmtDuration(180, 360)).toBe('½ day');
    expect(fmtDuration(1440, 360)).toBe('4 days');
    expect(fmtDuration(540, 360)).toBe('1½ days');
  });

  it('renders sub-day remainders as hours, never minutes', () => {
    expect(fmtDuration(120, 480)).toBe('2 h');
    expect(fmtDuration(600, 480)).toBe('1 day 2 h');
    expect(fmtDuration(90, 480)).toBe('1.5 h');
    expect(fmtDuration(570, 480)).toBe('1 day 1.5 h');
  });

  it('renders negative adjustments with a minus sign', () => {
    expect(fmtDuration(-240, 480)).toBe('−½ day');
    expect(fmtDuration(-960, 480)).toBe('−2 days');
    expect(fmtDuration(-60, 480)).toBe('−1 h');
  });
});

describe('fmtHours', () => {
  it('formats whole and fractional hours', () => {
    expect(fmtHours(480)).toBe('8 h');
    expect(fmtHours(90)).toBe('1.5 h');
    expect(fmtHours(-240)).toBe('−4 h');
  });
});

describe('dates', () => {
  it('formats ISO dates without timezone drift', () => {
    expect(fmtDate('2026-11-09')).toBe('9 Nov 2026');
    expect(fmtDate('2026-01-01')).toBe('1 Jan 2026');
  });
  it('formats compact day labels', () => {
    expect(fmtDay('2026-10-19')).toBe('Mon 19 Oct');
    expect(fmtDay('2026-11-02')).toBe('Mon 2 Nov');
  });
  it('computes weekdays in UTC', () => {
    expect(fmtWeekday('2026-11-09')).toBe('Mon');
    expect(fmtWeekday('2026-11-15')).toBe('Sun');
  });
  it('counts days between dates', () => {
    expect(daysBetween('2026-11-09', '2026-11-13')).toBe(4);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('fmtRange', () => {
  it('collapses same-month ranges', () => {
    expect(fmtRange('2026-11-02', '2026-11-13')).toBe('2–13 Nov 2026');
  });
  it('spans months and years', () => {
    expect(fmtRange('2026-10-28', '2026-11-02')).toBe('28 Oct – 2 Nov 2026');
    expect(fmtRange('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 2 Jan 2027');
  });
  it('renders a single day once', () => {
    expect(fmtRange('2026-11-09', '2026-11-09')).toBe('9 Nov 2026');
  });
});

describe('fmtDateTime', () => {
  it('renders Pacific/Nauru local time without a zone suffix', () => {
    // UTC+12: this timestamp crosses midnight in Nauru.
    expect(fmtDateTime('2026-01-01T20:00:00Z')).toBe('2 Jan 2026, 08:00');
    expect(fmtDateTime('2026-10-08T06:30:00Z')).toBe('8 Oct 2026, 18:30');
  });
});

describe('plural', () => {
  it('pluralises', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(3, 'day')).toBe('3 days');
    expect(plural(2, 'person', 'people')).toBe('2 people');
  });
});

describe('labels', () => {
  it('maps internal enums to plain words', () => {
    expect(statusLabel('rejected')).toBe('Refused');
    expect(roleLabel('hr_medical')).toBe('HR (medical)');
    expect(accrualModeLabel('annual_upfront')).toBe('Whole year on 1 January');
  });
  it('strips the (demo) suffix from unit names', () => {
    expect(orgUnitName('Central HR Office (demo)')).toBe('Central HR Office');
    expect(orgUnitName('Infrastructure Unit')).toBe('Infrastructure Unit');
  });
});

describe('auditSentence', () => {
  const base = { actor: { display_name: 'Maria Santos' }, acting_for: null };
  it('renders a submit with the request number', () => {
    expect(
      auditSentence({
        ...base,
        action: 'request.submit',
        entity: 'request',
        details: { number: 'NLD-2026-00008' },
      }),
    ).toBe('Maria Santos submitted NLD-2026-00008.');
  });
  it('renders a step decision with step and outcome words', () => {
    expect(
      auditSentence({
        ...base,
        action: 'step.decide',
        entity: 'step',
        details: { step: 'hr_check', outcome: 'needs_information', number: 'NLD-2026-00008' },
      }),
    ).toBe('Maria Santos asked a question on NLD-2026-00008 (HR check).');
  });
});

// Close-year tables express the entire amount in this employee's days.
describe('close-year days', () => {
  it('shows half-days and part-time carry-over limits in days', () => {
    expect(fmtDays(6000)).toBe('12.5 days');
    expect(fmtDays(4500, 360)).toBe('12.5 days');
    expect(fmtDays(4800, 360)).toBe('13.33 days');
    expect(fmtDays(0)).toBe('0 days');
  });
});
