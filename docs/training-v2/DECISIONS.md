# Активные технические решения

## Переиспользование Platforma

Training V2 является предметным модулем существующей Platforma и использует:

- NestJS API и его composition root;
- React/Vite frontend, app shell и manual routing;
- PostgreSQL и существующие Prisma integration;
- существующие `User`, `Role`, `Permission` и `RealEstateObject`;
- `AuthProvider`, `apiRequest`, JWT guards и `PermissionsGuard`;
- существующие UI-примитивы; shared-контракты только для API и web вместе.

Отдельные backend, database, admin shell, users и auth flow не создаются.

## Стратегия ровно из пяти этапов

1. **Stage 1 — Web Fake Vertical Slice.** Ручной проект, web attempt,
   текстовые development-ответы, deterministic fake result и минимальный
   Employee/Admin просмотр.
2. **Stage 2 — Telegram и Voice Transport.** Связь Telegram с `User`, bot shell,
   voice-сегменты, finish action, private storage, download, `ffmpeg`, fake
   transcription и fake evaluation; без OpenAI.
3. **Stage 3 — OpenAI и Review.** Реальная транскрибация, approved facts,
   структурированное оценивание, критерии, штраф `−5`, unsupported claim,
   минимальный review и server-side final score; без parsers и ranking.
4. **Stage 4 — Материалы и Admin Content.** PDF с текстовым слоем, явно
   добавленный официальный HTTPS URL, ручной текст и immutable snapshot
   выбранных стабильных полей связанного `RealEstateObject`; extraction и AI
   suggestions остаются черновиками до ручного создания `TrainingFact`.
5. **Stage 5 — Results, Ranking и Production Hardening.** Полные admin results,
   расширенная employee history, audio playback, полная review history,
   ranking, при необходимости CSV, security, минимальные operations, deploy,
   pilot и calibration.

Stage 5 выполняется четырьмя отдельными последовательными частями: Part 1 —
employee/admin results, protected audio и review integration; Part 2 — ranking,
current coverage и связанный CSV export; Part 3 — следующие отдельно
утверждённые product surfaces; Part 4 — production hardening и общий E2E.
Каждая часть требует отдельного разрешения. Реализация Part 2 не означает начало
Part 3–4.

## Stage 5 Part 1 — результаты, защищённое аудио и review

- Исторический результат всегда строится из `TrainingAttempt` и его immutable
  snapshot. Live project title/settings не переписывают историю.
- Current access mode, assignment и user/project availability вычисляются
  отдельно и показывают только состояние на момент запроса.
- Подтверждёнными являются terminal attempts с server-side `finalScore` и
  `isPassed`. `REQUIRES_REVIEW` скрывает provisional result;
  `TECHNICAL_FAILED` результата не имеет и возвращает попытку.
- Timeout остаётся terminal result и использует `expiresAt` для duration.
- Employee получает только safe breakdown: sequence/type/score/maxScore и уже
  разрешённый `safeBreakdownJson`; transcript, full evaluation, request IDs,
  facts, provider и storage metadata остаются admin-only.
- Admin list выполняет server-side pagination/filter/sort и отдаёт lightweight
  rows. Admin detail сохраняет существующую evidence-модель и добавляет snapshot,
  current access, duration, reviewer, answer source/request IDs и
  `audioAvailable` без file id/bucket/key/checksum.
- `training:results:read`, `training:results:review` и
  `training:audio:read` независимы. Seed выдаёт новый audio permission только
  admin role.
- Audio никогда не публикуется и не получает presigned URL. Endpoint читает
  детерминированный private object через backend, fail-closed проверяет metadata
  и WAV integrity, отвечает `private, no-store` и пишет успешное чтение в
  `AuditLog` без bucket/key/checksum.
- Browser создаёт Blob URL только после явного действия, отменяет устаревший
  запрос и всегда вызывает `URL.revokeObjectURL` при замене, закрытии и unmount.
