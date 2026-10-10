import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import type { AppConfig, Me, Role } from '../api/types';

export interface Session {
  config: AppConfig | null;
  me: Me | null;
  loading: boolean;
  refreshConfig: () => Promise<void>;
  adoptMe: (me: Me) => void;
  refreshMe: () => Promise<Me | null>;
  logout: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api<AppConfig>('/config'));
    } catch {
      /* keep last known config */
    }
  }, []);

  const adoptMe = useCallback((m: Me) => { setMe(m); setCsrfToken(m.csrf_token); }, []);

  const refreshMe = useCallback(async () => {
    try {
      const m = await api<Me>('/me');
      setMe(m);
      setCsrfToken(m.csrf_token);
      return m;
    } catch {
      setMe(null);
      setCsrfToken(null);
      return null;
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      setCsrfToken(null);
    });
    void (async () => {
      await refreshConfig();
      await refreshMe();
      setLoading(false);
    })();
    return () => setUnauthorizedHandler(null);
  }, [refreshConfig, refreshMe]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* already gone */
    }
    setMe(null);
    setCsrfToken(null);
  }, []);

  const hasRole = useCallback(
    (...roles: Role[]) => !!me && me.roles.some((r) => roles.includes(r.role)),
    [me],
  );

  const value = useMemo(
    () => ({ config, me, loading, refreshConfig, refreshMe, adoptMe, logout, hasRole }),
    [config, me, loading, refreshConfig, refreshMe, adoptMe, logout, hasRole],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside provider');
  return s;
}
