# Шаг 6. Переиспользовать нейтральный generation artifact между проектами

Работаем над модулем обучения в репозитории swaliwaem-cpu/platforma.

## Цель

Не оплачивать повторную генерацию вопросов для разных учебных проектов, если они используют один и тот же immutable набор источников и одинаковую generation policy.

Нельзя просто переиспользовать compiledKnowledgeJson первого проекта: он может содержать project-specific criteria, revision IDs и citation bindings. Общим может быть только нейтральный переносимый artifact с drafts/facts; criteria и references должны привязываться заново к текущему проекту.

## Контекст и зависимости

Шаги 1–5 должны быть завершены. Compact IDs, canonical source fingerprint и budget policy должны быть стабильны до глобального reuse.

Основные текущие точки:

- apps/api/prisma/schema.prisma
- apps/api/src/training/training-project-knowledge.service.ts
- apps/api/src/training/training-material-suggester.ts
- apps/api/src/training/training-material.service.ts
- apps/api/tests/training-v2-schema.test.cjs
- apps/api/tests/training-v2-stage4-postgres.test.cjs
- apps/api/tests/training-v2-stage4-domain.test.cjs

## Предлагаемая безопасная рамка

Предлагаемый безопасный вариант: автоматический reuse только для Platforma-объекта с тем же realEstateObjectId и полным immutable fingerprint источников. Manual text и URL остаются project-local. Не считай этот вариант утверждённым: подтверди его у пользователя до изменения Prisma и реализации.

Artifact не должен удаляться каскадно вместе с первым проектом. Политику retention после удаления последней связи не придумывай: если текущая модель требует отдельного решения, остановись до миграции и спроси пользователя.

Production flag по умолчанию должен оставаться выключенным до реальной PostgreSQL-проверки и отдельного разрешения.

## Границы задачи

Реализуй только безопасный cross-project artifact reuse за feature flag с сохранением старого per-project пути как rollback.

Не делай:

- destructive migration;
- изменение или удаление уже применённых migrations;
- prisma db push или migrate reset;
- reuse manual/URL sources;
- перенос project criteria между проектами;
- cleanup/retention policy без утверждения;
- commit, push, deploy, production DB access или paid calls.

## Обязательный preflight

1. Выполни git branch --show-current и git status --short.
2. Прочитай AGENTS.md, docs/BACKEND_GUIDE.md, docs/TESTING_AND_DEPLOY.md и docs/RISK_ZONES.md.
3. Изучи текущую незакоммиченную Prisma migration и knowledge service. Не перезаписывай их и не предполагай чистый HEAD.
4. Найди lifecycle TrainingProjectKnowledgeVersion, delete cascade, leases, claims, retries и project snapshot.
5. Используй минимум три read-only субагента:
   - schema/migration и deletion lifecycle;
   - concurrency/lease;
   - provenance/privacy.
   Общий worktree редактирует только главный агент.
6. До изменения Prisma представь пользователю короткий конкретный план таблицы, ключа, retention и rollback. Если эти решения ещё не подтверждены в текущем диалоге, остановись и спроси.

## Аудит перед изменением

1. Докажи, почему current unique projectId + sourceHash не даёт reuse.
2. Раздели current compiled JSON на:
   - переносимые drafts/facts;
   - project-specific criteria;
   - project-specific revision/citation bindings.
3. Определи полный generation key, включающий:
   - reuse scope Platforma object;
   - canonical content hashes;
   - model и reasoning;
   - prompt/compiler version;
   - budget и policy version;
   - routing strategy, если она существует.
4. Проверь concurrency claim across projects и stale lease recovery.
5. Проверь deletion и privacy boundary.
6. Если нейтральный artifact нельзя выделить без изменения публичного поведения, остановись.

## Требуемое поведение

1. Два проекта с одинаковым generation key получают один нейтральный artifact и вызывают provider один раз.
2. Параллельная первая компиляция двух проектов также приводит максимум к одному provider call.
3. Каждый проект заново строит references на собственные active revision IDs.
4. Criteria первого проекта не попадают во второй.
5. Изменение content, model, reasoning, prompt/compiler, budget или routing strategy создаёт новый artifact.
6. Ошибка или stale claim безопасно восстанавливаются bounded retry.
7. Provider call остаётся вне DB-транзакции.
8. Удаление одного проекта не ломает reuse второго.
9. Feature flag off сохраняет текущую per-project механику.
10. Миграция только additive; rollback выполняется выключением flag, а не destructive schema rollback.

## Ограничения реализации

- Не делай sourceHash глобально unique в project-owned таблице.
- Не сохраняй в shared artifact projectId, revisionId, employee criteria или access data.
- Не логируй документы и секреты.
- Не добавляй очередь или новую внешнюю инфраструктуру.
- Не менять публичную ошибку QUESTION_DRAFT_GENERATION_FAILED.
- Не использовать production DB для тестов.

## Критерии приёмки

- Schema test подтверждает additive migration без DROP, DELETE и TRUNCATE.
- Реальный изолированный PostgreSQL test подтверждает один provider call для двух проектов.
- Есть concurrent first-compile test.
- Есть tests criteria isolation и references rebound.
- Есть misses при изменении каждой составляющей generation key.
- Delete первого проекта не ломает второй.
- Failed/stale claim повторяется безопасно.
- Feature flag off проходит legacy regression.

## Проверки

Перед запуском найди или создай чистую временную PostgreSQL test DB. Не используй обычную локальную, shared или production DB.

Запусти:

- pnpm db:generate
- применение новой migration в чистую временную DB разрешённым deploy-only способом
- pnpm build:api
- node --test apps/api/tests/training-v2-schema.test.cjs
- реальный node --test apps/api/tests/training-v2-stage4-postgres.test.cjs с TRAINING_TEST_DATABASE_URL
- node --test apps/api/tests/training-v2-stage4-domain.test.cjs
- git diff --check

Важно: stage4-postgres без TRAINING_TEST_DATABASE_URL может пройти заглушкой. Не выдавай такой run за PostgreSQL-проверку.

Не запускай Stage 5 E2E, production migration и реальный provider.

## Stop conditions

Обязательно остановись и спроси пользователя до кодовых изменений, если:

- нужна новая Prisma table/index, а план ещё не подтверждён;
- не определена retention policy после последнего проекта;
- reuse предлагается расширить на manual/PDF/URL между разными Platforma objects;
- artifact содержит project-specific данные;
- нет безопасной временной DB для проверки;
- требуется production migration или paid call.

## Финальный отчёт

Сообщи:

- утверждённую архитектуру artifact и generation key;
- migrations и файлы;
- доказательство isolation/rebind/concurrency;
- какие PostgreSQL tests реально выполнились, а не были skipped;
- rollback через feature flag;
- ручные production gates и риски.

После отчёта остановись. Не переходи к шагу 7.
