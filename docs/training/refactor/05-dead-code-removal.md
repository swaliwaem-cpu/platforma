# Модуль обучения: characterization и удаление dead code

Дата выполнения: 2026-08-01.

Статус: `DEAD_CODE_STAGE_COMPLETE`. Выполнены только Stage 1 и Stage 2 из утверждённого плана. Дублирование, god-files, запросы, архитектура, Prisma, routes, DTO и production не изменялись.

## Исходный delete manifest

Manifest повторно проверен четырьмя read-only аудитами: backend usage, frontend/CSS consumers, dynamic registration и characterization coverage. `PROVEN_SAFE_TO_DELETE` присваивался только после проверки import graph, Nest wiring/DI, routes, jobs, Prisma, scripts, tests, string/dynamic references и runtime-generated CSS classes.

| Файл | Символ/selector | Статус | Доказательство | Нужен test до удаления |
|---|---|---|---|---|
| `training-openai-evaluation.provider.ts` | import `TrainingEvaluationCriterionInput` | `PROVEN_SAFE_TO_DELETE` | TS6133; точных consumers нет | API build/unit |
| `training-content.service.ts` | private `parseJsonArray()` | `PROVEN_SAFE_TO_DELETE` | TS6133; только definition | content/API unit |
| `training-fact-suggestion.provider.ts` | `normalizeTrainingFactSuggestionSnapshot()` | `PROVEN_SAFE_TO_DELETE` | только definition; provider factory не ссылается | fact/OpenAI unit |
| `training.domain.ts` | `TrainingAttemptStartSnapshot`, `TrainingSelectedQuestion`, `TrainingPrivateVoiceObject` | `PROVEN_SAFE_TO_DELETE` | каждый type встречался только в declaration | API build/contracts |
| `training.repository.types.ts` | `TrainingProjectRepositoryRecord`, `TrainingAttemptRepositoryRecord`, `TrainingJobClaimRecord` | `PROVEN_SAFE_TO_DELETE` | aliases без consumers; include/select constants сохранены | API build/contracts |
| `training-fact-suggestions.service.ts` | `listRuns()` | `PROVEN_SAFE_TO_DELETE` | нет controller, job, test или dynamic caller | fact/API unit и DB |
| `training-fact-suggestions.service.ts` | `dismissRun()` | `PROVEN_SAFE_TO_DELETE` | route отсутствует; нет caller или string registration | fact/API unit и DB |
| `training-fact-suggestions.service.ts` | `retryRun()` | `PROVEN_SAFE_TO_DELETE` | route/caller отсутствуют; не является worker retry | fact/API unit и DB |
| `training-official-url-sources.service.ts` | `getSnapshot()` | `PROVEN_SAFE_TO_DELETE` | controller имеет list/create/text/retry/delete, но не snapshot route; иных callers нет | URL/API unit и DB |
| `training.module.ts` | exports `TrainingAttemptEngineService`, `TrainingPolicyService`, `TrainingTelegramLinkService`, `TrainingTelegramWorkerService`, `FakeTrainingTelegramTransport` | `PROVEN_SAFE_TO_DELETE` | вне `TrainingModule` нужен только `TrainingConfigService`; providers сохранены | новый runtime Nest consumer test |
| `trainingReviewSubmission.mjs` / `.d.mts` | `TRAINING_REVIEW_SUBMISSION_STATES` | `PROVEN_SAFE_TO_DELETE` | runtime и type export без imports | web unit/build |
| `trainingReviewSubmission.mjs` / `.d.mts` | getter `TrainingReviewSubmission.state` | `PROVEN_SAFE_TO_DELETE` | внешний getter не читается; внутренний `#state` используется и сохранён | web review/browser |
| `TrainingShellPage.tsx` / `App.tsx` | prop `TrainingShellPageProps.mode` и `mode="employee"` | `PROVEN_SAFE_TO_DELETE` | prop не деструктурировался и не влиял на render; caller один | новый browser RBAC test |
| `trainingAdmin.css` | `.training-editor-tabs`, `.training-card-list`, `.training-criterion-summary` | `PROVEN_SAFE_TO_DELETE` | нет JSX/TSX, template/conditional/dynamic consumer; grouped rules проверены по отдельности | desktop/mobile DOM и golden screenshots |
| `trainingResults.css` | `.training-detail-summary--admin`, `.training-detail-summary-final`, `.training-attempt-summary`, `.training-admin-question-list`, `.training-timeline`, `.training-answer-meta`, `.training-answer-section`, `.training-answer-section-heading`, `.training-transcript`, `.training-component-list`, `.training-component`, `.training-component--warning`, `.training-provider-details`, `.training-provider-run-list`, `.training-segment-list`, `.training-evaluation-history`, `.training-job-list`, `.training-safe-json` | `PROVEN_SAFE_TO_DELETE` | нет обычного или runtime-generated consumer; live siblings в grouped rules сохранены | desktop/mobile DOM и golden screenshots |

При удалении `retryRun()` его закрытая dependency-цепочка `RETRYABLE_RUN_STATUSES` и `parseSourceSnapshots()` стала definition-only. Повторный точный поиск подтвердил отсутствие других consumers, поэтому они удалены в том же backend batch как доказанное следствие manifest entry.

## Добавленные characterization tests

