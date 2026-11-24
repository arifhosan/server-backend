import { Link } from 'react-router';
import type { PublicConnection } from '../api/types';
import { daysUntil } from '../lib/dates';
import '../styles/overview.css';

const NAME = { steam: 'Steam', psn: 'PSN' };

function message(c: PublicConnection, now: Date): { text: string; renew: boolean } | null {
  const n = NAME[c.provider];
  if (c.status === 'expiring') {
    const d = c.secretExpiresAt ? daysUntil(c.secretExpiresAt, now) : 0;
    const tail = c.provider === 'psn' ? ' PlayStation playtime stops syncing after that.' : '';
    return { text: `${n} sign-in expires in ${d} day${d === 1 ? '' : 's'}.${tail}`, renew: true };
  }
  if (c.status === 'expired') return { text: `${n} sign-in has expired. Playtime stops syncing until you renew it.`, renew: true };
  if (c.status === 'failing') return { text: `${n} sync is failing${c.lastError ? `: ${c.lastError}` : '.'}`, renew: false };
  return null;
}

export function HealthBanner({ connections, now = new Date() }: { connections: PublicConnection[]; now?: Date }) {
  return connections.map((c) => {
    const m = message(c, now);
    if (!m) return null;
    return (
      <section key={c.provider} className="banner" role="status" aria-label={`${NAME[c.provider]} sign-in`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F5B544" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
        <span className="banner-text">{m.text}</span>
        <Link className="btn btn-warn" to="/settings">
          {m.renew ? `Renew ${NAME[c.provider]} sign-in` : 'Open settings'}
        </Link>
      </section>
    );
  });
}
