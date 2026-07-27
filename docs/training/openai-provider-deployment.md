# Training OpenAI provider deployment

Дата актуализации: 2026-07-27.

Документ описывает только production/staging-контракт этапа 8. Он не разрешает
production deploy или billable smoke без отдельного решения.

## Runtime topology

`api` валидирует конфигурацию, ставит PostgreSQL jobs и обслуживает защищённый
review/reprocessing API. OpenAI HTTP requests выполняет только
`training-worker`. Оба process в production fail-fast при включённом training,
если `OPENAI_PROVIDER_MODE` не `real`, ключ отсутствует или похож на
placeholder.

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

## Environment contract

| Variable | Default | Назначение |
| --- | --- | --- |
| `OPENAI_PROVIDER_MODE` | `fake` local; `real` production overlay | выбор provider |
| `OPENAI_API_KEY` | empty | secret, обязателен только для real |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe-2025-12-15` | primary transcription |
| `OPENAI_TRANSCRIPTION_REVIEW_MODEL` | `gpt-4o-transcribe` | explicit reprocessing |
| `OPENAI_EVALUATION_MODEL` | `gpt-5.6-terra` | primary evaluation |
| `OPENAI_EVALUATION_REASONING` | `medium` | primary effort |
| `OPENAI_REVIEW_MODEL` | `gpt-5.6-terra` | review/reprocessing |
| `OPENAI_REVIEW_REASONING` | `high` | review effort |
| `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | `60000` | transcription deadline |
| `OPENAI_EVALUATION_TIMEOUT_MS` | `120000` | Responses deadline |
| `OPENAI_TRANSCRIPTION_MAX_RETRIES` | `2` | bounded transcription retries |
| `OPENAI_EVALUATION_MAX_RETRIES` | `2` | bounded evaluation retries |
| `OPENAI_TRANSCRIPTION_MAX_BYTES` | `25165824` | upload limit, strictly below 25 MiB |
| `OPENAI_MAX_RESPONSE_BYTES` | `2097152` | bounded response body |
| `OPENAI_EVALUATION_MAX_OUTPUT_TOKENS` | `4096` | structured output limit |
| `OPENAI_SMOKE_ENABLED` | `false` | explicit billable smoke gate |

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
timeout/network и временно malformed upstream response имеют bounded retry
внутри общего hard deadline. Поэтому система гарантирует сохранённый intent и
отсутствие нового durable/restart-повтора неоднозначного вызова, но не
exactly-once billing.

## Protected admin API

Все endpoints требуют JWT и `training:results:review`:

- `GET /training/admin/results/:attemptId`;
- `POST /training/admin/results/:attemptId/review`;
- `POST /training/admin/answers/:answerId/reprocess-transcription`;
- `POST /training/admin/answers/:answerId/reprocess-evaluation`.

Review требует comment. Каждый текущий unsupported component получает решение
`ACCEPTED` или `INCORRECT`; только reviewer-confirmed `INCORRECT` добавляет
`−5`. Override требует `adminScore`. История и audit не перезаписываются.

## Deployment checklist

1. Применить Prisma migrations до запуска новых containers.
2. Проверить dedicated private audio bucket и stage-7 privacy probe.
3. Задать production OpenAI key через secret store и оставить
   `OPENAI_SMOKE_ENABLED=false`.
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

Smoke отправляет синтезированный короткий WAV и один strict structured
evaluation request. Он выводит только safe request/model/status metadata, но
не transcript или response body. В этапе 8 smoke не запускался.

## Rollback

Остановить новый worker, вернуть предыдущий image и оставить аддитивную
миграцию на месте. Новые таблицы/columns не удалять: они содержат историю
provider intents и результатов. Jobs с `REQUESTING` после аварийного rollback
считать неоднозначными и не повторять автоматически.
