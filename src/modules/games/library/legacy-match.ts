import { Platform } from '../games.types';

/** A row with the total to compare: a legacy row's, or what the platform reports for a synced one. */
export interface MatchRow {
  id: number;
  platform: Platform;
  titleKey: string;
  total: number;
}
export type MatchRule = 'R1' | 'R2' | 'R3' | 'R4';

const STOP_WORDS = new Set([
  'the',
  'of',
  'and',
  'edition',
  'collection',
  'remastered',
  'ps4',
  'ps5',
  'game',
  'year',
]);
const words = (key: string) => key.split(' ').filter(Boolean);
const numbers = (key: string) => words(key).filter((w) => /^\d+$/.test(w));

/** Jaccard similarity of the two keys' word sets (0 when either is empty). */
export function jaccard(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  const common = [...A].filter((w) => B.has(w)).length;
  const union = A.size + B.size - common;
  return union ? common / union : 0;
}

/** Non-empty keys where one holds the other as whole words, or word-set Jaccard >= 0.5. */
export function similarTitles(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return true;
  return jaccard(a, b) >= 0.5;
}

/** "Far Cry 6" is not "Far Cry 5": numeric tokens, when either title has any, must be the same set. */
export function sameNumbers(a: string, b: string): boolean {
  const A = new Set(numbers(a));
  const B = new Set(numbers(b));
  return A.size === B.size && [...A].every((n) => B.has(n));
}

/** At least one shared word of 3+ letters that is not a stop word. */
export function shareSignificantWord(a: string, b: string): boolean {
  const B = new Set(words(b));
  return words(a).some((w) => w.length >= 3 && !STOP_WORDS.has(w) && B.has(w));
}

/** How far below the legacy total a synced total may be (Exophase minutes vs platform seconds). */
export const tolerance = (legacyTotal: number) =>
  Math.max(600, 0.01 * legacyTotal);

/**
 * The synced row of the same platform family an unadopted legacy row folds into, first rule wins:
 * R1 same titleKey, synced >= legacy - tol: the closest, then same platform, then lowest id.
 * R2 synced in [legacy - tol, legacy + max(2 h, 2 %)], similar title with the same numbers:
 *    the closest; a tie matches nothing.
 * R3 exactly one synced row within 60 s that shares a significant word (numbers may differ).
 * R4 the synced rows with the legacy titleKey (2+) sum to within tol: the largest of them.
 */
export function matchLegacy(
  legacy: MatchRow,
  synced: MatchRow[],
): { into: MatchRow; rule: MatchRule } | undefined {
  const L = legacy;
  const tol = tolerance(L.total);
  const above = synced.filter((s) => s.total >= L.total - tol);
  const dist = (s: MatchRow) => Math.abs(s.total - L.total);

  if (L.titleKey) {
    const [r1] = above
      .filter((s) => s.titleKey === L.titleKey)
      .sort(
        (a, b) =>
          dist(a) - dist(b) ||
          Number(b.platform === L.platform) -
            Number(a.platform === L.platform) ||
          a.id - b.id,
      );
    if (r1) return { into: r1, rule: 'R1' };
  }

  const r2 = above
    .filter(
      (s) =>
        s.total - L.total <= Math.max(7200, 0.02 * L.total) &&
        similarTitles(s.titleKey, L.titleKey) &&
        sameNumbers(s.titleKey, L.titleKey),
    )
    .sort((a, b) => dist(a) - dist(b));
  if (r2.length)
    return r2.length > 1 && dist(r2[0]) === dist(r2[1])
      ? undefined
      : { into: r2[0], rule: 'R2' };

  const r3 = synced.filter(
    (s) => dist(s) <= 60 && shareSignificantWord(s.titleKey, L.titleKey),
  );
  if (r3.length === 1) return { into: r3[0], rule: 'R3' };

  const same = L.titleKey
    ? synced.filter((s) => s.titleKey === L.titleKey)
    : [];
  const sum = same.reduce((a, s) => a + s.total, 0);
  if (same.length > 1 && Math.abs(sum - L.total) <= tol) {
    const [largest] = [...same].sort(
      (a, b) => b.total - a.total || a.id - b.id,
    );
    return { into: largest, rule: 'R4' };
  }
  return undefined;
}
