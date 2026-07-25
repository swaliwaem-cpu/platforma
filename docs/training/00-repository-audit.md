# Аудит репозитория перед модулем обучения

Дата проверки: 2026-07-25.

## 1. Границы аудита

Проверен только этап 0 из `docs/training/prompts/00_audit.md`.
Production-код, Prisma schema, миграции, зависимости, env-файлы и deploy-конфигурация
не изменялись.

Аудит выполнен по фактическому коду ветки `on-ser`, commit `604475d`:

- `package.json`, workspace package manifests и `pnpm-workspace.yaml`;
- `apps/api/src`, `apps/api/prisma/schema.prisma`, migrations и seed;
- `apps/web/src/App.tsx`, `AuthProvider.tsx`, `main.tsx`, `server.mjs`;
- `packages/shared/src`;
- `docker-compose.yml`, API/Web Dockerfiles и env examples;
- текущие API/Web/import tests;
- действующие инструкции и инженерные индексы репозитория.

До начала аудита рабочее дерево уже содержало пользовательские изменения:

- modified: `docs/CODEX_LOG.md`;
- untracked: `docs/MASTER_PLAN_ARCHIVE.md`, исходные `docs/training/**`,
  PDF/PNG в `output/pdf/**`.

Эти файлы не удалялись и не перезаписывались. Три документа этапа 0 до аудита
отсутствовали.

## 2. Подтверждённая архитектура

| Зона | Подтверждённое состояние | Источник истины |
| --- | --- | --- |
| Monorepo | `pnpm` workspace: `apps/*`, `packages/*`, `tools/*`; package manager `pnpm@10.33.3` | `package.json`, `pnpm-workspace.yaml` |
| Web | React `19.2.5`, React DOM `19.2.5`, Vite `8.0.10`, TypeScript `6.0.3`, Tailwind `4.3.0`, Radix/shadcn primitives | `apps/web/package.json` |
| API | NestJS `11.1.19`, TypeScript `6.0.3`, Prisma Client `6.19.3`; глобального `/api` prefix нет | `apps/api/package.json`, `apps/api/src/main.ts` |
| Runtime | API/Web Docker images основаны на Node `22-alpine` | `apps/api/Dockerfile`, `apps/web/Dockerfile` |
| Database | PostgreSQL 16 + PostGIS 3.5; Prisma provider `postgresql` | `docker-compose.yml`, `apps/api/prisma/schema.prisma` |
| Auth | Access JWT в Bearer header; refresh JWT в HttpOnly cookie; server-side `UserSession`; отдельный media JWT cookie; password и email activation flows | `apps/api/src/auth`, `UserSession`, `EmailAuthChallenge` в Prisma |
| RBAC | Существующие `User`, `Role`, `Permission`, `RolePermission`; guards `JwtAuthGuard`, `PermissionsGuard`, decorator `@RequirePermissions` | `apps/api/src/auth`, Prisma schema |
| Roles/permissions | Seed создаёт `admin`, `editor`, `user` и 20 permission keys; `training_admin` и training permissions отсутствуют | `apps/api/src/prisma/seed.ts` |
| Audit | Общая таблица `AuditLog` существует; записи создают object/user services; общего audit controller/service для переиспользования нет | Prisma schema, `objects.service.ts`, `users.service.ts` |
| Storage | Один S3-compatible bucket из `MINIO_BUCKET`; собственный SigV4 client; `File` хранит bucket/key и `url` через `getPublicUrl()` | `apps/api/src/files` |
| File API | JWT/permission-protected `/files/:id/content` и media-cookie-protected `/media/files/:id/content`; generic upload разрешает только JPEG/PNG/WebP/PDF, отдельно поддерживается feed XML | files controllers/service/constants |
| Durable worker pattern | `ProjectPresentationsWorkerService` использует PostgreSQL status/attempts/heartbeat, CAS claim, stale recovery и max 3 attempts | `apps/api/src/project-presentations`, Prisma schema |
| Other queue pattern | Feed command queue хранится в памяти процесса API с concurrency 3 | `apps/api/src/feeds/feeds.service.ts` |
| Redis | Redis 7 есть в Compose и `REDIS_URL` есть в env, но прямого клиента/очереди в application code нет | `docker-compose.yml`, scan `apps/api/src` |
| Routing | Собственный SPA router на `window.history`, `pathname` и regex/parsers внутри `App.tsx`; React Router не используется | `apps/web/src/App.tsx` |
| API routing | Nest controllers зарегистрированы без глобального prefix | `apps/api/src/main.ts`, controllers |
| Tests | `node:test`; API и import tests предварительно собирают TypeScript; Web tests в основном source/contract tests | package manifests, `apps/*/tests`, `tools/*/tests` |
| Browser tests | `@playwright/test` установлен в Web devDependencies, но Playwright config и Playwright test suite не найдены | `apps/web/package.json`, repository scan |
| Deploy | Compose содержит Postgres, Redis, MinIO, API и Web; API выполняет `prisma migrate deploy` перед start; Web отдаётся собственным Node static server со SPA fallback | `docker-compose.yml`, Dockerfiles, `apps/web/server.mjs` |
| Health | `/health` проверяет БД и наличие PostGIS; отдельного worker health/readiness сейчас нет | `apps/api/src/health/health.controller.ts` |

