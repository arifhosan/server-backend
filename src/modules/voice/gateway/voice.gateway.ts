import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import { errorMessage } from '@/common/utils/error.util';
import { ConversationService } from '../pipeline/conversation.service';
import { VoiceConfig } from '../voice.config';
import { DeviceSession } from './device-session';

@Injectable()
export class VoiceGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VoiceGateway.name);
  private readonly sessions = new Set<DeviceSession>();
  private server?: WebSocketServer;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: VoiceConfig,
    private readonly conversation: ConversationService,
  ) {}

  onApplicationBootstrap(): void {
    const http = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server = new WebSocketServer({ noServer: true });

    // noServer + a manual upgrade hook, so other paths on the same port stay
    // free for future WebSocket endpoints.
    http.on('upgrade', (request, socket, head) => {
      this.onUpgrade(request, socket, head);
    });

    this.logger.log(`Device WebSocket listening on ${this.config.wsPath}`);
  }

  onApplicationShutdown(): void {
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
    this.server?.close();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private onUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== this.config.wsPath || !this.server) return;

    if (!this.isAuthorised(request, url)) {
      this.logger.warn(
        `Rejected unauthorised upgrade from ${request.socket.remoteAddress}`,
      );
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.server.handleUpgrade(request, socket, head, (ws) => {
      const context = {
        deviceId:
          header(request, 'device-id') ??
          url.searchParams.get('device') ??
          'unknown',
        clientId:
          header(request, 'client-id') ??
          url.searchParams.get('client') ??
          'unknown',
        headerVersion: Number(header(request, 'protocol-version') ?? 1),
      };

      const session = new DeviceSession(
        ws,
        context,
        this.config,
        this.conversation,
      );
      this.sessions.add(session);
      ws.on('close', () => this.sessions.delete(session));

      try {
        session.start();
      } catch (error: unknown) {
        this.logger.error(`Session start failed: ${errorMessage(error)}`);
        ws.close(1011, 'session start failed');
      }
    });
  }

  /** Browsers cannot set headers on a WebSocket, so a query token is accepted. */
  private isAuthorised(request: IncomingMessage, url: URL): boolean {
    const expected = this.config.authToken;
    if (!expected) return true;

    const bearer = header(request, 'authorization')?.replace(/^Bearer\s+/i, '');
    return bearer === expected || url.searchParams.get('token') === expected;
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