- `apps/api/tests/training-module-boundary.test.cjs`: настоящий Nest scan/injection доказывает, что внешний module consumer продолжает получать retained `TrainingConfigService` через `TrainingModule`.
- `apps/web/tests-browser/training-results.spec.ts`: отрицательный `/training` RBAC-сценарий доказывает `training:take` boundary и отсутствие employee data requests без permission.
- `apps/web/tests-browser/training-admin-editor.spec.ts`: desktop/mobile DOM-отсутствие трёх legacy selectors и два golden screenshots.
- `apps/web/tests-browser/training-results.spec.ts`: desktop/mobile DOM-отсутствие 18 legacy selectors и два golden screenshots.
- Browser mock дополнен уже существующим `GET /training/admin/projects/:id/assignments`, чтобы harness соответствовал текущему API страницы; production behavior не менялся.
- Бриттл source assertions для `mode="employee"` и произвольного `overflow-x: auto` удалены только после появления runtime RBAC и desktop/mobile overflow/screenshot coverage. Behavioral assertions не ослаблялись.

До первого production deletion новые targeted characterization проверки прошли `1/1` API и `5/5` browser; затем были повторены после соответствующих batches и в полном suite.

## Удалённый backend

Удалены все 18 backend symbol/surface entries исходного manifest и их две доказанно эксклюзивные зависимости:

- один unused import;
- два definition-only helpers;
- три domain types и три repository aliases;
- `listRuns()`, `dismissRun()`, `retryRun()`, `getSnapshot()`;
- пять лишних Nest exports при сохранении всех providers и `TrainingConfigService` export;
- dependency-only `RETRYABLE_RUN_STATUSES` и `parseSourceSnapshots()`.

LOC: 281 удалённая production-строка, 1 добавленная строка при сжатии `exports`; net `-280`.

## Удалённый frontend

Удалены `TRAINING_REVIEW_SUBMISSION_STATES`, публичный getter `state` и неиспользуемый `TrainingShellPageProps.mode` вместе с caller prop. Внутренний `#state`, route и permission guard сохранены.

LOC: 21 удалённая production-строка, 1 изменённая caller-строка; net `-20`.

## Удалённый CSS

Удалён 21 selector: 3 из `trainingAdmin.css` и 18 из `trainingResults.css`. В selector groups сохранены live siblings `.training-ranking-narrative`, `.training-question-breakdown`, `.training-review-history`, `.training-unsupported-review`, `.training-transcript-card` и `.training-transcript-readable`.

LOC: 284 удалённые CSS-строки и 4 строки для сохранения live grouped rules; net `-280`. Итоговый `trainingResults.css` bundle уменьшился с 36.31 kB до 32.35 kB; общий CSS — примерно с 335.85 kB до 334.79 kB.

Суммарно production surface: 586 удалённых строк, 6 добавленных/перезаписанных строк, net `-580`.

## KEEP и UNCERTAIN

Среди повторно проверенных `PROVEN_UNUSED` entries нет `KEEP` или `UNCERTAIN`: все прошли четыре независимых safety-проверки. При этом ни одна запись раздела `Кандидаты: не удалять автоматически` из `01-dead-code-candidates.md` не повышалась до delete manifest и не удалялась. Сохранены, в частности:

- `TrainingJobKind.ANALYZE_ACOUSTICS`, legacy `openai-evaluation-v1` и operations route alias;
- `revokeLinkTokens()`, `finalizeAttempt()`, `refundTechnicalFailure()` и `visibleEmployeeScore()`;
- immutable/score/shared contract constants и repository include/select constants;
- dual `TrainingDocumentWorkerService` ownership, provider factories, fake providers и public shared contracts;
- eager page imports, discarded ranking refresh и full-history/query surfaces.

## Неизменённые публичные контракты

- Prisma schema/migrations/enums, routes/status/body, DTO и permissions не менялись.
- Telegram commands/callbacks/outbox, job kinds/payload/idempotency и OpenAI schemas/models не менялись.
- Scoring, penalty, random question selection, timeout/grace, review/ranking/policy behavior не менялись.
- Nest providers и process topology сохранены; уменьшена только внешняя export surface, а retained config export доказан runtime test.
- Manual React routing, URL/history и видимое UI-поведение сохранены; четыре golden screenshots совпали после CSS batch.

## Финальные проверки

| Gate | Результат |
|---|---|
| `pnpm --filter @platforma/api test` | PASS; unit 538/538, PostgreSQL 111/111, temporary DB dropped |
| PostgreSQL repeat 1 | PASS 111/111; `platforma_training_test_ms9gd6dn_8ddaa9fd68f4` dropped |
| PostgreSQL repeat 2 | PASS 111/111; `platforma_training_test_ms9gedoz_cd0a5f0e77f6` dropped |
| `pnpm --filter @platforma/web test` | PASS 312/312 |
| `pnpm build` | PASS; известный Vite warning для main chunk 790.86 kB |
| `pnpm test` | PASS; PostgreSQL 111/111, temporary DB dropped |
| `pnpm --filter @platforma/web test:training:browser` | PASS 24/24; fake/local API only |
| Prisma validate | PASS; schema valid |
| `git diff --check` | PASS |
| `.only/.skip`, удалённые tests, `output/` diff | отсутствуют |

## Остаточные риски и граница остановки

- Playwright dev-server продолжает печатать существующий до этой работы React warning `Maximum update depth exceeded` в editor-сценариях; suite проходит, а функциональное исправление явно вне Stage 1–2.
- Vite сохраняет известный warning о chunk больше 500 kB; bundle optimization не выполнялась.
- Реальные Telegram/OpenAI, production/SSH и deployment не запускались.
- Stage 3–8 не начинались. Следующий этап требует отдельной команды.
