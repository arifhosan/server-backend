import { Platform, Provider, SessionSource } from '../games.types';
import { MatchRule, matchLegacy } from '../library/legacy-match';
import { titleKey } from '../utils/title-key';
import type { ObservedTitle } from './platform-client';
import { isKnownPsnApp, psnTitlePlatform } from './psn.client';

/** A library_game row and how many sessions it has. */
export interface RepairRow {
  id: number;
  platform: Platform;
  externalId: string;
  title: string;
  titleKey: string;
  totalSeconds: number | null;
  sessions: number;
}

export type RepairAction =
  /** PSN row whose platform disagrees with its title id. */
  | { kind: 'relabel'; id: number; platform: Platform }
  /** Mislabelled row whose correct twin already exists: merge into the twin. */
  | { kind: 'fold'; dupId: number; intoId: number }
  /**
   * Unadopted legacy row folded into a synced row (`matchLegacy`): its sessions and icon move, it
   * is deleted, the synced total stays. Several legacy rows may fold into one synced row.
   */
  | { kind: 'foldLegacy'; legacyId: number; intoId: number; rule: MatchRule }
  /** Exact cross-gen duplicate (`twin` is the kept id) or media app, without sessions. */
  | { kind: 'delete'; id: number; why: 'duplicate' | 'app'; twin?: string }
  /** Same, but it has sessions: left alone, logged. */
  | { kind: 'keep'; id: number; why: 'duplicate' | 'app'; twin?: string };

const PSN_ID = /^[A-Z]{4}\d{5}_\d{2}$/;
const STEAM_ID = /^\d+$/;
const isLegacy = (r: { externalId: string }) =>
  r.externalId.startsWith('legacy:');
const ident = (platform: Platform, externalId: string) =>
  `${platform}|${externalId}`;

/** Sync sessions under this are noise (Exophase stored whole minutes, PSN reports seconds). */
export const MIN_SESSION_SECONDS = 300;

export interface RepairSession {
  id: number;
  libraryGameId: number;
  source: SessionSource;
  startedAt: Date;
  endedAt: Date;
  seconds: number;
}

export interface SessionRepair {
  kind: 'rewindow';
  id: number;
  startedAt: Date;
  source: SessionSource;
}

/** End of the newest `exophase` session: the legacy totals are current as of then. */
export function lastLegacyScrape(
  sessions: Pick<RepairSession, 'source' | 'endedAt'>[],
): Date | null {
  let last: Date | null = null;
  for (const s of sessions)
    if (s.source === 'exophase' && (!last || new Date(s.endedAt) > last))
      last = new Date(s.endedAt);
  return last;
}

/**
 * First-sync sessions windowed from before the last legacy scrape: they start at the scrape
 * instead (seconds unchanged; an `import` if they no longer fit, as `decideDelta` would have made
 * them). Nothing is deleted: short ones are hidden by the stats noise filter. Idempotent.
 */
export function planSessionRepairs(
  sessions: RepairSession[],
  scrapeAt: Date | null,
): SessionRepair[] {
  if (!scrapeAt) return [];
  const out: SessionRepair[] = [];
  for (const s of sessions) {
    const ended = new Date(s.endedAt);
    if (s.source !== 'steam' && s.source !== 'psn') continue;
    if (!(new Date(s.startedAt) < scrapeAt)) continue;
    if (ended > scrapeAt)
      out.push({
        kind: 'rewindow',
        id: s.id,
        startedAt: scrapeAt,
        source:
          s.seconds > (ended.getTime() - scrapeAt.getTime()) / 1000
            ? 'import'
            : s.source,
      });
  }
  return out;
}

/** Sessions per game id. */
export function sessionCounts(
  sessions: { libraryGameId: number }[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of sessions)
    out.set(s.libraryGameId, (out.get(s.libraryGameId) ?? 0) + 1);
  return out;
}

/**
 * PSN lists one cross-gen entitlement twice (PS4 and PS5 id, same seconds). In one fetch, titles
 * with the same non-empty titleKey and equal seconds (> 0) keep one: the one whose row exists
 * with sessions, else whose row exists, else the ps5 one, else the lower id.
 * `existing` maps `platform|externalId` of existing rows to "has sessions".
 */
