import { useRef, useState, type ReactNode } from 'react';
import { api, ApiError, post, postForm, unwrapList } from '../api/client';
import type { ExportBatch, ImportBatch, ImportPreview, OrgUnit } from '../api/types';
import { Empty, ErrBox, Field, GenericTable } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { IntentKeys } from '../lib/domain';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

// Report JSON row shapes are not pinned by API.md — render them generically.

function extractRows(data: unknown): Record<string, unknown>[] {
  return unwrapList<Record<string, unknown>>(data);
}

function ReportView({ data, printing }: { data: unknown; printing: boolean }) {
  const rows = extractRows(data);
  if (!rows.length) {
    if (data && typeof data === 'object' && !Array.isArray(data))
      return <GenericTable rows={[data as Record<string, unknown>]} />;
    return <Empty>No rows for these parameters.</Empty>;
  }
  void printing;
  return <GenericTable rows={rows} />;
}

function ReportCard({
  title,
  description,
  path,
  children,
  extraParams,
}: {
  title: string;
  description: string;
  path: string;
  children?: ReactNode;
  extraParams: Record<string, string | undefined>;
}) {
  const [shown, setShown] = useState(false);
  const [data, setData] = useState<unknown>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const query = Object.entries(extraParams).filter(([, v]) => v) as [string, string][];

  async function view() {
    setBusy(true);
    setErr(null);
    try {
      const p = new URLSearchParams([...query, ['format', 'json']]);
      setData(await api<unknown>(`${path}?${p}`));
      setShown(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  function csv() {
    const p = new URLSearchParams([...query, ['format', 'csv']]);
    window.open(`/api${path}?${p}`, '_blank');
  }

  return (
    <section className="panel report-section">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p className="muted small">{description}</p>
      {children}
      {err ? <ErrBox error={err} /> : null}
      <div className="btn-row">
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void view()}>
          {busy ? 'Loading…' : shown ? 'Refresh' : 'View'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={csv}>
          Download CSV
        </button>
        {shown ? (
          <button className="btn btn-secondary btn-sm" onClick={() => window.print()}>
            Print
          </button>
        ) : null}
      </div>
      {shown ? <ReportView data={data} printing={false} /> : null}
    </section>
  );
}

export default function Reports() {
  const { config } = useSession();
  const today = config?.business_date ?? '';
  const [orgUnit, setOrgUnit] = useState('');
  const unitsQ = useApi(() => api<unknown>('/org-units').then((d) => unwrapList<OrgUnit>(d)), []);

  const [balDate, setBalDate] = useState(today);
  const [absFrom, setAbsFrom] = useState(`${today.slice(0, 7)}-01`);
  const [absTo, setAbsTo] = useState(todayPlusMonthEnd(today));
  const [expFrom, setExpFrom] = useState(today);
  const [expTo, setExpTo] = useState(todayPlusMonthEnd(today));
  const [expScope, setExpScope] = useState('');
  const [expBusy, setExpBusy] = useState(false);
  const [expMsg, setExpMsg] = useState<string | null>(null);
  const [transferNote, setTransferNote] = useState<Record<number, string>>({});
  // One Idempotency-Key per intent (export create, import commit); reused only
  // when retrying the same intent after an unconfirmed network result.
  const opKeys = useRef(new IntentKeys());

  const exportsQ = useApi(
    () => api<unknown>('/exports').then((d) => unwrapList<ExportBatch>(d)),
    [],
  );
  const importsQ = useApi(
    () => api<unknown>('/imports').then((d) => unwrapList<ImportBatch>(d)),
    [],
  );

  const [impFile, setImpFile] = useState<File | null>(null);
  const [impKind, setImpKind] = useState('employees');
  const [impMode, setImpMode] = useState('already_in_opening');
  const [impPreview, setImpPreview] = useState<ImportPreview | null>(null);
  const [impErr, setImpErr] = useState<ApiError | null>(null);
  const [impBusy, setImpBusy] = useState(false);
  const [impMsg, setImpMsg] = useState<string | null>(null);

  function todayPlusMonthEnd(d: string) {
    const [y, m] = d.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    return `${d.slice(0, 7)}-${String(last).padStart(2, '0')}`;
  }

  async function createExport() {
    setExpBusy(true);
    setExpMsg(null);
    try {
      const r = await post<ExportBatch>(
        '/exports',
        { from: expFrom, to: expTo, org_unit_id: expScope ? Number(expScope) : undefined },
        opKeys.current.forIntent('export'),
      );
      opKeys.current.reset('export');
      const scope = r.org_unit?.name ?? 'the whole service';
      setExpMsg(
        `Export #${r.id} created for ${scope} — ${r.row_count} rows, sha256 ${r.sha256.slice(0, 12)}…`,
      );
      exportsQ.reload();
    } catch (e) {
      const ae = e instanceof ApiError ? e : null;
      // Keep the key only while the result is unconfirmed (status 0); a real
      // error means the server rejected the intent and the next try is new.
      if (ae && ae.status !== 0) opKeys.current.reset('export');
      setExpMsg(
        ae && ae.status === 0
          ? 'We could not confirm the export — check the list before retrying.'
          : e instanceof Error
            ? e.message
            : 'Export failed',
      );
    } finally {
      setExpBusy(false);
    }
  }

  async function markTransferred(id: number) {
    try {
      await post(`/exports/${id}/mark-transferred`, { note: transferNote[id] ?? '' });
      exportsQ.reload();
    } catch (e) {
      setExpMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function previewImport() {
    if (!impFile) return;
    setImpBusy(true);
    setImpErr(null);
    setImpMsg(null);
    try {
      const fd = new FormData();
      fd.set('file', impFile);
      fd.set('kind', impKind);
      if (impKind === 'historical_leave') fd.set('mode', impMode);
      setImpPreview(await postForm<ImportPreview>('/imports/preview', fd));
    } catch (e) {
      setImpErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setImpBusy(false);
    }
  }

  async function commitImport() {
    if (!impPreview) return;
    setImpBusy(true);
    setImpErr(null);
    const intent = `commit:${impPreview.batch_id}`;
    try {
      const r = await post<{ applied: number; skipped_duplicates: number }>(
        `/imports/${impPreview.batch_id}/commit`,
        {},
        opKeys.current.forIntent(intent),
      );
      opKeys.current.reset(intent);
      setImpMsg(`Import committed — applied ${r.applied}, skipped duplicates ${r.skipped_duplicates}.`);
      setImpPreview(null);
      setImpFile(null);
      importsQ.reload();
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (ae.status !== 0) opKeys.current.reset(intent);
      setImpErr(ae);
    } finally {
      setImpBusy(false);
    }
  }

  const ouParam = orgUnit || undefined;

  return (
    <>
      <h1>Reports</h1>
      <div className="toolbar">
        <Field label="Org unit (applies to all reports)">
          <select value={orgUnit} onChange={(e) => setOrgUnit(e.target.value)}>
            <option value="">All</option>
            {unitsQ.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <ReportCard
        title="Balances at date"
        description="Ledger, reserved and available minutes per employee and leave type."
        path="/reports/balances"
        extraParams={{ date: balDate, org_unit_id: ouParam }}
      >
        <Field label="As of">
          <input type="date" value={balDate} onChange={(e) => setBalDate(e.target.value)} />
        </Field>
      </ReportCard>

      <ReportCard
        title="Approved absences"
        description="Approved leave in the period, with counts and hours."
        path="/reports/absences"
        extraParams={{ from: absFrom, to: absTo, org_unit_id: ouParam }}
      >
        <div className="form-grid">
          <Field label="From">
            <input type="date" value={absFrom} onChange={(e) => setAbsFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={absTo} onChange={(e) => setAbsTo(e.target.value)} />
          </Field>
        </div>
      </ReportCard>

      <ReportCard
        title="Pending requests"
        description="Requests waiting for an action, with age."
        path="/reports/pending"
        extraParams={{}}
      />

      <ReportCard
        title="Changes since last export"
        description="Approved changes made after the most recent transferred export, within the selected org unit."
        path="/reports/changes-since-export"
        extraParams={{ org_unit_id: ouParam }}
      />

      <ReportCard
        title="Schedule drift"
        description="Future approved or pending days whose recorded schedule no longer matches the current schedule — these may need re-approval."
        path="/reports/schedule-drift"
        extraParams={{}}
      />

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Exports (transfer file)</h2>
        <p className="muted small">
          A generic CSV for handing approved leave to another system (for example payroll). It is
          not a ready-made import format for any specific product. Marking it “transferred” is a
          manual confirmation — the file itself is not proof of payroll posting.
        </p>
        <div className="toolbar">
          <Field label="From">
            <input type="date" value={expFrom} onChange={(e) => setExpFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={expTo} onChange={(e) => setExpTo(e.target.value)} />
          </Field>
          <Field label="Scope">
            <select value={expScope} onChange={(e) => setExpScope(e.target.value)}>
              <option value="">Whole service</option>
              {unitsQ.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} only
                </option>
              ))}
            </select>
          </Field>
          <button className="btn" disabled={expBusy || !expFrom || !expTo} onClick={() => void createExport()}>
            {expBusy ? 'Creating…' : 'Create export'}
          </button>
        </div>
        {expMsg ? <div className="alert alert-info">{expMsg}</div> : null}
        {exportsQ.data && exportsQ.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Period</th>
                  <th>Scope</th>
                  <th className="num">Rows</th>
                  <th>SHA-256</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {exportsQ.data.map((x) => (
                  <tr key={x.id}>
                    <td>{x.id}</td>
                    <td>
                      {x.from} – {x.to}
                    </td>
                    <td className="small">{x.org_unit?.name ?? 'Whole service'}</td>
                    <td className="num">{x.row_count}</td>
                    <td className="mono small" title={x.sha256}>
                      {x.sha256.slice(0, 16)}…
                    </td>
                    <td className="small">{fmtDateTime(x.created_at)}</td>
                    <td>
                      {x.transferred_at ? (
                        <span className="badge">
                          transferred {x.transferred_at.slice(0, 10)}
                          {x.transferred_by ? ` by ${x.transferred_by.display_name}` : ''}
                        </span>
                      ) : (
                        <span className="badge">created</span>
                      )}
                    </td>
                    <td className="small" style={{ minWidth: '14rem' }}>
                      <a href={`/api/exports/${x.id}/download`}>Download</a>
                      {!x.transferred_at ? (
                        <span style={{ marginLeft: '0.5rem' }}>
                          <input
                            className="small"
                            placeholder="transfer note"
                            style={{ width: '9rem', marginRight: '0.3rem' }}
                            value={transferNote[x.id] ?? ''}
                            onChange={(e) =>
                              setTransferNote({ ...transferNote, [x.id]: e.target.value })
                            }
                          />
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => void markTransferred(x.id)}
                          >
                            Mark transferred
                          </button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No exports yet.</Empty>
        )}
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Imports</h2>
        <p className="muted small">
          CSV files are previewed first; an import commits all-or-nothing and a repeated import does
          not duplicate entries.
        </p>
        <div className="toolbar">
          <Field label="Kind">
            <select value={impKind} onChange={(e) => setImpKind(e.target.value)}>
              <option value="employees">Employees</option>
              <option value="opening_balances">Opening balances</option>
              <option value="historical_leave">Historical leave</option>
            </select>
          </Field>
          {impKind === 'historical_leave' ? (
            <Field
              label="Mode"
              hint="Are these days already included in the opening balance?"
            >
              <select value={impMode} onChange={(e) => setImpMode(e.target.value)}>
                <option value="already_in_opening">Already in opening balance (record only)</option>
                <option value="post_movements">Not included — post movements</option>
              </select>
            </Field>
          ) : null}
          <Field label="CSV file">
            <input type="file" accept=".csv" onChange={(e) => setImpFile(e.target.files?.[0] ?? null)} />
          </Field>
          <button className="btn" disabled={!impFile || impBusy} onClick={() => void previewImport()}>
            {impBusy ? 'Checking…' : 'Preview'}
          </button>
        </div>
        {impErr ? <ErrBox error={impErr} /> : null}
        {impMsg ? <div className="alert alert-ok">{impMsg}</div> : null}

        {impPreview ? (
          <>
            <p>
              <strong>{impPreview.rows_valid}</strong> of {impPreview.rows_total} rows are valid.
              {impPreview.rows_valid < impPreview.rows_total
                ? ' Commit applies all-or-nothing — fix the file first.'
                : ''}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Data</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {impPreview.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="num">{r.line}</td>
                      <td className="mono small">
                        {typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}
                      </td>
                      <td>
                        {r.errors.length ? (
                          <span className="badge badge-med">{r.errors.join('; ')}</span>
                        ) : (
                          <span className="badge">ok</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              className="btn"
              disabled={impBusy || impPreview.rows_valid < impPreview.rows_total}
              title={
                impPreview.rows_valid < impPreview.rows_total
                  ? 'All rows must be valid to commit'
                  : undefined
              }
              onClick={() => void commitImport()}
            >
              {impBusy ? 'Committing…' : 'Commit import'}
            </button>
          </>
        ) : null}

        {importsQ.data && importsQ.data.length ? (
          <>
            <h3>History</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Kind</th>
                    <th>Status</th>
                    <th className="num">Rows</th>
                    <th className="num">Applied</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {importsQ.data.map((b) => (
                    <tr key={b.id}>
                      <td>{b.id}</td>
                      <td>{b.kind}</td>
                      <td>{b.status}</td>
                      <td className="num">{b.rows_total ?? '—'}</td>
                      <td className="num">{b.applied ?? '—'}</td>
                      <td className="small">{fmtDateTime(b.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}
