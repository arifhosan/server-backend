import { useState, type FormEvent } from 'react';
import { api, json } from '../api/client';
import type { PublicConnection } from '../api/types';
import { ago, daysUntil } from '../lib/dates';
import { ActionError, Chip, useAction } from './ConnectionParts';

type Tone = 'ok' | 'warn' | 'bad' | 'off';

function chipFor(conn: PublicConnection, expired: boolean, warn: boolean): { tone: Tone; text: string } {
  if (expired) return { tone: 'bad', text: 'Expired' };
  if (conn.secretExpiresAt) {
    const d = daysUntil(conn.secretExpiresAt);
    return { tone: warn ? 'warn' : 'ok', text: `Expires in ${d} day${d === 1 ? '' : 's'}` };
  }
  if (conn.status === 'failing') return { tone: 'bad', text: 'Sync failing' };
  if (conn.status === 'disabled') return { tone: 'off', text: 'Disabled' };
  return { tone: 'ok', text: 'OK' };
}

export function PsnCard({ conn, onChange }: { conn: PublicConnection | undefined; onChange: () => void }) {
  const [npsso, setNpsso] = useState('');
  const [confirm, setConfirm] = useState(false);
  const { error, busy, run } = useAction();

  const expired = !!conn && (conn.status === 'expired' || (!!conn.secretExpiresAt && daysUntil(conn.secretExpiresAt) === 0));
  const warn = expired || conn?.status === 'expiring';
  const chip = conn ? chipFor(conn, expired, warn) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api('/games/connections/psn', json('PUT', { npsso: npsso.trim() })))) {
      setNpsso('');
      onChange();
    }
  }
  const act = async (fn: () => Promise<unknown>, on409?: string) => {
    if (await run(fn, on409)) {
      setConfirm(false);
      onChange();
    }
  };

  return (
    <section className={`card set-card ${warn ? 'card-warn' : ''}`} aria-label="PlayStation">
      <div className="row-end">
        <div className="grow">
          <div className="strong big">PlayStation</div>
          <div className="muted small">
            {conn ? `Connected as ${conn.displayName}${conn.lastGameCount !== null ? ` · ${conn.lastGameCount} games` : ''}` : 'Not connected'}
          </div>
        </div>
        {chip && <Chip tone={chip.tone}>{chip.text}</Chip>}
      </div>
      {warn && (
        <div className="warn-text">
          {expired
            ? 'Your Sony sign-in token has expired. Renew it to resume syncing.'
            : 'Sony requires a new sign-in token every 60 days. Renew it before it expires to keep syncing.'}
        </div>
      )}
      {conn?.lastError && <div className="last-error">{conn.lastError}</div>}
      <ol className="steps">
        <li>
          Sign in at <a href="https://www.playstation.com">playstation.com</a>.
        </li>
        <li>
          Open <a href="https://ca.account.sony.com/api/v1/ssocookie">Sony's token page</a> and copy the value after "npsso".
        </li>
        <li>Paste it here.</li>
      </ol>
      <form className="row-end" onSubmit={save}>
        <label className="lbl grow">
          NPSSO token
          <input className="field" type="password" autoComplete="off" placeholder="64 characters" value={npsso} onChange={(e) => setNpsso(e.target.value)} required />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !npsso.trim()}>
          {conn ? 'Renew' : 'Connect PlayStation'}
        </button>
      </form>
      {conn && (
        <>
          <div className="muted small">
            {conn.lastSyncAt ? `Last sync ${ago(conn.lastSyncAt)}` : 'Not synced yet'} · your token is stored encrypted and never shown again
          </div>
          <div className="row-end">
            <button className="btn" type="button" disabled={busy} onClick={() => void act(() => api('/games/connections/psn/sync', json('POST')), 'A sync is already running')}>
              Sync now
            </button>
            {confirm ? (
              <>
                <button className="btn danger" type="button" disabled={busy} onClick={() => void act(() => api('/games/connections/psn', json('DELETE')))}>
                  Confirm disconnect
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn danger" type="button" onClick={() => setConfirm(true)}>
                Disconnect
              </button>
            )}
          </div>
        </>
      )}
      <ActionError message={error} />
    </section>
  );
}
