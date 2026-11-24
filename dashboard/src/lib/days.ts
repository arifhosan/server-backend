import type { DayPoint } from '../api/types';

const MS = 86_400_000;
const utc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** YYYY-MM-DD of an instant in the user's timezone (never the browser's). */
export function dayOf(when: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(when),
  );
}

export const todayIn = (timeZone: string) => dayOf(new Date(), timeZone);

export const addDays = (ymd: string, n: number) => new Date(utc(ymd) + n * MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / MS);

/** "Nov 24" */
export const shortDay = (ymd: string) => {
  const d = new Date(utc(ymd));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/** Every day from..to inclusive; days missing from the sparse list become 0 seconds. */
export function fillDays(sparse: DayPoint[], from: string, to: string): DayPoint[] {
  const byDate = new Map(sparse.map((d) => [d.date, d]));
  const out: DayPoint[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(byDate.get(d) ?? { date: d, seconds: 0, estimated: false, unknownSources: [] });
  }
  return out;
}

/** "Today", "Yesterday", "5 days ago", "3 months ago", both arguments are user-timezone days. */
export function relativeDay(day: string, today: string): string {
  const n = daysBetween(day, today);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 30) return `${n} days ago`;
  const m = Math.round(n / 30);
  return m === 1 ? '1 month ago' : `${m} months ago`;
}
