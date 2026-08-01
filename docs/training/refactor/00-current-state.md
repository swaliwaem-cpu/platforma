# Модуль обучения: текущее состояние перед рефакторингом

Дата аудита: 2026-07-31. Baseline recovery: 2026-08-01. Ветка: `on-ser`.

## Вердикт

Красный PostgreSQL baseline восстановлен: `REFACTOR_BASELINE_READY`. Исходные `21` failure разложены на пять общих test/fixture root causes; OpenAI recovery, publication race и document-worker ownership зафиксированы real PostgreSQL tests. Архитектурные риски аудита сохраняются, но больше не маскируются красным baseline.

Рефакторинг не начат. До отдельной команды `REFACTOR_APPROVED` не удалять dead code, не делить крупные файлы и не начинать Stage 2+.

## Границы и методика

В production-срез включены:

- `apps/api/src/training/`;
- `apps/web/src/training/`;
- `packages/shared/src/training.ts`;
- связанные controllers/routes, worker entrypoint и Nest wiring;
- связанные Prisma-модели и индексы;
- training unit, PostgreSQL integration, browser, Docker-audio и full-chain harness.

Не включались в LOC production-среза: `dist`, generated declarations `*.d.mts`, `docs`, `output`, fixtures и тестовые файлы.

Пять параллельных read-only проходов независимо проверили backend architecture, frontend architecture, dead code/duplication, tests/safety и data/performance. Дополнительно построен статический граф из 91 TypeScript/JavaScript production-модуля: 255 относительных import edges, циклических SCC не найдено. Это доказывает отсутствие статических relative-import cycles, но не исключает Nest DI/runtime cycles.

## Preflight и baseline

| Проверка | Результат | Вывод |
|---|---|---|
| `git branch --show-current` | `on-ser` | ожидаемая ветка |
| `git status --short` | `?? output/pdf/training-admin-tate-guide.pdf`; `?? output/training-editor-design/` | worktree был не чист до аудита; артефакты не тронуты |
| `pnpm --filter @platforma/api test` | pass; unit 537/537, PostgreSQL 111/111 | зелёный API baseline |
| `pnpm --filter @platforma/web test` | 312/312 pass | зелёный web unit/source baseline |
| `pnpm build` | pass | production build проходит; Vite предупреждает о main chunk 790.87 kB |
| `pnpm test` | pass; включая PostgreSQL 111/111 | root baseline зелёный |
| PostgreSQL repeat 1 / repeat 2 | 111/111; 111/111 | два независимых зелёных повтора после финальных исправлений |
| Prisma validate / clean migrations | pass; 43 migrations | схема валидна; каждый DB run развернул clean temporary database |
| `git diff --check` | pass | whitespace errors нет |

API-команда выполняет build, unit и общий DB runner (`apps/api/package.json:14-17`). DB runner создаёт UUID-именованную временную БД, применяет 43 migration, последовательно запускает 11 integration-файлов в fake-provider environment и удаляет БД в `finally`. Root `pnpm test` не включает Playwright, full-chain и Docker-audio (`package.json:15-16`; `apps/api/package.json:18-19`; `apps/web/package.json:10-11`).

Исходные 21 failure группируются так:

1. OpenAI crash-window fixture не ждал committed `TrainingProviderRun.REQUESTING`: 3 failure с учётом parent subtest.
2. Publication fixture отстал от readiness-контракта и поздняя mutation сама нарушала unique position: 1 failure.
3. Telegram fixture повторно использовал `telegramId`: 1 failure.
4. Два worker-сценария передавали undefined `engine`, а due job запускал каскад: 3 failure.
5. Прямые Telegram worker fixtures не передавали production-required attempt engine: 13 каскадных failure.

Полная классифация, исправления и контракты: `docs/training/refactor/04-baseline-recovery.md`.

## Размер production-среза

