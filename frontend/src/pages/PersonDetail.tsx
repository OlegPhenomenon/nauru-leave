import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, ApiError, put, unwrapList } from '../api/client';
import type {
  EmployeeDetail,
  EmployeeListItem,
  OrgUnit,
  RequestSummary,
  Schedule,
} from '../api/types';
import {
  DataTable,
  Details,
  ErrBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  StatusBadge,
  Tag,
  useToast,
} from '../components/ui';
import { fmtBalance } from '../lib/domain';
import { CorrectDialog } from './Balances';
import './People.css';
import { fmtDate, fmtDuration, fmtRange, orgUnitName } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { ApprovedRequestActions } from './request/ApprovedActions';
import {
  EndEmploymentDialog,
  PatternDialog,
  TransferDialog,
  type AffectedRequest,
} from './people/dialogs';

type Dialog = 'correct' | 'edit' | 'transfer' | 'pattern' | 'end' | null;

/** The API returns schedule history rows flat: {id, name, valid_from, valid_to}. */
type SchedHist = { id: number; name: string; valid_from: string; valid_to: string | null };

export default function PersonDetail() {
  const { id } = useParams();
  const { hasRole, config } = useSession();
  const canEdit = hasRole('hr');
  const today = config?.business_date ?? '';
  const [sp] = useSearchParams();
  const isNew = sp.get('new') === '1';
  const toast = useToast();

  const q = useApi(() => api<EmployeeDetail>(`/employees/${id}`), [id]);
  const unitsQ = useApi(() => api<unknown>('/org-units').then((d) => unwrapList<OrgUnit>(d)), []);
  const schedulesQ = useApi(() => api<unknown>('/schedules').then((d) => unwrapList<Schedule>(d)), []);
  const peopleQ = useApi(
    () => api<unknown>('/employees').then((d) => unwrapList<EmployeeListItem>(d)),
    [],
  );
  const reqsQ = useApi(
    () =>
      api<unknown>('/requests', {
        query: { scope: 'all', employee_id: id ?? '' },
      }).then((d) => unwrapList<RequestSummary>(d)),
    [id],
  );

  const [correctTypeId, setCorrectTypeId] = useState(0);
  const typesQ = useApi(() => api<unknown>('/leave-types').then(d => unwrapList<import('../api/types').LeaveType>(d)), []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [affected, setAffected] = useState<AffectedRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [edit, setEdit] = useState({ full_name: '', email: '' });

  const e = q.data;

  function openEdit() {
    if (!e) return;
    setEdit({ full_name: e.full_name, email: e.email ?? '' });
    setErr(null);
    setDialog('edit');
  }

  async function saveEdit() {
    if (!e) return;
    setBusy(true);
    setErr(null);
    try {
      await put(`/employees/${e.id}`, {
        full_name: edit.full_name.trim(),
        email: edit.email.trim() || null,
        end_date: e.end_date,
        active: e.active,
        expected_version: e.version,
      });
      setDialog(null);
      setFlash('Details saved.');
      void q.reload();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex : new ApiError(0, 'unknown', String(ex)));
    } finally {
      setBusy(false);
    }
  }

  async function reinstate() {
    if (!e) return;
    setBusy(true);
    setErr(null);
    try {
      await put(`/employees/${e.id}`, {
        full_name: e.full_name,
        email: e.email,
        end_date: null,
        active: true,
        expected_version: e.version,
      });
      setFlash(`${e.full_name} is active again.`);
      void q.reload();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex : new ApiError(0, 'unknown', String(ex)));
      toast('Could not save that. Try again.', 'err');
    } finally {
      setBusy(false);
    }
  }

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;
  if (!e) return null;

  const unit = e.org_unit ? orgUnitName(e.org_unit.name) : null;
  const units = unitsQ.data?.filter((u) => u.active) ?? [];
  const schedHistory = e.schedules as unknown as SchedHist[];
  const reqs = reqsQ.data ?? [];

  const subline = [
    `Staff no. ${e.service_id}`,
    unit,
    e.manager ? `reports to ${e.manager.full_name}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const requestColumns = [
    { label: 'Dates', title: true, render: (r: RequestSummary) => fmtRange(r.start_date, r.end_date) },
    { label: 'Type', render: (r: RequestSummary) => r.leave_type_name },
    {
      label: 'Days',
      className: 'nowrap',
      render: (r: RequestSummary) => fmtDuration(r.total_minutes, r.minutes_per_day),
    },
    {
      label: 'Status',
      render: (r: RequestSummary) => <StatusBadge status={r.status} />,
    },
    ...(canEdit ? [{ label: 'Actions', render: (r: RequestSummary) => r.kind === 'leave' && r.status === 'approved' ? <ApprovedRequestActions requestId={r.id} /> : null }] : []),
  ];

  return (
    <div className="stack person-page">
      <PageHeader
        back={{ to: '/people', label: 'People' }}
        title={
          <>
            {e.full_name}{' '}
            <Tag>{e.active ? 'Active' : `Left${e.end_date ? ` ${fmtDate(e.end_date)}` : ''}`}</Tag>
          </>
        }
        subtitle={subline}
        primary={
          canEdit ? (
            <Link className="btn" to={isNew ? `/balances?employee=${e.id}&correct=1` : `/requests/new?employee=${e.id}`}>
              {isNew ? 'Set opening balance…' : 'Enter paper form'}
            </Link>
          ) : undefined
        }
        more={
          canEdit
            ? [
                { label: 'Edit name or email…', onSelect: openEdit },
                e.active
                  ? { label: 'End employment…', danger: true, onSelect: () => setDialog('end') }
                  : { label: 'Reinstate…', onSelect: () => void reinstate() },
              ]
            : undefined
        }
      />

      {isNew ? (
        <p className="next-hint">
          <strong>{e.full_name} is added.</strong> Next step:{' '}
          <Link to={`/balances?employee=${e.id}&correct=1`}>set their opening balance</Link>.
        </p>
      ) : null}

      <div className="panel">
        <dl className="kv">
          <div className="kv-row">
            <dt>Contact</dt>
            <dd>
              {e.email ?? 'No email'}{' '}
              {canEdit ? (
                <button type="button" className="btn btn-ghost btn-sm link-sm" onClick={openEdit}>
                  Change…
                </button>
              ) : null}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Unit &amp; manager</dt>
            <dd>
              {unit ?? '—'}
              {e.manager ? ` · reports to ${e.manager.full_name}` : ''}{' '}
              {canEdit ? (
                <button type="button" className="btn btn-ghost btn-sm link-sm" onClick={() => setDialog('transfer')}>
                  Change…
                </button>
              ) : null}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Work pattern</dt>
            <dd>
              {e.schedule?.name ?? '—'}{' '}
              {canEdit ? (
                <button type="button" className="btn btn-ghost btn-sm link-sm" onClick={() => setDialog('pattern')}>
                  Change…
                </button>
              ) : null}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Employment</dt>
            <dd>
              {e.end_date
                ? `${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}`
                : `since ${fmtDate(e.start_date)}`}{' '}
              {canEdit && e.active ? (
                <button type="button" className="btn btn-ghost btn-sm link-sm" onClick={() => setDialog('end')}>
                  End…
                </button>
              ) : null}
            </dd>
          </div>
        </dl>
        {flash ? <p className="alert alert-ok">{flash}</p> : null}
        {affected.length > 0 ? (
          <p className="alert alert-info">
            {affected.length} future {affected.length === 1 ? 'request needs' : 'requests need'}{' '}
            checking:{' '}
            {affected.map((r) => (
              <Link key={r.id} className="req-num" to={`/requests/${r.id}`}>
                {r.number}
              </Link>
            ))}
          </p>
        ) : null}
      </div>

      {e.balances && e.balances.filter((b) => b.leave_type.uses_balance).length > 0 ? (
        <div className="panel">
          <h2>Leave left</h2>
          <dl className="kv">
            {e.balances
              .filter((b) => b.leave_type.uses_balance)
              .map((b) => (
                <div className="kv-row" key={b.leave_type.id}>
                  <dt>{b.leave_type.name}</dt>
                  <dd>
                    <strong>{fmtBalance(b.available_minutes, b.minutes_per_day)} left</strong>
                    {b.reserved_minutes > 0 ? (
                      <span className="muted">
                        {' '}
                        · {fmtDuration(b.reserved_minutes, b.minutes_per_day)} waiting for approval
                      </span>
                    ) : null}{' '}
                    {canEdit ? (
                      <button className="btn btn-ghost btn-sm link-sm" onClick={() => { setCorrectTypeId(b.leave_type.id); setDialog('correct'); }}>Correct…</button>
                    ) : null}{' '}
                    <Link
                      className="link-sm"
                      to={`/balances/${e.id}/explain?leave_type_id=${b.leave_type.id}`}
                    >
                      How is this worked out?
                    </Link>
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      ) : null}

      {reqs.length > 0 ? (
        <div className="panel">
          <h2>Requests</h2>
          <DataTable<RequestSummary>
            columns={requestColumns}
            rows={reqs.slice(0, 5)}
            rowLink={(r) => `/requests/${r.id}`}
            empty="No requests yet."
          />
          {reqs.length > 5 ? (
            <Details title="Older requests" count={reqs.length - 5}>
              <DataTable<RequestSummary>
                columns={requestColumns}
                rows={reqs.slice(5)}
                rowLink={(r) => `/requests/${r.id}`}
              />
            </Details>
          ) : null}
        </div>
      ) : null}

      <Details title="History">
        <div className="two-col">
          <div>
            <h3>Unit &amp; manager</h3>
            {e.assignments.length === 0 ? (
              <p className="empty">No history.</p>
            ) : (
              <div className="table-wrap">
                <table className="small">
                  <thead>
                    <tr>
                      <th>Unit</th>
                      <th>Manager</th>
                      <th>Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.assignments.map((a, i) => (
                      <tr key={i}>
                        <td>{a.org_unit ? orgUnitName(a.org_unit.name) : '—'}</td>
                        <td>{a.manager?.full_name ?? '—'}</td>
                        <td className="nowrap">
                          {fmtDate(a.valid_from)} – {a.valid_to ? fmtDate(a.valid_to) : 'now'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h3>Work pattern</h3>
            {schedHistory.length === 0 ? (
              <p className="empty">No history.</p>
            ) : (
              <div className="table-wrap">
                <table className="small">
                  <thead>
                    <tr>
                      <th>Pattern</th>
                      <th>Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedHistory.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td className="nowrap">
                          {fmtDate(s.valid_from)} – {s.valid_to ? fmtDate(s.valid_to) : 'now'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </Details>

      <Details title="Login &amp; access">
        {e.user ? (
          <dl className="kv">
            <div className="kv-row">
              <dt>Sign-in email</dt>
              <dd>{e.user.email}</dd>
            </div>
            <div className="kv-row">
              <dt>Access</dt>
              <dd>
                <Link to={`/settings/users?user=${e.user.id}`}>Edit access</Link>
              </dd>
            </div>
            <div className="kv-row">
              <dt>Stand-in</dt>
              <dd>
                <Link to={`/settings/delegations?new=1&for=${e.user.id}`}>Set stand-in</Link>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="empty">No sign-in — {e.full_name} is served on paper.</p>
        )}
      </Details>

      {dialog === 'correct' && typesQ.data ? <CorrectDialog employee={e} types={typesQ.data} initialTypeId={correctTypeId} initialMinutesPerDay={e.balances?.find(b => b.leave_type.id === correctTypeId)?.minutes_per_day} businessYear={Number(today.slice(0,4))} onClose={() => setDialog(null)} onDone={() => { setDialog(null); q.reload(); }} /> : null}
      {dialog === 'edit' ? (
        <Modal
          title="Edit name or email"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || edit.full_name.trim() === ''}
                onClick={() => void saveEdit()}
              >
                Save
              </button>
            </>
          }
        >
          <ErrBox error={err} />
          <Field label="Name">
            <input
              type="text"
              value={edit.full_name}
              onChange={(x) => setEdit({ ...edit, full_name: x.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={edit.email}
              onChange={(x) => setEdit({ ...edit, email: x.target.value })}
            />
          </Field>
        </Modal>
      ) : null}

      {dialog === 'transfer' ? (
        <TransferDialog
          employee={e}
          units={units}
          people={(peopleQ.data ?? []).filter((p) => p.active)}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null);
            setAffected([]);
            setFlash(msg);
            void q.reload();
          }}
        />
      ) : null}

      {dialog === 'pattern' ? (
        <PatternDialog
          employeeId={e.id}
          detail={e}
          schedules={schedulesQ.data ?? []}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(msg, aff) => {
            setDialog(null);
            setAffected(aff);
            setFlash(msg);
            void q.reload();
          }}
        />
      ) : null}

      {dialog === 'end' ? (
        <EndEmploymentDialog
          employeeId={e.id}
          detail={e}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null);
            setAffected([]);
            setFlash(msg);
            void q.reload();
          }}
        />
      ) : null}
    </div>
  );
}
