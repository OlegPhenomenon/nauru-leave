import { useMemo, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, unwrapList } from '../api/client';
import type { EmployeeRef, ExplainResponse, LedgerEntry, RequestSummary, Schedule } from '../api/types';
import {
  DataTable,
  Details,
  Empty,
  ErrBox,
  Loading,
  PageHeader,
} from '../components/ui';
import { fmtDate, fmtDateTime, fmtDuration, fmtRange } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import './Explain.css';

type ByNumber = Map<string, RequestSummary>;
type PatternHistory = EmployeeRef & {
  schedules: { id: number; valid_from: string; valid_to: string | null }[];
};

function dayLengthChanged(person: PatternHistory, schedules: Schedule[], today: string): string | null {
  const periods = person.schedules.flatMap(assignment => {
    const schedule = schedules.find(s => s.id === assignment.id);
    return (schedule?.versions ?? []).flatMap(version => {
      const from = assignment.valid_from > version.valid_from ? assignment.valid_from : version.valid_from;
      const ends = [assignment.valid_to, version.valid_to].filter((d): d is string => !!d);
      const to = ends.sort()[0];
      if (from > today || (to && from > to)) return [];
      const week = Array.isArray(version.week) ? version.week : Object.values(version.week);
      return [{ from, to, mpd: Math.max(...week), version: version.id }];
    });
  }).sort((a, b) => a.from.localeCompare(b.from) || a.version - b.version);
  let previous: number | undefined;
  let changed: string | null = null;
  for (const period of periods) {
    if (previous !== undefined && previous !== period.mpd) changed = period.from;
    previous = period.mpd;
  }
  const current = periods.at(-1);
  return current && (!current.to || current.to >= today) ? changed : null;
}

function whatHappened(e: LedgerEntry, byNumber: ByNumber): ReactNode {
  const req = e.request_number ? byNumber.get(e.request_number) : undefined;
  const link = e.request_number ? (
    req ? (
      <Link to={`/requests/${req.id}`}>Leave {fmtRange(req.start_date, req.end_date)}</Link>
    ) : (
      <span>{e.request_number}</span>
    )
  ) : null;
  switch (e.kind) {
    case 'opening':
      return 'Starting balance';
    case 'accrual':
      return `Allowance for ${e.period_year}`;
    case 'consumption':
      // The ledger records the original approval. Summary dates may now be
      // amended, so do not relabel that immutable posting with today's dates.
      return <>Leave approved{e.request_number ? <> — {req ? <Link to={`/requests/${req.id}`}>{e.request_number}</Link> : e.request_number}</> : null}</>;
    case 'return':
      return (
        <>
          {req?.kind === 'amendment'
            ? 'Change of dates returned days'
            : req?.kind === 'cancellation'
              ? 'Cancellation returned days'
              : 'Days returned'}
          {link ? <> — {link}</> : null}
        </>
      );
    case 'adjustment':
      return 'Correction';
    case 'carryover_expiry':
      return 'Carry-over expired';
    case 'historical':
      return 'Earlier record';
  }
}

