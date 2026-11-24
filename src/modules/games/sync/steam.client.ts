import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Connection } from '../entities/connection.entity';
import {
  ObservedTitle,
  PlatformClient,
  SyncFailedError,
} from './platform-client';

const BASE = 'https://api.steampowered.com';

export class SteamPrivateProfileError extends SyncFailedError {
  constructor() {
    super(
      'Steam game details are private. Set Game details to Public in your Steam privacy settings.',
    );
  }
}

export function parseSteamProfileInput(
  input: string,
): { steamId: string } | { vanity: string } {
  const s = input.trim().replace(/\/+$/, '');
  if (/^\d{17}$/.test(s)) return { steamId: s };
  const m = /\/(profiles|id)\/([^/?#]+)/.exec(s);
  if (m) return m[1] === 'profiles' ? { steamId: m[2] } : { vanity: m[2] };
  return { vanity: s };
}

@Injectable()
export class SteamClient implements PlatformClient {
  constructor(private readonly config: ConfigService) {}

  /** Never put the URL, the axios message or the key into an error: the key is in the query string. */
  private async call<T>(path: string, params: object): Promise<T> {
    const key = this.config.get<string>('STEAM_API_KEY');
    if (!key) throw new SyncFailedError('STEAM_API_KEY is not set');
    try {
      const res = await axios.get<T>(`${BASE}/${path}`, {
        params: { ...params, key },
        timeout: 15_000,
      });
      return res.data;
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      throw new SyncFailedError(
        status ? `Steam API error (HTTP ${status})` : 'Steam API unreachable',
      );
    }
  }

  async resolveSteamId(input: string): Promise<string> {
    const p = parseSteamProfileInput(input);
    if ('steamId' in p) return p.steamId;
    const d = await this.call<{
      response: { success: number; steamid?: string };
    }>('ISteamUser/ResolveVanityURL/v1', { vanityurl: p.vanity });
    if (d.response?.success !== 1 || !d.response.steamid) {
      throw new SyncFailedError('Steam profile not found');
    }
    return d.response.steamid;
  }

  async profile(
    steamId: string,
  ): Promise<{ steamId: string; displayName: string }> {
    const d = await this.call<{
      response: { players?: { personaname?: string }[] };
    }>('ISteamUser/GetPlayerSummaries/v2', { steamids: steamId });
    const player = d.response?.players?.[0];
    if (!player) throw new SyncFailedError('Steam profile not found');
    return { steamId, displayName: player.personaname ?? steamId };
  }

  async fetchTitles(conn: Connection): Promise<{ titles: ObservedTitle[] }> {
    const d = await this.call<{
      response?: {
        game_count?: number;
        games?: {
          appid: number;
          name: string;
          playtime_forever: number;
          rtime_last_played?: number;
        }[];
      };
    }>('IPlayerService/GetOwnedGames/v1', {
      steamid: conn.externalId,
      include_appinfo: 1,
      include_played_free_games: 1,
    });
    // Private "Game details" returns an empty response object; a public empty library has game_count 0.
    const games =
      d.response?.games ?? (d.response?.game_count === 0 ? [] : undefined);
    if (!games) throw new SteamPrivateProfileError();
    return {
      titles: games.map((g) => ({
        platform: 'steam',
        externalId: String(g.appid),
        title: g.name,
        totalSeconds: g.playtime_forever * 60,
        lastPlayedAt: g.rtime_last_played
          ? new Date(g.rtime_last_played * 1000)
          : undefined,
      })),
    };
  }
}
