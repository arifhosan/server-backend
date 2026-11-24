import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Connection } from '../entities/connection.entity';
import { PsnClient, PsnPrivacyError, PsnSecret } from '../sync/psn.client';
import { SyncFailedError } from '../sync/platform-client';
import { SteamClient, SteamPrivateProfileError } from '../sync/steam.client';
import { SyncService } from '../sync/sync.service';
import { openSecret } from '../utils/secret-box';
import { ConnectionsService } from './connections.service';

const KEY = Buffer.alloc(32, 7);
const NPSSO = 'n'.repeat(64);
const secret: PsnSecret = {
  npsso: NPSSO,
  npssoExpiresAt: '2027-01-01T00:00:00.000Z',
  accessToken: 'ACCESS-TOKEN-VALUE',
  accessExpiresAt: '2026-12-01T00:00:00.000Z',
  refreshToken: 'REFRESH-TOKEN-VALUE',
  refreshExpiresAt: '2027-01-01T00:00:00.000Z',
};

describe('ConnectionsService', () => {
  let rows: Connection[];
  let repo: Record<string, jest.Mock>;
  let steam: Record<string, jest.Mock>;
  let psn: { connect: jest.Mock };
  let sync: { syncConnection: jest.Mock };
  let service: ConnectionsService;

  beforeEach(() => {
    rows = [];
    const match = (w: Partial<Connection>) => (r: Connection) =>
      Object.entries(w).every(([k, v]) => r[k as keyof Connection] === v);
    repo = {
      create: jest.fn((d: Partial<Connection>) => d as Connection),
      save: jest.fn((c: Connection) => {
        if (!c.id) {
          c.id = rows.length + 1;
          rows.push(c);
        }
        return Promise.resolve(c);
      }),
      find: jest.fn(({ where }: { where: Partial<Connection> }) =>
        Promise.resolve(rows.filter(match(where))),
      ),
      findOneBy: jest.fn((w: Partial<Connection>) =>
        Promise.resolve(rows.find(match(w)) ?? null),
      ),
      delete: jest.fn((id: number) => {
        rows = rows.filter((r) => r.id !== id);
        return Promise.resolve();
      }),
    };
    steam = {
      resolveSteamId: jest.fn().mockResolvedValue('76561198000000000'),
      profile: jest.fn().mockResolvedValue({ displayName: 'Gabe' }),
      fetchTitles: jest.fn().mockResolvedValue({ titles: [] }),
    };
    psn = {
      connect: jest
        .fn()
        .mockResolvedValue({ secret, accountId: '123', onlineId: 'pilot' }),
    };
    sync = { syncConnection: jest.fn().mockResolvedValue({ id: 1 }) };
    service = new ConnectionsService(
      repo as unknown as Repository<Connection>,
      steam as unknown as SteamClient,
      psn as unknown as PsnClient,
      sync as unknown as SyncService,
      KEY,
    );
  });

  it('no return value leaks the secret, NPSSO or tokens', async () => {
    const out = [
      await service.connectSteam(1, 'gabe'),
      await service.connectPsn(1, NPSSO),
      await service.list(1),
    ];
    const json = JSON.stringify(out);
    for (const bad of ['"secret"', NPSSO, 'ACCESS-TOKEN', 'REFRESH-TOKEN'])
      expect(json).not.toContain(bad);
  });

  it('seals the PSN secret and uses npssoExpiresAt', async () => {
    const out = await service.connectPsn(1, NPSSO);
    expect(out.secretExpiresAt).toEqual(new Date(secret.npssoExpiresAt));
    expect(JSON.parse(openSecret(rows[0].secret as string, KEY))).toEqual(
      secret,
    );
    expect(sync.syncConnection).toHaveBeenCalledWith(rows[0].id);
  });

  it('user A cannot sync or delete user B connection', async () => {
    await service.connectSteam(2, 'gabe');
    await expect(service.syncNow(1, 'steam')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(1, 'steam')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(rows).toHaveLength(1);
  });

  it('private Steam profile is a 400 and nothing is saved', async () => {
    steam.fetchTitles.mockRejectedValue(new SteamPrivateProfileError());
    const err: unknown = await service
      .connectSteam(1, 'gabe')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(new SteamPrivateProfileError().message);
    expect(repo.save).not.toHaveBeenCalled();
    expect(sync.syncConnection).not.toHaveBeenCalled();
  });

  it('every Steam connect failure is a 400 with its fixed text (M2)', async () => {
    const cases: [jest.Mock, string][] = [
      [steam.resolveSteamId, 'Steam profile not found'],
      [steam.profile, 'Steam profile not found'],
      [steam.fetchTitles, 'Steam API error (HTTP 500)'],
      [steam.resolveSteamId, 'Steam API unreachable'],
    ];
    for (const [fn, text] of cases) {
      fn.mockRejectedValueOnce(new SyncFailedError(text));
      const err: unknown = await service
        .connectSteam(1, 'gabe')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toBe(text);
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('an unexpected Steam connect error is not turned into a 400', async () => {
    steam.profile.mockRejectedValueOnce(new Error('internal'));
    const err: unknown = await service
      .connectSteam(1, 'gabe')
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BadRequestException);
  });

  it('a rejected NPSSO is a 400 with the fixed text', async () => {
    psn.connect.mockRejectedValue(new Error('boom'));
    await expect(service.connectPsn(1, NPSSO)).rejects.toThrow(
      'PSN rejected this token. Copy a fresh one and try again.',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('a privacy refusal is a 400 with the privacy text', async () => {
    psn.connect.mockRejectedValue(new PsnPrivacyError());
    await expect(service.connectPsn(1, NPSSO)).rejects.toThrow(
      'Gaming history',
    );
  });

  it('reconnecting PSN replaces the secret and resets status to ok', async () => {
    await service.connectPsn(1, NPSSO);
    const old = rows[0].secret;
    Object.assign(rows[0], { status: 'expired', lastError: 'expired' });
    psn.connect.mockResolvedValue({
      secret: { ...secret, accessToken: 'NEW' },
      accountId: '123',
      onlineId: 'pilot',
    });
    const out = await service.connectPsn(1, NPSSO);
    expect(rows).toHaveLength(1);
    expect(rows[0].secret).not.toBe(old);
    expect(out.status).toBe('ok');
    expect(out.lastError).toBeNull();
  });

  it('a failing initial sync does not fail the request', async () => {
    sync.syncConnection.mockRejectedValue(new Error('x'));
    await expect(service.connectSteam(1, 'gabe')).resolves.toBeDefined();
  });

  it('the initial sync is fire-and-forget: a never-finishing sync does not block', async () => {
    sync.syncConnection.mockReturnValue(new Promise(() => undefined));
    await expect(service.connectSteam(1, 'gabe')).resolves.toBeDefined();
    await expect(service.connectPsn(1, NPSSO)).resolves.toBeDefined();
  });

  it("list returns only the caller's connections", async () => {
    await service.connectSteam(1, 'gabe');
    expect(await service.list(2)).toEqual([]);
    expect(await service.list(1)).toHaveLength(1);
  });
});
