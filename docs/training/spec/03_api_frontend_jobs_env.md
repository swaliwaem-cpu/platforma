# API, frontend, durable jobs и env

> Источник: финальный мастер-план от 25.07.2026. Этот файл является частью разбитой спецификации.

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
OPENAI_PROVIDER_MODE=fake
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe-2025-12-15
OPENAI_TRANSCRIPTION_REVIEW_MODEL=gpt-4o-transcribe
OPENAI_EVALUATION_MODEL=gpt-5.6-terra
OPENAI_EVALUATION_REASONING=medium
OPENAI_REVIEW_MODEL=gpt-5.6-terra
OPENAI_REVIEW_REASONING=high
OPENAI_TRANSCRIPTION_TIMEOUT_MS=60000
OPENAI_EVALUATION_TIMEOUT_MS=120000
OPENAI_TRANSCRIPTION_MAX_RETRIES=2
OPENAI_EVALUATION_MAX_RETRIES=2
OPENAI_TRANSCRIPTION_MAX_BYTES=25165824
OPENAI_MAX_RESPONSE_BYTES=2097152
OPENAI_EVALUATION_MAX_OUTPUT_TOKENS=4096
OPENAI_SMOKE_ENABLED=false

TRAINING_AUDIO_BUCKET=platforma-training-private
TRAINING_AUDIO_RETENTION_DAYS=0
TRAINING_MAX_TELEGRAM_FILE_BYTES=20000000
TRAINING_FINISH_GRACE_SECONDS=90
TRAINING_WARNING_SECONDS=60,20
TRAINING_MANUAL_REVIEW_SCORE_MARGIN=3

TRAINING_MAX_DOCUMENT_BYTES=52428800
TRAINING_MAX_EXTRACTED_CHARACTERS=1000000
TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS=30000
```

Production secrets не коммитить.

---
