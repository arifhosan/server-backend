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

```
src/
  common/        filters and helpers shared across modules
  database/      TypeORM entities, transformers and connection config
  modules/       one folder per feature (controller, service, dto, ...)
  main.ts        bootstrap: CORS, validation pipe, exception filter
```

Imports use the `@/` alias for `src/`, e.g. `import { User } from '@/database/entities/user.entity'`.

## Getting started

```bash
npm ci
cp .env.example .env    # then fill in real values
npm run start:dev
```

`JWT_SECRET` is required; the app refuses to start without it. See
`.env.example` for every variable.

### Docker

```bash
docker compose up --build
```

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
