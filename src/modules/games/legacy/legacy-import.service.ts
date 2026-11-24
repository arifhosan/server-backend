import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { Platform } from '../games.types';
import {
  LegacyDayRow,
  LegacyGameRow,
  LegacyInput,
  LegacyPlan,
  LegacyTotalRow,
  PlannedSession,
  buildLegacyPlan,
  checkLegacyPlan,
  dayMismatches,
} from './legacy-plan';

export interface LegacyImportReport {
  /** Rows in the legacy tables, and legacy-origin rows in the new tables after the import. */
  counts: {
    game: number;
    game_old: number;
    total_game_time: number;
    playtime: number;
    library_game: number;
    play_session: number;
  };
  /** Rows this run added (0 on a re-run). */
  inserted: { library_game: number; play_session: number };
  secondsBySource: Record<string, number>;
  unknownPlatforms: string[];
  dayMismatches: { date: string; playtime: number; gameSum: number }[];
  committed: boolean;
}

interface LibRow {
  id: number;
  externalId: string;
  platform: Platform;
  title: string;
  titleKey: string;
  totalSeconds: string | number | null;
  totalChangedAt: Date | null;
  lastPlayedAt: Date | null;
}
interface SessionRow extends Omit<PlannedSession, 'seconds'> {
  seconds: string | number;
}

const toGame = (r: LegacyGameRow): LegacyGameRow => ({
  ...r,
  playtimeMs: Number(r.playtimeMs), // BIGINT may arrive as a string
});

@Injectable()
export class LegacyImportService {
  constructor(private readonly dataSource: DataSource) {}

  async run(
    userId: number,
    opts: { commit: boolean },
  ): Promise<LegacyImportReport> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const report = await this.importAndCheck(qr, userId);
      if (opts.commit) {
        await qr.commitTransaction();
        report.committed = true;
      } else {
        await qr.rollbackTransaction();
      }
      return report;
    } catch (e) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  private async importAndCheck(
    qr: QueryRunner,
    userId: number,
  ): Promise<LegacyImportReport> {
    const totals = (
      (await qr.query(
        'SELECT id, slug, title, platform, totalMs, updatedAt FROM total_game_time ORDER BY id',
      )) as LegacyTotalRow[]
    ).map((r) => ({ ...r, totalMs: Number(r.totalMs) }));
    const games = (
      (await qr.query(
        'SELECT id, title, slug, platform, playtimeMs, createdAt FROM game ORDER BY id',
      )) as LegacyGameRow[]
    ).map(toGame);
    const gamesOld = (
      (await qr.query(
        'SELECT id, title, slug, platform, playtimeMs, createdAt FROM game_old ORDER BY id',
      )) as LegacyGameRow[]
    ).map(toGame);
    const days = (
      (await qr.query('SELECT date, totalMs FROM playtime ORDER BY id')) as {
        date: string | Date;
        totalMs: string | number;
      }[]
    ).map((r): LegacyDayRow => ({
      date:
        r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date),
      totalMs: Number(r.totalMs),
    }));
    const input: LegacyInput = { totals, games, gamesOld };
    const plan = buildLegacyPlan(input);

    const before = await this.counts(qr, userId);
    await this.write(qr, userId, plan);
    const { dbPlan, sessions } = await this.readBack(qr, userId);

    // Everything below must hold or the transaction is rolled back.
    const problems = checkLegacyPlan(dbPlan, input);
    if (sessions.length !== games.length + gamesOld.length) {
      problems.push(
        `play_session rows with legacyRef ${sessions.length} != game + game_old ${games.length + gamesOld.length}`,
      );
    }
    const withTotal = dbPlan.library.filter(
      (g) => g.totalSeconds !== null,
    ).length;
    if (withTotal !== totals.length) {
      problems.push(
        `library games with a total ${withTotal} != total_game_time rows ${totals.length}`,
      );
    }
    if (problems.length) {
      throw new Error(
        `Legacy import check failed (rolled back): ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? ` (+${problems.length - 20} more)` : ''}`,
      );
    }

    const after = await this.counts(qr, userId);
    const secondsBySource: Record<string, number> = {};
    for (const s of dbPlan.sessions) {
      secondsBySource[s.source] = (secondsBySource[s.source] ?? 0) + s.seconds;
    }
    return {
      counts: {
        game: games.length,
        game_old: gamesOld.length,
        total_game_time: totals.length,
        playtime: days.length,
        ...after,
      },
      inserted: {
        library_game: after.library_game - before.library_game,
        play_session: after.play_session - before.play_session,
      },
      secondsBySource,
      unknownPlatforms: plan.unknownPlatforms,
      dayMismatches: dayMismatches(days, games),
      committed: false,
    };
  }

  private async counts(
    qr: QueryRunner,
    userId: number,
  ): Promise<{ library_game: number; play_session: number }> {
    const [lib] = (await qr.query(
      "SELECT COUNT(*) AS n FROM library_game WHERE userId = ? AND externalId LIKE 'legacy:%'",
      [userId],
    )) as { n: string }[];
    const [ses] = (await qr.query(
      'SELECT COUNT(*) AS n FROM play_session WHERE userId = ? AND legacyRef IS NOT NULL',
      [userId],
    )) as { n: string }[];
    return { library_game: Number(lib.n), play_session: Number(ses.n) };
  }

  /** Insert-if-missing for both tables: existing rows are never overwritten, so a re-run changes nothing. */
  private async write(
    qr: QueryRunner,
    userId: number,
    plan: LegacyPlan,
  ): Promise<void> {
    const ids = new Map<string, number>();
    for (const g of plan.library) {
      const res = (await qr.query(
        `INSERT INTO library_game
           (userId, platform, externalId, title, titleKey, totalSeconds, totalChangedAt, lastPlayedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [
          userId,
          g.platform,
          g.externalId,
          g.title,
          g.titleKey,
          g.totalSeconds,
          g.totalChangedAt,
          g.lastPlayedAt,
        ],
      )) as { insertId: number };
      ids.set(g.externalId, Number(res.insertId));
    }
    for (const s of plan.sessions) {
      await qr.query(
        `INSERT INTO play_session
           (userId, libraryGameId, source, deviceId, startedAt, endedAt, seconds, legacyRef)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE legacyRef = legacyRef`,
        [
          userId,
          ids.get(s.externalId),
          s.source,
          s.startedAt,
          s.endedAt,
          s.seconds,
          s.legacyRef,
        ],
      );
    }
  }

  /** Re-reads what is now in the new tables, in the plan's shape. */
  private async readBack(
    qr: QueryRunner,
    userId: number,
  ): Promise<{ dbPlan: LegacyPlan; sessions: SessionRow[] }> {
    const lib = (await qr.query(
      `SELECT id, externalId, platform, title, titleKey, totalSeconds, totalChangedAt, lastPlayedAt
         FROM library_game WHERE userId = ? AND externalId LIKE 'legacy:%'`,
      [userId],
    )) as LibRow[];
    const sessions = (await qr.query(
      `SELECT s.legacyRef, g.externalId, s.source, s.startedAt, s.endedAt, s.seconds
         FROM play_session s JOIN library_game g ON g.id = s.libraryGameId
        WHERE s.userId = ? AND s.legacyRef IS NOT NULL`,
      [userId],
    )) as SessionRow[];
    return {
      dbPlan: {
        library: lib.map((g) => ({
          ...g,
          totalSeconds: g.totalSeconds === null ? null : Number(g.totalSeconds),
        })),
        sessions: sessions.map((s) => ({ ...s, seconds: Number(s.seconds) })),
        unknownPlatforms: [],
      },
      sessions,
    };
  }
}
