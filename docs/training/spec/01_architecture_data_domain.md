# Архитектура, Prisma-модель, RBAC и domain logic

> Источник: финальный мастер-план от 25.07.2026. Этот файл является частью разбитой спецификации.

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
  - не получает `training:*` до отдельной команды открытия обучения всем.
- temporary role `training_pilot`:
  - все базовые permissions роли `user`;
  - `training:take`;
  - `training:own-results:read`;
  - не получает административные `training:*`.
- new role `training_admin`:
  - `admin:access`;
  - административные `training:*` без `training:take`,
    `training:own-results:read` и удаления данных;
  - не давать автоматически права управления пользователями/объектами.
- role `admin`:
  - административные permissions, но без `training:take` и
    `training:own-results:read`, чтобы администратор не считался участником
    закрытого пилота.
- role `editor`:
  - никаких административных training permissions автоматически.

`training:audio:read` выдаётся менеджеру через RBAC, а не проверку имени роли в коде.
Employee-раздел `/training`, config, policy и список доступных проектов
проверяют `training:take`; `training:projects:read` остаётся административным
read-scope.

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
