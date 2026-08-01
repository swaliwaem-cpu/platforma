# Модуль обучения: backend god-file Batch 1

Дата выполнения: 2026-08-01. Разрешение: `REFACTOR_STAGE_4A_APPROVED`.

Статус: `BACKEND_GOD_FILE_BATCH_1_COMPLETE`. Выполнен только первый batch Stage 4: разделён `apps/api/src/training/training-admin.controller.ts`. Остальные backend/frontend god-files, React warning и query optimization не затрагивались.

## Почему выбран этот файл

`training-admin.controller.ts` был первым приоритетом утверждённого Stage 4 plan и имел средний/высокий, но ограниченный controller-level риск: 509 LOC, 43 route handler, пять application dependencies и семь admin domains. Prisma, transaction/state logic и внешние вызовы уже принадлежат вызываемым сервисам, поэтому разделение возможно как точный move без изменения SQL, транзакций или side effects.

Перед изменениями подтверждён baseline:

- ветка `on-ser`, HEAD `9fcb6b3`, tag `training-refactor-dedup-complete`;
- `pnpm --filter @platforma/api test` — pass, unit 542/542 и PostgreSQL 111/111;
- `pnpm --filter @platforma/web test` — 315/315;
- `pnpm build`, `pnpm test` — pass;
- Playwright training — 24/24;
- Prisma schema valid, `git diff --check` — pass;
- пользовательские `output/pdf/training-admin-tate-guide.pdf` и `output/training-editor-design/` оставлены без изменений.

## Responsibility map и решение

Пять параллельных read-only анализов проверили responsibility map, transaction/state safety, Nest DI/public surface, regression coverage и extraction design.

| Responsibility | Current methods | Classification | Target file/class | Dependencies | Risk/gate |
|---|---|---|---|---|---|
| project/version lifecycle | 13: project CRUD/status/draft и version read/update/delete/publish | `KEEP_IN_FACADE` | `training-admin.controller.ts` / `TrainingAdminController` | `TrainingContentService` | route/security matrix, content tests |
| document/catalog HTTP boundary | 8: object catalog, list/upload/text/update/retry/delete/download | `SAFE_SERVICE_EXTRACTION` | `training-admin-documents.controller.ts` / `TrainingAdminDocumentsController` | `TrainingDocumentsService`, `TrainingDocumentWorkerService` | `upload/retry → kick` переносить целиком; exact download headers |
| document response serializer | `ContentResponse`, content-disposition sanitizer | `SAFE_PURE_EXTRACTION` | рядом с documents controller | нет DI | exact byte/header order test |
| official URL sources | 5: list/create/text/retry/delete | `SAFE_SERVICE_EXTRACTION` | `training-admin-official-url-sources.controller.ts` | `TrainingOfficialUrlSourcesService` | не добавлять worker kick/catch |
| fact suggestions | 5: create/latest/list/accept/reject | `SAFE_SERVICE_EXTRACTION` | `training-admin-fact-suggestions.controller.ts` | `TrainingFactSuggestionsService` | сохранить raw idempotency header и аргументы |
| questions | 4 CRUD handler | `SAFE_SERVICE_EXTRACTION` | `training-admin-questions.controller.ts` | `TrainingContentService` | direct delegation only |
| facts | 4 CRUD handler | `SAFE_SERVICE_EXTRACTION` | `training-admin-facts.controller.ts` | `TrainingContentService` | direct delegation only |
| criteria | 4 CRUD handler | `SAFE_SERVICE_EXTRACTION` | `training-admin-criteria.controller.ts` | `TrainingContentService` | direct delegation only |

Controller не содержал private transaction/state methods. `TRANSACTION_BOUNDARY_DO_NOT_SPLIT` применён к двум цельным orchestration sequence: успешный document upload/retry должен завершиться до `documentWorker.kick()`. `UNCERTAIN_KEEP` production code отсутствует: `listRealEstateObjects` подтверждён как document/catalog boundary его единственным service owner и route characterization.

## Characterization до production move

Добавлен `apps/api/tests/training-admin-controller-contract.test.cjs`, который получает controllers из runtime metadata `TrainingModule` и не зависит от физического расположения handler-а.

Он фиксирует:

- все 43 handler name + HTTP method/path/effective status;
- прежние 43 public instance methods и пять constructor tokens исходного `TrainingAdminController`;
- prefix `training/admin`, exact guard order и permission `training:projects:manage` у каждого фактического owner;
- route argument metadata, включая `idempotency-key`, raw response и uploaded file;
- единственного owner и отсутствие duplicate routes;
- точный service method/argument order и return semantics;
- success-only порядок `upload/retry service → worker.kick`, passthrough исходной ошибки;
- exact private download headers, filename sanitization, исходный `Buffer` и `send` order;
- единственный `FileInterceptor('file')` с `TRAINING_MAX_DOCUMENT_BYTES`.

Первый test-authoring run выявил только неоднозначное имя `listProjects` у другого controller prefix. Owner lookup был сужен точным `training/admin` до production move; expectations не ослаблялись. Финальный pre-move gate: новый suite 5/5, совместно с content/documents — 31/31. Production code перемещался только после этого зелёного результата.

