import { Logger } from '@nestjs/common';
import http, { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import { errorMessage } from '@/common/utils/error.util';
import { IcyStreamParser, parsePlaylist } from './icy-metadata.parser';

const CONNECT_TIMEOUT_MS = 12_000;
const STALL_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 64 * 1024;
const USER_AGENT = 'server-backend-radio/1.0';

const PLAYLIST_CONTENT_TYPES = [
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/x-mpegurl',
  'audio/x-scpls',
  'application/pls+xml',
];

export interface UpstreamInfo {
  contentType: string;
  bitrateKbps: number | null;
}

export interface UpstreamHandlers {
  onOpen: (info: UpstreamInfo) => void;
  onAudio: (chunk: Buffer) => void;
  onTitle: (title: string) => void;
  onClose: (reason: string) => void;
}

/**
 * One attempt at one upstream URL. Uses node:http, not axios, because
 * `insecureHTTPParser` is the only way to accept Shoutcast's `ICY 200 OK`.
 */
export class UpstreamConnection {
  private readonly logger = new Logger(UpstreamConnection.name);

  private request: ClientRequest | null = null;
  private response: IncomingMessage | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: UpstreamHandlers,
  ) {}

  start(): void {
    this.open(this.url, MAX_REDIRECTS);
  }

  destroy(): void {
    this.closed = true;
    this.clearStallTimer();
    this.response?.destroy();
    this.request?.destroy();
    this.response = null;
    this.request = null;
  }

  private open(target: string, redirectsLeft: number): void {
    if (this.closed) return;

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      this.finish(`invalid upstream URL: ${target}`);
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Icy-MetaData': '1',
        },
        timeout: CONNECT_TIMEOUT_MS,
        insecureHTTPParser: true,
      },
      (response) => this.onResponse(response, parsed, redirectsLeft),
    );

    this.request = request;

    request.on('timeout', () => {
      request.destroy();
      this.finish('connect timeout');
    });

    request.on('error', (error: Error) => {
      this.finish(`connect failed: ${errorMessage(error)}`);
    });

    request.end();
  }

  private onResponse(
    response: IncomingMessage,
    requestUrl: URL,
    redirectsLeft: number,
  ): void {
    if (this.closed) {
      response.destroy();
      return;
    }

    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location) {
      this.discard(response);
      if (redirectsLeft <= 0) {
        this.finish('too many redirects');
        return;
      }
      this.detachRequest();
      this.open(new URL(location, requestUrl).toString(), redirectsLeft - 1);
      return;
    }

    if (status !== 200) {
      this.discard(response);
      this.finish(`upstream status ${status}`);
      return;
    }

    const contentType = (response.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (PLAYLIST_CONTENT_TYPES.includes(contentType)) {
      this.followPlaylist(response, requestUrl, redirectsLeft);
      return;
    }

    this.consumeAudio(response, contentType);
  }

  private followPlaylist(
    response: IncomingMessage,
    requestUrl: URL,
    redirectsLeft: number,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;

    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PLAYLIST_BYTES) {
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });

    response.on('end', () => {
      const [first] = parsePlaylist(Buffer.concat(chunks).toString('utf8'));
      if (!first) {
        this.finish('playlist contained no stream URL');
        return;
      }

      if (redirectsLeft <= 0) {
        this.finish('too many playlist hops');
        return;
      }

      this.detachRequest();
      this.open(new URL(first, requestUrl).toString(), redirectsLeft - 1);
    });

    response.on('error', (error: Error) => {
      this.finish(`playlist read failed: ${errorMessage(error)}`);
    });
  }

  private consumeAudio(response: IncomingMessage, contentType: string): void {
    this.response = response;

    const metaint = Number(response.headers['icy-metaint'] ?? 0);
    const icyBitrate = Number(response.headers['icy-br'] ?? 0);

    const parser = new IcyStreamParser(
      Number.isFinite(metaint) ? metaint : 0,
      this.handlers.onAudio,
      this.handlers.onTitle,
    );

    this.handlers.onOpen({
      contentType: contentType || 'audio/mpeg',
      bitrateKbps:
        Number.isFinite(icyBitrate) && icyBitrate > 0 ? icyBitrate : null,
    });

    this.request?.setTimeout(0);
    response.socket?.setTimeout(0);
    this.armStallTimer();

    response.on('data', (chunk: Buffer) => {
      this.armStallTimer();
      parser.push(chunk);
    });

    response.on('end', () => this.finish('upstream ended'));
    response.on('close', () => this.finish('upstream closed'));
    response.on('error', (error: Error) =>
      this.finish(`upstream error: ${errorMessage(error)}`),
    );
  }

  /** Listeners go first: destroy() emits 'error' async, after the replacement is live. */
  private detachRequest(): void {
    const previous = this.request;
    this.request = null;
    previous?.removeAllListeners('error');
    previous?.removeAllListeners('timeout');
    previous?.destroy();
  }

  /** An unhandled 'error' on an unread response would take the process down. */
  private discard(response: IncomingMessage): void {
    response.on('error', () => undefined);
    response.resume();
  }

  /** A stream can go silent with the socket still open; only a timer catches it. */
  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.logger.warn(`Upstream stalled: ${this.url}`);
      this.destroy();
      this.handlers.onClose('stalled');
    }, STALL_TIMEOUT_MS);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearStallTimer();
    this.response?.destroy();
    this.request?.destroy();
    this.handlers.onClose(reason);
  }
}
