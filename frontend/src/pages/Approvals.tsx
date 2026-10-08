import { api } from '../api/client';
import type { ApprovalsResp } from '../api/types';
import { Dur, Empty, ErrBox, Loading, ReqLink, StatusBadge, WarnList } from '../components/ui';
import { daysBetween, fmtDate, stepLabel } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

export default function Approvals() {
  const { config } = useSession();
  const { data, error, loading } = useApi(() => api<ApprovalsResp>('/approvals'), []);

  if (loading) return <Loading />;
  if (error) return <ErrBox error={error} />;
  if (!data) return null;
  const today = config?.business_date ?? '';

  return (
    <>
      <h1>Approvals</h1>
      {data.items.length === 0 && data.problems.length === 0 ? (
        <div className="panel">
          <Empty>Nothing is waiting for your decision.</Empty>
        </div>
      ) : null}

      {data.items.length ? (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Your step</th>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Dates</th>
                  <th className="num">Length</th>
                  <th>Status</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={`${it.id}-${it.step.id}`}>
                    <td>
                      <ReqLink id={it.id} number={it.number} />
                      {it.acting_for ? (
                        <div className="badge" style={{ marginTop: '0.2rem' }}>
                          acting for {it.acting_for.display_name}
                        </div>
                      ) : null}
                    </td>
                    <td>{stepLabel(it.step.kind)}</td>
                    <td>{it.employee.full_name}</td>
                    <td className="small">{it.leave_type_name}</td>
                    <td className="small">
                      {fmtDate(it.start_date)} – {fmtDate(it.end_date)}
                    </td>
                    <td className="num">
                      <Dur minutes={it.total_minutes} mpd={it.minutes_per_day} />
                    </td>
                    <td>
                      <StatusBadge status={it.status} label={it.status_label} />
                      <WarnList warnings={it.warnings} />
                    </td>
                    <td className="small muted">
                      {today ? `${Math.max(0, daysBetween(it.updated_at.slice(0, 10), today))} d` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.problems.length ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Problems — unassigned steps</h2>
          <p className="muted small">
            These requests have a step with no eligible person. Reassign the step from the request
            page.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Employee</th>
                  <th>Dates</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {data.problems.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <ReqLink id={p.id} number={p.number} />
                    </td>
                    <td>{p.employee.full_name}</td>
                    <td className="small">
                      {fmtDate(p.start_date)} – {fmtDate(p.end_date)}
                    </td>
                    <td>
                      <span className="badge badge-med">{p.problem}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
