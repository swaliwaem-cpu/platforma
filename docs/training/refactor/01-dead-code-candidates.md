# Модуль обучения: dead code, кандидаты, дублирование и god-files

Дата среза: 2026-07-31. Повторная read-only проверка и разрешённое удаление выполнены 2026-08-01 только для `PROVEN_UNUSED`; полный execution record находится в `05-dead-code-removal.md`.

Статус Stage 2: `COMPLETE`. Все 21 symbol/surface entry и 21 CSS selector из доказанного manifest удалены после недостающих characterization tests. Все записи `CANDIDATE` ниже оставлены без изменений; Stage 3–8 не начинались.

## Правила доказательства

`PROVEN_UNUSED` присваивался только когда выполнялось одно из условий:

- TypeScript с `--noUnusedLocals --noUnusedParameters` прямо сообщил о неиспользуемом элементе;
- точный глобальный поиск по production-коду, tests, Prisma, module/router wiring и scripts нашёл только definition/declaration;
- Nest export/public method не имеет ни внешнего DI consumer, ни controller/job/test caller в repository;
- обычный нединамический CSS class selector отсутствует во всём JSX/TS/JS markup.

Наличие содержательной логики, test-only caller, compatibility contract, enum/migration или возможного продуктового замысла переводит элемент в `CANDIDATE`, даже если текущего production caller нет.

Итог исходного аудита: **21 доказанно неиспользуемая symbol/surface entry** и **21 CSS class selector без consumer**. Таблицы ниже сохранены как исторический delete manifest; их удаление и проверки зафиксированы в `05-dead-code-removal.md`. Полностью мёртвых production-файлов, Prisma-моделей или зарегистрированных controllers не найдено.

## Доказанный dead code

| # | Элемент | Доказательство | Риск и условие удаления |
|---:|---|---|---|
| 1 | import `TrainingEvaluationCriterionInput` | `apps/api/src/training/openai/training-openai-evaluation.provider.ts:4`; TS6133 при `--noUnusedLocals` | нулевой; compile gate |
| 2 | private `parseJsonArray()` | `apps/api/src/training/training-content.service.ts:2228-2233`; TS6133 и только definition | низкий; content unit/build |
| 3 | `normalizeTrainingFactSuggestionSnapshot()` | `apps/api/src/training/fact-suggestions/training-fact-suggestion.provider.ts:425-427`; точный поиск — только definition | низкий; provider unit/build |
| 4 | `TRAINING_REVIEW_SUBMISSION_STATES` | `apps/web/src/training/trainingReviewSubmission.mjs:1-10`, declaration `trainingReviewSubmission.d.mts:11-12`; production/test imports отсутствуют | низкий; синхронно обновить declaration |
| 5 | getter `TrainingReviewSubmission.state` | `trainingReviewSubmission.mjs:23-25`, declaration `trainingReviewSubmission.d.mts:22`; обращений к getter нет | низкий; внутреннее `#state` оставить |
| 6 | prop `TrainingShellPageProps.mode` | `apps/web/src/training/TrainingShellPage.tsx:65-75`; компонент деструктурирует только `onBack`, единственный caller передаёт `employee` (`App.tsx:597`) | низкий, но сначала заменить source assertion реальным route test |
| 7–9 | `TrainingAttemptStartSnapshot`, `TrainingSelectedQuestion`, `TrainingPrivateVoiceObject` | `apps/api/src/training/training.domain.ts:33-58`; каждый точный символ встречается только в definition | низкий; API build/contracts |
| 10–12 | `TrainingProjectRepositoryRecord`, `TrainingAttemptRepositoryRecord`, `TrainingJobClaimRecord` | `apps/api/src/training/training.repository.types.ts:84-94`; каждый alias встречается только в definition | низкий; не удалять используемые include/select constants вместе с aliases |
| 13 | `TrainingFactSuggestionsService.listRuns()` | `apps/api/src/training/fact-suggestions/training-fact-suggestions.service.ts:127-143`; нет controller/job/test caller | средний: подтвердить отказ от planned run-history UI |
| 14 | `TrainingFactSuggestionsService.dismissRun()` | тот же файл `:518-624`; controller `training-admin.controller.ts:228-285` route не предоставляет | средний/высокий: содержательная недостижимая логика |
| 15 | `TrainingFactSuggestionsService.retryRun()` | тот же файл `:626-673`; нет route/caller | средний/высокий: не путать с retry provider/job operations |
| 16 | `TrainingOfficialUrlSourcesService.getSnapshot()` | `apps/api/src/training/training-official-url-sources.service.ts:384-394`; controller имеет list/create/text/retry/delete, но не snapshot route (`training-admin.controller.ts:169-225`) | средний: проверить planned protected download |
| 17–21 | лишние Nest `exports`: `TrainingAttemptEngineService`, `TrainingPolicyService`, `TrainingTelegramLinkService`, `TrainingTelegramWorkerService`, `FakeTrainingTelegramTransport` | `apps/api/src/training/training.module.ts:164-170`; `TrainingModule` импортирован только `AppModule`, вне module нужен лишь `TrainingConfigService` (`apps/api/src/health/health.controller.ts:4-10`) | низкий: удалять только export metadata, providers оставить; module-resolution characterization |

