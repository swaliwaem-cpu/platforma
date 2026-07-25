# ФИНАЛЬНЫЙ МАСТЕР-ПЛАН ДЛЯ CODEX
## Модуль «Обучение / Аттестация» + Telegram-бот в Platforma

**Статус:** бизнес-решения зафиксированы, блокирующих вопросов нет.  
**Репозиторий:** `swaliwaem-cpu/platforma`  
**Рабочая ветка:** `on-ser`  
**Дата фиксации плана:** 25.07.2026

---

# 0. Как Codex должен работать с этим документом

Этот файл — единое техническое задание и последовательность реализации. Не пытайся сделать весь модуль одним огромным изменением.

Правила выполнения:

1. Работай только в текущей ветке `on-ser`. Перед каждым этапом выполни:
   - `git branch --show-current`;
   - `git status --short`.
2. Не переключай ветку, не удаляй и не перезаписывай чужие изменения и untracked-файлы.
3. Если пользователь не указал диапазон этапов, выполняй только ближайший незавершённый этап.
4. После каждого этапа:
   - перечисли изменённые файлы;
   - покажи миграции;
   - выполни релевантные build/tests;
   - исправь найденные ошибки;
   - обнови `docs/training/02-implementation-checklist.md`;
   - остановись и выдай отчёт.
5. Не создавай вторую платформу, отдельную базу сотрудников, отдельную авторизацию или отдельную админку.
6. Не меняй существующий UI и маршруты вне необходимого объёма.
7. Не добавляй новые библиотеки без краткого обоснования в architecture decision. Для поддержки утверждённых форматов документов и обработки аудио новые зависимости разрешены, но выбирай минимальный и поддерживаемый набор.
8. Все внешние интеграции должны иметь fake-провайдеры для тестов и локальной разработки.
9. Никаких реальных Telegram/OpenAI вызовов в обычных unit/integration tests.
10. Не использовать Assistants API. Для оценки использовать Responses API со Structured Outputs, для речи — Audio Transcriptions API.

---

# 1. Подтверждённый технический контекст существующей Platforma

Переиспользовать текущую архитектуру:

- pnpm-монорепозиторий;
- frontend: `apps/web`, React 19, TypeScript, Vite, Tailwind, Radix/shadcn и существующие CSS-примитивы;
- routing пока ручной, находится в `apps/web/src/App.tsx`;
- backend: `apps/api`, NestJS 11, TypeScript;
- БД: PostgreSQL 16 + PostGIS;
- ORM: Prisma;
- auth: access JWT + refresh cookie, `JwtAuthGuard`, `PermissionsGuard`, `@RequirePermissions`;
- пользователи и RBAC: существующие `User`, `Role`, `Permission`, `RolePermission`;
- storage: существующие `FilesService` и S3-compatible MinIO/Beget S3;
- Redis присутствует в Compose, но очередь на нём сейчас не реализована;
- существующий worker-паттерн использует PostgreSQL-состояния и heartbeat;
- тесты: `node:test`, сборка TypeScript перед API tests;
- Docker Compose уже содержит API, web, Postgres, Redis и MinIO.

Точки размещения нового кода:

```text
apps/api/src/training/
apps/api/src/training/telegram/
apps/api/src/training/providers/
apps/api/src/training/jobs/
apps/api/src/training/document-ingestion/
apps/api/src/training/training-worker.main.ts
apps/web/src/training/
packages/shared/src/training.ts
apps/api/tests/training-*.test.cjs
apps/web/tests/training-*.test.mjs
docs/training/
```

Не мигрировать всю платформу на React Router в рамках этой задачи. Допустимо аккуратно вынести конфигурацию маршрутов и навигации из `App.tsx`, сохранив существующие URL и permission gates.

---

# 2. Зафиксированные бизнес-решения

## 2.1. Пользователи, доступ и роли

1. Аттестацию проходят существующие пользователи Platforma. Отдельную сущность employee не создавать.
2. У всех сотрудников одинаковый список доступных проектов. Индивидуальных назначений нет.
3. Администратор управляет глобальной доступностью и порядком проектов:
   - может открыть один проект;
   - может открыть несколько проектов одновременно;
   - может закрыть или архивировать проект;
   - порядок отображения задаётся `sortOrder`.
4. Нужна отдельная роль `training_admin` — «Администратор обучения».
5. Главный `admin` также имеет все права модуля обучения.
6. Менеджер/администратор с permission `training:audio:read` может прослушивать аудио.
7. Обычный сотрудник:
   - не видит общий рейтинг;
   - не видит чужие результаты;
   - не видит transcript;
   - не видит перечень фактических ошибок;
   - видит собственный итог и разрешённую разбивку по критериям.

## 2.2. Проекты обучения

1. Количество проектов не ограничивать десятью на уровне БД.
2. Для первого запуска предполагается около 10 проектов.
3. Учебный проект может опционально ссылаться на существующий `RealEstateObject`:
   - `realEstateObjectId` nullable;
   - связь используется для отображения карточки, изображения, названия и предварительного заполнения;
   - оценка никогда не должна напрямую зависеть от текущих изменяемых полей карточки ЖК;
   - вопросы, факты и rubric всегда сохраняются в неизменяемой опубликованной версии.
4. Проект может существовать без объекта каталога, например «Технология продаж» или «Ипотека».
5. Проект имеет настраиваемые:
   - проходной балл, default `75`;
   - лимит попыток, default `3`;
   - возможность пересдачи после успешного прохождения;
   - cooldown между попытками от 1 часа до 24 часов;
   - окно доступности/дедлайн от 1 до 7 дней;
   - общий лимит времени попытки, default 7 минут, разрешённый диапазон 5–7 минут.