- Review POST и последующий detail refresh — две разные операции. Успешный POST
  немедленно обновляет локальный terminal state; сбой GET требует только refresh.
- Новая Prisma migration не нужна: текущие Attempt/Question/Answer/File/AuditLog
  и assignment history покрывают Part 1. Индекс не добавляется без плана на
  реалистичной кардинальности; локальная малая fixture не является основанием
  для migration.

## Stage 5 Part 2 — рейтинг, текущий охват и CSV

- Исторический рейтинг строится из существующих attempts. Для каждой пары
  employee/project выбирается подтверждённая counting attempt с максимальным
  `finalScore`; при равенстве — более новая по `startedAt`, затем больший `id`.
- Подтверждёнными являются только `COMPLETED | TIMED_OUT` с non-null
  `finalScore/isPassed`, resolved либо не требовавшимся review и
  `countsTowardAttemptLimit=true`. Pending review и `TECHNICAL_FAILED`
  исключаются. Historical `isPassed` не пересчитывается по live `passScore`.
- Revoke assignment, смена access mode и закрытие проекта не удаляют historical
  best. Current coverage рассчитывается отдельно по единой Stage 4.5 policy.
- Universe рейтинга — объединение пользователей с historical confirmed result
  и пользователей хотя бы с одним currently eligible project.
- `project` и `accessMode` задают scope проектов до historical/current
  aggregation. `currentlyAssigned` и `currentlyEligible` являются tri-state
  row filters после aggregation: `true` означает хотя бы один, `false` — ни
  одного соответствующего проекта в scope.
- `attemptsUsed` считает все attempts с `countsTowardAttemptLimit=true` в scope.
  Passed/completed, score и duration считаются по одному best result на project.
- `averageBestScore` — PostgreSQL `AVG(finalScore::numeric)`. Сортировка идёт по
  exact numeric до display rounding; наружу значение округляется
  `ROUND_HALF_UP` до двух знаков и передаётся decimal-строкой.
- `currentCoveragePercent` равен completed eligible / eligible * 100 и равен
  `null`, если eligible denominator равен нулю. Current passed использует
  historical `isPassed` выбранного best result.
- Основной list query применяет filters, `COUNT(*) OVER()`, stable order и
  `LIMIT/OFFSET` в PostgreSQL. Project breakdown/evaluation aggregates
  загружаются одним bounded query только для users текущей страницы.
- Deterministic summary не использует OpenAI. Criterion analytics берётся из
  immutable snapshot и validated evaluation best attempts. Breakdown
  `OVERRIDDEN` attempt не используется для strongest/weakest; при недостатке
  согласованных данных выводится «Недостаточно данных».
- Ranking API и CSV защищены `training:results:read`. CSV выполняет тот же core
  и filters батчами по 100, сохраняет exact order, добавляет UTF-8 BOM, quoting
  и formula-injection protection после проверки leading whitespace.
- Ranking/CSV используют explicit allowlist. Transcript, evidence, audio,
  storage, source excerpts, provider payload/request IDs, review comments,
  Telegram IDs и secrets не экспортируются.
- Отдельные ranking/analytics/export tables и materialized results не создаются.
  Additive index допустим только после `EXPLAIN (ANALYZE, BUFFERS)` на synthetic
  dataset; отсутствие доказательства означает отсутствие migration.

Новый этап начинается только после приёмки текущего и отдельного разрешения.

## Этап 4.5 — назначение проектов пользователям

Этап 4 принят. Между Stage 4 и будущим Stage 5 добавлен ограниченный слой
контроля доступа к проектам. Текущее явно утверждённое задание этапа 4.5
заменяет прежнее ограничение первой версии об одинаковом списке проектов и
отсутствии индивидуальных назначений. Stage 5 при этом не начинается.

- Каждый `TrainingProject` имеет явный `accessMode`.
- `ALL_PARTICIPANTS` разрешает новую попытку всем активным неудалённым
  пользователям с permission `training:participate`.
