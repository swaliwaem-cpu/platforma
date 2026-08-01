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
4. **Stage 4 — Материалы и Admin Content.** Ручные facts, aliases, criteria,
   PDF/DOCX/PPTX/XLSX, draft extraction, ручное подтверждение и publication
   workflow; без RAG/vector DB без отдельного решения.
5. **Stage 5 — Results, Ranking и Production Hardening.** Полные admin results,
   расширенная employee history, audio playback, review UI, ranking, при
   необходимости CSV, security, минимальные operations, deploy, pilot и
   calibration.

Новый этап начинается только после приёмки текущего и отдельного разрешения.

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

Real transcription/OpenAI, voice grace period, retry UX после технического
`FAILED`, rubric, facts, penalty evidence, unsupported claims, review,
materials, ranking, retention, operations и production rollout решаются только
в соответствующих этапах.

## Закрытые вопросы Stage 1

Единица/default timer, reload/recovery, timeout, close behavior, role mapping и
сочетание confirmed/pending результата закрыты текущим заданием Stage 1 и
зафиксированы выше. Новых `NEEDS_DECISION` для Web Fake Vertical Slice нет.
