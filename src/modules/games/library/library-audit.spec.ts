import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  AuditGame,
  AuditInput,
  AuditSession,
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
    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql] of query.mock.calls as [string][])
      expect(sql.trimStart().startsWith('SELECT')).toBe(true);
  });
});

describe('buildAudit', () => {
  const g = (
    o: Partial<AuditGame> & Pick<AuditGame, 'id' | 'title'>,
  ): AuditGame => ({
    platform: 'ps4',
    externalId: `legacy:${o.id}`,
    titleKey: '',
    totalSeconds: null,
    ...o,
  });
  const scrape = new Date('2026-11-21T23:00:00Z');
  const april = new Date('2025-04-29T00:00:00Z');
  const end = new Date('2026-11-24T12:00:00Z');
  const session = (
    id: number,
    libraryGameId: number,
    source: AuditSession['source'],
    seconds: number,
    startedAt = april,
    endedAt = end,
  ): AuditSession => ({
    id,
    libraryGameId,
    source,
    seconds,
    startedAt,
    endedAt,
  });
  const input = (o: Partial<AuditInput> = {}): AuditInput => ({
    games: [
      // Synced rows.
      g({
        id: 1,
        title: 'Cyberpunk 2077',
        platform: 'ps5',
        externalId: 'PPSA04029_00',
        totalSeconds: h(113.8),
      }),
      g({
        id: 2,
        title: 'Cyberpunk 2077',
        platform: 'ps5',
        externalId: 'CUSA18278_00',
        totalSeconds: h(52),
      }),
      g({
        id: 3,
        title: 'Netflix',
        externalId: 'CUSA00127_00',
        totalSeconds: h(208),
      }),
      g({
        id: 4,
        title: 'God of War Ragnarök',
        platform: 'ps5',
        externalId: 'CUSA34384_00',
        totalSeconds: h(51.5),
      }),
      g({
        id: 5,
        title: 'God of War Ragnarök',
        platform: 'ps5',
        externalId: 'PPSA08329_00',
        totalSeconds: h(51.5),
      }),
      // Unadopted legacy rows.
      g({
        id: 6,
        title: 'Cyberpunk 2077',
        totalSeconds: h(52),
        titleKey: 'cyberpunk 2077',
      }),
      g({
        id: 7,
        title: 'Far Cry 6',
        platform: 'ps5',
        totalSeconds: h(13.1),
        titleKey: 'far cry 6',
      }),
      g({
        id: 8,
        title: 'Bitburner',
        platform: 'steam',
        totalSeconds: h(572),
        titleKey: 'bitburner',
      }),
    ],
    sessions: [
      session(1, 6, 'exophase', h(3), new Date('2026-11-20T23:00:00Z'), scrape),
      session(2, 1, 'psn', 40), // first-sync noise
      session(3, 1, 'psn', h(1)),
    ],
    oldTotals: [
      { title: 'Cyberpunk 2077', totalMs: h(52) },
      { title: 'Far Cry 6', totalMs: h(13.1) },
      { title: 'Bitburner', totalMs: h(572) },
    ],
    providers: ['psn', 'steam'],
    ...o,
  });

  it('lists folds with their rule, unmatched legacy rows, apps, cross-gen pairs, noise and totals', () => {
    const r = buildAudit(input());
    const fold = (f: (typeof r.legacyFolds)[number]) => [
      f.rule,
      f.legacy.id,
      f.legacy.title,
      f.into.id,
      f.into.externalId,
    ];
    expect(r.legacyFolds.map(fold)).toEqual([
      ['R1', 6, 'Cyberpunk 2077', 2, 'CUSA18278_00'],
    ]);
    expect(r.unmatchedLegacy).toEqual([
      expect.objectContaining({
        id: 7,
        title: 'Far Cry 6',
        repairedByAConnection: true,
      }),
      expect.objectContaining({
        id: 8,
        title: 'Bitburner',
        repairedByAConnection: true,
      }),
    ]);
    expect(r.mediaApps.map((a) => [a.action, a.game.id, a.game.title])).toEqual(
      [['delete', 3, 'Netflix']],
    );
    expect(
      r.crossGenPairs.map((p) => [
        p.action,
        p.dropped.id,
        p.dropped.externalId,
        p.keptExternalId,
      ]),
    ).toEqual([['delete', 4, 'CUSA34384_00', 'PPSA08329_00']]);
    expect(r.relabels.map((x) => [x.id, x.to])).toEqual([
      [2, 'ps4'],
      [4, 'ps4'],
    ]);
    expect(r.noiseSessions).toEqual({
      lastLegacyScrapeAt: scrape,
      deleteCount: 1,
      deleteHours: 0,
      rewindowCount: 1,
      repairs: [
        { kind: 'deleteSession', id: 2, seconds: 40 },
        { kind: 'rewindow', id: 3, startedAt: scrape, source: 'psn' },
      ],
    });
    // now: 113.8 + 52 + 208 + 51.5 + 51.5 + 52 + 13.1 + 572; after: Netflix, the Ragnarok twin
    // and the folded Cyberpunk legacy row are gone.
    expect(r.totalsHours).toEqual({
      old: 637.1,
      now: 1113.9,
      afterRepair: 802.4,
    });
  });

  it('Bitburner folds once Steam lists appid 1812820; without a Steam connection it is not repaired', () => {
    const withSteamRow = input();
    withSteamRow.games.push(
      g({
        id: 9,
        title: 'Bitburner',
        platform: 'steam',
        externalId: '1812820',
        totalSeconds: h(572.05),
      }),
    );
    expect(
      buildAudit(withSteamRow).legacyFolds.map((f) => [
        f.rule,
        f.legacy.id,
        f.into.externalId,
      ]),
    ).toContainEqual(['R1', 8, '1812820']);

    const psnOnly = buildAudit(input({ providers: ['psn'] }));
    expect(psnOnly.unmatchedLegacy).toContainEqual(
      expect.objectContaining({ id: 8, repairedByAConnection: false }),
    );
  });
});
