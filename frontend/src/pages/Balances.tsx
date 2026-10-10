import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError, newIdempotencyKey, post, unwrapList } from '../api/client';
import type {
  Adjustment,
  BalanceRow,
  BalanceSummary,
  ClosePreview,
  EmployeeDetail,
  EmployeeListItem,
  EmployeeRef,
  LeaveType,
  OrgUnit,
  PolicyVersion,
} from '../api/types';
import { ImportDialog } from '../components/ImportDialog';
import {
  DataTable,
  Details,
  ErrBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  useToast,
} from '../components/ui';
import {
  adjustmentStatusLabel,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtDays,
  orgUnitName,
  plural,
} from '../lib/format';
import {
  fmtBalance,
  accrualPlanFor,
  daysToMinutes,
  IntentKeys,
  policyInForceOn,
  STANDARD_DAY_MINUTES,
} from '../lib/domain';
import { describeError } from '../lib/errors';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

type Adj = Adjustment & { decision_note?: string | null };

interface RunResult {
  typeId: number;
  ok: boolean;
  text: string;
}

function RunResults({ results }: { results: RunResult[] }) {
  return (
    <ul>
      {results.map((r, i) => (
        <li key={i} className={r.ok ? undefined : 'field-error'}>
          {r.text}
        </li>
      ))}
    </ul>
  );
}

/** Keeps a per-type idempotency key only while a result is unconfirmed. */
function resetUnlessNetwork(keys: IntentKeys, intent: string, e: ApiError) {
  if (e.status !== 0) keys.reset(intent);
}

async function allItems<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const result: T[] = [];
  for (;;) {
    const data = await api<unknown>(path, { query: { ...query, limit: 500, offset: result.length } });
    const page = unwrapList<T>(data);
    result.push(...page);
    const total = data && typeof data === 'object' && 'total' in data ? Number(data.total) : result.length;
    if (!page.length || result.length >= total) return result;
  }
}

