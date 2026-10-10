// Dialogs shared by the People list (row ⋯ menu) and the person page.
// Each dialog fetches the full employee record only when the caller does
// not already hold it — the record carries `version`, required by the
// server-side expected_version check on every mutation.

import { useState } from 'react';
import { api, ApiError, post, put } from '../../api/client';
import type {
  EmployeeDetail,
  EmployeeListItem,
  OrgUnit,
  Schedule,
} from '../../api/types';
import { Details, ErrBox, Field, Loading, Modal } from '../../components/ui';
import { nextPatternDate } from '../../lib/domain';
import { fmtDate } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { savePersonChanges } from './edit';

export interface AffectedRequest {
  id: number;
  number: string;
}

interface PersonRef {
  id: number;
  full_name: string;
}

/** Full record from the list row or an already-loaded detail page. */
function useEmployee(id: number, preloaded: EmployeeDetail | null | undefined) {
  const q = useApi(
    () =>
      preloaded
        ? Promise.resolve(preloaded)
        : api<EmployeeDetail>(`/employees/${id}`),
    [id],
  );
  return preloaded ? { data: preloaded, error: null, loading: false } : q;
}

function errOf(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
}

/** The list's common edits share one form and one commit button. */
export function EditPersonDialog({ employeeId, units, people, schedules, today, onClose, onSaved }: {
  employeeId: number; units: OrgUnit[]; people: PersonRef[]; schedules: Schedule[]; today: string;
  onClose: () => void; onSaved: (message: string, affected: AffectedRequest[]) => void;
}) {
  const q = useEmployee(employeeId, null);
  if (q.loading) return <Modal title="Edit person" onClose={onClose}><Loading /></Modal>;
  if (q.error) return <Modal title="Edit person" onClose={onClose}><ErrBox error={q.error} /></Modal>;
  return q.data ? <EditPersonForm employee={q.data} units={units} people={people} schedules={schedules} today={today} onClose={onClose} onSaved={onSaved} /> : null;
}

