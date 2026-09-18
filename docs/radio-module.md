# Radio module

A local player for internet radio, backed by the radio-browser directory. Search
by name, country or city in the browser, pick a station, and it plays without
needing a reload when the upstream stream drops.

Open `http://localhost:3000/radio`.

## Why it proxies the audio

A browser `<audio>` element pointed straight at an Icecast or Shoutcast stream
has no recovery path. One TCP blip and the element fires `error` or `ended`, and
playback is dead until the page reloads. That is the problem this module solves.

So the server owns the upstream connection:

```
station --> UpstreamConnection --> StationStream --> your browser
                  (reconnects)      (stays open)     (never notices)
```

`StationStream` keeps every listener's HTTP response open across upstream
failures. When the station drops, the server reconnects behind the still-open
response and keeps writing into it. The player sees a short silence rather than
end-of-stream, and because Icecast bursts a few seconds of audio on connect, a
sub-second reconnect is usually inaudible.

Proxying also buys:

- **No mixed content.** An `http://` station plays on an `https://` page.
- **No CORS problems.** The stream is same-origin.
- **One upstream per station**, fanned out to every listener.
- **ICY metadata stripped**, so no client has to parse it.
- **Plain HTTP for the ESP32**, with TLS terminated here.

Measured against a live 128 kbps station: a 255 KB burst on connect, then a
steady 16 KB/s. A listener that falls more than 2 MB behind is dropped rather
than buffered, which is roughly two minutes of audio at that rate.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/radio` | The player UI |
| GET | `/radio/stations/search` | `q`, `country`, `city`, `tag`, `codec`, `order`, `limit`, `offset` |
| GET | `/radio/stations/:uuid` | One station |
| GET | `/radio/countries` | Country facets with station counts |
| GET | `/radio/tags` | Genre facets, trimmed to useful ones |
| GET | `/radio/active` | Streams currently being served |
| GET | `/radio/stream/:uuid` | The audio. Add `?raw=1` for ESP32 mode |
| GET | `/radio/stream/:uuid/now-playing` | Current track as JSON |
| GET | `/radio/stream/:uuid/events` | Same, as SSE |
| GET | `/radio/presets` | Preset list |
| POST | `/radio/presets` | `{ stationUuid, name?, slot? }` |
| DELETE | `/radio/presets/:uuid` | Remove a preset |
| GET | `/radio/presets/:slot/stream` | Audio for a preset slot |

## ESP32-S3

Firmware needs one URL and no JSON:

```
http://<server>:3000/radio/presets/1/stream?raw=1
```

`?raw=1` answers `HTTP/1.0 200 OK` with `Connection: close` and **no chunked
transfer encoding**, so the decoder reads audio straight off the socket. ICY
metadata is already stripped, TLS is already terminated, redirects and
`.pls`/`.m3u` indirection are already resolved. Presets are set from the browser,
so the device never has to search.

Pin stations to MP3 when filling presets (`codec=MP3` in search); the bitrate
shown in the UI is what the decoder will see.

Poll `/radio/stream/:uuid/now-playing` for a display, or skip it entirely.

## Presets table

Favourites are stored with TypeORM, so the table has to exist. Either boot once
with `DB_SYNC=true`, or create it:

```sql
CREATE TABLE favourite_station (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  stationUuid  VARCHAR(36)  NOT NULL UNIQUE,
  name         VARCHAR(255) NOT NULL,
  countryCode  VARCHAR(255) NOT NULL DEFAULT '',
  slot         INT          NOT NULL UNIQUE,
  createdAt    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Search and playback do not touch the database. If the table is missing, only
presets fail and the UI hides them.

## Known limits

- **HLS stations are excluded.** They are a segment playlist, not a byte stream
  the proxy can relay, so they are filtered out of search rather than offered
  and left silent.
- **City search is synthesised.** radio-browser has no city field, so `city`
  matches the region and the station name and merges the results.
- **Shoutcast v1 costs an extra connection.** Those servers answer `ICY 200 OK`,
  which Node's HTTP parser rejects even with `insecureHTTPParser`, so the first
  attempt fails and a raw-socket attempt follows.
- **A station down for over three minutes** ends client responses, letting the
  browser watchdog and the device retry from scratch.

See `docs/radio-browser-api.md` for the upstream API itself.
