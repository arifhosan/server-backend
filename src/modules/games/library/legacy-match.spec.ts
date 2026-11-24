import { titleKey } from '../utils/title-key';
import {
  MatchRow,
  matchLegacy,
  sameNumbers,
  shareSignificantWord,
  similarTitles,
  tolerance,
} from './legacy-match';

const h = (x: number) => Math.round(x * 3600);
let nextId = 1;
const m = (
  title: string,
  hours: number,
  platform: MatchRow['platform'] = 'ps4',
): MatchRow => ({
  id: nextId++,
  platform,
  titleKey: titleKey(title),
  total: h(hours),
});

describe('helpers', () => {
  it('similarTitles: whole-word containment or Jaccard >= 0.5, never on an empty key', () => {
    expect(
      similarTitles(
        'tom clancys rainbow six siege',
        'tom clancys rainbow six siege x',
      ),
    ).toBe(true);
    expect(similarTitles('final fantasy vii', 'final fantasy xvi')).toBe(true); // 2 of 4
    expect(similarTitles('it takes two', 'split fiction')).toBe(false);
    expect(similarTitles('it', 'split fiction')).toBe(false); // part of a word is not containment
    expect(similarTitles('', 'anything')).toBe(false);
  });

  it('sameNumbers: equal numeric token sets when either has one', () => {
    expect(sameNumbers('far cry 6', 'far cry 5')).toBe(false);
    expect(sameNumbers('far cry 6', 'far cry')).toBe(false);
    expect(
      sameNumbers(
        'the witcher 3 wild hunt',
        'the witcher 3 wild hunt remastered',
      ),
    ).toBe(true);
    expect(sameNumbers('rainbow six siege', 'rainbow six siege x')).toBe(true);
    expect(sameNumbers('fifa 23', 'fifa 23 ultimate')).toBe(true);
  });

  it('shareSignificantWord: 3+ letters, not a stop word', () => {
    expect(
      shareSignificantWord(
        'uncharted 4 a thiefs end',
        'uncharted legacy of thieves collection',
      ),
    ).toBe(true);
    expect(shareSignificantWord('the last of us', 'the game of the year')).toBe(
      false,
    );
    expect(shareSignificantWord('god of war', 'of war collection')).toBe(true);
    expect(shareSignificantWord('a b', 'a b')).toBe(false);
  });

  it('tolerance: max(600 s, 1 %)', () => {
    expect(tolerance(h(1))).toBe(600);
    expect(tolerance(h(675.9))).toBeCloseTo(h(675.9) / 100);
  });
});

