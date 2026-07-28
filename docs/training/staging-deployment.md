# Training staging deployment

Дата актуализации: 2026-07-28.

Runbook подготовлен этапом 10, но staging deploy не выполнялся. Staging
обязан использовать отдельные PostgreSQL database, MinIO/S3 buckets,
training audio bucket, Telegram bot/secret, OpenAI project/key, domains и
test users. Production resources запрещены.

## Подготовка и backup

```bash
cp .env.staging.example .env.staging
chmod 600 .env.staging
docker compose -f docker-compose.yml -f docker-compose.staging.yml \
  --env-file .env.staging config >/dev/null
```

Заменить все placeholders через secret store. Проверить HTTPS, exact
`WEB_ORIGIN`, secure cookies у reverse proxy, private audio bucket и
недоступность anonymous GET/LIST/PUT. `.env.staging` исключён из Git.

До любого Prisma/S3/Nest side effect выполнить обязательный fail-closed
preflight:

```bash
pnpm training:staging preflight
```

Команда запускается только из корня репозитория, обязательно загружает
корневой `.env.staging` и fail-closed требует `DEPLOYMENT_ENV=staging`.
Она требует exact staging DB host/name, попарно разные general/document/audio
buckets, отдельные staging public hosts и Telegram bot username. Known
production DB identities, bucket names, public hosts и bot usernames
передаются как несекретные deny-list значения из deployment/secret store;
credentials и production secrets для сравнения не используются. Совпадение,
production-like/default identifier или placeholder останавливает процесс до
migrations.

До migration выполнить backup по `backup-migration-rollback.md`; затем:

```bash
pnpm training:staging preflight
pnpm training:staging prisma validate
pnpm training:staging prisma migrate status
pnpm training:staging prisma migrate deploy
pnpm training:staging prisma migrate status
```

`migrate status` с pending migration ожидаемо может вернуть non-zero, поэтому
deploy выполняется отдельной командой. `migrate reset` и `db push`
запрещены. Runner допускает только перечисленные read/forward migration
команды, а isolation preflight повторяется перед каждым Prisma process.

## Последовательные режимы

Phase A — real staging Telegram + fake OpenAI:

```text
NODE_ENV=production
DEPLOYMENT_ENV=staging
TELEGRAM_TRANSPORT_MODE=real
OPENAI_PROVIDER_MODE=fake
STAGING_ALLOW_FAKE_PROVIDERS=true
OPENAI_SMOKE_ENABLED=false
TRAINING_MODULE_ENABLED=false
```

Сначала поднять production build с training disabled, проверить health,
migrations, worker idle и privacy. Затем отдельно включить training. Это
единственное явное исключение для fake OpenAI; production его отвергает.

Phase B — real Telegram + real OpenAI разрешён только после успешного
synthetic smoke:

```text
OPENAI_PROVIDER_MODE=real
STAGING_ALLOW_FAKE_PROVIDERS=false
OPENAI_SMOKE_ENABLED=false
```

Phase C — один утверждённый тестовый проект и test employee. Реальные
сотрудники/голоса не используются до go/no-go.

Команда deploy приводится для оператора и в этапе 10 не запускалась:

```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml \
  --env-file .env.staging up -d --build
```

Staging overlay использует required-variable syntax для DB, всех buckets,
S3 credentials/endpoints, public URLs и isolation allow/deny identifiers.
Отсутствующие значения не наследуют development defaults.

## Webhook tooling

Ни одна команда не запускается автоматически. Сначала dry-run:

```bash
pnpm --filter @platforma/api training:telegram:webhook:status -- --dry-run
pnpm --filter @platforma/api training:telegram:webhook:register -- --dry-run
```

Затем оператор может выполнить status/register без вывода token/secret:

```bash
pnpm --filter @platforma/api training:telegram:webhook:status
pnpm --filter @platforma/api training:telegram:webhook:register
```

Register передаёт HTTPS URL, `secret_token`, только `message` и
`callback_query`, сохраняя pending updates. Удаление требует явного флага:

```bash
TELEGRAM_WEBHOOK_DELETE_CONFIRMED=true \
pnpm --filter @platforma/api training:telegram:webhook:delete
```

Для осознанной очистки staging pending updates добавить
`TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES=true`. Не использовать этот флаг при
обычном rollback, если updates нужно сохранить.

После rollback вернуть прежний image/env, проверить status и повторить
register. Token/secret не печатать и ротировать через BotFather/secret store
при подозрении на компрометацию.

## Stop conditions

Остановить проверку и оставить `TRAINING_MODULE_ENABLED=false`, если policy не
утверждена, backup не проверен, privacy probe неоднозначен, worker heartbeat
отсутствует, webhook secret не проходит, есть DEAD jobs либо synthetic
OpenAI smoke/calibration не завершены.
