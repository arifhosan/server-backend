import { useState, type FormEvent } from 'react';
import { api, json } from '../api/client';
import type { PublicConnection } from '../api/types';
import { ago } from '../lib/dates';
import { ActionError, Chip, useAction } from './ConnectionParts';

const TONE = { ok: 'ok', expiring: 'warn', expired: 'bad', failing: 'bad', disabled: 'off' } as const;
const LABEL = { ok: 'OK', expiring: 'Expiring', expired: 'Expired', failing: 'Sync failing', disabled: 'Disabled' } as const;

export function SteamCard({ conn, onChange }: { conn: PublicConnection | undefined; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [profile, setProfile] = useState('');
  const { error, busy, run } = useAction();
  const form = !conn || editing;

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api('/games/connections/steam', json('PUT', { profile: profile.trim() })))) {
      setEditing(false);
      setProfile('');
      onChange();
    }
  }
  const act = async (fn: () => Promise<unknown>) => {
    if (await run(fn)) {
      setConfirm(false);
      onChange();
    }
  };

  return (
    <section className="card set-card" aria-label="Steam">
      <div className="row-end">
        <div className="grow">
          <div className="strong big">Steam</div>
          <div className="muted small">
            {conn ? `Connected as ${conn.displayName}${conn.lastGameCount !== null ? ` · ${conn.lastGameCount} games` : ''}` : 'Not connected'}
          </div>
        </div>
        {conn && <Chip tone={TONE[conn.status]}>{LABEL[conn.status]}</Chip>}
      </div>
      {conn && (
        <div className="muted small">
          {conn.lastSyncAt ? `Last sync ${ago(conn.lastSyncAt)}` : 'Not synced yet'} · hourly · fills gaps when the tracker was off
        </div>
      )}
      {conn?.lastError && <div className="last-error">{conn.lastError}</div>}
      {form ? (
        <form className="col" onSubmit={connect}>
          <p className="muted small">Your Steam profile must be public (Privacy Settings: Game details). Paste the profile URL or the custom name.</p>
          <div className="row-end">
            <label className="lbl grow">
              Steam profile URL or name
              <input className="field" value={profile} onChange={(e) => setProfile(e.target.value)} required />
            </label>
            <button className="btn primary" type="submit" disabled={busy || !profile.trim()}>
              Connect Steam
            </button>
            {editing && (
              <button className="btn ghost" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="row-end">
          <button className="btn" type="button" disabled={busy || conn.status === 'disabled'} onClick={() => void act(() => api('/games/connections/steam/sync', json('POST')))}>
            Sync now
          </button>
          <button className="btn ghost" type="button" onClick={() => setEditing(true)}>
            Change profile
          </button>
          {confirm ? (
            <>
              <button className="btn danger" type="button" disabled={busy} onClick={() => void act(() => api('/games/connections/steam', json('DELETE')))}>
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
      )}
      <ActionError message={error} />
    </section>
  );
}
