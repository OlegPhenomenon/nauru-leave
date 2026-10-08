// Duration and date formatting. All durations are integer minutes;
// minutes_per_day comes from the employee's schedule (default 480).

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

/**
 * Render minutes as days/hours for a schedule day length.
 * 2400 @480 → "5 days"; 240 @480 → "½ day (4 h)"; 360 @360 → "1 day".
 */
export function fmtDuration(minutes: number, minutesPerDay = 480): string {
  const sign = minutes < 0 ? '−' : '';
  const m = Math.abs(minutes);
  if (m === 0) return '0';
  const days = Math.floor(m / minutesPerDay);
  const rem = m % minutesPerDay;
  if (rem === 0) return `${sign}${days} ${pluralDays(days)}`;
  if (rem * 2 === minutesPerDay) {
    const label = days === 0 ? '½' : `${days}½`;
    return `${sign}${label} ${days === 0 ? 'day' : 'days'} (${fmtHours(m)})`;
  }
  const remH = Math.floor(rem / 60);
  const remM = rem % 60;
  const remStr = remH && remM ? `${remH} h ${remM} min` : remH ? `${remH} h` : `${remM} min`;
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

/** "2026-11-09" → "9 Nov 2026". Input is a bare date, no timezone shift. */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function fmtWeekday(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
}

/** "2026-11-09" → "Mon 9 Nov 2026" */
export function fmtDateFull(iso: string): string {
  const w = fmtWeekday(iso);
  return w ? `${w} ${fmtDate(iso)}` : fmtDate(iso);
}

/** RFC3339 UTC timestamp → "9 Nov 2026, 14:05 UTC" */
export function fmtDateTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date}, ${hh}:${mm} UTC`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const PART_LABELS: Record<string, string> = {
  full: 'Full day',
  am: 'Morning',
  pm: 'Afternoon',
  none: 'Non-working',
};
export function partLabel(p: string): string {
  return PART_LABELS[p] ?? p;
}

const STEP_LABELS: Record<string, string> = {
  manager_recommendation: 'Manager recommendation',
  hr_check: 'HR check',
  final_decision: 'Final decision',
};
export function stepLabel(k: string): string {
  return STEP_LABELS[k] ?? k;
}

const OUTCOME_LABELS: Record<string, string> = {
  recommend_approve: 'Recommended approval',
  recommend_reject: 'Recommended rejection',
  checked_ok: 'Checked — OK',
  checked_problem: 'Checked — problem noted',
  approve: 'Approved',
  reject: 'Rejected',
  needs_information: 'Information requested',
};
export function outcomeLabel(o: string): string {
  return OUTCOME_LABELS[o] ?? o;
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
