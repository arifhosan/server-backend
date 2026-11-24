# Game Tracker: design

Status: draft for approval · 2026-11-24

## 1. Intent

Playtime tracking today is one nightly Puppeteer scrape of an Exophase profile,
shown in Grafana. It is late (Exophase syncs platforms on its own schedule, and
one 23:00 UTC snapshot dates all play to the scrape day) and it is broken:
since 2026-11-23 Cloudflare answers the server with a 403 challenge, the scraper
extracts 0 games, and nothing notices.

The owner plays mostly **PC games** (Steam and the Xbox app on Windows; there is
no Xbox console) and some **PS5/PS4**. In the last 180 days: Steam 384 h,
PS5 20 h, "Xbox Series" (PC Xbox-app titles) 16 h, PS4 7 h.

Replace it with a small product:

1. **Tracker**: a minimal desktop app on each gaming PC that sees which game is
   running and reports play sessions as they happen.
2. **Backend**: the existing NestJS API gains accounts-with-devices, ingests
   tracker sessions, and pulls Steam and PSN directly.
3. **Dashboard**: a web app replacing the Grafana game dashboards: login,
   devices, connections (Steam/PSN), and the playtime views.

The owner wants all three platform families covered, same-day accuracy, history
over years, and no silent failures. Logins that need periodic manual renewal
are acceptable only where the platform gives no alternative (PSN), and then
with advance warning.

## 2. Goals, non-goals, anti-goals

**Goals**
- Per-day playtime that is right on the day it happened, per game, per platform.
- Every data source reports its health; a failed or empty run is visible in the
  dashboard, never silently recorded as "no play".
- Install the tracker on several PCs; each gets its own revocable token, created
  in the dashboard and pasted into the tracker.
- Each user configures their own Steam profile and PSN token in the dashboard.
- Keep all existing history (since 2025-04-28) and attach it to the owner.

**Non-goals (for now)**
- Xbox Live API. The tracker covers Xbox-app play on PC. Xbox console play is
  not a use case.
- Exophase. Switched off and removed; its history is migrated.
- Achievements/trophies, social features, public profiles.
- Health and Expenses dashboards; they stay on Grafana.
- macOS/Linux tracker builds. Windows only.
- Push notifications (Telegram, email). Status lives in the dashboard first.
- Idle/AFK detection. A running game counts, like Steam counts it.

**Anti-goals** (failure even if it technically works)
- A tracker that is heavy, noisy or needs babysitting. It must be a tray icon
  you forget about.
- Double counting the same play from two sources (tracker and Steam).
- Storing or logging third-party tokens in plain text.
- A dashboard that shows zero when the truth is "we don't know".

## 3. Constraints from the existing system

- Repo `ArifHosan/server-backend`, NestJS 12 + TypeORM + MySQL (`api_db` on
  10.0.1.194). Node 24, ESM. CI builds an ARM64 image to GHCR on push to
  `master`; Portainer runs it behind Traefik at `api.server.arifhosan.me`.
- **Modules must not import each other** (`boundaries/no-cross-module-import`).
  Cross-cutting code goes in `src/common` or `src/database`.
- `DB_SYNC` is false in production. Tables are created by hand from SQL kept in
  `docs/`. Follow that convention.
- `auth` module: `POST /auth/register` (open), `POST /auth/login` (returns a
  1-day JWT in the body), `GET /auth/verify`. `JwtStrategy` exists but nothing
  uses a guard yet. One user row exists (the owner).
- `main.ts` enables CORS with `origin: true` (reflects any origin).
- Server is Oracle ARM, 3 cores, 17 GB, disk 65% used. Removing Puppeteer and
  Chromium from the image is a welcome side effect.
- Steam: a server-side Steam Web API key reads `GetOwnedGames` for a SteamID
  only if that profile's game details are public.
- PSN: unofficial `psn-api` library. A user-pasted NPSSO is exchanged for access
  and refresh tokens; the refresh token lasts about 2 months, then a new NPSSO
  is needed. `getUserPlayedGames` returns per-title `playDuration` (ISO 8601
  duration, 1 s precision) and `category` (`ps4_game`, `ps5_native_game`, ...).
  PS4 and PS5 copies are separate entries.

## 4. Approaches considered

**Where the product lives**
- **A. Extend the existing NestJS backend + a separate static web frontend.**
  Chosen. Auth, DB, deploy and module structure already exist.
- B. New Next.js app for dashboard and game API. Rejected: rebuilds auth, two
  backends writing the same tables.
- C. New standalone game service. Rejected: another deploy and shared auth for
  no gain at this scale.

