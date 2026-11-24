import { Link } from 'react-router';
import type { TopGame } from '../api/types';
import { formatDuration } from '../lib/format';
import { Card } from './Card';
import { GameArt } from './GameArt';
import '../styles/overview.css';

export function TopGames({ games }: { games: TopGame[] }) {
  const max = Math.max(1, ...games.map((g) => g.seconds));
  return (
    <Card label="Top games">
      <div className="card-head">
        <h2>Top games · last 30 days</h2>
        <Link to="/library" className="strong">
          Open library
        </Link>
      </div>
      {games.length === 0 ? (
        <p className="muted">No games played in the last 30 days.</p>
      ) : (
        <ol className="top">
          {games.map((g, i) => (
            <li key={g.titleKey}>
              <span className="top-rank">{i + 1}</span>
              <GameArt imageUrl={g.imageUrl} hasIcon={g.hasIcon} iconLibraryGameId={g.iconLibraryGameId} libraryGameId={g.libraryGameId} title={g.title} />
              <Link className="top-title" to={`/games/${g.libraryGameId}`}>
                {g.title}
              </Link>
              <span className="top-bar" aria-hidden="true">
                <span style={{ width: `${Math.round((g.seconds / max) * 100)}%` }} />
              </span>
              <span className="top-time">{formatDuration(g.seconds)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
