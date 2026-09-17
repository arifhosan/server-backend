import { Game } from '@/database/entities/game.entity';
import { Controller, Get, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScrapingService } from './scraping.service';

// NOTE: the 'test' prefix is historical and kept so existing callers keep
// working. Rename to 'scraping' once nothing depends on these paths.
@Controller('test')
export class ScrapingController {
  private readonly logger = new Logger(ScrapingController.name);

  constructor(
    private readonly scrapingService: ScrapingService,
    @InjectRepository(Game) private readonly gameRepository: Repository<Game>,
  ) {}

  @Get()
  async scrapeData(): Promise<string> {
    const scrapedCount = await this.scrapingService.scrapeData();
    this.logger.log(`Scrape run stored ${scrapedCount} updated games`);
    return 'Scraping completed';
  }

  @Get('games')
  getGames(): Promise<Game[]> {
    return this.gameRepository.find();
  }
}
