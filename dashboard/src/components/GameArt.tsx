import { useState } from 'react';
import '../styles/overview.css';

const TILES = ['#2a3442', '#26362e', '#382a2a', '#2e2a3a', '#3a2f24', '#2f3329'];

interface Props {
  imageUrl: string | null;
  hasIcon: boolean;
  libraryGameId: number;
  title: string;
  size?: 'sm' | 'md' | 'lg';
}

/** Cover image, else the game's icon, else an initials tile. A failed image falls back to the tile. */
export function GameArt({ imageUrl, hasIcon, libraryGameId, title, size = 'md' }: Props) {
  const [failed, setFailed] = useState(false);
  const src = imageUrl ?? (hasIcon ? `/api/games/library/${libraryGameId}/icon` : null);
  const cls = `art art-${size}`;
  if (src && !failed) return <img className={cls} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
  const words = title.split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : title.slice(0, 2)).toUpperCase();
  const hash = [...title].reduce((h, c) => h + c.charCodeAt(0), 0);
  return (
    <span className={`${cls} art-tile`} aria-hidden="true" style={{ background: TILES[hash % TILES.length] }}>
      {initials}
    </span>
  );
}