| Слой | Файлы | LOC |
|---|---:|---:|
| API training | 76 | 35 113 |
| Web training, включая 3 runtime `*.mjs` | 17 | 16 001 |
| Shared training contract | 1 | 639 |
| **Всего** | **94** | **51 997** |

## Top-20 production-файлов

| # | LOC | Файл | Основная ответственность | Почему риск/кандидат | Предлагаемая граница split |
|---:|---:|---|---|---|---|
| 1 | 5 899 | `apps/web/src/training/TrainingAdminPage.tsx` | route dispatch, list/create/editor, 7 wizard-секций, polling, upload, history/dirty guards | критический god-component; UI и orchestration слиты | façade route + list/create/editor + editor hooks + section components + pure form/view-model helpers |
| 2 | 4 489 | `apps/api/src/training/training-attempt-engine.service.ts` | attempt state machine, jobs, providers, review, recovery, queries | 11 dependencies, DB/state machine/worker/integrations в одном классе | сохранить façade; поэтапно вынести commands, review, job runtime, provider coordinator, finalizer |
| 3 | 2 487 | `apps/api/src/training/training-content.service.ts` | project/version/question/fact/criterion CRUD, publish, clone, audit, parsing | 78 методов и несколько aggregates | project/version lifecycle и entity services; publish transaction оставить цельной первой |
| 4 | 2 390 | `apps/web/src/training/trainingAdmin.css` | весь admin editor/wizard responsive cascade | глобальный cascade и подтверждённый selector residue | делить последним по фактическим компонентам, сохраняя порядок правил |
| 5 | 2 175 | `apps/api/src/training/fact-suggestions/training-fact-suggestion-worker.service.ts` | polling/lease, provider orchestration, recovery, result persistence | god-worker, собственная job infrastructure | runtime/lease repository, input planner, provider state machine, persister |
| 6 | 2 035 | `apps/web/src/training/trainingResults.css` | employee/results/ranking/operations styles | глобальный cascade, крупный technical-UI residue | shared results primitives + page styles, после screenshot baseline |
| 7 | 2 010 | `apps/web/src/training/TrainingAdminResultsPage.tsx` | list/detail/workspace/audio/review/history | пять подсистем и async/browser side effects | list, detail query hook, workspace/audio, review hook/panel, evidence view-model |
| 8 | 1 783 | `apps/api/src/training/audio/training-audio-worker.service.ts` | Telegram download, FFmpeg, private storage intents, cleanup, jobs | 8 dependencies, четыре external/DB boundaries | worker runtime, downloader, assembler, object-intent service, terminalization |
| 9 | 1 642 | `apps/api/src/training/fact-suggestions/training-fact-suggestions.service.ts` | run/query/review commands, source planning, budgets, audit | commands, queries, planning, serialization смешаны | query service, run planner/command, review command, codecs |
| 10 | 1 421 | `apps/api/src/training/training-results.service.ts` | employee/admin read models, eligibility, serialization | два DTO-контракта и audit чтения transcript | employee/admin query services, serializers, отдельный sensitive-read audit |
| 11 | 1 359 | `apps/api/src/training/training-documents.service.ts` | linked PDFs, uploads, extraction state, storage, audit | DB + storage + HTTP input | linked source, uploaded document, storage façade, codecs/audit |
| 12 | 1 257 | `apps/api/src/training/telegram/training-telegram-dialog.service.ts` | update/callback routing, attempt use cases, read models, messages/keyboards | transport presentation и application logic слиты | update router, command adapter, read model, message renderer |
| 13 | 1 025 | `apps/api/src/training/openai/training-openai-evaluation.provider.ts` | OpenAI Responses request/schema/prompt/strict parsing | большой adapter, но основной класс связен | выносить только schemas/prompt/output codec; adapter не дробить ради LOC |
| 14 | 982 | `apps/api/src/training/telegram/training-telegram-worker.service.ts` | inbound/outbound jobs, transport, retry/recovery | god-worker и critical terminalization | lease runtime, inbound handler, delivery handler, critical recovery |
| 15 | 885 | `apps/api/src/training/training-document-worker.service.ts` | document job runtime, storage read, extraction, recovery | worker infrastructure + handler | runtime, extraction handler, state persister |
| 16 | 883 | `apps/web/src/training/trainingAdminApi.ts` | admin DTO declarations и весь authoring HTTP façade | домены/контракты/API calls в одном файле | types/facade + projects/content/sources/assignments/suggestions API modules |
| 17 | 863 | `apps/web/src/training/TrainingShellPage.tsx` | employee config/policy/Telegram/projects/history/detail | entrypoint и несколько features в одном component | employee data hook + policy + Telegram + cards/history/detail |
| 18 | 816 | `apps/api/src/training/training-content.validation.ts` | readiness/publication validation | в основном связный; домен зависит от Nest/OpenAI details | сначала отделить pure issue collectors от exception adapters, без механического split |
| 19 | 792 | `apps/api/src/training/training-official-url-worker.service.ts` | URL jobs, fetch, snapshot storage, recovery/orphan cleanup | worker runtime и integration handler смешаны | runtime, fetch/persist handler, orphan cleanup |
| 20 | 748 | `apps/api/src/training/fact-suggestions/training-fact-suggestion.provider.ts` | fake/real provider, schema/request/output validation | связный provider с codec duplication | contracts/schema, fake provider, real adapter, output codec |