Существующие source assertions в `training-content-service.test.cjs` и `training-documents.test.cjs` переведены с одного физического файла на совокупность узких `training-admin*.controller.ts`; проверяемые routes, permission, interceptor и private-cache semantics сохранены.

## Реализация и публичные контракты

Исходный `TrainingAdminController` остался экспортируемым class token и зарегистрированным controller для project/version lifecycle. Его прежние 43 public instance methods и пять constructor tokens сохранены: 13 route handlers объявлены в исходном классе, 30 compatibility delegates наследуются из узкого `training-admin-controller.compatibility.ts` и не несут Nest route metadata. Единственный HTTP owner каждого извлечённого route — соответствующий узкий controller; direct-call facade вызывает тот же controller method и сохраняет behavior.

Во всех семи controller-классах сохранены:

- `@Controller('training/admin')`;
- guard order `JwtAuthGuard → PermissionsGuard → TrainingFeatureGuard`;
- `@RequirePermissions('training:projects:manage')`;
- exact method/path/status/parameter decorators;
- прежние service tokens и порядок аргументов.

В `TrainingModule` добавлена только регистрация шести controllers. Providers, exports, imports, DTO, schema, migrations и dependencies не менялись. Новые controllers импортируют services/types только вниз по существующему направлению; обратных imports нет.

## Transaction/state guarantees

- Ни один Prisma query/write, transaction, isolation level, project/version lock, advisory lock, CAS, lease, retry или audit event не перемещён и не изменён.
- Project/version/questions/facts/criteria продолжают вызывать прежний `TrainingContentService` одним вызовом.
- Official URL create/retry/delete сохраняют прежние service-owned locks/jobs/audit; controller не добавляет worker kick.
- Fact suggestion create сохраняет raw `Idempotency-Key` пятым service argument; accept/reject сохраняют service-owned Serializable transaction и error passthrough.
- Document upload/retry вызывают `kick()` ровно после успешного service result и не вызывают его при reject.
- Document download сохраняет service read → четыре headers в прежнем порядке → отправку того же buffer.
- Новых DB/external calls, catch/error translation, jobs, callbacks, logging или side effects нет.

## Метрики

Методика: physical LOC; TypeScript AST `MethodDeclaration` без constructor; dependency — constructor parameter; method length — от первого decorator до закрывающей скобки.

| Метрика | До | После |
|---|---:|---:|
| LOC исходного `training-admin.controller.ts` | 509 | 155 |
| Объявленные route methods исходного класса | 43 | 13 |
| Public instance methods исходного класса | 43 | 43, включая 30 inherited compatibility delegates |
| Constructor dependencies исходного класса | 5 | 5; exact DI signature сохранена |
| Max method исходного класса | 20 | 9 |
| Extracted responsibilities | 0 | 6 domain responsibilities + 1 local serializer |
| Новые production-файлы | 0 | 7: 6 controllers + 1 controller-specific compatibility surface |
| Static relative-import cycles | 0 | 0; 86 files, 287 edges |
| Production net LOC | — | `+339`: `-354` facade, `+553` controllers, `+128` compatibility, `+12` module wiring |

Новые production-файлы имеют 70–161 LOC. Крупнейший — documents controller: одна document/catalog HTTP responsibility, 8 методов, 2 dependencies, max method 20. Compatibility-файл — 128 LOC и содержит только типизированную карту прежнего instance surface к этим узким controllers, без routes/DB/business logic. Новые god-files не созданы. Семейство сохраняет суммарно 43 route handler, исходные 43 public instance methods и те же пять уникальных application dependencies.

## Финальные проверки

| Gate | Результат |
|---|---|
| targeted contract/content/documents | 31/31 pass до и после move |
| `pnpm --filter @platforma/api test` | pass; unit 547/547, PostgreSQL 111/111 |
| PostgreSQL repeat 1 | 111/111; 43 migrations; temporary DB dropped |
| PostgreSQL repeat 2 | 111/111; 43 migrations; temporary DB dropped |
| `pnpm --filter @platforma/web test` | 315/315 pass |
| `pnpm build` | pass; прежний main chunk 787.75 kB и известный warning |
| `pnpm test` | pass; PostgreSQL 111/111, temporary DB dropped |
| Playwright training | 24/24 pass; goldens не изменены |
| Prisma validate | valid |
| import-cycle scan | 0 cycles |
| `git diff --check` | pass |

Проверено отсутствие `.only/.skip`, удалённых tests, новых migrations, snapshot/golden changes и `output/` diff. Существующий browser warning `Maximum update depth exceeded` воспроизведён и намеренно не исправлялся.

## Deferred

- Остальные backend god-files Stage 4: content, results, documents service, fact suggestions service, Telegram dialog и attempt engine.
- Все frontend god-files и Stage 5–8.
- Ранее отмеченные uncertain responsibilities/dead-code candidates вне выбранного controller.
- React warning и query optimization.
- Fake full-chain, Docker audio, real Telegram/OpenAI и production/SSH: этот controller-only move не меняет соответствующие boundaries; дополнительные действия требуют отдельного scope/GO.
