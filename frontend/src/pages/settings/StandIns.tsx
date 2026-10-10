import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { post } from '../../api/client';
import type { Delegation, UserListItem } from '../../api/types';
import {
  DataTable,
  Details,
  EmptyState,
  ErrBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Tag,
} from '../../components/ui';
import { delegationScopeLabel, fmtRange } from '../../lib/format';
import { useSession } from '../../lib/session';
import { readAll } from './data';
import { useApi } from '../../lib/useApi';
import { useSave } from './shared';

type StandInStatus = 'Active' | 'Upcoming' | 'Ended';

function status(d: Delegation, today: string): StandInStatus {
  if (d.revoked_at || d.valid_to < today) return 'Ended';
  if (d.valid_from > today) return 'Upcoming';
  return 'Active';
}

const SCOPE_OPTIONS = [
  'manager_recommendation',
  'hr_check',
  'final_decision',
  'all_approvals',
];

export default function StandIns() {
  const { me, config } = useSession();
  const today = config?.business_date ?? '';
  const manageOthers = me?.roles.some((r) => r.role === 'hr' && r.scope_org_unit_id === null) ?? false;
  const canEdit = manageOthers || !!me?.is_manager || !!me?.roles.some(r => r.role === 'hr' || r.role === 'final_approver');
  const q = useApi(() => readAll<Delegation>('/delegations'), []);
  const users = useApi(() => readAll<UserListItem>('/users'), []);
  const [params, setParams] = useSearchParams();
  const [endFor, setEndFor] = useState<Delegation | null>(null);

  const newOpen = params.get('new') === '1';
  const forUser = Number(params.get('for')) || null;
  const closeNew = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('for');
    setParams(next, { replace: true });
  };

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;

  const rank = (d: Delegation) =>
    status(d, today) === 'Active' ? 0 : status(d, today) === 'Upcoming' ? 1 : 2;
  const rows = [...(q.data ?? [])].sort(
    (a, b) => rank(a) - rank(b) || b.valid_from.localeCompare(a.valid_from),
  );

  const standInList = (items: Delegation[]) => <DataTable<Delegation> rows={items} empty="No current stand-ins." columns={[
    { label:'Stand-in', title:true, render:d => d.to_user.display_name },
    { label:'For', render:d => d.from_user.display_name },
    { label:'Approvals', render:d => delegationScopeLabel(d.scope) },
    { label:'Dates', render:d => fmtRange(d.valid_from,d.valid_to) },
    { label:'Status', render:d => <Tag tone={status(d,today) === 'Active' ? 'ok' : undefined}>{status(d,today)}</Tag> },
    { label:'', className:'row-actions', render:d => status(d,today) !== 'Ended' && (manageOthers || d.from_user.id === me?.user.id) ? <button className="btn btn-ghost btn-sm" onClick={() => setEndFor(d)}>End…</button> : null },
  ]} />;

  return (
    <>
      <PageHeader
        title="Stand-ins"
        subtitle="Who can act for someone else while they're away."
        primary={
          canEdit ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('new', '1');
                setParams(next);
              }}
            >
              Add stand-in…
            </button>
          ) : undefined
        }
      />
      {!canEdit ? <p className="muted">You have no approval duties to hand over.</p> : null}
      {rows.length === 0 ? (
        <EmptyState text="No stand-ins set up." />
      ) : (
        <>
          {standInList(rows.filter((d) => status(d, today) !== 'Ended'))}
          <Details title="Ended stand-ins" count={rows.filter((d) => status(d, today) === 'Ended').length}>
            {standInList(rows.filter((d) => status(d, today) === 'Ended'))}
          </Details>
        </>
      )}

      {newOpen && today && users.loading ? <Loading label="Loading people…" /> : null}
      {newOpen && users.error ? <ErrBox error={users.error} /> : null}
      {newOpen && canEdit && today && users.data && me ? (
        <NewStandInModal
          businessDate={today}
          users={users.data ?? []}
          prefillFor={manageOthers ? forUser : me.user.id}
          manageOthers={manageOthers}
          viewerId={me.user.id}
          onClose={closeNew}
          onDone={() => {
            closeNew();
            q.reload();
          }}
        />
      ) : null}
      {endFor ? <EndStandInModal delegation={endFor} onClose={() => setEndFor(null)} onDone={() => { setEndFor(null); q.reload(); }} /> : null}
    </>
  );
}

