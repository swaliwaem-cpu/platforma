# Training security and data flow

Дата актуализации: 2026-07-28.

Документ фиксирует границы безопасности этапов 7–9 после независимого review.
HTTP DTO/permissions этапа 9 подробно зафиксированы в
`docs/training/09-results-api.md`.

## Поток данных

```text
Telegram Bot API fixed origin
  -> no-follow getFile
  -> validated relative file_path
  -> no-follow bounded binary download
  -> checksum / size / MIME
  -> PostgreSQL TrainingAudioUploadIntent
  -> private S3 object + SHA-256 metadata
  -> PostgreSQL File link (url = null)
  -> ffprobe / ffmpeg isolated process group
  -> merged private WAV + upload intent
  -> persisted OpenAI provider intent
  -> worker-only Audio Transcriptions request
  -> immutable transcript version
  -> worker-only Responses strict structured evaluation
  -> backend-only deterministic score
  -> protected HTTP bytes + AuditLog
```

Normalized WAV и transcript передаются OpenAI только из `training-worker` в
real mode. Object key, private bucket, storage credentials, Telegram metadata,
bot token, signed headers и download URL OpenAI не передаются и не входят в
публичные ошибки или HTTP JSON.

## Защита исторических результатов

Историческая цепочка использует PostgreSQL `ON DELETE RESTRICT`:

```text
TrainingAttempt
  -> TrainingAttemptQuestion
  -> TrainingAnswer
     -> TrainingVoiceSegment
     -> TrainingProviderRun
     -> TrainingAnswerTranscription
     -> TrainingAnswerEvaluation
        -> TrainingScoreComponent
TrainingAttempt -> TrainingResultReview
File -> segment original / answer merged audio / committed upload intent
```

Текущий transcript/evaluation выбирается через explicit
`activeTranscriptionId`/`activeEvaluationId`; reprocessing добавляет новую
версию, не перезаписывая исходный provider output.

## OpenAI network and prompt boundary

- Разрешён фиксированный origin `https://api.openai.com`; OpenAI SDK не
  используется.
- Transcription принимает только persisted answer-owned private WAV,
  перепроверяет bucket/key/MIME/size/SHA-256 и формат mono 16 kHz 16-bit PCM.
- Upload меньше 25 MiB, `language=ru`, prompt содержит только bounded
  structured names и короткие aliases/professional terms. Полный эталонный
  ответ и `TrainingFact.statement` запрещены.
- Evaluation использует Responses, `store:false`, strict JSON Schema и не
  передаёт tools/search/conversation/background/previous response state.
- Instructions объявляют transcript и весь input JSON недоверенными данными.
- Backend проверяет schema version, exact fields/enums, numeric confidence
  `0..1`, неизвестные/повторные IDs, неутверждённые anchors, полное покрытие
  criteria/facts и evidence. Transcript/evidence сравниваются после NFC и
  CRLF/NBSP/whitespace normalization через case-sensitive `includes`, без
  lowercase/fuzzy matching.
- Non-UNSUPPORTED обязан иметь known `fact_id` и `claim=null`; UNSUPPORTED —
  `fact_id=null`, claim и transcript evidence. Совпадение/достаточно длинное
  containment approved statement/alias отклоняется как invalid output.
- Ответ модели не содержит points: score вычисляется по persisted anchors и
  distinct incorrect facts только backend-кодом.
- API process не исполняет AI jobs; HTTP calls выполняет только
  `training-worker`.
- Provider response body, transcript, audio и API key не логируются.

Перед request сохраняется provider intent, но DB transaction во время network
I/O не держится. `429/5xx`, timeout/network и временный malformed upstream
response повторяются bounded внутри общего hard deadline. Исчерпанный
timeout/network без известного исхода фиксируется как `AMBIGUOUS`; новый
durable job/restart не повторяет такой платный вызов автоматически, потому что
исход запроса и billing неизвестны. Reviewer запускает новую версию явным
reprocessing endpoint. Exactly-once billing не обещается.

Выбран `RESTRICT`, потому что это явная Prisma/PostgreSQL convention проекта
для исторических и используемых сущностей: нарушение обнаруживается в момент
DELETE, а архивирование остаётся отдельным domain transition. CASCADE
сохранён только у неисторических draft/content-owned сущностей.

