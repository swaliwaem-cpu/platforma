# Модуль обучения: безопасный план рефакторинга

Статус на 2026-08-01: Stage 1 и Stage 2 выполнены по явной команде `REFACTOR_APPROVED`; execution record — `04-baseline-recovery.md` и `05-dead-code-removal.md`. На границе Stage 2 работа остановлена. Stage 3–8 не разрешены и не начинались.

## Цель и стратегия

Цель — уменьшить связанность, размер god-files, дублирование и измеренно подтверждённые издержки без изменения observable behavior и production contracts. Стратегия — façade-first и strangler-style extraction внутри существующего Nest/React устройства: публичные классы, routes и page entrypoints сначала остаются на месте и делегируют новым внутренним collaborators.

Не допускаются rewrite, новый framework/router/queue, BullMQ, массовое форматирование, новые библиотеки, schema migration или «попутное» исправление функциональных дефектов.

## Глобальные неизменяемые контракты

На каждом stage byte/semantic-equivalent должны остаться:

- Prisma schema, migrations, enum storage values и FK/delete semantics;
- HTTP method/path/status/body, shared DTO и RBAC/guard order;
- Telegram callback/deep-link/update/outbox formats и message ordering;
- job kinds, payload fields, correlation/idempotency keys, CAS/lease/retry/maxAttempts;
- scoring `55 + 15 + 15 + 15`, penalty `−5`, random `3 из 10`, rounding/clamp;
- timeout, grace, refund, review/reprocess и provider `AMBIGUOUS` rules;
- OpenAI/Telegram request shapes, `store:false`, fake/real selection и error codes;
- private audio/storage access, upload-intent cleanup/recovery и signed access;
- manual React routing, permissions, URL/history, visited-step mounting, dirty/focus/polling UX;
- env names/defaults, API/worker topology, heartbeat/kill-switch/shutdown и deploy contract.

Каждый implementation batch должен быть отдельным reviewable commit/MR, без массового rename/format. Временный façade/re-export допустим и предпочтителен. Следующий batch разрешён только после зелёных gates предыдущего.

## Stage 1 — Characterization и восстановление baseline

**Готовность сейчас:** `COMPLETE`. PostgreSQL baseline восстановлен, а перед Stage 2 добавлены scoped runtime characterization: внешний Nest consumer retained config export, employee `training:take` boundary и desktop/mobile editor/results golden screenshots. Production behavior на этом stage не менялся.

**Файлы/зоны:**

- `apps/api/tests/training-telegram-db.integration.cjs`;
- `apps/api/tests/training-attempt-db.integration.cjs`;
- `apps/api/tests/training-content-lock-db.integration.cjs`;
- `apps/api/scripts/run-training-db-tests.cjs`;
- `apps/api/tests/training-full-chain.e2e.cjs` и его runner;
- `apps/web/tests/*.test.mjs`, `apps/web/tests-browser/*.spec.ts`;
- при необходимости новые test-only fixtures/harnesses.

**Изменения:**

1. Изолировать Telegram DB scenarios: уникальные identities, scoped cleanup/jobs, исправить test-only `engine` ReferenceError.
2. Разделить первичные failures и каскад; обеспечить несколько последовательных зелёных запусков DB runner.
3. Утвердить отдельно два продуктовых решения: recovery `TECHNICAL_FAILURE` против текущего `AWAITING_FOLLOW_UP/AMBIGUOUS`; ожидаемый winner publication/content race. Если нужен production bugfix — вынести в отдельную одобренную задачу до refactor.
4. Заменить brittle source-only assertions, которые будут блокировать split, connected/import/HTTP behavior tests; schema/secret/Compose static guards оставить.
5. Добавить characterization exact job producer/consumer payloads, process topology/heartbeats/SIGTERM, connected fake Telegram webhook→voice chain, real PostgreSQL/HTTP authoring flow и assignment RBAC.
6. Добавить frontend slow-A/fast-B, request-count, mounted visited panels, upload queue, review/audio lifecycle и responsive screenshot baseline.