- `ASSIGNED_USERS` дополнительно требует активный `TrainingProjectAssignment`.
- Назначение не выдаёт permission и не меняет роль пользователя.
- Новые проекты создаются с `ASSIGNED_USERS`; существующие проекты при migration
  получают `ALL_PARTICIPANTS`, сохраняя прежнюю видимость.
- Переключение режима не удаляет назначения. В `ALL_PARTICIPANTS` они сохраняются,
  а при возврате в `ASSIGNED_USERS` снова учитываются.
- Назначение и отзыв влияют на видимость и новые попытки, но не удаляют историю,
  answers, audio, results или immutable attempt snapshot.
- Уже начатая попытка продолжает работать после отзыва. После её завершения новая
  попытка без назначения блокируется; собственная история остаётся доступной.
- Назначения являются текущим контролем доступа и не входят в snapshot учебного
  содержимого.
- Одна активная попытка ограничена парой `(userId, projectId)`. Глобальная
  блокировка проекта для стартов разных пользователей запрещена.
- Один общий Telegram-бот обслуживает всех пользователей; каждый активный
  Telegram-account связан со своим существующим `User`.
- Создание project link, использование одноразового token и подтверждение старта
  повторно проверяют актуальную общую политику. Token не является постоянным
  доказательством доступа.
- Гонка revoke/start сериализуется одинаковым порядком блокировок: если revoke
  зафиксирован первым, новый start блокируется; если start зафиксирован первым,
  текущая попытка продолжает работать.

Используется один предметный `TrainingProjectAccessService`: он формирует DB
filter списка, проверяет новый start и Telegram-сценарии, а также отделяет право
продолжить активную попытку от права создать новую. Условия access mode,
assignment, user status и permission не дублируются во frontend или нескольких
services.

Административные операции используют существующий permission
`training:projects:manage` и максимум два новых endpoint-а: paginated безопасный
picker пользователей и атомарный bulk `ASSIGN | REVOKE`. Mode-only изменение
использует существующий project `PATCH`, не снимает publication/open и пишется в
существующий `AuditLog`. Bulk audit не содержит email, Telegram ID или полный
список user IDs.

В этап 4.5 не входят ranking, CSV, перестройка results, operations, notifications,
индивидуальные сроки/оценивание/лимиты/таймеры, группы, отделы, команды, офисы,
массовый импорт пользователей, отдельные Telegram-боты и production deploy.

## Граница Stage 1

Stage 1 — синхронный web-only vertical slice. Текстовые ответы существуют только
как development-замена будущего voice pipeline и не являются финальным
продуктовым поведением.

В Stage 1 нет Telegram, voice/audio, storage, `ffmpeg`, OpenAI, worker, queue,
outbox, provider runs, parsers, review, ranking, CSV, operations, notifications,
analytics, assignments и deploy.

## Граница Stage 2

Stage 2 добавляет реальный Telegram transport и реальную обработку Telegram
voice без настоящей транскрибации. Employee выбирает проект только в Platforma;
одноразовая deep link содержит выбранный `projectId` через server-side token и
никогда не превращает Telegram в каталог проектов.

- Telegram account связывается только с существующим активным `User`.
- Поддерживается только private chat и только `message.voice`.
- Один ответ состоит из одного или нескольких последовательно сохранённых voice
  segments и переходит в обработку только после отдельного действия
  «Завершить ответ».
- Worker действительно скачивает Telegram-файлы, сохраняет originals в
  отдельном private bucket и нормализует их через `ffmpeg` в один WAV PCM mono
  16 kHz.
- Транскрипция остаётся детерминированной fake-реализацией, которая по умолчанию
  возвращает `[fake:pass]`. Оценивание и progression переиспользуют существующий
  Stage 1 `TrainingEvaluator` и общий completion flow.
- Stage 1 text mode сохраняется только как development/test fallback. В
  production UI основной CTA ведёт в Telegram.

