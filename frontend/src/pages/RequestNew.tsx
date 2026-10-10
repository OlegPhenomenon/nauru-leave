import { DayParts } from '../components/DayParts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError, newIdempotencyKey, post, postForm, unwrapList } from '../api/client';
import type {
  DraftInput,
  EmployeeListItem,
  LeaveType,
  Part,
  Preview,
  RequestDetail,
} from '../api/types';
import { Details, ErrBox, Field, PageHeader, WarnList, useToast } from '../components/ui';
import { describeError, isValidDate } from '../lib/errors';
import {
  fmtBytes,
  fmtDay,
  fmtDuration,
  fmtWeekday,
  stepLabel,
} from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { PersonPicker } from './employee/PersonPicker';
import './RequestNew.css';

/* ------------------------------------------------------------------ */
/* Preview: summary line, warnings, day-by-day + route disclosure       */
/* ------------------------------------------------------------------ */

function countedLabel(d: Preview['days'][number], mpd: number): string {
  if (d.minutes > 0) return fmtDuration(d.minutes, mpd);
  if (d.explanation.startsWith('Holiday:')) {
    return `Public holiday — ${d.explanation.slice('Holiday:'.length).trim()}`;
  }
  const wd = fmtWeekday(d.date);
  return wd === 'Sat' || wd === 'Sun' ? 'Weekend' : 'Day off';
}

function routeWho(step: Preview['route'][number]): string {
  if (step.problem) return step.kind === 'manager_recommendation' ? 'your manager' : stepLabel(step.kind);
  switch (step.kind) {
    case 'manager_recommendation':
      return step.who;
    case 'hr_check':
      return 'HR';
    case 'final_decision':
      return 'a final approver';
  }
}

