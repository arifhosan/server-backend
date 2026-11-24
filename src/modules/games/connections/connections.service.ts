import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Connection } from '../entities/connection.entity';
import { SyncRun } from '../entities/sync-run.entity';
import { GAMES_SECRET_KEY } from '../games.constants';
import { ConnectionStatus, Provider } from '../games.types';
import { PsnClient } from '../sync/psn.client';
import { SyncFailedError } from '../sync/platform-client';
import { SteamClient } from '../sync/steam.client';
import { SyncService } from '../sync/sync.service';
import { sealSecret } from '../utils/secret-box';

export interface PublicConnection {
  provider: Provider;
  externalId: string;
  displayName: string;
  status: ConnectionStatus;
  secretExpiresAt: Date | null;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastGameCount: number | null;
}

/** Explicit pick: the sealed secret must never leave the service. */
export function toPublicConnection(c: Connection): PublicConnection {
  return {
    provider: c.provider,
    externalId: c.externalId,
    displayName: c.displayName,
    status: c.status,
    secretExpiresAt: c.secretExpiresAt,
    lastSyncAt: c.lastSyncAt,
    lastSuccessAt: c.lastSuccessAt,
    lastError: c.lastError,
    lastGameCount: c.lastGameCount,
  };
}

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    private readonly steam: SteamClient,
    private readonly psn: PsnClient,
    private readonly sync: SyncService,
    @Inject(GAMES_SECRET_KEY) private readonly key: Buffer,
  ) {}

  async list(userId: number): Promise<PublicConnection[]> {
    const rows = await this.connections.find({ where: { userId } });
    return rows.map(toPublicConnection);
  }

  async connectSteam(
    userId: number,
    profile: string,
  ): Promise<PublicConnection> {
    let steamId: string;
    let displayName: string;
    try {
      steamId = await this.steam.resolveSteamId(profile);
      ({ displayName } = await this.steam.profile(steamId));
      // One fetch as the test: a private profile fails here, before anything is saved.
      await this.steam.fetchTitles({ externalId: steamId } as Connection);
    } catch (e) {
      // Not found, private, API error, unreachable: all fixed, secret-free texts (Ruling R9).
      if (e instanceof SyncFailedError)
        throw new BadRequestException(e.message);
      throw e;
    }
    return this.save(userId, 'steam', {
      externalId: steamId,
      displayName,
      secret: null,
      secretExpiresAt: null,
    });
  }

  async connectPsn(userId: number, npsso: string): Promise<PublicConnection> {
    let res: Awaited<ReturnType<PsnClient['connect']>>;
    try {
      res = await this.psn.connect(npsso);
    } catch {
      // By design every connect failure (bad token, PSN down) is this one 400.
      throw new BadRequestException(
        'PSN rejected this token. Copy a fresh one and try again.',
      );
    }
    return this.save(userId, 'psn', {
      externalId: res.accountId,
      displayName: res.onlineId,
      secret: sealSecret(JSON.stringify(res.secret), this.key),
      secretExpiresAt: new Date(res.secret.npssoExpiresAt),
    });
  }

  async syncNow(userId: number, provider: Provider): Promise<SyncRun> {
    const conn = await this.owned(userId, provider);
    return this.sync.syncConnection(conn.id);
  }

  async remove(userId: number, provider: Provider): Promise<void> {
    const conn = await this.owned(userId, provider);
    // sync_run rows stay: no FK, and the 90-day prune removes them.
    await this.connections.delete(conn.id);
  }

  private async owned(userId: number, provider: Provider): Promise<Connection> {
    const conn = await this.connections.findOneBy({ userId, provider });
    if (!conn) throw new NotFoundException('Connection not found');
    return conn;
  }

  private async save(
    userId: number,
    provider: Provider,
    fields: Pick<
      Connection,
      'externalId' | 'displayName' | 'secret' | 'secretExpiresAt'
    >,
  ): Promise<PublicConnection> {
    const existing = await this.connections.findOneBy({ userId, provider });
    const conn = await this.connections.save(
      Object.assign(
        existing ?? this.connections.create({ userId, provider }),
        fields,
        { status: 'ok' as const, lastError: null },
      ),
    );
    void this.sync.syncConnection(conn.id).catch((e: unknown) => {
      this.logger.warn(
        `initial sync failed: ${e instanceof Error ? e.constructor.name : 'unknown'}`,
      );
    });
    return toPublicConnection(conn);
  }
}
