import { Platform, Provider, SessionSource } from '../games.types';
import { matchLegacyByTotal } from '../library/legacy-match';
import { titleKey } from '../utils/title-key';
import type { ObservedTitle } from './platform-client';
import { isKnownPsnApp, psnTitlePlatform } from './psn.client';

/** A library_game row plus what its sessions say about it. */
export interface RepairRow {
  id: number;
  platform: Platform;
  externalId: string;
  title: string;
  titleKey: string;
  totalSeconds: number | null;
  /** Seconds of sessions earlier syncs wrote (catch-up and deltas). */
  syncSeconds: number;
  trackerSessions: number;
  /** Legacy-import sessions (`legacyRef` set): the row is, or absorbed, a legacy row. */
  legacySessions: number;
}

type SessionStats = Pick<
  RepairRow,
  'syncSeconds' | 'trackerSessions' | 'legacySessions'
>;

export type RepairAction =
  /** PSN row whose platform disagrees with its title id. */
  | { kind: 'relabel'; id: number; platform: Platform }
  /** Mislabelled row whose correct twin already exists: merge into the twin. */
  | { kind: 'fold'; dupId: number; intoId: number }
  /**
   * Synced row folded into an unadopted legacy row, which takes its platform and id. The legacy
   * total stays the baseline, raised by `baselinePlus` (sync sessions moved over) so the next
   * delta does not count them again.
   */
  | {
      kind: 'adopt';
      dupId: number;
      legacyId: number;
      platform: Platform;
      externalId: string;
      baselinePlus: number;
      by: 'title' | 'total';
    }
  /** Exact cross-gen duplicate or media app without sessions. */
  | { kind: 'delete'; id: number; why: 'duplicate' | 'app' }
  /** Same, but it has sessions: left alone, logged. */
  | { kind: 'keep'; id: number; why: 'duplicate' | 'app' }
  /** Several legacy rows match the total: none adopted, logged. */
  | { kind: 'ambiguous'; id: number; legacyIds: number[] };

const PSN_ID = /^[A-Z]{4}\d{5}_\d{2}$/;
const STEAM_ID = /^\d+$/;
const isLegacy = (r: { externalId: string }) =>
  r.externalId.startsWith('legacy:');
const ident = (platform: Platform, externalId: string) =>
  `${platform}|${externalId}`;
const hasSessions = (r: RepairRow) =>
  r.syncSeconds > 0 || r.trackerSessions > 0 || r.legacySessions > 0;
const addStats = (into: SessionStats, from: SessionStats) => {
  into.syncSeconds += from.syncSeconds;
  into.trackerSessions += from.trackerSessions;
  into.legacySessions += from.legacySessions;
};

export const NO_SESSIONS: SessionStats = {
  syncSeconds: 0,
  trackerSessions: 0,
  legacySessions: 0,
};

/** Sync sessions under this are noise (Exophase stored whole minutes, PSN reports seconds). */
export const MIN_SESSION_SECONDS = 300;

export interface RepairSession {
  id: number;
  source: SessionSource;
  startedAt: Date;
  endedAt: Date;
  seconds: number;
}

export type SessionRepair =
  | { kind: 'deleteSession'; id: number; seconds: number }
  | { kind: 'rewindow'; id: number; startedAt: Date; source: SessionSource };

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
 * First-sync noise: Steam/PSN sessions windowed from before the last legacy scrape. Under 5 min
 * they are deleted; the rest start at the scrape instead (seconds unchanged; an `import` if they
 * no longer fit the window, as `decideDelta` would have made them). Idempotent.
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
    if (s.seconds < MIN_SESSION_SECONDS)
      out.push({ kind: 'deleteSession', id: s.id, seconds: s.seconds });
    else if (ended > scrapeAt)
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

/** Per game id: what its sessions are. */
export function sessionStats(
  sessions: {
    libraryGameId: number;
    source: SessionSource;
    legacyRef: string | null;
    seconds: number;
  }[],
): Map<number, SessionStats> {
  const out = new Map<number, SessionStats>();
  for (const s of sessions) {
    const st = out.get(s.libraryGameId) ?? { ...NO_SESSIONS };
    if (s.legacyRef) st.legacySessions++;
    else if (s.source === 'tracker') st.trackerSessions++;
    else st.syncSeconds += Number(s.seconds);
    out.set(s.libraryGameId, st);
  }
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
): { kept: ObservedTitle[]; dropped: ObservedTitle[] } {
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
  const dropped = new Set<ObservedTitle>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [, ...rest] = [...g].sort(
      (a, b) => rank(b) - rank(a) || a.externalId.localeCompare(b.externalId),
    );
    rest.forEach((t) => dropped.add(t));
  }
  return {
    kept: titles.filter((t) => !dropped.has(t)),
    dropped: [...dropped],
  };
}