**Tracker technology**
- PowerShell script + Task Scheduler. Smallest, but no UI, and the owner wants a
  UI with a token setting.
- Pure Rust UI (egui/iced). Smaller binary, but installer, autostart and
  auto-update would be hand-built.
- **Tauri v2 (Rust core, tiny web UI).** Chosen. Tray icon, autostart, Windows
  installer and updater come with it; multiple-machine installs need exactly
  those.

**Data collection**
- Exophase from a home IP: no logins, but laggy and fragile. Dropped.
- **Tracker for PC + Steam API + PSN API.** Chosen. Tracker gives exact sessions
  for every PC store; Steam API fills gaps when the tracker was off; PSN is the
  only route to console play.

## 5. System overview

```
 Gaming PC(s)                         Server (Traefik)
 ┌──────────────┐  heartbeats   ┌──────────────────────────────┐
 │ Tracker      │ ────────────▶ │ games.server.arifhosan.me    │
 │ (Tauri)      │  device token │   /api/*  → backend (Nest)   │──▶ MySQL api_db
 └──────────────┘               │   /*      → dashboard (static)│
                                └──────────────────────────────┘
                                   backend cron: Steam API, PSN API
```

Dashboard and API share one origin (`games.server.arifhosan.me`; Traefik routes
`/api` to the existing backend container with the prefix stripped, everything
else to a static nginx container). Same origin means an httpOnly session cookie
with no CORS or cross-site cookie handling. The existing `api.server.arifhosan.me`
host stays as it is for the other modules and the tracker may use either host.

## 6. Backend

### 6.1 Auth changes

- Move the JWT check into `src/common/auth/`: `JwtAuthGuard`, a `@CurrentUser()`
  decorator, and the payload types. `auth` keeps issuing; any module can guard.
- Login sets an httpOnly, Secure, `SameSite=Strict` cookie `session` holding the
  JWT (30 days). It still returns the JWT in the body for non-browser clients.
  The guard accepts the cookie or a Bearer header.