В Stage 2 нет OpenAI, facts/criteria, manual review, admin audio player,
documents/parsers, ranking, CSV, policy acceptance, operations и production
deploy.

## Telegram link, dialog и idempotency Stage 2

- Raw link token возвращается только внутри `https://t.me/...?...` и не
  сохраняется; PostgreSQL хранит SHA-256 hash. TTL — 15 минут.
- Создание deep link не создаёт и не расходует попытку. Попытка стартует только
  после Telegram callback и использует существующую транзакционную защиту
  limit/active attempt/retake/snapshot/timer.
- Token consume, active-account conflicts, start callback, segment insert и
  finish transition защищены транзакциями и unique constraints. Exactly-once
  Telegram delivery не обещается; повторное информационное сообщение допустимо.
- `/start` без token выводит состояние из `TrainingAttempt`,
  `TrainingAttemptQuestion` и `TrainingAnswer`. Отдельная Telegram session/state
  machine не создаётся.
- Project context берётся из последнего успешно использованного project-bound
  link token; при его отсутствии допускается fallback только на единственную
  active attempt пользователя.
- Unlink endpoint в Stage 2 не добавляется: безопасный lifecycle отвязки требует
  отдельного продуктового решения, а текущий flow в нём не нуждается.

## Audio и processing Stage 2

- `TrainingAnswer` со статусом `PROCESSING` является persisted processing unit;
  отдельные job/outbox/provider-run tables не создаются.
- Worker claim использует PostgreSQL `FOR UPDATE SKIP LOCKED`, ownership lock,
  heartbeat, stale-lock recovery и максимум три попытки обработки.
- Original OGG и merged WAV имеют детерминированные keys без PII, отдельный
  `TRAINING_AUDIO_BUCKET` и `File.url=null`. Повторная обработка переиспользует
  тот же object/File.
- `ffmpeg` запускается через `spawn` с `shell:false`, фиксированными аргументами,
  timeout и cleanup уникальной temp directory в `finally`.
- Domain transition и progression фиксируются до outbound Telegram message.
  Ошибка отправки не откатывает ответ; `/start` восстанавливает состояние.
- После исчерпания processing attempts answer получает `FAILED` без transcript,
  score и обычного pass/fail. Attempt остаётся `IN_PROGRESS`, поэтому техническая
  ошибка не превращается в низкую оценку. Повтор ответа в Stage 2 не реализован;
  это явное ограничение до отдельного решения следующих этапов.

## Timeout Stage 2

Stage 1 timer остаётся источником истины. Telegram update и worker перед
изменением progression применяют тот же lazy timeout. Истёкшая попытка не
принимает новые segments; unfinished Telegram answer становится `FAILED` с
техническим code, unanswered question получает timeout-состояние, а attempt не
может стать passed.

Grace period для voice, начатого до `expiresAt`, в Stage 2 отсутствует. Его нельзя
добавить корректно без дополнительного lifecycle, поэтому решение явно
отложено до Stage 3/5.

## Граница Stage 3

Stage 3 заменяет fake provider-часть единственного voice processing flow на
настраиваемые backend-only реализации, добавляет approved facts, criteria,
детерминированный backend scoring и одноразовую ручную проверку. Stage 1 fake
mode сохраняется для development и tests; второго progression flow нет.

- Основная transcription model —
  `gpt-4o-mini-transcribe-2025-12-15`; запрос идёт native `fetch`/`FormData` в
  `POST /v1/audio/transcriptions`.
- Evaluation model — `gpt-5.6-terra`, reasoning effort — `medium`; запрос идёт
  native `fetch` в Responses API `POST /v1/responses` с `store=false` и strict
  JSON Schema.
- OpenAI вызывается только backend. `tools`, web search, file search, external
  knowledge, `previous_response_id`, conversation и background mode запрещены.
