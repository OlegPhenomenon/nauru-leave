import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, post } from '../api/client';
import type { DemoStatus } from '../api/types';
import PersonaPicker from '../components/PersonaPicker';
import { ErrBox, Field, Loading } from '../components/ui';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

function DemoIntro({ onStart, status }: { onStart: () => void; status: DemoStatus | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { me } = useSession();
  const navigate = useNavigate();

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      if (!status?.has_sandbox) await post('/demo/start');
      onStart();
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.code === 'demo_full'
            ? 'The demo is full right now — please try again later.'
            : e.code === 'rate_limited'
              ? 'Too many demo environments were created recently — please try again later.'
              : e.message
          : 'Could not start the demo.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (me) {
    return (
      <div className="panel">
        <h2>Continue your demo</h2>
        <p>
          You are signed in as <strong>{me.user.display_name}</strong>.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => navigate('/my')}>
            Go to My leave
          </button>
          <button className="btn btn-secondary" onClick={onStart}>
            Switch persona
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Try it yourself — privately</h2>
      <p>
        Starting the demo creates your own isolated copy of a fictional government office. Nothing
        you do affects other visitors, and the whole environment disappears automatically.
      </p>
      {status?.has_sandbox ? (
        <p className="muted">You already have a demo environment — pick a persona to continue.</p>
      ) : null}
      {err ? <div className="alert alert-error">{err}</div> : null}
      <div className="btn-row">
        <button className="btn" disabled={busy} onClick={() => void start()}>
          {busy
            ? 'Preparing…'
            : status?.has_sandbox
              ? 'Choose a persona'
              : 'Start your private demo'}
        </button>
      </div>
    </div>
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
  const [err, setErr] = useState<string | null>(null);

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ needs_totp: boolean }>('/auth/login', { email, password });
      if (r.needs_totp) {
        setNeedsTotp(true);
      } else {
        await refreshMe();
        navigate('/my');
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Sign-in failed');
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
      await refreshMe();
      navigate('/my');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Code check failed');
    } finally {
      setBusy(false);
    }
  }

  if (needsTotp) {
    return (
      <form className="panel" onSubmit={doTotp}>
        <h2>Two-factor code</h2>
        <p className="muted">Enter the 6-digit code from your authenticator app.</p>
        {err ? <div className="alert alert-error">{err}</div> : null}
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
      {err ? <div className="alert alert-error">{err}</div> : null}
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
  const { config, loading } = useSession();
  const isDemo = config?.mode === 'demo';
  const statusQ = useApi(
    () => (isDemo ? api<DemoStatus>('/demo/status') : Promise.resolve(null)),
    [isDemo],
  );
  const [picking, setPicking] = useState(false);
  const navigate = useNavigate();

  if (loading || !config) return <Loading />;

  return (
    <div className="hero">
      <div className="kicker">Independent prototype · fictional data</div>
      <h1>Nauru Leave Desk</h1>
      <p>
        One place for public-service leave: an employee asks for time away, the manager considers
        the team calendar, HR checks the record, and an authorised person makes the decision.
        Requests, decisions, calendars and balances stay consistent — and explainable.
      </p>
      <div className="disclaimer">
        <strong>Please note:</strong> this is an independent prototype. All people, rules and amounts
        are fictional; it is not adopted by the Government of Nauru. Email delivery, antivirus
        scanning and two-factor codes are simulated inside the demo.
      </div>

      {isDemo ? (
        picking || statusQ.data?.has_sandbox ? (
          <div className="panel">
            <h2>Choose a persona</h2>
            <p className="muted">
              Each persona is a fictional person with a different job in the demo. You can switch at
              any time from the demo bar above.
            </p>
            <PersonaPicker onDone={() => navigate('/my')} />
          </div>
        ) : (
          <DemoIntro status={statusQ.data} onStart={() => setPicking(true)} />
        )
      ) : (
        <ProductionLogin />
      )}
      {statusQ.error ? <ErrBox error={statusQ.error} /> : null}
    </div>
  );
}
