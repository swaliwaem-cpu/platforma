# Training OpenAI provider deployment

Дата актуализации: 2026-07-27.

Документ описывает только production/staging-контракт этапа 8. Он не разрешает
production deploy или billable smoke без отдельного решения.

## Runtime topology

`api` валидирует конфигурацию, ставит PostgreSQL jobs и обслуживает защищённый
review/reprocessing API. OpenAI HTTP requests выполняет только
`training-worker`. Оба process в production fail-fast при включённом training,
если `OPENAI_PROVIDER_MODE` не `real`, ключ отсутствует или похож на
placeholder. При `NODE_ENV=production`, включённом training и real mode все
шесть model/reasoning variables должны быть заданы явно: development defaults
в этом режиме не используются.

Используются только native Node 22 `fetch`, `FormData`, `Blob` и
`AbortController`:

- `POST /v1/audio/transcriptions`;
- `POST /v1/responses`.

Fallback на fake provider в real mode отсутствует.

## Structured evaluation contract

Responses request использует `store:false`, `reasoning.effort` из env,
bounded `max_output_tokens`, не задаёт `temperature` и не передаёт tools,
search, conversation/background state или `previous_response_id`.

Strict JSON Schema требует:

```json
{
  "schema_version": "openai-evaluation-v1",
  "answer_relevance": "RELEVANT",
  "criteria": [
    {
      "criterion_id": "uuid",
      "anchor_id": "approved-anchor-id",
      "evidence_source": "TRANSCRIPT",
      "evidence": "exact transcript substring",
      "metric_id": null,
      "explanation": "кратко"
    }
  ],
  "facts": [
    {
      "fact_id": "uuid",
      "verdict": "CORRECT",
      "claim": null,
      "evidence_source": "TRANSCRIPT",
      "evidence": "exact transcript substring",
      "metric_id": null,
      "explanation": "кратко",
      "confidence": 0.99
    }
  ],
  "summary": "1–3 предложения.",
  "requires_manual_review": false,
  "review_reasons": []
}
```

Все object schemas запрещают `additionalProperties`. Backend повторно
проверяет schema version, allowed enums, confidence `0..1`, размеры
строк/массивов, полное покрытие переданных facts/criteria, IDs, approved
anchors и exact transcript/metric evidence. Модель не возвращает points,
final score или pass/fail.

Для TRANSCRIPT обе стороны приводятся к NFC, CRLF/NBSP/whitespace
нормализуются, затем применяется только case-sensitive `includes`;
lowercase/fuzzy matching отсутствует. Любой verdict, кроме `UNSUPPORTED`,
обязан ссылаться на известный `fact_id` и иметь `claim=null`. `UNSUPPORTED`
обязан иметь `fact_id=null`, непустой claim и transcript evidence. Claim не
может совпадать с approved statement/alias; containment запрещён для строк
длиной от 16 символов. Нарушение считается invalid provider output и проходит
существующий bounded retry.

## Safe transcription vocabulary

Transcription prompt никогда не содержит `TrainingFact.statement` или полный
правильный ответ. Источники ограничены структурированными именами проекта,
объекта, застройщика, locations/metro и короткими approved aliases/
профессиональными терминами.

Builder применяет NFC, trim/whitespace normalization, отбрасывает multiline и
sentence-like значения, aliases длиннее шести слов и terms длиннее 80
символов, дедуплицирует и ограничивает результат 64 terms. Version и SHA-256
вычисляются детерминированно; transcript никогда не дополняется vocabulary
после ответа provider.

## Environment contract

