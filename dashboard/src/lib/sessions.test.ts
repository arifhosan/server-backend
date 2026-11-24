import { listable, sessionDay, sessionWhen, sessionWhere } from './sessions';

const TZ = 'Europe/Berlin';
const mk = (source: string, startedAt: string, endedAt: string, seconds = 3600) => ({ source, deviceId: null, startedAt, endedAt, seconds });
const exo = mk('exophase', '2026-11-20T23:00:00Z', '2026-11-21T23:00:00Z', 7200);

describe('sessionWhen', () => {
  it('tracker shows clock times in the zone', () => {
    expect(sessionWhen(mk('tracker', '2026-11-23T18:40:00Z', '2026-11-23T21:55:00Z'), TZ).label).toBe('19:40 – 22:55');
  });
  it('exophase and import show no times', () => {
    expect(sessionWhen(exo, TZ).label).toBe('Daily total (history)');
    expect(sessionWhen({ ...exo, source: 'import' }, TZ).label).toBe('Daily total (history)');
  });
  it('steam/psn short window shows synced clock, long window shows dates', () => {
    expect(sessionWhen(mk('steam', '2026-11-20T13:18:00Z', '2026-11-20T14:37:00Z'), TZ).label).toBe('Synced 14:18 – 15:37');
    expect(sessionWhen(mk('psn', '2026-11-20T10:00:00Z', '2026-11-21T10:00:00Z'), TZ).label).toBe('Synced 11:00 – 11:00');
    expect(sessionWhen(mk('psn', '2026-11-18T10:00:00Z', '2026-11-21T10:00:00Z'), TZ).label).toBe('Synced between Nov 18 and Nov 21');
  });
  it('unknown source shows the date range', () => {
    expect(sessionWhen(mk('mystery', '2026-11-18T10:00:00Z', '2026-11-21T10:00:00Z'), TZ).label).toBe('Nov 18 – Nov 21');
  });
});

describe('sessionWhere', () => {
  it('labels sources and keeps the tracker device', () => {
    expect(sessionWhere(exo)).toBe('Imported history');
    expect(sessionWhere(mk('import', exo.startedAt, exo.endedAt))).toBe('Imported history');
    expect(sessionWhere(mk('steam', exo.startedAt, exo.endedAt))).toBe('Steam sync');
    expect(sessionWhere(mk('psn', exo.startedAt, exo.endedAt))).toBe('PlayStation sync');
    expect(sessionWhere(mk('tracker', exo.startedAt, exo.endedAt), 'DESKTOP-ARIF')).toBe('DESKTOP-ARIF');
  });
});

describe('sessionDay', () => {
  it('puts the Nov 20 23:00Z to Nov 21 23:00Z daily row on Nov 21', () => {
    expect(sessionDay(exo, TZ)).toBe('2026-11-21');
  });
  it('dates syncs by end and trackers by start', () => {
    expect(sessionDay(mk('steam', '2026-11-18T10:00:00Z', '2026-11-21T10:00:00Z'), TZ)).toBe('2026-11-21');
    expect(sessionDay(mk('tracker', '2026-11-23T22:30:00Z', '2026-11-24T01:00:00Z'), TZ)).toBe('2026-11-23');
  });
});

describe('listable', () => {
  it('hides sub-minute non-tracker rows only', () => {
    const rows = [mk('tracker', 'a', 'b', 20), mk('steam', 'a', 'b', 20), mk('exophase', 'a', 'b', 59), mk('psn', 'a', 'b', 60)];
    expect(listable(rows).map((r) => r.source)).toEqual(['tracker', 'psn']);
  });
});
