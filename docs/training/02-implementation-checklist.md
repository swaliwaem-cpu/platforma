# Checklist реализации модуля обучения

Дата актуализации: 2026-07-27.

Источник этапов: `docs/training/prompts/00_audit.md` …
`10_security_deploy_pilot.md`.

## Правила ведения

- Выполнять только явно запрошенный prompt-stage.
- Перед каждым этапом проверять `on-ser` и `git status --short`.
- Не перезаписывать чужие modified/untracked-файлы.
- Отмечать пункт только после реализации и релевантных build/tests.
- После отчёта останавливаться.
- Общая спецификация содержит stages 0–12, но prompts агрегируют их в этапы
  0–10; этот checklist следует prompts.

## Сводка

| Этап | Prompt | Статус |
| --- | --- | --- |
| 0 | `00_audit.md` | Выполнен по явному списку prompt |
| 1 | `01_foundation_rbac.md` | Выполнен |
| 2 | `02_prisma_schema.md` | Выполнен |
| 3 | `03_content_backend.md` | Выполнен |
| 4 | `04_content_ui_documents.md` | Выполнен |
| 5 | `05_attempt_engine_fake.md` | Выполнен; findings независимого review исправлены |
| 6 | `06_telegram.md` | Выполнен |
| 7 | `07_audio_worker.md` | Выполнен |
| 8 | `08_openai_scoring_review.md` | Выполнен |
| 9 | `09_results_ui_rating.md` | Не начат |
| 10 | `10_security_deploy_pilot.md` | Не начат |

## Этап 0. Аудит и архитектурные документы

- [x] Проверена ветка `on-ser`.
- [x] Зафиксирован исходный `git status --short`.
- [x] Проверены stack, auth/RBAC, Prisma, storage, workers, routing, tests,
  Docker/deploy.
- [x] Drift подтверждён по реальному коду, без изменения production-кода.
- [x] Создан `docs/training/00-repository-audit.md`.
- [x] Создан `docs/training/01-architecture-decision.md`.
- [x] Создан `docs/training/02-implementation-checklist.md`.
- [x] `pnpm build` прошёл.
- [x] `pnpm test` прошёл: 600/600.
- [x] Новые migrations отсутствуют.
- [x] Новые dependencies отсутствуют.
- [x] Production-код, Prisma schema и deploy не изменены.
- [x] Этап 1 не начинался.

Примечание: `spec/04_stages_tests_acceptance.md` дополнительно упоминает
`docs/training/03-security-and-data-flow.md`, но `00_audit.md` не включает его
в явный список. Файл не создан до отдельного решения пользователя.

## Этап 1. Foundation, feature flag, routing и RBAC

- [x] Создать `TrainingModule` и config/health shell.
- [x] Добавить безопасный `TRAINING_MODULE_ENABLED`.
- [x] Создать `packages/shared/src/training.ts` и re-export.
- [x] Добавить утверждённые training permissions и роль `training_admin`
  idempotent seed.
- [x] Сохранить полный training access для `admin`.
- [x] Добавить protected shells `/training` и `/admin/training`.
- [x] Не мигрировать Platforma на React Router.
- [x] Добавить permission contract и frontend route/navigation tests.
- [x] Запустить релевантные build/tests.

Проверки этапа 1:

- `pnpm build` — passed;
- `pnpm --filter @platforma/api test` — 241/241;
- `pnpm --filter @platforma/web test` — 280/280;
- `pnpm test` — 608/608.

На момент завершения этапа 1 новые Prisma models/migrations и dependencies
отсутствовали.

## Этап 2. Prisma schema и additive migration

- [x] Переиспользовать `User`; не создавать `Employee`.
- [x] Добавить nullable relation к `RealEstateObject`.
- [x] Разделить draft и immutable published version.
- [x] Pin attempt к version и выбранным questions.
- [x] Добавить content, Telegram, attempt, answer/segment, review и job models.
- [x] Добавить indexes/unique constraints для integrity/idempotency.
- [x] Создать additive migration без seed реальных проектов.
- [x] Сгенерировать Prisma Client.
- [x] Добавить schema/contract tests и запустить build/tests.

