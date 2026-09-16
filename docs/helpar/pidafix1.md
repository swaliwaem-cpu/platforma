# PIDAFIX1: Безопасный локальный OpenAI canary

**What to build:** подготовить воспроизводимый planner-only smoke реального OpenAI
на локальной disposable-среде, где количество пользовательских запросов, model
attempts и стоимость ограничены до первого HTTP-вызова и затем сверяются с
persisted ledger; отдельно закрыть возможность случайного live-вызова embeddings.

**Blocked by:** [FIX-TOKEN](./fix-token.md) и этапы 1–7
[FIX-TK1](./fix-tk1.md).

**Status:** ready-for-agent

## Границы

- [ ] Ticket не подключается к production, не использует production DB, SSH,
  deploy или production credentials.
- [ ] Обычные тесты используют только fake/stub providers и disposable PostgreSQL.
- [ ] Реальный smoke не запускается во время реализации ticket. Для него нужна
  отдельная команда пользователя с подтверждённым лимитом расходов.
- [ ] Первый canary проверяет только Query Planner. Embeddings остаются
  `fake` или `disabled`; Geo Provider, Overpass, external connectors и source worker
  выключены.
- [ ] Наличие `OPENAI_API_KEY` само по себе не разрешает ни одного вызова.
- [ ] Логи, отчёты и fixtures не содержат ключ, access token, prompt, raw provider
  payload, найденный контент или URL credentials.

## Этап 1 — RED-контракты локального smoke

- [ ] Добавить behavioral tests для нового CLI
  `apps/api/scripts/assistant-local-paid-smoke.cjs`.
- [ ] По умолчанию CLI является dry-run и делает ноль HTTP/provider calls.
- [ ] Live разрешён только при одновременных:
  `--live --limit 2 --max-attempts 4 --max-cost-usd 0.50`,
  `ASSISTANT_AI_MODE=openai`, `ASSISTANT_QUERY_PLANNER_LIVE=true` и
  `ASSISTANT_PAID_CALLS_CONFIRMED=true`.
- [ ] Отсутствующий или больший hard limit, remote API/DB, production mode,
  незавершённый ledger либо `PENDING/RUNNING` backlog блокируют запуск до HTTP.
- [ ] `ASSISTANT_MODEL_REQUESTS_PER_DAY=2` ограничивает canary двумя Luna-started
  пользовательскими запросами; суммарно допускается не более четырёх attempts.
- [ ] Третий запрос, пятая попытка и резерв сверх `$0.50` отклоняются до provider.

## Этап 2 — Fail-closed readiness и CLI

- [ ] Вынести общий read-only readiness contract, используемый CLI и rollout
  preflight, без дублирования разных правил.
- [ ] Для OpenAI mode readiness требует RPM, requests/day,
  `ASSISTANT_MODEL_DAILY_BUDGET_USD`, live-флаг, paid confirmation и наличие ключа.
  Проверяется только наличие секрета, значение не печатается.
- [ ] CLI работает только с loopback API и явно локальной/disposable DB;
  remote override в этом ticket не добавляется.
- [ ] CLI запускается внутри того же API container/image и с тем же effective env,
  что и проверяемый API. Readiness подтверждает effective requests/day `= 2`,
  RPM `<= 2`, USD budget `<= --max-cost-usd`, live/paid flags и local DB; host-side
  аргументы без проверки runtime config не считаются hard cap.
- [ ] До запуска CLI подтверждает отсутствие старых `PENDING/RUNNING` runs, чтобы
  processor не подобрал до двадцати чужих локальных задач вместе с canary.
- [ ] Access token передаётся только через временную env/FD, никогда через argv.
  Запросы идут последовательно; второй не стартует до settlement первого. Polling,
  response body и общее время ограничены, после первой ошибки новые запросы не идут,
  cleanup выполняется в `finally`.
- [ ] Smoke создаёт ровно два пользовательских запроса: простой structured search
  и сложный mortgage/installment query. Web Search для Query Planner остаётся
  запрещённым.
- [ ] После завершения CLI читает все attempts по двум точным
  `operationRunId = AssistantRun.id` через все executions и проверяет:
  `attempts <= 4`, effective cost `<= $0.50`, `webSearchCalls = 0`.
- [ ] Effective cost считается один раз на attempt: для settled — `chargedCostUsd`,
  для любого unsettled/unknown — полный `reservedCostUsd`. `charged + reserved`
  одного settled attempt не складываются повторно.
- [ ] Оставшийся `RESERVED` после bounded wait делает verdict красным, но всё равно
  входит в стоимость полным резервом. Недоступный ledger даёт ошибку, а не `$0`.

## Этап 3 — Безопасная граница embeddings

- [ ] `ASSISTANT_EMBEDDING_MODE=openai` требует отдельный
  `ASSISTANT_EMBEDDING_LIVE=true`, paid confirmation и поддерживаемую пару
  model/dimensions; первый planner canary всё равно отклоняет этот режим.
- [ ] Перед каждым embeddings HTTP-вызовом создаётся persisted reservation/attempt;
  unsupported model или отсутствующая цена блокируются до HTTP.
- [ ] Retrieval передаёт `AssistantRun.id` как `operationRunId` и lease execution ID;
  ingestion использует `jobId` и lease execution ID; benchmark создаёт собственные
  run/execution UUID. `attemptOrdinal` монотонно растёт для каждого batch/retry.
- [ ] Settlement учитывает фактическое число input tokens либо консервативный резерв,
  если provider не вернул usage или результат неизвестен после timeout/crash.
- [ ] `assistant-embedding-benchmark.cjs` становится dry-run по умолчанию. Live
  benchmark требует явных `--live`, `--max-http-attempts` и `--max-cost-usd`;
  лимит относится именно к физическим HTTP attempts, а не к candidates/batches,
  и формирует безопасный ledger-based cost report.
- [ ] До завершения этого этапа любой local canary fail-closed отклоняет OpenAI
  embeddings вместо молчаливого платного вызова.

## Этап 4 — Проверки

- [ ] Targeted RED → GREEN:
  `assistant-fix-token.test.cjs`, `assistant-t07-domain.test.cjs`, T03 embedding
  gateway/benchmark tests и тест нового smoke CLI.
- [ ] PostgreSQL tests доказывают atomic reservation, общий USD ceiling,
  settlement/reconciliation и отсутствие provider call при конфликте бюджета.
- [ ] На disposable DB выполнить полный migration replay и `prisma migrate status`.
- [ ] Запустить `pnpm --filter @platforma/api test`, `pnpm test`, `pnpm build`,
  `docker compose config --quiet` и `git diff --check`.
- [ ] Проверить отсутствие `.only`, `.skip`, новых зависимостей, секретов,
  случайных lockfile/generated изменений и незачищенных Docker resources.
- [ ] Source-discovery CLI не переписывать: сохранить его существующие dry-run,
  checkpoint, default limit и ledger-based cost report.

## Definition of Done

- [ ] Без полного набора live-разрешений все OpenAI boundaries делают ноль HTTP calls.
- [ ] Planner smoke физически не может превысить 2 user requests, 4 attempts и `$0.50`.
- [ ] Каждый оплачиваемый planner/embedding attempt резервируется до HTTP и попадает
  в итоговый отчёт даже при timeout, crash или отсутствующей usage telemetry.
- [ ] Первый canary принудительно изолирован от embeddings, geo и background workers.
- [ ] Все автоматические gates зелёные; реальные OpenAI-вызовы остаются отдельным
  явно разрешаемым шагом из [PIDAFIX3](./pidafix3.md).