**Что не меняется:** production code/behavior, routes, DTO, DB, provider calls; real Telegram/OpenAI не вызываются.

**Gates:**

- API build/unit;
- DB runner зелёный минимум 3 последовательных раза;
- web 312+ unit/source tests;
- Playwright training browser;
- fake full-chain E2E;
- Docker audio/MinIO/ffmpeg;
- root build/test и `git diff --check`.

**Риск:** средний — test harness может маскировать race, поэтому cleanup не должен удалять production-significant state раньше assertion.

**Оценка diff:** 800–1 800 test-only строк. Readiness для Stage 2: все gates зелёные, спорные contracts письменно утверждены, baseline commit зафиксирован.

## Stage 2 — Удаление только доказанного dead code

**Готовность сейчас:** `COMPLETE`. Удалены только повторно подтверждённые `PROVEN_UNUSED` entries; точный manifest, LOC и gates находятся в `05-dead-code-removal.md`.

**Файлы:** элементы таблицы `01-dead-code-candidates.md`: provider import/helper, content private helper, unused domain/repository types, review constant/getter, unused Shell prop, unreachable service methods/Nest exports; отдельно CSS selector residue.

**Изменения:** малыми партиями удалить:

1. compiler-proven import/private helper;
2. definition-only types/functions/constants/getter/prop;
3. после продуктового подтверждения — unreachable service methods и лишнюю Nest export surface;
4. CSS selectors — отдельным visual batch, удаляя только мёртвую часть grouped rules.

**Что не меняется:** callable routes, provider factories, jobs/enums, fake providers, public shared contract, live selectors.

**Gates:** affected unit/import tests, API/web builds, полный Stage 1 baseline; для CSS — desktop/mobile visual screenshots и browser editor/results.

**Риск:** низкий для compiler/definition-only symbols; средний для public service/Nest surface и CSS.

**Оценка diff:** 50–350 строк. Readiness для Stage 3: zero removed-symbol references, все gates зелёные, не осталось source-test, который лишь требует удалённую строку.

## Stage 3 — Безопасная консолидация дублирования

**Готовность сейчас:** `NOT_APPROVED`. Readiness Stage 2 достигнута, но явная команда требует остановиться до устранения дублирования.

**Файлы:** worker helpers, small backend utilities, `TrainingShellPage.tsx`, `TrainingOperationsPage.tsx`, `TrainingRankingPage.tsx`, `TrainingAdminResultsPage.tsx`, `QuestionEvaluationContext.tsx`, `TrainingReadiness.tsx`, `trainingAdminApi.ts`, `trainingResultsApi.ts`.

**Изменения:**

- вынести exact `waitForPromise` с сохранением `unref()` и return semantics;
- вынести frontend `readError` и `formatPoints`;
- объединить query serialization с точными tests encoding/null/array;
- при достаточной characterization — parametrized UUID primitive и canonical JSON/hash helper;
- не объединять пока worker lifecycle, audit IP, Serializable retry, provider errors или employee serializer: их похожесть скрывает различия semantics/security.

**Что не меняется:** retry counts, transaction isolation, error codes/messages, date/time locale, request query/body encoding.

**Gates:** focused helper tests + API/web/full baseline; snapshot exact request URLs and error display.

**Риск:** низкий/средний. **Оценка diff:** 150–450 строк. Readiness для Stage 4: только pure/exact duplication устранено, semantic duplicates остаются явно задокументированы.

## Stage 4 — Backend god-files

**Готовность сейчас:** `BLOCKED_BY_STAGE_3`; выполнять несколькими batches, не одной большой заменой.

**Файлы/порядок:**

1. `training-admin.controller.ts`: разделить по admin domains под тем же prefix/guards/routes.
2. `training-content.service.ts`: façade над project/version lifecycle, questions, facts, criteria; publish/clone transaction сначала не дробить.
3. `training-results.service.ts`, `training-documents.service.ts`, `training-fact-suggestions.service.ts`: query/command/presenter/storage boundaries.
4. `training-telegram-dialog.service.ts`: router, handlers, read model, renderer с неизменным callback/message contract.
5. `training-attempt-engine.service.ts`: последним; сохранить исходный class/token/public API и по одному вынести review, query, job runtime, provider coordinator, finalizer.