describe('matchLegacy (production cases, user 2)', () => {
  beforeEach(() => (nextId = 1));
  const fold = (legacy: MatchRow, synced: MatchRow[]) => {
    const r = matchLegacy(legacy, synced);
    return r && { id: r.into.id, rule: r.rule };
  };

  it('Rainbow Six Siege: "Siege X" and "Siege" legacy rows each fold into the same-gen synced row', () => {
    const ppsa = m('Tom Clancy‘s Rainbow Six® Siege', 675.9, 'ps5');
    const cusa = m('Tom Clancy’s Rainbow Six® Siege', 318.9, 'ps4');
    const synced = [ppsa, cusa];
    expect(
      fold(m('Tom Clancy’s Rainbow Six Siege X', 675.9, 'ps5'), synced),
    ).toEqual({ id: ppsa.id, rule: 'R2' });
    expect(
      fold(m('Tom Clancy’s Rainbow Six Siege', 548.4, 'ps5'), synced),
    ).toEqual({ id: ppsa.id, rule: 'R1' });
    expect(
      fold(m('Tom Clancy’s Rainbow Six Siege X', 318.9, 'ps4'), synced),
    ).toEqual({ id: cusa.id, rule: 'R2' });
    expect(
      fold(m('Tom Clancy’s Rainbow Six Siege', 318.9, 'ps4'), synced),
    ).toEqual({ id: cusa.id, rule: 'R1' });
  });

  it('R1 takes the closest total: Cyberpunk 52.0 goes to CUSA18278 (52.0), not PPSA04029 (113.8)', () => {
    const ppsa = m('Cyberpunk 2077', 113.8, 'ps5');
    const cusa = m('Cyberpunk 2077', 52.0, 'ps4');
    expect(fold(m('Cyberpunk 2077', 52.0), [ppsa, cusa])).toEqual({
      id: cusa.id,
      rule: 'R1',
    });
  });

  it('R1 within the tolerance below: Borderlands 3 0.8 h folds into 0.7 h', () => {
    const s = m('Borderlands 3', 0.7);
    expect(fold(m('Borderlands 3', 0.8), [s])).toEqual({
      id: s.id,
      rule: 'R1',
    });
    expect(fold(m('Borderlands 3', 0.9), [s])).toBeUndefined(); // 12 min below > 10 min
  });

  it('R1 ties go to the same platform, then the lowest id', () => {
    const ps5 = m('Rogue Company', 20.4, 'ps5');
    const ps4 = m('Rogue Company', 20.4, 'ps4');
    expect(fold(m('Rogue Company', 20.4, 'ps4'), [ps5, ps4])).toEqual({
      id: ps4.id,
      rule: 'R1',
    });
    expect(fold(m('Rogue Company', 20.4, 'ps5'), [ps5, ps4])).toEqual({
      id: ps5.id,
      rule: 'R1',
    });
  });

  it('R2: The Witcher 3 legacy 90.8 folds into "…— Remastered" 90.8', () => {
    const s = m('The Witcher 3: Wild Hunt — Remastered', 90.8, 'ps5');
    expect(fold(m('The Witcher 3: Wild Hunt', 90.8, 'ps5'), [s])).toEqual({
      id: s.id,
      rule: 'R2',
    });
  });

  it('R2 number rule: Far Cry 6 never folds into Far Cry® 5', () => {
    const s = m('Far Cry® 5', 14.0);
    expect(fold(m('Far Cry 6', 13.1, 'ps5'), [s])).toBeUndefined();
  });

  it('R2: two equally close candidates fold nowhere', () => {
    const a = m('Rainbow Six Siege Deluxe', 101, 'ps5');
    const b = m('Rainbow Six Siege Gold', 101, 'ps4');
    expect(fold(m('Rainbow Six Siege', 100, 'ps5'), [a, b])).toBeUndefined();
  });

  it('R3: equal total and a shared word, numbers may differ (Uncharted 12.8 h)', () => {
    const s = m('UNCHARTED: Legacy of Thieves Collection', 12.8, 'ps5');
    expect(fold(m('Uncharted 4: A Thief’s End', 12.8), [s])).toEqual({
      id: s.id,
      rule: 'R3',
    });
    // Two rows within 60 s: none.
    const t = m('Uncharted: Drake’s Fortune', 12.8);
    expect(fold(m('Uncharted 4: A Thief’s End', 12.8), [s, t])).toBeUndefined();
    // No shared significant word: none.
    expect(fold(m('Bloodborne', 12.8), [s])).toBeUndefined();
  });

  it('R4: Paladins 4.9 h = CUSA05078 4.0 + CUSA04414 0.9, folds into the larger', () => {
    const big = m('Paladins', 4.0);
    const small = m('Paladins', 0.9);
    expect(fold(m('Paladins', 4.9), [small, big])).toEqual({
      id: big.id,
      rule: 'R4',
    });
    expect(fold(m('Paladins', 6.0), [small, big])).toBeUndefined();
  });

  it('Steam: Bitburner legacy 572.0 h folds into appid 1812820 when Steam lists it', () => {
    const s = m('Bitburner', 572.05, 'steam');
    expect(fold(m('Bitburner', 572.0, 'steam'), [s])).toEqual({
      id: s.id,
      rule: 'R1',
    });
    expect(fold(m('Bitburner', 572.0, 'steam'), [])).toBeUndefined();
  });
});
