import { DataSource, EntityManager, FindOperator, Repository } from 'typeorm';
import { HeartbeatDto } from '../dto/heartbeats.dto';
import { Connection } from '../entities/connection.entity';
import { Device } from '../entities/device.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { LibraryService } from '../library/library.service';
import { TrackerService, trackerPlatform } from './tracker.service';

type Row = Record<string, unknown>;
const op = (v: unknown) => (v as FindOperator<Date>).value;

describe('TrackerService', () => {
  const now = new Date('2026-11-24T20:00:00Z');
  const hb = (offsetS: number, title = 'Hades', storeId = '1145360') =>
    ({
      at: new Date(now.getTime() + offsetS * 1000).toISOString(),
      game: { store: 'steam', storeId, title },
    }) as HeartbeatDto;

  let gameRows: LibraryGame[];
  let sessionRows: PlaySession[];
  let connRows: Connection[];
  let deviceRows: Device[];
  let service: TrackerService;

  beforeEach(() => {
    gameRows = [];
    sessionRows = [];
    connRows = [];
    deviceRows = [
      { id: 1, name: 'PC' } as Device,
      { id: 2, name: 'Laptop' } as Device,
    ];
    const gameRepo = {
      create: (d: Row) => d as unknown as LibraryGame,
      save: (g: LibraryGame) => {
        if (!g.id) {
          g.id = gameRows.length + 1;
          gameRows.push(g);
        }
        return Promise.resolve(g);
      },
      findOneBy: (w: Row) =>
        Promise.resolve(
          gameRows.find((g) =>
            Object.entries(w).every(([k, v]) => (g as unknown as Row)[k] === v),
          ) ?? null,
        ),
      update: (id: number, p: Partial<LibraryGame>) => {
        Object.assign(
          gameRows.find((g) => g.id === id)!,
          p,
        );
        return Promise.resolve();
      },
      find: () => Promise.resolve(gameRows),
    };
    const sessionRepo = {
      create: (d: Row) => d as unknown as PlaySession,
      save: (s: PlaySession) => {
        if (!s.id) {
          s.id = sessionRows.length + 1;
          sessionRows.push(s);
        }
        return Promise.resolve(s);
      },
      findOne: (o: { where: Row }) => {
        const w = o.where;
        const found = sessionRows
          .filter(
            (s) =>
              s.deviceId === w.deviceId &&
              s.libraryGameId === w.libraryGameId &&
              s.source === w.source &&
              s.startedAt <= op(w.startedAt),
          )
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        return Promise.resolve(found[0] ?? null);
      },
      find: (o: { where: Row }) =>
        Promise.resolve(
          sessionRows.filter(
            (s) =>
              s.userId === o.where.userId &&
              s.source === o.where.source &&
              s.endedAt >= op(o.where.endedAt),
          ),
        ),
    };
    const repos = new Map<unknown, unknown>([
      [LibraryGame, gameRepo],
      [PlaySession, sessionRepo],
    ]);
    const manager = {
      getRepository: (e: unknown) => repos.get(e),
    } as unknown as EntityManager;
    const ds = {
      transaction: (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
    } as unknown as DataSource;
    service = new TrackerService(
      ds,
      new LibraryService(gameRepo as unknown as Repository<LibraryGame>),
      sessionRepo as unknown as Repository<PlaySession>,
      gameRepo as unknown as Repository<LibraryGame>,
      {
        find: () => Promise.resolve(deviceRows),
      } as unknown as Repository<Device>,
      {
        findOneBy: ({ userId, provider }: Row) =>
          Promise.resolve(
            connRows.find(
              (c) => c.userId === userId && c.provider === provider,
            ) ?? null,
          ),
      } as unknown as Repository<Connection>,
    );
  });

  const total = (deviceId: number) =>
    sessionRows
      .filter((s) => s.deviceId === deviceId)
      .reduce((a, s) => a + s.seconds, 0);
  const dev = (deviceId: number) => ({ userId: 7, deviceId });

  it('rejects future and too old heartbeats and writes nothing', async () => {
    const r = await service.ingest(dev(1), [hb(6 * 60), hb(-31 * 86400)], now);
    expect(r).toEqual({ accepted: 0, rejected: 2 });
    expect(sessionRows).toHaveLength(0);
    expect(gameRows).toHaveLength(0);
  });

  it('processes a newest-first batch oldest-first into one session', async () => {
    const r = await service.ingest(dev(1), [hb(0), hb(-60), hb(-120)], now);
    expect(r).toEqual({ accepted: 3, rejected: 0 });
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0].seconds).toBe(180);
    expect(gameRows[0].lastPlayedAt).toEqual(now);
  });

  it('is idempotent when the same batch is posted twice', async () => {
    const batch = [hb(-120), hb(-60), hb(0)];
    await service.ingest(dev(1), batch, now);
    const before = total(1);
    await service.ingest(dev(1), batch, now);
    expect(total(1)).toBe(before);
    expect(sessionRows).toHaveLength(1);
  });

  it('keeps one session per device for the same game and minutes', async () => {
    await service.ingest(dev(1), [hb(-60), hb(0)], now);
    await service.ingest(dev(2), [hb(-60), hb(0)], now);
    expect(sessionRows).toHaveLength(2);
    expect(gameRows).toHaveLength(1);
  });

  it('keeps one session per game on one device', async () => {
    await service.ingest(dev(1), [hb(0), hb(0, 'Celeste', '504230')], now);
    expect(sessionRows).toHaveLength(2);
  });

  it('uses a folder external id without storeId', async () => {
    await service.ingest(
      dev(1),
      [{ at: now.toISOString(), game: { store: 'other', title: 'My Game!' } }],
      now,
    );
    expect(gameRows[0]).toMatchObject({
      platform: 'pc_other',
      externalId: 'folder:my game',
    });
    expect(trackerPlatform('xbox')).toBe('xbox_pc');
  });

  it('keeps different CJK titles as separate games', async () => {
    const h = (title: string) =>
      ({
        at: now.toISOString(),
        game: { store: 'other', title },
      }) as HeartbeatDto;
    await service.ingest(dev(1), [h('原神'), h('崩壊')], now);
    expect(gameRows).toHaveLength(2);
    expect(gameRows[0].externalId).toMatch(/^folder:t-[0-9a-f]{16}$/);
  });

  it('nowPlaying returns only recent tracker sessions', async () => {
    await service.ingest(dev(1), [hb(0)], now);
    await service.ingest(dev(2), [hb(-300, 'Celeste', '504230')], now);
    sessionRows.push({
      ...sessionRows[0],
      id: 99,
      source: 'steam',
    });
    const list = await service.nowPlaying(7, now);
    expect(list).toEqual([
      {
        deviceId: 1,
        deviceName: 'PC',
        libraryGameId: 1,
        title: 'Hades',
        platform: 'steam',
        startedAt: new Date(now.getTime() - 60_000),
      },
    ]);
  });

  it('status is null psn without a connection and never leaks the secret', async () => {
    expect(await service.status(7)).toEqual({ psn: null });
    const expiresAt = new Date('2026-12-01T00:00:00Z');
    connRows.push({
      userId: 7,
      provider: 'psn',
      status: 'expiring',
      secretExpiresAt: expiresAt,
      secret: 'sealed',
    } as Connection);
    const s = await service.status(7);
    expect(s).toEqual({ psn: { status: 'expiring', expiresAt } });
    expect(JSON.stringify(s)).not.toContain('sealed');
  });
});
