# Project Structure

Дата индексации: 2026-06-01.

## Дерево ключевых папок

Сканировались рабочие зоны без `node_modules` и `dist`.

```text
.
├── AGENTS.md
├── apps
│   ├── api
│   │   ├── prisma
│   │   │   ├── migrations
│   │   │   ├── schema.prisma
│   │   │   └── seed.ts
│   │   ├── src
│   │   │   ├── auth
│   │   │   ├── catalog-links
│   │   │   ├── directories
│   │   │   ├── feeds
│   │   │   ├── files
│   │   │   ├── health
│   │   │   ├── map
│   │   │   ├── objects
│   │   │   ├── prisma
│   │   │   ├── search
│   │   │   ├── users
│   │   │   ├── wordpress-import
│   │   │   ├── app.module.ts
│   │   │   └── main.ts
│   │   ├── tests
│   │   ├── .env.example
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web
│       ├── public
│       ├── src
│       │   ├── admin
│       │   ├── auth
│       │   ├── catalog
│       │   ├── components
│       │   ├── files
│       │   ├── lib
│       │   ├── map
│       │   ├── objects
│       │   ├── App.tsx
│       │   ├── app-theme.css
│       │   ├── appTheme.ts
│       │   ├── main.tsx
│       │   └── styles.css
│       ├── tests
│       ├── .env.example
│       ├── Dockerfile
│       ├── package.json
│       └── server.mjs
├── docker
│   └── postgres
│       └── init
├── docs
├── packages
│   └── shared
│       ├── src
│       │   ├── index.ts
│       │   ├── search-normalization.cjs
│       │   ├── search-normalization.d.cts
│       │   └── search-normalization.mjs
│       └── package.json
├── rules
├── tools
│   ├── feed-import
│   │   ├── src
│   │   ├── tests
│   │   └── package.json
│   └── wp-import
│       ├── src
│       ├── tests
│       ├── .env.example
│       └── package.json
├── .env.example
├── docker-compose.yml
├── package.json
└── pnpm-workspace.yaml
```

## Workspace

Workspace packages заданы в `pnpm-workspace.yaml`: `apps/*`, `packages/*`, `tools/*`.

Корневой `package.json` оркестрирует build/test/dev/import команды. Package-level scripts находятся в `apps/web/package.json`, `apps/api/package.json`, `packages/shared/package.json`, `tools/wp-import/package.json`, `tools/feed-import/package.json`.

## `apps/web`

Назначение: frontend SPA для login/cabinet/catalog/map/object detail/admin. Подтверждено `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/admin`.

Ключевые entry points:

- `apps/web/src/main.tsx` - React mount.
- `apps/web/src/App.tsx` - client-side routing, layout, login/cabinet/admin route shell.
- `apps/web/src/auth/AuthProvider.tsx` - auth state, refresh, permissions.
- `apps/web/src/admin/api.ts` - API client, bearer token, refresh retry.
- `apps/web/src/catalog/CatalogPage.tsx` - catalog/list/map route implementation.
- `apps/web/src/map/YandexMap.tsx` - Yandex JS map integration and no-key behavior.
- `apps/web/src/objects/ObjectDetailPage.tsx` - object detail and lot detail pages.

Global styles:

- `apps/web/src/styles.css`
- `apps/web/src/app-theme.css`

Frontend tests: `apps/web/tests`.

## `apps/api`

Назначение: NestJS API, auth/RBAC, users, directories, objects, map, files/media, catalog quick links, WordPress import reports, feed sources/imports. Подтверждено `apps/api/src/app.module.ts`.

Ключевые entry points:

- `apps/api/src/main.ts` - Nest bootstrap, CORS, port.
- `apps/api/src/app.module.ts` - composition root.
- `apps/api/src/health/health.controller.ts` - `/health` with DB/PostGIS check.
- `apps/api/prisma/schema.prisma` - Prisma schema.
- `apps/api/prisma/seed.ts` - roles, permissions, admin seed.

Основные modules:

- `apps/api/src/auth` - login, registration, refresh, JWT guards, cookies, RBAC guards.
- `apps/api/src/users` - admin users and own profile/photo/password.
- `apps/api/src/objects` - object CRUD, publish/archive, gallery/files, feed units.
- `apps/api/src/map` - map object endpoint.
- `apps/api/src/files` - upload/content/delete, media cookie endpoint, S3/MinIO storage.
- `apps/api/src/directories` - developers, locations, metro.
- `apps/api/src/catalog-links` - public/admin catalog quick links.
- `apps/api/src/feeds` - feed source admin, analyze, preview/run, units.
- `apps/api/src/wordpress-import` - WordPress import preview/run/report API.

Backend tests: `apps/api/tests`.

## `packages/shared`

Назначение: общие TypeScript-контракты API/frontend/backend и search normalization. Подтверждено `packages/shared/src/index.ts`, `packages/shared/src/search-normalization.mjs`.

Exports:

- `packages/shared/src/index.ts` через `@platforma/shared`.
- `packages/shared/src/search-normalization.mjs` и `packages/shared/src/search-normalization.cjs` через `@platforma/shared/search-normalization`.

Consumers подтверждены в `apps/web/src`, `apps/api/src/search/search-filters.ts`, `apps/api/src/objects/object-search.ts`.

## `tools/wp-import`

Назначение: CLI для WordPress import preview/run и repair preview/run. Подтверждено `tools/wp-import/src/index.ts`.

Ключевые файлы:

- `tools/wp-import/src/importer.ts` - основной import flow.
- `tools/wp-import/src/mapper.ts` - mapping WordPress posts/meta/terms/media в объектную модель.
- `tools/wp-import/src/repair.ts` - repair primary locations and developer duplicates.
- `tools/wp-import/src/wordpress-client.ts` - readonly WordPress source client.
- `tools/wp-import/src/storage.ts` - media storage.
- `tools/wp-import/src/env.ts` - env loading.

Tests: `tools/wp-import/tests`.

Env example: `tools/wp-import/.env.example`.

## `tools/feed-import`

Назначение: CLI для feed analyze, preview, run; импортирует feed units/media из XML источников. Подтверждено `tools/feed-import/src/index.ts`.

Ключевые файлы:

- `tools/feed-import/src/index.ts` - parsers, CLI args, analyze, import engine, persistence.
- `tools/feed-import/src/env.ts` - env loading.
- `tools/feed-import/src/storage.ts` - media storage.
- `tools/feed-import/src/image-variants.ts` - image variants.

Поддержанные форматы подтверждены `tools/feed-import/src/index.ts`: `YANDEX_REALTY`, `CIAN_XML`, `AVITO_XML`, `FSK_XML`, `TEKTA_XML`.

Tests: `tools/feed-import/tests`.

## Тесты

| Зона | Путь |
| --- | --- |
| Web | `apps/web/tests` |
| API | `apps/api/tests` |
| WordPress import | `tools/wp-import/tests` |
| Feed import | `tools/feed-import/tests` |
| Root `tests` | не найдено |

## Env examples

| Файл | Назначение |
| --- | --- |
| `.env.example` | Compose/local full-stack env, включая Postgres/Redis/MinIO/API/Web/JWT/SMTP/WP import |
| `apps/api/.env.example` | API env |
| `apps/web/.env.example` | Web env: `VITE_API_URL`, `VITE_YANDEX_MAPS_API_KEY` |
| `tools/wp-import/.env.example` | WP import CLI env |

`tools/feed-import/.env.example` при скане не найден: неясно.

## Prisma

Schema: `apps/api/prisma/schema.prisma`.

Migrations: `apps/api/prisma/migrations`.

Seed: `apps/api/prisma/seed.ts`.

PostGIS init for Docker: `docker/postgres/init/01-enable-postgis.sql`.

Root-level `prisma` directory не найден.

## Docker/config files

- `docker-compose.yml` - PostGIS, Redis, MinIO, API, Web.
- `apps/api/Dockerfile` - installs workspace deps, generates Prisma client, builds API, runs `prisma migrate deploy`, starts API.
- `apps/web/Dockerfile` - builds Vite app and serves `apps/web/server.mjs`.
- `docker/postgres/init/01-enable-postgis.sql` - enables PostGIS.

## Deep backend/API structure index

Дата углубленного backend/API-индекса: 2026-06-01.

Сканировался `apps/api` полностью, кроме `apps/api/dist` и `apps/api/node_modules`.

### `apps/api/src` module map

