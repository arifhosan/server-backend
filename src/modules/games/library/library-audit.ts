import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../../../database/database.module';
import {
  Platform,
  SessionSource,
  TOTAL_EXCLUDED_SOURCES,
} from '../games.types';
import type { ObservedTitle } from '../sync/platform-client';
import { isKnownPsnApp, psnTitlePlatform } from '../sync/psn.client';
import {
  NO_SESSIONS,
  RepairAction,
  RepairRow,
  lastLegacyScrape,
  planRepairs,
  planSessionRepairs,
  sessionStats,
} from '../sync/repair-plan';
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
  legacyRef: string | null;
  seconds: number;
}
export interface AuditInput {
  games: AuditGame[];
  sessions: AuditSession[];
  /** total_game_time rows (`totalMs` holds seconds). */
  oldTotals: { title: string; totalMs: number }[];
}

const hours = (s: number) => Math.round(s / 360) / 10;

/**
 * What the next syncs' repairs would do, from the stored rows alone: the reported totals are the
 * rows' own (the audit never calls PSN or Steam; a PSN refresh would rotate the stored tokens).
 * Totals are in hours; "after" assumes each adopted legacy row then shows its synced total.
 */
export function buildAudit(input: AuditInput) {
  const rekey = input.games
    .filter((g) => titleKey(g.title) !== g.titleKey)
    .map((g) => ({ id: g.id, from: g.titleKey, to: titleKey(g.title) }));
  const games = input.games.map((g) => ({ ...g, titleKey: titleKey(g.title) }));
  const scrapeAt = lastLegacyScrape(input.sessions);
  const sessionRepairs = planSessionRepairs(input.sessions, scrapeAt);
  const deleted = new Set(
    sessionRepairs.flatMap((r) => (r.kind === 'deleteSession' ? [r.id] : [])),
  );
  const stats = sessionStats(input.sessions.filter((s) => !deleted.has(s.id)));
  const rows: RepairRow[] = games.map((g) => ({
    ...g,
    ...(stats.get(g.id) ?? NO_SESSIONS),
  }));
  const observed = (platforms: Platform[], id: RegExp): ObservedTitle[] =>
    games
      .filter(
        (g) =>
          platforms.includes(g.platform) &&
          id.test(g.externalId) &&
          g.totalSeconds !== null &&
          !isKnownPsnApp(g.title),
      )
      .map((g) => ({
        platform: psnTitlePlatform(g.externalId) ?? g.platform,
        externalId: g.externalId,
        title: g.title,
        totalSeconds: g.totalSeconds as number,
      }));
  const actions: RepairAction[] = [
    ...planRepairs(
      'psn',
      rows,
      observed(['ps4', 'ps5'], /^[A-Z]{4}\d{5}_\d{2}$/),
    ).actions,
    ...planRepairs('steam', rows, observed(['steam'], /^\d+$/)).actions,
  ];

  // Library totals the way the dashboard counts them: reported total, else session sum.
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
    if (a.kind === 'adopt') {
      after.set(a.legacyId, now.get(a.dupId) ?? 0);
      after.delete(a.dupId);
    }
  }

  const groups = new Map<
    string,
    { titles: Set<string>; old: number; now: number; after: number }
  >();
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
  const adopted = new Set(
    actions.flatMap((a) => (a.kind === 'adopt' ? [a.legacyId] : [])),
  );
  const sum = (f: (g: { old: number; now: number; after: number }) => number) =>
    hours([...groups.values()].reduce((a, g) => a + f(g), 0));

  return {
    totalsHours: {
      old: sum((g) => g.old),
      now: sum((g) => g.now),
      afterRepair: sum((g) => g.after),
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
    unadoptedLegacy: games
      .filter((g) => g.externalId.startsWith('legacy:'))
      .map((g) => ({
        id: g.id,
        platform: g.platform,
        title: g.title,
        hours: g.totalSeconds === null ? null : hours(g.totalSeconds),
        adoptedByRepair: adopted.has(g.id),
      })),
    rekey,
    actions,
    sessions: {
      lastLegacyScrapeAt: scrapeAt,
      deleteCount: deleted.size,
      deleteHours: hours(
        sessionRepairs.reduce(
          (a, r) => a + (r.kind === 'deleteSession' ? r.seconds : 0),
          0,
        ),
      ),
      rewindowCount: sessionRepairs.length - deleted.size,
      repairs: sessionRepairs,
    },
  };
}

@Injectable()
export class LibraryAuditService {
  constructor(private readonly dataSource: DataSource) {}

  /** Read-only: SELECTs only. */
  async run(userId: number) {
    const q = <T>(sql: string, params: unknown[] = []) =>
      this.dataSource.query<T[]>(sql, params);
    const games = await q<AuditGame>(
      'SELECT id, platform, externalId, title, titleKey, totalSeconds FROM library_game WHERE userId = ?',
      [userId],
    );
    const sessions = await q<AuditSession>(
      'SELECT id, libraryGameId, source, legacyRef, startedAt, endedAt, seconds FROM play_session WHERE userId = ?',
      [userId],
    );
    const oldTotals = await q<{ title: string; totalMs: number }>(
      'SELECT title, totalMs FROM total_game_time',
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
    });
  }
}

/** Minimal module for the run-audit CLI: no HTTP server, cron or sync clients. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
  providers: [LibraryAuditService],
})
export class LibraryAuditCliModule {}
