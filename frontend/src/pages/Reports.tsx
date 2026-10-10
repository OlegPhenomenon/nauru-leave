import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { api, ApiError, post, unwrapList } from '../api/client';
import type { ExportBatch, OrgUnit, RequestSummary } from '../api/types';
import {
  DataTable,
  Details,
  ErrBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  ReqLink,
  useToast,
} from '../components/ui';
import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtRange,
  orgUnitName,
  partLabel,
  plural,
  statusLabel,
  stepLabel,
} from '../lib/format';
import { fmtBalance, IntentKeys } from '../lib/domain';
import { isValidDate } from '../lib/errors';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import './Reports.css';

type ReportId = 'absences' | 'balances' | 'pending' | 'changes' | 'drift' | 'payroll';

const REPORTS: { id: ReportId; name: string; dates: 'month' | 'date' | 'none' }[] = [
  { id: 'absences', name: 'Approved absences', dates: 'month' },
  { id: 'balances', name: 'Days left on a date', dates: 'date' },
  { id: 'pending', name: 'Requests waiting', dates: 'none' },
  { id: 'changes', name: 'Changes since last payroll file', dates: 'none' },
  { id: 'drift', name: 'Leave affected by work-pattern changes', dates: 'none' },
  { id: 'payroll', name: 'Payroll files', dates: 'month' },
];

const API_PATH: Record<Exclude<ReportId, 'payroll'>, string> = {
  absences: 'absences',
  balances: 'balances',
  pending: 'pending',
  changes: 'changes-since-export',
  drift: 'schedule-drift',
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

// Report downloads need every row, including those beyond the first API page.
async function allRows<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const d = await api<unknown>(path, { query: { ...query, limit: 500, offset: rows.length } });
    const page = unwrapList<T>(d);
    rows.push(...page);
    const total = d && typeof d === 'object' && 'total' in d ? Number(d.total) : rows.length;
    if (!page.length || rows.length >= total) return rows;
  }
}

interface Col {
  label: string;
  className?: string | undefined;
  /** first column is the stacked-mode row title */
  title?: boolean | undefined;
  /** plain text — also what the CSV download writes */
  text: (r: Row) => string;
  csvText?: (r: Row) => string;
  render?: ((r: Row) => ReactNode) | undefined;
}

const reqCol = (label: string, title = false): Col => ({
  label,
  title,
  text: (r) => str(r['request_number']),
  render: (r) => <ReqLink id={num(r['request_id'])} number={str(r['request_number'])} />,
});

const ABS_COLS: Col[] = [
  { label: 'Date', title: true, text: (r) => fmtDate(str(r['date'])) },
  { label: 'Person', text: (r) => str(r['employee']) },
  { label: 'Leave type (sick leave details are hidden)', text: (r) => str(r['leave_type']) },
  { label: 'Part of day', text: (r) => partLabel(str(r['part'])) },
  { label: 'Days', className: 'num', text: (r) => fmtDuration(num(r['minutes']), num(r['minutes_per_day']) || 480), csvText:r => String(num(r['minutes']) / (num(r['minutes_per_day']) || 480)) },
  reqCol('Request'),
];

const BAL_COLS: Col[] = [
  { label: 'Person', title: true, text: (r) => str(r['employee']) },
  { label: 'Leave type', text: (r) => str(r['leave_type']) },
  {
    label: 'Days left',
    className: 'num',
    csvText: r => String(num(r['available_minutes']) / (num(r['minutes_per_day']) || 480)),
    text: (r) => fmtBalance(num(r['available_minutes']), num(r['minutes_per_day']) || 480),
    render: (r) => (
      <strong>{fmtBalance(num(r['available_minutes']), num(r['minutes_per_day']) || 480)}</strong>
    ),
  },
  {
    label: 'On hold for requests',
    className: 'num',
    text: (r) => num(r['reserved_minutes']) ? fmtDuration(num(r['reserved_minutes']), num(r['minutes_per_day']) || 480) : '—',
    csvText: r => String(num(r['reserved_minutes']) / (num(r['minutes_per_day']) || 480)),
  },
];

