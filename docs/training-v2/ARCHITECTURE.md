# Архитектура Stage 1

## Контекстная схема

```text
React/Vite pages
  -> AuthProvider + apiRequest + manual routing
  -> NestJS TrainingModule
       -> admin controller -> TrainingProjectService
       -> employee controller -> TrainingAttemptService
       -> TrainingEvaluator -> DeterministicFakeTrainingEvaluator
  -> PrismaService -> existing PostgreSQL

Existing User/Role/Permission ----^---- ownership and RBAC
Existing RealEstateObject --------^---- optional project reference
```

В системе нет второго backend, database, auth flow, router или admin shell.

## Минимальные компоненты

- `TrainingModule` подключается в существующий `AppModule`.
- Два тонких controller разделяют employee и admin HTTP surface.
- `TrainingProjectService` отвечает за draft aggregate, publish/open и admin
  queries.
- `TrainingAttemptService` отвечает за eligibility, start, snapshot, timer,
  progression, random selection, evaluation и result queries.
- `TrainingEvaluator` имеет только операцию оценки завершённой попытки.
- `DeterministicFakeTrainingEvaluator` — локальная Stage 1 реализация.
- Explicit serializers формируют разные Employee/Admin DTO.
- Общие API-типы API и web размещаются в предметном shared-файле.

## Минимальная data model

Новых основных моделей — пять.

| Модель | Минимальные данные | Зачем нужна сейчас |
|---|---|---|
| `TrainingProject` | `title`, optional `realEstateObjectId`, `displayOrder`, `maxAttempts=3`, required `durationSeconds`, `passScore=75`, `allowRetakeAfterPass`, `publishedAt`, `isOpen`, timestamps | Admin aggregate, порядок, доступность и настройки попытки. |
| `TrainingQuestion` | `projectId`, `kind`, `position`, `text` | Редактируемый набор ровно 1 main + 10 additional. |
| `TrainingAttempt` | `projectId`, `userId`, `attemptNumber`, `startIdempotencyKey`, status/timestamps/deadline, project/config snapshots, `finalScore`, `resultStatus` | Расход попытки, timer, ownership и сохранённый результат без отдельного `TrainingResult`. |
| `TrainingAttemptQuestion` | `attemptId`, optional `sourceQuestionId`, snapshot kind/position/text/maxScore, nullable `selectedOrder` | Immutable snapshot всех 11 вопросов и сохранение выбранных 1+3. |
| `TrainingAnswer` | unique `attemptQuestionId`, immutable `text`, `submittedAt`, optional `awardedScore` | Одна финальная Stage 1 text submission на выбранный вопрос. |

Stage 1 использует только небольшие enums: question kind, attempt status и result
status. Universal state machine не создаётся.

## Связи и ограничения

- `TrainingProject` optionally относится к `RealEstateObject`; при удалении ЖК
  ссылка становится `null`, сам Training-проект сохраняется.
- `TrainingProject` имеет вопросы и попытки.
- `TrainingAttempt` принадлежит существующему `User` и одному проекту.
- `TrainingAttemptQuestion` принадлежит попытке; source question может стать
  `null`, snapshot остаётся неизменным.
- `TrainingAnswer` принадлежит ровно одному attempt question.
- Unique `(projectId, kind, position)` исключает дубли позиций.
- Unique `(userId, projectId, attemptNumber)` сохраняет порядок попыток.
- Unique `(userId, projectId, startIdempotencyKey)` защищает повтор start.
- Unique `(attemptId, sourceQuestionId)` и `(attemptId, selectedOrder)` не дают
  повторить выбранный вопрос или порядок.
- Cascade delete исторических попыток не используется. Delete project/attempt
  endpoints в Stage 1 отсутствуют.

Точное количество 1+10 проверяется server-side в publish transaction. DB
constraints поддерживают уникальность, но не заменяют aggregate validation.

## Project state flow

```text
DRAFT --publish(valid 1+10/config)--> PUBLISHED_CLOSED --open--> PUBLISHED_OPEN
  ^                                      ^                         |
  |------ edit closed (unpublish) -------|<--------- close --------|
```

Открыть можно только опубликованный проект. Открытый проект не редактируется.
Влияние close на активную попытку остаётся в `NEEDS_DECISION`.

## Attempt state flow

```text
start confirmation
  -> ACTIVE + snapshot 1 main / 10 candidates + deadline
  -> submit main
  -> backend marks 3 distinct candidates as selected
  -> submit selected additional 1, 2, 3
  -> synchronous fake evaluation
  -> COMPLETED: PASSED | FAILED | REQUIRES_REVIEW

deadline -> TIMED_OUT (точная result semantics требует решения)
```

Попытка расходуется созданием `TrainingAttempt` после явного confirmation.
Любая созданная попытка входит в used count независимо от terminal status.

## API surface proposal

У NestJS нет глобального `/api` prefix. Все endpoints используют существующие
JWT/RBAC guards, server-side validation и explicit serializers.

### Employee API — `training:participate`