**Изменения:** только move/delegate и dependency inversion через внутренние interfaces. Сначала один collaborator, зелёный gate, затем следующий. Транзакционные функции перемещать цельными вместе с lock order.

**Что не меняется:** controllers/routes/DI token, Prisma selects/writes, transaction boundaries/order, provider/outbox calls, job payloads, audit actions.

**Gates:**

- controller method/path/permission matrix;
- content authoring PostgreSQL/HTTP + content-lock race;
- attempt/scoring/review/OpenAI unit + весь DB runner + fake full-chain;
- results privacy/ranking/CSV/review HTTP and browser;
- documents/source/fact suites;
- import-cycle scan, API build/root build.

**Риск:** высокий, attempt/content — критический. **Оценка diff:** 12 000–22 000 moved/edited строк суммарно; каждый batch 500–1 500 строк. Readiness для Stage 5: façades остаются совместимыми, ни один batch не меняет SQL/DTO/behavior.

## Stage 5 — Frontend god-files

**Готовность сейчас:** `BLOCKED_BY_STAGE_4`.

**Файлы/порядок:**

1. разбить `trainingAdminApi.ts` по projects/content/sources/assignments/suggestions с временным façade/re-export;
2. `TrainingAdminPage.tsx`: dispatcher, list/create/editor, `useTrainingProjectEditor`, navigation guard и независимые sections;
3. централизовать editor resources/poll ownership, но не оптимизировать request count в механическом split;
4. `TrainingAdminResultsPage.tsx`: list, detail hook, question workspace/audio, review, evidence view-model;
5. `TrainingShellPage.tsx`: employee loader, policy, Telegram, cards/history/detail;
6. route-level lazy/declarative metadata внутри существующего manual router — отдельный batch;
7. CSS делить последним по новым компонентам, сохраняя source order/cascade.

**Что не меняется:** route strings/navigation permissions, `apiRequest`, DOM IDs/test hooks, mounted visited sections, dirty/history/focus, polling terminal refresh, review idempotency, Blob/ObjectURL cleanup, responsive layout.

**Gates:** web unit + request serialization; slow-A/fast-B; exact request counts; Playwright editor/results; visual desktop/mobile; root build и bundle comparison. React state/effects проверяются на stable dependencies, functional updates и отсутствие derived-state effects.

**Риск:** критический для Admin, высокий для Results/CSS. **Оценка diff:** 11 000–18 000 moved/edited строк; batches 500–1 500. Readiness для Stage 6: browser behavior и screenshots эквивалентны, initial bundle не регрессировал.

## Stage 6 — Provider и worker wiring

**Готовность сейчас:** `BLOCKED_BY_STAGE_5_AND_TOPOLOGY_DECISION`.

**Файлы:** `training.module.ts`, `audio/training-audio-worker.module.ts`, worker services, provider files/config, `training-worker.main.ts`; возможно новые internal provider/worker utility modules.

**Изменения:**

- консолидировать provider registration/factories, оставив process-specific tokens/flags у composition roots;
- извлечь общий Responses envelope parser, сохранив provider-specific schemas, error codes и requests;
- ввести typed `TrainingJobLeaseRepository` и shared shutdown helper, но не universal base worker;
- отдельно решить и зафиксировать намеренность dual document-worker ownership;
- после lifecycle characterization параметризовать Serializable retry/audit helpers только без semantic drift.

**Что не меняется:** API processor `false`, dedicated worker processor `true`, worker kinds/heartbeats, retry/lease/CAS/shutdown order, fake/real mode, external request body/headers/deadlines, no HTTP inside DB transaction.

**Gates:** provider local HTTP-stub protocol; job producer/consumer snapshots; all worker DB restart/race/lease tests; process boot/heartbeat/SIGTERM; fake full-chain; audio Docker; Compose/preflight static checks. Real provider smoke — только отдельным разрешением.