/**
 * What a sync of `provider` repairs before applying `titles` (keys already recomputed).
 * PSN only: platform from the title id; exact duplicates and media apps deleted. Both: a synced
 * row without legacy sessions folded into an unadopted legacy row of the same platform and
 * titleKey, else (rows with only sync sessions) into the one legacy row of the platform family
 * with a matching total (`matchLegacyByTotal`). Rows are the
 * user's; returns the titles to apply. Idempotent: on repaired rows it plans nothing.
 */
export function planRepairs(
  provider: Provider,
  rows: RepairRow[],
  titles: ObservedTitle[],
  ignoredIds: string[] = [],
): { titles: ObservedTitle[]; actions: RepairAction[] } {
  const psn = provider === 'psn';
  const family: Platform[] = psn ? ['ps4', 'ps5'] : ['steam'];
  const synced = (r: RepairRow) =>
    !isLegacy(r) &&
    r.totalSeconds !== null &&
    (psn ? PSN_ID : STEAM_ID).test(r.externalId);
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
        addStats(into, r);
        remove(r);
      } else {
        actions.push({ kind: 'relabel', id: r.id, platform });
        r.platform = platform;
      }
    }

    const d = dropExactDuplicates(
      titles,
      new Map(
        live.map((r) => [ident(r.platform, r.externalId), hasSessions(r)]),
      ),
    );
    kept = d.kept;
    const dupes = new Set(
      d.dropped.map((t) => ident(t.platform, t.externalId)),
    );
    const apps = new Set(ignoredIds);
    for (const r of [...live]) {
      if (isLegacy(r)) continue;
      const why = dupes.has(ident(r.platform, r.externalId))
        ? 'duplicate'
        : apps.has(r.externalId) ||
            (PSN_ID.test(r.externalId) && isKnownPsnApp(r.title))
          ? 'app'
          : undefined;
      if (!why) continue;
      actions.push({ kind: hasSessions(r) ? 'keep' : 'delete', id: r.id, why });
      remove(r);
    }
  }

  const adopted = new Set<number>();
  const adopt = (dup: RepairRow, legacy: RepairRow, by: 'title' | 'total') => {
    actions.push({
      kind: 'adopt',
      dupId: dup.id,
      legacyId: legacy.id,
      platform: dup.platform,
      externalId: dup.externalId,
      baselinePlus: legacy.totalSeconds === null ? 0 : dup.syncSeconds,
      by,
    });
    legacy.platform = dup.platform;
    legacy.externalId = dup.externalId;
    addStats(legacy, dup);
    adopted.add(legacy.id);
    remove(dup);
  };

  for (const legacy of live.filter((r) => isLegacy(r) && r.titleKey)) {
    const [dup] = live
      .filter(
        (r) =>
          synced(r) &&
          r.legacySessions === 0 && // never fold one legacy row into another
          !adopted.has(r.id) &&
          r.platform === legacy.platform &&
          r.titleKey === legacy.titleKey,
      )
      // Two regions: the larger total is the likelier continuation of the legacy one.
      .sort((a, b) => (b.totalSeconds ?? 0) - (a.totalSeconds ?? 0));
    if (dup) adopt(dup, legacy, 'title');
  }

  const reported = new Map(
    kept.map((t) => [ident(t.platform, t.externalId), t.totalSeconds]),
  );
  for (const r of live.filter(
    (x) =>
      synced(x) &&
      x.trackerSessions === 0 &&
      x.legacySessions === 0 &&
      !adopted.has(x.id),
  )) {
    const hits = matchLegacyByTotal(
      r.titleKey,
      reported.get(ident(r.platform, r.externalId)) ?? r.totalSeconds ?? 0,
      live.filter(isLegacy),
    );
    if (hits.length === 1) adopt(r, hits[0], 'total');
    else if (hits.length > 1)
      actions.push({
        kind: 'ambiguous',
        id: r.id,
        legacyIds: hits.map((h) => h.id),
      });
  }

  return { titles: kept, actions };
}