Синтаксически unreachable statements не обнаружены: API и web прошли TypeScript-проверку с `--allowUnreachableCode false`.

## CSS selectors без consumer

Динамические классы вида `training-status--${...}`, `training-document-status--${...}`, `training-wizard-step--${...}` и `admin-button--${tone}` исключены из результата.

| Файл | Zero-consumer selectors | Evidence | Риск |
|---|---|---|---|
| `apps/web/src/training/trainingAdmin.css` | `.training-editor-tabs`, `.training-card-list`, `.training-criterion-summary` | `:48,201-237,546,560-563,1134-1139`; точный поиск по `apps/web/src` не находит markup | низкий/средний: часть находится в selector groups |
| `apps/web/src/training/trainingResults.css` | `.training-detail-summary--admin`, `.training-detail-summary-final`, `.training-attempt-summary`, `.training-admin-question-list`, `.training-timeline`, `.training-answer-meta`, `.training-answer-section`, `.training-answer-section-heading`, `.training-transcript`, `.training-component-list`, `.training-component`, `.training-component--warning`, `.training-provider-details`, `.training-provider-run-list`, `.training-segment-list`, `.training-evaluation-history`, `.training-job-list`, `.training-safe-json` | `:547-573,604,699-909`; ни одного обычного markup consumer | средний: удалять отдельные selectors, не целые grouped rules; нужен visual regression |

CSS residue считается отдельно от symbol/surface entries. Он не должен удаляться до screenshot/visual baseline и проверки desktop/mobile editor/results.

## Кандидаты: не удалять автоматически

| Candidate | Почему подозрителен | Почему пока оставить / какая проверка нужна |
|---|---|---|
| `TrainingJobKind.ANALYZE_ACOUSTICS` | нет producer/consumer/worker switch | Prisma/shared enum и migration compatibility; job kinds менять запрещено (`schema.prisma:256`; shared `training.ts:82`) |
| legacy `openai-evaluation-v1` branch | текущий request schema требует v2 | historical replay fixture существует (`training-attempt-db.integration.cjs:1144`); проверить старые provider runs/reprocess |
| operations base-route alias | frontend использует `/operations/summary` | документирован legacy-equivalent; API routes менять нельзя (`training-operations.controller.ts:25-35`) |
| `revokeLinkTokens()` | production caller нет | test fixture использует метод (`training-telegram-db.integration.cjs:334`); сначала заменить fixture helper |
| `finalizeAttempt()` public façade | production завершает job processor | race/unit tests вызывают напрямую; сохранить до connected job contract tests (`training-attempt-engine.service.ts:1145-1195`) |
| `refundTechnicalFailure()` | controller route отсутствует | спецификация требует refund route; это вероятнее missing wiring, а не dead code (`:1197+`) |
| `visibleEmployeeScore()` | UI не вызывает | test-only characterization pending-score mask (`trainingViewModel.mjs:79-81`; `training-results.test.mjs:43-54`) |
| `TRAINING_IMMUTABLE_VERSION_STATUSES` | production references нет | contract test и возможная intended canonical surface (`training.domain.ts:28-31`) |
| `TRAINING_ATTEMPT_SCORE_MAXIMUM` | runtime references нет | scoring test использует alias; сначала перевести тест на canonical constant (`training-attempt-engine.service.ts:4489`) |
| repository include/select constants | часть production caller не имеет | skeleton закреплён contract tests; aliases можно удалить отдельно, constants — после query inventory (`training.repository.types.ts:3-96`) |
| shared status arrays | runtime consumers снаружи файла не найдены | публичная surface `@platforma/shared`; нужен compatibility audit возможных внешних consumers |
| лишние `export` у локальных типов | типы используются внутри своих файлов | runtime выигрыша нет; de-export только после public type inventory |
| dual `TrainingDocumentWorkerService` ownership | service зарегистрирован в API и worker, processor flag отсутствует | намеренность двух consumers не доказана; сначала process-topology/heartbeat test (`training.module.ts:95`; worker module `:73`) |
| discarded ranking GET после review | response игнорируется (`TrainingAdminResultsPage.tsx:571-584`) | source-test требует вызов; сначала behavior/request-count characterization |
| eager `TrainingAdminPage`/`TrainingShellPage` imports | большие entrypoints попадают в initial graph (`App.tsx:25-26`) | переводить на `lazy` только после route/permission/error-boundary test и bundle measurement |
| full history in editor/detail | потенциально большие payloads | UX/contract может требовать историю; измерить cardinality/bytes, pagination меняет DTO |

