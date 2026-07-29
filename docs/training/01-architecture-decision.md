# Architecture Decision: модуль обучения в существующей Platforma

Дата: 2026-07-25; дополнение принято 2026-07-29.

Статус: архитектурная основа реализована по этапам 1–10; дополнение
`linked-object PDF + assignments` принято к реализации.

## 1. Контекст

Модуль обучения должен быть частью текущей Platforma. Он использует существующих
пользователей, auth/RBAC, PostgreSQL/Prisma, S3-compatible storage, frontend и
deploy-контур. Этап 0 не меняет production-код и фиксирует решения для будущих
этапов.

Ключевые ограничения:

- отдельные employee, база, auth, web-приложение и админка запрещены;
- опубликованный training content immutable;
- attempts pinned к опубликованной версии;
- Telegram/OpenAI не вызываются в обычных tests;
- voice, transcript и оценки хранятся согласно бизнес-политике бессрочно;
- audio не получает публичный URL;
- Redis нельзя считать готовой durable queue только потому, что он есть в Compose.

## 2. Принятые решения

### ADR-01. Встраивать модуль в текущий monorepo

Будущие точки размещения:

```text
apps/api/src/training/
apps/api/src/training/training.module.ts
apps/api/src/training/telegram/
apps/api/src/training/providers/
apps/api/src/training/jobs/
apps/api/src/training/document-ingestion/
apps/api/src/training/training-worker.main.ts

apps/web/src/training/

packages/shared/src/training.ts
packages/shared/src/index.ts

apps/api/prisma/schema.prisma
apps/api/prisma/migrations/<timestamp>_add_training_module/

apps/api/tests/training-*.test.cjs
apps/web/tests/training-*.test.mjs

docker-compose.yml
apps/api/Dockerfile
.env.example
apps/api/.env.example
docs/training/
```

`TrainingModule` регистрируется в текущем `AppModule`. Новый workspace package
или отдельное приложение не создаются.

### ADR-02. Переиспользовать User и существующий RBAC

- Training participant — существующий `User`.
- Отдельная `Employee` model не создаётся.
- `TrainingProject.realEstateObjectId` nullable и ссылается на существующий
  `RealEstateObject`.
- Training controllers используют существующие `JwtAuthGuard`,
  `PermissionsGuard`, `@RequirePermissions`.
- Роль `training_admin` и training permission keys добавляются idempotently
  через текущий seed только на этапе 1.
- Главный `admin` получает полный training permission set.
- Protected audio требует отдельный `training:audio:read`.
- Employee endpoints дополнительно проверяют ownership, чтобы исключить IDOR.
- Telegram webhook не использует пользовательский JWT: он проверяет отдельный
  webhook secret и idempotency key/update ID.

Точная permission matrix берётся из утверждённой training-спецификации на этапе
1; этап 0 не добавляет и не угадывает новые keys.

### ADR-03. Хранить domain state в PostgreSQL/Prisma

Prisma schema расширяется additive migration на этапе 2. Основные инварианты:

- content разделён на mutable draft и immutable published version;
- attempt всегда хранит version ID и выбранные question IDs;
- backend выбирает три разных follow-up из десяти;
- voice segment, answer, transcript, AI suggestion, deterministic score,
  admin override и final score хранятся раздельно;
- Telegram updates/messages и jobs имеют unique/idempotency constraints;
- attempts/review/history не зависят от последующих изменений объекта каталога;
- privileged actions пишутся в существующий `AuditLog`.

Отдельная БД или event store не вводятся.

### ADR-04. Использовать PostgreSQL-backed TrainingJob

Для training jobs выбирается persisted queue в PostgreSQL:

- atomic claim/CAS;
- status, kind, attempts, availableAt;
- heartbeat и stale recovery;
- bounded retries/backoff;
- idempotency key;
- error category без secrets/transcript в structured logs.

Существующий `ProjectPresentationsWorkerService` служит reference pattern для
claim/heartbeat/recovery, но training worker запускается отдельным process через
`training-worker.main.ts`. In-memory feed queue не переиспользуется.

Redis/BullMQ не добавляются до появления измеримой необходимости, потому что
Redis client и durable Redis queue сейчас отсутствуют.

### ADR-05. Отделить private training storage от текущего public URL flow

Training audio хранится в отдельном private bucket либо через явно
multi-bucket-aware storage abstraction. Обязательные свойства:

- bucket/key хранятся server-side;
- `url` остаётся `null`;
- `getPublicUrl()` не вызывается;
- bucket policy не допускает anonymous read;
- выдача идёт только через backend streaming endpoint;
- endpoint требует JWT, `training:audio:read` и пишет audit log;
- Telegram file URL не сохраняется как долговременная ссылка;
- временные файлы worker удаляются в `finally`;
- lifecycle/retention не включают auto-delete при текущей политике.

