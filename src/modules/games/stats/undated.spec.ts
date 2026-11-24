import { SessionSource } from '../games.types';
import { isNoise, partitionSessions, undatedIn } from './undated';

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

  it('a PSN/Steam window over several local days is undated; tracker never is', () => {
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
    expect(p.dated).toEqual([oneDay, toMidnight, tracker]);
    expect(p.undated).toEqual([
      { s: gta, from: '2026-11-22', to: '2026-11-24' },
    ]);
    expect(undatedIn(p.undated, '2026-11-23', '2026-11-29')).toEqual([]);
    expect(undatedIn(p.undated, '2026-11-22', '2026-11-24')).toHaveLength(1);
    expect(undatedIn(p.undated, '2026-11-01', '2026-11-30')).toHaveLength(1);
  });
});
