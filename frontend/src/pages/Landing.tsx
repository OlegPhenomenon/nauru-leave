import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, post } from '../api/client';
import type { DemoStatus, Me } from '../api/types';
import PersonaPicker from '../components/PersonaPicker';
import { ErrBox, Field, Loading } from '../components/ui';
import { fetchNavCounts, homeFor } from '../lib/nav';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

/** Land on the right page for this user (queue-aware for managers). */
async function goHome(navigate: (to: string) => void, m: Me) {
  const c = await fetchNavCounts(m);
  navigate(homeFor(m, c));
}

function ContinuePanel({
  me,
  demo,
  onSwitch,
}: {
  me: Me;
  demo: boolean;
  onSwitch?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="panel">
      <h2>{demo ? 'Continue your demo' : 'Welcome back'}</h2>
      <p>
        You are signed in as <strong>{me.user.display_name}</strong>.
      </p>
      <div className="btn-row">
        <button className="btn" onClick={() => void goHome(navigate, me)}>
          Continue
        </button>
        {demo && onSwitch ? (
          <button className="btn btn-secondary" onClick={onSwitch}>
            Switch person
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StartDemo({
  onStart,
  status,
}: {
  onStart: () => void;
  status: DemoStatus | null;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      if (!status?.has_sandbox) await post('/demo/start');
      onStart();
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrBox error={err} />
      <div className="btn-row">
        <button className="btn" disabled={busy} onClick={() => void start()}>
          {busy ? 'Preparing…' : 'Start demo'}
        </button>
      </div>
    </>
  );
}

function ProductionLogin() {
  const { refreshMe } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ needs_totp: boolean }>('/auth/login', { email, password });
      if (r.needs_totp) {
        setNeedsTotp(true);
      } else {
        const m = await refreshMe();
        if (m) await goHome(navigate, m);
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex : new Error(String(ex)));
    } finally {
      setBusy(false);
    }
  }

  async function doTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post('/auth/totp', { code });
      const m = await refreshMe();
      if (m) await goHome(navigate, m);
    } catch (ex) {
      setErr(ex instanceof Error ? ex : new Error(String(ex)));
    } finally {
      setBusy(false);
    }
  }

  if (needsTotp) {
    return (
      <form className="panel" onSubmit={doTotp}>
        <h2>Two-factor code</h2>
        <p className="muted">Enter the 6-digit code from your authenticator app.</p>
        <ErrBox error={err} />
        <Field label="Code">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </Field>
        <div className="btn-row">
          <button className="btn" disabled={busy}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setNeedsTotp(false)}>
            Back
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="panel" onSubmit={doLogin}>
      <h2>Sign in</h2>
      <ErrBox error={err} />
      <Field label="Email">
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </Field>
      <Field label="Password">
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <div className="btn-row">
        <button className="btn" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </form>
  );
}

export default function Landing() {
  const { me, config, loading } = useSession();
  const isDemo = config?.mode === 'demo';
  const statusQ = useApi(
    () => (isDemo ? api<DemoStatus>('/demo/status') : Promise.resolve(null)),
    [isDemo],
  );
  const [picking, setPicking] = useState(false);

  if (loading || !config) return <Loading />;

  return (
    <div className="hero">
      <h1>Nauru Leave Desk</h1>
      <p>
        {isDemo
          ? 'Try a private demo of a leave system for a public service.'
          : 'Sign in to manage leave.'}
      </p>

      {isDemo ? (
        me && !picking ? (
          <ContinuePanel me={me} demo onSwitch={() => setPicking(true)} />
        ) : picking || statusQ.data?.has_sandbox ? (
          <div className="panel">
            <h2>Who do you want to be?</h2>
            <PersonaPicker onDone={() => setPicking(false)} />
          </div>
        ) : (
          <StartDemo status={statusQ.data} onStart={() => setPicking(true)} />
        )
      ) : me ? (
        <ContinuePanel me={me} demo={false} />
      ) : (
        <ProductionLogin />
      )}
      {statusQ.error ? <ErrBox error={statusQ.error} /> : null}
    </div>
  );
}
