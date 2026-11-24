import { ConflictException, Logger } from '@nestjs/common';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { Connection } from '../entities/connection.entity';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { SyncRun } from '../entities/sync-run.entity';
import { LibraryService } from '../library/library.service';
import { sealSecret } from '../utils/secret-box';
import {
  ObservedTitle,
  PlatformClient,
  SecretExpiredError,
  SyncFailedError,
} from './platform-client';
import { SyncService } from './sync.service';

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
    fetchTitles = jest.fn();
    client = { fetchTitles };

    const test = (o: FindOperator<unknown>, x: unknown): boolean => {
      const val = o.value;
      switch (o.type) {
        case 'like':
          return String(x).startsWith(String(val).slice(0, -1));
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
          existsBy: (w: Row) => Promise.resolve(match(icons, w).length > 0),
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
      transaction: (cb: (m: unknown) => Promise<void>) => cb(manager),
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

    it('does not fold a row that already has a platform total', async () => {
      conn();
      game({
        externalId: 'legacy:42',
        titleKey: 'cyberpunk 2077',
        totalSeconds: 100,
      });
      game({
        externalId: '1091500',
        titleKey: 'cyberpunk 2077',
        totalSeconds: 7200,
        totalChangedAt: at('10:00'),
      });
      fetchTitles.mockResolvedValue({ titles: [steamTitle()] });
      await service.syncConnection(1, now);
      expect(games.map((g) => g.externalId)).toEqual(['legacy:42', '1091500']);
    });
  });

  it('does not look at tracker sessions for PSN and uses no minimum', async () => {
    conn({ provider: 'psn' });
    const g = game({
      platform: 'ps5',
      externalId: 'CUSA1',
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
