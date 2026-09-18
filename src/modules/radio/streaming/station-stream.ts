import { Logger } from '@nestjs/common';
import { Writable } from 'node:stream';
import { StationStreamState, StationSummary } from '../types/station.types';
import { UpstreamConnection, UpstreamInfo } from './upstream-connection';

const PREBUFFER_BYTES = 64 * 1024;
const MAX_CLIENT_BACKLOG_BYTES = 2 * 1024 * 1024;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const STABLE_AFTER_MS = 5_000;
const MAX_OUTAGE_MS = 3 * 60 * 1000;

/**
 * One upstream connection fanned out to every listener of a station.
 * Clients stay attached across upstream failures, so a drop is silence
 * rather than end-of-stream. That is the bug this module exists to fix.
 */
export class StationStream {
  private readonly logger = new Logger(StationStream.name);

  private readonly clients = new Set<Writable>();
  private connection: UpstreamConnection | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private prebuffer: Buffer[] = [];
  private prebufferBytes = 0;

  private attempts = 0;
  private outageStartedAt: number | null = null;
  private connectedAt: number | null = null;
  private urlIndex = 0;

  private title: string | null = null;
  private contentType = 'audio/mpeg';
  private readyWaiters: {
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];

  constructor(
    readonly station: StationSummary,
    private readonly urls: string[],
    private readonly onEmpty: (uuid: string) => void,
  ) {}

  get listeners(): number {
    return this.clients.size;
  }

  get mediaType(): string {
    return this.contentType;
  }

  get state(): StationStreamState {
    return {
      uuid: this.station.uuid,
      name: this.station.name,
      title: this.title,
      connected: this.connectedAt !== null,
      listeners: this.clients.size,
      reconnects: this.attempts,
      contentType: this.contentType,
    };
  }

  addClient(sink: Writable): void {
    this.clients.add(sink);

    for (const chunk of this.prebuffer) sink.write(chunk);

    if (!this.connection && !this.reconnectTimer && !this.stopped) {
      this.connect();
    }
  }

  removeClient(sink: Writable): void {
    if (!this.clients.delete(sink)) return;
    if (this.clients.size === 0) this.onEmpty(this.station.uuid);
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.connection?.destroy();
    this.connection = null;
    this.connectedAt = null;

    for (const client of this.clients) client.end();
    this.clients.clear();
    this.prebuffer = [];
    this.prebufferBytes = 0;
  }

  private connect(): void {
    if (this.stopped) return;

    const url = this.urls[this.urlIndex % this.urls.length];
    this.logger.log(`Connecting ${this.station.name} (try ${this.attempts + 1}): ${url}`);

    this.connection = new UpstreamConnection(url, {
      onOpen: (info) => this.handleOpen(info),
      onAudio: (chunk) => this.broadcast(chunk),
      onTitle: (title) => {
        this.title = title;
      },
      onClose: (reason) => this.handleClose(reason),
    });

    this.connection.start();
  }

  private handleOpen(info: UpstreamInfo): void {
    this.connectedAt = Date.now();
    this.contentType = info.contentType;
    this.logger.log(`Connected ${this.station.name} as ${info.contentType}`);
  }

  private handleClose(reason: string): void {
    this.connection = null;

    const wasStable =
      this.connectedAt !== null &&
      Date.now() - this.connectedAt >= STABLE_AFTER_MS;

    if (wasStable) {
      this.attempts = 0;
      this.outageStartedAt = null;
    }

    this.connectedAt = null;

    if (this.stopped) return;

    if (this.clients.size === 0) {
      this.logger.debug(`${this.station.name} closed, no listeners: ${reason}`);
      return;
    }

    this.outageStartedAt ??= Date.now();

    if (Date.now() - this.outageStartedAt > MAX_OUTAGE_MS) {
      this.logger.error(`Giving up on ${this.station.name}: ${reason}`);
      this.stop();
      this.onEmpty(this.station.uuid);
      return;
    }

    this.urlIndex += 1;
    this.attempts += 1;

    const backoff = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.attempts - 1),
      RECONNECT_MAX_MS,
    );
    const wait = backoff + Math.floor(Math.random() * 250);

    this.logger.warn(
      `${this.station.name} dropped (${reason}); retry in ${wait}ms for ${this.clients.size}`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  private broadcast(chunk: Buffer): void {
    this.remember(chunk);

    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) {
        this.clients.delete(client);
        continue;
      }

      if (client.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
        this.logger.warn(`Dropping slow listener of ${this.station.name}`);
        this.clients.delete(client);
        client.destroy();
        continue;
      }

      client.write(chunk);
    }

    if (this.clients.size === 0) this.onEmpty(this.station.uuid);
  }

  private remember(chunk: Buffer): void {
    this.prebuffer.push(chunk);
    this.prebufferBytes += chunk.length;

    while (this.prebufferBytes > PREBUFFER_BYTES && this.prebuffer.length > 1) {
      const dropped = this.prebuffer.shift();
      this.prebufferBytes -= dropped?.length ?? 0;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
