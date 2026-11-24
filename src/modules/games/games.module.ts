import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceAuthGuard } from './devices/device-auth.guard';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { Connection } from './entities/connection.entity';
import { Device } from './entities/device.entity';
import { LibraryGame } from './entities/library-game.entity';
import { PlaySession } from './entities/play-session.entity';
import { SyncRun } from './entities/sync-run.entity';
import { loadSecretKey } from './utils/secret-box';

export const GAMES_SECRET_KEY = 'GAMES_SECRET_KEY';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Device,
      Connection,
      SyncRun,
      LibraryGame,
      PlaySession,
    ]),
  ],
  controllers: [DevicesController],
  providers: [
    DevicesService,
    DeviceAuthGuard,
    {
      provide: GAMES_SECRET_KEY,
      useFactory: loadSecretKey,
      inject: [ConfigService],
    },
  ],
})
export class GamesModule {}
