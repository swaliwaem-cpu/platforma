# Deployment private training audio worker

Дата актуализации: 2026-07-27.

Документ относится только к этапу 7: Telegram voice download, private audio
storage, ffmpeg/ffprobe и отдельный PostgreSQL-backed audio worker.
Транскрибация остаётся deterministic fake provider. OpenAI SDK, API key и
сетевые вызовы OpenAI отсутствуют.

## Runtime topology

Используется одна существующая таблица `training_jobs`. Новая queue, Redis,
BullMQ и отдельная queue-библиотека не добавлены.

```text
API / Telegram webhook
  -> TELEGRAM_DOWNLOAD_SEGMENT (по одному на persisted segment)
  -> training-worker
  -> private original File

finishAnswer
  -> ASSEMBLE_ANSWER_AUDIO
  -> training-worker + ffprobe/ffmpeg
  -> private normalized File
  -> TRANSCRIBE_ANSWER
  -> API attempt worker + deterministic fake transcription
```

API и `training-worker` используют один image
`${PLATFORMA_API_IMAGE:-platforma-api:local}`. Image содержит `ffmpeg` и
`ffprobe`. Только API выполняет `prisma migrate deploy`; worker зависит от
здорового API и стартует прямой командой:

```text
node apps/api/dist/training/training-worker.main.js
```

## Private storage

`TRAINING_AUDIO_BUCKET` должен быть отдельным private bucket. Object storage
credentials доступны только backend/worker. Bucket нельзя публиковать через
anonymous read policy, CDN или бессрочные signed URLs.

И оригиналы, и normalized audio создают `File` со следующими правилами:

- `url = null`;
- `bucket` и `key` хранятся только на backend;
- key строится из внутренних UUID answer/segment без ФИО, email, username,
  Telegram user/chat ID и другой PII;
- сохраняются фактические `sizeBytes`, MIME и SHA-256 checksum;
- `TRAINING_AUDIO_RETENTION_DAYS=0` означает утверждённое бессрочное хранение;
  иное значение stage-7 runtime отклоняет;
- unlink/revoke Telegram account не удаляет историю audio;
- original voice segments после merge не удаляются.

Доступ к normalized audio идёт только через:

```text
GET /training/admin/answers/:answerId/audio
```

Endpoint требует JWT, `training:audio:read`, ownership либо administrative
scope через `training:results:read`, проверяет checksum/size и пишет
`training.audio.read` в `AuditLog`. Ответ содержит bytes и безопасные headers,
но не storage key и не public URL.

## Environment

Обязательные и рекомендуемые значения приведены в `.env.example`,
`.env.production.example` и `apps/api/.env.example`:

| Variable | Default | Назначение |
| --- | ---: | --- |
| `TRAINING_AUDIO_BUCKET` | `platforma-training-audio-private` | private bucket |
| `TRAINING_AUDIO_MAX_BYTES` | `20971520` | максимум одного segment |
| `TRAINING_AUDIO_MAX_ANSWER_BYTES` | `83886080` | максимум answer до/после подготовки |
| `TRAINING_AUDIO_MAX_SEGMENTS` | `32` | максимум segments |
| `TRAINING_AUDIO_MAX_DURATION_SECONDS` | `600` | максимум duration |
| `TRAINING_AUDIO_DOWNLOAD_TIMEOUT_MS` | `30000` | getFile/download timeout |
| `TRAINING_FFMPEG_TIMEOUT_MS` | `90000` | timeout каждого ffmpeg/ffprobe process |
| `TRAINING_TRANSCRIPTION_TIMEOUT_MS` | `30000` | timeout provider interface |
| `TRAINING_AUDIO_WORKER_POLL_MS` | `500` | polling |
| `TRAINING_AUDIO_WORKER_CONCURRENCY` | `2` | process lanes |
| `TRAINING_AUDIO_WORKER_LEASE_MS` | `120000` | lease |
| `TRAINING_AUDIO_WORKER_HEARTBEAT_MS` | `5000` | heartbeat |
| `TRAINING_AUDIO_WORKER_DRAIN_TIMEOUT_MS` | `30000` | graceful drain |
| `TRAINING_AUDIO_TEMP_DIR` | `/tmp/platforma-training-audio` | generated-only temp root |
| `TRAINING_AUDIO_RETENTION_DAYS` | `0` | indefinite retention |

`TRAINING_AUDIO_WORKER_HEARTBEAT_MS` должен быть меньше lease. Temp path должен
быть абсолютным. Compose монтирует temp root как `tmpfs` размером 512 MiB.