- New `POST /auth/logout` (clears cookie) and `GET /auth/me` (public user).
- Registration stays open to anyone (owner's decision). Users who register
  accept that their Steam/PSN details are stored on this server.
- Rate-limit `POST /auth/login` and `POST /auth/register` per IP (e.g. 10/min).
- Keep `GET /auth/verify` for existing callers.
- CORS: keep `origin: true` for the public read routes other projects use, but
  never allow credentials. Cookie routes are same-origin only.

### 6.2 New module: `games`

One module (sub-folders, not sibling modules, because they share entities and
modules cannot import each other):

```
src/modules/games/
  devices/      create, list, rename, revoke; DeviceAuthGuard
  tracker/      heartbeat ingest, now-playing
  connections/  steam + psn config, test, status
  sync/         steam.sync.ts, psn.sync.ts, scheduler, run lock
  library/      games and totals
  stats/        read endpoints for the dashboard
  legacy/       one-off import of Exophase-era data
  entities/  dto/  utils/
```

All routes except tracker ingest use `JwtAuthGuard` and are scoped to the
current user. Every query filters by `userId`.

### 6.3 Data model

All times UTC, durations in **seconds** (the old `…Ms` columns held seconds).

`device`
- id, userId, name, tokenHash (sha256, unique), tokenPrefix (first 6 chars for
  display), createdAt, lastSeenAt, revokedAt (nullable)

`connection`
- id, userId, provider (`steam` | `psn`), unique (userId, provider)
- externalId (SteamID64 / PSN accountId), displayName
- secret (encrypted JSON blob: PSN access/refresh tokens; empty for Steam)
- secretExpiresAt (PSN refresh-token expiry)
- status (`ok` | `expiring` | `expired` | `failing` | `disabled`), lastSyncAt,
  lastSuccessAt, lastError, lastGameCount

`library_game`: one row per user per platform title
- id, userId, platform (`steam` | `xbox_pc` | `epic` | `pc_other` | `ps5` |
  `ps4`), externalId (Steam appid, PSN titleId, Xbox package name, or folder
  key), title, titleKey (normalised title used to group the same game across
  platforms), totalSeconds (platform-reported total, if any), lastPlayedAt
- unique (userId, platform, externalId)

`play_session`
- id, userId, libraryGameId, source (`tracker` | `steam` | `psn` | `exophase` |
  `import`), deviceId (tracker only), startedAt, endedAt, seconds
- index (userId, startedAt)

`sync_run`
- id, connectionId, startedAt, finishedAt, ok, gameCount, error
- Kept 90 days. Feeds the health banner and gap marking.

`play_session` is the one table every chart reads. Platform pulls turn total
deltas into sessions whose window is (previous successful sync, this sync).

**What "total" means**
- Charts and per-day numbers: sum of `play_session` (excluding `import`).
- A game's total in Library/Game detail: the platform-reported
  `library_game.totalSeconds` when the platform reports one (matches what Steam
  and PSN show, includes play before 2025-04-28); otherwise the sum of its
  sessions (tracker-only stores: xbox_pc, epic, pc_other).

**Windows longer than a day** (sync outage, the old ~24 h Exophase windows): a
session is split evenly across the calendar days it spans when charting, and
those days are flagged "estimated". Days with no successful run for a source
are flagged "unknown" for that source, never shown as zero.

### 6.4 Device tokens

- `POST /games/devices {name}` returns the token once:
  `gt_` + 32 random bytes base64url. Only the sha256 hash is stored.
- `DeviceAuthGuard` hashes the Bearer value, looks up a non-revoked device,
  updates `lastSeenAt`, and attaches `{userId, deviceId}`.
- Revoke sets `revokedAt`; the tracker then gets 401 and shows "token revoked".

### 6.5 Tracker ingest

`POST /games/tracker/heartbeats` (DeviceAuthGuard), batch body:

```json
{ "heartbeats": [
  { "at": "2026-11-24T20:15:00Z",
    "game": { "store": "steam", "storeId": "1091500",
              "title": "Cyberpunk 2077", "exe": "Cyberpunk2077.exe" } }
] }
```

- The tracker sends one heartbeat per running game every 60 s; offline
  heartbeats arrive later in batches, oldest first.
- Merge rule: a heartbeat at `t` for (device, game) extends the latest session
  if `t - endedAt <= 180 s`, else starts a new session at `t - 60 s`. Re-sent
  heartbeats inside an existing session change nothing (idempotent).
- Upserts `library_game` by (userId, platform from store, storeId or folder key).
- Rejects `at` more than 5 min in the future or older than 30 days.
- `GET /games/now` (JWT): games with a heartbeat in the last 2 minutes, per
  device, with session start.

### 6.6 Platform sync

Common rules:
- Cron every hour per enabled connection, plus `POST /games/connections/:provider/sync`
  for a manual run. One run at a time per connection (in-process lock; one
  backend replica).
  `// ponytail: in-process lock; move to a DB lock if the backend ever runs >1 replica`
- A run that throws, or returns 0 titles when the last success returned more,
  is a **failure**: status `failing`, `lastError` set, no sessions written.
- On success: per title, `delta = reportedTotal - library_game.totalSeconds`.
  `delta > 0` writes a session (window = previous success → now) and updates
  the total. `delta <= 0` updates nothing. A title with no prior total only
  sets its baseline and writes no session (avoids the 5,756 h first-day spike
  again; its time is still in the total).
- A delta larger than its window (late platform syncs, like the 36 h of one
  game on 2026-11-04) is written as an `import` session: kept and counted in
  totals, left out of daily charts. Nothing is discarded.
- **First sync of the owner's connections** matches each platform title to an
  imported legacy row (same platform, same `titleKey`) and adopts it: the row
  gets the real externalId, and the legacy total is the baseline. The play
  since the scraper broke (2026-11-21 → first sync) is therefore recovered as
  one catch-up session. Unmatched legacy rows stay as they are.

Steam:
- Server env `STEAM_API_KEY`. User enters a profile URL, vanity name or
  SteamID64; vanity names resolve via `ResolveVanityURL`.
- `IPlayerService/GetOwnedGames` with `include_appinfo=1`,
  `include_played_free_games=1`. `playtime_forever` is minutes, so convert.
- **Dedup with the tracker:** Steam often raises `playtime_forever` late (at
  game exit), so overlap checks are unreliable. Instead, per appid keep
  `library_game.totalChangedAt` (when Steam's total last moved). On a delta,
  `remainder = delta - trackerSeconds(appid, since totalChangedAt)`. Write a
  Steam session only for `remainder > 5 min` (play the tracker missed: PC off,
  tracker not installed). Totals always update.
- "Test connection" fails with a clear message when the profile's game details
  are private.

PSN:
- Measured by other projects (Sony documents none of it): access token ~1 h,
  refresh token **~10 days fixed** from the NPSSO exchange, NPSSO **~60 days
  from sign-in**; none is extended by use. Signing out of PSN kills the NPSSO
  early. A refused exchange may not throw, so results are checked explicitly.
- User pastes an NPSSO (or the tracker supplies one, section 7). Backend keeps
  the **NPSSO and the tokens, sealed**. `secretExpiresAt` = NPSSO expiry
  (60 days after it was supplied), the real limit.
- Each run: refresh the access token when needed; when the refresh token has
  < 3 days left, exchange the stored NPSSO again for a fresh 10-day refresh
  token. Only a rejected NPSSO needs the user.
- Status `expiring` 14 days before `secretExpiresAt`, `expired` after or when
  Sony rejects the NPSSO. The dashboard shows the countdown and a renew button.
- `getUserPlayedGames` (paginate all). Parse `playDuration`. Platform from
  `category`: `ps5_native_game` → ps5, `ps4_game` → ps4, else ps5.

### 6.7 Secrets

- AES-256-GCM with `GAMES_SECRET_KEY` (32 bytes, base64, env). The app refuses
  to start the games module without it, matching `requireJwtSecret`.
- Secrets never appear in responses or logs. The API returns status, display
  name and expiry only.

### 6.8 Read API for the dashboard

- `GET /games/overview`: today, this week, last week, 30-day daily totals, top
  games (30 d), now playing, connection/device health.
- `GET /games/sessions?from&to&game&platform`
- `GET /games/library?platform&q`: grouped by titleKey with per-platform totals.
- `GET /games/library/:id`: totals, sessions, daily series.
- `GET /games/calendar?year`: seconds per day for a heatmap.
- Day boundaries use the user's timezone (`user.timezone`, default
  `Europe/Berlin`, new column on `user`).

### 6.9 Legacy data and removal of the scraper

- A one-off import attaches existing data to the owner's user id:
  - `total_game_time` → `library_game` (map platform strings: Steam → steam,
    PS5 → ps5, PS4 → ps4, Xbox Series/Xbox One/Windows/Windows 10 → xbox_pc,
    Ubisoft → pc_other).
  - `game` rows → `play_session` with source `exophase`, window = previous
    nightly run → that row's `createdAt`.
  - Rows from the 2025-04-28/29 baseline import → source `import`, excluded
    from daily charts but counted in totals.
  - Any other legacy session longer than its window (e.g. 36 h of one game in
    the 2026-11-04 run) is also marked `import`: late platform syncs, not play.
  - `game_old` (49 rows of pre-launch test runs, 2025-04-25 to 04-29) →
    `play_session` with source `import`: preserved and queryable, but not
    counted, because the 2025-04-29 baseline already covers those totals.
  - `playtime` (daily sums) is not converted: it is derived from `game`, and
    every one of its rows stays in the archive below. 8 of its 366 days
    disagree with the sum of `game` for that date; the import report lists
    them.
  - `game.link` is empty in every row, so titles are the only legacy match key.
- **No game data is lost.** The import is checked before anything else
  changes, and the import fails if any check fails:
  - row counts: `game` + `game_old` rows = legacy `play_session` rows;
    `total_game_time` rows = legacy `library_game` rows;
  - sums: total seconds per source and per title match the old tables exactly;
  - the import is idempotent (re-running it changes nothing).
- The old tables are **never dropped**. After the Grafana game dashboards are
  retired they are renamed to `archive_game`, `archive_total_game_time`,
  `archive_playtime`, `archive_game_old` and kept read-only. A `mysqldump` of
  the four tables is taken before the import as well.
- The legacy import runs **before** the first platform sync (see build order).
- Remove the `scraping` module (and `cheerio`/`slugify` if unused elsewhere).
  **Keep Chromium and `puppeteer` in the image** (owner's call: may be needed
  later).
- Old tables stay in place, read-only, while Grafana still reads them.

## 7. Tracker (Tauri v2, Windows)

**UI** (one small window, opened from the tray)
- Now playing: game title, store, time in this session. "Not playing" otherwise.
- Today on this device: total.
- Status line: connected / offline (N heartbeats queued) / token revoked.
- Settings: server URL (prefilled `https://games.server.arifhosan.me/api`),
  device token (paste; masked after save), start with Windows (on by default),
  pause tracking.
- Tray icon changes when a game is running; tray menu has Open, Pause, Quit.

**PSN renewal without copy-paste**
- When PSN is `expiring` or `expired`, the tracker shows "Renew PSN sign-in".
  It opens a Sony sign-in window (the app's own webview; the user signs in
  normally, including 2FA), then loads
  `https://ca.account.sony.com/api/v1/ssocookie`, reads the `npsso` value and
  sends it to `PUT /games/tracker/psn` with the device token.
- Feasibility of reading that page from a Tauri webview is checked with a spike
  at the start of the tracker plan. Fallback: the dashboard's paste field.
- Rejected: storing the PSN password and signing in headless with Chromium
  (2FA and bot checks make it unreliable, and it would hold the password).

**Detection** (Rust, every 15 s, `sysinfo`)
- Build a library index at start and every 10 min:
  - Steam: `libraryfolders.vdf` → each `appmanifest_*.acf` (appid, name,
    installdir).
  - Xbox app: `XboxGames\*\Content` folders on each drive, title from
    `MicrosoftGame.config` or `appxmanifest.xml`.
  - Epic: `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`
    (DisplayName, InstallLocation).
  - Fallback roots (Ubisoft, EA, GOG): folder name as title.
- A running process is a game when its exe path is inside an indexed install
  folder. Built-in ignore list for helpers (crash reporters, anti-cheat,
  launchers, `UnityCrashHandler*`, `*Helper.exe`), plus user ignore list in
  settings.
- Several games at once each get heartbeats.

**Sending**
- One heartbeat per running game every 60 s to `POST /games/tracker/heartbeats`.
- Failed sends append to a local queue file in `%APPDATA%`; flushed oldest
  first in batches of up to 500; entries older than 30 days dropped.
- Token stored in Windows Credential Manager (`keyring` crate).

**Distribution**
- NSIS installer from a GitHub Actions Windows build on tag `tracker-v*`,
  published as a GitHub Release with the Tauri updater manifest; the app checks
  for updates daily.
- Unsigned build: Windows SmartScreen warns on first install. Accepted for
  personal use.

## 8. Dashboard (web)

- Vite + React + TypeScript, built to static files, served by an nginx
  container at `games.server.arifhosan.me` (Traefik routes `/api` to the
  backend, rest to nginx). Charts via one library (builder's choice).
- Pages:
  - Sign in / Register
  - Overview: now playing, today, this week vs last, 30-day daily chart, top
    games, health banner for any failing/expiring source or quiet device
  - Library: all games grouped across platforms, search, platform filter
  - Game detail: totals per platform, daily chart, session list
  - History: year calendar heatmap, monthly totals
  - Devices: create (token shown once, copy button), rename, revoke, last seen
  - Connections: Steam (profile input, test, status), PSN (paste NPSSO, expiry
    countdown, status), manual "sync now"
  - Account: name, email, password, timezone
- Unknown is not zero: days a source failed are marked as gaps.
- Owner's requirements (2026-11-24): mobile friendly, professional looking,
  error free. At least three views: game time; chart plus a sortable table;
  selecting a game shows its playtime over days; pick a period and see all
  sessions, per day and per game. The rest is the designer's call.
- The visual design (layout, look) is decided in a separate step with mockups
  before the dashboard is built.

## 9. Repository and deployment

- Same repo: `tracker/` (Tauri app) and `dashboard/` (web app) next to `src/`.
  The existing backend workflow ignores them; new workflows:
  - `dashboard-image.yml`: build static files into an ARM64 nginx image on
    changes under `dashboard/`.
  - `tracker-release.yml`: Windows build on `tracker-v*` tags.
- Production compose gains the dashboard service and the Traefik rules for
  `games.server.arifhosan.me`; new env: `STEAM_API_KEY`, `GAMES_SECRET_KEY`.
- SQL for all new tables and the `user.timezone` column goes in
  `docs/games-module.md`, applied by hand before deploying, like the radio and
  token tables.

## 10. Build order

1. **Backend core**: auth changes, `games` module tables, devices, tracker
   ingest, now-playing. Usable with curl.
2. **Tracker**: detection, UI, queue, installer. Real data starts flowing.
3. **Legacy import** of Exophase-era data.
4. **Platform sync**: Steam and PSN connections, dedup, health status; then
   remove the scraper.
5. **Dashboard**: design step with mockups, then build.
6. **Retire** the Grafana game dashboards and rename the old tables to
   `archive_*` (never dropped).

Each step ships on its own; Grafana keeps working until step 6.

## 11. Calls made during review (check these)

- Library totals use the platform's own number where one exists (6.3).
- Multi-day windows are spread evenly and flagged "estimated" (6.3).
- Steam dedup subtracts tracker time instead of checking overlap (6.6).
- Legacy rows are matched to platform titles by normalised title (6.6, 6.9).
- `game_old` imported as non-counting `import` sessions; `playtime` kept only
  in the archive since it is derived (6.9).
- Oversized deltas become `import` sessions rather than being discarded (6.6).

## 12. Left to the builder

- Chart library, component library, routing, state management in the dashboard.
- Exact helper-process ignore list and title normalisation for `titleKey`.
- Rate limiter implementation.
- Tauri plugin choices for autostart and updater wiring.
- Test layout, following the repo's existing Jest conventions; tracker
  detection logic gets Rust unit tests against sample manifest files.