export function dropExactDuplicates(
  titles: ObservedTitle[],
  existing: Map<string, boolean>,
): {
  kept: ObservedTitle[];
  dropped: { title: ObservedTitle; twin: ObservedTitle }[];
} {
  const groups = new Map<string, ObservedTitle[]>();
  for (const t of titles) {
    const key = titleKey(t.title);
    if (!key || t.totalSeconds <= 0) continue;
    const g = `${key}|${t.totalSeconds}`;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const rank = (t: ObservedTitle) => {
    const s = existing.get(ident(t.platform, t.externalId));
    return (
      (s === true ? 4 : s === false ? 2 : 0) + (t.platform === 'ps5' ? 1 : 0)
    );
  };
  const dropped: { title: ObservedTitle; twin: ObservedTitle }[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [twin, ...rest] = [...g].sort(
      (a, b) => rank(b) - rank(a) || a.externalId.localeCompare(b.externalId),
    );
    for (const title of rest) dropped.push({ title, twin });
  }
  const gone = new Set(dropped.map((d) => d.title));
  return { kept: titles.filter((t) => !gone.has(t)), dropped };
}

/**
 * What a sync of `provider` repairs before applying `titles` (keys already recomputed).
 * PSN only: platform from the title id; exact duplicates and media apps deleted. Both: every
 * unadopted legacy row with a total, largest first, folds into the synced row of the same
 * platform family `matchLegacy` picks (R1-R4). Rows are the user's; returns the titles to apply.
 * Idempotent: on repaired rows it plans nothing.
 */
export function planRepairs(
  provider: Provider,
  rows: RepairRow[],
  titles: ObservedTitle[],
  ignoredIds: string[] = [],
  /** 'sync': legacy folds by R1 only (the hourly repair); 'all': R1-R4 (reviewed audit --apply). */
  rules: 'sync' | 'all' = 'sync',
): { titles: ObservedTitle[]; actions: RepairAction[] } {
  const psn = provider === 'psn';
  const family: Platform[] = psn ? ['ps4', 'ps5'] : ['steam'];
  const live = rows
    .filter((r) => family.includes(r.platform))
    .map((r) => ({ ...r }))
    .sort((a, b) => a.id - b.id);
  const remove = (r: RepairRow) => live.splice(live.indexOf(r), 1);
  const find = (platform: Platform, externalId: string) =>
    live.find((r) => r.platform === platform && r.externalId === externalId);
  const actions: RepairAction[] = [];
  let kept = titles;

  if (psn) {
    for (const r of [...live]) {
      const platform = PSN_ID.test(r.externalId)
        ? psnTitlePlatform(r.externalId)
        : undefined;
      if (!platform || platform === r.platform) continue;
      const into = find(platform, r.externalId);
      if (into) {
        actions.push({ kind: 'fold', dupId: r.id, intoId: into.id });
        into.sessions += r.sessions;
        remove(r);
      } else {
        actions.push({ kind: 'relabel', id: r.id, platform });
        r.platform = platform;
      }
    }

    const d = dropExactDuplicates(
      titles,
      new Map(
        live.map((r) => [ident(r.platform, r.externalId), r.sessions > 0]),
      ),
    );
    kept = d.kept;
    const twins = new Map(
      d.dropped.map((x) => [
        ident(x.title.platform, x.title.externalId),
        x.twin.externalId,
      ]),
    );
    const apps = new Set(ignoredIds);
    for (const r of [...live]) {
      if (isLegacy(r)) continue;
      const twin = twins.get(ident(r.platform, r.externalId));
      const why = twin
        ? 'duplicate'
        : apps.has(r.externalId) ||
            (PSN_ID.test(r.externalId) && isKnownPsnApp(r.title))
          ? 'app'
          : undefined;
      if (!why) continue;
      const kind = r.sessions > 0 ? 'keep' : 'delete';
      actions.push(
        twin ? { kind, id: r.id, why, twin } : { kind, id: r.id, why },
      );
      remove(r);
    }
  }

  const reported = new Map(
    kept.map((t) => [ident(t.platform, t.externalId), t.totalSeconds]),
  );
  const synced = live
    .filter(
      (r) =>
        !isLegacy(r) &&
        r.totalSeconds !== null &&
        (psn ? PSN_ID : STEAM_ID).test(r.externalId),
    )
    .map((r) => ({
      id: r.id,
      platform: r.platform,
      titleKey: r.titleKey,
      total: reported.get(ident(r.platform, r.externalId)) ?? r.totalSeconds!,
    }));
  const legacies = live
    .filter((r) => isLegacy(r) && r.totalSeconds !== null)
    .sort((a, b) => b.totalSeconds! - a.totalSeconds! || a.id - b.id);
  for (const l of legacies) {
    const m = matchLegacy(
      {
        id: l.id,
        platform: l.platform,
        titleKey: l.titleKey,
        total: l.totalSeconds!,
      },
      synced,
      rules === 'sync',
    );
    if (m)
      actions.push({
        kind: 'foldLegacy',
        legacyId: l.id,
        intoId: m.into.id,
        rule: m.rule,
      });
  }

  return { titles: kept, actions };
}