function EditPersonForm({ employee, units, people, schedules, today, onClose, onSaved }: {
  employee: EmployeeDetail; units: OrgUnit[]; people: PersonRef[]; schedules: Schedule[]; today: string;
  onClose: () => void; onSaved: (message: string, affected: AffectedRequest[]) => void;
}) {
  const [changes, setChanges] = useState({ unitId: employee.org_unit?.id ?? 0, managerId: employee.manager?.id ?? 0, scheduleId: employee.schedule?.id ?? 0, from: nextPatternDate(employee.schedules, today), reassign: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [dateMessage, setDateMessage] = useState('');
  const [partial, setPartial] = useState(false);
  const [affected, setAffected] = useState<AffectedRequest[]>([]);
  const patternChanged = changes.scheduleId !== (employee.schedule?.id ?? 0);
  const minimumDate = nextPatternDate(employee.schedules, today);
  const dateError = patternChanged && changes.from < minimumDate ? `Choose ${fmtDate(minimumDate)} or later — the current work pattern has already started.` : '';
  const changed = changes.unitId !== (employee.org_unit?.id ?? 0) || changes.managerId !== (employee.manager?.id ?? 0) || changes.scheduleId !== (employee.schedule?.id ?? 0);
  async function save() {
    if (busy || partial || !changed || dateError) return;
    setBusy(true); setErr(null); setDateMessage('');
    let saved = false;
    let requests: AffectedRequest[] = [];
    try {
      await savePersonChanges(employee, changes, (_operation, future) => { saved = true; requests = [...requests, ...future]; setAffected(requests); });
      onSaved(`${employee.full_name}: changes saved from ${fmtDate(changes.from)}.`, requests);
    } catch (e) { const error = errOf(e); if (error.message.includes('schedule valid_from must follow')) setDateMessage('The work pattern changed while this form was open. Reload this person and choose a later start date.'); else setErr(error); setPartial(saved); }
    finally { setBusy(false); }
  }
  return <Modal title={`Edit ${employee.full_name}`} onClose={() => { if (!busy) { if (partial) onSaved('Some changes were saved. Check the updated person before editing again.', affected); else onClose(); } }} footer={<>
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => partial ? onSaved('Some changes were saved. Check the updated person before editing again.', affected) : onClose()}>Cancel</button>
    {partial ? <button type="button" className="btn" onClick={() => onSaved('Some changes were saved. Check the updated person before editing again.', affected)}>Reload people</button> : <button type="button" className="btn" disabled={busy || !!dateError || !changed || !changes.unitId || !changes.scheduleId || !changes.from} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>}
  </>}>
    <ErrBox error={err} />
    {partial ? <p role="status">The work pattern was saved, but the assignment could not be saved. Reload people before trying again.</p> : null}
    <fieldset disabled={busy || partial}>
      <legend className="visually-hidden">Assignment and work pattern</legend>
      <Field label="Unit"><select value={changes.unitId} onChange={(e) => setChanges({ ...changes, unitId: Number(e.target.value) })}><option value={0}>Choose a unit</option>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label="Manager"><select value={changes.managerId} onChange={(e) => setChanges({ ...changes, managerId: Number(e.target.value) })}><option value={0}>No manager</option>{people.filter((p) => p.id !== employee.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
      <Field label="Work pattern"><select value={changes.scheduleId} onChange={(e) => setChanges({ ...changes, scheduleId: Number(e.target.value) })}><option value={0}>Choose a work pattern</option>{schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="From" error={dateMessage || dateError} hint={patternChanged ? `The new pattern can start from ${fmtDate(minimumDate)}. Saved hours stay the same; the number of days may change.` : undefined}><input type="date" min={patternChanged ? minimumDate : undefined} value={changes.from} onChange={(e) => setChanges({ ...changes, from: e.target.value })} /></Field>
      <label className="field"><input type="checkbox" checked={changes.reassign} onChange={(e) => setChanges({ ...changes, reassign: e.target.checked })} /> Move open approvals to the new manager</label>
    </fieldset>
  </Modal>;
}

/* ------------------------------------------------------------------ */
/* Change manager or unit                                              */
/* ------------------------------------------------------------------ */

export function TransferDialog({
  employee,
  units,
  people,
  today,
  onClose,
  onSaved,
}: {
  employee: PersonRef & {
    org_unit?: { id: number; name: string } | null | undefined;
    manager?: { id: number } | null | undefined;
  };
  units: OrgUnit[];
  people: { id: number; full_name: string }[];
  today: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [unitId, setUnitId] = useState(employee.org_unit?.id ?? 0);
  const [managerId, setManagerId] = useState(employee.manager?.id ?? 0);
  const [from, setFrom] = useState(today);
  const [reassign, setReassign] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const unitName = units.find((u) => u.id === unitId)?.name;
  const managerName = people.find((p) => p.id === managerId)?.full_name;

  async function save() {
    // A transfer always writes a history row — skip it when nothing changed.
    if (
      unitId === (employee.org_unit?.id ?? 0) &&
      managerId === (employee.manager?.id ?? 0)
    ) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await post(`/employees/${employee.id}/transfer`, {
        org_unit_id: unitId,
        manager_employee_id: managerId || undefined,
        valid_from: from,
        reassign_open_steps: reassign,
      });
      const parts = [
        unitName && unitName !== employee.org_unit?.name ? `unit ${unitName}` : '',
        managerName && managerId !== (employee.manager?.id ?? 0)
          ? `manager ${managerName}`
          : '',
      ].filter(Boolean);
      onSaved(
        parts.length
          ? `${employee.full_name}: ${parts.join(', ')} from ${fmtDate(from)}.`
          : `${employee.full_name}: assignment saved from ${fmtDate(from)}.`,
      );
    } catch (e) {
      setErr(errOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Change manager or unit"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !unitId || !from}
            onClick={() => void save()}
          >
            Save change
          </button>
        </>
      }
    >
      <p className="muted">{employee.full_name}</p>
      <ErrBox error={err} />
      <div className="form-grid">
        <Field label="Unit">
          <select value={unitId} onChange={(e) => setUnitId(Number(e.target.value))}>
            <option value={0}>Choose…</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Manager">
          <select value={managerId} onChange={(e) => setManagerId(Number(e.target.value))}>
            <option value={0}>No manager</option>
            {people
              .filter((p) => p.id !== employee.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <Field label="From" hint="The new assignment starts on this date.">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <label className="field">
        <input
          type="checkbox"
          checked={reassign}
          onChange={(e) => setReassign(e.target.checked)}
        />{' '}
        Move open approvals to the new manager
      </label>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Change work pattern                                                 */
/* ------------------------------------------------------------------ */

export function PatternDialog({
  employeeId,
  detail,
  schedules,
  today,
  onClose,
  onSaved,
}: {
  employeeId: number;
  detail?: EmployeeDetail | null | undefined;
  schedules: Schedule[];
  today: string;
  onClose: () => void;
  onSaved: (message: string, affected: AffectedRequest[]) => void;
}) {
  const q = useEmployee(employeeId, detail);
  const e = q.data;
  const [scheduleId, setScheduleId] = useState(0);
  const [from, setFrom] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  if (e && !prefilled) {
    setScheduleId(e.schedule?.id ?? schedules[0]?.id ?? 0);
    setFrom(nextPatternDate(e.schedules, today));
    setPrefilled(true);
  }

  const scheduleName = schedules.find((s) => s.id === scheduleId)?.name;
  const [dateMessage, setDateMessage] = useState('');

  async function save() {
    if (!e || from < nextPatternDate(e.schedules, today)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ affected_future_requests?: AffectedRequest[] }>(
        `/employees/${e.id}/schedule`,
        { schedule_id: scheduleId, valid_from: from, expected_version: e.version },
      );
      onSaved(
        `${e.full_name}: work pattern changed to ${scheduleName ?? 'the new pattern'} from ${fmtDate(from)}.`,
        r.affected_future_requests ?? [],
      );
    } catch (ex) {
      const error = errOf(ex);
      if (error.message.includes('schedule valid_from must follow')) setDateMessage('The current pattern changed while this form was open. Reload this person and choose a later date.'); else setErr(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Change work pattern"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !e || !scheduleId || !from || from < nextPatternDate(e.schedules, today)}
            onClick={() => void save()}
          >
            Save change
          </button>
        </>
      }
    >
      {q.loading ? <Loading /> : null}
      {q.error ? <ErrBox error={q.error} /> : null}
      {e ? (
        <>
          <ErrBox error={err} />
          <Field label="Work pattern">
            <select value={scheduleId} onChange={(x) => setScheduleId(Number(x.target.value))}>
              {schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From" error={dateMessage || (from < nextPatternDate(e.schedules, today) ? `Choose ${fmtDate(nextPatternDate(e.schedules, today))} or later.` : undefined)} hint="Saved hours stay the same. Days from this date use the new pattern, so the number of days left may change.">
            <input type="date" min={e ? nextPatternDate(e.schedules, today) : undefined} value={from} onChange={(x) => setFrom(x.target.value)} />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* End employment                                                      */
/* ------------------------------------------------------------------ */

export function EndEmploymentDialog({
  employeeId,
  detail,
  today,
  onClose,
  onSaved,
}: {
  employeeId: number;
  detail?: EmployeeDetail | null | undefined;
  today: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const q = useEmployee(employeeId, detail);
  const e = q.data;
  const [lastDay, setLastDay] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  async function save() {
    if (!e) return;
    setBusy(true);
    setErr(null);
    try {
      await put(`/employees/${e.id}`, {
        full_name: e.full_name,
        email: e.email,
        end_date: lastDay,
        active: false,
        expected_version: e.version,
      });
      onSaved(`${e.full_name}'s employment ended ${fmtDate(lastDay)}.`);
    } catch (ex) {
      setErr(errOf(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="End employment"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !e || !lastDay}
            onClick={() => void save()}
          >
            End employment
          </button>
        </>
      }
    >
      {q.loading ? <Loading /> : null}
      {q.error ? <ErrBox error={q.error} /> : null}
      {e ? (
        <>
          <p>
            {e.full_name} stops appearing as an active employee after their last day.
            Requests and history are kept.
          </p>
          <ErrBox error={err} />
          <Field label="Last day of employment">
            <input type="date" value={lastDay} onChange={(x) => setLastDay(x.target.value)} />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Add person                                                          */
/* ------------------------------------------------------------------ */

export function AddPersonDialog({
  units,
  schedules,
  people,
  today,
  onClose,
  onSaved,
}: {
  units: OrgUnit[];
  schedules: Schedule[];
  people: EmployeeListItem[];
  today: string;
  onClose: () => void;
  onSaved: (id: number, name: string) => void;
}) {
  const [f, setF] = useState({
    full_name: '',
    service_id: '',
    org_unit_id: 0,
    manager_employee_id: 0,
    schedule_id: schedules[0]?.id ?? 0,
    start_date: today,
    email: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const ready =
    f.full_name.trim() !== '' &&
    f.service_id.trim() !== '' &&
    f.org_unit_id > 0 &&
    f.schedule_id > 0 &&
    f.start_date !== '';

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ id: number }>('/employees', {
        service_id: f.service_id.trim(),
        full_name: f.full_name.trim(),
        email: f.email.trim() || undefined,
        start_date: f.start_date,
        org_unit_id: f.org_unit_id,
        manager_employee_id: f.manager_employee_id || undefined,
        schedule_id: f.schedule_id,
      });
      onSaved(r.id, f.full_name.trim());
    } catch (e) {
      setErr(errOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add person"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Add person'}
          </button>
        </>
      }
    >
      <ErrBox error={err} />
      <Field label="Name">
        <input
          type="text"
          value={f.full_name}
          onChange={(e) => setF({ ...f, full_name: e.target.value })}
        />
      </Field>
      <div className="form-grid">
        <Field label="Staff number">
          <input
            type="text"
            value={f.service_id}
            onChange={(e) => setF({ ...f, service_id: e.target.value })}
          />
        </Field>
        <Field label="Start date">
          <input
            type="date"
            value={f.start_date}
            onChange={(e) => setF({ ...f, start_date: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Unit">
        <select
          value={f.org_unit_id}
          onChange={(e) => setF({ ...f, org_unit_id: Number(e.target.value) })}
        >
          <option value={0}>Choose…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="Manager">
          <select
            value={f.manager_employee_id}
            onChange={(e) => setF({ ...f, manager_employee_id: Number(e.target.value) })}
          >
            <option value={0}>Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Work pattern">
          <select
            value={f.schedule_id}
            onChange={(e) => setF({ ...f, schedule_id: Number(e.target.value) })}
          >
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Details title="More">
        <Field
          label="Sign-in email (optional)"
          hint="A sign-in is only created when a user account is added later."
        >
          <input
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </Field>
      </Details>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Add / rename a unit                                                 */
/* ------------------------------------------------------------------ */

function deriveCode(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function UnitDialog({
  unit,
  units,
  onClose,
  onSaved,
}: {
  /** null/undefined = add; otherwise rename this unit. */
  unit?: OrgUnit | null | undefined;
  units: OrgUnit[];
  onClose: () => void;
  onSaved: (message: string, id?: number) => void;
}) {
  const [name, setName] = useState(unit?.name ?? '');
  const [parentId, setParentId] = useState(unit?.parent_id ?? 0);
  const [active, setActive] = useState(unit ? Boolean(unit.active) : true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const renaming = unit != null;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (renaming && unit) {
        await put(`/org-units/${unit.id}`, {
          code: unit.code,
          name: name.trim(),
          parent_id: parentId || null,
          active,
          expected_version: unit.version,
        });
        onSaved(`${name.trim()} saved.`, unit.id);
      } else {
        const result = await post<{ id: number }>('/org-units', {
          code: deriveCode(name),
          name: name.trim(),
          parent_id: parentId || null,
        });
        onSaved(`${name.trim()} added.`, result.id);
      }
    } catch (e) {
      setErr(errOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={renaming ? 'Edit unit' : 'Add unit'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || name.trim() === ''}
            onClick={() => void save()}
          >
            {renaming ? 'Save' : 'Add unit'}
          </button>
        </>
      }
    >
      <ErrBox error={err} />
      <Field label="Name">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Inside unit (optional)">
        <select value={parentId ?? 0} onChange={(e) => setParentId(Number(e.target.value))}>
          <option value={0}>Top level</option>
          {units
            .filter((u) => u.id !== unit?.id)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </select>
      </Field>
      {renaming ? (
        <label className="field">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
          Listed as a unit people can join
        </label>
      ) : null}
    </Modal>
  );
}
