import axios from 'axios';
import { EntityManager } from 'typeorm';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { titleKey } from '../utils/title-key';
import { steamImageUrl } from './art';
import { jaccard, sameNumbers } from './legacy-match';

export interface StoreItem {
  id: number;
  name: string;
}

const PLATFORM_SUFFIX = /\s+(?:(?:for\s+)?windows 10|pc|xbox series x s)$/;
const DAY_MS = 86_400_000;
/** A miss waits 30 days; a failed request 1 day (stamped 29 days into the past). */
const RETRY_MS = 30 * DAY_MS;
const FAILED_RETRY_MS = DAY_MS;
const PER_RUN = 20;

/** titleKey without store suffixes: "Yakuza 0 for Windows 10" -> "yakuza 0". */
export function artKey(title: string): string {
  let k = titleKey(title);
  for (
    let n = k.replace(PLATFORM_SUFFIX, '');
    n !== k;
    n = k.replace(PLATFORM_SUFFIX, '')
  )
    k = n;
  return k;
}

/** The first store result named like the title: same artKey, else same numbers and Jaccard >= 0.8. */
export function pickStoreMatch(
  title: string,
  items: StoreItem[],
): number | undefined {
  const k = artKey(title);
  if (!k) return undefined;
  const exact = items.find((i) => artKey(i.name) === k);
  if (exact) return exact.id;
  return items.find((i) => {
    const n = artKey(i.name);
    return sameNumbers(k, n) && jaccard(k, n) >= 0.8;
  })?.id;
}

/** Steam store search (public, no key). */
export async function searchSteamStore(term: string): Promise<StoreItem[]> {
  const res = await axios.get<{ items?: StoreItem[] }>(
    'https://store.steampowered.com/api/storesearch/',
    {
      params: { term, cc: 'us', l: 'en' },
      timeout: 10_000,
      maxContentLength: 1_000_000,
    },
  );
  return res.data?.items ?? [];
}

/**
 * Steam store art for games whose whole group (user and titleKey, like the library's art
 * fallback) has no image and no icon, and whose title gives a non-empty search key: at most 20
 * lookups per run. A miss stamps `artCheckedAt` and waits 30 days; a failed request waits 1 day,
 * so a failing group cannot keep the others from their turn. Returns the hits.
 */
export async function fillMissingArt(
  m: EntityManager,
  now: Date,
  search: (term: string) => Promise<StoreItem[]> = searchSteamStore,
): Promise<number> {
  const repo = m.getRepository(LibraryGame);
  // ponytail: reads every row of every user; fine for a personal server, filter in SQL if it grows.
  const rows = await repo.find();
  const icons = new Set(
    (
      await m.getRepository(GameIcon).find({ select: { libraryGameId: true } })
    ).map((i) => i.libraryGameId),
  );
  const group = (g: LibraryGame) => `${g.userId}|${g.titleKey || `#${g.id}`}`;
  const skip = new Set(
    rows
      .filter(
        (g) =>
          g.imageUrl ||
          icons.has(g.id) ||
          (g.artCheckedAt &&
            now.getTime() - g.artCheckedAt.getTime() < RETRY_MS),
      )
      .map(group),
  );
  const todo: LibraryGame[] = [];
  for (const g of rows) {
    if (todo.length >= PER_RUN) break;
    if (skip.has(group(g)) || !artKey(g.title)) continue;
    skip.add(group(g)); // one lookup per group
    todo.push(g);
  }

  let found = 0;
  for (const g of todo) {
    let items: StoreItem[];
    try {
      items = await search(artKey(g.title));
    } catch {
      await repo.update(g.id, {
        artCheckedAt: new Date(now.getTime() - RETRY_MS + FAILED_RETRY_MS),
      });
      continue;
    }
    const appid = pickStoreMatch(g.title, items);
    await repo.update(
      g.id,
      appid
        ? { imageUrl: steamImageUrl(String(appid)), artCheckedAt: now }
        : { artCheckedAt: now },
    );
    if (appid) found++;
  }
  return found;
}
