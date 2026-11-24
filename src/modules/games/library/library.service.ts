import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Like, Repository } from 'typeorm';
import { LibraryGame } from '../entities/library-game.entity';
import { Platform } from '../games.types';
import type { ObservedTitle } from '../sync/platform-client';
import { titleKey } from '../utils/title-key';

@Injectable()
export class LibraryService {
  constructor(
    @InjectRepository(LibraryGame)
    private readonly repo: Repository<LibraryGame>,
  ) {}

  /** Finds or creates the game for (user, platform, externalId); refreshes title/titleKey. Pass `manager` to run inside a transaction. */
  async upsertByExternalId(
    userId: number,
    platform: Platform,
    externalId: string,
    title: string,
    manager?: EntityManager,
  ): Promise<LibraryGame> {
    const repo = manager ? manager.getRepository(LibraryGame) : this.repo;
    const key = titleKey(title);
    const found = await repo.findOneBy({ userId, platform, externalId });
    if (!found) {
      return repo.save(
        repo.create({
          userId,
          platform,
          externalId,
          title,
          titleKey: key,
          totalSeconds: null,
          totalChangedAt: null,
          lastPlayedAt: null,
        }),
      );
    }
    if (found.title !== title || found.titleKey !== key) {
      found.title = title;
      found.titleKey = key;
      return repo.save(found);
    }
    return found;
  }

  /** By platform id; else adopts a legacy row with the same non-empty titleKey; else creates. */
  async findOrAdopt(
    userId: number,
    o: ObservedTitle,
    manager?: EntityManager,
  ): Promise<LibraryGame> {
    const repo = manager ? manager.getRepository(LibraryGame) : this.repo;
    const { platform, externalId, title } = o;
    const key = titleKey(title);
    const exists = await repo.findOneBy({ userId, platform, externalId });
    if (!exists && key !== '') {
      const legacy = await repo.findOne({
        where: {
          userId,
          platform,
          titleKey: key,
          externalId: Like('legacy:%'),
        },
        order: { id: 'ASC' },
      });
      if (legacy) {
        legacy.externalId = externalId;
        legacy.title = title;
        return repo.save(legacy);
      }
    }
    return this.upsertByExternalId(
      userId,
      platform,
      externalId,
      title,
      manager,
    );
  }
}