const PEND_COLS: Col[] = [
  reqCol('Request', true),
  { label: 'Person', text: (r) => str(r['employee']) },
  {
    label: 'Waiting for',
    text: (r) => (str(r['pending_step']) ? stepLabel(str(r['pending_step'])) : '—'),
  },
  { label: 'Status', text: (r) => statusLabel(str(r['status'])) },
  { label: 'Waiting', className: 'num', text: (r) => plural(Math.max(0, num(r['age_days'])), 'day') },
];

function changeText(r: Row): string {
  const kind = str(r['kind']);
  const was = fmtDuration(num(r['previous_minutes']), num(r['minutes_per_day']) || 480);
  const now = fmtDuration(num(r['minutes']), num(r['minutes_per_day']) || 480);
  if (kind === 'new') return `New — ${now}`;
  if (kind === 'removed') return `Removed — was ${was}`;
  return `Changed — ${was} → ${now}`;
}

const CHG_COLS: Col[] = [
  { label: 'Date', title: true, text: (r) => fmtDate(str(r['date'])) },
  { label: 'Person', text: (r) => str(r['employee']) },
  { label: 'What changed', text: changeText },
  reqCol('Request'),
];

const DRIFT_COLS: Col[] = [
  { label: 'Person', title: true, text: (r) => str(r['employee_name']) },
  { label: 'Date', text: (r) => fmtDate(str(r['date'])) },
  reqCol('Request'),
  {
    label: 'Recorded → now',
    className: 'num',
    text: (r) =>
      `${fmtDuration(num(r['frozen_minutes']), num(r['minutes_per_day']) || 480)} → ${fmtDuration(num(r['current_minutes']), num(r['minutes_per_day']) || 480)}`,
  },
];

const COLS: Record<Exclude<ReportId, 'payroll'>, Col[]> = {
  absences: ABS_COLS,
  balances: BAL_COLS,
  pending: PEND_COLS,
  changes: CHG_COLS,
  drift: DRIFT_COLS,
};

const EMPTY: Record<ReportId, string> = {
  absences: 'No approved absences in this period.',
  balances: 'No balances on this date.',
  pending: 'Nothing is waiting for a decision.',
  changes: 'No changes since the last payroll file.',
  drift: 'No leave affected by work-pattern changes.',
  payroll: '',
};

