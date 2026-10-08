import { useParams } from 'react-router';
import { api } from '../api/client';
import type { RequestDetail } from '../api/types';
import { Dur, Empty, ErrBox, Loading, StatusBadge } from '../components/ui';
import { fmtDate, fmtDateTime, fmtHours, fmtWeekday, outcomeLabel, stepLabel } from '../lib/format';
import { useApi } from '../lib/useApi';

// GET /api/requests/:id/card → "RequestDetail subset"; render defensively.
export default function RequestPrint() {
  const { id } = useParams();
  const { data: d, error, loading } = useApi(
    () => api<RequestDetail>(`/requests/${id}/card`),
    [id],
  );

  if (loading) return <Loading />;
  if (error) return <ErrBox error={error} />;
  if (!d) return null;
  const mpd = d.minutes_per_day ?? 480;
  const rev = d.current_revision;

  return (
    <div className="panel" style={{ maxWidth: '52rem', margin: '0 auto' }}>
      <div className="btn-row no-print">
        <button className="btn" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <h1>Leave request {d.number}</h1>
      <p>
        <StatusBadge status={d.status} label={d.status_label} />
      </p>
      <dl className="kv">
        <div className="kv-row">
          <dt>Employee</dt>
          <dd>
            {d.employee.full_name} ({d.employee.service_id}
            {d.employee.org_unit ? ` · ${d.employee.org_unit.name}` : ''})
          </dd>
        </div>
        <div className="kv-row">
          <dt>Leave type</dt>
          <dd>{d.leave_type_name}</dd>
        </div>
        <div className="kv-row">
          <dt>Revision</dt>
          <dd>
            {rev.rev_no}
            {rev.change_reason ? ` — ${rev.change_reason}` : ''}
          </dd>
        </div>
        <div className="kv-row">
          <dt>Total</dt>
          <dd>
            <Dur minutes={d.total_minutes} mpd={mpd} />
          </dd>
        </div>
      </dl>

      <h2>Days</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Part</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {(rev.days ?? []).map((x) => (
            <tr key={x.date}>
              <td>
                {fmtWeekday(x.date)} {fmtDate(x.date)}
              </td>
              <td>{x.part === 'full' ? 'Full day' : x.part === 'am' ? 'Morning' : x.part === 'pm' ? 'Afternoon' : 'Non-working'}</td>
              <td className="num">{x.minutes > 0 ? fmtHours(x.minutes) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Decisions</h2>
      {(d.decisions ?? []).length === 0 ? (
        <Empty>No decisions recorded.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Outcome</th>
              <th>By</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {d.decisions.map((x) => (
              <tr key={x.id}>
                <td>
                  {stepLabel(x.step_kind)} (rev {x.revision_no})
                </td>
                <td>{outcomeLabel(x.outcome)}</td>
                <td>
                  {x.actor.display_name}
                  {x.acting_for ? ` for ${x.acting_for.display_name}` : ''}
                  <div className="muted small">
                    {x.authority}
                    {x.reason ? ` — ${x.reason}` : ''}
                  </div>
                </td>
                <td>{fmtDateTime(x.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted small" style={{ marginTop: '2rem', borderTop: '1px solid #999', paddingTop: '0.8rem' }}>
        Record of decision in Nauru Leave Desk — not a government electronic signature.
      </p>
    </div>
  );
}
