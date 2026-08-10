# 05. Эффективность и стабильность оценщика

Статус: предложение к реализации
Приоритет: P1
Область: evaluator latency, retries, output tokens

## Проблема

Production-выборка показала заметное число повторных evaluator-вызовов и тяжёлый latency tail. Текущая structured schema допускает большие пояснения для каждого факта и критерия, общий summary до 1000 символов и до 20 unsupported claims. Одинаковый полный запрос может повторяться после локальной validation error.

Затрагиваемые участки:

- `training-openai-evaluator.ts`;
- `training-evaluator.ts`;
- `training-openai-client.ts`;
- voice worker checkpoint/retry logic.

## Сначала измерить

До изменения лимитов необходимо сохранять per-attempt outcome и безопасный validation detail code. Нужно разделить:

- network/429/5xx;
- incomplete/refusal;
- malformed JSON;
- invalid IDs;
- evidence substring mismatch;
- output limit.

## Целевые изменения

- Уменьшить максимальную длину `explanation`, evidence и summary после анализа p95.
- Установить output token cap по фактическому распределению, оставив запас.
- Не выполнять идентичный retry для детерминированной локальной ошибки.
- Для исправимых ошибок использовать один узкий repair attempt либо скорректировать контракт.
- Рассмотреть `reasoning=low` для FOLLOW_UP и `medium` для MAIN только после quality gate.
- Сохранить существующий prompt-cache breakpoint для стабильной части вопроса.

## Границы

- Не снижать качество оценки ради меньшего output.
- Не парсить свободный текст вместо strict structured output.
- Не исправлять evidence так, чтобы цитата перестала быть подстрокой transcript.
- Не увеличивать retries без классификации причины.

## Критерии приёмки

- Retry rate и extra-call ratio измеряются отдельно.
- Невалидный ответ не вызывает три одинаковых платных запроса.
- Новый контракт проходит golden set без ухудшения согласия с ручной оценкой.
- p95 latency и средний output уменьшаются относительно baseline.
- Провайдерский сбой не превращается в обычную низкую оценку сотрудника.

## Проверки

Нужны stub-тесты всех error-классов и один небольшой закрытый golden set. Реальный A/B должен быть ограниченным, последовательным и opt-in.
