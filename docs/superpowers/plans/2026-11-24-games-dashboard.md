# Games Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web dashboard at `games.server.arifhosan.me`: sign in, overview with now playing, library, game detail, period explorer, devices and connections. Mobile friendly, professional, error free.

**Architecture:** A static single-page app (Vite + React + TypeScript) in `dashboard/`, served by an nginx container. Traefik sends `/api/*` on the same host to the existing backend (prefix stripped), so the app is same-origin and uses the backend's httpOnly session cookie. No chart library: bars are plain elements, exactly as in the approved mockups. Data via `fetch` and one small hook; no state library.

**Tech Stack:** Node 24, Vite, React 19, TypeScript, react-router (data-less `BrowserRouter`), Vitest + @testing-library/react, ESLint with `eslint-plugin-jsx-a11y`; nginx:alpine for serving.

**Spec:** `docs/superpowers/specs/2026-11-24-game-tracker-design.md` section 8. **Approved design:** the canvas https://claude.ai/artifact/Sns1hYmmJDDHSyEfCn6N5J (boards 1–7). Its source files are in `D:/Personal/agents/dashboard-mockup/project/*.dc.html`. Copy the look (colours, type, spacing, components, copy) from those files; their data is sample data.

## Global Constraints

- Lives in `dashboard/` of the `server-backend` repo, branch `feat/games` rules (no push; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Before each commit, in `dashboard/`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass.
- API base is `/api` (same origin). Every request uses `credentials: 'same-origin'`. A 401 from any call except `/auth/login` redirects to `/login?next=<path>`. Never store tokens in localStorage; the session lives in the httpOnly cookie.
- Look, verbatim from the mockups: background `#0E1014`; header `#12151B`; cards `#161920` with border `#22262F`, radius 14 px; text `#E8EAEE`; muted `#A3AAB8`; faint `#7D8594`; accent `#5B9BFF` (links `#8AB6FF`); success `#4ADE80`; warning text `#F5B544`/`#F5D9A0` on `#221C10` with border `#5A4318`; platform chips Steam `#1A2A44`/`#9CC2FF`, PlayStation `#3A2A10`/`#FBC46A`, Xbox app `#25330F`/`#C5EF7A`; Inter for text, Space Grotesk for headings and numbers (Google Fonts); define them once as CSS variables in `src/styles/tokens.css`.
- Mobile: works from 360 px wide. Header nav becomes a bottom tab bar under 720 px (board 6); tables scroll inside their card; nothing scrolls the page horizontally.
- Accessibility: real `<button>`/`<a>`/`<label>`; visible focus ring (`2px solid #5B9BFF`); 44 px touch targets; charts have `role="img"` and an `aria-label` that states the key numbers; sortable headers carry `aria-sort`; `prefers-reduced-motion` respected; no emoji anywhere.
- Durations shown as `3h 05m`, under an hour `45m`, zero as `—`. One helper, used everywhere.
- Dates and "today" follow the user's timezone from `/auth/me` (`timezone`), never the browser's.
- Unknown is not zero: `DayPoint.unknownSources` non-empty → hatched bar plus "unknown" in its tooltip.
- Game art: `imageUrl` → `<img alt="" loading="lazy">`; else `hasIcon` → `/api/games/library/<libraryGameId>/icon`; else an initials tile. Images that fail to load fall back to the tile.
- No feature the backend lacks: no password reset, no password or timezone change.

## API used (exists on `feat/games`)

- `POST /auth/login {email,password}` · `POST /auth/register {firstName,lastName,email,password}` (8–72 chars) · `POST /auth/logout` · `GET /auth/me` → `{id,email,firstName,lastName,timezone}`
- `GET /games/now` → `NowPlaying[]`; `GET /games/overview` → `Overview`; `GET /games/library` → `LibraryEntry[]`; `GET /games/library/:id` → `GameDetail` (`daily` sparse, last 100 sessions); `GET /games/period?from&to` → `Period`; `GET /games/sessions?from&to` → `SessionRow[]`
- `GET|POST /games/devices`, `PATCH|DELETE /games/devices/:id`; `GET /games/connections`, `PUT /games/connections/steam {profile}`, `PUT /games/connections/psn {npsso}`, `POST /games/connections/:provider/sync`, `DELETE /games/connections/:provider`
- Types: copy `src/modules/games/stats/stats.types.ts`, `PublicConnection`, `PublicDevice`, `NowPlaying` into `dashboard/src/api/types.ts` (dates as ISO strings), plus `imageUrl: string | null; hasIcon: boolean` on game objects (backend Task 12).

## Review Focus

1. **Session expiry while the tab is open** → next call gets 401 → redirect to sign-in, then back to the same page. Test in Task 1.
2. **Timezone boundaries** → "today", week (Mon–Sun) and month ranges computed in the user's timezone, not the browser's. Test in Task 2.
3. **Empty states**: a new user with no devices, no connections, no games → helpful empty states with the next step, never a blank chart or `NaN`. Test in Tasks 2–5.
4. **Long titles and many games** (300+ in the library, 60-char titles) → truncate with ellipsis plus a full-title tooltip; the table stays usable on a phone. Test in Task 3.
5. **Failed requests** → inline error with Retry, never an endless spinner. Test in Task 1 (hook) and used everywhere.

---

### Task 1: Scaffold, tokens, shell, API client, auth, sign-in page

**Files:** Create `dashboard/{package.json,vite.config.ts,tsconfig.json,index.html,eslint.config.js,.gitignore}`, `dashboard/src/{main.tsx,App.tsx}`, `src/styles/{tokens.css,base.css}`, `src/api/{client.ts,types.ts}`, `src/lib/{format.ts,useApi.ts}`, `src/auth/AuthContext.tsx`, `src/components/{AppShell.tsx,Card.tsx,ErrorState.tsx,EmptyState.tsx,Spinner.tsx}`, `src/pages/LoginPage.tsx`, tests beside them.

**Interfaces:**
- Produces: `api<T>(path: string, init?: RequestInit): Promise<T>` (prefixes `/api`, JSON in/out, throws `ApiError {status, message}`; on 401 except `/auth/login` calls the registered `onUnauthorized`); `formatDuration(seconds: number): string`; `useApi<T>(path: string | null, deps?): { data?: T; error?: ApiError; loading: boolean; reload(): void }`; `AuthContext` with `user`, `login(email,password)`, `register(dto)`, `logout()`; `<AppShell>` with the header nav (Overview, Library, Period, Devices & connections) and the phone bottom tab bar; routes `/login`, `/`, `/library`, `/games/:id`, `/period`, `/settings` (pages other than login are placeholders until their task).
- Vite dev proxy: `/api` → `http://localhost:3000`, rewrite strips `/api`.

- [ ] **Step 1: Failing tests:** `formatDuration(0)` → `'—'`, `(2700)` → `'45m'`, `(11100)` → `'3h 05m'`, `(5040)` → `'1h 24m'`; `api` sends `credentials: 'same-origin'` and JSON; a 401 on `/games/overview` calls `onUnauthorized` once; a 401 on `/auth/login` throws `ApiError(401)` without calling it (Review Focus 1); `useApi` exposes `error` and `reload()` re-fetches (Review Focus 5); LoginPage: tabs switch forms; wrong credentials show "Email or password is wrong. Check both and try again."; register password shorter than 8 shows the hint as an error and does not submit; after login it navigates to `next` or `/`.
- [ ] **Step 2–4:** run → FAIL; implement (sign-in page exactly as board 7); lint, typecheck, test, build → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): scaffold, shell, API client, sign-in`

### Task 2: Overview

**Files:** Create `src/pages/OverviewPage.tsx`, `src/components/{NowPlayingCard.tsx,HealthBanner.tsx,StatCard.tsx,DayBarChart.tsx,GameArt.tsx,TopGames.tsx}`, `src/lib/dates.ts` + tests.

**Interfaces:**
- Consumes: `/games/overview`, `/games/now` (poll every 30 s while `document.visibilityState === 'visible'`), `/games/period?from&to` for the chart toggle.
- Produces: `weekRange(today: string): {from, to}` (Mon–Sun containing `today`), `monthRange(today)`, `todayIn(timeZone: string, now?: Date): string`, `fillDays(points: DayPoint[], from, to): DayPoint[]` (missing days → 0 seconds, not unknown); `<DayBarChart days labelEvery? futureAfter?>` (single colour `#5B9BFF`, hatched unknown, future days greyed, tooltip per bar, `role="img"` label with the total and the best day); `<GameArt imageUrl hasIcon libraryGameId title size>`.
- Layout and copy as board 1: now-playing card (only when `/games/now` is non-empty; session time ticks locally each second from `startedAt`); health banner for each connection `expiring` ("PSN sign-in expires in N days…", Renew → `/settings`), `expired`, `failing` (shows `lastError`); stat cards Today, This week (+/− vs last week), Last 30 days (sum of `last30Days`, "N days unknown"), Sources (tracker devices seen < 10 min = Live; each connection's last sync); chart with the **This week / This month** toggle; top games (link to game detail via the first platform's `libraryGameId`).
- [ ] **Step 1: Failing tests:** `weekRange('2026-11-24')` → `2026-11-23..2026-11-29`; `todayIn('America/Toronto', 2026-11-25T03:00Z)` → `'2026-11-24'` (Review Focus 2); `fillDays` fills gaps with 0; chart marks unknown and future days; overview with no devices/connections/games shows the empty state "Install the tracker or connect Steam to start" with links (Review Focus 3); now-playing hidden when empty; banner text for `expiring` with 9 days.
- [ ] **Step 2–4:** FAIL → implement → PASS (lint, typecheck, test, build).
- [ ] **Step 5: Commit** `feat(dashboard): overview with now playing and week/month chart`

