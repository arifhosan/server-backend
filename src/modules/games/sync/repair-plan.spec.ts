import { Platform } from '../games.types';
import { titleKey } from '../utils/title-key';
import type { ObservedTitle } from './platform-client';
import {
  RepairAction,
  RepairRow,
  RepairSession,
  dropExactDuplicates,
  lastLegacyScrape,
  planRepairs,
  planSessionRepairs,
  sessionCounts,
} from './repair-plan';

const h = (hours: number) => Math.round(hours * 3600);

let nextId = 1;
const row = (o: Partial<RepairRow> & { title: string }): RepairRow => {
  const id = nextId++;
  return {
    id,
    platform: 'ps5',
    externalId: `legacy:${id}`,
    titleKey: titleKey(o.title),
    totalSeconds: null,
    sessions: 0,
    ...o,
  };
};
const obs = (
  platform: Platform,
  externalId: string,
  title: string,
  hours: number,
): ObservedTitle => ({ platform, externalId, title, totalSeconds: h(hours) });

/** What the service does with the actions, on plain rows: for the idempotency checks. */
function apply(rows: RepairRow[], actions: RepairAction[]): RepairRow[] {
  let out = rows.map((r) => ({ ...r }));
  const byId = (id: number) => out.find((r) => r.id === id)!;
  for (const a of actions) {
    if (a.kind === 'relabel') byId(a.id).platform = a.platform;
    if (a.kind === 'delete') out = out.filter((r) => r.id !== a.id);
    if (a.kind === 'fold' || a.kind === 'foldLegacy') {
      const dup = byId(a.kind === 'fold' ? a.dupId : a.legacyId);
      byId(a.intoId).sessions += dup.sessions;
      out = out.filter((r) => r.id !== dup.id);
    }
  }
  return out;
}

describe('sessionCounts', () => {
  it('counts sessions per game', () => {
    const c = sessionCounts([
      { libraryGameId: 1 },
      { libraryGameId: 1 },
      { libraryGameId: 2 },
    ]);
    expect([...c]).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });
});

