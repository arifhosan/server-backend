import type { DayPoint } from '../api/types';
import { DayBarChart } from './DayBarChart';

/** One bar per day of an already gap-filled list; the shared Overview chart, so axis and unknown-day hatching match. */
export function GameDayChart({ days, label }: { days: DayPoint[]; label: string }) {
  return (
    <DayBarChart
      days={days}
      label={label}
      dateLabels
      gap={days.length > 100 ? 1 : 3}
      labelEvery={days.length > 14 ? Math.ceil(days.length / 8) : undefined}
    />
  );
}
