# Модуль обучения: regression и characterization test plan

Статус: PostgreSQL baseline восстановлен 2026-08-01; Stage 1–2 завершены по `REFACTOR_APPROVED`, Stage 3 safe deduplication — по `REFACTOR_STAGE_3_APPROVED`, Stage 4 Batch 1 — по `REFACTOR_STAGE_4A_APPROVED`. Остальные backend god-files и Stage 5–8 не начинались и требуют отдельного разрешения.

## Текущее состояние gate

| Gate | Текущий результат 2026-08-01 | Статус для refactor |
|---|---|---|
| `pnpm --filter @platforma/api test` | pass; unit 547/547, PostgreSQL 111/111 | PASS после Stage 4 Batch 1 |
| `pnpm --filter @platforma/web test` | 315/315 pass | PASS |
| `pnpm build` | pass; известный Vite main chunk warning, 787.75 kB | PASS с зафиксированным warning |
| `pnpm test` | pass; PostgreSQL 111/111 | PASS |
| PostgreSQL repeat 1 / repeat 2 | 111/111; 111/111, каждый на clean temporary DB | PASS |
| Prisma validate / migrations | valid; 43/43 migrations применены в clean DB runs | PASS |
| `git diff --check` | pass | PASS |
| Playwright training | 24/24 pass; editor/results desktop/mobile goldens не изменены; известный React warning сохранён | PASS после Stage 4 Batch 1 |
| fake full-chain | не входил в baseline recovery | REQUIRED перед integration batch |
| Docker audio/MinIO/ffmpeg | не входил в baseline recovery | REQUIRED перед audio/worker batch |
| real Telegram/OpenAI | не запускался и не разрешён | OUT OF SCOPE до отдельного GO |

`pnpm test` не является полным training gate: root script запускает package tests (`package.json:15-16`), а browser, full-chain и Docker audio имеют отдельные scripts (`apps/web/package.json:10-11`; `apps/api/package.json:18-19`).

## P0: восстановить надёжный baseline до refactor — выполнено

1. Устранить test-only contamination в `training-telegram-db.integration.cjs`: уникальные Telegram IDs, scoped cleanup и несуществующий `engine` (`:63-68,232-246,398-402,1364-1384`).
2. Не разрешать worker из одного test claim-ить due job другого fixture; assertions должны ждать конкретный persisted final state, а не «любой drain завершился».
3. Разнести/пометить первичные failures и каскад dead-critical recovery (`training-telegram-worker.service.ts:169-175,202-269,804-838`).
4. Утвердить recovery-контракт оборванного provider request: ожидаемый attempt state после `REQUESTING → AMBIGUOUS` (`training-attempt-db.integration.cjs:599-704`; engine `:3171-3205`).
5. Утвердить и стабилизировать publication/content race contract (`training-content-lock-db.integration.cjs:133-216`; lock order `training-version-lock.ts:31-42,88-128`).
6. Требовать три последовательных зелёных DB runs; «те же 21 падение» не считать baseline.

Все шесть пунктов закрыты. Telegram fixtures изолированы, OpenAI crash windows ждут committed `REQUESTING`, а PostgreSQL assertions фиксируют `PENDING/REQUESTING/SUCCEEDED/FAILED/AMBIGUOUS`; publication contract покрыт двумя новыми real PostgreSQL races, document workers — dual-consumer/stale tests. После финальных исправлений получены два явных DB repeats и ещё один в root suite.

## Инвентаризация существующего покрытия

Проанализированы 17 API unit training suites, 11 файлов общего PostgreSQL runner, отдельный Docker-audio suite, 3 web node suites, 2 Playwright suites и full-chain harness.

### Сильные behavioral suites

