# Testing and Deploy

## Источник команд

Фактическим источником команд
являются текущие `package.json`.

Перед запуском команды проверь,
что соответствующий script существует.

Базовые команды проекта:

- `pnpm build`
- `pnpm build:api`
- `pnpm build:web`
- `pnpm test`
- `pnpm --filter @platforma/api test`
- `pnpm --filter @platforma/web test`
- `pnpm db:generate`
- `pnpm db:seed`
- `pnpm dev:api`
- `pnpm dev:web`

Для import tools используй только scripts,
которые существуют в их текущих `package.json`.

## Порядок проверок

Для локальной небольшой задачи:

1. targeted tests;
2. build изменённого workspace;
3. `git diff --check`.

Для cross-cutting задачи:

1. targeted tests;
2. API tests;
3. web tests;
4. `pnpm build`;
5. `pnpm test`;
6. browser или integration tests,
   если соответствующий script существует;
7. `git diff --check`.

Нельзя:

- добавлять `.only`;
- добавлять `.skip` вместо исправления;
- удалять failing test ради зелёного результата;
- утверждать, что команда прошла,
  если она не запускалась.

## Test environment

Автоматические tests:

- не используют production database;
- не используют production buckets;
- не вызывают реальные платные providers;
- не вызывают реальный Telegram
  или другой сторонний API;
- создают и удаляют временные ресурсы;
- принудительно используют test и fake env.

Concurrency и migration tests
должны работать на изолированной
PostgreSQL database или schema.

## Prisma

Для staging и production:

1. `prisma migrate status`
2. `prisma migrate deploy`
3. `prisma migrate status`

Запрещено на staging и production:

- `prisma migrate reset`
- `prisma db push`
- `prisma migrate dev`

До production migration:

1. backup;
2. проверка backup;
3. config validation;
4. build image;
5. migrate status;
6. migrate deploy;
7. post-migration validation.

Не изменяй старую применённую migration.

## Environment files

- Реальные секреты находятся только
  в untracked env-файлах или secret storage.
- `.env.example` содержит только шаблоны.
- Не вставляй секреты в Markdown,
  comments, tests и logs.
- Не печатай полный Compose config,
  если он содержит env values.
- Проверяй, что боевой env-файл
  игнорируется Git.

## Docker

Перед изменением Docker или Compose:

- проверь существующие service names;
- проверь healthchecks;
- проверь signal и shutdown path;
- проверь volumes;
- проверь, что build context
  не включает секреты.

После изменения:

- `docker compose config`;
- build затронутых images;
- локальный smoke;
- graceful stop;
- проверка cleanup временных ресурсов.

## Production

Production-действия выполняются
только по прямой команде пользователя.

Без отдельного разрешения нельзя:

- подключаться по SSH;
- применять production migrations;
- регистрировать webhook;
- выполнять платный smoke;
- менять production env;
- пересоздавать production containers.

Безопасный порядок production rollout:

1. проверить commit;
2. backup env и database;
3. validate config;
4. build;
5. migrate status и deploy;
6. seed, если требуется;
7. start с безопасным feature state;
8. health и log checks;
9. controlled smoke;
10. enable feature;
11. post-deploy checks.

### Training voice worker

Voice worker запускается отдельным Compose-сервисом
`training-voice-worker` из того же API image.

Обычный rollout только HTTP API выполняется адресно:

```sh
docker compose up -d --build --no-deps api
```

Эта команда не пересоздаёт работающий voice worker.
Не используй полный `docker compose up -d --build`
как замену адресному API rollout: полный запуск может пересоздать worker.

Перед пересозданием `training-voice-worker` обязательно выполни:

```sh
pnpm training:worker:predeploy
```

Проверка печатает безопасный JSON с количеством активных claims
и возрастом самого старого. При активной работе команда завершается
с exit code `2` и блокирует rollout. После явного решения оператора
допускается повторная проверка с подтверждением:

```sh
pnpm run training:worker:predeploy --confirm-active
```

После успешной проверки worker пересоздаётся отдельно:

```sh
docker compose up -d --no-deps --force-recreate training-voice-worker
```

Не увеличивай число replicas выше `1`, пока PostgreSQL fencing,
stale recovery и глобальный concurrency limit не прошли повторную
production-like проверку для новой топологии.

## Rollback

Rollback после применённых migrations
обычно выполняется через:

- feature disable;
- остановку worker или ingress;
- возврат предыдущего image;
- сохранение DB и storage данных;
- исправление forward.

Не выполняй destructive down migration
и не восстанавливай backup поверх production
без отдельного плана и разрешения.

## Финальный отчёт

Укажи:

- реально запущенные команды;
- exit и result;
- не запущенные проверки;
- ручные проверки;
- изменения migrations, env и Docker;
- rollback considerations.