| Method и path | Назначение Stage 1 |
|---|---|
| `GET /training/projects` | Открытые проекты в admin order, used/remaining, best/last confirmed и status. |
| `POST /training/projects/:projectId/attempts` | Подтверждённый idempotent start, snapshot и выдача main question. |
| `GET /training/attempts/:attemptId` | Только собственный active state/result; использование для active recovery запрещено фиксировать до решения границы abandonment. |
| `PUT /training/attempts/:attemptId/questions/:attemptQuestionId/answer` | Неизменяемый финальный text answer; после main выбирает 3, после четвёртого оценивает. |
| `GET /training/projects/:projectId/attempts` | Минимальная собственная история проекта. |

### Admin API — `admin:access` + `training:manage`

| Method и path | Назначение Stage 1 |
|---|---|
| `GET /training/admin/projects` | Список project summaries для admin entry. |
| `GET /training/admin/projects/:projectId` | Один editable aggregate с 11 вопросами. |
| `POST /training/admin/projects` | Создать draft. |
| `PUT /training/admin/projects/:projectId` | Атомарно заменить закрытые metadata/config/questions и снять publication. |
| `POST /training/admin/projects/:projectId/publish` | Проверить config и точное 1+10, затем publish. |
| `PATCH /training/admin/projects/:projectId/availability` | Глобально открыть или закрыть опубликованный проект. |
| `GET /training/admin/projects/:projectId/attempts` | Минимальный список attempt summaries проекта. |
| `GET /training/admin/attempts/:attemptId` | Четыре выбранных snapshots, fake answers и сохранённый итог. |

Удаление, отдельный question CRUD, review, ranking, CSV и operations endpoints не
создаются.

## Frontend routes proposal

| Route | Содержание |
|---|---|
| `/training` | Employee project list и минимальная собственная history. |
| `/training/attempts/:attemptId` | Start result, общий timer, 1 main + 3 additional и итог. |
| `/admin/training` | Admin project list и создание draft. |
| `/admin/training/projects/:projectId` | Editor, publish/open и attempt summaries. |
| `/admin/training/attempts/:attemptId` | Минимальный admin attempt view. |

Маршруты добавляются в существующие `App.tsx` manual routing/navigation и
permission gates. Страницы используют `AuthProvider`, `apiRequest`, app shell и
`AdminUi`; новый router, state manager или UI library не нужны.

## Transaction boundaries

### Draft и publish

- Aggregate update блокирует project row, проверяет closed state, заменяет
  вопросы и снимает publication в одной короткой transaction.
- Publish блокирует project row, проверяет config и ровно 1+10, затем выставляет
  `publishedAt`.
- Availability update в transaction блокирует тот же project row и разрешает
  `isOpen=true` только при `publishedAt != null`; concurrent edit/unpublish не
  может оставить открытым неопубликованный проект.

### Start

- Требуется `Idempotency-Key` и явный confirmation в request.
- Transaction в стабильном порядке блокирует существующий `User`, затем project;
  проверяет permission, open/published, pass/retake rule и attempt limit.
- Она создаёт attempt и 11 question snapshots с project/scoring/timer config.
- Никакой network operation внутри transaction нет.

Короткая user-row serialization предотвращает race параллельных стартов без
lock table. Повтор с тем же key возвращает ту же попытку.

### Answer, selection и result

- Transaction блокирует attempt, проверяет ownership, deadline и текущий
  selected question.
- Main answer и назначение `selectedOrder=1..3` фиксируются атомарно.
- Повтор той же отправки не выполняет selection/evaluation снова; конфликтующий
  повтор отклоняется.
- После четвёртого ответа pure fake evaluator выполняется синхронно, а
  per-question scores, final score и status сохраняются в той же transaction.
- Client не передаёт и не исправляет score/result status.

## Historical integrity

При старте snapshot сохраняет:

- title проекта;
- timer, pass score, max attempts, retake setting;
- max scores `55/15/15/15`;
- kind, source position и text всех 11 вопросов.

После main answer random selection использует только десять snapshot-candidates.
Изменение или удаление source project/question не меняет snapshot, selection,
answers и result. Завершённая попытка не пересчитывается автоматически.

## Random selection

- Выбор выполняет backend после принятого main answer.
- Выбираются ровно три разные строки из десяти snapshot-candidates.
- Качество и text main answer не участвуют в выборе.
- Подход использует встроенный server-side random source без зависимости.
- Тест доказывает размер, уникальность и принадлежность пулу, но не
  статистическую равномерность конкретной реализации.

## Serialization и безопасность

- Employee endpoints всегда фильтруются по `userId` из auth context.
- Admin endpoints защищены двумя permissions.
- Employee DTO никогда не содержит семь невыбранных candidates, fake answer
  text, чужие результаты или будущие review/fact fields.
- Admin attempt DTO Stage 1 ограничен выбранными 1+3, fake answers и итогом.
- Prisma entities напрямую наружу не возвращаются.

## Запрет premature infrastructure

Stage 1 не создаёт `TrainingProjectVersion`, `TrainingResult`, assignments,
criteria/facts, evaluation/provider runs, jobs, queues, outbox, audit subsystem,
worker, audio/files/storage, parsers, notifications, analytics, review, ranking,
CSV, operations UI, generic workflow или event sourcing.
