# Current Stage: Stage 4.5 — Project Assignments

## Статус

Stage 4 принят пользователем. Текущая временная граница между Stage 4 и Stage 5
— только назначение учебных проектов пользователям. Stage 5 не начинается.

## Цель

Добавить управляемую видимость проектов и право создать новую попытку без
изменения содержимого, scoring, Telegram transport, истории и уже начатых
попыток.

## Входит

- `TrainingProject.accessMode`: `ALL_PARTICIPANTS | ASSIGNED_USERS`.
- Новые проекты по умолчанию `ASSIGNED_USERS`; существующие при migration
  получают `ALL_PARTICIPANTS`.
- `TrainingProjectAssignment` с idempotent assign/reactivate/revoke, одной
  записью на пару project/user и сохранением истории отзыва.
- Единый `TrainingProjectAccessService` для employee list, старта, Telegram link,
  token consume, подтверждения старта и `/start` recovery.
- Новая попытка требует опубликованный открытый project, активного неудалённого
  пользователя, `training:participate` и подходящий access mode/assignment.
- Активная попытка продолжается после отзыва. После завершения новая попытка
  блокируется, а собственная история остаётся.
- Два admin endpoint-а: безопасный paginated user picker и атомарный bulk
  `ASSIGN | REVOKE`. Mode-only изменение использует существующий project PATCH.
- Раздел «Доступ сотрудников» в существующем редакторе project без нового
  frontend route; server search, pagination, filter, current-page selection,
  bulk actions и loading/empty/error states.
- Один общий Telegram-бот и независимая связь каждого Telegram account с
  существующим Platforma `User`.
- Конкурентный старт одного project разными users без глобальной exclusive
  блокировки project; одна активная попытка только на `(userId, projectId)`.

## Не входит

- Ranking, CSV, перестройка results, operations, notifications и analytics.
- Группы, отделы, команды, офисы, импорт users и отдельные боты.
- Индивидуальные сроки, scoring, attempt limits или timers назначения.
- Изменения Stage 2 voice/audio, Stage 3 OpenAI/scoring/review и Stage 4
  materials/source generation без блокирующего дефекта.
- Production deploy и реальные Telegram/OpenAI вызовы.

## Пакеты реализации

1. Enum, model, project field, additive migration и schema tests.
2. Общая политика доступа, employee/start/Telegram и PostgreSQL concurrency.
3. Admin API, AuditLog и HTTP/RBAC tests.
4. Existing editor UI, browser tests и связанный multi-user scenario.

После каждого пакета выполняются targeted tests, соответствующий workspace
build и `git diff --check`. Коммит не создаётся.

## Stop conditions

- Требуется функциональность Stage 5 или production deploy.
- Access policy дублируется в нескольких services либо вычисляется только во
  frontend.
- Assignment выдаёт permission, меняет role или попадает в immutable content
  snapshot.
- Revoke удаляет историю или мешает завершить уже начатую попытку.
- Start разных users сериализуется глобальной exclusive project lock.
- Bulk неатомарен, допускает partial validation либо использует unsafe SQL.
- Старые migration изменены или тест применяется к постоянной локальной базе.
