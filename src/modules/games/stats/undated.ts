import { SessionSource } from '../games.types';
import { MIN_SESSION_SECONDS } from '../sync/repair-plan';
import { localDate } from './day-split';

const PLATFORM_SOURCES: SessionSource[] = ['psn', 'steam'];

interface Timed {
  source: SessionSource;
  startedAt: Date;
  endedAt: Date;
  seconds: number;
}

/** The one noise rule for every stats read: a PSN/Steam session under 5 min is never shown. */
export const isNoise = (s: Pick<Timed, 'source' | 'seconds'>): boolean =>
  PLATFORM_SOURCES.includes(s.source) && s.seconds < MIN_SESSION_SECONDS;

/** A PSN/Steam session whose window spans more than one local day: when it was played is unknown. */
export interface Undated<T> {
  s: T;
  /** First and last local day of its window. */
  from: string;
  to: string;
}

/**
 * Drops noise and sets undated sessions apart: they go on no day, and count in a range only when
 * their whole window lies inside it (`undatedIn`). Tracker and import sessions are always dated.
 */
export function partitionSessions<T extends Timed>(
  sessions: T[],
  timeZone: string,
): { dated: T[]; undated: Undated<T>[] } {
  const dated: T[] = [];
  const undated: Undated<T>[] = [];
  for (const s of sessions) {
    if (isNoise(s)) continue;
    if (!PLATFORM_SOURCES.includes(s.source)) {
      dated.push(s);
      continue;
    }
    const from = localDate(s.startedAt, timeZone);
    // A window ending exactly at midnight ends on the day before.
    const to =
      s.endedAt > s.startedAt
        ? localDate(new Date(s.endedAt.getTime() - 1), timeZone)
        : from;
    if (from === to) dated.push(s);
    else undated.push({ s, from, to });
  }
  return { dated, undated };
}

/** Undated sessions whose whole window lies inside local days [from, to]. */
export const undatedIn = <T>(undated: Undated<T>[], from: string, to: string) =>
  undated.filter((u) => u.from >= from && u.to <= to);

export const seconds = (xs: { seconds: number }[]) =>
  xs.reduce((a, x) => a + x.seconds, 0);
