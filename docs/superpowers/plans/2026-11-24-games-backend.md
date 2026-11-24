# Games Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Exophase scraper with a `games` module that receives tracker heartbeats, pulls Steam and PSN, keeps all legacy data, and serves the dashboard.

**Architecture:** Extend the existing NestJS app. Shared login plumbing moves to `src/common/auth`; everything game-related lives in one module `src/modules/games` with sub-folders. Pure decision logic (heartbeat merge, delta rules, day splitting, legacy mapping) sits in small functions with unit tests; services are thin wrappers over TypeORM repositories.

**Tech Stack:** NestJS 12, TypeORM + MySQL, Jest (ts-jest), axios (installed), `psn-api` (new), `@nestjs/throttler` (new).

**Spec:** `docs/superpowers/specs/2026-11-24-game-tracker-design.md` (read it first; this plan implements sections 6 and 9, build-order steps 1, 3 and 4). The tracker and dashboard get their own plans.

## Global Constraints

- Work on branch `feat/games`. Do not push or merge until the owner says so (a push to `master` builds the production image).
- Commit messages follow the repo style (`feat(games): …`, `refactor(auth): …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Modules must not import each other (`boundaries/no-cross-module-import`). Shared code goes in `src/common` or `src/database`. Code only `games` uses stays inside `src/modules/games`.
- `DB_SYNC` stays false. Every schema change is SQL in `docs/games-module.md`, applied by hand before deploy.
- All times UTC in the database; all durations in **seconds**. `BIGINT` columns use `bigintTransformer`.
- Tests are colocated `*.spec.ts` under `src/`, run with `npm test`. Before each commit: `npx tsc --noEmit -p tsconfig.json`, `npx eslint "{src,test}/**/*.ts"`, `npm test` all pass.
- Secrets (PSN tokens, device tokens, NPSSO) never appear in responses or logs.
- Values pinned by the spec: heartbeat interval 60 s; merge gap ≤ 180 s; new session starts at `at − 60 s`; reject heartbeats > 5 min in the future or > 30 days old; batch ≤ 500; now-playing window 2 min; sync hourly; Steam remainder threshold 300 s; PSN `expiring` at < 14 days; `sync_run` kept 90 days; session cookie `session`, httpOnly, Secure, SameSite=Strict, 30 days; login/register rate limit 10 per minute per IP; registration open; `user.timezone` default `Europe/Berlin`.
- Legacy tables (`game`, `total_game_time`, `playtime`, `game_old`) are never modified or dropped by this plan.

## Review Focus

1. **Offline queue flush re-sends heartbeats, possibly unsorted and duplicated** → total tracked seconds must not change on re-send. Test in Task 4.
2. **A tracker session crossing local midnight, including a DST switch day in `Europe/Berlin`** → seconds split by real overlap per local day. Test in Task 10.
3. **Steam profile with private game details, or Steam API down** → connection `failing` with a readable error, no sessions written, days marked unknown rather than zero. Test in Tasks 6 and 7.
4. **PSN refresh token at its fixed ~10-day end, or the NPSSO rejected (silently or not)** → auto-renew from the stored NPSSO; if that fails, status `expired` with a renew message, other connections still sync, no crash. Test in Tasks 6 and 8.
5. **Same game on two PCs at once, or two games on one PC** → separate sessions, never merged across devices or games. Test in Task 4.

---

### Task 1: Shared auth, session cookie, logout/me, rate limit

**Files:**
- Create: `src/common/auth/auth.types.ts` (move `JwtPayload`, `AuthenticatedUser` here from `src/modules/auth/types/auth.types.ts`; the auth module re-imports them)
- Create: `src/common/auth/session-cookie.ts`, `src/common/auth/session-cookie.spec.ts`
- Create: `src/common/auth/jwt-auth.guard.ts`, `src/common/auth/current-user.decorator.ts`
- Create: `docs/games-module.md` (starts with the `user.timezone` SQL; later tasks append)
- Modify: `src/modules/auth/jwt.strategy.ts`, `auth.module.ts`, `auth.controller.ts`, `auth.service.ts`, `entities/user.entity.ts`, `types/auth.types.ts`
- Test: `src/modules/auth/auth.controller.spec.ts` (new), `src/modules/auth/auth.service.spec.ts` (update)

**Interfaces:**
- Produces: `JwtAuthGuard` (class, `AuthGuard('jwt')`), `@CurrentUser()` → `AuthenticatedUser { userId: number; email: string }`, `SESSION_COOKIE = 'session'`, `SESSION_MAX_AGE_MS = 2_592_000_000`, `readSessionCookie(cookieHeader: string | undefined): string | null`. `PublicUser` gains `timezone: string`.

- [ ] **Step 1: Write failing tests**

`session-cookie.spec.ts`:
```ts
expect(readSessionCookie('a=1; session=abc.def; b=2')).toBe('abc.def');
expect(readSessionCookie('a=1')).toBeNull();
expect(readSessionCookie(undefined)).toBeNull();
expect(readSessionCookie('session=a%2Eb')).toBe('a.b');
```
`auth.controller.spec.ts` (mock `AuthService.login` → `{ access_token: 't', user }`, pass a fake `res` with `cookie`/`clearCookie` jest fns):
```ts
expect(res.cookie).toHaveBeenCalledWith('session', 't', {
  httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 2_592_000_000,
});
// logout
expect(res.clearCookie).toHaveBeenCalledWith('session', { path: '/' });
```
Update `auth.service.spec.ts` "never returns the password hash" to expect `timezone: 'Europe/Berlin'` in the public user, and add `me(1)` returns the public user / throws `UnauthorizedException` for an unknown id.

- [ ] **Step 2: Run** `npm test -- auth session-cookie` → FAIL (missing modules/methods).

- [ ] **Step 3: Implement**
  - `readSessionCookie`: split on `;`, trim, find `session=`, `decodeURIComponent` the value.
  - `JwtStrategy`: `jwtFromRequest: ExtractJwt.fromExtractors([(req) => readSessionCookie(req.headers.cookie), ExtractJwt.fromAuthHeaderAsBearerToken()])`.
  - `AuthModule`: `expiresIn: '30d'`; import `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }])`.
  - `AuthController`: `login(@Body() dto, @Res({ passthrough: true }) res)` sets the cookie with the options above and still returns the body; `POST /auth/logout` clears it and returns `{ ok: true }`; `GET /auth/me` (`JwtAuthGuard`) returns `authService.me(user.userId)`. `@UseGuards(ThrottlerGuard)` on `register` and `login` only.
  - `User` entity: `@Column({ length: 64, default: 'Europe/Berlin' }) timezone: string`. `toPublicUser` includes it.
  - `docs/games-module.md`: title, one paragraph pointing to the spec, then:
```sql
ALTER TABLE user ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
```

- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint "{src,test}/**/*.ts"` → all PASS.