Проверки этапа 2:

- `pnpm --filter @platforma/api prisma:generate` — passed;
- `pnpm --filter @platforma/api exec prisma validate` — passed;
- targeted training tests — 15/15 passed;
- `pnpm build` — passed; сохраняется существующее предупреждение Vite о
  client chunk больше 500 kB;
- `pnpm test` — 618/618 passed: API 251, Web 280, Feed import 64,
  WordPress import 23;
- полный migration chain из 33 миграций применён на чистой изолированной БД;
- upgrade-копия локальной БД успешно обновлена с 32 до 33 миграций без
  изменения контрольных counts существующих `users`, `real_estate_objects`,
  `files`, `feed_units` и `project_presentation_documents`;
- обе временные тестовые БД удалены после проверки.

Новые dependencies, seed учебных проектов/вопросов и реальные training data
не добавлялись. Controllers, frontend, Telegram/OpenAI и обработка аудио этапа 3+
не начинались.

## Этап 3. Backend учебного контента

- [x] Реализовать admin CRUD проектов/drafts/versions.
- [x] Реализовать questions, facts, criteria и attempt settings.
- [x] Валидировать ровно 1 main + 10 follow-up.
- [x] Валидировать веса main 55 и follow-up 15.
- [x] Валидировать pass score, limits, timer, cooldown и availability.
- [x] Публиковать immutable version.
- [x] Ограничить delete неиспользованным draft; остальное архивировать.
- [x] Писать privileged actions в `AuditLog`.
- [x] Добавить unit/integration tests и запустить build/tests.

Проверки этапа 3:

- targeted content unit/service tests — 15/15 passed;
- `pnpm --filter @platforma/api test` — 266/266 passed;
- `pnpm build` — passed; сохраняется существующее предупреждение Vite о
  client chunk больше 500 kB;
- `pnpm test` — 633/633 passed: API 266, Web 280, Feed import 64,
  WordPress import 23;
- полный migration chain из 33 миграций применён на чистой изолированной БД;
- на изолированной БД пройден реальный flow create → 1 MAIN + 10 FOLLOW_UP →
  approved fact → criteria 55/15 → publish → open → clone draft → delete draft
  → archive;
- service guard и PostgreSQL trigger независимо запретили изменение
  published content; проверены 20 `AuditLog` записей flow;
- временная тестовая БД удалена.

Новые dependencies, Prisma schema/migrations, seed учебного контента, frontend,
Telegram/OpenAI и audio processing не добавлялись.

## Этап 4. Admin UI и document ingestion

- [x] Реализовать список/создание/редактирование training projects.
- [x] Добавить утверждённые вкладки content editor.
- [x] Поддержать nullable link к `RealEstateObject`.
- [x] Реализовать private upload PDF/DOCX/PPTX/XLSX.
- [x] Обосновать и согласовать минимальные parser dependencies.
- [x] Добавить async extraction status и source locators.
- [x] Добавить size/MIME/magic-byte/zip-bomb/text limits.
- [x] Поддержать `NEEDS_MANUAL_TEXT`; OCR не добавлять.
- [x] Допускать в scoring только подтверждённые facts.
- [x] Добавить frontend/backend tests и запустить build/tests.

Добавлены только узкие parser dependencies: `pdfjs-dist` для text layer PDF,
`yauzl` для контролируемого чтения OOXML ZIP и `fast-xml-parser` для XML внутри
DOCX/PPTX/XLSX. Извлечённый и вручную скорректированный текст всегда остаётся
черновым источником; scoring использует только структурированные facts с явным
подтверждением администратора.

## Этап 5. Attempt engine с fake providers

