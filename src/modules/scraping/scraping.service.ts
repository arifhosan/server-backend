import { TotalGameTime } from './entities/total-game-time.entity';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SITE_SCRAPER, SiteScraper } from './scrapers/site-scraper.interface';
import { GameDTO } from './dto/game.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Game } from './entities/game.entity';
import { generateSlug } from './utils/slug.util';
import { Playtime } from './entities/playtime.entity';
import { errorStack } from '@/common/utils/error.util';

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);

  constructor(
    @Inject(SITE_SCRAPER) private readonly exophase: SiteScraper,
    @InjectRepository(Game) private readonly gameRepository: Repository<Game>,
    @InjectRepository(TotalGameTime)
    private readonly totalGameTimeRepository: Repository<TotalGameTime>,
    @InjectRepository(Playtime)
    private readonly playtimeRepository: Repository<Playtime>,
  ) {}

  @Cron('0 0 23 * * *') // Runs daily at 23:00 (11:00 PM)
  async scrapeData(): Promise<number> {
    try {
      let scrapedCount = 0;
      const today = new Date().toISOString().split('T')[0];
      let dailyTotalDelta: number = 0;

      const games: GameDTO[] = await this.exophase.scrape();

      for (const game of games) {
        const slug = generateSlug(game.title + game.platform);
        const total = await this.totalGameTimeRepository.findOneBy({ slug });
        const previousPlaytime: number = total?.totalMs ?? 0;
        const deltaMs: number = game.playtimeMs - previousPlaytime;

        if (deltaMs <= 0) continue;

        await this.gameRepository.save({
          slug,
          title: game.title,
          platform: game.platform,
          playtimeMs: deltaMs,
        });

        if (total) {
          total.totalMs = total.totalMs + deltaMs;
          await this.totalGameTimeRepository.save(total);
        } else {
          await this.totalGameTimeRepository.save({
            slug,
            title: game.title,
            platform: game.platform,
            totalMs: game.playtimeMs,
          });
        }

        dailyTotalDelta += deltaMs;
        scrapedCount++;
      }

      if (dailyTotalDelta > 0) {
        const existing = await this.playtimeRepository.findOneBy({
          date: today,
        });

        if (!existing) {
          await this.playtimeRepository.save({
            date: today,
            totalMs: dailyTotalDelta,
          });
        } else if (existing.updatedAt.toISOString().split('T')[0] !== today) {
          existing.totalMs += dailyTotalDelta;
          await this.playtimeRepository.save(existing);
        } else {
          this.logger.log(
            `Skipped playtime update, already recorded today (${today}).`,
          );
        }
      }

      return scrapedCount;
    } catch (error: unknown) {
      this.logger.error('Scrape run failed', errorStack(error));
      return 0;
    }
  }
}
