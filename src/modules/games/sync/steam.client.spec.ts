import { ConfigService } from '@nestjs/config';
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
