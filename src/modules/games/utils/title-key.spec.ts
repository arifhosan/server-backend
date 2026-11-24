import { titleKey } from './title-key';

describe('titleKey', () => {
  it('normalises titles', () => {
    expect(titleKey('Tom Clancy’s Rainbow Six Siege')).toBe(
      'tom clancys rainbow six siege',
    );
    expect(titleKey("DEATH STRANDING DIRECTOR'S CUT")).toBe(
      'death stranding directors cut',
    );
    expect(titleKey('The Witcher 3: Wild Hunt — Remastered')).toBe(
      'the witcher 3 wild hunt remastered',
    );
    expect(titleKey('Pokémon™ Legends')).toBe('pokemon legends');
  });
});
