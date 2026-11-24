import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Device } from '../entities/device.entity';
import { DevicesService } from './devices.service';

describe('DevicesService', () => {
  let rows: Device[];
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOneBy: jest.Mock;
  };
  let service: DevicesService;

  beforeEach(() => {
    rows = [];
    repo = {
      create: jest.fn((d: Partial<Device>) => d as Device),
      save: jest.fn((d: Device) => {
        if (!d.id) {
          d.id = rows.length + 1;
          d.createdAt = new Date();
          rows.push(d);
        }
        return Promise.resolve(d);
      }),
      find: jest.fn(() => Promise.resolve(rows)),
      findOneBy: jest.fn(({ id, userId }: Partial<Device>) =>
        Promise.resolve(
          rows.find((r) => r.id === id && r.userId === userId) ?? null,
        ),
      ),
    };
    service = new DevicesService(repo as unknown as Repository<Device>);
  });

  it('create saves the hash, never the token', async () => {
    const { device, token } = await service.create(1, 'Laptop');
    expect(token).toMatch(/^gt_/);
    const saved = (repo.save.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.values(saved)).not.toContain(token);
    expect(saved.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(device).not.toHaveProperty('tokenHash');
    expect(device.tokenPrefix).toBe(token.slice(0, 9));
  });

  it('rename and revoke reject another user', async () => {
    const { device } = await service.create(1, 'Laptop');
    await expect(service.rename(2, device.id, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.revoke(2, device.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rename updates the name', async () => {
    const { device } = await service.create(1, 'Laptop');
    expect((await service.rename(1, device.id, 'Desk')).name).toBe('Desk');
  });

  it('revoking twice keeps the first revokedAt', async () => {
    const { device } = await service.create(1, 'Laptop');
    const first = await service.revoke(1, device.id);
    expect(first.revokedAt).toBeInstanceOf(Date);
    const second = await service.revoke(1, device.id);
    expect(second.revokedAt).toBe(first.revokedAt);
  });
});
