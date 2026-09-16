# FIX-TK1: Доведение FIX-TOKEN до fail-closed состояния

**What to build:** исправить найденные при review расхождения в учёте расходов и source discovery, чтобы восстановление после сбоя не блокировало `AssistantRun`, платные попытки не терялись из ledger и отчёта, а Terra запускалась только в разрешённых исходной спецификацией случаях.

**Status:** ready-for-agent

**Основание:** этот план применяется поверх [FIX-TOKEN](./fix-token.md) и не ослабляет его требования. Исходный review scope — `c22d840...HEAD`.

## Правила выполнения

- [ ] Реализация идёт последовательно по этапам ниже; каждый этап начинается с RED-теста, затем GREEN и локальный REFACTOR.
- [ ] Одновременно работают не более четырёх read-only субагентов; общий worktree изменяет только главный агент.
- [ ] Реальные OpenAI-вызовы, production DB, SSH, deploy и платный canary не выполняются.
- [ ] Все provider tests используют локальный stub, а PostgreSQL/concurrency tests — одноразовую изолированную БД.
- [ ] Новые зависимости не добавляются. Для domain validation используется fail-closed exact-host policy; переход на Public Suffix List требует отдельного согласования зависимости.
- [ ] Существующая migration `20260827170000_add_assistant_ai_cost_controls` не редактируется. Любое изменение схемы оформляется новой forward-only migration с безопасным backfill.
- [ ] Публичные HTTP routes, Training, geo, frontend и production-конфигурация остаются вне scope.

## Неподвижные инварианты

- [ ] Наличие `OPENAI_API_KEY` не разрешает вызов. Нужны одновременно OpenAI-режим, явный live-флаг соответствующей операции и `ASSISTANT_PAID_CALLS_CONFIRMED=true`.
- [ ] Один provider call имеет ровно одну persisted attempt-запись до отправки HTTP-запроса.
- [ ] Неизвестная стоимость после timeout, network failure или crash списывается консервативно как полный резерв и никогда не превращается в `$0`.
- [ ] Сумма `reserved_cost_usd + settled_cost_usd` не превышает дневной provider budget до начала вызова.
- [ ] Повторный settlement идемпотентен; повторное исполнение worker lease не упирается в старый unique key.
- [ ] Registry, checkpoint, официальный каталог и известные URL проверяются до Web Search.
- [ ] Timeout, network error, 429, 5xx, malformed output, budget error и settlement error никогда не переключают Luna на Terra.
- [ ] Terra разрешена один раз только после успешного распарсенного Luna-ответа, отклонённого локальной identity/evidence validation, либо при независимом детерминированном доказательстве существования проекта.
- [ ] Каждый retry и fallback учитывается в лимитах: до 3 provider calls на проект, до 35 calls и до 2 Terra calls на пакет.

## Этап 1 — Зафиксировать регрессии тестами

- [x] В `assistant-fix-token.test.cjs` сначала добавить RED-кейсы для:
  - corrupted checkpoint, `EACCES` и fingerprint mismatch;
  - dry-run upper estimate, рассчитанного из выбранных проектов, моделей и call limits, а не скопированного из `--max-cost-usd`;
  - отчёта с успешной ранней фазой и ошибкой поздней фазы;
  - полного учёта failed provider attempt с неизвестной usage telemetry;
  - отсутствия Terra fallback после parse, timeout, network, 429, 5xx и source-fetch failure.
- [x] В `assistant-t03-discovery.test.cjs` добавить RED-кейсы для deterministic-first порядка, registry reuse, exact-host trust boundary и допустимого fallback после локального identity/evidence rejection.
- [x] В `assistant-fix-token-postgres.cjs` добавить настоящий PostgreSQL-сценарий: expired worker lease, незавершённый `RESERVED` attempt, повторное исполнение того же `AssistantRun`, reconciliation и успешное создание новой попытки без unique conflict.
- [x] Отдельно доказать race: несколько planner/discovery reservations одного provider/day не превышают общий USD budget, а reconciliation и settlement не списывают одну попытку дважды.
- [x] Сохранить RED-output конкретных targeted-команд; не ослаблять существующие assertions и не использовать `.only`/`.skip`.

## Этап 2 — Восстановление attempt ledger и settlement

- [x] Ввести отдельную identity исполнения: `operationRunId` остаётся ID логической операции, а `executionId` создаётся один раз на worker lease/CLI execution; ordinal обозначает фазу внутри исполнения.
- [x] Новой migration добавить `execution_id` и срок жизни резерва, безопасно backfill существующие строки и заменить старую uniqueness на `(operation_run_id, execution_id, attempt_ordinal)`. Старую migration не менять.
- [x] Повторный `reserve()` с тем же execution/ordinal должен идемпотентно вернуть ту же reservation при совпадающих параметрах; несовпадающие параметры завершаются fail-closed conflict.
- [x] Перед повторным запуском lease атомарно reconcile истёкшие `RESERVED` attempts этого run:
  - снять их из `reserved_cost_usd`;
  - начислить полный `reserved_cost_usd` в `settled_cost_usd`;
  - сохранить `outcome=UNKNOWN_AFTER_CRASH`, безопасный error code и время reconciliation;
  - после этого разрешить новое execution с новым `executionId`.
