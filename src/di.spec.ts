import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthController } from './modules/auth/auth.controller';
import { User } from './modules/auth/entities/user.entity';
import { AuthModule } from './modules/auth/auth.module';
import { ConnectionsController } from './modules/games/connections/connections.controller';
import { DevicesController } from './modules/games/devices/devices.controller';
import { Connection } from './modules/games/entities/connection.entity';
import { Device } from './modules/games/entities/device.entity';
import { GameIcon } from './modules/games/entities/game-icon.entity';
import { LibraryGame } from './modules/games/entities/library-game.entity';
import { PlaySession } from './modules/games/entities/play-session.entity';
import { SyncRun } from './modules/games/entities/sync-run.entity';
import { GamesModule } from './modules/games/games.module';
import { StatsController } from './modules/games/stats/stats.controller';
import { TrackerController } from './modules/games/tracker/tracker.controller';

// No database: DataSource is a stub.
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: {} }],
  exports: [DataSource],
})
class StubDbModule {}

// Regression: boot crashed with "Nest can't resolve dependencies of the
// JwtAuthGuard (?)" because PassportModule (AuthModuleOptions) was not imported.
describe('AuthModule + GamesModule DI graph', () => {
  it('compiles and resolves every guarded controller', async () => {
    let builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: 'x',
              GAMES_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
              STEAM_API_KEY: 'x',
            }),
          ],
        }),
        StubDbModule,
        AuthModule,
        GamesModule,
      ],
    });
    for (const entity of [
      User,
      Device,
      Connection,
      SyncRun,
      LibraryGame,
      GameIcon,
      PlaySession,
    ]) {
      builder = builder
        .overrideProvider(getRepositoryToken(entity))
        .useValue({});
    }
    const mod = await builder.compile();
    for (const c of [
      AuthController,
      DevicesController,
      TrackerController,
      ConnectionsController,
      StatsController,
    ]) {
      expect(mod.get(c)).toBeDefined();
    }
    await mod.close();
  });
});
