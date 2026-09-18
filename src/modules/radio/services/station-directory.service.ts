import { Injectable } from '@nestjs/common';
import { RadioBrowserClient } from '../radio-browser/radio-browser.client';
import { SearchStationsDto } from '../dto/search-stations.dto';
import {
  RadioBrowserNameCount,
  RadioBrowserStation,
  StationSummary,
} from '../types/station.types';
import { TtlCache } from '../utils/ttl-cache';

const STATION_TTL_MS = 10 * 60 * 1000;
const FACET_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_LIMIT = 200;
const MIN_TAG_STATIONS = 20;
const MAX_TAGS = 300;

export interface ResolvedStation {
  summary: StationSummary;
  urls: string[];
}

@Injectable()
export class StationDirectoryService {
  private readonly stations = new TtlCache<ResolvedStation>(STATION_TTL_MS);
  private readonly facets = new TtlCache<RadioBrowserNameCount[]>(
    FACET_TTL_MS,
    16,
  );

  constructor(private readonly client: RadioBrowserClient) {}

  async search(query: SearchStationsDto): Promise<StationSummary[]> {
    const params: Record<string, string | number> = {
      limit: Math.min(query.limit ?? 50, MAX_LIMIT),
      offset: query.offset ?? 0,
      order: query.order ?? 'votes',
      reverse: query.order === 'name' ? 'false' : 'true',
      hidebroken: 'true',
    };

    if (query.q) params.name = query.q;
    if (query.tag) params.tag = query.tag;
    if (query.codec) params.codec = query.codec;

    if (query.country) {
      const isIsoCode = /^[a-z]{2}$/i.test(query.country);
      if (isIsoCode) params.countrycode = query.country.toUpperCase();
      else params.country = query.country;
    }

    const stations = query.city
      ? await this.searchByCity(params, query.city)
      : await this.fetchStations(params);

    return stations.map((station) => this.cacheAndSummarise(station));
  }

  /** Upstream has no city field, so match the region and the name, then merge. */
  private async searchByCity(
    base: Record<string, string | number>,
    city: string,
  ): Promise<RadioBrowserStation[]> {
    const [byState, byName] = await Promise.all([
      this.fetchStations({ ...base, state: city }),
      this.fetchStations({ ...base, name: city }),
    ]);

    const merged = new Map<string, RadioBrowserStation>();
    for (const station of [...byState, ...byName]) {
      merged.set(station.stationuuid, station);
    }

    return [...merged.values()].sort((a, b) => b.votes - a.votes);
  }

  private async fetchStations(
    params: Record<string, string | number>,
  ): Promise<RadioBrowserStation[]> {
    const stations = await this.client.get<RadioBrowserStation[]>(
      'stations/search',
      params,
    );

    // HLS is a segment playlist, not a byte stream the proxy can relay.
    return stations.filter((station) => station.hls !== 1);
  }

  async getStation(uuid: string): Promise<ResolvedStation | null> {
    const cached = this.stations.get(uuid);
    if (cached) return cached;

    const stations = await this.client.get<RadioBrowserStation[]>(
      'stations/byuuid',
      { uuids: uuid },
    );

    // Upstream returns 200 with [] for unknown and malformed uuids alike.
    const [station] = stations;
    if (!station) return null;

    this.cacheAndSummarise(station);
    return this.stations.get(uuid) ?? null;
  }

  countries(): Promise<RadioBrowserNameCount[]> {
    return this.facet('countries');
  }

  async tags(): Promise<RadioBrowserNameCount[]> {
    const tags = await this.facet('tags');
    return tags
      .filter((tag) => tag.stationcount >= MIN_TAG_STATIONS)
      .slice(0, MAX_TAGS);
  }

  reportClick(uuid: string): void {
    this.client.reportClick(uuid);
  }

  private async facet(name: string): Promise<RadioBrowserNameCount[]> {
    const cached = this.facets.get(name);
    if (cached) return cached;

    const values = await this.client.get<RadioBrowserNameCount[]>(name, {
      order: 'stationcount',
      reverse: 'true',
      hidebroken: 'true',
    });

    const usable = values.filter((value) => value.name.trim().length > 0);
    this.facets.set(name, usable);
    return usable;
  }

  private cacheAndSummarise(station: RadioBrowserStation): StationSummary {
    const summary: StationSummary = {
      uuid: station.stationuuid,
      name: station.name.trim(),
      country: station.country,
      countryCode: station.countrycode,
      state: station.state,
      tags: station.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      codec: station.codec,
      bitrate: station.bitrate,
      votes: station.votes,
      homepage: station.homepage,
      favicon: station.favicon,
      stream: `/radio/stream/${station.stationuuid}`,
    };

    // url_resolved is what the upstream checker followed; url is the fallback.
    const urls = [station.url_resolved, station.url]
      .map((url) => url?.trim())
      .filter((url): url is string => Boolean(url));

    this.stations.set(summary.uuid, { summary, urls: [...new Set(urls)] });
    return summary;
  }
}