Файлы, которые не следует дробить только из-за LOC: `training-official-url-fetcher.ts` является SSRF/DNS/HTTPS security boundary; `training-ffmpeg.service.ts` — process/filesystem boundary; оба provider-файла в основном связны. Для них важнее изоляция codec/helper, чем количество файлов.

## Карточки крупных файлов

| Файл | Public API / callers | Зависимости | Side effects и DB writes | External calls | Текущее покрытие |
|---|---|---|---|---|---|
| `TrainingAdminPage.tsx` | `TrainingAdminPage`; `App.tsx:525` | auth, `trainingAdminApi`, picker/wizard/readiness | HTTP mutations, polling, upload/download, `history`, `beforeunload`, focus | Platforma API/browser | source tests; 8 editor Playwright scenarios |
| `training-attempt-engine.service.ts` | 13 public/lifecycle methods; Telegram dialog, review controller, Telegram worker | Prisma, clock, selector, providers, config/policy/heartbeat | writes attempt/question/segment/transcription/evaluation/provider run/job/review/audit | transcription `:2358`; evaluation `:2746`; outbox writes | fake-Prisma unit + PostgreSQL race/recovery; baseline green |
| `training-content.service.ts` | project/version/content CRUD and lifecycle; admin controller | Prisma | project/version/questions/facts/criteria/links/audit writes | none | fake-Prisma behavioral + 5 PostgreSQL publication/content-lock tests |
| `trainingAdmin.css` | global import by admin page | global CSS cascade | layout/responsive side effects | none | DOM/browser assertions; no screenshot baseline |
| `training-fact-suggestion-worker.service.ts` | lifecycle, `kick`, `drainNow`; worker module | Prisma, provider, config, heartbeat | job/provider/suggestion/run/audit writes | `provider.suggest` `:445` | unit + PostgreSQL fact-suggestion suites |
| `trainingResults.css` | imported by result/shell pages | global CSS cascade | layout/responsive side effects | none | browser assertions; no complete visual baseline |
| `TrainingAdminResultsPage.tsx` | lazy route from `App.tsx:31-34` | results API, auth, review state machine, audio helper | review/reprocess POST, object URL lifecycle, history/navigation | Platforma API/audio URL | unit/source + 15 results Playwright scenarios |
| `training-audio-worker.service.ts` | lifecycle, `kick`, `drainNow`; worker module | Prisma, Files, FFmpeg, Telegram audio, config/heartbeat | file/answer/attempt/upload-intent/job/segment writes and cleanup | Telegram download, private storage, FFmpeg, outbox | unit, PostgreSQL, HTTP and optional Docker suites |
| `training-fact-suggestions.service.ts` | create/list/get/accept/reject/dismiss/retry; admin controller | Prisma, OpenAI config | run/provider/suggestion/fact/link/job/audit writes | none | unit + PostgreSQL |
| `training-results.service.ts` | employee/admin list/detail; results controllers | Prisma | mostly reads; transcript detail writes AuditLog `:722-737` | none | unit + PostgreSQL/HTTP results suite |
| `training-documents.service.ts` | linked/manual document commands and queries; admin/linked controllers | Prisma, Files, extractor metadata | files/source/jobs/audit writes, storage upload/delete | object storage | document unit; connected authoring gap |
| `training-telegram-dialog.service.ts` | employee queries and update handler; Telegram worker | Prisma, config, links, attempts, optional policy | reads plus Telegram delivery job writes | none directly | Telegram unit + DB; connected webhook-to-voice gap |
| `training-openai-evaluation.provider.ts` | provider class/factory/helpers; attempt engine through token | OpenAI config/HTTP client, shared schemas | no DB; validates request/response | OpenAI Responses `/v1/responses`, `store:false` | local HTTP-stub protocol tests; real billable smoke not run |
| `training-telegram-worker.service.ts` | lifecycle and job drain; module/webhook | Prisma, dialog, transport, config/heartbeat, optional attempts | processed-update/job state and critical attempt terminalization | Telegram transport | unit + PostgreSQL DB; fixtures isolated, baseline green |
| `training-document-worker.service.ts` | lifecycle worker; API and worker modules | Prisma, Files, extractor, config/heartbeat | document/job state | storage read, extractor | unit + real PostgreSQL dual-consumer and stale-lease tests |
| `trainingAdminApi.ts` | all authoring HTTP wrappers and local DTOs; admin page | shared `apiRequest` | HTTP only, idempotency key generation | Platforma API | page/source tests; no isolated serializer contract tests |
| `TrainingShellPage.tsx` | employee entrypoint; `App.tsx:597` | auth, shared DTO, results/Telegram/policy API | policy accept, link/revoke, window navigation | Platforma API, Telegram deep link | source + employee/policy browser scenarios |
| `training-content.validation.ts` | readiness collectors/assertions; content/doc/source services | Prisma types, Nest exception, OpenAI limits | none; pure-ish validation | none | content/readiness unit/source tests |
| `training-official-url-worker.service.ts` | lifecycle worker; worker module | Prisma, fetcher, Files, config/heartbeat | source/snapshot/job state and orphan cleanup | HTTPS fetch, storage | URL unit/DB coverage; lifecycle boot gap |
| `training-fact-suggestion.provider.ts` | fake/real provider and factory | OpenAI config/HTTP, strict codecs | no DB | OpenAI Responses `/v1/responses`, `store:false` | local provider protocol unit tests |

