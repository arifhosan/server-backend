import { GameDTO } from '../dto/game.dto';

export interface SiteScraper {
  scrape(): Promise<GameDTO[]>;
}