## 2.3. Сценарий экзамена

1. В опубликованной версии проекта должно быть строго:
   - 1 главный вопрос;
   - 10 дополнительных вопросов.
2. Одна попытка состоит из:
   - 1 главного вопроса;
   - 3 разных дополнительных вопросов.
3. Три дополнительных вопроса выбираются полностью случайно из десяти:
   - без повторов внутри одной попытки;
   - содержание главного ответа на выбор не влияет;
   - те же вопросы могут повториться в других попытках;
   - вопросы выбирает backend, а не LLM;
   - выбранные ID сохраняются в БД при старте попытки.
4. Бот принимает как ответ только Telegram `voice`.
5. На один вопрос разрешено несколько voice-частей.
6. После каждой части бот показывает кнопку `Завершить ответ`.
7. Пока кнопка не нажата, следующая voice считается дополнительной частью текущего ответа.
8. Уже принятую часть нельзя удалить или заменить.
9. Все части одного ответа объединяются и оцениваются как единый ответ.
10. После завершения каждого ответа бот пишет только `Ответ принят` — без промежуточного балла и объяснения.

## 2.4. Попытки и таймер

1. Попытка расходуется сразу после явного подтверждения старта.
2. До старта показать предупреждение:
   - попытка будет списана немедленно;
   - отменить и продолжить позже нельзя;
   - действует общий таймер.
3. После старта попытку нельзя отменить или поставить на паузу.
4. Брошенная пользователем попытка сгорает.
5. Таймер 5–7 минут относится ко всей попытке целиком: главный + 3 дополнительных.
6. Значение настраивается отдельно для проекта, default 7 минут.
7. Нужны предупреждения об оставшемся времени. Default:
   - за 60 секунд;
   - за 20 секунд.
   Порог хранить в настройке/конфиге, а не жёстко размазывать по коду.
8. При окончании таймера:
   - новые вопросы не задаются;
   - текущему пользователю разрешается дослать одну уже записываемую voice-часть в течение configurable grace period, default 90 секунд;
   - после получения этой части текущий ответ автоматически закрывается;
   - оставшиеся неотвеченные вопросы получают 0 баллов и статус `SKIPPED_TIMEOUT`;
   - попытка финализируется и считается использованной.
9. Если пользователь ничего не отправил после старта, попытка всё равно сгорает.
10. Подтверждённый системный сбой Telegram/OpenAI/storage не должен отнимать у сотрудника дополнительную попытку:
    - попытка помечается `TECHNICAL_FAILURE`;
    - её можно автоматически восстановить или вернуть администратором с audit log.

## 2.5. Итоговая шкала

Общая шкала — 100 баллов:

```text
Главный вопрос:          максимум 55
Дополнительный вопрос 1: максимум 15
Дополнительный вопрос 2: максимум 15
Дополнительный вопрос 3: максимум 15
Итого:                   максимум 100
```

Default-разбивка главного ответа, суммарно 55:

```text
Полнота раскрытия проекта/вопроса:                 5
Богатство речи и профессиональная лексика:        15
Фактическая точность:                             15
Логика, структура и вывод:                        10
Подача речи: темп, паузы, повторы, слова-паразиты: 10
```

Последние 10 баллов фиксируются как «Подача речи», поскольку отдельно подтверждено требование оценивать темп, паузы, запинки, повторы и слова-паразиты. Веса должны редактироваться в админке, а публикация запрещена, если сумма не равна 55.

Default-разбивка каждого дополнительного ответа, суммарно 15:

```text
Фактическая точность:        7
Полнота ответа:              4
Логика и ясность:            2
Качество устной подачи:      2
```

Эти четыре веса также настраиваемые; публикация запрещена, если сумма не равна 15.

Дополнительные правила:

1. За каждое отдельное подтверждённое несоответствие факта материалу применяется штраф `−5`.
2. Одна и та же фактическая ошибка штрафуется один раз, даже если повторена в одном ответе.
3. Балл ответа и итоговый балл ограничиваются диапазоном 0..max.
4. Факт, которого нет в утверждённом материале:
   - не штрафуется автоматически;
   - сохраняется как `unsupported claim`;
   - переводит попытку в `REQUIRES_REVIEW`;
   - подсвечивается администратору вместе с фрагментом transcript.
5. Администратор при проверке unsupported claim может:
   - подтвердить, что это допустимый дополнительный факт — без штрафа;
   - отметить как ошибку — применяется `−5`;
   - оставить комментарий;
   - добавить факт только в новую версию проекта, не меняя историческую попытку.
6. Корпоративного скрипта продаж нет. Не создавать искусственный критерий «соответствие корпоративному скрипту».
7. Не оценивать личность, пол, возраст, акцент, харизму, эмоциональное состояние или «приятность голоса».

## 2.6. Проверка и ручная корректировка

1. Первичную оценку выставляет ИИ.
2. `admin` и `training_admin` могут проверить и изменить оценку.
3. Хранить отдельно:
   - AI suggested score;
   - deterministic server score;
   - admin override score;
   - final score;
   - reviewer;
   - причина изменения;
   - дата проверки.
4. Исходная AI-оценка никогда не перезаписывается.
5. Попытки с unsupported claims обязательно имеют статус `REQUIRES_REVIEW` до решения администратора.
6. Другие попытки можно показывать как финальные сразу, но администратор сохраняет право позднего пересмотра.
7. Лучшим результатом проекта считается максимальный `finalScore` среди попыток.
8. Если попытка пересмотрена администратором, в рейтинг попадает пересмотренный `finalScore`.

## 2.7. Что показывать сотруднику

В платформе после завершения:

