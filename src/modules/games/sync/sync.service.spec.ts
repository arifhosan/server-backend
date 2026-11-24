import { ConflictException, Logger } from '@nestjs/common';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { Connection } from '../entities/connection.entity';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { SyncRun } from '../entities/sync-run.entity';
import { fillMissingArt } from '../library/art-lookup';
import { LibraryService } from '../library/library.service';
import { sealSecret } from '../utils/secret-box';
import { titleKey } from '../utils/title-key';
import {
  ObservedTitle,
  PlatformClient,
  SecretExpiredError,
  SyncFailedError,
} from './platform-client';
import { SyncService } from './sync.service';

// The art lookup calls the Steam store; it has its own spec.
jest.mock('../library/art-lookup', () => ({
  fillMissingArt: jest.fn().mockResolvedValue(0),
}));

type Row = Record<string, unknown>;
const op = (v: unknown) => v as FindOperator<unknown>;
const at = (hhmm: string) => new Date(`2026-11-24T${hhmm}:00Z`);

describe('SyncService', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const key = Buffer.alloc(32, 7);
  let games: Row[];
  let sessions: Row[];
  let runs: Row[];
  let conns: Row[];
  let icons: Row[];
  let failIcons: boolean;
  let fetchTitles: jest.Mock;
  let client: PlatformClient;
  let service: SyncService;

  const steamTitle = (o: Partial<ObservedTitle> = {}): ObservedTitle => ({
    platform: 'steam',
    externalId: '1091500',
    title: 'Cyberpunk 2077',
    totalSeconds: 7200,
    ...o,
  });
  const conn = (o: Row = {}) => {
    const c: Row = {
      id: 1,
      userId: 1,
      provider: 'steam',
      secret: null,
      secretExpiresAt: null,
      status: 'ok',
      lastSuccessAt: new Date(now.getTime() - 3600_000),
      lastGameCount: 1,
      ...o,
    };
    conns.push(c);
    return c;
  };
  const game = (o: Row) => {
    const g: Row = {
      id: games.length + 1,
      userId: 1,
      platform: 'steam',
      title: 'Cyberpunk 2077', // NOT NULL in the table; most fixtures are this game
      totalSeconds: null,
      totalChangedAt: null,
      lastPlayedAt: null,
      ...o,
    };
    games.push(g);
    return g;
  };

  beforeEach(() => {
    games = [];
    sessions = [];
    runs = [];
    conns = [];
    icons = [];
    failIcons = false;
    fetchTitles = jest.fn();
    client = { fetchTitles };

    const test = (o: FindOperator<unknown>, x: unknown): boolean => {
      const val = o.value;
      switch (o.type) {
        case 'like':
          return String(x).startsWith(String(val).slice(0, -1));
        case 'in':
          return (val as unknown[]).includes(x);
        case 'isNull':
          return x === null || x === undefined;
        case 'moreThan':
          return (x as Date) > (val as Date);
        case 'lessThan':
          return (x as Date) < (val as Date);
        default:
          return (x as Date) >= (val as Date);
      }
    };
    const match = (rows: Row[], w: Row) =>
      rows.filter((r) =>
        Object.entries(w).every(([k, v]) =>
          v instanceof FindOperator ? test(v, r[k]) : r[k] === v,
        ),
      );
    const updateWhere = (rows: () => Row[]) => (crit: number | Row, p: Row) => {
      const hit = match(rows(), typeof crit === 'number' ? { id: crit } : crit);
      hit.forEach((r) => Object.assign(r, p));
      return Promise.resolve({ affected: hit.length });
    };
    const saveTo = (rows: Row[]) => (e: Row) => {
      if (!e.id) {
        e.id = rows.length + 1;
        rows.push(e);
      }
      return Promise.resolve(e);
    };
    const repos = new Map<unknown, unknown>([
      [
        LibraryGame,
        {
          create: (d: Row) => d,
          save: saveTo(games),
          update: updateWhere(() => games),
          delete: (id: number) => {
            games.splice(
              games.findIndex((g) => g.id === id),
              1,
            );
            return Promise.resolve();
          },
          findOneBy: (w: Row) => Promise.resolve(match(games, w)[0] ?? null),
          findOne: ({ where }: { where: Row }) =>
            Promise.resolve(match(games, where)[0] ?? null),
          find: ({ where }: { where: Row }) =>
            Promise.resolve(match(games, where)),
        },
      ],
      [
        PlaySession,
        {
          save: saveTo(sessions),
          find: ({ where }: { where: Row }) =>
            Promise.resolve(match(sessions, where)),
          update: updateWhere(() => sessions),
        },
      ],
      [
        SyncRun,
        {
          create: (d: Row) => d,
          save: saveTo(runs),
          delete: jest.fn().mockResolvedValue(undefined),
        },
      ],
      [
        Connection,
        {
          // A copy, like a real DB read: later writes to the row do not leak into it.
          findOneBy: (w: Row) => {
            const c = match(conns, w)[0];
            return Promise.resolve(c ? { ...c } : null);
          },
          find: () => Promise.resolve(conns),
          update: updateWhere(() => conns),
        },
      ],
      [
        GameIcon,
        {
          existsBy: (w: Row) =>
            failIcons
              ? Promise.reject(new Error('db down'))
              : Promise.resolve(match(icons, w).length > 0),
          delete: (w: Row) => {
            icons = icons.filter((i) => !match([i], w).length);
            return Promise.resolve();
          },
          update: updateWhere(() => icons),
        },
      ],
    ]);
    const get = <T>(e: unknown) => repos.get(e) as T;
    const manager = { getRepository: (e: unknown) => get(e) };
    const ds = {
      manager,
      transaction: async (cb: (m: unknown) => Promise<void>) => {
        const snap = structuredClone({ games, sessions, icons });
        try {
          return await cb(manager);
        } catch (e) {
          games.splice(0, games.length, ...snap.games);
          sessions.splice(0, sessions.length, ...snap.sessions);
          icons = snap.icons;
          throw e;
        }
      },
    } as unknown as DataSource;
    service = new SyncService(
      get<Repository<Connection>>(Connection),
      get<Repository<SyncRun>>(SyncRun),
      new LibraryService(get<Repository<LibraryGame>>(LibraryGame)),
      ds,
      key,
      { steam: client, psn: client },
    );
  });

  it('persists the observed image url', async () => {
    conn();
    fetchTitles.mockResolvedValue({
      titles: [steamTitle({ imageUrl: 'https://img/x.jpg' })],
    });
    await service.syncConnection(1, now);
    expect(games[0].imageUrl).toBe('https://img/x.jpg');
  });

  it('rejects a second concurrent sync for the same connection', async () => {
    conn();
    let release!: () => void;
    fetchTitles.mockReturnValue(
      new Promise((r) => (release = () => r({ titles: [steamTitle()] }))),
    );
    const first = service.syncConnection(1, now);
    await new Promise((r) => setImmediate(r));
    await expect(service.syncConnection(1, now)).rejects.toThrow(
      new ConflictException('Sync already running'),
    );
    release();
    await first;
    fetchTitles.mockResolvedValue({ titles: [steamTitle()] });
    await expect(service.syncConnection(1, now)).resolves.toBeDefined();
  });

  it('marks failing and writes nothing when the client throws', async () => {
    const c = conn();
    fetchTitles.mockRejectedValue(new SyncFailedError('boom'));
    const run = await service.syncConnection(1, now);
    expect(run.ok).toBe(false);
    expect(run.error).toBe('boom');
    expect(c.status).toBe('failing');
    expect(c.lastError).toBe('boom');
    expect(sessions).toHaveLength(0);
    expect(games).toHaveLength(0);
  });

  it('refuses to sync a disabled connection and leaves it untouched', async () => {
    const c = conn({ status: 'disabled' });
    await expect(service.syncConnection(1, now)).rejects.toThrow(
      new ConflictException('Connection is disabled'),
    );
    expect(c.status).toBe('disabled');
    expect(runs).toHaveLength(0);
    expect(fetchTitles).not.toHaveBeenCalled();
  });

  it('keeps raw client error text out of lastError and logs', async () => {
    const c = conn();
    const spies = (['warn', 'error', 'log'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    fetchTitles.mockRejectedValue(new Error('token=abc123'));
    const run = await service.syncConnection(1, now);
    expect(c.lastError).toBe('Unexpected error from steam');
    expect(run.error).toBe('Unexpected error from steam');
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain(
      'abc123',
    );
    expect(run.gameCount).toBeNull();
    spies.forEach((s) => s.mockRestore());
  });

  it('still propagates the run when failure bookkeeping throws', async () => {
    conn();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchTitles.mockRejectedValue(new SyncFailedError('x'));
    const repo = (service as unknown as { connections: { update: jest.Mock } })
      .connections;
    repo.update = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(service.syncConnection(1, now)).resolves.toBeDefined();
    jest.restoreAllMocks();
  });

  it('syncAll still syncs when the prune throws', async () => {
    const c = conn();
    const old = c.lastSuccessAt;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    (service as unknown as { runs: { delete: jest.Mock } }).runs.delete = jest
      .fn()
      .mockRejectedValue(new Error('nope'));
    fetchTitles.mockResolvedValue({ titles: [steamTitle()] });
    await service.syncAll();
    expect(c.lastSuccessAt).not.toEqual(old);
    expect(runs).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it('treats zero games after a non-empty library as failing', async () => {
    const c = conn({ lastGameCount: 120 });
    fetchTitles.mockResolvedValue({ titles: [] });
    const run = await service.syncConnection(1, now);
    expect(run.ok).toBe(false);
    expect(c.status).toBe('failing');
    expect(c.lastError).toBe('Returned 0 games, previously 120');
    expect(c.lastGameCount).toBe(120);
  });

  it('marks expired on SecretExpiredError and syncAll continues', async () => {
    const a = conn({ id: 1, provider: 'psn' });
    const b = conn({ id: 2 });
    fetchTitles
      .mockRejectedValueOnce(new SecretExpiredError('Re-enter NPSSO'))
      .mockResolvedValueOnce({ titles: [steamTitle()] });
    await service.syncAll();
    expect(a.status).toBe('expired');
    expect(a.lastError).toBe('Re-enter NPSSO');
    expect(b.status).toBe('ok');
    expect(runs.map((r) => r.ok)).toEqual([false, true]);
  });

  it('adopts a legacy row and writes a catch-up session', async () => {
    const c = conn({ lastSuccessAt: null });
    game({
      externalId: 'legacy:42',
      title: 'Cyberpunk 2077',
      titleKey: 'cyberpunk 2077',
      totalSeconds: 3600,
      totalChangedAt: new Date('2026-11-23T12:00:00Z'),
    });
    fetchTitles.mockResolvedValue({ titles: [steamTitle()] });
    await service.syncConnection(1, now);
    expect(games).toHaveLength(1);
    expect(games[0].externalId).toBe('1091500');
    expect(games[0].totalSeconds).toBe(7200);
    expect(sessions).toEqual([
      expect.objectContaining({
        source: 'steam',
        seconds: 3600,
        startedAt: new Date('2026-11-23T12:00:00Z'),
        endedAt: now,
      }),
    ]);
    expect(c.status).toBe('ok');
  });

  it('never adopts a legacy row on an empty titleKey', async () => {
    conn();
    game({ externalId: 'legacy:1', title: '原神', titleKey: '' });
    fetchTitles.mockResolvedValue({
      titles: [steamTitle({ title: '原神', externalId: '1' })],
    });
    await service.syncConnection(1, now);
    expect(games.map((g) => g.externalId)).toEqual(['legacy:1', '1']);
  });

  describe('Steam dedup against tracker rows extended in place (C1)', () => {
    const steamGame = (o: Row = {}) =>
      game({
        externalId: '1091500',
        titleKey: 'cyberpunk 2077',
        totalSeconds: 0,
        totalChangedAt: at('10:00'),
        trackerCreditSeconds: 0,
        ...o,
      });
    const tracker = (g: Row, from: string, to: string) => {
      const row: Row = {
        libraryGameId: g.id,
        source: 'tracker',
        startedAt: at(from),
        endedAt: at(to),
        seconds: (at(to).getTime() - at(from).getTime()) / 1000,
      };
      sessions.push(row);
      return row;
    };
    const steamSessions = () => sessions.filter((x) => x.source === 'steam');

    it('counts only the part of a session after totalChangedAt', async () => {
      conn();
      const g = steamGame();
      tracker(g, '09:00', '10:30'); // 30 min after 10:00 count, the 60 before do not
      fetchTitles.mockResolvedValue({
        titles: [steamTitle({ totalSeconds: 3600 })],
      });
      await service.syncConnection(1, now);
      // 60 min delta - 30 min tracked = a 30 min Steam session (the old code subtracted 0).
      expect(steamSessions()).toEqual([
        expect.objectContaining({ seconds: 1800 }),
      ]);
      expect(g.totalSeconds).toBe(3600);
      expect(g.trackerCreditSeconds).toBe(0);
    });

    it('ignores a session that ended before totalChangedAt', async () => {
      conn();
      steamGame();
      tracker(games[0], '08:00', '09:30');
      fetchTitles.mockResolvedValue({
        titles: [steamTitle({ totalSeconds: 3600 })],
      });
      await service.syncConnection(1, now);
      expect(steamSessions()).toEqual([
        expect.objectContaining({ seconds: 3600 }),
      ]);
    });

    it('writes nothing when the remainder is at most 300 s', async () => {
      conn();
      const g = steamGame();
      tracker(g, '10:30', '11:26'); // 56 min
      fetchTitles.mockResolvedValue({
        titles: [steamTitle({ totalSeconds: 3600 })],
      });
      await service.syncConnection(1, now);
      expect(steamSessions()).toHaveLength(0); // 60 - 56 = 4 min <= 5 min
      expect(g.totalSeconds).toBe(3600);
    });

    it('restart within 3 min: no Steam session on top of the extended tracker row', async () => {
      // Play 10:00-10:30, restart 10:33 (same row extended), quit 12:00.
      conn({ lastSuccessAt: at('10:05') });
      const g = steamGame({ totalSeconds: 7200, totalChangedAt: at('09:00') });
      const row = tracker(g, '10:00', '11:05');
      // 11:05: Steam has booked the first 30 min only (its total moves at exit).
      fetchTitles.mockResolvedValue({
        titles: [steamTitle({ totalSeconds: 7200 + 1800 })],
      });
      await service.syncConnection(1, at('11:05'));
      expect(steamSessions()).toHaveLength(0);
      expect(g.totalChangedAt).toEqual(at('11:05'));
      expect(g.trackerCreditSeconds).toBe(35 * 60); // 65 tracked - 30 reported

      // 12:05: the row now ends 12:00; Steam reports the second stretch (+90 min).
      row.endedAt = at('12:00');
      row.seconds = 120 * 60;
      fetchTitles.mockResolvedValue({
        titles: [steamTitle({ totalSeconds: 7200 + 1800 + 5400 })],
      });
      await service.syncConnection(1, at('12:05'));
      // 90 - (35 credit + 55 after 11:05) = 0: nothing on top of the tracker row.
      expect(steamSessions()).toHaveLength(0);
      expect(g.totalSeconds).toBe(7200 + 1800 + 5400);
      expect(g.trackerCreditSeconds).toBe(0);
    });

    it('play the tracker missed is still booked after a credit is used up', async () => {
      conn();
      const g = steamGame({ trackerCreditSeconds: 600 });
      fetchTitles.mockResolvedValue({
        titles: [steamTitle({ totalSeconds: 3600 })],
      });
      await service.syncConnection(1, now);
      expect(steamSessions()).toEqual([
        expect.objectContaining({ seconds: 3000 }),
      ]);
      expect(g.trackerCreditSeconds).toBe(0);
    });
  });

  describe('legacy row and a tracker-created Steam row both exist (I1)', () => {
    it('folds the tracker row into the legacy row inside the run', async () => {
      conn({ lastSuccessAt: null });
      const legacy = game({
        externalId: 'legacy:42',
        title: 'Cyberpunk 2077',
        titleKey: 'cyberpunk 2077',
        totalSeconds: 3600,
        totalChangedAt: new Date('2026-11-23T12:00:00Z'),
        imageUrl: null,
      });
      const dup = game({
        externalId: '1091500',
        title: 'Cyberpunk 2077',
        titleKey: 'cyberpunk 2077',
        imageUrl: 'https://tracker.jpg',
      });
      sessions.push({
        id: 1,
        libraryGameId: dup.id,
        source: 'tracker',
        startedAt: at('10:00'),
        endedAt: at('10:40'),
        seconds: 2400,
      });
      icons.push({ libraryGameId: dup.id });
      fetchTitles.mockResolvedValue({ titles: [steamTitle()] });
      await service.syncConnection(1, now);

      expect(games).toEqual([
        expect.objectContaining({
          id: legacy.id,
          externalId: '1091500',
          totalSeconds: 7200,
        }),
      ]);
      expect(sessions[0].libraryGameId).toBe(legacy.id);
      expect(icons).toEqual([{ libraryGameId: legacy.id }]);
      // Catch-up 3600 s minus the 2400 s the tracker saw since the legacy total.
      expect(sessions.filter((x) => x.source === 'steam')).toEqual([
        expect.objectContaining({ libraryGameId: legacy.id, seconds: 1200 }),
      ]);
    });

    it('the repair folds the legacy row into a synced row with a total (its total stays)', async () => {
      // Arises when titleKeys change (apostrophes) or legacy rows arrive after the first sync.
      conn();
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const legacy = game({
        externalId: 'legacy:42',
        titleKey: 'cyberpunk 2077',
        totalSeconds: 7000,
      });
      sessions.push({
        id: 9,
        libraryGameId: legacy.id,
        source: 'exophase',
        legacyRef: 'game:9',
        seconds: 600,
      });
      const synced = game({
        externalId: '1091500',
        titleKey: 'cyberpunk 2077',
        totalSeconds: 7200,
        totalChangedAt: at('10:00'),
      });
      fetchTitles.mockResolvedValue({ titles: [steamTitle()] });
      await service.syncConnection(1, now);
      expect(games).toEqual([
        expect.objectContaining({
          id: synced.id,
          externalId: '1091500',
          totalSeconds: 7200,
        }),
      ]);
      expect(sessions).toEqual([
        expect.objectContaining({ id: 9, libraryGameId: synced.id }),
      ]);
      jest.restoreAllMocks();
    });
  });

  it('does not look at tracker sessions for PSN', async () => {
    conn({ provider: 'psn' });
    const g = game({
      platform: 'ps5',
      externalId: 'CUSA1',
      title: 'Bloodborne',
      titleKey: 'bloodborne',
      totalSeconds: 0,
      totalChangedAt: new Date('2026-11-24T10:00:00Z'),
    });
    sessions.push({
      libraryGameId: g.id,
      source: 'tracker',
      startedAt: new Date('2026-11-24T10:30:00Z'),
      seconds: 3400,
    });
    fetchTitles.mockResolvedValue({
      titles: [
        {
          platform: 'ps5',
          externalId: 'CUSA1',
          title: 'Bloodborne',
          totalSeconds: 3600,
        },
      ],
    });
    await service.syncConnection(1, now);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({ source: 'psn', seconds: 3600 });
  });

  describe('repairs before applying (production data, user 2)', () => {
    const H = 3600;
    const h = (x: number) => Math.round(x * H);
    const legacyAt = new Date('2026-11-21T12:00:00Z');
    const psn = (
      platform: 'ps4' | 'ps5',
      externalId: string,
      title: string,
      hours: number,
    ): ObservedTitle => ({
      platform,
      externalId,
      title,
      totalSeconds: h(hours),
    });
    /** A row an earlier sync created; titleKey left stale on purpose (the repair rekeys). */
    const synced = (o: Row) =>
      game({ totalChangedAt: at('11:00'), titleKey: '', ...o });
    const snapshot = () =>
      JSON.stringify({ games, sessions, icons: icons.length });

    let warn: jest.SpyInstance;
    beforeEach(() => {
      conn({ provider: 'psn', lastSuccessAt: at('11:00'), lastGameCount: 7 });
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('relabels, folds legacy rows in, drops the cross-gen twin and apps; a second sync changes nothing', async () => {
      const adopted = synced({
        platform: 'ps5',
        externalId: 'PPSA04029_00',
        title: 'Cyberpunk 2077',
        totalSeconds: h(113.8),
      });
      const cusa = synced({
        platform: 'ps5',
        externalId: 'CUSA18278_00',
        title: 'Cyberpunk 2077',
        totalSeconds: h(52),
        imageUrl: null,
      });
      const legacyPs4 = game({
        platform: 'ps4',
        externalId: 'legacy:cyberpunk-2077-ps4',
        title: 'Cyberpunk 2077',
        titleKey: 'cyberpunk 2077',
        totalSeconds: h(52),
        totalChangedAt: legacyAt,
        imageUrl: 'https://legacy.jpg',
      });
      const legacySession = (id: number, libraryGameId: unknown) => ({
        id,
        libraryGameId,
        source: 'import',
        legacyRef: `game:${id}`,
        seconds: h(40),
        startedAt: legacyAt,
        endedAt: legacyAt,
      });
      sessions.push(
        legacySession(1, adopted.id),
        legacySession(2, legacyPs4.id),
      );
      icons.push({ libraryGameId: legacyPs4.id });
      const twinCusa = synced({
        platform: 'ps5',
        externalId: 'CUSA34384_00',
        title: 'God of War Ragnarök',
        totalSeconds: h(51.5),
      });
      const twinPpsa = synced({
        platform: 'ps5',
        externalId: 'PPSA08329_00',
        title: 'God of War Ragnarök',
        totalSeconds: h(51.5),
      });
      const us = synced({
        platform: 'ps4',
        externalId: 'CUSA07408_00',
        title: 'God of War',
        totalSeconds: h(31.3),
      });
      const eu = synced({
        platform: 'ps4',
        externalId: 'CUSA07410_00',
        title: 'God of War',
        totalSeconds: h(28.1),
      });
      const netflix = synced({
        platform: 'ps4',
        externalId: 'CUSA00127_00',
        title: 'Netflix',
        totalSeconds: h(208),
      });
      fetchTitles.mockResolvedValue({
        titles: [
          psn('ps5', 'PPSA04029_00', 'Cyberpunk 2077', 113.8),
          psn('ps4', 'CUSA18278_00', 'Cyberpunk 2077', 52),
          psn('ps4', 'CUSA34384_00', 'God of War Ragnarök', 51.5),
          psn('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5),
          psn('ps4', 'CUSA07408_00', 'God of War', 31.3),
          psn('ps4', 'CUSA07410_00', 'God of War', 28.1),
        ],
        ignoredIds: ['CUSA00127_00'],
      });
      const run = await service.syncConnection(1, now);
      expect(run.ok).toBe(true);

      // Cyberpunk 52.0 legacy went into CUSA18278 (closest total), not PPSA04029.
      expect(games.map((g) => [g.id, g.platform, g.externalId])).toEqual([
        [adopted.id, 'ps5', 'PPSA04029_00'],
        [cusa.id, 'ps4', 'CUSA18278_00'],
        [twinPpsa.id, 'ps5', 'PPSA08329_00'],
        [us.id, 'ps4', 'CUSA07408_00'],
        [eu.id, 'ps4', 'CUSA07410_00'],
      ]);
      expect(
        games.some((g) =>
          [twinCusa.id, netflix.id, legacyPs4.id].includes(g.id),
        ),
      ).toBe(false);
      expect(
        games.every((g) => g.titleKey === titleKey(g.title as string)),
      ).toBe(true);
      // The synced row keeps its total and takes the legacy history, icon and art.
      expect(cusa.totalSeconds).toBe(h(52));
      expect(sessions.find((x) => x.id === 2)?.libraryGameId).toBe(cusa.id);
      expect(icons).toEqual([{ libraryGameId: cusa.id }]);
      expect(cusa.imageUrl).toBe('https://legacy.jpg');
      expect(sessions.filter((x) => x.legacyRef === null)).toEqual([]);

      const before = snapshot();
      await service.syncConnection(1, new Date(now.getTime() + 1));
      expect(snapshot()).toBe(before);
    });

    it('a dropped twin with sessions is kept and logged by id', async () => {
      const twin = synced({
        platform: 'ps4',
        externalId: 'CUSA34384_00',
        title: 'God of War Ragnarök',
        totalSeconds: h(51.5),
      });
      const ppsa = synced({
        platform: 'ps5',
        externalId: 'PPSA08329_00',
        title: 'God of War Ragnarök',
        totalSeconds: h(51.5),
      });
      for (const g of [twin, ppsa])
        sessions.push({
          libraryGameId: g.id,
          source: 'psn',
          legacyRef: null,
          seconds: 60,
        });
      fetchTitles.mockResolvedValue({
        titles: [
          psn('ps4', 'CUSA34384_00', 'God of War Ragnarök', 51.5),
          psn('ps5', 'PPSA08329_00', 'God of War Ragnarök', 51.5),
        ],
      });
      const debug = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => undefined);
      await service.syncConnection(1, now);
      await service.syncConnection(1, new Date(now.getTime() + 3_600_000));
      expect(games).toHaveLength(2);
      const msg = `sync 1: library game ${String(twin.id)} is a PSN duplicate but has sessions; kept`;
      expect(debug.mock.calls.filter((c) => c[0] === msg)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalledWith(msg);
    });

    it('the hourly sync never folds by R2/R3/R4 while live totals grow past legacy totals', async () => {
      const legacy = (title: string, platform: 'ps4' | 'ps5', hours: number) =>
        game({
          platform,
          externalId: `legacy:${title}`,
          title,
          titleKey: titleKey(title),
          totalSeconds: h(hours),
          totalChangedAt: legacyAt,
        });
      legacy('DOOM', 'ps5', 100); // R2 bait: "DOOM Eternal" passes 100 h
      legacy('Far Cry 6', 'ps5', 13.1); // R3 bait: "Far Cry 5" passes 13.1 h within 60 s
      legacy('Paladins', 'ps5', 4.9); // R4 bait: two "Paladins" rows sum past 4.9 h
      const live = {
        PPSA00001_00: ['DOOM Eternal', h(98)],
        CUSA05847_00: ['Far Cry® 5', h(13.1) - 120],
        CUSA05078_00: ['Paladins', h(4)],
        CUSA04414_00: ['Paladins', h(0.8)],
      } as const;
      for (const [id, [title, t]] of Object.entries(live))
        synced({
          platform: id.startsWith('CUSA') ? 'ps4' : 'ps5',
          externalId: id,
          title,
          totalSeconds: t,
        });
      const legacyIds = () =>
        games
          .filter((g) => String(g.externalId).startsWith('legacy:'))
          .map((g) => g.id);
      const before = legacyIds();
      for (let hour = 1; hour <= 12; hour++) {
        fetchTitles.mockResolvedValue({
          titles: [
            psn('ps5', 'PPSA00001_00', 'DOOM Eternal', 98 + hour * 0.5),
            {
              ...psn('ps4', 'CUSA05847_00', 'Far Cry® 5', 0),
              totalSeconds: h(13.1) - 120 + hour * 20,
            },
            psn('ps4', 'CUSA05078_00', 'Paladins', 4),
            psn('ps4', 'CUSA04414_00', 'Paladins', 0.8 + hour * 0.02),
          ],
        });
        await service.syncConnection(
          1,
          new Date(now.getTime() + hour * 3_600_000),
        );
        expect(legacyIds()).toEqual(before);
      }
    });

    it('Far Cry 6 never folds into Far Cry® 5 (number rule)', async () => {
      const legacy = game({
        platform: 'ps5',
        externalId: 'legacy:fc6',
        title: 'Far Cry 6',
        titleKey: 'far cry 6',
        totalSeconds: h(13.1),
        totalChangedAt: legacyAt,
      });
      synced({
        platform: 'ps4',
        externalId: 'CUSA05847_00',
        title: 'Far Cry® 5',
        totalSeconds: h(14),
      });
      fetchTitles.mockResolvedValue({
        titles: [psn('ps4', 'CUSA05847_00', 'Far Cry® 5', 14)],
      });
      await service.syncConnection(1, now);
      expect(games.map((g) => g.externalId)).toEqual([
        'legacy:fc6',
        'CUSA05847_00',
      ]);
      expect(legacy.totalSeconds).toBe(h(13.1));
    });
  });

  it('Steam: a stale legacy titleKey is recomputed, so a ‘ title adopts it', async () => {
    conn({ lastSuccessAt: null });
    const legacy = game({
      externalId: 'legacy:r6',
      title: "Tom Clancy's Rainbow Six Siege",
      titleKey: 'tom clancy s rainbow six siege', // from an older titleKey
      totalSeconds: 3600,
      totalChangedAt: new Date('2026-11-21T12:00:00Z'),
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    fetchTitles.mockResolvedValue({
      titles: [
        steamTitle({
          externalId: '359550',
          title: 'Tom Clancy‘s Rainbow Six® Siege',
          totalSeconds: 3700,
        }),
      ],
    });
    await service.syncConnection(1, now);
    expect(games).toEqual([
      expect.objectContaining({
        id: legacy.id,
        externalId: '359550',
        titleKey: 'tom clancys rainbow six siege',
      }),
    ]);
    jest.restoreAllMocks();
  });

  describe('first-sync noise against the last legacy scrape (F)', () => {
    const scrape = new Date('2026-11-21T23:00:00Z');
    const april = new Date('2025-04-29T00:00:00Z');
    const psnTitle = (seconds: number): ObservedTitle => ({
      platform: 'ps5',
      externalId: 'PPSA01397_00',
      title: 'Astro Bot',
      totalSeconds: seconds,
    });
    const setup = (lastSuccessAt: Date | null) => {
      conn({ provider: 'psn', lastSuccessAt });
      // An adopted legacy row: total current as of the scrape, totalChangedAt the 2025 baseline.
      const g = game({
        platform: 'ps5',
        externalId: 'PPSA01397_00',
        title: 'Astro Bot',
        titleKey: 'astro bot',
        totalSeconds: 36_000,
        totalChangedAt: april,
      });
      sessions.push({
        id: 100,
        libraryGameId: g.id,
        source: 'exophase',
        legacyRef: 'game:7',
        startedAt: new Date('2026-11-20T23:00:00Z'),
        endedAt: scrape,
        seconds: 1200,
      });
      return g;
    };
    const synced = () => sessions.filter((x) => x.id !== 100);

    beforeEach(() =>
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    );
    afterEach(() => jest.restoreAllMocks());

    it('PSN: under 5 min is no session, but the total still moves', async () => {
      const g = setup(at('11:00'));
      fetchTitles.mockResolvedValue({ titles: [psnTitle(36_000 + 299)] });
      await service.syncConnection(1, now);
      expect(synced()).toEqual([]);
      expect(g.totalSeconds).toBe(36_299);
    });

    it('a delta on an adopted legacy row starts at the scrape, not the 2025 baseline', async () => {
      const g = setup(null);
      fetchTitles.mockResolvedValue({ titles: [psnTitle(36_000 + 3600)] });
      await service.syncConnection(1, now);
      expect(synced()).toEqual([
        expect.objectContaining({
          libraryGameId: g.id,
          source: 'psn',
          seconds: 3600,
          startedAt: scrape,
          endedAt: now,
        }),
      ]);
    });

    it('the session ends at the title lastPlayedAt, not at the sync time', async () => {
      const g = setup(null);
      const played = new Date('2026-11-24T01:00:00Z');
      fetchTitles.mockResolvedValue({
        titles: [{ ...psnTitle(36_000 + 3600), lastPlayedAt: played }],
      });
      await service.syncConnection(1, new Date('2026-11-24T18:34:00Z'));
      expect(synced()).toEqual([
        expect.objectContaining({
          libraryGameId: g.id,
          source: 'psn',
          seconds: 3600,
          startedAt: scrape,
          endedAt: played,
        }),
      ]);
    });

    it('Steam: the same window rule applies', async () => {
      conn({ lastSuccessAt: null });
      const g = game({
        externalId: '1091500',
        titleKey: 'cyberpunk 2077',
        totalSeconds: 3600,
        totalChangedAt: april,
      });
      sessions.push({
        id: 100,
        libraryGameId: g.id,
        source: 'exophase',
        legacyRef: 'game:7',
        startedAt: april,
        endedAt: scrape,
        seconds: 60,
      });
      fetchTitles.mockResolvedValue({ titles: [steamTitle()] });
      await service.syncConnection(1, now);
      expect(synced()).toEqual([
        expect.objectContaining({ source: 'steam', startedAt: scrape }),
      ]);
    });

    it('the repair re-windows first-sync sessions, deletes none, once', async () => {
      const g = setup(at('11:00'));
      const first = {
        libraryGameId: g.id,
        legacyRef: null,
        startedAt: april,
        endedAt: at('10:00'),
      };
      sessions.push(
        { ...first, id: 1, source: 'psn', seconds: 40 },
        { ...first, id: 2, source: 'steam', seconds: 20 },
        { ...first, id: 3, source: 'psn', seconds: 7200 },
        { ...first, id: 4, source: 'tracker', seconds: 40 },
      );
      fetchTitles.mockResolvedValue({ titles: [psnTitle(36_000)] });
      await service.syncConnection(1, now);
      // Short ones stay (the stats hide them); every psn/steam one now starts at the scrape.
      expect(synced()).toEqual([
        expect.objectContaining({ id: 1, seconds: 40, startedAt: scrape }),
        expect.objectContaining({ id: 2, seconds: 20, startedAt: scrape }),
        expect.objectContaining({ id: 3, seconds: 7200, startedAt: scrape }),
        expect.objectContaining({ id: 4, source: 'tracker', startedAt: april }),
      ]);
      const before = JSON.stringify(sessions);
      await service.syncConnection(1, new Date(now.getTime() + 1));
      expect(JSON.stringify(sessions)).toBe(before);
    });
  });

  it('a failure mid-repair rolls everything back (rows, sessions, totals)', async () => {
    conn({ provider: 'psn', lastSuccessAt: at('11:00') });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const legacy = game({
      platform: 'ps4',
      externalId: 'legacy:cp',
      title: 'Cyberpunk 2077',
      titleKey: 'cyberpunk 2077',
      totalSeconds: 3600 * 52,
    });
    sessions.push({
      id: 1,
      libraryGameId: legacy.id,
      source: 'exophase',
      legacyRef: 'game:1',
      seconds: 600,
    });
    game({
      platform: 'ps5', // relabelled to ps4 before the fold
      externalId: 'CUSA18278_00',
      title: 'Cyberpunk 2077',
      titleKey: '',
      totalSeconds: 3600 * 52,
      totalChangedAt: at('10:00'),
    });
    fetchTitles.mockResolvedValue({
      titles: [
        {
          platform: 'ps4',
          externalId: 'CUSA18278_00',
          title: 'Cyberpunk 2077',
          totalSeconds: 3600 * 53,
        },
      ],
    });
    const before = JSON.stringify({ games, sessions, icons });
    failIcons = true; // the fold moves the sessions, then fails
    const run = await service.syncConnection(1, now);
    expect(run.ok).toBe(false);
    expect(JSON.stringify({ games, sessions, icons })).toBe(before);
    jest.restoreAllMocks();
  });

  it('persists a refreshed secret and the client status', async () => {
    const c = conn({
      provider: 'psn',
      secret: sealSecret('{"old":1}', key),
    });
    client.statusAfter = () => 'expiring';
    const exp = new Date('2026-12-01T00:00:00Z');
    fetchTitles.mockResolvedValue({
      titles: [],
      secret: '{"new":1}',
      secretExpiresAt: exp,
    });
    c.lastGameCount = 0;
    await service.syncConnection(1, now);
    expect((fetchTitles.mock.calls[0] as unknown[])[1]).toBe('{"old":1}');
    expect(c.secret).not.toContain('new');
    expect(c.secretExpiresAt).toBe(exp);
    expect(c.status).toBe('expiring');
  });

  it('syncAll looks for missing art after the syncs, and survives its failure', async () => {
    const fill = jest.mocked(fillMissingArt);
    fill.mockClear();
    await service.syncAll();
    expect(fill).toHaveBeenCalledTimes(1);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    fill.mockRejectedValueOnce(new Error('store down'));
    await expect(service.syncAll()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('art lookup failed: Error');
    warn.mockRestore();
  });

  it('syncAll deletes sync runs older than 90 days', async () => {
    await service.syncAll();
    const del = (service as unknown as { runs: { delete: jest.Mock } }).runs
      .delete;
    const arg = (del.mock.calls[0] as [{ startedAt: unknown }])[0];
    const cutoff = op(arg.startedAt).value as Date;
    const age = Date.now() - cutoff.getTime();
    expect(Math.abs(age - 90 * 86400_000)).toBeLessThan(5000);
  });
  describe('PSN renewal pasted during a sync (M1)', () => {
    const renewDuring = (c: Row, res: Row | Error) =>
      fetchTitles.mockImplementation(() => {
        c.secret = 'RENEWED';
        c.status = 'ok';
        c.lastError = null;
        return res instanceof Error
          ? Promise.reject(res)
          : Promise.resolve(res);
      });

    it('does not overwrite the new secret with the refreshed old one', async () => {
      const c = conn({ provider: 'psn', secret: sealSecret('{"old":1}', key) });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      renewDuring(c, {
        titles: [],
        secret: '{"refreshed":1}',
        secretExpiresAt: new Date('2027-01-01T00:00:00Z'),
      });
      const run = await service.syncConnection(1, now);
      expect(c.secret).toBe('RENEWED');
      expect(c.status).toBe('ok');
      expect(c.lastError).toBeNull();
      expect(run.ok).toBe(false);
      expect(run.error).toBe('Connection was renewed during the sync');
      jest.restoreAllMocks();
    });

    it('fail() leaves a renewed connection alone', async () => {
      const c = conn({ provider: 'psn', secret: sealSecret('{"old":1}', key) });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      renewDuring(c, new SecretExpiredError('Re-enter NPSSO'));
      await service.syncConnection(1, now);
      expect(c.status).toBe('ok');
      expect(c.lastError).toBeNull();
      jest.restoreAllMocks();
    });

    it('success does not stamp the old expiry status over a renewal', async () => {
      const c = conn({ provider: 'psn', secret: sealSecret('{"old":1}', key) });
      client.statusAfter = () => 'expiring';
      renewDuring(c, { titles: [steamTitle()] });
      await service.syncConnection(1, now);
      expect(c.status).toBe('ok');
    });

    it('still writes its own refreshed secret when nothing changed', async () => {
      const c = conn({ provider: 'psn', secret: sealSecret('{"old":1}', key) });
      fetchTitles.mockResolvedValue({
        titles: [steamTitle()],
        secret: '{"refreshed":1}',
      });
      await service.syncConnection(1, now);
      expect(c.secret).not.toBe('RENEWED');
      expect(c.status).toBe('ok');
      expect(c.lastSuccessAt).toBe(now);
    });
  });
});
