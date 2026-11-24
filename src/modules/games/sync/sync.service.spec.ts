import { ConflictException, Logger } from '@nestjs/common';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { Connection } from '../entities/connection.entity';
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

describe('SyncService', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const key = Buffer.alloc(32, 7);
  let games: Row[];
  let sessions: Row[];
  let runs: Row[];
  let conns: Row[];
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
    const g = {
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
    fetchTitles = jest.fn();
    client = { fetchTitles };

    const match = (rows: Row[], w: Row) =>
      rows.filter((r) =>
        Object.entries(w).every(([k, v]) => {
          if (v instanceof Object && 'type' in v && 'value' in v) {
            const val = op(v).value;
            return typeof val === 'string' && val.endsWith('%')
              ? String(r[k]).startsWith(val.slice(0, -1))
              : (r[k] as Date) >= (val as Date);
          }
          return r[k] === v;
        }),
      );
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
          update: (id: number, p: Row) => {
            Object.assign(
              games.find((g) => g.id === id)!,
              p,
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
          sum: (_c: string, w: Row) =>
            Promise.resolve(
              match(sessions, w).reduce(
                (a, s) => a + (s.seconds as number),
                0,
              ) || null,
            ),
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
          findOneBy: (w: Row) => Promise.resolve(match(conns, w)[0] ?? null),
          find: () => Promise.resolve(conns),
          update: (id: number, p: Row) => {
            Object.assign(
              conns.find((c) => c.id === id)!,
              p,
            );
            return Promise.resolve();
          },
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

  it('subtracts tracker seconds for Steam with a 300 s minimum', async () => {
    conn();
    const g = game({
      externalId: '1091500',
      titleKey: 'cyberpunk 2077',
      totalSeconds: 0,
      totalChangedAt: new Date('2026-11-24T10:00:00Z'),
    });
    const tracker = (startedAt: string, seconds: number) =>
      sessions.push({
        libraryGameId: g.id,
        source: 'tracker',
        startedAt: new Date(startedAt),
        seconds,
      });
    tracker('2026-11-24T09:00:00Z', 5000); // before totalChangedAt: ignored
    tracker('2026-11-24T10:30:00Z', 3400);
    fetchTitles.mockResolvedValue({
      titles: [steamTitle({ totalSeconds: 3600 })],
    });
    await service.syncConnection(1, now);
    expect(sessions).toHaveLength(2); // remainder 200 <= 300: no new session
    expect(g.totalSeconds).toBe(3600);
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
});