- [x] Reconciliation использует явный reservation expiry, превышающий provider timeout и settlement grace; активный HTTP-вызов не должен быть принят за stale.
- [x] `settle()` блокирует attempt и daily row в одном стабильном lock order, проверяет количество обновлённых строк и остаётся идемпотентным.
- [x] Ошибка settlement больше не проглатывается в `recordUsage()`: выполняется bounded DB retry, затем операция завершается явной telemetry/budget ошибкой, а резерв остаётся консервативно удержанным до reconciliation.
- [x] Не обещать exactly-once внешнему provider. После crash повторный вызов допустим только как новое execution, а возможный неизвестный предыдущий расход уже полностью учтён.
- [x] Верхняя reservation рассчитывается консервативно для максимальных input/cache-write/output tokens и Web Search calls; provider request фиксирует тарифицируемый service tier. Неподдерживаемая модель или tier блокируются до HTTP.

## Этап 3 — Deterministic-first discovery и граница доверия

- [x] До создания model request собрать deterministic seed:
  1. активный project-level source из registry;
  2. project checkpoint текущего fingerprint;
  3. активные developer-level sources и их явные allowed hosts;
  4. официальный developer catalog;
  5. bounded known project paths внутри доказанного host allowlist.
- [x] Существующий проверенный project source завершает поиск без provider call; developer source переиспользуется для catalog/known-path поиска и не открывается заново через Web Search.
- [x] `findDeveloperCatalogEvidence()` и `findProjectByKnownPaths()` выполняются до первого project model call, когда есть доказанный developer host. После модели они могут проверять только новую кандидатуру, но не заменять пропущенный preflight.
- [x] Удалить ручное сворачивание hostname до псевдо-registrable domain. `x.example.co.jp` не должен давать доверие к `co.jp` или `unrelated.co.jp`.
- [x] Без новой зависимости разрешать только exact host, нормализованный `www`-вариант и явно сохранённые catalog-derived hosts. Любой sibling domain требует доказанной ссылки с уже разрешённого официального сайта.
- [x] Redirect и final URL повторно проходят тот же allowlist; расширение trust perimeter из текста модели запрещено.
- [x] Проверить порядок вызовов stub-счётчиком: при registry/catalog/known-path hit количество OpenAI/Web Search calls равно нулю.

## Этап 4 — Явная retry/fallback state machine

Использовать одну функцию принятия решения, а не разрозненные `catch`-ветки:

| Результат Luna или локальной проверки | Same-model retry | Terra |
|---|---:|---:|
| timeout, network, 429, 5xx | не более одного Luna retry при наличии call/USD budget | никогда |
| malformed или отсутствующий structured output | нет | никогда |
| budget, authorization или settlement error | нет | никогда |
| source connector timeout/network/retryable HTTP | только собственный bounded connector retry | никогда |
| parsed candidate отклонён identity/evidence validation | нет | один раз |
| `NOT_FOUND` при независимом catalog evidence | нет | один раз |
| accepted candidate | нет | нет |

- [x] Каждый retry резервируется и отражается отдельной attempt-записью до HTTP.
- [x] Перед retry/fallback проверяются project, batch, Terra и USD limits; исчерпание возвращает конкретный stop reason без дополнительного вызова.
- [x] Terra проходит ту же локальную identity/evidence validation и не может расширить allowed hosts.
- [x] Ошибки `fetchOfficialSource()` сохраняют исходную классификацию и не попадают в общий безусловный fallback.
- [x] Contract tests фиксируют Luna/Terra model IDs, reasoning, `search_context_size: low`, `max_tool_calls: 1`, output limit и отсутствие Web Search у Query Planner.

## Этап 5 — Fail-closed checkpoint и повторный запуск

- [x] `readAssistantSourceDiscoveryCheckpoint()` возвращает различимые состояния `MISSING`, `VALID` и ошибку; только `ENOENT` создаёт пустой checkpoint.
- [x] Invalid JSON, permission/I/O error, неизвестная schema version, malformed entry и fingerprint mismatch завершают run до provider call.
- [x] Fingerprint mismatch разрешается только явным `--refresh`; старый файл перед заменой сохраняется как локальный ignored backup без prompt/raw payload/credentials.
- [x] Выбранный candidate set фиксируется до checkpoint filtering и не backfill-ится другими проектами. Повтор той же команды либо даёт checkpoint hits и ноль provider calls, либо требует явного `--refresh`.
- [x] `VERIFIED`, `NOT_FOUND` и `REJECTED` сохраняются атомарно через temporary file + rename; `ERROR` не маскируется как обработанный результат.
- [x] При ошибке записи checkpoint live-run завершается неуспешно и не сообщает, что повтор безопасен.
- [x] Тесты используют временный каталог и проверяют cleanup, permissions, fingerprint rotation, repeat и refresh без реального provider.