- [x] Реализовать transactional start с немедленным списанием.
- [x] Реализовать limit/cooldown/window/pass/retake rules.
- [x] Случайно выбирать 3 разных follow-up из 10 на backend.
- [x] Реализовать state machine 1 main + 3 follow-up.
- [x] Поддержать multi-segment answers и idempotent finish.
- [x] Реализовать общий timer, warnings, grace и timeout skip = 0.
- [x] Добавить fake transcription/evaluation providers.
- [x] Детерминированно считать 55 + 15 + 15 + 15, penalties и review.
- [x] Проверить concurrency, retries и fourth-attempt blocking.
- [x] Запустить исчерпывающие unit/integration tests.

Attempt start использует короткую `Serializable` PostgreSQL-транзакцию и
transaction-level advisory lock для пары user/project; существующий partial
unique index остаётся дополнительным барьером активной попытки. Fake providers
не выполняют внешних вызовов и запускаются вне транзакции. Finish-команда
адресует конкретный `attemptQuestionId`, поэтому повторный callback после
перехода к следующему вопросу не создаёт повторную evaluation.

Проверки этапа 5:

- targeted attempt unit/fake integration tests — 20/20 passed;
- отдельный PostgreSQL integration на чистой БД со всеми 33 migrations —
  1/1 passed: 12 concurrent starts создали одну consumed attempt, полный flow
  1 + 3 дал 100, четвёртая consumed attempt заблокирована;
- `pnpm --filter @platforma/api test` — 298/298 passed;
- `pnpm build` — passed; сохраняется существующее предупреждение Vite о
  client chunk `753.03 kB`, больше 500 kB;
- `pnpm test` — 671/671 passed: API 298, Web 286, Feed import 64,
  WordPress import 23;
- `git diff --check` — passed.

Prisma schema/migration, dependencies, controllers, Telegram/OpenAI/storage
audio pipeline и frontend на этапе 5 не изменялись. Изолированная PostgreSQL БД
удалена после integration test.

### Исправления независимого review этапа 5

- [x] Persisted jobs `TRANSCRIBE_ANSWER`, `EVALUATE_ANSWER` и
  `FINALIZE_ATTEMPT` используют существующую `TrainingJob`: уникальные
  idempotency keys, `attempts`, `runAt`, lease, heartbeat и возврат stale
  `RUNNING` jobs в обработку.
- [x] Recovery после пересоздания service продолжает состояния `READY`,
  `TRANSCRIBING`, `EVALUATING` и `FINALIZING`, не повторяет уже сохранённый
  provider result и допускает конкурирующие recovery workers без дублей.
- [x] Timeout intent сохраняется в payload persisted expire-job; текущая
  обработка восстанавливается/завершается, остальные вопросы получают
  `SKIPPED_TIMEOUT`, после чего attempt финализируется.
- [x] Все score-компоненты, answer/final score, penalties, pass threshold и
  admin review используют одну политику `Prisma.Decimal`: 2 знака,
  `ROUND_HALF_UP`.
- [x] Terminal attempt/refund атомарно закрывает неприменимые pending/running
  timer и process jobs; stale terminal job является no-op.
- [x] Стандартный `pnpm --filter @platforma/api test` включает unit suite и
  реальный PostgreSQL integration suite в уникальной временной БД.
- [x] Безопасный DB runner разрешает только локальный base PostgreSQL,
  отказывается от production-like URL, применяет migrations только во
  временную БД и удаляет её в `finally`, включая обработку `SIGINT/SIGTERM`.
- [x] Реальный PostgreSQL suite покрывает concurrent start, finish/timeout,
  duplicate finish/voice, voice/finish, concurrent finalize/refund,
  конкурентный recovery, restart states, timeout during processing и
  canonical rounding.
- [x] Source-regex architecture test заменён runtime/import/provider и
  transaction-level проверками без новой зависимости.
- [x] Prisma schema и migrations не менялись: существующих полей
  `TrainingJob` и JSON payload достаточно для recovery и timeout intent.
- [x] На момент завершения этапа 5 Telegram, OpenAI/network, audio storage,
  frontend и новые dependencies ещё не начинались.

Проверки review-fix:

- targeted attempt/scoring unit tests — 38/38 passed;
- `pnpm --filter @platforma/api test` — 316/316 unit и 18/18 PostgreSQL
  integration tests passed; integration suite действительно запущен этой
  стандартной командой;
- `pnpm build` — passed; сохраняется существующее предупреждение Vite о client
  chunk `753.03 kB`, больше 500 kB;
- `pnpm test` — 707/707 passed: API 316 unit + 18 PostgreSQL, Web 286,
  Feed import 64, WordPress import 23;
- `git diff --check` — passed;
- временные PostgreSQL databases удалены после каждого integration run.

## Этап 6. Telegram linking и webhook

- [x] Реализовать opaque one-time link token; хранить только hash.
- [x] Обеспечить связь user ↔ Telegram account один-к-одному.
- [x] Проверять webhook secret и private chat.
- [x] Обеспечить idempotency updates/messages/callbacks.
- [x] Принимать только `message.voice` как ответ.
- [x] Реализовать multi-part voice UX и кнопку finish.
- [x] Запрашивать подтверждение до списания attempt.
- [x] Быстро ACK webhook; тяжёлую работу отправлять в jobs.
- [x] Использовать fetch provider + fake fixtures без SDK по умолчанию.
- [x] Добавить contract/integration tests.

Одноразовый token генерируется из 32 криптографически случайных bytes,
передаётся только при создании deep link и не попадает в job payload:
`TrainingLinkToken` хранит SHA-256 hash, TTL и признаки atomic consume/revoke.
Привязка выполняется в короткой `Serializable` транзакции, а уникальные
`userId`, `telegramUserId` и `chatId` сохраняют one-to-one инвариант. Конфликт
существующей связи возвращается пользователю и не перепривязывает аккаунты.

Webhook без JWT проверяет `X-Telegram-Bot-Api-Secret-Token`, принимает только
private chat, сохраняет `update_id` и быстро создаёт
`PROCESS_TELEGRAM_UPDATE`. Обработка и исходящие сообщения выполняются
PostgreSQL worker-ом. Idempotency дополнительно закреплена ключами Telegram
`chat_id + message_id`, `callback_query.id`, callback с точным
`attemptQuestionId` и persisted delivery jobs.

После независимого review обязательные сообщения link/start/finish/next
question/final/review/technical failure переведены на transactional outbox:
domain transition и `SEND_TELEGRAM_MESSAGE` job фиксируются одной PostgreSQL
transaction, а сетевой вызов выполняется worker-ом уже после commit. Payload
содержит только устойчивые domain IDs (`user/account/chat/attempt/question`),
тип события и детерминированный `idempotencyKey`, без Telegram secrets.
Timer warning job создаётся в той же start transaction; terminal transitions
атомарно закрывают pending attempt timer jobs.

Диалог показывает только глобально OPEN проекты с PUBLISHED active version,
требует отдельный callback подтверждения старта, принимает несколько
`message.voice` частей и запрещает остальные Telegram message types. Finish,
timeout/grace, timer warnings и финал используют существующий attempt engine и
persisted jobs. `REQUIRES_REVIEW` не раскрывает предварительный балл или
passed/failed status.

`TELEGRAM_TRANSPORT_MODE=fake|real` задаётся явно. Fake разрешён только для
test/local development; production с включённым training требует real mode,
bot token/username, webhook secret и HTTPS webhook/public URLs. Telegram
username нормализуется без `@`, а тексты ошибок не включают secret values.

Каждый входящий update проверяет связанный `User`: разрешены только
`ACTIVE + deletedAt=null`. Block/deactivate атомарно отзывают account и
неиспользованные link tokens вместе с audit; повторная активация старую связь
не восстанавливает. `file_unique_id` дедуплицируется constraint-ом в пределах
`answerId`, но разрешён для другого вопроса или попытки.

