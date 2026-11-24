import { useState } from 'react';
import '../styles/library.css';

export interface GameArtProps {
  imageUrl: string | null;
  hasIcon: boolean;
  libraryGameId: number;
  title: string;
  /** sm = 64x30 table thumbnail, lg = 368 wide hero. */
  size?: 'sm' | 'lg';
}

const initials = (title: string) =>
  (title.match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

/** Stable dark tint per title so tiles are tellable apart. */
const tint = (title: string) => {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 18% 20%)`;
};

/** imageUrl, else the stored icon, else an initials tile; a broken image falls back to the tile. */
export function GameArt({ imageUrl, hasIcon, libraryGameId, title, size = 'sm' }: GameArtProps) {
  const src = imageUrl ?? (hasIcon ? `/api/games/library/${libraryGameId}/icon` : null);
  const [failed, setFailed] = useState<string | null>(null);
  const showImg = src !== null && failed !== src;
  return (
    <span className={`art art-${size}`} style={showImg ? undefined : { background: tint(title) }} aria-hidden="true">
      {showImg ? <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} /> : initials(title)}
    </span>
  );
}