Composite same-answer foreign keys дополнительно запрещают cross-owned active
transcription/evaluation и provider history. Additive migration сначала
проверяет существующую историю и fail-loud без автоматического data repair.

`FilesService.delete` блокирует строку `File` через `FOR UPDATE`, проверяет все
ссылки до object storage delete и только затем удаляет object и DB row в одной
транзакционной критической секции. Поэтому linked training audio нельзя
оставить без object из-за последующего FK error.

## Telegram network boundary

- Разрешён только фиксированный origin `https://api.telegram.org`.
- `file_path` не может быть абсолютным/protocol-relative URL, содержать
  credentials, port, `..`, percent-encoding, backslash или malformed bytes.
- `getFile` и binary fetch не следуют redirect.
- `3xx` и смена `response.url` считаются non-retryable security error.
- Размер ограничен Telegram metadata, `Content-Length` и фактически
  прочитанными bytes; MIME и Ogg/Opus container проверяются независимо.

## Durable object state machine

```text
PENDING
  -> object absent: upload deterministic key
  -> object exact: reuse
  -> UPLOADED
  -> File/link transaction
  -> COMMITTED

PENDING/UPLOADED + mismatch/terminal
  -> CLEANUP_PENDING
  -> persisted cleanup TrainingJob
  -> PENDING for safe re-upload, or CLEANED for terminal owner
```

Intent создаётся до внешнего upload и содержит owner, bucket/key, SHA-256,
size, MIME, timestamps и unique recovery key. S3 object несёт
`x-amz-meta-sha256`, поэтому restart проверяет существующий object через HEAD,
не скачивая и не угадывая его содержимое. Повторное выполнение использует
те же key/File/link и не создаёт дублей.

После создания intent его `bucket` и `objectKey` являются единственным
источником истины для upload, HEAD/metadata validation, File, delete и
повторного recovery. Текущий `TRAINING_AUDIO_BUCKET` читается только при
создании нового intent. Поэтому после crash и смены конфигурации A → B старый
intent продолжает обслуживаться в A, а объект с тем же key в B не читается,
не перезаписывается и не удаляется. Отсутствующий/некорректный persisted
bucket является controlled manual-review error без fallback.

Cleanup переводит intent в `CLEANED` только после signed delete из
`intent.bucket` и подтверждающего HEAD с `exists = false`. Ошибка delete/HEAD
остаётся retryable; после `maxAttempts` job становится `DEAD`, а intent
остаётся `CLEANUP_PENDING`.

Fault injection существует только как injected test token. Production
HTTP/API не позволяет включить crash hook.

## Private storage boundary

- Production требует явный `TRAINING_AUDIO_BUCKET`, отличный от
  `MINIO_BUCKET`.
- Training audio никогда не вызывает `getPublicUrl`; `File.url` всегда
  `null`.
- Bucket policy отклоняет public `Principal: "*"`/`Principal.AWS: "*"` и
  эквивалентные wildcard principals для read/list/write/delete/ACL
  capabilities. `Action` поддерживает string/array и wildcard patterns;
  conditional public capability, безопасность которой нельзя доказать,
  fail-closed отклоняется в production.
- Bucket ACL отклоняет `AllUsers` и `AuthenticatedUsers` с `READ`,
  `READ_ACP`, `WRITE`, `WRITE_ACP`, `FULL_CONTROL` и любым распознанным
  permission grant.
- Startup функционально выполняет unsigned object GET, bucket LIST, object
  DELETE и обязательный PUT случайного небольшого sentinel без credentials,
  `Authorization`, signed headers и redirect.
- Любой `2xx` означает public capability; только `401/403` подтверждают
  запрет. Неоднозначный ответ или недоступный probe в production останавливает
  startup.
- После неожиданного успешного PUT sentinel удаляется signed запросом в
  `finally`, затем HEAD подтверждает отсутствие. Cleanup failure безопасно
  логируется и сам останавливает startup; credentials, signed headers и полный
  endpoint не логируются.
- Production validation не меняет bucket policy/ACL автоматически.

## Process and temporary-file boundary

ffmpeg/ffprobe запускаются без shell, с generated basenames, массивом
аргументов, bounded stdout/stderr и отдельной POSIX process group. Timeout:
group `SIGTERM`, bounded grace, group `SIGKILL`, bounded wait. Docker
init/reaper удаляет zombie descendants.

