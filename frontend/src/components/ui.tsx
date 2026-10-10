import {
  cloneElement,
  isValidElement,
  useId,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { createPortal } from 'react-dom';
import type { ApiError } from '../api/client';
import type { PolicyVersion, Status, Step, Warning } from '../api/types';
import { describeError } from '../lib/errors';
import {
  fmtDuration,
  fmtPhase,
  fmtRange,
  plural,
  statusLabel,
} from '../lib/format';
import { useSession } from '../lib/session';

/* ------------------------------------------------------------------ */
/* Page header                                                         */
/* ------------------------------------------------------------------ */

export interface MoreItem {
  label: string;
  onSelect: () => void;
  danger?: boolean | undefined;
}

export function PageHeader({
  title,
  subtitle,
  back,
  primary,
  more,
}: {
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  back?: { to: string; label: string } | undefined;
  primary?: ReactNode | undefined;
  more?: MoreItem[] | undefined;
}) {
  return (
    <div className="page-header">
      <div>
        {back ? (
          <Link className="back-link" to={back.to}>
            ← {back.label}
          </Link>
        ) : null}
        <h1>{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {primary || (more && more.length > 0) ? (
        <div className="actions">
          {primary}
          {more && more.length > 0 ? (
            <Menu
              label="More"
              align="end"
              items={more.map((m) => ({
                label: m.label,
                onSelect: m.onSelect,
                danger: m.danger,
              }))}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Disclosure (progressive detail, closed by default)                  */
/* ------------------------------------------------------------------ */

export function Details({
  title,
  count,
  children,
  className,
  defaultOpen = false,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  count?: number | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <details className={`disclosure ${className ?? ''}`} open={defaultOpen || undefined}>
      <summary>
        {title}
        {typeof count === 'number' ? <span className="count"> ({count})</span> : null}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Menu — a native <details> dropdown. Closes on Escape/outside click.  */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  label: ReactNode;
  to?: string | undefined;
  onSelect?: (() => void) | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  /** small secondary line (e.g. a count) */
  hint?: ReactNode | undefined;
  /** renders a separator instead of an item */
  divider?: boolean | undefined;
  className?: string | undefined;
}

export function Menu({
  label,
  items,
  align,
  className,
}: {
  label: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end' | undefined;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDocMouse = (e: MouseEvent) => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && el.open) {
        el.open = false;
        el.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('mousedown', onDocMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const close = () => {
    if (ref.current) ref.current.open = false;
  };

  return (
    <details
      ref={ref}
      className={`menu ${align === 'end' ? 'menu-end' : ''} ${className ?? ''}`}
    >
      <summary>{label}</summary>
      <div className="menu-panel" role="menu">
        {items.map((item, i) => {
          if (item.divider) {
            return (
              <hr
                key={i}
                className={`menu-divider ${item.className ?? ''}`}
                aria-hidden="true"
              />
            );
          }
          const cls = `menu-item ${item.danger ? 'danger' : ''} ${item.className ?? ''}`.trim();
          return item.to ? (
            <Link key={`${item.label}:${item.to}`} role="menuitem" className={cls} to={item.to} onClick={close}>
              <span>{item.label}</span>
              {item.hint ? <span className="hint">{item.hint}</span> : null}
            </Link>
          ) : (
            <button
              key={`${item.label}:action`}
              role="menuitem"
              type="button"
              className={cls}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect?.();
              }}
            >
              <span>{item.label}</span>
              {item.hint ? <span className="hint">{item.hint}</span> : null}
            </button>
          );
        })}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Status + tags                                                       */
/* ------------------------------------------------------------------ */

type Tone = 'progress' | 'done' | 'stopped' | 'neutral';

const STATUS_TONE: Record<Status, Tone> = {
  draft: 'neutral',
  submitted: 'progress',
  needs_information: 'progress',
  under_review: 'progress',
  approved: 'done',
  rejected: 'stopped',
  withdrawn: 'neutral',
  cancelled: 'stopped',
};

/** Status = word + tone, never colour alone, never a glyph. */
export function StatusBadge({ status, label }: { status: Status; label?: string | undefined }) {
  // The backend's status_label still says "Rejected"; the UI word is Refused.
  const text = label && label !== 'Rejected' ? label : statusLabel(status);
  return <span className={`status status--${STATUS_TONE[status]}`}>{text}</span>;
}

/** Neutral metadata chip: Paper form, Change request, Sensitive, … */
export function Tag({ children, tone }: { children: ReactNode; tone?: 'warn' | 'ok' | 'err' | undefined }) {
  return <span className={`tag ${tone ? `tag-${tone}` : ''}`}>{children}</span>;
}

export function PhaseBadge({
  phase,
  start,
  today,
}: {
  phase: 'upcoming' | 'in_progress' | 'period_ended' | null | undefined;
  start?: string | undefined;
  today?: string | undefined;
}) {
  const text = fmtPhase(phase, start, today);
  if (!text) return null;
  return <span className="muted">{text}</span>;
}

export function Dur({ minutes, mpd }: { minutes: number; mpd?: number | undefined }) {
  return <>{fmtDuration(minutes, mpd ?? 480)}</>;
}

/* ------------------------------------------------------------------ */
/* Loading / empty / errors                                            */
/* ------------------------------------------------------------------ */

export function Loading({ label = 'Loading…' }: { label?: string | undefined }) {
  return (
    <div className="skeleton-stack" role="status" aria-label={label}>
      <span className="visually-hidden">{label}</span>
      <span className="skeleton" aria-hidden="true" />
      <span className="skeleton" aria-hidden="true" />
      <span className="skeleton" aria-hidden="true" />
    </div>
  );
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode | undefined }) {
  return (
    <div className="empty-state">
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrBox({ error }: { error: ApiError | Error | null }) {
  if (!error || ('code' in error && error.code === 'cancelled')) return null;
  const { message, technical } = describeError(error);
  return (
    <div className="alert alert-error" role="alert">
      <p style={{ margin: 0 }}>{message}</p>
      {technical && technical !== message ? (
        <Details title="Technical details">
          <code className="mono small">{technical}</code>
        </Details>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

/**
 * Dialog with a Cancel + one primary action in the footer.
 * - Focuses the first form field once on mount (never the ✕ button).
 * - Escape closes; overlay click closes only when the form is clean —
 *   a dirty form asks "Discard changes?" first.
 * - Focus returns to the element that opened it.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean | undefined;
  /** Footer actions; when set, the default Cancel button is omitted. */
  footer?: ReactNode | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dirtyRef = useRef(false);
  const [askDiscard, setAskDiscard] = useState(false);

  // Mount-only: remember the trigger, focus the first form field,
  // wire Escape + Tab trap, restore focus on unmount.
  useEffect(() => {
    const el = ref.current;
    const trigger = document.activeElement as HTMLElement | null;
    const firstField = el?.querySelector<HTMLElement>(
      'input:not([type=hidden]),select,textarea',
    );
    if (firstField) {
      firstField.focus();
    } else {
      el?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (dirtyRef.current) setAskDiscard(true);
        else onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && el) {
        const focusables = Array.from(
          el.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
          ),
        ).filter((n) => n.offsetParent !== null || n === document.activeElement);
        if (!focusables.length) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      trigger?.focus?.();
    };
  }, []);

  const markDirty = (e: React.FormEvent) => {
    const t = e.target as HTMLElement;
    if (t.matches('input,select,textarea')) dirtyRef.current = true;
  };

  const requestClose = () => {
    if (dirtyRef.current) setAskDiscard(true);
    else onCloseRef.current();
  };

  return createPortal(
    <div className="modal-overlay" onClick={requestClose}>
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        onInput={markDirty}
        onChange={markDirty}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={requestClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
        <div className="modal-foot">
          {askDiscard ? (
            <>
              <span className="discard-note">Discard changes?</span>
              <button type="button" className="btn btn-secondary" onClick={() => setAskDiscard(false)}>
                Keep editing
              </button>
              <button type="button" className="btn btn-danger" onClick={() => onCloseRef.current()}>
                Discard
              </button>
            </>
          ) : footer ? (
            footer
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export type ToastTone = 'ok' | 'info' | 'err';
interface ToastMsg {
  id: number;
  text: string;
  tone: ToastTone;
}

type Push = (text: string, tone?: ToastTone) => void;
const ToastPushCtx = createContext<Push>(() => {});
const ToastListCtx = createContext<ToastMsg[]>([]);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = useCallback<Push>((text, tone = 'ok') => {
    const id = ++toastSeq;
    setToasts([{ id, text, tone }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 5000);
  }, []);
  return (
    <ToastPushCtx.Provider value={push}>
      <ToastListCtx.Provider value={toasts}>{children}</ToastListCtx.Provider>
    </ToastPushCtx.Provider>
  );
}

/** toast(text, tone?) — call from any component under ToastProvider. */
export function useToast(): Push {
  return useContext(ToastPushCtx);
}

/** One global region, mounted once by Layout (bottom-right). */
export function ToastRegion() {
  const toasts = useContext(ToastListCtx);
  if (!toasts.length) return null;
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DataTable — typed columns, row links, stacked on small screens      */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  /** cell text used for the stacked "label" on small screens */
  label: string;
  render: (row: T) => ReactNode;
  className?: string | undefined;
  /** first column is the row title in stacked mode */
  title?: boolean | undefined;
}

export function DataTable<T>({
  columns,
  rows,
  rowLink,
  empty = 'Nothing to show.',
}: {
  columns: Column<T>[];
  rows: T[];
  rowLink?: ((row: T) => string) | undefined;
  empty?: ReactNode | undefined;
}) {
  const navigate = useNavigate();
  if (!rows.length) return <EmptyState text={typeof empty === 'string' ? empty : 'Nothing to show.'} action={typeof empty === 'string' ? undefined : empty} />;
  return (
    <div className="table-wrap table-stack">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={c.className}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const to = rowLink?.(row);
            return (
              <tr
                key={i}
                className={to ? 'row-link' : undefined}
                onClick={to ? () => navigate(to) : undefined}
              >
                {columns.map((c, j) => (
                  <td
                    key={j}
                    className={`${c.className ?? ''} ${c.title || j === 0 ? 'stack-title' : ''}`.trim()}
                    data-label={c.title || j === 0 ? '' : c.label}
                  >
                    {to && j === 0 ? <Link to={to}>{c.render(row)}</Link> : c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  children,
  hint,
  error,
  inputId,
}: {
  label: string;
  children: ReactNode;
  hint?: string | undefined;
  /** inline field error; wiring aria-describedby is the page's job */
  error?: string | undefined;
  inputId?: string | undefined;
}) {
  const generatedId = useId();
  const control = isValidElement<{ id?: string }>(children) && typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type);
  const id = inputId ?? (control ? children.props.id : undefined) ?? generatedId;
  const errId = `${id}-error`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {control ? cloneElement(children, { id }) : <label htmlFor={id}>{children}</label>}
      {error ? (
        <FieldError id={errId}>{error}</FieldError>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function FieldError({
  children,
  id,
}: {
  children: ReactNode;
  id?: string | undefined;
}) {
  return (
    <span className="field-error" role="alert" id={id}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Warnings — plain copy per code, details where they add names/dates   */
/* ------------------------------------------------------------------ */

function warnText(w: Warning): string {
  switch (w.code) {
    case 'team_overlap': {
      const list = Array.isArray(w.details)
        ? (w.details as { name?: string }[]).filter((o) => o.name)
        : [];
      return list.length === 1
        ? `${list[0]!.name} is also away in this period.`
        : `${plural(list.length, 'teammate')} are also away in this period.`;
    }
    case 'late_notice': {
      const d = w.details as { min_notice_days?: number } | undefined;
      return d?.min_notice_days
        ? `This starts sooner than the usual ${plural(d.min_notice_days, 'day')} of notice.`
        : 'This is short notice.';
    }
    case 'unassigned_step':
      return 'No one is assigned to a step yet — HR needs to assign it.';
    case 'schedule_drift':
      return 'The work pattern changed after this was submitted — the days may need checking.';
    default:
      return w.message;
  }
}

export function WarnList({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="warn-list">
      {warnings.map((w, i) => (
        <li key={i}>
          {warnText(w)}
          {w.code === 'team_overlap' && Array.isArray(w.details) && w.details.length > 1 ? (
            <ul className="warn-detail">
              {(w.details as { name?: string; from?: string; to?: string }[]).map((o, j) =>
                o.name ? (
                  <li key={j}>
                    {o.name}
                    {o.from && o.to ? ` — ${fmtRange(o.from, o.to)}` : ''}
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
 * Marks where a leave policy comes from. In demo mode a `demo_fictional`
 * policy renders nothing — the demo strip already says the rules are
 * fictional; repeating it on every screen is noise.
 */
export function PolicyBadge({ policy }: { policy: PolicyVersion | null | undefined }) {
  const { config } = useSession();
  if (!policy) return null;
  if (policy.status === 'demo_fictional') {
    if (config?.mode === 'demo') return null;
    return (
      <span className="badge badge-demo" title={policy.explanation}>
        Fictional demo rule — not Nauru law
      </span>
    );
  }
  if (policy.status === 'verified')
    return (
      <span className="badge badge-ok" title={policy.explanation}>
        Verified rule
      </span>
    );
  return (
    <span className="badge badge-med" title={policy.explanation}>
      Rule not verified
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

/* ------------------------------------------------------------------ */
/* Generic JSON rendering (kept for ops/report pages until P4/P5)       */
/* ------------------------------------------------------------------ */

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