- общий балл;
- `Пройдено / Не пройдено / Требует проверки`;
- баллы по разрешённым критериям;
- количество оставшихся попыток;
- лучший результат;
- история собственных попыток без transcript и ошибок.

В Telegram после завершения:

- только общий балл;
- статус;
- количество оставшихся попыток;
- кнопка открытия раздела обучения в Platforma.

В Telegram не показывать подробную разбивку, transcript и ошибки.

## 2.8. Рейтинг

Рейтинг доступен только `admin` и `training_admin`.

Обязательные данные:

- пользователь;
- общая оценка;
- краткая расшифровка общей оценки;
- лучший подтверждённый балл по каждому проекту;
- расшифровка баллов по критериям;
- допущенные ошибки;
- факты сверх утверждённого материала;
- количество использованных попыток;
- дата последней попытки;
- суммарное/среднее время прохождения.

Формула рейтинга:

1. Для каждого проекта используется лучший `finalScore`.
2. `averageBestScore` считается по завершённым проектам, непройденные/неоткрытые не превращать молча в нули.
3. Отдельно показывать `completedProjectsCount` и `passedProjectsCount`.
4. Сортировка общего рейтинга:
   - `passedProjectsCount DESC`;
   - `completedProjectsCount DESC`;
   - `averageBestScore DESC`;
   - `lastCompletedAt ASC` как tie-breaker.
5. Отделы и команды сейчас не реализовывать.

## 2.9. Материалы

Поддержать загрузку:

- текст вручную;
- PDF;
- DOCX;
- PPTX;
- XLSX.

Правила:

1. Сырые документы не являются непосредственным эталоном оценки.
2. Из документов извлекается текст и предлагаются факты/темы.
3. Администратор обязан подтвердить факты перед публикацией версии.
4. Для каждого факта желательно хранить ссылку на источник:
   - документ;
   - страница PDF;
   - номер слайда;
   - лист/ячейка XLSX;
   - раздел DOCX.
5. OCR сканов не входит в первый MVP. Документ без текстового слоя получает `NEEDS_MANUAL_TEXT`.
6. Для парсеров предусмотреть ограничения размера, zip-bomb protection и лимит extracted text.

## 2.10. Хранение

1. Оригинальные voice, transcript, оценки и история попыток хранятся бессрочно.
2. В конфиге использовать `null`/`0` как «без автоудаления», а не магическое большое число дней.
3. Аудио должно находиться только в приватном bucket.
4. Не сохранять публичный URL.
5. Выдавать аудио только через авторизованный backend endpoint с `training:audio:read` и audit log.
6. Добавить пользовательское уведомление/consent о записи, транскрибации, AI-обработке и бессрочном хранении.
7. Реализовать административное удаление/анонимизацию по специальному permission, даже если автоудаление отключено.

---

# 3. Целевая архитектура

```text
React Platforma
├── /training — кабинет сотрудника
├── /admin/training/projects — проекты и материалы
├── /admin/training/results — попытки и проверки
└── /admin/training/ranking — рейтинг
             │
             ▼
Existing NestJS API
├── TrainingModule
│   ├── Projects / Versions / Questions / Facts
│   ├── Attempts / State machine / Timer
│   ├── Scoring / Reviews / Ranking
│   ├── Telegram linking + webhook
│   ├── Document ingestion
│   └── Protected audio endpoints
├── Existing AuthModule / PrismaModule / FilesModule
└── PostgreSQL
             │
             ├── private S3/MinIO bucket
             ├── Telegram Bot API
             ├── OpenAI Audio Transcriptions
             └── OpenAI Responses API

Separate training worker process
├── PostgreSQL-backed TrainingJob queue
├── download Telegram voice
├── ffmpeg/ffprobe normalization and acoustic metrics
├── transcription
├── structured evaluation
├── deterministic scoring
└── Telegram notifications
```

Для MVP использовать durable PostgreSQL queue по паттерну существующего worker, но с отдельным процессом/контейнером. Redis/BullMQ не подключать только потому, что Redis уже присутствует.

---

# 4. Prisma-модель данных

Использовать UUID, snake_case через `@map/@@map`, timestamps и conventions текущего проекта.

## 4.1. Enum

```text
TrainingProjectStatus: DRAFT | OPEN | CLOSED | ARCHIVED
TrainingVersionStatus: DRAFT | PUBLISHED | SUPERSEDED
TrainingQuestionType: MAIN | FOLLOW_UP
TrainingAttemptStatus:
  STARTED
  AWAITING_MAIN
  PROCESSING_MAIN
  AWAITING_FOLLOW_UP
  PROCESSING_FOLLOW_UP
  FINALIZING
  COMPLETED
  REQUIRES_REVIEW
  EXPIRED
  TECHNICAL_FAILURE
TrainingAttemptQuestionStatus:
  PENDING | PRESENTED | COLLECTING | LOCKED | PROCESSING | SCORED | SKIPPED_TIMEOUT
TrainingAnswerStatus:
  COLLECTING | READY | DOWNLOADING | TRANSCRIBING | EVALUATING | SCORED | FAILED
TrainingFactVerdict: CORRECT | PARTIAL | MISSING | INCORRECT | UNSUPPORTED
TrainingReviewStatus: NOT_REQUIRED | PENDING | APPROVED | OVERRIDDEN
TrainingJobStatus: PENDING | RUNNING | SUCCEEDED | FAILED | DEAD
TrainingSourceExtractionStatus: PENDING | PROCESSING | READY | NEEDS_MANUAL_TEXT | FAILED
```

## 4.2. Основные модели

### `TrainingProject`

- `id`;
- `realEstateObjectId String?`;
- `slug` unique;
- `title`;
- `description`;
- `status`;
- `sortOrder`;
- `availableFrom DateTime?`;
- `deadlineAt DateTime?`;
- `activeVersionId String?`;
- timestamps;
- `archivedAt`.

