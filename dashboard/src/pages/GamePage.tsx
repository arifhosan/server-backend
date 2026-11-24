import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { GameDetail, PublicDevice } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { GameArt } from '../components/GameArt';
import { GameDayChart } from '../components/GameDayChart';
import { PlatformChip } from '../components/PlatformChip';
import { RangeToggle } from '../components/RangeToggle';
import { Spinner } from '../components/Spinner';
import { UndatedNote } from '../components/UndatedNote';
import { addDays, dayOf, fillDays, relativeDay, shortDay, todayIn } from '../lib/dates';
import { formatDuration } from '../lib/format';
import { listable, sessionDay, sessionWhen, sessionWhere } from '../lib/sessions';
import { PLATFORM_LABEL } from '../lib/sort';
import { useApi } from '../lib/useApi';
import '../styles/game.css';

type Range = '30' | '90' | '365' | 'all';
const RANGES: { id: Range; label: string }[] = [
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: '365', label: '1 year' },
  { id: 'all', label: 'All' },
];

export function GamePage() {
  const { id } = useParams();
  const tz = useAuth().user?.timezone ?? 'UTC';
  const game = useApi<GameDetail>(`/games/library/${encodeURIComponent(id ?? '')}`);
  const devs = useApi<PublicDevice[]>('/games/devices');
  const [range, setRange] = useState<Range>('30');
  const today = todayIn(tz);

  const devices = useMemo(() => new Map((devs.data ?? []).map((d) => [d.id, d.name])), [devs.data]);
  const g = game.data;

  const chart = useMemo(() => {
    if (!g) return null;
    // A client clock behind the server must not put the first play after `today`.
    const first = g.daily.reduce((m, d) => (d.date < m ? d.date : m), today);
    const from = range === 'all' ? first : addDays(today, 1 - Number(range));
    const days = fillDays(g.daily, from, today);
    const sum = days.reduce((s, d) => s + d.seconds, 0);
    const best = days.reduce((b, d) => (d.seconds > b.seconds ? d : b), days[0]);
    const span = range === 'all' ? `since ${shortDay(from)}` : `over the last ${range} days`;
    return { days, sum, best, label: `Daily playtime of ${g.title} ${span}, total ${formatDuration(sum)}` };
  }, [g, range, today]);

  if (game.error?.status === 404 || game.error?.status === 400) {
    return (
      <div className="page">
        <EmptyState title="This game isn't in your library">
          <Link to="/library">Back to the Library</Link>
        </EmptyState>
      </div>
    );
  }
  if (game.error) return <ErrorState error={game.error} onRetry={game.reload} />;
  if (!g || !chart) return <Spinner />;

  const date = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const sessions = listable(g.sessions);

  return (
    <div className="page">
      <Link to="/library" className="back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Library
      </Link>

      <section className="game-hero">
        <GameArt imageUrl={g.imageUrl} hasIcon={g.hasIcon} iconLibraryGameId={g.iconLibraryGameId} libraryGameId={g.platforms[0]?.libraryGameId ?? 0} title={g.title} size="xl" />
        <div className="game-hero-info">
          <h1>{g.title}</h1>
          <div className="chips">
            {g.platforms.map((p) => (
              <PlatformChip key={p.libraryGameId} platform={p.platform} />
            ))}
          </div>
          <dl className="facts">
            <div>
              <dt>Total</dt>
              <dd>{formatDuration(g.totalSeconds)}</dd>
            </div>
            <div>
              <dt>Sessions in list</dt>
              <dd>{sessions.length}</dd>
            </div>
            <div>
              <dt>Last played</dt>
              <dd>{g.lastPlayedAt ? relativeDay(dayOf(g.lastPlayedAt, tz), today) : 'Never'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <ul aria-label="Per platform" className="plat-cards">
        {g.platforms.map((p) => (
          <li key={p.libraryGameId}>
            <span>{PLATFORM_LABEL[p.platform]}</span>
            <b>{formatDuration(p.totalSeconds)}</b>
          </li>
        ))}
      </ul>

      <section aria-labelledby="g-chart" className="chart-card">
        <div className="chart-head">
          <h2 id="g-chart">Playtime over days</h2>
          <RangeToggle options={RANGES} value={range} onChange={setRange} />
        </div>
        <div className="chart-stats">
          <span>
            In range <strong>{formatDuration(chart.sum)}</strong>
          </span>
          <span>
            Daily average <strong>{formatDuration(chart.sum / chart.days.length)}</strong>
          </span>
          <span>
            Best day{' '}
            <strong>{chart.best.seconds > 0 ? `${shortDay(chart.best.date)} · ${formatDuration(chart.best.seconds)}` : '—'}</strong>
          </span>
        </div>
        <GameDayChart days={chart.days} label={chart.label} />
        {/* Undated play is known only as an all-time sum, so it is noted on the all-time view. */}
        {range === 'all' && <UndatedNote seconds={g.undatedSeconds} />}
      </section>

      <section aria-labelledby="g-sess" className="sessions">
        <h2 id="g-sess">Recent sessions</h2>
        {sessions.length === 0 ? (
          <EmptyState title="No sessions yet" />
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Time</th>
                <th scope="col">Where</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{date.format(new Date(`${sessionDay(s, tz)}T00:00:00Z`))}</td>
                  <td>{sessionWhen(s, tz).label}</td>
                  <td>{sessionWhere(s, s.deviceId === null ? undefined : (devices.get(s.deviceId) ?? 'Tracker'))}</td>
                  <td className="num">{formatDuration(s.seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