Fake providers не dead code: они выбираются factory через provider/transport modes и используются local/fake E2E. Все 29 training Prisma models имеют code/test delegate references. Все job kinds кроме compatibility tombstone `ANALYZE_ACOUSTICS` имеют production producer/consumer. Все controllers зарегистрированы, все пять training pages достижимы через manual router.

## Подтверждённое дублирование

Всего выделено **16 duplication families**. «Структурное» дублирование не означает, что реализации можно механически объединить.

| # | Логика | Evidence | Тип | Безопасная граница / риск |
|---:|---|---|---|---|
| 1 | `waitForPromise()` | document `:873-885`; audio `:1771-1783`; fact worker `:2163-2175`; Telegram `:963-975` | exact | общий shutdown helper; низкий риск |
| 2 | poll/drain/claim/heartbeat/recovery/shutdown | attempt, audio, Telegram, document, URL, fact workers | structural | typed lease repository/helper, не generic base worker; высокий риск |
| 3 | Serializable retry/P2034 | policy `:134-151`; assignments `:422-445`; audio `:1520-1543`; fact worker `:1319-1342`; attempt `:4112-4137`; Telegram link `:529-546`; operations `:368-395` | near | parameterized helper после retry-count/error characterization; высокий риск |
| 4 | integer env parsing | OpenAI config `:258-270`; audio config `:125-137`; Telegram config `:214-229`; document/URL fallback variants | near | явные modes throw/fallback/clamp; средний/высокий риск |
| 5 | UUID validation | content `:2443`; documents `:1317`; URL sources `:516`; facts `:48,1322`; assignments `:520`; controllers/workers | near | pure validator + local error adapters; версии UUID различаются |
| 6 | AuditLog request metadata/writer | content `:2073-2095`; documents `:1328-1351`; URL `:525-549`; facts `:1421-1446`; assignments `:394-419` | semantic | сначала зафиксировать приоритет forwarded/ip/socket |
| 7 | Responses `output_text`/JSON envelope parsing | evaluation provider `:735-760,878-1025`; fact provider `:542-598,670-729` | near | общий envelope parser, domain errors/schema limits локально |
| 8 | employee attempt serializer/pending-score mask | results `:1004-1028`; Telegram dialog `:1228-1256` | semantic/security | общий pure employee-safe serializer после privacy tests |
| 9 | publication/readiness validation | backend `training-content.validation.ts:123+`; frontend fallback `TrainingAdminPage.tsx:5485-5560` | semantic | backend остаётся authority; frontend только presentation mapping |
| 10 | evaluation schema magic/version | provider v2 `training-openai-evaluation.provider.ts:57`; stale estimator v1 `training-content.validation.ts:18,603-629` | drift | canonical internal version/estimator; provider request неизменен |
| 11 | fact-suggestion active-job raw SQL | content `:1552-1558`; suggestions `:1064-1070` | exact/near | один repository query; сохранить lowercase mapped enums |
| 12 | provider composition wiring | API module `training.module.ts:105-162`; worker module `training-audio-worker.module.ts:82-145` | structural | общий provider registration; process-specific flags рядом с roots |
| 13 | frontend `readError()` | Shell `:848`; Operations `:510`; Results `:2008`; Ranking `:403` | exact | маленький helper; низкий риск |
| 14 | frontend `formatPoints()` | `QuestionEvaluationContext.tsx:157-159`; `TrainingReadiness.tsx:105-107` | exact | pure formatter; низкий риск |
| 15 | frontend query serialization | `trainingAdminApi.ts:323-338,407-431,469-484`; `trainingResultsApi.ts:220+` | near | один encoded-query helper с contract tests |
| 16 | fact question-link selector UI | suggestions `TrainingAdminPage.tsx:2506+`; approved facts `:3014+` | semantic | общий controlled component после focus/dirty tests |

