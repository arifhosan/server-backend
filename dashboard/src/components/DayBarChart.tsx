import type { DayPoint } from '../api/types';
import { formatDuration } from '../lib/format';
import '../styles/overview.css';

interface Props {
  days: DayPoint[];
  /** Label every n-th day by its day number; omitted = weekday and day on every bar. */
  labelEvery?: number;
  /** Days after this date (YYYY-MM-DD) are not yet lived: greyed, no data. */
  futureAfter?: string;
}

const H = 200;
const fmt = (date: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${date}T00:00:00Z`));
const short = (date: string) => fmt(date, { month: 'short', day: 'numeric' });

export function DayBarChart({ days, labelEvery, futureAfter }: Props) {
  const isFuture = (d: DayPoint) => futureAfter !== undefined && d.date > futureAfter;
  const isUnknown = (d: DayPoint) => !isFuture(d) && d.unknownSources.length > 0;
  const max = Math.max(0, ...days.map((d) => d.seconds));
  const top = Math.max(4, Math.ceil(max / 3600 / 4) * 4); // y axis in whole hours, 4 steps
  const total = days.reduce((s, d) => s + d.seconds, 0);
  const best = days.reduce<DayPoint | null>((b, d) => (d.seconds > (b?.seconds ?? 0) ? d : b), null);
  const unknown = days.filter(isUnknown).length;
  const label = [
    days.length ? `Daily playtime ${short(days[0].date)} to ${short(days[days.length - 1].date)}.` : 'Daily playtime.',
    `Total ${formatDuration(total)}.`,
    best ? `Highest day: ${short(best.date)} with ${formatDuration(best.seconds)}.` : 'No playtime.',
    unknown ? `${unknown} day${unknown > 1 ? 's' : ''} unknown.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const tip = (d: DayPoint) =>
    `${fmt(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}: ` +
    (isFuture(d) ? 'not yet' : isUnknown(d) ? `unknown (no data from ${d.unknownSources.join(', ')})` : formatDuration(d.seconds));

  return (
    <div role="img" aria-label={label} className="chart-scroll">
      <div className="chart" style={{ minWidth: days.length > 10 ? 640 : 0 }}>
        <div className="chart-y" aria-hidden="true" style={{ height: H }}>
          {[4, 3, 2, 1, 0].map((i) => (
            <span key={i}>{i ? `${(top * i) / 4}h` : '0'}</span>
          ))}
        </div>
        <div className="chart-main">
          <div className="chart-plot" style={{ height: H, backgroundSize: `100% ${H / 4}px` }}>
            {days.map((d) => (
              <div key={d.date} className="chart-col" title={tip(d)} style={{ height: H }}>
                {isUnknown(d) ? (
                  <div className="bar-unknown" style={{ height: H - 4 }} />
                ) : (
                  !isFuture(d) &&
                  d.seconds > 0 && <div className="bar" style={{ height: Math.max(2, (d.seconds / 3600 / top) * H) }} />
                )}
              </div>
            ))}
          </div>
          <div className="chart-x" aria-hidden="true">
            {days.map((d, i) => (
              <span key={d.date} className={isFuture(d) ? 'future' : undefined}>
                {labelEvery
                  ? i % labelEvery === 0 || i === days.length - 1
                    ? fmt(d.date, { day: 'numeric' })
                    : ''
                  : fmt(d.date, { weekday: 'short', day: 'numeric' })}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