| Variable | Default | Назначение |
| --- | --- | --- |
| `OPENAI_PROVIDER_MODE` | `fake` local; `real` production overlay | выбор provider |
| `OPENAI_API_KEY` | empty | secret, обязателен только для real |
| `OPENAI_TRANSCRIPTION_MODEL` | local default; production explicit | primary transcription |
| `OPENAI_TRANSCRIPTION_REVIEW_MODEL` | local default; production explicit | explicit reprocessing |
| `OPENAI_EVALUATION_MODEL` | local default; production explicit | primary evaluation |
| `OPENAI_EVALUATION_REASONING` | local default; production explicit | primary effort |
| `OPENAI_REVIEW_MODEL` | local default; production explicit | review/reprocessing |
| `OPENAI_REVIEW_REASONING` | local default; production explicit | review effort |
| `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | `60000` | transcription deadline |
| `OPENAI_EVALUATION_TIMEOUT_MS` | `120000` | Responses deadline |
| `OPENAI_TRANSCRIPTION_MAX_RETRIES` | `2` | bounded transcription retries |
| `OPENAI_EVALUATION_MAX_RETRIES` | `2` | bounded evaluation retries |
| `OPENAI_TRANSCRIPTION_MAX_BYTES` | `25165824` | upload limit, strictly below 25 MiB |
| `OPENAI_MAX_RESPONSE_BYTES` | `2097152` | bounded response body |
| `OPENAI_EVALUATION_MAX_OUTPUT_TOKENS` | `4096` | structured output limit |
| `OPENAI_SMOKE_ENABLED` | `false` | explicit billable smoke gate |

Production Compose использует `${VARIABLE:?message}` для key и всех шести
model/reasoning choices в `api` и `training-worker`. Key validation не зависит
от одного префикса: marker placeholders, repeated masks, whitespace,
недостаточная длина/вариативность отклоняются без включения key в ошибку.
Secrets не коммитятся, не попадают в Compose config output, audit metadata или
application logs.

## Persisted request lifecycle

```text
PENDING intent
  -> REQUESTING (committed before fetch)
  -> SUCCEEDED + immutable transcript/evaluation version
  -> active version pointer

REQUESTING + timeout/network/crash before persisted response
  -> AMBIGUOUS
  -> TECHNICAL_FAILURE
  -> explicit reviewer reprocessing creates a new run
```

Внешний request не выполняется внутри DB transaction. `429/5xx`,
timeout/network, response read/validation, backoff и `Retry-After` sleep имеют
bounded retry внутри одного monotonic hard deadline. Исчерпание даёт
детерминированный `DEADLINE_EXCEEDED`. Поэтому система гарантирует intent и
отсутствие нового durable/restart-повтора неоднозначного вызова, но не
exactly-once billing.

## Protected admin API

Все endpoints требуют JWT и `training:results:review`:

- `GET /training/admin/results/:attemptId`;
- `POST /training/admin/results/:attemptId/review`;
- `POST /training/admin/answers/:answerId/reprocess-transcription`;
- `POST /training/admin/answers/:answerId/reprocess-evaluation`.

Review POST требует валидный `Idempotency-Key` header и comment. Каждый
текущий unsupported component получает решение
`ACCEPTED` или `INCORRECT`; только reviewer-confirmed `INCORRECT` добавляет
`−5`. Override требует `adminScore` и непустую причину. Canonical payload hash
и key сохраняются с DB unique `(attempt_id, reviewer_id, idempotency_key)`.
Повтор того же key/payload возвращает текущий result без новой review/audit/
penalty, другой payload получает `409`. История и audit не перезаписываются.

Composite PostgreSQL foreign keys гарантируют, что active transcription/
evaluation и provider run принадлежат тому же `TrainingAnswer`. Миграционный
preflight падает до создания constraints при наличии cross-answer history и
не исправляет данные автоматически.

## Deployment checklist

1. Применить Prisma migrations до запуска новых containers.
2. Проверить dedicated private audio bucket и stage-7 privacy probe.
3. Задать production OpenAI key через secret store, явно задать все шесть
   model/reasoning variables и оставить `OPENAI_SMOKE_ENABLED=false`.
4. Проверить в OpenAI project data controls допустимость передачи тестовых
   audio/transcript, retention policy и отсутствие ненужного provider-side
   хранения.
5. Проверить `docker compose -f docker-compose.yml -f
   docker-compose.production.yml --env-file .env.production config`.
6. Запустить `api` и `training-worker`; оба должны пройти fail-fast config.
7. На staging проверить один consented test answer, provider run metadata,
   active version pointers и отсутствие transcript/audio в logs.
8. Проверить manual review и explicit reprocessing на тестовой попытке.

## Opt-in smoke

Команда является billable и по умолчанию завершится до network call:

```bash
OPENAI_SMOKE_ENABLED=true \
OPENAI_PROVIDER_MODE=real \
OPENAI_API_KEY=... \
pnpm --filter @platforma/api test:training:openai:smoke
```

Smoke отправляет ровно один синтезированный короткий WAV и ровно один strict
structured evaluation request с retries `0`. Он валидирует completed/refusal/
incomplete/output/schema version и выводит только success/failure, model,
request ID, usage и latency без transcript/prompt/output. В этапе 8 smoke не
запускался.

## Rollback

Остановить новый worker, вернуть предыдущий image и оставить аддитивную
миграцию на месте. Новые таблицы/columns не удалять: они содержат историю
provider intents и результатов. Jobs с `REQUESTING` после аварийного rollback
считать неоднозначными и не повторять автоматически.
