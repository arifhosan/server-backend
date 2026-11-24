import { Injectable, Logger } from '@nestjs/common';
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

export class PsnPrivacyError extends Error {
  constructor() {
    super(
      'PSN accepted the sign-in but refused to list games. Make sure your PlayStation privacy settings allow your game list ("Gaming history") to be seen.',
    );
    this.name = 'PsnPrivacyError';
  }
}

const fromNpsso = (npsso: string) =>
  exchange(async () =>
    exchangeAccessCodeForAuthTokens(await exchangeNpssoForAccessCode(npsso)),
  );

type PlayedTitle = Awaited<
  ReturnType<typeof getUserPlayedGames>
>['titles'][number];

/** Null for a title without a usable id, name or duration (M6: skipped, not fatal). */
export function toObserved(t: PlayedTitle): ObservedTitle | null {
  const name = typeof t?.name === 'string' ? t.name.trim() : '';
  if (!t?.titleId || typeof t.titleId !== 'string' || !name) return null;
  let totalSeconds: number;
  try {
    totalSeconds = parseIsoDuration(t.playDuration);
  } catch {
    return null;
  }
  return {
    platform: psnPlatform(t.category),
    externalId: t.titleId,
    title: name,
    imageUrl: t.imageUrl || undefined,
    totalSeconds,
    lastPlayedAt: t.lastPlayedDateTime
      ? new Date(t.lastPlayedDateTime)
      : undefined,
  };
}

@Injectable()
export class PsnClient implements PlatformClient {
  private readonly logger = new Logger(PsnClient.name);

  /** One scrubbed log line: no token-looking strings, 200 chars max. */
  private describe(e: unknown): string {
    const cls = e instanceof Error ? e.constructor.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    return `${cls}: ${msg}`
      .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
      .slice(0, 200);
  }

  async connect(
    npsso: string,
  ): Promise<{ secret: PsnSecret; accountId: string; onlineId: string }> {
    const now = Date.now();
    const step = async <T>(
      name: string,
      run: () => Promise<T | undefined>,
    ): Promise<T> => {
      try {
        const r = await run();
        if (!r) throw new Error('empty response');
        return r;
      } catch (e) {
        this.logger.error(`PSN connect failed at ${name}: ${this.describe(e)}`);
        throw new SecretExpiredError(EXPIRED_MSG);
      }
    };
    const code = await step('exchange-code', () =>
      exchangeNpssoForAccessCode(npsso),
    );
    const tokens = await step('exchange-tokens', async () => {
      const t = await exchangeAccessCodeForAuthTokens(code);
      return t?.accessToken && t.refreshToken ? t : undefined;
    });
    const auth = { accessToken: tokens.accessToken };

    try {
      await getUserPlayedGames(auth, 'me', { limit: 1, offset: 0 });
    } catch (e) {
      this.logger.error(
        `PSN connect failed at played-games: ${this.describe(e)}`,
      );
      if (
        /40[13]|forbidden|privacy|permission|not authori[sz]ed|access denied/i.test(
          e instanceof Error ? e.message : '',
        )
      )
        throw new PsnPrivacyError();
      throw new SecretExpiredError(EXPIRED_MSG);
    }

    // Best effort: the sync only needs the tokens.
    let onlineId = 'PlayStation';
    let accountId = 'me';
    try {
      const p = await getProfileFromAccountId(auth, 'me');
      if (p?.onlineId) {
        onlineId = p.onlineId;
        const u = await getProfileFromUserName(auth, p.onlineId);
        if (u?.profile?.accountId) accountId = u.profile.accountId;
      }
    } catch (e) {
      this.logger.warn(`PSN profile lookup failed: ${this.describe(e)}`);
    }
    return {
      secret: buildSecret(
        npsso,
        new Date(now + 60 * DAY_MS).toISOString(),
        tokens,
        now,
      ),
      accountId,
      onlineId,
    };
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
    // `!(x >= y)` so a corrupt (NaN) date forces renewal instead of skipping it.
    if (!(Date.parse(s.refreshExpiresAt) >= now + 3 * DAY_MS)) {
      s = buildSecret(s.npsso, s.npssoExpiresAt, await fromNpsso(s.npsso), now);
      refreshed = true;
    } else if (!(Date.parse(s.accessExpiresAt) >= now + 60_000)) {
      // Only a rejected NPSSO needs the user: if the refresh fails, retry once from it.
      const { npsso, npssoExpiresAt, refreshToken } = s;
      const tokens = await exchange(() =>
        exchangeRefreshTokenForAuthTokens(refreshToken),
      ).catch(() => fromNpsso(npsso));
      s = buildSecret(npsso, npssoExpiresAt, tokens, now);
      refreshed = true;
    }

    const titles: ObservedTitle[] = [];
    let skipped = 0;
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
        for (const t of page.titles) {
          const title = toObserved(t);
          if (title) titles.push(title);
          else skipped++;
        }
      }
    } catch {
      throw new SyncFailedError('PSN played-games request failed.');
    }
    if (skipped) this.logger.warn(`Skipped ${skipped} malformed PSN titles`);

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
