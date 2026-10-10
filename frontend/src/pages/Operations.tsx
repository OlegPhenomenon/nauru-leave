import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, post } from '../api/client';
import type { NotificationItem } from '../api/types';
import { DataTable, Details, EmptyState, ErrBox, Field, Loading, PageHeader, Tag, useToast } from '../components/ui';
import { fmtDateTime, fmtDuration, notificationStatusLabel, plural } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { readAll } from './settings/data';

interface SystemSummary {
  notifications: { status: string; count: number }[];
  quarantined_files: number;
  scan_failed_files: number;
  active_reservation_minutes: number;
  scanner: string;
  sandbox_id: string | null;
  generation: number | null;
}
const EMAIL_STATUSES = ['queued', 'sent', 'retrying', 'failed', 'gave_up'];

function emailProblem(error: string | null): string {
  if (/unreachable|recipient|address/i.test(error ?? '')) return "The address can't receive mail.";
  if (/timeout|timed out|connection|network/i.test(error ?? '')) return 'The mail service did not respond. Try again.';
  return 'Delivery failed. Check the address and try again.';
}

export default function Operations() {
  const { hasRole } = useSession();
  const canRetry = hasRole('tech_admin', 'hr');
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [emailsOpen, setEmailsOpen] = useState(false);
  const [retrying, setRetrying] = useState<number[]>([]);
  const [queued, setQueued] = useState<number[]>([]);
  const [errors, setErrors] = useState<Record<number, ApiError>>({});
  const summary = useApi(() => api<SystemSummary>('/ops/summary'), []);
  const attention = useApi(async () => {
    const groups = await Promise.all([
      readAll<NotificationItem>('/ops/notifications', { status: 'failed' }),
      readAll<NotificationItem>('/ops/notifications', { status: 'gave_up' }),
    ]);
    return groups.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, []);
  const emails = useApi(async () => {
    const rows = await readAll<NotificationItem>('/ops/notifications', { status: status === 'attention' || status === 'waiting' ? '' : status });
    return status === 'attention' ? rows.filter(n => n.status === 'failed' || n.status === 'gave_up') : status === 'waiting' ? rows.filter(n => n.status === 'queued' || n.status === 'retrying') : rows;
  }, [status]);

  async function retry(id: number) {
    setRetrying((ids) => [...ids, id]);
    setErrors((old) => { const next = { ...old }; delete next[id]; return next; });
    try {
      await post(`/ops/notifications/${id}/retry`);
      setQueued((ids) => [...ids, id]);
      toast('Email queued again.');
      summary.reload();
      emails.reload();
    } catch (e) {
      setErrors((old) => ({ ...old, [id]: e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)) }));
    } finally {
      setRetrying((ids) => ids.filter((n) => n !== id));
    }
  }
  const health = summary.data;
  const undelivered = health?.notifications.filter((n) => n.status === 'failed' || n.status === 'gave_up').reduce((n, row) => n + row.count, 0) ?? 0;
  const waiting = health?.notifications.filter((n) => n.status === 'queued' || n.status === 'retrying').reduce((n, row) => n + row.count, 0) ?? 0;
  const blocked = health ? health.quarantined_files + health.scan_failed_files : 0;
  const retryButton = (n: NotificationItem) => (
    <>
      {queued.includes(n.id) ? <span role="status">Queued again</span> : canRetry ? (
        <button className="btn btn-secondary btn-sm" disabled={retrying.includes(n.id)} onClick={() => void retry(n.id)} aria-label={`Retry email to ${n.to_email}`}>
          {retrying.includes(n.id) ? 'Queuing…' : 'Retry email'}
        </button>
      ) : null}
      {errors[n.id] ? <ErrBox error={errors[n.id]!} /> : null}
    </>
  );

  return (
    <div className="stack">
      <PageHeader title="System" subtitle="Email delivery and file checks." />
      {summary.loading ? <Loading /> : null}
      {summary.error ? <ErrBox error={summary.error} /> : null}
      {health ? <div className="card-grid">
        <div className="card"><h2>Emails</h2><a href="#all-emails" onClick={() => { setStatus(undelivered ? 'attention' : waiting ? 'waiting' : 'sent'); setEmailsOpen(true); }}>
          <Tag tone={undelivered ? 'warn' : 'ok'}>{undelivered || waiting ? `${undelivered} not delivered · ${waiting} waiting to be sent` : 'All delivered'}</Tag>
        </a></div>
        <div className="card"><h2>Files</h2><Tag tone={blocked ? 'warn' : 'ok'}>{blocked ? `${blocked} blocked` : 'None blocked'}</Tag></div>
        <div className="card"><h2>Virus scanner</h2><Tag tone={health.scan_failed_files ? 'warn' : undefined}>{health.scan_failed_files ? 'Some checks failed' : 'No failed checks'}</Tag></div>
      </div> : null}
      <section className="panel" aria-labelledby="attention-title">
        <h2 id="attention-title">Needs attention</h2>
        {attention.loading ? <Loading /> : attention.error ? <ErrBox error={attention.error} /> : (
          <DataTable<NotificationItem> rows={attention.data ?? []} empty="No emails need attention." columns={[
            { label: 'To', render: (n) => n.to_email },
            { label: 'Subject', render: (n) => n.subject },
            { label: 'Problem', render: (n) => emailProblem(n.last_error) },
            { label: 'Action', render: retryButton },
          ]} />
        )}
      </section>
      <div id="all-emails"><Details title="All emails" defaultOpen={emailsOpen}>
        <Field label="Delivery status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All emails</option><option value="attention">Not delivered</option><option value="waiting">Waiting to be sent</option>{EMAIL_STATUSES.map((s) => <option key={s} value={s}>{notificationStatusLabel(s)}</option>)}</select></Field>
        {emails.loading ? <Loading /> : emails.error ? <ErrBox error={emails.error} /> : <DataTable<NotificationItem> rows={emails.data ?? []} empty="No emails with this status." columns={[
          { label: 'To', render: (n) => n.to_email },
          { label: 'Subject', render: (n) => n.subject },
          { label: 'Status', render: (n) => notificationStatusLabel(n.status) },
          { label: 'Delivery', render: (n) => n.sent_at ? `Sent ${fmtDateTime(n.sent_at)}` : n.next_attempt_at ? `Next try ${fmtDateTime(n.next_attempt_at)}` : 'No next try scheduled' },
          { label: 'Details', render: (n) => <Details title="Delivery details"><p>{plural(n.attempts, 'attempt')}.</p>{n.last_error ? <p>{emailProblem(n.last_error)}</p> : null}{n.status !== 'sent' ? retryButton(n) : null}</Details> },
        ]} />}
      </Details></div>
      <Details title="Technical details">
        {health ? <dl className="kv">
          <div className="kv-row"><dt>Waiting for approval</dt><dd>{fmtDuration(health.active_reservation_minutes)}</dd></div>
          <div className="kv-row"><dt>Files blocked by scanning</dt><dd>{health.quarantined_files}</dd></div>
          <div className="kv-row"><dt>Files awaiting a successful check</dt><dd>{health.scan_failed_files}</dd></div>
          <div className="kv-row"><dt>Scanner</dt><dd>{health.scanner}</dd></div>
          {health.sandbox_id ? <div className="kv-row"><dt>Demo environment</dt><dd>Generation {health.generation}</dd></div> : null}
        </dl> : <EmptyState text="System details are unavailable." />}
        <p className="muted small">Delivery failures do not reverse saved changes.</p>
        <Link to="/history">View history</Link>
      </Details>
    </div>
  );
}
