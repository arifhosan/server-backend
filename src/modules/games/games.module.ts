import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceAuthGuard } from './devices/device-auth.guard';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { Connection } from './entities/connection.entity';
import { Device } from './entities/device.entity';
import { LibraryGame } from './entities/library-game.entity';
import { PlaySession } from './entities/play-session.entity';
import { SyncRun } from './entities/sync-run.entity';
import { GAMES_SECRET_KEY, SYNC_CLIENTS } from './games.constants';
import { LegacyImportService } from './legacy/legacy-import.service';
import { LibraryService } from './library/library.service';
import { TrackerController } from './tracker/tracker.controller';
import { TrackerService } from './tracker/tracker.service';
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
      PlaySession,
    ]),
  ],
  controllers: [DevicesController, TrackerController],
  providers: [
    DevicesService,
    DeviceAuthGuard,
    LegacyImportService,
    LibraryService,
    TrackerService,
    SyncService,
    SteamClient,
    {
      provide: SYNC_CLIENTS,
      useFactory: (steam: SteamClient) => ({ steam }),
      inject: [SteamClient],
    },
    {
      provide: GAMES_SECRET_KEY,
      useFactory: loadSecretKey,
      inject: [ConfigService],
    },
  ],
})
export class GamesModule {}
