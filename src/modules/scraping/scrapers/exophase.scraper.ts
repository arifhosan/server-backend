import { Injectable, Logger } from '@nestjs/common';
import puppeteer, { Browser, Page } from 'puppeteer';
import { GameDTO } from '../dto/game.dto';
import { SiteScraper } from './site-scraper.interface';
import { errorMessage } from '@/common/utils/error.util';

const PROFILE_URL = 'https://www.exophase.com/user/arifhosan';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.75 Safari/537.36';
const GAME_CARD_SELECTOR = '.col.col-game.game-info.pe-3';

const SCROLL_STEP_PX = 50000;
const SCROLL_PAUSE_MS = 3000;
const SCROLL_TIMEOUT_MS = 5000;

@Injectable()
export class ExophaseScraper implements SiteScraper {
  private readonly logger = new Logger(ExophaseScraper.name);

  async scrape(): Promise<GameDTO[]> {
    let browser: Browser | undefined;

    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setViewport({ width: 1080, height: 1024 });
      await page.goto(PROFILE_URL);
      await this.scrollUntilEnd(page);

      const games = await this.extractGames(page);
      this.logger.log(`Extracted ${games.length} games from Exophase`);
      return games;
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.logger.error(`Exophase scrape failed: ${message}`);
      throw new Error(`Error scraping site: ${message}`, { cause: error });
    } finally {
      // The original closed the browser only on the happy path, leaking a
      // Chromium process on every failure.
      await browser?.close();
    }
  }

  private extractGames(page: Page): Promise<GameDTO[]> {
    return page.evaluate((selector: string): GameDTO[] => {
      const games: GameDTO[] = [];

      document.querySelectorAll(selector).forEach((el) => {
        const anchor = el.querySelector('h3 a');
        const title = anchor?.textContent?.trim();
        const playtimeText = el.querySelector('.hours')?.textContent?.trim();
        if (!title || !playtimeText) return;

        const match = playtimeText.match(/(\d+)h (\d+)m/);
        if (!match) return;

        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);

        games.push({
          title,
          link: anchor?.getAttribute('href') ?? '',
          // NOTE: despite the name, this value is SECONDS, not milliseconds.
          // The column and DTO field were never renamed; every stored row
          // and consumer assumes seconds, so the arithmetic is left as-is.
          playtimeMs: (hours * 60 + minutes) * 60,
          platform:
            el.querySelector('.platforms span')?.textContent?.trim() ?? '',
          slug: '',
        });
      });

      return games;
    }, GAME_CARD_SELECTOR);
  }

  /**
   * Exophase loads the game list lazily, so scroll until the page stops
   * growing or stops responding.
   */
  private async scrollUntilEnd(page: Page): Promise<void> {
    let previousHeight = await page.evaluate(() => document.body.scrollHeight);

    for (;;) {
      await page.evaluate(
        (step: number) => window.scrollBy(0, step),
        SCROLL_STEP_PX,
      );
      await new Promise((resolve) => setTimeout(resolve, SCROLL_PAUSE_MS));

      const grew = await page
        .waitForFunction(`document.body.scrollHeight > ${previousHeight}`, {
          timeout: SCROLL_TIMEOUT_MS,
        })
        .catch(() => false);

      if (!grew) {
        this.logger.debug('Scroll stopped: no new content loaded');
        return;
      }

      const currentHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );
      if (currentHeight === previousHeight) {
        this.logger.debug(`Scroll stopped at height ${currentHeight}`);
        return;
      }

      previousHeight = currentHeight;
    }
  }
}
