import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Device } from '../entities/device.entity';
import { hashDeviceToken } from '../utils/device-token';
import { DeviceAuthGuard } from './device-auth.guard';

describe('DeviceAuthGuard', () => {
  const token = 'gt_sometoken';
  const device = {
    id: 7,
    userId: 3,
    tokenHash: hashDeviceToken(token),
    revokedAt: null,
  } as Device;
  let repo: { findOneBy: jest.Mock; update: jest.Mock };
  let guard: DeviceAuthGuard;

  const ctx = (req: object) =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    repo = {
      findOneBy: jest.fn(({ tokenHash }: Partial<Device>) =>
        Promise.resolve(tokenHash === device.tokenHash ? device : null),
      ),
      update: jest.fn().mockResolvedValue(undefined),
    };
    guard = new DeviceAuthGuard(repo as unknown as Repository<Device>);
  });

  it('rejects a missing header', async () => {
    await expect(
      guard.canActivate(ctx({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown token', async () => {
    const req = { headers: { authorization: 'Bearer gt_nope' } };
    await expect(guard.canActivate(ctx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a revoked device', async () => {
    repo.findOneBy.mockResolvedValueOnce({ ...device, revokedAt: new Date() });
    const req = { headers: { authorization: `Bearer ${token}` } };
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(
      'Device token revoked',
    );
  });

  it('accepts a valid token, sets req.device and touches lastSeenAt', async () => {
    const req: { headers: object; device?: unknown } = {
      headers: { authorization: `Bearer ${token}` },
    };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.device).toEqual({ userId: 3, deviceId: 7 });
    expect(repo.update).toHaveBeenCalledWith(7, {
      lastSeenAt: expect.any(Date) as Date,
    });
  });
});
