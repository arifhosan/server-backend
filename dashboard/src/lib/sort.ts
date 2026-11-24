import type { LibraryEntry, Platform } from '../api/types';

export type SortKey = 'title' | 'total' | 'recent' | 'last';
export type Dir = 'asc' | 'desc';
export type PlatformFilter = 'all' | 'steam' | 'ps' | 'xbox' | 'other';

export interface LibraryRow extends LibraryEntry {
  recent: number;
  /** Normalised title, computed once so filtering 300+ rows stays cheap. */
  search: string;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  steam: 'Steam',
  ps5: 'PS5',
  ps4: 'PS4',
  xbox_pc: 'Xbox app',
  epic: 'Epic',
  pc_other: 'Other PC',
};

export const FILTERS: { id: PlatformFilter; label: string; platforms: Platform[] }[] = [
  { id: 'all', label: 'All', platforms: [] },
  { id: 'steam', label: 'Steam', platforms: ['steam'] },
  { id: 'ps', label: 'PlayStation', platforms: ['ps4', 'ps5'] },
  { id: 'xbox', label: 'Xbox app', platforms: ['xbox_pc'] },
  { id: 'other', label: 'Other PC', platforms: ['epic', 'pc_other'] },
];

/** Lower-case and strip accents: "Pokémon" matches "pokemon". */
export const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function toRows(entries: LibraryEntry[], recentByKey: Map<string, number>): LibraryRow[] {
  return entries.map((e) => ({ ...e, recent: recentByKey.get(e.titleKey) ?? 0, search: norm(e.title) }));
}

export function filterRows(rows: LibraryRow[], filter: PlatformFilter, query: string): LibraryRow[] {
  const platforms = FILTERS.find((f) => f.id === filter)?.platforms ?? [];
  const q = norm(query.trim());
  return rows.filter(
    (r) => (filter === 'all' || r.platforms.some((p) => platforms.includes(p.platform))) && r.search.includes(q),
  );
}

/** Title sorts A-Z first; numbers biggest first. */
export const defaultDir = (key: SortKey): Dir => (key === 'title' ? 'asc' : 'desc');

export function sortRows(rows: LibraryRow[], key: SortKey, dir: Dir): LibraryRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (key) {
      case 'title':
        return sign * a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
      case 'total':
        return sign * (a.totalSeconds - b.totalSeconds);
      case 'recent':
        return sign * (a.recent - b.recent);
      case 'last': {
        // Never-played rows go last in both directions.
        if (a.lastPlayedAt === null || b.lastPlayedAt === null) {
          return a.lastPlayedAt === b.lastPlayedAt ? 0 : a.lastPlayedAt === null ? 1 : -1;
        }
        return sign * (Date.parse(a.lastPlayedAt) - Date.parse(b.lastPlayedAt));
      }
    }
  });
}
