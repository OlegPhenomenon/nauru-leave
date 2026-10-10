import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, ApiError, beginPersonaSwitch, finishPersonaSwitch, post } from '../api/client';
import type { AppConfig, MailboxItem, Me, Persona } from '../api/types';
import {
  delegationScopeLabel,
  fmtDate,
  fmtDateTime,
  todayPlus,
} from '../lib/format';
import {
  fetchNavCounts,
  homeFor,
  myLeaveInBar,
  navFor,
  personRoleLabel,
  type NavCounts,
} from '../lib/nav';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import {
  Empty,
  ErrBox,
  Field,
  Loading,
  Menu,
  Modal,
  ToastRegion,
  Tag,
  useToast,
} from './ui';

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#0b5fa5" />
      <rect x="0" y="14.5" width="24" height="2" fill="#f2b01e" />
      <path
        d="M12 6.6l.9 2 2.2.2-1.7 1.4.5 2.1-1.9-1.2-1.9 1.2.5-2.1-1.7-1.4 2.2-.2z"
        fill="#fff"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Mailbox drawer                                                      */
/* ------------------------------------------------------------------ */

const REQUEST_LINK = /(?:https?:\/\/\S+)?(\/requests\/\d+)/;

function mailBody(body: string) {
  // Bodies end with a URL pointing at the request — turn it into an
  // in-app link instead of showing a raw path.
  const m = body.match(REQUEST_LINK);
  if (!m || m.index === undefined) return body;
  const path = m[1]!;
  const before = body.slice(0, m.index).trimEnd();
  const after = body.slice(m.index + m[0].length);
  return (
    <>
      {before} <Link to={path}>Open the request</Link>
      {after}
    </>
  );
}

