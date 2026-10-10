// The request page — one component, two views.
// Owner: what happens next + send/answer/change/cancel.
// Reviewer: the DecisionCard for the pending step + a quiet record below.
// Everything else lives behind collapsed disclosures.

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, post } from '../api/client';
import type { AllowedAction, LeaveType, Outcome, RequestDetail as RD } from '../api/types';
import { AttachmentLines, DecisionCard } from '../components/DecisionCard';
import { ErrBox, Loading, PageHeader, StatusBadge, useToast } from '../components/ui';
import { IntentKeys, remainingRanges } from '../lib/domain';
import { fmtDate, fmtDuration, fmtRange, statusLabel } from '../lib/format';
import { homeFor } from '../lib/nav';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import {
  AssignModal,
  CancelModal,
  ChangeDatesModal,
  ConfirmActualModal,
  DeleteDraftModal,
  EditDraftModal,
  RecordAnswerModal,
  SubmitModal,
  UploadModal,
  WithdrawModal,
  WorkedModal,
  type ModalCtx,
} from './request/modals';
import {
  ActualDetails,
  ChangesDetails,
  DaysDetails,
  DocumentsDetails,
  EffectDetails,
  HistoryDetails,
  Messages,
  StepsDetails,
} from './request/sections';
import {
  changeSummary,
  decisionToast,
  firstName,
  fmtStampDay,
  statusSentence,
  thingsToKnow,
} from './request/text';
import { approvedActions } from './request/ApprovedActions';
import './RequestDetail.css';

type ModalKind =
  | 'submit'
  | 'edit'
  | 'delete'
  | 'withdraw'
  | 'respond-change'
  | 'amend'
  | 'cancel'
  | 'assign'
  | 'actual-confirm'
  | 'actual-worked'
  | 'record'
  | 'upload';

const MODAL_NAMES: ModalKind[] = ['submit', 'edit', 'delete', 'withdraw', 'respond-change', 'amend', 'cancel', 'assign', 'actual-confirm', 'actual-worked', 'record', 'upload'];
function modalFromUrl(action: string | null): ModalKind | null {
  return MODAL_NAMES.includes(action as ModalKind) ? action as ModalKind : null;
}

const CHIP_WHEN_DECIDABLE = {
  manager_recommendation: 'Waiting for your recommendation',
  hr_check: 'Waiting for your HR check',
  final_decision: 'Waiting for your decision',
} as const;

function ownerTitle(d: RD): string {
  if (d.kind === 'amendment') {
    const rev = d.current_revision;
    return `Change to ${d.leave_type_name.toLowerCase()} · ${fmtRange(rev.start_date, rev.end_date)}`;
  }
  if (d.kind === 'cancellation') {
    const ch = changeSummary(d);
    return `Cancel ${ch?.cancelledRange ?? fmtRange(d.current_revision.start_date, d.current_revision.end_date)} · ${d.leave_type_name.toLowerCase()}`;
  }
  const rev = d.in_force_revision ?? d.current_revision;
  return `${d.leave_type_name} · ${remainingRanges(rev).map(([a, b]) => fmtRange(a, b)).join(', ') || fmtRange(rev.start_date, rev.end_date)}`;
}

function reviewerTitle(d: RD): string {
  if (d.kind === 'amendment')
    return `${d.employee.full_name} — Change to ${d.leave_type_name.toLowerCase()}`;
  if (d.kind === 'cancellation') return `${d.employee.full_name} — Cancellation`;
  return `${d.employee.full_name} — ${ownerTitle(d)}`;
}

