import { EntityManager } from 'typeorm';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { titleKey } from '../utils/title-key';
import {
  StoreItem,
  artKey,
  fillMissingArt,
  pickStoreMatch,
} from './art-lookup';

const item = (id: number, name: string): StoreItem => ({ id, name });

describe('artKey', () => {
  it('strips store suffixes', () => {
    expect(artKey('Yakuza 0 for Windows 10')).toBe('yakuza 0');
    expect(artKey('Forza Horizon 5 Windows 10')).toBe('forza horizon 5');
    expect(artKey('Avowed PC')).toBe('avowed');
    expect(artKey('The Outer Worlds 2 Xbox Series X|S')).toBe(
      'the outer worlds 2',
    );
    expect(artKey('PC Building Simulator')).toBe('pc building simulator');
  });
});

describe('pickStoreMatch', () => {
  it('exact titleKey, apostrophes and ™ included', () => {
    expect(
      pickStoreMatch("Baldur's Gate 3", [
        item(1, 'Baldur’s Gate 3 Soundtrack Edition'),
        item(1086940, 'Baldur’s Gate 3'),
      ]),
    ).toBe(1086940);
  });

  it('after stripping a platform suffix', () => {
    expect(
      pickStoreMatch('Yakuza 0 for Windows 10', [item(638970, 'Yakuza 0')]),
    ).toBe(638970);
  });

  it('rejects another number: Far Cry 5 for Far Cry 6', () => {
    expect(
      pickStoreMatch('Far Cry 6', [item(552520, 'Far Cry® 5')]),
    ).toBeUndefined();
    expect(
      pickStoreMatch('Far Cry 6', [
        item(552520, 'Far Cry® 5'),
        item(2369390, 'Far Cry® 6'),
      ]),
    ).toBe(2369390);
  });

  it('rejects a loose match, accepts a close one', () => {
    // 2 of 4 words: Jaccard 0.5.
    expect(
      pickStoreMatch("Assassin's Creed Valhalla", [
        item(1, "Assassin's Creed Mirage"),
      ]),
    ).toBeUndefined();
    expect(
      pickStoreMatch('Crimson Desert', [item(2, 'Black Desert')]),
    ).toBeUndefined();
    // 4 of 5 words: Jaccard 0.8.
    expect(
      pickStoreMatch('A Plague Tale Requiem', [
        item(1182900, 'A Plague Tale: Requiem Deluxe'),
      ]),
    ).toBe(1182900);
  });

  it('nothing for an empty key', () => {
    expect(pickStoreMatch('原神', [item(1, '原神')])).toBeUndefined();
  });
});

describe('fillMissingArt', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  let rows: Partial<LibraryGame>[];
  let icons: Partial<GameIcon>[];
  const row = (id: number, title: string, o: Partial<LibraryGame> = {}) =>
    rows.push({
      id,
      userId: 2,
      platform: 'xbox_pc',
      title,
      titleKey: titleKey(title),
      imageUrl: null,
      artCheckedAt: null,
      ...o,
    });
  const manager = () =>
    ({
      getRepository: (e: unknown) =>
        e === GameIcon
          ? { find: () => Promise.resolve(icons) }
          : {
              find: () => Promise.resolve(rows),
              update: (id: number, p: Partial<LibraryGame>) => {
                Object.assign(
                  rows.find((r) => r.id === id)!,
                  p,
                );
                return Promise.resolve();
              },
            },
    }) as unknown as EntityManager;

  beforeEach(() => {
    rows = [];
    icons = [];
  });

  it('fills a hit, stamps a miss, skips groups with art and fresh misses', async () => {
    row(1, 'Yakuza 0 for Windows 10');
    row(2, 'Unknown Indie');
    row(3, 'Forza Horizon 5', { platform: 'xbox_pc' });
    row(4, 'Forza Horizon 5', {
      platform: 'steam',
      imageUrl: 'https://fh5.jpg',
    });
    row(5, 'Has Icon');
    icons.push({ libraryGameId: 5 });
    row(6, 'Checked Recently', {
      artCheckedAt: new Date('2026-11-10T00:00:00Z'),
    });
    row(7, 'Checked Long Ago', {
      artCheckedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const search = jest.fn((term: string) =>
      Promise.resolve(term === 'yakuza 0' ? [item(638970, 'Yakuza 0')] : []),
    );
    expect(await fillMissingArt(manager(), now, search)).toBe(1);
    expect(search.mock.calls.map((c) => c[0])).toEqual([
      'yakuza 0',
      'unknown indie',
      'checked long ago',
    ]);
    expect(rows[0]).toMatchObject({
      imageUrl:
        'https://cdn.cloudflare.steamstatic.com/steam/apps/638970/header.jpg',
      artCheckedAt: now,
    });
    expect(rows[1]).toMatchObject({ imageUrl: null, artCheckedAt: now });
    expect(rows[6].artCheckedAt).toEqual(now);
  });

  it('at most 20 lookups per run; a failed request is not stamped', async () => {
    for (let i = 1; i <= 25; i++) row(i, `Game ${i}`);
    const search = jest.fn((term: string) =>
      term === 'game 1'
        ? Promise.reject(new Error('down'))
        : Promise.resolve([]),
    );
    await fillMissingArt(manager(), now, search);
    expect(search).toHaveBeenCalledTimes(20);
    expect(rows[0].artCheckedAt).toBeNull();
    expect(rows[1].artCheckedAt).toEqual(now);
    expect(rows[24].artCheckedAt).toBeNull();
  });
});
