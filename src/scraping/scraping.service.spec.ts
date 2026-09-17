import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Game } from '@/database/entities/game.entity';
import { Playtime } from '@/database/entities/playtime.entity';
import { TotalGameTime } from '@/database/entities/totalGameTime.entity';
import { ScrapingService } from './scraping.service';
import { ExophaseScrapper } from './sites/exophase.scraper';
import { GameDTO } from './sites/game.dto';

const game = (overrides: Partial<GameDTO> = {}): GameDTO => ({
  title: 'Hollow Knight',
  link: '/game/hollow-knight',
  slug: '',
  platform: 'Steam',
  playtimeMs: 5000,
  ...overrides,
});

describe('ScrapingService', () => {
  let service: ScrapingService;
  let exophase: { scrape: jest.Mock };
  let gameRepo: { save: jest.Mock };
  let totalRepo: { findOneBy: jest.Mock; save: jest.Mock };
  let playtimeRepo: { findOneBy: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    exophase = { scrape: jest.fn() };
    gameRepo = { save: jest.fn().mockResolvedValue(undefined) };
    totalRepo = {
      findOneBy: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    playtimeRepo = {
      findOneBy: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScrapingService,
        { provide: ExophaseScrapper, useValue: exophase },
        { provide: getRepositoryToken(Game), useValue: gameRepo },
        { provide: getRepositoryToken(TotalGameTime), useValue: totalRepo },
        { provide: getRepositoryToken(Playtime), useValue: playtimeRepo },
      ],
    }).compile();

    service = module.get(ScrapingService);
  });

  it('stores a first-time game as a full-playtime delta', async () => {
    exophase.scrape.mockResolvedValue([game({ playtimeMs: 5000 })]);
    totalRepo.findOneBy.mockResolvedValue(null);
    playtimeRepo.findOneBy.mockResolvedValue(null);

    await expect(service.scrapeData()).resolves.toBe(1);

    expect(gameRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'hollow-knightsteam',
        title: 'Hollow Knight',
        platform: 'Steam',
        playtimeMs: 5000,
      }),
    );
    expect(totalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'hollow-knightsteam', totalMs: 5000 }),
    );
  });

  it('stores only the delta when the game was seen before', async () => {
    exophase.scrape.mockResolvedValue([game({ playtimeMs: 8000 })]);
    totalRepo.findOneBy.mockResolvedValue({
      slug: 'hollow-knightsteam',
      totalMs: 5000,
    });
    playtimeRepo.findOneBy.mockResolvedValue(null);

    await expect(service.scrapeData()).resolves.toBe(1);

    expect(gameRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ playtimeMs: 3000 }),
    );
    expect(totalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ totalMs: 8000 }),
    );
  });

  it('skips a game whose playtime has not advanced', async () => {
    exophase.scrape.mockResolvedValue([game({ playtimeMs: 5000 })]);
    totalRepo.findOneBy.mockResolvedValue({
      slug: 'hollow-knightsteam',
      totalMs: 5000,
    });

    await expect(service.scrapeData()).resolves.toBe(0);

    expect(gameRepo.save).not.toHaveBeenCalled();
    expect(totalRepo.save).not.toHaveBeenCalled();
    expect(playtimeRepo.save).not.toHaveBeenCalled();
  });

  it('records the daily total when no row exists for today', async () => {
    const today = new Date().toISOString().split('T')[0];
    exophase.scrape.mockResolvedValue([game({ playtimeMs: 5000 })]);
    totalRepo.findOneBy.mockResolvedValue(null);
    playtimeRepo.findOneBy.mockResolvedValue(null);

    await service.scrapeData();

    expect(playtimeRepo.findOneBy).toHaveBeenCalledWith({ date: today });
    expect(playtimeRepo.save).toHaveBeenCalledWith({
      date: today,
      totalMs: 5000,
    });
  });

  it('does not touch the daily total twice on the same day', async () => {
    exophase.scrape.mockResolvedValue([game({ playtimeMs: 5000 })]);
    totalRepo.findOneBy.mockResolvedValue(null);
    playtimeRepo.findOneBy.mockResolvedValue({
      date: new Date().toISOString().split('T')[0],
      totalMs: 1000,
      updatedAt: new Date(),
    });

    await service.scrapeData();

    expect(playtimeRepo.save).not.toHaveBeenCalled();
  });

  it('counts every game that advanced', async () => {
    exophase.scrape.mockResolvedValue([
      game({ title: 'A', playtimeMs: 100 }),
      game({ title: 'B', playtimeMs: 200 }),
      game({ title: 'C', playtimeMs: 300 }),
    ]);
    totalRepo.findOneBy.mockResolvedValue(null);
    playtimeRepo.findOneBy.mockResolvedValue(null);

    await expect(service.scrapeData()).resolves.toBe(3);
  });

  it('returns 0 rather than throwing when the scraper fails', async () => {
    exophase.scrape.mockRejectedValue(new Error('site unreachable'));

    await expect(service.scrapeData()).resolves.toBe(0);
  });
});