### Task 3: Library and game detail

**Files:** Create `src/pages/{LibraryPage.tsx,GamePage.tsx}`, `src/components/{SortableTable.tsx,PlatformChip.tsx,RangeToggle.tsx}`, `src/lib/sort.ts` + tests.

**Interfaces:**
- Library (board 2): `/games/library` plus `/games/period` for the last 30 days, joined on `titleKey` → columns Game (art + title), Platforms, Total, Last 30 days, Last played; client-side sort on every column except Platforms (`aria-sort`, default Total desc), platform filter chips (All, Steam, PlayStation, Xbox app, Other PC), search (case- and accent-insensitive). Row click goes to `/games/<first platform libraryGameId>`.
- Game detail (board 3): `/games/library/:id` → header with art, chips, Total, Sessions in list, Last played; per-platform cards; chart with 30 days / 90 days / 1 year / All (fill the sparse `daily` over the range; All = from first day with play); stats line In range / Daily average / Best day; sessions table (date, time range, device name or "PlayStation sync"/"Steam sync", duration). 404 → "This game isn't in your library" with a link back.
- [ ] **Step 1: Failing tests:** sort by title (locale), total, last played (nulls last) both directions; filter PlayStation matches ps4 and ps5; search "pokemon" finds "Pokémon"; a 60-char title truncates with `title` attribute (Review Focus 4); rendering 400 rows stays under 200 ms in the test; game detail fills a 30-day range from 3 sparse points; 404 state.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): library and game detail`

### Task 4: Period explorer

**Files:** Create `src/pages/PeriodPage.tsx`, `src/components/StackedDayChart.tsx` + tests.

**Interfaces:**
- Board 4: presets This week / Last week / This month / Last 30 days, plus From/To date inputs (max 366 days; invalid range shows an inline error and keeps the last result); totals Total / Games / Sessions; stacked chart per day by game (top 4 by time + Other, colours `#5B9BFF #F59E0B #A3E635 #C084FC #7D8594`, legend); Per game table (time, share, sessions); All sessions by day from `/games/sessions?from&to`, newest day first, each day with its total. Range kept in the URL query (`?from=&to=`) so it can be shared or reloaded.
- [ ] **Step 1: Failing tests:** presets compute ranges in the user's timezone; top-4-plus-Other grouping sums correctly; URL round-trip; range over 366 days shows the error and makes no request; empty period shows "No play in this period".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): period explorer`

