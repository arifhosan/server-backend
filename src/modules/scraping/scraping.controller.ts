import { Controller, Get } from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Game } from '@/database/entities/game.entity';

@Controller('test')
export class ScrapingController {
  constructor(
    private readonly scrapingService: ScrapingService,
    @InjectRepository(Game) private readonly gameRepository: Repository<Game>,
  ) {}
  @Get()
  async scrapeData(): Promise<string> {
    const games = await this.scrapingService.scrapeData();
    console.log(games);
    return 'Scraping completed';
  }

  @Get('games')
  async getGames(): Promise<Game[]> {
    const games = await this.gameRepository.find();
    return games;
  }
}
