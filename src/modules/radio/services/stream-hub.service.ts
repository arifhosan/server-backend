import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Writable } from 'node:stream';
import { StationStream } from '../streaming/station-stream';
import { StationStreamState } from '../types/station.types';
import { StationDirectoryService } from './station-directory.service';

const IDLE_SHUTDOWN_MS = 30_000;
const CONNECT_WAIT_MS = 15_000;

@Injectable()
export class StreamHubService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamHubService.name);

  private readonly streams = new Map<string, StationStream>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly directory: StationDirectoryService) {}

  /** Connects upstream and resolves once the Content-Type is known. */
  async open(uuid: string): Promise<StationStream | null> {
    const existing = this.streams.get(uuid);
    if (existing) {
      this.cancelIdle(uuid);
      await this.awaitReady(uuid, existing);
      return existing;
    }

    const resolved = await this.directory.getStation(uuid);
    if (!resolved || resolved.urls.length === 0) return null;

    const stream = new StationStream(resolved.summary, resolved.urls, (id) =>
      this.scheduleIdle(id),
    );

    this.streams.set(uuid, stream);
    this.directory.reportClick(uuid);
    stream.start();

    await this.awaitReady(uuid, stream);
    return stream;
  }

  private async awaitReady(uuid: string, stream: StationStream): Promise<void> {
    const ready = stream.ready();
    // The loser of the race below must stay handled or Node reports it.
    ready.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`${stream.station.name} did not respond in time`)),
        CONNECT_WAIT_MS,
      );
    });

    try {
      await Promise.race([ready, expiry]);
    } catch (error: unknown) {
      if (stream.listeners === 0) {
        stream.stop();
        this.streams.delete(uuid);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  detach(uuid: string, sink: Writable): void {
    this.streams.get(uuid)?.removeClient(sink);
  }

  state(uuid: string): StationStreamState | null {
    return this.streams.get(uuid)?.state ?? null;
  }

  active(): StationStreamState[] {
    return [...this.streams.values()].map((stream) => stream.state);
  }

  onModuleDestroy(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();

    for (const stream of this.streams.values()) stream.stop();
    this.streams.clear();
  }

  /** Held briefly so a page reload reuses the connection instead of redialling. */
  private scheduleIdle(uuid: string): void {
    this.cancelIdle(uuid);

    const timer = setTimeout(() => {
      this.idleTimers.delete(uuid);
      const stream = this.streams.get(uuid);
      if (!stream || stream.listeners > 0) return;

      this.logger.log(`Closing idle stream ${stream.station.name}`);
      stream.stop();
      this.streams.delete(uuid);
    }, IDLE_SHUTDOWN_MS);

    this.idleTimers.set(uuid, timer);
  }

  private cancelIdle(uuid: string): void {
    const timer = this.idleTimers.get(uuid);
    if (!timer) return;
    clearTimeout(timer);
    this.idleTimers.delete(uuid);
  }
}
