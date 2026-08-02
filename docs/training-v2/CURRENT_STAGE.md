# Current Stage: Stage 3 — OpenAI, Facts, Scoring и Review

## Цель

Подключить реальную backend-only транскрибацию и strict structured evaluation к
существующему Telegram voice flow, закрепить approved facts/criteria в immutable
attempt snapshot, считать итог детерминированно на backend и дать admin один
минимальный review action без раскрытия provisional/internal данных сотруднику.

Код и automated checks могут быть готовы, но текущим этапом остаётся Stage 3 до
ручной проверки OpenAI и полного Telegram + OpenAI flow. Stage 4 и Stage 5 не
начинаются автоматически.

## Входит

- Только две новые основные модели: `TrainingFact` и `TrainingCriterion`.
- Snapshot schema v2 с facts, MAIN/FOLLOW_UP criteria, max points, scoring и
  evaluation schema versions; schema v1 attempts остаются читаемыми без
  destructive conversion.
- Existing project PATCH для atomic draft facts/criteria и existing publish/open
  validation: `1 + 10`, fact на каждый question, aliases bounds, criteria totals
  `55/15`, unique codes.
- Existing admin project editor с facts, aliases, required flag, criteria,
  totals и publication/validation errors; нового route нет.
- `TRAINING_AI_MODE=fake|openai`; OpenAI API key и bounded timeout/retry/model
  settings. Tests принудительно используют fake mode и удаляют inherited key.
- `POST /v1/audio/transcriptions` через native `fetch`/`FormData`, model
  `gpt-4o-mini-transcribe-2025-12-15`, `language=ru`, one verified merged WAV и
  короткий vocabulary prompt без fact statements/scoring.
- Responses API `POST /v1/responses`, model `gpt-5.6-terra`, reasoning `medium`,
  `store=false`, без tools/web/file/external knowledge и со strict JSON Schema.
- Backend evidence/ID validation, objective speech metrics и deterministic
  per-answer/attempt scoring со штрафом `−5` за distinct incorrect fact.
- Unsupported claim без автоматического штрафа переводит attempt в
  `REQUIRES_REVIEW` и скрывает provisional result от employee.
- Persisted transcription/evaluation checkpoints, resume без повторения уже
  сохранённого шага и общий Stage 1/2 progression.
- Terminal `TECHNICAL_FAILED`, refund через
  `countsTowardAttemptLimit=false`, safe employee message и replacement attempt.
- Permission `training:results:review` и единственный новый review endpoint с
  одноразовыми `APPROVE | OVERRIDE` и exact-payload idempotency.
- Existing admin attempt detail с facts/evidence/criteria/metrics/models/scores и
  review form; backend-safe employee pending/overridden/technical DTO.
- Отдельный opt-in OpenAI smoke script, который не входит в обычные tests.

## Не входит

- PDF/DOCX/PPTX/XLSX, documents, parsers, extraction, material library, RAG,
  embeddings, vector store и external knowledge.
- Ranking, rating, CSV, operations dashboard, monitoring stack и notification
  system.
- Separate worker container/app, generic queue/job, outbox, provider-run или
  evaluation/transcription-run tables.
- Полная review history, per-claim resolution, multi-review и reprocessing UI.
- Admin audio endpoint/player, новые frontend routes и новые dependencies.
- Production fail-fast hardening, staging/production deploy, real webhook
  registration, pilot и calibration.

## Реализуемая последовательность

1. Additive schema/migrations, facts/criteria domain, snapshot v2 и publication.
2. OpenAI config/client/transcription и реально сериализованный multipart stub.
3. Responses strict schema, evidence validation, metrics и backend scoring.
4. Processing checkpoints/restart, bounded retries и technical refund.
5. Review/RBAC/visibility, existing admin/employee UI, HTTP/PostgreSQL/browser
   checks, opt-in smoke и канонические документы.
6. Остановиться с отчётом и ждать ручной приёмки Stage 3.

## Ограничения scope

- Ровно две новые основные Prisma models и один новый HTTP endpoint.
- Только existing API process worker; external calls выполняются вне database
  transactions.
- Exactly-once billing не обещается: crash после provider response и до
  checkpoint save может повторить один платный request.
- Stage 1 fake text mode и deterministic fake providers остаются только для
  tests/development. Real mode не fallback-ится на fake.
- Stage 2 Telegram, private audio, random 3/10, timer, attempt limit и immutable
  snapshot principle не меняются.

## Ручная приёмка

Нужны отдельные сценарии из `ACCEPTANCE.md`:

1. opt-in synthetic OpenAI smoke с ровно одной transcription и одной evaluation;
2. real Telegram voice + OpenAI полный `1 + 3` flow;
3. pending review без provisional leakage и `APPROVE`;
4. `OVERRIDE` с final score/reason и безопасным employee result;
5. provider technical failure с refund и replacement attempt.

Production deploy и production Telegram webhook не выполняются.

## Stop conditions

- Появляется третья основная Stage 3 model, второй новый endpoint, provider run,
  job/outbox, document/material/ranking/operations infrastructure.
- OpenAI request содержит passScore/finalScore, другие projects/users, hidden
  future questions, web/files/tools или сохраняется с `store=true`.
- Vocabulary содержит полные fact statements/criteria/scoring или PII.
- Модель определяет final score/pass/fail либо evidence/IDs принимаются без
  backend validation.
- Pending employee DTO раскрывает provisional/internal данные; technical failure
  расходует attempt limit.
- Restart повторяет сохранённый checkpoint либо progression применяется дважды.
- PostgreSQL, HTTP, provider, web, browser, migration или workspace gates красные.
