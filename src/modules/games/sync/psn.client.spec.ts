import {
  exchangeAccessCodeForAuthTokens,
  exchangeNpssoForAccessCode,
  exchangeRefreshTokenForAuthTokens,
  getProfileFromAccountId,
  getProfileFromUserName,
  getUserPlayedGames,
} from 'psn-api';
import { Connection } from '../entities/connection.entity';
import { SecretExpiredError, SyncFailedError } from './platform-client';
import {
  parseIsoDuration,
  PsnClient,
  PsnSecret,
  psnPlatform,
  psnStatus,
} from './psn.client';

jest.mock('psn-api');

const mNpsso = jest.mocked(exchangeNpssoForAccessCode);
const mCode = jest.mocked(exchangeAccessCodeForAuthTokens);
const mRefresh = jest.mocked(exchangeRefreshTokenForAuthTokens);
const mPlayed = jest.mocked(getUserPlayedGames);
const mProfile = jest.mocked(getProfileFromAccountId);
const mByName = jest.mocked(getProfileFromUserName);

const DAY = 86_400_000;
const tokens = (access = 'new-access', refresh = 'new-refresh') =>
  ({
    accessToken: access,
    refreshToken: refresh,
    expiresIn: 3600,
    refreshTokenExpiresIn: 864_000,
  }) as never;

function secret(over: Partial<PsnSecret> = {}): string {
  const now = Date.now();
  const s: PsnSecret = {
    npsso: 'NPSSO-VALUE',
    npssoExpiresAt: new Date(now + 40 * DAY).toISOString(),
    accessToken: 'old-access',
    accessExpiresAt: new Date(now + 30 * 60_000).toISOString(),
    refreshToken: 'old-refresh',
    refreshExpiresAt: new Date(now + 9 * DAY).toISOString(),
    ...over,
  };
  return JSON.stringify(s);
}

const title = (i: number) => ({
  titleId: `PPSA${i}_00`,
  name: `Game ${i}`,
  category: 'ps5_native_game',
  imageUrl: 'https://img',
  lastPlayedDateTime: '2026-11-20T10:00:00Z',
  playDuration: 'PT1H',
});

