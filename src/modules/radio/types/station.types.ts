export interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  homepage: string;
  favicon: string;
  tags: string;
  country: string;
  countrycode: string;
  state: string;
  language: string;
  votes: number;
  codec: string;
  /** Documented as bps upstream, actually kbps. */
  bitrate: number;
  hls: number;
  lastcheckok: number;
  clickcount: number;
}

export interface RadioBrowserNameCount {
  name: string;
  stationcount: number;
}

export interface StationSummary {
  uuid: string;
  name: string;
  country: string;
  countryCode: string;
  state: string;
  tags: string[];
  codec: string;
  bitrate: number;
  votes: number;
  homepage: string;
  favicon: string;
  stream: string;
}

export interface StationStreamState {
  uuid: string;
  name: string;
  title: string | null;
  connected: boolean;
  listeners: number;
  reconnects: number;
  contentType: string;
}
