import { useParams } from 'react-router';
import { api } from '../api/client';
import type { DayRow, Decision, RequestDetail } from '../api/types';
import {
  Details,
  Empty,
  ErrBox,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components/ui';
import { inForceRevision, remainingRanges } from '../lib/domain';
import {
  fmtDate,
  fmtDuration,
  fmtRange,
  outcomeLabel,
  partLabel,
  stepLabel,
  todayPlus,
} from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { fmtStampDay } from './request/text';

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
  const showPart = groups.some(g => !!partNote(g.part));
  const decisionGroups = new Map<string, { requestId: number; decisions: Decision[] }>();
  for (const x of d.decisions ?? []) {
    const record = x as Decision & { request?: { id: number }; revision_id?: number };
    const requestId = record.request?.id ?? d.id;
    const key = `${requestId}:${record.revision_id ?? x.revision_no}`;
    const group = decisionGroups.get(key) ?? { requestId, decisions: [] };
    group.decisions.push(x);
    decisionGroups.set(key, group);
  }
  const dates = remainingRanges(rev).map(([a, b]) => fmtRange(a, b)).join(', ') || fmtRange(rev.start_date, rev.end_date);
  const decisionHeading = (group: { requestId: number; decisions: Decision[] }): string => {
    const kind = group.requestId === d.id ? d.kind : d.children.find(c => c.id === group.requestId)?.kind;
    const approved = group.decisions.find(x => x.outcome === 'approve');
    if (kind === 'amendment' || kind === 'cancellation')
      return `${kind === 'amendment' ? 'Change of dates' : 'Cancellation of days'}${approved ? ` (approved ${fmtStampDay(approved.created_at)})` : ''}`;
    return group.requestId === d.id && group.decisions[0]?.revision_no === 1 ? 'Original request' : 'Revised request';
  };

  return (
    <>
      <div className="panel print-card">
        <PageHeader
          title={`${d.leave_type_name} · ${dates}`}
          subtitle={d.number}
          back={{ to: `/requests/${id}`, label: 'Back to the request' }}
          primary={<button type="button" className="btn no-print" onClick={() => window.print()}>Print</button>}
        />
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
              {dates}
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
              <dt>Reason for change</dt>
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
          <div className="table-wrap table-stack"><table>
            <thead>
              <tr>
                <th>Dates</th>
                <th className="num">Counted</th>
                {showPart ? <th>Part</th> : null}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.start}>
                  <td className="stack-title nowrap">{fmtRange(g.start, g.end)}</td>
                  <td className="num" data-label="Counted">
                    {g.minutes > 0 ? fmtDuration(g.minutes, mpd) : '—'}
                  </td>
                  {showPart ? <td className="small" data-label="Part">{partNote(g.part)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}

        <h2>Decisions</h2>
        {(d.decisions ?? []).length === 0 ? (
          <Empty>No decisions recorded yet.</Empty>
        ) : ([...decisionGroups.entries()].map(([key, group]) => (
          <section key={key} className="print-decisions">
          <h3>{decisionHeading(group)}</h3>
          <div className="table-wrap table-stack"><table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Decision</th>
                <th>By</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {group.decisions.map((x) => (
                <tr key={x.id}>
                  <td className="stack-title">{stepLabel(x.step_kind)}</td>
                  <td data-label="Decision">
                    {outcomeLabel(x.outcome)}
                    {x.reason ? <div className="muted small">{x.reason}</div> : null}
                  </td>
                  <td className="nowrap" data-label="By">
                    {x.actor.display_name}
                    {x.acting_for ? ` for ${x.acting_for.display_name}` : ''}
                  </td>
                  <td className="nowrap" data-label="When">{fmtStampDay(x.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          </section>
        )))}

        {history.length || changedBy.length ? (
          <Details title="Earlier versions and record details" className="print-history">
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
              <div className="table-wrap table-stack"><table className="small">
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
                      <td className="stack-title">{r.rev_no}</td>
                      <td className="nowrap" data-label="Dates">{fmtRange(r.start_date, r.end_date)}</td>
                      <td className="num" data-label="Length">{fmtDuration(r.total_minutes, mpd)}</td>
                      <td className="small" data-label="Reason for change">{r.change_reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            ) : null}
            {(d.decisions ?? []).length ? (
              <div className="table-wrap table-stack"><table className="small">
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
                      <td className="stack-title">{stepLabel(x.step_kind)}</td>
                      <td data-label="Version">{x.revision_no}</td>
                      <td className="small" data-label="Authority">{x.authority}</td>
                      <td className="small" data-label="Basis document">{x.basis_document ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
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
