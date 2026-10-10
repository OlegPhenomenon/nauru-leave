import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import { fetchNavCounts, homeFor } from '../lib/nav';
import { useState } from 'react';
import { api, post } from '../api/client';
import type { Me, Persona } from '../api/types';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { ErrBox, Loading } from './ui';

/**
 * Order: Alexei (the "start here" employee), then other employees,
 * then approvers, then admin/auditor personas.
 */
function rank(p: Persona): number {
  if (p.display_name.startsWith('Alexei')) return 0;
  if (p.roles.includes('tech_admin') || p.roles.includes('auditor')) return 3;
  if (p.roles.length > 0) return 2;
  if (/manager|approver|hr/i.test(p.title)) return 2;
  return 1;
}

export default function PersonaPicker({ onDone }: { onDone: (me: Me) => void | Promise<void> }) {
  const { adoptMe } = useSession();
  const navigate = useNavigate();
  const { data, error, loading } = useApi(() => api<Persona[]>('/demo/personas'), []);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  async function pick(user_id: number) {
    setBusy(user_id);
    setErr(null);
    try {
      await post('/demo/login', { user_id });
      const m = await api<Me>('/me');
      const counts = await fetchNavCounts(m);
      flushSync(() => {
        navigate(homeFor(m, counts));
        adoptMe(m);
      });
      await onDone(m);
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Loading label="Loading demo people…" />;
  if (error) return <ErrBox error={error} />;
  const personas = [...(data ?? [])].sort((a, b) => rank(a) - rank(b));
  return (
    <>
      <ErrBox error={err} />
      <div className="persona-grid">
        {personas.map((p) => (
          <button
            key={p.user_id}
            className="persona-card"
            disabled={busy !== null}
            onClick={() => void pick(p.user_id)}
          >
            <span className="name">{p.display_name}</span>
            <span className="title">{p.title}</span>
            <span className="story">{p.story}</span>
            {busy === p.user_id ? <span className="muted small">Signing in…</span> : null}
          </button>
        ))}
      </div>
    </>
  );
}
