import { useState } from 'react';
import { Link } from 'react-router';
import { post } from '../../api/client';
import type { CalendarException, Delegation, LeaveType, NotificationItem, OrgUnit, Schedule, UserListItem } from '../../api/types';
import { ErrBox, Field, Modal, PageHeader } from '../../components/ui';
import { plural } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useApi } from '../../lib/useApi';
import { readAll } from './data';
import { AddHolidayModal } from './Holidays';
import { AddTypeModal, ChangeRulesModal } from './LeaveTypes';
import { UnitDialog } from '../people/dialogs';
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
  const [unitFor, setUnitFor] = useState<OrgUnit | null | undefined>(undefined);
  const units = useApi(() => readAll<OrgUnit>('/org-units'), []);
  const [action, setAction] = useState<Action | null>(null);
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
    units.reload(); types.reload(); patterns.reload(); holidays.reload(); users.reload(); standIns.reload();
  }
  const count = (rows: unknown[] | null, noun: string) => rows ? plural(rows.length, noun) : 'Loading…';
  const quick = (label: string, next: Action, ready: boolean) => <button type="button" className={next === 'rules' ? 'btn' : 'btn btn-secondary'} disabled={!ready || !today} onClick={() => setAction(next)}>{label}</button>;
  const failures = failedEmails.data ?? [];
  return <>
    <PageHeader title="Settings" subtitle="Leave rules, work patterns and access." primary={canConfigure ? quick('Change rules…', 'rules', !!types.data) : undefined} />
    <AffectedRequests requests={affected} />
    <div className="settings-grid">
      <section className="card settings-card">
        <h2><Link to="/people?tab=units">Units</Link></h2>
        <p>{count(units.data, 'unit')}</p>
        {canConfigure ? <button className="btn btn-secondary" onClick={() => setUnitFor(null)}>Add unit…</button> : <Link className="btn btn-secondary" to="/people?tab=units">Units</Link>}
      </section>
      <section className="card settings-card">
        <h2><Link to="/settings/leave-types">Leave types</Link></h2>
        <p>{count(types.data?.filter(t => t.active) ?? null, 'active leave type')}</p>
        {canConfigure ? quick('Add leave type…', 'type', !!types.data) : <Link className="btn btn-secondary" to="/settings/leave-types">Leave types</Link>}
      </section>
      <section className="card settings-card">
        <h2><Link to="/settings/schedules">Work patterns</Link></h2>
        <p>{count(patterns.data, 'work pattern')}</p>
        {canConfigure ? quick('Add work pattern…', 'pattern', !!patterns.data) : <Link className="btn btn-secondary" to="/settings/schedules">Work patterns</Link>}
      </section>
      <section className="card settings-card">
        <h2><Link to="/settings/holidays">Public holidays</Link></h2>
        <p>{count(holidays.data?.filter(h => !h.revoked_at && h.date >= today) ?? null, 'upcoming holiday')}</p>
        {canConfigure ? quick('Add public holiday…', 'holiday', !!patterns.data) : <Link className="btn btn-secondary" to="/settings/holidays">Public holidays</Link>}
      </section>
      <section className="card settings-card">
        <h2><Link to="/settings/route">Approval route</Link></h2>
        <p>Manager recommendation, HR check, final decision.</p>
        <Link className="btn btn-secondary" to="/settings/route">Approval route</Link>
      </section>
      <section className="card settings-card">
        <h2><Link to="/settings/delegations">Stand-ins</Link></h2>
        <p>{count(standIns.data?.filter(d => !d.revoked_at && d.valid_to >= today) ?? null, 'current or upcoming stand-in')}</p>
        {canConfigure ? quick('Add stand-in…', 'stand-in', !!users.data) : <Link className="btn btn-secondary" to="/settings/delegations">Stand-ins</Link>}
      </section>
      <section className="card settings-card">
        <h2><Link to="/settings/users">Users &amp; access</Link></h2>
        <p>{count(users.data, 'user')}</p>
        {users.data?.some(u => u.allowed.grant_roles.length > 0) ? quick('Give access…', 'access', true) : <Link className="btn btn-secondary" to="/settings/users">Users &amp; access</Link>}
      </section>
      <section className="card settings-card">
        <h2><Link to="/system">System</Link></h2>
        <p>{failedEmails.error ? 'Email delivery could not be checked.' : failedEmails.loading ? 'Checking email delivery…' : failures.length ? plural(failures.length, 'failed email') : 'No failed emails.'}</p>
        {canRetry && failures.length ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(async () => {
          const results = await Promise.allSettled(failures.map(n => post(`/ops/notifications/${n.id}/retry`)));
          failedEmails.reload();
          const failure = results.find(r => r.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          return 'Failed emails will be sent again.';
        })}>{busy ? 'Queuing…' : 'Retry failed emails'}</button> : <Link className="btn btn-secondary" to="/system">System</Link>}
      </section>
      <section className="card settings-card">
        <h2><Link to="/history">History</Link></h2>
        <p>Find a request or see who changed what.</p>
        <Link className="btn btn-secondary" to="/history">History</Link>
      </section>
    </div>
    {[types.error, patterns.error, holidays.error, users.error, standIns.error, failedEmails.error, err].map((error, i) => error ? <ErrBox key={i} error={error} /> : null)}
    {unitFor !== undefined ? <UnitDialog unit={unitFor} units={units.data ?? []} onClose={() => setUnitFor(undefined)} onSaved={() => { setUnitFor(undefined); units.reload(); }} /> : null}
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
  return selected ? <ChangeRulesModal key={selected.id} t={selected} picker={picker} businessDate={businessDate} onClose={onClose} onDone={onDone} /> : <Modal title="Change rules" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled>Save rules</button></>}>{picker}{!types.length ? <p>No leave types yet.</p> : null}</Modal>;
}
