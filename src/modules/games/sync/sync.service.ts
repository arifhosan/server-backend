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
  In,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { Connection } from '../entities/connection.entity';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { SyncRun } from '../entities/sync-run.entity';
import { GAMES_SECRET_KEY, SYNC_CLIENTS } from '../games.constants';
import { ConnectionStatus, Provider } from '../games.types';
import { fillMissingArt } from '../library/art-lookup';
import { LibraryService } from '../library/library.service';
import { openSecret, sealSecret } from '../utils/secret-box';
import { titleKey } from '../utils/title-key';
import { decideDelta } from './delta';
import {
  ObservedTitle,
  PlatformClient,
  SecretExpiredError,
  SyncFailedError,
} from './platform-client';
import {
  MIN_SESSION_SECONDS,
  RepairAction,
  lastLegacyScrape,
  planRepairs,
  planSessionRepairs,
  sessionCounts,
} from './repair-plan';

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
    try {
      const found = await fillMissingArt(this.dataSource.manager, new Date());
      if (found) this.logger.log(`art found for ${found} games`);
    } catch (e) {
      this.logger.warn(`art lookup failed: ${(e as Error).name}`);
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
    if (res.secret !== undefined || res.secretExpiresAt) {
      const fields = {
        secret:
          res.secret !== undefined
            ? sealSecret(res.secret, this.key)
            : conn.secret,
        secretExpiresAt: res.secretExpiresAt ?? conn.secretExpiresAt,
      };
      // Refreshed tokens must survive even if the writes below fail, but never
      // over a secret the user pasted while this run was fetching.
      const r = await this.connections.update(
        { id: conn.id, secret: conn.secret ?? IsNull() },
        fields,
      );
      if (r.affected === 0)
        throw new SyncFailedError('Connection was renewed during the sync');
      Object.assign(conn, fields);
    }
    if (res.titles.length === 0 && (conn.lastGameCount ?? 0) > 0)
      throw new SyncFailedError(
        `Returned 0 games, previously ${conn.lastGameCount}`,
      );

    const status: ConnectionStatus =
      client.statusAfter?.(conn.secretExpiresAt, now) ?? 'ok';
    await this.dataSource.transaction(async (m) => {
      const { titles, scrapeAt } = await this.repair(
        m,
        conn,
        res.titles,
        res.ignoredIds,
      );
      for (const t of titles) await this.applyTitle(m, conn, t, now, scrapeAt);
      await m.getRepository(Connection).update(
        { id: conn.id, secret: conn.secret ?? IsNull() },
        {
          status,
          lastSyncAt: now,
          lastSuccessAt: now,
          lastError: null,
          lastGameCount: res.titles.length,
        },
      );
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

  /**
   * Self-healing before the titles are applied: recomputes every titleKey of the user, cleans
   * first-sync sessions (`planSessionRepairs`), then runs `planRepairs`. Returns the titles to
   * apply (exact duplicates dropped) and the last legacy scrape.
   */
  private async repair(
    m: EntityManager,
    conn: Connection,
    titles: ObservedTitle[],
    ignoredIds: string[] = [],
  ): Promise<{ titles: ObservedTitle[]; scrapeAt: Date | null }> {
    const games = m.getRepository(LibraryGame);
    const rows = await games.find({ where: { userId: conn.userId } });
    let rekeyed = 0;
    for (const g of rows) {
      const key = titleKey(g.title);
      if (key === g.titleKey) continue;
      await games.update(g.id, { titleKey: key });
      g.titleKey = key;
      rekeyed++;
    }
    const sessionRepo = m.getRepository(PlaySession);
    // ponytail: loads the sessions of every row (a few thousand); aggregate in SQL if it grows.
    let sessions = rows.length
      ? await sessionRepo.find({
          where: { libraryGameId: In(rows.map((g) => g.id)) },
          select: {
            id: true,
            libraryGameId: true,
            source: true,
            startedAt: true,
            endedAt: true,
            seconds: true,
          },
        })
      : [];
    const scrapeAt = lastLegacyScrape(sessions);
    const sessionFixes = planSessionRepairs(sessions, scrapeAt);
    const gone = new Set<number>();
    for (const f of sessionFixes) {
      if (f.kind === 'deleteSession') gone.add(f.id);
      else
        await sessionRepo.update(f.id, {
          startedAt: f.startedAt,
          source: f.source,
        });
    }
    if (gone.size) {
      await sessionRepo.delete([...gone]);
      sessions = sessions.filter((s) => !gone.has(s.id));
    }
    const counts = sessionCounts(sessions);
    const plan = planRepairs(
      conn.provider,
      rows.map((g) => ({ ...g, sessions: counts.get(g.id) ?? 0 })),
      titles,
      ignoredIds,
    );
    for (const a of plan.actions) await this.applyRepair(m, conn, a);
    const all = [...sessionFixes, ...plan.actions];
    if (rekeyed || all.length) {
      const done: Record<string, number> = rekeyed ? { rekey: rekeyed } : {};
      for (const a of all) done[a.kind] = (done[a.kind] ?? 0) + 1;
      this.logger.log(`sync ${conn.id} repairs: ${JSON.stringify(done)}`);
    }
    return { titles: plan.titles, scrapeAt };
  }

  private async applyRepair(
    m: EntityManager,
    conn: Connection,
    a: RepairAction,
  ): Promise<void> {
    const games = m.getRepository(LibraryGame);
    switch (a.kind) {
      case 'relabel':
        await games.update(a.id, { platform: a.platform });
        return;
      case 'delete':
        await m.getRepository(GameIcon).delete({ libraryGameId: a.id });
        await games.delete(a.id);
        return;
      case 'keep':
        this.logger.warn(
          `sync ${conn.id}: library game ${a.id} is a PSN ${a.why} but has sessions; kept`,
        );
        return;
      case 'fold':
      case 'foldLegacy': {
        const dup = await games.findOneBy({
          id: a.kind === 'fold' ? a.dupId : a.legacyId,
        });
        const into = await games.findOneBy({ id: a.intoId });
        if (!dup || !into) return;
        // The synced total stays authoritative; fold only moves sessions, icon and art.
        await this.library.fold(dup, into, m);
        await games.save(into);
      }
    }
  }

  private async applyTitle(
    m: EntityManager,
    conn: Connection,
    t: ObservedTitle,
    now: Date,
    scrapeAt: Date | null,
  ): Promise<void> {
    const game = await this.library.findOrAdopt(conn.userId, t, m);
    if (t.imageUrl && game.imageUrl !== t.imageUrl) {
      game.imageUrl = t.imageUrl;
      await m
        .getRepository(LibraryGame)
        .update(game.id, { imageUrl: t.imageUrl });
    }
    const steam = conn.provider === 'steam';
    const alreadyTracked =
      steam && game.totalChangedAt
        ? (game.trackerCreditSeconds ?? 0) +
          (await this.trackedSince(m, game.id, game.totalChangedAt, now))
        : 0;
    const d = decideDelta({
      priorSeconds: game.totalSeconds,
      priorChangedAt: game.totalChangedAt,
      reportedSeconds: t.totalSeconds,
      windowStart: conn.lastSuccessAt,
      notBefore: scrapeAt,
      lastPlayedAt: t.lastPlayedAt,
      now,
      alreadyTracked,
      minRemainder: MIN_SESSION_SECONDS,
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
      // Tracked play Steam has not reported yet (its total moves at game exit) carries to the next delta.
      game.trackerCreditSeconds =
        steam && game.totalSeconds !== null && d.session?.source !== 'import'
          ? Math.max(0, alreadyTracked - (t.totalSeconds - game.totalSeconds))
          : 0;
      game.totalSeconds = t.totalSeconds;
      game.totalChangedAt = now;
      game.lastPlayedAt = t.lastPlayedAt ?? game.lastPlayedAt;
      await m.getRepository(LibraryGame).save(game);
    }
  }

  /** Tracker seconds inside (from, now]; a row extended in place can start before `from`. */
  private async trackedSince(
    m: EntityManager,
    libraryGameId: number,
    from: Date,
    now: Date,
  ): Promise<number> {
    const rows = await m.getRepository(PlaySession).find({
      where: { libraryGameId, source: 'tracker', endedAt: MoreThan(from) },
    });
    const ms = rows.reduce((a, s) => {
      const span = s.endedAt.getTime() - s.startedAt.getTime();
      const inside =
        Math.min(s.endedAt.getTime(), now.getTime()) -
        Math.max(s.startedAt.getTime(), from.getTime());
      return span > 0 && inside > 0
        ? a + (s.seconds * 1000 * inside) / span
        : a;
    }, 0);
    return Math.round(ms / 1000);
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
      e instanceof SyncFailedError || expired
        ? e.message.slice(0, 500)
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
      // A secret pasted during the run starts fresh: leave its status alone.
      await this.connections.update(
        { id: conn.id, secret: conn.secret ?? IsNull() },
        {
          status: expired ? 'expired' : 'failing',
          lastSyncAt: now,
          lastError: message,
        },
      );
    } catch (e2) {
      this.logger.error(
        `sync ${conn.id} failure bookkeeping failed: ${e2 instanceof Error ? e2.name : 'non-Error'}`,
      );
    }
  }
}