## 3. Текущее состояние относительно training-модуля

На момент аудита в tracked production-коде отсутствуют:

- `TrainingModule` и `apps/api/src/training/**`;
- training models/enums в Prisma и training migrations;
- `packages/shared/src/training.ts`;
- `/training` и `/admin/training` во frontend routing/navigation;
- `training_admin` и `training:*` permissions;
- `TRAINING_*`, `TELEGRAM_*`, `OPENAI_*`, ffmpeg/worker env;
- отдельный training worker entrypoint, package script и Compose service;
- document extraction, Telegram, audio и OpenAI providers;
- training tests.

Это ожидаемая исходная точка этапа 0, а не дефект существующего production-кода.

## 4. Найденный drift

### D-01. Технический контекст верен концептуально, но требует точных версий

Мастер-контекст правильно указывает pnpm/React 19/NestJS 11/Prisma/PostgreSQL,
но текущая ветка уже зафиксирована на React `19.2.5`, NestJS `11.1.19`,
Prisma `6.19.3`, Vite `8.0.10`, TypeScript `6.0.3`, Tailwind `4.3.0`,
pnpm `10.33.3`. Runtime — Node 22, тогда как `@types/node` в API — `25.6.0`.
Перед добавлением бинарных/Node-specific зависимостей нужна проверка совместимости
именно с Node 22.

### D-02. Auth богаче исходного краткого описания

Помимо access JWT и refresh cookie, текущий код имеет:

- несколько server-side refresh sessions через `UserSession`;
- legacy refresh fields в `User` для обратной совместимости;
- email registration/activation через `EmailAuthChallenge`;
- отдельный media JWT cookie.

Training account linking нельзя связывать с refresh session или media token:
он должен использовать отдельные opaque one-time tokens и отдельные Prisma models.

### D-03. Актуальный PostgreSQL-worker pattern появился после ранних индексов

В ветке есть новый `ProjectPresentationsWorkerService` с persisted status,
heartbeat, CAS claim, retry и stale recovery. Он работает как provider внутри
API-процесса, а не как отдельный entrypoint/container. Для training это полезный
domain/reference pattern, но тяжёлые audio/transcription/evaluation jobs должны
выполняться отдельным процессом, как требует спецификация.

### D-04. Текущий storage нельзя переиспользовать для private audio без адаптации

`FilesService`:

- использует один `MINIO_BUCKET`;
- сохраняет `url` из `S3_PUBLIC_ENDPOINT`;
- сериализует этот URL;
- принимает images/PDF и отдельный feed XML, но не OGG/Opus, WAV, DOCX, PPTX,
  XLSX;
- не настраивает bucket policy в репозитории.

Защищённые content endpoints существуют, но приватность самого bucket из кода
не доказана. Для training audio нужен отдельный private bucket либо явная
multi-bucket abstraction, запрет `getPublicUrl()`, авторизованный streaming
endpoint с `training:audio:read` и audit log.

