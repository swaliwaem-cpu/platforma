# Feature Map

Дата индексации: 2026-06-01.

## Product and UI Context

- Назначение: компактный продуктовый и UI-контекст для Codex перед frontend/UI-задачами.
- Документ: `docs/PRODUCT_AND_UI_CONTEXT.md`.
- Подтверждающие frontend files: `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/admin`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css`.
- Связанные правила: `rules/project.md`, `rules/frontend.md`, `rules/workflow.md`.
- Риски: UI-задачи без этого контекста могут случайно превратить внутренний рабочий интерфейс в лендинг, нарушить catalog/map/list/filter/permissions/import flows или начать менять layout без согласования.
- Проверки: перед UI-изменениями читать `docs/PRODUCT_AND_UI_CONTEXT.md`, затем конкретные route/component/style files из соответствующего раздела документа.

## Auth, Session, Refresh

- Назначение: login, email registration, logout, refresh access token, media cookie issuance.
- Frontend files: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`.
- Backend files: `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/jwt-auth.guard.ts`, `apps/api/src/auth/cookies.ts`, `apps/api/src/auth/media-token.guard.ts`.
- Shared types: `AuthUser`, `AuthResponse`, `EmailRegistrationRequestInput`, `EmailRegistrationVerifyInput`, `ProfilePhotoFile` in `packages/shared/src/index.ts`.
- Prisma models: `User`, `UserSession`, `EmailAuthChallenge`, `Role`, `Permission`, `RolePermission`, `File` in `apps/api/prisma/schema.prisma`.
- API endpoints: `POST /auth/login`, `POST /auth/register/request`, `POST /auth/register/verify`, `POST /auth/logout`, `POST /auth/refresh`, `GET /auth/me`.
- Tests: `apps/api/tests/auth-rbac.test.cjs`, `apps/api/tests/auth-session-schema.test.cjs`, `apps/web/tests/api-request-errors.test.mjs`, `apps/web/tests/login-copy.test.mjs`.
- Связанные docs: `docs/API_AND_DATA.md`, `docs/STATE_AND_LOGIC.md`, `docs/RISK_ZONES.md`.
- Риски: refresh cookie/media cookie/cross-origin credentials must align across `apps/web/src/admin/api.ts`, `apps/api/src/auth/cookies.ts`, `apps/api/src/main.ts`.
- Проверки: login, refresh after expired access token, logout, media images, registration request with password, activation token flow.

## RBAC and Permissions

