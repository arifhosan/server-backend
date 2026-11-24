import { useState } from 'react';
import { ApiError } from '../api/client';

/** Runs an API action; keeps the server's error message verbatim, except the one known 409. */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409 && e.message === 'Sync already running'
          ? 'A sync is already running'
          : e instanceof Error
            ? e.message
            : String(e),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}

export function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'off'; children: string }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function ActionError({ message }: { message: string | null }) {
  return message ? (
    <div role="alert" className="action-error">
      {message}
    </div>
  ) : null;
}
