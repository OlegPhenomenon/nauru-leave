import { DayParts } from '../../components/DayParts';
// Request actions open modals from visible buttons in the summary card.
// Every mutation goes through the same endpoints as before; only the
// presentation changed.

import { useRef, useState } from 'react';
import { api, ApiError, del, newIdempotencyKey, post, postForm, put, unwrapList } from '../../api/client';
import type {
  LeaveType,
  BalanceSummary,
  Part,
  RequestDetail as RD,
  UserListItem,
  OrgUnit,
  Preview,
} from '../../api/types';
import { Details, Empty, ErrBox, Field, Loading, Modal } from '../../components/ui';
import { useApi } from '../../lib/useApi';
import { correctableDays, inForceRevision, workedMinutesByAccount } from '../../lib/domain';
import { fmtDay, fmtDuration, fmtRange, partLabel } from '../../lib/format';
import { firstName } from './text';
import { isValidDate } from '../../lib/errors';
import { policyInForceOn } from '../../lib/domain';

export interface ModalCtx {
  d: RD;
  leaveTypes: LeaveType[];
  businessDate: string;
  isOwner: boolean;
  /** mutation finished → parent reloads the request and toasts */
  onDone: (toast: string, result?: RD | null) => void;
  /** mutation finished → parent navigates away */
  onNavigate: (to: string, toast?: string) => void;
  /** stale_version — parent refreshes and asks to retry */
  onStale: () => void;
  onClose: () => void;
}

/** busy/error/idempotency handling shared by every modal in this file. */
function useRun(ctx: ModalCtx, intent: unknown = null) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const key = useRef(newIdempotencyKey());
  const fingerprint = JSON.stringify([ctx.d.id, ctx.d.version, intent]);
  const lastIntent = useRef(fingerprint);
  if (lastIntent.current !== fingerprint) { lastIntent.current = fingerprint; key.current = newIdempotencyKey(); }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (ae.code === 'stale_version') {
        ctx.onStale();
      } else {
        setErr(ae);
        // A definitive error ends this intent; a corrected retry needs a new key.
        if (ae.status !== 0) key.current = newIdempotencyKey();
      }
    } finally {
      setBusy(false);
    }
  }
  return { busy, err, key: key.current, run };
}

