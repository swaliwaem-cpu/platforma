# Risk Zones

Этот файл содержит только постоянные зоны риска проекта.

Он не является журналом найденных багов.

## Auth, sessions и cookies

Риск:

- login, refresh и logout;
- access token;
- refresh и media cookies;
- CORS credentials;
- параллельные запросы после `401`.

Проверить:

- login;
- refresh;
- параллельный refresh;
- logout;
- reload;
- protected media.

## RBAC и permissions

Риск:

- frontend navigation и backend permissions
  могут разойтись;
- seed может случайно выдать или отнять доступ;
- UUID probing может обойти ownership.

Проверить:

- 401;
- 403;
- безопасный 404;
- разные роли;
- прямой переход по URL;
- seed permissions;
- IDOR.

## Prisma, migrations и seed

Риск:

- потеря данных;
- cascade delete;
- drift;
- concurrent writes;
- изменение исторического поведения.

Проверить:

- schema;
- существующие migrations;
- migration на чистой временной БД;
- backup;
- seed idempotency;
- FK и unique constraints;
- реальные PostgreSQL race tests.

## Shared contracts и serialization

Риск:

- frontend compile проходит,
  но runtime response отличается;
- Prisma Decimal, BigInt, Date и JSON
  сериализуются неверно;
- backend возвращает лишние чувствительные поля.

Проверить:

- explicit serializers;
- shared consumers;
- API contract tests;
- отсутствие запрещённых полей.

## Files, media и object storage

Риск:

- публичный доступ;
- orphan objects;
- удаление связанного файла;
- MIME и size mismatch;
- storage и DB расходятся.

Проверить:

- upload;
- download;
- linked delete;
- private access;
- checksums;
- cleanup и recovery;
- anonymous bucket access;
- auth cookies и headers.

## Frontend routing и navigation

Риск:

- route не перехвачен;
- direct reload не работает;
- permission gate отличается от backend;
- browser back/forward ломает state.

Проверить:

- direct URL;
- internal navigation;
- back и forward;
- logged-out redirect;
- denied route;
- unknown entity.

## Async frontend lifecycle

Риск:

- stale response;
- duplicate submit;
- request после unmount;
- Blob URL leak;
- polling race;
- infinite effect loop.

Проверить:

- `AbortController`;
- request ownership;
- retry semantics;
- double click;
- unmount;
- route или entity switch;
- timer cleanup.

## Catalog, map и global styles

Риск:

- catalog filters и URL расходятся;
- map и list behavior ломается;
- global CSS влияет на несвязанные страницы.

Проверить:

- catalog filters;
- pagination;
- shared URL;
- map markers и list;
- selected state;
- mobile;
- соседние admin и detail страницы.

## Import tools

Риск:

- неверный mapping;
- duplicate entities;
- архивирование данных;
- неверные media paths;
- long-running run остаётся зависшим.

Проверить:

- analyze;
- preview;
- run;
- stop и recovery;
- report warnings и errors;
- повторный запуск;
- catalog и detail после import.

## External providers и background jobs

Риск:

- duplicate billing или message;
- зависший request;
- lost job;
- stale lease;
- повторный side effect;
- секрет в логах.

Проверить:

- timeout;
- retries;
- idempotency;
- persisted intent;
- crash и restart;
- stale recovery;
- graceful shutdown;
- safe logging;
- fake tests.

## Docker, env и deploy

Риск:

- development config попадает в production;
- secret отсутствует или раскрывается;
- SIGTERM не доходит до Node;
- migrations запускаются не тем image;
- staging использует production resource.

Проверить:

- Compose overlays;
- required env;
- `docker compose config`;
- PID и signal path;
- healthchecks;
- distinct DB и buckets;
- backup;
- migrate deploy;
- rollback.

## Правило работы с risk zone

Если задача затрагивает одну из зон:

1. Назови зону в плане.
2. Найди реальные связанные файлы.
3. Запусти обязательные проверки.
4. Не выполняй попутный рефакторинг.
5. В финальном ответе укажи остаточный риск.