### D-05. Durable queue на Redis отсутствует

Redis остаётся инфраструктурным сервисом без application client. Feed queue
in-memory и не переживает restart; project presentation jobs сохраняют состояние
в PostgreSQL. Решение использовать PostgreSQL-backed `TrainingJob` соответствует
реальному коду и не требует BullMQ/Redis dependency.

### D-06. Полноценного browser E2E harness нет

`@playwright/test` уже находится в lockfile и Web devDependencies, но config и
Playwright tests отсутствуют. Текущие 600 тестов — `node:test`; `e2e-smoke` API
также является Node test, а не browser E2E. Этап 10 не должен объявлять browser
E2E готовым без отдельного harness или явно описанного fake HTTP/domain E2E.

### D-07. Deploy пока не включает prerequisites training worker

В Compose нет отдельного worker service, ffmpeg/ffprobe и worker health/readiness.
В репозитории нет Nginx config; есть только checklist ожидаемого внешнего proxy.
Добавление training worker потребует отдельной команды, контейнерного target,
health strategy и порядка deploy/rollback.

### D-08. Расхождение между исполняемым prompt и общей спецификацией этапов

`docs/training/spec/04_stages_tests_acceptance.md` включает в Stage 0 четвёртый
файл `docs/training/03-security-and-data-flow.md`, но исполняемый
`docs/training/prompts/00_audit.md` явно перечисляет только три документа.
По правилу «строго по prompt» в этом этапе создано только три файла.

Также общая спецификация содержит stages 0–12, а prompt-набор содержит 0–10:

- prompt 09 объединяет spec stages 9–10;
- prompt 10 объединяет spec stages 11–12.

Checklist ниже следует требованию `00_audit.md` и нумерации prompts 0–10.

### D-09. Инженерные индексы репозитория частично отстают от текущей ветки

Основные индексы датированы 2026-06-01 и не полностью отражают июльские
project presentation models/worker и session auth. Для training решения
подтверждались непосредственно кодом, а не только индексами.

## 5. Безопасные проверки

| Команда | Результат |
| --- | --- |
| `git branch --show-current` | `on-ser` |
| `git status --short` | зафиксировано исходное грязное дерево; чужие файлы не затронуты |
| `pnpm build` | passed для Shared, API, Web, WP import, Feed import |
| `pnpm test` | passed: 600/600 |
| `pnpm --filter @platforma/web test` | повторная сводка: 277/277 passed |

Разбивка `pnpm test`:

- API: 236/236;
- Web: 277/277;
- Feed import: 64/64;
- WordPress import: 23/23.

Единственное предупреждение сборки: production Web chunk `700.22 kB` превышает
порог Vite `500 kB`. Это существующий performance risk, не ошибка этапа 0.

## 6. Риски перед этапом 1

1. Нельзя смешивать permission visibility во frontend с backend enforcement:
   training API должен использовать `JwtAuthGuard` + `PermissionsGuard`.
2. `training_admin` должен быть idempotently добавлен в существующий seed без
   изменения прав текущих ролей сверх утверждённой матрицы.
3. Ручной router в `App.tsx` уже крупный; training routes нужно добавлять
   локально и покрыть navigation/route tests, без React Router migration.
4. Storage privacy должна быть доказана bucket policy/runtime проверкой, а не
   наличием защищённого endpoint.
5. Worker claim/retry должен быть PostgreSQL-durable и отдельным от API process;
   in-memory feed queue не подходит как основа.
6. Telegram/OpenAI tests должны оставаться fake/fixture-only; smoke tests —
   только opt-in.
7. Текущее грязное рабочее дерево требует сохранять точную границу файлов на
   каждом следующем этапе.
8. До Stage 1 нужно решить расхождение по обязательности
   `03-security-and-data-flow.md`.

## 7. Вывод о готовности

Фактическая архитектура и точки интеграции подтверждены. Этап 1 технически
можно начинать после отдельного запроса пользователя, но перед ним следует
явно решить drift D-08 и снова проверить ветку/рабочее дерево. Автоматический
переход к этапу 1 не выполнялся.
