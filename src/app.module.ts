import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheModule } from '@nestjs/cache-manager';
import { HaController } from './modules/ha/ha.controller';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { RadioModule } from './modules/radio/radio.module';
import { VoiceModule } from './modules/voice/voice.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { GamesModule } from './modules/games/games.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CacheModule.register(),
    DatabaseModule,
    AuthModule,
    RadioModule,
    VoiceModule,
    TokensModule,
    GamesModule,
  ],
  controllers: [AppController, HaController],
  providers: [AppService],
})
export class AppModule {}
