import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Adjustment, AuditEvent, EmployeeListItem, LeaveType, RequestSummary } from '../api/types';
import { Details, EmptyState, ErrBox, Field, Loading, PageHeader } from '../components/ui';
import { auditSentence, fmtDateTime, fmtDuration, fmtRange } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { readAll } from './settings/data';
import './History.css';
import { AuditDetails, auditDetailRows } from '../components/AuditDetails';

const WHAT = [
  { value: '', label: 'All changes', entities: [] },
  { value: 'requests', label: 'Requests', entities: ['request', 'leave_request', 'attachment'] },
  { value: 'corrections', label: 'Balance corrections', entities: ['adjustment', 'account', 'leave_type'] },
  { value: 'people', label: 'People', entities: ['employee', 'org-unit', 'org_unit'] },
  { value: 'rules', label: 'Leave rules & work patterns', entities: ['leave-type', 'policy', 'policie', 'schedule'] },
  { value: 'holidays', label: 'Holidays', entities: ['calendar-exception', 'calendar_exception'] },
  { value: 'stand-ins', label: 'Stand-ins', entities: ['delegation'] },
  { value: 'users', label: 'Users', entities: ['user', 'role-grant', 'role_grant'] },
  { value: 'sign-ins', label: 'Sign-ins', entities: ['session'] },
];
function detailsOf(e: AuditEvent): Record<string, unknown> {
  return e.details && typeof e.details === 'object' ? e.details as Record<string, unknown> : {};
}
function numberSearchInput(search: string): boolean { return /^NLD-/i.test(search); }
function visible(e: AuditEvent): boolean { return detailsOf(e).restricted !== true; }
function requestId(e: AuditEvent): number | null {
  if (e.entity === 'request' || e.entity === 'leave_request') return e.entity_id;
  return typeof detailsOf(e).request_id === 'number' ? detailsOf(e).request_id as number : null;
}

