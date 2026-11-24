# Game Tracker Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal Windows tray app that detects running PC games, reports play sessions to the backend, and shows now playing, today's time, connection and PSN status.

**Architecture:** Tauri v2. All logic in Rust (`tracker/src-tauri/src`): pure parsers and matchers with unit tests, a poll loop, a sender with an offline queue, and a status poller. The window is plain HTML/CSS/JS (`tracker/ui`, no framework, no bundler) that renders state pushed from Rust via Tauri events and calls a few Tauri commands.

**Tech Stack:** Rust 1.99 (stable, MSVC), Tauri 2 + plugins `autostart`, `updater`, `single-instance`, `opener`; crates `sysinfo`, `reqwest` (rustls, json, blocking off), `tokio`, `serde`/`serde_json`, `keyring`, `chrono`, `windows-icons` + `image` (icons); dev: `mockito`, `tempfile`.

**Spec:** `docs/superpowers/specs/2026-11-24-game-tracker-design.md` section 7 (Tracker) and 6.5 (ingest API). Backend endpoints come from `docs/superpowers/plans/2026-11-24-games-backend.md` Tasks 3, 4 and 12.

## Global Constraints

- Lives in `tracker/` of the `server-backend` repo; branch `feat/games` work rules apply (no push; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Windows only. Must build with `cargo build` and pass `cargo test` and `cargo clippy -- -D warnings` in `tracker/src-tauri`.
- Detection every **15 s**; one heartbeat per running game every **60 s**; status poll every **10 min**; library index rebuilt at start and every **10 min**.
- Heartbeat body exactly as backend Task 4: `POST {server}/games/tracker/heartbeats` with `{ "heartbeats": [ { "at": ISO-8601 UTC, "game": { "store": "steam"|"xbox"|"epic"|"other", "storeId"?: string, "title": string, "exe"?: string } } ] }`, header `Authorization: Bearer <device token>`.
- Offline queue: JSON lines file `%APPDATA%\GameTracker\queue.jsonl`; flushed oldest first in batches ≤ **500**; entries older than **30 days** dropped.
- Device token only in Windows Credential Manager (`keyring`, service `GameTracker`, user `device-token`); never logged, never written to settings or queue files.
- Default server URL `https://games.server.arifhosan.me/api`. Dashboard URL = server URL with a trailing `/api` removed.
- No PSN code. PSN status comes only from `GET {server}/games/tracker/status`.
- Window ~360×440, not resizable, hidden to tray on close; one instance only; follows Windows light/dark (`prefers-color-scheme`); no emoji in UI text.
- UI states and copy (approved by the owner):
  - Playing: `NOW PLAYING` / `<title>` / `<Store> · <h>h <m>m this session`
  - Idle: `Not playing`
  - Always: `Today on this PC  <h>h <m>m`
  - Connection: `Connected · last sent <n> s ago` | `Offline · <n> heartbeats waiting` | red banner `This device was removed in the dashboard` + token field
  - PSN (only when the API says `expiring`/`expired`): `PSN sign-in expires in <n> days` | `PSN sign-in expired`, button `Renew` → opens `<dashboard>/connections`
  - Footer buttons `Settings`, `Pause`/`Resume`
  - Settings: Server, Device token (`gt_xxxxxx••••••••` + `Paste`/`Remove`), `Start with Windows` (default on), Ignored games (remove with ×)
  - Tray: idle icon grey, playing icon green; menu `Open`, `Pause`/`Resume`, `Quit`.

## Review Focus

1. **Game helper processes** (crash handlers, anti-cheat, launchers inside the game folder) → never reported as separate games. Test in Task 3.
2. **Steam library on a second drive** (`libraryfolders.vdf` lists several paths) → games there are detected. Test in Task 2.
3. **PC offline for hours, then back** → queued heartbeats sent in order, none lost, none sent twice after a successful batch. Test in Task 4.
4. **Device token revoked in the dashboard** (401) → sending stops, queue kept, banner shown; a new pasted token resumes sending. Test in Task 4.
5. **Two games running at once** → both get heartbeats and both appear in state; UI shows the most recently started. Test in Tasks 3 and 5.

---

### Task 1: Scaffold, tray, window, settings, token storage

**Files:**
- Create: `tracker/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,icons/*}`, `tracker/src-tauri/src/{main.rs,settings.rs,token.rs,state.rs}`, `tracker/ui/{index.html,style.css,app.js}`, `tracker/README.md`, `tracker/.gitignore` (`target/`)

**Interfaces:**
- Produces:
  - `Settings { server_url: String, start_with_windows: bool, paused: bool, ignored: Vec<String> /* titles */, sent_icons: Vec<String> /* game keys */ }` with `Settings::load(dir: &Path) -> Settings` (defaults when missing/corrupt) and `save(&self, dir: &Path) -> io::Result<()>`; file `settings.json` in the app config dir.
  - `dashboard_url(server_url: &str) -> String`.
  - `token::{get() -> Option<String>, set(&str) -> Result<()>, clear() -> Result<()>}` (keyring); `token::mask(&str) -> String` → first 9 chars + `••••••••`.
  - `AppState` (in `state.rs`, behind `Arc<Mutex<_>>`): `{ playing: Vec<RunningGame>, today_seconds: u64, connection: Connection /* Ok{last_sent_at} | Offline{queued} | Revoked | NoToken */, psn: Option<PsnBanner>, paused: bool }`; emitted to the UI as event `state` (JSON) on every change.
  - Tauri commands: `get_state`, `get_settings`, `save_settings(server_url, start_with_windows)`, `set_token(token)`, `remove_token`, `set_paused(bool)`, `unignore(title)`, `open_dashboard(path)`.
- [ ] **Step 1: Failing tests:** `Settings::load` on a missing dir returns defaults (`server_url` = default URL, `start_with_windows` true); round-trip save/load; corrupt JSON → defaults; `dashboard_url("https://games.server.arifhosan.me/api")` → `"https://games.server.arifhosan.me"`, with trailing slash too; `mask("gt_abcdefghijk")` → `"gt_abcdef••••••••"`.
- [ ] **Step 2: Run** `cargo test` → FAIL.
- [ ] **Step 3: Implement.** Tray + hidden-on-close window + single instance + autostart plugin wired to `start_with_windows`. UI renders every state listed in Global Constraints from a static `get_state` (no detection yet); light/dark via CSS variables on `:root` and `@media (prefers-color-scheme: dark)`.
- [ ] **Step 4: Run** `cargo test`, `cargo clippy -- -D warnings`, `cargo build` → PASS; `cargo tauri dev` opens the window (manual check, note it in the report).
- [ ] **Step 5: Commit** `feat(tracker): Tauri shell with tray, settings and token storage`

### Task 2: Library index (Steam, Xbox app, Epic, fallback)

**Files:** Create `tracker/src-tauri/src/library/{mod.rs,steam.rs,xbox.rs,epic.rs}`, fixtures under `tracker/src-tauri/tests/fixtures/{steam,xbox,epic}/`.

**Interfaces:**
- Produces: `InstalledGame { store: Store /* Steam|Xbox|Epic|Other */, store_id: Option<String>, title: String, install_dir: PathBuf, logo: Option<PathBuf> }`; `build_index(roots: &Roots) -> Vec<InstalledGame>` where `Roots { steam: Option<PathBuf>, drives: Vec<PathBuf>, epic_manifests: PathBuf, fallback: Vec<PathBuf> }`; `Roots::detect() -> Roots` (Steam path from `HKCU\Software\Valve\Steam\SteamPath`; drives = existing fixed drive roots; Epic = `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests`; fallback = `Ubisoft Game Launcher\games`, `EA Games`, `GOG Galaxy\Games` under Program Files and drive roots).
  - Steam: parse `steamapps/libraryfolders.vdf` for every `"path"`; in each `<path>/steamapps/appmanifest_*.acf` read `appid`, `name`, `installdir`; install dir = `<path>/steamapps/common/<installdir>`. Line-based key/value parsing (`"key"<ws>"value"`), unescape `\\`.
  - Xbox: `<drive>\XboxGames\<Folder>\Content`; title from `MicrosoftGame.config` (`<ShellVisuals DefaultDisplayName=…>`, else `<Identity Name=…>`, else folder name); `store_id` = `Identity Name`; `logo` = `ShellVisuals Square150x150Logo` resolved against `Content`.
  - Epic: each `*.item` JSON → `DisplayName`, `InstallLocation`, `AppName` (store_id).
  - Fallback: each subfolder = one game, title = folder name, store `Other`.
- [ ] **Step 1: Failing tests** with fixtures: a `libraryfolders.vdf` with two libraries (`C:\\Program Files (x86)\\Steam` and `D:\\SteamLibrary`) → manifests from both found (Review Focus 2); `appmanifest_1091500.acf` → `{store_id: "1091500", title: "Cyberpunk 2077", install_dir: …/common/Cyberpunk 2077}`; a `MicrosoftGame.config` with DefaultDisplayName → that title and logo path; config missing → folder name; an Epic `.item` → title/install dir; unreadable/garbled files are skipped, never panic.
- [ ] **Step 2–4:** run → FAIL; implement; `cargo test` + clippy → PASS.
- [ ] **Step 5: Commit** `feat(tracker): installed game index for Steam, Xbox app, Epic and other`

### Task 3: Running-game matcher and poll loop

**Files:** Create `tracker/src-tauri/src/detect.rs`; modify `main.rs`.

**Interfaces:**
- Consumes: `InstalledGame`, `Settings.ignored`.
- Produces: `RunningGame { key: String /* "<store>:<store_id or folder title>" */, store, store_id, title, exe: String, started_at: DateTime<Utc> }`; `match_running(index: &[InstalledGame], exes: &[PathBuf], ignored: &[String]) -> Vec<(InstalledGame, String /*exe file name*/)>` (one entry per game, even when several of its processes run); `is_helper(exe_name: &str) -> bool` built-in list (case-insensitive): `UnityCrashHandler32.exe`, `UnityCrashHandler64.exe`, `CrashReportClient.exe`, `EasyAntiCheat*.exe`, `BEService*.exe`, `*Helper*.exe`, `*Launcher*.exe`, `steamwebhelper.exe`, `vc_redist*.exe`, `DXSETUP.exe`, `*crash*.exe`.
  - Poll loop (tokio, every 15 s, skipped while paused): `sysinfo` process exe paths → `match_running` → update `AppState.playing` (keep `started_at` for games still running; new games get `now`) → emit `state`.
- [ ] **Step 1: Failing tests:** exe inside `…/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe` → that game; exe in an unrelated folder → none; only `UnityCrashHandler64.exe` running inside a game folder → none (Review Focus 1); game exe + its helper → one entry; two games → two entries (Review Focus 5); ignored title → none; path comparison case-insensitive.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ clippy).
- [ ] **Step 5: Commit** `feat(tracker): detect running games`

