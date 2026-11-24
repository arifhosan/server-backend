import { ago, daysUntil, fillDays, monthRange, todayIn, weekRange } from './dates';

describe('dates', () => {
  it('weekRange is Mon-Sun containing today', () => {
    expect(weekRange('2026-11-24')).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(weekRange('2026-11-29')).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(weekRange('2026-11-23')).toEqual({ from: '2026-11-23', to: '2026-11-29' });
  });

  it('monthRange covers the whole month, incl. leap February', () => {
    expect(monthRange('2026-11-24')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('todayIn uses the given zone, not the browser zone', () => {
    const now = new Date('2026-11-25T03:00:00Z');
    expect(todayIn('America/Toronto', now)).toBe('2026-11-24');
    expect(todayIn('Asia/Dhaka', now)).toBe('2026-11-25');
  });

  it('fillDays fills gaps with known zero days', () => {
    const p = { date: '2026-11-24', seconds: 60, estimated: false, unknownSources: [] };
    const out = fillDays([p], '2026-11-23', '2026-11-25');
    expect(out.map((d) => d.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25']);
    expect(out.map((d) => d.seconds)).toEqual([0, 60, 0]);
    expect(out[0].unknownSources).toEqual([]);
  });

  it('ago and daysUntil', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(ago('2026-11-24T11:48:00Z', now)).toBe('12 min ago');
    expect(ago('2026-11-23T08:00:00Z', now)).toBe('1 d ago');
    expect(daysUntil('2026-12-03T00:00:00Z', now)).toBe(9);
  });
});