export default function RequestDetail() {
  const { me, config } = useSession();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useApi(() => api<RD>(`/requests/${id}`), [id]);
  const leaveTypesQ = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const [modal, setModal] = useState<ModalKind | null>(
    modalFromUrl(searchParams.get('action')),
  );
  const keys = useRef(new IntentKeys());
  const hadData = useRef<string | null>(null);
  const responseIntent = useRef('');
  useEffect(() => { setModal(modalFromUrl(searchParams.get('action'))); }, [id, searchParams]);

  const d = q.data;
  const today = config?.business_date ?? '';
  const isOwner = !!me?.employee && !!d && me.employee.id === d.employee.id;

  // Toasts passed via router state ("Request sent." after RequestNew).
  useEffect(() => {
    const st = location.state as { toast?: string } | null;
    if (st?.toast) {
      toast(st.toast);
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (d && d.id === Number(id) && !q.loading && !q.error) hadData.current = id ?? null;
  }, [d, id, q.loading, q.error]);

  // If a post-decision (or post-action) reload loses access — e.g. the
  // request moved out of the viewer's scope — go back to the queue with a
  // toast instead of showing a fatal error page.
  useEffect(() => {
    if (q.error?.status === 403 && hadData.current === id) {
      toast('Done — the request has moved on.', 'info');
      navigate('/approvals', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.error]);

  if (q.loading) return <Loading />;
  if (q.error) {
    const home = me ? homeFor(me) : '/my';
    if (q.error.status === 403)
      return (
        <div className="panel rq-error">
          <h1>You don’t have access to this request</h1>
          <p className="muted">
            This request is not shared with you. It may belong to another team or contain
            restricted (e.g. medical) details. If you believe you should see it, ask an HR
            officer to check your role and scope.
          </p>
          <Link className="btn btn-secondary" to={home}>
            Back
          </Link>
        </div>
      );
    if (q.error.status === 404)
      return (
        <div className="panel rq-error">
          <h1>Request not found</h1>
          <p className="muted">This link does not match any request you can see.</p>
          <Link className="btn btn-secondary" to={home}>
            Back
          </Link>
        </div>
      );
    return <ErrBox error={q.error} />;
  }
  if (!d || !me) return null;

  const can = (a: AllowedAction) => d.allowed_actions.includes(a);
  const viewer = isOwner ? 'owner' : 'reviewer';
  const first = firstName(d.employee.full_name);
  const decidable = !isOwner && !!d.decidable_step;

  /* ----- header ----- */

  const chipLabel = decidable ? CHIP_WHEN_DECIDABLE[d.decidable_step!.kind] : undefined;
  const submitted =
    d.current_revision.submitted_at ??
    [...d.revisions].reverse().find((r) => r.submitted_at)?.submitted_at ??
    null;
  const subtitleBits = [
    d.number,
    submitted ? `sent ${fmtStampDay(submitted)}` : 'not sent yet',
    d.source === 'paper'
      ? `paper form${d.paper_received_date ? ` received ${fmtDate(d.paper_received_date)}` : ''}`
      : null,
    d.entered_by.id !== me.user.id ? `entered by ${d.entered_by.display_name}` : null,
  ].filter(Boolean);
  const subtitle = (
    <>
      {subtitleBits.join(' · ')}
      {d.parent ? (
        <>
          {' · '}
          {d.kind === 'amendment' ? 'changes' : 'for'}{' '}
          <Link to={`/requests/${d.parent.id}`}>{d.parent.number}</Link>
        </>
      ) : null}
    </>
  );

  const pastLeave = d.kind === 'leave' && d.date_phase === 'period_ended';
  const canChange = d.kind !== 'cancellation' && d.status !== 'draft' && !pastLeave && (can('revise') || can('amend'));
  const canCancel = !pastLeave && can('cancel');
  const changeModal = can('amend') ? 'amend' : 'respond-change';
  const primary = can('submit') ? (
    <button type="button" className="btn" onClick={() => setModal('submit')}>
      Send request
    </button>
  ) : isOwner && !can('respond') && canChange ? (
    <><button type="button" className="btn" onClick={() => setModal(changeModal)}>Change dates</button>{canCancel ? <button type="button" className="btn btn-secondary" onClick={() => setModal('cancel')}>Cancel days</button> : null}</>
  ) : isOwner && !can('respond') && canCancel ? <button type="button" className="btn" onClick={() => setModal('cancel')}>Cancel days</button> : null;

  const employeeActions = !isOwner ? approvedActions(d) : [];
  const more: { label: string; onSelect: () => void; danger?: boolean }[] = [];
  if (can('edit')) more.push({ label: 'Edit draft…', onSelect: () => setModal('edit') });
  if (canChange && can('revise') && (!isOwner || can('respond')))
    more.push({ label: isOwner ? 'Change dates…' : `Change dates for ${first}…`, onSelect: () => setModal('respond-change') });
  if (!isOwner && canChange && can('amend') && !employeeActions.some((a) => a.action === 'amend'))
    more.push({ label: isOwner ? 'Change dates…' : `Change dates for ${first}…`, onSelect: () => setModal('amend') });
  if (!isOwner && canCancel && !employeeActions.some((a) => a.action === 'cancel'))
    more.push({ label: `Cancel part of ${first}’s leave…`, onSelect: () => setModal('cancel') });
  if (!isOwner && can('respond'))
    more.push({ label: `Record ${first}’s answer…`, onSelect: () => setModal('record') });
  if (can('reassign')) more.push({ label: 'Assign step to…', onSelect: () => setModal('assign') });
  const canUpload = can('upload') && !['withdrawn', 'cancelled', 'rejected'].includes(d.status);
  if (canUpload) more.push({ label: 'Add document…', onSelect: () => setModal('upload') });
  if (can('confirm_actual'))
    more.push({ label: 'Confirm leave was taken', onSelect: () => setModal('actual-confirm') });
  if (can('propose_actual_adjustment') && !employeeActions.some((a) => a.action === 'actual-worked'))
    more.push({ label: 'Days actually worked…', onSelect: () => setModal('actual-worked') });
  if (can('print'))
    more.push({ label: 'Print', onSelect: () => navigate(`/requests/${d.id}/print`) });
  if (can('withdraw'))
    more.push({
      label: isOwner ? 'Withdraw…' : `Withdraw ${first}’s request…`,
      danger: true,
      onSelect: () => setModal('withdraw'),
    });
  if (can('delete'))
    more.push({ label: 'Delete draft…', danger: true, onSelect: () => setModal('delete') });

  /* ----- handlers ----- */

  const ctx: ModalCtx = {
    d,
    leaveTypes: leaveTypesQ.data ?? [],
    businessDate: today,
    isOwner,
    onDone: (text) => {
      setModal(null);
      toast(text);
      q.reload();
    },
    onNavigate: (to, text) => {
      setModal(null);
      if (text) toast(text);
      navigate(to);
    },
    onStale: () => {
      setModal(null);
      q.reload();
      toast('This request changed — the page was updated. Please try again.', 'info');
    },
    onClose: () => setModal(null),
  };

  async function sendMessage(body: string, asAnswer: boolean) {
    if (!d) return;
    try {
      if (asAnswer) {
        if (responseIntent.current !== body) { keys.current.reset('respond'); responseIntent.current = body; }
        await post<RD>(
          `/requests/${d.id}/respond`,
          { expected_version: d.version, body },
          keys.current.forIntent('respond'),
        );
        keys.current.reset('respond');
      } else {
        await post(`/requests/${d.id}/messages`, { body });
      }
    } catch (e) {
      if (!(e && typeof e === 'object' && 'status' in e && e.status === 0)) keys.current.reset('respond');
      throw e;
    }
    q.reload();
    toast(asAnswer ? 'Answer sent.' : 'Comment posted.');
  }

  function onDecided(outcome: Outcome) {
    if (!d) return;
    toast(decisionToast(outcome, d.employee.full_name, d.kind));
    navigate('/approvals');
  }

  const know = decidable || ['approved', 'rejected', 'withdrawn', 'cancelled'].includes(d.status) ? [] : thingsToKnow(d);
  const canAnswer = isOwner && can('respond');
  const activeChange = d.children.find(c => ['draft', 'submitted', 'under_review', 'needs_information'].includes(c.status));
  const modalAction: Record<ModalKind, AllowedAction> = { submit: 'submit', edit: 'edit', delete: 'delete', withdraw: 'withdraw', 'respond-change': 'revise', amend: 'amend', cancel: 'cancel', assign: 'reassign', 'actual-confirm': 'confirm_actual', 'actual-worked': 'propose_actual_adjustment', record: 'respond', upload: 'upload' };
  const visibleModal = modal && can(modalAction[modal]) && (modal !== 'respond-change' || canChange) && (modal !== 'upload' || canUpload) && (!(modal === 'amend' || modal === 'cancel') || !pastLeave) ? modal : null;

  return (
    <div className="rq-page">
      <PageHeader
        back={{ to: isOwner ? '/my' : '/approvals', label: isOwner ? 'My leave' : 'Approvals' }}
        title={isOwner ? ownerTitle(d) : reviewerTitle(d)}
        subtitle={subtitle}
        primary={primary}
        more={more}
      />

      <div className="btn-row no-print">
        {employeeActions.map(({ action, label }) => <button key={action} type="button" className="btn btn-secondary" onClick={() => setModal(action)}>{label}</button>)}
      </div>

      <div className="rq-status">
        <StatusBadge status={d.status} label={chipLabel ?? (isOwner && d.status === 'needs_information' ? 'Question for you' : statusLabel(d.status))} />
        <span className="rq-status-text">{statusSentence(d, viewer, today)}</span>
      </div>

      <p className="rq-duration">{d.kind === 'cancellation' ? changeSummary(d)?.headline : `${fmtDuration((d.in_force_revision ?? d.current_revision).total_minutes, d.minutes_per_day)} of leave`}</p>
      {isOwner && d.attachments.length ? <AttachmentLines d={d} owner /> : null}
      {activeChange ? <p className="rq-change-pending">A {activeChange.kind === 'cancellation' ? 'cancellation' : 'change'} is waiting for approval. <Link to={`/requests/${activeChange.id}`}>View request</Link></p> : null}
      {isOwner && pastLeave ? <p className="muted small">Past leave can be corrected by HR.</p> : null}

      {decidable ? (
        <div className="panel rq-card">
          <DecisionCard request={d} onDecided={onDecided} onRefresh={q.reload} />
        </div>
      ) : null}

      {!decidable && know.length ? (
        <ul className="warn-list">
          {know.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : null}

      <Messages
        d={d}
        canAnswer={canAnswer}
        canComment={can('comment') && !canAnswer}
        onSend={sendMessage}
        onChangeInstead={canAnswer && canChange ? () => setModal('respond-change') : undefined}
      />

      <div className="rq-details">
        <DaysDetails d={d} />
        <StepsDetails d={d} viewer={viewer} />
        <ChangesDetails d={d} />
        <DocumentsDetails d={d} owner={isOwner} />
        <EffectDetails d={d} />
        <ActualDetails d={d} />
        <HistoryDetails d={d} startOpen={searchParams.get('history') === 'open'} />
      </div>

      {visibleModal === 'submit' ? <SubmitModal ctx={ctx} /> : null}
      {visibleModal === 'edit' ? <EditDraftModal ctx={ctx} /> : null}
      {visibleModal === 'delete' ? <DeleteDraftModal ctx={ctx} /> : null}
      {visibleModal === 'withdraw' ? <WithdrawModal ctx={ctx} /> : null}
      {visibleModal === 'respond-change' ? <ChangeDatesModal ctx={ctx} mode="respond-change" /> : null}
      {visibleModal === 'amend' ? <ChangeDatesModal ctx={ctx} mode="amend" /> : null}
      {visibleModal === 'cancel' ? <CancelModal ctx={ctx} /> : null}
      {visibleModal === 'assign' ? <AssignModal ctx={ctx} /> : null}
      {visibleModal === 'actual-confirm' ? <ConfirmActualModal ctx={ctx} /> : null}
      {visibleModal === 'actual-worked' ? <WorkedModal ctx={ctx} /> : null}
      {visibleModal === 'record' ? <RecordAnswerModal ctx={ctx} /> : null}
      {visibleModal === 'upload' ? <UploadModal ctx={ctx} /> : null}
    </div>
  );
}
