# Acceptance: Stage 5 Part 3/4 — Runtime Hardening and Concurrency

## Критерии готовности

- Один bot и один API worker обрабатывают 10 concurrent users одного проекта
  без cross-user contamination; provider peak больше одного и не превышает
  `TRAINING_VOICE_WORKER_CONCURRENCY` (default `3`, bounded `1..10`).
- Claim остаётся атомарным через существующий `FOR UPDATE SKIP LOCKED`; каждый
  claim получает уникальный fencing owner, поэтому второй worker/slot не
  обрабатывает answer дважды, а lost owner не сохраняет stale checkpoint/result.
- Shutdown запрещает новые claims, ждёт active tasks не дольше configured drain,
  освобождает unfinished ownership для restart и не теряет persisted work.
- Stale/restart recovery и сохранённые transcription/evaluation checkpoints не
  повторяют уже подтверждённые этапы.
- При `TRAINING_MODULE_ENABLED=false` frontend entry скрыты, employee/admin API
  возвращает controlled disabled error, webhook отвечает controlled no-op,
  worker и external providers не начинают новую работу. Re-enable продолжает
  сохранённый processing; исторические данные не удаляются.
- Production + enabled не стартует с fake provider, HTTP/local/private/
  placeholder URL, отсутствующими Telegram/OpenAI values/models или
  совпадающими/невалидными buckets. Ошибка содержит только безопасный code.
- Webhook status/register/delete являются opt-in. Register использует HTTPS,
  `secret_token`, только `message`/`callback_query`, bounded timeout и safe
  errors; delete требует `--confirm-delete`; token/secret не печатаются.
- Ordinary test/build не запускает opt-in OpenAI smoke или Telegram CLI.
- `/health` возвращает только `status`, `database` и optional `training`.
- API image содержит `ffmpeg`; Node получает SIGTERM/SIGINT; отдельного worker
  container и schema migration нет.

## Automated fake/local acceptance

1. Unit/domain: strict feature flag, production config matrix, HTTPS/private/
   placeholder URL, pairwise bucket distinctness, redaction, webhook request/
   dry-run/delete confirmation/local stub и health allowlist.
2. Isolated PostgreSQL/runtime: 10 users одного project с разными Telegram
   accounts/chats, concurrent voice+finish, bounded provider concurrency,
   independent segments/transcripts/results, two workers/one answer, stale
   recovery и lost-owner fencing.
3. Lifecycle: disable before claim, disable between claim/external call,
   re-enable resume, shutdown without new claims, successful bounded drain и
   timeout/restart recovery с финальными DB assertions.
4. HTTP: disabled employee/admin actions, controlled webhook no-op, safe health
   и redacted production startup failure.
5. API/web/root tests and builds, Prisma validate, development/production
   Compose config, Docker API image build, `ffmpeg`, signal/stop/restart smoke,
   `git diff --check`, `.only`/`.skip` и excluded-scope/secret scans.

## Локальная ручная приёмка

1. При enabled проверить employee/admin Training entry и direct routes; при
   disabled убедиться, что entry скрыты, direct actions заблокированы, а после
   re-enable данные и pending processing сохранены.
2. Запустить webhook `status`/register `--dry-run`; убедиться, что вывод не
   содержит token/secret. Реальные register/delete не выполнять.
3. Остановить и перезапустить локальный API во время fake processing; проверить
   bounded stop и финальное восстановление persisted answer.
4. Проверить `/health` в enabled/disabled state и отсутствие config metadata.

## Remaining production gates

- Отдельное production env review и backup/migration/rollback plan.
- Реальные HTTPS endpoint, Telegram webhook registration/status и controlled
  Telegram/OpenAI smoke по отдельному разрешению.
- Production deploy и post-deploy observation не выполнены.

## Definition of Done

Part 3 готова только при зелёных fake/local gates, чистых временных ресурсах и
отсутствии real external/deploy действий. Commit и Part 4 остаются отдельными
не начатыми задачами.
