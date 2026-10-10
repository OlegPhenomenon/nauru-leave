import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { del, post, put } from '../../api/client';
import type { EmployeeListItem, OrgUnit, UserListItem } from '../../api/types';
import { DataTable, Details, ErrBox, Field, Loading, Modal, PageHeader, Tag } from '../../components/ui';
import { isHr, isTechAdmin } from '../../lib/nav';
import { useSession } from '../../lib/session';
import { useApi } from '../../lib/useApi';
import { readAll } from './data';
import { Check, ROLE_INFO, SidePanel, useSave, userRoleLabel } from './shared';

function accessSummary(u: UserListItem): string {
  return u.roles.filter(r => r.role !== 'hr' || !u.roles.some(m => m.role === 'hr_medical' && m.scope_org_unit_id === r.scope_org_unit_id)).map(r => `${r.role === 'hr_medical' ? 'HR officer (with medical files)' : userRoleLabel(r.role)}${r.scope_org_unit_id ? ` — ${r.scope_name}` : ''}`).join(', ') || 'No extra access';
}
export default function UsersAccess() {
  const { me } = useSession();
  const tech = me ? isTechAdmin(me) : false;
  const hr = me ? isHr(me) : false;
  const q = useApi(() => readAll<UserListItem>('/users'), []);
  const [params, setParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [search, setSearch] = useState('');
  const roleFilter = params.get('role');
  const selected = q.data?.find((u) => u.id === Number(params.get('user')));
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  }
  const rows = (q.data ?? []).filter((u) => (!roleFilter || u.roles.some((r) => r.role === roleFilter)) && `${u.display_name} ${u.email}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.display_name.localeCompare(b.display_name));
  return <>
    <PageHeader title="Users & access" subtitle="Who can sign in, and what each person may do." primary={tech || hr ? <>{tech ? <button className="btn" onClick={() => setAddOpen(true)}>Add user…</button> : null}<button className={tech ? 'btn btn-secondary' : 'btn'} onClick={() => setAccessOpen(true)}>Give access…</button></> : undefined} />
    <Field label="Find a user"><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or email" /></Field>
    {roleFilter ? <p>Showing {userRoleLabel(roleFilter)} <button className="btn btn-ghost btn-sm" onClick={() => setParam('role', null)}>Show all users</button></p> : null}
    {q.loading ? <Loading /> : q.error ? <ErrBox error={q.error} /> : <DataTable<UserListItem> rows={rows} rowLink={(u) => { const next = new URLSearchParams(params); next.set('user', String(u.id)); return `/settings/users?${next}`; }} empty="No users match." columns={[
      { label: 'Person', render: (u) => <>{u.display_name}{!u.active ? <> <Tag>Inactive</Tag></> : null}<div className="muted small">{u.email}</div></> },
      { label: 'Access', render: accessSummary },
      { label: '', className:'row-actions', render:u => u.allowed.grant_roles.length ? <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); setParam('user',String(u.id)); }}>Edit access…</button> : null },
    ]} />}
    <p className="muted small">Managers get approval rights from <Link to="/people">People</Link> › Manager.</p>
    {selected ? <UserPanel key={selected.id} user={selected} hr={hr} onClose={() => setParam('user', null)} onSaved={q.reload} /> : null}
    {accessOpen && q.data ? <GiveAccessModal users={q.data} hr={hr} onClose={() => setAccessOpen(false)} onSaved={q.reload} /> : null}
    {addOpen ? <AddUserModal onClose={() => setAddOpen(false)} onDone={(id) => { setAddOpen(false); setParam('user', String(id)); q.reload(); }} /> : null}
  </>;
}
interface RoleState { checked: boolean; scopes: string[] }
function UserPanel({ user: u, hr, onClose, onSaved, picker, dialog = false }: { user: UserListItem; hr: boolean; onClose: () => void; onSaved: () => void; picker?: ReactNode; dialog?: boolean }) {
  const { err, busy, run } = useSave();
  const orgs = useApi(() => readAll<OrgUnit>('/org-units'), []);
  const employees = useApi(() => hr && u.allowed.link_employee ? readAll<EmployeeListItem>('/employees', { include_inactive: true }) : Promise.resolve([] as EmployeeListItem[]), [hr, u.allowed.link_employee]);
  const [active, setActive] = useState(u.active);
  const [name, setName] = useState(u.display_name);
  const [email, setEmail] = useState(u.email);
  const [employeeId, setEmployeeId] = useState(u.employee ? String(u.employee.id) : '');
  const [partial, setPartial] = useState(false);
  const [roles, setRoles] = useState<Record<string, RoleState>>(() => Object.fromEntries(ROLE_INFO.map((info) => {
    const grants = u.roles.filter((r) => r.role === info.role);
    return [info.role, { checked: !!grants.length, scopes: grants.length ? grants.map((r) => String(r.scope_org_unit_id ?? '')) : [''] }];
  })));
  const setRole = (role: string, state: RoleState) => setRoles((old) => ({ ...old, [role]: state }));
  const hasChanges = active !== u.active || name.trim() !== u.display_name || email.trim() !== u.email || employeeId !== String(u.employee?.id ?? '') || ROLE_INFO.some(info => {
    if (!u.allowed.grant_roles.includes(info.role)) return false;
    const wanted = new Set(roles[info.role]?.checked ? roles[info.role]!.scopes : []);
    const current = new Set(u.roles.filter(r => r.role === info.role).map(r => String(r.scope_org_unit_id ?? '')));
    return wanted.size !== current.size || [...wanted].some(s => !current.has(s));
  });
  async function save() {
    if (!hasChanges) return;
    let changed = false;
    try {
      const linkChanged = u.allowed.link_employee && employeeId !== String(u.employee?.id ?? '');
      if (active !== u.active || name.trim() !== u.display_name || email.trim() !== u.email || linkChanged) {
        await put(`/users/${u.id}`, { email: email.trim(), display_name: name.trim(), active, ...(linkChanged ? { employee_id: employeeId ? Number(employeeId) : null } : {}), expected_version: u.version });
        changed = true;
      }
      for (const info of ROLE_INFO) {
        if (!u.allowed.grant_roles.includes(info.role)) continue;
        const state = roles[info.role]!;
        const wanted = new Set(state.checked ? state.scopes : []);
        const current = u.roles.filter((r) => r.role === info.role);
        // Add the replacement before removing old grants to preserve access on failure.
        for (const scope of wanted) if (!current.some((g) => String(g.scope_org_unit_id ?? '') === scope)) {
          await post(`/users/${u.id}/roles`, { role: info.role, scope_org_unit_id: scope ? Number(scope) : null }); changed = true;
        }
        for (const grant of current) if (!wanted.has(String(grant.scope_org_unit_id ?? ''))) { await del(`/role-grants/${grant.id}`); changed = true; }
      }
      onSaved(); onClose(); return `${u.display_name}: access updated.`;
    } catch (error) { setPartial(changed); throw error; }
  }
  const Container = dialog ? Modal : SidePanel;
  return <Container title={dialog ? 'Give access' : u.display_name} onClose={() => { if (!busy) onClose(); }} footer={<><button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" form="access-form" className="btn" disabled={busy || partial || !hasChanges}>{busy ? 'Saving…' : 'Save access'}</button></>}>
    {picker ? <fieldset disabled={busy || partial}>{picker}</fieldset> : null}
    <p className="muted small">{u.email}</p>
    {err ? <ErrBox error={err} /> : null}
    {partial ? <p className="next-hint">Some changes were saved. <button className="btn btn-ghost" onClick={() => { onSaved(); onClose(); }}>Reload users before trying again</button></p> : null}
    <form id="access-form" onSubmit={(e) => { e.preventDefault(); void run(save); }}>
      <Check label="Can sign in" checked={active} onChange={setActive} hint={!active ? 'Saving will sign this user out.' : undefined} />
      <h2>Access</h2>
      {ROLE_INFO.map((info) => {
        const state = roles[info.role]!;
        const can = u.allowed.grant_roles.includes(info.role);
        return <div key={info.role}>
          <Check label={info.label} checked={state.checked} disabled={!can} onChange={(checked) => setRole(info.role, { ...state, checked })} hint={`${info.desc}${!can ? info.role === 'tech_admin' ? ' Granted by another technical admin.' : ' Granted by HR.' : ''}`} />
          {state.checked && info.role !== 'tech_admin' ? <div className="indent">
            {state.scopes.map((scope, index) => <div key={index}>
              <Field label={`${info.label} — scope${state.scopes.length > 1 ? ` ${index + 1}` : ''}`}>
                <select value={scope} disabled={!can || orgs.loading || !!orgs.error} onChange={(e) => setRole(info.role, { ...state, scopes: state.scopes.map((s, i) => i === index ? e.target.value : s) })}>
                  <option value="">Whole service</option>
                  {orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Field>
              {can && state.scopes.length > 1 ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRole(info.role, { ...state, scopes: state.scopes.filter((_, i) => i !== index) })}>Remove this scope</button> : null}
            </div>)}
            {can ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRole(info.role, { ...state, scopes: [...state.scopes, ''] })}>Add another scope</button> : null}
          </div> : null}
        </div>;
      })}
      {orgs.error ? <ErrBox error={orgs.error} /> : null}
      <Details title="User details">
        <Field label="Name"><input value={name} required onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email"><input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} /></Field>
        {u.allowed.link_employee ? <Field label="Linked person"><select value={employeeId} disabled={employees.loading || !!employees.error} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Not linked</option>{employees.data?.filter((p) => !p.has_login || p.id === u.employee?.id).map((p) => <option key={p.id} value={p.id}>{p.full_name} — {p.service_id}</option>)}</select></Field> : null}
        {employees.error ? <ErrBox error={employees.error} /> : null}
        {u.employee ? <p>Linked person: <Link to={`/people/${u.employee.id}`}>{u.employee.full_name}</Link></p> : null}
      </Details>
    </form>
  </Container>;
}
function AddUserModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const { err, busy, run } = useSave();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return <Modal title="Add user" onClose={onClose} footer={<> <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><button className="btn" type="submit" form="usersaccess-dialog-form" disabled={busy}>{busy ? 'Adding…' : 'Add user'}</button> </>}>
    {err ? <ErrBox error={err} /> : null}
    <form id="usersaccess-dialog-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const result = await post<{ id: number }>('/users', { email: email.trim(), display_name: name.trim(), active: true }); onDone(result.id); return `${name.trim()} added.`; }); }}>
      <Field label="Name"><input value={name} required onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Email"><input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} /></Field>

    </form>
  </Modal>;
}

/** Pick a user and edit access in the same dialog, using the existing editor. */
export function GiveAccessModal({ users, hr, onClose, onSaved }: { users: UserListItem[]; hr: boolean; onClose: () => void; onSaved: () => void }) {
  const [userId, setUserId] = useState(0);
  const eligible = users.filter((u) => u.allowed.grant_roles.length > 0);
  const user = eligible.find((u) => u.id === userId);
  const picker = <Field label="User"><select value={userId} onChange={(e) => setUserId(Number(e.target.value))}>
    <option value={0}>Choose a user</option>
    {eligible.map((u) => <option key={u.id} value={u.id}>{u.display_name} — {u.email}</option>)}
  </select></Field>;
  return user ? <UserPanel key={user.id} user={user} hr={hr} dialog picker={picker} onClose={onClose} onSaved={onSaved} /> :
    <Modal title="Give access" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled>Save access</button></>}>{picker}{!eligible.length ? <p className="muted">No users are available for you to give access.</p> : null}</Modal>;
}
