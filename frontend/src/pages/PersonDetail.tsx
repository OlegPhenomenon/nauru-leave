import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, post, put, unwrapList } from '../api/client';
import type {
  EmployeeDetail,
  EmployeeListItem,
  OrgUnit,
  Schedule,
} from '../api/types';
import { Dur, Empty, ErrBox, Field, Loading, Modal } from '../components/ui';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

type Dialog = 'edit' | 'transfer' | 'schedule' | 'deactivate' | null;

export default function PersonDetail() {
  const { id } = useParams();
  const { hasRole } = useSession();
  const canEdit = hasRole('hr');
  const q = useApi(() => api<EmployeeDetail>(`/employees/${id}`), [id]);
  const unitsQ = useApi(() => api<unknown>('/org-units').then((d) => unwrapList<OrgUnit>(d)), []);
  const schedulesQ = useApi(() => api<unknown>('/schedules').then((d) => unwrapList<Schedule>(d)), []);
  const employeesQ = useApi(
    () => api<unknown>('/employees').then((d) => unwrapList<EmployeeListItem>(d)),
    [],
  );

  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [affected, setAffected] = useState<{ id: number; number: string }[] | null>(null);

  const [edit, setEdit] = useState({ full_name: '', email: '', end_date: '', active: true });
  const [transfer, setTransfer] = useState({
    org_unit_id: 0,
    manager_employee_id: 0,
    valid_from: '',
    reassign_open_steps: false,
  });
  const [sched, setSched] = useState({ schedule_id: 0, valid_from: '' });

  const e = q.data;
  useEffect(() => {
    if (e && dialog === 'edit')
      setEdit({
        full_name: e.full_name,
        email: e.email ?? '',
        end_date: e.end_date ?? '',
        active: e.active,
      });
  }, [e, dialog]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setDialog(null);
      q.reload();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex : new ApiError(0, 'unknown', String(ex)));
    } finally {
      setBusy(false);
    }
  }

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;
  if (!e) return null;

  return (
    <>
      <h1>
        {e.full_name} {!e.active ? <span className="badge">inactive</span> : null}
      </h1>
      <div className="panel">
        <dl className="kv">
          <div className="kv-row">
            <dt>Service ID</dt>
            <dd className="mono">{e.service_id}</dd>
          </div>
          <div className="kv-row">
            <dt>Org unit</dt>
            <dd>{e.org_unit?.name ?? '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>Manager</dt>
            <dd>{e.manager?.full_name ?? '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>Schedule</dt>
            <dd>{e.schedule?.name ?? '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>Employment</dt>
            <dd>
              {fmtDate(e.start_date)} – {e.end_date ? fmtDate(e.end_date) : 'present'}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Login</dt>
            <dd>
              {e.user ? `${e.user.email} (user #${e.user.id})` : e.has_login ? 'yes' : 'no login — served on paper'}
            </dd>
          </div>
        </dl>
        {canEdit ? (
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={() => setDialog('edit')}>
              Edit
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog('transfer')}>
              Transfer
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog('schedule')}>
              Change schedule
            </button>
            {e.active ? (
              <button className="btn btn-danger" onClick={() => setDialog('deactivate')}>
                Deactivate
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="two-col">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Assignments</h2>
          {e.assignments.length === 0 ? (
            <Empty>No assignment history.</Empty>
          ) : (
            <table className="small">
              <thead>
                <tr>
                  <th>Org unit</th>
                  <th>Manager</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {e.assignments.map((a) => (
                  <tr key={a.id}>
                    <td>{a.org_unit?.name ?? '—'}</td>
                    <td>{a.manager?.full_name ?? '—'}</td>
                    <td>{fmtDate(a.valid_from)}</td>
                    <td>{a.valid_to ? fmtDate(a.valid_to) : 'present'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Schedules</h2>
          {e.schedules.length === 0 ? (
            <Empty>No schedule history.</Empty>
          ) : (
            <table className="small">
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {e.schedules.map((s) => (
                  <tr key={s.id}>
                    <td>{s.schedule?.name ?? '—'}</td>
                    <td>{fmtDate(s.valid_from)}</td>
                    <td>{s.valid_to ? fmtDate(s.valid_to) : 'present'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {e.balances ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Balances</h2>
          <div className="card-grid">
            {e.balances.filter((b) => b.leave_type.uses_balance).map((b) => (
              <div className="card" key={b.leave_type.id}>
                <h3>{b.leave_type.name}</h3>
                <span className="balance-num">
                  <Dur minutes={b.available_minutes} mpd={b.minutes_per_day} />
                </span>
                <span className="balance-sub">
                  ledger <Dur minutes={b.ledger_minutes} mpd={b.minutes_per_day} /> · reserved{' '}
                  <Dur minutes={b.reserved_minutes} mpd={b.minutes_per_day} />
                </span>
                <div>
                  <Link className="small" to={`/balances/${e.id}/explain?leave_type_id=${b.leave_type.id}`}>
                    How is this calculated?
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {affected ? (
        <div className="alert alert-info">
          The schedule change affects these future requests:{' '}
          {affected.map((r) => (
            <Link key={r.id} to={`/requests/${r.id}`} style={{ marginRight: '0.5rem' }}>
              {r.number}
            </Link>
          ))}
        </div>
      ) : null}

      {dialog === 'edit' ? (
        <Modal title="Edit employee" onClose={() => setDialog(null)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Full name">
            <input value={edit.full_name} onChange={(x) => setEdit({ ...edit, full_name: x.target.value })} />
          </Field>
          <Field label="Email">
            <input type="email" value={edit.email} onChange={(x) => setEdit({ ...edit, email: x.target.value })} />
          </Field>
          <Field label="End date (leave empty if still employed)">
            <input type="date" value={edit.end_date} onChange={(x) => setEdit({ ...edit, end_date: x.target.value })} />
          </Field>
          <label className="field">
            <input type="checkbox" checked={edit.active} onChange={(x) => setEdit({ ...edit, active: x.target.checked })} />{' '}
            active
          </label>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  put(`/employees/${e.id}`, {
                    full_name: edit.full_name,
                    email: edit.email,
                    end_date: edit.end_date || null,
                    active: edit.active,
                    expected_version: e.version,
                  }).then(() => undefined),
                )
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === 'deactivate' ? (
        <Modal title="Deactivate employee" onClose={() => setDialog(null)}>
          <p>
            Deactivate {e.full_name}? Existing requests and history are kept; the person stops
            appearing as active.
          </p>
          {err ? <ErrBox error={err} /> : null}
          <div className="btn-row">
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  put(`/employees/${e.id}`, {
                    active: false,
                    expected_version: e.version,
                  }).then(() => undefined),
                )
              }
            >
              {busy ? 'Working…' : 'Deactivate'}
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === 'transfer' ? (
        <Modal title="Transfer employee" onClose={() => setDialog(null)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="New org unit">
            <select value={transfer.org_unit_id} onChange={(x) => setTransfer({ ...transfer, org_unit_id: Number(x.target.value) })}>
              <option value={0}>—</option>
              {unitsQ.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="New manager">
            <select
              value={transfer.manager_employee_id}
              onChange={(x) => setTransfer({ ...transfer, manager_employee_id: Number(x.target.value) })}
            >
              <option value={0}>—</option>
              {employeesQ.data
                ?.filter((x) => x.id !== e.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.full_name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Valid from">
            <input type="date" value={transfer.valid_from} onChange={(x) => setTransfer({ ...transfer, valid_from: x.target.value })} />
          </Field>
          <label className="field">
            <input
              type="checkbox"
              checked={transfer.reassign_open_steps}
              onChange={(x) => setTransfer({ ...transfer, reassign_open_steps: x.target.checked })}
            />{' '}
            reassign open approval steps to the new manager
          </label>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !transfer.org_unit_id || !transfer.valid_from}
              onClick={() =>
                void run(() =>
                  post(`/employees/${e.id}/transfer`, {
                    org_unit_id: transfer.org_unit_id,
                    manager_employee_id: transfer.manager_employee_id || undefined,
                    valid_from: transfer.valid_from,
                    reassign_open_steps: transfer.reassign_open_steps,
                  }).then(() => undefined),
                )
              }
            >
              {busy ? 'Saving…' : 'Transfer'}
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === 'schedule' ? (
        <Modal title="Change schedule" onClose={() => setDialog(null)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="New schedule">
            <select value={sched.schedule_id} onChange={(x) => setSched({ ...sched, schedule_id: Number(x.target.value) })}>
              <option value={0}>—</option>
              {schedulesQ.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Valid from">
            <input type="date" value={sched.valid_from} onChange={(x) => setSched({ ...sched, valid_from: x.target.value })} />
          </Field>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !sched.schedule_id || !sched.valid_from}
              onClick={() =>
                void run(async () => {
                  const r = await post<{ affected_future_requests?: { id: number; number: string }[] }>(
                    `/employees/${e.id}/schedule`,
                    { schedule_id: sched.schedule_id, valid_from: sched.valid_from, expected_version: e.version },
                  );
                  setAffected(r.affected_future_requests ?? []);
                })
              }
            >
              {busy ? 'Saving…' : 'Change schedule'}
            </button>
            <button className="btn btn-secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
