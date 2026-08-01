# Acceptance: Stage 1

## Критерии готовности к ручной приёмке

- Admin может создать draft, сохранить manual config и ровно 1+10 вопросов,
  опубликовать и глобально открыть/закрыть проект.
- Employee видит упорядоченный список доступных проектов, used/remaining,
  confirmed result и отдельный pending-review marker.
- Попытка создаётся только после явного confirmation, сразу считается
  использованной и не превышает limit при concurrent requests.
- Start атомарно сохраняет ограниченный snapshot project settings и всех
  одиннадцати вопросов; изменение live-проекта не меняет попытку.
- После ответа на MAIN backend выбирает и сохраняет ровно три разных
  FOLLOW_UP из snapshot, не раскрывая остальные семь Employee.
- Четыре text answers immutable; deterministic fake evaluator синхронно
  формирует `COMPLETED`, `REQUIRES_REVIEW` или `TIMED_OUT` result.
- Employee видит только собственный безопасный result/history; Admin видит
  минимальную detail-попытку с выбранными вопросами и fake answers.
- Вторая попытка хранится отдельно; закрытие проекта блокирует новый start,
  но не прерывает уже начатую snapshot-попытку.
- Production-код не содержит инфраструктуру Stage 2+.

## Выполненные автоматические проверки

### Unit и schema

- Publication validation принимает только 1 MAIN + 10 FOLLOW_UP.
- UI timer parsing хранит секунды, default равен `420`.
- Fake evaluator проверен для обычного текста, `[fake:pass]`, `[fake:fail]`
  и `[fake:review]`; score ограничен max вопроса и total `0..100`.
- Random selector возвращает три уникальных snapshot-candidate.
- Snapshot parser принимает только структуру 1 MAIN + 10 distinct FOLLOW_UP.
- Employee serializer возвращает только current question и safe result fields.
- Prisma schema содержит ровно пять Training-моделей; migration содержит
  history/concurrency constraints; seed role mapping проверен.

### PostgreSQL behavior

- Чистая временная PostgreSQL получила все 33 migration; итоговый status —
  `Database schema is up to date!`.
- Реальные PostgreSQL scenarios прошли `7/7`: create/publish, idempotency,
  concurrent double start, start/answer race, limits/retake, reload, immutable
  snapshot, selection, duplicate/foreign answer, timeout через GET и expired
  submit, close, separate attempts, best confirmed и pending review.
- Временная БД удалена после проверки.

### HTTP и RBAC

- Реальный Nest HTTP scenario прошёл `1/1`: anonymous `401`, missing permission
  `403`, Employee participation/ownership, Admin authoring/results и safe `404`
  для UUID probing чужой попытки.
- Backend routes требуют предметные permissions. Общий Admin web-shell
  дополнительно требует существующий `admin:access`.
- Employee DTO не содержит snapshot pool, семь скрытых FOLLOW_UP, чужие
  attempts, answer texts других пользователей, transcript или audio fields.

### Web и workspace

- Targeted Training web source-contract tests прошли `8/8`: routes, navigation
  permissions, editor validation, reload/current question, timeout, fake states,
  loading/empty/error и отсутствие hidden pool.
- Полные API tests прошли `249/249`, полные web tests — `285/285`.
- `pnpm build`, `pnpm test`, `prisma validate` и `git diff --check` прошли.
- Отдельный Training browser test не запускался: существующего настроенного
  browser harness/config для этого flow в репозитории нет.
- Реальные Telegram/OpenAI и другие внешние providers не вызывались.

## Ручной сценарий — ожидает пользователя

1. Запустить локальные PostgreSQL и Platforma.
2. Применить migration и выполнить seed.
3. Войти под Admin.
4. Создать Training-проект.
5. Заполнить title, timer, attempt limit, pass score, 1 MAIN и 10 FOLLOW_UP.
6. Опубликовать и открыть проект.
7. Войти под User.
8. Открыть `/training`.
9. Подтвердить старт попытки.
10. Убедиться, что показан MAIN и запущен общий timer.
11. Отправить текстовый fake answer.
12. Убедиться, что показан первый из трёх выбранных FOLLOW_UP.
13. Ответить ещё на три вопроса.
14. Получить и проверить результат.
15. Проверить собственную историю на `/training`.
16. Войти под Admin.
17. Открыть detail созданной попытки.
18. Закрыть, изменить и повторно опубликовать проект.
19. Подтвердить, что старая попытка сохранила прежние settings, texts,
    selection, answers и result.
20. Создать вторую попытку и убедиться, что обе попытки существуют отдельно.

Ручная приёмка в этой реализации автоматически не выполнялась, потому что для
неё нужны пользовательские credentials и визуальное подтверждение flow.

## Ограничения приёмки

- Ровно пять Training-моделей, 12 endpoints и пять frontend routes.
- Нет `TrainingProjectVersion`, отдельного `TrainingResult`, worker/queue,
  provider/job/run, audio/storage, parsers, review resolution, ranking или
  operations.
- После предметной консолидации Stage 1 содержит 10 backend, 9 frontend и
  1 shared production-файл; Prisma schema, migration, tests и docs считаются
  отдельно. Количество файлов и LOC не используются как механический лимит.
- Mock/static проверки не заменяют выполненные PostgreSQL/HTTP checks и
  ожидающую пользовательскую ручную проверку.

## Definition of Done и переход к Stage 2

Код и автоматические проверки Stage 1 готовы, но текущим этапом остаётся
Stage 1 до прохождения ручного сценария и явного подтверждения пользователя.
Stage 2 не начинается автоматически: Telegram, voice/audio, storage, `ffmpeg`
и fake transcription не проектируются и не реализуются без отдельной задачи.
