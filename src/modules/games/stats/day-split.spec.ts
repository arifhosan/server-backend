import { localDate, splitIntoDays, unknownDays } from './day-split';

const d = (s: string) => new Date(s);
const plain = (m: Map<string, { seconds: number; estimated: boolean }>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.seconds]));
const one = (a: string, b: string, seconds: number) => ({
  startedAt: d(a),
  endedAt: d(b),
  seconds,
});

describe('day-split', () => {
  it('localDate uses the time zone', () => {
    expect(localDate(d('2026-11-24T23:30:00Z'), 'Europe/Berlin')).toBe(
      '2026-11-25',
    );
    expect(localDate(d('2026-11-24T23:30:00Z'), 'America/Toronto')).toBe(
      '2026-11-24',
    );
  });

  it('splits a session over local midnight (Berlin)', () => {
    const m = splitIntoDays(
      [one('2026-11-24T22:30:00Z', '2026-11-24T23:30:00Z', 3600)],
      'Europe/Berlin',
    );
    expect(plain(m)).toEqual({ '2026-11-24': 1800, '2026-11-25': 1800 });
    expect([...m.values()].some((v) => v.estimated)).toBe(false);
  });

  it('keeps a session across the Berlin DST start on one day', () => {
    const m = splitIntoDays(
      [one('2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', 3600)],
      'Europe/Berlin',
    );
    expect(plain(m)).toEqual({ '2026-03-29': 3600 });
  });

  it('spreads a 72 h window evenly and flags it estimated', () => {
    const m = splitIntoDays(
      [one('2026-11-21T23:00:00Z', '2026-11-24T23:00:00Z', 18000)],
      'Europe/Berlin',
    );
    expect(plain(m)).toEqual({
      '2026-11-22': 6000,
      '2026-11-23': 6000,
      '2026-11-24': 6000,
    });
    expect([...m.values()].every((v) => v.estimated)).toBe(true);
  });

  it('splits over local midnight in Toronto', () => {
    const m = splitIntoDays(
      [one('2026-11-25T04:30:00Z', '2026-11-25T05:30:00Z', 3600)],
      'America/Toronto',
    );
    expect(plain(m)).toEqual({ '2026-11-24': 1800, '2026-11-25': 1800 });
  });

  it('weights days by real length across a DST change', () => {
    // Berlin 2026-03-28 23:00Z -> 03-29 22:00Z is the 23 h local day of 03-29.
    const m = splitIntoDays(
      [one('2026-03-28T20:00:00Z', '2026-03-29T04:00:00Z', 8 * 3600)],
      'Europe/Berlin',
    );
    expect(plain(m)).toEqual({
      '2026-03-28': 3 * 3600,
      '2026-03-29': 5 * 3600,
    });
  });

  it('keeps the total when proportions do not divide evenly', () => {
    const m = splitIntoDays(
      [one('2026-11-24T22:00:00Z', '2026-11-25T01:00:00Z', 1000)],
      'Europe/Berlin',
    );
    expect([...m.values()].reduce((a, v) => a + v.seconds, 0)).toBe(1000);
  });

  it('unknownDays lists days without an ok run', () => {
    expect(
      unknownDays(
        [
          { startedAt: d('2026-11-21T10:00:00Z'), ok: true },
          { startedAt: d('2026-11-22T10:00:00Z'), ok: false },
          { startedAt: d('2026-11-23T10:00:00Z'), ok: true },
        ],
        d('2026-11-01T00:00:00Z'),
        '2026-11-21',
        '2026-11-23',
        'Europe/Berlin',
      ),
    ).toEqual(['2026-11-22']);
  });

  it('unknownDays skips days before creation or before the run history', () => {
    const runs = [{ startedAt: d('2026-11-23T10:00:00Z'), ok: true }];
    expect(
      unknownDays(
        runs,
        d('2026-11-01T00:00:00Z'),
        '2026-11-01',
        '2026-11-25',
        'Europe/Berlin',
      ),
    ).toEqual(['2026-11-24', '2026-11-25']);
    expect(
      unknownDays(
        [],
        d('2026-11-01T00:00:00Z'),
        '2026-11-01',
        '2026-11-03',
        'UTC',
      ),
    ).toEqual([]);
  });
});