- Модель возвращает только assessments/evidence/unsupported claims/summary и
  не возвращает final score или pass/fail. Transcript объявлен недоверенными
  данными; IDs и evidence повторно проверяет backend.
- Итог одного answer равен сумме разрешённых criterion points с clamp и штрафом
  `−5` за каждый distinct `INCORRECT` fact. Unsupported claim автоматически не
  штрафуется, но всегда требует ручной проверки.
- Stage 2 technical `FAILED` lifecycle заменён terminal
  `TECHNICAL_FAILED`: попытка сохраняется, не расходует limit, не имеет
  `finalScore`, возвращается сотруднику и допускает replacement attempt.

В Stage 3 нет документов/parsers, extraction, RAG, embeddings, ranking, CSV,
operations dashboard, отдельного worker container, generic queue/job, outbox,
provider-run tables, полной review history и production deploy.

## Facts, criteria и immutable snapshot Stage 3

- Добавляются только две основные модели: `TrainingFact` принадлежит одному
  question, `TrainingCriterion` — project и template `MAIN | FOLLOW_UP`.
- Default criteria редактируемы: MAIN `5 + 15 + 15 + 10 + 10 = 55`, FOLLOW_UP
  — один `answer_quality = 15`. Admin может менять состав при сохранении точных
  totals `55/15` и уникальных codes внутри project/question type.
- Новый project получает `contentSchemaVersion=2`. Publication/open требует
  ровно `1 + 10` active questions, минимум один active fact на каждый question,
  валидные ограниченные aliases и точные criteria totals.
- Attempt snapshot schema v2 содержит settings, все 11 questions, fact IDs,
  statements, aliases, required/position, оба criteria templates, scoring и
  evaluation schema versions. После start evaluation не читает live
  facts/criteria.
- Исторические schema v1 snapshots не конвертируются. Existing projects получают
  `contentSchemaVersion=1`; новые Stage 3 projects создаются как v2.

## OpenAI request и recovery boundary Stage 3

- Перед transcription backend повторно читает только merged private WAV
  текущего answer и проверяет ownership, bucket, MIME, RIFF/WAVE, размер и
  checksum. Лимит OpenAI transcription — 25 MB.
- Vocabulary prompt содержит только короткие NFC-normalized project/object names
  и aliases. Полные fact statements, criteria guidance, scoring rules, эталонный
  ответ и данные сотрудника туда не передаются.
- Один hard deadline охватывает bounded retries. Retryable: `429`, `5xx`,
  timeout/network и временно malformed provider response. `400`, `401`, `403`,
  invalid audio/model/configuration и size limit не retry-ятся. `Retry-After`
  учитывается только внутри оставшегося deadline.
- `TrainingAnswer` остаётся processing unit и хранит отдельные checkpoints:
  transcript/provider metadata, затем validated evaluation/objective metrics и
  server score, затем общий progression. Restart не повторяет уже сохранённый
  checkpoint; progression/follow-up/finalization защищены транзакцией.
- Внешний OpenAI request выполняется вне database transaction. Crash после
  provider response, но до checkpoint save, может повторить платный request;
  exactly-once billing в Stage 3 не обещается.
- API key, Authorization header, transcript в logs, полный prompt/raw request,
  chain-of-thought и неограниченный raw provider response не сохраняются.

## Objective metrics Stage 3

Backend считает только `audioDurationSeconds`, `segmentCount`, `wordCount`,
`wordsPerMinute`, `fillerWordsCount` и `fillerWordsFound` по ограниченному списку
русских filler phrases. Пол, возраст, акцент, национальность, эмоции,
психологическая уверенность, харизма и личность не оцениваются.

## Минимальный review и visibility Stage 3

- Permission `training:results:review` добавляется только admin seed role; user
  и editor не получают его автоматически.
- Единственный новый endpoint —
  `POST /training/admin/attempts/:attemptId/review`. `APPROVE` принимает
  `calculatedScore`; `OVERRIDE` требует `finalScore 0..100` и непустую причину.