export function NewStandInModal({
  businessDate,
  users,
  prefillFor,
  manageOthers,
  viewerId,
  onClose,
  onDone,
}: {
  businessDate: string;
  users: UserListItem[];
  prefillFor: number | null;
  manageOthers: boolean;
  viewerId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { err, busy, run } = useSave();
  const { me } = useSession();
  const active = users.filter((u) => u.active && !u.roles.some(r => r.role === 'auditor' || r.role === 'tech_admin'));
  const [fromId, setFromId] = useState<number>(prefillFor ?? (manageOthers ? 0 : viewerId));
  const [toId, setToId] = useState<number>(0);
  const [scope, setScope] = useState('manager_recommendation');
  const sender = active.find(u => u.id === fromId);
  const senderRoles = sender?.roles.map(r => r.role) ?? [];
  const senderScopes = SCOPE_OPTIONS.filter(s => s === 'manager_recommendation' ? !!sender?.employee && (manageOthers || !!me?.is_manager) : s === 'hr_check' ? senderRoles.includes('hr') : s === 'final_decision' ? senderRoles.includes('final_approver') : senderRoles.includes('hr') && senderRoles.includes('final_approver'));
  // A delegation supplies approval authority for its scope. The stand-in does
  // not need to hold that role already (e.g. Tom standing in for Elena).
  const eligible = active.filter(u => !!u.employee);
  const [from, setFrom] = useState(businessDate);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');

  return (
    <Modal title="Add stand-in" onClose={onClose} footer={<> <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !senderScopes.includes(scope) || !eligible.some(u => u.id === toId) || !fromId || !toId || (fromId === toId || (fromId !== viewerId && toId === viewerId)) || !from || !to || to < from || !reason.trim()}
          onClick={() =>
            void run(async () => {
              await post('/delegations', {
                from_user_id: fromId,
                to_user_id: toId,
                scope,
                valid_from: from,
                valid_to: to,
                reason: reason.trim(),
              });
              onDone();
              return 'Stand-in saved.';
            })
          }
        >
          {busy ? 'Saving…' : 'Save stand-in'}
        </button>

       </>}>
      {err ? <ErrBox error={err} /> : null}
      <Field label="Who is away?" hint={manageOthers ? undefined : "HR appoints stand-ins for other people. You can appoint your own."}>
        {manageOthers ? <select value={fromId} onChange={(e) => { const id = Number(e.target.value); setFromId(id); setToId(0); const u = active.find(u => u.id === id); setScope(u?.roles.some(r => r.role === 'final_approver') ? 'final_decision' : u?.roles.some(r => r.role === 'hr') ? 'hr_check' : 'manager_recommendation'); }}>
          <option value={0}>Choose who is away</option>
          {active.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </select> : <span>You ({sender?.display_name ?? me?.user.display_name})</span>}
      </Field>
      <Field label="Who stands in?">
        <select value={toId} onChange={(e) => setToId(Number(e.target.value))}>
          <option value={0}>Choose a stand-in</option>
          {eligible.filter((u) => u.id !== fromId && (fromId === viewerId || u.id !== viewerId)).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      </Field>
      <Field label="Which approvals?">
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          {senderScopes.map((s) => (
            <option key={s} value={s}>
              {delegationScopeLabel(s)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="From">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field label="To">
        <input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Field label="Reason (required)" hint="Shown in the history.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>

      {from && to && to < from ? (
        <p className="field-hint">“To” must be on or after “From”.</p>
      ) : null}
      {fromId === toId && fromId ? (
        <p className="field-hint">Pick two different people.</p>
      ) : null}
    </Modal>
  );
}


export function EndStandInModal({ delegation:d, onClose, onDone }: { delegation:Delegation; onClose:()=>void; onDone:()=>void }) {
  const { err, busy, run } = useSave();
  return <Modal title="End stand-in?" onClose={onClose} footer={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => { await post(`/delegations/${d.id}/revoke`); onDone(); return 'Stand-in ended.'; })}>End stand-in</button></>}><p>{d.to_user.display_name} will no longer be able to act for {d.from_user.display_name}.</p><ErrBox error={err} /></Modal>;
}
