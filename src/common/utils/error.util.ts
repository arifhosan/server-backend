/**
 * Narrows an `unknown` caught value to something safe to log.
 * A bare String(error) on an object yields '[object Object]', which hides
 * exactly the detail you need when something fails in production.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

/** Stack trace when available, otherwise the best available description. */
export function errorStack(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return errorMessage(error);
}
