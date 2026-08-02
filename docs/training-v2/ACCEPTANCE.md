# Acceptance: Stage 4

## Критерии готовности к ручной приёмке

- `TrainingMaterial` принадлежит одному project, архивируется без physical
  delete и поддерживает только `PDF | OFFICIAL_URL | MANUAL_TEXT |
  OBJECT_SNAPSHOT`.
- Каждая загрузка/refresh создаёт immutable `TrainingMaterialRevision` с
  revision number, previous revision, bounded normalized segments, content hash
  и deterministic diff. Старые facts и attempts не меняются.
- PDF проверяется по auth/RBAC/ownership, MIME, extension, `%PDF-`, размеру,
  page count и timeout, хранится private с `File.url=null` и извлекается по
  страницам. Scanned/password-protected/invalid PDF получает safe error без OCR.
- Official URL требует admin confirmation, допускает только HTTPS и проходит
  DNS/IP/redirect SSRF checks. Fetch ограничен по redirects, bytes, content type
  и timeout; crawler и follow-links отсутствуют.
- Browser fallback выключен по умолчанию, обрабатывает только одну указанную
  страницу в isolated ephemeral context, проверяет все requests и гарантированно
  закрывается.
- Manual text сохраняется как normalized plain text. Object snapshot принимает
  только field codes и читает текущие values backend-ом из linked object по
  explicit allowlist стабильных полей.
- ЖК выбирается в searchable dropdown через server-side Platforma search,
  включая другую клавиатурную раскладку. Явный import связывает project,
  snapshot-ит все стабильные allowlisted поля и копирует каждый прикреплённый
  PDF в private Training material revision.
- По всем READY revisions импортированной карточки система создаёт ровно один
  главный и десять дополнительных grounded question drafts. Existing questions
  заменяются только после подтверждения; project остаётся `DRAFT`, а факты не
  создаются автоматически.
- Suggestions генерируются deterministic fake или existing OpenAI client,
  chunk-ятся по segments, проходят strict schema/IDs/evidence validation и не
  создают fact до explicit admin apply.
- Apply повторно проверяет permission, ownership, question, statement, aliases,
  required, locator/excerpt и duplicates. Созданный material fact хранит точную
  source citation; existing manual fact editor сохраняется.
- Snapshot v3 замораживает bounded fact source citation. Snapshot v1/v2 читаются
  без conversion; material refresh и новые facts не меняют old attempt.
- Publication/evaluation используют только approved `TrainingFact`. Employee не
  получает materials, URLs, extracted text, revisions, suggestions или hidden
  facts.
- Existing admin project editor содержит tab «Материалы», четыре source flows,
  preview/history/diff/suggestions/apply/archive; facts и admin attempt detail
  показывают source badge/citation. Новый frontend route отсутствует.
- Нет DOCX/PPTX/XLSX/OCR/crawler/search/RAG/embeddings/ranking/CSV/operations,
  worker/job/queue/outbox/provider-run infrastructure и production deploy.

## Automated fake/stub acceptance

Все external providers и URL/browser scenarios используют fake/stub/local
fixtures. Migration/PostgreSQL tests используют только временную PostgreSQL.

1. `prisma validate`/generate и additive Stage 4 migration проходят на clean
   install и при Stage 3 → Stage 4 upgrade с сохранением projects, facts,
   attempts и snapshots v1/v2; existing facts backfill-ятся `MANUAL`.
2. Unit tests проверяют material types, immutable revision numbering,
   paragraph/segment diff, manual segments, object allowlist, canonical
   duplicates, excerpt normalization, strict suggestions и snapshot v1/v2/v3.
3. Synthetic PDF tests проверяют MIME/magic/size/page limits, page text/locator,
   checksum, private `File.url=null`, missing text layer, password/invalid input,
   timeout и отсутствие temp artifacts при in-memory parsing без коммерческих
   fixtures.
4. Local URL fixture проверяет extraction headings/paragraphs/lists/tables,
   bytes/content-type/timeout, redirects/downgrade/credentials/port, DNS/public
   IP validation, final URL и changed/unchanged refresh diff без real websites.
5. Local JS-only fixture проверяет disabled/enabled browser fallback, rendered
   text, отсутствие clicks, blocking third-party/private requests, timeout и
   process/context cleanup.