Дополнительный god-controller: `apps/api/src/training/training-admin.controller.ts:43-502` — 43 handlers и пять application dependencies. Его можно разделить на controller-классы с тем же `@Controller('training/admin')`, guards, methods и paths.

## Карта зависимостей и потоков

```text
Web manual routes (App.tsx)
  ├─ Admin authoring ── trainingAdminApi ───────────────┐
  ├─ Admin results/ranking/operations ─ results API ───┤
  └─ Employee shell/policy/Telegram ───────────────────┤
                                                       v
Nest controllers/guards/permissions
  ├─ content / assignments / documents / URL / facts ──┐
  ├─ results / ranking / review / operations ───────────┤
  └─ Telegram account / webhook / audio ────────────────┤
                                                        v
Application services and PostgreSQL/Prisma
  ├─ authoring aggregates + AuditLog
  ├─ attempt state machine + persisted TrainingJob queue
  ├─ employee/admin read models
  └─ Telegram link/update/outbox state

Telegram webhook/update
  -> TrainingTelegramWorkerService
  -> TrainingTelegramDialogService
  -> TrainingAttemptEngineService
  -> persisted audio/attempt/outbox jobs

training-worker process
  ├─ TrainingAudioWorker -> Telegram audio -> private Files/S3 -> FFmpeg
  ├─ AttemptEngine job loop -> transcription/evaluation provider ports -> OpenAI/fake
  ├─ DocumentWorker -> Files -> document extractor
  ├─ OfficialUrlWorker -> secure fetcher -> private source snapshot
  └─ FactSuggestionWorker -> OpenAI/fake -> suggestion persistence

Results/ranking
  <- attempts/questions/evaluations/reviews/provider runs
  -> employee-safe DTO / admin-sensitive DTO / CSV
```