- [ ] **Step 5: Commit** `refactor(auth): session cookie, shared guard, logout and me, rate limits`

---

### Task 2: `games` module skeleton, schema, secret box, title key

**Files:**
- Create: `src/modules/games/games.module.ts`, `src/modules/games/games.types.ts`
- Create: `src/modules/games/entities/{device,connection,sync-run,library-game,play-session}.entity.ts`
- Create: `src/modules/games/utils/secret-box.ts` + `.spec.ts`, `src/modules/games/utils/title-key.ts` + `.spec.ts`
- Modify: `src/app.module.ts` (import `GamesModule`), `docs/games-module.md` (append SQL)

**Interfaces:**
- Produces (in `games.types.ts`):
```ts
export type Platform = 'steam' | 'xbox_pc' | 'epic' | 'pc_other' | 'ps5' | 'ps4';
export type SessionSource = 'tracker' | 'steam' | 'psn' | 'exophase' | 'import' | 'legacy_test';
export type Provider = 'steam' | 'psn';
export type ConnectionStatus = 'ok' | 'expiring' | 'expired' | 'failing' | 'disabled';
export const CHART_EXCLUDED_SOURCES: SessionSource[] = ['import', 'legacy_test'];
export const TOTAL_EXCLUDED_SOURCES: SessionSource[] = ['legacy_test'];
```
- Entities `Device`, `Connection`, `SyncRun`, `LibraryGame`, `PlaySession` with the columns in the SQL below (camelCase property = column name).
- `sealSecret(plain: string, key: Buffer): string`, `openSecret(sealed: string, key: Buffer): string`, `loadSecretKey(config: ConfigService): Buffer` (reads `GAMES_SECRET_KEY`, base64, must decode to 32 bytes, else throws `Error('GAMES_SECRET_KEY must be 32 bytes, base64')`). Format: `v1.` + base64url(iv 12 bytes ‖ auth tag 16 bytes ‖ ciphertext), AES-256-GCM.
- `titleKey(title: string): string`.

- [ ] **Step 1: Write failing tests**

`secret-box.spec.ts`: round-trip returns the plain text; two seals of the same text differ; flipping one character of the sealed value makes `openSecret` throw; a 16-byte key makes `loadSecretKey` throw.

`title-key.spec.ts`:
```ts
expect(titleKey('Tom Clancy’s Rainbow Six Siege')).toBe('tom clancys rainbow six siege');
expect(titleKey("DEATH STRANDING DIRECTOR'S CUT")).toBe('death stranding directors cut');
expect(titleKey('The Witcher 3: Wild Hunt — Remastered')).toBe('the witcher 3 wild hunt remastered');
expect(titleKey('Pokémon™ Legends')).toBe('pokemon legends');
```

- [ ] **Step 2: Run** `npm test -- games/utils` → FAIL.

- [ ] **Step 3: Implement** the utils (`node:crypto`; title key = NFKD, strip combining marks, drop apostrophes `'’`, lowercase, any other non-`[a-z0-9]` run → one space, trim), the types, the five entities, and a `GamesModule` registering the entities with `TypeOrmModule.forFeature` and a `GAMES_SECRET_KEY` provider built with `loadSecretKey`, so the app refuses to start when the key is missing or malformed (same stance as `requireJwtSecret`). Append to `docs/games-module.md`:

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
`legacyRef` (`game:<id>` / `game_old:<id>`) makes the legacy import idempotent (Task 5).

- [ ] **Step 4: Run** tests, typecheck, lint → PASS. App still boots: `npm run build`.

- [ ] **Step 5: Commit** `feat(games): module skeleton, schema, secret box and title key`

---

### Task 3: Devices and device tokens

**Files:**
- Create: `src/modules/games/utils/device-token.ts` + `.spec.ts`
- Create: `src/modules/games/devices/{devices.service,devices.controller,device-auth.guard}.ts` + `devices.service.spec.ts`, `device-auth.guard.spec.ts`
- Create: `src/modules/games/dto/device.dto.ts`
- Modify: `games.module.ts`

