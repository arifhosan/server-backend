import type { DayPoint, Period } from '../api/types';
import { formatDuration } from '../lib/format';
import '../styles/overview.css';
import '../styles/period.css';

export const COLORS = ['#5B9BFF', '#F59E0B', '#A3E635', '#C084FC'];
export const OTHER = { key: 'other', title: 'Other', color: '#7D8594' };

export interface Series {
  key: string;
  title: string;
  color: string;
}

/** Top 4 games by time keep their own colour; every other game is summed into "Other". */
export function groupGames(games: Period['games'], dayGames: Period['dayGames']) {
  const top = [...games].sort((a, b) => b.seconds - a.seconds).slice(0, 4);
  const isTop = new Set(top.map((g) => g.titleKey));
  const series: Series[] = top.map((g, i) => ({ key: g.titleKey, title: g.title, color: COLORS[i] }));
  const perDay = new Map<string, Map<string, number>>();
  let hasOther = false;
  for (const r of dayGames) {
    const key = isTop.has(r.titleKey) ? r.titleKey : OTHER.key;
    hasOther ||= key === OTHER.key;
    const day = perDay.get(r.date) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + r.seconds);
    perDay.set(r.date, day);
  }
  if (hasOther) series.push(OTHER);
  return { series, perDay };
}

const H = 200;
const fmt = (date: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${date}T00:00:00Z`));

interface Props {
  days: DayPoint[];
  games: Period['games'];
  dayGames: Period['dayGames'];
}

export function StackedDayChart({ days, games, dayGames }: Props) {
  const { series, perDay } = groupGames(games, dayGames);
  const max = Math.max(1, ...days.map((d) => d.seconds));
  const total = days.reduce((s, d) => s + d.seconds, 0);
  const every = days.length > 14 ? Math.ceil(days.length / 8) : 0;
  const short = { month: 'short', day: 'numeric' } as const;
  const range = days.length ? `${fmt(days[0].date, short)} to ${fmt(days[days.length - 1].date, short)}` : '';
  const label = `Playtime per day by game, ${range}, total ${formatDuration(total)}.`;

  return (
    <>
      <div className="legend" aria-label="Games">
        {series.map((s) => (
          <span key={s.key}>
            <i className="sw" aria-hidden="true" style={{ background: s.color }} />
            {s.title}
          </span>
        ))}
      </div>
      <div role="img" aria-label={label} className="chart-scroll">
        <div className="stack" style={{ minWidth: days.length > 10 ? 640 : 0 }}>
          <div className="stack-plot" style={{ height: H }}>
            {days.map((d) => {
              const unknown = d.unknownSources.length > 0;
              const parts = series.map((s) => ({ s, sec: perDay.get(d.date)?.get(s.key) ?? 0 })).filter((p) => p.sec > 0);
              const tip =
                `${fmt(d.date, { weekday: 'short', ...short })}: ` +
                (unknown ? `unknown (no data from ${d.unknownSources.join(', ')})` : d.seconds ? formatDuration(d.seconds) : 'no play');
              return (
                <div key={d.date} className="stack-col" title={tip} style={{ height: H }}>
                  {unknown && <div className="bar-unknown" style={{ height: H - 4 }} />}
                  {!unknown &&
                    parts.map((p) => (
                      <div key={p.s.key} className="stack-seg" style={{ height: Math.max(2, (p.sec / max) * (H - 10)), background: p.s.color }} />
                    ))}
                </div>
              );
            })}
          </div>
          <div className="stack-x" aria-hidden="true">
            {days.map((d, i) => (
              <span key={d.date}>
                {every ? (i % every === 0 ? fmt(d.date, { day: 'numeric' }) : '') : fmt(d.date, { weekday: 'short', day: 'numeric' })}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
