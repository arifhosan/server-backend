import { createHash } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { DeviceContext } from '../devices/device-auth.guard';
import {
  HeartbeatDto,
  HeartbeatGameDto,
  TrackerStore,
} from '../dto/heartbeats.dto';
import { Connection } from '../entities/connection.entity';
import { Device } from '../entities/device.entity';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { ConnectionStatus, Platform } from '../games.types';
import { isPng, MAX_ICON_BYTES, pickArt, steamImageUrl } from '../library/art';
import { LibraryService } from '../library/library.service';
import { titleKey } from '../utils/title-key';
import { mergeHeartbeat } from './heartbeat-merge';

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 30 * 86_400_000;
const NOW_WINDOW_MS = 120_000;

export interface NowPlaying {
  deviceId: number;
  deviceName: string;
  libraryGameId: number;
  title: string;
  platform: Platform;
  startedAt: Date;
  imageUrl: string | null;
  hasIcon: boolean;
  iconLibraryGameId: number | null;
}

export interface TrackerStatus {
  psn: { status: ConnectionStatus; expiresAt: Date | null } | null;
}

const PLATFORMS: Record<TrackerStore, Platform> = {
  steam: 'steam',
  xbox: 'xbox_pc',
  epic: 'epic',
  other: 'pc_other',
};

export function trackerPlatform(store: TrackerStore): Platform {
  return PLATFORMS[store];
}

/** External id for games without a store id; hashes the title when titleKey is empty (Ruling R8). */
function folderId(title: string): string {
  const key = titleKey(title);
  if (key) return `folder:${key}`;
  const hash = createHash('sha256').update(title.trim()).digest('hex');
  return `folder:t-${hash.slice(0, 16)}`;
}

@Injectable()
export class TrackerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly library: LibraryService,
    @InjectRepository(PlaySession)
    private readonly sessions: Repository<PlaySession>,
    @InjectRepository(LibraryGame)
    private readonly games: Repository<LibraryGame>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(GameIcon)
    private readonly icons: Repository<GameIcon>,
  ) {}

  /** Heartbeats and icon uploads resolve the library game the same way; Steam games get their CDN art. */
  private async resolveGame(
    userId: number,
    { store, storeId, title }: HeartbeatGameDto,
    manager?: EntityManager,
  ): Promise<LibraryGame> {
    const platform = trackerPlatform(store);
    // A Steam appid adopts a legacy row like the sync does, so the first of the two wins (I1).
    const game =
      store === 'steam' && storeId
        ? await this.library.findOrAdopt(
            userId,
            { platform, externalId: storeId, title },
            manager,
            false,
          )
        : await this.library.upsertByExternalId(
            userId,
            platform,
            storeId ?? folderId(title),
            title,
            manager,
          );
    const url = store === 'steam' && storeId ? steamImageUrl(storeId) : null;
    if (url && game.imageUrl !== url) {
      game.imageUrl = url;
      await (manager ? manager.getRepository(LibraryGame) : this.games).update(
        game.id,
        { imageUrl: url },
      );
    }
    return game;
  }

  async saveIcon(
    userId: number,
    game: HeartbeatGameDto,
    base64: string,
  ): Promise<void> {
    const png = Buffer.from(base64, 'base64');
    if (png.length > MAX_ICON_BYTES)
      throw new BadRequestException('Icon is larger than 64 KB');
    if (!isPng(png)) throw new BadRequestException('Icon must be a PNG');
    const { id } = await this.resolveGame(userId, game);
    await this.icons.save({ libraryGameId: id, png });
  }

  async ingest(
    device: DeviceContext,
    heartbeats: HeartbeatDto[],
    now = new Date(),
  ): Promise<{ accepted: number; rejected: number }> {
    const valid = heartbeats
      .map((h) => ({ h, at: new Date(h.at) }))
      .filter(
        ({ at }) =>
          at.getTime() <= now.getTime() + MAX_FUTURE_MS &&
          at.getTime() >= now.getTime() - MAX_AGE_MS,
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    await this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(PlaySession);
      const games = manager.getRepository(LibraryGame);
      for (const { h, at } of valid) {
        const game = await this.resolveGame(device.userId, h.game, manager);
        const latest = await sessions.findOne({
          where: {
            deviceId: device.deviceId,
            libraryGameId: game.id,
            source: 'tracker',
            startedAt: LessThanOrEqual(at),
          },
          order: { startedAt: 'DESC' },
        });
        const m = mergeHeartbeat(latest, at);
        if (m.action === 'ignore') continue;
        const seconds = Math.round(
          (m.endedAt.getTime() - m.startedAt.getTime()) / 1000,
        );
        if (m.action === 'extend' && latest) {
          latest.endedAt = m.endedAt;
          latest.seconds = seconds;
          await sessions.save(latest);
        } else {
          await sessions.save(
            sessions.create({
              userId: device.userId,
              libraryGameId: game.id,
              source: 'tracker',
              deviceId: device.deviceId,
              startedAt: m.startedAt,
              endedAt: m.endedAt,
              seconds,
              legacyRef: null,
            }),
          );
        }
        if (!game.lastPlayedAt || game.lastPlayedAt < m.endedAt) {
          game.lastPlayedAt = m.endedAt;
          await games.update(game.id, { lastPlayedAt: m.endedAt });
        }
      }
    });
    return {
      accepted: valid.length,
      rejected: heartbeats.length - valid.length,
    };
  }

  async nowPlaying(userId: number, now = new Date()): Promise<NowPlaying[]> {
    const active = await this.sessions.find({
      where: {
        userId,
        source: 'tracker',
        endedAt: MoreThanOrEqual(new Date(now.getTime() - NOW_WINDOW_MS)),
      },
      order: { startedAt: 'DESC' },
    });
    if (!active.length) return [];
    const [games, devices] = await Promise.all([
      this.games.find({
        where: { id: In(active.map((s) => s.libraryGameId)) },
      }),
      this.devices.find({
        where: { id: In(active.map((s) => s.deviceId as number)) },
      }),
    ]);
    const iconIds = new Set(
      (
        await this.icons.find({
          select: { libraryGameId: true },
          where: { libraryGameId: In(games.map((g) => g.id)) },
        })
      ).map((i) => i.libraryGameId),
    );
    return active.flatMap((s) => {
      const g = games.find((x) => x.id === s.libraryGameId);
      const d = devices.find((x) => x.id === s.deviceId);
      if (!g || !d) return [];
      return [
        {
          deviceId: d.id,
          deviceName: d.name,
          libraryGameId: g.id,
          title: g.title,
          platform: g.platform,
          startedAt: s.startedAt,
          ...pickArt([g], iconIds),
        },
      ];
    });
  }

  async status(userId: number): Promise<TrackerStatus> {
    const c = await this.connections.findOneBy({ userId, provider: 'psn' });
    return {
      psn: c ? { status: c.status, expiresAt: c.secretExpiresAt } : null,
    };
  }
}