| Контракт | Tests / evidence | Что реально защищено |
|---|---|---|
| scoring | `apps/api/tests/training-attempt-scoring.test.cjs:35-320` | random `3/10`, `55+15+15+15`, `−5`, `ROUND_HALF_UP`, clamp, unknown IDs |
| attempt state machine | `training-attempt-engine.test.cjs:209-1575`; `training-attempt-db.integration.cjs:66-1445` | limits, assignment, timeout/grace, idempotency, refund, review, recovery/races; DB recovery сейчас red |
| audio/privacy | `training-audio.test.cjs:146-1335`; `training-audio-db.integration.cjs:60-1430`; `training-audio-http.integration.cjs:36-166` | private access, Telegram download security, FFmpeg, cleanup, lease/restart/IDOR |
| OpenAI protocol | `training-openai.test.cjs`; `training-openai-smoke.test.cjs:22-171` | request body/schema, deadlines/retry/refusal/bounds через local HTTP stub; billable calls отсутствуют |
| results/ranking/privacy | `training-results-db.integration.cjs:44-1276`; `apps/web/tests-browser/training-results.spec.ts:8-405` | SQL/result/CSV, employee masking, review idempotency, Blob lifecycle, stale requests |
| admin editor | `apps/web/tests-browser/training-admin-editor.spec.ts:13-410` | dirty/history, visited steps, mobile, readiness fail-closed |
| fact suggestions/content | corresponding unit/DB suites | budgets, source snapshot, accept/reject, locks; connected authoring HTTP flow отсутствует |

### Static/source-regex suites

Полностью статические:

- `apps/api/tests/training-schema.test.cjs:1-292`;
- `apps/web/tests/training-admin-page.test.mjs:1-296`;
- `apps/web/tests/training-routes.test.mjs:1-129`.

Смешанные suites содержат static assertions: `training-foundation.test.cjs:79-108,137-164`, `training-contracts.test.cjs:64-147`, `training-content-service.test.cjs:157-183,924-947`, `training-documents.test.cjs:62-126`, `training-audio.test.cjs:572-616,1336-1352,1474-1486`, `training-telegram.test.cjs:282-363`, `training-stage10.test.cjs:551-585`, последние три проверки `apps/web/tests/training-results.test.mjs:157-223`.

Schema/migration, secret scan и exact Compose guards остаются полезными. Assertions вида «строка/метод находится именно в старом god-file» до split заменить behavior/import/wiring tests: они дают false failure при move и false pass при наличии мёртвой строки.

## Scoped characterization, добавленный для Stage 2

- Runtime Nest consumer импортирует `TrainingModule` и получает retained `TrainingConfigService` без привязки к расположению provider.
- Browser RBAC test открывает `/training` без `training:take`, получает access denied и доказывает отсутствие employee data requests.
- Editor и results имеют desktop/mobile golden screenshots и DOM assertions отсутствия удаляемых legacy selectors.
- Четыре golden screenshots совпали до и после CSS batch; полный browser suite прошёл 24/24.

Остальные suites ниже остаются обязательными перед теми будущими batches, которые затрагивают соответствующие integration, worker, provider или authoring contracts. Stage 2 их не менял.

## Scoped characterization, добавленный для Stage 3

- Backend pure helper suite фиксирует worker wait success/timeout/`unref()`/rejection, UUID v1–5 и отдельный v1–8 document boundary, canonical JSON ordering и SHA-256 — 4/4.
- Frontend query suite фиксирует omission, coercion, insertion order, Cyrillic/NBSP/reserved-character encoding, `null`/`false`/`0`/array behavior и точные defaults трёх admin endpoints — 2/2.
- Results suite фиксирует общий error fallback и points formatting — 1 новый test.
- Characterization был зелёным до переключения production consumers; после переключения focused API/web gates повторены.
- Полный web suite вырос с 312 до 315 tests; source-contract assertions теперь требуют shared serializer и caller-owned defaults, а не локальную копию `URLSearchParams`.

Stage 3 не менял React state/effects, запросы, routing, SQL, worker lifecycle, provider или public contracts. Exact execution record — `06-safe-deduplication.md`.

## Scoped characterization, добавленный для Stage 4 Batch 1

- `training-admin-controller-contract.test.cjs` получает controllers из runtime metadata `TrainingModule` и фиксирует все 43 handler: exact name/method/path/effective status, prefix, guard order, permission, route arguments, interceptor presence и отсутствие duplicate owners.
- Исходный `TrainingAdminController` отдельно сохраняет exact пять constructor tokens и все 43 public instance methods; 30 inherited compatibility delegates вызываются тем же delegation table, но не получают route metadata и не создают duplicates.
- Delegation table фиксирует service token/method, точный порядок аргументов, return semantics и raw `Idempotency-Key`.
- Отдельно зафиксированы success-only `upload/retry → documentWorker.kick()`, passthrough исходной ошибки, exact download headers/filename sanitization/Buffer/send order и file-size interceptor contract.
- Один и тот же suite был зелёным до и после перемещения: 5/5; совместный targeted content/documents gate — 31/31.
- Два явных PostgreSQL repeats после split — 111/111 и 111/111 на clean temporary DB; полный API и root suites добавили ещё по одному зелёному DB run.
- Static source assertions content/documents теперь проверяют aggregate узких controllers, а не расположение route в старом god-file; semantic expectations не удалены и не ослаблены.

