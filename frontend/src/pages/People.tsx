import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, post, unwrapList } from '../api/client';
import type { EmployeeListItem, OrgUnit, Schedule } from '../api/types';
import { Empty, ErrBox, Field, Loading, Modal } from '../components/ui';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

export default function People() {
  const { hasRole } = useSession();
  const canEdit = hasRole('hr');
  const [q, setQ] = useState('');
  const [orgUnit, setOrgUnit] = useState('');
  const [inclInactive, setInclInactive] = useState(false);
  const [creating, setCreating] = useState(false);

  const unitsQ = useApi(
    () => api<unknown>('/org-units').then((d) => unwrapList<OrgUnit>(d)),
    [],
  );
  const schedulesQ = useApi(
    () => api<unknown>('/schedules').then((d) => unwrapList<Schedule>(d)),
    [],
  );
  const listQ = useApi(
    () =>
      api<unknown>('/employees', {
        query: {
          q: q || undefined,
          org_unit_id: orgUnit || undefined,
          include_inactive: inclInactive || undefined,
        },
      }).then((d) => unwrapList<EmployeeListItem>(d)),
    [q, orgUnit, inclInactive],
  );

  // create form
  const [f, setF] = useState({
    service_id: '',
    full_name: '',
    email: '',
    start_date: '',
    org_unit_id: 0,
    manager_employee_id: 0,
    schedule_id: 0,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await post('/employees', {
        service_id: f.service_id,
        full_name: f.full_name,
        email: f.email || undefined,
        start_date: f.start_date,
        org_unit_id: f.org_unit_id || undefined,
        manager_employee_id: f.manager_employee_id || undefined,
        schedule_id: f.schedule_id || undefined,
      });
      setCreating(false);
      setF({ service_id: '', full_name: '', email: '', start_date: '', org_unit_id: 0, manager_employee_id: 0, schedule_id: 0 });
      listQ.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>People</h1>
      <div className="panel">
        <div className="toolbar">
          <Field label="Search">
            <input
              type="text"
              value={q}
              placeholder="name or service ID"
              onChange={(e) => setQ(e.target.value)}
            />
          </Field>
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
          <label className="field" style={{ paddingBottom: '0.5rem' }}>
            <input
              type="checkbox"
              checked={inclInactive}
              onChange={(e) => setInclInactive(e.target.checked)}
            />{' '}
            include deactivated
          </label>
          {canEdit ? (
            <button className="btn" onClick={() => setCreating(true)}>
              New employee
            </button>
          ) : null}
        </div>

        {listQ.loading ? <Loading /> : null}
        {listQ.error ? <ErrBox error={listQ.error} /> : null}
        {listQ.data && listQ.data.length === 0 ? <Empty>No employees match.</Empty> : null}
        {listQ.data && listQ.data.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Service ID</th>
                  <th>Org unit</th>
                  <th>Manager</th>
                  <th>Schedule</th>
                  <th>Employed</th>
                  <th>Login</th>
                </tr>
              </thead>
              <tbody>
                {listQ.data.map((e) => (
                  <tr key={e.id} style={e.active ? undefined : { opacity: 0.55 }}>
                    <td>
                      <Link className="req-num" to={`/people/${e.id}`}>
                        {e.full_name}
                      </Link>
                      {!e.active ? <span className="badge" style={{ marginLeft: '0.4rem' }}>inactive</span> : null}
                    </td>
                    <td className="mono small">{e.service_id}</td>
                    <td className="small">{e.org_unit?.name ?? '—'}</td>
                    <td className="small">{e.manager?.full_name ?? '—'}</td>
                    <td className="small">{e.schedule?.name ?? '—'}</td>
                    <td className="small">
                      {fmtDate(e.start_date)}
                      {e.end_date ? ` – ${fmtDate(e.end_date)}` : ' –'}
                    </td>
                    <td className="small">{e.has_login ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {creating ? (
        <Modal title="New employee" onClose={() => setCreating(false)}>
          {err ? <ErrBox error={err} /> : null}
          <div className="form-grid">
            <Field label="Service ID">
              <input value={f.service_id} onChange={(e) => setF({ ...f, service_id: e.target.value })} />
            </Field>
            <Field label="Full name">
              <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
            </Field>
          </div>
          <Field label="Email (optional — creates a login only when a user record is added)">
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <div className="form-grid">
            <Field label="Start date">
              <input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} />
            </Field>
            <Field label="Org unit">
              <select value={f.org_unit_id} onChange={(e) => setF({ ...f, org_unit_id: Number(e.target.value) })}>
                <option value={0}>—</option>
                {unitsQ.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label="Manager">
              <select
                value={f.manager_employee_id}
                onChange={(e) => setF({ ...f, manager_employee_id: Number(e.target.value) })}
              >
                <option value={0}>—</option>
                {listQ.data?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.full_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Schedule">
              <select value={f.schedule_id} onChange={(e) => setF({ ...f, schedule_id: Number(e.target.value) })}>
                <option value={0}>—</option>
                {schedulesQ.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy || !f.service_id || !f.full_name || !f.start_date} onClick={() => void create()}>
              {busy ? 'Saving…' : 'Create'}
            </button>
            <button className="btn btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