describe('helpers', () => {
  it('parseIsoDuration', () => {
    expect(parseIsoDuration('PT228H56M33S')).toBe(824_193);
    expect(parseIsoDuration('PT45M')).toBe(2_700);
    expect(parseIsoDuration('PT0S')).toBe(0);
    expect(parseIsoDuration('P1DT2H')).toBe(93_600);
    for (const bad of ['', 'P', 'PT', '1H', 'PT-5S', 'garbage'])
      expect(() => parseIsoDuration(bad)).toThrow();
  });
  it('psnPlatform', () => {
    expect(psnPlatform('ps4_game')).toBe('ps4');
    expect(psnPlatform('ps5_native_game')).toBe('ps5');
    expect(psnPlatform('pspc_game')).toBe('ps5');
  });
  it('psnStatus', () => {
    const now = new Date('2026-11-24T00:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(psnStatus(at(15 * DAY), now)).toBe('ok');
    expect(psnStatus(at(13 * DAY), now)).toBe('expiring');
    expect(psnStatus(at(-1000), now)).toBe('expired');
  });
});

describe('PsnClient', () => {
  const client = new PsnClient();
  const conn = {} as Connection;

  beforeEach(() => {
    jest.resetAllMocks();
    mPlayed.mockResolvedValue({
      titles: [title(1)],
      totalItemCount: 1,
    } as never);
  });

  it('connect exchanges the NPSSO and reads the profile', async () => {
    mNpsso.mockResolvedValue('code');
    mCode.mockResolvedValue(tokens());
    mProfile.mockResolvedValue({ onlineId: 'Hakoom' } as never);
    mByName.mockResolvedValue({ profile: { accountId: '123' } } as never);
    const r = await client.connect('NPSSO-VALUE');
    expect(r).toMatchObject({ accountId: '123', onlineId: 'Hakoom' });
    expect(r.secret.npsso).toBe('NPSSO-VALUE');
    expect(r.secret.refreshToken).toBe('new-refresh');
    const days = (Date.parse(r.secret.npssoExpiresAt) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });

  it('re-runs the NPSSO exchange when the refresh token has 2 days left', async () => {
    const old = secret({
      refreshExpiresAt: new Date(Date.now() + 2 * DAY).toISOString(),
    });
    mNpsso.mockResolvedValue('code');
    mCode.mockResolvedValue(tokens());
    const r = await client.fetchTitles(conn, old);
    expect(mNpsso).toHaveBeenCalledWith('NPSSO-VALUE');
    expect(mRefresh).not.toHaveBeenCalled();
    const next = JSON.parse(r.secret!) as PsnSecret;
    const prev = JSON.parse(old) as PsnSecret;
    expect(next.refreshToken).toBe('new-refresh');
    expect(next.accessToken).toBe('new-access');
    expect(next.npsso).toBe(prev.npsso);
    expect(next.npssoExpiresAt).toBe(prev.npssoExpiresAt);
    expect(r.secretExpiresAt).toEqual(new Date(prev.npssoExpiresAt));
    expect(mPlayed).toHaveBeenCalledWith(
      { accessToken: 'new-access' },
      'me',
      expect.anything(),
    );
  });

  it('uses the refresh token when only the access token is stale', async () => {
    mRefresh.mockResolvedValue(tokens('a2', 'r2'));
    const r = await client.fetchTitles(
      conn,
      secret({
        accessExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      }),
    );
    expect(mRefresh).toHaveBeenCalledWith('old-refresh');
    expect(mNpsso).not.toHaveBeenCalled();
    expect((JSON.parse(r.secret!) as PsnSecret).accessToken).toBe('a2');
  });

  it('makes no exchange when tokens are fresh', async () => {
    const r = await client.fetchTitles(conn, secret());
    expect(mNpsso).not.toHaveBeenCalled();
    expect(mRefresh).not.toHaveBeenCalled();
    expect(r.secret).toBeUndefined();
    expect(r.titles).toEqual([
      {
        platform: 'ps5',
        externalId: 'PPSA1_00',
        title: 'Game 1',
        totalSeconds: 3600,
        lastPlayedAt: new Date('2026-11-20T10:00:00Z'),
      },
    ]);
  });

  const expiring = () =>
    secret({ refreshExpiresAt: new Date(Date.now() + DAY).toISOString() });

  it('silent NPSSO refusal (empty accessToken) is SecretExpiredError', async () => {
    mNpsso.mockResolvedValue('code');
    mCode.mockResolvedValue({ accessToken: '' } as never);
    await expect(client.fetchTitles(conn, expiring())).rejects.toThrow(
      SecretExpiredError,
    );
  });

  it('empty refreshToken is SecretExpiredError', async () => {
    mNpsso.mockResolvedValue('code');
    mCode.mockResolvedValue(tokens('a', ''));
    await expect(client.fetchTitles(conn, expiring())).rejects.toThrow(
      SecretExpiredError,
    );
  });

  it('a throwing NPSSO exchange is SecretExpiredError without leaking', async () => {
    mNpsso.mockRejectedValue(new Error('bad NPSSO-VALUE'));
    const err = (await client
      .fetchTitles(conn, expiring())
      .catch((e: unknown) => e as Error)) as Error;
    expect(err).toBeInstanceOf(SecretExpiredError);
    expect(err.message).toBe(
      'PSN sign-in expired. Paste a new NPSSO under Connections in the dashboard.',
    );
  });

  it('a throwing refresh-token exchange is SecretExpiredError', async () => {
    mRefresh.mockRejectedValue(new Error('x'));
    await expect(
      client.fetchTitles(
        conn,
        secret({ accessExpiresAt: new Date(Date.now() - 1).toISOString() }),
      ),
    ).rejects.toThrow(SecretExpiredError);
  });

  it('pages through all titles', async () => {
    mPlayed.mockImplementation(((
      _a: unknown,
      _id: string,
      o: { offset: number },
    ) =>
      Promise.resolve({
        totalItemCount: 250,
        titles: Array.from({ length: o.offset === 0 ? 200 : 50 }, (_, i) =>
          title(o.offset + i),
        ),
      })) as never);
    const r = await client.fetchTitles(conn, secret());
    expect(r.titles).toHaveLength(250);
    expect(mPlayed).toHaveBeenCalledTimes(2);
    expect(mPlayed).toHaveBeenNthCalledWith(1, expect.anything(), 'me', {
      limit: 200,
      offset: 0,
    });
    expect(mPlayed).toHaveBeenNthCalledWith(2, expect.anything(), 'me', {
      limit: 200,
      offset: 200,
    });
  });

  it('wraps psn-api errors in SyncFailedError without tokens', async () => {
    mPlayed.mockRejectedValue(new Error('401 old-access old-refresh'));
    const err = (await client
      .fetchTitles(conn, secret())
      .catch((e: unknown) => e as Error)) as Error;
    expect(err).toBeInstanceOf(SyncFailedError);
    expect(err.message).not.toMatch(/old-access|old-refresh|NPSSO-VALUE/);
  });

  it('unreadable secret is SyncFailedError, missing is SecretExpiredError', async () => {
    await expect(client.fetchTitles(conn, 'nope')).rejects.toThrow(
      SyncFailedError,
    );
    await expect(client.fetchTitles(conn, null)).rejects.toThrow(
      SecretExpiredError,
    );
  });

  it('statusAfter delegates to psnStatus', () => {
    expect(client.statusAfter(new Date(Date.now() - 1000), new Date())).toBe(
      'expired',
    );
  });
});