Stage 4 Batch 1 не менял Prisma/query/transaction/state, DTO, jobs, provider/Telegram/OpenAI, frontend или production. Exact execution record — `07-backend-god-file-batch-1.md`.

## Обязательные новые characterization suites для последующих stages

### 1. Connected Telegram voice E2E

Текущий full-chain вызывает link/attempt services напрямую (`apps/api/tests/training-full-chain.e2e.cjs:144-169,193-269`), а HTTP API поднимает только после завершения attempt (`:339-352`). Нужен fake-transport connected сценарий:

```text
webhook secret -> persisted update -> Telegram worker/dialog
-> link/start callback -> voice update -> finish callback
-> audio assemble -> transcription -> evaluation -> finalization
-> outbox delivery -> employee/admin result
```

Использовать real PostgreSQL, private MinIO и FFmpeg, но fake Telegram/OpenAI. Assertions: exact callback/job payloads, idempotency, no unsigned storage access, persisted terminal states после restart.

### 2. Producer/consumer job contracts

Snapshot/behavior tests для exact `kind`, payload fields, correlation ID, idempotency key и owner transition:

- attempt → audio (`training-attempt-engine.service.ts:765-783`);
- finish → assemble/transcribe/evaluate (`:925-946,3527-3571`);
- audio commit → transcription (`training-audio-worker.service.ts:803-843`);
- attempt/dialog → Telegram outbox;
- documents/official URLs/fact suggestions → соответствующие workers.

### 3. Process topology и lifecycle

Boot application contexts и доказать:

- API attempt processor выключен (`training.module.ts:129-136`);
- dedicated worker включён (`training-audio-worker.module.ts:101-104`);
- точные worker kinds/heartbeats для attempt, audio, document, URL, fact suggestion и Telegram;
- намеренность либо исправление dual document-worker ownership;
- feature disable после claim, bounded SIGTERM, lease release и restart recovery.

### 4. Connected authoring PostgreSQL/HTTP golden flow

Через реальные controllers/guards/Prisma:

```text
create project -> working draft/clone -> question/fact/criterion
-> linked/manual source -> readiness -> publish -> open
-> immutable mutation rejection -> AuditLog
```

Добавить 401/403/feature-disabled, optimistic assignment revision и permission matrix. Browser mocks не заменяют этот gate.

### 5. Frontend concurrency и lifecycle

- slow A / fast B для project list/editor, results list/detail, employee shell, operations/ranking;
- request counts для config, assignments, source/suggestion polling и ranking;
- visited hidden steps остаются mounted и сохраняют drafts;
- no overlapping polling; terminal refresh происходит;
- upload queue concurrency/retry;
- review POST идемпотентен, ambiguous response не повторяет mutation;
- audio object URL создаётся/отзывается ровно один раз;
- responsive screenshot baseline admin editor/results desktop/mobile.

### 6. Public contract inventory

До удаления exports или split зафиксировать:

- Nest controllers: exact method/path/guards/permissions/status;
- shared DTO runtime fixtures/TypeScript compile consumers;
- public service methods, DI exports и tokens;
- Telegram callback/message formats;
- provider request/response/error snapshots;
- env key/default/fail-closed behavior.

## Неявный порядок, который тесты должны защищать

- content mutation: project lock → version lock → повторная проверка `DRAFT` (`training-version-lock.ts:31-42`);
- attempt recovery: re-enqueue processing → timeout intents → timeout handling → drain (`training-attempt-engine.service.ts:1861-1942`);
- provider: `PENDING → REQUESTING` до HTTP; recovered `REQUESTING → AMBIGUOUS`; retry только explicit reprocess (`:3171-3229`);
- external OpenAI/Telegram/S3/FFmpeg call не выполняется внутри долгой DB transaction;
- production audio finish ставит async assemble job; sync drain только без audio config (`:925-955`);
- merge ждёт original files, затем атомарно сохраняет merged file и transcription job (`training-audio-worker.service.ts:407-455,803-843`);
- Telegram drain: critical recovery → stale recovery → claim → process → ownership refresh → terminal result (`training-telegram-worker.service.ts:169-199`);
- attempt shutdown/restart не создаёт повторный billable provider request (`training-attempt-engine.service.ts:261-271`).

