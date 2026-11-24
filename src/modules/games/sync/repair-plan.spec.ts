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
  sessionStats,
} from './repair-plan';

const H = 3600;
const h = (hours: number) => Math.round(hours * H);

let nextId = 1;
const row = (o: Partial<RepairRow> & { title: string }): RepairRow => ({
  id: nextId++,
  platform: 'ps5',
  externalId: `legacy:${nextId}`,
  titleKey: titleKey(o.title),
  totalSeconds: null,
  syncSeconds: 0,
  trackerSessions: 0,
  legacySessions: 0,
  ...o,
});
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
    if (a.kind === 'fold' || a.kind === 'adopt') {
      const dup = byId(a.dupId);
      const into = byId(a.kind === 'fold' ? a.intoId : a.legacyId);
      into.syncSeconds += dup.syncSeconds;
      into.trackerSessions += dup.trackerSessions;
      into.legacySessions += dup.legacySessions;
      if (a.kind === 'adopt') {
        into.platform = a.platform;
        into.externalId = a.externalId;
        if (into.totalSeconds !== null) into.totalSeconds += a.baselinePlus;
      }
      out = out.filter((r) => r.id !== dup.id);
    }
  }
  return out;
}

describe('sessionStats', () => {
  it('splits sync seconds, tracker and legacy sessions', () => {
    const s = sessionStats([
      { libraryGameId: 1, source: 'psn', legacyRef: null, seconds: 600 },
      { libraryGameId: 1, source: 'import', legacyRef: null, seconds: 60 },
      { libraryGameId: 1, source: 'import', legacyRef: 'game:1', seconds: 9 },
      { libraryGameId: 2, source: 'tracker', legacyRef: null, seconds: 5 },
    ]);
    expect(s.get(1)).toEqual({
      syncSeconds: 660,
      trackerSessions: 0,
      legacySessions: 1,
    });
    expect(s.get(2)).toEqual({
      syncSeconds: 0,
      trackerSessions: 1,
      legacySessions: 0,
    });
  });
});

