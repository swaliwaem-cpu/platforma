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

## Fake evaluation boundary

Создаётся один узкий `TrainingEvaluator` contract и одна синхронная
`DeterministicFakeTrainingEvaluator` реализация без network calls.

Evaluator получает четыре выбранных snapshot-вопроса, финальные текстовые
ответы и snapshot scoring config. Он возвращает result status, final score или
`null` для `REQUIRES_REVIEW`, а также согласованные per-question scores.

Development-механизм детерминирован:

- точный нормализованный `FAKE_PASS` даёт максимум ответа;
- точный нормализованный `FAKE_FAIL` даёт ноль;
- любой иной текст детерминированно даёт ноль;
- хотя бы один точный нормализованный `FAKE_REVIEW` завершает попытку как `REQUIRES_REVIEW` без
  подтверждённого final score.

Маркеры не являются публичным продуктовым контрактом. Provider registry,
provider-run tables, retries, billing и recovery не создаются.

## Permissions Stage 1

- `training:participate` определяет eligible-сотрудника и разрешает employee
  list, start, answer и чтение только собственных результатов.
- `training:manage` вместе с существующим `admin:access` разрешает authoring,
  publish/open и минимальный admin просмотр попыток.

Отдельный results permission появится только при реальном разделении
обязанностей. Frontend gates отвечают за UX; backend guards и ownership — за
доступ.

## Минимальная видимость Stage 1

- Employee history — только собственные summary: номер/дата попытки, status и
  подтверждённый score; без текстов ответов и скрытых данных.
- Admin attempt view — четыре выбранных snapshot-вопроса, fake text answers,
  timestamps, status и score. Review, ошибки, ranking и общий dashboard не
  создаются.
- `REQUIRES_REVIEW` не участвует в best/last confirmed score.

## Явно отложено

Все детали voice grace period, transcription, rubric, facts, penalty evidence,
unsupported claims, review, materials, ranking, retention, operations и
production rollout решаются только в соответствующих этапах.

## NEEDS_DECISION

Эти вопросы не блокируют проектирование, но указанные вопросы Stage 1 нужно
закрыть до реализации связанного поведения:

1. Каковы допустимые min/max и единица timer; рекомендуется хранить целые секунды
   и требовать явное значение без неутверждённого default.
2. Какие текущие роли получают `training:participate`; eligibility уже
   определяется permission, но seed mapping не утверждён.
3. Где проходит проверяемая server-side граница между техническим
   reload/reconnect активного взаимодействия и брошенной попыткой, которую
   запрещено продолжать позднее; до решения recovery behavior не предполагается.
4. Как завершать неполную попытку по timeout; рекомендуется terminal
   `TIMED_OUT` без подтверждённого score, пока другое правило не утверждено.
5. Что делает закрытие проекта с уже начатой попыткой; рекомендуется запрещать
   новые старты, но дать snapshot-попытке завершиться в исходный deadline.
6. Как вычисляется показываемый project-level status, если у сотрудника
   одновременно есть confirmed `PASSED`/`FAILED` и `REQUIRES_REVIEW`; это нужно
   решить до реализации employee project list.
