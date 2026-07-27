# Production deployment Training Telegram

Дата актуализации: 2026-07-27.

Этот документ описывает Telegram-интеграцию этапа 6. Deployment private voice,
audio storage, ffmpeg и отдельного worker этапа 7 описан в
`docs/training/audio-worker-deployment.md`. OpenAI остаётся вне обоих этапов.

## Local development

Локальный запуск сохраняет development defaults из `docker-compose.yml`:

```text
NODE_ENV=development
TELEGRAM_TRANSPORT_MODE=fake
```

Fake transport не должен использоваться для production.

## Обязательный production profile

Создать локальный, не коммитящийся файл:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

В `.env.production` обязательно заменить все placeholders и задать:

- `TELEGRAM_BOT_TOKEN`;
- `TELEGRAM_BOT_USERNAME`;
- `TELEGRAM_WEBHOOK_SECRET`;
- `TELEGRAM_WEBHOOK_URL`;
- `PUBLIC_APP_URL`.

Оба URL должны быть абсолютными HTTPS URL реальных production hosts.
`localhost`, `127.0.0.1`, example/test/fake hosts и placeholder-значения
запрещены runtime validation. Bot token и webhook secret не включаются в
validation errors.

Production override фиксирует независимо от development defaults:

```text
NODE_ENV=production
TELEGRAM_TRANSPORT_MODE=real
```

## Проверка до запуска

Проверка Compose только рендерит конфигурацию и не запускает контейнеры:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --env-file .env.production \
  config >/dev/null
```

Команда должна завершиться ошибкой, если отсутствует хотя бы одна из пяти
обязательных переменных. Содержимое production config не следует выводить в
логи CI, поскольку rendered Compose содержит secret environment values.

## Production запуск

Использовать только полную команду:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --env-file .env.production \
  up -d --build
```

После healthcheck проверить режим без вывода secrets:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --env-file .env.production \
  exec api sh -c \
  'test "$NODE_ENV" = production && test "$TELEGRAM_TRANSPORT_MODE" = real'
```

`TrainingTelegramConfig` дополнительно завершает startup ошибкой при:

- fake transport в production;
- отсутствующей Telegram-переменной;
- HTTP URL;
- localhost/loopback/placeholder production host;
- известных fake/default placeholder token, username или webhook secret.

Silent fallback на fake transport отсутствует.

## SIGTERM и bounded drain

Signal path:

```text
docker compose stop api
  -> SIGTERM для Node PID 1
  -> Nest enableShutdownHooks
  -> TrainingTelegramWorkerService.onModuleDestroy()
  -> запрет новых claim
  -> ожидание активного job до TELEGRAM_WORKER_DRAIN_TIMEOUT_MS
  -> завершение job либо возврат owned job в PENDING для stale/restart recovery
```

API Docker CMD после migrations выполняет `exec node
apps/api/dist/main.js`, поэтому финальный Node-процесс становится PID 1.
Default worker drain timeout — `10000ms`; Compose `stop_grace_period` — `30s`.

Ручная проверка выполняется на staging во время контролируемого Telegram job:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --env-file .env.production \
  stop api
```

Критерии:

- после начала shutdown новые jobs не claim-ятся;
- активный job получает до 10 секунд на завершение;
- при превышении timeout незавершённый owned job становится `PENDING` с
  `TELEGRAM_SHUTDOWN_RELEASE` и может быть обработан после restart;
- heartbeat остановлен, lock остановленного worker отсутствует;
- API завершается до Docker grace period `30s`.

Для просмотра последних job states использовать read-only запрос:

```sql
SELECT kind, status, attempts, lock_owner, last_error_code
FROM training_jobs
ORDER BY updated_at DESC
LIMIT 20;
```
