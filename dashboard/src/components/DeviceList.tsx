import { useState } from 'react';
import { api, json } from '../api/client';
import type { PublicDevice } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ago } from '../lib/dates';
import { ActionError, useAction } from './ConnectionParts';

const LIVE_MS = 10 * 60_000;
const seenRecently = (iso: string) => Date.now() - Date.parse(iso) < LIVE_MS;

function Row({ d, onChange }: { d: PublicDevice; onChange: () => void }) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'view' | 'rename' | 'revoke'>('view');
  const [name, setName] = useState(d.name);
  const { error, busy, run } = useAction();
  const live = d.revokedAt === null && d.lastSeenAt !== null && seenRecently(d.lastSeenAt);

  const done = async (fn: () => Promise<unknown>) => {
    if (await run(fn)) {
      setMode('view');
      onChange();
    }
  };

  if (d.revokedAt !== null) {
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: user?.timezone }).format(
      new Date(d.revokedAt),
    );
    return (
      <li className="dev revoked">
        <span className="led led-off" aria-hidden="true" />
        <div className="grow">
          <div className="strong struck">{d.name}</div>
          <div className="small">Revoked {day} · its sessions stay in your history</div>
        </div>
      </li>
    );
  }

  return (
    <li className="dev">
      <span className={`led ${live ? 'led-live' : ''}`} aria-hidden="true" />
      <div className="grow">
        {mode === 'rename' ? (
          <form
            className="row-end"
            onSubmit={(e) => {
              e.preventDefault();
              void done(() => api(`/games/devices/${d.id}`, json('PATCH', { name: name.trim() })));
            }}
          >
            <input className="field grow" aria-label="Device name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
            <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
              Save
            </button>
            <button className="btn ghost" type="button" onClick={() => setMode('view')}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <div className="strong">{d.name}</div>
            <div className="muted small">
              {d.lastSeenAt ? (live ? 'Online now' : `Seen ${ago(d.lastSeenAt)}`) : 'Never seen'} · token {d.tokenPrefix}
            </div>
          </>
        )}
        <ActionError message={error} />
      </div>
      {mode === 'view' && (
        <>
          <button className="btn ghost" type="button" onClick={() => setMode('rename')}>
            Rename
          </button>
          <button className="btn danger" type="button" onClick={() => setMode('revoke')}>
            Revoke
          </button>
        </>
      )}
      {mode === 'revoke' && (
        <>
          <span className="small muted">Revoke {d.name}? The tracker on it stops syncing.</span>
          <button className="btn danger" type="button" disabled={busy} onClick={() => void done(() => api(`/games/devices/${d.id}`, json('DELETE')))}>
            Confirm revoke
          </button>
          <button className="btn ghost" type="button" onClick={() => setMode('view')}>
            Cancel
          </button>
        </>
      )}
    </li>
  );
}

export function DeviceList({ devices, onChange }: { devices: PublicDevice[]; onChange: () => void }) {
  return (
    <section className="card set-list" aria-label="Your devices">
      <div className="list-head strong">Your devices</div>
      {devices.length === 0 ? (
        <p className="list-empty muted">
          No devices yet. <a href="#download">Download the Game Tracker app</a>, then create a token above.
        </p>
      ) : (
        <ul>
          {devices.map((d) => (
            <Row key={d.id} d={d} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}
