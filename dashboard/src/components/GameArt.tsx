import '../styles/library.css';
import { useState } from 'react';
import '../styles/overview.css';

const TILES = ['#2a3442', '#26362e', '#382a2a', '#2e2a3a', '#3a2f24', '#2f3329'];

interface Props {
  imageUrl: string | null;
  hasIcon: boolean;
  libraryGameId: number;
  iconLibraryGameId?: number | null;
  title: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

/** "Tom Clancy's Rainbow Six" -> "TC"; one word -> its first two letters; none -> "?". */
export function initials(title: string): string {
  const [first = '?', second] = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  return (second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2)).toUpperCase();
}

/** Cover image, else the game's icon, else an initials tile. A failing image (404) falls through to the next. */
export function GameArt({ imageUrl, hasIcon, libraryGameId, iconLibraryGameId, title, size = 'md' }: Props) {
  const [failed, setFailed] = useState<string[]>([]);
  const icon = hasIcon ? `/api/games/library/${iconLibraryGameId ?? libraryGameId}/icon` : null;
  const src = [imageUrl, icon].find((u): u is string => !!u && !failed.includes(u));
  const cls = `art art-${size}`;
  if (src) return <img className={cls} src={src} alt="" loading="lazy" onError={() => setFailed((f) => [...f, src])} />;
  const hash = [...title].reduce((h, c) => h + c.charCodeAt(0), 0);
  return (
    <span className={`${cls} art-tile`} aria-hidden="true" style={{ background: TILES[hash % TILES.length] }}>
      {initials(title)}
    </span>
  );
}