/** CSV with the same curated columns as the on-screen table. */
function downloadCsvFile(name: string, cols: Col[], rows: Row[]) {
  const esc = (s: string) => {
    const t = /^[\s]*[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };
  const lines = [cols.map((c) => esc(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc((c.csvText ?? c.text)(r))).join(','));
  downloadCsvText(name, lines.join('\r\n'));
}

function downloadCsvText(name: string, csv: string) {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export default function Reports() {
  const { config, hasRole } = useSession();
  const today = config?.business_date ?? '';
  const [sp, setSp] = useSearchParams();
  const [payrollHeader, setPayrollHeader] = useState<HTMLSpanElement | null>(null);
  const canPayroll = hasRole('hr');
  const availableReports = REPORTS.filter(r => r.id !== 'payroll' || canPayroll);

  const rawR = sp.get('r') ?? 'absences';
  const report = (availableReports.some((r) => r.id === rawR) ? rawR : 'absences') as ReportId;
  const unit = sp.get('unit') ?? '';
  const month = ISO_MONTH.test(sp.get('month') ?? '') ? sp.get('month')! : today.slice(0, 7);
  const custom = sp.get('custom') === '1';
  const dateParam = sp.get('date');
  const date = isValidDate(dateParam ?? '') ? dateParam! : today;

  const lastDay = month ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10) : '';
  const monthFrom = `${month}-01`;
  const from = custom && isValidDate(sp.get('from') ?? '') ? sp.get('from')! : monthFrom;
  const to = custom && isValidDate(sp.get('to') ?? '') ? sp.get('to')! : lastDay;
  const validRange = isValidDate(from) && isValidDate(to) && from <= to;

  function update(updates: Record<string, string | null>) {
    setSp(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === '') n.delete(k);
          else n.set(k, v);
        }
        return n;
      },
      { replace: false },
    );
  }

  const unitsQ = useApi(() => allRows<OrgUnit>('/org-units'), []);
  const exportsQ = useApi(
    () => hasRole('hr') ? allRows<ExportBatch>('/exports') : Promise.resolve([]),
    [],
  );

  const [view, setView] = useState<{ rows: Row[]; meta?: string } | null>(null);
  const [viewErr, setViewErr] = useState<ApiError | null>(null);
  const [viewBusy, setViewBusy] = useState(false);

  const viewSequence = useRef(0);
  // Prevent a slow response for old filters replacing the selected report.
  useEffect(() => {
    viewSequence.current++;
    setViewBusy(false);
    setView(null);
    setViewErr(null);
    if (report !== 'payroll' && today && (def.dates === 'none' || (def.dates === 'month' && validRange) || (def.dates === 'date' && isValidDate(date)))) {
      void showHere();
    }
    // The selected report and filters define the view; showHere uses this render's values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, unit, from, to, date, today]);

  const def = REPORTS.find((r) => r.id === report)!;

  async function fetchRows(): Promise<{ rows: Row[]; meta?: string }> {
    if (report === 'payroll') return { rows: [] };
    const rows = await allRows<Row>(`/reports/${API_PATH[report]}`, {
      format: 'json', org_unit_id: unit || undefined,
      ...(report === 'absences' ? { from, to } : {}),
      ...(report === 'balances' ? { date } : {}),
    });
    if (report === 'balances' || !rows.length) return { rows };
    const requests = await allRows<RequestSummary>('/requests', { scope: 'all' });
    const byId = new Map(requests.map((r) => [r.id, r]));
    const enriched: Row[] = rows.filter((r) => !(unit && (report === 'pending' || report === 'drift')) ||
      byId.get(num(r['request_id']))?.employee.org_unit?.id === Number(unit))
      .map((r) => ({ ...r, minutes_per_day: byId.get(num(r['request_id']))?.minutes_per_day ?? (num(r['minutes_per_day']) || 480) }));
    if (report === 'absences' || report === 'changes') enriched.sort((a, b) => str(a['date']).localeCompare(str(b['date'])) || str(a['employee']).localeCompare(str(b['employee'])));
    return { rows: enriched, ...(report === 'absences' ? { meta: `${plural(enriched.length, 'absence day')} · ${fmtRange(from, to)}` } : {}) };
  }

  async function showHere() {
    const seq = ++viewSequence.current;
    setViewBusy(true);
    setViewErr(null);
    try {
      const data = await fetchRows();
      if (viewSequence.current === seq) setView(data);
    } catch (e) {
      if (viewSequence.current === seq) setViewErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      if (viewSequence.current === seq) setViewBusy(false);
    }
  }

  async function downloadCsv() {
    if (report !== 'payroll') {
      const seq = ++viewSequence.current;
      setViewBusy(true);
      setViewErr(null);
      try {
        const { rows } = view ?? await fetchRows();
        if (viewSequence.current !== seq) return;
        downloadCsvFile(
          `${report}.csv`,
          COLS[report],
          rows,
        );

      } catch (e) {
        if (viewSequence.current === seq) setViewErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
      } finally {
        if (viewSequence.current === seq) setViewBusy(false);
      }
      return;
    }
  }

  async function printReport() {
    const seq = ++viewSequence.current;
    setViewBusy(true);
    setViewErr(null);
    try {
      const data = view ?? await fetchRows();
      if (viewSequence.current !== seq) return;
      setView(data);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (viewSequence.current === seq) window.print(); }));
    } catch (e) {
      if (viewSequence.current === seq) setViewErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      if (viewSequence.current === seq) setViewBusy(false);
    }
  }

  const filters = (
<div className="toolbar">
                <Field label="Unit">
                  <select value={unit} onChange={(e) => update({ unit: e.target.value || null })}>
                    <option value="">All units</option>
                    {unitsQ.data?.map((u) => (
                      <option key={u.id} value={u.id}>
                        {orgUnitName(u.name)}
                      </option>
                    ))}
                  </select>
                </Field>
                {def.dates === 'month' && !custom ? (
                  <Field label="Month">
                    <input
                      type="month"
                      value={month}
                      onChange={(e) =>
                        update({
                          month: ISO_MONTH.test(e.target.value) ? e.target.value : null,
                        })
                      }
                    />
                  </Field>
                ) : null}
                {def.dates === 'month' && custom ? (
                  <>
                    <Field label="From">
                      <input
                        type="date"
                        value={from}
                        onChange={(e) => update({ from: e.target.value || null })}
                      />
                    </Field>
                    <Field label="To">
                      <input
                        type="date"
                        value={to}
                        onChange={(e) => update({ to: e.target.value || null })}
                      />
                    </Field>
                  </>
                ) : null}
                {def.dates === 'date' ? (
                  <Field label="On date">
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => update({ date: e.target.value || null })}
                    />
                  </Field>
                ) : null}
                {def.dates === 'month' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      custom
                        ? update({ custom: null, from: null, to: null, month: from.slice(0, 7) })
                        : update({ custom: '1', month: null, from: monthFrom, to: lastDay })
                    }
                  >
                    {custom ? 'Back to month' : 'Custom dates'}
                  </button>
                ) : null}
              </div>
  );

  return (
    <div className="reports-page">
      <PageHeader title="Reports" primary={report !== 'payroll' ? <>
<button
                  type="button"
                  className="btn"
                  disabled={viewBusy || (def.dates === 'month' && !validRange) || (def.dates === 'date' && !isValidDate(date))}
                  onClick={() => void downloadCsv()}
                >
                  Download CSV
                </button>
                <button type="button" className="btn btn-secondary" disabled={viewBusy || (def.dates === 'month' && !validRange) || (def.dates === 'date' && !isValidDate(date))} onClick={() => void printReport()}>Print</button>
      </> : <span ref={setPayrollHeader} />} />
      <div className="reports-layout">
        <nav className="reports-nav subnav" aria-label="Reports">
          {availableReports.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === report ? 'active' : ''}
              aria-current={r.id === report ? 'page' : undefined}
              onClick={() => update({ r: r.id === 'absences' ? null : r.id })}
            >
              {r.name}
            </button>
          ))}
        </nav>

        <section className="panel">
          {report !== 'payroll' ? <><h2>{def.name}</h2>{filters}</> : null}
          {unitsQ.error ? <ErrBox error={unitsQ.error} /> : null}
          {def.dates === 'month' && !validRange ? <p className="field-error">Choose an end date on or after the start date.</p> : null}
          {report === 'payroll' ? (
            <PayrollPanel
              units={unitsQ.data ?? []}
              unit={unit}
              from={from}
              to={to}
              exportsQ={exportsQ}
              canManage={hasRole('hr')}
              filters={filters}
              headerTarget={payrollHeader}
            />
          ) : (
            <>
              {viewErr ? <ErrBox error={viewErr} /> : null}
              {view ? (
                <>
                  {view.meta ? <p className="muted small">{view.meta}</p> : null}
                  <DataTable<Row>
                    columns={COLS[report].map((c) => ({
                      label: c.label,
                      className: c.className,
                      title: c.title,
                      render: c.render ?? ((r) => c.text(r)),
                    }))}
                    rows={view.rows}
                    empty={EMPTY[report]}
                  />
                </>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payroll files (was: exports)                                        */
/* ------------------------------------------------------------------ */

function PayrollPanel({
  units,
  unit,
  from,
  to,
  exportsQ,
  canManage,
  filters,
  headerTarget,
}: {
  units: OrgUnit[];
  unit: string;
  from: string;
  to: string;
  exportsQ: { data: ExportBatch[] | null; error: ApiError | null; loading: boolean; reload: () => void };
  canManage: boolean;
  filters: ReactNode;
  headerTarget: HTMLSpanElement | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [markId, setMarkId] = useState<number | null>(null);
  const [markNote, setMarkNote] = useState('');
  const [creating, setCreating] = useState(false);
  const keys = useRef(new IntentKeys());

  function unitName(id: number | null | undefined) {
    if (!id) return 'the whole service';
    const u = units.find((x) => x.id === id);
    return u ? orgUnitName(u.name) : 'Selected unit';
  }

  async function createFile() {
    if (busy || !canManage || !isValidDate(from) || !isValidDate(to) || from > to) return;
    setBusy(true);
    setCreating(true);
    setErr(null);
    try {
      const r = await post<ExportBatch>(
        '/exports',
        { from, to, org_unit_id: unit ? Number(unit) : undefined },
        keys.current.forIntent(`export:${unit}:${from}:${to}`),
      );
      keys.current.reset(`export:${unit}:${from}:${to}`);

      exportsQ.reload();
      const csv = await api<string>(`/exports/${r.id}/download`);
      downloadCsvText(`payroll-${r.from}-${r.to}.csv`, csv);
      toast(`Payroll file created for ${fmtRange(r.from, r.to)} (${plural(r.row_count, 'leave day')}) and downloaded.`);
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (ae.status !== 0) keys.current.reset(`export:${unit}:${from}:${to}`);
      setErr(ae);
    } finally {
      setBusy(false);
      setCreating(false);
    }
  }

  async function markSent(id = markId, note = markNote) {
    if (id === null || busy || !canManage) return;
    setBusy(true);
    setErr(null);
    const intent = `sent:${id}:${note}`;
    try {
      await post(`/exports/${id}/mark-transferred`, { note }, keys.current.forIntent(intent));
      keys.current.reset(intent);
      toast('Marked as sent.');
      setMarkId(null);
      setMarkNote('');
      exportsQ.reload();
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (ae.status !== 0) keys.current.reset(intent);
      setErr(ae);
    } finally {
      setBusy(false);
    }
  }

  const batches = (exportsQ.data ?? []).filter((x) => (!unit || x.org_unit_id === Number(unit)) && x.from <= to && x.to >= from);

  async function downloadFile(batch: ExportBatch) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const csv = await api<string>(`/exports/${batch.id}/download`);
      downloadCsvText(`payroll-${batch.from}-${batch.to}.csv`, csv);
      toast('Payroll file downloaded.');
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Payroll files</h2>
      {canManage && headerTarget ? createPortal(<button type="button" className="btn" disabled={busy || !isValidDate(from) || !isValidDate(to) || from > to} onClick={() => void createFile()}>{creating ? 'Creating…' : 'Create payroll file'}</button>, headerTarget) : null}
      {canManage ? <>{filters}<p className="muted small">A CSV of approved leave for {fmtRange(from,to)}{unit ? ` · ${unitName(Number(unit))}` : ' · the whole service'}.</p></> : null}
      <p className="muted small">Sick leave details are hidden. The payroll CSV retains system columns for transfer; its Leave type column is readable.</p>
      {err && markId === null ? <ErrBox error={err} /> : null}
      {exportsQ.loading ? <Loading /> : null}
      {exportsQ.error ? <ErrBox error={exportsQ.error} /> : null}
      {exportsQ.data ? (
        <DataTable<ExportBatch>
          columns={[
            { label: 'Period', className:'nowrap', title: true, render: (x) => fmtRange(x.from, x.to) },
            {
              label: 'Unit',
              render: (x) => (x.org_unit_id ? unitName(x.org_unit_id) : 'Whole service'),
            },
            { label: 'Leave days', className: 'num', render: (x) => x.row_count },
            { label: 'Created', className:'nowrap', render: (x) => fmtDateTime(x.created_at) },
            {
              label: 'Status',
              render: (x) =>
                x.transferred_at ? (
                  <>
                    Sent on {fmtDateTime(x.transferred_at)}
                    {x.transferred_by ? ` by ${x.transferred_by.display_name}` : ''}
                  </>
                ) : (
                  'Ready'
                ),
            },
            {
              label: '',
              className:'row-actions',
              render: (x) => (
                <>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void downloadFile(x)}>Download</button>
                  {canManage && !x.transferred_at ? <><button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void markSent(x.id,'')}>Mark as sent</button><button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setErr(null); setMarkId(x.id); setMarkNote(''); }}>Mark as sent with a note…</button></> : null}
                </>
              ),
            },
          ]}
          rows={batches}
          empty="No payroll files yet."
        />
      ) : null}
      <Details title="About payroll files">
        <p className="muted small">
          A payroll file is a generic CSV for handing approved leave to another system (for
          example payroll). It is not a ready-made import format for any specific product.
          Marking a file as sent is a manual confirmation — the file itself is not proof of
          payroll posting.
        </p>

      </Details>

      {markId !== null ? (
        <Modal
          title="Mark as sent"
          onClose={() => { if (!busy) setMarkId(null); }}
          footer={
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setMarkId(null)}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void markSent()}>
                {busy ? 'Saving…' : 'Mark as sent'}
              </button>
            </>
          }
        >
          {err ? <ErrBox error={err} /> : null}
          <Field label="Note (optional)" hint="e.g. which payroll run received it">
            <input
              type="text"
              disabled={busy}
              value={markNote}
              onChange={(e) => setMarkNote(e.target.value)}
            />
          </Field>
        </Modal>
      ) : null}
    </>
  );
}
