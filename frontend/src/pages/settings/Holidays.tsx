import { useState } from 'react';
import { post } from '../../api/client';
import type { CalendarException, Schedule } from '../../api/types';
import { DataTable, Details, ErrBox, Field, Loading, Modal, PageHeader } from '../../components/ui';
import { fmtDate, fmtDay, plural } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useApi } from '../../lib/useApi';
import { readAll } from './data';
import { AffectedRequests, type AffectedRequest, useSave } from './shared';

export default function Holidays() {
  const { me, config } = useSession();
  const canEdit = me?.roles.some(r => r.role === 'hr' && r.scope_org_unit_id === null) ?? false;
  const today = config?.business_date ?? '';
  const q = useApi(() => readAll<CalendarException>('/calendar-exceptions'), []);
  const schedules = useApi(() => readAll<Schedule>('/schedules'), []);
  const [add, setAdd] = useState(false);
  const [revokeFor, setRevokeFor] = useState<CalendarException | null>(null);
  const [affected, setAffected] = useState<AffectedRequest[]>([]);
  const rows = [...(q.data ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  function done(requests: AffectedRequest[]) { setAffected(requests); setAdd(false); setRevokeFor(null); q.reload(); }
  const table = (items: CalendarException[], empty: string, removed = false) => <DataTable<CalendarException> rows={items} empty={empty} columns={[
    { label: 'Date', render: ex => ex.date.slice(0,4) === today.slice(0,4) ? fmtDay(ex.date) : fmtDate(ex.date) },
    { label: 'Name', render: ex => <>{ex.name}{ex.schedule_id ? <div className="small muted">{schedules.data?.find(s => s.id === ex.schedule_id)?.name ?? 'Selected work pattern'}</div> : null}</> },
    ...(rows.some(ex => ex.minutes > 0) ? [{ label: 'Day type', render: (ex: CalendarException) => ex.minutes === 0 ? 'Holiday' : `Short day — ${ex.minutes / 60} h` }] : []),
    removed ? { label: 'Reason', render: ex => ex.reason ?? '—' } : { label: '', className: 'row-actions', render: ex => canEdit ? <button className="btn btn-secondary btn-sm" onClick={() => setRevokeFor(ex)} aria-label={`Remove ${ex.name}`}>Remove…</button> : null },
  ]} />;
  return <>
    <PageHeader title="Public holidays" subtitle="Days off and shorter days used when working out leave." primary={canEdit ? <button className="btn" onClick={() => setAdd(true)}>Add public holiday…</button> : undefined} />
    {schedules.error ? <ErrBox error={schedules.error} /> : null}
    <AffectedRequests requests={affected} />
    {q.loading ? <Loading /> : q.error ? <ErrBox error={q.error} /> : <>
      {table(rows.filter(ex => !ex.revoked_at && ex.date >= today), 'No holidays coming up.')}
      <Details title="Past holidays" count={rows.filter(ex => !ex.revoked_at && ex.date < today).length}>{table(rows.filter(ex => !ex.revoked_at && ex.date < today), 'No past holidays.')}</Details>
      <Details title="Removed holidays" count={rows.filter(ex => ex.revoked_at).length}>{table(rows.filter(ex => ex.revoked_at), 'No holidays have been removed.', true)}</Details>
    </>}
    {add ? <AddHolidayModal businessDate={today} schedules={schedules.data ?? []} onClose={() => setAdd(false)} onDone={done} /> : null}
    {revokeFor ? <RevokeModal ex={revokeFor} onClose={() => setRevokeFor(null)} onDone={done} /> : null}
  </>;
}

export function RevokeModal({ ex, onClose, onDone }: { ex: CalendarException; onClose: () => void; onDone: (requests: AffectedRequest[]) => void }) {
  const { err, busy, run } = useSave();
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<AffectedRequest[] | null>(null);
  return <Modal title={`Remove ${ex.name}?`} onClose={() => result ? onDone(result) : onClose()} footer={result ? <button className="btn" onClick={() => onDone(result)}>Done</button> : <>
    <button className="btn btn-ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
    <button className="btn btn-danger" type="submit" form="remove-holiday" disabled={busy || !reason.trim()}>{busy ? 'Removing…' : 'Remove holiday'}</button>
  </>}>
    {result ? <><p role="status">{ex.name} removed.</p><AffectedRequests requests={result} /></> : <>
    <p>{ex.name} on {fmtDate(ex.date)} will stop applying to new calculations. Saved requests keep their original days.</p>
    <ErrBox error={err} />
    <form id="remove-holiday" onSubmit={e => { e.preventDefault(); void run(async () => {
      const result = await post<{ affected_future_requests?: AffectedRequest[] }>(`/calendar-exceptions/${ex.id}/revoke`, { reason: reason.trim() });
      const affected = result.affected_future_requests ?? [];
      if (affected.length) setResult(affected); else onDone(affected);
      return affected.length ? `Holiday removed. ${plural(affected.length, 'request')} needs checking.` : 'Holiday removed.';
    }); }}>
      <Field label="Reason (required)"><textarea value={reason} required onChange={e => setReason(e.target.value)} /></Field>
    </form></>}
  </Modal>;
}

export function AddHolidayModal({ businessDate, schedules, onClose, onDone }: { businessDate: string; schedules: Schedule[]; onClose: () => void; onDone: (requests: AffectedRequest[]) => void }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(businessDate);
  const [kind, setKind] = useState('holiday');
  const [hours, setHours] = useState(4);
  const [schedule, setSchedule] = useState('');
  const { err, busy, run } = useSave();
  return <Modal title="Add public holiday" onClose={onClose} footer={<>
    <button className="btn btn-ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
    <button className="btn" type="submit" form="add-holiday" disabled={busy || !name.trim() || !date}>{busy ? 'Adding…' : 'Add holiday'}</button>
  </>}>
    <form id="add-holiday" onSubmit={e => { e.preventDefault(); void run(async () => {
      const result = await post<{ affected_future_requests?: AffectedRequest[] }>('/calendar-exceptions', { name: name.trim(), date, minutes: kind === 'holiday' ? 0 : Math.round(hours * 60), schedule_id: schedule ? Number(schedule) : null });
      onDone(result.affected_future_requests ?? []);
      return `${name.trim()} added.`;
    }); }}>
      <Field label="Date"><input type="date" value={date} required onChange={e => setDate(e.target.value)} /></Field>
      <Field label="Name"><input value={name} required onChange={e => setName(e.target.value)} /></Field>
      <Field label="Day type"><select value={kind} onChange={e => setKind(e.target.value)}><option value="holiday">Holiday</option><option value="short">Short day</option></select></Field>
      {kind === 'short' ? <Field label="Working hours"><input type="number" min={0.5} max={24} step={0.5} value={hours} required onChange={e => setHours(Number(e.target.value))} /></Field> : null}
      <Details title="Limit to a work pattern"><Field label="Applies to"><select value={schedule} onChange={e => setSchedule(e.target.value)}><option value="">Everyone</option>{schedules.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field></Details>
      <ErrBox error={err} />
    </form>
  </Modal>;
}
