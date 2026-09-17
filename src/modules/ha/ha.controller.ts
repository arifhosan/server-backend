import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import {
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { Agent } from 'https';
import { errorStack } from '@/common/utils/error.util';

axiosRetry(axios, { retries: 3 });

const ASEAG_BASE_URL =
  'http://mova.aseag.de/mbroker/rest/areainformation/publicTransport/sourceSystem';
const CACHE_TTL_MS = 1000 * 60 * 10;

type AseagResponse = Record<string, unknown>;

@Controller('ha')
export class HaController {
  private readonly logger = new Logger(HaController.name);

  // NOTE: kept from the original implementation. The endpoint is plain HTTP so
  // this agent is unused today, but it would disable certificate verification
  // if the host ever redirects to HTTPS. Revisit before relying on it.
  private readonly httpsAgent = new Agent({ rejectUnauthorized: false });

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  @Get('aseag/route/:routeId')
  async getBusInfo(
    @Param('routeId') routeId: string,
  ): Promise<AseagResponse | undefined> {
    const cacheKey = `aseag_route_${routeId}`;

    const cached = await this.cacheManager.get<string>(cacheKey);
    if (cached) {
      return JSON.parse(cached) as AseagResponse;
    }

    try {
      const { data } = await axios.get<AseagResponse>(
        `${ASEAG_BASE_URL}/${routeId}`,
        { httpsAgent: this.httpsAgent },
      );
      await this.cacheManager.set(cacheKey, JSON.stringify(data), CACHE_TTL_MS);
      return data;
    } catch (error: unknown) {
      this.logger.error(
        `ASEAG request failed for route ${routeId}`,
        errorStack(error),
      );
      throw new ServiceUnavailableException('Upstream ASEAG request failed');
    }
  }
}
