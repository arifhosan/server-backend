import {
  LegacyDayRow,
  LegacyGameRow,
  LegacyTotalRow,
  buildLegacyPlan,
  checkLegacyPlan,
  dayMismatches,
  legacyPlatform,
} from './legacy-plan';

const d = (s: string) => new Date(s);
const total = (o: Partial<LegacyTotalRow> = {}): LegacyTotalRow => ({
  id: 1,
  slug: 'hades-steam',
  title: 'Hades',
  platform: 'Steam',
  totalMs: 7200,
  updatedAt: d('2026-11-01T00:00:00Z'),
  ...o,
});
const game = (o: Partial<LegacyGameRow> = {}): LegacyGameRow => ({
  id: 10,
  title: 'Hades',
  slug: 'hades-steam',
  platform: 'Steam',
  playtimeMs: 3600,
  createdAt: d('2026-06-01T02:00:00Z'),
  ...o,
});
const input = () => ({
  totals: [total()],
  games: [game()],
  gamesOld: [
    game({ id: 5, playtimeMs: 60, createdAt: d('2025-04-26T02:00:00Z') }),
  ],
});

describe('legacyPlatform', () => {
  it.each([
    ['Steam', 'steam'],
    ['PS5', 'ps5'],
    ['PS4', 'ps4'],
    ['Xbox Series', 'xbox_pc'],
    ['Xbox One', 'xbox_pc'],
    ['Windows', 'xbox_pc'],
    ['Windows 10', 'xbox_pc'],
    ['Ubisoft', 'pc_other'],
  ])('%s -> %s (known)', (raw, platform) => {
    expect(legacyPlatform(raw)).toEqual({ platform, known: true });
  });

  it('maps unknown platforms to pc_other and flags them', () => {
    expect(legacyPlatform('Foo')).toEqual({
      platform: 'pc_other',
      known: false,
    });
  });
});

describe('buildLegacyPlan', () => {
  it('turns each total row into a library game', () => {
    const plan = buildLegacyPlan(input());
    expect(plan.library).toHaveLength(1);
    expect(plan.library[0]).toMatchObject({
      externalId: 'legacy:hades-steam',
      platform: 'steam',
      title: 'Hades',
      titleKey: 'hades',
      totalSeconds: 7200,
      totalChangedAt: d('2026-11-01T00:00:00Z'),
    });
  });

  it('turns each game row into a 24 h session ending at createdAt', () => {
    const s = buildLegacyPlan(input()).sessions.find(
      (x) => x.legacyRef === 'game:10',
    );
    expect(s).toEqual({
      legacyRef: 'game:10',
      externalId: 'legacy:hades-steam',
      source: 'exophase',
      startedAt: d('2026-05-31T02:00:00Z'),
      endedAt: d('2026-06-01T02:00:00Z'),
      seconds: 3600,
    });
  });

  it('marks baseline-era and oversized game rows as import', () => {
    const plan = buildLegacyPlan({
      totals: [total()],
      games: [
        game({ id: 1, createdAt: d('2025-04-29T11:59:59Z') }),
        game({ id: 2, createdAt: d('2025-04-29T12:00:00Z') }),
        game({ id: 3, playtimeMs: 86_401 }),
        game({ id: 4, playtimeMs: 86_400 }),
      ],
      gamesOld: [],
    });
    const src = Object.fromEntries(
      plan.sessions.map((s) => [s.legacyRef, s.source]),
    );
    expect(src).toEqual({
      'game:1': 'import',
      'game:2': 'exophase',
      'game:3': 'import',
      'game:4': 'exophase',
    });
  });

  it('keeps game_old as legacy_test sessions joined by slug', () => {
    const s = buildLegacyPlan(input()).sessions.find(
      (x) => x.legacyRef === 'game_old:5',
    );
    expect(s).toMatchObject({
      source: 'legacy_test',
      externalId: 'legacy:hades-steam',
      seconds: 60,
    });
  });

  it('joins game_old by platform + titleKey when the slug is empty', () => {
    const plan = buildLegacyPlan({
      totals: [total()],
      games: [],
      gamesOld: [game({ id: 6, slug: '', title: 'HADES' })],
    });
    expect(plan.library).toHaveLength(1);
    expect(plan.sessions[0].externalId).toBe('legacy:hades-steam');
  });

  it('does not join across platforms', () => {
    const plan = buildLegacyPlan({
      totals: [total()],
      games: [],
      gamesOld: [game({ id: 6, slug: '', platform: 'PS5' })],
    });
    expect(plan.library).toHaveLength(2);
    expect(plan.library[1]).toMatchObject({
      platform: 'ps5',
      totalSeconds: null,
    });
  });

  it('creates a new library game for an unmatched game_old row', () => {
    const plan = buildLegacyPlan({
      totals: [],
      games: [],
      gamesOld: [
        game({ id: 7, slug: 'zelda-switch', title: 'Zelda' }),
        game({ id: 8, slug: '', title: 'Zelda!' }),
      ],
    });
    expect(plan.library).toHaveLength(1);
    expect(plan.library[0]).toMatchObject({
      externalId: 'legacy:zelda-switch',
      totalSeconds: null,
      totalChangedAt: null,
    });
    expect(plan.sessions.map((s) => s.externalId)).toEqual([
      'legacy:zelda-switch',
      'legacy:zelda-switch',
    ]);
  });

  it('never matches on an empty titleKey: each such row is its own game', () => {
    const rows = {
      totals: [],
      games: [],
      gamesOld: [
        game({ id: 1, slug: '', title: '日本語' }),
        game({ id: 2, slug: '', title: '日本語' }),
      ],
    };
    const plan = buildLegacyPlan(rows);
    expect(plan.library).toHaveLength(2);
    expect(new Set(plan.library.map((g) => g.externalId)).size).toBe(2);
    expect(plan.sessions[0].externalId).not.toBe(plan.sessions[1].externalId);
    expect(checkLegacyPlan(plan, rows)).toEqual([]);
  });

  it('creates a library game from a game row with no total row', () => {
    const plan = buildLegacyPlan({
      totals: [],
      games: [game({ slug: 'solo-steam' })],
      gamesOld: [],
    });
    expect(plan.library).toEqual([
      expect.objectContaining({
        externalId: 'legacy:solo-steam',
        totalSeconds: null,
        lastPlayedAt: d('2026-06-01T02:00:00Z'),
      }),
    ]);
    expect(plan.sessions).toHaveLength(1);
  });

  it('sets lastPlayedAt from the latest non-test session', () => {
    const plan = buildLegacyPlan({
      totals: [total()],
      games: [
        game({ id: 1, createdAt: d('2026-01-01T00:00:00Z') }),
        game({ id: 2, createdAt: d('2026-03-01T00:00:00Z') }),
      ],
      gamesOld: [game({ id: 3, createdAt: d('2027-04-26T00:00:00Z') })],
    });
    expect(plan.library[0].lastPlayedAt).toEqual(d('2026-03-01T00:00:00Z'));
  });

  it('reports unknown platforms once each', () => {
    const plan = buildLegacyPlan({
      totals: [total({ platform: 'Foo' })],
      games: [game({ platform: 'Foo' }), game({ id: 11, platform: 'Bar' })],
      gamesOld: [],
    });
    expect(plan.unknownPlatforms).toEqual(['Bar', 'Foo']);
  });
});