Telegram worker использует уникальный owner, lease и heartbeat с CAS по
`jobId + RUNNING + lockOwner`. Stale jobs возвращаются в `PENDING` только до
`maxAttempts`, иначе переходят в `DEAD`; shutdown прекращает claim, ждёт
активную работу ограниченное время и освобождает незавершённый owned job.
429 учитывает `retry_after`, 5xx/network/timeout/invalid JSON повторяются с
bounded backoff, постоянные 4xx сразу завершаются как `DEAD`.

Перед timer warning worker под advisory attempt lock атомарно проверяет
ownership job и active attempt; transaction завершается до Telegram API call.
Если terminal transition произошёл до gate, warning становится no-op.
Остаётся неизбежное для at-least-once доставки микроскопическое окно между
успешным pre-send gate и фактическим Telegram send: закрыть его полностью без
distributed transaction с Telegram Bot API невозможно.

Проверки этапа 6:

- Telegram unit/contract tests — 12/12 passed;
- `pnpm --filter @platforma/api test` — 328/328 unit и 53/53 PostgreSQL
  integration tests passed;
- `pnpm build` — passed; сохраняется существующее предупреждение Vite о client
  chunk `753.03 kB`, больше 500 kB;
- `pnpm test` — 754/754 passed: API 328 unit + 53 PostgreSQL, Web 286,
  Feed import 64, WordPress import 23;
- `git diff --check` — passed;
- все временные PostgreSQL databases удалены runner-ом.

Добавлены две additive migrations: stage-6 migration расширяет
`training_job_kind` значением `process_telegram_update`, review-fix migration
добавляет scoped unique index
`training_voice_segments(answer_id, file_unique_id)`. Новые dependencies,
Telegram SDK и frontend не добавлялись. Реальные Telegram-файлы не
скачивались, audio storage/MinIO, ffmpeg и OpenAI не подключались. Этап 7 не
начинался.

### Оставшиеся findings повторного review этапа 6

- [x] Добавлен отдельный `docker-compose.production.yml`, который независимо
  от development defaults фиксирует `NODE_ENV=production` и
  `TELEGRAM_TRANSPORT_MODE=real`.
- [x] Compose required-variable syntax требует bot token/username, webhook
  secret/URL и public app URL без fake/default fallback.
- [x] Runtime production validation отклоняет отсутствующие значения, HTTP,
  localhost/loopback и известные placeholder values/hosts без вывода secrets.
- [x] Development сохраняет `NODE_ENV=development` и fake transport.
- [x] Bootstrap включает Nest shutdown hooks для `SIGTERM` и `SIGINT`.
- [x] API Docker CMD после migrations передаёт PID 1 в
  `node apps/api/dist/main.js` через `exec`.
- [x] Compose ждёт `30s`, что превышает default Telegram worker drain timeout
  `10000ms`.
- [x] PostgreSQL lifecycle tests подтверждают запрет новых claim после начала
  shutdown, bounded ожидание активного job и recoverable release после timeout.
- [x] Rollback test использует реальный deterministic key
  `telegram:attempt:<attemptId>:answer-accepted:<attemptQuestionId>` и
  дополнительно ищет любой `ANSWER_ACCEPTED` delivery event для той же
  attempt/question.
- [x] Production env/deployment docs содержат полную Compose command,
  config-only validation, проверку real transport и ручной
  `docker compose stop api` checklist.

Проверки повторного review:

- Telegram unit/contract tests — 15/15 passed;
- `pnpm --filter @platforma/api test` — 331/331 unit и 53/53 PostgreSQL
  integration tests passed;
- `pnpm build` — passed; сохраняется существующее предупреждение Vite о client
  chunk `753.03 kB`, больше 500 kB;
- `pnpm test` — 757/757 passed: API 331 unit + 53 PostgreSQL, Web 286,
  Feed import 64, WordPress import 23;
- development Compose config — passed;
- production Compose без пяти обязательных variables — ожидаемо rejected;
- production Compose config rendering с безопасными test placeholders —
  passed; production containers не запускались.
- `git diff --check` — passed.

Prisma schema/migrations, dependencies, transactional outbox, attempt engine,
scoring, worker lease/claim business logic, frontend и этап 7 не изменялись.

