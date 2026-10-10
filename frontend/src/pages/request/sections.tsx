import { AuditDetails } from '../../components/AuditDetails';
// Request page detail sections — everything behind collapsed disclosures
// so the top of the page stays calm. No internal codes, minutes, revision
// numbers or server prose on screen.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import type {
  AuditEvent,
  Decision,
  Part,
  RequestDetail as RD,
  Step,
} from '../../api/types';
import { AttachmentLines } from '../../components/DecisionCard';
import { Details, Empty, ErrBox, Field, ReqLink, stepStatusLabel } from '../../components/ui';
import {
  auditSentence,
  fmtDateFull,
  fmtDateTime,
  fmtDuration,
  fmtRange,
  kindLabel,
  partLabel,
  statusLabel,
  stepLabel,
} from '../../lib/format';
import {
  auditHasDetails,
  changeSummary,
  decisionForStep,
  earlierStepLine,
  effectSentence,
  fmtStampDay,
  stepAssigneeWords,
  type Viewer,
} from './text';

/* ------------------------------------------------------------------ */
/* A disclosure that can start open (History with ?history=open)        */
/* ------------------------------------------------------------------ */

export function MaybeOpenDetails({
  open,
  title,
  count,
  children,
}: {
  open?: boolean | undefined;
  title: ReactNode;
  count?: number | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (open) ref.current?.setAttribute('open', '');
    // mount only — ?history=open is read once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <details ref={ref} className="disclosure">
      <summary>
        {title}
        {typeof count === 'number' ? <span className="count"> ({count})</span> : null}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Days                                                                */
/* ------------------------------------------------------------------ */

function partWords(part: Part | 'none', cancelled: boolean): string {
  if (part === 'none') return cancelled ? 'Cancelled' : 'Day off';
  return partLabel(part);
}

export function DaysDetails({ d }: { d: RD }) {
  // For a change/cancellation the proposal is the interesting table;
  // for a normal leave it is what is in force.
  const rev = d.kind === 'leave' ? (d.in_force_revision ?? d.current_revision) : d.current_revision;
  const shownDays = d.kind === 'cancellation' ? rev.days.filter(day => day.explanation === `Cancelled by ${d.number}`) : rev.days;
  const working = rev.days.filter((x) => x.minutes > 0).length;
  return (
    <Details title="Days" count={shownDays.length}>
      {rev.days.length === 0 ? (
        <Empty>No days — the leave was fully cancelled.</Empty>
      ) : (
        <>
          <p className="muted small">
            {d.kind === 'cancellation' ? changeSummary(d)?.headline : <>{working} working {working === 1 ? 'day' : 'days'} counted,{' '}{fmtDuration(rev.total_minutes, d.minutes_per_day)} in total.</>}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Day part</th>
                  <th className="num">Counted</th>
                  <th>Year</th>
                </tr>
              </thead>
              <tbody>
                {shownDays.map((day) => (
                  <tr key={day.date} className={day.minutes === 0 ? 'muted' : undefined}>
                    <td>{fmtDateFull(day.date)}</td>
                    <td>{partWords(day.part, day.explanation.startsWith('Cancelled by '))}{d.kind === 'amendment' && day.minutes > 0 && !d.parent_in_force_revision?.days.some(w => w.date === day.date && w.minutes > 0) ? ' · Added' : ''}</td>
                    <td className="num">
                      {day.minutes > 0 ? fmtDuration(day.minutes, d.minutes_per_day) : '—'}
                    </td>
                    <td className="small">{day.allocations.length ? [...new Set(day.allocations.map(a => `${a.period_year}${a.carryover ? ' (carried over)' : ''}`))].join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rev.change_reason ? <p className="muted small">Why it changed: “{rev.change_reason}”</p> : null}
        </>
      )}
    </Details>
  );
}

/* ------------------------------------------------------------------ */
/* Approval steps (steps merged with their decisions)                   */
/* ------------------------------------------------------------------ */

const WAIT_VERB: Record<Step['kind'], string> = {
  manager_recommendation: 'to recommend',
  hr_check: 'to check',
  final_decision: 'to approve',
};

function stepLine(s: Step, dec: Decision | null, d: RD, viewer: Viewer): string {
  if (s.status === 'done') {
    if (dec) return `${earlierStepLine(dec)} · ${fmtStampDay(dec.created_at)}`;
    return 'Done';
  }
  if (s.status === 'pending') {
    if (s.problem) return 'Nobody is assigned yet — HR needs to assign someone';
    if (d.decidable_step?.id === s.id) return `Waiting for you ${WAIT_VERB[s.kind]} — use the card above`;
    return `Waiting for ${stepAssigneeWords(s, viewer)} ${WAIT_VERB[s.kind]}`;
  }
  if (s.status === 'waiting') return 'Not started yet';
  if (s.status === 'superseded') return 'Replaced by a newer version';
  return 'Ended';
}

export function StepsDetails({ d, viewer }: { d: RD; viewer: Viewer }) {
  const steps = [...d.steps].sort((a, b) => a.seq - b.seq);
  return (
    <Details title="Approval steps" count={steps.length}>
      {steps.length === 0 ? (
        <Empty>No steps yet — they appear once the request is sent.</Empty>
      ) : (
        <ol className="timeline">
          {steps.map((s) => {
            const dec = decisionForStep(d, s);
            return (
              <li key={s.id}>
                <span
                  className={`tl-dot tl-${s.status}`}
                  aria-hidden="true"
                  title={stepStatusLabel(s.status)}
                >
                  {s.status === 'done' ? '●' : s.status === 'pending' ? '◐' : '○'}
                </span>
                <span className="tl-body">
                  <strong>{stepLabel(s.kind)}</strong>
                  <br />
                  <span className="small">{stepLine(s, dec, d, viewer)}{dec?.basis_document ? ` · Reference: ${dec.basis_document}` : ''}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {d.decisions.filter(x => !d.steps.some(s => s.id === x.step_id)).map(x => <p key={x.id} className="small">{earlierStepLine(x)} · {fmtStampDay(x.created_at)}{x.basis_document ? ` · Reference: ${x.basis_document}` : ''}</p>)}
    </Details>
  );
}

/* ------------------------------------------------------------------ */
/* Changes — parent/child links, revision history, amendment diff       */
/* ------------------------------------------------------------------ */

export function ChangesDetails({ d }: { d: RD }) {
  const change = changeSummary(d);
  const hasVersions = d.revisions.length > 1 || (!!d.in_force_revision && d.in_force_revision.id !== d.current_revision.id);
  const hasLinks = !!d.parent || !!d.previous_request || d.children.length > 0;
  if (!change && !hasVersions && !hasLinks) return null;

  const ordered = [...d.revisions].sort(
    (a, b) => (a.submitted_at ?? a.created_at).localeCompare(b.submitted_at ?? b.created_at),
  );

  return (
    <Details title="Changes" count={Math.max(1, d.children.length + d.revisions.filter(r => r.id !== d.current_revision.id).length + (d.parent ? 1 : 0) + (d.previous_request ? 1 : 0))}>
      {change ? (
        <p>
          {change.headline}
          {change.detail ? ` ${change.detail}` : ''}
        </p>
      ) : null}
      {d.parent ? (
        <p className="small">
          This {d.kind === 'amendment' ? 'changes' : 'cancels days from'}{' '}
          <ReqLink id={d.parent.id} number={d.parent.number} />.
        </p>
      ) : null}
      {d.previous_request ? (
        <p className="small">
          Follow-up to <ReqLink id={d.previous_request.id} number={d.previous_request.number} />.
        </p>
      ) : null}
      {d.children.length ? (
        <p className="small">
          Later requests:{' '}
          {d.children.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? ' · ' : ''}
              <ReqLink id={c.id} number={c.number} /> ({kindLabel(c.kind)}, {statusLabel(c.status)})
            </span>
          ))}
        </p>
      ) : null}
      {hasVersions ? (
        <table className="small"><thead><tr><th>Dates</th><th>Length</th><th>Status</th><th>Reason</th></tr></thead><tbody>
          {ordered.map(r => <tr key={r.id}><td>{fmtRange(r.start_date, r.end_date)}</td><td>{fmtDuration(r.total_minutes, d.minutes_per_day)}</td><td>{r.id === (d.in_force_revision ?? d.current_revision).id ? 'In force' : 'Superseded'}</td><td>{r.change_reason ?? '—'}</td></tr>)}
        </tbody></table>
      ) : null}
    </Details>
  );
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export function DocumentsDetails({ d, owner = false }: { d: RD; owner?: boolean }) {
  if (!d.attachments.length && !d.supporting_document_required) return null;
  return (
    <Details title="Documents" count={d.attachments.length || undefined}>
      {d.supporting_document_required && !d.supporting_document_ready ? (
        <p className="warn-line">A readable supporting document is needed before approval.</p>
      ) : null}
      {d.attachments.length ? (
        <AttachmentLines d={d} owner={owner} />
      ) : (
        <Empty>No documents yet.</Empty>
      )}
    </Details>
  );
}

/* ------------------------------------------------------------------ */
/* Effect on balance — one sentence                                     */
/* ------------------------------------------------------------------ */

export function EffectDetails({ d }: { d: RD }) {
  const sentence = effectSentence(d);
  if (!sentence) return null;
  return (
    <Details title="Effect on balance">
      <p>{sentence}</p>
    </Details>
  );
}

/* ------------------------------------------------------------------ */
/* Leave actually taken                                                */
/* ------------------------------------------------------------------ */

export function ActualDetails({ d }: { d: RD }) {
  if (!d.actual) return null;
  return (
    <Details title="Leave actually taken">
      <p>
        Confirmed by {d.actual.confirmed_by.display_name} on{' '}
        {fmtStampDay(d.actual.confirmed_at)}
        {d.actual.note ? ` — “${d.actual.note}”` : ''}
      </p>
    </Details>
  );
}

/* ------------------------------------------------------------------ */
/* History — audit events as sentences; raw JSON under technical        */
/* ------------------------------------------------------------------ */

function EventLine({ e }: { e: AuditEvent }) {
  return (
    <li>
      <span>{auditSentence(e)}</span><Details title="Details"><AuditDetails details={e.details} /></Details>{' '}
      <span className="muted small">{fmtStampDay(e.at)}</span>
    </li>
  );
}

export function HistoryDetails({ d, startOpen }: { d: RD; startOpen?: boolean | undefined }) {
  const hasDetails = d.audit.some(auditHasDetails);
  return (
    <MaybeOpenDetails open={startOpen} title="History" count={d.audit.length}>
      {d.audit.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ul className="rq-history">
          {d.audit.map((e) => (
            <EventLine key={e.id} e={e} />
          ))}
        </ul>
      )}
      {hasDetails ? (
        <Details title="Technical details" className="rq-tech">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {d.audit.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{fmtDateTime(e.at)}</td>
                    <td className="small">{e.action}</td>
                    <td className="small muted">
                      {e.details ? (
                        <code className="mono">{JSON.stringify(e.details)}</code>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Details>
      ) : null}
    </MaybeOpenDetails>
  );
}

/* ------------------------------------------------------------------ */
/* Messages — question/answer thread + inline reply                     */
/* ------------------------------------------------------------------ */

const MSG_KIND: Record<string, string> = {
  question: 'Question',
  answer: 'Answer',
  comment: 'Comment',
  system: 'System',
};

export function Messages({
  d,
  canAnswer,
  canComment,
  onSend,
  onChangeInstead,
}: {
  d: RD;
  /** true when the open question can be answered by this viewer. */
  canAnswer: boolean;
  canComment: boolean;
  onSend: (body: string, asAnswer: boolean) => Promise<void>;
  /** "Change dates instead" link under the answer box. */
  onChangeInstead?: (() => void) | undefined;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const replyable = canAnswer || canComment;
  if (!d.messages.length && !replyable) return null;

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      await onSend(text.trim(), canAnswer);
      setText('');
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  const messageLine = (m: RD['messages'][number]) => <div key={m.id} className={`msg msg-${m.kind}`}>
    <div className="small muted">{m.author?.display_name ?? 'System'} · {MSG_KIND[m.kind] ?? 'Message'} · {fmtStampDay(m.created_at)}</div>
    <div>{m.body}</div>
  </div>;
  const updates = d.messages.filter(m => m.kind === 'system');
  const thread = <>{d.messages.filter(m => m.kind !== 'system').map(messageLine)}{updates.length ? <Details title="System updates" count={updates.length}>{updates.map(messageLine)}</Details> : null}</>;
  const question = [...d.messages].reverse().find(m => m.kind === 'question');
  const reply = replyable ? <div className="rq-reply no-print">
    <Field label={canAnswer ? 'Your answer' : 'Add a comment'}>
      <textarea rows={canAnswer ? 3 : 1} value={text} onFocus={e => { if (!canAnswer) e.currentTarget.rows = 3; }} onChange={e => setText(e.target.value)} disabled={busy} />
    </Field>
    <ErrBox error={err} />
    <div className="btn-row">
      <button type="button" className={canAnswer ? 'btn' : 'btn btn-secondary'} disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? 'Sending…' : canAnswer ? 'Send answer' : 'Post comment'}</button>
      {canAnswer && onChangeInstead ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={onChangeInstead}>Change dates instead…</button> : null}
    </div>
  </div> : null;
  return <section className={`rq-messages${canAnswer ? ' rq-messages-answer' : ''}`}>
    {canAnswer ? <><h2 className="rq-h2">Answer question</h2>{question ? <p className="rq-question"><strong>{question.author?.display_name ?? 'Reviewer'} asked:</strong> “{question.body}”</p> : null}{reply}</> : null}
    {d.messages.length ? <Details title="Messages" count={d.messages.length}>
      {thread}
      {!canAnswer ? reply : null}
    </Details> : !canAnswer ? reply : null}
  </section>;
}
