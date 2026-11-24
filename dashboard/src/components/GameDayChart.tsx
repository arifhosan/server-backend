import type { DayPoint } from '../api/types';
import { shortDay } from '../lib/days';
import { formatDuration } from '../lib/format';
import '../styles/game.css';

const tip = (d: DayPoint) =>
  `${shortDay(d.date)}: ${formatDuration(d.seconds)}${d.estimated ? ' (estimated)' : ''}${
    d.unknownSources.length ? ' (unknown: sync data missing)' : ''
  }`;

/** One bar per day of an already gap-filled list. Unknown (missing sync) days are hatched, not zero. */
export function GameDayChart({ days, label }: { days: DayPoint[]; label: string }) {
  const max = Math.max(1, ...days.map((d) => d.seconds));
  return (
    <div role="img" aria-label={label} className="chart-scroll">
      <div className="chart-inner">
        <div className="bars" style={{ gap: days.length > 100 ? 1 : 3 }}>
          {days.map((d) => (
            <div
              key={d.date}
              title={tip(d)}
              className={d.unknownSources.length ? 'day-bar day-bar-unknown' : 'day-bar'}
              style={{ height: d.unknownSources.length ? 170 : Math.round((d.seconds / max) * 170) }}
            />
          ))}
        </div>
        <div aria-hidden="true" className="chart-axis">
          <span>{shortDay(days[0].date)}</span>
          <span>{shortDay(days[days.length - 1].date)}</span>
        </div>
      </div>
    </div>
  );
}