- Назначение: role-based access for frontend routes and backend endpoints.
- Frontend files: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`, admin pages under `apps/web/src/admin`.
- Backend files: `apps/api/src/auth/permissions.decorator.ts`, `apps/api/src/auth/permissions.guard.ts`, `apps/api/src/auth/jwt-auth.guard.ts`, controllers under `apps/api/src`.
- Shared types: `AdminRole`, `AuthUser` in `packages/shared/src/index.ts`.
- Prisma models: `Role`, `Permission`, `RolePermission`, `User`.
- API endpoints: all guarded endpoints in `apps/api/src/*/*.controller.ts`.
- Tests: `apps/api/tests/auth-rbac.test.cjs`, `apps/web/tests/sidebar-navigation.test.mjs`, `apps/web/tests/admin-catalog-links-route.test.mjs`, `apps/web/tests/admin-feeds-route.test.mjs`.
- Связанные docs: `docs/PAGES_AND_ROUTES.md`, `docs/API_AND_DATA.md`, `docs/RISK_ZONES.md`.
- Риски: frontend route visibility can drift from backend `RequirePermissions`; seed changes can lock out roles.
- Проверки: admin/editor/user navigation, denied screens, 403/401 API behavior.

## Users

- Назначение: admin user management and own profile/password/photo.
- Frontend files: `apps/web/src/admin/UsersAdminPage.tsx`, `apps/web/src/App.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Backend files: `apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.service.ts`, `apps/api/src/files/files.service.ts`.
- Shared types: `AdminUser`, `AdminUsersResponse`, `AdminRolesResponse`, `ProfilePhotoFile`.
- Prisma models: `User`, `Role`, `File`, `AuditLog`, `UserSession`.
- API endpoints: `GET /users`, `GET /users/roles`, `PATCH /users/me`, `PATCH /users/me/password`, `POST /users/me/profile-photo`, `GET /users/me/profile-photo/content`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/activate`, `POST /users/:id/deactivate`, `DELETE /users/:id`.
- Tests: `apps/api/tests/services.test.cjs`, `apps/api/tests/auth-rbac.test.cjs`, `apps/web/tests/sidebar-navigation.test.mjs`.
- Связанные docs: `docs/PAGES_AND_ROUTES.md`, `docs/API_AND_DATA.md`.
- Риски: role/status/password changes clear sessions; profile photo is file-linked and affects media.
- Проверки: create/update/deactivate/reactivate user, self profile update, password change, photo upload/display.

## Objects CRUD

- Назначение: create, edit, quick edit, publish/archive, gallery, files, object detail.
- Frontend files: `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/ObjectQuickEditTable.tsx`, `apps/web/src/admin/objectQuickEditPersistence.ts`, `apps/web/src/admin/objectQuickEditTransforms.ts`, `apps/web/src/objects/ObjectDetailPage.tsx`.
- Backend files: `apps/api/src/objects/objects.controller.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/objects/object-search.ts`, `apps/api/src/search/search-filters.ts`.
- Shared types: `RealEstateObjectBase`, `RealEstateObjectSummary`, `RealEstateObjectDetail`, `ObjectsResponse`, `ObjectResponse`, `ObjectImage`, `ObjectLinkedFile`.
- Prisma models: `RealEstateObject`, `ObjectLocation`, `ObjectMetroStation`, `ObjectImage`, `ObjectFile`, `Developer`, `Location`, `MetroStation`, `File`, `FileVariant`, `AuditLog`, `FeedUnit`.
- API endpoints: `GET /objects`, `GET /objects/:id`, `GET /objects/slug/:slug`, `POST /objects`, `PATCH /objects/:id`, `PATCH /objects/:id/status`, `POST /objects/:id/publish`, object gallery/file endpoints.
- Tests: `apps/api/tests/api-contract.test.cjs`, `apps/api/tests/object-gallery-batch.test.cjs`, `apps/api/tests/object-gallery-stream.test.cjs`, `apps/api/tests/object-file-upload-limit.test.cjs`, `apps/web/tests/admin-object-create-route.test.mjs`, `apps/web/tests/admin-object-quick-edit-table.test.mjs`, `apps/web/tests/admin-object-file-upload.test.mjs`.
- Связанные docs: `docs/API_AND_DATA.md`, `docs/STATE_AND_LOGIC.md`, `docs/RISK_ZONES.md`.
- Риски: published lifecycle required fields, decimal serialization, gallery batch/staged files, quick edit mismatch.
- Проверки: create draft, edit fields, publish validation, archive/status quick edit, gallery reorder/cover, linked PDF upload/delete.

## Catalog

- Назначение: searchable/filterable object list with quick links and feed lot filters.
- Frontend files: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Backend files: `apps/api/src/objects/objects.controller.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/objects/object-search.ts`, `apps/api/src/directories/directories.controller.ts`.
- Shared types: `ObjectsResponse`, `RealEstateObjectSummary`, `ObjectDeveloper`, `ObjectLocation`, `ObjectMetroStationLink`.
- Prisma models: `RealEstateObject`, `Developer`, `Location`, `MetroStation`, `FeedUnit`, `ObjectImage`, `ObjectFile`.
- API endpoints: `GET /objects`, `GET /developers`, `GET /locations`, `GET /metro`, `GET /catalog-links`.
- Tests: `apps/web/tests/catalog-feed-fallback.test.mjs`, `apps/web/tests/catalog-lot-filters.test.mjs`, `apps/web/tests/catalog-pagination-controls.test.mjs`, `apps/web/tests/catalog-quick-links-page.test.mjs`.
- Связанные docs: `docs/PAGES_AND_ROUTES.md`, `docs/STATE_AND_LOGIC.md`.
- Риски: query params are source of truth; manual/feed price fallback affects sorting/filtering; `matchedFeedUnitsCount` only appears under lot filters.
- Проверки: search, directory filters, lot filters, pagination, sort, card/list views.

## Catalog Quick Links

- Назначение: admin-configurable shortcuts for catalog filters and sales start object links.
- Frontend files: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/admin/CatalogLinksAdminPage.tsx`.
- Backend files: `apps/api/src/catalog-links/catalog-links.controller.ts`, `apps/api/src/catalog-links/catalog-links.service.ts`.
- Shared types: `PublicCatalogQuickLink`, `CatalogLinksResponse`, `AdminCatalogQuickLink`, `AdminCatalogLinksResponse`, `UpdateCatalogLinksRequest`, `CatalogQuickLinkType`.
- Prisma models: `CatalogQuickLink`, `Developer`, `RealEstateObject`.
- API endpoints: `GET /catalog-links`, `GET /catalog-links/admin`, `PUT /catalog-links/admin`.
- Tests: `apps/api/tests/catalog-quick-link-schema.test.cjs`, `apps/web/tests/admin-catalog-links-page.test.mjs`, `apps/web/tests/admin-catalog-links-route.test.mjs`, `apps/web/tests/catalog-quick-links-page.test.mjs`.
- Связанные docs: `docs/PAGES_AND_ROUTES.md`, `docs/API_AND_DATA.md`.
- Риски: target validation depends on link type; public sales links need published object slug.
- Проверки: public links render and navigate, admin save/validation/order/enabled state.

## Object Detail and Lot Detail

- Назначение: full object page, gallery, files, map, feed unit table and lot detail page.
- Frontend files: `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/objects/objectDetailViewModel.ts`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Backend files: `apps/api/src/objects/objects.controller.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/files/media.controller.ts`.
- Shared types: `RealEstateObjectDetail`, `ObjectResponse`, `FeedUnitsResponse`, `FeedUnitResponse`, `FeedUnit`.
- Prisma models: `RealEstateObject`, `ObjectImage`, `ObjectFile`, `FeedUnit`, `FeedResidentialUnitDetails`, `FeedCommercialUnitDetails`, `FeedUnitMedia`, `FeedMediaAsset`, `File`.
- API endpoints: `GET /objects/slug/:slug`, `GET /objects/:id/feed-units`, `GET /objects/:id/feed-units/:unitId`, media/file content endpoints.
- Tests: `apps/web/tests/object-detail-carousel.test.mjs`, `apps/web/tests/object-detail-edit-link.test.mjs`, `apps/web/tests/object-detail-feed-units.test.mjs`, `apps/web/tests/object-detail-view-model.test.mjs`, `apps/web/tests/object-lot-detail-page.test.mjs`.
- Связанные docs: `docs/PAGES_AND_ROUTES.md`, `docs/STATE_AND_LOGIC.md`.
- Риски: detail requires full nested response; lot filters from catalog initialize feed units filters; media carousel depends on file variants.
- Проверки: open detail by slug, edit link visibility, feed unit filtering/sorting, lot route, image/file access.

## Map and Yandex No-key Mode

- Назначение: map route and object detail map.
- Frontend files: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/map/mapMarkerLabels.ts`, `apps/web/src/objects/ObjectDetailPage.tsx`.
- Backend files: `apps/api/src/map/map.controller.ts`, `apps/api/src/map/map.service.ts`, `apps/api/src/objects/object-search.ts`.
- Shared types: `MapObject`, `MapObjectsResponse`.
- Prisma models: `RealEstateObject`, `Developer`, `Location`, `MetroStation`, `ObjectImage`, `FeedUnit`.
- API endpoints: `GET /map/objects`.
- Tests: `apps/web/tests/yandex-map-markers.test.mjs`, `docs/manual-qa-checklist.md` map checks.
- Связанные docs: `docs/PAGES_AND_ROUTES.md`, `docs/RISK_ZONES.md`.
- Риски: no-key mode omits `apikey` from Yandex JS API URL; map route depends on coordinates and endpoint filter parity with catalog.
- Проверки: `/catalog/map` with and without `VITE_YANDEX_MAPS_API_KEY`, empty coordinates state, marker labels, selected card.

## Files and Media

- Назначение: protected uploads, S3/MinIO storage, media cookie image/file access, variants.
- Frontend files: `apps/web/src/files/SecureImage.tsx`, `apps/web/src/files/fileDisplay.ts`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`.
- Backend files: `apps/api/src/files/files.controller.ts`, `apps/api/src/files/media.controller.ts`, `apps/api/src/files/files.service.ts`, `apps/api/src/files/s3-storage.service.ts`, `apps/api/src/files/image-variants.ts`, `apps/api/src/files/backfill-image-variants.ts`.
- Shared types: `FileResponse`, `ObjectStoredFile`, `ObjectImage`, `ObjectLinkedFile`, `FileVariant`, `FileStorage`.
- Prisma models: `File`, `FileVariant`, `ObjectImage`, `ObjectFile`, `User`, `FeedMediaAsset`, `FeedUnitMedia`.
- API endpoints: `POST /files/upload`, `GET /files/:id`, `GET /files/:id/content`, `GET /media/files/:id/content`, `DELETE /files/:id`, object file/gallery endpoints, `POST /users/me/profile-photo`.
- Tests: `apps/api/tests/file-variant-schema.test.cjs`, `apps/api/tests/file-variants-behavior.test.cjs`, `apps/api/tests/backfill-image-variants.test.cjs`, `apps/web/tests/secure-image-variants.test.mjs`, `apps/web/tests/admin-object-file-upload.test.mjs`.
- Связанные docs: `docs/API_AND_DATA.md`, `docs/RISK_ZONES.md`.
- Риски: linked file delete restrictions, variant fallback, media cookie scope, upload size and MIME limits.
- Проверки: upload/delete image and PDF, display thumbnail/card/detail variants, download, profile photo.

## WordPress Import

- Назначение: legacy WP data/media import into current Prisma model.
- Frontend files: `apps/web/src/admin/ImportAdminPage.tsx`.
- Backend files: `apps/api/src/wordpress-import/wordpress-import.controller.ts`, `apps/api/src/wordpress-import/wordpress-import.service.ts`.
- Tool files: `tools/wp-import/src/index.ts`, `tools/wp-import/src/importer.ts`, `tools/wp-import/src/mapper.ts`, `tools/wp-import/src/wordpress-client.ts`, `tools/wp-import/src/storage.ts`.
- Shared types: `ImportReport`, `ImportReportsResponse`, `ImportReportResponse`, `ImportMode`, `ImportStatus`.
- Prisma models: `ImportReport`, `RealEstateObject`, `Developer`, `Location`, `MetroStation`, `File`, `ObjectImage`, `ObjectFile`, `AuditLog`.
- API endpoints: `POST /wordpress-import/preview`, `POST /wordpress-import/run`, `GET /wordpress-import/reports`, `GET /wordpress-import/reports/:id`.
- Tests: `tools/wp-import/tests/mapper.test.cjs`, `tools/wp-import/tests/importer-archive-source.test.cjs`, `tools/wp-import/tests/importer-manual-overrides.test.cjs`, `tools/wp-import/tests/wordpress-client-source.test.cjs`, `tools/wp-import/tests/image-variants.test.cjs`.
- Связанные docs: `docs/manual-qa-checklist.md`, `docs/staging-production-env-checklist.md`.
- Риски: mapping WP meta/terms/media is brittle; run archives missing imported objects when no limit; media path/env must match deployment.
- Проверки: preview report, run report, warnings/errors, media import, archive behavior.

## Feed Import

- Назначение: feed source admin, XML analyze, preview/run units/media import.
- Frontend files: `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/feedSourceMatching.ts`.
- Backend files: `apps/api/src/feeds/feeds.controller.ts`, `apps/api/src/feeds/feeds.service.ts`.
- Tool files: `tools/feed-import/src/index.ts`, `tools/feed-import/src/env.ts`, `tools/feed-import/src/storage.ts`, `tools/feed-import/src/image-variants.ts`.
- Shared types: `FeedSource`, `FeedSourceMapping`, `FeedImportRun`, `FeedUnit`, feed analysis/response types in `packages/shared/src/index.ts`.
- Prisma models: `FeedSource`, `FeedSourceMapping`, `FeedImportRun`, `FeedUnit`, `FeedResidentialUnitDetails`, `FeedCommercialUnitDetails`, `FeedMediaAsset`, `FeedUnitMedia`, `File`, `FileVariant`, `RealEstateObject`.
- API endpoints: `GET /feeds/sources`, `POST /feeds/sources`, `POST /feeds/analyze`, `PATCH /feeds/sources/:id`, `DELETE /feeds/sources/:id`, `POST /feeds/sources/:id/preview`, `POST /feeds/sources/:id/run`, `GET /feeds/sources/:id/runs`, `GET /feeds/runs/:id`, `POST /feeds/runs/:id/stop`, `GET /feeds/units`.
- Tests: `apps/api/tests/feed-schema.test.cjs`, `apps/api/tests/feeds-module.test.cjs`, `tools/feed-import/tests/parser.test.cjs`, `tools/feed-import/tests/import-engine.test.cjs`, `tools/feed-import/tests/package-contract.test.cjs`, `apps/web/tests/admin-feeds-page.test.mjs`, `apps/web/tests/admin-feeds-route.test.mjs`.
- Связанные docs: `docs/API_AND_DATA.md`, `docs/STATE_AND_LOGIC.md`.
- Риски: long-running command process, queued runs, source mappings, index feed namespacing, media dedup/upsert.
- Проверки: analyze URL/file/index, create/update source, preview, run, stop, list units, object price/lot fallback in catalog.

## Repair Scripts

- Назначение: separate WP repair flow for primary locations and developer duplicates.
- Tool files: `tools/wp-import/src/index.ts`, `tools/wp-import/src/repair.ts`, `tools/wp-import/src/developer-aliases.ts`.
- Backend files: no HTTP endpoint; root scripts invoke CLI from `package.json`.
- Shared types: no direct shared type found.
- Prisma models: `RealEstateObject`, `Location`, `ObjectLocation`, `Developer`.
- Commands: `pnpm wp-import:repair:preview`, `pnpm wp-import:repair:run`.
- Tests: no dedicated `repair` test file found in `tools/wp-import/tests`: неясно.
- Связанные docs: `docs/RISK_ZONES.md`.
- Риски: updates primary location flags and moves/deletes developers; must stay separate from normal import.
- Проверки: preview summary before run, inspect moved objects/deleted developers, verify catalog filters.

## Audit Log

- Назначение: backend records administrative/domain actions.
- Frontend files: no audit log UI found: неясно.
- Backend files: `apps/api/src/objects/objects.service.ts`, `apps/api/src/users/users.service.ts`, `tools/wp-import/src/importer.ts`.
- Shared types: no exported audit log response type found in `packages/shared/src/index.ts`: неясно.
- Prisma models: `AuditLog`.
- API endpoints: no audit log controller found in `apps/api/src`: неясно.
- Tests: no dedicated audit log test found by file name: неясно.
- Связанные docs: `docs/API_AND_DATA.md`, `docs/RISK_ZONES.md`.
- Риски: logs exist but no API/UI surface was found; changes to service action names can affect future audit tooling.
- Проверки: inspect DB records after object/user/import actions if audit behavior matters.

## Cabinet, Profile, Photo, Password

- Назначение: user's own workspace and account management.
- Frontend files: `apps/web/src/App.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Backend files: `apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.service.ts`, `apps/api/src/files/files.service.ts`.
- Shared types: `AuthUser`, `ProfilePhotoFile`, `AuthResponse`.
- Prisma models: `User`, `File`, `UserSession`, `AuditLog`.
- API endpoints: `PATCH /users/me`, `PATCH /users/me/password`, `POST /users/me/profile-photo`, `GET /users/me/profile-photo/content`.
- Tests: covered indirectly by auth/user tests; exact cabinet UI tests not found: неясно.
- Связанные docs: `docs/PAGES_AND_ROUTES.md`, `docs/STATE_AND_LOGIC.md`.
- Риски: password policy differs between registration and own password service; photo uses file pipeline and media/token display.
- Проверки: profile save, password change + session behavior, photo upload/display.

## Shared Contracts

- Назначение: shared enums, request/response shapes, object/feed/map/catalog/user contracts.
- Frontend files: all consumers found via `rg '@platforma/shared'` in `apps/web/src`.
- Backend files: `apps/api/src/search/search-filters.ts`, `apps/api/src/objects/object-search.ts`; backend services serialize shapes matching shared manually.
- Shared files: `packages/shared/src/index.ts`, `packages/shared/src/search-normalization.mjs`, `packages/shared/src/search-normalization.cjs`, `packages/shared/src/search-normalization.d.cts`.
- Prisma models: most shared object/feed/file/user types map to `apps/api/prisma/schema.prisma`.
- API endpoints: every endpoint returning shared response shapes.
- Tests: `apps/api/tests/api-contract.test.cjs`, `tools/feed-import/tests/package-contract.test.cjs`, plus frontend tests importing shared types.
- Связанные docs: `docs/API_AND_DATA.md`, `docs/RISK_ZONES.md`.
- Риски: no generated OpenAPI/DTO layer found; response compatibility depends on manual serializers in services.
- Проверки: `pnpm test`, targeted API contract tests, TypeScript builds for web/api/shared.

## Deep frontend feature index

Дата углубленного frontend-индекса: 2026-06-01.

Сканировался `apps/web` полностью, кроме `dist` и `node_modules`. Все выводы ниже подтверждены путями в `apps/web/src`, backend/API путями в `apps/api/src` и shared-контрактами в `packages/shared/src/index.ts`.

### Frontend Shell, Entry, Theme, Routing

- Назначение: bootstrap React app, global theme, protected SPA shell, sidebar, manual routes.
- Frontend files: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/appTheme.ts`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css`.
- Shared types: `AuthUser`, `UserStatus` in `packages/shared/src/index.ts`.
- Routes: `/login`, `/`, `/cabinet`, `/catalog`, `/catalog/map`, `/objects/:slug`, `/objects/:slug/lots/:unitId`, `/admin`, `/admin/users`, `/admin/objects`, `/admin/objects/new`, `/admin/objects/:id/edit`, `/admin/catalog-links`, `/admin/feeds`, `/admin/feeds/new`, `/admin/feeds/:id/edit`, `/admin/import`.
- Permissions: top-level gates in `apps/web/src/App.tsx`; source `hasPermission()` in `apps/web/src/auth/AuthProvider.tsx`.
- Tests: `apps/web/tests/sidebar-navigation.test.mjs`, `apps/web/tests/sidebar-outside-click.test.mjs`, `apps/web/tests/app-theme.test.mjs`, `apps/web/tests/admin-object-create-route.test.mjs`, `apps/web/tests/admin-catalog-links-route.test.mjs`, `apps/web/tests/admin-feeds-route.test.mjs`.
- Риски: every new route must be added to `isAppRoute()` and render branches in `apps/web/src/App.tsx`; global CSS imported by `App.tsx` affects every route.
- Проверки: direct URL reload for every route, sidebar open/close, internal link interception, browser back/forward, theme toggle and `?theme=c|d`.

### Auth and Cabinet Deep Index

- Назначение: session bootstrap, login/logout, email registration, profile, password, photo, permission visibility.
- Frontend files: `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Backend files: `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/cookies.ts`, `apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.service.ts`, `apps/api/src/files/media.controller.ts`.
- Shared types: `AuthResponse`, `AuthUser`, `EmailRegistrationRequestInput`, `EmailRegistrationVerifyInput`, `ProfilePhotoFile` in `packages/shared/src/index.ts`.
- API endpoints: `POST /auth/refresh`, `POST /auth/login`, `POST /auth/register/request`, `POST /auth/register/verify`, `POST /auth/logout`, `PATCH /users/me`, `PATCH /users/me/password`, `POST /users/me/profile-photo`, media content URL from `apps/web/src/files/SecureImage.tsx`.
- Frontend states: `accessToken`, `user`, `isLoading`, profile submitting/error/notice, photo uploading, password submitting/error/notice, registration email/password/activation state.
- Permission display: `cabinetSections` and `permission-chip-list` in `apps/web/src/App.tsx`; role permission grouping in `apps/web/src/admin/UsersAdminPage.tsx`.
- Tests: `apps/web/tests/login-copy.test.mjs`, `apps/web/tests/api-request-errors.test.mjs`, `apps/web/tests/secure-image-variants.test.mjs`, `apps/web/tests/sidebar-navigation.test.mjs`.
- Риски: frontend uses refresh as initial session source; `GET /auth/me` frontend consumer was not found in `apps/web/src`; media image `src` cannot carry bearer token and relies on cookies/backend media guard.
- Проверки: login, auth_token registration, expired access token retry, logout, profile name save, password change, profile photo upload/display, permissions list visibility.

### Catalog Deep Index

- Назначение: searchable/filterable public object catalog with cards/list modes, quick links, pagination, map transition and lot-filter handoff.
- Frontend files: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/components/MultiSelectDropdown.tsx`, `apps/web/src/files/SecureImage.tsx`, `apps/web/src/lib/numberInput.ts`.
- Backend files: `apps/api/src/objects/objects.controller.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/objects/object-search.ts`, `apps/api/src/search/search-filters.ts`, `apps/api/src/directories/directories.controller.ts`, `apps/api/src/catalog-links/catalog-links.controller.ts`.
- Shared types: `ObjectsResponse`, `RealEstateObjectSummary`, `DevelopersResponse`, `LocationsResponse`, `MetroStationsResponse`, `CatalogLinksResponse`, `PublicCatalogQuickLink` in `packages/shared/src/index.ts`.
- API endpoints: `GET /objects`, `GET /catalog-links`, `GET /developers`, `GET /locations`, `GET /metro`.
- Query params: `search`, `developerId`, `krtName`, `locationId`, `areaId`, `metroStationId`, `completionYear`, `lotPriceMin`, `lotPriceMax`, `lotPricePerMeterMin`, `lotPricePerMeterMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax`, `sortBy`, `sortDirection`, `page`, `limit`, `view=list`.
- UI modes: cards default, list via `view=list`, map via route `/catalog/map`.
- States: initial loading, load more loading, directory loading/error, catalog links loading/error, empty state, API error, image loading/error placeholders.
- Tests: `apps/web/tests/catalog-feed-fallback.test.mjs`, `apps/web/tests/catalog-lot-filters.test.mjs`, `apps/web/tests/catalog-pagination-controls.test.mjs`, `apps/web/tests/catalog-quick-links-page.test.mjs`.
- Риски: query params are source of truth; `buildCatalogObjectHref()` carries only lot filters to object detail; `buildObjectsParams()` must stay aligned with backend parser and map endpoint.
- Проверки: filter serialization/reload, sort, limit/page, load more, cards/list switch, quick links, sales links, object detail link with lot filters.

### Catalog Map Deep Index

- Назначение: map-first view of catalog objects with Yandex JS API, markers, selected card, list overlay and bounds filtering.
- Frontend files: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/map/mapMarkerLabels.ts`, `apps/web/src/files/SecureImage.tsx`.
- Backend files: `apps/api/src/map/map.controller.ts`, `apps/api/src/map/map.service.ts`, `apps/api/src/objects/object-search.ts`.
- Shared types: `MapObject`, `MapObjectsResponse` in `packages/shared/src/index.ts`.
- API endpoints: `GET /map/objects`.
- Env: `VITE_YANDEX_MAPS_API_KEY` in `apps/web/.env.example` and `.env.example`; empty key is allowed by frontend loader because `apikey` is omitted.
- Marker behavior: individual `ymaps.Placemark` per object in `apps/web/src/map/YandexMap.tsx`; no frontend clusterer found; labels from `resolveMapMarkerLabel()` in `apps/web/src/map/mapMarkerLabels.ts`.
- Popup behavior: Yandex `balloonContent` is built by `buildMapBalloon()` in `apps/web/src/catalog/CatalogPage.tsx`, but marker click selects React overlay card instead of opening Yandex balloon.
- Overlay behavior: `CatalogMapView` renders `catalog-map-list`, selected `MapObjectCard`, hidden/list toggle and visible-bounds filtering.
- Tests: `apps/web/tests/yandex-map-markers.test.mjs`; manual checks in `docs/manual-qa-checklist.md`.
- Риски: external Yandex script availability, no-key mode, fullscreen viewport restore, overlay portal, marker label truncation and protected map/list model from `rules/frontend.md`.
- Проверки: `/catalog/map` with/without API key, empty coordinates, selected marker/card, list hide/show, map bounds list count, object open link, mobile layout.

### Object Detail Deep Index

- Назначение: public object page, gallery, object parameters, files, map, description/content sections and feed lot table.
- Frontend files: `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/objects/objectDetailViewModel.ts`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/files/SecureImage.tsx`, `apps/web/src/files/fileDisplay.ts`.
- Backend files: `apps/api/src/objects/objects.controller.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/files/media.controller.ts`.
- Shared types: `RealEstateObjectDetail`, `ObjectResponse`, `ObjectImage`, `ObjectLinkedFile`, `FeedUnitsResponse`, `FeedUnitResponse`, `FeedUnit` in `packages/shared/src/index.ts`.
- API endpoints: `GET /objects/slug/:slug`, `GET /objects/:id/feed-units`, `GET /objects/:id/feed-units/:unitId`, media file content URLs.
- Content: description splitting in `apps/web/src/objects/ObjectDetailPage.tsx`; architecture/infrastructure/filling sections in `apps/web/src/objects/objectDetailViewModel.ts`.
- Gallery: cover-first ordering, section filters, thumbnails, lightbox, original download in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Files: presentation primary action, external `layoutsUrl`, additional files list and decoded mojibake titles via `apps/web/src/files/fileDisplay.ts`.
- Map: object coordinates fallback through `YandexMap`; balloon image uses `useSecureImageObjectUrl()` from `apps/web/src/files/SecureImage.tsx`.
- Lot route: `/objects/:slug/lots/:unitId` in `apps/web/src/objects/ObjectDetailPage.tsx` loads object then unit detail.
- Tests: `apps/web/tests/object-detail-carousel.test.mjs`, `apps/web/tests/object-detail-edit-link.test.mjs`, `apps/web/tests/object-detail-feed-units.test.mjs`, `apps/web/tests/object-detail-view-model.test.mjs`, `apps/web/tests/object-lot-detail-page.test.mjs`, `apps/web/tests/object-detail-styles.test.mjs`.
- Риски: detail depends on complete nested serializer; lot filters initialize once from URL; image/file access depends on media cookie; map fallback changes affect object and catalog map.
- Проверки: detail by slug, unpublished badge/edit link visibility by role, gallery filters/lightbox/download, file buttons, object map fallback, feed lot filters/sorting/pagination, lot detail route.

### Admin Deep Index

- Назначение: admin home, users, objects CRUD, import, catalog links, feed sources/imports.
- Frontend files: `apps/web/src/App.tsx`, `apps/web/src/admin/UsersAdminPage.tsx`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/ObjectQuickEditTable.tsx`, `apps/web/src/admin/objectQuickEditPersistence.ts`, `apps/web/src/admin/objectQuickEditTransforms.ts`, `apps/web/src/admin/CatalogLinksAdminPage.tsx`, `apps/web/src/admin/ImportAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/feedSourceMatching.ts`, `apps/web/src/admin/AdminUi.tsx`.
- Backend files: `apps/api/src/users`, `apps/api/src/objects`, `apps/api/src/files`, `apps/api/src/catalog-links`, `apps/api/src/wordpress-import`, `apps/api/src/feeds`.
- Shared types: admin user, role, object, file, catalog link, import report, feed source/run/unit types in `packages/shared/src/index.ts`.
- Permissions: route gates in `apps/web/src/App.tsx`; action gates in each admin page, including `users:create/update/delete`, `objects:create/update/publish`, `files:upload/delete`, `objects:update` for catalog links, `import:preview/run`, `feeds:manage/run`.
- Forms: user create/edit modal-like panel in `UsersAdminPage`; object editor and gallery modal in `ObjectsAdminPage`; catalog link columns in `CatalogLinksAdminPage`; WP report controls in `ImportAdminPage`; feed source create/edit/analyze/run in `FeedsAdminPage`.
- Uploads: profile photo in `App.tsx`; object PDFs and gallery stream upload in `ObjectsAdminPage`; feed XML file upload in `FeedsAdminPage`.
- Validation: object frontend validation in `validateObjectForm()` inside `apps/web/src/admin/ObjectsAdminPage.tsx`; catalog link validation in `validateCatalogLinks()` inside `apps/web/src/admin/CatalogLinksAdminPage.tsx`; feed source JSON/form validation in `apps/web/src/admin/FeedsAdminPage.tsx`.
- Tests: `apps/web/tests/admin-object-create-route.test.mjs`, `apps/web/tests/admin-object-quick-edit-table.test.mjs`, `apps/web/tests/admin-object-file-upload.test.mjs`, `apps/web/tests/admin-object-content-sections.test.mjs`, `apps/web/tests/admin-object-coordinates.test.mjs`, `apps/web/tests/admin-object-location-search-selects.test.mjs`, `apps/web/tests/admin-gallery-state.test.mjs`, `apps/web/tests/admin-gallery-styles.test.mjs`, `apps/web/tests/admin-file-display.test.mjs`, `apps/web/tests/admin-catalog-links-page.test.mjs`, `apps/web/tests/admin-feeds-page.test.mjs`.
- Риски: `ObjectsAdminPage` controls create-before-upload, staged gallery cleanup, batch layout, route parsing and validation; `FeedsAdminPage` controls long-running imports and polling; permissions must match backend guards and seed.
- Проверки: admin navigation by role, user create/update/deactivate, object list filters/quick edit, object create/edit/publish, gallery upload/reorder/cover/delete, PDF upload/delete, catalog links save/public render, import preview/run, feed analyze/preview/run/stop.

### Styles Deep Index

- Назначение: global shell, route layouts, shadcn/Tailwind tokens, catalog/map/object/admin visuals and theme overrides.
- Frontend files: `apps/web/src/styles.css`, `apps/web/src/app-theme.css`, `apps/web/src/appTheme.ts`, `apps/web/src/components/ui/*`, `apps/web/src/components/MultiSelectDropdown.tsx`.
- CSS imports: `@import "tailwindcss"`, `@import "tw-animate-css"`, `@import "shadcn/tailwind.css"` in `apps/web/src/styles.css`.
- Shell/layout selectors: `.app-shell`, `.sidebar`, `.sidebar--open`, `.workspace`, `.page-header`, `.content-panel` in `apps/web/src/styles.css`.
- Catalog selectors: `.catalog-page`, `.catalog-filters`, `.catalog-quick-links`, `.catalog-grid`, `.catalog-list`, `.catalog-card`, `.catalog-list-item`, `.catalog-pagination` in `apps/web/src/styles.css`.
- Map selectors: `.catalog-map-layout`, `.catalog-map-panel`, `.catalog-map-list`, `.yandex-map-shell`, `.yandex-map`, `.map-price-marker`, `.map-object-card`, `.map-fallback`, `.map-balloon` in `apps/web/src/styles.css`.
- Admin selectors: `.admin-users`, `.admin-objects`, `.admin-catalog-links`, `.admin-feeds`, `.admin-import`, `.toolbar`, `.admin-panel`, `.object-quick-edit-table`, `.gallery-modal`, `.catalog-link-*` in `apps/web/src/styles.css`.
- Object selectors: `.object-detail-page`, `.detail-section`, `.media-gallery-frame`, `.object-image-carousel`, `.carousel-*`, `.object-feed-units-*`, `.object-feed-media-*`, `.object-content-sections` in `apps/web/src/styles.css`.
- Theme selectors: `html[data-app-theme]` overrides broad route and component selectors in `apps/web/src/app-theme.css`.
- Tests: `apps/web/tests/object-detail-styles.test.mjs`, `apps/web/tests/admin-gallery-styles.test.mjs`, `apps/web/tests/admin-file-list-styles.test.mjs`, `apps/web/tests/app-theme.test.mjs`.
- Риски: global selectors and theme overrides are intentionally broad; changing one class can affect catalog, map, admin and object detail simultaneously.
- Проверки: visual QA for `/cabinet`, `/catalog`, `/catalog?view=list`, `/catalog/map`, `/objects/:slug`, `/admin/objects`, object editor gallery modal, `/admin/users`, `/admin/catalog-links`, `/admin/import`, `/admin/feeds` in both themes and mobile widths.

## Deep backend/API feature index

Дата углубленного backend/API-индекса: 2026-06-01.

Сканировался `apps/api` полностью, кроме `apps/api/dist` и `apps/api/node_modules`. Подробная endpoint-таблица находится в `docs/API_AND_DATA.md`; ниже карта backend-фич с путями, consumers, тестами и рисками.

### Backend Shell and Modules

- Назначение: NestJS composition root, bootstrap, CORS, module graph.
- Backend files: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`.
- Modules: `PrismaModule`, `AuthModule`, `UsersModule`, `CatalogLinksModule`, `DirectoriesModule`, `FeedsModule`, `FilesModule`, `ObjectsModule`, `MapModule`, `WordpressImportModule`.
- Controller outside feature modules: `HealthController` in `apps/api/src/health/health.controller.ts`.
- Tests: `apps/api/tests/e2e-smoke.test.cjs`, `apps/api/tests/api-contract.test.cjs`.
- Риски: `WEB_ORIGIN` and `credentials: true` must stay aligned with `apps/web/src/admin/api.ts` and `apps/web/src/auth/AuthProvider.tsx`.

### Auth, RBAC and Cookies

- Backend files: `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/cookies.ts`, `apps/api/src/auth/jwt-auth.guard.ts`, `apps/api/src/auth/permissions.guard.ts`, `apps/api/src/auth/media-token.guard.ts`, `apps/api/prisma/seed.ts`.
- API endpoints: `POST /auth/login`, `POST /auth/register/request`, `POST /auth/register/verify`, `POST /auth/logout`, `POST /auth/refresh`, `GET /auth/me`, `GET /media/files/:id/content`.
- Prisma models: `User`, `UserSession`, `EmailAuthChallenge`, `Role`, `Permission`, `RolePermission`, `File`.
- Shared types: `AuthUser`, `AuthResponse`, `EmailRegistrationRequestInput`, `EmailRegistrationVerifyInput`, `EmailRegistrationRequestResponse`, `ProfilePhotoFile` in `packages/shared/src/index.ts`.
- Frontend consumers: `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Tests: `apps/api/tests/auth-rbac.test.cjs`, `apps/api/tests/auth-session-schema.test.cjs`, `apps/api/tests/api-contract.test.cjs`, `apps/web/tests/secure-image-variants.test.mjs`.
- Риски: refresh cookie, media cookie, CORS credentials, ACTIVE user check, seeded permissions and frontend route gates can drift.

### Users and Profile

- Backend files: `apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.service.ts`.
- API endpoints: `GET /users`, `GET /users/roles`, `PATCH /users/me`, `PATCH /users/me/password`, `POST /users/me/profile-photo`, `GET /users/me/profile-photo/content`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/activate`, `POST /users/:id/deactivate`, `DELETE /users/:id`.
- Prisma models: `User`, `Role`, `Permission`, `UserSession`, `File`, `AuditLog`.
- Shared types: `AdminUser`, `AdminUsersResponse`, `AdminRole`, `AdminRolesResponse`, `AuthUser`.
- Frontend consumers: `apps/web/src/admin/UsersAdminPage.tsx`, cabinet/profile code in `apps/web/src/App.tsx`.
- Tests: `apps/api/tests/services.test.cjs`, `apps/api/tests/auth-rbac.test.cjs`.
- Риски: role/status/password changes clear sessions; own profile endpoints return `AuthUser`, admin endpoints return `AdminUser`.

### Objects, Gallery, Files and Lots

- Backend files: `apps/api/src/objects/objects.controller.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/objects/object-search.ts`, `apps/api/src/search/search-filters.ts`.
- API endpoints: `GET /objects`, `GET /objects/:id`, `GET /objects/slug/:slug`, `POST /objects`, `PATCH /objects/:id`, `PATCH /objects/:id/status`, `POST /objects/:id/publish`, object gallery/file endpoints, `GET /objects/:id/feed-units`, `GET /objects/:id/feed-units/:unitId`.
- Prisma models: `RealEstateObject`, `ObjectLocation`, `ObjectMetroStation`, `ObjectImage`, `ObjectFile`, `Developer`, `Location`, `MetroStation`, `File`, `FileVariant`, `FeedUnit`, `AuditLog`.
- Shared types: `RealEstateObjectSummary`, `RealEstateObjectDetail`, `ObjectsResponse`, `ObjectResponse`, `ObjectImage`, `ObjectLinkedFile`, `FeedUnitsResponse`, `FeedUnitResponse`.
- Frontend consumers: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/objectQuickEditPersistence.ts`, `apps/web/src/objects/ObjectDetailPage.tsx`.
- Tests: `apps/api/tests/api-contract.test.cjs`, `apps/api/tests/services.test.cjs`, `apps/api/tests/object-gallery-batch.test.cjs`, `apps/api/tests/object-gallery-stream.test.cjs`, `apps/api/tests/object-file-upload-limit.test.cjs`, frontend object/catalog tests.
- Риски: manual serializers, decimal/string conversions, coordinate numeric conversion, publish validation, staged gallery batch.

### Directories, Catalog Links and Map

- Backend files: `apps/api/src/directories`, `apps/api/src/catalog-links`, `apps/api/src/map`.
- API endpoints: `GET /developers`, `GET /locations`, `GET /metro`, `GET /catalog-links`, `GET /catalog-links/admin`, `PUT /catalog-links/admin`, `GET /map/objects`.
- Prisma models: `Developer`, `Location`, `MetroStation`, `CatalogQuickLink`, `RealEstateObject`, `ObjectImage`, `FeedUnit`.
- Shared types: `DevelopersResponse`, `LocationsResponse`, `MetroStationsResponse`, `CatalogLinksResponse`, `AdminCatalogLinksResponse`, `MapObjectsResponse`.
- Frontend consumers: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/admin/CatalogLinksAdminPage.tsx`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`.
- Tests: `apps/api/tests/services.test.cjs`, `apps/api/tests/catalog-quick-link-schema.test.cjs`, `apps/web/tests/yandex-map-markers.test.mjs`, catalog link tests.
- Риски: map filter parity with `/objects`; admin catalog link `PUT` deletes omitted ids; sales quick links require published object slugs.

### Files and Storage

- Backend files: `apps/api/src/files/files.controller.ts`, `apps/api/src/files/media.controller.ts`, `apps/api/src/files/files.service.ts`, `apps/api/src/files/s3-storage.service.ts`, `apps/api/src/files/image-variants.ts`, `apps/api/src/files/file-upload.constants.ts`.
- API endpoints: `POST /files/upload`, `GET /files/:id`, `GET /files/:id/content`, `DELETE /files/:id`, `GET /media/files/:id/content`, object media endpoints, `POST /users/me/profile-photo`.
- Prisma models: `File`, `FileVariant`, `ObjectImage`, `ObjectFile`, `User`, `FeedSource`, `FeedMediaAsset`.
- Shared types: `ObjectStoredFile`, `FileResponse`, `FileVariant`, object/feed media types.
- Frontend consumers: `apps/web/src/files/SecureImage.tsx`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/App.tsx`.
- Tests: `apps/api/tests/file-variant-schema.test.cjs`, `apps/api/tests/file-variants-behavior.test.cjs`, `apps/api/tests/backfill-image-variants.test.cjs`, `apps/web/tests/secure-image-variants.test.mjs`.
- Риски: media cookie path, linked file delete protection, image variants `THUMBNAIL/CARD/DETAIL`, MinIO env.

### WordPress and Feed Imports

- WordPress backend files: `apps/api/src/wordpress-import/wordpress-import.controller.ts`, `apps/api/src/wordpress-import/wordpress-import.service.ts`, `tools/wp-import/src`.
- WordPress endpoints: `POST /wordpress-import/preview`, `POST /wordpress-import/run`, `GET /wordpress-import/reports`, `GET /wordpress-import/reports/:id`.
- Feed backend files: `apps/api/src/feeds/feeds.controller.ts`, `apps/api/src/feeds/feeds.service.ts`, `tools/feed-import/src`.
- Feed endpoints: `GET /feeds/sources`, `POST /feeds/sources`, `POST /feeds/analyze`, `PATCH /feeds/sources/:id`, `DELETE /feeds/sources/:id`, `POST /feeds/sources/:id/preview`, `POST /feeds/sources/:id/run`, `GET /feeds/sources/:id/runs`, `GET /feeds/runs/:id`, `POST /feeds/runs/:id/stop`, `GET /feeds/units`.
- Absent endpoints: `/feed-import/preview` and `/feed-import/run` were not found in `apps/api/src`; use `/feeds/sources/:id/preview|run`.
- Prisma models: `ImportReport`, `FeedSource`, `FeedSourceMapping`, `FeedImportRun`, `FeedUnit`, `FeedResidentialUnitDetails`, `FeedCommercialUnitDetails`, `FeedMediaAsset`, `FeedUnitMedia`, `File`, `RealEstateObject`.
- Frontend consumers: `apps/web/src/admin/ImportAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, plus catalog/detail via imported feed data.
- Tests: `tools/wp-import/tests/*`, `apps/api/tests/feeds-module.test.cjs`, `apps/api/tests/feed-schema.test.cjs`, `tools/feed-import/tests/*`.
- Риски: shell command/report lookup, queue concurrency, stop process discovery, import idempotency and media import.

### Audit Log

- Backend files: `apps/api/src/objects/objects.service.ts`, `apps/api/src/users/users.service.ts`, `apps/api/prisma/schema.prisma`, `tools/wp-import/src/importer.ts`.
- API endpoints: no audit log controller/endpoints found in `apps/api/src`.
- Prisma model: `AuditLog`.
- Shared types: no audit log response type found in `packages/shared/src/index.ts`.
- Tests: service-level audit assertions in `apps/api/tests/services.test.cjs`.
- Риски: `audit-log:read` permission exists in `apps/api/prisma/seed.ts`, but no API surface currently exposes logs.

## Deep import feature index

Дата углубленного import-индекса: 2026-06-01.

Подробная карта import-подсистем находится в `docs/IMPORT_INDEX.md`. Ниже краткая feature map с путями, consumers, тестами и рисками.

### WordPress import feature

- Назначение: перенос опубликованных legacy WordPress объектов в текущие `RealEstateObject` и связанные справочники/media.
- CLI/tool files: `tools/wp-import/src/index.ts`, `tools/wp-import/src/env.ts`, `tools/wp-import/src/wordpress-client.ts`, `tools/wp-import/src/mapper.ts`, `tools/wp-import/src/importer.ts`, `tools/wp-import/src/storage.ts`, `tools/wp-import/src/image-variants.ts`.
- API files: `apps/api/src/wordpress-import/wordpress-import.controller.ts`, `apps/api/src/wordpress-import/wordpress-import.service.ts`, `apps/api/src/wordpress-import/wordpress-import.module.ts`.
- Frontend files: `apps/web/src/admin/ImportAdminPage.tsx`, route gate in `apps/web/src/App.tsx`.
- Shared types: `ImportReport`, `ImportReportsResponse`, `ImportReportResponse`, `ImportMode`, `ImportStatus` in `packages/shared/src/index.ts`.
- Prisma models: `ImportReport`, `RealEstateObject`, `Developer`, `Location`, `MetroStation`, `File`, `FileVariant`, `ObjectImage`, `ObjectFile`, `AuditLog` in `apps/api/prisma/schema.prisma`.
- API endpoints: `POST /wordpress-import/preview`, `POST /wordpress-import/run`, `GET /wordpress-import/reports`, `GET /wordpress-import/reports/:id`.
- Commands: `wp-import:preview`, `wp-import:run` in `package.json`; package scripts in `tools/wp-import/package.json`.
- Tests: `tools/wp-import/tests/mapper.test.cjs`, `tools/wp-import/tests/wordpress-client-source.test.cjs`, `tools/wp-import/tests/importer-archive-source.test.cjs`, `tools/wp-import/tests/importer-manual-overrides.test.cjs`, `tools/wp-import/tests/image-variants.test.cjs`.
- Риски: preview writes only `ImportReport`; run mutates objects/media; full run without `WP_IMPORT_LIMIT` can archive missing imported objects; idempotency depends on `wpPostId`, `wpAttachmentId`, slug conflict handling and imported link cleanup in `tools/wp-import/src/importer.ts`.

### WordPress repair feature

- Назначение: отдельный repair flow для primary location и developer duplicates.
- CLI/tool files: `tools/wp-import/src/index.ts`, `tools/wp-import/src/repair.ts`, `tools/wp-import/src/developer-aliases.ts`.
- API files: no HTTP endpoint found in `apps/api/src/wordpress-import/wordpress-import.controller.ts`.
- Shared types: no direct shared response type found in `packages/shared/src/index.ts`.
- Prisma models: `RealEstateObject`, `ObjectLocation`, `Location`, `Developer` in `apps/api/prisma/schema.prisma`.
- Commands: `wp-import:repair:preview`, `wp-import:repair:run` in `package.json`; package scripts in `tools/wp-import/package.json`.
- Tests: dedicated repair tests were not found in `tools/wp-import/tests`.
- Риски: repair does not create `ImportReport`, can move primary locations and merge/delete developers, and must stay separate from main WP import semantics.

### Feed import feature

- Назначение: analyze/preview/run XML feed sources and persist feed units/media linked to catalog objects.
- CLI/tool files: `tools/feed-import/src/index.ts`, `tools/feed-import/src/env.ts`, `tools/feed-import/src/storage.ts`, `tools/feed-import/src/image-variants.ts`.
- API files: `apps/api/src/feeds/feeds.controller.ts`, `apps/api/src/feeds/feeds.service.ts`, `apps/api/src/feeds/feeds.module.ts`.
- Frontend files: `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/feedSourceMatching.ts`, route gate in `apps/web/src/App.tsx`.
- Shared types: `FeedSource`, `FeedSourceMapping`, `FeedImportRun`, `FeedUnit`, `FeedSourcesResponse`, `FeedSourceAnalysisResponse`, `FeedImportRunResponse`, `FeedUnitsResponse` in `packages/shared/src/index.ts`.
- Prisma models: `FeedSource`, `FeedSourceMapping`, `FeedImportRun`, `FeedUnit`, `FeedResidentialUnitDetails`, `FeedCommercialUnitDetails`, `FeedMediaAsset`, `FeedUnitMedia`, `File`, `FileVariant`, `RealEstateObject` in `apps/api/prisma/schema.prisma`.
- API endpoints: `GET /feeds/sources`, `POST /feeds/sources`, `POST /feeds/analyze`, `PATCH /feeds/sources/:id`, `DELETE /feeds/sources/:id`, `POST /feeds/sources/:id/preview`, `POST /feeds/sources/:id/run`, `GET /feeds/sources/:id/runs`, `GET /feeds/runs/:id`, `POST /feeds/runs/:id/stop`, `GET /feeds/units`.
- Commands: `feed-import:preview`, `feed-import:run` in `package.json`; package scripts `analyze`, `preview`, `run`, `test` in `tools/feed-import/package.json`.
- Tests: `apps/api/tests/feeds-module.test.cjs`, `apps/api/tests/feed-schema.test.cjs`, `tools/feed-import/tests/parser.test.cjs`, `tools/feed-import/tests/import-engine.test.cjs`, `tools/feed-import/tests/package-contract.test.cjs`, `apps/web/tests/admin-feeds-page.test.mjs`, `apps/web/tests/admin-feeds-route.test.mjs`.
- Риски: preview must not persist units/media/object aggregates; run is queued/detached and idempotent by `(sourceId, externalId)`, `FeedMediaAsset.sourceUrl` and media link replacement in `tools/feed-import/src/index.ts`; stop logic depends on process discovery in `apps/api/src/feeds/feeds.service.ts`.

## Custom project PDF presentations

Дата добавления: 2026-07-20.

- Назначение: администратор вручную выбирает до 12 опубликованных жилых комплексов, задаёт обложку и точечные переопределения, сохраняет черновик и асинхронно получает PDF согласованного формата 4:5.
- Frontend: `apps/web/src/presentations/projects`, маршруты и menu routing в `apps/web/src/App.tsx`, access helper в `apps/web/src/presentations/presentationAccess.ts`.
- Backend: `apps/api/src/project-presentations`, регистрация в `apps/api/src/app.module.ts`.
- Access boundary: на localhost/development раздел доступен любому авторизованному пользователю; в production frontend и backend требуют точную роль `admin`. `JwtAuthGuard` остаётся обязательным во всех окружениях.
- PDF assets: `apps/api/assets/project-presentations/telegram-qr.png`; Telegram CTA и QR ведут на `https://t.me/FluffyWhite`.
- Shared contracts: `ProjectPresentation*` в `packages/shared/src/index.ts`.
- Prisma models: `ProjectPresentationDraft`, `ProjectPresentationDraftObject`, `ProjectPresentationDocument`, `ProjectPresentationDocumentObject`, `ProjectPresentationDocumentAsset`; migration `20260720120000_add_project_presentations`.
- Catalog boundary: выборка включает только `PUBLISHED`, не удалённые объекты категории `RESIDENTIAL`. Источники изображений валидируются по текущим связям объекта.
- Draft semantics: все администраторы видят все черновики; черновик может быть пустым, но генерация требует 1–12 объектов и обложку. `version` используется для optimistic locking.
- Cover upload: обложкой может быть как `ObjectImage` выбранного ЖК, так и собственный `File`, привязанный через `ProjectPresentationDraft.coverFileId`; `POST /project-presentations/drafts/:draftId/cover` принимает JPEG/PNG/WebP до 10 МБ и участвует в optimistic versioning.
- Document semantics: при запуске фиксируется неизменяемый snapshot данных, изображений и контактов владельца черновика. Удаление черновика не удаляет ранее созданные документы.
- Queue: статусы `PENDING`, `RUNNING`, `READY`, `FAILED`; DB-backed worker восстанавливает зависшие задания, хранит progress и поддерживает ручной retry до трёх попыток.
- PDF: `N + 4` страниц — обложка, оглавление, `N` страниц ЖК, Telegram, контакты; каждая страница `540 x 675 pt`.
- Tests: `apps/api/tests/project-presentations-*.test.cjs`, `apps/web/tests/project-presentations-*.test.mjs`.
- Риски: генерация зависит от доступности S3/MinIO и исходных файлов snapshot; UI должен корректно обработать version conflict, failed document и ошибку размера custom cover; замена/удаление собственной обложки не должна удалять файл, пока он связан с immutable document asset.
