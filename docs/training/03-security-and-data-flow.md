# Training audio security and data flow

Дата актуализации: 2026-07-27.

Документ фиксирует границы безопасности этапов 7–8 после независимого review.
UI результатов/rating и следующий этап здесь не реализуются.

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
- Upload меньше 25 MiB, `language=ru`, prompt содержит только короткий
  approved vocabulary, не полный эталонный ответ.
- Evaluation использует Responses, `store:false`, strict JSON Schema и не
  передаёт tools/search/conversation/background/previous response state.
- Instructions объявляют transcript и весь input JSON недоверенными данными.
- Backend проверяет schema version, exact fields/enums, numeric confidence
  `0..1`, неизвестные/повторные IDs, неутверждённые anchors, полное покрытие
  criteria/facts и evidence, которое не является точной подстрокой transcript
  или известным metric ID.
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
