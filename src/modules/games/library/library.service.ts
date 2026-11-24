import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Like, Repository } from 'typeorm';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { Platform } from '../games.types';
import type { ObservedTitle } from '../sync/platform-client';
import { titleKey } from '../utils/title-key';

@Injectable()
export class LibraryService {
  constructor(
    @InjectRepository(LibraryGame)
    private readonly repo: Repository<LibraryGame>,
  ) {}

  /**
   * Finds or creates the game for (user, platform, externalId). Refreshes title/titleKey,
   * except that only a platform sync (`fromSync`) renames a row with a reported total.
   * Pass `manager` to run inside a transaction.
   */
  async upsertByExternalId(
    userId: number,
    platform: Platform,
    externalId: string,
    title: string,
    manager?: EntityManager,
    fromSync = false,
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
    const owned = found.totalSeconds !== null && !fromSync;
    if (!owned && (found.title !== title || found.titleKey !== key)) {
      found.title = title;
      found.titleKey = key;
      return repo.save(found);
    }
    return found;
  }

  /**
   * By platform id; else adopts a legacy row with the same non-empty titleKey (keeping its
   * total as the baseline); else creates. Used by the sync (`fromSync`) and by tracker Steam
   * games, so whichever comes first adopts. A sync also folds a tracker-created row (no total
   * yet) into a matching legacy row: sessions and icon move over, the duplicate is deleted.
   */
  async findOrAdopt(
    userId: number,
    o: Pick<ObservedTitle, 'platform' | 'externalId' | 'title'>,
    manager?: EntityManager,
    fromSync = true,
  ): Promise<LibraryGame> {
    const repo = manager ? manager.getRepository(LibraryGame) : this.repo;
    const { platform, externalId, title } = o;
    const key = titleKey(title);
    const exists = await repo.findOneBy({ userId, platform, externalId });
    const canAdopt =
      key !== '' && (!exists || (fromSync && exists.totalSeconds === null));
    const legacy = canAdopt
      ? await repo.findOne({
          where: {
            userId,
            platform,
            titleKey: key,
            externalId: Like('legacy:%'),
          },
          order: { id: 'ASC' },
        })
      : null;
    if (!legacy)
      return this.upsertByExternalId(
        userId,
        platform,
        externalId,
        title,
        manager,
        fromSync,
      );
    if (exists) await this.fold(exists, legacy, manager ?? this.repo.manager);
    legacy.externalId = externalId;
    if (fromSync) legacy.title = title;
    return repo.save(legacy);
  }

  /** Moves `dup`'s sessions and icon onto `into` and deletes `dup` (frees its externalId). */
  async fold(
    dup: LibraryGame,
    into: LibraryGame,
    m: EntityManager,
  ): Promise<void> {
    await m
      .getRepository(PlaySession)
      .update({ libraryGameId: dup.id }, { libraryGameId: into.id });
    const icons = m.getRepository(GameIcon);
    if (await icons.existsBy({ libraryGameId: into.id }))
      await icons.delete({ libraryGameId: dup.id });
    else
      await icons.update({ libraryGameId: dup.id }, { libraryGameId: into.id });
    await m.getRepository(LibraryGame).delete(dup.id);
    into.imageUrl ??= dup.imageUrl;
    if (
      dup.lastPlayedAt &&
      (!into.lastPlayedAt || into.lastPlayedAt < dup.lastPlayedAt)
    )
      into.lastPlayedAt = dup.lastPlayedAt;
  }
}
