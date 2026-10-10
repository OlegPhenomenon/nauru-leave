import { useState } from 'react';
import { Link } from 'react-router';
import { post } from '../../api/client';
import type { CalendarException, Delegation, LeaveType, NotificationItem, Schedule, UserListItem } from '../../api/types';
import { ErrBox, Field, Modal, PageHeader } from '../../components/ui';
import { fmtDay, plural } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useApi } from '../../lib/useApi';
import { readAll } from './data';
import { AddHolidayModal, RevokeModal } from './Holidays';
import { AddTypeModal, ChangeRulesModal } from './LeaveTypes';
import { NewStandInModal } from './StandIns';
import { GiveAccessModal } from './UsersAccess';
import { PatternModal } from './WorkPatterns';
import { AffectedRequests, type AffectedRequest, useSave } from './shared';

type Action = 'type' | 'rules' | 'pattern' | 'holiday' | 'stand-in' | 'access';

export default function Overview() {
  const { me, config } = useSession();
  const today = config?.business_date ?? '';
  const canConfigure = me?.roles.some((r) => r.role === 'hr' && r.scope_org_unit_id === null) ?? false;
  const canRetry = me?.roles.some((r) => r.role === 'hr') ?? false;
  const [action, setAction] = useState<Action | null>(null);
  const [revokeFor, setRevokeFor] = useState<CalendarException | null>(null);
  const [affected, setAffected] = useState<AffectedRequest[]>([]);
  const { err, busy, run } = useSave();
  const types = useApi(() => readAll<LeaveType>('/leave-types'), []);
  const patterns = useApi(() => readAll<Schedule>('/schedules'), []);
  const holidays = useApi(() => readAll<CalendarException>('/calendar-exceptions'), []);
  const users = useApi(() => readAll<UserListItem>('/users'), []);
  const standIns = useApi(() => readAll<Delegation>('/delegations'), []);
  const failedEmails = useApi(async () => {
    if (!canRetry) return [];
    const groups = await Promise.all([
      readAll<NotificationItem>('/ops/notifications', { status: 'failed' }),
      readAll<NotificationItem>('/ops/notifications', { status: 'gave_up' }),
    ]);
    return groups.flat();
  }, [canRetry]);
  const close = () => setAction(null);
  function done(requests: AffectedRequest[] = []) {
    close();
    setAffected(requests);
    types.reload(); patterns.reload(); holidays.reload(); users.reload(); standIns.reload();
  }
  const count = (rows: unknown[] | null, noun: string) => rows ? plural(rows.length, noun) : 'Loading…';
  const quick = (label: string, next: Action, ready: boolean) => <button type="button" className={next === 'rules' ? 'btn' : 'btn btn-secondary btn-sm'} disabled={!ready || !today} onClick={() => setAction(next)}>{label}</button>;
  const failures = failedEmails.data ?? [];
  return <>
    <PageHeader title="Settings" subtitle="Leave rules, work patterns and access." primary={canConfigure ? quick('Change leave rules…', 'rules', !!types.data) : undefined} />
    <ul className="sentence-list">
      <li><span><Link to="/settings/leave-types">Leave types</Link> · {count(types.data?.filter((t) => t.active) ?? null, 'active leave type')}</span>{canConfigure ? quick('Add leave type…', 'type', !!types.data) : null}</li>
      <li><span><Link to="/settings/schedules">Work patterns</Link> · {count(patterns.data, 'work pattern')}</span>{canConfigure ? quick('Add work pattern…', 'pattern', !!patterns.data) : null}</li>
      <li><span><Link to="/settings/holidays">Public holidays</Link> · {count(holidays.data?.filter((h) => !h.revoked_at && h.date >= today) ?? null, 'upcoming holiday')}</span>{canConfigure ? quick('Add public holiday…', 'holiday', !!patterns.data) : null}</li>
      {canConfigure ? (holidays.data ?? []).filter(h => !h.revoked_at && h.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3).map(h => <li key={h.id}><span>{h.name} · {fmtDay(h.date)}</span><button className="btn btn-ghost btn-sm" onClick={() => setRevokeFor(h)} aria-label={`Remove ${h.name}`}>Remove…</button></li>) : null}
      <li><span><Link to="/settings/route">Approval route</Link> · Manager recommendation, HR check, final decision.</span></li>
      <li><span><Link to="/settings/delegations">Stand-ins</Link> · {count(standIns.data?.filter((d) => !d.revoked_at && d.valid_to >= today) ?? null, 'current or upcoming stand-in')}</span>{canConfigure ? quick('Add stand-in…', 'stand-in', !!users.data) : null}</li>
      <li><span><Link to="/settings/users">Users &amp; access</Link> · {count(users.data, 'user')}</span>{users.data?.some((u) => u.allowed.grant_roles.length > 0) ? quick('Give access…', 'access', true) : null}</li>
      <li><span><Link to="/system">System</Link> · {failedEmails.error ? 'Email delivery could not be checked.' : failedEmails.loading ? 'Checking email delivery…' : failures.length ? plural(failures.length, 'failed email') : 'No failed emails.'}</span>{canRetry && failures.length ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(async () => {
        // Only failed deliveries are retried. Refresh even after a partial failure.
        const results = await Promise.allSettled(failures.map((n) => post(`/ops/notifications/${n.id}/retry`)));
        failedEmails.reload();
        const failure = results.find((r) => r.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return 'Failed emails queued again.';
      })}>{busy ? 'Queuing…' : 'Retry failed emails'}</button> : null}</li>
      <li><span><Link to="/history">History</Link> · Find a request or see who changed what.</span></li>
    </ul>
    {[types.error, patterns.error, holidays.error, users.error, standIns.error, failedEmails.error, err].map((error, i) => error ? <ErrBox key={i} error={error} /> : null)}
    <AffectedRequests requests={affected} />
    {revokeFor ? <RevokeModal ex={revokeFor} onClose={() => setRevokeFor(null)} onDone={requests => { setRevokeFor(null); done(requests); }} /> : null}
    {action === 'type' && types.data ? <AddTypeModal businessDate={today} existingCodes={types.data.map((t) => t.code)} onClose={() => { close(); types.reload(); }} onDone={done} /> : null}
    {action === 'rules' && types.data ? <PickRulesModal types={types.data} businessDate={today} onClose={close} onDone={done} /> : null}
    {action === 'pattern' ? <PatternModal businessDate={today} onClose={close} onDone={done} /> : null}
    {action === 'holiday' && patterns.data ? <AddHolidayModal businessDate={today} schedules={patterns.data} onClose={close} onDone={done} /> : null}
    {action === 'stand-in' && users.data && me ? <NewStandInModal businessDate={today} users={users.data} prefillFor={null} manageOthers={canConfigure} viewerId={me.user.id} onClose={close} onDone={done} /> : null}
    {action === 'access' && users.data ? <GiveAccessModal users={users.data} hr onClose={close} onSaved={users.reload} /> : null}
  </>;
}

function PickRulesModal({ types, businessDate, onClose, onDone }: { types: LeaveType[]; businessDate: string; onClose: () => void; onDone: (requests: AffectedRequest[]) => void }) {
  const [id, setId] = useState(0);
  const selected = types.find((t) => t.id === id);
  const picker = <Field label="Leave type"><select value={id} onChange={(e) => setId(Number(e.target.value))}><option value={0}>Choose a leave type</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.active ? '' : ' (inactive)'}</option>)}</select></Field>;
  return selected ? <ChangeRulesModal key={selected.id} t={selected} picker={picker} businessDate={businessDate} onClose={onClose} onDone={onDone} /> : <Modal title="Change leave rules" onClose={onClose}>{picker}{!types.length ? <p>No leave types yet.</p> : null}</Modal>;
}
