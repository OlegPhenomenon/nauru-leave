// Shared bits for the Settings sections: a right-side panel (same chrome as
// the mailbox drawer), a save hook (busy + mapped error + toast) and small
// form primitives used across the sections.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../lib/useApi';
import { readAll } from './data';
import { fmtRange } from '../../lib/format';
import type { RequestSummary } from '../../api/types';
import { ApiError } from '../../api/client';
import { roleLabel } from '../../lib/format';
import type { Role } from '../../api/types';
import { useToast } from '../../components/ui';

/**
 * Detail panel sliding in from the right, reusing the .drawer chrome.
 * Escape closes it; rendered above page content, below modals.
 */
export function SidePanel({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-overlay')) return;
      if (e.key === 'Escape') { e.preventDefault(); close.current(); }
      if (e.key === 'Tab') {
        const fields = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary');
        const first = fields?.[0];
        const last = fields?.[fields.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (before?.isConnected) before.focus(); };
  }, []);
  return (
    <div className="settings-panel-shade">
      <aside ref={panel} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'}>
        <div className="drawer-head">
          <strong>{title}</strong>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close panel</button>
        </div>
        <div className="drawer-body">{children}{footer ? <div className="modal-foot">{footer}</div> : null}</div>
      </aside>
    </div>
  );
}

/**
 * Submit helper for dialogs/panels: tracks busy, maps errors through
 * ErrBox (ApiError → describeError), toasts the returned message and
 * runs `done` on success.
 */
export function useSave() {
  const toast = useToast();
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string | void>, done?: () => void) {
    setBusy(true);
    setErr(null);
    try {
      const msg = await fn();
      if (msg) toast(msg);
      done?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      setBusy(false);
    }
  }

  return { err, busy, run, clearErr: () => setErr(null) };
}

/** Labelled checkbox consistent with .field styling. */
export function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <label className="field">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />{' '}
      {label}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Access roles → plain names + one-line descriptions                  */
/* ------------------------------------------------------------------ */

export interface RoleInfo {
  role: Role;
  label: string;
  desc: string;
}

export const ROLE_INFO: RoleInfo[] = [
  {
    role: 'hr',
    label: 'HR officer',
    desc: 'Sets up leave rules, people, holidays and balance corrections.',
  },
  {
    role: 'hr_medical',
    label: 'HR officer — medical files',
    desc: 'HR duties, plus access to medical documents.',
  },
  {
    role: 'final_approver',
    label: 'Final approver',
    desc: 'Makes the final decision on leave requests.',
  },
  {
    role: 'adjustment_approver',
    label: 'Correction approver',
    desc: 'Approves balance corrections proposed by another HR officer.',
  },
  {
    role: 'tech_admin',
    label: 'Technical administrator',
    desc: 'Manages sign-ins and watches the system.',
  },
  {
    role: 'auditor',
    label: 'Auditor',
    desc: 'Reads the history and downloads reports.',
  },
];

export function userRoleLabel(role: string): string {
  return ROLE_INFO.find((r) => r.role === role)?.label ?? roleLabel(role);
}

export interface AffectedRequest { id: number; number: string }
export function AffectedRequests({ requests }: { requests: AffectedRequest[] }) {
  if (!requests.length) return null;
  return <div className="next-hint" role="status">
    <p>These future requests need to be checked:</p>
    <ul>{requests.map((r) => <li key={r.id}><RequestHistoryLink request={r} /></li>)}</ul>
  </div>;
}
function RequestHistoryLink({ request }: { request: AffectedRequest }) {
  const q = useApi(() => readAll<RequestSummary>('/requests', { scope:'all' }), []);
  const r = q.data?.find(r => r.id === request.id);
  return <>{r ? `${r.employee.full_name} · ${fmtRange(r.start_date,r.end_date)} · ` : `${request.number} · `}<Link to={`/requests/${request.id}`}>Review</Link></>;
}
