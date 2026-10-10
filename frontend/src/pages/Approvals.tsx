import { useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, unwrapList } from '../api/client';
import type { ApprovalsResp, RequestSummary, Outcome, RequestDetail as RD } from '../api/types';
import { DecisionCard } from '../components/DecisionCard';
import { Details, EmptyState, ErrBox, Loading, Menu, PageHeader, Tag, useToast } from '../components/ui';
import { useSession } from '../lib/session';
import { isHr } from '../lib/nav';
import { fmtDuration, fmtRange, plural } from '../lib/format';
import { useApi } from '../lib/useApi';
import { AssignModal, type ModalCtx } from './request/modals';
import { decisionToast, firstName, fmtStampDay, verbsFor } from './request/text';
import './Approvals.css';

type Item = ApprovalsResp['items'][number];

function rowFlags(it: Item): ReactNode {
  const overlap = it.warnings.find(w => w.code === 'team_overlap');
  const names = Array.isArray(overlap?.details)
    ? (overlap.details as { name?: string }[]).flatMap(x => x.name ? [x.name] : []) : [];
  return <span className="qr-flags">
    {it.kind === 'amendment' ? <Tag>Change to approved leave</Tag> : null}
    {it.kind === 'cancellation' ? <Tag>Cancellation of days</Tag> : null}
    {names.length ? <Tag tone="warn">Overlaps with {names.join(', ')}</Tag> : null}
    {it.warnings.some(w => w.code === 'late_notice') ? <Tag tone="warn">Short notice</Tag> : null}
    {it.source === 'paper' ? <Tag>Paper form</Tag> : null}
  </span>;
}

function QueueRow({ it, waiting, open, onOpen, onDecided }: {
  it: Item;
  waiting?: boolean;
  open: boolean;
  onOpen: (id: number | null) => void;
  onDecided: (it: Item, outcome: Outcome) => void;
}) {
  const [panel, setPanel] = useState<'refuse' | 'question' | null>(null);
  const [load, setLoad] = useState(false);
  // Load detail once the row or its menu is used; retain it while collapsed.
  const q = useApi(() => load ? api<RD>(`/requests/${it.id}`) : Promise.resolve(null), [load]);
  const verbs = verbsFor(it.step.kind, ['recommend_approve', 'recommend_reject', 'checked_ok', 'checked_problem', 'approve', 'reject', 'needs_information']);
  function expand(which: 'refuse' | 'question' | null) {
    setLoad(true);
    setPanel(which);
    onOpen(which || !open ? it.id : null);
  }
  const extras = q.data?.allowed_actions ?? [];
  const more = [
    ...(!waiting && !open ? [
      { label: verbs.refuseLabel, onSelect: () => expand('refuse') },
      { label: 'Ask a question…', onSelect: () => expand('question') },
    ] : []),
    ...(extras.includes('amend') ? [{ label: 'Change dates for employee…', to: `/requests/${it.id}?action=amend` }] : []),
    ...(extras.includes('revise') && it.kind !== 'cancellation' ? [{ label: 'Change dates for employee…', to: `/requests/${it.id}?action=respond-change` }] : []),
    ...(extras.includes('respond') ? [{ label: "Record employee’s answer…", to: `/requests/${it.id}?action=record` }] : []),
    ...(extras.includes('reassign') ? [{ label: 'Assign step to…', to: `/requests/${it.id}?action=assign` }] : []),
    ...(extras.includes('upload') ? [{ label: 'Add document…', to: `/requests/${it.id}?action=upload` }] : []),
    ...(extras.includes('withdraw') ? [{ label: 'Withdraw for employee…', to: `/requests/${it.id}?action=withdraw`, danger: true }] : []),
    { label: 'Open full request', to: `/requests/${it.id}` },
  ];
  const sent = q.data?.current_revision.submitted_at;
  return <article className={`queue-row${open ? ' open' : ''}`}>
    <div className="queue-row-head">
      <button type="button" className="queue-row-toggle" aria-expanded={open} aria-controls={`request-${it.id}`} onClick={() => expand(null)}>
        <span className="qr-l1"><strong>{it.employee.full_name}</strong> — {it.leave_type_name}</span>
        <span className="qr-l2">{fmtRange(it.start_date, it.end_date)} · {fmtDuration(it.total_minutes, it.minutes_per_day)}</span>
        <span className="qr-l3">{waiting ? `Waiting for ${firstName(it.employee.full_name)} to answer` : verbs.yourStep}{it.acting_for ? ` · standing in for ${it.acting_for.display_name}` : ''}{sent ? ` · sent ${fmtStampDay(sent)}` : ''}</span>
        {rowFlags(it)}
        <span className="qr-l3 queue-review-label">{open ? 'Hide review' : 'Review ›'}</span>
      </button>
      <div className="queue-row-actions no-print" onClickCapture={() => setLoad(true)}>
        <Menu label="More" align="end" items={more} />
      </div>
    </div>
    {open ? <div id={`request-${it.id}`} className="queue-expand">
      {q.loading || !load ? <Loading label="Loading request…" /> : q.error ? <><ErrBox error={q.error} /><button className="btn btn-secondary" onClick={q.reload}>Reload request</button></> : q.data ?
        <DecisionCard request={q.data} initialPanel={panel} openLink onRefresh={q.reload} onDecided={outcome => onDecided(it, outcome)} /> : null}
    </div> : null}
  </article>;
}

