import { Logger } from '@nestjs/common';
import http, { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { errorMessage } from '@/common/utils/error.util';
import { IcyStreamParser, parsePlaylist } from './icy-metadata.parser';

const CONNECT_TIMEOUT_MS = 12_000;
const STALL_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 16 * 1024;
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

/** One attempt at one upstream URL, over HTTP or a raw socket for ICY servers. */
export class UpstreamConnection {
  private readonly logger = new Logger(UpstreamConnection.name);

  private request: ClientRequest | null = null;
  private body: Readable | null = null;
  private socket: net.Socket | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private opened = false;

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
    this.body?.destroy();
    this.request?.destroy();
    this.socket?.destroy();
    this.body = null;
    this.request = null;
    this.socket = null;
  }

  private open(target: string, redirectsLeft: number): void {
    if (this.closed) return;

    const parsed = this.parse(target);
    if (!parsed) return;

    const transport = parsed.protocol === 'https:' ? https : http;

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: this.portOf(parsed),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: this.requestHeaders(parsed),
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

    request.on('error', (error: NodeJS.ErrnoException) => {
      // Shoutcast v1 answers `ICY 200 OK`, which no HTTP parser accepts --
      // not even the insecure one. Those stations need the raw path.
      const parserFailed = error.code?.startsWith('HPE_') ?? false;

      if (parserFailed && !this.opened && !this.closed) {
        this.logger.debug(`Falling back to raw socket for ${target}`);
        this.detachRequest();
        this.openRaw(parsed, redirectsLeft);
        return;
      }

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
      this.hop(location, requestUrl, redirectsLeft, 'too many redirects');
      return;
    }

    if (status !== 200) {
      this.discard(response);
      this.finish(`upstream status ${status}`);
      return;
    }

    const contentType = normaliseContentType(response.headers['content-type']);

    if (PLAYLIST_CONTENT_TYPES.includes(contentType)) {
      this.followPlaylist(response, requestUrl, redirectsLeft);
      return;
    }

    this.attachBody(response, {
      contentType,
      metaint: Number(response.headers['icy-metaint'] ?? 0),
      bitrate: Number(response.headers['icy-br'] ?? 0),
    });
  }

  /** Reads and parses the response head by hand, accepting `ICY 200 OK`. */
  private openRaw(requestUrl: URL, redirectsLeft: number): void {
    if (this.closed) return;

    const port = this.portOf(requestUrl);
    const socket =
      requestUrl.protocol === 'https:'
        ? tls.connect({
            host: requestUrl.hostname,
            port,
            servername: requestUrl.hostname,
          })
        : net.connect({ host: requestUrl.hostname, port });

    this.socket = socket;
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    const path = `${requestUrl.pathname}${requestUrl.search}`;
    const headers = Object.entries(this.requestHeaders(requestUrl))
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');

    const onReady = (): void => {
      socket.write(`GET ${path} HTTP/1.0\r\n${headers}\r\n\r\n`);
    };

    socket.once(
      requestUrl.protocol === 'https:' ? 'secureConnect' : 'connect',
      onReady,
    );

    let head = Buffer.alloc(0);

    const onHeadData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf('\r\n\r\n');

      if (split === -1) {
        if (head.length > MAX_HEAD_BYTES) {
          this.finish('upstream sent no usable response head');
        }
        return;
      }

      socket.off('data', onHeadData);

      const parsedHead = parseHead(head.subarray(0, split).toString('latin1'));
      if (!parsedHead) {
        this.finish('unparseable upstream response head');
        return;
      }

      const { status, fields } = parsedHead;
      const leftover = head.subarray(split + 4);

      if (status >= 300 && status < 400 && fields.location) {
        this.hop(
          fields.location,
          requestUrl,
          redirectsLeft,
          'too many redirects',
        );
        return;
      }

      if (status !== 200) {
        this.finish(`upstream status ${status}`);
        return;
      }

      socket.setTimeout(0);

      this.attachBody(
        socket,
        {
          contentType: normaliseContentType(fields['content-type']),
          metaint: Number(fields['icy-metaint'] ?? 0),
          bitrate: Number(fields['icy-br'] ?? 0),
        },
        leftover,
      );
    };

    socket.on('data', onHeadData);
    socket.on('timeout', () => {
      socket.destroy();
      this.finish('connect timeout');
    });
    socket.on('error', (error: Error) =>
      this.finish(`connect failed: ${errorMessage(error)}`),
    );
    socket.on('close', () => this.finish('upstream closed'));
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

      this.hop(first, requestUrl, redirectsLeft, 'too many playlist hops');
    });

    response.on('error', (error: Error) => {
      this.finish(`playlist read failed: ${errorMessage(error)}`);
    });
  }

  private attachBody(
    body: Readable,
    head: { contentType: string; metaint: number; bitrate: number },
    initial?: Buffer,
  ): void {
    this.body = body;
    this.opened = true;

    const parser = new IcyStreamParser(
      Number.isFinite(head.metaint) ? head.metaint : 0,
      this.handlers.onAudio,
      this.handlers.onTitle,
    );

    this.handlers.onOpen({
      contentType: head.contentType || 'audio/mpeg',
      bitrateKbps:
        Number.isFinite(head.bitrate) && head.bitrate > 0 ? head.bitrate : null,
    });

    this.request?.setTimeout(0);
    this.armStallTimer();

    if (initial?.length) parser.push(initial);

    body.on('data', (chunk: Buffer) => {
      this.armStallTimer();
      parser.push(chunk);
    });

    body.on('end', () => this.finish('upstream ended'));
    body.on('close', () => this.finish('upstream closed'));
    body.on('error', (error: Error) =>
      this.finish(`upstream error: ${errorMessage(error)}`),
    );
  }

  private hop(
    location: string,
    requestUrl: URL,
    redirectsLeft: number,
    exhausted: string,
  ): void {
    if (redirectsLeft <= 0) {
      this.finish(exhausted);
      return;
    }

    this.detachRequest();
    this.socket?.destroy();
    this.socket = null;
    this.open(new URL(location, requestUrl).toString(), redirectsLeft - 1);
  }

  private parse(target: string): URL | null {
    try {
      return new URL(target);
    } catch {
      this.finish(`invalid upstream URL: ${target}`);
      return null;
    }
  }

  private portOf(url: URL): number {
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  }

  private requestHeaders(url: URL): Record<string, string> {
    return {
      Host: url.host,
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Icy-MetaData': '1',
    };
  }

  /** Listeners go first: destroy() emits 'error' after the replacement is live. */
  private detachRequest(): void {
    const previous = this.request;
    this.request = null;
    previous?.removeAllListeners('error');
    previous?.removeAllListeners('timeout');
    previous?.destroy();
  }

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
    this.body?.destroy();
    this.request?.destroy();
    this.socket?.destroy();
    this.handlers.onClose(reason);
  }
}

function normaliseContentType(value: string | undefined): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

function parseHead(
  text: string,
): { status: number; fields: Record<string, string> } | null {
  const [statusLine, ...headerLines] = text.split('\r\n');
  // Matches both `HTTP/1.0 200 OK` and Shoutcast's `ICY 200 OK`.
  const status = Number(/^\S+\s+(\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isFinite(status)) return null;

  const fields: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }

  return { status, fields };
}
