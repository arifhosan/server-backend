import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

interface Result<T> {
  key: string;
  base: string;
  data?: T;
  error?: ApiError;
}

/** GET `path` (null = skip). Re-fetches when path, deps or reload() change. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T>>({ key: '', base: '' });
  const base = `${path}|${JSON.stringify(deps)}`;
  const key = `${base}|${tick}`;

  useEffect(() => {
    if (path === null) return;
    const ctl = new AbortController();
    api<T>(path, { signal: ctl.signal }).then(
      (data) => setResult({ key, base, data }),
      (e) => {
        if (ctl.signal.aborted) return;
        setResult({ key, base, error: e instanceof ApiError ? e : new ApiError(0, String(e)) });
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key already encodes path, tick and deps
  }, [key]);

  const current = result.key === key ? result : undefined;
  // On reload() keep the previous data (same path and deps) instead of flashing the spinner.
  const stale = !current && result.base === base ? result.data : undefined;
  return {
    data: current ? current.data : stale,
    error: current?.error,
    loading: path !== null && !current && stale === undefined,
    reload: () => setTick((t) => t + 1),
  };
}
