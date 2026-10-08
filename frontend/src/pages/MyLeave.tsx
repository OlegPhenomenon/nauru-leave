import { Link } from 'react-router';
import { api, unwrapList } from '../api/client';
import type { BalanceSummary, RequestSummary } from '../api/types';
import {
  Dur,
  Empty,
  ErrBox,
  Loading,
  PhaseBadge,
  PolicyBadge,
  ReqLink,
  StatusBadge,
} from '../components/ui';
import { fmtDate, fmtDateFull } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

export default function MyLeave() {
  const { me, config } = useSession();
  const empId = me?.employee?.id;
  const balancesQ = useApi(
    () => (empId ? api<BalanceSummary[]>('/balances/me') : Promise.resolve([])),
    [empId],
  );
  const requestsQ = useApi(
    () => api<unknown>('/requests', { query: { scope: 'mine' } }).then((d) => unwrapList<RequestSummary>(d)),
    [],
  );

  const requests = requestsQ.data ?? [];
  const open = requests.filter((r) =>
    ['draft', 'submitted', 'needs_information', 'under_review'].includes(r.status),
  );
  const nextAbsence = requests
    .filter(
      (r) =>
        r.status === 'approved' &&
        config != null &&
        r.end_date >= config.business_date &&
        r.kind === 'leave',
    )
    .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  const hints = open.filter((r) => r.next_action).slice(0, 5);

  return (
    <>
      <h1>My leave</h1>
      {!empId ? (
        <div className="alert alert-info">
          Your user account is not linked to an employee record, so personal balances are not shown.
        </div>
      ) : null}

      {balancesQ.loading ? <Loading label="Loading balances…" /> : null}
      {balancesQ.error ? <ErrBox error={balancesQ.error} /> : null}
      {balancesQ.data && balancesQ.data.length === 0 && empId ? (
        <Empty>No balance accounts yet.</Empty>
      ) : null}
      <div className="card-grid">
        {balancesQ.data?.map((b) => (
          <div className="card" key={b.leave_type.id}>
            <h3>{b.leave_type.name}</h3>
            {b.leave_type.uses_balance ? (
              <>
                <span className="balance-num">
                  <Dur minutes={b.available_minutes} mpd={b.minutes_per_day} />
                </span>
                <span className="balance-sub">available now</span>
                <dl className="kv" style={{ marginTop: '0.6rem' }}>
                  <div className="kv-row">
                    <dt>Ledger</dt>
                    <dd>
                      <Dur minutes={b.ledger_minutes} mpd={b.minutes_per_day} />
                    </dd>
                  </div>
                  <div className="kv-row">
                    <dt>Reserved by open requests</dt>
                    <dd>
                      <Dur minutes={b.reserved_minutes} mpd={b.minutes_per_day} />
                    </dd>
                  </div>
                  {b.approved_upcoming_minutes > 0 ? (
                    <div className="kv-row">
                      <dt>Approved, still upcoming</dt>
                      <dd>
                        <Dur minutes={b.approved_upcoming_minutes} mpd={b.minutes_per_day} />
                      </dd>
                    </div>
                  ) : null}
                  {b.taken_minutes > 0 ? (
                    <div className="kv-row">
                      <dt>Taken (past dates)</dt>
                      <dd>
                        <Dur minutes={b.taken_minutes} mpd={b.minutes_per_day} />
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {b.accounts.length > 1 || b.accounts.some((a) => a.period_year !== undefined) ? (
                  <table className="small">
                    <tbody>
                      {b.accounts.map((a) => (
                        <tr key={a.account_id}>
                          <td>{a.period_year}</td>
                          <td className="num">
                            <Dur minutes={a.available_minutes} mpd={a.minutes_per_day} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                <Link
                  to={`/balances/${empId}/explain?leave_type_id=${b.leave_type.id}`}
                  className="small"
                >
                  How is this calculated?
                </Link>
              </>
            ) : (
              <p className="muted">This leave type does not use a balance — days are counted, no
                account is deducted.</p>
            )}
            {b.policy ? (
              <div style={{ marginTop: '0.6rem' }}>
                <PolicyBadge policy={b.policy} />
                <div className="muted small">{b.policy.explanation}</div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {nextAbsence ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Next absence</h2>
          <p>
            <ReqLink id={nextAbsence.id} number={nextAbsence.number} /> — {nextAbsence.leave_type_name}
            , {fmtDateFull(nextAbsence.start_date)} – {fmtDateFull(nextAbsence.end_date)} (
            <Dur minutes={nextAbsence.total_minutes} mpd={nextAbsence.minutes_per_day} />){' '}
            <PhaseBadge phase={nextAbsence.date_phase} />
          </p>
        </div>
      ) : null}

      {hints.length ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>What&apos;s next</h2>
          {hints.map((r) => (
            <p key={r.id} className="next-hint">
              <ReqLink id={r.id} number={r.number} /> — {r.next_action}
            </p>
          ))}
        </div>
      ) : null}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>My requests</h2>
        <p>
          <Link className="btn btn-sm" to="/requests/new">
            New request
          </Link>
        </p>
        {requestsQ.loading ? <Loading /> : null}
        {requestsQ.error ? <ErrBox error={requestsQ.error} /> : null}
        {requestsQ.data && requests.length === 0 ? (
          <Empty>No requests yet — start with “New request”.</Empty>
        ) : null}
        {requests.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Type</th>
                  <th>Dates</th>
                  <th className="num">Length</th>
                  <th>Status</th>
                  <th>Next step</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <ReqLink id={r.id} number={r.number} />
                      {r.kind !== 'leave' ? (
                        <span className="badge" style={{ marginLeft: '0.4rem' }}>
                          {r.kind}
                        </span>
                      ) : null}
                    </td>
                    <td>{r.leave_type_name}</td>
                    <td>
                      {fmtDate(r.start_date)} – {fmtDate(r.end_date)}{' '}
                      <PhaseBadge phase={r.date_phase} />
                    </td>
                    <td className="num">
                      <Dur minutes={r.total_minutes} mpd={r.minutes_per_day} />
                    </td>
                    <td>
                      <StatusBadge status={r.status} label={r.status_label} />
                    </td>
                    <td className="small">{r.next_action ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}
