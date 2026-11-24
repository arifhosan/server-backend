import { matchLegacyByTotal, similarTitles } from './legacy-match';

const H = 3600;

describe('similarTitles', () => {
  it('whole-word containment or Jaccard >= 0.5, never on an empty key', () => {
    expect(
      similarTitles(
        'tom clancys rainbow six siege',
        'tom clancys rainbow six siege x',
      ),
    ).toBe(true);
    expect(similarTitles('god of war', 'god of war ragnarok')).toBe(true);
    expect(similarTitles('red dead redemption 2', 'red dead redemption')).toBe(
      true,
    );
    // 2 of 4 words shared: 0.5.
    expect(similarTitles('final fantasy vii', 'final fantasy xvi')).toBe(true);
    expect(similarTitles('it takes two', 'split fiction')).toBe(false);
    // Substring of a word is not containment.
    expect(similarTitles('it', 'split fiction')).toBe(false);
    expect(similarTitles('', 'anything')).toBe(false);
    expect(similarTitles('anything', '')).toBe(false);
  });
});

describe('matchLegacyByTotal', () => {
  const legacy = (id: number, titleKey: string, hours: number | null) => ({
    id,
    titleKey,
    totalSeconds: hours === null ? null : Math.round(hours * H),
  });

  it('accepts reported >= legacy and at most max(2 h, 2 %) more', () => {
    const l = legacy(1, 'tom clancys rainbow six siege x', 675.9);
    const key = 'tom clancys rainbow six siege';
    expect(matchLegacyByTotal(key, Math.round(675.9 * H), [l])).toEqual([l]);
    // 2 % of 675.9 h = 13.5 h.
    expect(matchLegacyByTotal(key, Math.round(689 * H), [l])).toEqual([l]);
    expect(matchLegacyByTotal(key, Math.round(690 * H), [l])).toEqual([]);
    expect(matchLegacyByTotal(key, Math.round(675 * H), [l])).toEqual([]);
    // Small games: 2 h floor.
    const small = legacy(2, 'tom clancys rainbow six siege', 10);
    expect(matchLegacyByTotal(key, 12 * H, [small])).toEqual([small]);
    expect(matchLegacyByTotal(key, 12 * H + 1, [small])).toEqual([]);
  });

  it('needs a similar title and a legacy total', () => {
    expect(
      matchLegacyByTotal('bloodborne', 10 * H, [legacy(1, 'astro bot', 10)]),
    ).toEqual([]);
    expect(
      matchLegacyByTotal('bloodborne', 10 * H, [legacy(1, 'bloodborne', null)]),
    ).toEqual([]);
  });

  it('returns every candidate so the caller can refuse an ambiguous match', () => {
    const a = legacy(1, 'god of war', 31);
    const b = legacy(2, 'god of war iii', 31.5);
    expect(matchLegacyByTotal('god of war', 32 * H, [a, b])).toEqual([a, b]);
  });
});
