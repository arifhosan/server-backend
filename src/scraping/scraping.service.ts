import { TotalGameTime } from '@/database/entities/totalGameTime.entity';
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ExophaseScrapper } from './sites/exophase.scraper';
import { GameDTO } from './sites/game.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Game } from '@/database/entities/game.entity';
import { generateSlug } from '@/utils/slug.util';
import { Playtime } from '@/database/entities/playtime.entity';

@Injectable()
export class ScrapingService {
  constructor(
    private readonly exophase: ExophaseScrapper,
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
          total.totalMs = Number(total.totalMs) + deltaMs;
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
          console.log(
            `[Cron] Skipped Playtime update — already updated today (${today}).`,
          );
        }
      }

      return scrapedCount;
    } catch (error: any) {
      console.error('Error during scraping:', error);
      return 0;
    }
  }
}