### Task 5: Devices and connections

**Files:** Create `src/pages/SettingsPage.tsx`, `src/components/{DeviceList.tsx,NewTokenCard.tsx,SteamCard.tsx,PsnCard.tsx,AccountCard.tsx}` + tests.

**Interfaces:**
- Board 5: download card with the button linking to `https://github.com/ArifHosan/server-backend/releases/latest/download/GameTracker-setup.exe` and the three steps; new device token (name 1–100 chars) → shows the token once with Copy (clipboard API, fallback select-all) and "shown only once"; devices list (live dot if seen < 10 min, "Seen N ago", token prefix, Rename inline, Revoke with a confirm step in the row, revoked ones greyed); Steam card (connect form when absent: profile URL or name; when present: status chip, last sync, Sync now, Change profile, Disconnect with confirm); PSN card (connect/renew form with the three steps and links to playstation.com and `https://ca.account.sony.com/api/v1/ssocookie`, password-type input, countdown from `secretExpiresAt`, status chip, last sync, Sync now, Disconnect); account card (email, timezone read-only, Sign out).
- Errors from the API (`lastError`, 400 messages) are shown verbatim in the card; 409 on Sync now → "A sync is already running".
- [ ] **Step 1: Failing tests:** token shown once and gone after navigating away; revoke needs confirm; Steam 400 private-profile message shown; PSN countdown "Expires in 9 days" and expired state; Sync now 409 text; empty state with no devices points at the download card (Review Focus 3).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): devices and connections`

### Task 6: Container, routing, release workflow

**Files:** Create `dashboard/{Dockerfile,nginx.conf,.dockerignore}`, `.github/workflows/dashboard-image.yml`; modify `docker-compose.prod.yaml`, `README.md`, `docs/games-module.md`.

**Interfaces:**
- Dockerfile: `node:24-slim` build stage (`npm ci && npm run build`) → `nginx:alpine` serving `dist/`.
- nginx: SPA fallback (`try_files $uri /index.html`); `index.html` `Cache-Control: no-cache`; hashed assets `max-age=31536000, immutable`; headers `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Content-Security-Policy: default-src 'self'; img-src 'self' https://cdn.cloudflare.steamstatic.com https://image.api.playstation.com data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'` (adjust the PSN image host to what Task 12 stores; check `imageUrl` values in tests/fixtures).
- Workflow: on push to `master` touching `dashboard/**`, build ARM64, push `ghcr.io/arifhosan/server-dashboard:latest` (mirror `docker-image.yml`).
- Compose: service `dashboard` with Traefik router `games` on ``Host(`games.server.arifhosan.me`)`` (websecure, TLS, certresolver myresolver, port 80). The existing `games-api` router has the longer rule, so it wins for `/api`.
- Docs: deploy step for the dashboard in `docs/games-module.md`; README mention.
- [ ] **Step 1:** `docker build -t server-dashboard:local dashboard` succeeds; `docker run -p 8080:80` serves `/` and `/library` (SPA fallback) with the headers above (`curl -I`).
- [ ] **Step 2: Commit** `feat(dashboard): nginx image, Traefik routing, release workflow`

### Task 7: Visual and accessibility check (controller)

- [ ] Run `npm run dev` against a local backend (or the API mocked with fixture JSON from the tests), open every page at 1280 px and 390 px in Chrome, compare with the boards, check focus order and contrast, and fix differences through the owning task's implementer.
