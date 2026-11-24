import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  AuditGame,
  LibraryAuditCliModule,
  LibraryAuditService,
  buildAudit,
} from './library-audit';

const h = (x: number) => Math.round(x * 3600);

describe('LibraryAuditCliModule', () => {
  it('compiles without the DB and resolves LibraryAuditService', async () => {
    const mod = await Test.createTestingModule({
      imports: [LibraryAuditCliModule],
    })
      .overrideProvider(DataSource)
      .useValue({})
      .compile();
    expect(mod.get(LibraryAuditService)).toBeInstanceOf(LibraryAuditService);
  });

  it('runs SELECTs only', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new LibraryAuditService({ query } as unknown as DataSource);
    await svc.run(2);
    for (const [sql] of query.mock.calls as [string][])
      expect(sql.trimStart().startsWith('SELECT')).toBe(true);
  });
});

describe('buildAudit', () => {
  const g = (o: Partial<AuditGame> & Pick<AuditGame, 'id' | 'title'>) => ({
    platform: 'ps5' as const,
    externalId: `legacy:${o.id}`,
    titleKey: '',
    totalSeconds: null,
    ...o,
  });

  const scrape = new Date('2026-11-21T23:00:00Z');
  const april = new Date('2025-04-29T00:00:00Z');
  const firstSync = {
    libraryGameId: 2,
    source: 'psn' as const,
    legacyRef: null,
    startedAt: april,
    endedAt: new Date('2026-11-24T12:00:00Z'),
  };

  it('shows old vs now vs after-repair totals and the planned actions', () => {
    const report = buildAudit({
      games: [
        g({
          id: 1,
          title: 'Cyberpunk 2077',
          platform: 'ps4',
          totalSeconds: h(40),
          titleKey: 'cyberpunk 2077',
        }),
        g({
          id: 2,
          title: 'Cyberpunk 2077',
          externalId: 'CUSA18278_00',
          totalSeconds: h(52),
        }),
        g({
          id: 3,
          title: 'Netflix',
          platform: 'ps4',
          externalId: 'CUSA00127_00',
          totalSeconds: h(208),
        }),
        g({ id: 4, title: 'Bloodborne', titleKey: 'bloodborne' }),
      ],
      sessions: [
        {
          id: 1,
          libraryGameId: 4,
          source: 'exophase',
          legacyRef: 'game:1',
          startedAt: new Date('2026-11-20T23:00:00Z'),
          endedAt: scrape,
          seconds: h(3),
        },
        {
          id: 2,
          libraryGameId: 4,
          source: 'legacy_test',
          legacyRef: 'game_old:1',
          startedAt: april,
          endedAt: april,
          seconds: h(9),
        },
        // First-sync noise on game 2: windowed from the April 2025 baseline.
        { ...firstSync, id: 3, seconds: 40 },
        { ...firstSync, id: 4, seconds: h(1) },
      ],
      oldTotals: [{ title: 'Cyberpunk 2077', totalMs: h(40) }],
    });
    expect(report.totalsHours).toEqual({ old: 40, now: 303, afterRepair: 55 });
    expect(report.rekey).toEqual([
      { id: 2, from: '', to: 'cyberpunk 2077' },
      { id: 3, from: '', to: 'netflix' },
    ]);
    expect(report.actions).toEqual([
      { kind: 'relabel', id: 2, platform: 'ps4' },
      { kind: 'delete', id: 3, why: 'app' },
      expect.objectContaining({
        kind: 'adopt',
        dupId: 2,
        legacyId: 1,
        by: 'title',
      }),
    ]);
    expect(report.groups[0]).toEqual(
      expect.objectContaining({
        titleKey: 'netflix',
        oldHours: 0,
        nowHours: 208,
        afterHours: 0,
      }),
    );
    expect(report.sessions).toEqual({
      lastLegacyScrapeAt: scrape,
      deleteCount: 1,
      deleteHours: 0,
      rewindowCount: 1,
      repairs: [
        { kind: 'deleteSession', id: 3, seconds: 40 },
        { kind: 'rewindow', id: 4, startedAt: scrape, source: 'psn' },
      ],
    });
    expect(report.unadoptedLegacy).toEqual([
      expect.objectContaining({ id: 1, adoptedByRepair: true }),
      expect.objectContaining({ id: 4, adoptedByRepair: false }),
    ]);
  });
});