### Task 4: Sender, offline queue, revoked token

**Files:** Create `tracker/src-tauri/src/{api.rs,queue.rs,sender.rs}`; modify `main.rs`, `state.rs`.

**Interfaces:**
- Consumes: `RunningGame`, `token::get`, `Settings.server_url`.
- Produces:
  - `Heartbeat { at: DateTime<Utc>, game: HeartbeatGame { store: &'static str /* steam|xbox|epic|other */, store_id: Option<String>, title, exe: Option<String> } }` serialised exactly as Global Constraints (camelCase `storeId`).
  - `Queue::open(path) -> Queue`; `push(&mut self, hbs: &[Heartbeat]) -> io::Result<()>`; `peek_batch(&self, max: usize, now) -> Vec<Heartbeat>` (drops entries older than 30 days first); `ack(&mut self, n: usize) -> io::Result<()>` (removes the first n, rewrites the file atomically via temp + rename).
  - `Api::send_heartbeats(&self, token, &[Heartbeat]) -> Result<(), SendError>` where `SendError::{Unauthorized, Network(String), Server(u16)}`.
  - Sender loop every 60 s: build one heartbeat per running game, `push` all, then flush: `peek_batch(500)` → send → on `Ok` `ack`, repeat until empty; on `Network`/`Server` stop and set `Connection::Offline{queued}`; on `Unauthorized` stop, set `Connection::Revoked`, keep the queue; no token → `Connection::NoToken`, keep queuing. Successful flush → `Connection::Ok{last_sent_at}`. `set_token` triggers an immediate flush.
  - `today_seconds`: sum of 60 s per heartbeat generated today (local date), persisted in `today.json` `{date, seconds}`; resets at local midnight.