function Footer({
  ctx,
  confirm,
  busy,
  disabled,
  danger,
  label,
  busyLabel,
  closeLabel = 'Cancel',
}: {
  ctx: ModalCtx;
  confirm: () => void;
  busy: boolean;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  label: string;
  busyLabel?: string | undefined;
  closeLabel?: string;
}) {
  return (
    <>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={ctx.onClose}>{closeLabel}</button>
      <button type="button" className={`btn${danger ? ' btn-danger' : ''}`} disabled={busy || disabled} onClick={confirm}>
        {busy ? (busyLabel ?? 'Sending…') : label}
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Date/type fields shared by edit / respond-with-changes / amend       */
/* ------------------------------------------------------------------ */

export interface DateFieldsValue {
  leave_type_id: number;
  start_date: string;
  end_date: string;
  start_part: Part;
  end_part: Part;
  note: string;
}

export function fieldsFrom(d: RD, fromInForce: boolean): DateFieldsValue {
  const r = fromInForce ? inForceRevision(d) : d.current_revision;
  return {
    leave_type_id: r.leave_type?.id ?? 0,
    start_date: r.start_date,
    end_date: r.end_date,
    start_part: r.start_part,
    end_part: r.end_part,
    note: r.note ?? '',
  };
}


function dateProblem(value: DateFieldsValue): string | null {
  if (!value.leave_type_id) return 'Choose a leave type.';
  if (!isValidDate(value.start_date)) return 'Choose a full first-day date.';
  if (!isValidDate(value.end_date)) return 'Choose a full last-day date.';
  if (value.end_date < value.start_date) return 'The last day must be on or after the first day.';
  if (value.start_date === value.end_date && value.start_part !== value.end_part) return 'Choose the same part for a single day.';
  return null;
}

export function DateFields({
  leaveTypes,
  value,
  onChange,
  showType,
  typeOnly = false,
}: {
  leaveTypes: LeaveType[];
  value: DateFieldsValue;
  onChange: (patch: Partial<DateFieldsValue>) => void;
  showType?: boolean | undefined;
  typeOnly?: boolean;
}) {
  const lt = leaveTypes.find((t) => t.id === value.leave_type_id);
  const halfDay = lt ? policyInForceOn(lt, value.start_date)?.allow_half_day ?? false : false;
  function setDate(which: 'start_date' | 'end_date', date: string) {
    const patch = { [which]: date };
    const first = which === 'start_date' ? date : value.start_date;
    const last = which === 'end_date' ? date : value.end_date;
    const allowsHalf = lt ? policyInForceOn(lt, first)?.allow_half_day : false;
    onChange(!allowsHalf ? { ...patch, start_part: 'full', end_part: 'full' } : first === last ? { ...patch, end_part: value.start_part } : { ...patch, start_part: value.start_part === 'am' ? 'full' : value.start_part, end_part: value.end_part === 'pm' ? 'full' : value.end_part });
  }
  const typeSelect = (
    <Field label="Leave type">
      <select
        value={value.leave_type_id}
        onChange={(e) => onChange({ leave_type_id: Number(e.target.value), start_part: 'full', end_part: 'full' })}
      >
        {leaveTypes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </Field>
  );
  if (typeOnly) return typeSelect;
  return (
    <>
      {showType ? typeSelect : null}
      <div className="form-grid">
        <Field label="First day">
          <input
            type="date"
            value={value.start_date}
            onChange={(e) => setDate('start_date', e.target.value)}
          />
        </Field>
        <Field label="Last day">
          <input
            type="date"
            value={value.end_date}
            min={value.start_date}
            onChange={(e) => setDate('end_date', e.target.value)}
          />
        </Field>
      </div>
      {halfDay ? <Details title="Starts or ends with a half day?" defaultOpen={value.start_part !== 'full' || value.end_part !== 'full'}>
        <DayParts single={value.start_date === value.end_date} startPart={value.start_part} endPart={value.end_part} prefix="change" onChange={(start, end) => onChange({ start_part: start, end_part: end })} />
      </Details> : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Simple confirms                                                     */
/* ------------------------------------------------------------------ */

export function SubmitModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const { busy, err, key, run } = useRun(ctx);
  const rev = d.current_revision;
  return (
    <Modal
      title="Send request"
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          label="Send request"
          confirm={() =>
            void run(async () => {
              await post<RD>(`/requests/${d.id}/submit`, { expected_version: d.version }, key);
              ctx.onDone('Request sent.');
            })
          }
        />
      }
    >
      <p>
        Send {d.leave_type_name.toLowerCase()} for {fmtRange(rev.start_date, rev.end_date)} (
        {fmtDuration(rev.total_minutes, d.minutes_per_day)}) for approval?
      </p>
      <ErrBox error={err} />
    </Modal>
  );
}

export function DeleteDraftModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const { busy, err, run } = useRun(ctx);
  return (
    <Modal
      title="Delete draft"
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          danger
          label="Delete draft"
          busyLabel="Deleting…"
          confirm={() =>
            void run(async () => {
              await del(`/requests/${d.id}`, { expected_version: d.version });
              ctx.onNavigate(ctx.isOwner ? '/my' : '/approvals', 'Draft deleted.');
            })
          }
        />
      }
    >
      <p>
        Delete this draft? This cannot be undone.
      </p>
      <ErrBox error={err} />
    </Modal>
  );
}

export function WithdrawModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const [reason, setReason] = useState('');
  const { busy, err, key, run } = useRun(ctx, reason);
  const who = ctx.isOwner ? 'your request' : `${firstName(d.employee.full_name)}'s request`;
  return (
    <Modal
      title={ctx.isOwner ? 'Withdraw request' : `Withdraw ${firstName(d.employee.full_name)}'s request`}
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          danger
          label="Withdraw request"
          busyLabel="Withdrawing…"
          confirm={() =>
            void run(async () => {
              await post<RD>(
                `/requests/${d.id}/withdraw`,
                { expected_version: d.version, reason: reason || undefined },
                key,
              );
              ctx.onDone('Request withdrawn.');
            })
          }
        />
      }
    >
      <p>Withdraw {who}? {ctx.isOwner ? 'Your' : 'The'} {fmtDuration(d.reservations.reduce((sum, r) => sum + r.minutes, 0), d.minutes_per_day)} goes back to {ctx.isOwner ? 'your' : 'the'} balance straight away.</p>
      <Details title="Add a reason"><Field label="Reason (optional)"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></Details>
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Edit draft                                                          */
/* ------------------------------------------------------------------ */

export function EditDraftModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const [fields, setFields] = useState(() => fieldsFrom(d, false));
  const { busy, err, run } = useRun(ctx, fields);
  const patch = (p: Partial<DateFieldsValue>) => setFields((f) => ({ ...f, ...p }));
  return (
    <Modal
      title="Edit draft"
      onClose={ctx.onClose}
      wide
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          disabled={!!dateProblem(fields)}
          label="Save draft"
          busyLabel="Saving…"
          confirm={() =>
            void run(async () => {
              await put<RD>(`/requests/${d.id}`, {
                leave_type_id: fields.leave_type_id,
                start_date: fields.start_date,
                end_date: fields.end_date,
                start_part: fields.start_part,
                end_part: fields.end_part,
                note: fields.note,
                expected_version: d.version,
              });
              ctx.onDone('Draft saved.');
            })
          }
        />
      }
    >
      <DateFields leaveTypes={ctx.leaveTypes} value={fields} onChange={patch} showType />
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Change dates — either a respond-with-changes (before approval) or    */
/* a new amendment request (approved leave).                            */
/* ------------------------------------------------------------------ */

export function ChangeDatesModal({
  ctx,
  mode,
}: {
  ctx: ModalCtx;
  mode: 'respond-change' | 'amend';
}) {
  const { d } = ctx;
  const [fields, setFields] = useState(() => fieldsFrom(d, mode === 'amend'));
  const [why, setWhy] = useState('');
  const { busy, err, key, run } = useRun(ctx, [fields, why]);
  const patch = (p: Partial<DateFieldsValue>) => setFields((f) => ({ ...f, ...p }));
  const amend = mode === 'amend';
  const who = ctx.isOwner ? 'your' : `${firstName(d.employee.full_name)}'s`;
  const balances = useApi(() => api<BalanceSummary[]>(ctx.isOwner ? '/balances/me' : `/balances/${d.employee.id}`), [d.employee.id]);
  const selectedBalance = balances.data?.find(b => b.leave_type.id === fields.leave_type_id);
  const original = inForceRevision(d);
  const credit = original.leave_type?.id === fields.leave_type_id ? original.total_minutes : 0;
  const leftAfter = selectedBalance ? selectedBalance.available_minutes + credit : undefined;
  const preview = useApi(() => !amend || dateProblem(fields) ? Promise.resolve(null) : post<Preview>('/requests/preview', { employee_id: d.employee.id, ...fields, amend_of: d.id }), [amend, fields.leave_type_id, fields.start_date, fields.end_date, fields.start_part, fields.end_part]);
  return (
    <Modal
      title={ctx.isOwner ? 'Change dates' : `Change dates for ${firstName(d.employee.full_name)}`}
      onClose={ctx.onClose}
      wide
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          disabled={!why.trim() || !!dateProblem(fields) || (amend && (preview.loading || !!preview.error || !!preview.data?.errors.length))}
          label={amend ? 'Send change for approval' : 'Send change'}
          confirm={() =>
            void run(async () => {
              if (amend) {
                const r = await post<RD>(
                  `/requests/${d.id}/amend`,
                  {
                    expected_version: d.version,
                    leave_type_id: fields.leave_type_id,
                    start_date: fields.start_date,
                    end_date: fields.end_date,
                    start_part: fields.start_part,
                    end_part: fields.end_part,
                    change_reason: why.trim(),
                  },
                  key,
                );
                ctx.onNavigate(`/requests/${r.id}`, 'Change sent for approval.');
              } else {
                await post<RD>(
                  `/requests/${d.id}/respond`,
                  {
                    expected_version: d.version,
                    body: why.trim() || '(dates changed)',
                    changes: {
                      leave_type_id: fields.leave_type_id,
                      start_date: fields.start_date,
                      end_date: fields.end_date,
                      start_part: fields.start_part,
                      end_part: fields.end_part,
                      note: fields.note,
                      change_reason: why.trim(),
                    },
                  },
                  key,
                );
                ctx.onDone('Change sent for approval.');
              }
            })
          }
        />
      }
    >
      {amend ? (
        <p className="muted small">
          This creates a change request — {who} approved dates stay in force until the change is
          decided.
        </p>
      ) : (
        <p className="muted small">This sends {who} request back through approval.</p>
      )}
      <DateFields leaveTypes={ctx.leaveTypes} value={fields} onChange={patch} />
      {preview.data ? <p className="small" role="status">Was {fmtDuration(inForceRevision(d).total_minutes, d.minutes_per_day)} → now {fmtDuration(preview.data.total_minutes, preview.data.minutes_per_day)}{selectedBalance?.leave_type.uses_balance && leftAfter !== undefined ? ` · ${fmtDuration(leftAfter - preview.data.total_minutes, preview.data.minutes_per_day)} left after` : ''}.</p> : null}
      <Details title="Change leave type"><DateFields leaveTypes={ctx.leaveTypes} value={fields} onChange={patch} typeOnly /></Details>
      <ErrBox error={preview.error} />
      {preview.data?.errors.map((error, i) => <ErrBox key={i} error={new ApiError(422, error.code, error.message)} />)}
      <Field label="Why? (required)">
        <textarea rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Cancel days — a checklist of the remaining working days              */
/* ------------------------------------------------------------------ */

export function CancelModal({ ctx }: { ctx: ModalCtx }) {
  const { d, businessDate } = ctx;
  const rev = inForceRevision(d);
  const workDays = rev.days.filter((day) => day.minutes > 0 && day.part !== 'none');
  const future = workDays.filter((day) => day.date >= businessDate);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [why, setWhy] = useState('');
  const { busy, err, key, run } = useRun(ctx, [[...sel].sort(), why]);

  const toggle = (date: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(date)) n.delete(date);
      else n.add(date);
      return n;
    });

  // The cancellation endpoint accepts one continuous date range.
  function blocks(): { from: string; to: string }[] {
    const picked = workDays.map((w) => w.date).filter((x) => sel.has(x));
    const out: { from: string; to: string }[] = [];
    let from: string | null = null;
    let prev: string | null = null;
    for (const date of picked) {
      if (from !== null && prev !== null) {
        const skippedWorkday = workDays.some(
          (w) => w.date > prev! && w.date < date && !sel.has(w.date),
        );
        if (skippedWorkday) {
          out.push({ from, to: prev });
          from = date;
        }
      } else {
        from = date;
      }
      prev = date;
    }
    if (from !== null && prev !== null) out.push({ from, to: prev });
    return out;
  }

  const selMinutes = workDays.filter((w) => sel.has(w.date)).reduce((a, w) => a + w.minutes, 0);
  const runs = blocks();
  const who = ctx.isOwner ? 'your leave' : `${firstName(d.employee.full_name)}'s leave`;

  return (
    <Modal
      title={ctx.isOwner ? 'Cancel days' : `Cancel part of ${firstName(d.employee.full_name)}'s leave`}
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          disabled={!sel.size || !why.trim() || runs.length !== 1}
          label='Send cancellation'
          closeLabel="Keep my days"
          confirm={() =>
            void run(async () => {
              const range = runs[0];
              if (!range || runs.length !== 1) return;
              const r = await post<RD>(`/requests/${d.id}/cancel`, {
                expected_version: d.version,
                from_date: range.from,
                to_date: range.to,
                change_reason: why.trim(),
              }, key);
              ctx.onNavigate(`/requests/${r.id}`, 'Cancellation sent for approval.');
            })
          }
        />
      }
    >
      <p className="muted small">Tick the days to cancel on {who}. Days already taken can't be
        cancelled here — HR can correct them instead.</p>
      <div className="field"><div className="rq-check-label"><span className="field-label">Days to cancel</span><button type="button" className="link-button" onClick={() => setSel(new Set(future.map(x => x.date)))}>Select all</button></div>
        <div className="rq-checklist" role="group" aria-label="Days to cancel">
          {future.map((day) => (
            <label key={day.date} className="rq-check">
              <input
                type="checkbox"
                checked={sel.has(day.date)}
                onChange={() => toggle(day.date)}
              />{' '}
              {fmtDay(day.date)}
              {day.part !== 'full' ? ` (${partLabel(day.part)})` : ''}
            </label>
          ))}

        </div>
      </div>
      {sel.size ? (
        <p className="small">
          Cancelling {fmtDuration(selMinutes, d.minutes_per_day)} · you get this leave back once approved.
        </p>
      ) : null}
      {runs.length > 1 ? <p className="field-hint" role="status">Choose consecutive working days. Submit another cancellation after this one is decided.</p> : null}
      {!future.length ? <Empty>No future working days remain. Ask HR to correct past leave.</Empty> : null}
      <Field label="Why? (required)">
        <textarea rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Assign a step to someone                                             */
/* ------------------------------------------------------------------ */

export function AssignModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const usersQ = useApi(() => api<unknown>('/users').then((r) => unwrapList<UserListItem>(r)), []);
  const unitsQ = useApi(() => api<unknown>('/org-units').then(r => unwrapList<OrgUnit>(r)), []);
  const pending = d.steps.filter((s) => s.status === 'pending' || s.status === 'waiting');
  const [stepId, setStepId] = useState(pending[0]?.id ?? 0);
  const [assigneeId, setAssigneeId] = useState(0);
  const { busy, err, key, run } = useRun(ctx, [stepId, assigneeId]);
  const step = pending.find((s) => s.id === stepId) ?? pending[0];
  const users = (usersQ.data ?? []).filter((u) => u.active && u.employee?.id !== d.employee.id);

  const scope = new Set<number>();
  let unit = d.employee.org_unit?.id ?? null;
  while (unit !== null && !scope.has(unit)) {
    scope.add(unit);
    unit = unitsQ.data?.find(u => u.id === unit)?.parent_id ?? null;
  }
  const suggested = users.filter(u => step?.kind === 'manager_recommendation' || u.roles.some(r =>
    r.role === (step?.kind === 'hr_check' ? 'hr' : 'final_approver') &&
    (r.scope_org_unit_id === null || scope.has(r.scope_org_unit_id)),
  ));

  return (
    <Modal
      title="Assign step to…"
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          disabled={!stepId || !assigneeId || !suggested.some(u => u.id === assigneeId)}
          label="Assign"
          confirm={() =>
            void run(async () => {
              await post<RD>(
                `/requests/${d.id}/reassign`,
                { expected_version: d.version, step_id: stepId, assignee_user_id: assigneeId },
                key,
              );
              ctx.onDone('Step assigned.');
            })
          }
        />
      }
    >
      {pending.length > 1 ? (
        <Field label="Step">
          <select value={stepId} onChange={(e) => setStepId(Number(e.target.value))}>
            {pending.map((s) => (
              <option key={s.id} value={s.id}>
                {s.kind === 'manager_recommendation'
                  ? "Manager's recommendation"
                  : s.kind === 'hr_check'
                    ? 'HR check'
                    : 'Final decision'}
              </option>
            ))}
          </select>
        </Field>
      ) : step ? (
        <p className="muted small">
          Step:{' '}
          {step.kind === 'manager_recommendation'
            ? "Manager's recommendation"
            : step.kind === 'hr_check'
              ? 'HR check'
              : 'Final decision'}
          .
        </p>
      ) : (
        <Empty>No step is waiting for an assignee.</Empty>
      )}
      {usersQ.loading || unitsQ.loading ? (
        <Loading label="Loading people…" />
      ) : suggested.length ? (
        <Field label="Assign to">
          <select value={assigneeId} onChange={(e) => setAssigneeId(Number(e.target.value))}>
            <option value={0}>— choose a person —</option>
            {suggested.length ? (
              <optgroup label={step?.kind === 'final_decision' ? 'Final approvers' : step?.kind === 'hr_check' ? 'HR officers' : 'People'}>
                {suggested.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name}
                  </option>
                ))}
              </optgroup>
            ) : null}

          </select>
        </Field>
      ) : (
        <p className="muted">
          No eligible people are available. Ask HR to check access for this step.
        </p>
      )}
      <ErrBox error={usersQ.error} />
      <ErrBox error={unitsQ.error} />
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Leave actually taken — confirm / propose a correction                */
/* ------------------------------------------------------------------ */