## Этап 7. Private audio и отдельный worker

- [x] Реализовать private bucket/multi-bucket storage без public URL.
- [x] Скачать и проверить Telegram voice server-side.
- [x] Сохранить каждый voice segment.
- [x] Добавить безопасный ffmpeg/ffprobe pipeline с limits/timeouts/cleanup.
- [x] Извлечь утверждённые объективные audio metrics.
- [x] Реализовать PostgreSQL claim/heartbeat/retry/stale recovery.
- [x] Добавить `training-worker.main.ts`, package script и Compose service.
- [x] Добавить protected audio streaming с `training:audio:read` и audit.
- [x] Оставить transcription fake.
- [x] Добавить restart/retry/duplicate/cleanup fixtures/tests.

`TELEGRAM_DOWNLOAD_SEGMENT` создаётся при persisted voice segment, а
`ASSEMBLE_ANSWER_AUDIO` — только после `finishAnswer`. Оба вида обрабатывает
отдельный process через существующую таблицу `TrainingJob`: CAS claim,
owner/lease/heartbeat, bounded retry, stale recovery, `DEAD`, graceful shutdown
и deterministic idempotency keys сохранены. Вторая queue/table/library не
добавлена.

Original и normalized audio сохраняются в `TRAINING_AUDIO_BUCKET` как private
`File` с `url = null`, фактическими MIME/size/SHA-256 и internal UUID-only key.
Retention зафиксирован как бессрочный. Backend playback требует JWT,
`training:audio:read`, ownership либо administrative results scope и создаёт
`training.audio.read` audit.

Telegram provider выполняет `getFile` и bounded body download через
`AbortController`, классифицирует 429/5xx/4xx/network/timeout, проверяет
Content-Type/Length, metadata/actual byte count и Ogg/Opus magic. Token и
download URL не попадают в ошибки.

ffmpeg pipeline использует только `spawn`, `shell: false`, generated filenames,
array args, one-thread limits, bounded captured output, timeout, unique mode
`0700` temp directory и unconditional cleanup. Сохраняются duration, segment
durations/count/bytes, technical intervals, надёжные silence metrics и WPM
только из fake transcript word count.

Transcription остаётся deterministic fake с success/retryable/permanent/timeout
fixtures и получает internal audio metadata. OpenAI SDK/API key/network calls
не добавлены; scoring и Telegram business dialogue не менялись.

Проверки этапа 7:

- новые audio unit/contract tests — 25/25 passed;
- полный API suite — 356/356 unit и 65/65 PostgreSQL integration passed;
- `pnpm test` — 794/794 passed во всём monorepo;
- `pnpm build`, development/production Compose config, Prisma validation,
  Docker image build и проверки `ffmpeg`/`ffprobe`/worker entrypoint — passed;
  подробности см. в `docs/CODEX_LOG.md`.

### Исправления независимого review этапа 7

- [x] Historical result chain переведена с destructive cascade на
  `ON DELETE RESTRICT`; ограничения проверяются через `pg_constraint`, а
  linked training audio `File` отклоняется до object storage delete.
- [x] Telegram `getFile` и binary download не следуют redirect; `file_path`,
  protocol/host/port/origin и `response.url` валидируются fail-closed.
- [x] ffmpeg/ffprobe запускаются в отдельной POSIX process group; timeout
  выполняет group `SIGTERM`, bounded grace и group `SIGKILL`. Docker
  init/reaper включён для API/worker.
- [x] Добавлен persisted `TrainingAudioUploadIntent` до upload с owner,
  deterministic key, SHA-256/size/MIME и state
  `PENDING → UPLOADED → COMMITTED`.
- [x] Restart через HEAD и S3 SHA metadata завершает link без дублей; mismatch
  и terminal owner используют persisted
  `CLEANUP_TRAINING_AUDIO_OBJECT` в существующей `TrainingJob`.
- [x] Для существующего upload intent все upload/HEAD/File/delete/restart
  paths используют только persisted `intent.bucket`; смена текущего
  `TRAINING_AUDIO_BUCKET` с A на B не перенаправляет recovery в B.
