import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  LessThan,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { Connection } from '../entities/connection.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { SyncRun } from '../entities/sync-run.entity';
import { GAMES_SECRET_KEY, SYNC_CLIENTS } from '../games.constants';
import { ConnectionStatus, Provider } from '../games.types';
import { LibraryService } from '../library/library.service';
import { openSecret, sealSecret } from '../utils/secret-box';
import { decideDelta } from './delta';
import {
  ObservedTitle,
  PlatformClient,
  SecretExpiredError,
  SyncFailedError,
} from './platform-client';

const STEAM_MIN_REMAINDER = 300;
const RUN_RETENTION_MS = 90 * 24 * 3600 * 1000;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  // ponytail: in-process lock; move to a DB lock if the backend ever runs >1 replica
  private readonly running = new Set<number>();

  constructor(
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(SyncRun)
    private readonly runs: Repository<SyncRun>,
    private readonly library: LibraryService,
    private readonly dataSource: DataSource,
    @Inject(GAMES_SECRET_KEY) private readonly key: Buffer,
    @Inject(SYNC_CLIENTS)
    private readonly clients: Partial<Record<Provider, PlatformClient>>,
  ) {}

  @Cron('0 5 * * * *')
  async syncAll(): Promise<void> {
    try {
      await this.runs.delete({
        startedAt: LessThan(new Date(Date.now() - RUN_RETENTION_MS)),
      });
    } catch (e) {
      this.logger.warn(`sync_run prune failed: ${(e as Error).name}`);
    }
    const conns = await this.connections.find({
      where: { status: Not('disabled') },
    });
    for (const c of conns) {
      try {
        await this.syncConnection(c.id);
      } catch (e) {
        // Only HttpExceptions (lock/disabled/not found) reach here; their text is fixed.
        this.logger.warn(`sync ${c.id} skipped: ${(e as Error).message}`);
      }
    }
  }

  async syncConnection(
    connectionId: number,
    now: Date = new Date(),
  ): Promise<SyncRun> {
    const conn = await this.connections.findOneBy({ id: connectionId });
    if (!conn) throw new NotFoundException('Connection not found');
    if (conn.status === 'disabled')
      throw new ConflictException('Connection is disabled');
    if (this.running.has(connectionId))
      throw new ConflictException('Sync already running');
    this.running.add(connectionId);
    try {
      const run = await this.runs.save(
        this.runs.create({
          connectionId,
          startedAt: now,
          finishedAt: null,
          ok: false,
          gameCount: null,
          error: null,
        }),
      );
      try {
        await this.run(conn, run, now);
      } catch (e) {
        await this.fail(conn, run, e, now);
      }
      return run;
    } finally {
      this.running.delete(connectionId);
    }
  }

  private async run(conn: Connection, run: SyncRun, now: Date): Promise<void> {
    const client = this.clients[conn.provider];
    if (!client) throw new SyncFailedError(`No client for ${conn.provider}`);
    const secret = conn.secret ? openSecret(conn.secret, this.key) : null;
    const res = await client.fetchTitles(conn, secret);
    if (res.secret !== undefined)
      conn.secret = sealSecret(res.secret, this.key);
    if (res.secretExpiresAt) conn.secretExpiresAt = res.secretExpiresAt;
    // Refreshed tokens must survive even if the writes below fail.
    if (res.secret !== undefined || res.secretExpiresAt)
      await this.connections.update(conn.id, {
        secret: conn.secret,
        secretExpiresAt: conn.secretExpiresAt,
      });
    if (res.titles.length === 0 && (conn.lastGameCount ?? 0) > 0)
      throw new SyncFailedError(
        `Returned 0 games, previously ${conn.lastGameCount}`,
      );

    const status: ConnectionStatus =
      client.statusAfter?.(conn.secretExpiresAt, now) ?? 'ok';
    await this.dataSource.transaction(async (m) => {
      for (const t of res.titles) await this.applyTitle(m, conn, t, now);
      await m.getRepository(Connection).update(conn.id, {
        status,
        lastSyncAt: now,
        lastSuccessAt: now,
        lastError: null,
        lastGameCount: res.titles.length,
      });
    });
    run.ok = true;
    run.gameCount = res.titles.length;
    run.finishedAt = new Date();
    try {
      await this.runs.save(run);
    } catch (e) {
      this.logger.warn(
        `sync ${conn.id} run record not saved: ${(e as Error).name}`,
      );
    }
  }

  private async applyTitle(
    m: EntityManager,
    conn: Connection,
    t: ObservedTitle,
    now: Date,
  ): Promise<void> {
    const game = await this.library.findOrAdopt(conn.userId, t, m);
    const steam = conn.provider === 'steam';
    let alreadyTracked = 0;
    if (steam && game.totalChangedAt)
      alreadyTracked =
        (await m.getRepository(PlaySession).sum('seconds', {
          libraryGameId: game.id,
          source: 'tracker',
          startedAt: MoreThanOrEqual(game.totalChangedAt),
        })) ?? 0;
    const d = decideDelta({
      priorSeconds: game.totalSeconds,
      priorChangedAt: game.totalChangedAt,
      reportedSeconds: t.totalSeconds,
      windowStart: conn.lastSuccessAt,
      now,
      alreadyTracked,
      minRemainder: steam ? STEAM_MIN_REMAINDER : 0,
    });
    if (d.session) {
      const { source, ...span } = d.session;
      await m.getRepository(PlaySession).save({
        userId: conn.userId,
        libraryGameId: game.id,
        source: source === 'import' ? 'import' : conn.provider,
        deviceId: null,
        legacyRef: null,
        ...span,
      });
    }
    if (d.updateTotal) {
      game.totalSeconds = t.totalSeconds;
      game.totalChangedAt = now;
      game.lastPlayedAt = t.lastPlayedAt ?? game.lastPlayedAt;
      await m.getRepository(LibraryGame).save(game);
    }
  }

  private async fail(
    conn: Connection,
    run: SyncRun,
    e: unknown,
    now: Date,
  ): Promise<void> {
    const expired = e instanceof SecretExpiredError;
    // Only SyncFailedError text is known to be free of secrets.
    const message =
      e instanceof SyncFailedError
        ? e.message.slice(0, 500)
        : expired
          ? 'Secret expired'
          : `Unexpected error from ${conn.provider}`;
    this.logger.warn(
      `sync ${conn.id} failed: ${e instanceof Error ? e.name : 'non-Error'}: ${message}`,
    );
    try {
      run.ok = false;
      run.gameCount = null;
      run.error = message;
      run.finishedAt = new Date();
      await this.runs.save(run);
      await this.connections.update(conn.id, {
        status: expired ? 'expired' : 'failing',
        lastSyncAt: now,
        lastError: message,
      });
    } catch (e2) {
      this.logger.error(
        `sync ${conn.id} failure bookkeeping failed: ${e2 instanceof Error ? e2.name : 'non-Error'}`,
      );
    }
  }
}