export function ConfirmActualModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const [note, setNote] = useState('');
  const { busy, err, key, run } = useRun(ctx, note);
  const rev = inForceRevision(d);
  return (
    <Modal
      title="Confirm leave was taken"
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          label="Confirm"
          confirm={() =>
            void run(async () => {
              await post<RD>(
                `/requests/${d.id}/actual`,
                {
                  expected_version: d.version,
                  action: 'confirm',
                  note,
                },
                key,
              );
              ctx.onDone('Leave confirmed.');
            })
          }
        />
      }
    >
      <p>
        Confirm that {d.employee.full_name} took this leave (
        {fmtRange(rev.start_date, rev.end_date)})?
      </p>
      <Field label="Note (optional)">
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrBox error={err} />
    </Modal>
  );
}

export function WorkedModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const rev = inForceRevision(d);
  const [worked, setWorked] = useState<string[]>([]);
  const [why, setWhy] = useState('');
  const [reference, setReference] = useState('');
  const { busy, err, key, run } = useRun(ctx, [worked, why, reference]);
  const correctable = correctableDays(rev.days, d.actual_corrections);
  const giveBack = worked.length
    ? workedMinutesByAccount(correctable, worked)
        .map((a) => `${fmtDuration(a.minutes, d.minutes_per_day)} to ${a.period_year}`)
        .join(' and ')
    : '';

  const toggle = (date: string) =>
    setWorked((w) => (w.includes(date) ? w.filter((x) => x !== date) : [...w, date]));

  return (
    <Modal
      title="Days actually worked"
      onClose={ctx.onClose}
      wide
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          disabled={!worked.length || !why.trim() || !reference.trim()}
          label="Send for second approval"
          confirm={() =>
            void run(async () => {
              await post<RD & { adjustment_ids?: number[] }>(
                `/requests/${d.id}/actual`,
                {
                  expected_version: d.version,
                  action: 'propose_adjustment',
                  note: why.trim(),
                  worked_dates: worked,
                  basis_document: reference.trim(),
                },
                key,
              );
              ctx.onDone('Sent for a second approver.');
            })
          }
        />
      }
    >
      <p className="muted small">
        Tick the days {firstName(d.employee.full_name)} actually worked. The leave for those days is
        given back — a second approver must confirm the correction.
      </p>
      <div className="field"><span className="field-label">Days worked</span>
        <div className="rq-checklist" role="group" aria-label="Days worked">
          {rev.days
            .filter((day) => day.minutes > 0)
            .map((day) => {
              const corrections = d.actual_corrections.filter((c) => c.date === day.date);
              const pendingC = corrections.some((c) => c.pending_minutes > 0);
              const fully = !correctableDays([day], corrections)[0]?.allocations.some(a => a.minutes > 0);
              return (
                <label key={day.date} className={`rq-check${pendingC || fully ? ' muted' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={pendingC || fully}
                    checked={worked.includes(day.date)}
                    onChange={() => toggle(day.date)}
                  />{' '}
                  {fmtDay(day.date)}
                  {pendingC
                    ? ' — correction waiting for approval'
                    : fully
                      ? ' — already corrected'
                      : ''}
                </label>
              );
            })}
        </div>
      </div>
      {giveBack ? <p className="small">This gives {giveBack} back.</p> : null}
      <Field label="Why? (required)">
        <textarea rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <Field label="Supporting reference (required)" hint="For example, a timesheet or attendance record.">
        <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Record the employee's spoken answer (HR)                             */
/* ------------------------------------------------------------------ */

export function RecordAnswerModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const [body, setBody] = useState('');
  const { busy, err, key, run } = useRun(ctx, body);
  return (
    <Modal
      title={`Record ${firstName(d.employee.full_name)}'s answer`}
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          disabled={!body.trim()}
          label="Record answer"
          confirm={() =>
            void run(async () => {
              await post<RD>(
                `/requests/${d.id}/respond`,
                { expected_version: d.version, body: body.trim() },
                key,
              );
              ctx.onDone('Answer recorded.');
            })
          }
        />
      }
    >
      <p className="muted small">
        Use this when {firstName(d.employee.full_name)} answers by phone or in person.
      </p>
      <Field label="The answer">
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Add a document                                                       */
/* ------------------------------------------------------------------ */

export function UploadModal({ ctx }: { ctx: ModalCtx }) {
  const { d } = ctx;
  const [file, setFile] = useState<File | null>(null);
  const sensitive = d.current_revision.leave_type?.sensitive ?? false;
  const [medical, setMedical] = useState(sensitive);
  const { busy, err, key, run } = useRun(ctx, [file?.name, file?.size, file?.lastModified, medical]);
  return (
    <Modal
      title="Add document"
      onClose={ctx.onClose}
      footer={
        <Footer
          ctx={ctx}
          busy={busy}
          disabled={!file}
          label="Add document"
          busyLabel="Uploading…"
          confirm={() =>
            void run(async () => {
              const fd = new FormData();
              fd.set('file', file!);
              fd.set('sensitivity', medical ? 'medical' : 'normal');
              await postForm(`/requests/${d.id}/attachments`, fd, key);
              ctx.onDone('Document added.');
            })
          }
        />
      }
    >
      <Field label="File" hint="PDF, PNG or JPEG — up to 2 MB (1 MB in demo).">
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <label className="rq-check">
        <input
          type="checkbox"
          checked={medical}
          onChange={(e) => setMedical(e.target.checked)}
        />{' '}
        Private medical document — visible to the employee and authorised HR
      </label>
      <ErrBox error={err} />
    </Modal>
  );
}

/** The ordinary upload commits immediately after selecting a file. */
export function AddDocumentButton({ ctx }: { ctx: ModalCtx }) {
  const input = useRef<HTMLInputElement>(null);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  async function upload(file: File) {
    if (busy) return;
    setBusy(true); setErr(null);
    const sensitivity = ctx.d.current_revision.leave_type?.sensitive ? 'medical' : 'normal';
    const fingerprint = JSON.stringify([ctx.d.id, file.name, file.size, file.lastModified, sensitivity]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: newIdempotencyKey() };
    try {
      const fd = new FormData(); fd.set('file', file); fd.set('sensitivity', sensitivity);
      await postForm(`/requests/${ctx.d.id}/attachments`, fd, intent.current.key);
      intent.current = null;
      ctx.onDone('Document added.');
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (error.status !== 0) intent.current = null;
      setErr(error);
    } finally { setBusy(false); }
  }
  return <span>
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Add document'}</button>
    <input ref={input} type="file" hidden accept=".pdf,.png,.jpg,.jpeg" aria-label="Document to upload" onChange={(e) => {
      const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file);
    }} />
    <ErrBox error={err} />
  </span>;
}
