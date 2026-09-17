import { Playtime } from '@/database/entities/playtime.entity';
import { TotalGameTime } from '@/database/entities/total-game-time.entity';
import { Module } from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { ScheduleModule } from '@nestjs/schedule';
import { ExophaseScraper } from './scrapers/exophase.scraper';
import { SITE_SCRAPER } from './scrapers/site-scraper.interface';
import { ScrapingController } from './scraping.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Game } from '@/database/entities/game.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Game, TotalGameTime, Playtime]),
  ],
  providers: [
    ScrapingService,
    { provide: SITE_SCRAPER, useClass: ExophaseScraper },
  ],
  controllers: [ScrapingController],
})
export class ScrapingModule {}
