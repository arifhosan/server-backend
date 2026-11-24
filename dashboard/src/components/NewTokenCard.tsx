import { useRef, useState, type FormEvent } from 'react';
import { api, json } from '../api/client';
import type { PublicDevice } from '../api/types';
import { ActionError, useAction } from './ConnectionParts';

export function NewTokenCard({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null); // memory only: shown once, never stored
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLElement>(null);
  const { error, busy, run } = useAction();

  async function create(e: FormEvent) {
    e.preventDefault();
    setCopied(false);
    const ok = await run(async () => {
      const r = await api<{ device: PublicDevice; token: string }>('/games/devices', json('POST', { name: name.trim() }));
      setToken(r.token);
    });
    if (ok) {
      setName('');
      onCreated();
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(token ?? '');
      setCopied(true);
    } catch {
      if (code.current) window.getSelection()?.selectAllChildren(code.current); // fallback: select for Ctrl+C
    }
  }

  return (
    <form className="card set-card" onSubmit={create}>
      <div className="strong">New device token</div>
      <div className="row-end">
        <label className="lbl grow">
          Device name
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} maxLength={100} />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
          Create token
        </button>
      </div>
      <ActionError message={error} />
      {token && (
        <div role="status" className="token-box">
          <div className="token-msg">Token created. Copy it now: it is shown only once.</div>
          <div className="row-end">
            <code ref={code} className="token">
              {token}
            </code>
            <button className="btn" type="button" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
