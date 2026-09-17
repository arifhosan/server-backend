import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheModule } from '@nestjs/cache-manager';
import { HaController } from './modules/ha/ha.controller';
import { DatabaseModule } from './database/database.module';
import { ScrapingModule } from './modules/scraping/scraping.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [CacheModule.register(), DatabaseModule, ScrapingModule, AuthModule],
  controllers: [AppController, HaController],
  providers: [AppService],
})
export class AppModule {}
