import { useMemo, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { api, unwrapList } from '../api/client';
import type { ExplainResponse, LedgerEntry, RequestSummary } from '../api/types';
import {
  DataTable,
  Details,
  Empty,
  ErrBox,
  Loading,
  PageHeader,
  ReqLink,
} from '../components/ui';
import { fmtDate, fmtDateTime, fmtDuration } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import './Explain.css';

type ByNumber = Map<string, RequestSummary>;

function whatHappened(e: LedgerEntry, byNumber: ByNumber): ReactNode {
  const req = e.request_number ? byNumber.get(e.request_number) : undefined;
  const link = e.request_number ? (
    req ? (
      <ReqLink id={req.id} number={req.number} />
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
      return req ? (
        <>Leave approved — <ReqLink id={req.id} number={req.number} /></>
      ) : (
        <>Leave approved{link ? <> — {link}</> : null}</>
      );
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

  // Request numbers → ids/dates so entries can say "Leave 2–13 Nov approved".
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

  return (
    <div className="stack">
      <PageHeader
        title={`${summary.leave_type.name}: how ${mine ? 'your' : 'the'} balance of ${fmtDuration(summary.available_minutes, mpd)} is worked out`}
        back={
          mine
            ? { to: '/my', label: 'My leave' }
            : { to: `/people/${employeeId}`, label: 'Back to the person' }
        }
      />

      <section className="panel">
        <ul className="sum-list">
          <li>
            {mine ? 'You were' : 'They were'} given{' '}
            <strong>{fmtDuration(given, mpd)}</strong> in total.
          </li>
          {used > 0 ? (
            <li>
              −{fmtDuration(used, mpd)} went to approved leave, after returned days.
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
              { label: 'Date', title: true, render: (e) => fmtDate(e.effective_date) },
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
                    <ReqLink id={req.id} number={req.number} />
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

      <Details title="More detail (year, basis, recorded)">
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
                  <td className="nowrap">{fmtDate(e.effective_date)}</td>
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
