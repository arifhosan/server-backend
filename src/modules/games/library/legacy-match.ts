const words = (key: string) => new Set(key.split(' ').filter(Boolean));

/** Non-empty keys where one holds the other as whole words, or word-set Jaccard >= 0.5. */
export function similarTitles(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return true;
  const A = words(a);
  const B = words(b);
  const common = [...A].filter((w) => B.has(w)).length;
  return common / (A.size + B.size - common) >= 0.5;
}

/**
 * Legacy rows a reported total could have grown from since the legacy import (Exophase read the
 * same platforms): reported >= legacy and at most max(2 h, 2 %) more, with a similar title.
 * The caller passes only unadopted legacy rows of the same platform family.
 */
export function matchLegacyByTotal<
  T extends { titleKey: string; totalSeconds: number | null },
>(key: string, reported: number, legacy: T[]): T[] {
  return legacy.filter(
    (l) =>
      l.totalSeconds !== null &&
      reported >= l.totalSeconds &&
      reported - l.totalSeconds <= Math.max(7200, 0.02 * l.totalSeconds) &&
      similarTitles(key, l.titleKey),
  );
}
