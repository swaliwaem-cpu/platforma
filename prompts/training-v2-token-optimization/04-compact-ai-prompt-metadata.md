# Шаг 4. Сократить служебные metadata в AI prompt

Работаем над модулем обучения в репозитории swaliwaem-cpu/platforma.

## Цель

Сократить input tokens за счёт коротких внутренних evidence IDs и неповторяющихся labels, сохранив полную server-side трассировку до исходного материала.

Модель должна получать компактные идентификаторы наподобие e1, e2, e3. В базе и публичных контрактах должны сохраняться исходные sourceLocator, revisionId и понятный sourceLabel.

## Контекст и зависимости

Шаги 1–3 должны быть завершены.

Основные текущие точки:

- apps/api/src/training/training-material-suggester.ts
- apps/api/src/training/training-material.service.ts
- apps/api/src/training/training-project-knowledge.service.ts
- apps/api/tests/training-v2-stage4-domain.test.cjs
- apps/api/tests/training-v2-stage4-openai.test.cjs

Текущий AI payload повторяет длинные locator и названия материалов. compilation.references уже является естественным местом для обратного server-side mapping.

## Границы задачи

Реализуй только compact AI-only IDs и минимизацию повторяющихся служебных labels.

Не минифицируй:

- инструкции и смысловой prompt;
- имена полей output JSON schema;
- пользовательский текст;
- сохранённые sourceLocator и публичные DTO;
- модель, reasoning, retry, cache policy и context budget.

Не меняй Prisma, не добавляй зависимости, не делай commit, push, deploy или paid calls.

## Обязательный preflight

1. Выполни git branch --show-current и git status --short.
2. Прочитай AGENTS.md, docs/BACKEND_GUIDE.md и релевантные части docs/RISK_ZONES.md.
3. Найди все producers и consumers QuestionEvidenceFragment.locator, compilation.references и TrainingFact.sourceLocator.
4. Проверь, где locator попадает в JSON schema enum и как response валидируется.
5. Используй read-only субагентов для аудита mapping и обратной совместимости. Редактирует только главный агент.
6. Сохрани dirty worktree и не перезаписывай существующий knowledge patch.

## Аудит перед изменением

1. Измерь на локальной representative fixture:
   - длину текущего metadata payload;
   - долю повторяющихся title/locator;
   - ожидаемое сокращение chars без реального provider-вызова.
2. Докажи текущий путь mapping от AI locator до persisted fact.
3. Определи стабильную сортировку evidence до назначения коротких IDs.
4. Проверь, что ID не зависит от projectId, revisionId, UUID и исходного порядка загрузки.
5. Если публичный consumer использует внутренний AI locator, остановись и покажи конфликт.

## Требуемое поведение

1. Каждый выбранный evidence fragment получает короткий уникальный AI-only ID.
2. Назначение IDs детерминировано для одного canonical payload.
3. JSON schema разрешает только реально переданные compact IDs.
4. Provider response с compact ID восстанавливается через references в:
   - актуальный sourceRevisionId;
   - исходный sourceLocator;
   - sourceLabel;
   - server-known sourceExcerpt.
5. Persisted TrainingFact.sourceLocator остаётся исходным locator материала, а не e1.
6. Модель не должна возвращать sourceExcerpt как источник истины, если backend может восстановить его сам.
7. Изменение canonical locator contract отражено новой compiler/policy version и sourceHash.

## Ограничения реализации

- Не сохраняй compact ID как долговечный публичный идентификатор.
- Не включай UUID проекта или ревизии в AI payload.
- Не полагайся на Map insertion order без стабильной предварительной сортировки.
- Не ослабляй strict schema и grounded-locator validation.
- Сохрани 1 MAIN + 10 FOLLOW_UP и 1–3 facts на вопрос.
- Не меняй DB-транзакционные границы и retry behavior.

## Критерии приёмки

- AI payload содержит короткие IDs и не повторяет полный title в каждом segment label.
- IDs стабильны при перестановке входных источников.
- Provider response с неизвестным ID отклоняется.
- Все валидные compact IDs маппятся обратно без потери provenance.
- Persisted locator contract не изменён.
- Compiler/policy version защищает от ошибочного reuse старого artifact.
- Измерено сокращение metadata chars на fixture.

## Проверки

Добавь targeted tests:

- apps/api/tests/training-v2-stage4-domain.test.cjs:
  - короткие уникальные IDs;
  - order invariance;
  - mapping к исходным locator/revision;
  - compiler/sourceHash versioning;
- apps/api/tests/training-v2-stage4-openai.test.cjs:
  - compact enum в schema;
  - валидный response;
  - неизвестный ID;
  - server-side recovery sourceExcerpt.

Запусти:

- pnpm build:api
- node --test apps/api/tests/training-v2-stage4-domain.test.cjs
- node --test apps/api/tests/training-v2-stage4-openai.test.cjs
- git diff --check

Реальный OpenAI, PostgreSQL, web и E2E не запускай.

## Stop conditions

Остановись и спроси пользователя, если:

- compact ID требуется хранить в публичной модели;
- mapping нельзя сделать без Prisma migration;
- детерминированность требует менять порядок бизнес-выборки;
- sourceExcerpt нельзя безопасно восстановить на backend.

## Финальный отчёт

Сообщи:

- старый и новый metadata format без публикации контента документов;
- какие файлы изменены;
- измеренное сокращение chars;
- проверки;
- ручной check;
- остаточные риски.

После отчёта остановись. Не переходи к шагу 5.
