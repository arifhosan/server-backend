import { GameDTO } from '../dto/game.dto';

/**
 * DI token for the active scraper.
 *
 * Services depend on this rather than on a concrete scraper class, so they do
 * not transitively import puppeteer. That keeps the heavy browser dependency
 * out of anything that only needs the data.
 */
export const SITE_SCRAPER = Symbol('SITE_SCRAPER');

export interface SiteScraper {
  scrape(): Promise<GameDTO[]>;
}