- [x] Cleanup delete errors получают bounded retry/`DEAD` и structured log;
  intent остаётся `CLEANUP_PENDING`, а `CLEANED` выставляется только после
  delete и подтверждающего HEAD именно persisted bucket. Temp cleanup
  наблюдаем, startup/periodic scavenger ограничен configured root, не следует
  symlink и не удаляет fresh/active directories.
- [x] Production требует отдельный `TRAINING_AUDIO_BUCKET`; startup проверяет
  public principal/action policy, ACL grants и functional anonymous
  GET/LIST/PUT/DELETE. Public write, неоднозначный ответ или недоступный probe
  останавливает запуск; успешный PUT sentinel удаляется signed запросом и
  отсутствие объекта подтверждается HEAD.
- [x] Добавлен настоящий HTTP integration на ephemeral port с real login,
  `JwtAuthGuard`/`PermissionsGuard`, матрицей `401/403/404/200`, private
  headers и `AuditLog`.
- [x] Fake 1+3 PostgreSQL flow проверяет merged File ID, bucket, internal key,
  checksum, MIME, size, duration, segment count, answer и attempt question для
  всех четырёх answers.
- [x] Добавлен обязательный перед этапом 8 Docker gate
  `pnpm --filter @platforma/api test:training:audio:docker`: isolated
  PostgreSQL/MinIO, все migrations, настоящий process `SIGKILL` после upload,
  реальные anonymous GET/LIST/PUT policies, active recovery после смены
  bucket A → B, terminal cleanup из A без изменения одноимённого объекта в B,
  duplicate retry, synthetic multi-segment OGG/Opus → mono 16 kHz PCM WAV и
  process-tree timeout.
- [x] Новая queue, Redis/BullMQ, OpenAI, Telegram dialogue/scoring/frontend и
  этап 8 не добавлялись.

Подробные security/data-flow invariants зафиксированы в
`docs/training/03-security-and-data-flow.md`, а deployment/runtime gate — в
`docs/training/audio-worker-deployment.md`.

Финальная проверка review findings: API `378/378` unit и `71/71`
PostgreSQL/HTTP integration tests; root suite также включает `286/286` web,
`64/64` feed-import и `23/23` wp-import tests. Docker gate с чистой БД,
реальным MinIO и ffmpeg прошёл полностью.

### Последние два finding этапа 7

- [x] Privacy validation отклоняет anonymous/public write через policy и ACL,
  выполняет настоящий unsigned PUT и гарантирует signed cleanup sentinel.
- [x] Recovery и cleanup используют persisted `intent.bucket` после смены
  текущей конфигурации A → B; объект с тем же key в B не затрагивается.
- [x] Новая migration не создана: существующая модель уже содержит
  обязательный `TrainingAudioUploadIntent.bucket`.
- [x] API tests прошли: `396/396` unit и `71/71` PostgreSQL/HTTP integration;
  временные PostgreSQL databases удалены.
- [x] Root suite прошёл: API `396 + 71`, Web `286`, Feed import `64`,
  WordPress import `23`.
- [x] Real MinIO Docker gate проверил фактические anonymous GET/LIST/PUT,
  отсутствие sentinel, crash recovery A → B и terminal cleanup из A;
  containers, volumes и network удалены.
- [x] Development/production Compose config и API/worker image build прошли.
- [x] Этап 8, OpenAI, Telegram dialogue, scoring, ffmpeg pipeline,
  transactional job semantics, dependencies и Prisma schema/migrations не
  изменялись.

## Этап 8. OpenAI providers, scoring и review

- [x] Реализовать server-side native fetch providers для
  transcription/evaluation без OpenAI SDK.
- [x] Использовать Audio Transcriptions API с normalized private WAV,
  `language=ru`, approved vocabulary и лимитом меньше 25 MiB.
- [x] Использовать Responses API + strict Structured Outputs, `store:false`,
  без tools/search/conversation state.
