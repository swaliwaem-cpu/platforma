# Этап 5. Исправить PostgreSQL fixture рейтинга

Приоритет: P1

Тип работы: точечное исправление тестовых данных

Production: запрещён

## Промт этапа

```text
Цель: вернуть работоспособность PostgreSQL-тестов рейтинга, исправив несогласованные fixture-данные, не меняя корректный DB constraint или бизнес-логику review.

Предпосылки предыдущего аудита, которые нужно перепроверить:

- `apps/api/tests/training-v2-stage5-part2-postgres.test.cjs` создавал попытку с `reviewStatus: RESOLVED`, `reviewDecision: APPROVED` и `reviewFinalScore: 80`;
- constraint `training_attempts_review_state_check` требует для `APPROVED` значение `reviewFinalScore = null`;
- ненулевой `reviewFinalScore` и обязательный comment относятся к `OVERRIDDEN`; обычный `finalScore` присутствует и у `APPROVED`;
- три ranking-теста падали при создании fixture до проверок ranking service.

Порядок работы:

1. Read-only субагент сверяет Prisma schema, migration SQL, review service и все соседние test fixtures.
2. Главный агент воспроизводит падение на изолированной временной PostgreSQL.
3. Подтверди, что constraint соответствует текущей бизнес-логике и API contract.
4. Если подтверждено, в `apps/api/tests/training-v2-stage5-part2-postgres.test.cjs` для записи `APPROVED` установи `reviewFinalScore: null` или удали поле. Сохрани `finalScore: 80` и `calculatedScore: 80`; не меняй корректную `OVERRIDDEN` запись с `reviewFinalScore: 99`.
5. Проверь, что fixture всё ещё моделирует нужный ranking-сценарий, а не просто проходит constraint.
6. После правки read-only субагент проверяет смысл assertions и отсутствие аналогичных некорректных записей в затронутом файле.

Границы:

- не изменять старые migration-файлы;
- не ослаблять DB constraint;
- не менять scoring/review/ranking contract без доказанного противоречия;
- не использовать shared или production database;
- не выполнять попутную очистку fixtures;
- не расширять этап на ranking UI/API.

Stop condition: если schema, актуальная migration и review service противоречат друг другу, ничего не исправляй молча. Покажи точное противоречие и задай один вопрос о целевом контракте.

Минимальные проверки:

- сначала `pnpm build:api`, потому что Node-тесты используют собранный `dist`;
- targeted `apps/api/tests/training-v2-stage5-part2-postgres.test.cjs` на чистой временной БД с `TRAINING_TEST_DATABASE_URL`, ожидаемый результат 3/3; sentinel без переменной не считать проверкой;
- `node --test apps/api/tests/training-v2-stage5-part2-domain.test.cjs`;
- `git diff --check`.

Критерий завершения: тесты доходят до ranking assertions и проходят на данных, валидных по текущему review contract; production-код и migrations не изменены.

Если после исправления fixture падают ranking assertions, остановись и оформи новый дефект отдельно. Если фактический DB constraint отличается от migration и service, зафиксируй drift и не меняй старую migration.
```
