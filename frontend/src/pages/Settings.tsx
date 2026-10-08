import { useState } from 'react';
import { api, ApiError, del, post, put, unwrapList } from '../api/client';
import type {
  CalendarException,
  Delegation,
  LeaveType,
  OrgUnit,
  Role,
  Schedule,
  ScheduleWeek,
  UserListItem,
} from '../api/types';
import { Empty, ErrBox, Field, Loading, Modal } from '../components/ui';
import { fmtDate, fmtHours } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

const TABS = ['Leave types', 'Schedules', 'Holidays', 'Users & roles', 'Delegations'] as const;

const WEEK_DAYS: (keyof ScheduleWeek)[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ROLES: Role[] = [
  'hr',
  'hr_medical',
  'final_approver',
  'adjustment_approver',
  'tech_admin',
  'auditor',
];

export default function Settings() {
  const { hasRole } = useSession();
  const isHr = hasRole('hr');
  const isAdmin = hasRole('tech_admin');
  const [tab, setTab] = useState<(typeof TABS)[number]>(isHr ? 'Leave types' : 'Users & roles');
  return (
    <>
      <h1>Settings</h1>
      <div className="tabs" role="tablist">
        {TABS.filter((t) =>
          t === 'Users & roles' || t === 'Delegations' ? true : isHr,
        ).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Leave types' ? <LeaveTypesTab canEdit={isHr} /> : null}
      {tab === 'Schedules' ? <SchedulesTab canEdit={isHr} /> : null}
      {tab === 'Holidays' ? <HolidaysTab canEdit={isHr} /> : null}
      {tab === 'Users & roles' ? <UsersTab canEdit={isAdmin} /> : null}
      {tab === 'Delegations' ? <DelegationsTab canEdit={isHr || isAdmin} /> : null}
    </>
  );
}

/* ---------------- Leave types ---------------- */

function LeaveTypesTab({ canEdit }: { canEdit: boolean }) {
  const q = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const [modal, setModal] = useState<'type' | 'policy' | null>(null);
  const [sel, setSel] = useState<LeaveType | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [tf, setTf] = useState({
    code: '',
    name: '',
    sensitive: false,
    paid: true,
    uses_balance: true,
    allow_half_day: true,
    requires_attachment: false,
    min_notice_days: 0,
    active: true,
  });
  const [pf, setPf] = useState({
    valid_from: '',
    annual_entitlement_min: 9600,
    accrual_mode: 'annual_upfront',
    advance_publish_months: 0,
    carryover_allowed: false,
    carryover_expiry_months: 0,
    allow_negative: false,
    explanation: '',
  });

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setModal(null);
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;

  return (
    <div className="panel">
      {canEdit ? (
        <div className="btn-row" style={{ marginTop: 0 }}>
          <button
            className="btn"
            onClick={() => {
              setTf({ code: '', name: '', sensitive: false, paid: true, uses_balance: true, allow_half_day: true, requires_attachment: false, min_notice_days: 0, active: true });
              setSel(null);
              setModal('type');
            }}
          >
            New leave type
          </button>
        </div>
      ) : null}
      {q.data?.map((t) => (
        <div key={t.id} className="panel" style={{ boxShadow: 'none', marginTop: '0.8rem' }}>
          <h3 style={{ marginTop: 0 }}>
            {t.name} <span className="mono small muted">{t.code}</span>{' '}
            {!t.active ? <span className="badge">inactive</span> : null}
            {t.sensitive ? <span className="badge badge-med">sensitive</span> : null}
          </h3>
          <p className="small">
            {t.paid ? 'paid' : 'unpaid'} · {t.uses_balance ? 'uses balance' : 'no balance'} ·{' '}
            {t.allow_half_day ? 'half days allowed' : 'whole days only'} · min notice{' '}
            {t.min_notice_days} d{t.requires_attachment ? ' · attachment required' : ''}
          </p>
          {t.policy ? (
            <div className="small">
              <p>
                Policy from {fmtDate(t.policy.valid_from)}: {fmtHours(t.policy.annual_entitlement_min)}/year
                , accrual {t.policy.accrual_mode}
                {t.policy.advance_publish_months
                  ? `, published ${t.policy.advance_publish_months} months ahead`
                  : ''}
                , carry-over {t.policy.carryover_allowed ? `allowed${t.policy.carryover_expiry_months ? `, expires after ${t.policy.carryover_expiry_months} months` : ', no expiry'}` : 'not allowed'}
                {t.policy.allow_negative ? ', negative balance allowed' : ''}.
              </p>
              <p className="muted">{t.policy.explanation}</p>
              {t.policy.status === 'demo_fictional' ? (
                <span className="badge badge-demo">Fictional demo rule — not Nauru law</span>
              ) : t.policy.status === 'verified' ? (
                <span className="badge badge-ok">
                  Verified{t.policy.verified_by ? ` by ${t.policy.verified_by.display_name}` : ''}
                </span>
              ) : (
                <span className="badge badge-med">Rule not verified — {t.policy.status}</span>
              )}{' '}
              {canEdit && t.policy.status !== 'verified' ? (
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => post(`/policies/${t.policy!.id}/verify`).then(() => undefined))
                  }
                >
                  Verify rule
                </button>
              ) : null}
            </div>
          ) : (
            <p className="muted small">No policy version.</p>
          )}
          {canEdit ? (
            <div className="btn-row">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setSel(t);
                  setTf({
                    code: t.code,
                    name: t.name,
                    sensitive: t.sensitive,
                    paid: t.paid,
                    uses_balance: t.uses_balance,
                    allow_half_day: t.allow_half_day,
                    requires_attachment: t.requires_attachment,
                    min_notice_days: t.min_notice_days,
                    active: t.active,
                  });
                  setModal('type');
                }}
              >
                Edit
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setSel(t);
                  setModal('policy');
                }}
              >
                New policy version
              </button>
            </div>
          ) : null}
        </div>
      ))}

      {modal === 'type' ? (
        <Modal title={sel ? `Edit ${sel.name}` : 'New leave type'} onClose={() => setModal(null)}>
          {err ? <ErrBox error={err} /> : null}
          <div className="form-grid">
            <Field label="Code">
              <input value={tf.code} onChange={(e) => setTf({ ...tf, code: e.target.value })} disabled={!!sel} />
            </Field>
            <Field label="Name">
              <input value={tf.name} onChange={(e) => setTf({ ...tf, name: e.target.value })} />
            </Field>
          </div>
          <div className="form-grid">
            {(
              [
                ['sensitive', 'Sensitive (details restricted)'],
                ['paid', 'Paid'],
                ['uses_balance', 'Uses balance'],
                ['allow_half_day', 'Allow half days'],
                ['requires_attachment', 'Requires attachment'],
                ['active', 'Active'],
              ] as [keyof typeof tf, string][]
            ).map(([k, label]) =>
              k === 'code' || k === 'name' || k === 'min_notice_days' ? null : (
                <label key={k} className="field">
                  <input
                    type="checkbox"
                    checked={tf[k] as boolean}
                    onChange={(e) => setTf({ ...tf, [k]: e.target.checked })}
                  />{' '}
                  {label}
                </label>
              ),
            )}
            <Field label="Min notice (days)">
              <input type="number" min={0} value={tf.min_notice_days} onChange={(e) => setTf({ ...tf, min_notice_days: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !tf.code || !tf.name}
              onClick={() =>
                void run(async () => {
                  const body = {
                    code: tf.code,
                    name: tf.name,
                    sensitive: tf.sensitive,
                    paid: tf.paid,
                    uses_balance: tf.uses_balance,
                    allow_half_day: tf.allow_half_day,
                    requires_attachment: tf.requires_attachment,
                    min_notice_days: tf.min_notice_days,
                    active: tf.active,
                  };
                  if (sel) await put(`/leave-types/${sel.id}`, body);
                  else await post('/leave-types', body);
                })
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {modal === 'policy' && sel ? (
        <Modal title={`New policy version — ${sel.name}`} onClose={() => setModal(null)}>
          {err ? <ErrBox error={err} /> : null}
          <div className="form-grid">
            <Field label="Valid from">
              <input type="date" value={pf.valid_from} onChange={(e) => setPf({ ...pf, valid_from: e.target.value })} />
            </Field>
            <Field label="Annual entitlement (minutes)">
              <input type="number" step="60" value={pf.annual_entitlement_min} onChange={(e) => setPf({ ...pf, annual_entitlement_min: Number(e.target.value) })} />
            </Field>
            <Field label="Accrual mode">
              <select value={pf.accrual_mode} onChange={(e) => setPf({ ...pf, accrual_mode: e.target.value })}>
                <option value="annual_upfront">annual_upfront</option>
                <option value="monthly">monthly</option>
                <option value="none">none</option>
              </select>
            </Field>
            <Field label="Advance publish (months)">
              <input type="number" min={0} value={pf.advance_publish_months} onChange={(e) => setPf({ ...pf, advance_publish_months: Number(e.target.value) })} />
            </Field>
          </div>
          <label className="field">
            <input type="checkbox" checked={pf.carryover_allowed} onChange={(e) => setPf({ ...pf, carryover_allowed: e.target.checked })} />{' '}
            Carry-over allowed
          </label>
          {pf.carryover_allowed ? (
            <Field label="Carry-over expires after (months, 0 = never)">
              <input type="number" min={0} value={pf.carryover_expiry_months} onChange={(e) => setPf({ ...pf, carryover_expiry_months: Number(e.target.value) })} />
            </Field>
          ) : null}
          <label className="field">
            <input type="checkbox" checked={pf.allow_negative} onChange={(e) => setPf({ ...pf, allow_negative: e.target.checked })} />{' '}
            Allow negative balance
          </label>
          <Field label="Explanation (required — what rule this encodes)">
            <textarea value={pf.explanation} onChange={(e) => setPf({ ...pf, explanation: e.target.value })} />
          </Field>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !pf.valid_from || !pf.explanation}
              onClick={() =>
                void run(() =>
                  post(`/leave-types/${sel.id}/policies`, {
                    valid_from: pf.valid_from,
                    annual_entitlement_min: pf.annual_entitlement_min,
                    accrual_mode: pf.accrual_mode,
                    advance_publish_months: pf.advance_publish_months,
                    carryover_allowed: pf.carryover_allowed,
                    carryover_expiry_months: pf.carryover_expiry_months,
                    allow_negative: pf.allow_negative,
                    explanation: pf.explanation,
                  }).then(() => undefined),
                )
              }
            >
              {busy ? 'Saving…' : 'Create policy version'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ---------------- Schedules ---------------- */

function SchedulesTab({ canEdit }: { canEdit: boolean }) {
  const q = useApi(() => api<unknown>('/schedules').then((d) => unwrapList<Schedule>(d)), []);
  const [modal, setModal] = useState<'schedule' | 'version' | null>(null);
  const [sel, setSel] = useState<Schedule | null>(null);
  const [name, setName] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [week, setWeek] = useState<ScheduleWeek>({ mon: 480, tue: 480, wed: 480, thu: 480, fri: 480, sat: 0, sun: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setModal(null);
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  function weekCells(w: ScheduleWeek | number[]) {
    if (Array.isArray(w)) return w.map((m, i) => `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]} ${m / 60}h`).join(' · ');
    return WEEK_DAYS.map((d) => `${d.slice(0, 1).toUpperCase()}${d.slice(1, 3)} ${w[d] / 60}h`).join(' · ');
  }

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;

  return (
    <div className="panel">
      {canEdit ? (
        <div className="btn-row" style={{ marginTop: 0 }}>
          <button className="btn" onClick={() => setModal('schedule')}>
            New schedule
          </button>
        </div>
      ) : null}
      {q.data?.map((s) => (
        <div key={s.id} className="panel" style={{ boxShadow: 'none', marginTop: '0.8rem' }}>
          <h3 style={{ marginTop: 0 }}>{s.name}</h3>
          {s.versions?.length ? (
            <table className="small">
              <thead>
                <tr>
                  <th>Valid from</th>
                  <th>Working minutes per weekday</th>
                </tr>
              </thead>
              <tbody>
                {s.versions.map((v) => (
                  <tr key={v.id}>
                    <td>{fmtDate(v.valid_from)}</td>
                    <td>{weekCells(v.week)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">No versions listed.</p>
          )}
          {canEdit ? (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSel(s);
                setModal('version');
              }}
            >
              Add version
            </button>
          ) : null}
        </div>
      ))}

      {modal === 'schedule' ? (
        <Modal title="New schedule" onClose={() => setModal(null)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Valid from">
            <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <fieldset>
            <legend>Working minutes per weekday</legend>
            <div className="form-grid">
              {WEEK_DAYS.map((d) => (
                <Field key={d} label={d}>
                  <input type="number" step="30" min={0} value={week[d]} onChange={(e) => setWeek({ ...week, [d]: Number(e.target.value) })} />
                </Field>
              ))}
            </div>
          </fieldset>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !name || !validFrom}
              onClick={() => void run(() => post('/schedules', { name, valid_from: validFrom, week }).then(() => undefined))}
            >
              {busy ? 'Saving…' : 'Create'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {modal === 'version' && sel ? (
        <Modal title={`New version — ${sel.name}`} onClose={() => setModal(null)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Valid from">
            <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <fieldset>
            <legend>Working minutes per weekday</legend>
            <div className="form-grid">
              {WEEK_DAYS.map((d) => (
                <Field key={d} label={d}>
                  <input type="number" step="30" min={0} value={week[d]} onChange={(e) => setWeek({ ...week, [d]: Number(e.target.value) })} />
                </Field>
              ))}
            </div>
          </fieldset>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !validFrom}
              onClick={() => void run(() => post(`/schedules/${sel.id}/versions`, { valid_from: validFrom, week }).then(() => undefined))}
            >
              {busy ? 'Saving…' : 'Add version'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ---------------- Holidays ---------------- */

function HolidaysTab({ canEdit }: { canEdit: boolean }) {
  const q = useApi(
    () => api<unknown>('/calendar-exceptions').then((d) => unwrapList<CalendarException>(d)),
    [],
  );
  const [modal, setModal] = useState(false);
  const [f, setF] = useState({ date: '', name: '', minutes: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(fn: () => Promise<{ affected_future_requests?: { number: string }[] } | void>) {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await fn();
      const aff = r && 'affected_future_requests' in r ? r.affected_future_requests : undefined;
      if (aff?.length)
        setNotice(`Affected future requests: ${aff.map((x) => x.number).join(', ')}`);
      setModal(false);
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      {notice ? <div className="alert alert-info">{notice}</div> : null}
      {canEdit ? (
        <div className="btn-row" style={{ marginTop: 0 }}>
          <button className="btn" onClick={() => setModal(true)}>
            Add holiday / exception
          </button>
        </div>
      ) : null}
      {q.loading ? <Loading /> : null}
      {q.error ? <ErrBox error={q.error} /> : null}
      {q.data && q.data.length === 0 ? <Empty>No calendar exceptions.</Empty> : null}
      {q.data && q.data.length ? (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Name</th>
              <th className="num">Working minutes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((x) => (
              <tr key={x.id}>
                <td>{fmtDate(x.date)}</td>
                <td>{x.name}</td>
                <td className="num">{x.minutes}</td>
                <td>
                  {canEdit ? (
                    <button
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await del<Record<string, never>>(`/calendar-exceptions/${x.id}`);
                          return {};
                        })
                      }
                    >
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {modal ? (
        <Modal title="Add holiday / calendar exception" onClose={() => setModal(false)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Date">
            <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Independence Day" />
          </Field>
          <Field label="Working minutes that day (0 = full holiday)">
            <input type="number" min={0} step="30" value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} />
          </Field>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !f.date || !f.name}
              onClick={() => void run(() => post('/calendar-exceptions', f))}
            >
              {busy ? 'Saving…' : 'Add'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ---------------- Users & roles ---------------- */

function UsersTab({ canEdit }: { canEdit: boolean }) {
  const q = useApi(() => api<unknown>('/users').then((d) => unwrapList<UserListItem>(d)), []);
  const unitsQ = useApi(() => api<unknown>('/org-units').then((d) => unwrapList<OrgUnit>(d)), []);
  const [modal, setModal] = useState<'user' | 'role' | null>(null);
  const [sel, setSel] = useState<UserListItem | null>(null);
  const [uf, setUf] = useState({ email: '', display_name: '', active: true });
  const [rf, setRf] = useState<{ role: Role; scope: number }>({ role: 'hr', scope: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setModal(null);
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;

  return (
    <div className="panel">
      <p className="muted small">
        User accounts and role grants. Deactivating a user revokes their sessions; their history is
        kept.
      </p>
      {canEdit ? (
        <div className="btn-row" style={{ marginTop: 0 }}>
          <button
            className="btn"
            onClick={() => {
              setSel(null);
              setUf({ email: '', display_name: '', active: true });
              setModal('user');
            }}
          >
            New user
          </button>
        </div>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Linked employee</th>
              <th>Roles</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.map((u) => (
              <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                <td>
                  {u.display_name}
                  <div className="muted small">{u.email}</div>
                </td>
                <td className="small">{u.employee?.full_name ?? '—'}</td>
                <td>
                  {(u.roles ?? []).map((r) => (
                    <span key={r.id} className="badge" style={{ marginRight: '0.3rem' }}>
                      {r.role.replaceAll('_', ' ')}
                      {r.scope_name && r.scope_name !== 'all' ? ` (${r.scope_name})` : ''}
                      {canEdit ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          title="Revoke role"
                          disabled={busy}
                          onClick={() => void run(() => del(`/role-grants/${r.id}`).then(() => undefined))}
                        >
                          ✕
                        </button>
                      ) : null}
                    </span>
                  ))}
                </td>
                <td>
                  {canEdit ? (
                    <span className="btn-row" style={{ marginTop: 0 }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setSel(u);
                          setUf({ email: u.email, display_name: u.display_name, active: u.active });
                          setModal('user');
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setSel(u);
                          setModal('role');
                        }}
                      >
                        Add role
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal === 'user' ? (
        <Modal title={sel ? `Edit ${sel.display_name}` : 'New user'} onClose={() => setModal(null)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Email">
            <input type="email" value={uf.email} onChange={(e) => setUf({ ...uf, email: e.target.value })} />
          </Field>
          <Field label="Display name">
            <input value={uf.display_name} onChange={(e) => setUf({ ...uf, display_name: e.target.value })} />
          </Field>
          <label className="field">
            <input type="checkbox" checked={uf.active} onChange={(e) => setUf({ ...uf, active: e.target.checked })} />{' '}
            active (deactivating revokes sessions)
          </label>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !uf.email || !uf.display_name}
              onClick={() =>
                void run(async () => {
                  if (sel) await put(`/users/${sel.id}`, uf);
                  else await post('/users', uf);
                })
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {modal === 'role' && sel ? (
        <Modal title={`Add role — ${sel.display_name}`} onClose={() => setModal(null)}>
          {err ? <ErrBox error={err} /> : null}
          <Field label="Role">
            <select value={rf.role} onChange={(e) => setRf({ ...rf, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scope (org unit; empty = all)">
            <select value={rf.scope} onChange={(e) => setRf({ ...rf, scope: Number(e.target.value) })}>
              <option value={0}>All units</option>
              {unitsQ.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  post(`/users/${sel.id}/roles`, {
                    role: rf.role,
                    scope_org_unit_id: rf.scope || undefined,
                  }).then(() => undefined),
                )
              }
            >
              {busy ? 'Saving…' : 'Grant role'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ---------------- Delegations ---------------- */

function DelegationsTab({ canEdit }: { canEdit: boolean }) {
  const { me } = useSession();
  const q = useApi(() => api<unknown>('/delegations').then((d) => unwrapList<Delegation>(d)), []);
  const usersQ = useApi(() => api<unknown>('/users').then((d) => unwrapList<UserListItem>(d)).catch(() => [] as UserListItem[]), []);
  const [modal, setModal] = useState(false);
  const [f, setF] = useState({ from_user_id: 0, to_user_id: 0, scope: 'manager_recommendation', valid_from: '', valid_to: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const { config } = useSession();

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setModal(false);
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;
  const today = config?.business_date ?? '';

  return (
    <div className="panel">
      <p className="muted small">
        A delegation lets one person act for another in a defined scope and date range. Decisions
        record the real actor plus who they acted for. Self-approval stays forbidden.
      </p>
      <div className="btn-row" style={{ marginTop: 0 }}>
        <button className="btn" onClick={() => setModal(true)}>
          New delegation
        </button>
      </div>
      {q.data && q.data.length === 0 ? <Empty>No delegations.</Empty> : null}
      {q.data && q.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Acts for</th>
                <th>Delegate</th>
                <th>Scope</th>
                <th>Valid</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((x) => {
                const active =
                  !x.revoked_at && x.valid_from <= today && today <= x.valid_to;
                return (
                  <tr key={x.id} style={active ? undefined : { opacity: 0.55 }}>
                    <td>{x.from_user.display_name}</td>
                    <td>
                      {x.to_user.display_name}
                      {active ? <span className="badge" style={{ marginLeft: '0.4rem', background: 'var(--ok-bg)', color: 'var(--ok)', borderColor: '#9ccbab' }}>active</span> : null}
                      {x.revoked_at ? <span className="badge" style={{ marginLeft: '0.4rem' }}>revoked</span> : null}
                    </td>
                    <td className="small">{x.scope.replaceAll('_', ' ')}</td>
                    <td className="small">
                      {fmtDate(x.valid_from)} – {fmtDate(x.valid_to)}
                    </td>
                    <td className="small">{x.reason ?? '—'}</td>
                    <td>
                      {canEdit && !x.revoked_at ? (
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={busy}
                          onClick={() => void run(() => post(`/delegations/${x.id}/revoke`).then(() => undefined))}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {modal ? (
        <Modal title="New delegation" onClose={() => setModal(false)}>
          {err ? <ErrBox error={err} /> : null}
          <div className="form-grid">
            <Field label="From (who is being substituted)">
              <select value={f.from_user_id} onChange={(e) => setF({ ...f, from_user_id: Number(e.target.value) })}>
                <option value={0}>—</option>
                {usersQ.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name}
                    {u.id === me?.user.id ? ' (you)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To (who acts)">
              <select value={f.to_user_id} onChange={(e) => setF({ ...f, to_user_id: Number(e.target.value) })}>
                <option value={0}>—</option>
                {usersQ.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Scope">
            <select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
              <option value="manager_recommendation">Manager recommendation</option>
              <option value="hr_check">HR check</option>
              <option value="final_decision">Final decision</option>
              <option value="all_approvals">All approvals</option>
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Valid from">
              <input type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} />
            </Field>
            <Field label="Valid to">
              <input type="date" value={f.valid_to} min={f.valid_from} onChange={(e) => setF({ ...f, valid_to: e.target.value })} />
            </Field>
          </div>
          <Field label="Reason">
            <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </Field>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !f.from_user_id || !f.to_user_id || !f.valid_from || !f.valid_to || f.from_user_id === f.to_user_id}
              onClick={() => void run(() => post('/delegations', f).then(() => undefined))}
            >
              {busy ? 'Saving…' : 'Create delegation'}
            </button>
            <button className="btn btn-secondary" onClick={() => setModal(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
