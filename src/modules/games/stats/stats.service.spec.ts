import { BadRequestException } from '@nestjs/common';
import { DataSource, FindOperator } from 'typeorm';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { SessionSource } from '../games.types';
import { TrackerService } from '../tracker/tracker.service';
import { StatsService } from './stats.service';

type Row = Record<string, unknown>;

/** Minimal in-memory repo: equality plus the In / LessThan / MoreThanOrEqual operators the service uses. */
function repo<T>(rows: () => T[]) {
  return {
    find: ({ where }: { where: Row }) =>
      Promise.resolve(
        rows().filter((r) =>
          Object.entries(where).every(([k, v]) => {
            const x = (r as Row)[k];
            if (!(v instanceof FindOperator)) return x === v;
            const val = v.value as unknown;
            if (v.type === 'in') return (val as unknown[]).includes(x);
            if (v.type === 'lessThan') return (x as Date) < (val as Date);
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
    );
    game({ id: 1, platform: 'steam', title: 'Cyberpunk 2077' });
    game({
      id: 2,
      platform: 'ps5',
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

  it('game detail returns the group, daily series and sessions', async () => {
    sess(1, 'tracker', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3600);
    sess(2, 'psn', '2026-11-23T08:00:00Z', '2026-11-23T09:00:00Z', 600);
    const d = await service.game(1, 1);
    expect(d.platforms).toHaveLength(2);
    expect(d.daily.map((x) => x.date)).toEqual(['2026-11-23', '2026-11-24']);
    expect(d.sessions.map((s) => s.id)).toEqual([1, 2]);
  });
});