function PreviewBlock({ preview, pending }: { preview: Preview | null; pending: boolean }) {
  if (!preview) return pending ? <p className="muted small">Working out the days…</p> : null;
  return (
    <div aria-busy={pending}>
      {preview.errors.length ? (
        <div className="alert alert-error" role="alert">
          {preview.errors.map((e, i) => (
            <p key={i} className="small">
              {describeError(new ApiError(422, e.code, e.message)).message}
            </p>
          ))}
        </div>
      ) : (
        <>
          <p className="summary-line">
            <strong>
              Uses {fmtDuration(preview.total_minutes, preview.minutes_per_day).replace(/\bdays?\b/, (w) => `working ${w}`)}
              {preview.balance_after.length
                ? ` · ${fmtDuration(
                    preview.balance_after.reduce((s, b) => s + b.available_after, 0),
                    preview.minutes_per_day,
                  )} left after`
                : ''}
            </strong>
          </p>
          <WarnList warnings={preview.warnings} />
          <Details title="Show day by day">
            <table className="small">
              <tbody>
                {preview.days.map((d) => (
                  <tr key={d.date}>
                    <td className="nowrap">{fmtDay(d.date)}</td>
                    <td>{countedLabel(d, preview.minutes_per_day)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.route.length ? (
              <p className="muted small">
                Who approves:{' '}
                {preview.route.map((r) => routeWho(r)).join(' → ')}
                {preview.route.some((r) => r.problem)
                  ? ` — ${preview.route.find((r) => r.problem)?.problem}`
                  : ''}
              </p>
            ) : null}
          </Details>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The form                                                           */
/* ------------------------------------------------------------------ */

export default function RequestNew() {
  const { me, hasRole, config } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [sp] = useSearchParams();
  const isHr = hasRole('hr', 'hr_medical');
  const today = config?.business_date ?? '';
  const employeeParam = Number(sp.get('employee') ?? 0) || 0;

  const leaveTypesQ = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const employeesQ = useApi(
    () =>
      isHr
        ? api<unknown>('/employees').then((d) => unwrapList<EmployeeListItem>(d))
        : Promise.resolve([]),
    [isHr],
  );

  const [paperOn, setPaperOn] = useState(employeeParam > 0 || sp.get('paper') === '1');
  const [leaveTypeId, setLeaveTypeId] = useState(0);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [singlePart, setSinglePart] = useState<Part>('full');
  const [firstPart, setFirstPart] = useState<Part>('full');
  const [lastPart, setLastPart] = useState<Part>('full');
  const [multiHalf, setMultiHalf] = useState(false);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [employeeId, setEmployeeId] = useState(employeeParam);
  const [paperDate, setPaperDate] = useState(today);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewErr, setPreviewErr] = useState<ApiError | null>(null);

  const [draft, setDraft] = useState<RequestDetail | null>(null);
  const [previousDraft, setPreviousDraft] = useState<RequestDetail | null>(null);
  // File already uploaded against the current draft — don't upload twice on retry.
  const uploadedFor = useRef<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'draft' | null>(null);
  const [submitKey, setSubmitKey] = useState<string | null>(null);
  // Key for POST /requests: stable for the life of this form so a retry after
  // a dropped connection replays the same create instead of making a second draft.
  const createKey = useRef(newIdempotencyKey());
  const [formErr, setFormErr] = useState<ApiError | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const paperMode = isHr && paperOn;
  const leaveTypes = (leaveTypesQ.data ?? []).filter((t) => t.active);
  const lt = leaveTypes.find((t) => t.id === leaveTypeId) ?? null;
  const halfDay = lt?.allow_half_day ?? false;
  const singleDay = isValidDate(startDate) && startDate === endDate;

  const people = (employeesQ.data ?? []).filter((e) => e.active && e.id !== me?.employee?.id);

  useEffect(() => {
    if (!leaveTypeId && leaveTypes.length) setLeaveTypeId(leaveTypes[0]!.id);
  }, [leaveTypes, leaveTypeId]);

  // Received-on defaults to the business date once config arrives.
  useEffect(() => {
    setPaperDate((d) => d || today);
  }, [today]);

  const input = useMemo<DraftInput | null>(() => {
    if (!leaveTypeId || !isValidDate(startDate) || !isValidDate(endDate)) return null;
    if (endDate < startDate) return null;
    let startPart: Part = 'full';
    let endPart: Part = 'full';
    if (halfDay) {
      if (singleDay) {
        startPart = endPart = singlePart;
      } else if (multiHalf) {
        startPart = firstPart;
        endPart = lastPart;
      }
    }
    const d: DraftInput = {
      leave_type_id: leaveTypeId,
      start_date: startDate,
      end_date: endDate,
      start_part: startPart,
      end_part: endPart,
    };
    if (note.trim()) d.note = note.trim();
    if (paperMode && employeeId) {
      d.employee_id = employeeId;
      d.source = 'paper';
      if (paperDate) d.paper_received_date = paperDate;
    }
    return d;
  }, [leaveTypeId, startDate, endDate, halfDay, singleDay, singlePart, multiHalf, firstPart, lastPart, note, paperMode, employeeId, paperDate]);

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
  }, [input, today]);

  function startNewRequest() {
    setPreviousDraft(draft);
    setDraft(null);
    setEmployeeId(0);
    setFile(null);
    uploadedFor.current = null;
    createKey.current = newIdempotencyKey();
    setSubmitKey(null);
    setFormErr(null);
  }

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
    const d = await post<RequestDetail>('/requests', input, createKey.current);
    setDraft(d);
    return d;
  }

  async function uploadIfNeeded(d: RequestDetail): Promise<void> {
    if (!file) return;
    const key = `${d.id}:${file.name}:${file.size}`;
    if (uploadedFor.current === key) return;
    const fd = new FormData();
    fd.set('file', file);
    fd.set('sensitivity', lt?.sensitive ? 'medical' : 'normal');
    await postForm(`/requests/${d.id}/attachments`, fd);
    uploadedFor.current = key;
  }

  async function onSaveDraft() {
    setBusy('draft');
    setFormErr(null);
    try {
      const d = await saveDraft();
      if (!d) return;
      await uploadIfNeeded(d);
      toast('Draft saved — find it under My leave.');
      navigate(`/requests/${d.id}`);
    } catch (e) {
      setFormErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(null);
    }
  }

  // Send = create/update draft, upload the document, then submit. The submit
  // Idempotency-Key is reused when the user retries after a network failure.
  async function onSend() {
    setBusy('send');
    setFormErr(null);
    const key = submitKey ?? newIdempotencyKey();
    setSubmitKey(key);
    try {
      const d = await saveDraft();
      if (!d) return;
      await uploadIfNeeded(d);
      const fresh = file ? await api<RequestDetail>(`/requests/${d.id}`) : d;
      const r = await post<RequestDetail>(
        `/requests/${d.id}/submit`,
        { expected_version: fresh.version },
        key,
      );
      toast(
        r.source === 'paper'
          ? `Paper request sent for ${r.employee.full_name}.`
          : 'Request sent for approval.',
      );
      navigate(`/requests/${r.id}`, { state: { submitted: true } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        toast(
          'The connection dropped — check My leave to see whether it was saved before sending again. Sending again is safe.',
          'err',
        );
      } else {
        setFormErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
      }
    } finally {
      setBusy(null);
    }
  }

  const previewBlocked = !!preview?.errors.length;
  const missingDoc = !!lt?.requires_attachment && !file;
  const disabledReason = !leaveTypeId
    ? 'Choose a leave type.'
    : !startDate
      ? 'Choose a start date.'
      : !endDate
        ? 'Choose an end date.'
        : endDate < startDate
          ? 'The end date must be on or after the start date.'
          : paperMode && !employeeId
            ? 'Choose who this is for.'
            : missingDoc
              ? 'Attach the document — this leave type needs one.'
              : previewBlocked
                ? 'Fix the problems listed above first.'
                : '';
  const canSend = !!input && !disabledReason && busy === null;
  const canDraft = !!input && !(paperMode && !employeeId) && busy === null;

  return (
    <div className="stack">
      <PageHeader
        title={paperMode ? 'Enter a paper form' : 'Request leave'}
        back={
          sp.get('from') === 'approvals'
            ? { to: '/approvals', label: 'Approvals' }
            : paperOn || employeeParam > 0
            ? { to: '/people', label: 'People' }
            : { to: '/my', label: 'My leave' }
        }
        primary={
          isHr && !paperMode ? (
            <button type="button" className="btn btn-secondary" disabled={!!draft || !!busy} onClick={() => setPaperOn(true)}>
              Enter a paper form
            </button>
          ) : undefined
        }
      />

      <div className="req-form">
        {formErr ? <ErrBox error={formErr} /> : null}
        {draft ? <div className="alert" role="status">
          <p>This draft is for {draft.employee.full_name} ({draft.source === 'paper' ? 'paper form' : 'your own request'}).
            To change the person or request for yourself, start a new request. Its documents stay with this draft.</p>
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={startNewRequest}>Start a new request</button>
        </div> : null}
        {previousDraft ? <p role="status">New request started. <Link to={`/requests/${previousDraft.id}`}>The draft for {previousDraft.employee.full_name}</Link> is still saved separately. Choose who this new request is for; add its document again if needed.</p> : null}

        {paperMode ? (
          <>
            <div className="field">
              <label className="field-label" htmlFor="paper-employee">Employee</label>
              {draft ? <div className="picker-selected"><strong>{draft.employee.full_name}</strong></div>
                : <PersonPicker people={people} value={employeeId} onChange={setEmployeeId} disabled={!!busy} />}
              <span className="field-hint">
                For someone without a login or who handed in the form on paper.{' '}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!!draft || !!busy}
                  onClick={() => setPaperOn(false)}
                >
                  Request for myself instead
                </button>
              </span>
            </div>
            <Field label="Paper form received on">
              <input
                type="date"
                value={paperDate}
                max={today}
                onChange={(e) => setPaperDate(e.target.value)}
              />
            </Field>
          </>
        ) : null}

        <Field label="Leave type">
          <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(Number(e.target.value))}>
            {leaveTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        {lt?.sensitive ? (
          <p className="field-hint">Only HR sees the reason and documents.</p>
        ) : null}

        <div className="form-grid">
          <Field label="Start date">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>

        {halfDay && singleDay ? <DayParts single startPart={singlePart} endPart={singlePart} prefix="new" onChange={start => setSinglePart(start)} /> : null}
        {halfDay && input && !singleDay ? <Details title="Starts or ends with a half day?" defaultOpen={multiHalf}>
          <DayParts single={false} startPart={firstPart} endPart={lastPart} prefix="new" onChange={(start, end) => { setMultiHalf(true); setFirstPart(start); setLastPart(end); }} />
        </Details> : null}

        {!input ? (
          <p className="field-hint">Pick dates to see how many days this uses.</p>
        ) : null}
        {previewErr ? <ErrBox error={previewErr} /> : null}
        <PreviewBlock preview={preview} pending={previewPending} />

        {lt?.requires_attachment ? <>
          <div className="field">
            <span className="field-label">Document</span>
            <div className={`file-zone${file ? ' has-file' : ''}`}>
              <label className={`dropzone${drag ? ' drag' : ''}${file ? ' has-file' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
            >
              <input
                key={createKey.current}
                type="file"
                className="visually-hidden"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file
                ? `${file.name} · ${fmtBytes(file.size)}`
                : 'Drop a file here, or press to choose one'}
              </label>
              {file ? <button type="button" className="btn btn-ghost btn-sm file-remove" onClick={() => setFile(null)}>Remove</button> : null}
            </div>
            <span className="field-hint">
              PDF, PNG or JPEG.{' '}
              {lt?.requires_attachment ? (
                <>
                  {' '}
                  <Link to="/help#certificate">Why is it needed?</Link>
                </>
              ) : null}
            </span>
          </div>
        </> : <Details title="Add a document" defaultOpen={!!file}>
          <div className="field">
            <span className="field-label">Document</span>
            <div className={`file-zone${file ? ' has-file' : ''}`}>
              <label className={`dropzone${drag ? ' drag' : ''}${file ? ' has-file' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
            >
              <input
                key={createKey.current}
                type="file"
                className="visually-hidden"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file
                ? `${file.name} · ${fmtBytes(file.size)}`
                : 'Drop a file here, or press to choose one'}
              </label>
              {file ? <button type="button" className="btn btn-ghost btn-sm file-remove" onClick={() => setFile(null)}>Remove</button> : null}
            </div>
            <span className="field-hint">
              PDF, PNG or JPEG.{' '}
              {lt?.requires_attachment ? (
                <>
                  {' '}
                  <Link to="/help#certificate">Why is it needed?</Link>
                </>
              ) : null}
            </span>
          </div>
        </Details>}
        <Details title="Add a note" defaultOpen={!!note}>
          <Field label="Note (optional)">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the approver should know…"
            />
          </Field>
        </Details>

        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={!canSend}
            onClick={() => void onSend()}
          >
            {busy === 'send' ? 'Sending…' : 'Send request'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!canDraft}
            onClick={() => void onSaveDraft()}
          >
            {busy === 'draft' ? 'Saving…' : 'Save as draft'}
          </button>
        </div>
        {disabledReason ? <p className="field-hint">{disabledReason}</p> : null}
      </div>
    </div>
  );
}