**Interfaces:**
- Consumes: `JwtAuthGuard`, `CurrentUser` (Task 1); `Device` (Task 2).
- Produces:
  - `generateDeviceToken(): { token: string; hash: string; prefix: string }` (`gt_` + base64url of 32 random bytes; `hash` = sha256 hex; `prefix = token.slice(0, 9)`), `hashDeviceToken(token: string): string`.
  - `DeviceAuthGuard` sets `req.device: DeviceContext { userId: number; deviceId: number }` and updates `lastSeenAt`.
  - `PublicDevice { id; name; tokenPrefix; createdAt; lastSeenAt: Date | null; revokedAt: Date | null }`.
  - Routes (all `JwtAuthGuard`): `POST /games/devices {name}` → `{ device: PublicDevice; token: string }`; `GET /games/devices` → `PublicDevice[]` (newest first); `PATCH /games/devices/:id {name}` → `PublicDevice`; `DELETE /games/devices/:id` → revokes, returns `PublicDevice`.
  - DTO: `name` string, 1–100 chars.

- [ ] **Step 1: Write failing tests**
  - token: matches `/^gt_[A-Za-z0-9_-]{43}$/`; `hash` matches `/^[0-9a-f]{64}$/` and equals `hashDeviceToken(token)`.
  - service: `create` saves the hash, never the token (assert the saved entity has no field equal to `token`); `revoke(otherUserId, id)` and `rename(otherUserId, …)` throw `NotFoundException`; revoking twice keeps the first `revokedAt`.
  - guard: no header → `UnauthorizedException`; unknown token → 401; revoked device → 401 with message `'Device token revoked'`; valid → returns true, `req.device` equals `{ userId, deviceId }`, `lastSeenAt` updated.

- [ ] **Step 2: Run** `npm test -- games/devices device-token` → FAIL.

- [ ] **Step 3: Implement** service, guard, controller, DTO; register in `GamesModule`.

- [ ] **Step 4: Run** tests, typecheck, lint → PASS.

- [ ] **Step 5: Commit** `feat(games): devices with revocable tokens`

---

### Task 4: Tracker heartbeat ingest and now-playing

**Files:**
- Create: `src/modules/games/tracker/heartbeat-merge.ts` + `.spec.ts`
- Create: `src/modules/games/tracker/{tracker.service,tracker.controller}.ts` + `tracker.service.spec.ts`
- Create: `src/modules/games/library/library.service.ts` (upsert helper reused by Tasks 5 and 6)
- Create: `src/modules/games/dto/heartbeats.dto.ts`

**Interfaces:**
- Consumes: `DeviceAuthGuard`/`DeviceContext` (Task 3), `titleKey` (Task 2).
- Produces:
  - `mergeHeartbeat(latest: { startedAt: Date; endedAt: Date } | null, at: Date): { action: 'create' | 'extend' | 'ignore'; startedAt: Date; endedAt: Date }`.
  - `LibraryService.upsertByExternalId(userId: number, platform: Platform, externalId: string, title: string): Promise<LibraryGame>` (creates with `totalSeconds: null`, updates `title`/`titleKey` if changed).
  - `trackerPlatform(store: 'steam' | 'xbox' | 'epic' | 'other'): Platform` → `steam | xbox_pc | epic | pc_other`. External id = `storeId` when given, else `folder:` + `titleKey(title)`.
  - `TrackerService.ingest(device: DeviceContext, heartbeats: HeartbeatDto[], now?: Date): Promise<{ accepted: number; rejected: number }>`.
  - `TrackerService.nowPlaying(userId: number, now?: Date): Promise<NowPlaying[]>` where `NowPlaying { deviceId; deviceName; libraryGameId; title; platform: Platform; startedAt: Date }`.
  - Routes: `POST /games/tracker/heartbeats` (`DeviceAuthGuard`) body `{ heartbeats: HeartbeatDto[] }` (1–500) where `HeartbeatDto { at: ISO string; game: { store: 'steam'|'xbox'|'epic'|'other'; storeId?: string (≤64); title: string (1–255); exe?: string (≤255) } }`; `GET /games/now` (`JwtAuthGuard`) → `NowPlaying[]`.

- [ ] **Step 1: Write failing tests**

`heartbeat-merge.spec.ts` (t = 2026-11-24T20:00:00Z):
```ts
expect(mergeHeartbeat(null, t)).toEqual({ action: 'create', startedAt: t - 60s, endedAt: t });
// latest [t-60s, t]:
at t+60s  → { action: 'extend', startedAt: t-60s, endedAt: t+60s }
at t+180s → 'extend'          // exactly the gap limit
at t+181s → { action: 'create', startedAt: t+121s, endedAt: t+181s }
at t      → 'ignore'          // already covered
at t-30s  → 'ignore'
```
`tracker.service.spec.ts` (mocked repos, in-memory session store):
  - heartbeat `at` 6 min in the future, or 31 days old → `rejected` counts it, nothing written.
  - batch given newest-first is processed oldest-first (one session, not several).
  - same batch posted twice → total seconds of the device's sessions unchanged (Review Focus 1).
  - two devices, same game, same minutes → two sessions (lookup keyed by `deviceId` + `libraryGameId`) (Review Focus 5).
  - one device, two games → two sessions.
  - `nowPlaying` returns only sessions with `endedAt >= now − 120 s` and source `tracker`.

