import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '../entities/device.entity';
import { generateDeviceToken } from '../utils/device-token';

export interface PublicDevice {
  id: number;
  name: string;
  tokenPrefix: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

const toPublic = (d: Device): PublicDevice => ({
  id: d.id,
  name: d.name,
  tokenPrefix: d.tokenPrefix,
  createdAt: d.createdAt,
  lastSeenAt: d.lastSeenAt,
  revokedAt: d.revokedAt,
});

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device) private readonly repo: Repository<Device>,
  ) {}

  async create(
    userId: number,
    name: string,
  ): Promise<{ device: PublicDevice; token: string }> {
    const { token, hash, prefix } = generateDeviceToken();
    const device = await this.repo.save(
      this.repo.create({
        userId,
        name,
        tokenHash: hash,
        tokenPrefix: prefix,
        lastSeenAt: null,
        revokedAt: null,
      }),
    );
    return { device: toPublic(device), token };
  }

  async list(userId: number): Promise<PublicDevice[]> {
    const devices = await this.repo.find({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return devices.map(toPublic);
  }

  async rename(
    userId: number,
    id: number,
    name: string,
  ): Promise<PublicDevice> {
    const device = await this.owned(userId, id);
    device.name = name;
    return toPublic(await this.repo.save(device));
  }

  async revoke(userId: number, id: number): Promise<PublicDevice> {
    const device = await this.owned(userId, id);
    if (!device.revokedAt) {
      device.revokedAt = new Date();
      await this.repo.save(device);
    }
    return toPublic(device);
  }

  private async owned(userId: number, id: number): Promise<Device> {
    const device = await this.repo.findOneBy({ id, userId });
    if (!device) throw new NotFoundException('Device not found');
    return device;
  }
}
