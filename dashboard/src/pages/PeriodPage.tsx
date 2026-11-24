import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Period, SessionRow } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Spinner } from '../components/Spinner';
import { StackedDayChart, groupGames, OTHER } from '../components/StackedDayChart';
import { UndatedNote } from '../components/UndatedNote';
import { addDays, daysBetween, fillDays, monthRange, todayIn, weekRange } from '../lib/dates';
import { formatDuration } from '../lib/format';
import { listable, sessionDay, sessionWhen } from '../lib/sessions';
import { useApi } from '../lib/useApi';
import '../styles/period.css';

const MAX_DAYS = 366;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

type Range = { from: string; to: string };

export function presets(today: string): { label: string; range: Range }[] {
  const week = weekRange(today);
  return [
    { label: 'This week', range: week },
    { label: 'Last week', range: weekRange(addDays(week.from, -7)) },
    { label: 'This month', range: monthRange(today) },
    { label: 'Last 30 days', range: { from: addDays(today, -29), to: today } },
  ];
}

/** Error text for a range, or null when it is fine to request. */
export function rangeError({ from, to }: Range): string | null {
  if (!ISO.test(from) || !ISO.test(to)) return 'Pick both a start and an end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  if (daysBetween(from, to) + 1 > MAX_DAYS) return `Choose at most ${MAX_DAYS} days.`;
  return null;
}

const dayLabel = (date: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`));

function Sessions({ range, period, timeZone }: { range: Range; period: Period; timeZone: string }) {
  const { data, error, loading, reload } = useApi<SessionRow[]>(`/games/sessions?from=${range.from}&to=${range.to}`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const colorOf = new Map(groupGames(period.games, period.dayGames).series.map((s) => [s.key, s.color]));
  const keyOf = new Map(period.games.map((g) => [g.libraryGameId, g.titleKey]));
  const keyByTitle = new Map(period.games.map((g) => [g.title, g.titleKey]));
  // Prefer the session's own titleKey, then its library row, then its title.
  const keyFor = (r: SessionRow) => r.titleKey ?? keyOf.get(r.libraryGameId) ?? keyByTitle.get(r.title) ?? '';
  const byDay = new Map<string, SessionRow[]>();
  for (const s of listable(data).sort((a, b) => b.endedAt.localeCompare(a.endedAt))) {
    const day = sessionDay(s, timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }
  if (!byDay.size) return <EmptyState title="No sessions in this period" />;
  return (
    <>
      {[...byDay].map(([day, rows]) => (
        <div key={day}>
          <div className="day-head">
            <span>{dayLabel(day)}</span>
            <span>{formatDuration(rows.reduce((t, r) => t + r.seconds, 0))}</span>
          </div>
          {rows.map((r) => (
            <div className="sess" key={r.id}>
              <span className="p-dot" aria-hidden="true" style={{ background: colorOf.get(keyFor(r)) ?? OTHER.color }} />
              <span className="name">{r.title}</span>
              <span className="when">{sessionWhen(r, timeZone).label}</span>
              <span className="dur">{formatDuration(r.seconds)}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

export function PeriodPage() {
  const { user } = useAuth();
  const timeZone = user?.timezone ?? 'UTC';
  const choices = presets(todayIn(timeZone));
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? choices[0].range.from;
  const to = params.get('to') ?? choices[0].range.to;
  const error = rangeError({ from, to });

  // The last valid range stays on screen while the inputs hold an invalid one.
  const [shown, setShown] = useState<Range | null>(error ? null : { from, to });
  if (!error && (shown?.from !== from || shown?.to !== to)) setShown({ from, to });

  const { data, error: loadError, loading, reload } = useApi<Period>(shown && `/games/period?from=${shown.from}&to=${shown.to}`);
  // Typing in a date input must not add a history entry per edit; presets may.
  const set = (r: Range, replace = false) => setParams({ from: r.from, to: r.to }, { replace });
  const total = (data?.days.reduce((s, d) => s + d.seconds, 0) ?? 0) + (data?.undatedSeconds ?? 0);
  const gameTotal = data?.games.reduce((s, g) => s + g.seconds, 0) ?? 0; // Share is of the games listed, so it never exceeds 100%
  const sessions = data?.games.reduce((s, g) => s + g.sessionCount, 0) ?? 0;
  const colors = new Map(data ? groupGames(data.games, data.dayGames).series.map((s) => [s.key, s.color]) : []);

  return (
    <div className="period">
      <h1>Period</h1>
      <Card label="Choose a period">
        <div className="picker">
          <div role="group" aria-label="Preset" className="seg-group">
            {choices.map((p) => {
              const on = p.range.from === from && p.range.to === to;
              return (
                <button key={p.label} type="button" className={on ? 'seg on' : 'seg'} aria-pressed={on} onClick={() => set(p.range)}>
                  {p.label}
                </button>
              );
            })}
          </div>
          <label>
            From
            <input type="date" value={from} aria-invalid={!!error} onChange={(e) => set({ from: e.target.value, to }, true)} />
          </label>
          <label>
            To
            <input type="date" value={to} aria-invalid={!!error} onChange={(e) => set({ from, to: e.target.value }, true)} />
          </label>
          <div className="totals">
            <div><div className="stat-label">Total</div><div className="stat-value">{formatDuration(total)}</div></div>
            <div><div className="stat-label">Games</div><div className="stat-value">{data?.games.length ?? 0}</div></div>
            <div><div className="stat-label">Sessions</div><div className="stat-value">{sessions}</div></div>
          </div>
          {error && <p className="range-error" role="alert">{error}</p>}
        </div>
      </Card>

      {loadError ? (
        <ErrorState error={loadError} onRetry={reload} />
      ) : !shown ? null : loading || !data ? (
        <Spinner />
      ) : data.games.length === 0 && total === 0 ? (
        <Card>
          <EmptyState title="No play in this period" />
        </Card>
      ) : (
        <>
          <Card label="Per day, by game">
            <div className="card-head">
              <h2>Per day, by game</h2>
            </div>
            <StackedDayChart days={fillDays(data.days, shown.from, shown.to)} games={data.games} dayGames={data.dayGames} />
            <UndatedNote seconds={data.undatedSeconds} />
          </Card>
          <div className="period-split">
            <Card label="Per game">
              <div className="card-head">
                <h2>Per game</h2>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Game</th>
                      <th scope="col" className="num">Time</th>
                      <th scope="col" className="num">Share</th>
                      <th scope="col" className="num">Sessions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.games].sort((a, b) => b.seconds - a.seconds).map((g) => (
                      <tr key={g.titleKey}>
                        <td>
                          <span className="p-game">
                            <span className="p-dot" aria-hidden="true" style={{ background: colors.get(g.titleKey) ?? OTHER.color }} />
                            <Link to={`/games/${g.libraryGameId}`}>{g.title}</Link>
                          </span>
                        </td>
                        <td className="num">{formatDuration(g.seconds)}</td>
                        <td className="num">{gameTotal ? `${Math.round((g.seconds / gameTotal) * 100)}%` : '—'}</td>
                        <td className="num">{g.sessionCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card label="All sessions, by day">
              <div className="card-head">
                <h2>All sessions, by day</h2>
              </div>
              <Sessions range={shown} period={data} timeZone={timeZone} />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
