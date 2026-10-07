import { TokenDay } from './entities/token-day.entity';
import { lastDays } from './tokens.util';

const row = (date: string, totalTokens: number, totalCost: number): TokenDay =>
  ({ date, totalTokens, totalCost }) as TokenDay;

describe('lastDays', () => {
  it('returns N days ending today, oldest first, with nulls for gaps', () => {
    const days = lastDays(
      [row('2026-10-07', 100, 1.5), row('2026-10-05', 50, 0.5)],
      '2026-10-07',
      3,
    );
    expect(days).toEqual([
      { date: '2026-10-05', total: 50, cost: 0.5 },
      { date: '2026-10-06', total: null, cost: null },
      { date: '2026-10-07', total: 100, cost: 1.5 },
    ]);
  });

  it('crosses a month boundary', () => {
    expect(lastDays([], '2026-10-01', 2).map((d) => d.date)).toEqual([
      '2026-09-30',
      '2026-10-01',
    ]);
  });
});
