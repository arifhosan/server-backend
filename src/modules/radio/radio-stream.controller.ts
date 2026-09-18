import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  Sse,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Writable } from 'node:stream';
import { Observable, distinctUntilChanged, interval, map } from 'rxjs';
import { errorMessage } from '@/common/utils/error.util';
import { FavouritesService } from './services/favourites.service';
import { StreamHubService } from './services/stream-hub.service';
import { StationStreamState } from './types/station.types';

const SSE_INTERVAL_MS = 2_000;

@Controller('radio')
export class RadioStreamController {
  constructor(
    private readonly hub: StreamHubService,
    private readonly favourites: FavouritesService,
  ) {}

  @Get('stream/:uuid')
  async stream(
    @Param('uuid') uuid: string,
    @Query('raw') raw: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.relay(uuid, raw === '1', request, response);
  }

  @Get('presets/:slot/stream')
  async presetStream(
    @Param('slot', ParseIntPipe) slot: number,
    @Query('raw') raw: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const uuid = await this.favourites.uuidForSlot(slot);
    if (!uuid) throw new NotFoundException(`Preset ${slot} is empty`);

    await this.relay(uuid, raw === '1', request, response);
  }

  @Get('stream/:uuid/now-playing')
  nowPlaying(
    @Param('uuid') uuid: string,
  ): StationStreamState | { uuid: string } {
    return this.hub.state(uuid) ?? { uuid };
  }

  @Sse('stream/:uuid/events')
  events(@Param('uuid') uuid: string): Observable<{ data: string }> {
    return interval(SSE_INTERVAL_MS).pipe(
      map(() => JSON.stringify(this.hub.state(uuid) ?? { uuid })),
      distinctUntilChanged(),
      map((data) => ({ data })),
    );
  }

  private async relay(
    uuid: string,
    rawMode: boolean,
    request: Request,
    response: Response,
  ): Promise<void> {
    const stream = await this.hub.open(uuid).catch((error: unknown) => {
      throw new ServiceUnavailableException(errorMessage(error));
    });

    if (!stream) throw new NotFoundException('Unknown station');

    const sink = rawMode
      ? this.hijack(request, stream.mediaType)
      : this.openResponse(response, stream.mediaType);

    stream.addClient(sink);

    const detach = (): void => this.hub.detach(uuid, sink);
    request.on('close', detach);
    request.on('aborted', detach);
  }

  private openResponse(response: Response, contentType: string): Writable {
    response.socket?.setNoDelay(true);
    response.setTimeout(0);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache',
      'Access-Control-Allow-Origin': '*',
    });

    return response;
  }

  /**
   * ESP32 mode: HTTP/1.0 with no chunked framing, so firmware can read bytes
   * straight off the socket. Writing to it directly is what keeps Express from
   * adding a Transfer-Encoding the decoder would have to unwrap.
   */
  private hijack(request: Request, contentType: string): Writable {
    const socket = request.socket;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.write(
      `HTTP/1.0 200 OK\r\nContent-Type: ${contentType}\r\n` +
        'Cache-Control: no-store\r\nConnection: close\r\n\r\n',
    );

    return socket;
  }
}
