import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { DeviceAuthGuard, DeviceContext } from '../devices/device-auth.guard';
import { HeartbeatsDto } from '../dto/heartbeats.dto';
import { NowPlaying, TrackerService, TrackerStatus } from './tracker.service';

type DeviceRequest = Request & { device: DeviceContext };

@Controller('games')
export class TrackerController {
  constructor(private readonly tracker: TrackerService) {}

  @Get('tracker/status')
  @UseGuards(DeviceAuthGuard)
  status(@Req() req: DeviceRequest): Promise<TrackerStatus> {
    return this.tracker.status(req.device.userId);
  }

  @Post('tracker/heartbeats')
  @UseGuards(DeviceAuthGuard)
  heartbeats(
    @Req() req: DeviceRequest,
    @Body() dto: HeartbeatsDto,
  ): Promise<{ accepted: number; rejected: number }> {
    return this.tracker.ingest(req.device, dto.heartbeats);
  }

  @Get('now')
  @UseGuards(JwtAuthGuard)
  now(@CurrentUser() user: AuthenticatedUser): Promise<NowPlaying[]> {
    return this.tracker.nowPlaying(user.userId);
  }
}
