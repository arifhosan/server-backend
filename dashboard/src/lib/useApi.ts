import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

interface Result<T> {
  key: string;
  data?: T;
  error?: ApiError;
}

/** GET `path` (null = skip). Re-fetches when path, deps or reload() change. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T>>({ key: '' });
  const key = `${path}|${tick}|${JSON.stringify(deps)}`;

  useEffect(() => {
    if (path === null) return;
    let live = true;
    api<T>(path).then(
      (data) => live && setResult({ key, data }),
      (e) => live && setResult({ key, error: e instanceof ApiError ? e : new ApiError(0, String(e)) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key already encodes path, tick and deps
  }, [key]);

  const current = result.key === key ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: path !== null && !current,
    reload: () => setTick((t) => t + 1),
  };
}
