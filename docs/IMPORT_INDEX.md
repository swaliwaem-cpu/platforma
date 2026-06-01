# Import Index

Дата индексации: 2026-06-01.

Индекс построен статическим чтением кода и env examples. Import run, repair run и feed import run не запускались. Application code не менялся.

## Import overview

В проекте есть три связанные, но разные import-зоны.

| Подсистема | Назначение | Основные файлы | Где хранит результат |
| --- | --- | --- | --- |
| WordPress import | Перенос legacy WordPress объектов, таксономий, мета, PDF и изображений в текущую модель объектов | `tools/wp-import/src/index.ts`, `tools/wp-import/src/wordpress-client.ts`, `tools/wp-import/src/mapper.ts`, `tools/wp-import/src/importer.ts`, `apps/api/src/wordpress-import/wordpress-import.service.ts`, `apps/web/src/admin/ImportAdminPage.tsx` | `RealEstateObject`, `Developer`, `Location`, `MetroStation`, `File`, `FileVariant`, `ObjectImage`, `ObjectFile`, `ImportReport` in `apps/api/prisma/schema.prisma` |
| WordPress repair | Отдельная ремонтная операция после/вокруг WP import: primary location и developer duplicates | `tools/wp-import/src/index.ts`, `tools/wp-import/src/repair.ts`, `tools/wp-import/src/developer-aliases.ts` | `RealEstateObject.primaryLocationId`, `ObjectLocation.isPrimary`, `Developer` in `apps/api/prisma/schema.prisma` |
| Feed import | Анализ и импорт XML/feed лотов из URL, XML file или index URL | `tools/feed-import/src/index.ts`, `apps/api/src/feeds/feeds.controller.ts`, `apps/api/src/feeds/feeds.service.ts`, `apps/web/src/admin/FeedsAdminPage.tsx` | `FeedSource`, `FeedSourceMapping`, `FeedImportRun`, `FeedUnit`, `FeedResidentialUnitDetails`, `FeedCommercialUnitDetails`, `FeedMediaAsset`, `FeedUnitMedia`, `File`, object feed aggregate fields in `apps/api/prisma/schema.prisma` |

WordPress import импортирует сами объекты недвижимости и часть справочников из legacy WordPress. Feed import импортирует лоты/юниты и медиа фидов, привязывая их к уже существующим объектам через `FeedSource.objectId` или `FeedSourceMapping`, что подтверждено `tools/feed-import/src/index.ts` и `apps/api/prisma/schema.prisma`.

Команды из root `package.json`:

| Команда | Что делает | Подтверждение |
| --- | --- | --- |
| `pnpm wp-import:preview` | Запускает `@platforma/wp-import` preview | `package.json`, `tools/wp-import/package.json`, `tools/wp-import/src/index.ts` |
| `pnpm wp-import:run` | Запускает `@platforma/wp-import` run | `package.json`, `tools/wp-import/package.json`, `tools/wp-import/src/index.ts` |
| `pnpm wp-import:repair:preview` | Запускает repair preview | `package.json`, `tools/wp-import/package.json`, `tools/wp-import/src/index.ts`, `tools/wp-import/src/repair.ts` |
| `pnpm wp-import:repair:run` | Запускает repair run | `package.json`, `tools/wp-import/package.json`, `tools/wp-import/src/index.ts`, `tools/wp-import/src/repair.ts` |
| `pnpm feed-import:preview` | Запускает `@platforma/feed-import` preview, требует `--source` на уровне CLI | `package.json`, `tools/feed-import/package.json`, `tools/feed-import/src/index.ts` |
| `pnpm feed-import:run` | Запускает `@platforma/feed-import` run, требует `--source` на уровне CLI | `package.json`, `tools/feed-import/package.json`, `tools/feed-import/src/index.ts` |

API/admin UI:

- WordPress import API: `POST /wordpress-import/preview`, `POST /wordpress-import/run`, `GET /wordpress-import/reports`, `GET /wordpress-import/reports/:id` in `apps/api/src/wordpress-import/wordpress-import.controller.ts`.
- WordPress import admin UI: `apps/web/src/admin/ImportAdminPage.tsx`, route `/admin/import` and permission gate in `apps/web/src/App.tsx`.
- Feed import API: `GET /feeds/sources`, `POST /feeds/sources`, `POST /feeds/analyze`, `PATCH /feeds/sources/:id`, `DELETE /feeds/sources/:id`, `POST /feeds/sources/:id/preview`, `POST /feeds/sources/:id/run`, `GET /feeds/sources/:id/runs`, `GET /feeds/runs/:id`, `POST /feeds/runs/:id/stop`, `GET /feeds/units` in `apps/api/src/feeds/feeds.controller.ts`.
- Feed import admin UI: `apps/web/src/admin/FeedsAdminPage.tsx`, route `/admin/feeds` and permission gate in `apps/web/src/App.tsx`.
- Separate `apps/api/src/feed-import` directory and `/feed-import/preview|run` endpoints were not found; current feed HTTP surface is `/feeds/*`, confirmed by `apps/api/src/feeds/feeds.controller.ts`.

## WordPress import

Source data:

- WordPress DB is read through `mysql2/promise` by `WordPressReadonlyClient` in `tools/wp-import/src/wordpress-client.ts`.
- The client asserts read-only SQL with `assertReadonlyQuery()` and allows only `select`, `show`, `describe`, `explain` in `tools/wp-import/src/wordpress-client.ts`.
- Env is loaded from root `.env`, `apps/api/.env`, `tools/wp-import/.env` in `tools/wp-import/src/env.ts`.
- Expected WP env examples are in `.env.example` and `tools/wp-import/.env.example`; `tools/feed-import/.env.example` was not found.

Post type and selection:

- Default `WP_POST_TYPE` is `nedvizhimosts`, defined in `tools/wp-import/src/env.ts`.
- `.env.example` also sets `WP_POST_TYPE=nedvizhimosts`.
- Import selects only `post_status = 'publish'` for the configured post type in `tools/wp-import/src/wordpress-client.ts`; `tools/wp-import/tests/wordpress-client-source.test.cjs` protects this behavior.
- `WP_IMPORT_LIMIT` is parsed in `tools/wp-import/src/env.ts`. Full run archive behavior is only enabled when `importLimit === null`, confirmed in `tools/wp-import/src/importer.ts` and `tools/wp-import/tests/importer-archive-source.test.cjs`.

ACF/meta/taxonomy/media/coordinates:

- Main field mapping lives in `tools/wp-import/src/mapper.ts`.
- Title uses `zagolovok_1`, then `post_title`, then fallback `WordPress object <ID>` in `tools/wp-import/src/mapper.ts`.
- Descriptions use `opisanie_2`, `opisanie_3`, `opisanie_4_1`, `opisanie_4_2` and fallback stripped `post_content` in `tools/wp-import/src/mapper.ts`.
- Developer comes from `imya_zastrojshhika` and can be normalized through `tools/wp-import/src/developer-aliases.ts`.
- Coordinates come from `karta_koordinaty`, parsed as latitude/longitude strings with range checks in `tools/wp-import/src/mapper.ts`; missing/invalid coordinates add `missing_coordinates` info warning.
- Prices come from `stoimost` and `za_m2` in `tools/wp-import/src/mapper.ts`.
- Address comes from `adres` or `address` in `tools/wp-import/src/mapper.ts`.
- Locations are derived from WP taxonomies with roots/slugs `rajon-okolo` and `rajony`; metro from `metro`; completion year from `god`; completion quarter from `sdacha` or `etap-stroitelstva`, all in `tools/wp-import/src/mapper.ts`.
- WP object terms are fetched for taxonomies `nedvizhimost` and `custom_tag-two` in `tools/wp-import/src/wordpress-client.ts`.
- Metro line color reads term meta `czvet_metro` in `tools/wp-import/src/mapper.ts`.
- Cover/hero/gallery images read meta `izobrazhenie_miniatyura`, `izobrazhenie_1`, `czikl_vyvoda_galerei_<n>_izobrazhenie` in `tools/wp-import/src/mapper.ts`.
- PDF presentation reads `pdf_fajl`; other PDF/file refs are detected by keys matching `fajl|pdf|plan` in `tools/wp-import/src/mapper.ts`.
- Image MIME allow-list is `image/jpeg`, `image/png`, `image/webp`; PDF MIME is `application/pdf`, confirmed in `tools/wp-import/src/mapper.ts`.

Preview flow:

- CLI command `preview` is routed by `tools/wp-import/src/index.ts` to `executeWordPressImport('preview')`.
- `executeWordPressImport()` creates a pending `ImportReport`, reads WP data, maps it and finishes report in `tools/wp-import/src/importer.ts`.
- Preview sets `dryRun: true` in summary through `tools/wp-import/src/mapper.ts` and `tools/wp-import/src/importer.ts`.
- Preview does not call `persistMappedImport()` because persistence is guarded by `if (mode === 'run')` in `tools/wp-import/src/importer.ts`.
- Preview still writes `ImportReport` rows because `createPendingReport()` and `finishReport()` run for both modes in `tools/wp-import/src/importer.ts`.

Run/commit flow:

- CLI command `run` is routed by `tools/wp-import/src/index.ts` to `executeWordPressImport('run')`.
- API `POST /wordpress-import/run` shells out to `pnpm --filter @platforma/wp-import run run` through `apps/api/src/wordpress-import/wordpress-import.service.ts`.
- Run persists developers, locations, metro, objects, media, object images and object files in `tools/wp-import/src/importer.ts`.
- Missing imported WP objects are archived only on full run with no `WP_IMPORT_LIMIT`, confirmed by `archiveImportedObjectsMissingFromSource()` in `tools/wp-import/src/importer.ts`.

Idempotency:

- Object idempotency is primarily by unique `RealEstateObject.wpPostId`; fallback slug matching and conflict slug generation are in `upsertObject()` and `getUniqueObjectSlug()` in `tools/wp-import/src/importer.ts`.
- File idempotency is by unique `File.wpAttachmentId`, confirmed by `ensureImportedFile()` in `tools/wp-import/src/importer.ts` and `File.wpAttachmentId` in `apps/api/prisma/schema.prisma`.
- Object image idempotency uses `upsertObjectImage()` in `tools/wp-import/src/importer.ts`; stale imported object images with non-null `sourceMetaKey` are deleted after current imported images are persisted.
- Object file idempotency uses `upsertObjectFile()` in `tools/wp-import/src/importer.ts`; stale imported object files with non-null `sourceMetaKey` are deleted after current imported files are persisted.
- Manual admin overrides are preserved using `AuditLog` metadata for fields such as address, coordinates, prices, developer, primary location, location ids and metro ids in `tools/wp-import/src/importer.ts`; tests are in `tools/wp-import/tests/importer-manual-overrides.test.cjs`.
- Developer idempotency uses normalized names and alias groups in `tools/wp-import/src/developer-aliases.ts` and `tools/wp-import/src/importer.ts`.

Files/images:

- Local WP attachment paths are resolved from `WP_UPLOADS_PATH` and `_wp_attached_file` in `tools/wp-import/src/wordpress-client.ts`.
- Missing local files add `missing_local_file` warnings before run persistence, confirmed in `tools/wp-import/src/mapper.ts`.
- Storage writes use a minimal signed S3/MinIO client in `tools/wp-import/src/storage.ts`.
- Image variants `THUMBNAIL`, `CARD`, `DETAIL` are generated as WebP in `tools/wp-import/src/image-variants.ts` and backfilled for existing imported images in `tools/wp-import/src/importer.ts`; tests are in `tools/wp-import/tests/image-variants.test.cjs`.
- Storage env comes from `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MINIO_BUCKET` in `tools/wp-import/src/env.ts`, `.env.example`, `tools/wp-import/.env.example`.

ImportReport:

- `ImportReport` model stores `mode`, `status`, `source`, `startedAt`, `finishedAt`, `summaryJson`, `warningsJson`, `errorsJson`, `createdById`, `createdAt` in `apps/api/prisma/schema.prisma`.
- WP reports use `source: 'wordpress'`, confirmed by `createPendingReport()` / `finishReport()` in `tools/wp-import/src/importer.ts` and report filters in `apps/api/src/wordpress-import/wordpress-import.service.ts`.
- Shared response types are `ImportReport`, `ImportReportsResponse`, `ImportReportResponse` in `packages/shared/src/index.ts`.
- Admin UI displays reports, summary metrics, warnings and errors in `apps/web/src/admin/ImportAdminPage.tsx`.

Repair flow:

- CLI command shape is `repair preview` or `repair run` in `tools/wp-import/src/index.ts`.
- Root scripts are `wp-import:repair:preview` and `wp-import:repair:run` in `package.json`.
- Repair does not have an HTTP endpoint in `apps/api/src/wordpress-import/wordpress-import.controller.ts`.
- Repair does not write `ImportReport`; it returns JSON to CLI from `executeRepair()` in `tools/wp-import/src/repair.ts`.
- Location repair finds objects whose primary location is `area`, then switches primary location to a linked `district` with highest sort order in `tools/wp-import/src/repair.ts`.
- Developer repair builds plans from alias groups and can move objects, delete duplicate developers, rename target developer and normalize developer names in `tools/wp-import/src/repair.ts`.
- Dedicated repair tests were not found in `tools/wp-import/tests`.

WordPress import risks:

- Preview must not persist objects/media; guard is `if (mode === 'run')` in `tools/wp-import/src/importer.ts`.
- Run must stay idempotent by `wpPostId`, `wpAttachmentId`, slug conflict handling and imported media link cleanup in `tools/wp-import/src/importer.ts`.
- Repeated run must not duplicate objects, files, object images or object files; relevant constraints are in `apps/api/prisma/schema.prisma`.
- `WP_UPLOADS_PATH` and Docker-oriented `WP_UPLOADS_HOST_PATH` / `WP_UPLOADS_PATH` must point to the real `wp-content/uploads`; env examples are `.env.example` and `tools/wp-import/.env.example`.
- MIME/type checks can exclude attachments: `invalid_image_mime`, `invalid_file_mime` in `tools/wp-import/src/mapper.ts`.
- Missing files and missing attachment records become warnings, not hard failures, in `tools/wp-import/src/mapper.ts`.
- Empty coordinates, prices and developer are possible; missing developer and coordinates are warnings in `tools/wp-import/src/mapper.ts`, while empty prices map to null.
- MinIO/S3 bucket and credentials are required for run media persistence through `tools/wp-import/src/storage.ts`.
- WordPress DB user should be read-only; code also asserts read-only SQL in `tools/wp-import/src/wordpress-client.ts`, and env checklist states read-only WP DB user in `docs/staging-production-env-checklist.md`.
- Repair changes primary location and developers outside the main importer; repair must not be mixed mentally with normal import behavior because it has separate code path and no `ImportReport`.

## Feed import

Source feed files:

- Feed sources are stored in `FeedSource` with `sourceKind` `URL`, `FILE` or `INDEX_URL` in `apps/api/prisma/schema.prisma`.
- URL and index sources use `FeedSource.url`; file sources use `FeedSource.xmlFileId` linked to `File`, confirmed in `apps/api/prisma/schema.prisma`.
- API upload for XML files is handled by `apps/api/src/feeds/feeds.controller.ts`, `apps/api/src/feeds/feeds.service.ts` and `FilesService.uploadFile(..., 'feed-xml')` in `apps/api/src/files/files.service.ts`.
- Feed XML max size is `FEED_XML_MAX_SIZE_BYTES` in `apps/api/src/files/file-upload.constants.ts`.
- `tools/feed-import/src/env.ts` loads root `.env`, `apps/api/.env` and `tools/feed-import/.env`; no `tools/feed-import/.env.example` exists.

Format:

- Supported import formats are `YANDEX_REALTY`, `CIAN_XML`, `AVITO_XML`, `FSK_XML`, confirmed by `tools/feed-import/src/index.ts` and `apps/api/src/feeds/feeds.service.ts`.
- Analyze supports `AUTO`, confirmed by `parseAnalyzeFormat()` in `apps/api/src/feeds/feeds.service.ts` and `parseFeedAnalyzeCliArgs()` in `tools/feed-import/src/index.ts`.
- XML parsing uses `fast-xml-parser` in `tools/feed-import/src/index.ts`.
- Format-specific parsers are `YandexRealtyFeedParser`, `CianXmlFeedParser`, `AvitoXmlFeedParser`, `FskXmlFeedParser` in `tools/feed-import/src/index.ts`.
- Parser tests and fixtures are in `tools/feed-import/tests/parser.test.cjs`, `tools/feed-import/tests/fixtures/yandex.xml`, `tools/feed-import/tests/fixtures/MNF_Cian_5827_.xml`.

Preview flow:

- API `POST /feeds/sources/:id/preview` calls `FeedsService.runFeedImportCommand(id, 'preview')` in `apps/api/src/feeds/feeds.controller.ts`.
- Preview runs `pnpm --filter @platforma/feed-import --fail-if-no-match run preview --source <id>` through `runFeedImportCli()` in `apps/api/src/feeds/feeds.service.ts`.
- CLI preview creates or uses a `FeedImportRun`, parses source, routes units, builds a plan and finishes the run with summary in `tools/feed-import/src/index.ts`.
- Preview does not call `persistFeedImportRun()` because persistence is guarded by `if (options.mode === 'run')` in `tools/feed-import/src/index.ts`.
- Preview updates `FeedSource.lastPreviewAt` in `finishFeedImportRun()` in `tools/feed-import/src/index.ts`.

