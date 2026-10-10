import { useParams } from 'react-router';
import { api } from '../api/client';
import type { DayRow, RequestDetail } from '../api/types';
import {
  Details,
  Empty,
  ErrBox,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components/ui';
import { inForceRevision } from '../lib/domain';
import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtRange,
  outcomeLabel,
  partLabel,
  stepLabel,
  todayPlus,
} from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

// Merge consecutive days with the same part into one "2–6 Nov" row so a
// two-week leave prints as a few lines instead of fourteen.
function groupDays(days: DayRow[]) {
  const groups: { start: string; end: string; part: string; minutes: number }[] = [];
  for (const d of days) {
    const last = groups[groups.length - 1];
    if (last && last.part === d.part && todayPlus(last.end, 1) === d.date) {
      last.end = d.date;
      last.minutes += d.minutes;
    } else {
      groups.push({ start: d.date, end: d.date, part: d.part, minutes: d.minutes });
    }
  }
  return groups;
}

function partNote(part: string): string {
  if (part === 'full') return '';
  if (part === 'none') return 'Not counted';
  return partLabel(part);
}

// GET /api/requests/:id/card → "RequestDetail subset"; render defensively.
export default function RequestPrint() {
  const { id } = useParams();
  const { config } = useSession();
  const { data: d, error, loading } = useApi(
    () => api<RequestDetail>(`/requests/${id}/card`),
    [id],
  );

  if (loading) return <Loading />;
  if (error) return <ErrBox error={error} />;
  if (!d) return null;
  const mpd = d.minutes_per_day ?? 480;
  // The printable card records what is actually in force. A superseded
  // original revision (e.g. 5 days before an approved amendment to 3)
  // appears only in the history section — never next to the in-force total.
  const rev = inForceRevision(d);
  const history = (d.revisions ?? []).filter((r) => r.id !== rev.id);
  const changedBy = (d.children ?? []).filter((c) => c.status === 'approved');
  const groups = groupDays(rev.days ?? []);

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={`Request ${d.number}`}
          back={{ to: `/requests/${id}`, label: 'Back to the request' }}
          primary={
            <button type="button" className="btn" onClick={() => window.print()}>
              Print
            </button>
          }
        />
      </div>

      <div className="panel">
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
            <dt>Dates</dt>
            <dd>
              {fmtRange(rev.start_date, rev.end_date)}
              {rev.start_date === rev.end_date && rev.start_part !== 'full'
                ? ` · ${partLabel(rev.start_part)} only`
                : ''}
              {rev.start_date !== rev.end_date && rev.start_part !== 'full'
                ? ` · first day: ${partLabel(rev.start_part).toLowerCase()} only`
                : ''}
              {rev.start_date !== rev.end_date && rev.end_part !== 'full'
                ? ` · last day: ${partLabel(rev.end_part).toLowerCase()} only`
                : ''}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Total</dt>
            <dd>{fmtDuration(rev.total_minutes, mpd)}</dd>
          </div>
          {rev.change_reason ? (
            <div className="kv-row">
              <dt>Latest change</dt>
              <dd>{rev.change_reason}</dd>
            </div>
          ) : null}
          {rev.note ? (
            <div className="kv-row">
              <dt>Note</dt>
              <dd>{rev.note}</dd>
            </div>
          ) : null}
          {d.source === 'paper' && d.paper_received_date ? (
            <div className="kv-row">
              <dt>Paper form</dt>
              <dd>Received {fmtDate(d.paper_received_date)}</dd>
            </div>
          ) : null}
        </dl>

        <h2>Days</h2>
        {groups.length === 0 ? (
          <p className="muted">No days remain — the leave was fully cancelled.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Dates</th>
                <th className="num">Counted</th>
                <th>Part</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.start}>
                  <td>{fmtRange(g.start, g.end)}</td>
                  <td className="num">
                    {g.minutes > 0 ? fmtDuration(g.minutes, mpd) : '—'}
                  </td>
                  <td className="small">{partNote(g.part)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Decisions</h2>
        {(d.decisions ?? []).length === 0 ? (
          <Empty>No decisions recorded yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Decision</th>
                <th>By</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {d.decisions.map((x) => (
                <tr key={x.id}>
                  <td>{stepLabel(x.step_kind)}</td>
                  <td>
                    {outcomeLabel(x.outcome)}
                    {x.reason ? <div className="muted small">{x.reason}</div> : null}
                  </td>
                  <td>
                    {x.actor.display_name}
                    {x.acting_for ? ` for ${x.acting_for.display_name}` : ''}
                  </td>
                  <td className="nowrap">{fmtDateTime(x.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {history.length || changedBy.length ? (
          <Details title="Earlier versions and record details">
            {changedBy.length ? (
              <p className="small">
                Brought into force by an approved{' '}
                {changedBy
                  .map((c) => (c.kind === 'amendment' ? 'change of dates' : 'cancellation'))
                  .join('/')}{' '}
                {changedBy.map((c) => (
                  <a key={c.id} href={`/requests/${c.id}/print`}>
                    {c.number}
                  </a>
                ))}
                {' — '}its decisions are recorded on that request.
              </p>
            ) : null}
            {history.length ? (
              <table className="small">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Dates</th>
                    <th className="num">Length</th>
                    <th>Reason for change</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>{r.rev_no}</td>
                      <td>{fmtRange(r.start_date, r.end_date)}</td>
                      <td className="num">{fmtDuration(r.total_minutes, mpd)}</td>
                      <td className="small">{r.change_reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {(d.decisions ?? []).length ? (
              <table className="small">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Version</th>
                    <th>Authority</th>
                    <th>Basis document</th>
                  </tr>
                </thead>
                <tbody>
                  {d.decisions.map((x) => (
                    <tr key={x.id}>
                      <td>{stepLabel(x.step_kind)}</td>
                      <td>{x.revision_no}</td>
                      <td className="small">{x.authority}</td>
                      <td className="small">{x.basis_document ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Details>
        ) : null}

        <div className="print-only">
          {config?.mode === 'demo' ? <p>Demo record — fictional data</p> : null}
          <p>
            Record of decision in Nauru Leave Desk — not a government electronic
            signature.
          </p>
        </div>
      </div>
    </>
  );
}
