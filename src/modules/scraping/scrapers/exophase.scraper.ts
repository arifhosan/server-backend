import { Injectable, Logger } from '@nestjs/common';
import puppeteer, { Browser, Page } from 'puppeteer';
import { GameDTO } from '../dto/game.dto';
import { SiteScraper } from './site-scraper.interface';
import { errorMessage } from '@/common/utils/error.util';
import { parsePlaytimeSeconds } from '../utils/playtime.util';

const PROFILE_URL = 'https://www.exophase.com/user/arifhosan';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.75 Safari/537.36';
const GAME_CARD_SELECTOR = '.col.col-game.game-info.pe-3';

const SCROLL_STEP_PX = 50000;
const SCROLL_PAUSE_MS = 3000;
const SCROLL_TIMEOUT_MS = 5000;

/** Raw card text. Parsed in Node rather than page.evaluate, so it can be tested. */
interface RawGameRow {
  title: string;
  link: string;
  platform: string;
  playtimeText: string;
}

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
      // Not on the happy path only: a failure used to leak a Chromium process.
      await browser?.close();
    }
  }

  private async extractGames(page: Page): Promise<GameDTO[]> {
    const rows = await this.extractRows(page);

    const games: GameDTO[] = [];
    const unreadable: string[] = [];

    for (const row of rows) {
      const playtimeSeconds = parsePlaytimeSeconds(row.playtimeText);

      // Dropped, not counted as zero, so the game keeps the total it has.
      if (playtimeSeconds === null) {
        unreadable.push(`${row.title}: '${row.playtimeText}'`);
        continue;
      }

      games.push({
        title: row.title,
        link: row.link,
        // Despite the name this is SECONDS; every stored row assumes seconds.
        playtimeMs: playtimeSeconds,
        platform: row.platform,
        slug: '',
      });
    }

    if (unreadable.length > 0) {
      this.logger.warn(
        `Skipped ${unreadable.length} card(s) with an unreadable playtime: ${unreadable.join(', ')}`,
      );
    }

    return games;
  }

  private extractRows(page: Page): Promise<RawGameRow[]> {
    return page.evaluate((selector: string): RawGameRow[] => {
      const rows: RawGameRow[] = [];

      document.querySelectorAll(selector).forEach((el) => {
        const anchor = el.querySelector('h3 a');
        const title = anchor?.textContent?.trim();
        const playtimeText = el.querySelector('.hours')?.textContent?.trim();
        if (!title || !playtimeText) return;

        rows.push({
          title,
          link: anchor?.getAttribute('href') ?? '',
          platform:
            el.querySelector('.platforms span')?.textContent?.trim() ?? '',
          playtimeText,
        });
      });

      return rows;
    }, GAME_CARD_SELECTOR);
  }

  /** The list loads lazily, so scroll until the page stops growing or responding. */
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