Run flow:

- API `POST /feeds/sources/:id/run` creates a pending `FeedImportRun`, queues a detached run and returns immediately in `apps/api/src/feeds/feeds.service.ts`.
- Queue concurrency is `3`, confirmed by `feedRunQueueConcurrency` in `apps/api/src/feeds/feeds.service.ts`.
- CLI run is started with `--run-id <feedImportRunId>` in `apps/api/src/feeds/feeds.service.ts`; CLI validates that pending run belongs to the same source and mode in `tools/feed-import/src/index.ts`.
- Run persists units, details, media assets, media links and object feed aggregates in `tools/feed-import/src/index.ts`.
- Run updates progress in `FeedImportRun.summaryJson.progress` for queued/processing/archiving/refreshing/completed/failed/stopped stages across `apps/api/src/feeds/feeds.service.ts` and `tools/feed-import/src/index.ts`.
- Stop endpoint `POST /feeds/runs/:id/stop` removes queued jobs or signals running processes through active map, `/proc` and `pgrep` in `apps/api/src/feeds/feeds.service.ts`.

Idempotency:

- Feed units are upserted by unique `(sourceId, externalId)` in `apps/api/prisma/schema.prisma` and `upsertFeedUnit()` in `tools/feed-import/src/index.ts`.
- Existing units for a source that are absent from the current parsed external ids are archived by `persistFeedImportRun()` in `tools/feed-import/src/index.ts`.
- Index URL imports namespace external ids by source URL hash in `namespaceIndexFeedUnitExternalId()` in `tools/feed-import/src/index.ts`, reducing collisions between files under the same index.
- Feed media assets are upserted by unique `sourceUrl` in `apps/api/prisma/schema.prisma` and `ensureFeedMediaAsset()` in `tools/feed-import/src/index.ts`.
- Media file records are upserted by `(storage,bucket,key)` in `upsertFeedMediaFile()` in `tools/feed-import/src/index.ts`; storage key is hash-based from source URL and date in `createFeedMediaStorageKey()`.
- Feed unit media links are replaced per unit by deleting existing `FeedUnitMedia` rows and recreating current links in `syncFeedUnitMedia()` in `tools/feed-import/src/index.ts`.

Mapping fields:

- Source-level `filterJson` and mapping-level `filterJson` are parsed as JSON objects in `apps/api/src/feeds/feeds.service.ts`.
- Mapping inputs require `objectId`, `sourceKey`, `sourceTitle`, `filterJson`, `isActive` in `apps/api/src/feeds/feeds.service.ts`.
- Filter keys supported by import engine are `externalIds`, `feedIndexSourceUrls`, `projectNames`, `buildingNames`, `yandexBuildingIds`, `yandexHouseIds`, `avitoDevelopmentIds`, `addressIncludes` in `tools/feed-import/src/index.ts`.
- Analyze generates suggested `filterJson` for Yandex, Avito and generic feeds in `createFeedAnalysisFilterJson()` and related helpers in `tools/feed-import/src/index.ts`.
- Frontend matching/suggestions live in `apps/web/src/admin/feedSourceMatching.ts` and are used by `apps/web/src/admin/FeedsAdminPage.tsx`.
- If active mappings exist, units route through matching mapping filters; otherwise units route to `FeedSource.objectId`, confirmed by `routeFeedUnitsForSource()` in `tools/feed-import/src/index.ts`.

Where results are stored:

- Source configuration: `FeedSource`, `FeedSourceMapping` in `apps/api/prisma/schema.prisma`.
- Runs/reports: `FeedImportRun` in `apps/api/prisma/schema.prisma`.
- Units: `FeedUnit`, `FeedResidentialUnitDetails`, `FeedCommercialUnitDetails` in `apps/api/prisma/schema.prisma`.
- Media: `FeedMediaAsset`, `FeedUnitMedia`, `File`, `FileVariant` in `apps/api/prisma/schema.prisma`.
- Object catalog aggregates: `RealEstateObject.feedPriceFrom`, `feedPricePerMeterFrom`, `feedAreaRange`, `feedFloorRange`, `feedUnitsCount`, `feedUnitsCountText`, `feedCompletionYear`, `feedCompletionQuarter`, `feedUpdatedAt` in `apps/api/prisma/schema.prisma`; refresh logic is in `refreshRealEstateObjectFeedAggregates()` in `tools/feed-import/src/index.ts`.
- Frontend object/catalog/detail consumers rely on feed data through `apps/api/src/objects/objects.service.ts`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`.

Feed risks:

- Preview must not write units/media/object aggregates; `tools/feed-import/src/index.ts` guards persistence by `if (options.mode === 'run')`.
- Run must be idempotent by `(sourceId, externalId)`, `sourceUrl`, media link replacement and archived missing units in `tools/feed-import/src/index.ts`.
- Repeat runs should not create duplicate `FeedUnit`, `FeedMediaAsset` or `FeedUnitMedia` rows; constraints are in `apps/api/prisma/schema.prisma`.
- Local/XML file sources depend on uploaded `File.key` and MinIO/S3 availability; file source reads object bytes through `FeedImportStorage.getObject()` in `tools/feed-import/src/storage.ts`.
- XML upload validation is split: analyze validates first bytes start with `<` in `apps/api/src/feeds/feeds.service.ts`; saved feed XML upload relies on `FilesService` feed XML checks in `apps/api/src/files/files.service.ts`.
- Missing XML file key throws `FeedSource <id> XML file was not found` in `tools/feed-import/src/index.ts`.
- Empty price, area, completion and other numeric fields normalize to null with warnings for invalid values in `tools/feed-import/src/index.ts`; object aggregate ranges can then be null.
- Feed media content type falls back from header to URL extension and then `application/octet-stream` in `tools/feed-import/src/index.ts`; image variants are only generated for JPEG/PNG/WebP.
- MinIO/S3 is required for run media persistence and file source reads through `tools/feed-import/src/storage.ts`.
- Detached run/stop behavior is process-local and runtime-dependent: active process map, `/proc` and `pgrep` are used in `apps/api/src/feeds/feeds.service.ts`.

## API and admin UI

WordPress endpoints and permissions:

| Endpoint | Permission | UI consumer | Notes |
| --- | --- | --- | --- |
| `POST /wordpress-import/preview` | `import:preview` | `apps/web/src/admin/ImportAdminPage.tsx` | Runs CLI preview; no request body; returns `{report}` |
| `POST /wordpress-import/run` | `import:run` | `apps/web/src/admin/ImportAdminPage.tsx` | Browser confirm before call; returns `{report}` |
| `GET /wordpress-import/reports` | `import:preview` | `apps/web/src/admin/ImportAdminPage.tsx` | Supports `page`, `limit`, `mode`, `status` |
| `GET /wordpress-import/reports/:id` | `import:preview` | `apps/web/src/admin/ImportAdminPage.tsx` | Rejects reports whose `source` is not `wordpress` |

Feed endpoints and permissions:

| Endpoint | Permission | UI consumer | Notes |
| --- | --- | --- | --- |
| `GET /feeds/sources` | `feeds:read` | `apps/web/src/admin/FeedsAdminPage.tsx` | Source list and filters |
| `POST /feeds/sources` | `feeds:manage` | `apps/web/src/admin/FeedsAdminPage.tsx` | Creates URL/FILE/INDEX_URL source |
| `POST /feeds/analyze` | `feeds:manage` | `apps/web/src/admin/FeedsAdminPage.tsx` | Runs analyze CLI with URL or temp XML file |
| `PATCH /feeds/sources/:id` | `feeds:manage` | `apps/web/src/admin/FeedsAdminPage.tsx` | Updates source and mappings |
| `DELETE /feeds/sources/:id` | `feeds:manage` | `apps/web/src/admin/FeedsAdminPage.tsx` | Soft delete |
| `POST /feeds/sources/:id/preview` | `feeds:run` | `apps/web/src/admin/FeedsAdminPage.tsx` | Synchronous preview CLI |
| `POST /feeds/sources/:id/run` | `feeds:run` | `apps/web/src/admin/FeedsAdminPage.tsx` | Queued detached run, returns pending run |
| `GET /feeds/sources/:id/runs` | `feeds:read` | `apps/web/src/admin/FeedsAdminPage.tsx` | Run history |
| `GET /feeds/runs/:id` | `feeds:read` | `apps/web/src/admin/FeedsAdminPage.tsx` | Polling target every 2000 ms |
| `POST /feeds/runs/:id/stop` | `feeds:run` | `apps/web/src/admin/FeedsAdminPage.tsx` | Stops queued/running run |
| `GET /feeds/units` | `feeds:read` | `apps/web/src/admin/FeedsAdminPage.tsx` | Units diagnostics table |

Displayed statuses, warnings and errors:

- WordPress UI labels modes `PREVIEW`/`RUN` and statuses `PENDING`, `SUCCESS`, `PARTIAL`, `FAILED` in `apps/web/src/admin/ImportAdminPage.tsx`.
- WordPress UI displays summary counters, `warningsJson`, `errorsJson`, issue `severity`, `code`, `message`, `wpPostId`, `wpAttachmentId`, `metaKey` in `apps/web/src/admin/ImportAdminPage.tsx`.
- Feed UI displays source status, run status, warnings/errors count, progress card and run detail units in `apps/web/src/admin/FeedsAdminPage.tsx`.
- Feed progress stages are read from `summaryJson.progress` in `apps/web/src/admin/FeedsAdminPage.tsx`; producers are `apps/api/src/feeds/feeds.service.ts` and `tools/feed-import/src/index.ts`.
- Route permissions are gated in `apps/web/src/App.tsx`: `/admin/import` requires `admin:access` and `import:preview`; `/admin/feeds` requires `admin:access` and `feeds:read`.

## Риски

- Preview не должен писать данные: WP preview persists only `ImportReport`, not objects/media, due to `if (mode === 'run')` in `tools/wp-import/src/importer.ts`; feed preview persists only `FeedImportRun`/source timestamps, not units/media/aggregates, due to `if (options.mode === 'run')` in `tools/feed-import/src/index.ts`.
- Run должен быть идемпотентным: WP uses `wpPostId`, `wpAttachmentId`, unique slugs and imported link cleanup in `tools/wp-import/src/importer.ts`; feed uses `(sourceId, externalId)`, unique `sourceUrl`, unique file storage keys and unit media replacement in `tools/feed-import/src/index.ts`.
- Повторный запуск не должен создавать дубли: uniqueness is enforced by `apps/api/prisma/schema.prisma` for `RealEstateObject.wpPostId`, `File.wpAttachmentId`, `FeedUnit.sourceId_externalId`, `FeedMediaAsset.sourceUrl`, `FeedUnitMedia` composite id and `File.storage_bucket_key`.
- Локальные пути uploads/feed-файлов: WP depends on `WP_UPLOADS_PATH` in `tools/wp-import/src/wordpress-client.ts`; feed FILE sources depend on `File.key` and storage reads in `tools/feed-import/src/storage.ts`.
- MIME/type проверки: WP image/PDF checks live in `tools/wp-import/src/mapper.ts`; feed XML upload checks live in `apps/api/src/files/files.service.ts` and analysis XML byte check lives in `apps/api/src/feeds/feeds.service.ts`; feed media MIME fallback lives in `tools/feed-import/src/index.ts`.
- Отсутствующие файлы: WP missing attachment/local file warnings are emitted in `tools/wp-import/src/mapper.ts`; feed missing XML file key throws in `tools/feed-import/src/index.ts`; feed media download failures become `MEDIA_DOWNLOAD_FAILED` warnings in `tools/feed-import/src/index.ts`.
- Пустые координаты/цены/застройщик: WP emits missing developer/coordinates warnings and maps prices to null in `tools/wp-import/src/mapper.ts`; feed invalid/empty numeric fields can become null in `tools/feed-import/src/index.ts`.
- MinIO/S3: both import tools write/read S3-compatible storage through `tools/wp-import/src/storage.ts` and `tools/feed-import/src/storage.ts`; env examples are `.env.example`, `apps/api/.env.example`, `tools/wp-import/.env.example`.
- Read-only DB user for WordPress: expected by `.env.example`, `tools/wp-import/.env.example`, `docs/staging-production-env-checklist.md`; code also blocks non-read SQL in `tools/wp-import/src/wordpress-client.ts`.
- Repair differs from main import: repair has no API endpoint and no `ImportReport`, mutates primary locations and developers through `tools/wp-import/src/repair.ts`, while main WP import maps/persists objects/media through `tools/wp-import/src/importer.ts`.
