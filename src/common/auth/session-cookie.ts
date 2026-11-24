export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_MS = 2_592_000_000; // 30 days

export function readSessionCookie(
  cookieHeader: string | undefined,
): string | null {
  const prefix = `${SESSION_COOKIE}=`;
  const part = cookieHeader
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!part) return null;
  try {
    return decodeURIComponent(part.slice(prefix.length));
  } catch {
    return null; // malformed escape: treat as no cookie, not a 500
  }
}
