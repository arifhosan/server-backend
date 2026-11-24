export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;

/** The auth provider registers itself here; a 401 anywhere (except login) signs the user out. */
export function setOnUnauthorized(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized?.();
    let message = res.statusText || 'Request failed';
    try {
      const m = (await res.json())?.message;
      if (Array.isArray(m)) message = m.join(', ');
      else if (typeof m === 'string') message = m;
    } catch {
      // non-JSON error body: keep the status text
    }
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** JSON request init: api(path, json('POST', body)). */
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
