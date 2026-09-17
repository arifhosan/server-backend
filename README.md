# server-backend

Personal API backend built with [NestJS](https://nestjs.com/) and TypeORM/MySQL.
It exposes a few unrelated endpoints used by personal projects: JWT auth, a
Home Assistant proxy for local bus times, and a nightly scraper that tracks
game playtime.

## Modules

| Module     | Routes                            | What it does                                                                 |
| ---------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `auth`     | `POST /auth/register`, `POST /auth/login`, `GET /auth/verify` | Registration and JWT issuing/verification. |
| `ha`       | `GET /ha/aseag/route/:routeId`    | Cached proxy for the ASEAG public-transport endpoint (10 minute TTL).         |
| `scraping` | `GET /test`, `GET /test/games`    | Scrapes Exophase for playtime; also runs nightly at 23:00 via cron.           |

The `test` prefix is historical. It is kept so existing callers keep working.

## Layout

This repo is one deployable serving several **unrelated** sub-projects. Each
folder under `src/modules/` is self-contained and owns everything only it uses -
its entities, DTOs, helpers, types. There is deliberately no shared `services/`
or `entities/` folder collecting unrelated things.

```
src/
  common/        genuinely cross-cutting: exception filter, error helpers
  database/      the connection itself, and column transformers
  modules/
    auth/        controller, service, dto/, entities/, types/
    ha/
    scraping/    controller, service, dto/, entities/, scrapers/, utils/
  main.ts        bootstrap: CORS, validation pipe, exception filter
```

**Modules must not import each other.** A module may use `src/common` and
`src/database`; reaching into a sibling is a lint error
(`boundaries/no-cross-module-import` in `eslint.config.mjs`). If two modules
genuinely need the same thing, it belongs in `src/common` or `src/database`.

Within a module, imports are relative (`./entities/user.entity`). The `@/` alias
is for shared infrastructure only (`@/common/...`, `@/database/...`).

### Adding a sub-project

1. Create `src/modules/<name>/` with its own `<name>.module.ts`.
2. Keep its entities in `src/modules/<name>/entities/` and register them with
   `TypeOrmModule.forFeature([...])`. `autoLoadEntities` picks them up, so no
   central registry needs editing.
3. Import the module in `src/app.module.ts`. That is the only shared file a new
   sub-project touches.

## Getting started

```bash
npm ci
cp .env.example .env    # then fill in real values
npm run start:dev
```

Node is pinned with [Volta](https://volta.sh/) (`node` 24, `npm` 11) in
`package.json`. With Volta installed the right versions are selected
automatically; without it, use Node 24 or newer.

NestJS 12 is published ESM-only, so the test scripts run Jest with
`NODE_OPTIONS=--experimental-vm-modules`. Jest gates its `require(esm)`
support on `vm.SourceTextModule`, which only exists under that flag.

`JWT_SECRET` is required; the app refuses to start without it. See
`.env.example` for every variable.

### Docker

```bash
docker compose up --build
```

The image is built from `node:24-slim` (Debian bookworm) in two stages rather
than from a prebuilt puppeteer image. Chrome for Testing has no linux-arm64
build, so Chromium comes from Debian's own package (152.x, one major from the
Chrome 153 puppeteer pins) and `PUPPETEER_EXECUTABLE_PATH` points at it. The app
runs as a non-root user with `dumb-init` as PID 1.

## Scripts

| Command             | Purpose                        |
| ------------------- | ------------------------------ |
| `npm run build`     | Compile to `dist/`             |
| `npm run start:dev` | Watch mode                     |
| `npm test`          | Unit tests                     |
| `npm run test:e2e`  | End-to-end tests (needs MySQL) |
| `npm run lint`      | ESLint with `--fix`            |

## Notes and known issues

- **`DB_SYNC`** controls TypeORM's `synchronize`. Leave it `false` outside local
  development: when on, TypeORM issues DDL on every boot and will drop columns
  that no longer appear on an entity. There is no migration setup yet, so
  schema changes currently have to be applied by hand.
- **`Game.playtimeMs` holds seconds, not milliseconds.** The scraper has always
  written seconds and the column was never renamed. Every stored row and
  consumer assumes seconds; treat the name as historical.
- **The `utilities` table is orphaned.** Its module was removed; the table was
  left in place. Drop it manually if the data is not worth keeping.
- **`HaController` disables TLS verification** via `rejectUnauthorized: false`.
  The ASEAG endpoint is plain HTTP so the agent is unused today, but this would
  matter if the host ever redirects to HTTPS.