6. Object snapshot/import tests доказывают keyboard-layout search,
   linked-object ownership, backend-only value read, все object PDF, tampered
   frontend values ignored, volatile fields unavailable, immutable old revision
   и создание grounded 1+10 question drafts.
7. Fake/local OpenAI stub проверяет `store=false`, no tools/search, strict
   schema, untrusted-source prompt, IDs/locator/excerpt, injection, chunk limits,
   partial failure и отсутствие `TrainingFact` до apply.
8. Apply/publication tests проверяют selected edited suggestions, source fields,
   duplicate warning/no auto-create и использование только approved facts.
9. PostgreSQL/HTTP/RBAC tests проверяют constraints/immutability, 401/403/200,
   safe UUID probing, ownership, PDF download, material/suggestion/apply,
   object-options/import-object endpoints, snapshot v3 и unchanged old attempts.
10. Frontend/browser tests проверяют Materials tab, searchable ЖК dropdown,
    другую раскладку, импорт карточки/всех PDF, 1+10 question drafts, четыре
    ручных source flows, loading/empty/error, extracted text/history/diff,
    review/apply, source badges и отсутствие employee material UI.
11. Full API/web/workspace tests, builds, `git diff --check`, `.only`/`.skip`,
    real-provider/real-website scans и cleanup временных resources проходят.
12. Если изменён browser runtime/API Dockerfile, API image build и local PDF +
    JS-only extraction smokes проходят с graceful cleanup.

## Локальная ручная приёмка

Использовать локальную test database, private test bucket, fake/local OpenAI stub
и локальные HTTP/JS fixture pages. Production и реальные сайты не нужны.

### Сценарий 1 — PDF

1. Admin открывает существующий TrainingProject и tab «Материалы».
2. Загружает небольшой synthetic text PDF.
3. Проверяет page count, extracted text, private original download и page
   locators.
4. Генерирует suggestions, редактирует и применяет несколько выбранных.
5. Проверяет `TrainingFact` с badge `PDF · Страница N` и публикует project.

### Сценарий 2 — официальный URL

1. Admin добавляет локальный HTTPS fixture URL и подтверждает официальный
   источник.
2. Проверяет final URL, fetchedAt, `HTTP` method и extracted text.
3. Меняет fixture и нажимает refresh: появляется новая revision и bounded diff.
4. Проверяет, что существующие facts не изменились; новые suggestions
   применяются только вручную.

### Сценарий 3 — JS-only URL

1. Проверяет `BROWSER_FALLBACK_REQUIRED` при выключенном fallback.
2. Включает test env fallback и повторяет extraction локальной JS-only page.
3. Видит rendered text и `BROWSER` method; fixture подтверждает, что clicks,
   other pages и blocked requests не выполнялись.

### Сценарий 4 — ручной текст

1. Admin создаёт manual material с title/text.
2. Изменяет text через новую revision и проверяет diff/history.
3. Генерирует и вручную применяет выбранные suggestions.

### Сценарий 5 — карточка Platforma

1. Admin вводит название ЖК в searchable dropdown, в том числе в другой
   клавиатурной раскладке, и выбирает найденный `RealEstateObject`.
2. Запускает import и проверяет snapshot всех доступных стабильных полей и
   отдельные private materials для всех прикреплённых к карточке PDF.
3. Проверяет появление одного главного и десяти дополнительных черновиков
   вопросов в tab «Контент и оценивание»; существующие вопросы заменяются только
   после отдельного подтверждения.
4. Изменяет исходный object/PDF, повторяет import и проверяет неизменность old
   revisions и создание новых revisions.

### Сценарий 6 — integrity попытки

1. Публикует project с approved sourced facts и начинает test attempt.
2. Проверяет snapshot v3/source citation в admin attempt detail.
3. Обновляет material и facts после старта.
4. Проверяет, что old attempt и его source citation не изменились.

## Definition of Done

Stage 4 остаётся текущим даже после готовности кода и зелёных automated checks.
Только отдельное ручное подтверждение шести сценариев закрывает этап. Stage 5,
ranking, operations и production deploy не начинаются без новой задачи.