- [x] Брать model IDs/reasoning/timeouts/retries/limits из env; production с
  включённым training fail-fast требует real mode и непустой non-placeholder
  key.
- [x] Считать transcript недоверенными данными и отделять его от
  instructions.
- [x] Валидировать exact schema, известные IDs, anchors, fact coverage и
  transcript/metric evidence на backend.
- [x] Считать score только на backend по утверждённым structured anchors.
- [x] Реализовать distinct incorrect fact `−5`, dedup и unsupported claim без
  автоматического штрафа до review.
- [x] Реализовать permission-bound review/override с обязательным comment,
  решением по каждому unsupported claim, историей и audit.
- [x] Сохранять provider intent/status, requested/actual model,
  prompt/schema/rubric version, usage, latency, request ID и неизменяемые
  версии transcript/evaluation.
- [x] Исполнять OpenAI jobs только в `training-worker`; API только ставит
  durable jobs и обслуживает review/reprocessing.
- [x] Не повторять неоднозначный REQUESTING outcome автоматически: сохранять
  `AMBIGUOUS`, переводить попытку в technical failure и требовать явный
  reprocessing.
- [x] Добавить fake/HTTP-stub/PostgreSQL tests и отдельную billable opt-in
  smoke command; real API не вызывался.
- [x] Обновить structured anchors в минимальном criteria editor; UI
  результатов/rating не начинался.
- [x] `pnpm --filter @platforma/api test` прошёл: `412/412` unit и `74/74`
  PostgreSQL/HTTP integration; все `38` migrations применены к временной БД,
  затем БД удалена.
- [x] `pnpm build` и `pnpm test` прошли: API `412 + 74`, Web `286`, Feed
  import `64`, WordPress import `23`; сохраняется существующий Vite warning о
  client chunk больше `500 kB`.
- [x] Development/production Compose config, Prisma validation,
  `git diff --check` и сборка общего API/worker image прошли.
- [x] Новые dependencies не добавлены; opt-in real OpenAI smoke намеренно не
  запускался.

## Этап 9. Employee/Admin results UI и rating

- [ ] Реализовать employee `/training` и Telegram connection state.
- [ ] Показывать employee только разрешённый собственный результат.
- [ ] Не показывать employee transcript/errors/audio/rating.
- [ ] Оставить Telegram result кратким.
- [ ] Реализовать admin filters/detail/timeline/audio/transcript/evidence.
- [ ] Реализовать review/override UX с обязательной причиной.
- [ ] Реализовать утверждённую rating formula и columns.
- [ ] Использовать best reviewed final score.
- [ ] Исключить storage keys/audio URLs из exports.
- [ ] Добавить ownership/IDOR и frontend tests; запустить build/tests.

## Этап 10. Security, deploy и pilot preparation

- [ ] Реализовать consent/notification.
- [ ] Добавить webhook hardening, rate/input limits и prompt-injection guards.
- [ ] Проверить private audio и privileged access audit.
- [ ] Добавить structured logs/counters без secrets/audio/transcript.
- [ ] Добавить worker health/readiness.
- [ ] Добавить полный fake E2E утверждённого сценария.
- [ ] Создать обезличенный eval dataset scaffold без raw personal audio.
- [ ] Обновить env/migration/worker/ffmpeg/webhook/backup/rollback docs.
- [ ] Подготовить pilot checklist для ЖК «Шагал» без реальных материалов.
- [ ] Выполнить финальные `pnpm build` и все tests.
- [ ] Не выполнять production deploy без отдельного запроса.

## Следующий этап

Точный следующий этап: `docs/training/prompts/09_results_ui_rating.md`.
Этап 9 не начинался.

Он не начат и не должен выполняться автоматически. Перед ним нужно:

1. получить отдельный запрос пользователя;
2. повторно проверить branch/status и сохранить чужие изменения;
3. прочитать prompt этапа 9 и visibility/rating части спецификации;
4. не расширять review backend в results/rating frontend без отдельного
   запроса.