export default function Balances() {
  const { me, hasRole, config } = useSession();
  const toast = useToast();
  const canEdit = hasRole('hr');
  const isApprover = hasRole('adjustment_approver');
  const businessDate = config?.business_date ?? '';
  const businessYear = Number(businessDate.slice(0, 4));

  const [sp, setSp] = useSearchParams();
  const initialAction = sp.get('action');
  const [q, setQ] = useState('');
  const [unit, setUnit] = useState('');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [asOf, setAsOf] = useState('');
  const [histStatus, setHistStatus] = useState('');
  const [modal, setModal] = useState<'entitlement' | 'close' | null>(initialAction === 'entitlement' || initialAction === 'close' ? initialAction : null);
  const [importKind, setImportKind] = useState<'opening_balances' | 'historical_leave' | null>(
    initialAction === 'opening_balances' || initialAction === 'historical_leave' ? initialAction : null,
  );
  const [correct, setCorrect] = useState<{
    employee: EmployeeRef | null;
    leaveTypeId: number;
    minutesPerDay?: number;
  } | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectErr, setRejectErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [bannerErr, setBannerErr] = useState<ApiError | null>(null);

  const decideKeys = useRef(new IntentKeys());

  const unitsQ = useApi(() => allItems<OrgUnit>('/org-units'), []);
  const typesQ = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const balanceTypes = (typesQ.data ?? [])
    .filter((t) => t.uses_balance || t.policies?.some((p) => p.uses_balance))
    .sort((a, b) => Number(b.uses_balance) - Number(a.uses_balance));
  // Segmented control: the chosen type, defaulting to the first balance type.
  const selTypeId = typeId ?? balanceTypes[0]?.id ?? null;

  const tableQ = useApi(
    () =>
      selTypeId === null
        ? Promise.resolve([] as BalanceRow[])
        : allItems<BalanceRow>('/balances', {
              org_unit_id: unit || undefined,
              leave_type_id: selTypeId,
              date: asOf || undefined,
          })
            .then((rows) => rows.filter((r) => r.summary.leave_type.uses_balance)),
    [unit, selTypeId, asOf],
  );
  const waitingQ = useApi(
    () =>
      allItems<Adj>('/adjustments', { status: 'proposed' }),
    [],
  );
  const histQ = useApi(
    () =>
      allItems<Adj>('/adjustments', { status: histStatus || undefined }),
    [histStatus],
  );

  // Deep link: /balances?employee=<id>&correct=1 opens the Correct dialog.
  useEffect(() => {
    const empId = sp.get('employee');
    if (sp.get('correct') !== '1' || !empId || !/^\d+$/.test(empId) || !canEdit || selTypeId === null) return;
    let cancelled = false;
    api<EmployeeDetail>(`/employees/${empId}`)
      .then((e) => {
        if (cancelled) return;
        setCorrect({
          employee: {
            id: e.id,
            service_id: e.service_id,
            full_name: e.full_name,
            org_unit: e.org_unit,
          },
          leaveTypeId: balanceTypes.find((t) => t.id === Number(sp.get('leave_type_id')))?.id ?? selTypeId,
        });
        setSp(
          (p) => {
            const n = new URLSearchParams(p);
            n.delete('correct');
            return n;
          },
          { replace: true },
        );
      })
      .catch((e: unknown) => { if (!cancelled) setBannerErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e))); });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, canEdit, selTypeId]);

  const rows = (tableQ.data ?? []).filter((r) => {
    if (!q.trim()) return true;
    const needle = q.trim().toLowerCase();
    return (
      r.employee.full_name.toLowerCase().includes(needle) ||
      r.employee.service_id.toLowerCase().includes(needle)
    );
  }).sort((a, b) => a.employee.full_name.localeCompare(b.employee.full_name));
  const anyReserved = rows.some((r) => r.summary.reserved_minutes > 0) || (waitingQ.data ?? []).some(a => a.leave_type.id === selTypeId);

  const waiting = waitingQ.data ?? [];
  const waitingForMe = waiting.filter((a) => a.proposed_by.id !== me?.user.id);
  const waitingFromMe = waiting.filter((a) => a.proposed_by.id === me?.user.id);

  function reloadAll() {
    tableQ.reload();
    waitingQ.reload();
    histQ.reload();
  }

  async function decide(a: Adj, decision: 'apply' | 'reject', note: string) {
    setBusy(true);
    setBannerErr(null);
    const intent = JSON.stringify([decision, a.id, note]);
    try {
      await post(
        `/adjustments/${a.id}/decide`,
        { decision, note },
        decideKeys.current.forIntent(intent),
      );
      decideKeys.current.reset(intent);
      toast(
        decision === 'apply'
          ? `Correction approved for ${a.employee.full_name}.`
          : `Correction refused for ${a.employee.full_name}.`,
      );
      setRejecting(null);
      setRejectNote('');
      reloadAll();
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      resetUnlessNetwork(decideKeys.current, intent, ae);
      setBannerErr(ae);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Balances"
        primary={
          canEdit ? (
            <>
              <button type="button" className="btn" disabled={selTypeId === null || !businessDate} onClick={() => {
                if (selTypeId !== null) setCorrect({ employee: null, leaveTypeId: selTypeId });
              }}>Correct balance…</button>
            </>
          ) : undefined
        }
        secondary={canEdit ? <>
          <button className="btn btn-secondary" onClick={() => setModal('entitlement')}>Add entitlement…</button>
          <button className="btn btn-secondary" onClick={() => setModal('close')}>Close year…</button>
        </> : undefined}
        more={canEdit ? [
          { label: 'Import opening balances…', onSelect: () => setImportKind('opening_balances') },
          { label: 'Import past leave…', onSelect: () => setImportKind('historical_leave') },
        ] : undefined}
      />
      {bannerErr ? <ErrBox error={bannerErr} /> : null}
      {waitingQ.error ? <ErrBox error={waitingQ.error} /> : null}

      {isApprover && waitingForMe.length > 0 ? (
        <section className="panel" aria-label="Corrections waiting for you">
          <h2>Waiting for you</h2>
          {waitingForMe.map((a) => (
            <div className="msg" key={a.id}>
              <p>
                <strong>{a.employee.full_name}</strong> · {a.leave_type.name} {a.period_year} ·{' '}
                <strong>
                  {a.minutes > 0 ? '+' : ''}
                  {fmtDuration(a.minutes, a.minutes_per_day || 480)}
                </strong>{' '}
                · {a.reason}
                {a.basis_document ? ` (${a.basis_document})` : ''} · proposed by{' '}
                {a.proposed_by.display_name}
              </p>
              {rejecting === a.id ? (
                <>
                  <Field label="Reason for the refusal (required)" error={rejectErr}>
                    <input
                      type="text"
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                    />
                  </Field>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={() => {
                        if (!rejectNote.trim()) {
                          setRejectErr('Add a reason.');
                          return;
                        }
                        void decide(a, 'reject', rejectNote.trim());
                      }}
                    >
                      Refuse correction
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setRejecting(null);
                        setRejectErr('');
                      }}
                    >
                      Back
                    </button>
                  </div>
                </>
              ) : (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void decide(a, 'apply', '')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setRejecting(a.id);
                      setRejectNote('');
                      setRejectErr('');
                    }}
                  >
                    Refuse…
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      ) : null}
      {waitingFromMe.length > 0 ? (
        <p className="muted">
          {plural(waitingFromMe.length, 'correction')} waiting for approval.
        </p>
      ) : null}

      <section className="panel">
        {typesQ.error ? <ErrBox error={typesQ.error} /> : null}
        {unitsQ.error ? <ErrBox error={unitsQ.error} /> : null}
        <div className="toolbar">
          <Field label="Find a person">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name or staff number"
            />
          </Field>
          <Field label="Unit">
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="">All units</option>
              {unitsQ.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {orgUnitName(u.name)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {balanceTypes.length ? (
          <div className="tabs" role="group" aria-label="Leave type">
            {balanceTypes.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.id === selTypeId ? 'active' : ''}
                aria-pressed={t.id === selTypeId}
                onClick={() => setTypeId(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
        ) : null}

        {asOf ? <p className="muted small">Showing balances on {fmtDate(asOf)}.</p> : null}

        {tableQ.loading ? <Loading /> : null}
        {tableQ.error ? <ErrBox error={tableQ.error} /> : null}
        {tableQ.data && !tableQ.loading ? (
          <DataTable<BalanceRow>
            columns={[
              { label: 'Person', title: true, render: (r) => r.employee.full_name },
              {
                label: 'Unit',
                render: (r) =>
                  r.employee.org_unit ? orgUnitName(r.employee.org_unit.name) : '—',
              },
              {
                label: 'Days left',
                className: 'num',
                render: (r) => (
                  <strong>
                    {fmtBalance(r.summary.available_minutes, r.summary.minutes_per_day)}
                  </strong>
                ),
              },
              ...(anyReserved
                ? [
                    {
                      label: 'On hold for requests',
                      className: 'num',
                      render: (r: BalanceRow) => <>
                        {r.summary.reserved_minutes ? fmtDuration(r.summary.reserved_minutes, r.summary.minutes_per_day) : '—'}
                        {waiting.filter(a => a.employee.id === r.employee.id && a.leave_type.id === selTypeId).map(a => <div className="small muted" key={a.id}>{a.minutes > 0 ? '+' : ''}{fmtDuration(a.minutes, a.minutes_per_day)} (correction waiting)</div>)}
                      </>,
                    },
                  ]
                : []),
              ...(canEdit
                ? [
                    {
                      label: '',
                      render: (r: BalanceRow) => (
                        <span
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <button className="btn btn-secondary btn-sm" onClick={() => selTypeId !== null && setCorrect({ employee: r.employee, leaveTypeId: selTypeId, minutesPerDay: r.summary.minutes_per_day })}>Correct…</button>
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
            rows={rows}
            rowLink={(r) =>
              `/balances/${r.employee.id}/explain?leave_type_id=${r.summary.leave_type.id}${asOf ? `&date=${asOf}` : ''}`
            }
            empty={
              typesQ.loading
                ? 'Loading…'
                : balanceTypes.length
                  ? 'No balances match these filters.'
                  : 'No balances to show.'
            }
          />
        ) : null}

        <Details title="Show balances on another date">
          <div className="toolbar">
            <Field label="On date">
              <input
                type="date"
                value={asOf || businessDate}
                onChange={(e) =>
                  setAsOf(e.target.value === businessDate ? '' : e.target.value)
                }
              />
            </Field>
            {asOf ? (
              <button type="button" className="btn btn-ghost" onClick={() => setAsOf('')}>
                Back to today
              </button>
            ) : null}
          </div>
        </Details>
      </section>

      <section className="panel">
        <Details title="Corrections history" count={histQ.data?.length}>
          <div className="toolbar">
            <Field label="Status">
              <select value={histStatus} onChange={(e) => setHistStatus(e.target.value)}>
                <option value="">All</option>
                <option value="proposed">Waiting for approval</option>
                <option value="applied">Applied</option>
                <option value="rejected">Refused</option>
              </select>
            </Field>
          </div>
          {histQ.loading ? <Loading /> : null}
          {histQ.error ? <ErrBox error={histQ.error} /> : null}
          {histQ.data ? (
            <DataTable<Adj>
              columns={[
                { label: 'Person', title: true, render: (a) => a.employee.full_name },
                {
                  label: 'Type',
                  render: (a) => (
                    <>
                      {a.leave_type.name} <span className="muted">{a.period_year}</span>
                    </>
                  ),
                },
                {
                  label: 'Change',
                  className: 'num',
                  render: (a) => (
                    <>
                      {a.minutes > 0 ? '+' : ''}
                      {fmtDuration(a.minutes, a.minutes_per_day || 480)}
                    </>
                  ),
                },
                {
                  label: 'Reason',
                  render: (a) => (
                    <>
                      {a.reason}
                      {a.basis_document ? (
                        <div className="muted small">{a.basis_document}</div>
                      ) : null}
                    </>
                  ),
                },
                {
                  label: 'Proposed by',
                  render: (a) => (
                    <>
                      {a.proposed_by.display_name}
                      <div className="muted small">{fmtDateTime(a.created_at)}</div>
                    </>
                  ),
                },
                {
                  label: 'Decision',
                  render: (a) =>
                    a.status === 'proposed' ? (
                      <span className="muted">{adjustmentStatusLabel(a.status)}</span>
                    ) : (
                      <>
                        {adjustmentStatusLabel(a.status)}
                        {a.decided_by ? ` by ${a.decided_by.display_name}` : ''}
                        {a.decided_at ? ` · ${fmtDateTime(a.decided_at)}` : ''}
                        {a.decision_note ? (
                          <div className="muted small">{a.decision_note}</div>
                        ) : null}
                      </>
                    ),
                },
              ]}
              rows={histQ.data}
              empty="No corrections here."
            />
          ) : null}
        </Details>
      </section>

      {correct ? (
        <CorrectDialog
          employee={correct.employee}
          types={balanceTypes}
          initialTypeId={correct.leaveTypeId}
          initialMinutesPerDay={correct.minutesPerDay}
          businessYear={businessYear}
          onClose={() => setCorrect(null)}
          onDone={reloadAll}
        />
      ) : null}
      {modal === 'entitlement' ? (
        <EntitlementDialog
          types={typesQ.data ?? []}
          businessDate={businessDate}
          onClose={() => setModal(null)}
          onDone={reloadAll}
        />
      ) : null}
      {modal === 'close' ? (
        <CloseYearDialog
          types={typesQ.data ?? []}
          businessDate={businessDate}
          onClose={() => setModal(null)}
          onDone={reloadAll}
        />
      ) : null}
      {importKind ? (
        <ImportDialog
          kind={importKind}
          onClose={() => setImportKind(null)}
          onDone={reloadAll}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Correct balance                                                     */
/* ------------------------------------------------------------------ */

export function CorrectDialog({
  employee,
  types,
  initialTypeId,
  initialMinutesPerDay,
  businessYear,
  onClose,
  onDone,
}: {
  employee: EmployeeRef | null;
  types: LeaveType[];
  initialTypeId: number;
  initialMinutesPerDay?: number | undefined;
  businessYear: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [person, setPerson] = useState(employee);
  const [leaveTypeId, setLeaveTypeId] = useState(initialTypeId);
  const [year, setYear] = useState(businessYear);
  const [dir, setDir] = useState<'add' | 'remove'>('add');
  const [days, setDays] = useState('1');
  const [amountUnit, setAmountUnit] = useState<'days' | 'hours'>('days');
  const [reason, setReason] = useState('');
  const [basis, setBasis] = useState('');
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(newIdempotencyKey());
  const peopleQ = useApi(() => employee ? Promise.resolve([] as EmployeeListItem[]) : allItems<EmployeeListItem>('/employees', { include_inactive: 1 }), [employee]);

  // The day length for the ±days conversion comes from the person's own
  // balance summary (their work pattern), not a global constant.
  const balQ = useApi(
    () => person ? api<BalanceSummary[]>(`/balances/${person.id}`).then((summaries) => ({ employeeId: person.id, summaries })) : Promise.resolve(null),
    [person?.id],
  );
  const mpd = leaveTypeId === initialTypeId && initialMinutesPerDay
    ? initialMinutesPerDay
    : balQ.data?.employeeId === person?.id ? balQ.data?.summaries.find((s) => s.leave_type.id === leaveTypeId)?.minutes_per_day : undefined;

  async function submit() {
    if (busy || !mpd || !person) return;
    const daysNum = Number(days);
    const fe: Record<string, string> = {};
    const amountMinutes = amountUnit === 'hours' ? daysNum * 60 : daysToMinutes(daysNum, mpd);
    if (!Number.isFinite(daysNum) || daysNum <= 0 || (amountUnit === 'days' && !Number.isInteger(daysNum * 2)) || !Number.isSafeInteger(amountMinutes)) fe['days'] = amountUnit === 'days' ? 'Enter an amount in half-day steps, such as ½ or 1 day.' : 'Enter hours that make a whole number of minutes.';
    if (!reason.trim()) fe['reason'] = 'Add a reason.';
    if (!basis.trim()) fe['basis'] = 'Add the document this is based on.';
    if (!Number.isInteger(year) || year < 2000 || year > 2100) fe['year'] = 'Enter a year from 2000 to 2100.';
    setFieldErr(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setErr(null);
    try {
      const minutes = (dir === 'add' ? 1 : -1) * amountMinutes;
      await post(
        '/adjustments',
        {
          employee_id: person.id,
          leave_type_id: leaveTypeId,
          period_year: year,
          minutes,
          reason: reason.trim(),
          basis_document: basis.trim(),
        },
        keyRef.current,
      );
      toast('Correction sent for approval.');
      onDone();
      onClose();
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (ae.status !== 0) keyRef.current = newIdempotencyKey();
      setErr(ae);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Correct balance"
      onClose={() => { if (!busy) onClose(); }}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={busy || !mpd} onClick={() => void submit()}>
            {busy ? 'Sending…' : 'Send for approval'}
          </button>
        </>
      }
    >
      {employee ? <p><strong>{employee.full_name}</strong>{employee.org_unit ? <span className="muted"> · {orgUnitName(employee.org_unit.name)}</span> : null}</p> :
        <Field label="Person (required)"><select disabled={busy || peopleQ.loading} value={person?.id ?? ''} onChange={(e) => {
          keyRef.current = newIdempotencyKey();
          setPerson(peopleQ.data?.find((p) => p.id === Number(e.target.value)) ?? null);
        }}><option value="">Choose a person</option>{peopleQ.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>}
      {peopleQ.error ? <ErrBox error={peopleQ.error} /> : null}
      <p className="muted small">Another HR officer must approve this.</p>
      {err ? <ErrBox error={err} /> : null}
      {balQ.error ? <ErrBox error={balQ.error} /> : null}
      {person && !mpd && balQ.loading ? <Loading label="Loading this person's work pattern…" /> : null}
      <div className="form-grid">
        <Field label="Leave type">
          <select disabled={busy} value={leaveTypeId} onChange={(e) => { keyRef.current = newIdempotencyKey(); setLeaveTypeId(Number(e.target.value)); }}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Year" error={fieldErr['year']}>
          <input type="number" min={2000} max={2100} step={1} disabled={busy} value={year} onChange={(e) => { keyRef.current = newIdempotencyKey(); setYear(Number(e.target.value)); }} />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Change">
          <select disabled={busy} value={dir} onChange={(e) => { keyRef.current = newIdempotencyKey(); setDir(e.target.value as 'add' | 'remove'); }}>
            <option value="add">Add days</option>
            <option value="remove">Remove days</option>
          </select>
        </Field>
        <Field label={amountUnit === 'days' ? 'Days' : 'Hours'} hint={amountUnit === 'days' ? 'In half-day steps.' : 'For a correction shorter than half a day.'} error={fieldErr['days']}>
          <input
            type="number"
            disabled={busy}
            min={amountUnit === 'days' ? 0.5 : 1 / 60}
            step={amountUnit === 'days' ? 0.5 : 'any'}
            value={days}
            onChange={(e) => { keyRef.current = newIdempotencyKey(); setDays(e.target.value); }}
          />
        </Field>
      </div>
      <Details title="Use hours instead"><Field label="Amount in"><select value={amountUnit} onChange={(e) => { keyRef.current = newIdempotencyKey(); setAmountUnit(e.target.value as 'days' | 'hours'); }}><option value="days">Days</option><option value="hours">Hours</option></select></Field></Details>
      <Field label="Reason (required)" error={fieldErr['reason']}>
        <input type="text" disabled={busy} value={reason} onChange={(e) => { keyRef.current = newIdempotencyKey(); setReason(e.target.value); }} />
      </Field>
      <Field
        label="Reference document (required)"
        hint="e.g. the paper form number"
        error={fieldErr['basis']}
      >
        <input type="text" disabled={busy} value={basis} onChange={(e) => { keyRef.current = newIdempotencyKey(); setBasis(e.target.value); }} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Add entitlement (was: run accrual)                                  */
/* ------------------------------------------------------------------ */

function EntitlementDialog({
  types,
  businessDate,
  onClose,
  onDone,
}: {
  types: LeaveType[];
  businessDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const businessYear = Number(businessDate.slice(0, 4));
  const businessMonth = Number(businessDate.slice(5, 7));
  const balanceTypes = types.filter((t) => t.uses_balance || t.policies?.some((p) => p.uses_balance));
  const [year, setYear] = useState(businessYear);
  const [month, setMonth] = useState(businessMonth || 1);
  const [chooseNext, setChooseNext] = useState(true);
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(balanceTypes.filter(t => !!accrualPlanFor(t, businessYear, businessMonth || 1)).map((t) => t.id)));
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const keys = useRef(new IntentKeys());

  const plans = balanceTypes.map((t) => ({ t, plan: accrualPlanFor(t, year, month) }));
  const isRunnable = (p: (typeof plans)[number]) =>
    !!p.plan && businessDate >= p.plan.runnableFrom;
  const preview = useApi(async () => ({ year, month, items: Object.fromEntries(await Promise.all(plans.filter(p => p.plan).map(async ({ t, plan }) => {
    const value = await api<{ eligible: number; skipped_existing: number; entitlement_minutes: number }>('/accruals/preview', { query: { leave_type_id: t.id, period_year: year, ...(plan?.kind === 'monthly' ? { month } : {}) } });
    return [t.id, value] as const;
  }))) }), [year, month]);
  useEffect(() => {
    if (!chooseNext || preview.loading || !preview.data || preview.data.year !== year || preview.data.month !== month || preview.error) return;
    const values = Object.values(preview.data.items);
    if (values.length && values.every(p => p.eligible === 0) && values.some(p => p.skipped_existing > 0) && year < 2100) {
      setYear(year + 1);
    } else {
      setChooseNext(false);
      setTicked(new Set(plans.filter(p => p.plan && isRunnable(p)).map(p => p.t.id)));
    }
  }, [chooseNext, preview.data, preview.loading, preview.error, year]);
  const previewReady = !preview.loading && preview.data?.year === year && preview.data?.month === month && !preview.error;
  // Keep month selection reachable when a monthly rule starts later in the year.
  const needsMonth = balanceTypes.some((t) => ticked.has(t.id) &&
    MONTH_NAMES.some((_, i) => accrualPlanFor(t, year, i + 1)?.kind === 'monthly'));
  const anyRunnable = plans.some((p) => ticked.has(p.t.id) && isRunnable(p));
  const periodLabel = needsMonth ? `${MONTH_NAMES[month - 1]} ${year}` : `${year}`;
  const warnEarly = plans.some(
    (p) => ticked.has(p.t.id) && isRunnable(p) && p.plan?.kind === 'annual' && year > businessYear,
  );

  async function run() {
    if (busy || !previewReady || chooseNext) return;
    setBusy(true);
    const out: RunResult[] = results?.filter((r) => r.ok) ?? [];
    for (const { t, plan } of plans) {
      if (!ticked.has(t.id) || !plan || businessDate < plan.runnableFrom) continue;
      if (out.some((r) => r.typeId === t.id)) continue;
      const intent = `accrual:${t.id}:${year}:${plan.kind === 'monthly' ? month : 'annual'}`;
      try {
        const r = await post<{ posted?: number; skipped_existing?: number }>(
          '/accruals/run',
          {
            leave_type_id: t.id,
            period_year: year,
            ...(plan.kind === 'monthly' ? { month } : {}),
          },
          keys.current.forIntent(intent),
        );
        keys.current.reset(intent);
        const period = plan.kind === 'monthly' ? `${MONTH_NAMES[month - 1]} ${year}` : `${year}`;
        out.push({
          typeId: t.id,
          ok: true,
          text: r.posted === 0 ? `${t.name} — Everyone already has the ${period} entitlement.` : `${t.name} — added the ${period} entitlement for ${plural(r.posted ?? 0, 'person', 'people')} (${r.skipped_existing ?? 0} already had it).`,
        });
      } catch (e) {
        const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
        resetUnlessNetwork(keys.current, intent, ae);
        out.push({ typeId: t.id, ok: false, text: `${t.name} — ${describeError(ae).message}` });
      }
    }
    setResults(out);
    setBusy(false);
    if (out.some((r) => r.ok) && out.some(r => r.text.includes('added the'))) toast(out.some((r) => !r.ok) ? 'Some entitlements were added. Check the remaining leave types.' : `Entitlements added for ${periodLabel}.`);
    onDone();
  }

  return (
    <Modal
      title="Add entitlement"
      onClose={() => { if (!busy) onClose(); }}
      footer={
        results ? (
          <>
            <button type="button" className={results.some((r) => !r.ok) ? 'btn btn-ghost' : 'btn'} disabled={busy} onClick={onClose}>Done</button>
            {results.some((r) => !r.ok) ? <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{busy ? 'Adding…' : 'Retry remaining types'}</button> : null}
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !anyRunnable || !previewReady || chooseNext}
              onClick={() => void run()}
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </>
        )
      }
    >
      {results ? (
        <RunResults results={results} />
      ) : (
        <>
          <p className="muted small">
            Adds the entitlement for the chosen period to everyone entitled. People who already
            have it are skipped.
          </p>
          <div className="form-grid">
            <Field label="Year">
              <input
                type="number"
                disabled={busy}
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => { setChooseNext(false); setYear(Number(e.target.value)); }}
              />
            </Field>
            {needsMonth ? (
              <Field label="Month">
                <select disabled={busy} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                  {MONTH_NAMES.map((name, i) => (
                    <option key={i + 1} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
          {!previewReady && !preview.error || chooseNext && !preview.error ? <Loading label="Checking who already has this entitlement…" /> : null}
          <ErrBox error={preview.error} />
          {previewReady && !chooseNext && preview.data ? <ul className="sum-list">{plans.filter(p => ticked.has(p.t.id) && isRunnable(p)).map(({t}) => {
            const p = preview.data?.items[t.id];
            return p ? <li key={t.id}>{p.eligible ? `Adds ${fmtDuration(p.entitlement_minutes)} ${t.name} to ${plural(p.eligible, 'person', 'people')}. ${p.skipped_existing} already have it and will be skipped.` : `Everyone already has the ${periodLabel} entitlement for ${t.name}.`}</li> : null;
          })}</ul> : null}
          <fieldset disabled={busy}>
            <legend>Leave types</legend>
            {plans.map(({ t, plan }) => {
              const runnable = isRunnable({ t, plan });
              const hint = !plan
                ? `Nothing adds days for ${periodLabel}`
                : !runnable
                  ? `Available from ${fmtDate(plan!.runnableFrom)}`
                  : '';
              return (
                <div key={t.id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!runnable}
                      checked={runnable && ticked.has(t.id)}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if (e.target.checked) next.add(t.id);
                        else next.delete(t.id);
                        setTicked(next);
                      }}
                    />{' '}
                    {t.name}
                    {hint ? <span className="muted small"> — {hint}</span> : null}
                  </label>
                </div>
              );
            })}
          </fieldset>
          {warnEarly ? (
            <ul className="warn-list">
              <li>This makes {year} days available now.</li>
            </ul>
          ) : null}
          {!anyRunnable ? (
            <p className="muted">Nothing to add for {periodLabel} yet.</p>
          ) : null}
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Close year (was: close period)                                      */
/* ------------------------------------------------------------------ */

function closeSentence(name: string, policy: PolicyVersion | null, year: number): string {
  const next = year + 1;
  if (!policy) return `${name} — no rules for ${year} yet; skipped.`;
  if (!policy.uses_balance) return `${name} — does not use a yearly allowance in ${year}; skipped.`;
  if (!policy.carryover_allowed) return `${name} — unused days are removed.`;
  const expiry = policy.carryover_expiry_months;
  const expiryText =
    expiry === null
      ? ''
      : expiry === 0
        ? ` and expire at the start of ${next}`
        : ` and expire after ${plural(expiry, 'month')}`;
  if (policy.carryover_limit_min !== null) {
    return `${name} — up to ${fmtDuration(policy.carryover_limit_min, STANDARD_DAY_MINUTES)} carry over to ${next}${expiryText}; the rest is removed.`;
  }
  return `${name} — unused days carry over to ${next}${expiryText}.`;
}

function CloseYearDialog({
  types,
  businessDate,
  onClose,
  onDone,
}: {
  types: LeaveType[];
  businessDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const businessYear = Number(businessDate.slice(0, 4));
  const balanceTypes = types.filter((t) => t.uses_balance || t.policies?.some((p) => p.uses_balance));
  const [year, setYear] = useState(businessYear - 1);
  const [previews, setPreviews] = useState<ClosePreview[]>([]);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const keys = useRef(new IntentKeys());

  const ended = Number.isInteger(year) && year >= 2000 && year <= businessYear && `${year}-12-31` < businessDate;
  const lines = balanceTypes.map((t) => ({
    t,
    policy: policyInForceOn(t, `${year}-12-31`),
  }));
  const postable = lines.filter((l) => l.policy?.uses_balance);

  useEffect(() => {
    let active = true;
    setPreviews([]);
    setPreviewError(null);
    setPreviewLoading(ended);
    if (ended) {
      const eligible = types.filter(t => policyInForceOn(t, `${year}-12-31`)?.uses_balance);
      void Promise.all(eligible.map(t => api<ClosePreview>('/periods/close', {
        query: { leave_type_id: t.id, period_year: year },
      }))).then(data => {
        if (active) setPreviews(data);
      }).catch((e: unknown) => {
        if (active) setPreviewError(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
      }).finally(() => { if (active) setPreviewLoading(false); });
    }
    return () => { active = false; };
  }, [types, year, ended, businessDate]);

  const unclosed = postable.filter(l => previews.some(p => p.period_year === year && p.leave_type_id === l.t.id && !p.already_closed));

  async function run() {
    if (busy || !ended || !confirm || previewLoading || previewError || !unclosed.length) return;
    setBusy(true);
    const out: RunResult[] = results?.filter((r) => r.ok) ?? [];
    for (const { t } of unclosed) {
      if (out.some((r) => r.typeId === t.id)) continue;
      const intent = `close:${t.id}:${year}`;
      try {
        const result = await post<{ posted: number }>(
          '/periods/close',
          { leave_type_id: t.id, period_year: year },
          keys.current.forIntent(intent),
        );
        keys.current.reset(intent);
        out.push({ typeId: t.id, ok: true, text: result.posted === 0 ? `${t.name} — no balance changes for ${year}.` : `${t.name} — ${year} closed.` });
      } catch (e) {
        const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
        resetUnlessNetwork(keys.current, intent, ae);
        out.push({ typeId: t.id, ok: false, text: `${t.name} — ${describeError(ae).message}` });
      }
    }
    setResults(out);
    setBusy(false);
    if (out.some((r) => r.ok) && out.some(r => r.text.includes('added the'))) toast(out.some((r) => !r.ok) ? 'Some leave types were closed. Check the remaining types.' : out.every(r => r.text.includes('no balance changes')) ? 'No balance changes.' : `${year} closed.`);
    onDone();
  }

  return (
    <Modal
      title={`Close ${year}`}
      onClose={() => { if (!busy) onClose(); }}
      footer={
        results ? (
          <>
            <button type="button" className={results.some((r) => !r.ok) ? 'btn btn-ghost' : 'btn'} disabled={busy} onClick={onClose}>Done</button>
            {results.some((r) => !r.ok) ? <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{busy ? 'Closing…' : 'Retry remaining types'}</button> : null}
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !ended || !confirm || previewLoading || !!previewError || !unclosed.length}
              onClick={() => void run()}
            >
              {busy ? 'Closing…' : `Close ${year}`}
            </button>
          </>
        )
      }
    >
      {results ? (
        <RunResults results={results} />
      ) : (
        <>
          <Field label="Year to close">
            <input type="number" min={2000} max={businessYear} step={1} disabled={busy} value={year} onChange={(e) => { setYear(Number(e.target.value)); setConfirm(false); }} />
          </Field>
          {!ended ? (
            <p className="alert alert-info">
              {year} has not ended yet — you can only close a finished year.
            </p>
          ) : null}
          <p className="muted small">For each leave type:</p>
          <ul>
            {lines.map((l) => (
              <li key={l.t.id}>{closeSentence(l.t.name, l.policy, year)}</li>
            ))}
            {!lines.length ? <li>No leave types use balances.</li> : null}
          </ul>
          {previewLoading ? <Loading /> : null}
          {previewError ? <ErrBox error={previewError} /> : null}
          {previews.map(preview => <section key={preview.leave_type_id}>
            <h3>{types.find(t => t.id === preview.leave_type_id)?.name}</h3>
            {preview.already_closed ? <p>Already closed</p> : null}
            <DataTable rows={preview.items} empty="No balances for this year." columns={[
              { label: 'Person', render: row => <>{row.full_name}{row.already_closed ? ' · Already closed' : ''}</> },
              { label: 'Days left', render: row => fmtDays(row.left_minutes, row.minutes_per_day) },
              { label: 'Carries over', render: row => fmtDays(row.carried_minutes, row.minutes_per_day) },
              { label: 'Removed', render: row => fmtDays(row.removed_minutes, row.minutes_per_day) },
            ]} />
          </section>)}
          <div>
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />{' '}
              I understand the carry-over rules above.
            </label>
          </div>
        </>
      )}
    </Modal>
  );
}
