# Games module

Design and rationale: `docs/superpowers/specs/2026-11-24-game-tracker-design.md`. `DB_SYNC` stays off, so every schema change below is applied by hand before deploy.

```sql
ALTER TABLE user ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
```

```sql
CREATE TABLE device (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  tokenHash CHAR(64) NOT NULL UNIQUE,
  tokenPrefix VARCHAR(12) NOT NULL,
  createdAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  lastSeenAt DATETIME(6) NULL,
  revokedAt DATETIME(6) NULL,
  INDEX (userId)
);
CREATE TABLE connection (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  provider VARCHAR(16) NOT NULL,
  externalId VARCHAR(64) NOT NULL,
  displayName VARCHAR(255) NOT NULL DEFAULT '',
  secret TEXT NULL,
  secretExpiresAt DATETIME(6) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ok',
  createdAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  lastSyncAt DATETIME(6) NULL,
  lastSuccessAt DATETIME(6) NULL,
  lastError VARCHAR(500) NULL,
  lastGameCount INT NULL,
  UNIQUE KEY (userId, provider)
);
CREATE TABLE sync_run (
  id INT AUTO_INCREMENT PRIMARY KEY,
  connectionId INT NOT NULL,
  startedAt DATETIME(6) NOT NULL,
  finishedAt DATETIME(6) NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  gameCount INT NULL,
  error VARCHAR(500) NULL,
  INDEX (connectionId, startedAt)
);
CREATE TABLE library_game (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  platform VARCHAR(16) NOT NULL,
  externalId VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  titleKey VARCHAR(255) NOT NULL,
  totalSeconds BIGINT NULL,
  totalChangedAt DATETIME(6) NULL,
  lastPlayedAt DATETIME(6) NULL,
  UNIQUE KEY (userId, platform, externalId),
  INDEX (userId, titleKey)
);
CREATE TABLE play_session (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  libraryGameId INT NOT NULL,
  source VARCHAR(16) NOT NULL,
  deviceId INT NULL,
  startedAt DATETIME(6) NOT NULL,
  endedAt DATETIME(6) NOT NULL,
  seconds INT NOT NULL,
  legacyRef VARCHAR(32) NULL UNIQUE,
  INDEX (userId, startedAt),
  INDEX (libraryGameId, startedAt),
  INDEX (deviceId, libraryGameId, startedAt)
);
```

Game art (Task 12):

```sql
ALTER TABLE library_game ADD COLUMN imageUrl VARCHAR(512) NULL;
CREATE TABLE game_icon (
  libraryGameId INT NOT NULL PRIMARY KEY,
  png MEDIUMBLOB NOT NULL,
  updatedAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
```

Steam/tracker dedup (final review C1): tracker seconds Steam has not reported
yet carry over to the next sync, because a tracker row extended in place can
span a sync.

```sql
ALTER TABLE library_game ADD COLUMN trackerCreditSeconds INT NOT NULL DEFAULT 0;
```

`legacyRef` (`game:<id>` / `game_old:<id>`) makes the legacy import idempotent.

## Routes

Authoritative list (README points here). Auth: **JWT** = the cookie or `Authorization: Bearer` access token; **device** = `Authorization: Bearer <device token>`.

A cookie-authenticated write (anything but GET/HEAD/OPTIONS) needs an `Origin` whose host equals the `Host` header, else 403 (CSRF); Bearer requests are not checked. Bodies are JSON only, up to 512 KB. Connecting Steam/PSN and sync-now are limited to 10 calls per minute each (429).

| Method and path | Auth | What it does |
| --- | --- | --- |
| `POST /games/devices` | JWT | Create a device; the token is shown once. |
| `GET /games/devices` | JWT | List the user's devices. |
| `PATCH /games/devices/:id` | JWT | Rename a device. |
| `DELETE /games/devices/:id` | JWT | Revoke a device token. |
| `GET /games/tracker/status` | device | Tracker's view of the PSN connection (`psn: null` or status and expiry). |
| `POST /games/tracker/heartbeats` | device | Ingest up to 500 heartbeats; returns `{ accepted, rejected }`. |
| `PUT /games/tracker/icon` | device | Upload a game icon `{ game, png }` (base64 PNG, at most 64 KB decoded); 204. |
| `GET /games/now` | JWT | Games a tracker reported in the last 2 minutes. |
| `GET /games/connections` | JWT | Steam and PSN connections with health, never secrets. |
| `PUT /games/connections/steam` | JWT | Connect Steam by profile URL, vanity name or SteamID64. |
| `PUT /games/connections/psn` | JWT | Connect PSN with a pasted NPSSO. PSN renewal is the same call repeated with a new NPSSO. |
| `POST /games/connections/:provider/sync` | JWT | Run a sync now (`steam` or `psn`). |
| `DELETE /games/connections/:provider` | JWT | Remove a connection and its stored secret. |
| `GET /games/overview` | JWT | Dashboard home: now playing, today, week, 30-day series, top games, health. |
| `GET /games/sessions` | JWT | Sessions in a date range, optional game and platform filter. |
| `GET /games/library` | JWT | Games grouped across platforms, with `platform` and `q` filters. |
| `GET /games/library/:id` | JWT | One game group with daily series and latest sessions. |
| `GET /games/library/:id/icon` | JWT | Uploaded PNG icon (`Cache-Control: private, max-age=86400`); 404 if none or not the user's game. |
| `GET /games/calendar` | JWT | Per-day seconds for a year. |
| `GET /games/period` | JWT | Per-day and per-game totals for a date range. |

