import { Link } from 'react-router';
import { api, unwrapList } from '../api/client';
import type { BalanceSummary, RequestDetail, RequestSummary } from '../api/types';
import {
  DataTable,
  Details,
  Empty,
  ErrBox,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components/ui';
import {
  fmtDay,
  fmtDuration,
  fmtPhase,
  fmtRange,
} from '../lib/format';
import { remainingRanges } from '../lib/domain';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { ActionNeeded } from './employee/ActionNeeded';
import './MyLeave.css';

const CLOSED: RequestSummary['status'][] = ['rejected', 'withdrawn', 'cancelled'];

function kindText(kind: RequestSummary['kind']): string {
  return kind === 'amendment' ? 'Change of dates' : 'Cancellation of days';
}

function RequestTable({ rows }: { rows: RequestSummary[] }) {
  const { config } = useSession();
  return (
    <DataTable<RequestSummary>
      columns={[
        {
          label: 'Dates',
          title: true,
          render: (r) => {
            const phase =
              r.status === 'approved'
                ? fmtPhase(r.date_phase, r.start_date, config?.business_date)
                : '';
            return (
              <>
                <Link to={`/requests/${r.id}`}>
                  {('ranges' in r ? (r.ranges as [string, string][]).map(([a, b]) => fmtRange(a, b)).join(', ') : fmtRange(r.start_date, r.end_date))}
                </Link>
                <div className="muted small">
                  {r.number}
                  {r.kind !== 'leave' ? ` · ${kindText(r.kind)}` : ''}
                  {phase ? ` · ${phase}` : ''}
                </div>
              </>
            );
          },
        },
        { label: 'Type', render: (r) => r.leave_type_name },
        {
          label: 'Days',
          className: 'num',
          render: (r) => fmtDuration(r.total_minutes, r.minutes_per_day),
        },
        {
          label: 'Status',
          render: (r) => <StatusBadge status={r.status} label={r.status === 'needs_information' ? 'Question for you' : undefined} />,
        },
        { label: '', render: (r) => r.status === 'approved' && r.kind === 'leave' ? <Link className="btn btn-ghost btn-sm" to={`/requests/${r.id}/print`}>Print</Link> : ['submitted', 'under_review', 'needs_information'].includes(r.status) ? <Link className="btn btn-ghost btn-sm" to={`/requests/${r.id}?action=withdraw`}>Withdraw…</Link> : null },
      ]}
      rows={rows}
      empty="Nothing here."
    />
  );
}

export default function MyLeave() {
  const { me, config } = useSession();
  const empId = me?.employee?.id;
  const userId = me?.user.id;
  const balancesQ = useApi(
    () => (empId ? api<BalanceSummary[]>('/balances/me') : Promise.resolve([])),
    [empId],
  );
  const requestsQ = useApi(
    () =>
      api<unknown>('/requests', { query: { scope: 'mine' } }).then(async (d) =>
        Promise.all(unwrapList<RequestSummary>(d).map(async r => {
          if (r.kind !== 'leave' || r.status !== 'approved') return r;
          const detail = await api<RequestDetail>(`/requests/${r.id}`);
          const rev = detail.in_force_revision ?? detail.current_revision;
          return { ...r, ranges: remainingRanges(rev) };
        })),
      ),
    [userId],
  );

  const requests = requestsQ.data ?? [];
  const balances = (balancesQ.data ?? []).filter((b) => b.leave_type.uses_balance);

  const awaitingAnswer = requests.filter((r) => r.status === 'needs_information');
  const open = requests
    .filter((r) => !CLOSED.includes(r.status) && r.date_phase !== 'period_ended' && !(r.kind !== 'leave' && r.status === 'approved'))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const closed = requests
    .filter((r) => CLOSED.includes(r.status) || r.date_phase === 'period_ended' || (r.kind !== 'leave' && r.status === 'approved'))
    .sort((a, b) => b.start_date.localeCompare(a.start_date));

  const upcoming = requests
    .filter(
      (r) =>
        r.status === 'approved' &&
        r.kind === 'leave' &&
        config != null &&
        r.end_date >= config.business_date,
    )
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  function bookedFrom(b: BalanceSummary): string {
    const first = upcoming.find((r) => r.leave_type_name === b.leave_type.name);
    return first ? ` from ${fmtDay('ranges' in first ? (first.ranges as [string, string][])[0]?.[0] ?? first.start_date : first.start_date)}` : '';
  }

  return (
    <div className="stack">
      <PageHeader
        title="My leave"
        primary={
          <Link className="btn" to="/requests/new">
            Request leave
          </Link>
        }
      />

      {!empId ? (
        <div className="alert alert-info">
          Your user account is not linked to an employee record, so personal balances are
          not shown.
        </div>
      ) : null}

      {awaitingAnswer.map((r) => (
        <ActionNeeded
          key={r.id}
          request={r}
          onDone={() => {
            requestsQ.reload();
            balancesQ.reload();
          }}
        />
      ))}

      <section aria-label="Days left">
        <h2>Days left</h2>
        {balancesQ.loading ? <Loading label="Loading balances…" /> : null}
        {balancesQ.error ? <ErrBox error={balancesQ.error} /> : null}
        {balancesQ.data && balances.length === 0 && empId ? (
          <Empty>No balances yet — ask HR if you expected one.</Empty>
        ) : null}
        <div className="days-list">
          {balances.map((b) => (
            <div className="day-row" key={b.leave_type.id}>
              <div className="day-head">
                <span className="day-name">{b.leave_type.name}</span>
                <span className="day-num">
                  {fmtDuration(b.available_minutes, b.minutes_per_day)} left
                </span>
              </div>
              {b.reserved_minutes > 0 || b.approved_upcoming_minutes > 0 ? (
                <p className="day-note">
                  {[
                    b.reserved_minutes > 0
                      ? `${fmtDuration(b.reserved_minutes, b.minutes_per_day)} waiting for approval`
                      : '',
                    b.approved_upcoming_minutes > 0
                      ? `${fmtDuration(b.approved_upcoming_minutes, b.minutes_per_day)} booked${bookedFrom(b)}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
              {empId ? (
                <Link
                  className="small"
                  to={`/balances/${empId}/explain?leave_type_id=${b.leave_type.id}`}
                >
                  How is this worked out?
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section aria-label="My requests">
        <h2>My requests</h2>
        {requestsQ.loading ? <Loading /> : null}
        {requestsQ.error ? <ErrBox error={requestsQ.error} /> : null}
        {requestsQ.data && requests.length === 0 ? (
          <Empty>
            No requests yet — press <strong>Request leave</strong> to start one.
          </Empty>
        ) : null}
        {open.length ? <RequestTable rows={open} /> : null}
        {!open.length && requests.length ? (
          <p className="muted">Nothing open right now.</p>
        ) : null}
        {closed.length ? (
          <Details title="Show past and closed requests" count={closed.length}>
            <RequestTable rows={closed} />
          </Details>
        ) : null}
      </section>
    </div>
  );
}
