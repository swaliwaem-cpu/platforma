# 08. Дальнейшее снижение стоимости генерации вопросов

Статус: предложение к реализации
Приоритет: P1/P2
Область: context budget, artifact reuse, Luna/Terra routing

## Текущее состояние

Уже реализованы compact evidence IDs, дедупликация, coverage-safe selection, source hashing и portable cross-project artifacts. Однако production использует потолок 30 000 символов, cross-project reuse выключен, а модельная стратегия — `terra_only`.

Текущий budget policy выбирает `min(uniqueChars, configuredMaximum, hardCeiling)`. Он ограничивает объём, но не выбирает меньший бюджет по сложности источников.

Основные участки:

- `training-question-context-budget.ts`;
- `training-material-suggester.ts`;
- `training-project-knowledge.service.ts`;
- `training-question-generation-artifact.ts`;
- `training-question-generation-router.ts`.

## Порядок улучшений

### 1. Exact cross-project reuse

Пилотно включить reuse только для одного и того же Platforma object при полном совпадении source fingerprint, compiler/prompt/validator versions, routing, model и budget. Переносить можно только нейтральные question drafts; provenance и criteria необходимо материализовать заново для текущего проекта.

### 2. Настоящий adaptive budget

Ввести ограниченный набор уровней, например 12k/18k/24k/30k. Выбор должен учитывать число источников, объём уникальных фрагментов, числовые факты и возможность сохранить source coverage. Точные уровни утверждаются после небольшого benchmark.

### 3. Luna → Terra routing

Включать только после измерения:

- Luna acceptance rate;
- local validation failure rate;
- blended tokens/cost;
- quality относительно Terra baseline.

Fallback после невалидного Luna-ответа означает оплату обоих вызовов, поэтому низкая цена одного Luna request сама по себе не доказывает экономию.

## Границы

- Не переиспользовать compiled knowledge целиком между проектами.
- Не переносить sourceRevisionId или criteria первого проекта.
- Не снижать production budget без quality gate.
- Не запускать платные A/B автоматически в обычных тестах.

## Критерии приёмки

- Cache hit полностью исключает provider generation call.
- Изменение любого входного контракта инвалидирует artifact.
- Каждый generated fact восстанавливает canonical provenance текущего проекта.
- Adaptive tier сохраняет установленный минимум source coverage.
- В отчёте отдельно показаны savings, fallback overhead и validation failures.
- Production rollout выполняется последовательно: reuse, budget, затем routing.
