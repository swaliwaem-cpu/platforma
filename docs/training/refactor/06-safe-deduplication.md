# Модуль обучения: Stage 3 safe deduplication

Статус на 2026-08-01: `SAFE_DEDUPLICATION_COMPLETE`. Выполнен только Stage 3 утверждённого плана. Stage 4–8 не начинались.

## Граница работы

Исходная точка — commit `962298e` и tag `training-refactor-dead-code-complete`, где Stage 1–2 уже имели полностью зелёный baseline. В Stage 3 разрешена только консолидация exact/pure duplication после characterization. Не выполнялись split god-files, перенос ownership, изменение React state/effects, SQL/query optimization, functional bugfix, schema/migration, новая dependency, real provider call или production deploy.

Перед изменениями пять независимых read-only проверок классифицировали кандидатов по backend, frontend, cross-layer semantics, dynamic DI и regression coverage. В production код перенесены только группы, для которых совпадение поведения было доказано.

## Consolidation manifest

| ID | Классификация | Исходные копии | Каноническая реализация | Сохранённый контракт |
|---|---|---|---|---|
| W1 | exact duplication | четыре worker-local `waitForPromise` | `training-worker-shutdown.ts` | `Promise.race`, boolean result, rejection propagation, timeout и `unref()` |
| B1 | equivalent pure validation | UUID predicates в десяти consumers | `training-uuid.ts` | default UUID v1–5; document worker явно использует прежний диапазон v1–8; caller-specific errors/null adapters сохранены |
| B2 | exact duplication | canonical JSON/SHA-256 в fact-suggestion service и worker | `training-fact-suggestion-canonical-json.ts` | recursive key ordering через `localeCompare`, array order, `JSON.stringify`, UTF-8 SHA-256 и прежние exception semantics |
| F1 | exact duplication | четыре frontend `readError` | `trainingViewModel.mjs` | строка `Error.message` либо прежний fallback |
| F2 | exact duplication | два frontend `formatPoints` | `trainingViewModel.mjs` | integer/fraction formatting и прежняя обработка non-finite values |
| F3 | equivalent pure serialization | results helper и три admin query builders | `trainingQueryString.mjs` | insertion order, `URLSearchParams` encoding, omission только `undefined`/`''`, coercion через `String`, отсутствие пустого `?`; caller defaults/truthiness сохранены |

Consumers используют aliases там, где это удерживает прежние локальные имена и делает diff минимальным. Новые helpers не экспортированы через Nest module, shared package или новый public barrel.

## Intentional duplication kept

- Telegram compact callback UUID остаётся отдельным 32-hex wire-format validator; его объединение с dashed UUID изменило бы transport contract.
- UUID callers сохраняют собственные exception messages, nullable adapters и field context.
- Worker lifecycle, ownership, claim/release, retry и shutdown sequencing не объединялись; вынесена только pure wait primitive.
- Audit/IP normalization, Serializable retry, provider error parsing/schemas, environment parsing и Prisma error handling остались у своих security/transaction domains.
- FNV review hash, provider/domain hashes и другие hash primitives не связаны с canonical fact-suggestion SHA-256.
- Frontend API methods сохраняют свои defaults: projects `1/50`, objects и assignees `1/20`; `hasPdf=false` и `null` не отбрасываются.

## Uncertain or merely similar duplication kept

- date, duration, status labels и loading predicates;
- path and type guards с различающимися input domains;
- allowed-field checks и provider response/error readers;
- React polling, request ownership, navigation, mounted panels, review/audio lifecycle;
- похожие SQL/select/serialization blocks и employee/admin presenters.

Эти группы не доказаны как exact behavior-equivalent либо относятся к Stage 4–7. Они оставлены без изменений.

## Characterization before switch

Сначала были добавлены и запущены tests против новых pure helpers, пока production consumers продолжали использовать старые локальные реализации:

- `training-pure-deduplication.test.cjs`: timeout result, successful wait, `unref()`, rejection propagation, UUID v1–5/v1–8 matrix и canonical JSON/hash edge cases — 4/4;
- `training-query-string.test.mjs`: exact omission/coercion/encoding/order для `undefined`, empty string, `null`, `false`, `0`, arrays, Cyrillic, NBSP и reserved characters; exact endpoint defaults — 2/2;
- `training-results.test.mjs`: единый error/points view-model — 1 новый test.

Первый characterization run обнаружил, что circular canonical JSON наследует legacy `RangeError`, а не `TypeError`; expectation исправлен до подключения consumers. После этого helper gate был зелёным. Production wiring выполнен только затем.

Два source-contract assertions для admin query builders переведены с требования локального `URLSearchParams` на требование канонического serializer и точных caller defaults. Тесты не удалялись, `.only`/`.skip` не добавлялись.

## Production LOC

Подсчёт относится только к production source diff относительно `962298e`; tests и docs исключены:

- backend: удалено 128, добавлено 84, net `-44`;
- frontend: удалено 60, добавлено 56, net `-4`;
- всего: удалено 188, добавлено 140, net `-48`.

## Public contracts

Не изменены Prisma schema/migrations, HTTP methods/routes/status/body, shared DTO, permissions/guards, Nest exports/tokens, job kinds/payloads, Telegram callbacks/messages, OpenAI/provider shapes, scoring, retry/transaction/lock order, environment keys/defaults и Compose topology. Новых dependencies нет.

React state, effects, dependency arrays, routing, polling, request ownership, Blob lifecycle и rendered structure не менялись. Browser goldens остались без diff.

## Final checks

| Gate | Результат |
|---|---|
| API | `pnpm --filter @platforma/api test` — pass; unit 542/542, PostgreSQL 111/111 |
| PostgreSQL repeat 1 | 111/111; clean temporary DB удалена |
| PostgreSQL repeat 2 | 111/111; clean temporary DB удалена |
| Web | `pnpm --filter @platforma/web test` — 315/315 |
| Build | `pnpm build` — pass; известный Vite chunk warning, main chunk 787.75 kB |
| Root | `pnpm test` — pass; PostgreSQL 111/111, temporary DB удалена |
| Browser | training Playwright 24/24; desktop/mobile goldens без изменений |
| Prisma | schema valid; clean DB runs применили все 43 migrations |
| Diff | `git diff --check` pass; `.only`/`.skip` и удаления tests отсутствуют |

Известный React dev warning `Maximum update depth exceeded` в editor browser harness воспроизводится как на baseline и не исправлялся вне scope. Real Telegram/OpenAI, fake full-chain, Docker audio и production не запускались: затронутые Stage 3 helpers не меняют эти integration/provider/audio contracts, а внешнего GO не было.

## Stop condition

Stage 3 завершён на pure/exact consolidation. Следующее допустимое действие — отдельное review/commit Stage 3 либо новая явная команда на Stage 4. Backend god-file decomposition и любой последующий этап не начаты.