describe('dropExactDuplicates', () => {
  const pair = [
    obs('ps4', 'CUSA34384_00', 'God of War Ragnarök', 51.5),
    obs('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5),
  ];
  const kept = (existing: [string, boolean][] = []) =>
    dropExactDuplicates(pair, new Map(existing)).kept.map((t) => t.externalId);

  it('keeps the ps5 entry when neither has a row, and names the twin of the dropped one', () => {
    const r = dropExactDuplicates(pair, new Map());
    expect(r.kept.map((t) => t.externalId)).toEqual(['PPSA08329_00']);
    expect(r.dropped).toEqual([{ title: pair[0], twin: pair[1] }]);
  });

  it('prefers an existing row, and one with sessions over one without', () => {
    expect(kept([['ps4|CUSA34384_00', false]])).toEqual(['CUSA34384_00']);
    expect(
      kept([
        ['ps4|CUSA34384_00', true],
        ['ps5|PPSA08329_00', false],
      ]),
    ).toEqual(['CUSA34384_00']);
  });

  it('keeps titles whose seconds differ, and ignores empty keys and zero seconds', () => {
    const titles = [
      obs('ps4', 'CUSA07408_00', 'God of War', 31.3),
      obs('ps4', 'CUSA07410_00', 'God of War', 28.1),
      obs('ps5', 'PPSA1_00', '原神', 10),
      obs('ps4', 'CUSA1_00', '原神', 10),
      obs('ps5', 'PPSA2_00', 'Astro Bot', 0),
      obs('ps4', 'CUSA2_00', 'Astro Bot', 0),
    ];
    expect(dropExactDuplicates(titles, new Map()).dropped).toEqual([]);
  });
});

describe('planRepairs', () => {
  beforeEach(() => (nextId = 1));

  describe('PSN platform from the title id', () => {
    it('relabels a CUSA row stored as ps5 and a PPSA row stored as ps4', () => {
      const a = row({
        title: 'A',
        externalId: 'CUSA00001_00',
        totalSeconds: 1,
      });
      const b = row({
        title: 'B',
        platform: 'ps4',
        externalId: 'PPSA00002_00',
        totalSeconds: 1,
      });
      expect(planRepairs('psn', [a, b], []).actions).toEqual([
        { kind: 'relabel', id: a.id, platform: 'ps4' },
        { kind: 'relabel', id: b.id, platform: 'ps5' },
      ]);
    });

    it('leaves legacy, Steam and non-PSN-pattern rows alone', () => {
      const rows = [
        row({ title: 'A', externalId: 'legacy:cusa' }),
        row({
          title: 'B',
          platform: 'steam',
          externalId: '1091500',
          totalSeconds: 1,
        }),
        row({ title: 'C', externalId: 'CUSA1', totalSeconds: 1 }),
        row({ title: 'D', externalId: 'NPWR12345_00', totalSeconds: 1 }),
      ];
      expect(planRepairs('psn', rows, []).actions).toEqual([]);
      expect(planRepairs('steam', rows, []).actions).toEqual([]);
    });

    it('merges a mislabelled row into its correctly labelled twin', () => {
      const bad = row({
        title: 'A',
        externalId: 'CUSA00001_00',
        totalSeconds: 1,
        sessions: 1,
      });
      const good = row({
        title: 'A',
        platform: 'ps4',
        externalId: 'CUSA00001_00',
        totalSeconds: 1,
      });
      expect(planRepairs('psn', [bad, good], []).actions).toEqual([
        { kind: 'fold', dupId: bad.id, intoId: good.id },
      ]);
    });
  });

  describe('exact duplicates and media apps', () => {
    const ragnarok = () => [
      row({
        title: 'God of War Ragnarök',
        externalId: 'CUSA34384_00',
        totalSeconds: h(51.5),
      }),
      row({
        title: 'God of War Ragnarök',
        externalId: 'PPSA08329_00',
        totalSeconds: h(51.5),
      }),
    ];
    const titles = [
      obs('ps4', 'CUSA34384_00', 'God of War Ragnarök', 51.5),
      obs('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5),
    ];

    it('deletes the dropped duplicate row', () => {
      const rows = ragnarok();
      const plan = planRepairs('psn', rows, titles);
      const [cusa] = rows;
      expect(plan.titles.map((t) => t.externalId)).toEqual(['PPSA08329_00']);
      expect(plan.actions).toEqual([
        { kind: 'relabel', id: cusa.id, platform: 'ps4' },
        { kind: 'delete', id: cusa.id, why: 'duplicate', twin: 'PPSA08329_00' },
      ]);
    });

    it('keeps it (to be logged) when both rows hold sessions', () => {
      const [cusa, ppsa] = ragnarok();
      cusa.sessions = ppsa.sessions = 1;
      expect(planRepairs('psn', [cusa, ppsa], titles).actions).toContainEqual({
        kind: 'keep',
        id: cusa.id,
        why: 'duplicate',
        twin: 'PPSA08329_00',
      });
    });

    it('deletes PSN app rows without sessions and keeps the ones with', () => {
      const netflix = row({
        title: 'Netflix',
        platform: 'ps4',
        externalId: 'CUSA00127_00',
        totalSeconds: h(208),
      });
      const other = row({
        title: 'Some Media',
        externalId: 'PPSA00003_00',
        totalSeconds: h(3),
      });
      const yt = row({
        title: 'YouTube',
        externalId: 'PPSA00004_00',
        totalSeconds: h(5),
        sessions: 2,
      });
      const legacyNetflix = row({
        title: 'Netflix',
        platform: 'ps4',
        totalSeconds: h(100),
      });
      const plan = planRepairs(
        'psn',
        [netflix, other, yt, legacyNetflix],
        [],
        ['PPSA00003_00'],
      );
      expect(plan.actions).toEqual([
        { kind: 'delete', id: netflix.id, why: 'app' },
        { kind: 'delete', id: other.id, why: 'app' },
        { kind: 'keep', id: yt.id, why: 'app' },
      ]);
    });
  });

  describe('legacy rows fold into synced rows', () => {
    it('several legacy rows may fold into one synced row; null totals and other families stay', () => {
      const s = row({
        title: 'Tom Clancy‘s Rainbow Six® Siege',
        externalId: 'PPSA01397_00',
        totalSeconds: h(675.9),
      });
      const x = row({
        title: 'Tom Clancy’s Rainbow Six Siege X',
        totalSeconds: h(675.9),
      });
      const plain = row({
        title: 'Tom Clancy’s Rainbow Six Siege',
        totalSeconds: h(548.4),
      });
      const noTotal = row({ title: 'Tom Clancy’s Rainbow Six Siege' });
      const steam = row({
        title: 'Tom Clancy’s Rainbow Six Siege',
        platform: 'steam',
        totalSeconds: h(675.9),
      });
      expect(
        planRepairs('psn', [s, x, plain, noTotal, steam], []).actions,
      ).toEqual([
        { kind: 'foldLegacy', legacyId: x.id, intoId: s.id, rule: 'R2' },
        { kind: 'foldLegacy', legacyId: plain.id, intoId: s.id, rule: 'R1' },
      ]);
    });

    it('compares against the total reported in this fetch', () => {
      const s = row({
        title: 'Astro Bot',
        externalId: 'PPSA00005_00',
        totalSeconds: h(1),
      });
      const l = row({ title: 'Astro Bot', totalSeconds: h(20) });
      expect(planRepairs('psn', [s, l], []).actions).toEqual([]);
      expect(
        planRepairs(
          'psn',
          [s, l],
          [obs('ps5', 'PPSA00005_00', 'Astro Bot', 20.5)],
        ).actions,
      ).toEqual([
        { kind: 'foldLegacy', legacyId: l.id, intoId: s.id, rule: 'R1' },
      ]);
    });

    it('a dropped duplicate or app row is no target', () => {
      const app = row({
        title: 'Netflix',
        platform: 'ps4',
        externalId: 'CUSA00127_00',
        totalSeconds: h(208),
        sessions: 3,
      });
      const l = row({
        title: 'Netflix',
        platform: 'ps4',
        totalSeconds: h(200),
      });
      expect(planRepairs('psn', [app, l], []).actions).toEqual([
        { kind: 'keep', id: app.id, why: 'app' },
      ]);
    });

    it('Steam rows fold the same way; a Steam sync leaves PS rows alone', () => {
      const s = row({
        title: 'Bitburner',
        platform: 'steam',
        externalId: '1812820',
        totalSeconds: h(572.1),
      });
      const l = row({
        title: 'Bitburner',
        platform: 'steam',
        totalSeconds: h(572),
      });
      const ps = row({ title: 'Astro Bot', totalSeconds: h(1) });
      const psS = row({
        title: 'Astro Bot',
        externalId: 'PPSA00005_00',
        totalSeconds: h(1),
      });
      expect(planRepairs('steam', [s, l, ps, psS], []).actions).toEqual([
        { kind: 'foldLegacy', legacyId: l.id, intoId: s.id, rule: 'R1' },
      ]);
    });
  });

  it('production state (user 2): repairs once, then plans nothing', () => {
    const ps = (
      platform: 'ps4' | 'ps5',
      externalId: string,
      title: string,
      hours: number,
      sessions = 0,
    ) => row({ platform, externalId, title, totalSeconds: h(hours), sessions });
    const legacy = (platform: Platform, title: string, hours: number) =>
      row({ platform, title, totalSeconds: h(hours), sessions: 3 });
    const rows = [
      // Synced rows after the first sync (CUSA ones partly stored as ps5).
      ps('ps5', 'PPSA01397_00', 'Tom Clancy‘s Rainbow Six® Siege', 675.9), // 1
      ps('ps5', 'CUSA01788_00', 'Tom Clancy‘s Rainbow Six® Siege', 318.9), // 2
      ps('ps5', 'PPSA04029_00', 'Cyberpunk 2077', 113.8, 30), // 3, an adopted legacy row
      ps('ps5', 'CUSA18278_00', 'Cyberpunk 2077', 52.0), // 4
      ps('ps4', 'CUSA18534_00', 'Assassin’s Creed® Valhalla', 16.5), // 5
      ps('ps4', 'CUSA15138_00', 'Rogue Company', 20.4), // 6
      ps('ps4', 'CUSA08025_00', 'Borderlands® 3', 0.7), // 7
      ps('ps5', 'PPSA04019_00', 'The Witcher 3: Wild Hunt — Remastered', 90.8), // 8
      ps('ps4', 'CUSA05847_00', 'Far Cry® 5', 14.0), // 9
      ps('ps5', 'CUSA34384_00', 'God of War Ragnarök', 51.5), // 10
      ps('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5), // 11
      ps('ps4', 'CUSA07408_00', 'God of War', 31.3), // 12
      ps('ps4', 'CUSA07410_00', 'God of War', 28.1), // 13
      ps(
        'ps4',
        'CUSA00341_00',
        'UNCHARTED: Legacy of Thieves Collection',
        12.8,
      ), // 14
      ps('ps4', 'CUSA05078_00', 'Paladins', 4.0), // 15
      ps('ps4', 'CUSA04414_00', 'Paladins', 0.9), // 16
      ps('ps4', 'CUSA00127_00', 'Netflix', 208), // 17
      // Unadopted legacy rows.
      legacy('ps5', 'Tom Clancy’s Rainbow Six Siege X', 675.9), // 18
      legacy('ps5', 'Tom Clancy’s Rainbow Six Siege', 548.4), // 19
      legacy('ps4', 'Tom Clancy’s Rainbow Six Siege X', 318.9), // 20
      legacy('ps4', 'Tom Clancy’s Rainbow Six Siege', 318.9), // 21
      legacy('ps4', 'Cyberpunk 2077', 52.0), // 22
      legacy('ps4', "Assassin's Creed Valhalla", 16.5), // 23
      legacy('ps4', 'Rogue Company', 20.4), // 24
      legacy('ps4', 'Borderlands 3', 0.8), // 25
      legacy('ps5', 'The Witcher 3: Wild Hunt', 90.8), // 26
      legacy('ps5', 'Far Cry 6', 13.1), // 27
      legacy('ps4', 'Uncharted 4: A Thief’s End', 12.8), // 28
      legacy('ps4', 'Paladins', 4.9), // 29
      legacy('steam', 'Bitburner', 572.0), // 30
    ];
    const titles = rows
      .filter(
        (r) => !r.externalId.startsWith('legacy:') && r.title !== 'Netflix',
      )
      .map((r) =>
        obs(
          r.externalId.startsWith('CUSA') ? 'ps4' : 'ps5',
          r.externalId,
          r.title,
          r.totalSeconds! / 3600,
        ),
      );

    const first = planRepairs('psn', rows, titles, ['CUSA00127_00']);
    const folds = first.actions.flatMap((a) =>
      a.kind === 'foldLegacy' ? [[a.legacyId, a.intoId, a.rule]] : [],
    );
    // Largest legacy total first.
    expect(folds).toEqual([
      [18, 1, 'R2'], // ps5 Siege X 675.9 -> PPSA01397
      [19, 1, 'R1'], // ps5 Siege 548.4 -> PPSA01397
      [20, 2, 'R2'], // ps4 Siege X 318.9 -> CUSA01788
      [21, 2, 'R1'], // ps4 Siege 318.9 -> CUSA01788
      [26, 8, 'R2'], // Witcher 3 90.8 -> Remastered
      [22, 4, 'R1'], // Cyberpunk 52.0 -> CUSA18278, not PPSA04029
      [24, 6, 'R1'], // Rogue Company
      [23, 5, 'R1'], // AC Valhalla
      [28, 14, 'R3'], // Uncharted 4 -> Legacy of Thieves, equal total
      [29, 15, 'R4'], // Paladins 4.9 = 4.0 + 0.9
      [25, 7, 'R1'], // Borderlands 3 0.8 -> 0.7
    ]);
    // Far Cry 6 and the Steam row (other family) stay; Ragnarök twin and Netflix go.
    expect(first.actions).toContainEqual({
      kind: 'delete',
      id: 10,
      why: 'duplicate',
      twin: 'PPSA08329_00',
    });
    expect(first.actions).toContainEqual({
      kind: 'delete',
      id: 17,
      why: 'app',
    });
    expect(first.titles.map((t) => t.externalId)).not.toContain('CUSA34384_00');

    const repaired = apply(rows, first.actions);
    expect(
      repaired
        .filter((r) => r.externalId.startsWith('legacy:'))
        .map((r) => r.id),
    ).toEqual([27, 30]);
    // Both God of War regions are kept.
    expect(repaired.map((r) => r.id)).toEqual(expect.arrayContaining([12, 13]));
    const second = planRepairs('psn', repaired, titles, ['CUSA00127_00']);
    expect(second.actions).toEqual([]);
    expect(second.titles).toEqual(first.titles);
  });
});

describe('first-sync session noise', () => {
  const scrape = new Date('2026-11-21T23:00:00Z');
  const april = new Date('2025-04-29T00:00:00Z');
  const end = new Date('2026-11-24T12:00:00Z');
  const s = (
    id: number,
    source: RepairSession['source'],
    seconds: number,
    startedAt = april,
    endedAt = end,
  ): RepairSession => ({
    id,
    libraryGameId: 1,
    source,
    seconds,
    startedAt,
    endedAt,
  });

  it('lastLegacyScrape is the end of the newest exophase session', () => {
    expect(lastLegacyScrape([])).toBeNull();
    expect(
      lastLegacyScrape([
        s(1, 'exophase', 60, april, new Date('2026-11-20T23:00:00Z')),
        s(2, 'exophase', 60, april, scrape),
        s(3, 'psn', 60, april, end),
      ]),
    ).toEqual(scrape);
  });

  it('deletes short Steam/PSN sessions and re-windows the rest to start at the scrape', () => {
    const plan = planSessionRepairs(
      [
        s(1, 'psn', 40),
        s(2, 'steam', 299),
        s(3, 'psn', 3600),
        s(4, 'steam', 300),
        // 3 days fit 60 h; 100 h no longer fits the narrowed window.
        s(5, 'psn', 100 * 3600),
        // Left alone: other sources, sessions already after the scrape.
        s(6, 'tracker', 40),
        s(7, 'import', 40),
        s(8, 'exophase', 40),
        s(9, 'psn', 40, new Date('2026-11-22T00:00:00Z')),
      ],
      scrape,
    );
    expect(plan).toEqual([
      { kind: 'deleteSession', id: 1, seconds: 40 },
      { kind: 'deleteSession', id: 2, seconds: 299 },
      { kind: 'rewindow', id: 3, startedAt: scrape, source: 'psn' },
      { kind: 'rewindow', id: 4, startedAt: scrape, source: 'steam' },
      { kind: 'rewindow', id: 5, startedAt: scrape, source: 'import' },
    ]);
  });

  it('is a no-op without a scrape and on its own output', () => {
    expect(planSessionRepairs([s(1, 'psn', 40)], null)).toEqual([]);
    expect(
      planSessionRepairs(
        [s(3, 'psn', 3600, scrape), s(9, 'psn', 40, scrape)],
        scrape,
      ),
    ).toEqual([]);
  });
});
