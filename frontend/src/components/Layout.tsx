import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { api, post } from '../api/client';
import type { AppConfig, MailboxItem } from '../api/types';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useSession, type Session } from '../lib/session';
import { useApi } from '../lib/useApi';
import PersonaPicker from './PersonaPicker';
import { Empty, ErrBox, Loading, Modal } from './ui';

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

function MailboxDrawer({ onClose }: { onClose: () => void }) {
  const { data, error, loading } = useApi(
    () => api<{ items: MailboxItem[] }>('/demo/mailbox'),
    [],
  );
  return (
    <aside className="drawer" role="dialog" aria-label="Demo mailbox">
      <div className="drawer-head">
        <strong>Demo mailbox</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <div className="drawer-body">
        <p className="muted small">
          Simulated delivery — messages stay inside this demo and are never emailed.
        </p>
        {loading ? <Loading /> : null}
        {error ? <ErrBox error={error} /> : null}
        {data && data.items.length === 0 ? <Empty>No messages yet.</Empty> : null}
        {data?.items.map((m) => (
          <div key={m.id} className="mail-item">
            <div className="subject">{m.subject}</div>
            <div className="muted small">
              To {m.to_email} · {fmtDateTime(m.delivered_at)}
            </div>
            <div className="body">{m.body}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function DemoBar({ config }: { config: AppConfig }) {
  const { me, refreshMe, refreshConfig } = useSession();
  const navigate = useNavigate();
  const [mailbox, setMailbox] = useState(false);
  const [personas, setPersonas] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clockBusy, setClockBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function setDate(date: string) {
    if (!date) return;
    setClockBusy(true);
    setErr(null);
    try {
      await post<AppConfig>('/demo/clock', { date });
      await refreshConfig();
      await refreshMe();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not set date');
    } finally {
      setClockBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm('Reset your private demo? All demo data will be regenerated.')) return;
    setResetting(true);
    try {
      await post('/demo/reset');
      setMeNull();
      navigate('/');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setResetting(false);
    }
  }

  // reset invalidates the session; refreshMe() will return null
  async function setMeNull() {
    await refreshMe();
  }

  return (
    <div className="demo-bar">
      <div className="demo-bar-inner">
        <span className="demo-tag">Demo</span>
        <span>
          business date <strong>{fmtDate(config.business_date)}</strong> · fictional data &amp; rules
        </span>
        {me ? <span className="muted">· signed in as {me.user.display_name}</span> : null}
        <span className="spacer" />
        {me ? (
          <button className="btn btn-secondary btn-sm" onClick={() => setPersonas(true)}>
            Switch persona
          </button>
        ) : null}
        <label className="muted small">
          Time travel:{' '}
          <input
            type="date"
            min={config.business_date}
            max="2028-12-31"
            disabled={clockBusy}
            onChange={(e) => void setDate(e.target.value)}
            aria-label="Time travel to business date"
          />
        </label>
        <button className="btn btn-secondary btn-sm" onClick={() => setMailbox(true)}>
          Mailbox
        </button>
        <button className="btn btn-danger btn-sm" disabled={resetting} onClick={() => void reset()}>
          {resetting ? 'Resetting…' : 'Reset demo'}
        </button>
        {err ? <span className="alert alert-error small">{err}</span> : null}
      </div>
      {mailbox ? <MailboxDrawer onClose={() => setMailbox(false)} /> : null}
      {personas ? (
        <Modal title="Switch persona" onClose={() => setPersonas(false)} wide>
          <PersonaPicker onDone={() => setPersonas(false)} />
        </Modal>
      ) : null}
    </div>
  );
}

const NAV: { to: string; label: string; show: (s: Session) => boolean }[] = [
  { to: '/my', label: 'My leave', show: () => true },
  { to: '/requests/new', label: 'New request', show: () => true },
  {
    to: '/approvals',
    label: 'Approvals',
    show: (s) =>
      !!s.me &&
      (s.me.is_manager ||
        s.me.acting_for.length > 0 ||
        s.hasRole('hr', 'final_approver', 'hr_medical')),
  },
  { to: '/calendar', label: 'Team calendar', show: () => true },
  { to: '/people', label: 'People', show: (s) => s.hasRole('hr', 'hr_medical', 'auditor') },
  {
    to: '/balances',
    label: 'Balances',
    show: (s) => s.hasRole('hr', 'hr_medical', 'auditor', 'adjustment_approver'),
  },
  {
    to: '/reports',
    label: 'Reports',
    show: (s) => s.hasRole('hr', 'hr_medical', 'auditor', 'final_approver'),
  },
  { to: '/settings', label: 'Settings', show: (s) => s.hasRole('hr', 'tech_admin') },
  {
    to: '/operations',
    label: 'Operations',
    show: (s) => s.hasRole('tech_admin', 'hr', 'auditor'),
  },
  { to: '/help', label: 'Help', show: () => true },
];

export default function Layout() {
  const session = useSession();
  const { me, config, logout } = session;
  const navigate = useNavigate();

  return (
    <>
      <header className="app-header no-print">
        <div className="app-header-inner">
          <NavLink to="/" className="brand">
            <Logo />
            Nauru Leave Desk
          </NavLink>
          {me ? (
            <nav className="main-nav" aria-label="Main">
              {NAV.filter((n) => n.show(session)).map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
          ) : null}
          {me ? (
            <div className="user-box">
              <span>{me.user.display_name}</span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  void logout().then(() => navigate('/'));
                }}
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>
      {config?.mode === 'demo' ? <DemoBar config={config} /> : null}
      <main className="page">
        <Outlet />
      </main>
      <footer className="app-footer no-print">
        Nauru Leave Desk {config?.app_version ? `· v${config.app_version}` : ''} — independent
        prototype; fictional people and rules. Not adopted by the Government of Nauru.
      </footer>
    </>
  );
}