## Regression matrix по refactor batch

| Изменяемая зона | Минимальный focused gate | Обязательный integration gate | UI/ops gate |
|---|---|---|---|
| dead imports/types/helpers | API/web build, relevant unit | полный DB runner | `git diff --check` |
| CSS dead selectors | web unit | — | editor/results Playwright + screenshot desktop/mobile |
| pure shared helpers | helper unit, exact snapshot | полный DB runner | web tests при frontend consumer; Stage 3 PASS |
| content/controller | content/doc/source/fact unit | authoring HTTP + content-lock DB + full-chain | editor Playwright |
| attempt/scoring/review | contracts/scoring/engine/OpenAI unit | весь DB runner + fake full-chain | results/review Playwright |
| audio/storage | audio unit | audio DB/HTTP + Docker + full-chain | audio browser lifecycle |
| Telegram | Telegram unit | isolated Telegram DB + connected webhook E2E | employee policy/link flow |
| results/ranking/shared DTO | results/ranking unit | results DB/HTTP/CSV | results/ranking/employee Playwright |
| frontend split | web unit, query/request-count | connected authoring/results | all training Playwright + screenshots + build |
| provider/wiring/workers | provider protocol unit, module boot | DB restart/race + full-chain + Docker | heartbeat/SIGTERM/preflight |
| performance | exact output fixtures | query-count/plan/cardinality benchmarks | stale/polling/memory/bundle budgets |

Прямые `node --test` для API запускать только после API build: suites импортируют `dist`.

## Performance regression plan

Каждая оптимизация требует before/after evidence на одинаковом fixture/cardinality:

| Surface | Метрики | Acceptance |
|---|---|---|
| Telegram employee projects | DB statements на N projects, p95, DTO snapshot | уйти от `1+2N`; constant bounded query count, identical eligibility/score |
| attempt recovery | rows scanned, tx count/duration, statements/sec, restart latency | bounded/non-overlapping sweep без пропуска timeout/finalize |
| ranking page | relation rows/bytes, p95, exact order/position/total | heavy detail только для нужных attempts, DTO byte-equivalent |
| ranking CSV | statements, wall time, peak RSS на 1k/10k users | no repeated full aggregate per page; exact CSV bytes/order/escaping |
| source lists/polling | row width, DB→Node bytes, heap/GC, request overlap | preview DTO identical; no full 1 MB text transfer; terminal refresh preserved |
| heartbeats | effective intervals, updates/sec, WAL/CPU, ONLINE threshold | cadence decoupled без false OFFLINE и shutdown regression |
| answer context/detail history | rows/bytes/RSS, provider input snapshots | narrow reads, provider/admin DTO identical |
| draft clone | statement count, lock/tx duration, partial-state probe | atomic version clone и lock order неизменны |

Не добавлять индекс, cursor pagination или schema change в Stage 7 без отдельного plan/approval. Локальный fixture `EXPLAIN` не выдавать за production proof.

## Полный финальный gate

После каждого крупного stage и обязательно перед Stage 8:

```bash
pnpm --filter @platforma/api test
pnpm --filter @platforma/web test
pnpm build
pnpm test
pnpm --filter @platforma/web test:training:browser
pnpm test:training:e2e
pnpm --filter @platforma/api test:training:audio:docker
git diff --check
```

Дополнительно: module/route/job/provider/env snapshots, import-cycle scan, deployment preflight/Compose validation и сравнение production-like query plans. Real Telegram/OpenAI smoke и production rollout — отдельные внешние gates только после явного разрешения.

## Acceptance для старта рефакторинга

`REFACTOR_BASELINE_READY` поставлен 2026-08-01, потому что:

- branch/worktree baseline явно принят;
- API DB suite зелёная минимум три запуска;
- все новые P0 characterization tests зелёные;
- recovery/content-lock contracts утверждены;
- список неизменяемых contracts подписан;
- необходимые для recovery gates зелёны.

На этом baseline выполнены scoped characterization, proven dead-code removal, safe deduplication и только первый backend god-file split (Stage 1–3 + Stage 4 Batch 1). Перед каждым следующим batch Stage 4–8 нужны его stage-specific gates и отдельная явная команда; текущая работа остановлена перед вторым backend god-file.
