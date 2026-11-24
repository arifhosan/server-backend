import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DatabaseModule } from '../../../database/database.module';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import {
  Platform,
  Provider,
  SessionSource,
  TOTAL_EXCLUDED_SOURCES,
} from '../games.types';
import type { ObservedTitle } from '../sync/platform-client';
import { isKnownPsnApp, psnTitlePlatform } from '../sync/psn.client';
import { RepairPlan, applyRepairs } from '../sync/repair-apply';
import {
  RepairAction,
  lastLegacyScrape,
  planRepairs,
  planSessionRepairs,
  sessionCounts,
} from '../sync/repair-plan';
import { isNoise } from '../stats/undated';
import { titleKey } from '../utils/title-key';

export interface AuditGame {
  id: number;
  platform: Platform;
  externalId: string;
  title: string;
  titleKey: string;
  totalSeconds: number | null;
}
export interface AuditSession {
  id: number;
  libraryGameId: number;
  startedAt: Date;
  endedAt: Date;
  source: SessionSource;
  seconds: number;
}
export interface AuditInput {
  games: AuditGame[];
  sessions: AuditSession[];
  /** total_game_time rows (`totalMs` holds seconds). */
  oldTotals: { title: string; totalMs: number }[];
  /** Providers with a connection that is not disabled: only their families are repaired. */
  providers: Provider[];
}

const hours = (s: number) => Math.round(s / 360) / 10;
const familyOf = (p: Platform) =>
  p === 'ps4' || p === 'ps5' ? 'psn' : p === 'steam' ? 'steam' : undefined;

/**
 * The full repair plan (legacy folds by R1-R4, which the hourly sync never runs beyond R1) from
 * the stored rows alone: the reported totals are the rows' own (the audit never calls PSN or
 * Steam; a PSN refresh would rotate the stored tokens). Returns the plan and a report of it in
 * hours; a library total is the reported one, else the session sum (as the dashboard).
 */
export function buildAudit(input: AuditInput) {
  const rekey = input.games
    .filter((g) => titleKey(g.title) !== g.titleKey)
    .map((g) => ({ id: g.id, from: g.titleKey, to: titleKey(g.title) }));
  const games = input.games.map((g) => ({
    ...g,
    titleKey: titleKey(g.title),
  }));
  const byId = new Map(games.map((g) => [g.id, g]));
  const scrapeAt = lastLegacyScrape(input.sessions);
  const sessionRepairs = planSessionRepairs(input.sessions, scrapeAt);
  const hidden = input.sessions.filter(isNoise);
  const counts = sessionCounts(input.sessions);
  const rows = games.map((g) => ({ ...g, sessions: counts.get(g.id) ?? 0 }));
  const observed = (provider: Provider): ObservedTitle[] =>
    games
      .filter(
        (g) =>
          familyOf(g.platform) === provider &&
          !g.externalId.startsWith('legacy:') &&
          g.totalSeconds !== null &&
          !isKnownPsnApp(g.title),
      )
      .map((g) => ({
        platform: psnTitlePlatform(g.externalId) ?? g.platform,
        externalId: g.externalId,
        title: g.title,
        totalSeconds: g.totalSeconds as number,
      }));
  const actions: RepairAction[] = input.providers.flatMap(
    (p) => planRepairs(p, rows, observed(p), [], 'all').actions,
  );

  const sums = new Map<number, number>();
  for (const s of input.sessions)
    if (!TOTAL_EXCLUDED_SOURCES.includes(s.source))
      sums.set(
        s.libraryGameId,
        (sums.get(s.libraryGameId) ?? 0) + Number(s.seconds),
      );
  const now = new Map(
    games.map((g) => [g.id, g.totalSeconds ?? sums.get(g.id) ?? 0]),
  );
  const after = new Map(now);
  for (const a of actions) {
    if (a.kind === 'delete') after.delete(a.id);
    if (a.kind === 'fold') after.delete(a.dupId);
    if (a.kind === 'foldLegacy') after.delete(a.legacyId);
  }

  const row = (id: number) => {
    const g = byId.get(id)!;
    return {
      id,
      platform: g.platform,
      externalId: g.externalId,
      title: g.title,
      hours: hours(now.get(id) ?? 0),
    };
  };
  type Totals = { old: number; now: number; after: number };
  const groups = new Map<string, Totals & { titles: Set<string> }>();
  const group = (key: string) => {
    const g = groups.get(key) ?? {
      titles: new Set<string>(),
      old: 0,
      now: 0,
      after: 0,
    };
    groups.set(key, g);
    return g;
  };
  for (const o of input.oldTotals) {
    const g = group(titleKey(o.title) || `old:${o.title}`);
    g.old += Number(o.totalMs);
    g.titles.add(o.title);
  }
  for (const r of games) {
    const g = group(r.titleKey || `#${r.id}`);
    g.now += now.get(r.id) ?? 0;
    g.after += after.get(r.id) ?? 0;
    g.titles.add(`${r.title} [${r.platform} ${r.externalId}]`);
  }
  const sum = (f: (g: Totals) => number) =>
    hours([...groups.values()].reduce((a, g) => a + f(g), 0));
  const folded = new Set(
    actions.flatMap((a) => (a.kind === 'foldLegacy' ? [a.legacyId] : [])),
  );

  const plan: RepairPlan = {
    rekey: rekey.map((r) => ({ id: r.id, to: r.to })),
    sessionRepairs,
    actions,
  };
  const report = {
    totalsHours: {
      old: sum((g) => g.old),
      now: sum((g) => g.now),
      afterRepair: sum((g) => g.after),
    },
    legacyFolds: actions.flatMap((a) =>
      a.kind === 'foldLegacy'
        ? [{ rule: a.rule, legacy: row(a.legacyId), into: row(a.intoId) }]
        : [],
    ),
    unmatchedLegacy: games
      .filter((g) => g.externalId.startsWith('legacy:') && !folded.has(g.id))
      .map((g) => ({
        ...row(g.id),
        repairedByAConnection: input.providers.some(
          (p) => p === familyOf(g.platform),
        ),
      })),
    mediaApps: actions.flatMap((a) =>
      (a.kind === 'delete' || a.kind === 'keep') && a.why === 'app'
        ? [{ action: a.kind, game: row(a.id) }]
        : [],
    ),
    crossGenPairs: actions.flatMap((a) =>
      (a.kind === 'delete' || a.kind === 'keep') && a.why === 'duplicate'
        ? [{ action: a.kind, dropped: row(a.id), keptExternalId: a.twin }]
        : [],
    ),
    relabels: actions.flatMap((a) =>
      a.kind === 'relabel' ? [{ ...row(a.id), to: a.platform }] : [],
    ),
    twinFolds: actions.flatMap((a) =>
      a.kind === 'fold' ? [{ dup: row(a.dupId), into: row(a.intoId) }] : [],
    ),
    rekey,
    noiseSessions: {
      lastLegacyScrapeAt: scrapeAt,
      /** PSN/Steam under 5 min: kept in the table, hidden by every stats read. */
      hiddenCount: hidden.length,
      hiddenHours: hours(hidden.reduce((a, x) => a + Number(x.seconds), 0)),
      rewindowCount: sessionRepairs.length,
      repairs: sessionRepairs,
    },
    groups: [...groups]
      .filter(([, g]) => g.old !== g.now || g.now !== g.after)
      .map(([key, g]) => ({
        titleKey: key,
        titles: [...g.titles],
        oldHours: hours(g.old),
        nowHours: hours(g.now),
        afterHours: hours(g.after),
      }))
      .sort((a, b) => b.nowHours - b.oldHours - (a.nowHours - a.oldHours)),
  };
  return { report, plan };
}