export default function History() {
  const { hasRole } = useSession();
  const techOnly = hasRole('tech_admin') && !hasRole('hr', 'auditor');
  const [params, setParams] = useSearchParams();
  const search = params.get('q')?.trim() ?? '';
  const what = params.get('what') ?? '';
  const who = params.get('who') ?? '';
  const [draft, setDraft] = useState(search);
  const [shown, setShown] = useState(50);
  useEffect(() => { setDraft(search); }, [search]);
  useEffect(() => { setShown(50); }, [search, what, who]);
  const all = useApi(() => readAll<AuditEvent>('/audit'), []);
  const requests = useApi(() => techOnly ? Promise.resolve([] as RequestSummary[]) : readAll<RequestSummary>('/requests', { scope: 'all' }), [techOnly]);
  const people = useApi(() => search && !techOnly && !/^NLD-/i.test(search) ? readAll<EmployeeListItem>('/employees', { q: search, include_inactive: true }) : Promise.resolve([] as EmployeeListItem[]), [search, techOnly]);
  const adjustments = useApi(() => !techOnly ? readAll<Adjustment>('/adjustments') : Promise.resolve([] as Adjustment[]), [search, techOnly]);
  const types = useApi(() => techOnly ? Promise.resolve([] as LeaveType[]) : readAll<LeaveType>('/leave-types'), [techOnly]);
  const numberMatches = (requests.data ?? []).filter((r) => r.number.toLowerCase().includes(search.toLowerCase()));
  const numberSearch = numberSearchInput(search);
  const events = useApi(async () => {
    if (numberSearch) {
      if (requests.loading) return [];
      const groups = await Promise.all(numberMatches.map((r) => readAll<AuditEvent>('/audit', { entity: 'request', entity_id: r.id, actor_user_id: who || undefined })));
      return groups.flat();
    }
    return readAll<AuditEvent>('/audit', { actor_user_id: who || undefined });
  }, [search, who, requests.data, requests.loading]);

  const actors = useMemo(() => {
    const names = new Map<number, string>();
    for (const e of all.data ?? []) if (visible(e) && e.actor) names.set(e.actor.id, e.actor.display_name);
    return [...names].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all.data]);
  const requestById = new Map((requests.data ?? []).map((r) => [r.id, r]));
  const adjustmentById = new Map((adjustments.data ?? []).map((a) => [a.id, a]));
  const personIds = new Set((people.data ?? []).map((p) => p.id));
  const category = WHAT.find((w) => w.value === what) ?? WHAT[0]!;
  const rows = (events.data ?? []).filter(visible).filter((e) => {
    if (what === 'sign-ins') return e.action.startsWith('session.');
    if (what === 'users' && e.action.startsWith('session.')) return false;
    return !category.entities.length || category.entities.includes(e.entity);
  }).filter((e) => {
    if (!search || numberSearch) return true;
    const related = requestById.get(requestId(e) ?? -1);
    const d = detailsOf(e);
    return (e.entity === 'employee' && personIds.has(e.entity_id ?? -1))
      || (related && personIds.has(related.employee.id))
      || (e.entity === 'adjustment' && personIds.has(adjustmentById.get(e.entity_id ?? -1)?.employee.id ?? -1))
      || (typeof d.employee_id === 'number' && personIds.has(d.employee_id))
      || [e.actor?.display_name, e.acting_for?.display_name, related?.employee.full_name, related?.employee.service_id, related?.number].some((text) => text?.toLowerCase().includes(search.toLowerCase()));
  }).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
    setShown(50);
  }
  function sentence(e: AuditEvent): string {
    const d = detailsOf(e);
    const request = requestById.get(requestId(e) ?? -1);
    const entity = e.entity === 'policie' ? 'policy' : e.entity;
    const safeEntity = ['request', 'employee', 'user', 'org-unit', 'org_unit', 'leave-type', 'leave_type', 'schedule', 'calendar-exception', 'calendar_exception', 'delegation', 'policy', 'role-grant', 'role_grant', 'notification', 'settings', 'adjustment', 'attachment', 'export_batch', 'import_batch', 'account', 'ledger'].includes(entity);
    const action = e.action === 'policie.post' ? 'policy.put' : e.action;
    let text = auditSentence({ ...e, entity, action: safeEntity || /^(session|demo)\./.test(action) ? action : 'settings.put', details: { ...d, ...(request ? { number: request.number } : {}) } });
    if (e.action === 'step.decide') {
      const verbs: Record<string,string> = { approve:'approved', reject:'refused', recommend_approve:'recommended approval of', recommend_reject:'recommended refusal of', checked_ok:'checked', checked_problem:'flagged a problem with', needs_information:'asked a question about' };
      const verb = verbs[String(d.outcome)] ?? 'made a decision on';
      text = `${e.actor?.display_name ?? 'The system'} ${verb} ${request?.number ?? d.number ?? 'a request'}${d.outcome === 'checked_ok' ? ' — OK' : ''}${e.acting_for ? `, acting for ${e.acting_for.display_name}` : ''}.`;
    }
    if (e.action === 'export.create' && typeof d.from === 'string' && typeof d.to === 'string') text = `${e.actor?.display_name ?? 'The system'} created the payroll file for ${fmtRange(d.from,d.to)}.`;
    if (request && request.employee.full_name !== e.actor?.display_name) text = `${text.slice(0, -1)} for ${request.employee.full_name}.`;
    if (e.entity === 'employee') {
      const person = people.data?.find((p) => p.id === e.entity_id);
      if (person) text = text.replace('an employee record', `${person.full_name}'s details`);
    }
    if (e.entity === 'adjustment') {
      const adjustment = adjustmentById.get(e.entity_id ?? -1);
      if (adjustment) text = `${text.slice(0, -1)} — ${adjustment.employee.full_name}, ${fmtDuration(adjustment.minutes, adjustment.minutes_per_day)} ${adjustment.leave_type.name}.`;
    }
    if (e.action === 'accrual.run' || e.action === 'period.close') {
      const type = types.data?.find((t) => t.id === (d.leave_type_id ?? e.entity_id));
      if (type) text = `${text.slice(0, -1)} — ${type.name}.`;
    }
    return text;
  }
  const loading = events.loading || requests.loading || people.loading || adjustments.loading;
  const error = events.error ?? requests.error ?? people.error ?? adjustments.error;

  return (
    <>
      {hasRole('hr') ? <Link className="muted small" to="/settings">Settings › History</Link> : null}
      <PageHeader title="History" subtitle="Find a request or see who changed what." />
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setFilter('q', draft.trim()); }}>
        <Field label="Request number, person or staff number"><input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. NLD-2026-00008" /></Field>
        <button type="submit" className="btn">Search history</button>
        <Field label="What"><select value={what} onChange={(e) => setFilter('what', e.target.value)}>{WHAT.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</select></Field>
        <Field label="Who"><select value={who} onChange={(e) => setFilter('who', e.target.value)}><option value="">Anyone</option>{actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
      </form>
      {all.error ? <ErrBox error={all.error} /> : null}
      {loading ? <Loading label="Finding history…" /> : error ? <ErrBox error={error} /> : !rows.length ? <EmptyState text="No changes match. Try another person, request number or filter." /> : (
        <ol className="history-list">
          {rows.slice(0, shown).map((e) => {
            const request = requestById.get(requestId(e) ?? -1);
            const text = sentence(e);
            const number = request?.number;
            const at = number ? text.indexOf(number) : -1;
            return <li key={e.id}>
              <time className="muted small" dateTime={e.at}>{fmtDateTime(e.at)}</time>
              <p>{number && at >= 0 ? <>{text.slice(0, at)}<Link to={`/requests/${request.id}?history=open`}>{number}</Link>{text.slice(at + number.length)}</> : <>{text}{request ? <> <Link to={`/requests/${request.id}?history=open`}>Open {request.number}</Link></> : null}</>}</p>
              {e.entity === 'adjustment' && adjustmentById.get(e.entity_id ?? -1) ? <Link to={`/balances/${adjustmentById.get(e.entity_id ?? -1)!.employee.id}/explain?leave_type_id=${adjustmentById.get(e.entity_id ?? -1)!.leave_type.id}`}>View balance</Link> : null}
              {auditDetailRows(e.details).length ? <Details title="Details"><AuditDetails details={e.details} /></Details> : null}
            </li>;
          })}
        </ol>
      )}
      {!loading && rows.length > shown ? <button className="btn btn-secondary" onClick={() => setShown((n) => n + 50)}>Show more changes</button> : null}
    </>
  );
}
