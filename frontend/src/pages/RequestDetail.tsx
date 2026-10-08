import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, del, newIdempotencyKey, post, postForm, put, unwrapList } from '../api/client';
import type {
  AllowedAction,
  AuditEvent,
  DraftInput,
  LeaveType,
  Outcome,
  Part,
  RequestDetail as RD,
  UserListItem,
} from '../api/types';
import {
  Dur,
  Empty,
  ErrBox,
  Field,
  Loading,
  Modal,
  PhaseBadge,
  ReqLink,
  StatusBadge,
  stepStatusLabel,
  WarnList,
} from '../components/ui';
import {
  fmtBytes,
  fmtDate,
  fmtDateTime,
  fmtHours,
  fmtWeekday,
  outcomeLabel,
  partLabel,
  stepLabel,
} from '../lib/format';
import { useApi } from '../lib/useApi';

const REASON_REQUIRED: Outcome[] = [
  'reject',
  'recommend_reject',
  'needs_information',
  'checked_problem',
];

function DaysTable({ days }: { days: RD['current_revision']['days'] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Part</th>
            <th className="num">Counted</th>
            <th>Period / account</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>
                {fmtWeekday(d.date)} {fmtDate(d.date)}
              </td>
              <td>{partLabel(d.part)}</td>
              <td className="num">{d.minutes > 0 ? fmtHours(d.minutes) : '—'}</td>
              <td className="small">
                {d.allocations.length
                  ? d.allocations.map((a) => (
                      <div key={a.account_id}>
                        {a.period_year} — {fmtHours(a.minutes)}
                        {a.carryover ? (
                          <span className="badge" style={{ marginLeft: '0.3rem' }}>
                            carry-over
                          </span>
                        ) : null}
                      </div>
                    ))
                  : d.period_year}
              </td>
              <td className="small muted">{d.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RevisionFieldValue {
  leave_type_id: number;
  start_date: string;
  end_date: string;
  start_part: Part;
  end_part: Part;
  note: string;
}

/** Shared mini-form used by edit-draft, respond-with-changes and amend. */
function RevisionFields({
  leaveTypes,
  value,
  onChange,
}: {
  leaveTypes: LeaveType[];
  value: RevisionFieldValue;
  onChange: (patch: Partial<RevisionFieldValue>) => void;
}) {
  // Patch-style updates: the parent merges into current state, so an edit that
  // lands in the same tick as the prefill effect can't clobber other fields.
  const set = (patch: Partial<RevisionFieldValue>) => onChange(patch);
  const lt = leaveTypes.find((t) => t.id === value.leave_type_id);
  const halfDay = lt?.allow_half_day ?? false;
  return (
    <>
      <Field label="Leave type">
        <select
          value={value.leave_type_id}
          onChange={(e) => set({ leave_type_id: Number(e.target.value) })}
        >
          {leaveTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="Start date">
          <input
            type="date"
            value={value.start_date}
            onChange={(e) => set({ start_date: e.target.value })}
          />
        </Field>
        <Field label="End date">
          <input
            type="date"
            value={value.end_date}
            min={value.start_date}
            onChange={(e) => set({ end_date: e.target.value })}
          />
        </Field>
      </div>
      {halfDay ? (
        <div className="form-grid">
          <Field label="Start day part">
            <select value={value.start_part} onChange={(e) => set({ start_part: e.target.value as Part })}>
              <option value="full">Full day</option>
              <option value="am">Morning</option>
              <option value="pm">Afternoon</option>
            </select>
          </Field>
          <Field label="End day part">
            <select value={value.end_part} onChange={(e) => set({ end_part: e.target.value as Part })}>
              <option value="full">Full day</option>
              <option value="am">Morning</option>
              <option value="pm">Afternoon</option>
            </select>
          </Field>
        </div>
      ) : null}
      <Field label="Note">
        <textarea value={value.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
    </>
  );
}

type ActionKind =
  | 'edit'
  | 'delete'
  | 'submit'
  | 'withdraw'
  | 'respond'
  | 'revise'
  | 'decide'
  | 'amend'
  | 'cancel'
  | 'reassign'
  | 'actual'
  | 'upload';

export default function RequestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useApi(() => api<RD>(`/requests/${id}`), [id]);
  const leaveTypesQ = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [stale, setStale] = useState(false);
  const [actionErr, setActionErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [commentErr, setCommentErr] = useState<ApiError | null>(null);

  // modal field state
  const [reason, setReason] = useState('');
  const [basisDoc, setBasisDoc] = useState('');
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [body, setBody] = useState('');
  const [withChanges, setWithChanges] = useState(false);
  const [fields, setFields] = useState({
    leave_type_id: 0,
    start_date: '',
    end_date: '',
    start_part: 'full' as Part,
    end_part: 'full' as Part,
    note: '',
  });
  const [changeReason, setChangeReason] = useState('');
  const [cancelFrom, setCancelFrom] = useState('');
  const [cancelTo, setCancelTo] = useState('');
  const [stepId, setStepId] = useState(0);
  const [assigneeId, setAssigneeId] = useState(0);
  const [actualAction, setActualAction] = useState<'confirm' | 'propose_adjustment'>('confirm');
  const [minutesDelta, setMinutesDelta] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sensitivity, setSensitivity] = useState<'normal' | 'medical'>('normal');

  const d = q.data;

  // reassign target list — users endpoint may be admin-only; degrade gracefully
  const usersQ = useApi(
    () =>
      action === 'reassign'
        ? api<unknown>('/users').then((r) => unwrapList<UserListItem>(r))
        : Promise.resolve(null),
    [action === 'reassign'],
  );

  useEffect(() => {
    if (d && (action === 'amend' || action === 'revise' || action === 'respond' || action === 'edit')) {
      const r = d.current_revision;
      setFields({
        leave_type_id: r.leave_type?.id ?? 0,
        start_date: r.start_date,
        end_date: r.end_date,
        start_part: r.start_part,
        end_part: r.end_part,
        note: r.note ?? '',
      });
    }
    if (d && action === 'cancel') {
      setCancelFrom(d.current_revision.start_date);
      setCancelTo(d.current_revision.end_date);
    }
    if (d && action === 'decide' && d.decidable_step) {
      setOutcome(d.decidable_step.outcomes[0] ?? '');
      setStepId(d.decidable_step.id);
    }
    if (d && action === 'reassign') {
      const pending = d.steps.filter((s) => s.status === 'pending');
      setStepId(pending[0]?.id ?? 0);
    }
  }, [action, d]);

  // One Idempotency-Key per click-intent; reused if the user retries (API.md).
  const [opKey, setOpKey] = useState('');
  function patchFields(patch: Partial<typeof fields>) {
    setFields((f) => ({ ...f, ...patch }));
  }
  function openAction(a: ActionKind | null) {
    setOpKey(newIdempotencyKey());
    setActionErr(null);
    setReason('');
    setBasisDoc('');
    setOutcome('');
    setBody('');
    setWithChanges(false);
    setChangeReason('');
    setMinutesDelta('');
    setFile(null);
    setSensitivity('normal');
    setAction(a);
  }

  function handleErr(e: unknown) {
    const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
    if (ae.code === 'stale_version') setStale(true);
    else setActionErr(ae);
  }

  async function run(fn: () => Promise<RD | void>) {
    setBusy(true);
    setActionErr(null);
    try {
      const r = await fn();
      if (r) q.reload();
      setAction(null);
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  }

  if (q.loading) return <Loading />;
  if (q.error) {
    // A request someone links you can be outside your scope (sensitive leave,
    // another unit). Say so plainly instead of showing a raw API error.
    if (q.error.status === 403)
      return (
        <div className="panel" style={{ maxWidth: '36rem', margin: '2rem auto' }}>
          <h1>You don’t have access to this request</h1>
          <p className="muted">
            This request is not shared with you. It may belong to another team or contain
            restricted (e.g. medical) details. If you believe you should see it, ask an HR
            officer to check your role and scope.
          </p>
          <Link className="btn btn-secondary" to="/my">
            Back to My leave
          </Link>
        </div>
      );
    if (q.error.status === 404)
      return (
        <div className="panel" style={{ maxWidth: '36rem', margin: '2rem auto' }}>
          <h1>Request not found</h1>
          <p className="muted">This link does not match any request you can see.</p>
          <Link className="btn btn-secondary" to="/my">
            Back to My leave
          </Link>
        </div>
      );
    return <ErrBox error={q.error} />;
  }
  if (!d) return null;
  const mpd = d.minutes_per_day;
  const can = (a: AllowedAction) => d.allowed_actions.includes(a);
  const rev = d.current_revision;

  async function postComment() {
    if (!comment.trim()) return;
    setCommentErr(null);
    try {
      await post(`/requests/${d!.id}/messages`, { body: comment.trim() });
      setComment('');
      q.reload();
    } catch (e) {
      setCommentErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    }
  }

  return (
    <>
      {stale ? (
        <div className="alert alert-error stale-banner">
          This request changed while you were viewing it.{' '}
          <button
            className="btn btn-sm"
            onClick={() => {
              setStale(false);
              q.reload();
            }}
          >
            Reload
          </button>
        </div>
      ) : null}

      <div className="panel">
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0 }}>{d.number}</h1>
          <StatusBadge status={d.status} label={d.status_label} />
          <PhaseBadge phase={d.date_phase} />
          {d.kind !== 'leave' ? <span className="badge">{d.kind}</span> : null}
          {d.source === 'paper' ? (
            <span className="badge" title={`Received on paper ${d.paper_received_date ?? ''}`}>
              paper form
            </span>
          ) : null}
        </div>
        <dl className="kv" style={{ marginTop: '0.6rem' }}>
          <div className="kv-row">
            <dt>Employee</dt>
            <dd>
              {d.employee.full_name} ({d.employee.service_id}
              {d.employee.org_unit ? ` · ${d.employee.org_unit.name}` : ''})
            </dd>
          </div>
          <div className="kv-row">
            <dt>Leave type</dt>
            <dd>{d.leave_type_name}</dd>
          </div>
          <div className="kv-row">
            <dt>Dates</dt>
            <dd>
              {fmtDate(rev.start_date)} – {fmtDate(rev.end_date)} (
              <Dur minutes={d.total_minutes} mpd={mpd} />)
              {rev.start_part !== 'full' || rev.end_part !== 'full'
                ? ` · ${partLabel(rev.start_part)} / ${partLabel(rev.end_part)}`
                : ''}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Entered by</dt>
            <dd>
              {d.entered_by.display_name}
              {d.paper_received_date ? ` · paper received ${fmtDate(d.paper_received_date)}` : ''}
            </dd>
          </div>
          {d.effective_revision && d.effective_revision.id !== d.current_revision.id ? (
            <div className="kv-row">
              <dt>Effective version</dt>
              <dd>
                revision {d.effective_revision.rev_no} is in force; revision{' '}
                {d.current_revision.rev_no} shown
              </dd>
            </div>
          ) : null}
          {d.next_action ? (
            <div className="kv-row">
              <dt>Next</dt>
              <dd>{d.next_action}</dd>
            </div>
          ) : null}
        </dl>
        {rev.note ? <p className="muted">“{rev.note}”</p> : null}
        <WarnList warnings={d.warnings} />

        <div className="btn-row no-print">
          {can('submit') ? (
            <button className="btn" onClick={() => openAction('submit')}>
              Submit for approval
            </button>
          ) : null}
          {can('decide') && d.decidable_step ? (
            <button className="btn" onClick={() => openAction('decide')}>
              Decide — {stepLabel(d.decidable_step.kind)}
              {d.decidable_step.acting_for ? ` (for ${d.decidable_step.acting_for.display_name})` : ''}
            </button>
          ) : null}
          {can('edit') ? (
            <button className="btn btn-secondary" onClick={() => openAction('edit')}>
              Edit draft
            </button>
          ) : null}
          {can('delete') ? (
            <button className="btn btn-danger" onClick={() => openAction('delete')}>
              Delete draft
            </button>
          ) : null}
          {can('respond') ? (
            <button className="btn" onClick={() => openAction('respond')}>
              Respond to question
            </button>
          ) : null}
          {can('revise') ? (
            <button className="btn btn-secondary" onClick={() => openAction('revise')}>
              Change dates / type
            </button>
          ) : null}
          {can('withdraw') ? (
            <button className="btn btn-secondary" onClick={() => openAction('withdraw')}>
              Withdraw
            </button>
          ) : null}
          {can('amend') ? (
            <button className="btn btn-secondary" onClick={() => openAction('amend')}>
              Request amendment
            </button>
          ) : null}
          {can('cancel') ? (
            <button className="btn btn-secondary" onClick={() => openAction('cancel')}>
              Request cancellation
            </button>
          ) : null}
          {can('reassign') ? (
            <button className="btn btn-secondary" onClick={() => openAction('reassign')}>
              Reassign a step
            </button>
          ) : null}
          {can('confirm_actual') || can('propose_actual_adjustment') ? (
            <button className="btn btn-secondary" onClick={() => openAction('actual')}>
              Confirm actual / propose adjustment
            </button>
          ) : null}
          {can('upload') ? (
            <button className="btn btn-secondary" onClick={() => openAction('upload')}>
              Upload attachment
            </button>
          ) : null}
          {can('print') ? (
            <Link className="btn btn-secondary" to={`/requests/${d.id}/print`}>
              Printable card
            </Link>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Days in revision {rev.rev_no}</h2>
        <DaysTable days={rev.days} />
        {rev.change_reason ? (
          <p className="muted small">Change reason: {rev.change_reason}</p>
        ) : null}
      </div>

      <div className="two-col">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Approval route</h2>
          {d.steps.length === 0 ? (
            <Empty>No steps — the request has not been submitted.</Empty>
          ) : (
            <ol className="timeline">
              {d.steps.map((s) => (
                <li key={s.id}>
                  <span className="tl-dot" aria-hidden="true">
                    {s.status === 'done' ? '●' : s.status === 'pending' ? '◐' : '○'}
                  </span>
                  <span className="tl-body">
                    <strong>{stepLabel(s.kind)}</strong>{' '}
                    <span className="muted small">
                      rev {s.revision_no} · {stepStatusLabel(s.status)}
                    </span>
                    <br />
                    <span className="small">
                      {s.assignee ? s.assignee.display_name : s.eligible_description}
                    </span>
                    {s.problem ? (
                      <div className="badge badge-med" style={{ marginTop: '0.2rem' }}>
                        {s.problem}
                      </div>
                    ) : null}
                    {s.outcome ? (
                      <div className="small">
                        {outcomeLabel(s.outcome)}
                        {s.completed_at ? ` · ${fmtDateTime(s.completed_at)}` : ''}
                      </div>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <h2>Decisions</h2>
          {d.decisions.length === 0 ? (
            <Empty>No decisions yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Step</th>
                    <th>By</th>
                    <th>Outcome</th>
                    <th>Reason / basis</th>
                  </tr>
                </thead>
                <tbody>
                  {d.decisions.map((x) => (
                    <tr key={x.id}>
                      <td className="small">{fmtDateTime(x.created_at)}</td>
                      <td className="small">
                        {stepLabel(x.step_kind)} (rev {x.revision_no})
                      </td>
                      <td className="small">
                        {x.actor.display_name}
                        {x.acting_for ? ` (for ${x.acting_for.display_name})` : ''}
                        <div className="muted">{x.authority}</div>
                      </td>
                      <td className="small">{outcomeLabel(x.outcome)}</td>
                      <td className="small">
                        {x.reason ?? ''}
                        {x.basis_document ? (
                          <div className="muted">basis: {x.basis_document}</div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Questions &amp; comments</h2>
          {d.messages.length === 0 ? <Empty>No messages yet.</Empty> : null}
          {d.messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.kind}`}>
              <div className="small muted">
                {m.kind === 'question' ? 'Question' : m.kind === 'system' ? 'System' : m.kind}
                {m.author ? ` · ${m.author.display_name}` : ''} · {fmtDateTime(m.created_at)}
              </div>
              <div>{m.body}</div>
            </div>
          ))}
          {can('comment') ? (
            <div className="no-print">
              <Field label="Add a comment">
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
              </Field>
              {commentErr ? <ErrBox error={commentErr} /> : null}
              <button className="btn btn-secondary btn-sm" onClick={() => void postComment()}>
                Post comment
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Attachments</h2>
        {d.attachments.length === 0 ? <Empty>No attachments.</Empty> : null}
        <ul>
          {d.attachments.map((a) =>
            'restricted' in a && a.restricted ? (
              <li key={a.id}>
                <span className="badge badge-med">Restricted document</span>
                <span className="muted small"> — you do not have access to this file</span>
              </li>
            ) : (
              <li key={(a as { id: number }).id}>
                {(() => {
                  const att = a as Extract<typeof a, { filename: string }>;
                  return (
                    <>
                      {att.can_download && att.scan_status === 'clean' ? (
                        <a href={`/api/attachments/${att.id}`}>{att.filename}</a>
                      ) : (
                        <span>{att.filename}</span>
                      )}{' '}
                      <span className="muted small">
                        {fmtBytes(att.size_bytes)} · {att.uploaded_by.display_name}
                      </span>{' '}
                      {att.sensitivity === 'medical' ? (
                        <span className="badge badge-med">medical</span>
                      ) : null}
                      {att.scan_status === 'quarantined' ? (
                        <span className="badge badge-med">quarantined — cannot be downloaded</span>
                      ) : att.scan_status === 'pending' ? (
                        <span className="badge">scan pending</span>
                      ) : att.scan_status === 'scan_failed' ? (
                        <span className="badge badge-med">scan failed</span>
                      ) : null}
                    </>
                  );
                })()}
              </li>
            ),
          )}
        </ul>
      </div>

      {d.reservations.length || d.ledger_entries.length ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Effect on the ledger</h2>
          <div className="two-col">
            <div>
              <h3>Reservations</h3>
              {d.reservations.length === 0 ? (
                <Empty>None active.</Empty>
              ) : (
                <table className="small">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th className="num">Minutes</th>
                      <th>Revision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.reservations.map((r) => (
                      <tr key={r.id}>
                        <td>{r.period_year}</td>
                        <td className="num">
                          <Dur minutes={r.minutes} mpd={mpd} />
                        </td>
                        <td>{r.revision_no}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h3>Ledger entries</h3>
              {d.ledger_entries.length === 0 ? (
                <Empty>None yet — entries appear when a request is approved.</Empty>
              ) : (
                <table className="small">
                  <thead>
                    <tr>
                      <th>Effective</th>
                      <th>Kind</th>
                      <th className="num">Minutes</th>
                      <th>Basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.ledger_entries.map((e) => (
                      <tr key={e.id}>
                        <td>{fmtDate(e.effective_date)}</td>
                        <td>{e.kind}</td>
                        <td className="num">
                          {e.minutes > 0 ? '+' : ''}
                          <Dur minutes={e.minutes} mpd={mpd} />
                        </td>
                        <td className="muted">{e.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {d.revisions.length > 1 || d.parent || d.children.length || d.previous_request ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>History &amp; links</h2>
          {d.parent ? (
            <p>
              This is a {d.kind} of <ReqLink id={d.parent.id} number={d.parent.number} />.
            </p>
          ) : null}
          {d.previous_request ? (
            <p>
              Follow-up to <ReqLink id={d.previous_request.id} number={d.previous_request.number} />.
            </p>
          ) : null}
          {d.children.length ? (
            <p>
              Related:{' '}
              {d.children.map((c) => (
                <span key={c.id} style={{ marginRight: '0.6rem' }}>
                  <ReqLink id={c.id} number={c.number} /> <span className="badge">{c.kind}</span>{' '}
                  <StatusBadge status={c.status} />
                </span>
              ))}
            </p>
          ) : null}
          {d.revisions.length > 1 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rev</th>
                    <th>Type</th>
                    <th>Dates</th>
                    <th className="num">Length</th>
                    <th>Changed by</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {d.revisions.map((r, i) => {
                    const prev = i > 0 ? d.revisions[i - 1] : null;
                    const changed =
                      prev &&
                      (prev.start_date !== r.start_date ||
                        prev.end_date !== r.end_date ||
                        prev.leave_type?.id !== r.leave_type?.id);
                    return (
                      <tr key={r.id} style={r.id === rev.id ? { fontWeight: 600 } : undefined}>
                        <td>
                          {r.rev_no}
                          {r.id === rev.id ? ' (current)' : ''}
                          {d.effective_revision?.id === r.id ? ' · effective' : ''}
                        </td>
                        <td>{r.leave_type?.name ?? 'Restricted'}</td>
                        <td>
                          {fmtDate(r.start_date)} – {fmtDate(r.end_date)}
                          {changed ? <span className="badge" style={{ marginLeft: '0.3rem' }}>changed</span> : null}
                        </td>
                        <td className="num">
                          <Dur minutes={r.total_minutes} mpd={mpd} />
                        </td>
                        <td className="small">
                          {r.created_by.display_name}
                          <div className="muted">{fmtDateTime(r.created_at)}</div>
                        </td>
                        <td className="small">{r.change_reason ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {d.actual ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Actual period</h2>
          <p>
            Confirmed by {d.actual.confirmed_by.display_name} on {fmtDateTime(d.actual.confirmed_at)}
            {d.actual.note ? ` — ${d.actual.note}` : ''}
          </p>
        </div>
      ) : null}

      <details className="audit panel">
        <summary>Audit trail ({d.audit.length} events)</summary>
        <AuditTable events={d.audit} />
      </details>

      {/* ------- action modals ------- */}

      {action === 'submit' ? (
        <Modal title="Submit for approval" onClose={() => setAction(null)}>
          <p>
            Submit {d.number} — <Dur minutes={d.total_minutes} mpd={mpd} /> — through the approval
            route? The balance will be reserved until a decision.
          </p>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  post<RD>(`/requests/${d.id}/submit`, { expected_version: d.version }, opKey),
                )
              }
            >
              {busy ? 'Submitting…' : 'Submit'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'edit' ? (
        <Modal title="Edit draft" onClose={() => setAction(null)} wide>
          <RevisionFields
            leaveTypes={leaveTypesQ.data ?? []}
            value={fields}
            onChange={patchFields}
          />
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  put<RD>(`/requests/${d.id}`, {
                    leave_type_id: fields.leave_type_id,
                    start_date: fields.start_date,
                    end_date: fields.end_date,
                    start_part: fields.start_part,
                    end_part: fields.end_part,
                    note: fields.note,
                    expected_version: d.version,
                  } satisfies DraftInput & { expected_version: number }),
                )
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'delete' ? (
        <Modal title="Delete draft" onClose={() => setAction(null)}>
          <p>Delete draft {d.number}? This cannot be undone (the audit record stays).</p>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await del(`/requests/${d.id}`, { expected_version: d.version });
                  navigate('/my');
                })
              }
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Keep
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'withdraw' ? (
        <Modal title="Withdraw request" onClose={() => setAction(null)}>
          <p>Withdraw {d.number}? The reservation is released immediately.</p>
          <Field label="Reason (optional)">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  post<RD>(`/requests/${d.id}/withdraw`, {
                    expected_version: d.version,
                    reason: reason || undefined,
                  }),
                )
              }
            >
              {busy ? 'Withdrawing…' : 'Withdraw'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'decide' && d.decidable_step ? (
        <Modal title={`Decide — ${stepLabel(d.decidable_step.kind)}`} onClose={() => setAction(null)}>
          {d.decidable_step.acting_for ? (
            <p className="alert alert-info">
              You are acting for {d.decidable_step.acting_for.display_name} under a delegation.
            </p>
          ) : null}
          <Field label="Outcome">
            <div>
              {d.decidable_step.outcomes.map((o) => (
                <label key={o} style={{ display: 'block', margin: '0.25rem 0' }}>
                  <input
                    type="radio"
                    name="outcome"
                    checked={outcome === o}
                    onChange={() => setOutcome(o)}
                  />{' '}
                  {outcomeLabel(o)}
                </label>
              ))}
            </div>
          </Field>
          <Field
            label={REASON_REQUIRED.includes(outcome as Outcome) ? 'Reason (required)' : 'Reason'}
          >
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Basis document (optional)">
            <input type="text" value={basisDoc} onChange={(e) => setBasisDoc(e.target.value)} />
          </Field>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !outcome || (REASON_REQUIRED.includes(outcome as Outcome) && !reason.trim())}
              onClick={() =>
                void run(() =>
                  post<RD>(
                    `/requests/${d.id}/decide`,
                    {
                      expected_version: d.version,
                      step_id: d.decidable_step!.id,
                      outcome,
                      reason: reason || undefined,
                      basis_document: basisDoc || undefined,
                    },
                    opKey,
                  ),
                )
              }
            >
              {busy ? 'Saving…' : 'Record decision'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'respond' || action === 'revise' ? (
        <Modal
          title={action === 'respond' ? 'Respond' : 'Change dates or type'}
          onClose={() => setAction(null)}
          wide
        >
          {action === 'respond' ? (
            <label style={{ display: 'block', margin: '0.4rem 0' }}>
              <input
                type="checkbox"
                checked={withChanges}
                onChange={(e) => setWithChanges(e.target.checked)}
              />{' '}
              Also change dates / leave type (starts the approval route again)
            </label>
          ) : null}
          {action === 'revise' || withChanges ? (
            <>
              <RevisionFields leaveTypes={leaveTypesQ.data ?? []} value={fields} onChange={patchFields} />
              <Field label="Change reason (required)">
                <input
                  type="text"
                  value={changeReason}
                  onChange={(e) => setChangeReason(e.target.value)}
                />
              </Field>
            </>
          ) : null}
          <Field label={action === 'respond' ? 'Your answer' : 'Message (optional)'}>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={
                busy ||
                (action === 'respond' && !withChanges && !body.trim()) ||
                ((withChanges || action === 'revise') && !changeReason.trim())
              }
              onClick={() =>
                void run(() =>
                  post<RD>(`/requests/${d.id}/respond`, {
                    expected_version: d.version,
                    body: body || '(dates changed)',
                    changes:
                      withChanges || action === 'revise'
                        ? {
                            leave_type_id: fields.leave_type_id,
                            start_date: fields.start_date,
                            end_date: fields.end_date,
                            start_part: fields.start_part,
                            end_part: fields.end_part,
                            note: fields.note,
                            change_reason: changeReason,
                          }
                        : undefined,
                  }),
                )
              }
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'amend' ? (
        <Modal title="Request amendment" onClose={() => setAction(null)} wide>
          <p className="muted small">
            Creates a new amendment request — the approved dates stay in force until the amendment is
            decided.
          </p>
          <RevisionFields leaveTypes={leaveTypesQ.data ?? []} value={fields} onChange={patchFields} />
          <Field label="Change reason (required)">
            <input type="text" value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />
          </Field>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !changeReason.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await post<RD>(
                    `/requests/${d.id}/amend`,
                    {
                      expected_version: d.version,
                      leave_type_id: fields.leave_type_id,
                      start_date: fields.start_date,
                      end_date: fields.end_date,
                      start_part: fields.start_part,
                      end_part: fields.end_part,
                      change_reason: changeReason,
                    },
                    opKey,
                  );
                  navigate(`/requests/${r.id}`);
                })
              }
            >
              {busy ? 'Creating…' : 'Create amendment'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'cancel' ? (
        <Modal title="Request cancellation" onClose={() => setAction(null)}>
          <p className="muted small">
            Cancel the whole range or part of it. Days already in the past need an HR correction
            instead.
          </p>
          <div className="form-grid">
            <Field label="Cancel from">
              <input type="date" value={cancelFrom} onChange={(e) => setCancelFrom(e.target.value)} />
            </Field>
            <Field label="to">
              <input type="date" value={cancelTo} min={cancelFrom} onChange={(e) => setCancelTo(e.target.value)} />
            </Field>
          </div>
          <Field label="Reason (required)">
            <input type="text" value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />
          </Field>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !changeReason.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await post<RD>(
                    `/requests/${d.id}/cancel`,
                    {
                      expected_version: d.version,
                      from_date: cancelFrom,
                      to_date: cancelTo,
                      change_reason: changeReason,
                    },
                    opKey,
                  );
                  navigate(`/requests/${r.id}`);
                })
              }
            >
              {busy ? 'Creating…' : 'Create cancellation'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'reassign' ? (
        <Modal title="Reassign an approval step" onClose={() => setAction(null)}>
          <Field label="Step">
            <select value={stepId} onChange={(e) => setStepId(Number(e.target.value))}>
              {d.steps
                .filter((s) => s.status === 'pending')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {stepLabel(s.kind)} — currently {s.assignee?.display_name ?? s.eligible_description}
                  </option>
                ))}
            </select>
          </Field>
          {usersQ.data ? (
            <Field label="Assign to">
              <select value={assigneeId} onChange={(e) => setAssigneeId(Number(e.target.value))}>
                <option value={0}>— choose user —</option>
                {usersQ.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name} ({u.email})
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Assign to user id" hint="User list is not available to your role; enter the numeric user id.">
              <input
                type="number"
                value={assigneeId || ''}
                onChange={(e) => setAssigneeId(Number(e.target.value))}
              />
            </Field>
          )}
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !stepId || !assigneeId}
              onClick={() =>
                void run(() =>
                  post<RD>(`/requests/${d.id}/reassign`, {
                    expected_version: d.version,
                    step_id: stepId,
                    assignee_user_id: assigneeId,
                  }),
                )
              }
            >
              {busy ? 'Saving…' : 'Reassign'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'actual' ? (
        <Modal title="Actual period" onClose={() => setAction(null)}>
          <Field label="Action">
            <select
              value={actualAction}
              onChange={(e) => setActualAction(e.target.value as 'confirm' | 'propose_adjustment')}
            >
              {can('confirm_actual') ? <option value="confirm">Confirm the period happened</option> : null}
              {can('propose_actual_adjustment') ? (
                <option value="propose_adjustment">Propose an adjustment (needs a second approver)</option>
              ) : null}
            </select>
          </Field>
          {actualAction === 'propose_adjustment' ? (
            <Field label="Minutes delta (+ return days / − deduct more)">
              <input
                type="number"
                step="60"
                value={minutesDelta}
                onChange={(e) => setMinutesDelta(e.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Note">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Basis document">
            <input type="text" value={basisDoc} onChange={(e) => setBasisDoc(e.target.value)} />
          </Field>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  post<RD>(`/requests/${d.id}/actual`, {
                    expected_version: d.version,
                    action: actualAction,
                    note: reason,
                    minutes_delta: minutesDelta ? Number(minutesDelta) : undefined,
                    basis_document: basisDoc || undefined,
                  }),
                )
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}

      {action === 'upload' ? (
        <Modal title="Upload attachment" onClose={() => setAction(null)}>
          <Field label="File" hint="PDF, PNG or JPEG — up to 2 MB (1 MB in demo).">
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Sensitivity">
            <select
              value={sensitivity}
              onChange={(e) => setSensitivity(e.target.value as 'normal' | 'medical')}
            >
              <option value="normal">Normal</option>
              <option value="medical">Medical (restricted access)</option>
            </select>
          </Field>
          {actionErr ? <ErrBox error={actionErr} /> : null}
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !file}
              onClick={() =>
                void run(async () => {
                  const fd = new FormData();
                  fd.set('file', file!);
                  fd.set('sensitivity', sensitivity);
                  await postForm(`/requests/${d.id}/attachments`, fd);
                })
              }
            >
              {busy ? 'Uploading…' : 'Upload'}
            </button>
            <button className="btn btn-secondary" onClick={() => openAction(null)}>
              Back
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function AuditTable({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <Empty>No audit events.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="small">{fmtDateTime(e.at)}</td>
              <td className="small">
                {e.actor?.display_name ?? 'system'}
                {e.acting_for ? ` (for ${e.acting_for.display_name})` : ''}
              </td>
              <td className="small">{e.action}</td>
              <td className="small muted">
                {e.details ? <code className="mono">{JSON.stringify(e.details)}</code> : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