- [ ] **Step 2: Run** `npm test -- games/tracker` → FAIL.

- [ ] **Step 3: Implement.** Per heartbeat: resolve library game, fetch the latest tracker session for `(deviceId, libraryGameId)` with `startedAt <= at` ordered by `startedAt DESC`, apply `mergeHeartbeat`, save; `seconds = round((endedAt − startedAt) / 1000)`; update `library_game.lastPlayedAt`. Process one batch sequentially inside one transaction.

- [ ] **Step 4: Run** tests, typecheck, lint → PASS.

- [ ] **Step 5: Commit** `feat(games): tracker heartbeat ingest and now playing`

---

### Task 5: Legacy import (no game data lost)

**Files:**
- Create: `src/modules/games/legacy/legacy-plan.ts` + `.spec.ts` (pure)
- Create: `src/modules/games/legacy/legacy-import.service.ts`
- Create: `src/modules/games/legacy/run-legacy-import.ts` (CLI)
- Modify: `docs/games-module.md` (runbook section)

**Interfaces:**
- Consumes: `titleKey` (Task 2), entities (Task 2).
- Produces:
  - Raw row types: `LegacyGameRow { id; title; slug; platform; playtimeMs: number; createdAt: Date }` (used for both `game` and `game_old`), `LegacyTotalRow { id; slug; title; platform; totalMs: number; updatedAt: Date }`, `LegacyDayRow { date: string; totalMs: number }`.
  - `legacyPlatform(raw: string): { platform: Platform; known: boolean }`: `Steam`→steam, `PS5`→ps5, `PS4`→ps4, `Xbox Series`/`Xbox One`/`Windows`/`Windows 10`→xbox_pc, `Ubisoft`→pc_other, anything else → pc_other with `known: false`.
  - `buildLegacyPlan(input: { totals: LegacyTotalRow[]; games: LegacyGameRow[]; gamesOld: LegacyGameRow[] }): LegacyPlan` where `LegacyPlan { library: PlannedGame[]; sessions: PlannedSession[]; unknownPlatforms: string[] }`, `PlannedGame { externalId: 'legacy:<slug>'; platform; title; titleKey; totalSeconds: number | null; totalChangedAt: Date | null; lastPlayedAt: Date | null }`, `PlannedSession { legacyRef: string; externalId: string; source: 'exophase' | 'import' | 'legacy_test'; startedAt; endedAt; seconds }`.
  - `checkLegacyPlan(plan: LegacyPlan, input): string[]` returns mismatch descriptions (empty = OK).
  - `dayMismatches(days: LegacyDayRow[], games: LegacyGameRow[]): { date: string; playtime: number; gameSum: number }[]`.
  - `LegacyImportService.run(userId: number, opts: { commit: boolean }): Promise<LegacyImportReport>` where the report holds row counts per table, seconds per source, `unknownPlatforms`, `dayMismatches`, `committed: boolean`.

- [ ] **Step 1: Write failing tests** (`legacy-plan.spec.ts`)
  - Each `total_game_time` row → one library game with `externalId 'legacy:' + slug`, `totalSeconds = totalMs` (the column holds seconds), `totalChangedAt = updatedAt`.
  - Each `game` row → one session with `legacyRef 'game:<id>'`, window `[createdAt − 24 h, createdAt]`, `seconds = playtimeMs`.
  - `game` row created before `2025-04-29T12:00:00Z` → source `import`; row with `playtimeMs > 86_400` → `import`; otherwise `exophase`.
  - Each `game_old` row → `legacyRef 'game_old:<id>'`, source `legacy_test`; joins its library game by slug, else by platform + titleKey, else a new library game with `totalSeconds: null`.
  - A `game` row whose slug has no `total_game_time` row → library game created from the row with `totalSeconds: null` (no row dropped).
  - `checkLegacyPlan` on a correct plan → `[]`; after deleting one planned session → one message naming the missing `legacyRef`; after changing one total → one message naming the slug.
  - `legacyPlatform('Foo')` → `{ platform: 'pc_other', known: false }`.

- [ ] **Step 2: Run** `npm test -- games/legacy` → FAIL.

- [ ] **Step 3: Implement.** Service: read the four tables with `dataSource.query` (no entities for them); `buildLegacyPlan`; in one transaction upsert library games by `(userId, platform, externalId)` and insert sessions with `INSERT … ON DUPLICATE KEY` on `legacyRef` (idempotent); then re-read counts and per-slug sums from the new tables and compare with the old ones (`checkLegacyPlan` plus DB counts: `game` + `game_old` rows = sessions with `legacyRef`; `total_game_time` rows = library games with `externalId LIKE 'legacy:%'`); any mismatch → throw and roll back. Without `commit`, roll back after the checks and return the report. CLI: `node dist/modules/games/legacy/run-legacy-import.js --user-id <id> [--commit]` boots `NestFactory.createApplicationContext(AppModule)`, prints the report as JSON, exits non-zero on failure.

  Append to `docs/games-module.md` a **Legacy import runbook**: (1) `mysqldump api_db game game_old total_game_time playtime > legacy-YYYY-MM-DD.sql` and keep it; (2) dry run; (3) read the report (unknown platforms, day mismatches); (4) `--commit`; (5) re-running prints the same counts and inserts nothing.

- [ ] **Step 4: Run** tests, typecheck, lint → PASS. Then against a local MySQL with a copy of the four tables (or the real DB, dry run only): report shows 840 `game`, 49 `game_old`, 282 `total_game_time`, 366 `playtime` rows and no check failures.

