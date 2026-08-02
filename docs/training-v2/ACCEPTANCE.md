# Acceptance: Stage 4.5 — Project Assignments

## Критерии готовности

- Migration additive: existing projects backfill-ятся `ALL_PARTICIPANTS`, новые
  получают default `ASSIGNED_USERS`, данные Stage 1–4 не удаляются.
- Assignment хранит actor/time/revoke, уникален на project/user и имеет индексы
  `(projectId, revokedAt)` и `(userId, revokedAt)`.
- Assign, повторный assign, revoke и повторный revoke идемпотентны; invalid user
  отменяет весь bulk request.
- Новая попытка разрешена только активному неудалённому user с
  `training:participate` и текущим project access. Assignment не выдаёт
  permission.
- `ALL_PARTICIPANTS` и `ASSIGNED_USERS` проверяются одной backend policy в list,
  start и всех Telegram checkpoints.
- После revoke активная попытка, questions, answers, voice/audio, results и
  history сохраняются; новая попытка после завершения блокируется.
- Employee list фильтруется в БД и возвращает active attempt после revoke.
- Admin API защищён `training:projects:manage`, возвращает только userId, name,
  email, status, canParticipate, isAssigned и assignedAt.
- UI расширяет existing editor, поддерживает mode, warning при нуле назначений,
  server search/pagination/filter, current-page selection, bulk и все состояния.
- Admin project list показывает mode/count без N+1.
- Один Telegram bot изолирует пользователей; token не является доказательством
  доступа и recheck выполняется при link, consume и start.
- 10 разных users могут одновременно начать один project; double start одного
  user создаёт одну active attempt.
- Stage 5, реальные provider calls, deploy и commit отсутствуют.

## Automated fake/local acceptance

1. `prisma validate`/generate; clean temporary PostgreSQL install; Stage 4 → 4.5
   upgrade с backfill, сохранением projects/attempts/history и новым default.
2. Unit/schema tests: access matrix, active/inactive/deleted users, permission +
   assignment, active-attempt recovery, bulk validation, idempotency и safe DTO.
3. PostgreSQL: uniqueness/indexes, bulk, user on 10 projects, project for 10
   users, revoke/reactivate, mode preservation, filtered visibility, permission,
   revoke/start race, 10 concurrent starts и per-user isolation.
4. HTTP/RBAC: 401/403/404, employee isolation, admin picker search/pagination/
   filters, safe response, atomic bulk, employee list/start/Telegram denial.
5. Frontend/browser: mode toggle, defaults/backfill display, search, pagination,
   selection, assign/revoke, zero-assignment and missing-permission warnings,
   employee visibility, active-attempt recovery, loading/empty/error.
6. Linked fake scenario: 10 projects, at least 3 users with overlapping
   assignments, three Telegram accounts, concurrent start and independent
   questions/answers/audio/results, revoke during attempt and post-completion
   denial without affecting other users.
7. API/web/workspace tests and builds, targeted browser suite,
   `git diff --check`, `.only`/`.skip`, real-call/secrets/old-migration scans and
   cleanup temporary resources.

## Локальная ручная приёмка

1. Создать 10 учебных проектов.
2. Часть проектов установить в `ALL_PARTICIPANTS`, часть в `ASSIGNED_USERS`.
3. Назначить нескольким пользователям один проект.
4. Назначить одному пользователю несколько проектов.
5. Проверить видимость проектов под разными аккаунтами Platforma.
6. Связать разные Telegram-аккаунты с разными пользователями.
7. Одновременно начать один проект минимум с двух аккаунтов.
8. Проверить независимость вопросов, ответов, voice, аудио и результатов.
9. Отозвать доступ одному пользователю во время активной попытки.
10. Проверить: текущая попытка завершается, новая попытка блокируется, история
    остаётся.

## Definition of Done

Stage 4.5 готов только при зелёных automated gates и выполнении отдельной ручной
приёмки. Stage 5, commit и production deploy не выполняются в этой задаче.
