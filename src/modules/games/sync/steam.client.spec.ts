import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Connection } from '../entities/connection.entity';
import { SyncFailedError } from './platform-client';
import {
  parseSteamProfileInput,
  SteamClient,
  SteamPrivateProfileError,
} from './steam.client';

jest.mock('axios');
const get = jest.fn();
(axios as unknown as { get: jest.Mock }).get = get;
const conn = { externalId: '76561198000000000' } as Connection;

describe('parseSteamProfileInput', () => {
  it.each([
    ['76561198000000000', { steamId: '76561198000000000' }],
    [
      'https://steamcommunity.com/profiles/76561198000000000/',
      { steamId: '76561198000000000' },
    ],
    ['https://steamcommunity.com/id/arif/', { vanity: 'arif' }],
    ['arif', { vanity: 'arif' }],
  ])('%s', (input, expected) => {
    expect(parseSteamProfileInput(input)).toEqual(expected);
  });
});

describe('SteamClient', () => {
  let client: SteamClient;
  beforeEach(() => {
    get.mockReset();
    client = new SteamClient({
      get: () => 'SECRETKEY',
    } as unknown as ConfigService);
  });

  it('maps owned games', async () => {
    get.mockResolvedValue({
      data: {
        response: {
          games: [
            {
              appid: 1091500,
              name: 'Cyberpunk 2077',
              playtime_forever: 90,
              rtime_last_played: 1795500000,
            },
          ],
        },
      },
    });
    const { titles } = await client.fetchTitles(conn);
    expect(titles).toEqual([
      {
        platform: 'steam',
        externalId: '1091500',
        title: 'Cyberpunk 2077',
        imageUrl:
          'https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/header.jpg',
        totalSeconds: 5400,
        lastPlayedAt: new Date(1795500000 * 1000),
      },
    ]);
  });

  it('asks for played free games and keeps them (Bitburner, appid 1812820, free to play)', async () => {
    get.mockResolvedValue({
      data: {
        response: {
          games: [
            { appid: 1812820, name: 'Bitburner', playtime_forever: 34_322 },
          ],
        },
      },
    });
    const { titles } = await client.fetchTitles(conn);
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('IPlayerService/GetOwnedGames/v1'),
      expect.objectContaining({
        params: expect.objectContaining({
          include_played_free_games: 1,
        }) as unknown,
      }),
    );
    expect(titles).toEqual([
      expect.objectContaining({
        externalId: '1812820',
        title: 'Bitburner',
        totalSeconds: 34_322 * 60,
      }),
    ]);
  });

  it('skips malformed titles, logs only a count, keeps the rest (M6)', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const ok = { appid: 1, name: 'Good', playtime_forever: 2 };
    get.mockResolvedValue({
      data: {
        response: {
          games: [
            ok,
            { appid: 2, name: '  ', playtime_forever: 1 },
            { appid: 3, playtime_forever: 1 },
            { name: 'No id', playtime_forever: 1 },
            { appid: 'x', name: 'Bad id', playtime_forever: 1 },
            { appid: 5, name: 'No time' },
            { appid: 6, name: 'Negative', playtime_forever: -1 },
            { appid: 7, name: 'NaN', playtime_forever: 'abc' },
            null,
          ],
        },
      },
    });
    const { titles } = await client.fetchTitles(conn);
    expect(titles.map((t) => [t.externalId, t.title, t.totalSeconds])).toEqual([
      ['1', 'Good', 120],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Skipped 8 malformed Steam titles');
    warn.mockRestore();
  });

  it('treats an empty response as a private profile', async () => {
    get.mockResolvedValue({ data: { response: {} } });
    await expect(client.fetchTitles(conn)).rejects.toBeInstanceOf(
      SteamPrivateProfileError,
    );
  });

  it('treats game_count 0 as an empty library', async () => {
    get.mockResolvedValue({ data: { response: { game_count: 0 } } });
    await expect(client.fetchTitles(conn)).resolves.toEqual({ titles: [] });
  });

  it('reports HTTP errors without leaking the key', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('failed key=SECRETKEY'), {
        isAxiosError: true,
        response: { status: 503 },
      }),
    );
    const err = await client.fetchTitles(conn).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SyncFailedError);
    expect((err as Error).message).toBe('Steam API error (HTTP 503)');
  });

  it('reports network errors without leaking the key', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('connect SECRETKEY'), { isAxiosError: true }),
    );
    const err = await client.fetchTitles(conn).catch((e: Error) => e);
    expect((err as Error).message).toBe('Steam API unreachable');
  });

  it('fails when the key is missing', async () => {
    client = new SteamClient({
      get: () => undefined,
    } as unknown as ConfigService);
    await expect(client.fetchTitles(conn)).rejects.toThrow(
      'STEAM_API_KEY is not set',
    );
  });

  it('resolves a vanity name and rejects unknown ones', async () => {
    get.mockResolvedValueOnce({
      data: { response: { success: 1, steamid: '76561198000000001' } },
    });
    await expect(client.resolveSteamId('arif')).resolves.toBe(
      '76561198000000001',
    );
    get.mockResolvedValueOnce({ data: { response: { success: 42 } } });
    await expect(client.resolveSteamId('nobody')).rejects.toThrow(
      'Steam profile not found',
    );
  });

  it('returns the profile display name', async () => {
    get.mockResolvedValue({
      data: { response: { players: [{ personaname: 'Arif' }] } },
    });
    await expect(client.profile('76561198000000000')).resolves.toEqual({
      steamId: '76561198000000000',
      displayName: 'Arif',
    });
  });
});