function MailboxDrawer({
  me,
  items,
  loading,
  error,
  onClose,
}: {
  me: Me;
  items: MailboxItem[];
  loading: boolean;
  error: ApiError | null;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const mine = items.filter((m) => m.to_email === me.user.email);
  const shown = all ? items : mine;

  const renderItem = (m: MailboxItem) => (
    <div key={m.id} className="mail-item">
      <div className="subject">{m.subject}</div>
      <div className="muted small">
        To {m.to_email} · {fmtDateTime(m.delivered_at)}
      </div>
      <div className="body">{mailBody(m.body)}</div>
    </div>
  );

  return (
    <aside className="drawer" role="dialog" aria-label="Emails">
      <div className="drawer-head">
        <strong>Emails sent by the system</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <div className="drawer-body">
        <p className="muted small">In the demo, no real email leaves the system — every message lands here.</p>
        <div className="tabs" role="tablist" aria-label="Whose emails">
          <button type="button" role="tab" aria-selected={!all} className={!all ? 'active' : ''} onClick={() => setAll(false)}>
            To {me.user.display_name} ({mine.length})
          </button>
          <button type="button" role="tab" aria-selected={all} className={all ? 'active' : ''} onClick={() => setAll(true)}>
            Everyone ({items.length})
          </button>
        </div>
        {loading ? <Loading /> : null}
        {error ? <ErrBox error={error} /> : null}
        {!loading && !error && shown.length === 0 ? (
          <Empty>No emails {all ? 'yet' : `for ${me.user.display_name} yet`}.</Empty>
        ) : null}
        {shown.map(renderItem)}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Demo tool modals                                                    */
/* ------------------------------------------------------------------ */

function MoveDateModal({ config, onClose }: { config: AppConfig; onClose: () => void }) {
  const { refreshConfig, refreshMe } = useSession();
  const toast = useToast();
  const [date, setDate] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const min = todayPlus(config.business_date, 1);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await post('/demo/clock', { date });
      await refreshConfig();
      await refreshMe();
      window.dispatchEvent(new Event('nld:counts-changed'));
      toast(`Demo date moved to ${fmtDate(date)}.`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Change the demo date"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!date || busy} onClick={() => void go()}>
            {date ? `Move to ${fmtDate(date)}` : 'Move date'}
          </button>
        </>
      }
    >
      <Field label="New business date" hint="You can't move back. Reset the demo to start over.">
        <input
          type="date"
          min={min}
          max="2028-12-31"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      <ErrBox error={err} />
    </Modal>
  );
}

function ResetModal({ onClose }: { onClose: () => void }) {
  const { refreshMe } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await post('/demo/reset');
      await refreshMe(); // session is invalidated → null
      toast('Demo reset — fresh fictional data.');
      navigate('/');
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Reset demo"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void go()}>
            {busy ? 'Resetting…' : 'Reset demo'}
          </button>
        </>
      }
    >
      <p>
        This wipes your demo and generates fresh fictional people and requests. You'll be
        signed out.
      </p>
      <ErrBox error={err} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Demo strip                                                          */
/* ------------------------------------------------------------------ */

/** ⓘ popover holding the full fictional-data notice. */
function InfoPopover() {
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
  return (
    <details ref={ref} className="menu demo-info">
      <summary aria-label="About the demo">i</summary>
      <div className="demo-popover" role="note">
        <p>
          Independent prototype — not adopted by the Government of Nauru. People, rules and
          amounts are fictional. Email, antivirus scanning and two-factor codes are simulated
          inside the demo.
        </p>
      </div>
    </details>
  );
}

function DemoStrip({
  config,
  me,
  mailboxCount,
  onSwitch,
  onTools,
}: {
  config: AppConfig;
  me: Me;
  mailboxCount: number;
  onSwitch: () => void;
  onTools: (tool: 'mailbox' | 'date' | 'reset') => void;
}) {
  return (
    <div className="demo-strip no-print">
      <div className="demo-strip-inner">
        <div className="demo-group">
          <span className="demo-note">
            Demo<span className="demo-note-tail"> — fictional people and rules</span>
            <InfoPopover />
          </span>
          <span className="demo-today">Today {fmtDate(config.business_date)}</span>
          <button
            type="button"
            className="demo-btn"
            onClick={() => onTools('date')}
            title="Move the demo's today forward to see how leave and balances change"
          >
            Change date…
          </button>
        </div>
        <div className="demo-group">
          <span className="demo-viewing">
            <strong>{me.user.display_name}</strong>
            <span className="demo-viewing-role">· {personRoleLabel(me)}</span>
          </span>
          <button type="button" className="demo-btn demo-btn-strong demo-switch" onClick={onSwitch}>
            Switch user
          </button>
          <button
            type="button"
            className="demo-btn"
            onClick={() => onTools('mailbox')}
            title="Emails the system sent in this demo (nothing is really sent)"
          >
            Emails ({mailboxCount})
          </button>
          <button type="button" className="demo-btn" onClick={() => onTools('reset')}>
            Reset demo…
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

// Keep the old page unmounted throughout the change of session and route.
function SwitchPersonPicker({ onBusy, onDone }: { onBusy: (busy: boolean) => void; onDone: () => void }) {
  const { me, adoptMe } = useSession();
  const navigate = useNavigate();
  const q = useApi(() => api<Persona[]>('/demo/personas'), []);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  async function pick(userId: number) {
    if (busy !== null || userId === me?.user.id) return;
    setBusy(userId);
    setError(null);
    onBusy(true);
    beginPersonaSwitch();
    try {
      await post('/demo/login', { user_id: userId });
      const next = await api<Me>('/me');
      finishPersonaSwitch();
      const counts = await fetchNavCounts(next);
      flushSync(() => navigate(homeFor(next, counts), { replace: true }));
      flushSync(() => adoptMe(next));
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      finishPersonaSwitch();
      onBusy(false);
      setBusy(null);
    }
  }
  if (q.loading) return <Loading label="Loading demo people…" />;
  if (q.error) return <ErrBox error={q.error} />;
  return <>
    <ErrBox error={error} />
    <div className="persona-grid">{(q.data ?? []).map(person => <button
      key={person.user_id} type="button" className="persona-card"
      disabled={busy !== null || person.user_id === me?.user.id}
      onClick={() => void pick(person.user_id)}>
      <span className="name">{person.display_name}</span>
      <span className="title">{person.title}</span>
      <span className="story">{person.story}</span>
      {person.user_id === me?.user.id ? <Tag>Current</Tag> : null}
      {busy === person.user_id ? <span className="muted small">Switching…</span> : null}
    </button>)}</div>
  </>;
}

export default function Layout() {
  const { me, config, logout } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const isDemo = config?.mode === 'demo';

  const [counts, setCounts] = useState<NavCounts>({ approvals: 0, corrections: 0 });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [mailboxOpen, setMailboxOpen] = useState(false);
  const [moveDateOpen, setMoveDateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  // Badge counts refresh on route change and on persona switch.
  const meId = me?.user.id;
  const [countsVersion, setCountsVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setCountsVersion(v => v + 1);
    window.addEventListener('nld:counts-changed', refresh);
    return () => window.removeEventListener('nld:counts-changed', refresh);
  }, []);
  useEffect(() => {
    if (switching) return;
    if (!me) {
      setCounts({ approvals: 0, corrections: 0 });
      return;
    }
    let alive = true;
    void fetchNavCounts(me).then((c) => {
      if (alive) setCounts(c);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, location.pathname, countsVersion, switching]);

  // Close the mobile sheet on navigation and Escape.
  useEffect(() => setSheetOpen(false), [location.pathname]);
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheetOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const mailbox = useApi(
    () =>
      isDemo && meId && !switching
        ? api<{ items: MailboxItem[] }>('/demo/mailbox')
        : Promise.resolve(null),
    // Refresh the count as the demo day / persona / page changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isDemo, meId, location.pathname, switching],
  );
  const myMailCount =
    me && mailbox.data
      ? mailbox.data.items.filter((m) => m.to_email === me.user.email).length
      : 0;

  function afterPersonaPick() {
    setSwitcher(false);
  }

  const nav = me ? navFor(me, counts) : [];
  const userItems = me
    ? [
        ...(myLeaveInBar(me) ? [] : [{ label: 'My leave', to: '/my' }]),
        ...(isDemo ? [{ label: 'Switch user…', onSelect: () => setSwitcher(true) }] : []),
        { label: 'Help', to: '/help' },
        {
          label: 'Sign out',
          onSelect: () => {
            void logout().then(() => navigate('/'));
          },
        },
      ]
    : [];

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {isDemo && me && config ? (
        <DemoStrip
          config={config}
          me={me}
          mailboxCount={myMailCount}
          onSwitch={() => setSwitcher(true)}
          onTools={(t) => {
            if (t === 'mailbox') setMailboxOpen(true);
            if (t === 'date') setMoveDateOpen(true);
            if (t === 'reset') setResetOpen(true);
          }}
        />
      ) : null}
      <header className="app-header no-print">
        <div className="app-header-inner">
          <Link to={me ? homeFor(me, { approvals: counts.approvals }) : '/'} className="brand">
            <Logo />
            Nauru Leave Desk
          </Link>
          {me ? (
            <nav className="main-nav" aria-label="Main">
              {nav.map((n) => (
                <NavLink key={n.to} to={n.to}>
                  {n.label}
                  {n.count ? <span className="nav-count">{n.count}</span> : null}
                </NavLink>
              ))}
            </nav>
          ) : null}
          {me ? (
            <div className="user-box">
              <Menu label={me.user.display_name} align="end" items={userItems} />
            </div>
          ) : null}
          {me ? (
            <button
              type="button"
              className="menu-button"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen(true)}
            >
              Menu
            </button>
          ) : null}
        </div>
      </header>
      {me && me.acting_for.length > 0 ? (
        <div className="acting-banner no-print">
          <div className="acting-banner-inner">
            {me.acting_for.map((a) => (
              <span key={a.delegation_id}>
                Acting for {a.from.display_name} (
                {delegationScopeLabel(a.scope).toLowerCase()}) until {fmtDate(a.valid_to)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <main id="main" tabIndex={-1} className="page">
        {switching ? <Loading label="Switching person…" /> : <Outlet key={me?.user.id ?? 'anon'} context={counts} />}
      </main>
      <footer className="app-footer no-print">
        Nauru Leave Desk{config?.app_version ? ` v${config.app_version}` : ''} ·{' '}
        <Link to="/help">Help</Link>
      </footer>

      {sheetOpen && me ? (
        <div
          className="menu-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          onClick={() => setSheetOpen(false)}
        >
          <div className="menu-sheet-panel" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="btn btn-ghost sheet-close"
              onClick={() => setSheetOpen(false)}
            >
              ✕ Close
            </button>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to}>
                <span>{n.label}</span>
                {n.count ? <span className="nav-count">{n.count}</span> : null}
              </NavLink>
            ))}
            <h2>You</h2>
            {myLeaveInBar(me) ? null : (
              <NavLink to="/my">
                <span>My leave</span>
              </NavLink>
            )}
            <NavLink to="/help">
              <span>Help</span>
            </NavLink>
            <button
              type="button"
              className="sheet-item"
              onClick={() => {
                setSheetOpen(false);
                void logout().then(() => navigate('/'));
              }}
            >
              <span>Sign out</span>
            </button>
          </div>
        </div>
      ) : null}

      {mailboxOpen && me ? (
        <MailboxDrawer
          me={me}
          items={mailbox.data?.items ?? []}
          loading={mailbox.loading}
          error={mailbox.error}
          onClose={() => setMailboxOpen(false)}
        />
      ) : null}
      {moveDateOpen && config ? (
        <MoveDateModal config={config} onClose={() => setMoveDateOpen(false)} />
      ) : null}
      {resetOpen ? <ResetModal onClose={() => setResetOpen(false)} /> : null}
      {switcher ? (
        <Modal title="Switch person" onClose={() => { if (!switching) setSwitcher(false); }} wide>
          <SwitchPersonPicker onBusy={value => flushSync(() => setSwitching(value))} onDone={afterPersonaPick} />
        </Modal>
      ) : null}
      <ToastRegion />
    </>
  );
}