### `TrainingProjectVersion`

- `projectId`;
- `versionNumber`;
- `status`;
- `passScore` default 75;
- `attemptLimit` default 3;
- `cooldownMinutes` default 60, allowed 60..1440;
- `totalTimeLimitSeconds` default 420, allowed 300..420;
- `finishGraceSeconds` default 90;
- `warningSecondsJson` default `[60,20]`;
- `allowRetakeAfterPass`;
- `mainMaxScore` = 55;
- `followUpMaxScore` = 15;
- `scoringConfigJson`;
- `promptVersion`;
- `schemaVersion`;
- `publishedById`, `publishedAt`;
- timestamps.

Published version immutable. Для изменений создаётся новый draft.

### `TrainingQuestion`

- `projectVersionId`;
- `type`;
- `text`;
- `position`;
- `isActive`;
- `maxScore`;
- optional `topicCodesJson`.

Publication validation: ровно 1 MAIN, ровно 10 FOLLOW_UP.

### `TrainingFact`

- `projectVersionId`;
- `code`;
- `topicCode`;
- `statement`;
- `acceptedAliasesJson`;
- `importance`;
- `sourceDocumentId?`;
- `sourceLocatorJson`;
- `isApproved`;
- timestamps.

### `TrainingQuestionFactLink`

Связь question↔fact, optional weight/required flag.

### `TrainingEvaluationCriterion`

- `projectVersionId`;
- `questionType`;
- `code`;
- `title`;
- `maxPoints`;
- `description`;
- `anchorsJson`;
- `sortOrder`.

При публикации сумма MAIN criteria = 55, FOLLOW_UP criteria = 15.

### `TrainingSourceDocument`

- `projectVersionId`;
- `fileId` relation to existing `File`;
- `documentType`;
- `checksum`;
- `extractionStatus`;
- `extractedText`;
- `extractionMetadataJson`;
- `errorMessage`;
- timestamps.

### `TrainingTelegramAccount`

- unique `userId`;
- unique `telegramUserId` as BigInt/string-safe representation;
- `chatId`;
- username/name metadata;
- `linkedAt`, `revokedAt`.

### `TrainingLinkToken`

- `userId`;
- optional `projectId`;
- `tokenHash` unique;
- `expiresAt`;
- `usedAt`;
- `revokedAt`.

В БД хранить только hash.

### `TrainingAttempt`

- `userId`;
- `projectId`;
- `projectVersionId`;
- `attemptNumber`;
- `status`;
- `isConsumed` true сразу после подтверждения старта;
- `startedAt`;
- `expiresAt`;
- `graceExpiresAt`;
- `completedAt`;
- snapshot настроек попытки;
- `aiScore`;
- `serverScore`;
- `adminScore?`;
- `finalScore`;
- `passStatus`;
- `reviewStatus`;
- `summary`;
- duration fields;
- timestamps.

Constraints:

- unique `[userId, projectId, attemptNumber]`;
- максимум одна активная попытка user+project;
- лимит/cooldown проверяются транзакционно.

### `TrainingAttemptQuestion`

- `attemptId`;
- `questionId`;
- `sequence` 1..4;
- `status`;
- `presentedAt`;
- `firstSegmentAt`;
- `finishedAt`;
- `responseTimeSeconds`;
- `answerDurationSeconds`;
- `selectionRandomIndex/metadata`.

### `TrainingAnswer`

Один агрегированный ответ на вопрос:

- `attemptQuestionId` unique;
- `status`;
- combined transcript;
- normalized language;
- acoustic metrics JSON;
- provider/model/request metadata;
- processing timestamps;
- error data.

### `TrainingVoiceSegment`

Каждое Telegram voice-сообщение:

- `answerId`;
- `segmentIndex`;
- Telegram update/message/file IDs;
- `fileUniqueId`;
- original private storage key;
- mime/size/duration;
- receivedAt;
- unique constraints для идемпотентности.

### `TrainingAnswerEvaluation`

- `answerId`;
- actual model ID;
- reasoning effort;
- prompt/schema/rubric versions;
- structured result JSON;
- AI suggested score;
- server score;
- summary;
- review flags/reasons;
- usage/latency/request ID;
- timestamps.

### `TrainingScoreComponent`

Детализированные criterion points, fact verdicts, evidence, penalties.

### `TrainingResultReview`

- `attemptId`;
- `reviewerId`;
- previous/final score;
- decision;
- required comment;
- unsupported claims decisions;
- timestamps.

### `TrainingProcessedUpdate`

Unique Telegram `update_id`, status and processedAt.

### `TrainingJob`

- type;
- status;
- payload JSON;
- idempotency key unique;
- runAt;
- attempts/maxAttempts;
- lock owner;
- lockedAt/heartbeatAt;
- error data;
- timestamps.

---

# 5. Permissions и роли

Добавить permissions:

```text
training:take
training:own-results:read
training:projects:read
training:projects:manage
training:results:read
training:results:review
training:attempts:reset
training:audio:read
training:ranking:read
training:telegram:manage
training:data:delete
```

Seed:

- role `user`:
  - `training:take`;
  - `training:own-results:read`;
  - `training:projects:read`.
- new role `training_admin`:
  - `admin:access`;
  - все `training:*`, кроме удаления данных можно оставить только после явного назначения;
  - не давать автоматически права управления пользователями/объектами.
- role `admin`:
  - все permissions.
- role `editor`:
  - никаких административных training permissions автоматически.

`training:audio:read` выдаётся менеджеру через RBAC, а не проверку имени роли в коде.

---

# 6. State machine и domain logic

## 6.1. Старт