Temp root должен быть абсолютным. Cleanup errors структурированно логируются.
Startup/periodic scavenger ограничен 200 entries, только generated
`answer-*` directories внутри root; symlink, свежие и активные directories не
удаляются.

## HTTP access boundary

`GET /training/admin/answers/:answerId/audio` проходит реальные
`JwtAuthGuard` и `PermissionsGuard`, требует `training:audio:read`, а затем
ownership либо `training:results:read`. Несуществующий/чужой answer скрывается
как `404`. Успех возвращает только bytes с `private, no-store` и создаёт
`training.audio.read` в `AuditLog`; storage key/public URL не сериализуются.

Employee result endpoints используют только authenticated `user.id` из JWT и
никогда не принимают owner ID из query/body. Чужой/несуществующий attempt
возвращается как `404`; pending-review DTO обнуляет итог и breakdown. После
`OVERRIDDEN` либо любого review adjustment, при котором
`finalScore != serverScore`, employee получает только итог и
`MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE`: исходные question/component scores
не сериализуются. Breakdown доступен только из persisted active evaluation,
если суммы question/criterion точно согласованы с `finalScore`. AI summary и
AI/server/admin score fields отсутствуют в employee DTO при любом status.
Project DTO отдаёт только безопасную связь с объектом, backend eligibility,
active attempt timestamps/status и булевы Telegram/retake состояния; Telegram
ID/chat ID и внутренний account ID не возвращаются.
Transcript, ошибки, audio endpoint, provider metadata, ranking и review history
в employee DTO отсутствуют по типу и по explicit Prisma select.

Admin list/ranking/CSV требуют `training:results:read`; review/reprocessing —
`training:results:review`; фактические audio bytes —
`training:audio:read` плюс административный results scope. Frontend permission
checks служат UX-фильтром, но не заменяют Nest guards.

## Versioned policy и техническая фиксация ознакомления

Единый текст хранится в `TrainingPolicyVersion` и создаётся seed из
`training-policy.seed.ts`. Версия содержит `version`, `title`, `body`,
`effectiveAt`, `isActive`, SHA-256 `checksum`, автора и статус утверждения.
Текст `2026-07-28.1` утверждён владельцем процесса 2026-07-28 и seed хранит
статус `APPROVED`. Это техническая фиксация утверждения внутренних правил, а
не заявление о полной юридической compliance.

`TrainingPolicyAcceptance` хранит только internal `userId`, версию, дату,
`PLATFORM | TELEGRAM` и optional `revokedAt`. Telegram identifiers не нужны и
не сохраняются. Acceptance создаётся в транзакции с AuditLog и является
идемпотентной для пары user/version. Новая active version или отзыв блокирует
новую попытку до повторного подтверждения, но не удаляет исторические
attempt/audio/results.

## Категории данных, видимость и retention

| Данные | Источник и назначение | Storage / retention | Кто видит | External / audit |
| --- | --- | --- | --- | --- |
| Platform user | существующий профиль, RBAC и owner binding | PostgreSQL, lifecycle пользователя | сам пользователь; admins по RBAC | не передаётся provider; auth/audit |
| Telegram link/account | одноразовая связь private chat | hash токена и internal account relation; TTL/revoke | employee видит только connected state | Telegram; link/revoke audit |
| Policy acceptance | Platforma или private Telegram callback | PostgreSQL, исторически; revoke без delete | employee свою; admin version/date/source | не external; acceptance audit |
| Voice metadata | Telegram `file_id`, duration, update chain | PostgreSQL, вместе с исторической попыткой | только authorised admin processing | Telegram; correlation IDs |
| Original/merged audio | bounded download и ffmpeg | private bucket, `File.url=null`, бессрочно | только `training:audio:read` + admin scope; employee не видит | Telegram download; privileged read audit |
| Transcript | server-side transcription | immutable PostgreSQL versions, исторически | authorised admin; employee не видит | OpenAI Transcriptions в real mode; provider-run metadata |
| Evaluation | strict structured result | immutable PostgreSQL versions, исторически | authorised admin; employee только разрешённый final result | OpenAI Responses `store=false`; provider-run metadata |
| Score/review | backend formula и решение reviewer | PostgreSQL, исторически | employee безопасный final; admin detail/history | не external; review audit |
| Ranking/CSV | подтверждённые final scores | формируется bounded page/batches, отдельного retention нет | `training:results:read` | не external; без transcript/audio/storage/provider payload |

