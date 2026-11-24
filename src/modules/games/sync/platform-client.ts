import { Connection } from '../entities/connection.entity';
import { ConnectionStatus, Platform } from '../games.types';

export interface ObservedTitle {
  platform: Platform;
  externalId: string;
  title: string;
  totalSeconds: number;
  lastPlayedAt?: Date;
  imageUrl?: string;
}

export interface PlatformClient {
  /** `secret` is the decrypted JSON string; return a new one if tokens were refreshed. */
  fetchTitles(
    conn: Connection,
    secret: string | null,
  ): Promise<{
    titles: ObservedTitle[];
    secret?: string;
    secretExpiresAt?: Date;
  }>;
  /** Absent means `ok`. */
  statusAfter?(secretExpiresAt: Date | null, now: Date): ConnectionStatus;
}

export class SecretExpiredError extends Error {
  constructor(message = 'Secret expired') {
    super(message);
    this.name = 'SecretExpiredError';
  }
}

export class SyncFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncFailedError';
  }
}
