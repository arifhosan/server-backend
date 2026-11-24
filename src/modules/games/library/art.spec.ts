import { LibraryGame } from '../entities/library-game.entity';
import { isPng, pickArt, steamImageUrl } from './art';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('art', () => {
  it('builds the Steam CDN url', () => {
    expect(steamImageUrl('1091500')).toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/header.jpg',
    );
  });

  it('isPng checks the signature', () => {
    expect(isPng(PNG_1X1)).toBe(true);
    expect(
      isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])),
    ).toBe(false);
    expect(isPng(Buffer.alloc(0))).toBe(false);
  });

  it('pickArt prefers steam, then ps5, then ps4, and ORs icons', () => {
    const g = (id: number, platform: string, imageUrl: string | null) =>
      ({ id, platform, imageUrl }) as LibraryGame;
    const members = [
      g(1, 'ps4', 'ps4.jpg'),
      g(2, 'ps5', 'ps5.jpg'),
      g(3, 'steam', 'steam.jpg'),
      g(4, 'epic', null),
    ];
    expect(pickArt(members, new Set([4]))).toEqual({
      imageUrl: 'steam.jpg',
      hasIcon: true,
      iconLibraryGameId: 4,
    });
    expect(pickArt(members.slice(0, 2), new Set())).toEqual({
      imageUrl: 'ps5.jpg',
      hasIcon: false,
      iconLibraryGameId: null,
    });
    expect(
      pickArt([g(3, 'steam', null), g(1, 'ps4', 'ps4.jpg')], new Set())
        .imageUrl,
    ).toBe('ps4.jpg');
    expect(pickArt([g(4, 'epic', null)], new Set()).imageUrl).toBeNull();
  });

  it('iconLibraryGameId names the member that holds the icon, not the first one (M10)', () => {
    const g = (id: number, platform: string) =>
      ({ id, platform, imageUrl: null }) as LibraryGame;
    // The group links to steam (id 3) but only the epic row has an icon.
    const art = pickArt([g(3, 'steam'), g(9, 'epic')], new Set([9]));
    expect(art).toMatchObject({ hasIcon: true, iconLibraryGameId: 9 });
    // Two icons: preference order, then lowest id.
    expect(
      pickArt([g(8, 'epic'), g(5, 'pc_other'), g(2, 'ps5')], new Set([8, 5]))
        .iconLibraryGameId,
    ).toBe(5);
  });
});