function Assignment({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const q = useApi(() => api<RD>(`/requests/${id}`), [id]);
  const { config } = useSession();
  const toast = useToast();
  if (q.loading) return <Loading label="Loading request…" />;
  if (q.error) return <><ErrBox error={q.error} /><button className="btn btn-ghost" onClick={onClose}>Close assignment</button></>;
  if (!q.data) return null;
  const ctx: ModalCtx = {
    d: q.data, leaveTypes: [], businessDate: config?.business_date ?? '', isOwner: false,
    onClose, onNavigate: onClose,
    onDone: text => { toast(text); onClose(); onDone(); },
    onStale: () => { toast('This request changed. Check the updated step.', 'info'); q.reload(); },
  };
  return q.data.allowed_actions.includes('reassign') ? <AssignModal ctx={ctx} /> : <><ErrBox error={new ApiError(403, 'forbidden', 'Assignment is no longer available.')} /><button className="btn btn-ghost" onClick={onClose}>Close assignment</button></>;
}

export default function Approvals() {
  const { me } = useSession();
  const navigate = useNavigate();
  const q = useApi(async () => {
    const queue = await api<ApprovalsResp>('/approvals');
    const requests = unwrapList<RequestSummary>(await api('/requests', { query: { scope: 'all', status: 'needs_information', limit: 500 } }));
    const missing = requests.filter(r => r.status === 'needs_information' && !queue.items.some(it => it.id === r.id));
    const details = await Promise.all(missing.map(r => api<RD>(`/requests/${r.id}`)));
    for (const d of details) {
      const question = [...d.messages].reverse().find(m => m.kind === 'question');
      const step = d.steps.find(s => s.status === 'pending');
      if (question?.author?.id === me?.user.id && step) queue.items.push({ ...d, step, acting_for: null });
    }
    return queue;
  }, [me?.user.id]);
  const toast = useToast();
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [assign, setAssign] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;
  if (!q.data) return null;
  const items = q.data.items.filter(it => !removed.has(it.id) || it.status === 'needs_information');
  const actionable = items.filter(it => it.status !== 'needs_information');
  const waiting = items.filter(it => it.status === 'needs_information');
  const problems = me && isHr(me) ? q.data.problems : [];
  function finish(it: Item, outcome: Outcome) {
    const idx = actionable.indexOf(it);
    setRemoved(s => new Set(s).add(it.id));
    setOpenId(null);
    toast(decisionToast(outcome, it.employee.full_name, it.kind));
    q.reload();
    requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('.queue-row-toggle');
      if (rows?.length) rows[Math.min(Math.max(idx, 0), rows.length - 1)]?.focus();
      else document.getElementById('queue-summary')?.focus();
    });
  }
  return <>
    <PageHeader title="Approvals" more={me && isHr(me) ? [
      { label: 'Enter paper form', onSelect: () => navigate('/requests/new?paper=1') },
      { label: 'Add unit', onSelect: () => navigate('/people?action=add-unit') },
      { label: 'Add entitlement…', onSelect: () => navigate('/balances?action=entitlement') },
      { label: 'Close year…', onSelect: () => navigate('/balances?action=close') },
      { label: 'Import opening balances…', onSelect: () => navigate('/balances?action=opening_balances') },
      { label: 'Import past leave…', onSelect: () => navigate('/balances?action=historical_leave') },
    ] : undefined} subtitle={actionable.length ? `${plural(actionable.length, 'request')} need${actionable.length === 1 ? 's' : ''} you` : undefined} />
    <div id="queue-summary" tabIndex={-1} className="visually-hidden">{actionable.length ? `${plural(actionable.length, 'request')} waiting` : 'No requests waiting for a decision'}</div>
    {!actionable.length ? <EmptyState text="Nothing is waiting for your decision." /> : null}
    <div className="queue" ref={listRef}>{actionable.map(it => <QueueRow key={`${it.id}-${it.step.id}`} it={it} open={openId === it.id} onOpen={setOpenId} onDecided={finish} />)}</div>
    {waiting.length ? <Details title="Waiting for the employee" count={waiting.length} className="queue-waiting"><div className="queue">{waiting.map(it => <QueueRow key={`${it.id}-${it.step.id}`} it={it} waiting open={openId === it.id} onOpen={setOpenId} onDecided={finish} />)}</div></Details> : null}
    {problems.length ? <Details title="Steps with nobody assigned" count={problems.length}><ul className="queue-plain">{problems.map(p => <li key={p.id} className="queue-row"><div className="queue-row-head"><div className="queue-row-lines"><span className="qr-l1"><Link to={`/requests/${p.id}`}>{p.employee.full_name} — {p.leave_type_name}</Link></span><span className="qr-l2">{fmtRange(p.start_date, p.end_date)} · {fmtDuration(p.total_minutes, p.minutes_per_day)}</span><span className="qr-l3">Nobody is assigned to a step yet</span></div><button className="btn btn-secondary" onClick={() => setAssign(p.id)}>Assign step…</button></div></li>)}</ul></Details> : null}
    {assign !== null ? <Assignment id={assign} onClose={() => setAssign(null)} onDone={q.reload} /> : null}
  </>;
}
