import { useParams, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { ExplainResponse } from '../api/types';
import { Dur, Empty, ErrBox, Loading } from '../components/ui';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

const KIND_LABEL: Record<string, string> = {
  opening: 'Opening balance',
  accrual: 'Accrual',
  consumption: 'Approved leave',
  return: 'Returned (amendment/cancellation)',
  adjustment: 'Correction',
  carryover_expiry: 'Carry-over expired',
  historical: 'Historical record',
};

export default function Explain() {
  const { employeeId } = useParams();
  const [sp] = useSearchParams();
  const leaveTypeId = sp.get('leave_type_id') ?? '';
  const { data, error, loading } = useApi(
    () =>
      api<ExplainResponse>(`/balances/${employeeId}/explain`, { query: { leave_type_id: leaveTypeId } }),
    [employeeId, leaveTypeId],
  );

  if (loading) return <Loading />;
  if (error) return <ErrBox error={error} />;
  if (!data) return null;
  const { summary, entries, reservations } = data;
  const mpd = summary.minutes_per_day;

  return (
    <>
      <h1>
        How the {summary.leave_type.name} balance is calculated
      </h1>
      <div className="panel">
        <p>
          <strong>Available = ledger − reservations.</strong> The ledger is the sum of all applied
          entries (opening balance, accruals, approved consumption, returns and corrections).
          Reservations are minutes held by requests that are submitted but not yet decided.
        </p>
        <dl className="kv">
          <div className="kv-row">
            <dt>Ledger total</dt>
            <dd>
              <Dur minutes={summary.ledger_minutes} mpd={mpd} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>Reserved by open requests</dt>
            <dd>
              − <Dur minutes={summary.reserved_minutes} mpd={mpd} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>
              <strong>Available for a new request</strong>
            </dt>
            <dd>
              <strong>
                <Dur minutes={summary.available_minutes} mpd={mpd} />
              </strong>
            </dd>
          </div>
        </dl>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Ledger entries</h2>
        {entries.length === 0 ? (
          <Empty>No entries yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Effective date</th>
                  <th>Kind</th>
                  <th>Period</th>
                  <th className="num">Minutes</th>
                  <th className="num">Running total</th>
                  <th>Basis</th>
                  <th>Request</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.effective_date)}</td>
                    <td>{KIND_LABEL[e.kind] ?? e.kind}</td>
                    <td>{e.period_year}</td>
                    <td className="num">
                      {e.minutes > 0 ? '+' : ''}
                      <Dur minutes={e.minutes} mpd={mpd} />
                    </td>
                    <td className="num">
                      <Dur minutes={e.running_total} mpd={mpd} />
                    </td>
                    <td className="small">{e.basis}</td>
                    <td className="small">{e.request_number ?? '—'}</td>
                    <td className="small muted">
                      {fmtDateTime(e.created_at)}
                      {e.author ? ` · ${e.author.display_name}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Active reservations</h2>
        {reservations.length === 0 ? (
          <Empty>No open reservations — nothing is being held for pending requests.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Period</th>
                  <th className="num">Minutes</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {reservations.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.request_number} (rev {r.revision_no})
                    </td>
                    <td>{r.period_year}</td>
                    <td className="num">
                      <Dur minutes={r.minutes} mpd={mpd} />
                    </td>
                    <td className="small muted">{fmtDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
