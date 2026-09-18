import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import axiosRetry, { exponentialDelay } from 'axios-retry';
import { promises as dns } from 'node:dns';
import { errorMessage } from '@/common/utils/error.util';

const SRV_NAME = '_api._tcp.radio-browser.info';
const UMBRELLA_NAME = 'all.api.radio-browser.info';
const FALLBACK_HOST = 'de1.api.radio-browser.info';

const HOST_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'server-backend-radio/1.0';

@Injectable()
export class RadioBrowserClient {
  private readonly logger = new Logger(RadioBrowserClient.name);
  private readonly http: AxiosInstance;

  private hosts: string[] = [];
  private hostsResolvedAt = 0;
  private pendingResolve: Promise<string[]> | null = null;

  constructor() {
    this.http = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    axiosRetry(this.http, {
      retries: 2,
      retryDelay: exponentialDelay,
      shouldResetTimeout: true,
    });
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const hosts = await this.resolveHosts();
    let lastError: unknown;

    for (const host of hosts) {
      try {
        const response = await this.http.get<T>(
          `https://${host}/json/${path}`,
          {
            params,
          },
        );
        return response.data;
      } catch (error: unknown) {
        lastError = error;
        this.logger.warn(
          `Host ${host} failed for /json/${path}: ${errorMessage(error)}`,
        );
      }
    }

    this.hostsResolvedAt = 0;
    throw new Error(
      `radio-browser /json/${path} failed on every host: ${errorMessage(lastError)}`,
      { cause: lastError },
    );
  }

  /** Upstream counts one click per IP per station per day; never fails playback. */
  reportClick(stationUuid: string): void {
    this.get(`url/${encodeURIComponent(stationUuid)}`).catch(
      (error: unknown) => {
        this.logger.debug(`Click report failed: ${errorMessage(error)}`);
      },
    );
  }

  private async resolveHosts(): Promise<string[]> {
    const fresh = Date.now() - this.hostsResolvedAt < HOST_TTL_MS;
    if (fresh && this.hosts.length > 0) return this.hosts;

    this.pendingResolve ??= this.discover().finally(() => {
      this.pendingResolve = null;
    });

    return this.pendingResolve;
  }

  private async discover(): Promise<string[]> {
    const hosts = (await this.discoverBySrv()) ?? (await this.discoverByName());

    this.hosts = hosts.length > 0 ? shuffle(hosts) : [FALLBACK_HOST];
    this.hostsResolvedAt = Date.now();
    this.logger.log(`radio-browser hosts: ${this.hosts.join(', ')}`);
    return this.hosts;
  }

  private async discoverBySrv(): Promise<string[] | null> {
    try {
      const records = await dns.resolveSrv(SRV_NAME);
      const names = records.map((record) => record.name).filter(Boolean);
      return names.length > 0 ? names : null;
    } catch (error: unknown) {
      this.logger.debug(`SRV discovery failed: ${errorMessage(error)}`);
      return null;
    }
  }

  private async discoverByName(): Promise<string[]> {
    try {
      const addresses = await dns.resolve4(UMBRELLA_NAME);
      return addresses.length > 0 ? [UMBRELLA_NAME] : [FALLBACK_HOST];
    } catch (error: unknown) {
      this.logger.warn(`DNS discovery failed: ${errorMessage(error)}`);
      return [FALLBACK_HOST];
    }
  }
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
