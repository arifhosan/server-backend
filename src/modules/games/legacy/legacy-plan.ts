import { Platform, SessionSource } from '../games.types';
import { titleKey } from '../utils/title-key';

/** Rows of `game` and `game_old`. `playtimeMs` really holds SECONDS. */
export interface LegacyGameRow {
  id: number;
  title: string;
  slug: string;
  platform: string;
  playtimeMs: number;
  createdAt: Date;
}
/** Row of `total_game_time`. `totalMs` really holds SECONDS. */
export interface LegacyTotalRow {
  id: number;
  slug: string;
  title: string;
  platform: string;
  totalMs: number;
  updatedAt: Date;
}
/** Row of `playtime` (daily sum). `totalMs` really holds SECONDS. */
export interface LegacyDayRow {
  date: string;
  totalMs: number;
}
export interface LegacyInput {
  totals: LegacyTotalRow[];
  games: LegacyGameRow[];
  gamesOld: LegacyGameRow[];
}

export interface PlannedGame {
  externalId: string;
  platform: Platform;
  title: string;
  titleKey: string;
  totalSeconds: number | null;
  totalChangedAt: Date | null;
  lastPlayedAt: Date | null;
}
export interface PlannedSession {
  legacyRef: string;
  externalId: string;
  source: Extract<SessionSource, 'exophase' | 'import' | 'legacy_test'>;
  startedAt: Date;
  endedAt: Date;
  seconds: number;
}
export interface LegacyPlan {
  library: PlannedGame[];
  sessions: PlannedSession[];
  unknownPlatforms: string[];
}

const PLATFORMS: Record<string, Platform> = {
  Steam: 'steam',
  PS5: 'ps5',
  PS4: 'ps4',
  'Xbox Series': 'xbox_pc',
  'Xbox One': 'xbox_pc',
  Windows: 'xbox_pc',
  'Windows 10': 'xbox_pc',
  Ubisoft: 'pc_other',
};

export function legacyPlatform(raw: string): {
  platform: Platform;
  known: boolean;
} {
  const platform = Object.hasOwn(PLATFORMS, raw) ? PLATFORMS[raw] : undefined;
  return platform
    ? { platform, known: true }
    : { platform: 'pc_other', known: false };
}

const DAY_S = 86_400;
/** Sessions created before this belong to the 2025-04-28/29 baseline import. */
const BASELINE_END = Date.parse('2025-04-29T12:00:00Z');

export function buildLegacyPlan(input: LegacyInput): LegacyPlan {
  const library: PlannedGame[] = [];
  const bySlugId = new Map<string, PlannedGame>();
  const byPlatformKey = new Map<string, PlannedGame>();
  const unknown = new Set<string>();

  const add = (
    externalId: string,
    title: string,
    rawPlatform: string,
    total: LegacyTotalRow | null,
  ): PlannedGame => {
    const g: PlannedGame = {
      externalId,
      platform: legacyPlatform(rawPlatform).platform,
      title,
      titleKey: titleKey(title),
      totalSeconds: total ? Number(total.totalMs) : null,
      totalChangedAt: total ? total.updatedAt : null,
      lastPlayedAt: null,
    };
    library.push(g);
    bySlugId.set(externalId, g);
    // R8: an empty titleKey is "no key"; never match on it.
    if (g.titleKey) {
      const k = `${g.platform}|${g.titleKey}`;
      if (!byPlatformKey.has(k)) byPlatformKey.set(k, g);
    }
    return g;
  };

  for (const r of [...input.totals, ...input.games, ...input.gamesOld]) {
    if (!legacyPlatform(r.platform).known) unknown.add(r.platform);
  }
  for (const t of input.totals) {
    add(`legacy:${t.slug}`, t.title, t.platform, t);
  }

  const sessions: PlannedSession[] = [];
  /** Finds or creates the library game for a session row. */
  const resolve = (
    r: LegacyGameRow,
    table: string,
    fuzzy: boolean,
  ): PlannedGame => {
    if (r.slug) {
      const hit = bySlugId.get(`legacy:${r.slug}`);
      if (hit) return hit;
    }
    // game rows only fall back to the title when they have no slug at all.
    if (fuzzy || !r.slug) {
      const key = titleKey(r.title);
      if (key) {
        const hit = byPlatformKey.get(
          `${legacyPlatform(r.platform).platform}|${key}`,
        );
        if (hit) return hit;
      }
    }
    return add(
      r.slug ? `legacy:${r.slug}` : `legacy:${table}:${r.id}`,
      r.title,
      r.platform,
      null,
    );
  };
  const addSession = (
    r: LegacyGameRow,
    table: 'game' | 'game_old',
    source: PlannedSession['source'],
  ): void => {
    const g = resolve(r, table, table === 'game_old');
    const endedAt = new Date(r.createdAt);
    const seconds = Number(r.playtimeMs);
    sessions.push({
      legacyRef: `${table}:${r.id}`,
      externalId: g.externalId,
      source,
      startedAt: new Date(endedAt.getTime() - DAY_S * 1000),
      endedAt,
      seconds,
    });
    if (
      source !== 'legacy_test' &&
      (!g.lastPlayedAt || g.lastPlayedAt < endedAt)
    ) {
      g.lastPlayedAt = endedAt;
    }
  };

  for (const r of input.games) {
    const baseline = new Date(r.createdAt).getTime() < BASELINE_END;
    addSession(
      r,
      'game',
      baseline || Number(r.playtimeMs) > DAY_S ? 'import' : 'exophase',
    );
  }
  for (const r of input.gamesOld) addSession(r, 'game_old', 'legacy_test');

  return { library, sessions, unknownPlatforms: [...unknown].sort() };
}

