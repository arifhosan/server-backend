import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { VoiceGateway } from './gateway/voice.gateway';
import { VoiceConfig } from './voice.config';

interface OtaResponse {
  server_time: { timestamp: number; timezone_offset: number };
  firmware: { version: string; url: string };
  websocket: { url: string; token?: string; version: number };
  activation: null;
}

@Controller('voice')
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private readonly config: VoiceConfig,
    private readonly gateway: VoiceGateway,
  ) {}

  /**
   * First call a device makes on boot. Mirrors the xiaozhi OTA contract: the
   * body is whatever the firmware reports, the response tells it where to
   * connect. Deliberately untyped so unknown board fields are not rejected.
   */
  @Post('ota')
  @HttpCode(200)
  getDeviceConfig(
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
  ): OtaResponse {
    this.logger.log(
      `OTA check-in from ${request.get('device-id') ?? 'unknown'}: ${JSON.stringify(body)}`,
    );

    return {
      server_time: {
        timestamp: Date.now(),
        timezone_offset: -new Date().getTimezoneOffset(),
      },
      firmware: { version: '1.0.0', url: '' },
      websocket: {
        url: this.websocketUrl(request),
        token: this.config.authToken,
        version: 1,
      },
      activation: null,
    };
  }

  @Get('health')
  getHealth(): Record<string, unknown> {
    return {
      status: 'ok',
      sessions: this.gateway.sessionCount,
      ws_path: this.config.wsPath,
      downlink_sample_rate: this.config.downlinkSampleRate,
      model: this.config.model,
      tts_engine: this.config.ttsEngine,
    };
  }

  @Get('client')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getTestClient(): string {
    return readFileSync(join(__dirname, 'public', 'tester.html'), 'utf8');
  }

  private websocketUrl(request: Request): string {
    if (this.config.publicWsUrl) return this.config.publicWsUrl;

    const forwarded = request.headers['x-forwarded-proto'];
    const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const scheme = (proto ?? request.protocol) === 'https' ? 'wss' : 'ws';
    return `${scheme}://${request.get('host') ?? 'localhost'}${this.config.wsPath}`;
  }
}