Текущий `FilesService` можно расширить общими безопасными primitives, но нельзя
использовать его public URL semantics для audio.

### ADR-06. Сохранить ручной frontend routing

Добавляются route roots:

```text
/training
/admin/training
```

Они интегрируются в существующий `App.tsx`/navigation pattern и permission
gates. Миграция всего приложения на React Router не входит в задачу. Если
route-конфигурация выносится из `App.tsx`, существующие URL и поведение должны
остаться без изменений и получить regression tests.

### ADR-07. Использовать provider abstractions и native fetch

Telegram и OpenAI интеграции оформляются интерфейсами с:

- real server-side fetch provider;
- deterministic fake provider;
- fixture-based provider tests;
- timeouts, retries и нормализованными ошибками;
- explicit opt-in smoke commands.

Telegram SDK и OpenAI SDK по умолчанию не нужны: Node 22 предоставляет `fetch`,
а prompts прямо требуют provider boundary. Решение об SDK можно изменить только
при доказанном снижении риска/сложности.

Для OpenAI:

- transcription — Audio Transcriptions API;
- evaluation — Responses API со strict Structured Outputs;
- model IDs — только env;
- `store: false`, где поддерживается;
- модель не выбирает вопросы и не считает final score;
- schema/evidence/IDs валидирует backend.

### ADR-08. Извлекать документы асинхронно, а оценивать только подтверждённые факты

PDF/DOCX/PPTX/XLSX являются источниками чернового extracted text. Они не являются
непосредственным rubric/source of truth. В scoring участвуют только
структурированные факты, подтверждённые администратором и опубликованные в
immutable version.

Pipeline обязан проверять:

- размер до и во время чтения;
- extension, declared MIME и magic bytes;
- compressed/uncompressed size и entry count для OOXML;
- timeouts и extracted text limit;
- отсутствие text layer (`NEEDS_MANUAL_TEXT`);
- source locator: PDF page, DOCX section, PPTX slide, XLSX sheet/cell.

OCR не входит в первый MVP.

### ADR-09. Сохранить текущий test stack

- Unit/contract/integration tests остаются на `node:test`.
- API tests по текущему convention сначала собирают TypeScript.
- External providers всегда fake/fixture в обычном test run.
- Реальные OpenAI/Telegram smoke tests opt-in и не запускаются без secrets и
  явного разрешения.
- Browser E2E нельзя считать существующим только по devDependency
  `@playwright/test`; harness должен быть добавлен и описан отдельно, если он
  потребуется финальному этапу.

### ADR-10. Выделить worker в deploy-контуре

На этапе audio worker:

- в `apps/api/package.json` появляется отдельный worker script;
- `apps/api/Dockerfile` получает отдельный worker target или эквивалентный
  изолированный runtime layer с ffmpeg/ffprobe;
- `docker-compose.yml` получает `training-worker`;
- API и worker используют одну БД и private storage;
- миграции выполняются до запуска обоих процессов;
- worker получает отдельные health/readiness semantics;
- API не выполняет тяжёлые ffmpeg/OpenAI jobs в webhook request.

Конкретная Docker target layout проверяется на этапе 7; отдельный новый
Dockerfile не создаётся без необходимости.

### ADR-11. Ввести явную аудиторию проекта и M:N назначения

- `TrainingProjectAudienceMode` имеет `ALL_ELIGIBLE | ASSIGNED_ONLY`.
- Additive migration выставляет существующим проектам `ALL_ELIGIBLE`, чтобы не
  ломать текущую доступность; новые проекты получают `ASSIGNED_ONLY`.
- `TrainingProjectAssignment` связывает существующие `User` и
  `TrainingProject`, поддерживает soft revoke/reactivate и unique
  `(projectId, userId)`.
- Пустой active assignment set означает «никому». `ASSIGNED_ONLY` нельзя
  открыть без хотя бы одного активного, не удалённого пользователя с
  `training:take`.
- Назначение следует за текущей active published version при каждом новом
  старте; созданная attempt по-прежнему pins конкретный version ID.
- Revoke блокирует новые Platforma/Telegram/deep-link/start flows, но не
  останавливает уже начатую attempt и не удаляет историю.
- Audience/assignment mutations используют optimistic `audienceRevision`,
  canonical no-op idempotency и тот же `user + project` advisory-lock order,
  что transactional attempt start.

Общий `/users` не переиспользуется: training admin получает узкий eligible
assignee endpoint под `training:projects:manage`, без расширения `users:read`.