describe('checkLegacyPlan', () => {
  it('accepts a correct plan', () => {
    expect(checkLegacyPlan(buildLegacyPlan(input()), input())).toEqual([]);
  });

  it('names the missing legacyRef when a session is gone', () => {
    const plan = buildLegacyPlan(input());
    plan.sessions = plan.sessions.filter((s) => s.legacyRef !== 'game:10');
    const msgs = checkLegacyPlan(plan, input());
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('game:10');
  });

  it('names the slug when a total differs', () => {
    const plan = buildLegacyPlan(input());
    plan.library[0].totalSeconds = 7201;
    const msgs = checkLegacyPlan(plan, input());
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('hades-steam');
  });

  it('flags a changed session length, source or extra row', () => {
    const plan = buildLegacyPlan(input());
    plan.sessions[0].seconds += 1;
    plan.sessions[1].source = 'import';
    plan.sessions.push({ ...plan.sessions[0], legacyRef: 'game:999' });
    expect(checkLegacyPlan(plan, input())).toHaveLength(3);
  });
});

describe('dayMismatches', () => {
  const days: LegacyDayRow[] = [
    { date: '2026-06-01', totalMs: 3600 },
    { date: '2026-06-02', totalMs: 100 },
  ];
  it('lists days whose playtime differs from the sum of game rows', () => {
    const games = [
      game({ id: 1, playtimeMs: 1800, createdAt: d('2026-06-01T01:00:00Z') }),
      game({ id: 2, playtimeMs: 1800, createdAt: d('2026-06-01T02:00:00Z') }),
      game({ id: 3, playtimeMs: 50, createdAt: d('2026-06-02T02:00:00Z') }),
      game({ id: 4, playtimeMs: 70, createdAt: d('2026-06-03T02:00:00Z') }),
    ];
    expect(dayMismatches(days, games)).toEqual([
      { date: '2026-06-02', playtime: 100, gameSum: 50 },
      { date: '2026-06-03', playtime: 0, gameSum: 70 },
    ]);
  });
});