- [ ] **Step 5: Commit** `feat(games): lossless legacy import of Exophase-era data`

---

### Task 6: Sync core (delta rules, run lock, health)

**Files:**
- Create: `src/modules/games/sync/delta.ts` + `.spec.ts` (pure)
- Create: `src/modules/games/sync/platform-client.ts` (types + errors)
- Create: `src/modules/games/sync/sync.service.ts` + `.spec.ts`
- Modify: `library.service.ts` (add `findOrAdopt`), `games.module.ts` (`ScheduleModule.forRoot()` is already registered by the scraping module today; register it here, since Task 11 deletes that module)

**Interfaces:**
- Consumes: `LibraryService` (Task 4), `openSecret`/`sealSecret`/`loadSecretKey` (Task 2), `titleKey`.
- Produces:
  - `decideDelta(input: { priorSeconds: number | null; priorChangedAt: Date | null; reportedSeconds: number; windowStart: Date | null; now: Date; alreadyTracked?: number; minRemainder?: number }): { updateTotal: boolean; session: null | { source: 'platform' | 'import'; seconds: number; startedAt: Date; endedAt: Date } }`. Rules, in order:
    1. `priorSeconds === null` → `{ updateTotal: true, session: null }` (baseline).
    2. `delta = reportedSeconds − priorSeconds`; `delta <= 0` → `{ updateTotal: false, session: null }`.
    3. `start = windowStart ?? priorChangedAt ?? now`; if `delta > (now − start)/1000` → import session `[start, now]` of `delta` seconds.
    4. `remainder = delta − (alreadyTracked ?? 0)`; `remainder <= (minRemainder ?? 0)` → `{ updateTotal: true, session: null }`; else platform session `[start, now]` of `remainder` seconds.
  - `ObservedTitle { platform: Platform; externalId: string; title: string; totalSeconds: number; lastPlayedAt?: Date }`.
  - `PlatformClient { fetchTitles(conn: Connection, secret: string | null): Promise<{ titles: ObservedTitle[]; secret?: string; secretExpiresAt?: Date }>; statusAfter?(secretExpiresAt: Date | null, now: Date): ConnectionStatus }` (secret is the decrypted JSON string; the client returns a new one when it refreshed tokens; `statusAfter` absent → `ok`).
  - Errors: `SecretExpiredError`, `SyncFailedError(message)`.
  - `LibraryService.findOrAdopt(userId, observed: ObservedTitle): Promise<LibraryGame>`: by `(userId, platform, externalId)`; else a legacy row (`externalId LIKE 'legacy:%'`, same platform, same `titleKey`) gets `externalId` replaced and is returned; else upsert new with `totalSeconds: null`.
  - `SyncService.syncConnection(connectionId: number, now?: Date): Promise<SyncRun>`; `SyncService.syncAll(): Promise<void>` with `@Cron('0 5 * * * *')`; `SyncService` gets the provider client via a map `{ steam: SteamClient, psn: PsnClient }` injected in Tasks 7–8 (until then the spec injects fakes).
  - Status after a run: success → `client.statusAfter?.(secretExpiresAt, now) ?? 'ok'`; `SecretExpiredError` → `expired`; any other error, or zero titles when `lastGameCount > 0` → `failing` with `lastError`, and **no sessions or totals written**.

- [ ] **Step 1: Write failing tests**

`delta.spec.ts` (now = 2026-11-24T12:00Z):
  - baseline: prior null → `updateTotal: true, session: null`.
  - no change / decrease → `updateTotal: false`.
  - normal: prior 1000, reported 4600, windowStart now−2 h → platform session 3600 s over `[now−2h, now]`.
  - oversized: prior 0, reported 36 h in a 24 h window → import session of 129_600 s.
  - Steam remainder: delta 3600, alreadyTracked 3400, minRemainder 300 → `updateTotal: true, session: null`; alreadyTracked 3000 → platform session 600 s.
  - catch-up: windowStart null, priorChangedAt 2026-11-21T23:00Z, delta 5 h → platform session `[2026-11-21T23:00Z, now]` of 18_000 s.

`sync.service.spec.ts` (fake client, mocked repos):
  - second concurrent `syncConnection` for the same id → `ConflictException('Sync already running')`.
  - client throws → run `ok: false`, connection `failing`, `lastError` set, no session saved (Review Focus 3).
  - client returns `[]` after `lastGameCount: 120` → same as above with `lastError 'Returned 0 games, previously 120'`.
  - `SecretExpiredError` → status `expired`; `syncAll` still syncs the next connection (Review Focus 4).
  - legacy row with titleKey `cyberpunk 2077` on steam is adopted by observed appid `1091500` and gets a catch-up session.
  - Steam connection: `alreadyTracked` = sum of tracker sessions for that library game with `startedAt >= totalChangedAt`; `minRemainder` 300. PSN: no tracker lookup, `minRemainder` 0.
  - `syncAll` deletes `sync_run` rows older than 90 days.

- [ ] **Step 2: Run** `npm test -- games/sync` → FAIL.

- [ ] **Step 3: Implement.** In-process lock: `Set<number>` of running connection ids.
  `// ponytail: in-process lock; move to a DB lock if the backend ever runs >1 replica`
  Window start passed to `decideDelta` = `connection.lastSuccessAt`. For each title with `updateTotal`, set `totalSeconds`, `totalChangedAt = now`, `lastPlayedAt` (observed, else keep). Session source = provider name (`steam`/`psn`) for `'platform'`, `import` for `'import'`. One transaction per run for the writes.

