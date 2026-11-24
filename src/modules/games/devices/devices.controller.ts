import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { DeviceNameDto } from '../dto/device.dto';
import { DevicesService, PublicDevice } from './devices.service';

@Controller('games/devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeviceNameDto,
  ): Promise<{ device: PublicDevice; token: string }> {
    return this.devices.create(user.userId, dto.name);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<PublicDevice[]> {
    return this.devices.list(user.userId);
  }

  @Patch(':id')
  rename(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeviceNameDto,
  ): Promise<PublicDevice> {
    return this.devices.rename(user.userId, id, dto.name);
  }

  @Delete(':id')
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PublicDevice> {
    return this.devices.revoke(user.userId, id);
  }
}
