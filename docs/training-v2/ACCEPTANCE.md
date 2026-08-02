# Acceptance: Stage 3

## Критерии готовности к ручной приёмке

- New project хранит facts и criteria, публикуется только при валидных `1 + 10`,
  facts на каждый question, aliases и точных totals `55/15`.
- New attempt snapshot schema v2 замораживает settings, 11 questions, facts,
  criteria и schema versions; старые schema v1 attempts не конвертируются.
- `TRAINING_AI_MODE=openai` использует только backend OpenAI implementations и
  требует API key без fallback на fake.
- Transcription отправляет один проверенный private merged WAV в
  `/v1/audio/transcriptions`; vocabulary не содержит full facts/scoring/PII.
- Evaluation отправляет только current answer context в `/v1/responses` с
  `store=false`, без tools/web/files и с strict JSON Schema.
- Backend проверяет exact IDs/evidence, считает objective metrics, criteria sum,
  distinct `−5` penalties и final score. Unsupported claim требует review и не
  получает автоматический штраф.
- Transcription и validated evaluation сохраняются отдельными checkpoints;
  restart не повторяет уже сохранённый step и не дублирует progression.
- Исчерпанный provider failure создаёт `TECHNICAL_FAILED`, возвращает попытку и
  позволяет replacement attempt.
- Review permission/endpoint разрешает одноразовые idempotent `APPROVE` и
  `OVERRIDE`; employee pending/override/technical DTO остаётся безопасным.
- Admin видит facts/evidence/criteria/metrics/models/calculated/final score, но не
  secrets, raw provider body, prompt, private storage key или chain-of-thought.
- Нет Stage 4/5 infrastructure и production deploy.

## Automated fake/stub acceptance

Все сценарии ниже не обращаются к `api.openai.com` и реальному Telegram.

1. `prisma validate` и `prisma generate` проходят на текущей schema.
2. Все migrations применяются на чистой временной PostgreSQL.
3. Upgrade Stage 2 → Stage 3 сохраняет schema v1 snapshot/status/final score и
   backfill-ит только additive Stage 3 columns.
4. Unit/domain tests проверяют facts/aliases, totals `55/15`, snapshot v1/v2,
   metrics, strict evaluation IDs/evidence, score clamps, distinct penalties и
   unsupported review.
5. Transcription local HTTP stub проверяет реальный multipart: one WAV part,
   model, `language=ru`, bounded vocabulary, timeout/retry/4xx/malformed cases.
6. Evaluation local HTTP stub проверяет реальный Responses body: model,
   reasoning, `store=false`, strict schema, trust boundary, запрещённые fields,
   refusal/incomplete/invalid IDs/evidence/injection/retry/4xx cases.
7. PostgreSQL tests проверяют snapshot immutability, both checkpoints/restart,
   exactly-once progression/finalization, technical refund/replacement и review
   idempotency/conflict.
8. HTTP/RBAC tests проверяют project PATCH/publish errors, denied employee review,
   allowed admin review и safe pending/override/technical employee DTO.
9. Web source tests и targeted Playwright production-preview harness проверяют
   facts/criteria totals, evaluation detail, approve/override duplicate-submit
   protection и employee states без sensitive rendering.
10. Full API/web/workspace tests, builds, `git diff --check`, `.only`/`.skip`,
    test-env, lockfile и scope scans проходят.
11. Временные databases удаляются после проверок.

## Opt-in synthetic OpenAI smoke — только вручную

Обычные tests никогда не запускают этот smoke. Требуются одновременно:

- `TRAINING_AI_MODE=openai`;
- `OPENAI_SMOKE_ENABLED=true`;
- непустой `OPENAI_API_KEY` в untracked environment.

Запуск из repository root:

`pnpm test:training:openai:smoke`

Smoke генерирует короткий mono PCM WAV 16 kHz, отключает retries, выполняет ровно
один transcription request и один strict evaluation request с synthetic
facts/criteria. Он не печатает transcript, prompt, structured evaluation или
API key; выводит только status, requested/actual models, request IDs, usage и
latency. Без любого обязательного флага выводит explicit skip.

Этот smoke не выполняется автоматически и не доказывает Telegram integration.

## Real Telegram voice + OpenAI — только вручную

Не использовать production webhook и не выполнять production deploy.

Подготовка:

- отдельная test database и private test audio bucket;
- test Telegram bot/webhook/tunnel по процедуре принятого Stage 2;
- `TRAINING_AI_MODE=openai`, временный `OPENAI_API_KEY`, pinned models и bounded
  timeouts/retries только в untracked environment;
- draft project с 11 вопросами, approved facts каждого question и criteria
  totals `55/15`; затем publish/open.

Проверка:

1. Employee проходит real Telegram voice MAIN + 3 FOLLOW_UP.
2. Для каждого answer originals/merged private WAV и ownership остаются Stage 2;
   transcript сохраняется до evaluation, provider metadata не содержит secret.
3. Restart после transcription продолжает evaluation без второй transcription;
   restart после saved evaluation не делает второй evaluation request.
4. Valid result завершает progression один раз и backend final score совпадает с
   criteria/penalties из admin detail.
5. Ответ с unsupported claim становится `REQUIRES_REVIEW`; employee видит «Требует
   проверки» без provisional score/breakdown/internal data, admin видит evidence.
6. Admin `APPROVE` завершает attempt с `finalScore=calculatedScore`; точный повтор
   не создаёт второй side effect.
7. На новой pending attempt admin `OVERRIDE` задаёт `0..100` и причину; employee
   видит скорректированный final score, нейтральное сообщение и без старого
   breakdown.
8. Безопасно смоделированный non-retryable/исчерпанный provider failure создаёт
   `TECHNICAL_FAILED`, скрывает internal code от employee, не расходует limit и
   позволяет replacement attempt.
9. Проверить отсутствие transcript/evaluation/provider metadata/review comment в
   employee HTTP response, а не только визуально.
10. После smoke удалить test webhook, временный key/config, private test audio и
    test database.

## Definition of Done и переход к Stage 4

Stage 3 остаётся текущим даже после готовности кода и зелёных automated checks.
Только ручное подтверждение synthetic OpenAI smoke и real Telegram + OpenAI
сценариев закрывает этап. Documents/materials Stage 4 и ranking/production
hardening Stage 5 не начинаются без отдельной задачи.
