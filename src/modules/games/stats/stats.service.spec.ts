import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, FindOperator } from 'typeorm';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { SessionSource } from '../games.types';
import { TrackerService } from '../tracker/tracker.service';
import { StatsService } from './stats.service';

type Row = Record<string, unknown>;

/** Minimal in-memory repo: equality plus the In / LessThan / MoreThanOrEqual operators the service uses. */
function repo<T>(rows: () => T[]) {
  return {
    findOneBy: (w: Row) =>
      Promise.resolve(
        rows().find((r) =>
          Object.entries(w).every(([k, v]) => (r as Row)[k] === v),
        ) ?? null,
      ),
    find: ({ where }: { where: Row }) =>
      Promise.resolve(
        rows().filter((r) =>
          Object.entries(where).every(([k, v]) => {
            const x = (r as Row)[k];
            if (!(v instanceof FindOperator)) return x === v;
            const val = v.value as unknown;
            if (v.type === 'in') return (val as unknown[]).includes(x);
            if (v.type === 'lessThan') return (x as Date) < (val as Date);
            if (v.type === 'moreThan') return (x as Date) > (val as Date);
            if (v.type === 'moreThanOrEqual')
              return (x as Date) >= (val as Date);
            throw new Error(`unsupported operator ${v.type}`);
          }),
        ),
      ),
  };
}

