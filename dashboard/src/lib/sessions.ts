import { todayIn } from './dates';

type S = { source: string; deviceId: number | null; startedAt: string; endedAt: string; seconds: number };

const DAILY = ['exophase', 'import'];
const SYNC = ['steam', 'psn'];
const WHERE: Record<string, string> = { exophase: 'Exophase import', import: 'Exophase import', steam: 'Steam sync', psn: 'PlayStation sync' };
const DAY_MS = 86_400_000;

const clock = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const mon = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' });

/** What to show in a "Time" column: never a fake clock time for imports and syncs. */
export function sessionWhen(s: S, timeZone: string): { label: string } {
  const a = new Date(s.startedAt);
  const b = new Date(s.endedAt);
  const range = (f: Intl.DateTimeFormat) => `${f.format(a)} – ${f.format(b)}`;
  if (DAILY.includes(s.source)) return { label: 'Daily total (Exophase)' };
  if (SYNC.includes(s.source)) {
    if (b.getTime() - a.getTime() <= DAY_MS) return { label: `Synced ${range(clock(timeZone))}` };
    const m = mon(timeZone);
    return { label: `Synced between ${m.format(a)} and ${m.format(b)}` };
  }
  if (s.source === 'tracker') return { label: range(clock(timeZone)) };
  return { label: range(mon(timeZone)) };
}

/** Where the time came from; tracker keeps its device name. */
export const sessionWhere = (s: S, deviceName?: string) => WHERE[s.source] ?? deviceName ?? 'Tracker';

/** Local date a session belongs to. Imports and syncs are dated by their end; endedAt - 1 min keeps a
 * 23:00Z -> 23:00Z daily row (Berlin 00:00 -> 00:00) on the day it covers, not the next. */
export function sessionDay(s: S, timeZone: string): string {
  const end = Date.parse(s.endedAt) - 60_000;
  return todayIn(timeZone, new Date(s.source === 'tracker' ? s.startedAt : end));
}

/** Sub-minute non-tracker rows are noise. */
export const listable = <T extends S>(rows: T[]): T[] => rows.filter((s) => s.source === 'tracker' || s.seconds >= 60);
