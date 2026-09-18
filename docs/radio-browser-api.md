# Radio Browser API — Integration Reference

Probed live against `de1.api.radio-browser.info` on 2026-09-18. No OpenAPI spec is
published, so types have to be hand-written.

## At a glance

No key, no signup, no quota — the API is open and anonymous.

| Property | Value |
| --- | --- |
| Auth | None |
| Base URL | Discovered via DNS, never hardcoded |
| Formats | `/json/`, `/xml/`, `/csv/` (languages only), `/m3u/`, `/pls/` |
| Methods | `GET` with query params, or `POST` with a JSON **or** form-encoded body — all three verified |
| CORS | `Access-Control-Allow-Origin: *`, methods `GET,POST` |
| Compression | None — no `Content-Encoding` even when requested |
| Server | `tiny-http` (Rust), software `0.7.45`, `supported_version: 1` |
| Licence | Station data public domain; software GPL. "No guarantee to work" |

Catalogue scale from [`/json/stats`](https://de1.api.radio-browser.info/json/stats):
58,361 stations (6,713 flagged broken), 12,261 tags, 663 languages, 241 countries.

## Server discovery

There is no stable base URL. The documented flow is a DNS lookup:

- A/AAAA on `all.api.radio-browser.info` → mirror IPs
- or SRV on `_api._tcp.radio-browser.info` → mirror hostnames and port

**Both currently resolve to exactly one host: `de1.api.radio-browser.info`**
(`91.98.4.78`, `2a01:4f8:1c1d:699::1`, Hetzner Falkenstein). `/json/servers` agrees —
it returns only de1's v4 and v6 addresses. The old `nl1`/`at1`/`fr1` mirrors are gone.

So the docs' "randomise the list, fail over to the next entry" advice is a no-op today.
Keep the discovery and failover code anyway: it is the only mechanism that will pick up
new mirrors, and until one appears this is a single point of failure. Resolve at boot,
cache the result, refresh periodically.

## Endpoints

### Advanced search — the one that matters

`/json/stations/search`. Every other station endpoint is a shortcut for it.

| Group | Parameters |
| --- | --- |
| Filters | `name`, `country`, `countrycode`, `state`, `language`, `tag`, `tagList` (comma-separated, AND), `codec` |
| Exact toggles | `nameExact`, `countryExact`, `stateExact`, `languageExact`, `tagExact` (default `false`) |
| Bitrate | `bitrateMin` (0), `bitrateMax` (1000000), in kbps |
| Flags | `is_https`, `has_geo_info`, `has_extended_info` — each unset / `true` / `false` |
| Geo | `geo_lat`, `geo_long`, `geo_distance` (metres) |
| Paging | `offset` (0), `limit` (**default 100000 — always set it**) |
| Sorting | `order` (default `name`), `reverse` (`false`), `hidebroken` (`false`) |

`order` accepts: `name`, `url`, `homepage`, `favicon`, `tags`, `country`, `state`,
`language`, `votes`, `codec`, `bitrate`, `lastcheckok`, `lastchecktime`,
`clicktimestamp`, `clickcount`, `clicktrend`, `changetimestamp`, `random`.

### Everything else

| Endpoint | Notes |
| --- | --- |
| `/json/stations/byuuid` | `uuids` = comma-separated. Batch resolve; use over N single lookups |
| `/json/stations/byurl` | `url` mandatory |
| `/json/stations/topvote`, `topclick`, `lastclick`, `lastchange` (`/{rowcount}`) | Ready-made rankings; take `offset`, `limit`, `hidebroken` |
| `/json/stations/bytag`, `byname`, `bycountrycodeexact`, `bycodec`, `bystate`, `bylanguage` (`/{term}`) | Path-based shortcuts, plus `...exact` variants |
| `/json/stations/changed` | `lastchangeuuid`, `limit` — incremental sync feed |
| `/json/stations/broken/{rowcount}` | `offset`, `limit` |
| `/json/tags`, `/json/countries`, `/json/languages`, `/json/codecs` | Facet lists: `order` (`name` or `stationcount`), `reverse`, `hidebroken`, `offset`, `limit` |
| `/json/states/{country}/{filter}` | Same params plus a `country` filter |
| `/json/checks`, `/json/clicks` | `stationuuid`, `lastcheckuuid`/`lastclickuuid`, `seconds`, `limit` |
| `/json/checksteps` | `uuids` mandatory |
| `/json/streamingservers` | `hidebroken` |
| `/json/stats`, `/json/config`, `/json/servers` | Server info |
| `/metrics` | Prometheus exporter |

### Mutations

| Endpoint | Behaviour |
| --- | --- |
| `/json/url/{stationuuid}` | Call when playback starts. Bumps the click counter, returns the stream URL. Counted once per IP per station per 24 h |
| `/json/vote/{stationuuid}` | Once per IP per station per 10 minutes |
| `/json/add` | Submit a station. `name` (≤400 chars) and `url` required; optional `homepage`, `favicon`, `countrycode`, `iso_3166_2`, `languagecodes`, `tags`, `geo_lat`, `geo_long` |

## The station object

`stationuuid`, `changeuuid`, `serveruuid`, `name`, `url`, `url_resolved`, `homepage`,
`favicon`, `tags`, `country`, `countrycode`, `state`, `iso_3166_2`, `language`,
`languagecodes`, `votes`, `codec`, `bitrate`, `hls` (0|1), `lastcheckok` (0|1),
`ssl_error`, `clickcount`, `clicktrend`, `geo_lat`, `geo_long`, `geo_distance`,
`has_extended_info`, plus `lastchangetime`, `lastchecktime`, `lastcheckoktime`,
`lastlocalchecktime` and `clicktimestamp` — each in both `"YYYY-MM-DD HH:mm:ss"` and
`_iso8601` form.

Gotchas, from a real record:

- **`bitrate` is kbps, not bps** as the docs claim (sample: MP3 at `128`).
- `tags`, `language` and `languagecodes` are **single comma-joined strings**, not
  arrays — split them yourself. Tags are free-form and lowercase.
- **Play `url_resolved`, not `url`.** `url` is what the submitter typed;
  `url_resolved` is what the checker actually followed.
- `geo_lat`/`geo_long` are frequently `null`. Filter with `has_geo_info=true` if you
  need them.
- `serveruuid` appears in responses but is absent from the documented field table.
- `country` and `id` are deprecated → use `countrycode` (ISO 3166-1 alpha-2) and
  `stationuuid`.
- Some fields that were strings in the legacy API now return numbers or booleans.

## Errors and rate limiting

- Unknown path → `404`.
- **Malformed UUID → `200` with `[]`**, not an error. Same response as "no matches", so
  you cannot tell bad input from an empty result. Validate UUIDs before sending.
- 20 rapid sequential requests all returned `200`. No rate limiting is documented or
  observed, and there are no quota or `Retry-After` headers to back off on. That is not
  a licence to hammer it — this is one volunteer-run box.
- The `User-Agent` header (`appname/version`) is requested but **not enforced** — an
  empty UA still returns `200`. Send it anyway: it is how the maintainer sees who uses
  the service, and the only thing they explicitly ask for.

## Freshness ceiling

From [`/json/config`](https://de1.api.radio-browser.info/json/config):

| Setting | Value | Meaning |
| --- | --- | --- |
| `cache_type` / `cache_ttl` | redis / 600 s | Server-side response cache |
| `update_caches_interval_seconds` | 120 | How often derived caches refresh |
| `click_valid_timeout_seconds` | 86400 | Click dedup window |
| `checks_timeout_seconds` | 1209600 | Check history retention (14 days) |
| `broken_stations_never_working_timeout_seconds` | 1728000 | 20 days before a never-working station is dropped |

**Polling faster than about two minutes gains nothing.**

## Fitting it into this backend

The existing dependencies already cover it: `axios` + `axios-retry`,
`@nestjs/cache-manager`, `@nestjs/schedule`. A `src/modules/radio` module following the
self-contained pattern from `4aefd0c` would want:

1. A resolver service that does the DNS / `/json/servers` lookup at boot, caches the
   host, and retries against the next candidate on failure.
2. A hardcoded `de1.api.radio-browser.info` fallback for when DNS is unavailable — a
   container without a working resolver, for instance.
3. `User-Agent` set once on the axios instance.
4. Aggressive caching. A 600 s TTL matching theirs is the natural floor; facet lists
   (tags, countries, languages) can cache for hours.
5. `hidebroken=true` and an explicit `limit` on every station query, or you pull all
   58k records uncompressed.

Two notes on shape:

- CORS is wide open, so a proxy here is for caching, UA hygiene and shielding a fragile
  upstream — **not** for browser access, which works directly.
- To mirror the catalogue locally rather than proxy, use `/json/stations/changed` with
  `lastchangeuuid` for incremental sync instead of re-pulling the full dump.

## Sources

- [api.radio-browser.info](https://api.radio-browser.info/) — server discovery and etiquette
- [de1.api.radio-browser.info](https://de1.api.radio-browser.info/) — full endpoint and field reference
- [docs.radio-browser.info](https://docs.radio-browser.info/) — throttling rules, click/vote semantics
- [radio-browser.info](https://www.radio-browser.info/) — project and licence
