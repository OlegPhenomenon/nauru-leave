import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, newIdempotencyKey, post, unwrapList } from '../api/client';
import type {
  DraftInput,
  EmployeeListItem,
  LeaveType,
  Part,
  Preview,
  RequestDetail,
} from '../api/types';
import { Dur, Empty, ErrBox, Field, WarnList } from '../components/ui';
import { fmtHours, fmtWeekday, partLabel, stepLabel } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

function PreviewPanel({ preview, pending }: { preview: Preview | null; pending: boolean }) {
  if (!preview && pending) return <p className="muted">Calculating…</p>;
  if (!preview) return <Empty>Pick a leave type and dates to see the calculation.</Empty>;
  return (
    <div aria-busy={pending}>
      {preview.errors.length ? (
        <div className="alert alert-error">
          <strong>Cannot be submitted:</strong>
          <ul>
            {preview.errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <WarnList warnings={preview.warnings} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Part</th>
              <th className="num">Time</th>
              <th>Period</th>
              <th>Explanation</th>
            </tr>
          </thead>
          <tbody>
            {preview.days.map((d) => (
              <tr key={d.date}>
                <td>
                  {fmtWeekday(d.date)} {d.date.slice(8)}/{d.date.slice(5, 7)}
                </td>
                <td>{partLabel(d.part)}</td>
                <td className="num">{d.minutes > 0 ? fmtHours(d.minutes) : '—'}</td>
                <td>
                  {d.minutes > 0
                    ? d.allocations
                        .map((a) => `${a.period_year}${a.carryover ? ' (carry-over)' : ''}`)
                        .join(', ')
                    : d.period_year}
                </td>
                <td className="small muted">{d.explanation}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>Total</th>
              <th className="num">
                {fmtHours(preview.total_minutes)} ={' '}
                <Dur minutes={preview.total_minutes} mpd={preview.minutes_per_day} />
              </th>
              <th colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      {preview.balance_after.length ? (
        <table className="small" style={{ maxWidth: '34rem' }}>
          <thead>
            <tr>
              <th>Period</th>
              <th className="num">Balance before</th>
              <th className="num">Balance after</th>
            </tr>
          </thead>
          <tbody>
            {preview.balance_after.map((b) => (
              <tr key={b.period_year}>
                <td>{b.period_year}</td>
                <td className="num">
                  <Dur minutes={b.available_before} mpd={preview.minutes_per_day} />
                </td>
                <td className="num">
                  <Dur minutes={b.available_after} mpd={preview.minutes_per_day} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {preview.route.length ? (
        <>
          <h3>Approval route</h3>
          <ol>
            {preview.route.map((r, i) => (
              <li key={i}>
                {stepLabel(r.kind)} — {r.who}
                {r.problem ? (
                  <span className="badge badge-med" style={{ marginLeft: '0.4rem' }}>
                    {r.problem}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

export default function RequestNew() {
  const { me, hasRole, config } = useSession();
  const navigate = useNavigate();
  const isHr = hasRole('hr');
  const today = config?.business_date ?? '';

  const leaveTypesQ = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const employeesQ = useApi(
    () =>
      isHr
        ? api<unknown>('/employees').then((d) => unwrapList<EmployeeListItem>(d))
        : Promise.resolve([]),
    [isHr],
  );

  const [leaveTypeId, setLeaveTypeId] = useState(0);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [startPart, setStartPart] = useState<Part>('full');
  const [endPart, setEndPart] = useState<Part>('full');
  const [note, setNote] = useState('');
  const [employeeId, setEmployeeId] = useState(0);
  const [paper, setPaper] = useState(false);
  const [paperDate, setPaperDate] = useState(today);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewErr, setPreviewErr] = useState<ApiError | null>(null);

  const [draft, setDraft] = useState<RequestDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitKey, setSubmitKey] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<ApiError | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const leaveTypes = (leaveTypesQ.data ?? []).filter((t) => t.active);
  const lt = leaveTypes.find((t) => t.id === leaveTypeId) ?? null;
  const halfDay = lt?.allow_half_day ?? false;

  useEffect(() => {
    if (!leaveTypeId && leaveTypes.length) setLeaveTypeId(leaveTypes[0]!.id);
  }, [leaveTypes, leaveTypeId]);

  const input = useMemo<DraftInput | null>(() => {
    if (!leaveTypeId || !startDate || !endDate) return null;
    const d: DraftInput = {
      leave_type_id: leaveTypeId,
      start_date: startDate,
      end_date: endDate,
      start_part: halfDay ? startPart : 'full',
      end_part: halfDay ? endPart : 'full',
    };
    if (note.trim()) d.note = note.trim();
    if (isHr && employeeId) d.employee_id = employeeId;
    if (isHr && paper) {
      d.source = 'paper';
      if (paperDate) d.paper_received_date = paperDate;
    }
    return d;
  }, [leaveTypeId, startDate, endDate, startPart, endPart, halfDay, note, isHr, employeeId, paper, paperDate]);

  // Debounced live preview (spec: show calculation before submit).
  useEffect(() => {
    if (!input) {
      setPreview(null);
      return;
    }
    setPreviewPending(true);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      post<Preview>('/requests/preview', input)
        .then((p) => {
          setPreview(p);
          setPreviewErr(null);
        })
        .catch((e) => {
          setPreviewErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
        })
        .finally(() => setPreviewPending(false));
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [input]);

  async function saveDraft(): Promise<RequestDetail | null> {
    if (!input) return null;
    if (draft) {
      const d = await api<RequestDetail>(`/requests/${draft.id}`, {
        method: 'PUT',
        body: { ...input, expected_version: draft.version },
      });
      setDraft(d);
      return d;
    }
    const d = await post<RequestDetail>('/requests', input);
    setDraft(d);
    return d;
  }

  async function onSaveDraft() {
    setSaving(true);
    setFormErr(null);
    try {
      const d = await saveDraft();
      if (d) navigate(`/requests/${d.id}`);
    } catch (e) {
      setFormErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setSaving(false);
    }
  }

  // Submit = create/update draft, then submit with an Idempotency-Key that is
  // reused if the user retries after a network failure (API.md).
  async function onSubmit() {
    setSubmitting(true);
    setFormErr(null);
    setInfoMsg(null);
    const key = submitKey ?? newIdempotencyKey();
    setSubmitKey(key);
    try {
      const d = await saveDraft();
      if (!d) return;
      const r = await post<RequestDetail>(
        `/requests/${d.id}/submit`,
        { expected_version: d.version },
        key,
      );
      navigate(`/requests/${r.id}`, { state: { submitted: true } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        setInfoMsg(
          'The connection dropped before we could confirm. Do not resubmit blindly — open “My leave” to check whether the request was saved, or press Submit again (it is safe to retry).',
        );
      } else if (e instanceof ApiError) {
        setFormErr(e);
      } else {
        setFormErr(new ApiError(0, 'unknown', String(e)));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const blocked = !!preview?.errors.length;

  return (
    <>
      <h1>New leave request</h1>
      <div className="two-col">
        <div className="panel">
          {formErr ? <ErrBox error={formErr} /> : null}
          {infoMsg ? <div className="alert alert-info">{infoMsg}</div> : null}

          {isHr ? (
            <fieldset>
              <legend>For whom (HR)</legend>
              <Field label="Employee" hint="Leave empty to request for yourself.">
                <select
                  value={employeeId}
                  onChange={(e) => setEmployeeId(Number(e.target.value))}
                >
                  <option value={0}>Myself{me?.employee ? ` (${me.employee.full_name})` : ''}</option>
                  {employeesQ.data?.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.full_name} ({e.service_id})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Source">
                <select value={paper ? 'paper' : 'self'} onChange={(e) => setPaper(e.target.value === 'paper')}>
                  <option value="self">Entered directly</option>
                  <option value="paper">Paper form received</option>
                </select>
              </Field>
              {paper ? (
                <Field label="Paper form received on">
                  <input
                    type="date"
                    value={paperDate}
                    max={today}
                    onChange={(e) => setPaperDate(e.target.value)}
                  />
                </Field>
              ) : null}
            </fieldset>
          ) : null}

          <Field label="Leave type">
            <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(Number(e.target.value))}>
              {leaveTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.sensitive ? ' (restricted details)' : ''}
                </option>
              ))}
            </select>
          </Field>
          {lt ? (
            <p className="muted small">
              {lt.min_notice_days > 0
                ? `Normally requested at least ${lt.min_notice_days} days in advance (a warning, not a refusal). `
                : ''}
              {lt.requires_attachment ? 'An attachment is required. ' : ''}
              {!lt.uses_balance ? 'Does not use a leave balance. ' : ''}
            </p>
          ) : null}

          <div className="form-grid">
            <Field label="Start date">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            </Field>
            <Field label="End date">
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
            </Field>
          </div>
          {halfDay ? (
            <div className="form-grid">
              <Field label="Start day part">
                <select value={startPart} onChange={(e) => setStartPart(e.target.value as Part)}>
                  <option value="full">Full day</option>
                  <option value="am">Morning only</option>
                  <option value="pm">Afternoon only</option>
                </select>
              </Field>
              <Field label="End day part">
                <select value={endPart} onChange={(e) => setEndPart(e.target.value as Part)}>
                  <option value="full">Full day</option>
                  <option value="am">Morning only</option>
                  <option value="pm">Afternoon only</option>
                </select>
              </Field>
            </div>
          ) : null}

          <Field label="Note (optional)">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          {lt?.requires_attachment ? (
            <p className="muted small">
              Attachments are added after the draft is saved — press “Save draft” first, upload on
              the request page, then submit.
            </p>
          ) : null}

          <div className="btn-row">
            <button className="btn btn-secondary" disabled={saving || submitting || !input} onClick={() => void onSaveDraft()}>
              {saving ? 'Saving…' : draft ? 'Update draft' : 'Save draft'}
            </button>
            <button
              className="btn"
              disabled={saving || submitting || blocked || !input}
              title={blocked ? 'Fix the errors shown in the preview first' : undefined}
              onClick={() => void onSubmit()}
            >
              {submitting ? 'Submitting…' : 'Submit for approval'}
            </button>
          </div>
          {draft ? (
            <p className="muted small">
              Draft saved as {draft.number} — you can attach files on its page before submitting.
            </p>
          ) : null}
        </div>

        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Preview</h2>
          {previewErr ? <ErrBox error={previewErr} /> : null}
          <PreviewPanel preview={preview} pending={previewPending} />
        </div>
      </div>
    </>
  );
}
