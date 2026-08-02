# Current Stage: Stage 5 Part 3/4 — Runtime Hardening and Concurrency

## Статус

Stage 4, Stage 4.5 и Stage 5 Parts 1–2 приняты пользователем. Текущая
разрешённая граница — только третья из четырёх частей Stage 5. Part 4 не
начинается без отдельного задания.

Отдельного staging-окружения сейчас нет. Эта часть выполняется локально без
production deploy, production DB/SSH и реальных Telegram/OpenAI вызовов.

## Входит

- Один общий Telegram-бот обслуживает минимум 10 одновременно работающих
  пользователей одного проекта с независимыми account/chat/attempt/answer.
- `TrainingAnswer` остаётся persisted processing unit. Локальный API worker
  использует существующий PostgreSQL `FOR UPDATE SKIP LOCKED`, configurable
  bounded concurrency с default `3`, уникальный fencing token каждого claim,
  heartbeat, stale recovery и bounded retries.
- `TRAINING_MODULE_ENABLED=true|false`: backend actions блокируются, webhook
  становится controlled no-op, worker не берёт новую работу, frontend скрывает
  employee/admin entry, а существующие данные и processing work сохраняются.
- При production + enabled startup fail-closed требует real Telegram, HTTPS
  webhook/public URL, OpenAI, explicit models и три валидных попарно различных
  general/audio/material bucket.
- Только opt-in webhook CLI: status, HTTPS register и confirm-required delete;
  secret и allowed updates передаются безопасно, реальные вызовы автоматически
  не запускаются.
- Публичный `/health` ограничен status, DB и training
  `ready|disabled|degraded` без config/provider/user/payload metadata.
- Nest shutdown hooks, прямой Node signal path, bounded worker drain и restart
  recovery внутри существующего API container. `ffmpeg` остаётся в API image.

## Не входит

- Production deploy, production DB/SSH, real Telegram webhook registration,
  real Telegram/OpenAI smoke и отдельное staging-окружение.
- Изменение results, ranking, CSV, protected audio, review, materials или
  assignments без доказанного blocker.
- Generic queue/job/outbox/provider-run infrastructure, отдельный worker
  container, operations dashboard и remote/dynamic feature flag.
- Новые product features, Part 4, commit и schema migration.

## Production boundary

Production требует `TRAINING_MODULE_ENABLED=true`, real Telegram/OpenAI,
публичные HTTPS URL и отдельно выполненную operator registration webhook.
Feature disable сохраняет projects, assignments, materials, attempts, answers,
audio и незавершённую работу; после re-enable persisted processing продолжается.

## Stop conditions

- Требуется production deploy/DB/SSH, real provider call или webhook registration.
- Требуется generic queue/separate worker container или изменение Part 1–2
  surfaces без доказанного blocker.
- Lost owner способен сохранить stale checkpoint/result либо shutdown берёт
  новую работу после stop boundary.
- Disabled module начинает новый external call или удаляет/финализирует
  persisted work вместо сохранения для recovery.
- Health/config/error/log раскрывает secret, model, bucket, user, transcript или
  provider payload.
