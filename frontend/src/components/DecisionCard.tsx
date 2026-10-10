// The decision card — one component shared by the expanded Approvals row
// and the top of the request page (reviewer view). Shows who/what/when,
// what changes, earlier steps, things to know, documents, and the
// actions for the pending step. Secondary choices reveal an inline
// textarea — never a modal.

import { useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey, post } from '../api/client';
import type { Outcome, RequestDetail as RD } from '../api/types';
import { fmtBytes } from '../lib/format';
import {
  changeSummary,
  earlierStepLine,
  firstName,
  fmtDuration,
  fmtRange,
  thingsToKnow,
  verbsFor,
  type StepVerbs,
} from '../pages/request/text';
import { Details, ErrBox, Field, Tag, useToast } from './ui';
import './DecisionCard.css';

/** POST a decision for a request's pending step. Shared by card + queue rows. */
export function postDecision(
  requestId: number,
  version: number,
  stepId: number,
  outcome: Outcome,
  reason?: string,
  basisDocument?: string,
  idempotencyKey?: string,
) {
  return post<RD>(
    `/requests/${requestId}/decide`,
    {
      expected_version: version,
      step_id: stepId,
      outcome,
      reason: reason || undefined,
      basis_document: basisDocument || undefined,
    },
    idempotencyKey,
  );
}

function fileType(contentType: string): string {
  if (contentType === 'application/pdf') return 'PDF';
  if (contentType === 'image/png') return 'PNG';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return 'JPEG';
  return 'file';
}

/** Human-readable attachment list; shared by the card and the Documents section. */
export function AttachmentLines({ d, owner = false }: { d: RD; owner?: boolean }) {
  if (!d.attachments.length) return null;
  return (
    <ul className="dc-docs">
      {d.attachments.map((a) =>
        'restricted' in a ? (
          <li key={a.id} className="muted">
            A document only HR can open
          </li>
        ) : (
          <li key={a.id}>
            {a.can_download && a.scan_status === 'clean' ? (
              <a href={`/api/attachments/${a.id}`} download>
                {a.filename}
              </a>
            ) : (
              <span>{a.filename}</span>
            )}{' '}
            <span className="muted small">
              ({fileType(a.content_type)}{owner ? '' : `, ${fmtBytes(a.size_bytes)}`})
            </span>{' '}
            {a.sensitivity === 'medical' ? <Tag>Medical</Tag> : null}
            {a.scan_status === 'pending' ? (
              <span className="muted small"> — being checked for viruses, not downloadable yet</span>
            ) : a.scan_status === 'quarantined' || a.scan_status === 'scan_failed' ? (
              <span className="muted small"> — blocked by the virus check</span>
            ) : null}
          </li>
        ),
      )}
    </ul>
  );
}