Game objects carry `imageUrl` (Steam CDN or PSN image, or null) and `hasIcon` (a tracker icon exists; fetch it from the icon route).

Public host: `games.server.arifhosan.me/api/*` (Traefik strips `/api`).

## Deploy runbook

Do these in order.

1. `mysqldump api_db game game_old total_game_time playtime > legacy-YYYY-MM-DD.sql`
2. Apply all SQL in this file.
3. Set `STEAM_API_KEY` and `GAMES_SECRET_KEY` (`openssl rand -base64 32`) in the Portainer stack.
4. Deploy the image. The stack also runs the dashboard (`ghcr.io/arifhosan/server-dashboard:latest`, built by `.github/workflows/dashboard-image.yml` on pushes to `master` touching `dashboard/**`); redeploy the stack to pull a new one. It serves `games.server.arifhosan.me/`; `/api/*` still goes to the backend.
5. Legacy import: dry run, then `--commit` (see below).
6. Only then connect Steam and PSN; their first sync adopts the legacy rows.
7. Connect Steam/PSN and let their first sync finish (Connections shows a last
   success) before creating the first tracker device. The backend also adopts
   correctly in the other order; this is belt and braces.

The Grafana game dashboards keep reading the untouched legacy tables, which get no new rows from now on.

## Legacy import runbook

One-off import of the Exophase-era data (`game`, `game_old`, `total_game_time`)
into `library_game` / `play_session` for one user. The legacy tables are only
read, never modified. `playtime` is read for the day check only.

Run it inside the backend container: it needs the built `dist/`, the stack's
`DB_*` environment and the same database connection settings (`timezone: 'Z'`)
as the app. Find the container name with
`docker ps --filter ancestor=ghcr.io/arifhosan/server-backend:latest --format '{{.Names}}'`
(or Portainer, stack, service `app`). Below, `<backend>` is that name. The run
boots the whole app context for a few seconds, so its hourly sync cron could
fire once; before any connection exists it has nothing to do.

0. Check the database clock first:
   `SELECT @@global.time_zone, @@session.time_zone, NOW(), UTC_TIMESTAMP();`
   Expect `NOW()` equal to `UTC_TIMESTAMP()` (`time_zone` `+00:00`, `UTC`, or
   `SYSTEM` on a UTC host). The app writes and reads every DATETIME as UTC, and
   the legacy `createdAt` values are read as UTC too. If `NOW()` differs, stop:
   find out in which zone the legacy scraper wrote `createdAt` (compare a recent
   row with when it was scraped). If it wrote UTC, set the server to UTC
   (`default-time-zone='+00:00'` in the MySQL config, restart) and re-check. If
   it wrote local time, do not import until the plan handles that offset.
1. Back up first and keep the file:
   `mysqldump api_db game game_old total_game_time playtime > legacy-YYYY-MM-DD.sql`
2. Dry run (default, writes nothing, rolls back):
   `docker exec <backend> node dist/modules/games/legacy/run-legacy-import.js --user-id <id>`
3. Read the JSON report. Expect `game` 840, `game_old` 49, `total_game_time` 282,
   `playtime` 366, no error. Look at `unknownPlatforms` (mapped to `pc_other`)
   and `dayMismatches` (days where `playtime` differs from the sum of `game`
   rows by UTC createdAt date; about 8 are expected). Sources: `exophase`
   counts, `import` (baseline and over-long sessions) is left out of charts,
   `legacy_test` (`game_old`) is left out of totals.
4. Commit: `docker exec <backend> node dist/modules/games/legacy/run-legacy-import.js --user-id <id> --commit`.
   Row counts and per-game and per-source seconds are compared with the legacy
   tables inside the transaction; any mismatch aborts and rolls back.
5. Re-running prints the same counts with `inserted` all 0 (existing rows are
   never overwritten, `play_session.legacyRef` is unique). Run it before the
   tracker/sync goes live: later changes to imported library rows would make
   the check fail, which fails safely (rollback).

The dry-run report shows the would-be state (counts and `inserted` as if committed); the transaction is rolled back.

### Stats: noise and undated PSN/Steam play

Every stats read applies `stats/undated.ts`: `psn`/`steam` sessions under 5 min
are hidden; those whose window spans several local days are "undated". An
undated session is on no day and counts in a range's totals only when its
whole window lies inside the range. Overview, period and game responses carry
`undatedSeconds` (in the totals, in no bar); the dashboard shows it as a muted
note under the chart.

### Library audit (read-only)

Every Steam/PSN sync first repairs the user's library inside its transaction
(`sync/repair-plan.ts`): titleKeys recomputed, PSN platforms taken from the
title id (CUSA ps4, PPSA ps5), exact cross-gen duplicates and media apps
deleted (kept and logged when they have sessions), every unadopted legacy row
of a connected platform folded into the synced row it matches (rules R1-R4 in
`library/legacy-match.ts`; the synced total stays, the legacy sessions and icon
move), first-sync sessions older than the last Exophase scrape deleted
(< 5 min) or re-windowed. To see what it would do, without writing or calling
PSN/Steam:

`docker exec <backend> node dist/modules/games/library/run-audit.js --user-id <id>`

It prints total hours (old `total_game_time`, now, after repair), each legacy
fold with its rule, the unmatched legacy rows, media apps and cross-gen pairs to
drop, relabels, noise sessions, and the title groups whose totals differ.
