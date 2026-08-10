# Backend Guide

## NestJS

- Сохраняй существующую модульную структуру `apps/api/src`.
- Controller должен быть тонкой HTTP-границей.
- Business logic размещай в предметных services.
- Не создавай один service,
  отвечающий одновременно за HTTP, persistence,
  external providers, serialization и background jobs.
- Сохраняй существующие DI tokens и module boundaries.
- Не создавай circular dependencies
  ради быстрого исправления.

## Размер и ответственность

- Количество строк и файлов не является самостоятельной целью.
- Предпочитай цельный читаемый файл нескольким мелким файлам,
  между которыми распределена одна ответственность.
- Разделяй код по предметным обязанностям,
  а не по случайным helper-функциям.
- Разделяй код, только если выделяемая часть имеет самостоятельную
  предметную ответственность, меняется по другой причине,
  имеет собственные dependencies или lifecycle,
  используется несколькими consumers, может тестироваться независимо
  либо заметно уменьшает связность исходного файла.
- Не выноси только ради уменьшения LOC локальные types,
  одноразовые constants, private helpers, DTO одного controller,
  mapper или serializer с одним consumer, небольшие validators
  и barrel-файлы `index.ts`.
- До 900 строк допустимо при одной ясной ответственности;
  900–1200 строк является сигналом проверить смешение обязанностей;
  более 1200 строк требует архитектурного объяснения.
- Не объединяй самостоятельные controllers или lifecycles
  только ради уменьшения количества файлов.
- Бюджет файлов используется для обнаружения архитектурного конфетти,
  но не является критерием успешности сам по себе.
- Не создавай generic `utils.ts`,
  `helpers.ts` и `common.ts`.
- Один service должен описываться
  одним понятным предложением.

## API

- Не возвращай Prisma entities напрямую,
  если контракт должен ограничивать поля.
- Используй explicit serializers и `select`.
- Не меняй route, status code и error contract молча.
- Input validation выполняется server-side.
- Pagination и filters больших наборов
  выполняются server-side.
- Не загружай тяжёлые nested relations
  для list endpoint.

## Auth и RBAC

- Авторизация всегда проверяется backend-ом.
- Frontend visibility не является защитой.
- Новые административные endpoints
  используют существующие guards
  и явные permissions.
- IDOR проверяется ownership или scope,
  а не только наличием JWT.
- Seed ролей и permissions изменяется
  только с пониманием влияния
  на существующих пользователей.

## Prisma и PostgreSQL

- Prisma schema меняется только по отдельному плану.
- Новые migrations additive,
  если не утверждена data migration.
- Не редактируй уже применённые migrations.
- Не используй `db push` вместо migration.
- Транзакции должны быть короткими.
- Не держи transaction
  во время внешнего HTTP-запроса.
- Сохраняй существующий lock order,
  isolation и idempotency.
- Concurrency invariants проверяй
  настоящими PostgreSQL-тестами.
- Не исправляй race увеличением timeout
  без root cause.

## Queries

- Используй explicit `select`.
- Проверяй N+1.
- Сортировку и пагинацию больших выборок
  выполняй в PostgreSQL.
- Raw SQL должен быть параметризован.
- Не используй unsafe interpolation
  пользовательских значений.
- Индексы добавляй после проверки query plan.

## Shared contracts

Переноси контракт в `packages/shared`,
если он используется и frontend, и backend.

Не переносить в shared:

- Prisma operations;
- secrets;
- authorization;
- audit;
- storage implementation;
- external provider request construction.

## External providers и jobs

- External calls выполняются только server-side.
- Используй timeout, bounded retries
  и безопасную error classification.
- Не обещай exactly-once
  для внешнего billing или message delivery,
  если provider этого не поддерживает.
- Jobs должны быть идемпотентны.
- Restart не должен терять persisted work.
- Не создавай новую queue или infrastructure
  без текущей необходимости.
- Не логируй raw payload,
  секреты и персональные данные.

## Files и storage

- Проверяй MIME, размер и ownership.
- Не отдавай приватные storage keys
  и бессрочные public URLs.
- Перед удалением object
  проверяй DB references.
- Ошибки cleanup не проглатывай молча.
- Storage и DB должны иметь
  понятный recovery contract.

## Imports

Для WordPress и feed изменений:

- сначала analyze или preview;
- затем run;
- проверяй отчёт;
- не смешивай repair и основной import
  без необходимости;
- не запускай production import автоматически.

## Tests

- Pure logic — unit tests.
- Transactions и concurrency —
  PostgreSQL integration tests.
- Guards и routes —
  HTTP tests с реальным Nest application.
- Providers — local stub server.
- Не обращайся к реальным внешним сервисам
  в обычных tests.
- Не заменяй DB race test
  fake repository.