export default function Explain() {
  const { employeeId } = useParams();
  const [sp] = useSearchParams();
  const { me, config } = useSession();
  const leaveTypeId = sp.get('leave_type_id') ?? '';
  const mine = me?.employee?.id === Number(employeeId);
  const businessYear = Number(config?.business_date.slice(0, 4) ?? 0);

  const { data, error, loading } = useApi(
    () =>
      api<ExplainResponse>(`/balances/${employeeId}/explain`, {
        query: { leave_type_id: leaveTypeId },
      }),
    [employeeId, leaveTypeId],
  );
  const personQ = useApi(() => api<PatternHistory>(`/employees/${employeeId}`), [employeeId]);
  const schedulesQ = useApi(() => api<unknown>('/schedules').then(d => unwrapList<Schedule>(d)), []);

  // Match ledger request numbers to their current request links.
  const reqsQ = useApi(
    () =>
      api<unknown>('/requests', {
        query: { scope: mine ? 'mine' : 'all', employee_id: employeeId },
      })
        .then((d) => unwrapList<RequestSummary>(d))
        .catch(() => []),
    [employeeId, mine],
  );
  const byNumber = useMemo<ByNumber>(
    () => new Map((reqsQ.data ?? []).map((r) => [r.number, r])),
    [reqsQ.data],
  );

  if (loading) return <Loading />;
  if (error) return <ErrBox error={error} />;
  if (!data) return null;

  const { summary, entries, reservations } = data;
  const mpd = summary.minutes_per_day;
  const given = entries.filter(e => e.kind === 'opening' || e.kind === 'accrual').reduce((s, e) => s + e.minutes, 0);
  const used = -entries.filter(e => e.kind === 'consumption' || e.kind === 'return' || e.kind === 'historical').reduce((s, e) => s + e.minutes, 0);
  const corrections = entries.filter(e => e.kind === 'adjustment' || e.kind === 'carryover_expiry').reduce((s, e) => s + e.minutes, 0);
  const showYears = summary.accounts.length > 1;
  const changedFrom = personQ.data && schedulesQ.data
    ? dayLengthChanged(personQ.data, schedulesQ.data, config?.business_date ?? '') : null;
  const personName = personQ.data?.full_name ?? reqsQ.data?.[0]?.employee.full_name;

  return (
    <div className="stack">
      <PageHeader
        title={mine ? `${summary.leave_type.name}: how your balance of ${fmtDuration(summary.available_minutes, mpd)} is worked out` : `${personName ?? 'Employee'} — ${summary.leave_type.name}: ${fmtDuration(summary.available_minutes, mpd)} left`}
        back={
          mine
            ? { to: '/my', label: 'My leave' }
            : { to: `/people/${employeeId}`, label: 'Back to the person' }
        }
      />

      <section className="panel">
        {changedFrom && personName && (summary.available_minutes * 2) % mpd !== 0 ? <p>From {fmtDate(changedFrom)} {personName}'s days are {mpd / 60} h, so {summary.available_minutes / 60} h is {fmtDuration(summary.available_minutes, mpd)}.</p> : null}
        <ul className="sum-list">
          <li>
            {mine ? 'You were' : 'They were'} given{' '}
            <strong>{fmtDuration(given, mpd)}</strong> in total.
          </li>
          {used > 0 ? (
            <li>
              {fmtDuration(used, mpd)} used.
            </li>
          ) : null}
          {corrections !== 0 ? <li>{corrections > 0 ? '+' : '−'}{fmtDuration(Math.abs(corrections), mpd)} from corrections and expired carry-over.</li> : null}
          {summary.reserved_minutes > 0 ? (
            <li>
              −{fmtDuration(summary.reserved_minutes, mpd)} is on hold while requests are
              decided.
            </li>
          ) : null}
          <li>
            = <strong>{fmtDuration(summary.available_minutes, mpd)} left</strong>
          </li>
        </ul>
        {summary.taken_minutes > 0 || summary.approved_upcoming_minutes > 0 ? (
          <p className="muted small">
            {[
              summary.taken_minutes > 0
                ? `${fmtDuration(summary.taken_minutes, mpd)} already taken`
                : '',
              summary.approved_upcoming_minutes > 0
                ? `${fmtDuration(summary.approved_upcoming_minutes, mpd)} booked for later`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        {showYears ? (
          <p className="muted small">
            {summary.accounts
              .map(
                (a) =>
                  `${a.period_year}${a.period_year < businessYear ? ' carry-over' : ''}: ${fmtDuration(a.available_minutes, a.minutes_per_day)}`,
              )
              .join(' · ')}
          </p>
        ) : null}
      </section>

      <section aria-label="Balance changes">
        <h2>Balance changes</h2>
        {entries.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <DataTable<LedgerEntry>
            columns={[
              { label: 'Date', title: true, render: (e) => fmtDate(e.kind === 'opening' && e.effective_date < `${e.period_year}-01-01` ? `${e.period_year}-01-01` : e.effective_date) },
              { label: 'What happened', render: (e) => whatHappened(e, byNumber) },
              {
                label: 'Change',
                className: 'num',
                render: (e) => (
                  <>
                    {e.minutes > 0 ? '+' : ''}
                    {fmtDuration(e.minutes, mpd)}{showYears ? ` (${e.period_year})` : ''}
                  </>
                ),
              },
              {
                label: 'Left',
                className: 'num',
                render: (e) => fmtDuration(e.running_total, mpd),
              },
            ]}
            rows={entries}
          />
        )}
      </section>

      {reservations.length ? (
        <section aria-label="On hold">
          <h2>On hold — waiting for approval</h2>
          <ul>
            {reservations.map((r) => {
              const req = byNumber.get(r.request_number);
              return (
                <li key={r.id}>
                  {req ? (
                    <Link to={`/requests/${req.id}`}>Leave {fmtRange(req.start_date, req.end_date)}</Link>
                  ) : (
                    r.request_number
                  )}{' '}
                  holds {fmtDuration(r.minutes, mpd)} since {fmtDate(r.created_at)}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Details title="Details">
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Date</th>
                <th>Year</th>
                <th>Basis</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{fmtDate(e.kind === 'opening' && e.effective_date < `${e.period_year}-01-01` ? `${e.period_year}-01-01` : e.effective_date)}</td>
                  <td>{e.period_year}</td>
                  <td className="small">{e.basis?.replace(/\s*\(policy #\d+\)/g, '') || '—'}</td>
                  <td className="small muted">
                    {fmtDateTime(e.created_at)}
                    {e.author ? ` · ${e.author.display_name}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {reservations.length ? (
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Year</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {reservations.map((r) => (
                  <tr key={r.id}>
                    <td>{r.request_number}</td>
                    <td>{r.period_year}</td>
                    <td>{r.revision_no}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Details>
    </div>
  );
}