1. Пользователь выбирает открытый проект.
2. Backend проверяет:
   - Telegram связан;
   - проект открыт и не истёк дедлайн;
   - нет активной попытки;
   - лимит не исчерпан;
   - cooldown прошёл;
   - пересдача после pass разрешена либо проект ещё не пройден.
3. Бот показывает подтверждение списания попытки.
4. После нажатия `Начать` в одной транзакции:
   - создаётся `TrainingAttempt` с `isConsumed=true`;
   - фиксируется immutable version;
   - случайно выбираются 3 разных follow-up из 10;
   - создаются 4 `TrainingAttemptQuestion`;
   - рассчитываются `expiresAt` и `graceExpiresAt`;
   - ставятся jobs предупреждений и таймаута;
   - отправляется главный вопрос.

## 6.2. Сбор нескольких voice

1. Первый voice создаёт `TrainingAnswer` и первый `TrainingVoiceSegment`.
2. Следующие voice до `Завершить ответ` добавляются как новые segments.
3. Text/audio/document/video_note отклоняются и не создают segment.
4. После каждого segment бот отвечает:
   - `Часть N принята.`
   - кнопки `Завершить ответ` и, пока позволяет время, `Отправить ещё часть`.
5. Callback `Завершить ответ` атомарно переводит answer в `READY` и ставит processing job.
6. Повторный callback/duplicate update не создаёт повторную обработку.

## 6.3. Таймер

- Таймер не останавливается во время обработки ответа.
- Если обработка занимает время, следующая отправка вопроса должна учитывать оставшееся время.
- При достижении `expiresAt`:
  - не открывать новые вопросы;
  - пометить attempt `TIME_EXPIRED` internally;
  - принять максимум один последний segment текущего вопроса до `graceExpiresAt`;
  - автоматически закрыть текущий answer;
  - остальные questions → `SKIPPED_TIMEOUT`;
  - после обработки отправленного материала финализировать attempt.
- После `graceExpiresAt` новые voice игнорируются для этой попытки.

## 6.4. Технические ошибки

- Telegram/OpenAI/S3 429/5xx/timeouts → retry with exponential backoff.
- Invalid provider JSON → retry, затем `REQUIRES_REVIEW`.
- После исчерпания retries не создавать новую попытку.
- Admin может `retry job` или `reset/refund attempt` с причиной и audit log.

---

# 7. Telegram-интеграция

## 7.1. Привязка

Platforma создаёт одноразовый deep link:

```text
https://t.me/<bot_username>?start=<opaque_token>
```

Требования:

- private chat only;
- token до 64 base64url characters;
- cryptographically random;
- short TTL;
- hash in DB;
- атомарное одноразовое использование;
- один активный Telegram account на Platforma user и наоборот;
- конфликт не перепривязывать молча.

## 7.2. Webhook

Route без внутреннего глобального `/api` prefix:

```text
POST /training/telegram/webhook
```

Проверять Telegram secret header. Быстро ACK; тяжёлая работа только через jobs/worker.

Поддержать:

- `/start`;
- список открытых проектов;
- мои результаты;
- правила;
- callback `Начать`;
- callback `Завершить ответ`;
- callback открытия Platforma.

`/cancel` во время активной попытки не отменяет её. Ответить, что попытку нельзя остановить и таймер продолжает идти.

## 7.3. Сообщения

До старта:

> После подтверждения попытка будет списана. На весь экзамен отведено N минут. Экзамен нельзя поставить на паузу или продолжить позже.

После части:

> Часть N принята. Отправьте ещё голосовую часть или завершите ответ.

После вопроса:

> Ответ принят.

Финал:

> Результат: 82/100. Аттестация пройдена. Осталось попыток: 2.

При review:

> Предварительный результат: 76/100. Ответ содержит сведения, требующие проверки администратором. Итог будет обновлён после проверки.

---

# 8. Аудио, ffmpeg и акустические метрики

Telegram voice обычно приходит как Opus-контейнер, а актуальный OpenAI upload endpoint не принимает OGG напрямую. Поэтому worker обязан нормализовать файл.

## 8.1. Pipeline

1. Получить file metadata через Telegram `getFile`.
2. Проверить ограничение cloud Bot API download, размер и duration.
3. Скачать original segment.
4. Сохранить original segment в private bucket бессрочно.
5. Через `ffprobe` проверить codec/duration/channels/sample rate.
6. Для каждой части создать временный WAV PCM 16 kHz mono.
7. Объединить части одного ответа в один WAV.
8. Выполнить `ffmpeg silencedetect` для пауз.
9. Отправить combined WAV на transcription provider.
10. Удалить временные нормализованные файлы после успешной обработки.

Добавить `ffmpeg` в API/worker Docker image. Запускать только через безопасный `spawn` с массивом аргументов, никогда не строить shell-команду из пользовательского имени файла.

## 8.2. Метрики

Детерминированно считать:

- суммарную длительность voice;
- длительность речи без длинных пауз;
- words per minute;
- количество и суммарную длительность пауз;
- максимальную паузу;
- filler words из настраиваемого русского словаря;
- прямые повторы слов и n-gram repetitions;
- долю повторов;
- количество незавершённых фраз/дисфлюенций по консервативной эвристике.

Не делать медицинские/психологические выводы и не оценивать «уверенность» по тембру.

---

# 9. OpenAI providers

## 9.1. Транскрибация

Provider interface не зависит от конкретного SDK.

Рекомендуемый default на дату плана:

```text
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

Fallback/reprocessing:

```text
OPENAI_TRANSCRIPTION_REVIEW_MODEL=gpt-4o-transcribe
```

Передавать language `ru` и короткий approved vocabulary prompt с названием ЖК, застройщиком и профессиональными терминами. Не передавать эталонный полный ответ, чтобы не исказить transcript.

Сохранять:

- actual model ID;
- request ID;
- latency;
- usage;
- transcript;
- provider error classification.

## 9.2. Оценивание

Рекомендуемый cost-efficient default на дату плана:

```text
OPENAI_EVALUATION_MODEL=gpt-5.6-luna
OPENAI_EVALUATION_REASONING=low
```

Для повторной проверки спорных случаев:

```text
OPENAI_REVIEW_MODEL=gpt-5.6-terra
OPENAI_REVIEW_REASONING=medium
```

Модели задаются env и должны быть заменяемыми без миграции кода. После калибровки закрепить конкретный snapshot/model ID в каждой evaluation record.

Использовать Responses API и strict Structured Outputs. Для запроса оценки использовать `store: false` там, где это поддерживается.

LLM получает только:

- текст вопроса;
- transcript;
- approved facts и aliases;
- criteria и anchors;
- акустические/текстовые метрики;
- правила штрафов;
- IDs сущностей.

LLM не получает web search и не должна использовать внешние знания.

## 9.3. Structured output

Логическая схема:

```json
{
  "schema_version": "1",
  "answer_relevance": "relevant|partial|irrelevant",
  "fact_assessments": [
    {
      "fact_id": "uuid",
      "verdict": "correct|partial|missing|incorrect|unsupported",
      "evidence": "короткий фрагмент transcript",
      "explanation": "кратко",
      "confidence": 0.0
    }
  ],
  "unsupported_claims": [
    {
      "claim": "пересказ утверждения",
      "evidence": "фрагмент transcript",
      "confidence": 0.0
    }
  ],
  "criterion_assessments": [
    {
      "criterion_id": "uuid",
      "suggested_points": 0,
      "evidence": "фрагмент или метрики",
      "explanation": "кратко"
    }
  ],
  "summary": "1–3 предложения",
  "requires_manual_review": false,
  "review_reasons": []
}
```

Backend обязан:

- валидировать JSON Schema;
- отвергать неизвестные IDs;
- проверять, что evidence существует в transcript или опирается на переданные метрики;
- считать points сам;
- применять `−5` за distinct incorrect fact;
- не штрафовать unsupported до review;
- clamp score;
- сохранять AI output и server calculation отдельно.

Никаких chain-of-thought в БД или UI.

---

# 10. Document ingestion

Расширить server-side training upload, не превращая общий пользовательский upload в приём произвольных файлов.

Поддерживаемые MIME/ext:

- PDF;
- DOCX;
- PPTX;
- XLSX.

Сделать adapter interface:

```text
TrainingDocumentExtractor
- supports(mimeType, extension)
- extract(buffer) -> text + structured locators + metadata
```

Adapters:

- PDF text extractor;
- DOCX paragraphs/tables;
- PPTX slide text;
- XLSX sheet/cell text.

Безопасность:

- allow-list MIME и extension;
- maximum file bytes;
- maximum uncompressed bytes;
- maximum entries for ZIP-based formats;
- extraction timeout;
- maximum extracted characters;
- filename sanitization;
- no macros execution;
- no formulas evaluation from XLSX;
- no external links fetching.

После extraction admin создаёт/подтверждает structured facts. Публикация невозможна, если обязательные facts не подтверждены.

---

# 11. API

Фактические Nest controller paths без глобального `/api` prefix.

## Employee

```text
GET    /training/projects
GET    /training/projects/:id
GET    /training/attempts
GET    /training/attempts/:id
GET    /training/telegram/account
POST   /training/telegram/link-tokens
DELETE /training/telegram/account
POST   /training/projects/:id/start-link
```

Employee attempt response не должен включать transcript, errors, unsupported claims, audio keys или admin notes.

## Admin

```text
GET/POST/PATCH /training/admin/projects
POST           /training/admin/projects/:id/draft-version
POST           /training/admin/versions/:id/publish
POST           /training/admin/projects/:id/open
POST           /training/admin/projects/:id/close
POST           /training/admin/projects/:id/archive
CRUD           /training/admin/versions/:id/questions
CRUD           /training/admin/versions/:id/facts
CRUD           /training/admin/versions/:id/criteria
POST           /training/admin/versions/:id/documents
GET            /training/admin/results
GET            /training/admin/results/:attemptId
POST           /training/admin/results/:attemptId/review
POST           /training/admin/attempts/:attemptId/retry
POST           /training/admin/attempts/:attemptId/refund
GET            /training/admin/ranking
GET            /training/admin/ranking/export.csv
GET            /training/admin/answers/:answerId/audio
DELETE         /training/admin/users/:userId/training-data
```

## Integration

```text
POST /training/telegram/webhook
```

Все endpoints защищать от IDOR и проверять permissions backend-ом.

---

# 12. Frontend

## 12.1. Employee `/training`

Показать:

- Telegram connected/not connected;
- открытые проекты в заданном admin порядке;
- дедлайн;
- cooldown;
- pass score;
- attempts used/left;
- best score;
- last score;
- status;
- кнопку `Пройти в Telegram`;
- собственную историю;
- breakdown разрешённых критериев.

Не показывать:

- общий рейтинг;
- transcript;
- ошибки;
- unsupported claims;
- audio;
- admin review notes.

## 12.2. Admin projects

Разделы:

1. Основное и optional связь с ЖК.
2. Доступность, порядок, дедлайн, cooldown, attempts, timer, retake-after-pass.
3. Материалы.
4. Главный вопрос.
5. 10 дополнительных вопросов.
6. Факты и источники.
7. Критерии и баллы.
8. Preview/validation/publish.

## 12.3. Admin results

- server-side filters: пользователь, проект, дата, score, status, review;
- timeline;
- четыре вопроса;
- все voice segments;
- защищённый audio player;
- transcript;
- acoustic metrics;
- criteria breakdown;
- incorrect facts;
- unsupported claims;
- AI/server/admin/final scores;
- summary 1–3 предложения;
- model/prompt/schema versions;
- review form с обязательным комментарием.

## 12.4. Rating

Таблица с обязательными колонками и возможностью раскрыть проекты пользователя. Добавить CSV export; XLSX export можно отложить, поскольку CSV достаточно для технического MVP.

---

# 13. Durable jobs и worker

MVP: PostgreSQL-backed queue.

Job types:

```text
TELEGRAM_DOWNLOAD_SEGMENT
ASSEMBLE_ANSWER_AUDIO
TRANSCRIBE_ANSWER
ANALYZE_ACOUSTICS
EVALUATE_ANSWER
FINALIZE_ATTEMPT
SEND_TELEGRAM_MESSAGE
SEND_TIMER_WARNING
EXPIRE_ATTEMPT
EXTRACT_SOURCE_DOCUMENT
```

Требования:

- atomic claim;
- `FOR UPDATE SKIP LOCKED` или безопасный эквивалент;
- heartbeat;
- stale job recovery;
- exponential backoff + jitter;
- idempotency key;
- dead-letter status;
- admin retry;
- отдельный entrypoint и Docker service;
- graceful shutdown;
- structured logs без transcript/audio/token.

---

# 14. Env

Добавить в `.env.example`, `apps/api/.env.example`, Compose и deployment docs:

```text
TRAINING_MODULE_ENABLED=true
TRAINING_WORKER_ENABLED=true
TRAINING_WORKER_POLL_INTERVAL_MS=1000
TRAINING_WORKER_CONCURRENCY=3

TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_WEBHOOK_URL=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_LINK_TOKEN_TTL_MINUTES=15

OPENAI_API_KEY=
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
OPENAI_TRANSCRIPTION_REVIEW_MODEL=gpt-4o-transcribe
OPENAI_EVALUATION_MODEL=gpt-5.6-luna
OPENAI_EVALUATION_REASONING=low
OPENAI_REVIEW_MODEL=gpt-5.6-terra
OPENAI_REVIEW_REASONING=medium

TRAINING_AUDIO_BUCKET=platforma-training-private
TRAINING_AUDIO_RETENTION_DAYS=0
TRAINING_MAX_TELEGRAM_FILE_BYTES=20000000
TRAINING_MAX_OPENAI_FILE_BYTES=25000000
TRAINING_FINISH_GRACE_SECONDS=90
TRAINING_WARNING_SECONDS=60,20
TRAINING_MANUAL_REVIEW_SCORE_MARGIN=3

TRAINING_MAX_DOCUMENT_BYTES=52428800
TRAINING_MAX_EXTRACTED_CHARACTERS=1000000
TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS=30000
```

Production secrets не коммитить.

---

# 15. Пошаговая реализация

## Этап 0. Актуализация аудита и документы

Создать:

- `docs/training/00-repository-audit.md`;
- `docs/training/01-architecture-decision.md`;
- `docs/training/02-implementation-checklist.md`;
- `docs/training/03-security-and-data-flow.md`.

Проверить drift ветки `on-ser`, текущие модели, routes, storage, Docker и tests. Production-код не менять.

**Готово:** точные пути и зависимости подтверждены, никаких догадок о коде.

## Этап 1. Каркас, routing, feature flag и RBAC

- `TrainingModule`;
- config validation;
- permissions и role `training_admin`;
- shared contracts skeleton;
- аккуратная подготовка routes/navigation;
- пустые permission-protected pages;
- contract tests.

**Готово:** приложение собирается, старые routes работают, доступы корректны.

## Этап 2. Prisma schema и миграции

- все content/version/Telegram/attempt/answer/review/job models;
- indexes/unique constraints;
- migration;
- seed permissions/role;
- serialization helpers;
- schema tests.

**Готово:** migration up на чистой и существующей БД, build/tests green.

## Этап 3. Проекты, версии и админка контента

- CRUD project/draft;
- optional RealEstateObject link;
- questions/facts/criteria;
- settings;
- validation 1+10, 55/15;
- publish immutable version;
- open/close/order/deadline;
- audit log;
- admin UI.

**Готово:** admin вручную создаёт и публикует полностью валидный проект.

## Этап 4. Документы

- private training upload;
- PDF/DOCX/PPTX/XLSX adapters;
- extraction jobs;
- source locators;
- `NEEDS_MANUAL_TEXT`;
- security limits;
- tests fixtures.

**Готово:** каждый формат извлекается, факты подтверждаются вручную.

## Этап 5. Attempt engine с fake providers

- start checks;
- immediate consumption;
- cooldown/deadline/retake rules;
- secure random 3/10 selection;
- state machine;
- multi-segment answer domain;
- timer and grace;
- deterministic fake transcript/evaluation;
- server scoring;
- unit/integration tests.

**Готово:** полный fake-flow 1+3 завершается без Telegram/OpenAI.

## Этап 6. Telegram link и webhook

- token hash/TTL;
- connect/reconnect/revoke;
- webhook secret;
- update idempotency;
- private chat only;
- inline buttons;
- voice-only validation;
- multi-part UX;
- start warning;
- timer notifications.

**Готово:** fake Telegram fixtures проходят весь сценарий.

## Этап 7. Private audio + ffmpeg + worker

- separate worker entrypoint/container;
- PostgreSQL jobs;
- Telegram download;
- original private storage;
- ffmpeg/ffprobe;
- WAV assembly;
- acoustic metrics;
- protected playback;
- cleanup temp files;
- retries/recovery.

**Готово:** несколько voice объединяются, аудио доступно только по permission.

## Этап 8. Real OpenAI providers

- transcription provider;
- evaluation provider;
- strict schema;
- `store:false`;
- usage/latency/request IDs;
- fallback review model;
- prompt injection defense;
- provider fixture tests.

**Готово:** opt-in real smoke test и полный fake CI suite.

## Этап 9. Review, finalization и employee result

- unsupported claim review;
- AI/server/admin/final score;
- pass/fail/pending review;
- Telegram concise result;
- employee Platforma breakdown;
- best score;
- remaining attempts;
- technical failure refund.

**Готово:** visibility rules не дают сотруднику transcript/errors.

## Этап 10. Admin results и ranking

- filters;
- audio/transcript/evidence;
- manual override;
- ranking formula;
- CSV export;
- audit;
- pagination/performance.

**Готово:** admin видит все обязательные колонки, user — нет.

## Этап 11. Security, observability и deploy

- consent;
- private bucket;
- audit of audio access;
- rate limiting;
- data delete/anonymize;
- structured logs;
- worker health/readiness;
- Compose/Docker/Nginx/webhook docs;
- backup/rollback;
- feature flag rollout.

**Готово:** production checklist и rollback проверены.

## Этап 12. Pilot и calibration

Пилотный проект — `ЖК Шагал`, когда предоставлены утверждённые материалы и вопросы.

- загрузить 1+10;
- 20–30 примеров voice: плохие/средние/хорошие;
- expert scores;
- сравнить AI vs expert;
- настроить prompt/rubric;
- проверить false penalties и unsupported claims;
- запуск на небольшой группе;
- затем остальные проекты через админку.

**Готово:** согласованные acceptance thresholds и реальный E2E.

---

# 16. Обязательные тесты

Unit/integration:

1. Попытка списывается при старте.
2. Брошенная попытка сгорает.
3. Системный сбой можно refund без четвёртой попытки.
4. Limit default 3 и custom limit.
5. Cooldown 1h..24h.
6. Deadline 1..7 days.
7. Retake-after-pass per project.
8. Ровно 3 разных random follow-up из 10.
9. Повтор вопросов между попытками разрешён.
10. Text/audio/document не принимаются как voice.
11. Несколько voice становятся одним answer.
12. Duplicate Telegram update не создаёт segment/job.
13. `Завершить ответ` идемпотентна.
14. Таймер закрывает попытку, unanswered = 0.
15. Grace принимает только последнюю часть текущего ответа.
16. MAIN criteria sum 55, FOLLOW_UP sum 15.
17. Итог 100 и clamp.
18. Каждая distinct incorrect fact = −5.
19. Unsupported claim без штрафа, но обязательный review.
20. Admin override сохраняет AI score.
21. Best result использует final reviewed score.
22. User не получает transcript/errors/audio/ranking.
23. `training:audio:read` позволяет protected playback.
24. Published version immutable.
25. Новая версия не меняет старые attempts.
26. Optional RealEstateObject relation работает с null.
27. PDF/DOCX/PPTX/XLSX extraction fixtures.
28. Zip bomb/oversize/timeouts отклоняются.
29. Worker restart восстанавливает stale job.
30. OpenAI invalid schema/retry/429 fixtures.

Commands:

```text
pnpm build
pnpm --filter @platforma/api test
pnpm --filter @platforma/web test
pnpm test
```

Не писать «lint пройден», пока отдельного lint script нет.

---

# 17. Definition of Done

- Training встроен в существующую Platforma.
- Пользователь связывает Telegram одноразовой ссылкой.
- У всех одинаковый глобально управляемый список проектов.
- Проект опционально связан с ЖК.
- Admin публикует immutable version с 1 main + 10 follow-up.
- Попытка списывается при старте и длится общий configurable 5–7 минут.
- Бот принимает только voice и несколько частей на вопрос.
- Backend случайно выбирает 3 разных follow-up.
- Вопросы никогда не генерируются ИИ.
- Оригинальное аудио приватно хранится бессрочно.
- OGG/Opus безопасно нормализуется через ffmpeg.
- Расшифровка и оценка асинхронны, идемпотентны и переживают restart.
- Main 55 + 3×15 = 100.
- Incorrect facts дают −5, unsupported claims требуют review без автштрафа.
- AI output structured, итог считает backend.
- `admin` и `training_admin` могут проверить/изменить оценку.
- Employee не видит transcript/errors/ranking.
- Telegram показывает только итог/status/attempts left.
- Admin видит обязательный ranking и полный разбор.
- Все tests/build проходят.
- Есть security/deploy/rollback docs.

---

# 18. Формат отчёта Codex после каждого этапа

1. Что проверено и реализовано.
2. Архитектурные решения.
3. Изменённые файлы.
4. Миграции.
5. Новые зависимости и зачем они нужны.
6. Запущенные команды и результаты.
7. Риски/ограничения.
8. Что осталось в checklist.
9. Точный следующий этап — без его автоматического выполнения.

---

# 19. Первый запрос к Codex

После добавления этого файла в репозиторий отправить Codex:

```text
Прочитай целиком файл codex_training_module_final_ru.md.

Выполни только Этап 0: актуализация аудита и архитектурные документы.
Не изменяй production-код, Prisma schema и зависимости.
Не переключай ветку on-ser и не трогай чужие/untracked файлы.

В конце покажи:
1. найденный drift относительно мастер-плана;
2. точные будущие пути файлов;
3. необходимые новые зависимости с обоснованием;
4. риски миграции и интеграции;
5. созданные docs/training файлы;
6. результаты существующих build/tests.

После отчёта остановись и не начинай Этап 1.
```
