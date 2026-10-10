import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { post } from '../../api/client';
import type { Delegation, UserListItem } from '../../api/types';
import {
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
import { isTechAdmin } from '../../lib/nav';
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
  const canEdit = manageOthers || (me ? isTechAdmin(me) : false);
  const q = useApi(() => readAll<Delegation>('/delegations'), []);
  const users = useApi(() => readAll<UserListItem>('/users'), []);
  const [params, setParams] = useSearchParams();
  const { err, busy, run } = useSave();
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

  const standInList = (items: Delegation[]) => (
        <ul className="sentence-list">
          {items.map((d) => {
            const st = status(d, today);
            const canEnd =
              st !== 'Ended' && (manageOthers || d.from_user.id === me?.user.id);
            return (
              <li key={d.id}>
                <span>
                  <strong>{d.to_user.display_name}</strong> stands in for{' '}
                  <strong>{d.from_user.display_name}</strong> ·{' '}
                  {delegationScopeLabel(d.scope).toLowerCase()} · {fmtRange(d.valid_from, d.valid_to)}{' '}
                  <Tag tone={st === 'Active' ? 'ok' : undefined}>{st}</Tag>
                  {d.reason ? <span className="muted small"> — {d.reason}</span> : null}
                </span>
                {canEnd ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => setEndFor(d)}
                  >
                    End now
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
  );

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
              Add stand-in
            </button>
          ) : undefined
        }
      />
      {err ? <ErrBox error={err} /> : null}
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
      {newOpen && today && users.data && me ? (
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
      {endFor ? <Modal title="End stand-in?" onClose={() => setEndFor(null)} footer={<> <button type="button" className="btn btn-ghost" onClick={() => setEndFor(null)}>Cancel</button><button className="btn btn-secondary" disabled={busy} onClick={() => void run(async () => {
          await post(`/delegations/${endFor.id}/revoke`); setEndFor(null); q.reload(); return 'Stand-in ended.';
        })}>End stand-in</button> </>}>
        <p>{endFor.to_user.display_name} will no longer be able to act for {endFor.from_user.display_name}.</p>
        {err ? <ErrBox error={err} /> : null}

      </Modal> : null}
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
  const active = users.filter((u) => u.active);
  const [fromId, setFromId] = useState<number>(prefillFor ?? active[0]?.id ?? 0);
  const [toId, setToId] = useState<number>(0);
  const [scope, setScope] = useState('all_approvals');
  const [from, setFrom] = useState(businessDate);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');

  return (
    <Modal title="Add stand-in" onClose={onClose} footer={<> <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !fromId || !toId || (fromId === toId || (fromId !== viewerId && toId === viewerId)) || !from || !to || to < from || !reason.trim()}
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
        <select disabled={!manageOthers} value={fromId} onChange={(e) => setFromId(Number(e.target.value))}>
          {active.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Who stands in?">
        <select value={toId} onChange={(e) => setToId(Number(e.target.value))}>
          <option value={0}>Choose a stand-in</option>
          {active.filter((u) => u.id !== fromId && (fromId === viewerId || u.id !== viewerId)).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      </Field>
      <Field label="Which approvals?">
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          {SCOPE_OPTIONS.map((s) => (
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
      <Field label="Reason" hint="Required — shown in the history.">
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

