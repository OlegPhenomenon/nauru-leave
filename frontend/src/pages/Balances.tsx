import { useState } from 'react';
import { api, ApiError, post, unwrapList } from '../api/client';
import type {
  Adjustment,
  BalanceRow,
  EmployeeListItem,
  LeaveType,
  OrgUnit,
} from '../api/types';
import { Dur, Empty, ErrBox, Field, Loading, Modal } from '../components/ui';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

export default function Balances() {
  const { me, hasRole } = useSession();
  const canEdit = hasRole('hr');
  const isApprover = hasRole('adjustment_approver');

  const [orgUnit, setOrgUnit] = useState('');
  const [leaveType, setLeaveType] = useState('');
  const [asOf, setAsOf] = useState('');
  const [adjStatus, setAdjStatus] = useState('proposed');
  const [modal, setModal] = useState<'adjust' | 'accrual' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const unitsQ = useApi(() => api<unknown>('/org-units').then((d) => unwrapList<OrgUnit>(d)), []);
  const typesQ = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const employeesQ = useApi(
    () => api<unknown>('/employees').then((d) => unwrapList<EmployeeListItem>(d)),
    [],
  );
  const tableQ = useApi(
    () =>
      api<unknown>('/balances', {
        query: {
          org_unit_id: orgUnit || undefined,
          leave_type_id: leaveType || undefined,
          date: asOf || undefined,
        },
      }).then((d) => unwrapList<BalanceRow>(d)),
    [orgUnit, leaveType, asOf],
  );
  const adjQ = useApi(
    () =>
      api<unknown>('/adjustments', { query: { status: adjStatus || undefined } }).then((d) =>
        unwrapList<Adjustment>(d),
      ),
    [adjStatus],
  );

  const [adj, setAdj] = useState({
    employee_id: 0,
    leave_type_id: 0,
    period_year: new Date().getFullYear(),
    minutes: 0,
    reason: '',
    basis_document: '',
  });
  const [accrual, setAccrual] = useState({ leave_type_id: 0, period_year: new Date().getFullYear() + 1 });

  async function run(fn: () => Promise<void>, ok?: string) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setModal(null);
      if (ok) setMsg(ok);
      tableQ.reload();
      adjQ.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Balances</h1>
      {msg ? <div className="alert alert-ok">{msg}</div> : null}

      <div className="panel">
        <div className="toolbar">
          <Field label="Org unit">
            <select value={orgUnit} onChange={(e) => setOrgUnit(e.target.value)}>
              <option value="">All</option>
              {unitsQ.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Leave type">
            <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
              <option value="">All</option>
              {typesQ.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="As of date">
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          {canEdit ? (
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button className="btn btn-secondary" onClick={() => setModal('adjust')}>
                Propose adjustment
              </button>
              <button className="btn btn-secondary" onClick={() => setModal('accrual')}>
                Run accrual
              </button>
              <button className="btn btn-secondary" onClick={() => setModal('close')}>
                Close period
              </button>
            </div>
          ) : null}
        </div>

        {tableQ.loading ? <Loading /> : null}
        {tableQ.error ? <ErrBox error={tableQ.error} /> : null}
        {tableQ.data && tableQ.data.length === 0 ? <Empty>No balances in this scope.</Empty> : null}
        {tableQ.data && tableQ.data.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Leave type</th>
                  <th className="num">Ledger</th>
                  <th className="num">Reserved</th>
                  <th className="num">Available</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tableQ.data.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.employee.full_name}
                      <div className="muted small">
                        {r.employee.service_id} · {r.employee.org_unit?.name ?? '—'}
                      </div>
                    </td>
                    <td>{r.summary.leave_type.name}</td>
                    <td className="num">
                      <Dur minutes={r.summary.ledger_minutes} mpd={r.summary.minutes_per_day} />
                    </td>
                    <td className="num">
                      <Dur minutes={r.summary.reserved_minutes} mpd={r.summary.minutes_per_day} />
                    </td>
                    <td className="num">
                      <strong>
                        <Dur minutes={r.summary.available_minutes} mpd={r.summary.minutes_per_day} />
                      </strong>
                    </td>
                    <td className="small">
                      <a href={`/balances/${r.employee.id}/explain?leave_type_id=${r.summary.leave_type.id}`}>
                        Explain
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Adjustments</h2>
        <div className="toolbar">
          <Field label="Status">
            <select value={adjStatus} onChange={(e) => setAdjStatus(e.target.value)}>
              <option value="proposed">Proposed</option>
              <option value="applied">Applied</option>
              <option value="rejected">Rejected</option>
              <option value="">All</option>
            </select>
          </Field>
        </div>
        {adjQ.loading ? <Loading /> : null}
        {adjQ.error ? <ErrBox error={adjQ.error} /> : null}
        {adjQ.data && adjQ.data.length === 0 ? <Empty>No adjustments with this status.</Empty> : null}
        {adjQ.data && adjQ.data.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Type / period</th>
                  <th className="num">Change</th>
                  <th className="num">Before → after</th>
                  <th>Reason</th>
                  <th>Proposed by</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {adjQ.data.map((a) => (
                  <tr key={a.id}>
                    <td>{a.employee.full_name}</td>
                    <td>
                      {a.leave_type.name} {a.period_year}
                    </td>
                    <td className="num">
                      {a.minutes > 0 ? '+' : ''}
                      <Dur minutes={a.minutes} mpd={a.minutes_per_day || 480} />
                    </td>
                    <td className="num small">
                      <Dur minutes={a.balance_before} mpd={a.minutes_per_day || 480} /> →{' '}
                      <Dur minutes={a.balance_after_if_applied} mpd={a.minutes_per_day || 480} />
                    </td>
                    <td className="small">
                      {a.reason}
                      {a.basis_document ? <div className="muted">basis: {a.basis_document}</div> : null}
                    </td>
                    <td className="small">
                      {a.proposed_by.display_name}
                      <div className="muted">{fmtDateTime(a.created_at)}</div>
                    </td>
                    <td>
                      {a.status === 'proposed' && isApprover && a.proposed_by.id !== me?.user.id ? (
                        <div className="btn-row" style={{ marginTop: 0 }}>
                          <button
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  post(`/adjustments/${a.id}/decide`, {
                                    decision: 'apply',
                                    note: '',
                                  }).then(() => undefined),
                                'Adjustment applied.',
                              )
                            }
                          >
                            Apply
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  post(`/adjustments/${a.id}/decide`, {
                                    decision: 'reject',
                                    note: '',
                                  }).then(() => undefined),
                                'Adjustment rejected.',
                              )
                            }
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="badge">
                          {a.status}
                          {a.decided_by ? ` · ${a.decided_by.display_name}` : ''}
                          {a.decided_at ? ` · ${fmtDate(a.decided_at)}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {modal === 'adjust' ? (
        <Modal title="Propose balance adjustment" onClose={() => setModal(null)}>
          <p className="muted small">
            A proposed adjustment is applied only after a second approver confirms it.
          </p>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Employee">
            <select value={adj.employee_id} onChange={(e) => setAdj({ ...adj, employee_id: Number(e.target.value) })}>
              <option value={0}>—</option>
              {employeesQ.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.full_name} ({x.service_id})
                </option>
              ))}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Leave type">
              <select value={adj.leave_type_id} onChange={(e) => setAdj({ ...adj, leave_type_id: Number(e.target.value) })}>
                <option value={0}>—</option>
                {typesQ.data?.filter((t) => t.uses_balance).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Period year">
              <input type="number" value={adj.period_year} onChange={(e) => setAdj({ ...adj, period_year: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Minutes (+ add / − remove)" hint="480 minutes = one day on a full-time schedule.">
            <input type="number" step="30" value={adj.minutes} onChange={(e) => setAdj({ ...adj, minutes: Number(e.target.value) })} />
          </Field>
          <Field label="Reason">
            <input value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
          </Field>
          <Field label="Basis document">
            <input value={adj.basis_document} onChange={(e) => setAdj({ ...adj, basis_document: e.target.value })} />
          </Field>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !adj.employee_id || !adj.leave_type_id || !adj.minutes || !adj.reason}
              onClick={() => void run(() => post('/adjustments', adj).then(() => undefined), 'Adjustment proposed.')}
            >
              {busy ? 'Saving…' : 'Propose'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {modal === 'accrual' || modal === 'close' ? (
        <Modal title={modal === 'accrual' ? 'Run accrual' : 'Close period'} onClose={() => setModal(null)}>
          <p className="muted small">
            {modal === 'accrual'
              ? 'Posts the yearly accrual for everyone entitled under the policy. Running it twice does not duplicate entries.'
              : 'Closes the period and posts carry-over expiry entries per policy. Idempotent.'}
          </p>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Leave type">
            <select value={accrual.leave_type_id} onChange={(e) => setAccrual({ ...accrual, leave_type_id: Number(e.target.value) })}>
              <option value={0}>—</option>
              {typesQ.data?.filter((t) => t.uses_balance).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Period year">
            <input type="number" value={accrual.period_year} onChange={(e) => setAccrual({ ...accrual, period_year: Number(e.target.value) })} />
          </Field>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !accrual.leave_type_id}
              onClick={() =>
                void run(async () => {
                  const path = modal === 'accrual' ? '/accruals/run' : '/periods/close';
                  const r = await post<{ posted?: number; skipped_existing?: number }>(path, accrual);
                  setMsg(
                    modal === 'accrual'
                      ? `Accrual done — posted ${r.posted ?? '?'}, skipped existing ${r.skipped_existing ?? 0}.`
                      : 'Period closed.',
                  );
                })
              }
            >
              {busy ? 'Running…' : modal === 'accrual' ? 'Run accrual' : 'Close period'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
