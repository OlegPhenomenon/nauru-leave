import { useState } from 'react';
import { api, post } from '../api/client';
import type { Persona } from '../api/types';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { ErrBox, Loading } from './ui';

export default function PersonaPicker({ onDone }: { onDone: () => void }) {
  const { refreshMe } = useSession();
  const { data, error, loading } = useApi(() => api<Persona[]>('/demo/personas'), []);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick(user_id: number) {
    setBusy(user_id);
    setErr(null);
    try {
      await post('/demo/login', { user_id });
      await refreshMe();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Loading label="Loading demo personas…" />;
  if (error) return <ErrBox error={error} />;
  return (
    <>
      {err ? <div className="alert alert-error">{err}</div> : null}
      <div className="persona-grid">
        {(data ?? []).map((p) => (
          <button
            key={p.user_id}
            className="persona-card"
            disabled={busy !== null}
            onClick={() => void pick(p.user_id)}
          >
            <span className="name">{p.display_name}</span>
            <span className="title"> — {p.title}</span>
            <div className="prole">
              {p.roles.map((r) => (
                <span key={r} className="badge">
                  {r.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
            <div className="story">{p.story}</div>
            {busy === p.user_id ? <div className="muted small">Signing in…</div> : null}
          </button>
        ))}
      </div>
    </>
  );
}
