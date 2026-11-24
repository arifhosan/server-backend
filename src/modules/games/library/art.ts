import { LibraryGame } from '../entities/library-game.entity';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PREFERENCE = ['steam', 'ps5', 'ps4'];

export interface Art {
  imageUrl: string | null;
  hasIcon: boolean;
  /** The platform row that holds the icon (build the icon URL from this), null when none. */
  iconLibraryGameId: number | null;
}

export const MAX_ICON_BYTES = 65_536;

export const steamImageUrl = (appid: string): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

export const isPng = (buf: Buffer): boolean =>
  buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);

const rank = (p: string) => {
  const i = PREFERENCE.indexOf(p);
  return i === -1 ? PREFERENCE.length : i;
};

/** The row a group links to: steam, ps5, ps4, then the rest (lowest id breaks ties). */
export const primaryId = (
  members: Pick<LibraryGame, 'id' | 'platform'>[],
): number =>
  [...members].sort(
    (a, b) => rank(a.platform) - rank(b.platform) || a.id - b.id,
  )[0].id;

/** Art for a group of platform rows: first non-null imageUrl in steam, ps5, ps4, other order. */
export function pickArt(
  members: Pick<LibraryGame, 'id' | 'platform' | 'imageUrl'>[],
  iconIds: Set<number>,
): Art {
  const withImage = members
    .filter((m) => m.imageUrl)
    .sort((a, b) => rank(a.platform) - rank(b.platform))[0];
  const withIcon = members
    .filter((m) => iconIds.has(m.id))
    .sort((a, b) => rank(a.platform) - rank(b.platform) || a.id - b.id)[0];
  return {
    imageUrl: withImage?.imageUrl ?? null,
    hasIcon: !!withIcon,
    iconLibraryGameId: withIcon?.id ?? null,
  };
}