describe('StatsService', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  let games: Partial<LibraryGame>[];
  let sessions: Partial<PlaySession>[];
  let icons: Partial<GameIcon>[];
  let service: StatsService;
  let nid: number;

  const game = (g: Partial<LibraryGame>) => {
    games.push({
      userId: 1,
      totalSeconds: null,
      lastPlayedAt: null,
      titleKey: (g.title ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''),
      ...g,
    });
  };
  const sess = (
    libraryGameId: number,
    source: SessionSource,
    a: string,
    b: string,
    seconds: number,
    userId = 1,
  ) =>
    sessions.push({
      id: nid++,
      userId,
      libraryGameId,
      source,
      deviceId: null,
      startedAt: new Date(a),
      endedAt: new Date(b),
      seconds,
    });

  beforeEach(() => {
    games = [];
    sessions = [];
    icons = [];
    nid = 1;
    const empty = repo(() => []);
    service = new StatsService(
      repo(() => games as LibraryGame[]) as never,
      repo(() => sessions as PlaySession[]) as never,
      empty as never,
      empty as never,
      empty as never,
      {
        query: () => Promise.resolve([{ timezone: 'Europe/Berlin' }]),
      } as unknown as DataSource,
      { nowPlaying: () => Promise.resolve([]) } as unknown as TrackerService,
      repo(() => icons as GameIcon[]) as never,
    );
    game({
      id: 1,
      platform: 'steam',
      title: 'Cyberpunk 2077',
      imageUrl: 'steam.jpg',
    });
    game({
      id: 2,
      platform: 'ps5',
      imageUrl: 'ps5.jpg',
      title: 'Cyberpunk 2077',
      totalSeconds: 5000,
    });
    game({ id: 3, platform: 'epic', title: 'Tracker Only' });
    game({ id: 4, platform: 'pc_other', title: '日本語', titleKey: '' });
    game({ id: 5, platform: 'pc_other', title: '漢字', titleKey: '' });
    game({ id: 9, userId: 2, platform: 'steam', title: 'Other User' });
  });

  it('keeps import and legacy_test out of the 30-day series and the calendar', async () => {
    sess(1, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    sess(1, 'import', '2026-11-24T09:00:00Z', '2026-11-24T10:00:00Z', 7200);
    sess(
      1,
      'legacy_test',
      '2026-11-24T10:00:00Z',
      '2026-11-24T11:00:00Z',
      9999,
    );
    const o = await service.overview(1, now);
    expect(o.last30Days).toHaveLength(30);
    expect(o.last30Days.at(-1)).toMatchObject({
      date: '2026-11-24',
      seconds: 3600,
    });
    expect(o.today).toBe(3600);
    const cal = await service.calendar(1, 2026);
    expect(cal).toHaveLength(365);
    expect(cal.find((d) => d.date === '2026-11-24')?.seconds).toBe(3600);
  });

  it('counts import but not legacy_test in a tracker-only library total', async () => {
    sess(3, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    sess(3, 'import', '2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z', 7200);
    sess(
      3,
      'legacy_test',
      '2026-11-21T08:00:00Z',
      '2026-11-21T10:00:00Z',
      9999,
    );
    const lib = await service.library(1, {});
    expect(lib.find((e) => e.titleKey === 'trackeronly')?.totalSeconds).toBe(
      10800,
    );
  });

  it('groups the same title across platforms and never groups empty keys', async () => {
    sess(1, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    const lib = await service.library(1, {});
    const cp = lib.filter((e) => e.title === 'Cyberpunk 2077');
    expect(cp).toHaveLength(1);
    expect(cp[0].platforms.map((p) => p.platform).sort()).toEqual([
      'ps5',
      'steam',
    ]);
    expect(cp[0].totalSeconds).toBe(5000 + 3600);
    expect(lib.filter((e) => e.titleKey.startsWith('#'))).toHaveLength(2);
    expect(await service.library(1, { platform: 'ps5' })).toHaveLength(1);
    expect(await service.library(1, { q: 'tracker' })).toHaveLength(1);
  });

  it("never returns another user's rows", async () => {
    sess(9, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600, 2);
    expect(
      (await service.library(1, {})).some((e) => e.title === 'Other User'),
    ).toBe(false);
    expect((await service.overview(1, now)).today).toBe(0);
    expect(
      await service.sessions(1, { from: '2026-11-24', to: '2026-11-24' }),
    ).toEqual([]);
    await expect(service.game(1, 9)).rejects.toThrow('Game not found');
  });

  it('period splits a midnight-crossing session per day and per game', async () => {
    sess(1, 'tracker', '2026-11-23T22:30:00Z', '2026-11-23T23:30:00Z', 3600);
    const p = await service.period(1, { from: '2026-11-23', to: '2026-11-24' });
    expect(p.days.map((d) => d.seconds)).toEqual([1800, 1800]);
    expect(p.games).toHaveLength(1);
    expect(p.games[0]).toMatchObject({
      titleKey: 'cyberpunk2077',
      seconds: 3600,
      sessionCount: 1,
    });
    expect(p.dayGames).toEqual([
      { date: '2026-11-23', titleKey: 'cyberpunk2077', seconds: 1800 },
      { date: '2026-11-24', titleKey: 'cyberpunk2077', seconds: 1800 },
    ]);
  });

  it('exposes art: steam image preferred, hasIcon if any member has one', async () => {
    sess(1, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    icons.push({ libraryGameId: 2 });
    const lib = await service.library(1, {});
    expect(lib.find((e) => e.title === 'Cyberpunk 2077')).toMatchObject({
      imageUrl: 'steam.jpg',
      hasIcon: true,
    });
    expect(lib.find((e) => e.title === 'Tracker Only')).toMatchObject({
      imageUrl: null,
      hasIcon: false,
    });
    const o = await service.overview(1, now);
    expect(o.topGames30d[0]).toMatchObject({
      libraryGameId: 1,
      imageUrl: 'steam.jpg',
      hasIcon: true,
    });
    const s = await service.sessions(1, {
      from: '2026-11-24',
      to: '2026-11-24',
    });
    expect(s[0]).toMatchObject({ imageUrl: 'steam.jpg' });
    const p = await service.period(1, { from: '2026-11-24', to: '2026-11-24' });
    expect(p.games[0]).toMatchObject({
      libraryGameId: 1,
      imageUrl: 'steam.jpg',
    });
  });

  it("serves the icon of the user's own game only", async () => {
    const png = Buffer.from('x');
    icons.push({ libraryGameId: 1, png }, { libraryGameId: 9, png });
    await expect(service.icon(1, 1)).resolves.toBe(png);
    await expect(service.icon(1, 9)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.icon(1, 2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('period ignores sessions without an in-range slice and drops 0 s rows', async () => {
    // Ends exactly at the from-midnight (Berlin 2026-11-23 00:00 = 22:00Z the day before).
    sess(1, 'tracker', '2026-11-22T21:00:00Z', '2026-11-22T22:00:00Z', 3600);
    sess(3, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 600);
    // A 0 s session on another game: counted, but no dayGames row.
    sess(2, 'psn', '2026-11-23T10:00:00Z', '2026-11-23T11:00:00Z', 0);
    const p = await service.period(1, { from: '2026-11-23', to: '2026-11-24' });
    expect(p.games.map((g) => [g.titleKey, g.sessionCount])).toEqual([
      ['trackeronly', 1],
      ['cyberpunk2077', 1],
    ]);
    expect(p.dayGames).toEqual([
      { date: '2026-11-24', titleKey: 'trackeronly', seconds: 600 },
    ]);
  });

  it('rejects ranges over 366 days and bad dates', async () => {
    await expect(
      service.period(1, { from: '2025-01-01', to: '2026-01-02' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.sessions(1, { from: '2025-01-01', to: '2026-01-02' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.sessions(1, { from: '2026-02-30', to: '2026-03-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.period(1, { from: '2025-01-01', to: '2026-01-01' }),
    ).resolves.toBeDefined();
  });

  it('rejects a huge range quickly, before building any day list (I2)', async () => {
    const t0 = Date.now();
    await expect(
      service.period(1, { from: '2000-01-01', to: '2100-12-31' }),
    ).rejects.toThrow('Range is limited to 366 days');
    await expect(
      service.sessions(1, { from: '2000-01-01', to: '2100-12-31' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('years outside 2000-2100 are a 400, never a 500 (I2)', async () => {
    for (const [from, to] of [
      ['1000-01-01', '9999-12-30'],
      ['2026-01-01', '9999-12-31'],
      ['0099-01-01', '0099-01-02'],
      ['1999-12-31', '2000-01-01'],
      ['2101-01-01', '2101-01-01'],
    ])
      await expect(service.period(1, { from, to })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    await expect(
      service.period(1, { from: '2100-12-01', to: '2100-12-31' }),
    ).resolves.toBeDefined();
  });

  it('session rows carry the group titleKey, with the #id fallback (M9)', async () => {
    sess(1, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    sess(2, 'psn', '2026-11-24T09:00:00Z', '2026-11-24T10:00:00Z', 3600);
    sess(4, 'tracker', '2026-11-24T10:00:00Z', '2026-11-24T11:00:00Z', 3600);
    const s = await service.sessions(1, {
      from: '2026-11-24',
      to: '2026-11-24',
    });
    expect(s.map((r) => [r.libraryGameId, r.titleKey])).toEqual([
      [4, '#4'],
      [2, 'cyberpunk2077'],
      [1, 'cyberpunk2077'],
    ]);
    const lib = await service.library(1, {});
    expect(lib.map((e) => e.titleKey)).toEqual(
      expect.arrayContaining(['cyberpunk2077', '#4']),
    );
    const detail = await service.game(1, 2);
    expect(detail.sessions.map((r) => r.titleKey)).toEqual([
      'cyberpunk2077',
      'cyberpunk2077',
    ]);
  });

  it('iconLibraryGameId points at the member holding the icon (M10)', async () => {
    // The group links to steam (1); only the ps5 row (2) has an icon.
    sess(1, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    icons.push({ libraryGameId: 2 });
    const want = { hasIcon: true, iconLibraryGameId: 2 };
    const o = await service.overview(1, now);
    expect(o.topGames30d[0]).toMatchObject({ libraryGameId: 1, ...want });
    const lib = await service.library(1, {});
    expect(lib.find((e) => e.titleKey === 'cyberpunk2077')).toMatchObject(want);
    expect(lib.find((e) => e.titleKey === 'trackeronly')).toMatchObject({
      hasIcon: false,
      iconLibraryGameId: null,
    });
    expect(await service.game(1, 1)).toMatchObject(want);
    const s = await service.sessions(1, {
      from: '2026-11-24',
      to: '2026-11-24',
    });
    expect(s[0]).toMatchObject(want);
    const p = await service.period(1, { from: '2026-11-24', to: '2026-11-24' });
    expect(p.games[0]).toMatchObject(want);
  });

  it('game detail returns the group, daily series and sessions', async () => {
    sess(1, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    sess(2, 'psn', '2026-11-23T08:00:00Z', '2026-11-23T09:00:00Z', 600);
    const d = await service.game(1, 1);
    expect(d.platforms).toHaveLength(2);
    expect(d.daily.map((x) => x.date)).toEqual(['2026-11-23', '2026-11-24']);
    expect(d.sessions.map((s) => s.id)).toEqual([1, 2]);
  });
});
