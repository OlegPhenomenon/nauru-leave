import { useState } from 'react';
import { api, post, unwrapList } from '../api/client';
import type { AuditEvent, NotificationItem } from '../api/types';
import { Empty, ErrBox, Field, JsonValue, Loading } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

const STATUS_OPTS = ['', 'queued', 'sent', 'retrying', 'failed', 'gave_up'];

export default function Operations() {
  const { hasRole } = useSession();
  const canRetry = hasRole('tech_admin', 'hr');
  const [status, setStatus] = useState('');
  const [auditEntity, setAuditEntity] = useState('');
  const [auditEntityId, setAuditEntityId] = useState('');
  const [auditActor, setAuditActor] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const notifQ = useApi(
    () =>
      api<unknown>('/ops/notifications', { query: { status: status || undefined } }).then((d) =>
        unwrapList<NotificationItem>(d),
      ),
    [status],
  );
  const summaryQ = useApi(() => api<unknown>('/ops/summary'), []);
  const auditQ = useApi(
    () =>
      api<unknown>('/audit', {
        query: {
          entity: auditEntity || undefined,
          entity_id: auditEntityId || undefined,
          actor_user_id: auditActor || undefined,
          limit: 200,
        },
      }).then((d) => unwrapList<AuditEvent>(d)),
    [auditEntity, auditEntityId, auditActor],
  );

  async function retry(id: number) {
    setMsg(null);
    try {
      await post(`/ops/notifications/${id}/retry`);
      setMsg(`Notification #${id} re-queued.`);
      notifQ.reload();
      summaryQ.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Retry failed');
    }
  }

  return (
    <>
      <h1>Operations</h1>
      {msg ? <div className="alert alert-info">{msg}</div> : null}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Summary</h2>
        {summaryQ.loading ? <Loading /> : null}
        {summaryQ.error ? <ErrBox error={summaryQ.error} /> : null}
        {summaryQ.data ? <JsonValue v={summaryQ.data} /> : null}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Notifications</h2>
        <div className="toolbar">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_OPTS.map((s) => (
                <option key={s} value={s}>
                  {s || 'All'}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {notifQ.loading ? <Loading /> : null}
        {notifQ.error ? <ErrBox error={notifQ.error} /> : null}
        {notifQ.data && notifQ.data.length === 0 ? <Empty>No notifications with this status.</Empty> : null}
        {notifQ.data && notifQ.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
                  <th>Last error</th>
                  <th>Next attempt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {notifQ.data.map((n) => (
                  <tr key={n.id}>
                    <td>{n.id}</td>
                    <td className="small">{n.to_email}</td>
                    <td className="small">{n.subject}</td>
                    <td>
                      <span
                        className={`badge ${n.status === 'gave_up' || n.status === 'failed' ? 'badge-med' : ''}`}
                      >
                        {n.status}
                      </span>
                    </td>
                    <td className="num">{n.attempts}</td>
                    <td className="small muted">{n.last_error ?? '—'}</td>
                    <td className="small">{n.next_attempt_at ? fmtDateTime(n.next_attempt_at) : '—'}</td>
                    <td>
                      {canRetry && (n.status === 'failed' || n.status === 'gave_up' || n.status === 'queued') ? (
                        <button className="btn btn-secondary btn-sm" onClick={() => void retry(n.id)}>
                          Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="muted small">
          Addresses on the @unreachable.demo domain always fail in the demo — that is intentional.
          Message bodies are not shown here.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Audit log</h2>
        <div className="toolbar">
          <Field label="Entity type">
            <input value={auditEntity} onChange={(e) => setAuditEntity(e.target.value)} placeholder="leave_request" />
          </Field>
          <Field label="Entity id">
            <input type="number" value={auditEntityId} onChange={(e) => setAuditEntityId(e.target.value)} />
          </Field>
          <Field label="Actor user id">
            <input type="number" value={auditActor} onChange={(e) => setAuditActor(e.target.value)} />
          </Field>
        </div>
        {auditQ.loading ? <Loading /> : null}
        {auditQ.error ? <ErrBox error={auditQ.error} /> : null}
        {auditQ.data && auditQ.data.length === 0 ? <Empty>No events match.</Empty> : null}
        {auditQ.data && auditQ.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {auditQ.data.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{fmtDateTime(e.at)}</td>
                    <td className="small">
                      {e.actor?.display_name ?? 'system'}
                      {e.acting_for ? ` (for ${e.acting_for.display_name})` : ''}
                    </td>
                    <td className="small">{e.action}</td>
                    <td className="small">
                      {e.entity}
                      {e.entity_id != null ? ` #${e.entity_id}` : ''}
                    </td>
                    <td className="small muted">
                      {e.details ? <code className="mono">{JSON.stringify(e.details)}</code> : '—'}
                    </td>
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