**Риск:** критический. **Оценка diff:** 1 500–4 000 строк. Readiness для Stage 7: topology доказана тестом, restart final states идентичны, provider request snapshots byte-equivalent.

## Stage 7 — Только измеренно подтверждённая performance-работа

**Готовность сейчас:** `NOT_READY_WITHOUT_MEASUREMENTS`.

**Приоритеты измерения:**

1. confirmed Telegram `1 + 2N` employee projects (`training-telegram-dialog.service.ts:82-123`);
2. attempt recovery sweep каждые 250 ms без `take` и status-leading index (`training-attempt-engine.service.ts:111,242-258,1861-1942`);
3. ranking heavy relation history и CSV repeated full aggregation (`training-ranking.service.ts:58-220,468-601`);
4. full source texts ради 500-char preview и 2.5s polling (`training-documents.service.ts:536-545,1285-1295`; URL sources `:432-456`; Admin page `:3528-3613`);
5. heartbeat write cadence; broad answer context; unbounded admin detail history; large sequential draft clone.

**Изменения допускаются только после:** production-like cardinality, statement/query counts, p95, transferred bytes/RSS и `EXPLAIN (ANALYZE, BUFFERS)`. Сначала no-schema решения: batched/narrow selects, computed preview projection, one-time project options, non-overlapping polling, export iterator. Новый index/schema/cursor pagination — отдельное разрешение.

**Что не меняется:** DTO/routes/order/CSV escaping, ranking position/total/best semantics, recovery latency guarantee, atomic clone, terminal refresh, employee privacy.

**Gates:** before/after query-count and plan fixtures, PostgreSQL cardinality tests, ranking exact output/CSV, recovery restart/race, source UI polling/stale response, memory/p95 budgets, весь baseline.

**Риск:** высокий. **Оценка diff:** 300–2 500 строк по фактически подтверждённым findings; stage может законно завершиться без code changes. Readiness для Stage 8: для каждой оптимизации есть измеримый выигрыш и отсутствие plan/behavior regression.

## Stage 8 — Финальная архитектурная валидация

**Готовность сейчас:** `BLOCKED_BY_STAGES_3_7`.

**Файлы:** весь training scope, shared contract, Prisma schema/migration history, Compose/env/deploy manifests и четыре audit-документа.

**Изменения:** code changes не планируются; обновить архитектурную карту и закрыть временные façades/re-exports только если public surface inventory подтверждает безопасность.

**Что проверяется:**

- отсутствие static/DI cycles и неправильных direction dependencies;
- отсутствие новых god-files/duplication/dead residue;
- неизменность routes/permissions/DTO/schema/jobs/scoring/providers/env/topology;
- production-like query plans/performance budgets;
- rollback каждого stage и отсутствие незавершённых migrations.

**Финальные gates:** исходные четыре команды аудита; API DB минимум 3 раза; Playwright; fake full-chain; audio Docker; deployment preflight/Compose validation; `git diff --check`; clean expected worktree с явным учётом пользовательских артефактов. Real Telegram/OpenAI и production deploy не входят без отдельного GO.

**Риск:** средний как интеграционный audit. **Оценка diff:** 0–300 строк документации/удаления временных compatibility shells. Итоговая готовность: только после общего review и отдельного deploy decision.

## Рекомендуемый порядок и stop conditions

```text
Stage 1 green baseline
  -> Stage 2 proven dead only
  -> Stage 3 exact/pure duplication
  -> Stage 4 backend façades
  -> Stage 5 frontend decomposition
  -> Stage 6 provider/worker topology
  -> Stage 7 measured performance only
  -> Stage 8 architecture validation
```

Немедленный stop любого batch:

- изменение route/DTO/schema/job/provider snapshot;
- новый либо нестабильный DB/browser failure;
- другая transaction/lock/external-call order;
- рост query count/p95/bundle без объяснения;
- необходимость functional bugfix, migration, dependency или product decision вне scope.

Текущая команда после аудита: **остановиться и ждать `REFACTOR_APPROVED`**.
