# Project Index

Дата индексации: 2026-06-01.

## Что это за проект

`Platforma` - закрытая внутренняя брокерская платформа для объектов недвижимости. Основные пользовательские сценарии: кабинет пользователя, каталог объектов, карта объектов, карточка объекта, админка объектов/пользователей/быстрых ссылок/импорта. Это подтверждено `rules/project.md`, `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/api/src/app.module.ts`.

Главные рабочие сущности проекта: пользователь, роль, permission, объект недвижимости, локация, застройщик, метро, файл, медиа, WordPress import report, feed source, feed import run, feed unit. Это подтверждено `apps/api/prisma/schema.prisma`, `packages/shared/src/index.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/feeds/feeds.service.ts`.

## Главный источник актуального контекста

Основной индекс документации: `docs/DOCS_INVENTORY.md`.

Инженерные индексы, созданные для Codex:

- `docs/PROJECT_INDEX.md` - главный входной индекс.
- `docs/PROJECT_STRUCTURE.md` - карта структуры проекта.
- `docs/PAGES_AND_ROUTES.md` - frontend routes и их связи.
- `docs/FEATURE_MAP.md` - карта фич по frontend/backend/shared/data/tests.
- `docs/PRODUCT_AND_UI_CONTEXT.md` - компактный продуктовый и UI-контекст для Codex.
- `docs/API_AND_DATA.md` - API, Prisma и data flow.
- `docs/STATE_AND_LOGIC.md` - состояние и бизнес-логика.
- `docs/RISK_ZONES.md` - зоны риска.
- `docs/IMPORT_INDEX.md` - WordPress import, repair и feed import.
- `docs/CODEX_LOG.md` - журнал изменений документации.

Правила Codex перед любой работой: `AGENTS.md`, `rules/communication.md`, `rules/workflow.md`, `rules/code-style.md`, `rules/project.md`, `rules/commands.md`, `rules/frontend.md`, `rules/backend.md`, `rules/files-and-secrets.md`, `rules/final-response.md`.

Код остается источником истины для фактического поведения: `apps/web/src`, `apps/api/src`, `apps/api/prisma/schema.prisma`, `packages/shared/src`, `tools/wp-import/src`, `tools/feed-import/src`.

## Стек

| Зона | Стек | Подтверждение |
| --- | --- | --- |
| Monorepo | `pnpm` workspace | `package.json`, `pnpm-workspace.yaml` |
| Frontend | Vite, React 19, TypeScript, Tailwind CSS 4, shadcn/ui-style components, lucide icons | `apps/web/package.json`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css` |
| Backend | NestJS 11, TypeScript, Prisma 6, PostgreSQL/PostGIS, JWT/cookies, S3/MinIO storage | `apps/api/package.json`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/prisma/schema.prisma`, `docker-compose.yml` |
| Shared contracts | TypeScript shared package with domain types and search normalization | `packages/shared/package.json`, `packages/shared/src/index.ts`, `packages/shared/src/search-normalization.mjs` |
| WordPress import | Node CLI, Prisma, MySQL readonly source, S3/MinIO media import, preview/run/repair modes | `tools/wp-import/package.json`, `tools/wp-import/src/index.ts`, `tools/wp-import/src/importer.ts`, `tools/wp-import/src/repair.ts` |
| Feed import | Node CLI, `fast-xml-parser`, Prisma, S3/MinIO media import, Yandex/CIAN/Avito/FSK formats | `tools/feed-import/package.json`, `tools/feed-import/src/index.ts` |
| Containers | Docker Compose with PostGIS, Redis, MinIO, API, Web | `docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker/postgres/init/01-enable-postgis.sql` |

`REDIS_URL` есть в env examples и compose, но прямое использование Redis в `apps/api/src` при текущем скане не найдено: неясно.

## Основные зоны

