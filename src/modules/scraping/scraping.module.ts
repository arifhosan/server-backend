import { Playtime } from './entities/playtime.entity';
import { TotalGameTime } from './entities/total-game-time.entity';
import { Module } from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { ExophaseScraper } from './scrapers/exophase.scraper';
import { SITE_SCRAPER } from './scrapers/site-scraper.interface';
import { ScrapingController } from './scraping.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Game } from './entities/game.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Game, TotalGameTime, Playtime])],
  providers: [
    ScrapingService,
    { provide: SITE_SCRAPER, useClass: ExophaseScraper },
  ],
  controllers: [ScrapingController],
})
export class ScrapingModule {}