describe('dropExactDuplicates', () => {
  const pair = [
    obs('ps4', 'CUSA34384_00', 'God of War Ragnarök', 51.5),
    obs('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5),
  ];
  const ids = (ts: ObservedTitle[]) => ts.map((t) => t.externalId);

  it('keeps the ps5 entry when neither has a row', () => {
    const r = dropExactDuplicates(pair, new Map());
    expect(ids(r.kept)).toEqual(['PPSA08329_00']);
    expect(ids(r.dropped)).toEqual(['CUSA34384_00']);
  });

  it('prefers an existing row, and one with sessions over one without', () => {
    expect(
      ids(
        dropExactDuplicates(pair, new Map([['ps4|CUSA34384_00', false]])).kept,
      ),
    ).toEqual(['CUSA34384_00']);
    expect(
      ids(
        dropExactDuplicates(
          pair,
          new Map([
            ['ps4|CUSA34384_00', true],
            ['ps5|PPSA08329_00', false],
          ]),
        ).kept,
      ),
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
        platform: 'ps5',
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
        row({ title: 'A', platform: 'ps5', externalId: 'legacy:cusa' }),
        row({
          title: 'B',
          platform: 'steam',
          externalId: '1091500',
          totalSeconds: 1,
        }),
        row({
          title: 'C',
          platform: 'ps5',
          externalId: 'CUSA1',
          totalSeconds: 1,
        }),
        row({
          title: 'D',
          platform: 'ps5',
          externalId: 'NPWR12345_00',
          totalSeconds: 1,
        }),
      ];
      expect(planRepairs('psn', rows, []).actions).toEqual([]);
      expect(planRepairs('steam', rows, []).actions).toEqual([]);
    });

    it('merges a mislabelled row into its correctly labelled twin', () => {
      const bad = row({
        title: 'A',
        platform: 'ps5',
        externalId: 'CUSA00001_00',
        totalSeconds: 1,
        syncSeconds: 60,
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
    it('deletes the dropped duplicate row, or keeps it when it has sessions', () => {
      const cusa = row({
        title: 'God of War Ragnarök',
        platform: 'ps5',
        externalId: 'CUSA34384_00',
        totalSeconds: h(51.5),
      });
      const ppsa = row({
        title: 'God of War Ragnarök',
        platform: 'ps5',
        externalId: 'PPSA08329_00',
        totalSeconds: h(51.5),
      });
      const titles = [
        obs('ps4', 'CUSA34384_00', 'God of War Ragnarök', 51.5),
        obs('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5),
      ];
      const plan = planRepairs('psn', [cusa, ppsa], titles);
      expect(plan.titles.map((t) => t.externalId)).toEqual(['PPSA08329_00']);
      expect(plan.actions).toEqual([
        { kind: 'relabel', id: cusa.id, platform: 'ps4' },
        { kind: 'delete', id: cusa.id, why: 'duplicate' },
      ]);

      // Both rows hold sessions: the ps5 one is kept, the other is logged, not deleted.
      cusa.syncSeconds = 60;
      ppsa.syncSeconds = 60;
      expect(planRepairs('psn', [cusa, ppsa], titles).actions).toContainEqual({
        kind: 'keep',
        id: cusa.id,
        why: 'duplicate',
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
        platform: 'ps5',
        externalId: 'PPSA00003_00',
        totalSeconds: h(3),
      });
      const yt = row({
        title: 'YouTube',
        platform: 'ps5',
        externalId: 'PPSA00004_00',
        totalSeconds: h(5),
        legacySessions: 2,
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

  describe('legacy adoption by title', () => {
    it('folds a synced row into the unadopted legacy row, raising its baseline by sync seconds', () => {
      const legacy = row({
        title: 'Cyberpunk 2077',
        platform: 'ps4',
        totalSeconds: h(40),
      });
      const dup = row({
        title: 'Cyberpunk 2077',
        platform: 'ps4',
        externalId: 'CUSA18278_00',
        totalSeconds: h(52),
        syncSeconds: 1800,
      });
      expect(planRepairs('psn', [legacy, dup], []).actions).toEqual([
        {
          kind: 'adopt',
          dupId: dup.id,
          legacyId: legacy.id,
          platform: 'ps4',
          externalId: 'CUSA18278_00',
          baselinePlus: 1800,
          by: 'title',
        },
      ]);
    });

    it('two regions: the larger total adopts, the other stays', () => {
      const legacy = row({
        title: 'God of War',
        platform: 'ps4',
        totalSeconds: h(30),
      });
      const eu = row({
        title: 'God of War',
        platform: 'ps4',
        externalId: 'CUSA07410_00',
        totalSeconds: h(28.1),
      });
      const us = row({
        title: 'God of War',
        platform: 'ps4',
        externalId: 'CUSA07408_00',
        totalSeconds: h(31.3),
      });
      const plan = planRepairs('psn', [legacy, eu, us], []);
      expect(plan.actions).toEqual([
        expect.objectContaining({
          kind: 'adopt',
          dupId: us.id,
          legacyId: legacy.id,
        }),
      ]);
    });

    it('never folds a row holding legacy sessions (an adopted legacy row) into another', () => {
      const legacy = row({
        title: 'Cyberpunk 2077',
        platform: 'ps5',
        totalSeconds: h(10),
      });
      const adopted = row({
        title: 'Cyberpunk 2077',
        platform: 'ps5',
        externalId: 'PPSA04029_00',
        totalSeconds: h(113.8),
        legacySessions: 40,
      });
      expect(planRepairs('psn', [legacy, adopted], []).actions).toEqual([]);
    });

    it('Steam: a synced row with tracker sessions still adopts by title', () => {
      const legacy = row({
        title: "Tom Clancy's Rainbow Six Siege",
        platform: 'steam',
        totalSeconds: h(500),
      });
      const dup = row({
        title: 'Tom Clancy‘s Rainbow Six® Siege',
        platform: 'steam',
        externalId: '359550',
        totalSeconds: h(587.5),
        trackerSessions: 3,
      });
      expect(planRepairs('steam', [legacy, dup], []).actions).toEqual([
        expect.objectContaining({
          kind: 'adopt',
          dupId: dup.id,
          legacyId: legacy.id,
          by: 'title',
          baselinePlus: 0,
        }),
      ]);
      // A PSN sync does not touch Steam rows.
      expect(planRepairs('psn', [legacy, dup], []).actions).toEqual([]);
    });
  });

  describe('legacy adoption by total', () => {
    it('R6 Siege: legacy ps5 "…Siege X" 675.9 h takes PPSA01397 "…Siege" 676.0 h', () => {
      const legacy = row({
        title: "Tom Clancy's Rainbow Six Siege X",
        platform: 'ps5',
        totalSeconds: h(675.9),
      });
      const dup = row({
        title: 'Tom Clancy‘s Rainbow Six Siege',
        platform: 'ps5',
        externalId: 'PPSA01397_00',
        totalSeconds: h(675.9),
      });
      const plan = planRepairs(
        'psn',
        [legacy, dup],
        [obs('ps5', 'PPSA01397_00', 'Tom Clancy‘s Rainbow Six Siege', 676)],
      );
      expect(plan.actions).toEqual([
        expect.objectContaining({
          kind: 'adopt',
          dupId: dup.id,
          legacyId: legacy.id,
          by: 'total',
          platform: 'ps5',
        }),
      ]);
    });

    it('crosses ps4/ps5 (Exophase PS labels are unreliable): legacy ps5 318.9 h, CUSA01788 318.9 h', () => {
      const legacy = row({
        title: 'Grand Theft Auto V',
        platform: 'ps5',
        totalSeconds: h(318.9),
      });
      const dup = row({
        title: 'Grand Theft Auto V (PS4)',
        platform: 'ps4',
        externalId: 'CUSA01788_00',
        totalSeconds: h(318.9),
      });
      expect(planRepairs('psn', [legacy, dup], []).actions).toEqual([
        expect.objectContaining({
          kind: 'adopt',
          legacyId: legacy.id,
          platform: 'ps4',
          externalId: 'CUSA01788_00',
          by: 'total',
        }),
      ]);
    });

    it('Steam 359550 587.5 h adopts the matching legacy steam row', () => {
      const legacy = row({
        title: 'Rainbow Six Siege',
        platform: 'steam',
        totalSeconds: h(587),
      });
      const dup = row({
        title: "Tom Clancy's Rainbow Six® Siege X",
        platform: 'steam',
        externalId: '359550',
        totalSeconds: h(587.5),
      });
      expect(planRepairs('steam', [legacy, dup], []).actions).toEqual([
        expect.objectContaining({
          kind: 'adopt',
          dupId: dup.id,
          legacyId: legacy.id,
          by: 'total',
        }),
      ]);
    });

    it('two qualifying legacy rows: adopts none and reports it', () => {
      const a = row({
        title: 'God of War',
        platform: 'ps4',
        totalSeconds: h(31),
      });
      const b = row({
        title: 'God of War III Remastered',
        platform: 'ps5',
        totalSeconds: h(31.2),
      });
      const dup = row({
        title: 'God of War III',
        platform: 'ps4',
        externalId: 'CUSA01623_00',
        totalSeconds: h(31.3),
      });
      expect(planRepairs('psn', [a, b, dup], []).actions).toEqual([
        { kind: 'ambiguous', id: dup.id, legacyIds: [a.id, b.id] },
      ]);
    });

    it('needs only sync sessions, a total within tolerance and a similar title', () => {
      const legacy = row({
        title: 'Bloodborne',
        platform: 'ps4',
        totalSeconds: h(100),
      });
      const tracked = row({
        title: 'Bloodborne GOTY',
        platform: 'steam',
        externalId: '1',
        totalSeconds: h(100),
        trackerSessions: 1,
      });
      const far = row({
        title: 'Bloodborne GOTY',
        platform: 'ps4',
        externalId: 'CUSA00900_00',
        totalSeconds: h(103),
      });
      const unlike = row({
        title: 'Astro Bot',
        platform: 'ps4',
        externalId: 'CUSA00901_00',
        totalSeconds: h(100),
      });
      expect(planRepairs('psn', [legacy, far, unlike], []).actions).toEqual([]);
      const steamLegacy = row({
        title: 'Bloodborne',
        platform: 'steam',
        totalSeconds: h(100),
      });
      expect(planRepairs('steam', [steamLegacy, tracked], []).actions).toEqual(
        [],
      );
    });
  });

  it('production state (user 2): repairs once, then plans nothing', () => {
    const rows = [
      // Cyberpunk: adopted ps5 legacy row with history; CUSA stored as ps5 next to an unadopted ps4 legacy row.
      row({
        title: 'Cyberpunk 2077',
        platform: 'ps5',
        externalId: 'PPSA04029_00',
        totalSeconds: h(113.8),
        legacySessions: 30,
      }),
      row({
        title: 'Cyberpunk 2077',
        platform: 'ps5',
        externalId: 'CUSA18278_00',
        totalSeconds: h(52),
      }),
      row({
        title: 'Cyberpunk 2077',
        platform: 'ps4',
        externalId: 'legacy:cyberpunk-2077-ps4',
        totalSeconds: h(40),
        legacySessions: 5,
      }),
      // Ragnarök: one cross-gen entitlement reported twice.
      row({
        title: 'God of War Ragnarök',
        platform: 'ps5',
        externalId: 'CUSA34384_00',
        totalSeconds: h(51.5),
      }),
      row({
        title: 'God of War Ragnarök',
        platform: 'ps5',
        externalId: 'PPSA08329_00',
        totalSeconds: h(51.5),
      }),
      // God of War: two regions, both real.
      row({
        title: 'God of War',
        platform: 'ps4',
        externalId: 'CUSA07408_00',
        totalSeconds: h(31.3),
      }),
      row({
        title: 'God of War',
        platform: 'ps4',
        externalId: 'CUSA07410_00',
        totalSeconds: h(28.1),
      }),
    ];
    const titles = [
      obs('ps5', 'PPSA04029_00', 'Cyberpunk 2077', 113.8),
      obs('ps4', 'CUSA18278_00', 'Cyberpunk 2077', 52),
      obs('ps4', 'CUSA34384_00', 'God of War Ragnarök', 51.5),
      obs('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5),
      obs('ps4', 'CUSA07408_00', 'God of War', 31.3),
      obs('ps4', 'CUSA07410_00', 'God of War', 28.1),
    ];
    const first = planRepairs('psn', rows, titles);
    expect(first.actions).toEqual([
      { kind: 'relabel', id: 2, platform: 'ps4' },
      { kind: 'relabel', id: 4, platform: 'ps4' },
      { kind: 'delete', id: 4, why: 'duplicate' },
      {
        kind: 'adopt',
        dupId: 2,
        legacyId: 3,
        platform: 'ps4',
        externalId: 'CUSA18278_00',
        baselinePlus: 0,
        by: 'title',
      },
    ]);
    expect(first.titles.map((t) => t.externalId)).not.toContain('CUSA34384_00');

    const repaired = apply(rows, first.actions);
    expect(repaired.map((r) => [r.id, r.platform, r.externalId])).toEqual([
      [1, 'ps5', 'PPSA04029_00'],
      [3, 'ps4', 'CUSA18278_00'],
      [5, 'ps5', 'PPSA08329_00'],
      [6, 'ps4', 'CUSA07408_00'],
      [7, 'ps4', 'CUSA07410_00'],
    ]);
    expect(repaired.find((r) => r.id === 3)!.totalSeconds).toBe(h(40));
    const second = planRepairs('psn', repaired, titles);
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
  ): RepairSession => ({ id, source, seconds, startedAt, endedAt });

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
