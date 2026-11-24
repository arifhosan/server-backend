import { PublicConnection } from '../connections/connections.service';
import { Platform, Provider } from '../games.types';
import { Art } from '../library/art';
import { NowPlaying } from '../tracker/tracker.service';

export interface DayPoint {
  date: string;
  seconds: number;
  estimated: boolean;
  unknownSources: Provider[];
}

/** titleKey is the group key: the real titleKey, or `#<libraryGameId>` when a title has none (Ruling R8). */
export interface TopGame extends Art {
  libraryGameId: number;
  titleKey: string;
  title: string;
  seconds: number;
}

export interface Overview {
  nowPlaying: NowPlaying[];
  today: number;
  thisWeek: number;
  lastWeek: number;
  last30Days: DayPoint[];
  topGames30d: TopGame[];
  health: {
    connections: PublicConnection[];
    devices: { id: number; name: string; lastSeenAt: Date | null }[];
  };
}

export interface SessionRow extends Art {
  id: number;
  libraryGameId: number;
  title: string;
  platform: Platform;
  source: string;
  deviceId: number | null;
  startedAt: Date;
  endedAt: Date;
  seconds: number;
}

export interface LibraryEntry extends Art {
  titleKey: string;
  title: string;
  totalSeconds: number;
  lastPlayedAt: Date | null;
  platforms: {
    platform: Platform;
    libraryGameId: number;
    totalSeconds: number;
  }[];
}

export interface GameDetail extends LibraryEntry {
  /** Sparse: only days with play, oldest first (the client fills gaps); chart sources only, unknownSources always []. */
  daily: DayPoint[];
  /** Last 100, newest first; import and legacy_test sessions are excluded, like the charts. */
  sessions: SessionRow[];
}

export interface Period {
  days: DayPoint[];
  games: (TopGame & {
    platforms: Platform[];
    sessionCount: number;
    firstPlayedAt: Date;
    lastPlayedAt: Date;
  })[];
  dayGames: { date: string; titleKey: string; seconds: number }[];
}