Дополнительно formatter даты/времени повторяется в Shell/Operations/Results, но семантика UTC policy date, local datetime и `null` различается; это candidate под параметризованный formatter, а не механический duplicate.

## God-files

Критерий: файл одновременно координирует минимум три независимых предметных/технических ответственности и имеет широкую mutation/side-effect surface. По этому критерию подтверждены **12 god-files**.

| Файл | Смешанные ответственности | Безопасная последовательность split | Риск |
|---|---|---|---|
| `TrainingAdminPage.tsx` | routing, editor state, seven sections, polling, uploads, browser guards | façade → hooks → sections → helpers; сохранить mounted visited panels | критический |
| `training-attempt-engine.service.ts` | commands, state machine, worker, providers, queries, review/recovery | façade и один internal collaborator за batch | критический |
| `training-content.service.ts` | multiple aggregates, publish/clone, parsing/audit | entity services; publish transaction цельной | очень высокий |
| `fact-suggestion-worker.service.ts` | runtime, lease, provider state, persistence/recovery | runtime → planner → state machine → persister | очень высокий |
| `TrainingAdminResultsPage.tsx` | list/detail/workspace/audio/review/history | query hooks → UI regions → view-model | очень высокий |
| `training-audio-worker.service.ts` | Telegram, FFmpeg, storage intents, cleanup, jobs | runtime/downloader/assembler/intents | очень высокий |
| `training-fact-suggestions.service.ts` | commands, queries, planning, review, serialization | query/command/planner/codecs | высокий |
| `training-results.service.ts` | employee/admin models, privacy, serialization, audit | employee/admin queries + presenters + audit | высокий |
| `training-documents.service.ts` | linked source, upload, storage, lifecycle, audit | linked/manual/storage/codecs | высокий |
| `training-telegram-dialog.service.ts` | router, use cases, read models, presentation/outbox | router/handlers/read model/renderer | высокий |
| `training-telegram-worker.service.ts` | inbound/outbound processing, lease, retry, critical recovery | runtime/handlers/recovery | высокий |
| `training-admin.controller.ts` | 43 handlers для семи admin domains | несколько controllers под неизменным prefix/guards/routes | средний/высокий |

`TrainingDocumentWorkerService` и `TrainingOfficialUrlWorkerService` смешивают runtime и handler, но остаются одним job domain; это split candidates, а не god-files. `TrainingOperationsPage`, `TrainingRankingPage`, `TrainingSearchPicker`, OpenAI providers, secure URL fetcher и FFmpeg service связны и не должны делиться только по LOC.

## Итог классификации

- доказанно неиспользуемые symbol/surface entries: **21**;
- zero-consumer CSS selectors: **21**, считаются отдельно;
- полностью dead production files: **0**;
- полностью dead Prisma models: **0**;
- duplication families: **16**;
- god-files: **12**;
- import cycles: **0 статических relative-import cycles**.

Удаление разрешается только Stage 2 после зелёного Stage 1 и команды `REFACTOR_APPROVED`.
