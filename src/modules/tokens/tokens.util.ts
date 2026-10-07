import { TokenDay } from './entities/token-day.entity';

export type PublicTokenDay = {
  date: string;
  total: number | null;
  cost: number | null;
};

/** 'YYYY-MM-DD' in Europe/Berlin, where the posting machine lives and ccusage dates its rows. */
export function berlinToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(
    now,
  );
}

/**
 * The last `count` calendar days ending at `today`, oldest first. A day with
 * no row comes back as nulls, so a missed upload shows as a gap rather than
 * as a zero-usage day.
 */
export function lastDays(
  rows: TokenDay[],
  today: string,
  count: number,
): PublicTokenDay[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const end = new Date(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (count - 1 - i));
    const date = d.toISOString().slice(0, 10);
    const row = byDate.get(date);
    return {
      date,
      total: row?.totalTokens ?? null,
      cost: row?.totalCost ?? null,
    };
  });
}
