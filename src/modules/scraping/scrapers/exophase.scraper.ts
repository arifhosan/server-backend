/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Injectable } from '@nestjs/common';
import { SiteScraper } from './site-scraper.interface';
import puppeteer, { Page } from 'puppeteer';
import { GameDTO } from '../dto/game.dto';

@Injectable()
export class ExophaseScraper implements SiteScraper {
  private readonly baseUrl: string = 'https://www.exophase.com/user/arifhosan';

  async scrape(): Promise<GameDTO[]> {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.75 Safari/537.36',
      );
      await page.setViewport({ width: 1080, height: 1024 });
      await page.goto(this.baseUrl);
      await scrollUntilEnd(page);

      const gameInfo = await page.evaluate(() => {
        const games: GameDTO[] = [];
        const gameElements = document.querySelectorAll(
          '.col.col-game.game-info.pe-3',
        );

        gameElements.forEach((el) => {
          const title = el.querySelector('h3 a')?.textContent?.trim(); // Extract the game title
          const link = el.querySelector('h3 a')?.getAttribute('href'); // Extract the game link
          const playtimeText = el.querySelector('.hours')?.textContent?.trim(); // Extract the playtime text
          const platform = el
            .querySelector('.platforms span')
            ?.textContent?.trim();

          if (title && playtimeText) {
            const timeMatch = playtimeText.match(/(\d+)h (\d+)m/);
            if (timeMatch) {
              const hours = parseInt(timeMatch[1], 10);
              const minutes = parseInt(timeMatch[2], 10);
              const playtimeMs = (hours * 60 + minutes) * 60; // Convert to milliseconds
              games.push({
                title,
                link,
                playtimeMs,
                platform,
                slug: '',
              });
            }
          }
        });
        return games;
      });
      await browser.close();
      return gameInfo;
    } catch (error) {
      console.error('Error scraping site:', error);
      throw new Error('Error scraping site: ' + error.message);
    }

    async function delay(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function scrollUntilEnd(
      page: Page,
      pause = 3000,
      step = 50000,
    ): Promise<void> {
      let previousHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );

      while (true) {
        await page.evaluate((step) => window.scrollBy(0, step), step);
        await delay(pause);
        const contentLoaded = await page
          .waitForFunction(
            `document.body.scrollHeight > ${previousHeight}`,
            { timeout: 5000 }, // Adjust timeout if needed
          )
          .catch(() => false); // If no content loaded, catch the timeout and break out of loop

        if (!contentLoaded) {
          console.log('[Scroll] No new content loaded. Breaking out of loop.');
          break; // No more content loaded or network timeout
        }
        const currentHeight = await page.evaluate(
          () => document.body.scrollHeight,
        );

        if (currentHeight === previousHeight) {
          console.log(
            '[Scroll] No more content to load. Current height:',
            currentHeight,
          );
          break; // no more content loaded
        }

        previousHeight = currentHeight;
      }
    }
  }
}