const same = (a: Date | null, b: Date | null): boolean =>
  (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/** Compares a plan (or a read-back of the new tables) with the legacy rows. Empty = OK. */
export function checkLegacyPlan(
  plan: LegacyPlan,
  input: LegacyInput,
): string[] {
  const want = buildLegacyPlan(input);
  const out: string[] = [];

  const haveGames = new Map(plan.library.map((g) => [g.externalId, g]));
  for (const w of want.library) {
    const h = haveGames.get(w.externalId);
    if (!h) {
      out.push(`library game missing: ${w.externalId}`);
    } else if (
      h.platform !== w.platform ||
      h.title !== w.title ||
      h.titleKey !== w.titleKey ||
      (h.totalSeconds === null ? null : Number(h.totalSeconds)) !==
        w.totalSeconds ||
      !same(h.totalChangedAt, w.totalChangedAt)
    ) {
      out.push(
        `library game differs: ${w.externalId} total ${String(h.totalSeconds)} != ${String(w.totalSeconds)}`,
      );
    }
  }
  const wantGames = new Set(want.library.map((g) => g.externalId));
  for (const h of plan.library) {
    if (!wantGames.has(h.externalId)) {
      out.push(`unexpected library game: ${h.externalId}`);
    }
  }

  const haveSessions = new Map<string, PlannedSession>();
  for (const s of plan.sessions) {
    if (haveSessions.has(s.legacyRef)) {
      out.push(`duplicate session: ${s.legacyRef}`);
    }
    haveSessions.set(s.legacyRef, s);
  }
  for (const w of want.sessions) {
    const h = haveSessions.get(w.legacyRef);
    if (!h) {
      out.push(`session missing: ${w.legacyRef}`);
    } else if (
      h.externalId !== w.externalId ||
      h.source !== w.source ||
      Number(h.seconds) !== w.seconds ||
      !same(h.startedAt, w.startedAt) ||
      !same(h.endedAt, w.endedAt)
    ) {
      out.push(
        `session differs: ${w.legacyRef} (${h.source}/${h.seconds}s/${h.externalId} != ${w.source}/${w.seconds}s/${w.externalId})`,
      );
    }
  }
  const wantRefs = new Set(want.sessions.map((s) => s.legacyRef));
  for (const h of plan.sessions) {
    if (!wantRefs.has(h.legacyRef)) {
      out.push(`unexpected session: ${h.legacyRef}`);
    }
  }
  return out;
}

/** Days where `playtime` disagrees with the sum of `game` rows created that (UTC) day. */
export function dayMismatches(
  days: LegacyDayRow[],
  games: LegacyGameRow[],
): { date: string; playtime: number; gameSum: number }[] {
  const sums = new Map<string, number>();
  for (const g of games) {
    const date = new Date(g.createdAt).toISOString().slice(0, 10);
    sums.set(date, (sums.get(date) ?? 0) + Number(g.playtimeMs));
  }
  const play = new Map<string, number>();
  for (const r of days) {
    play.set(r.date, (play.get(r.date) ?? 0) + Number(r.totalMs));
  }
  const out: { date: string; playtime: number; gameSum: number }[] = [];
  for (const date of new Set([...play.keys(), ...sums.keys()])) {
    const playtime = play.get(date) ?? 0;
    const gameSum = sums.get(date) ?? 0;
    if (playtime !== gameSum) out.push({ date, playtime, gameSum });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