- Review одноразовый. Точный повтор resolved payload идемпотентен; другой payload
  получает conflict. Отдельной review table/history нет.
- При unsupported claim attempt сохраняет `calculatedScore`, переходит в
  `REQUIRES_REVIEW`, но employee DTO скрывает provisional score, breakdown,
  transcript, evaluations, facts/provider metadata, review comment и internal
  error. Admin detail видит evidence, metrics, models, calculated/final score и
  safe technical error code.
- После `APPROVE` employee получает final score и согласованный safe breakdown.
  После `OVERRIDE` старый breakdown скрывается и показывается нейтральное
  сообщение. После `TECHNICAL_FAILED` показывается только безопасное сообщение
  о возврате попытки.

## Historical integrity

Рассмотрены два варианта:

- **A: опубликованная версия проекта.** Даёт постоянный version lifecycle, но
  уже сейчас требует шестую модель, active version, copy-on-edit и правила
  переключения draft/published.
- **B: immutable snapshot внутри попытки.** Требует пять моделей. При старте
  атомарно копирует настройки и все 11 вопросов; старая попытка не зависит от
  последующих изменений проекта.

Выбран **вариант B**. `TrainingProjectVersion` в Stage 1 не создаётся. В попытке
сохраняются полный пул 1+10, scoring/timer settings и project title. После
главного ответа три вопроса выбираются только из snapshot-пула. Старые попытки
останутся самодостаточными, если versioning понадобится позднее.

Проект редактируется только закрытым. Изменение закрытого проекта снимает
публикацию; для нового старта нужны повторные publish и open. Удаление проекта в
Stage 1 отсутствует.

`allowRetakeAfterPass=false` запрещает новый start после подтверждённого
`PASSED`. При `true` новый start разрешён только пока не исчерпан общий attempt
limit. Настройка задаётся явно, потому что её default не утверждён.

## Timer, reload и timeout Stage 1

- В `TrainingProject` лимит времени хранится целым числом секунд; default —
  `420` секунд.
- В Admin UI время вводится положительным целым числом минут и передаётся в API
  как секунды. Искусственный верхний product limit в Stage 1 не вводится.
- Один общий timer начинается только после подтверждённого start и сохраняется
  как `startedAt`/`expiresAt` попытки.
- Reload, закрытие вкладки и повторное открытие не ставят timer на паузу, не
  продлевают его и не создают новую попытку. До `expiresAt` Employee продолжает
  ту же active attempt.
- Expiry обрабатывается лениво при API-взаимодействии и загрузке active attempt;
  worker или background timer не создаётся.
- Начатая попытка считается использованной. При timeout она финализируется с
  `completionReason=TIMEOUT`, пропущенными вопросами по `0`, суммой реально
  полученных баллов без нормализации и `isPassed=false` даже при достигнутом
  numeric `passScore`.
- После timeout продолжение и отдельная cancel-команда недоступны.

## Закрытие проекта и active attempt

- Закрытый проект не позволяет создавать новые попытки.
- Уже начатая попытка продолжает работать по immutable snapshot до завершения
  либо timeout.
- Изменение проекта не меняет активную или завершённую попытку.

## Fake evaluation boundary

Создаётся один узкий `TrainingEvaluator` contract и одна синхронная
`DeterministicFakeTrainingEvaluator` реализация без network calls.

Evaluator получает текущий текстовый answer и `maxScore`. Он возвращает
`score`, безопасный breakdown и outcome `SCORED | REQUIRES_REVIEW`. Итог и
pass/fail рассчитывает backend по сохранённым per-question scores и snapshot
настройкам.

Development-механизм детерминирован:

- точный нормализованный `[fake:pass]` даёт максимум ответа;
- точный нормализованный `[fake:fail]` даёт ноль;
- точный нормализованный `[fake:review]` даёт `REQUIRES_REVIEW`;
- любой иной непустой текст получает `min(maxScore, normalizedText.length)`.