export function DecisionCard({
  request: d,
  onDecided,
  onRefresh,
  initialPanel,
  openLink,
}: {
  request: RD;
  /** Called after a decision is recorded (parent toasts / navigates). */
  onDecided?: ((outcome: Outcome) => void) | undefined;
  onRefresh?: (() => void) | undefined;
  /** Open a secondary panel right away (queue "Refuse…" / "Ask a question…"). */
  initialPanel?: 'refuse' | 'question' | null | undefined;
  /** Show "Open full request" — used on the approvals queue. */
  openLink?: boolean | undefined;
}) {
  const toast = useToast();
  const step = d.decidable_step;
  const verbs: StepVerbs | null = step ? verbsFor(step.kind, step.outcomes) : null;
  const [panel, setPanel] = useState<'refuse' | 'question' | null>(initialPanel ?? null);
  const [text, setText] = useState('');
  const [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => { setPanel(initialPanel ?? null); }, [initialPanel]);

  const rev = d.current_revision;
  const change = changeSummary(d);
  const completed = new Set(d.steps.filter(s => s.status === 'done' && s.revision_no === rev.rev_no).map(s => s.id));
  const earlier = d.decisions.filter(x => completed.has(x.step_id) && x.outcome !== 'needs_information');
  const know = thingsToKnow(openLink ? { ...d, warnings: d.warnings.filter(w => w.code !== 'team_overlap' && w.code !== 'late_notice') } : d);
  const latestQ = [...d.messages].reverse().find((m) => m.kind === 'question');
  const approveBlocked =
    step?.kind === 'final_decision' &&
    d.supporting_document_required &&
    !d.supporting_document_ready;

  async function decide(outcome: Outcome, reason?: string) {
    if (!step || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fingerprint = JSON.stringify([d.id, d.version, step.id, outcome, reason, basis.trim()]);
      if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: newIdempotencyKey() };
      await postDecision(d.id, d.version, step.id, outcome, reason, basis.trim(), intent.current.key);
      onDecided?.(outcome);
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      setErr(error);
      if (error.status !== 0) intent.current = null;
      if (error.code === 'stale_version') { toast('This request changed. Check the updated request before deciding.', 'info'); onRefresh?.(); }
    } finally {
      setBusy(false);
    }
  }

  const openPanel = (which: 'refuse' | 'question') => {
    if (panel !== which) setText('');
    setPanel(panel === which ? null : which);
    setErr(null);
  };

  const panelIs = panel === 'refuse' ? 'refuse' : 'question';
  const confirmLabel =
    panelIs === 'refuse' ? verbs?.refuseConfirm : verbs?.questionConfirm;
  const confirmOutcome: Outcome | null =
    panel === 'refuse' ? (verbs?.refuse ?? null) : panel === 'question' ? (verbs?.question ?? null) : null;

  return (
    <div className="dc">
      {!openLink ? <p className="dc-who">
        <strong>{d.employee.full_name}</strong>
        {' · '}
        {d.leave_type_name}
        {' · '}
        {fmtRange(rev.start_date, rev.end_date)}
        {' · '}
        {fmtDuration(rev.total_minutes, d.minutes_per_day)}
      </p> : <p className="muted small">{d.number}</p>}
      {rev.note ? <p className="dc-note">“{rev.note}”</p> : null}
      {rev.change_reason ? <p className="dc-note">Why: “{rev.change_reason}”</p> : null}

      {change ? (
        <p className="dc-change">
          {change.headline}
          {change.detail ? ` ${change.detail}` : ''}
        </p>
      ) : null}

      {d.attachments.length ? <div className="dc-block"><h3 className="dc-h">Documents</h3><AttachmentLines d={d} /></div> : null}
      {latestQ ? <p className="dc-note">{latestQ.author?.display_name ?? 'Reviewer'} asked: “{latestQ.body}”{d.messages.find(m => m.kind === 'answer' && m.id > latestQ.id) ? ` · ${d.employee.full_name} answered: “${d.messages.find(m => m.kind === 'answer' && m.id > latestQ.id)!.body}”` : ' · Waiting for an answer.'}</p> : null}
      {earlier.length ? (
        <div className="dc-block">
          <h3 className="dc-h">Earlier steps</h3>
          <ul className="dc-list">
            {earlier.map((x) => (
              <li key={x.id}>{earlierStepLine(x)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {know.length ? (
        <ul className="dc-know">
          {know.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : null}


      {step && verbs ? (
        <>
          {step.acting_for ? (
            <p className="dc-acting">
              You are deciding for {step.acting_for.display_name} (stand-in).
            </p>
          ) : null}
          <div className="dc-actions">
            <button
              type="button"
              className={panel ? "btn btn-secondary" : "btn"}
              disabled={busy || approveBlocked || !step.outcomes.includes(verbs.positive)}
              onClick={() => void decide(verbs.positive)}
            >
              {busy ? 'Sending…' : verbs.positiveLabel}
            </button>
            {verbs.refuse ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                aria-expanded={panel === 'refuse'}
                onClick={() => openPanel('refuse')}
              >
                {verbs.refuseLabel}
              </button>
            ) : null}
            {verbs.question ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                aria-expanded={panel === 'question'}
                onClick={() => openPanel('question')}
              >
                {verbs.questionLabel}
              </button>
            ) : null}
          </div>
          {approveBlocked ? <p className="field-hint">Add a readable supporting document before approving.</p> : null}
          {!openLink ? <Details title="More options">
            <Field label="Reference document (optional)">
              <input
                type="text"
                value={basis}
                onChange={(e) => setBasis(e.target.value)}
                placeholder="e.g. paper form number"
              />
            </Field>
          </Details> : null}
          {panel && confirmOutcome ? (
            <div className="dc-panel">
              <Field
                label={
                  panelIs === 'refuse'
                    ? 'Reason (the employee will see this)'
                    : 'Your question'
                }
              >
                <textarea
                  disabled={busy}
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </Field>
              <ErrBox error={err} />
              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !text.trim()}
                  onClick={() => void decide(confirmOutcome, text.trim())}
                >
                  {busy ? 'Sending…' : confirmLabel}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPanel(null)}>Keep reviewing</button>
                {!text.trim() ? (
                  <span className="field-hint">
                    {panelIs === 'refuse'
                      ? step.kind === 'hr_check' ? 'Describe the problem.' : 'Write a reason to refuse.'
                      : 'Write your question.'}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {!panel && err ? <ErrBox error={err} /> : null}
        </>
      ) : (
        <>
          {d.status === 'needs_information' && latestQ ? (
            <p className="dc-wait">
              Waiting for {firstName(d.employee.full_name)} to answer.
            </p>
          ) : (
            <p className="dc-wait muted">Nothing for you to decide on this request.</p>
          )}
        </>
      )}

    </div>
  );
}
