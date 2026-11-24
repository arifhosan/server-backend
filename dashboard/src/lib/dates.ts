import type { DayPoint } from '../api/types';

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Calendar date (YYYY-MM-DD) in `timeZone` at `now`. Never uses the browser zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Monday to Sunday containing `today`. */
export function weekRange(today: string): { from: string; to: string } {
  const offset = (new Date(toUtc(today)).getUTCDay() + 6) % 7; // Monday = 0
  const from = toUtc(today) - offset * DAY;
  return { from: fromUtc(from), to: fromUtc(from + 6 * DAY) };
}

/** First to last day of the month containing `today`. */
export function monthRange(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  return { from: `${y}-${pad(m)}-01`, to: fromUtc(Date.UTC(y, m, 0)) };
}

/** One point per day from..to; days the API omitted are 0 seconds and known (not unknown). */
export function fillDays(points: DayPoint[], from: string, to: string): DayPoint[] {
  const byDate = new Map(points.map((p) => [p.date, p]));
  const out: DayPoint[] = [];
  for (let t = toUtc(from); t <= toUtc(to); t += DAY) {
    const date = fromUtc(t);
    out.push(byDate.get(date) ?? { date, seconds: 0, estimated: false, unknownSources: [] });
  }
  return out;
}

/** "5 min ago", "2 h ago", "3 d ago". */
export function ago(iso: string, now: Date = new Date()): string {
  const min = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}

/** Whole days left until `iso` (rounded up), never below 0. */
export const daysUntil = (iso: string, now: Date = new Date()) =>
  Math.max(0, Math.ceil((Date.parse(iso) - now.getTime()) / DAY));
