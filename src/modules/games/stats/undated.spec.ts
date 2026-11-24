import { SessionSource } from '../games.types';
import { isNoise, partitionSessions } from './undated';

const s = (source: SessionSource, a: string, b: string, seconds = 3600) => ({
  source,
  startedAt: new Date(a),
  endedAt: new Date(b),
  seconds,
});
const TZ = 'Europe/Berlin';

describe('undated sessions', () => {
  it('isNoise: PSN/Steam under 5 min only', () => {
    expect(isNoise({ source: 'psn', seconds: 4 })).toBe(true);
    expect(isNoise({ source: 'steam', seconds: 299 })).toBe(true);
    expect(isNoise({ source: 'psn', seconds: 300 })).toBe(false);
    expect(isNoise({ source: 'tracker', seconds: 4 })).toBe(false);
    expect(isNoise({ source: 'import', seconds: 4 })).toBe(false);
  });

  it('a multi-day PSN/Steam window becomes one block before its end; tracker is untouched', () => {
    const gta = s('psn', '2026-11-21T23:00:00Z', '2026-11-24T18:34:00Z');
    const oneDay = s('steam', '2026-11-24T06:00:00Z', '2026-11-24T07:00:00Z');
    // Ends exactly at Berlin midnight: still the day before.
    const toMidnight = s('psn', '2026-11-23T20:00:00Z', '2026-11-23T23:00:00Z');
    const tracker = s(
      'tracker',
      '2026-11-22T22:30:00Z',
      '2026-11-22T23:30:00Z',
    );
    const noise = s('psn', '2026-11-21T23:00:00Z', '2026-11-24T18:34:00Z', 4);
    const p = partitionSessions([gta, oneDay, toMidnight, tracker, noise], TZ);
    expect(p.undated).toEqual([]);
    expect(p.dated).toEqual([
      {
        ...gta,
        startedAt: new Date(gta.endedAt.getTime() - gta.seconds * 1000),
      },
      oneDay,
      toMidnight,
      tracker,
    ]);
  });

  it('a block that does not fit its end day spills back, never before the window start', () => {
    // 5 h ending 02:00 Berlin on 11-24: starts 21:00 Berlin on 11-23.
    const late = s(
      'psn',
      '2026-11-21T23:00:00Z',
      '2026-11-24T01:00:00Z',
      5 * 3600,
    );
    expect(partitionSessions([late], TZ).dated[0].startedAt).toEqual(
      new Date('2026-11-23T20:00:00Z'),
    );
    // More seconds than the window: the start stays at the window start.
    const over = s(
      'steam',
      '2026-11-23T20:00:00Z',
      '2026-11-24T01:00:00Z',
      9 * 3600,
    );
    expect(partitionSessions([over], TZ).dated[0].startedAt).toEqual(
      over.startedAt,
    );
  });
});
