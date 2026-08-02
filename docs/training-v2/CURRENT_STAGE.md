# Current Stage: Stage 4 — Materials and Admin Content

## Цель

Дать администратору существующего `TrainingProject` четыре безопасных источника
контента — PDF, официальный URL, ручной текст и snapshot карточки Platforma —,
позволить загрузить карточку выбранного ЖК со всеми его PDF и автоматически
получить черновики 1+10 вопросов, а проверенные AI suggestions вручную
превратить в `TrainingFact` с immutable source citation.

Stage 3 вручную принят пользователем. Stage 4 остаётся текущим до отдельной
ручной приёмки. Stage 5 не начинается автоматически.

## Входит

- Ровно две новые основные модели: `TrainingMaterial` и
  `TrainingMaterialRevision`; material архивируется, revisions immutable.
- Четыре source types: PDF с текстовым слоем, явно подтверждённый official HTTPS
  URL, manual plain text и immutable snapshot выбранных allowlisted полей
  связанного `RealEstateObject`.
- Searchable dropdown выбора ЖК использует те же server-side search variants,
  что каталог Platforma, включая запрос в другой клавиатурной раскладке.
- Явный import action связывает project с выбранным ЖК, создаёт snapshot всех
  стабильных allowlisted полей и private immutable revisions для всех
  прикреплённых к карточке PDF с текстовым слоем.
- По READY snapshot/PDF revisions автоматически создаются черновики ровно
  одного главного и десяти дополнительных вопросов. Замена существующих
  вопросов требует отдельного подтверждения; project остаётся `DRAFT`.
- Bounded extraction, normalized segments, checksum, revision history и
  deterministic segment diff; refresh всегда создаёт новую revision и не меняет
  facts автоматически.
- Отдельный private Training material bucket, `File.url=null`, admin-only PDF
  download с JWT, `training:projects:manage` и ownership.
- SSRF-safe HTTP extraction одной URL-страницы и opt-in isolated browser
  fallback одной страницы без clicks, forms, login, downloads и crawling.
- Один узкий `TrainingMaterialSuggester`: deterministic fake и OpenAI через
  существующий `TRAINING_AI_MODE`, strict schema, bounded chunking и no tools or
  web search.
- Manual review/apply выбранных suggestions. Только успешный apply создаёт
  `TrainingFact`; duplicate warning не создаёт второй fact.
- `TrainingFact` source `MANUAL | MATERIAL`, один primary source и exact
  locator/excerpt. Existing Stage 3 facts становятся `MANUAL`.
- Immutable attempt snapshot schema v3 с bounded source citation при сохранении
  чтения snapshots v1/v2.
- Existing project editor с tab «Материалы», source badges в facts и source
  citation в existing admin attempt detail; новый frontend route не создаётся.
- Publication и scoring используют только approved `TrainingFact`, questions и
  criteria, но не raw materials, extracted text или suggestions.

## Не входит

- DOCX, PPTX, XLSX, OCR, image-to-text и scanned PDF без text layer.
- Crawling, sitemap, follow-links, search engine, web search tool, RAG,
  embeddings и vector database.
- Automatic fact approval, auto-update facts, multi-source merge и live sync с
  `RealEstateObject`.
- Automatic question approval и публикация проекта без ручной проверки admin.
- Ranking, CSV, operations dashboard, notifications, generic worker/queue/job,
  outbox, provider-run tables и document library вне Training.
- Employee material/source endpoints, новые frontend routes, новый UI framework
  и production deploy.
- Изменения Telegram, voice, transcription/evaluation Stage 3, scoring, review,
  random 3/10, timer, attempt limit и employee visibility.

## Реализуемая последовательность

1. Models/enums, additive migration, fact source, snapshot v3 и PostgreSQL
   compatibility.
2. Material revisions, manual text, object snapshot, hashes/diff и tests.
3. Private PDF storage/extraction, validation, timeout/cleanup и Docker check
   при новой dependency.
4. Official URL HTTP extraction, SSRF/redirect protection, opt-in browser
   fallback и local fixture tests.
5. Strict material suggestions, bounded chunking, manual apply и duplicate
   handling.
6. Existing admin editor Materials tab, source badges/citations и browser tests.
7. Searchable object import, все object PDF и grounded 1+10 question drafts.
8. Полные gates, read-only verification и остановка с отчётом без commit/deploy.

## Ограничения scope

- Только две новые основные Prisma models; failed revision не является
  источником facts.
- Один material принадлежит одному project. Все project/material/revision/file
  endpoints проверяют backend permission и ownership.
- External PDF parsing, HTTP/browser extraction и OpenAI requests выполняются
  вне database transaction с server-side timeout.
- Browser fallback выключен по умолчанию и обрабатывает только одну явно
  добавленную страницу.
- Extracted text и AI suggestions являются черновиками. Только подтверждённый
  `TrainingFact` участвует в publication, snapshot и evaluation.
- Старые revisions, facts и attempts не переписываются при refresh или update
  источника.

## Ручная приёмка

Нужны отдельные локальные сценарии из `ACCEPTANCE.md`:

1. PDF upload, extraction, suggestions, manual apply и source page.
2. Official URL extraction/refresh/diff без изменения existing facts.
3. JS-only URL через opt-in browser fallback одной страницы.
4. Manual text с новой revision и diff.
5. Platforma object snapshot с allowlisted fields и immutable refresh.
6. Searchable ЖК dropdown, импорт карточки и всех PDF, затем появление 1+10
   черновиков вопросов в content editor.
7. Attempt snapshot v3/source citation остаётся неизменным после material/fact
   edits.

Production deploy, реальные внешние сайты и реальные provider-вызовы в
automated tests не выполняются.

## Stop conditions

- Появляется третья новая основная Stage 4 model, generic job/queue/outbox,
  crawler, OCR, RAG/vector infrastructure, ranking или operations surface.
- URL/redirect/browser request может обращаться к private/reserved address либо
  обходит повторную SSRF validation.
- PDF становится публичным, storage key или source content раскрывается
  employee, либо raw PDF/HTML передаётся OpenAI.
- Suggestion создаёт или меняет `TrainingFact` без explicit admin apply.
- Refresh меняет старую revision, approved fact или historical attempt.
- PostgreSQL, HTTP, provider, browser, migration, API/web/workspace или Docker
  gates красные.
