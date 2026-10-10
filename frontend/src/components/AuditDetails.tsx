import { fmtDate, fmtDuration, outcomeActionLabel, partLabel, roleLabel, stepLabel, statusLabel } from '../lib/format';

const LABELS: Record<string, string> = {
  number: 'Request', outcome: 'Decision', step: 'Approval step', revision: 'Version', revision_no: 'Version',
  period_year: 'Year', date: 'Date', start_date: 'First day', end_date: 'Last day', effective_date: 'Applies from',
  valid_from: 'From', valid_to: 'To', reason: 'Reason', body: 'Message', note: 'Note', basis: 'Reference',
  basis_document: 'Reference document', name: 'Name', full_name: 'Full name', display_name: 'Name',
  employee: 'Person', role: 'Access', status: 'Status', start_part: 'First day part', end_part: 'Last day part',
  posted: 'Changes applied', expired_accounts: 'Balances changed', active: 'Can sign in',
};

/** Only known, readable fields reach the ordinary disclosure. Internal fields stay technical. */
export function AuditDetails({ details, minutesPerDay = 480 }: { details: unknown; minutesPerDay?: number }) {
  const values = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  const rows = Object.entries(values).flatMap(([key, value]) => {
    if (key === 'minutes' && typeof value === 'number') return [['Change', fmtDuration(value, minutesPerDay)]];
    const label = LABELS[key];
    if (!label || value == null || typeof value === 'object') return [];
    let text = typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
    if (key === 'outcome') text = outcomeActionLabel(text);
    else if (key === 'step') text = stepLabel(text);
    else if (key === 'status') text = statusLabel(text);
    else if (key === 'role') text = roleLabel(text);
    else if (key.endsWith('_part')) text = partLabel(text);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = fmtDate(text);
    return [[label, text]];
  });
  return rows.length ? <dl className="kv">{rows.map(([label, value], i) => <div className="kv-row" key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="muted small">No additional readable details.</p>;
}