@Injectable()
export class LibraryAuditService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Without `apply`: SELECTs only. With `apply`: the same plan, written in one transaction (all
   * or nothing), after a review of the dry run.
   */
  async run(userId: number, opts: { apply?: boolean } = {}) {
    if (!opts.apply) return (await this.plan(this.dataSource, userId)).report;
    return this.dataSource.transaction(async (m) => {
      const { report, plan } = await this.plan(m, userId);
      await applyRepairs(m, plan);
      return { ...report, applied: true };
    });
  }

  private async plan(db: DataSource | EntityManager, userId: number) {
    const q = <T>(sql: string, params: unknown[] = []) =>
      db.query<T[]>(sql, params);
    const games = await q<AuditGame>(
      'SELECT id, platform, externalId, title, titleKey, totalSeconds FROM library_game WHERE userId = ?',
      [userId],
    );
    const sessions = await q<AuditSession>(
      'SELECT id, libraryGameId, source, startedAt, endedAt, seconds FROM play_session WHERE userId = ?',
      [userId],
    );
    const oldTotals = await q<{ title: string; totalMs: number }>(
      'SELECT title, totalMs FROM total_game_time',
    );
    const conns = await q<{ provider: Provider }>(
      "SELECT provider FROM connection WHERE userId = ? AND status <> 'disabled'",
      [userId],
    );
    return buildAudit({
      games: games.map((g) => ({
        ...g,
        id: Number(g.id),
        totalSeconds: g.totalSeconds === null ? null : Number(g.totalSeconds), // BIGINT as string
      })),
      sessions: sessions.map((s) => ({
        ...s,
        id: Number(s.id),
        libraryGameId: Number(s.libraryGameId),
        seconds: Number(s.seconds),
      })),
      oldTotals,
      providers: conns.map((c) => c.provider),
    });
  }
}

/** Minimal module for the run-audit CLI: no HTTP server, cron or sync clients. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    // Entity metadata for --apply (autoLoadEntities).
    TypeOrmModule.forFeature([LibraryGame, PlaySession, GameIcon]),
  ],
  providers: [LibraryAuditService],
})
export class LibraryAuditCliModule {}
