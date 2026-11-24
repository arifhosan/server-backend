import { Injectable } from '@nestjs/common';
import {
  AuthTokensResponse,
  exchangeAccessCodeForAuthTokens,
  exchangeNpssoForAccessCode,
  exchangeRefreshTokenForAuthTokens,
  getProfileFromAccountId,
  getProfileFromUserName,
  getUserPlayedGames,
} from 'psn-api';
import { Connection } from '../entities/connection.entity';
import { ConnectionStatus, Platform } from '../games.types';
import {
  ObservedTitle,
  PlatformClient,
  SecretExpiredError,
  SyncFailedError,
} from './platform-client';

export interface PsnSecret {
  npsso: string;
  npssoExpiresAt: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

const DAY_MS = 86_400_000;
const PAGE = 200;
const EXPIRED_MSG =
  'PSN sign-in expired. Paste a new NPSSO under Connections in the dashboard.';

const DURATION =
  /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** ISO-8601 duration (days to seconds) to whole seconds. */
export function parseIsoDuration(value: string): number {
  const m = DURATION.exec(value);
  if (!m || value === 'P' || value.endsWith('T'))
    throw new Error('Invalid duration');
  const [, d, h, min, s] = m;
  return Math.floor(
    Number(d ?? 0) * 86_400 +
      Number(h ?? 0) * 3_600 +
      Number(min ?? 0) * 60 +
      Number(s ?? 0),
  );
}

export function psnPlatform(category: string): Platform {
  return category === 'ps4_game' ? 'ps4' : 'ps5';
}

export function psnStatus(refreshExpiresAt: Date, now: Date): ConnectionStatus {
  const left = refreshExpiresAt.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  return left < 14 * DAY_MS ? 'expiring' : 'ok';
}

function buildSecret(
  npsso: string,
  npssoExpiresAt: string,
  t: AuthTokensResponse,
  now: number,
): PsnSecret {
  return {
    npsso,
    npssoExpiresAt,
    accessToken: t.accessToken,
    accessExpiresAt: new Date(now + t.expiresIn * 1000).toISOString(),
    refreshToken: t.refreshToken,
    refreshExpiresAt: new Date(
      now + t.refreshTokenExpiresIn * 1000,
    ).toISOString(),
  };
}

/** Any throw, or a silent refusal (empty tokens), means the user must sign in again. */
async function exchange(
  run: () => Promise<AuthTokensResponse>,
): Promise<AuthTokensResponse> {
  let t: AuthTokensResponse;
  try {
    t = await run();
  } catch {
    throw new SecretExpiredError(EXPIRED_MSG);
  }
  if (!t?.accessToken || !t.refreshToken)
    throw new SecretExpiredError(EXPIRED_MSG);
  return t;
}

const fromNpsso = (npsso: string) =>
  exchange(async () =>
    exchangeAccessCodeForAuthTokens(await exchangeNpssoForAccessCode(npsso)),
  );

@Injectable()
export class PsnClient implements PlatformClient {
  async connect(
    npsso: string,
  ): Promise<{ secret: PsnSecret; accountId: string; onlineId: string }> {
    const now = Date.now();
    const tokens = await fromNpsso(npsso);
    const secret = buildSecret(
      npsso,
      new Date(now + 60 * DAY_MS).toISOString(),
      tokens,
      now,
    );
    try {
      const auth = { accessToken: tokens.accessToken };
      const { onlineId } = await getProfileFromAccountId(auth, 'me');
      const { profile } = await getProfileFromUserName(auth, onlineId);
      return { secret, accountId: profile.accountId, onlineId };
    } catch {
      throw new SyncFailedError('Could not read the PSN profile.');
    }
  }

  async fetchTitles(
    _conn: Connection,
    sealed: string | null,
  ): Promise<{
    titles: ObservedTitle[];
    secret?: string;
    secretExpiresAt?: Date;
  }> {
    if (!sealed) throw new SecretExpiredError(EXPIRED_MSG);
    let s: PsnSecret;
    try {
      s = JSON.parse(sealed) as PsnSecret;
      if (!s.npsso || !s.accessToken || !s.refreshToken) throw new Error();
    } catch {
      throw new SyncFailedError('Stored PSN secret is unreadable.');
    }

    const now = Date.now();
    let refreshed = false;
    if (Date.parse(s.refreshExpiresAt) < now + 3 * DAY_MS) {
      s = buildSecret(s.npsso, s.npssoExpiresAt, await fromNpsso(s.npsso), now);
      refreshed = true;
    } else if (Date.parse(s.accessExpiresAt) < now + 60_000) {
      s = buildSecret(
        s.npsso,
        s.npssoExpiresAt,
        await exchange(() => exchangeRefreshTokenForAuthTokens(s.refreshToken)),
        now,
      );
      refreshed = true;
    }

    const titles: ObservedTitle[] = [];
    try {
      const auth = { accessToken: s.accessToken };
      let total = Infinity;
      for (let offset = 0; offset < total; offset += PAGE) {
        const page = await getUserPlayedGames(auth, 'me', {
          limit: PAGE,
          offset,
        });
        total = page.totalItemCount;
        if (!page.titles.length) break;
        for (const t of page.titles)
          titles.push({
            platform: psnPlatform(t.category),
            externalId: t.titleId,
            title: t.name,
            totalSeconds: parseIsoDuration(t.playDuration),
            lastPlayedAt: t.lastPlayedDateTime
              ? new Date(t.lastPlayedDateTime)
              : undefined,
          });
      }
    } catch {
      throw new SyncFailedError('PSN played-games request failed.');
    }

    return refreshed
      ? {
          titles,
          secret: JSON.stringify(s),
          secretExpiresAt: new Date(s.npssoExpiresAt),
        }
      : { titles };
  }

  statusAfter(secretExpiresAt: Date | null, now: Date): ConnectionStatus {
    return secretExpiresAt ? psnStatus(secretExpiresAt, now) : 'expired';
  }
}
