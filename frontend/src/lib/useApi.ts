import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Small data-fetching hook. Re-runs when `deps` change. */
export function useApi<T>(fn: () => Promise<T>, deps: readonly unknown[]): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback((background = false) => {
    const id = ++seq.current;
    if (!background) setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        if (seq.current === id) setData(d);
      })
      .catch((e) => {
        if (seq.current === id)
          setError(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
      })
      .finally(() => {
        if (seq.current === id) setLoading(false);
      });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => run(), deps);
  useEffect(() => {
    const refresh = () => run(true);
    window.addEventListener('nld:data-changed', refresh);
    return () => {
      window.removeEventListener('nld:data-changed', refresh);
      ++seq.current;
    };
  }, [run]);

  const reload = useCallback(() => run(), [run]);
  return { data, error, loading, reload };
}