- [ ] **Step 1: Failing tests** (`mockito` server, `tempfile` queue): JSON body shape and `Authorization` header exact; 600 queued → two requests (500 + 100) in order; network error after first batch → first 500 acked, 100 remain (Review Focus 3); a crash between send and ack (simulate by not calling ack) re-sends the same batch — acceptable, backend is idempotent; 401 → `Revoked`, queue untouched (Review Focus 4); entries older than 30 days dropped by `peek_batch`; queue file survives reopen.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ clippy).
- [ ] **Step 5: Commit** `feat(tracker): heartbeat sender with offline queue`

### Task 5: Status poll and live UI

**Files:** Modify `api.rs`, `main.rs`, `state.rs`, `tracker/ui/*`.

**Interfaces:**
- Consumes: `GET {server}/games/tracker/status` → `{ psn: { status: "ok"|"expiring"|"expired"|"failing"|"disabled", expiresAt: string|null } | null }`.
- Produces: `psn_banner(status: &TrackerStatus, now) -> Option<PsnBanner>` (`expiring` → `ExpiresIn{days}` with days = ceil((expiresAt − now)/1 day); `expired` → `Expired`; anything else or `null` → `None`); poller every 10 min and right after a token is set; UI: session time ticks every second client-side from `started_at`; when two games run, show the most recently started (Review Focus 5); `Renew` → `open_dashboard("/connections")`; tray icon switches grey/green with `playing.is_empty()`.
- [ ] **Step 1: Failing tests:** `psn_banner` cases (9.2 days → 10; expired; ok → None; null → None); status 401 → `Revoked`.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ clippy). Manual check with `cargo tauri dev` against a `mockito`-free local stub is optional; describe what was checked in the report.
- [ ] **Step 5: Commit** `feat(tracker): PSN status, live now playing and tray state`