- [ ] **Step 4: Run** tests, typecheck, lint → PASS.

- [ ] **Step 5: Commit** `feat(games): sync engine with delta rules and run health`

---

### Task 7: Steam client

**Files:**
- Create: `src/modules/games/sync/steam.client.ts` + `.spec.ts`

**Interfaces:**
- Consumes: `PlatformClient`, `ObservedTitle`, `SyncFailedError` (Task 6).
- Produces:
  - `parseSteamProfileInput(input: string): { steamId: string } | { vanity: string }`: 17-digit id; `…/profiles/<id>`; `…/id/<vanity>`; otherwise a bare vanity name.
  - `SteamClient implements PlatformClient` (reads `STEAM_API_KEY`; missing key → every call throws `SyncFailedError('STEAM_API_KEY is not set')`), plus `resolveSteamId(input: string): Promise<string>` and `profile(steamId: string): Promise<{ steamId: string; displayName: string }>`.
  - Endpoints (axios, 15 s timeout): `ISteamUser/ResolveVanityURL/v1` (`success !== 1` → `SyncFailedError('Steam profile not found')`), `ISteamUser/GetPlayerSummaries/v2`, `IPlayerService/GetOwnedGames/v1?include_appinfo=1&include_played_free_games=1`.
  - Class `SteamPrivateProfileError extends SyncFailedError` with message `'Steam game details are private. Set Game details to Public in your Steam privacy settings.'`.

- [ ] **Step 1: Write failing tests** (axios mocked)
  - parse: `'76561198000000000'`, `'https://steamcommunity.com/profiles/76561198000000000/'` → steamId; `'https://steamcommunity.com/id/arif/'` and `'arif'` → vanity `arif`.
  - `fetchTitles` maps `{ appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 90, rtime_last_played: 1795500000 }` → `{ platform: 'steam', externalId: '1091500', title: 'Cyberpunk 2077', totalSeconds: 5400, lastPlayedAt: new Date(1795500000 * 1000) }`.
  - `GetOwnedGames` returning `{ response: {} }` → `SteamPrivateProfileError` (Review Focus 3).
  - HTTP 5xx → `SyncFailedError` whose message contains the status code, never the API key.

- [ ] **Step 2: Run** `npm test -- steam.client` → FAIL.
- [ ] **Step 3: Implement**; wire `SteamClient` into `SyncService`'s client map in `games.module.ts`.
- [ ] **Step 4: Run** tests, typecheck, lint → PASS.
- [ ] **Step 5: Commit** `feat(games): Steam owned-games client`

---

### Task 8: PSN client