| Зона | Назначение | Путь |
| --- | --- | --- |
| Web app | SPA routes, auth state, catalog/map/object/admin UI | `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/admin`, `apps/web/src/objects` |
| API app | NestJS modules, auth/RBAC, objects, files, map, feeds, WP import | `apps/api/src/app.module.ts`, `apps/api/src/auth`, `apps/api/src/objects`, `apps/api/src/files`, `apps/api/src/feeds` |
| Prisma | DB schema and migrations | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations` |
| Shared | API response/request contracts and common enums | `packages/shared/src/index.ts`, `packages/shared/src/search-normalization.mjs` |
| WordPress import | Legacy WP import and repair scripts | `tools/wp-import/src/index.ts`, `tools/wp-import/src/importer.ts`, `tools/wp-import/src/mapper.ts`, `tools/wp-import/src/repair.ts` |
| Feed import | XML feed analysis/import engine | `tools/feed-import/src/index.ts` |
| Tests | Node tests per workspace package | `apps/web/tests`, `apps/api/tests`, `tools/wp-import/tests`, `tools/feed-import/tests` |
| Env examples | Expected environment variables | `.env.example`, `apps/api/.env.example`, `apps/web/.env.example`, `tools/wp-import/.env.example` |

## Что читать перед задачами

| Тип задачи | Читать сначала | Затем читать |
| --- | --- | --- |
| Любая задача | `AGENTS.md`, `rules/*.md`, `docs/DOCS_INVENTORY.md`, `docs/PROJECT_INDEX.md` | `docs/CODEX_LOG.md` |
| Frontend route/UI | `rules/frontend.md`, `docs/PRODUCT_AND_UI_CONTEXT.md`, `docs/PAGES_AND_ROUTES.md`, `docs/STATE_AND_LOGIC.md` | `apps/web/src/App.tsx`, нужный файл в `apps/web/src` |
| Catalog/map/object detail | `rules/frontend.md`, `docs/PRODUCT_AND_UI_CONTEXT.md`, `docs/PAGES_AND_ROUTES.md`, `docs/FEATURE_MAP.md`, `docs/RISK_ZONES.md` | `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx` |
| Backend/API | `rules/backend.md`, `docs/API_AND_DATA.md`, `docs/FEATURE_MAP.md` | нужный controller/service в `apps/api/src` |
| Prisma/data migration | `rules/backend.md`, `docs/API_AND_DATA.md`, `docs/RISK_ZONES.md` | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations` |
| Shared contracts | `rules/backend.md`, `docs/API_AND_DATA.md`, `docs/RISK_ZONES.md` | `packages/shared/src/index.ts`, consumers from `rg '@platforma/shared'` |
| WordPress import | `rules/backend.md`, `docs/IMPORT_INDEX.md`, `docs/FEATURE_MAP.md`, `docs/API_AND_DATA.md` | `tools/wp-import/src`, `apps/api/src/wordpress-import` |
| Feed import | `rules/backend.md`, `docs/IMPORT_INDEX.md`, `docs/FEATURE_MAP.md`, `docs/API_AND_DATA.md` | `tools/feed-import/src/index.ts`, `apps/api/src/feeds` |
| QA/deploy | `docs/manual-qa-checklist.md`, `docs/staging-production-env-checklist.md` | `.env.example`, `docker-compose.yml`, Dockerfiles |

## Быстрые ссылки

| Тема | Документы | Код |
| --- | --- | --- |
| Frontend | `docs/PRODUCT_AND_UI_CONTEXT.md`, `docs/PAGES_AND_ROUTES.md`, `docs/STATE_AND_LOGIC.md` | `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/admin`, `apps/web/src/objects` |
| Backend | `docs/API_AND_DATA.md`, `docs/FEATURE_MAP.md` | `apps/api/src/app.module.ts`, `apps/api/src/auth`, `apps/api/src/objects`, `apps/api/src/users` |
| Import | `docs/IMPORT_INDEX.md`, `docs/FEATURE_MAP.md`, `docs/API_AND_DATA.md` | `apps/api/src/wordpress-import`, `apps/api/src/feeds`, `tools/wp-import/src`, `tools/feed-import/src` |
| Shared | `docs/API_AND_DATA.md`, `docs/RISK_ZONES.md` | `packages/shared/src/index.ts`, `packages/shared/src/search-normalization.mjs` |
| QA | `docs/manual-qa-checklist.md` | `apps/web/tests`, `apps/api/tests`, `tools/wp-import/tests`, `tools/feed-import/tests` |
| Deploy/env | `docs/staging-production-env-checklist.md` | `.env.example`, `apps/api/.env.example`, `apps/web/.env.example`, `docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile` |

## Команды

Корневые команды из `package.json`:

| Команда | Назначение |
| --- | --- |
| `pnpm build` | Сборка shared, API, web, WP import и feed import |
| `pnpm build:api` | Сборка `@platforma/api` |
| `pnpm build:web` | Сборка `@platforma/web` |
| `pnpm db:generate` | Prisma generate для API |
| `pnpm db:migrate` | Prisma migrate dev для API |
| `pnpm db:seed` | Seed API |
| `pnpm dev:api` | Dev server API |
| `pnpm dev:web` | Dev server web |
| `pnpm test` | Тесты API, web, WP import, feed import |
| `pnpm wp-import:preview` | Preview WordPress import |
| `pnpm wp-import:run` | Run WordPress import |
| `pnpm wp-import:repair:preview` | Preview repair script |
| `pnpm wp-import:repair:run` | Run repair script |
| `pnpm feed-import:preview` | Preview feed import CLI; требует параметры source |
| `pnpm feed-import:run` | Run feed import CLI; требует параметры source |

Дополнительные package-level команды подтверждены в `apps/web/package.json`, `apps/api/package.json`, `packages/shared/package.json`, `tools/wp-import/package.json`, `tools/feed-import/package.json`.

Правило dev web server: использовать порт `5173` со strict port, подтверждено `rules/commands.md`.
