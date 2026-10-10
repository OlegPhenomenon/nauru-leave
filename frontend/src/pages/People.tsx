import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, unwrapList } from '../api/client';
import type { EmployeeDetail, EmployeeListItem, OrgUnit, Schedule } from '../api/types';
import { ImportDialog } from '../components/ImportDialog';
import {
  type Column,
  DataTable,
  EmptyState,
  ErrBox,
  Field,
  Loading,
  Menu,
  PageHeader,
  Tag,
  useToast,
} from '../components/ui';
import { orgUnitName } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import {
  AddPersonDialog,
  EndEmploymentDialog,
  EditPersonDialog,
  PatternDialog,
  TransferDialog,
  UnitDialog,
} from './people/dialogs';
import './People.css';

type Dialog =
  | { kind: 'edit' | 'transfer' | 'pattern' | 'end'; employee: EmployeeListItem }
  | { kind: 'unit'; unit: OrgUnit | null }
  | null;

export default function People() {
  const { hasRole, config } = useSession();
  const canEdit = hasRole('hr');
  const today = config?.business_date ?? '';
  const navigate = useNavigate();
  const toast = useToast();

  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'units' ? 'units' : 'people';
  const q = sp.get('q') ?? '';
  const unit = sp.get('unit') ?? '';
  const former = sp.get('former') === '1';
  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setSp(next, { replace: true });
  };

  const [dialog, setDialog] = useState<Dialog>(sp.get('action') === 'add-unit' ? { kind: 'unit', unit: null } : null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [affected, setAffected] = useState<{ id: number; number: string }[]>([]);

  const unitsQ = useApi(
    () => api<unknown>('/org-units').then((d) => unwrapList<OrgUnit>(d)),
    [],
  );
  const schedulesQ = useApi(
    () => api<unknown>('/schedules').then((d) => unwrapList<Schedule>(d)),
    [],
  );
  // The manager dropdown and unit counts need everyone, not the filtered rows.
  const allQ = useApi(
    () => api<unknown>('/employees').then((d) => unwrapList<EmployeeListItem>(d)),
    [],
  );
  const listQ = useApi(
    () =>
      api<unknown>('/employees', {
        query: {
          q: q || undefined,
          org_unit_id: unit || undefined,
          include_inactive: former || undefined,
        },
      }).then((d) => unwrapList<EmployeeListItem>(d)),
    [q, unit, former],
  );

  const units = unitsQ.data ?? [];
  const activeUnits = units.filter((u) => u.active);
  const schedules = schedulesQ.data ?? [];
  const everyone = allQ.data ?? [];

  /** Row actions that need the linked user account (stand-in, access). */
  async function goForUser(employeeId: number, make: (userId: number) => string) {
    try {
      const d = await api<EmployeeDetail>(`/employees/${employeeId}`);
      if (d.user) navigate(make(d.user.id));
      else toast('This person has no sign-in.', 'info');
    } catch {
      toast('Could not open that. Try again.', 'err');
    }
  }

  const rowMenu = (e: EmployeeListItem) => (
    <span onClick={(ev) => ev.stopPropagation()}>
      <Menu
        className="row-menu"
        label={
          <>
            ⋯
          </>
        }
        align="end"
        items={[
          { label: 'Change manager or unit…', onSelect: () => setDialog({ kind: 'transfer', employee: e }) },
          { label: 'Change work pattern…', onSelect: () => setDialog({ kind: 'pattern', employee: e }) },
          { label: 'Correct balance…', to: `/balances?employee=${e.id}&correct=1` },
          e.has_login
            ? {
                label: 'Set stand-in…',
                onSelect: () => void goForUser(e.id, (u) => `/settings/delegations?new=1&for=${u}`),
              }
            : { label: 'Set stand-in…', disabled: true, hint: 'No sign-in' },
          e.has_login
            ? { label: 'Access…', onSelect: () => void goForUser(e.id, (u) => `/settings/users?user=${u}`) }
            : { label: 'Access…', disabled: true, hint: 'No sign-in' },
          { label: 'Enter paper form…', to: `/requests/new?employee=${e.id}` },
          { label: '', divider: true },
          e.active
            ? { label: 'End employment…', danger: true, onSelect: () => setDialog({ kind: 'end', employee: e }) }
            : { label: 'End employment…', disabled: true },
        ]}
      />
    </span>
  );

  const peopleColumns: Column<EmployeeListItem>[] = [
    {
      label: 'Name',
      title: true,
      render: (e) => (
        <>
          {e.full_name}{' '}
          {e.active ? null : <Tag>Left{e.end_date ? ` ${e.end_date.slice(0, 4)}` : ''}</Tag>}
          <div className="muted small">{e.service_id}</div>
        </>
      ),
    },
    { label: 'Unit', render: (e) => (e.org_unit ? orgUnitName(e.org_unit.name) : '—') },
    { label: 'Manager', render: (e) => e.manager?.full_name ?? '—' },
    { label: 'Work pattern', render: (e) => e.schedule?.name ?? '—' },
    ...(canEdit
      ? [{ label: '', className: 'row-actions nowrap', render: (e: EmployeeListItem) => <span className="btn-row" onClick={(ev) => ev.stopPropagation()}><button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'edit', employee: e })}>Edit…</button>{rowMenu(e)}</span> } satisfies Column<EmployeeListItem>]
      : []),
  ];

  const unitColumns: Column<OrgUnit>[] = [
    {
      label: 'Name',
      title: true,
      render: (u) => (
        <>
          <span className={sp.get('highlight') === String(u.id) ? 'unit-added' : ''}>{orgUnitName(u.name)}</span> {u.active ? null : <Tag>Not in use</Tag>}
        </>
      ),
    },
    {
      label: 'Inside',
      render: (u) => {
        const p = units.find((x) => x.id === u.parent_id);
        return p ? orgUnitName(p.name) : '—';
      },
    },
    {
      label: 'People',
      className: 'num',
      render: (u) => everyone.filter((e) => e.org_unit?.id === u.id).length,
    },
    ...(canEdit
      ? [
          {
            label: '',
            className: 'nowrap',
            render: (u: OrgUnit) => (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-label={`Edit ${u.name}`}
                onClick={() => setDialog({ kind: 'unit', unit: u })}
              >
                Edit unit…
              </button>
            ),
          } satisfies Column<OrgUnit>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="People"
        primary={
          canEdit ? (
            tab === 'people' ? (
              <><button type="button" className="btn" onClick={() => setAdding(true)}>
                Add person…
              </button></>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => setDialog({ kind: 'unit', unit: null })}
              >
                Add unit…
              </button>
            )
          ) : undefined
        }
        more={
          canEdit && tab === 'people'
            ? [{ label: 'Enter paper form…', onSelect: () => navigate('/requests/new?paper=1') }, { label: 'Add unit…', onSelect: () => setDialog({ kind: 'unit', unit: null }) }, { label: 'Import people…', onSelect: () => setImporting(true) }]
            : undefined
        }
      />

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'people'}
          className={tab === 'people' ? 'active' : ''}
          onClick={() => setParams({ tab: null })}
        >
          People
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'units'}
          className={tab === 'units' ? 'active' : ''}
          onClick={() => setParams({ tab: 'units' })}
        >
          Units
        </button>
      </div>

      {tab === 'people' ? (
        <div className="panel">
          <div className="toolbar">
            <Field label="Find a person">
              <input
                type="search"
                value={q}
                placeholder="Name or staff number"
                onChange={(e) => setParams({ q: e.target.value || null })}
              />
            </Field>
            <Field label="Unit">
              <select value={unit} onChange={(e) => setParams({ unit: e.target.value || null })}>
                <option value="">All units</option>
                {activeUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {orgUnitName(u.name)}
                  </option>
                ))}
              </select>
            </Field>
            <label className="field">
              <input
                type="checkbox"
                checked={former}
                onChange={(e) => setParams({ former: e.target.checked ? '1' : null })}
              />{' '}
              Show former staff
            </label>
          </div>

          {affected.length > 0 ? (
            <p className="alert alert-info">
              Future requests to check:{' '}
              {affected.map((r) => (
                <Link key={r.id} to={`/requests/${r.id}`} className="req-num">
                  {r.number}
                </Link>
              ))}
            </p>
          ) : null}

          {listQ.error ? <ErrBox error={listQ.error} /> : null}
          {listQ.loading ? <Loading /> : null}
          {listQ.data ? (
            <DataTable<EmployeeListItem>
              columns={peopleColumns}
              rows={[...listQ.data].sort((a, b) => a.full_name.localeCompare(b.full_name))}
              rowLink={(e) => `/people/${e.id}`}
              empty={
                q || unit || former
                  ? 'No one matches this search.'
                  : 'No people yet.'
              }
            />
          ) : null}
        </div>
      ) : (
        <div className="panel">
          {unitsQ.error ? <ErrBox error={unitsQ.error} /> : null}
          {unitsQ.loading ? <Loading /> : null}
          {unitsQ.data ? (
            <DataTable<OrgUnit>
              columns={unitColumns}
              rows={unitsQ.data}
              empty={
                <EmptyState
                  text="No units yet."
                  action={
                    canEdit ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setDialog({ kind: 'unit', unit: null })}
                      >
                        Add unit…
                      </button>
                    ) : undefined
                  }
                />
              }
            />
          ) : null}
        </div>
      )}

      {adding ? (
        <AddPersonDialog
          units={activeUnits}
          schedules={schedules}
          people={everyone.filter((e) => e.active)}
          today={today}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            void allQ.reload();
            void listQ.reload();
            navigate(`/people/${id}?new=1`);
          }}
        />
      ) : null}

      {dialog?.kind === 'edit' ? <EditPersonDialog employeeId={dialog.employee.id} units={activeUnits} people={everyone.filter((e) => e.active)} schedules={schedules} today={today} onClose={() => setDialog(null)} onSaved={(msg, requests) => {
        setDialog(null); setAffected(requests); toast(msg); listQ.reload(); allQ.reload();
      }} /> : null}

      {dialog?.kind === 'transfer' ? (
        <TransferDialog
          employee={dialog.employee}
          units={activeUnits}
          people={everyone.filter((e) => e.active)}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null);
            toast(msg);
            void listQ.reload();
            void allQ.reload();
          }}
        />
      ) : null}

      {dialog?.kind === 'pattern' ? (
        <PatternDialog
          employeeId={dialog.employee.id}
          schedules={schedules}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(msg, aff) => {
            setDialog(null);
            setAffected(aff);
            toast(msg);
            void listQ.reload();
          }}
        />
      ) : null}

      {dialog?.kind === 'end' ? (
        <EndEmploymentDialog
          employeeId={dialog.employee.id}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null);
            toast(msg);
            void listQ.reload();
            void allQ.reload();
          }}
        />
      ) : null}

      {dialog?.kind === 'unit' ? (
        <UnitDialog
          unit={dialog.unit}
          units={units}
          onClose={() => setDialog(null)}
          onSaved={(msg, id) => {
            setDialog(null);
            setParams({ tab: 'units', highlight: id ? String(id) : null });
            toast(msg);
            void unitsQ.reload();
          }}
        />
      ) : null}

      {importing ? (
        <ImportDialog
          kind="employees"
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void listQ.reload();
            void allQ.reload();
          }}
        />
      ) : null}
    </>
  );
}