| Path | Purpose | Public API surface |
| --- | --- | --- |
| `apps/api/src/app.module.ts` | Nest composition root. | Imports API feature modules and registers `HealthController`. |
| `apps/api/src/main.ts` | Nest bootstrap, CORS and port binding. | Uses `WEB_ORIGIN`, `credentials: true`, listens on `PORT` or `3000`. |
| `apps/api/src/health/health.controller.ts` | DB/PostGIS health check. | `GET /health`. |
| `apps/api/src/prisma/prisma.module.ts`, `apps/api/src/prisma/prisma.service.ts` | Shared Prisma provider. | Exported `PrismaService`. |
| `apps/api/src/auth` | Auth controller/service, cookies, JWT guard, media guard, permissions guard/decorator, mail service. | `/auth/*`, guard layer used by protected controllers. |
| `apps/api/src/users` | Admin users and own profile/password/photo. | `/users/*`. |
| `apps/api/src/objects` | Object list/detail/create/update/status/publish, gallery, files, feed units. | `/objects/*`. |
| `apps/api/src/map` | Map object list. | `/map/objects`. |
| `apps/api/src/files` | File upload/content/delete, media-cookie content endpoint, S3 storage, variants. | `/files/*`, `/media/files/*`. |
| `apps/api/src/directories` | Developers, locations, metro directory read APIs. | `/developers`, `/locations`, `/metro`. |
| `apps/api/src/catalog-links` | Public/admin catalog quick links. | `/catalog-links`, `/catalog-links/admin`. |
| `apps/api/src/wordpress-import` | HTTP wrapper around `tools/wp-import`. | `/wordpress-import/*`. |
| `apps/api/src/feeds` | Feed source admin, analyze, preview/run queue, runs, units. | `/feeds/*`. |
| `apps/api/src/search` | Backend search filter helpers. | Used by objects/directories/feeds services; no controller. |

### Controllers and services

- Controllers found: `AuthController`, `UsersController`, `ObjectsController`, `MapController`, `FilesController`, `MediaController`, `DevelopersController`, `LocationsController`, `MetroController`, `CatalogLinksController`, `WordpressImportController`, `FeedsController`, `HealthController`.
- Services found: `AuthService`, `UsersService`, `ObjectsService`, `MapService`, `FilesService`, `S3StorageService`, `DirectoriesService`, `CatalogLinksService`, `WordpressImportService`, `FeedsService`, `PrismaService`, `MailService`.
- Guards found: `JwtAuthGuard`, `PermissionsGuard`, `MediaTokenGuard`.
- Permission decorator: `RequirePermissions` in `apps/api/src/auth/permissions.decorator.ts`.

### API tests

`apps/api/tests` contains:

- `apps/api/tests/api-contract.test.cjs`
- `apps/api/tests/auth-rbac.test.cjs`
- `apps/api/tests/auth-session-schema.test.cjs`
- `apps/api/tests/backfill-image-variants.test.cjs`
- `apps/api/tests/catalog-quick-link-schema.test.cjs`
- `apps/api/tests/e2e-smoke.test.cjs`
- `apps/api/tests/feed-schema.test.cjs`
- `apps/api/tests/feeds-module.test.cjs`
- `apps/api/tests/file-variant-schema.test.cjs`
- `apps/api/tests/file-variants-behavior.test.cjs`
- `apps/api/tests/object-file-upload-limit.test.cjs`
- `apps/api/tests/object-gallery-batch.test.cjs`
- `apps/api/tests/object-gallery-stream.test.cjs`
- `apps/api/tests/object-image-section-schema.test.cjs`
- `apps/api/tests/services.test.cjs`

### Backend absence checks

- No `/feed-import/preview` or `/feed-import/run` controller was found in `apps/api/src`; feed preview/run endpoints are `POST /feeds/sources/:id/preview` and `POST /feeds/sources/:id/run` in `apps/api/src/feeds/feeds.controller.ts`.
- No audit log controller/endpoints were found in `apps/api/src`; `AuditLog` exists in `apps/api/prisma/schema.prisma`, writes exist in `apps/api/src/objects/objects.service.ts` and `apps/api/src/users/users.service.ts`, and `audit-log:read` is seeded in `apps/api/prisma/seed.ts`.
- `apps/api/.env` exists but was not read or documented for secrets; env expectations should come from `apps/api/.env.example` and root `.env.example`.
