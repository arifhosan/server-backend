import { useState } from 'react';
import { Link } from 'react-router';
import type { Overview, Period, PublicConnection } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/Card';
import { DayBarChart } from '../components/DayBarChart';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { HealthBanner } from '../components/HealthBanner';
import { NowPlayingCard, useNowPlaying } from '../components/NowPlayingCard';
import { Spinner } from '../components/Spinner';
import { StatCard } from '../components/StatCard';
import { TopGames } from '../components/TopGames';
import { ago, daysUntil, fillDays, monthRange, todayIn, weekRange } from '../lib/dates';
import { formatDuration } from '../lib/format';
import { useApi } from '../lib/useApi';
import '../styles/overview.css';

const LIVE_MS = 10 * 60_000;

function connectionStatus(c: PublicConnection): { text: string; cls: string } {
  if (c.status === 'expiring' && c.secretExpiresAt) {
    const d = daysUntil(c.secretExpiresAt);
    return { text: `expires in ${d} day${d === 1 ? '' : 's'}`, cls: 'warn' };
  }
  if (c.status === 'expired') return { text: 'sign-in expired', cls: 'warn' };
  if (c.status === 'failing') return { text: 'sync failing', cls: 'warn' };
  if (c.status === 'disabled') return { text: 'disabled', cls: 'muted' };
  return { text: c.lastSyncAt ? `synced ${ago(c.lastSyncAt)}` : 'not synced yet', cls: 'muted' };
}

function Sources({ health }: { health: Overview['health'] }) {
  const [now] = useState(() => Date.now());
  const live = health.devices.some((d) => d.lastSeenAt && now - Date.parse(d.lastSeenAt) < LIVE_MS);
  const n = health.devices.length;
  return (
    <StatCard label="Sources">
      <div className="source-row">
        <span>
          Tracker · {n} PC{n === 1 ? '' : 's'}
        </span>
        <span className={live ? 'ok' : 'muted'}>{live ? 'Live' : 'Not running'}</span>
      </div>
      {health.connections.map((c) => {
        const s = connectionStatus(c);
        return (
          <div className="source-row" key={c.provider}>
            <span>{c.provider === 'psn' ? 'PlayStation' : 'Steam'}</span>
            <span className={s.cls}>{s.text}</span>
          </div>
        );
      })}
    </StatCard>
  );
}

function ChartCard({ today }: { today: string }) {
  const [range, setRange] = useState<'week' | 'month'>('week');
  const { from, to } = range === 'week' ? weekRange(today) : monthRange(today);
  const { data, error, loading, reload } = useApi<Period>(`/games/period?from=${from}&to=${to}`);
  return (
    <Card label="Playtime per day">
      <div className="card-head">
        <h2>Playtime per day · {range === 'week' ? 'this week' : 'this month'}</h2>
        <div role="group" aria-label="Chart range" className="seg-group">
          {(['week', 'month'] as const).map((r) => (
            <button key={r} type="button" className={r === range ? 'seg on' : 'seg'} aria-pressed={r === range} onClick={() => setRange(r)}>
              {r === 'week' ? 'This week' : 'This month'}
            </button>
          ))}
        </div>
        <div className="legend">
          <span>
            <i className="sw" aria-hidden="true" />
            Playtime
          </span>
          <span>
            <i className="sw sw-unknown" aria-hidden="true" />
            Unknown
          </span>
        </div>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading || !data ? (
        <Spinner />
      ) : (
        <DayBarChart days={fillDays(data.days, from, to)} futureAfter={today} labelEvery={range === 'month' ? 5 : undefined} />
      )}
    </Card>
  );
}

export function OverviewPage() {
  const { user } = useAuth();
  const timeZone = user?.timezone ?? 'UTC';
  const today = todayIn(timeZone);
  const { data: o, error, loading, reload } = useApi<Overview>('/games/overview');
  const now = useNowPlaying();

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !o) return <Spinner />;

  if (o.health.devices.length === 0 && o.health.connections.length === 0 && o.topGames30d.length === 0) {
    return (
      <EmptyState title="Install the tracker or connect Steam to start">
        <Link to="/settings">Add a device</Link> to track a PC, or <Link to="/settings">connect Steam or PlayStation</Link>.
      </EmptyState>
    );
  }

  const diff = o.thisWeek - o.lastWeek;
  const month = o.last30Days.reduce((s, d) => s + d.seconds, 0);
  const unknownDays = o.last30Days.filter((d) => d.unknownSources.length > 0).length;

  return (
    <div className="overview">
      <NowPlayingCard games={now} timeZone={timeZone} />
      <HealthBanner connections={o.health.connections} />
      <section className="stats" aria-label="Totals">
        <StatCard label="Today" value={formatDuration(o.today)}>
          <div className="muted">incl. current session</div>
        </StatCard>
        <StatCard label="This week" value={formatDuration(o.thisWeek)}>
          <div className="muted">
            <span className="delta">
              {diff < 0 ? '−' : '+'}
              {formatDuration(Math.abs(diff))}
            </span>{' '}
            vs last week ({formatDuration(o.lastWeek)})
          </div>
        </StatCard>
        <StatCard label="Last 30 days" value={formatDuration(month)}>
          {unknownDays > 0 && (
            <div className="muted">
              {unknownDays} day{unknownDays === 1 ? '' : 's'} unknown
            </div>
          )}
        </StatCard>
        <Sources health={o.health} />
      </section>
      <ChartCard today={today} />
      <TopGames games={o.topGames30d} />
    </div>
  );
}
