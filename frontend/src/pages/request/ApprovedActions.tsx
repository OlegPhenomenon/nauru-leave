import { Link } from 'react-router';
import { api } from '../../api/client';
import type { RequestDetail } from '../../api/types';
import { ErrBox } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useApi } from '../../lib/useApi';

export type ApprovedAction = 'amend' | 'cancel' | 'actual-worked';

/** The server's capabilities govern both the request page and person-row shortcuts. */
export function approvedActions(d: RequestDetail): { action: ApprovedAction; label: string }[] {
  if (d.kind !== 'leave' || d.status !== 'approved') return [];
  const actions: { action: ApprovedAction; label: string }[] = [];
  if (d.date_phase !== 'period_ended') {
    if (d.allowed_actions.includes('amend')) actions.push({ action: 'amend', label: 'Change dates for employee…' });
    if (d.allowed_actions.includes('cancel')) actions.push({ action: 'cancel', label: 'Cancel part…' });
  }
  if (d.allowed_actions.includes('propose_actual_adjustment')) actions.push({ action: 'actual-worked', label: 'Days actually worked…' });
  return actions;
}

export function ApprovedRequestActions({ requestId }: { requestId: number }) {
  const { me } = useSession();
  const q = useApi(() => api<RequestDetail>(`/requests/${requestId}`), [requestId]);
  if (q.error) return <ErrBox error={q.error} />;
  if (!q.data || q.data.employee.id === me?.employee?.id) return null;
  return <span className="btn-row" onClick={(e) => e.stopPropagation()}>
    {approvedActions(q.data).map(({ action, label }) => <Link key={action} className="btn btn-secondary btn-sm" to={`/requests/${requestId}?action=${action}`}>{label}</Link>)}
  </span>;
}
