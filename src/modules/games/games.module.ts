import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsController } from './connections/connections.controller';
import { ConnectionsService } from './connections/connections.service';
import { DeviceAuthGuard } from './devices/device-auth.guard';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { Connection } from './entities/connection.entity';
import { Device } from './entities/device.entity';
import { GameIcon } from './entities/game-icon.entity';
import { LibraryGame } from './entities/library-game.entity';
import { PlaySession } from './entities/play-session.entity';
import { SyncRun } from './entities/sync-run.entity';
import { GAMES_SECRET_KEY, SYNC_CLIENTS } from './games.constants';
import { LegacyImportService } from './legacy/legacy-import.service';
import { LibraryService } from './library/library.service';
import { StatsController } from './stats/stats.controller';
import { StatsService } from './stats/stats.service';
import { TrackerController } from './tracker/tracker.controller';
import { TrackerService } from './tracker/tracker.service';
import { PsnClient } from './sync/psn.client';
import { SteamClient } from './sync/steam.client';
import { SyncService } from './sync/sync.service';
import { loadSecretKey } from './utils/secret-box';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      Device,
      Connection,
      SyncRun,
      LibraryGame,
      GameIcon,
      PlaySession,
    ]),
  ],
  controllers: [
    DevicesController,
    TrackerController,
    ConnectionsController,
    StatsController,
  ],
  providers: [
    DevicesService,
    ConnectionsService,
    DeviceAuthGuard,
    LegacyImportService,
    LibraryService,
    TrackerService,
    StatsService,
    SyncService,
    SteamClient,
    PsnClient,
    {
      provide: SYNC_CLIENTS,
      useFactory: (steam: SteamClient, psn: PsnClient) => ({ steam, psn }),
      inject: [SteamClient, PsnClient],
    },
    {
      provide: GAMES_SECRET_KEY,
      useFactory: loadSecretKey,
      inject: [ConfigService],
    },
  ],
})
export class GamesModule {}