Wiring API-процесса: `apps/api/src/training/training.module.ts:70-173`; wiring worker-процесса: `apps/api/src/training/audio/training-audio-worker.module.ts:55-147`; entrypoint и bounded shutdown: `apps/api/src/training/training-worker.main.ts:8-27`. API отключает attempt job processor (`training.module.ts:129-136`), worker включает (`training-audio-worker.module.ts:101-104`). Document worker зарегистрирован в обоих процессах как несколько одинаковых consumers. Безопасность обеспечивают job CAS, lease ownership, heartbeat и отдельный source-document fence; real PostgreSQL test доказывает один persisted extraction при двух consumers и детерминированное stale recovery.

## Prisma/data surface

Training-модели находятся в `apps/api/prisma/schema.prisma:1166-2000` и включают authoring/versioned content, assignments, source documents/snapshots, fact suggestions/provider runs, attempts/questions/answers/audio, reviews, Telegram accounts/updates и persisted jobs/heartbeats. Схему, migrations и enum values план не меняет.

Ключевые существующие ограничения:

- attempt uniqueness и основные status indexes: `schema.prisma:1629-1635`;
- question uniqueness/indexes: `schema.prisma:1659-1662`;
- job idempotency и claim indexes: `schema.prisma:1939-1962`;
- operations retry uniqueness: `schema.prisma:1978-1980`.

Подтверждён один N+1: Telegram `listEmployeeProjects` делает после списка по `count` и `getBestReviewedScore` на каждый проект, то есть `1 + 2N` queries (`training-telegram-dialog.service.ts:82-115`); `getEmployeeProject` сначала строит весь список и фильтрует его в памяти (`:118-123`). Results service уже имеет batched read model (`training-results.service.ts:153-227`), но объединять DTO/eligibility без characterization нельзя.

Employee results загружает все attempts по открытым project IDs, затем несколько раз фильтрует/сортирует их в памяти (`training-results.service.ts:197-257`). Это только performance-кандидат: нужна production cardinality/`EXPLAIN (ANALYZE, BUFFERS)` до изменения запроса. Admin results использует count + page query и один `groupBy`, а не N+1 (`:459-503`). Новые индексы или cursor pagination не предлагаются без измерений и отдельного разрешения.

## Контракты, которые нельзя менять

- Prisma schema, migrations и persisted enum values;
- HTTP methods/paths/status codes, shared DTO и permission order;
- Telegram `callback_data`, deep-link/link semantics и message/outbox contracts;
- job kinds, payloads, correlation/idempotency keys, claim/retry/lease semantics;
- scoring: `55 + 15 + 15 + 15`, penalty `−5`, random `3 из 10`, rounding/clamp;
- attempt timeout/grace/refund/review/reprocess behavior;
- private audio buckets, signed access, cleanup/recovery и `store:false`;
- provider request schemas, error codes, `AMBIGUOUS`/explicit reprocess semantics;
- manual React routing, RBAC visibility, visited-panel mounting, dirty/history/focus behavior;
- environment names, fake/real provider selection, API/worker process isolation and deploy topology.

## Готовность

Stage 1 / baseline recovery завершён: `REFACTOR_BASELINE_READY`. Это не означает, что рефакторинг начат: Stage 2+ требуют отдельной команды `REFACTOR_APPROVED` и своих stage-specific gates.
