import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { Device } from '../entities/device.entity';
import { hashDeviceToken } from '../utils/device-token';

export interface DeviceContext {
  userId: number;
  deviceId: number;
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    @InjectRepository(Device) private readonly repo: Repository<Device>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { device?: DeviceContext }>();
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException('Missing device token');

    const device = await this.repo.findOneBy({
      tokenHash: hashDeviceToken(match[1]),
    });
    if (!device) throw new UnauthorizedException('Invalid device token');
    if (device.revokedAt)
      throw new UnauthorizedException('Device token revoked');

    await this.repo.update(device.id, { lastSeenAt: new Date() });
    req.device = { userId: device.userId, deviceId: device.id };
    return true;
  }
}
