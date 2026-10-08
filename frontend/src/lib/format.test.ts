import { describe, expect, it } from 'vitest';
import { daysBetween, fmtDate, fmtDuration, fmtHours, fmtWeekday } from './format';

describe('fmtDuration', () => {
  it('renders whole days', () => {
    expect(fmtDuration(2400, 480)).toBe('5 days');
    expect(fmtDuration(480, 480)).toBe('1 day');
    expect(fmtDuration(0, 480)).toBe('0');
  });

  it('renders a half day as ½ day with hours', () => {
    expect(fmtDuration(240, 480)).toBe('½ day (4 h)');
    expect(fmtDuration(2640, 480)).toBe('5½ days (44 h)');
  });

  it('handles part-time schedules (360/day)', () => {
    expect(fmtDuration(360, 360)).toBe('1 day');
    expect(fmtDuration(180, 360)).toBe('½ day (3 h)');
    expect(fmtDuration(1440, 360)).toBe('4 days');
    expect(fmtDuration(540, 360)).toBe('1½ days (9 h)');
  });

  it('renders sub-day remainders as hours/minutes', () => {
    expect(fmtDuration(120, 480)).toBe('2 h');
    expect(fmtDuration(600, 480)).toBe('1 day 2 h');
    expect(fmtDuration(30, 480)).toBe('30 min');
    expect(fmtDuration(90, 480)).toBe('1 h 30 min');
    expect(fmtDuration(570, 480)).toBe('1 day 1 h 30 min');
  });

  it('renders negative adjustments with a minus sign', () => {
    expect(fmtDuration(-240, 480)).toBe('−½ day (4 h)');
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
  it('computes weekdays in UTC', () => {
    expect(fmtWeekday('2026-11-09')).toBe('Mon');
    expect(fmtWeekday('2026-11-15')).toBe('Sun');
  });
  it('counts days between dates', () => {
    expect(daysBetween('2026-11-09', '2026-11-13')).toBe(4);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});
