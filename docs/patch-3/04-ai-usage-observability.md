# 04. Долговечная аналитика AI-расходов

Статус: реализовано локально; migration не развёрнута
Приоритет: P1
Область: токены, стоимость, latency, аномалии

## Проблема

API уже извлекает input, cached, cache-write, output, reasoning и total tokens, но сохраняет их только в structured logs. После пересоздания контейнера история недоступна, поэтому невозможно надёжно сравнивать проекты, модели, retries и версии промптов.

Основной участок: `apps/api/src/training/training-openai-usage.ts`.

## Целевое решение

Сохранять безопасную телеметрию каждого provider attempt либо атомарные агрегаты. Предпочтительно отделить telemetry от доменных таблиц, чтобы не раздувать `TrainingAnswer` и knowledge records.

Минимальные поля:

- operation и model;
- prompt/compiler/schema version;
- projectId, attemptId и questionId как nullable внутренние ссылки;
- input/cached/cache-write/output/reasoning/total tokens;
- latency и outcome;
- ordinal attempt и safe error code;
- responseId для корреляции;
- createdAt.

Не сохранять prompt, transcript, source excerpt, audio, provider body, API key или raw error.

## Отчёты и guardrails

- Расход по дням, операциям, моделям и проектам.
- Cached-token ratio.
- Retry overhead.
- p50/p95 latency и error rate.
- Estimated cost по версионируемой таблице цен.
- Предупреждение при резком росте расхода.
- Мягкий дневной/месячный бюджет с fail-open или fail-closed режимом, утверждённым отдельно.

## Границы

- Не помещать цены непосредственно в исторические provider rows без версии.
- Не блокировать действующую аттестацию из-за сбоя записи telemetry.
- Не показывать сотруднику внутренние расходы или provider metadata.

## Критерии приёмки

- После restart история метрик сохраняется.
- Один provider attempt создаёт не более одной telemetry-записи.
- Можно посчитать расход одной генерации проекта и одной полной попытки.
- Отдельно виден расход retries и fallback.
- В логах и API отсутствуют чувствительные данные.

## Проверки

Использовать fake/stub usage payloads. Реальные платные вызовы не входят в обязательные автотесты и запускаются только отдельной командой.

## Результат реализации

- Добавлена отдельная таблица `training_ai_usage_events` с дедупликацией по logical run и ordinal provider attempt.
- Записываются успешные ответы, provider errors, transport errors и локальные validation failures для transcription, evaluation, material suggestions и question generation.
- Telemetry write работает fail-open и не содержит prompt, transcript, source excerpt, audio, provider body или raw error.
- `GET /training/admin/ai-usage` под permission `training:results:read` возвращает totals, daily breakdown, разрезы по operation/model/project, recent runs, cache ratio, retry/fallback overhead, p50/p95, error rate, estimated cost и предупреждения о token spike.
- Стоимость рассчитывается по immutable pricing snapshot; в исторической строке сохраняются version, status и estimate. Неизвестная модель или неполный usage остаются явно unpriced.
- Фильтры `projectId`, `attemptId` и `operationRunId` позволяют посчитать отдельную попытку аттестации или один logical AI run.

Не реализован блокирующий дневной/месячный budget: выбор лимитов и режима fail-open/fail-closed по-прежнему требует отдельного утверждения.