Версия этого development-контракта сохраняется в attempt. Пустой answer
отклоняется input validation.

Маркеры не являются публичным продуктовым контрактом. Provider registry,
provider-run tables, retries, billing и recovery не создаются.

## Permissions Stage 1

- `training:participate` определяет eligible-сотрудника и разрешает employee
  list, start, answer и чтение только собственных результатов.
- `training:projects:manage` разрешает authoring, publish и open/close.
- `training:results:read` разрешает минимальный admin просмотр попыток.
- `admin` получает все три permission, `user` — только
  `training:participate`, `editor` не получает Training permissions
  автоматически.

Business logic не проверяет role name. Frontend gates отвечают за UX; backend
guards, permissions и ownership — за доступ. Существующий `admin:access`
продолжает защищать общий `/admin` shell, но не заменяет предметные permissions.

## Минимальная видимость Stage 1

- Employee history — только собственные summary: номер/дата попытки, status и
  подтверждённый score; без текстов ответов и скрытых данных.
- Admin attempt view — четыре выбранных snapshot-вопроса, fake text answers,
  timestamps, status и score. Review, ошибки, ranking и общий dashboard не
  создаются.
- `REQUIRES_REVIEW` не участвует в best/last confirmed score.

Project-level employee summary возвращает раздельно:

- `bestConfirmedScore`;
- `bestConfirmedStatus`;
- `hasPendingReview`.

Подтверждённый `PASSED` остаётся основным статусом при наличии pending review,
а pending показывается отдельно. Если подтверждённого результата нет, но есть
pending review, основной статус — `REQUIRES_REVIEW`. Review resolution в
Stage 1 отсутствует.

## Явно отложено

Document ingestion/extraction и material workflow относятся к Stage 4.
Ranking, CSV, audio playback, полная review history, retention, operations,
production hardening/deploy, pilot и calibration относятся к Stage 5. Voice
grace period не меняется Stage 3 и требует отдельного решения.

## Граница Stage 4

Stage 4 добавляет административные источники approved facts в существующий
Training aggregate. Поддерживаются только:

- PDF с текстовым слоем;
- одна явно добавленная администратором страница официального HTTPS-сайта;
- ручной plain text;
- immutable snapshot allowlisted стабильных полей выбранного
  `RealEstateObject` и всех прикреплённых к нему PDF с текстовым слоем.

DOCX, PPTX, XLSX, OCR, scanned PDF без text layer, crawler, sitemap, поиск в
интернете, RAG, embeddings и vector database не поддерживаются. PDF без
текстового слоя получает безопасную ошибку `PDF_TEXT_LAYER_MISSING`; OCR
автоматически не запускается. Browser fallback обрабатывает только исходную
явно указанную страницу, не кликает ссылки и не выполняет crawling.

`TrainingMaterial` является административным источником одного проекта, а
`TrainingMaterialRevision` — immutable результат конкретной загрузки или
refresh. Старые revisions не перезаписываются. Refresh всегда создаёт новую
revision, считает checksum и bounded segment diff и никогда автоматически не
изменяет существующие `TrainingFact` или attempt snapshots. ЖК выбирается в
admin editor через searchable dropdown, который переиспользует server-side
Platforma search variants, включая запрос в другой клавиатурной раскладке.
Явный import action связывает project с выбранным `RealEstateObject`, создаёт
snapshot всех backend allowlisted стабильных полей и отдельную private immutable
revision для каждого прикреплённого PDF. Live synchronization отсутствует.

Тот же явный import action формирует один главный и десять дополнительных
черновиков вопросов по READY snapshot/PDF revisions. Если в проекте уже есть
вопросы, backend требует отдельного подтверждения их замены. Проект остаётся
`DRAFT`; администратор проверяет и сохраняет вопросы перед публикацией. Это не
является автоматическим созданием или утверждением `TrainingFact`.

