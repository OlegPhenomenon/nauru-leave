import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import type { PolicyVersion, Status, Step, Warning } from '../api/types';
import { fmtDate, fmtDuration } from '../lib/format';

// Statuses are always words + a shape, never colour alone (spec).
const STATUS_META: Record<Status, { icon: string; cls: string; label: string }> = {
  draft: { icon: '▤', cls: 'st-draft', label: 'Draft' },
  submitted: { icon: '◔', cls: 'st-submitted', label: 'Submitted' },
  needs_information: { icon: '◑', cls: 'st-needs', label: 'Needs information' },
  under_review: { icon: '◕', cls: 'st-review', label: 'Under review' },
  approved: { icon: '●', cls: 'st-approved', label: 'Approved' },
  rejected: { icon: '■', cls: 'st-rejected', label: 'Rejected' },
  withdrawn: { icon: '◌', cls: 'st-withdrawn', label: 'Withdrawn' },
  cancelled: { icon: '⊘', cls: 'st-cancelled', label: 'Cancelled' },
};

export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const m = STATUS_META[status];
  return (
    <span className={`status ${m.cls}`}>
      <span aria-hidden="true" className="status-icon">
        {m.icon}
      </span>
      {label ?? m.label}
    </span>
  );
}

const PHASE_LABELS = {
  upcoming: 'Upcoming',
  in_progress: 'In progress',
  period_ended: 'Period ended',
} as const;
export function PhaseBadge({ phase }: { phase: keyof typeof PHASE_LABELS | null | undefined }) {
  if (!phase) return null;
  return <span className={`phase phase-${phase}`}>{PHASE_LABELS[phase]}</span>;
}

export function Dur({ minutes, mpd }: { minutes: number; mpd?: number }) {
  return <>{fmtDuration(minutes, mpd ?? 480)}</>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}

export function ErrBox({ error }: { error: ApiError | Error | null }) {
  if (!error) return null;
  const code = error instanceof ApiError ? ` (${error.code})` : '';
  return (
    <div className="alert alert-error" role="alert">
      {error.message}
      {code}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function WarnList({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="warn-list">
      {warnings.map((w, i) => (
        <li key={i}>
          <span aria-hidden="true">⚠ </span>
          {w.message}
          {w.code === 'team_overlap' && Array.isArray(w.details) ? (
            <ul className="warn-detail">
              {(w.details as { name?: string; from?: string; to?: string }[]).map((o, j) =>
                o.name ? (
                  <li key={j}>
                    {o.name}
                    {o.from && o.to ? ` — ${fmtDate(o.from)} to ${fmtDate(o.to)}` : ''}
                  </li>
                ) : null,
              )}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ReqLink({ id, number }: { id: number; number: string }) {
  return (
    <Link className="req-num" to={`/requests/${id}`}>
      {number}
    </Link>
  );
}

/**
 * Marks where a leave policy comes from. Demo rules must never look like
 * verified law — the badge text is fixed by docs/DEMO_DATA.md.
 */
export function PolicyBadge({ policy }: { policy: PolicyVersion | null | undefined }) {
  if (!policy) return null;
  if (policy.status === 'demo_fictional')
    return (
      <span className="badge badge-demo" title={policy.explanation}>
        Fictional demo rule — not Nauru law
      </span>
    );
  if (policy.status === 'verified')
    return (
      <span className="badge badge-ok" title={policy.explanation}>
        Verified rule
      </span>
    );
  return (
    <span className="badge badge-med" title={policy.explanation}>
      Rule not verified — confirm with HR before real use
    </span>
  );
}

export function stepStatusLabel(s: Step['status']): string {
  switch (s) {
    case 'waiting':
      return 'Waiting';
    case 'pending':
      return 'Pending';
    case 'done':
      return 'Done';
    case 'superseded':
      return 'Superseded';
    case 'closed':
      return 'Closed';
  }
}

/** Render an unknown JSON value as a compact definition list / table (ops summary, reports). */
export function JsonValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  if (typeof v === 'boolean') return <>{v ? 'yes' : 'no'}</>;
  if (typeof v === 'number' || typeof v === 'string') return <>{v}</>;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="muted">—</span>;
    if (v.every((x) => typeof x !== 'object' || x === null))
      return <>{v.map((x) => String(x)).join(', ')}</>;
    return <GenericTable rows={v as Record<string, unknown>[]} />;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  return (
    <dl className="kv">
      {entries.map(([k, val]) => (
        <div key={k} className="kv-row">
          <dt>{k.replaceAll('_', ' ')}</dt>
          <dd>
            <JsonValue v={val} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function GenericTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return <Empty>Nothing to show.</Empty>;
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c.replaceAll('_', ' ')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>
                  <CellValue v={r[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  if (typeof v === 'boolean') return <>{v ? 'yes' : 'no'}</>;
  if (typeof v === 'number' || typeof v === 'string') return <>{v}</>;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.full_name === 'string') return <>{o.full_name}</>;
    if (typeof o.display_name === 'string') return <>{o.display_name}</>;
    if (typeof o.name === 'string') return <>{o.name}</>;
    return <code className="mono small">{JSON.stringify(v)}</code>;
  }
  return <>{String(v)}</>;
}