OpenAI key, Telegram token/webhook secret и S3 credentials остаются
server-side. Реальные OpenAI project data controls до staging/pilot не
проверялись; Zero Data Retention не заявляется. До их проверки допускается
только fake provider или отдельный synthetic smoke по runbook.

## Safe disable, logs и operations

При `TRAINING_MODULE_ENABLED=false` ingress возвращает controlled
`TRAINING_DISABLED`, webhook не выполняет domain transitions, workers не
claim-ят jobs, recovery не начинает новую работу, данные и pending jobs
сохраняются. Worker повторно проверяет runtime flag после каждого await между
поиском кандидата и CAS claim. Если disable случился после claim, job
атомарно возвращается в `PENDING` без увеличения attempt count; новые
Telegram/provider/storage вызовы не начинаются. Уже начатый внешний вызов
может безопасно завершиться и сохранить результат. После re-enable recovery
продолжает persisted state.

Training logs используют Nest Logger и whitelist полей: correlation/internal
IDs, provider/model/request ID, latency, retry, status и safe error code.
Raw error, transcript, audio, prompt/provider payload, link token, secrets,
email/name и signed storage headers не форматируются. Один persisted
correlation ID сопровождает Telegram update/outbox, audio job, provider call,
evaluation и attempt finalization; retry не создаёт новую логическую
корреляцию.

Публичный `GET /health` возвращает только `status`, `database` и
`training: disabled|ready|degraded`. `GET /training/admin/operations/summary`
требует `training:operations:read`; manual retry требует
`training:operations:manage`, reason `3..500`, обязательный
`Idempotency-Key` и пишет одну audit-запись на логическую операцию. Повтор с
тем же ключом и payload возвращает сохранённый результат, а другой payload
отклоняется. Summary содержит только агрегированные counts/ages/status/error
codes/heartbeat/modes/privacy verdict и не содержит payload, transcript,
audio, bucket name, object key, user identifiers или credential state.

## Staging isolation

`DEPLOYMENT_ENV=staging` требует `NODE_ENV=production` и синхронный
fail-closed preflight до migrations, Nest bootstrap и storage probes.
Preflight сравнивает canonical DB identity с exact staging allowlist и known
production deny-list, требует отдельное имя staging DB, попарно разные
general/document/audio buckets и отклоняет их совпадение с known production
buckets. Staging public URLs и Telegram bot username также проверяются по
allow/deny identifiers. Placeholder/default/production-like значения
отклоняются без вывода DB credentials, tokens или secrets.

Known production identifiers содержат только host/port/database name, bucket
name, public host и bot username; их задаёт runtime deployment store.
Production passwords, tokens и keys в Git не сохраняются.

## Автоматические доказательства

Быстрый gate:

```bash
pnpm --filter @platforma/api test
```

Он включает unit и изолированные PostgreSQL tests, проверяет реальные
constraints через `pg_constraint` и поднимает Nest endpoint на ephemeral port
с настоящими auth/guards.

Обязательный Docker gate перед этапом 8:

```bash
pnpm --filter @platforma/api test:training:audio:docker
```

Он использует временные PostgreSQL/MinIO, настоящий API image и synthetic
tones без голосов сотрудников. Проверяются реальные anonymous GET/LIST/PUT
policy, отсутствие sentinel после signed cleanup, object metadata, реальный
process crash после upload, restart reconciliation при смене текущего bucket
A → B, terminal cleanup из A без удаления одноимённого объекта в B, duplicate
retry, multi-segment storage, OGG/Opus → WAV и process tree timeout.

Полный connected gate:

```bash
pnpm test:training:e2e
```

Он создаёт чистую временную PostgreSQL, применяет все migrations, поднимает
isolated MinIO и Docker worker с реальным ffmpeg, использует только fake
Telegram/transcription/evaluation providers и проходит единую persisted
цепочку policy → link → attempt → audio → review → results/ranking/CSV →
API/UI. В конце runner удаляет контейнеры, сеть, временную БД и локальные
артефакты.
