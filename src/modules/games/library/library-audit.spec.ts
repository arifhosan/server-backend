import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
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
      .useValue({
        options: { type: 'mysql' },
        entityMetadatas: [],
        getRepository: () => ({}),
      })
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
    const { report: r } = buildAudit(input());
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
    // Noise is hidden by the stats, never deleted; both first-sync sessions are re-windowed.
    expect(r.noiseSessions).toEqual({
      lastLegacyScrapeAt: scrape,
      hiddenCount: 1,
      hiddenHours: 0,
      rewindowCount: 2,
      repairs: [
        { kind: 'rewindow', id: 2, startedAt: scrape, source: 'psn' },
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
      buildAudit(withSteamRow).report.legacyFolds.map((f) => [
        f.rule,
        f.legacy.id,
        f.into.externalId,
      ]),
    ).toContainEqual(['R1', 8, '1812820']);

    const psnOnly = buildAudit(input({ providers: ['psn'] })).report;
    expect(psnOnly.unmatchedLegacy).toContainEqual(
      expect.objectContaining({ id: 8, repairedByAConnection: false }),
    );
  });

  it('plans R2-R4 folds too (the hourly sync only does R1)', () => {
    const i = input();
    i.games.push(
      g({
        id: 10,
        title: 'The Witcher 3: Wild Hunt',
        platform: 'ps5',
        totalSeconds: h(90.8),
      }),
      g({
        id: 11,
        title: 'The Witcher 3: Wild Hunt — Remastered',
        platform: 'ps5',
        externalId: 'PPSA04019_00',
        totalSeconds: h(90.8),
      }),
    );
    const { report, plan } = buildAudit(i);
    expect(
      report.legacyFolds.map((f) => [f.rule, f.legacy.id, f.into.id]),
    ).toContainEqual(['R2', 10, 11]);
    expect(plan.actions).toContainEqual({
      kind: 'foldLegacy',
      legacyId: 10,
      intoId: 11,
      rule: 'R2',
    });
  });

  it('--apply writes the same plan in one transaction and says so', async () => {
    const i = input();
    let games = i.games.map((x) => ({ ...x }));
    const sessions = i.sessions.map((x) => ({ ...x }));
    const query = (sql: string) =>
      Promise.resolve(
        sql.includes('FROM library_game')
          ? games
          : sql.includes('FROM play_session')
            ? sessions
            : sql.includes('FROM total_game_time')
              ? i.oldTotals
              : [{ provider: 'psn' }, { provider: 'steam' }],
      );
    const byId = (id: number) => games.find((x) => x.id === id) ?? null;
    const m = {
      query,
      getRepository: (e: unknown) =>
        e === LibraryGame
          ? {
              update: (id: number, p: object) =>
                Promise.resolve(Object.assign(byId(id)!, p)),
              delete: (id: number) => {
                games = games.filter((x) => x.id !== id);
                return Promise.resolve();
              },
              findOneBy: ({ id }: { id: number }) => Promise.resolve(byId(id)),
              save: (x: object) => Promise.resolve(x),
            }
          : e === PlaySession
            ? {
                update: (w: number | { libraryGameId: number }, p: object) => {
                  for (const x of sessions)
                    if (
                      typeof w === 'number'
                        ? x.id === w
                        : x.libraryGameId === w.libraryGameId
                    )
                      Object.assign(x, p);
                  return Promise.resolve();
                },
              }
            : e === GameIcon
              ? {
                  existsBy: () => Promise.resolve(false),
                  update: () => Promise.resolve(),
                  delete: () => Promise.resolve(),
                }
              : undefined,
    } as unknown as EntityManager;
    const transaction = jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(m),
    );
    const svc = new LibraryAuditService({
      query,
      transaction,
    } as unknown as DataSource);

    const report = await svc.run(2, { apply: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ applied: true });
    // Netflix and the Ragnarok twin are gone, the Cyberpunk legacy row folded into CUSA18278.
    expect(games.map((x) => x.id)).toEqual([1, 2, 5, 7, 8]);
    expect(byId(2)).toMatchObject({
      platform: 'ps4',
      titleKey: 'cyberpunk 2077',
    });
    expect(sessions.find((x) => x.id === 1)?.libraryGameId).toBe(2);
    expect(sessions.find((x) => x.id === 2)?.startedAt).toEqual(scrape);

    // Without --apply nothing is written.
    transaction.mockClear();
    await svc.run(2);
    expect(transaction).not.toHaveBeenCalled();
  });
});