Это изменение несовместимо с assignment-unaware старым API при включённом
training: старый код интерпретирует все `OPEN` проекты как глобальные и может
показать `ASSIGNED_ONLY` нецелевым пользователям. После появления таких
проектов rollback допускается только при `TRAINING_MODULE_ENABLED=false` либо
на assignment-aware revision; additive tables/columns не удаляются.

### ADR-12. Переиспользовать PDF связанного ЖК как явный source

- Источник выбирается только через принадлежность
  `RealEstateObject → ObjectFile → File` текущему `realEstateObjectId`.
- `TrainingSourceDocument` переиспользует существующий `File` и получает
  `originKind=LINKED_OBJECT_PDF` плюс immutable provenance snapshot. Storage
  copy не создаётся без доказанной lifecycle-проблемы.
- Перед attach повторно проверяются ownership, PDF MIME/magic bytes, size и
  checksum; arbitrary `fileId` не принимается.
- `PRESENTATION`/`DOCUMENT` отмечаются UI по умолчанию, `FLOOR_PLAN` выбирается
  вручную.
- Смена ЖК не удаляет и не перепривязывает прежние sources. Manual upload и
  official URL остаются отдельными источниками.
- Выбор ЖК/PDF не запускает OpenAI. Pipeline остаётся:
  extraction → explicit suggestions → human-approved facts → publish.
- Многообъектные `ProjectPresentationDocument` исключены из v1 из-за другой
  семантики snapshot/delete и отсутствия однозначного одного связанного ЖК.

## 3. Зависимости

На этапе 0 новые зависимости не добавляются.

Предварительный минимальный набор для последующих этапов:

| Потребность | Кандидат | Почему нужен | Когда принять окончательное решение |
| --- | --- | --- | --- |
| Определение реального file type | direct dependency `file-type` | Нельзя полагаться только на extension/MIME; сейчас пакет лишь transitive | Stage 4 после fixture tests |
| PDF text layer | `pdfjs-dist` | Извлечение текста и page locator без OCR | Stage 4 после Node 22 compatibility check |
| DOCX | `mammoth` | Поддерживаемое извлечение текста/структуры DOCX | Stage 4 после security/size review |
| PPTX | `yauzl` + direct `fast-xml-parser` | Streaming ZIP limits и чтение slide XML; `fast-xml-parser` уже используется в feed workspace, но не является API dependency | Stage 4 после zip-bomb fixtures |
| XLSX | `exceljs` | Чтение sheets/cells с locator; запись/формулы не нужны | Stage 4 после memory-limit fixtures |
| Audio processing | system packages `ffmpeg`, `ffprobe` | OGG/Opus validation, concat/convert и объективные метрики | Stage 7 в worker image |

Ограничения списка:

- версии не фиксируются до проверки Node 22, license, maintenance и security;
- один package не должен добавляться только ради convenience API;
- Telegram/OpenAI SDK не планируются;
- `ffmpeg`/`ffprobe` — container/system dependencies, не npm packages;
- lockfile изменяется только на соответствующем отдельно подтверждённом этапе.

## 4. Отклонённые альтернативы

| Альтернатива | Причина отклонения |
| --- | --- |
| Отдельное training-приложение/БД/auth | Дублирует Platforma и нарушает бизнес-ограничение |
| React Router migration | Широкий несвязанный риск для всех текущих routes |
| BullMQ только из-за наличия Redis | В приложении нет Redis client/queue; PostgreSQL pattern уже подтверждён |
| In-memory queue для audio/AI | Теряет задания при restart и не даёт durable idempotency |
| Public S3 URL для audio | Нарушает privacy/permission/audit требования |
| Реальные Telegram/OpenAI calls в CI | Нестабильность, расходы, secrets и персональные данные |
| AI selection вопросов/final scoring | Противоречит deterministic backend rules |
| OCR в MVP | Не входит в утверждённый scope |

## 5. Нерешённые решения перед реализацией

1. Уточнить, обязателен ли отдельный
   `docs/training/03-security-and-data-flow.md` уже в Stage 0.
2. Зафиксировать точную permission matrix из training spec в Stage 1.
3. До Stage 4 проверить выбранные parser packages на Node 22, лицензии,
   zip-bomb/memory limits и реальные fixtures.
4. До Stage 7 подтвердить private bucket policy в целевом S3 и deployment
   способ установки ffmpeg.
5. До Stage 8 зафиксировать разрешённые OpenAI model IDs и data controls в env.
6. До Stage 10 определить, нужен ли настоящий Playwright E2E или достаточно
   утверждённого fake HTTP/domain E2E.

Эти вопросы не являются разрешением начинать следующие этапы.