**Files:**
- Create: `src/modules/games/sync/psn.client.ts` + `.spec.ts`
- Modify: `package.json` (`npm install psn-api`; check the installed version's exports match the names below and adjust only the import lines if they differ)

**Interfaces:**
- Consumes: Task 6 types and errors, `sealSecret`/`openSecret`.
- Produces:
  - `PsnSecret { npsso: string; npssoExpiresAt: string; accessToken: string; accessExpiresAt: string; refreshToken: string; refreshExpiresAt: string }` (ISO strings, stored sealed as JSON). `npssoExpiresAt` = supply time + 60 days; the connection's `secretExpiresAt` = `npssoExpiresAt`.
  - `parseIsoDuration(value: string): number` (seconds): `'PT228H56M33S'` → 824_193; `'PT45M'` → 2_700; `'PT0S'` → 0; `'P1DT2H'` → 93_600; anything else throws.
  - `psnPlatform(category: string): Platform`: `ps4_game` → ps4, `ps5_native_game` → ps5, other → ps5.
  - `psnStatus(refreshExpiresAt: Date, now: Date): 'ok' | 'expiring' | 'expired'` (expired if past, expiring if < 14 days left).
  - `PsnClient implements PlatformClient` with `connect(npsso: string): Promise<{ secret: PsnSecret; accountId: string; onlineId: string }>` (`exchangeNpssoForAccessCode` → `exchangeAccessCodeForAuthTokens`; profile for the display name) and `fetchTitles`, in order: (1) if `refreshExpiresAt < now + 3 days`, re-run the NPSSO exchange with the stored `npsso` to get fresh tokens; (2) else if `accessExpiresAt < now + 60 s`, `exchangeRefreshTokenForAuthTokens`; (3) any exchange that throws, or returns an empty `accessToken`/`refreshToken`, or a rejected NPSSO → `SecretExpiredError('PSN sign-in expired. Renew it in the tracker or paste a new NPSSO.')`; (4) page through `getUserPlayedGames(auth, 'me', { limit: 200, offset })` until all `totalItemCount` read; externalId = `titleId`; returns the new secret JSON and `secretExpiresAt` when refreshed. `statusAfter(secretExpiresAt, now)` returns `psnStatus(secretExpiresAt, now)`.

- [ ] **Step 1: Write failing tests** (`psn-api` mocked with `jest.mock`)
  - the `parseIsoDuration`, `psnPlatform`, `psnStatus` cases above (15 days → ok, 13 days → expiring, −1 s → expired).
  - refresh token with 2 days left → NPSSO exchange called, new tokens returned in the secret, `npsso`/`npssoExpiresAt` unchanged.
  - NPSSO exchange returns `{ accessToken: '' }` (silent refusal) → `SecretExpiredError` (Review Focus 4).
  - NPSSO exchange throws → `SecretExpiredError`.
  - access token valid and refresh token has 9 days → no exchange call at all.
  - two pages (`totalItemCount: 250`) → 250 titles.
  - an error thrown by `psn-api` is wrapped in `SyncFailedError` and the message never contains the access or refresh token.

- [ ] **Step 2: Run** `npm test -- psn.client` → FAIL.
- [ ] **Step 3: Implement**; wire into the client map.
- [ ] **Step 4: Run** tests, typecheck, lint → PASS.
- [ ] **Step 5: Commit** `feat(games): PSN played-games client`

---

### Task 9: Connections API

**Files:**
- Create: `src/modules/games/connections/{connections.service,connections.controller}.ts` + `connections.service.spec.ts`
- Create: `src/modules/games/dto/connection.dto.ts`

**Interfaces:**
- Consumes: `SteamClient`, `PsnClient`, `SyncService`, secret box.
- Produces (all `JwtAuthGuard`, scoped to the current user):
  - `PublicConnection { provider: Provider; externalId: string; displayName: string; status: ConnectionStatus; secretExpiresAt: Date | null; lastSyncAt; lastSuccessAt; lastError: string | null; lastGameCount: number | null }`.
  - `GET /games/connections` → `PublicConnection[]`.
  - `PUT /games/connections/steam { profile: string (1–255) }`: resolve id, fetch titles once as the test (private → 400 with the `SteamPrivateProfileError` message), upsert connection, start a sync without awaiting it (`void this.sync.syncConnection(id).catch(log)`), return `PublicConnection`.
  - `PUT /games/connections/psn { npsso: string (20–200) }`: `connect`, seal the secret, `secretExpiresAt = npssoExpiresAt`, upsert, start a sync, return `PublicConnection`. A bad NPSSO → 400 `'PSN rejected this token. Copy a fresh one and try again.'`
  - `PUT /games/tracker/psn { npsso }` with `DeviceAuthGuard` (in `tracker.controller.ts`): same as above for the device's user, so the tracker can renew PSN without copy-paste. Returns `PublicConnection`.
  - `POST /games/connections/:provider/sync` → the finished `SyncRun` (409 while one is running).
  - `DELETE /games/connections/:provider` → deletes the connection; library games and sessions stay.

- [ ] **Step 1: Write failing tests**
  - `JSON.stringify` of every service return value contains neither `secret`, the NPSSO, nor any token value.
  - user A cannot sync or delete user B's connection (404).
  - Steam private profile → `BadRequestException` with the private-profile message, nothing saved.
  - reconnecting PSN replaces the secret and resets status to `ok`.
  - `PUT /games/tracker/psn` with a revoked device token → 401; with a valid one → connection saved for that device's user only.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** tests, typecheck, lint → PASS.
- [ ] **Step 5: Commit** `feat(games): Steam and PSN connections API`

---

### Task 10: Stats read API for the dashboard

**Files:**
- Create: `src/modules/games/stats/day-split.ts` + `.spec.ts` (pure)
- Create: `src/modules/games/stats/stats.types.ts`, `stats.service.ts` + `.spec.ts`, `stats.controller.ts`

**Interfaces:**
- Consumes: entities, `CHART_EXCLUDED_SOURCES`, `TOTAL_EXCLUDED_SOURCES`, `TrackerService.nowPlaying` (Task 4), `PublicConnection` and its mapper (Task 9), user timezone (Task 1; read via the `user` table with `dataSource.query`, since `auth` is another module).
- Produces:
  - `localDate(at: Date, timeZone: string): string` (`YYYY-MM-DD`).
  - `splitIntoDays(sessions: { startedAt: Date; endedAt: Date; seconds: number }[], timeZone: string): Map<string, { seconds: number; estimated: boolean }>`: each session's `seconds` is distributed over local days in proportion to the real overlap of `[startedAt, endedAt]` with each local day; days touched by a session longer than 86 400 s are `estimated`. No new dependency: use `Intl.DateTimeFormat` with `timeZone` to find local midnights.
  - `unknownDays(runs: { startedAt: Date; ok: boolean }[], connectionCreatedAt: Date, from: string, to: string, timeZone: string): string[]`: local days from the later of `from` and creation date up to `to` with no `ok` run (only within the 90-day run history).
  - `DayPoint { date: string; seconds: number; estimated: boolean; unknownSources: Provider[] }`.
  - Routes (`JwtAuthGuard`, user-scoped):
    - `GET /games/overview` → `{ nowPlaying: NowPlaying[]; today: number; thisWeek: number; lastWeek: number; last30Days: DayPoint[]; topGames30d: { titleKey: string; title: string; seconds: number }[] (10); health: { connections: PublicConnection[]; devices: { id; name; lastSeenAt }[] } }` (weeks start Monday, local time).
    - `GET /games/sessions?from&to&libraryGameId&platform` (from/to `YYYY-MM-DD`, max 366 days) → `{ id; libraryGameId; title; platform; source; deviceId; startedAt; endedAt; seconds }[]`.
    - `GET /games/library?platform&q` → `{ titleKey; title; totalSeconds; lastPlayedAt; platforms: { platform; libraryGameId; totalSeconds }[] }[]`, sorted by `lastPlayedAt` desc. Per-platform total = `totalSeconds` if not null, else sum of sessions excluding `TOTAL_EXCLUDED_SOURCES`.
    - `GET /games/library/:id` → the group containing that game, plus `daily: DayPoint[]` (all time) and the last 100 sessions.
    - `GET /games/calendar?year` → `DayPoint[]` for every day of that year.
    - `GET /games/period?from&to&platform` (max 366 days) → `{ days: DayPoint[]; games: { titleKey: string; title: string; platforms: Platform[]; seconds: number; sessionCount: number; firstPlayedAt: Date; lastPlayedAt: Date }[]; dayGames: { date: string; titleKey: string; seconds: number }[] }`: the "pick a period, see it per day and per game" view, split by `splitIntoDays`.
  - All chart series exclude `CHART_EXCLUDED_SOURCES`.

- [ ] **Step 1: Write failing tests**

`day-split.spec.ts`:
  - Berlin, 2026-11-24T22:30Z → 2026-11-24T23:30Z (23:30–00:30 local) → `{ '2026-11-24': 1800, '2026-11-25': 1800 }` (Review Focus 2).
  - Berlin DST start: 2026-03-29T00:30Z → 2026-03-29T01:30Z (01:30 CET → 03:30 CEST) → all 3600 s on `2026-03-29`.
  - 72 h window with 18 000 s → 6000 s on each of the 3 local days, all `estimated: true`.
  - `America/Toronto` 2026-11-25T04:30Z → 05:30Z splits 1800/1800 across 24th/25th.
  - `unknownDays`: runs ok on 21st and 23rd only, range 21st–23rd → `['2026-11-22']`.

`stats.service.spec.ts`:
  - `import` and `legacy_test` sessions are absent from `last30Days` and calendar; `import` still counts in a tracker-only game's library total; `legacy_test` never does.
  - library groups `Cyberpunk 2077` on steam and ps5 into one entry with two platforms.
  - user A's request never returns user B's rows.
  - `period` for 23rd–24th with one tracker session 23:30–00:30 Berlin on Cyberpunk → `days` 1800/1800, `games` one entry with 3600 s and `sessionCount: 1`, `dayGames` two rows of 1800.
  - `period` / `sessions` with a range over 366 days → `BadRequestException`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (fetch the range's sessions once, aggregate in JS). **Step 4: Run** tests, typecheck, lint → PASS.
- [ ] **Step 5: Commit** `feat(games): stats endpoints for the dashboard`

---

### Task 11: Remove the scraper, deploy wiring

**Files:**
- Delete: `src/modules/scraping/` (whole folder)
- Modify: `src/app.module.ts`, `package.json` + lockfile (`npm uninstall cheerio slugify`, after `grep -r` confirms no other use; **keep `puppeteer`**), `Dockerfile` (comments only), `docker-compose.prod.yaml`, `README.md`, `docs/games-module.md`

**Interfaces:**
- Consumes: everything above.
- Produces: Traefik route `games.server.arifhosan.me/api/*` → backend with the `/api` prefix stripped. Chromium and Puppeteer stay available in the image (owner's call).

- [ ] **Step 1: Remove and rewire.**
  - Drop `ScrapingModule` from `app.module.ts`, delete the folder.
  - `Dockerfile`: no package changes. Only reword comments that say Chromium is for "the scraped pages" to say it is kept available for future browser automation.
  - `docker-compose.prod.yaml`: add `STEAM_API_KEY: ${STEAM_API_KEY:?STEAM_API_KEY must be set}` and `GAMES_SECRET_KEY: ${GAMES_SECRET_KEY:?GAMES_SECRET_KEY must be set}`, plus labels:
```yaml
- traefik.http.routers.games-api.rule=Host(`games.server.arifhosan.me`) && PathPrefix(`/api`)
- traefik.http.routers.games-api.entrypoints=websecure
- traefik.http.routers.games-api.tls=true
- traefik.http.routers.games-api.tls.certresolver=myresolver
- traefik.http.routers.games-api.middlewares=games-api-strip
- traefik.http.routers.games-api.service=backend
- traefik.http.middlewares.games-api-strip.stripprefix.prefixes=/api
```
  - `README.md`: modules table row for `games` (routes from Tasks 3, 4, 9, 10) replacing `scraping`; env vars; link to `docs/games-module.md`.
  - `docs/games-module.md`: **Deploy runbook** in order: (1) mysqldump the four legacy tables; (2) apply all SQL in this file; (3) set `STEAM_API_KEY` and `GAMES_SECRET_KEY` (`openssl rand -base64 32`) in the Portainer stack; (4) deploy the image; (5) legacy import dry run, then `--commit` (Task 5 runbook); (6) only then connect Steam and PSN (their first sync adopts the legacy rows). Note: the Grafana game dashboards keep reading the untouched legacy tables, which get no new rows from now on.

- [ ] **Step 2: Verify.**
  - `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint "{src,test}/**/*.ts"`, `npm run build` → PASS.
  - `grep -rni "exophase\|scraping" src` → no matches.

- [ ] **Step 3: Commit** `feat(games): remove Exophase scraper, add games deploy wiring`

---

## Later plans (not in this one)

- **Tracker plan** (Tauri, Windows): consumes `POST /games/tracker/heartbeats` and device tokens. Includes the tracker window design, which goes to the owner before it is built.
- **Dashboard plan**: mockups with the owner first, then the build against the Task 10 endpoints, the nginx container, and the Traefik host route.
