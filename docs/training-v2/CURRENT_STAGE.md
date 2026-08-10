# Current Stage: Stage 5 Part 4/4 — Connected E2E and Final Readiness

## Статус

`final acceptance pending`

Stage 4, Stage 4.5 и Stage 5 Parts 1–3 вручную приняты и находятся в отдельных
commits. Connected fake E2E и автоматическая финальная регрессия Part 4
реализованы локально. Для полного acceptance остаются перечисленные ниже
ручные и внешние gates.

Отдельного staging-окружения нет. Production deploy, production DB/SSH,
реальные Telegram/OpenAI вызовы и webhook registration в этой части не
выполняются.

## Входит

- Одна команда `pnpm test:training-v2:e2e` с чистой PostgreSQL БД, MinIO,
  собранными API/web images, real `ffmpeg`, live Nest API и live browser.
- Один connected сценарий на одинаковых IDs: object/PDF/official URL,
  materials/suggestions, 10 проектов с ALL/ASSIGNED доступом, assignments,
  Telegram linking, voice segments, finish, result/history/review,
  ranking/coverage/CSV и protected audio.
- Multi-user concurrency, duplicate delivery, worker restart/fencing,
  disable/re-enable, technical refund, timeout и bounded graceful shutdown.
- Регрессия Stage 4/4.5/Stage 5, RBAC, ownership, private storage, redaction,
  revoke/close mid-attempt и immutable snapshot.
- Performance evidence на 105 сотрудниках и 10 проектах: exact pagination,
  stable API/CSV order, query counts и PostgreSQL `EXPLAIN` без искусственного
  machine-specific SLA.
- Финальные local manual acceptance и future production rollout checklists.

## Не входит

- Новые product features, migrations, dependencies, generic queue/outbox,
  отдельный worker container или новый provider mode.
- Реальные Telegram/OpenAI вызовы, платный smoke, реальный webhook register или
  delete, production deploy, production DB/SSH и commit.
- Изменение product-кода без доказанного connected blocker.

## Remaining external gates

- Локальная ручная fake-проверка ключевых экранов и operator flow.
- Отдельно разрешённый real local Telegram/OpenAI smoke без автоматических
  повторов.
- Production env review, backup/rollback, operator webhook registration,
  deploy и post-deploy observation по отдельной задаче.

## Stop conditions

- Любой шаг требует real provider call, webhook mutation, production access,
  deploy или commit без отдельной команды пользователя.
- Connected E2E оставляет Docker resources, обращается к внешнему provider или
  использует неочищенную shared БД/MinIO.
- Results/ranking/CSV/audio раскрывают private payload/storage/provider data,
  а RBAC/ownership допускают cross-user или cross-project доступ.
- Regression, build, Compose, migration, browser, shutdown или performance gate
  не имеет воспроизводимого зелёного результата.