## Источник факта и snapshot v3

`TrainingFact` имеет один primary source: `MANUAL` либо `MATERIAL`. Material fact
ссылается на READY revision того же проекта и хранит bounded source label,
locator и точный excerpt из нормализованного segment text. Existing Stage 3
facts backfill-ятся как `MANUAL`. Ручной fact editor сохраняется и не требует
создания отдельного manual material.

Attempt snapshot schema v3 замораживает source type, label, locator, excerpt,
material type, URL snapshot при его наличии и source revision ID. Полный
extracted text, PDF file ID, storage key, raw HTML, suggestions и admin metadata
в snapshot не входят. Snapshot v1 и v2 продолжают читаться без преобразования.

Publication использует только `TrainingQuestion`, подтверждённый
`TrainingFact` и `TrainingCriterion`. Raw materials, extracted text, failed
revisions и AI suggestions не участвуют в scoring и не публикуются отдельно.

## Extraction и private storage Stage 4

Training PDF хранится в отдельном private bucket, имеет `File.url=null` и
выдаётся только через admin endpoint с JWT, `training:projects:manage` и
project/material ownership. Проверяются MIME, `.pdf`, magic bytes `%PDF-`,
размер, non-empty payload, page count и timeout; page text сохраняется bounded
segments с `page:N` locators. Parsing выполняется в памяти без temp files, а
`pdfjs` loading task закрывается в `finally`.

Official URL требует явного подтверждения администратора. Допускается только
HTTPS без credentials, fragment и нестандартного порта. Backend проверяет DNS и
все resolved IP, запрещает localhost/private/link-local/multicast/reserved и
metadata endpoints, вручную и bounded обрабатывает redirects с повторной полной
проверкой каждого destination и запрещает downgrade на HTTP. Response bytes,
content type и timeout ограничены; raw HTML не хранится.

Browser fallback по умолчанию выключен и включается только env-настройкой. Он
использует ephemeral context без persistent profile, cookies, permissions,
clicks, forms и downloads; каждый network request проходит URL/IP validation,
а third-party analytics, images, media и fonts блокируются. Extraction и
browser process завершаются bounded timeout и cleanup в `finally`.

Extraction выполняется явным синхронным admin action вне долгой DB transaction.
Отдельные worker, generic queue, job table и outbox в Stage 4 не создаются.

## AI suggestions Stage 4

Один узкий `TrainingMaterialSuggester` генерирует как fact suggestions, так и
grounded question drafts; он имеет deterministic fake и OpenAI реализации и
выбирается существующим `TRAINING_AI_MODE`. OpenAI использует
существующий client/config и `OPENAI_EVALUATION_MODEL`, Responses API с
`store=false`, strict Structured Outputs, без tools, web/file search,
conversation, background и `previous_response_id`.

В provider передаётся только bounded extracted segment text. PDF binary, raw
HTML, данные других проектов и сотрудников, attempts и scoring туда не входят.
Source text считается недоверенным и не может давать инструкции provider-у.
Детерминированный chunking идёт по границам segments с ограничениями chars,
chunks, total text и общим hard deadline. Частичная ошибка отклоняет весь набор
suggestions и не меняет facts.

Suggestion содержит только target question, statement, aliases, required flag и
точный source locator/excerpt. Backend повторно валидирует strict schema,
question ownership, IDs, locator и excerpt. Suggestion остаётся черновиком:
`TrainingFact` создаётся только отдельным admin apply после выбора и возможного
редактирования. Canonical exact/safe-containment duplicate detection не создаёт
второй fact автоматически. Semantic merge и multi-source facts не входят в
Stage 4.

## Закрытые вопросы Stage 1

Единица/default timer, reload/recovery, timeout, close behavior, role mapping и
сочетание confirmed/pending результата закрыты текущим заданием Stage 1 и
зафиксированы выше. Новых `NEEDS_DECISION` для Web Fake Vertical Slice нет.
