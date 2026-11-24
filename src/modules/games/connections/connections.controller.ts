import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { PsnConnectDto, SteamConnectDto } from '../dto/connection.dto';
import { SyncRun } from '../entities/sync-run.entity';
import { Provider } from '../games.types';
import { ConnectionsService, PublicConnection } from './connections.service';

function provider(p: string): Provider {
  if (p !== 'steam' && p !== 'psn')
    throw new NotFoundException('Connection not found');
  return p;
}

@Controller('games/connections')
@UseGuards(JwtAuthGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<PublicConnection[]> {
    return this.connections.list(user.userId);
  }

  @Put('steam')
  steam(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SteamConnectDto,
  ): Promise<PublicConnection> {
    return this.connections.connectSteam(user.userId, dto.profile);
  }

  @Put('psn')
  psn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PsnConnectDto,
  ): Promise<PublicConnection> {
    return this.connections.connectPsn(user.userId, dto.npsso);
  }

  @Post(':provider/sync')
  sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') p: string,
  ): Promise<SyncRun> {
    return this.connections.syncNow(user.userId, provider(p));
  }

  @Delete(':provider')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') p: string,
  ): Promise<void> {
    return this.connections.remove(user.userId, provider(p));
  }
}