## Этап 6 — Полный cost/report contract

- [x] Live summary строится из persisted `assistant_ai_usage_attempts` данного run, а не только из `result.telemetry.phases`; in-memory telemetry остаётся детализацией результата, но не источником денежных итогов.
- [x] Каждый отчёт содержит: run ID, mode, stop reason, selected/checkpoint projects, Luna/Terra/fallback calls, фактические Web Search calls, input/cached/cache-write/output/reasoning/total tokens, reserved/estimated/charged USD и pricing catalog version.
- [x] Failed attempt без usage остаётся одним provider call и показывает консервативный charged reserve; `$0` допустим только для доказанного zero-call dry-run/checkpoint hit.
- [x] При ошибке поздней фазы отчёт сохраняет все предыдущие успешные фазы и саму неуспешную попытку.
- [x] Dry-run отдельно показывает:
  - `requestedCostCapUsd` — пользовательский hard cap;
  - `maximumEstimatedUsd` — вычисленную верхнюю стоимость допустимого Luna/Terra call mix;
  - возможную остановку до завершения пакета, если cap меньше верхней оценки.
- [x] Верхняя оценка учитывает project/batch/Terra limits, максимальный request size, output tokens, cache-write rate и Web Search calls по текущей версии catalog.
- [x] Отчёт не содержит prompt, найденный текст, raw provider response, API key, URL credentials или query/hash fragments.
- [x] Ошибка чтения ledger завершает формирование live-отчёта fail-closed вместо ложных нулей.

## Этап 7 — Углубление модулей и query hygiene

- [x] После зелёных behavioral tests оставить `AssistantSourceDiscoveryService` оркестратором developer/project flow, а provider transport, bounded retry, phase telemetry и reserve/settle собрать в самостоятельной provider boundary.
- [x] Call/USD/Terra counters и fallback matrix держать в `assistant-source-discovery-policy.ts`; identity и checkpoint остаются в своих предметных модулях.
- [x] Не создавать `utils.ts`, barrel-файлы и одноразовые wrappers. Разделение оправдывается самостоятельной ответственностью и независимыми тестами, а не числом строк.
- [x] Все Prisma reads в новых и затронутых тестах/services используют явный `select`.
- [x] Для индекса `(provider, usage_date, status)` найти реальный consumer reconciliation-query и подтвердить PostgreSQL query plan; при отсутствии consumer удалить индекс новой migration по отдельному разрешению пользователя.
- [x] Для индексов только по `usage_date` и `(operation, created_at)` найти реальный consumer и приложить query-plan; если consumer отсутствует, удалить их новой migration. Старую migration не переписывать.
- [x] После refactor повторно прогнать behavioral tests, чтобы перемещение кода не изменило публичные contracts и error codes.

## Этап 8 — Финальная проверка

- [ ] Targeted unit/domain:
  - `pnpm build:api`
  - `node apps/api/tests/assistant-fix-token.test.cjs`
  - `node apps/api/tests/assistant-t03-discovery.test.cjs`
  - `node apps/api/tests/assistant-t03-connector.test.cjs`
- [ ] PostgreSQL и migrations на одноразовой БД:
  - `pnpm test:assistant:fix-token:postgres`
  - `pnpm test:assistant:t03:postgres`
  - полный `prisma migrate deploy` и `prisma migrate status` с чистого состояния;
  - cleanup-аудит временной БД/network/volume.
- [ ] Browser runtime: `pnpm test:assistant:t03:browser` при запущенных локальных Docker-зависимостях; реальные provider modes принудительно выключены.
- [ ] Workspace gates:
  - `pnpm --filter @platforma/api test`
  - `pnpm test`
  - `pnpm build`
  - `docker compose config --quiet`
  - `git diff --check`
- [ ] Проверить отсутствие `.only`, `.skip`, секретов, raw payload fixtures и случайных изменений lockfile/generated output.
- [ ] Зафиксировать точные exit codes, длительность PostgreSQL/browser gates, состояние Docker-зависимостей и список не запущенных ручных/платных проверок.

## Definition of Done

- [ ] Закрыты все 8 Standards и 6 Spec findings исходного review.
- [ ] Recovery того же `AssistantRun` проходит после lease expiry, а неизвестный предыдущий расход учтён консервативно.
- [ ] Corrupted/inaccessible checkpoint и settlement failure блокируют дальнейшие платные вызовы.
- [ ] Deterministic hit выполняется до модели и даёт zero provider calls.
- [ ] Fallback matrix доказана тестами для каждой строки таблицы; transport/source-fetch errors не запускают Terra.
- [ ] Dry-run показывает вычисленную верхнюю стоимость, а live report не теряет ни одной оплачиваемой попытки.
- [ ] Domain trust не расширяется до public suffix или несвязанного sibling host.
- [ ] Migration replay, PostgreSQL race/recovery, targeted tests, API tests, browser runtime и builds зелёные.
- [ ] Реальные OpenAI-вызовы и production-действия не выполнялись. Платный canary из `fix-token.md` остаётся отдельным шагом только по новой команде пользователя.
