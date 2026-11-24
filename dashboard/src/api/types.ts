// Mirrors src/modules/games/{stats/stats.types,connections,devices,tracker}; dates are ISO strings.
export type Platform = 'steam' | 'xbox_pc' | 'epic' | 'pc_other' | 'ps5' | 'ps4';
export type Provider = 'steam' | 'psn';
export type ConnectionStatus = 'ok' | 'expiring' | 'expired' | 'failing' | 'disabled';

/** Fields every game object carries for its artwork (backend Task 12). */
export interface GameArt {
  imageUrl: string | null;
  hasIcon: boolean;
  /** Library row whose icon to show when it is not this object's own (backend 'iconLibraryGameId'). */
  iconLibraryGameId?: number | null;
}

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
}

export interface NowPlaying extends GameArt {
  deviceId: number;
  deviceName: string;
  libraryGameId: number;
  title: string;
  platform: Platform;
  startedAt: string;
}

export interface PublicConnection {
  provider: Provider;
  externalId: string;
  displayName: string;
  status: ConnectionStatus;
  secretExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastGameCount: number | null;
}

export interface PublicDevice {
  id: number;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface DayPoint {
  date: string;
  seconds: number;
  estimated: boolean;
  unknownSources: Provider[];
}

export interface TopGame extends GameArt {
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
    devices: { id: number; name: string; lastSeenAt: string | null }[];
  };
}

export interface SessionRow extends GameArt {
  id: number;
  libraryGameId: number;
  titleKey?: string;
  title: string;
  platform: Platform;
  source: string;
  deviceId: number | null;
  startedAt: string;
  endedAt: string;
  seconds: number;
}

export interface LibraryEntry extends GameArt {
  titleKey: string;
  title: string;
  totalSeconds: number;
  lastPlayedAt: string | null;
  platforms: { platform: Platform; libraryGameId: number; totalSeconds: number }[];
}

export interface GameDetail extends LibraryEntry {
  daily: DayPoint[];
  sessions: SessionRow[];
}

export interface Period {
  days: DayPoint[];
  games: (TopGame & {
    platforms: Platform[];
    sessionCount: number;
    firstPlayedAt: string;
    lastPlayedAt: string;
  })[];
  dayGames: { date: string; titleKey: string; seconds: number }[];
}