### Task 6: Game icons

**Files:** Create `tracker/src-tauri/src/icons.rs`; modify `api.rs`, `sender.rs`.

**Interfaces:**
- Consumes: `InstalledGame.logo`, running exe path, `PUT {server}/games/tracker/icon` body `{ game: { store, storeId?, title }, png: base64 }` (backend Task 12), `Settings.sent_icons`.
- Produces: `icon_png(game: &InstalledGame, exe: &Path) -> Option<Vec<u8>>`: Xbox `logo` PNG if present; else the exe icon via `windows-icons`; encoded as PNG, downscaled to ≤ 128 px if larger; `None` when the result is still > 65 536 bytes. Skipped for Steam (the backend uses Steam's CDN). Sent once per game key on the first heartbeat of a session when not in `sent_icons`; on 2xx the key is added and settings saved; failures retried next session.
- [ ] **Step 1: Failing tests:** downscale of a 512 px PNG → ≤ 128 px and ≤ 64 KB; Steam game → no upload; second session of the same game → no upload; non-2xx → key not stored.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ clippy).
- [ ] **Step 5: Commit** `feat(tracker): send game icons once`

### Task 7: Installer, autostart, auto-update, release workflow

**Files:** Modify `tauri.conf.json`, `Cargo.toml`; create `.github/workflows/tracker-release.yml`; update `tracker/README.md`.

**Interfaces:**
- Produces: NSIS installer (per-user install, no admin); updater endpoint `https://github.com/ArifHosan/server-backend/releases/latest/download/latest.json`; daily update check; workflow on tag `tracker-v*` (windows-latest: install Rust, `npm`-free `cargo install tauri-cli --locked`, `cargo tauri build`, upload the installer under the stable name `GameTracker-setup.exe` (the dashboard links to `releases/latest/download/GameTracker-setup.exe`) plus `latest.json` and signatures to the release using `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets).
  - README: install steps, where to create a device token (dashboard → Devices), SmartScreen note (unsigned binary), how to generate the updater key (`cargo tauri signer generate`) and which two GitHub secrets the owner must add (owner action; never commit the private key).
- [ ] **Step 1:** `cargo tauri build` locally produces an NSIS installer under `target/release/bundle/nsis/` (updater signing skipped locally if no key; document the flag).
- [ ] **Step 2:** `actionlint` (if available) or YAML parse of the workflow passes.
- [ ] **Step 3: Commit** `feat(tracker): installer, autostart, updater and release workflow`
