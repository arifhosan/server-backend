import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { NowPlaying } from '../api/types';
import { formatDuration } from '../lib/format';
import { GameArt } from './GameArt';
import '../styles/overview.css';

const PLATFORM: Record<string, string> = {
  steam: 'Steam',
  xbox_pc: 'Xbox app',
  epic: 'Epic',
  pc_other: 'PC',
  ps5: 'PS5',
  ps4: 'PS4',
};

/** /games/now, refreshed every 30 s while the tab is visible. */
export function useNowPlaying() {
  const [now, setNow] = useState<NowPlaying[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      api<NowPlaying[]>('/games/now').then(
        (r) => live && setNow(r),
        () => {}, // keep the last known state on error
      );
    };
    load();
    const id = setInterval(load, 30_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      live = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);
  return now;
}

function Session({ g, timeZone }: { g: NowPlaying; timeZone: string }) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const started = new Date(g.startedAt);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(started);
  return (
    <section className="now" aria-label="Now playing">
      <GameArt imageUrl={g.imageUrl} hasIcon={g.hasIcon} libraryGameId={g.libraryGameId} title={g.title} size="lg" />
      <div className="now-info">
        <div className="now-badge">
          <span className="dot" aria-hidden="true" />
          NOW PLAYING
        </div>
        <div className="now-title">{g.title}</div>
        <div className="muted">
          {PLATFORM[g.platform] ?? g.platform} · {g.deviceName} · started {clock}
        </div>
      </div>
      <div className="now-time">
        <div className="now-clock">{formatDuration(Math.max(0, Math.floor((tick - started.getTime()) / 1000)))}</div>
        <div className="muted small">this session</div>
      </div>
    </section>
  );
}

export function NowPlayingCard({ games, timeZone }: { games: NowPlaying[]; timeZone: string }) {
  return games.map((g) => <Session key={`${g.deviceId}-${g.libraryGameId}-${g.startedAt}`} g={g} timeZone={timeZone} />);
}