## Telegram download and retry

Real transport выполняет server-side `getFile`, проверяет безопасный
`file_path`, затем скачивает body через `AbortController`. Проверяются HTTP
status, `Content-Type`, `Content-Length`, размер `getFile`, persisted
`message.voice.file_size`, фактическое число bytes и Ogg/Opus magic.

- 429 учитывает `retry_after`;
- 5xx, timeout и network errors повторяются bounded;
- постоянные 4xx и spoofed/invalid audio не повторяются;
- error/log messages не содержат bot token или download URL;
- deterministic storage key и unique File constraint делают retry
  идемпотентным.

Реальный Telegram webhook этим deployment flow автоматически не
регистрируется.

## ffmpeg strategy

Worker создаёт уникальную директорию с mode `0700`, читает только связанные
private File records и создаёт внутренние имена `segment-NNNN.*`.

Процессы запускаются через `child_process.spawn` с `shell: false` и массивом
аргументов. Используются `-nostdin`, один thread/filter thread, bounded output
capture и timeout с `SIGKILL`. Concat manifest содержит только сгенерированные
basename. Каждый segment нормализуется в mono 16 kHz PCM WAV, затем файлы
объединяются и проверяются через ffprobe. Temp directory удаляется в `finally`.

Если локальные `ffmpeg`/`ffprobe` отсутствуют, job получает явный
`FFMPEG_NOT_AVAILABLE`; Docker image уже содержит binaries.

## Job recovery and shutdown

Audio worker переиспользует CAS claim, unique owner, heartbeat, lease,
`maxAttempts`, `DEAD`, advisory attempt lock и stale recovery существующей
PostgreSQL infrastructure.

Idempotency keys:

```text
attempt:<attemptId>:answer:<answerId>:segment:<segmentId>:download
attempt:<attemptId>:answer:<answerId>:assemble
attempt:<attemptId>:answer:<answerId>:transcribe
```

Merge job без всех downloaded segments возвращается в `PENDING` без расхода
attempt. После terminal attempt jobs становятся no-op. Исчерпанный/permanent
audio job переводит answer в `FAILED`, очищает transcript, attempt — в
`TECHNICAL_FAILURE`, закрывает остальные attempt jobs и создаёт существующий
transactional Telegram outbox event при наличии активной Telegram account.

Signal path:

```text
docker compose stop training-worker
  -> SIGTERM для Node PID 1
  -> Nest shutdown hooks
  -> запрет новых claim
  -> drain до TRAINING_AUDIO_WORKER_DRAIN_TIMEOUT_MS
  -> complete либо release owned job в PENDING
  -> restart/stale recovery
```

Compose даёт worker `45s`, что больше default drain `30s`.

## Safe checks

Config-only проверки не запускают containers и не печатают secrets:

```bash
docker compose config --quiet
```

Production config проверяется с заполненным локальным `.env.production`;
rendered output не следует писать в CI logs:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --env-file .env.production \
  config --quiet
```

Проверка image:

```bash
docker compose build api training-worker
docker compose run --rm --no-deps training-worker ffmpeg -version
docker compose run --rm --no-deps training-worker ffprobe -version
```

Автоматическая проверка без production Telegram/MinIO/OpenAI:

```bash
pnpm --filter @platforma/api test
```

Runner создаёт временную локальную PostgreSQL database, применяет migrations,
использует fake Telegram/audio/ffmpeg fixtures и удаляет database после тестов.

## Manual staging QA without production webhook and OpenAI

1. Запустить Compose с `NODE_ENV=development`,
   `TELEGRAM_TRANSPORT_MODE=fake` и отдельным test bucket.
2. Проверить `ffmpeg -version` и `ffprobe -version` внутри
   `training-worker`.
3. Пройти synthetic fake 1+3 через integration suite; убедиться, что на каждый
   segment создан один private File, а на answer — один normalized File.
4. Проверить в БД `url IS NULL`, checksum, size, duration и final job states.
5. С JWT пользователя с `training:audio:read` проверить собственный answer;
   с training admin — administrative read и `AuditLog`; без permission ожидать
   `403`.
6. Во время блокируемого fake job выполнить
   `docker compose stop training-worker`, затем restart и проверить отсутствие
   orphan `RUNNING` locks/duplicates.

Реальный Bot API download требует отдельного разрешённого staging smoke с
настоящим bot token и voice. Production webhook и OpenAI для этой проверки не
нужны и автоматически не настраиваются.
