# State and Logic

Дата индексации: 2026-06-01.

## Auth state

Auth state lives in `apps/web/src/auth/AuthProvider.tsx`.

State fields:

- `accessToken`
- `user`
- `isLoading`

Main flows:

- On mount, frontend calls `POST /auth/refresh` through `apiRequest`/fetch with credentials.
- Login and registration verification apply `AuthResponse`.
- Logout calls `POST /auth/logout`, clears local state.
- `apiRequest` in `apps/web/src/admin/api.ts` retries once on 401 by calling `POST /auth/refresh`.
- Auth update/clear is propagated with browser events `platforma-auth-updated` and `platforma-auth-cleared`.

Backend session state lives in `apps/api/src/auth/auth.service.ts` and `apps/api/prisma/schema.prisma` models `UserSession` and legacy `User.refreshTokenHash`.

Хрупкие связи:

- Cookie names/options: `apps/api/src/auth/cookies.ts`.
- CORS credentials: `apps/api/src/main.ts`.
- Frontend credentials and Authorization: `apps/web/src/admin/api.ts`.
- Media cookie for images: `apps/api/src/auth/media-token.guard.ts`, `apps/web/src/files/SecureImage.tsx`.

## User/session logic

Current user shape comes from `AuthUser` in `packages/shared/src/index.ts`. Backend builds it in `apps/api/src/auth/auth.service.ts` and `apps/api/src/auth/jwt-auth.guard.ts`.

User admin/profile logic:

- Admin users page state: `apps/web/src/admin/UsersAdminPage.tsx`.
- Own cabinet/profile/password/photo state: `CabinetHome` in `apps/web/src/App.tsx`.
- Backend user mutations: `apps/api/src/users/users.service.ts`.
- Role/status/password changes can clear sessions in `apps/api/src/users/users.service.ts`.

Неясно: there is no dedicated frontend global user store beyond `AuthProvider`.

## Permissions

Frontend permission source: `user.permissions` from `AuthProvider`.

Frontend route gates:

- `apps/web/src/App.tsx` uses `hasPermission`.
- Admin pages also compute action permissions locally, for example `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/UsersAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`.

Backend permission source:

- Decorator: `apps/api/src/auth/permissions.decorator.ts`.
- Guard: `apps/api/src/auth/permissions.guard.ts`.
- Permissions seeded in `apps/api/prisma/seed.ts`.

Хрупкая связь: frontend route permission sets must stay aligned with backend `RequirePermissions` on controllers.

## Catalog filters

Catalog state lives in `apps/web/src/catalog/CatalogPage.tsx`.

Query params are the primary source of truth for public catalog state:

- `search`
- `developerId`
- `krtName`
- `locationId`
- `areaId`
- `metroStationId`
- `completionYear`
- `lotPriceMin`
- `lotPriceMax`
- `lotRooms`
- `lotFloorMin`
- `lotFloorMax`
- `sortBy`
- `sortDirection`
- `page`
- `limit`
- `view=list`

Internal defaults and non-serialized values:

- Default `status` is `PUBLISHED`.
- `completionQuarter` exists in filter type but was not found as serialized catalog query param.
- `hasCoordinates` and `hasPresentation` exist in filter state/backend support; current route serialization/UI coverage is partial: неясно for full UX.

Backend filtering is in `apps/api/src/objects/objects.service.ts` and map filtering is in `apps/api/src/map/map.service.ts`.

Хрупкие связи:

- Query param names must match backend query parser.
- Lot filters rely on `FeedUnit` fields.
- Catalog object links carry lot filters into `/objects/:slug`.
- Map and list filters must stay aligned.

## View models

Object detail view model logic lives in `apps/web/src/objects/objectDetailViewModel.ts`.

It formats:

- content sections;
- location line;
- parameter rows;
- location rows;
- price and completion labels;
- ceiling height normalization.

Other frontend transformation logic:

- Object quick edit transforms: `apps/web/src/admin/objectQuickEditTransforms.ts`.
- Object quick edit persistence: `apps/web/src/admin/objectQuickEditPersistence.ts`.
- Feed source matching: `apps/web/src/admin/feedSourceMatching.ts`.
- File display decoding: `apps/web/src/files/fileDisplay.ts`, `apps/web/src/admin/fileDisplay.ts`.
- Map marker labels: `apps/web/src/map/mapMarkerLabels.ts`.

Риск: these view models are not generated from backend contracts and can drift from serialized values.

## Object admin form

Object admin state lives in `apps/web/src/admin/ObjectsAdminPage.tsx`.

Main state groups:

- list filters and pagination;
- directory options for developers/locations/metro;
- create/edit route mode from pathname;
- `ObjectFormState`;
- linked files draft;
- gallery draft/staged/existing items;
- validation errors, notices, submitting states.

Important flows:

1. List route loads summaries with `/objects` and directories.
2. Create route validates local form and calls `POST /objects`.
3. Edit route loads detail with `GET /objects/:id` and saves with `PATCH /objects/:id`.
4. Publish uses `POST /objects/:id/publish`.
5. Linked PDFs use `POST /objects/:id/files` and `DELETE /objects/:id/files/:objectFileId`.
6. Gallery uses raw stream staging `POST /objects/:id/gallery/stream`, then `PATCH /objects/:id/gallery/batch`.

Backend validation/lifecycle is in `apps/api/src/objects/objects.service.ts`.

Хрупкие связи:

- Form local validation must not disagree with backend validation.
- Create flow can create object before media save.
- Gallery cleanup depends on `DELETE /files/:fileId` and `files:delete`.
- `featuresText` is JSON and maps to `featuresJson`.

## Import flows

### WordPress import

Frontend state: `apps/web/src/admin/ImportAdminPage.tsx`.

Backend orchestration: `apps/api/src/wordpress-import/wordpress-import.service.ts`.

CLI implementation: `tools/wp-import/src/index.ts`, `tools/wp-import/src/importer.ts`, `tools/wp-import/src/mapper.ts`.

Flow:

1. Admin calls `POST /wordpress-import/preview` or `POST /wordpress-import/run`.
2. API starts `pnpm --filter @platforma/wp-import run preview|run`.
3. CLI reads WP DB/media env, maps posts/meta/terms/media, writes `ImportReport`.
4. API returns latest report.

Хрупкие связи:

- API finds report after shell command.
- One active command lock is in backend service.
- Run can archive missing imported objects if no import limit.
- Mapper depends on legacy WP meta/term conventions.

### Feed import

Frontend state: `apps/web/src/admin/FeedsAdminPage.tsx`.

Backend orchestration: `apps/api/src/feeds/feeds.service.ts`.

CLI implementation: `tools/feed-import/src/index.ts`.

Flow:

1. Admin creates/updates feed source and mappings.
2. Analyze can run against URL/file/index.
3. Preview/run creates or uses `FeedImportRun`.
4. Backend starts `pnpm --filter @platforma/feed-import --fail-if-no-match run preview|run --source <id>`.
5. CLI parses feed XML, routes units to objects, persists units/details/media, refreshes object feed summary.
6. Frontend polls pending run every 2000ms in `apps/web/src/admin/FeedsAdminPage.tsx`.

Хрупкие связи:

- Source kind/format/mappings must match parser behavior.
- Index feeds can namespace external ids.
- Media dedup and variant generation affect detail page.
- Long-running process and stop logic must not leave stale run states.

## Map flow

Map route state lives in `apps/web/src/catalog/CatalogPage.tsx`; map rendering lives in `apps/web/src/map/YandexMap.tsx`.

Flow:

1. `/catalog/map` parses query params into filters.
2. Frontend calls `GET /map/objects` with catalog-like filters.
3. Backend `apps/api/src/map/map.service.ts` returns objects with non-null coordinates.
4. Frontend converts to map points and passes them to `YandexMap`.
5. `YandexMap` loads `https://api-maps.yandex.ru/2.1/?lang=ru_RU` and appends `apikey` only when `VITE_YANDEX_MAPS_API_KEY` exists.

States:

- map loading;
- map error;
- no points;
- selected point;
- fullscreen/viewport restore.

Хрупкие связи:

- External Yandex JS API behavior without key.
- Marker label expectations in `apps/web/src/map/mapMarkerLabels.ts`.
- Backend map filters must match catalog filters.

## File upload flow

Frontend file access/upload files:

- `apps/web/src/admin/ObjectsAdminPage.tsx`
- `apps/web/src/objects/ObjectDetailPage.tsx`
- `apps/web/src/files/SecureImage.tsx`

Backend files:

- `apps/api/src/files/files.controller.ts`
- `apps/api/src/files/media.controller.ts`
- `apps/api/src/files/files.service.ts`
- `apps/api/src/files/s3-storage.service.ts`
- `apps/api/src/files/file-upload.constants.ts`

Flow:

1. Upload validates MIME/size using constants.
2. Backend stores original in S3/MinIO and creates `File`.
3. Image uploads generate variants and `FileVariant` rows.
4. Object/profile/feed flows link files to domain models.
5. Browser image display uses `/media/files/:id/content` with media cookie.
6. Downloads can use `/files/:id/content` with bearer or media URL with `download=1`.

Хрупкие связи:

- Image src cannot attach bearer token.
- Variant names are shared expectations.
- Delete refuses linked files, but all link types must be counted.
- Gallery stream upload uses headers and raw body instead of multipart.

## Other fragile links

- `apps/web/src/App.tsx` manual client routing must include any new app route.
- `apps/web/src/styles.css` and `apps/web/src/app-theme.css` affect global layout, admin, catalog, map, detail.
- `packages/shared/src/index.ts` changes can break many consumers at once.
- `apps/api/prisma/schema.prisma` enum/value changes must match shared enums and frontend labels.
- `tools/wp-import/src/mapper.ts` and `tools/feed-import/src/index.ts` can mutate object data used by catalog/map/detail.

## Deep frontend state and logic index

Дата углубленного frontend-индекса: 2026-06-01.

Сканировался `apps/web` полностью, кроме `dist` и `node_modules`. Этот раздел фиксирует frontend state и local logic, подтвержденные конкретными файлами.

### Entry, route and shell state

- Theme bootstrap state is initialized before React render in `apps/web/src/main.tsx` through `initAppTheme()` from `apps/web/src/appTheme.ts`.
- Theme persistence uses `localStorage` key `platforma.theme` in `apps/web/src/appTheme.ts`; query params `?theme=c` and `?theme=d` override and persist theme.
- Route state lives in `usePathname()` inside `apps/web/src/App.tsx`: `pathname` mirrors `window.location.pathname`.
- `usePathname()` listens to `popstate` and intercepts app-local anchor clicks from `document` in `apps/web/src/App.tsx`; app-local paths are constrained by `isAppRoute()`.
- Sidebar state lives in `AppRoutes` in `apps/web/src/App.tsx`: `isSidebarOpen`, `sidebarRef`, outside `pointerdown` close handler.
- Current section state is derived in `AppRoutes` in `apps/web/src/App.tsx`: paths starting `/admin` map to `admin`, `/catalog` and `/objects/` map to `catalog`, everything else maps to `cabinet`.
- Risk: because route parsing is manual in `apps/web/src/App.tsx`, route changes must update `isAppRoute()`, active section derivation, render branches and tests under `apps/web/tests/*route*.test.mjs`.

### Auth, API and cabinet state

- Auth state lives in `apps/web/src/auth/AuthProvider.tsx`: `accessToken`, `user`, `isLoading`.
- Initial session refresh is `POST /auth/refresh` in `apps/web/src/auth/AuthProvider.tsx`; frontend does not call `GET /auth/me` in current `apps/web/src`.
- Login and email registration mutate auth through `applyAuthResponse()` in `apps/web/src/auth/AuthProvider.tsx`.
- Global API token lives outside React in `currentAccessToken` inside `apps/web/src/admin/api.ts`.
- Refresh retry state uses `refreshSessionPromise` singleton in `apps/web/src/admin/api.ts`, preventing parallel refresh storms.
- Auth cross-component sync uses browser events `platforma-auth-updated` and `platforma-auth-cleared`, declared in `apps/web/src/admin/api.ts` and listened to in `apps/web/src/auth/AuthProvider.tsx`.
- Cabinet profile state is local to `CabinetHome` in `apps/web/src/App.tsx`: `profileName`, `profilePhotoFile`, `profileError`, `profileNotice`, `isProfileSubmitting`, `isPhotoUploading`.
- Cabinet password state is local to `CabinetHome` in `apps/web/src/App.tsx`: `currentPassword`, `newPassword`, `newPasswordRepeat`, `passwordError`, `passwordNotice`, `isPasswordSubmitting`.
- Available cabinet sections are derived from `user.permissions` through `getAvailableCabinetSections()` in `apps/web/src/App.tsx`; the visible permissions are rendered as chips.
- Profile photo display state uses `SecureProfileImage` in `apps/web/src/App.tsx`, with `hasError` fallback to initials; image URL builder is `buildMediaFileContentUrl()` in `apps/web/src/files/SecureImage.tsx`.
- Risk: `apiRequest()` in `apps/web/src/admin/api.ts`, `AuthProvider` in `apps/web/src/auth/AuthProvider.tsx` and backend cookie/CORS settings must stay aligned or login, refresh and media display fail together.

### Secure image and file state

- Protected image loading state lives in `useSecureImageObjectUrl()` in `apps/web/src/files/SecureImage.tsx`: `src`, `status`, `shouldLoad`, `targetElement`.
- Lazy loading uses `IntersectionObserver` in `apps/web/src/files/SecureImage.tsx`, default `rootMargin` is `240px`.
- `SecureImage` preloads with browser `Image`; on load it sets `src`, on error it sets `status='error'`.
- Variant selection is normalized in `normalizeVariant()` in `apps/web/src/files/SecureImage.tsx`; supported frontend values are `original` and lowercase shared `FileVariant`.
- Download/media URLs are built by `buildMediaFileContentUrl()` in `apps/web/src/files/SecureImage.tsx`.
- File title decoding for mojibake lives in `apps/web/src/files/fileDisplay.ts` and admin copy in `apps/web/src/admin/fileDisplay.ts`.
- Risk: image `src` cannot attach Authorization header; any media cookie/backend guard change must be checked against `SecureImage` consumers in `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/App.tsx`.

### Catalog state

- Catalog URL state source is `queryString` in `apps/web/src/catalog/CatalogPage.tsx`; it is initialized from `window.location.search` and updated on `popstate` and pathname changes.
- Parsed catalog filters come from `parseCatalogFilters(queryString)` in `apps/web/src/catalog/CatalogPage.tsx`.
- View mode comes from `parseCatalogViewMode(queryString)` in `apps/web/src/catalog/CatalogPage.tsx`; only `view=list` is serialized, cards are default.
- Object list state in `CatalogPage`: `objects`, `totalPages`, `total`, `loadedThroughPage`, `isLoading`, `isLoadingMore`, `error`, `loadMoreError`.
- Map object state in `CatalogPage`: `mapObjects`, `mapTotal`, `isMapLoading`, `mapError`.
- Directory state in `CatalogPage`: `directories`, `isDirectoriesLoading`, `directoryError`; data comes from developers, locations and metro endpoints.
- Quick links state in `CatalogPage`: `catalogLinks`, `isCatalogLinksLoading`, `catalogLinksError`; loaded only for `/catalog` and `/catalog/map`.
- Request race protection uses `objectsRequestIdRef` and `mapObjectsRequestIdRef` in `apps/web/src/catalog/CatalogPage.tsx`.
- `updateFilters()` in `apps/web/src/catalog/CatalogPage.tsx` rewrites URL with `window.history.pushState`, resets page by default and aggressively clears old results for search changes.
- `loadMoreObjects()` appends results with `appendUniqueCatalogObjects()` in `apps/web/src/catalog/CatalogPage.tsx`.
- Lot filters are serialized into object links by `buildCatalogLotFilterQuery()` in `apps/web/src/catalog/CatalogPage.tsx`; only `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax` are carried to object detail.
- Risk: current public catalog UI does not serialize internal `completionQuarter`, `status`, `hasPresentation`, `hasCoordinates`; changing these fields needs explicit route/query design.

### Catalog map state

- Map route state is still owned by `CatalogPage` in `apps/web/src/catalog/CatalogPage.tsx`; map-specific component is `CatalogMapView`.
- `CatalogMapView` local state: `visibleBounds`, `selectedObjectId`, `isListVisible`.
- Map points are derived from `objects.map((object) => mapObjectToPoint(object, filters))` in `apps/web/src/catalog/CatalogPage.tsx`.
- Visible overlay list is derived by filtering map objects through `isMapObjectInBounds()` using bounds from `YandexMap.onBoundsChange`.
- Selected card is derived from `selectedObjectId` and renders `MapObjectCard`; marker visual selection is applied in `apps/web/src/map/YandexMap.tsx` via `[data-yandex-point-id]` and `.map-price-marker--selected`.
- `YandexMap` internal state in `apps/web/src/map/YandexMap.tsx`: `status` (`idle`, `loading`, `ready`, `error`) and `overlayRoot`.
- Yandex map lifecycle state in `apps/web/src/map/YandexMap.tsx` includes map instance, fullscreen viewport restore, boundschange handlers, overlay root cleanup and global `window.platformaYandexMapsPromise`.
- No cluster state was found in `apps/web/src/map/YandexMap.tsx`; all points are individual placemarks.
- Risk: overlay children are portaled into Yandex map DOM; CSS/z-index changes in `apps/web/src/styles.css` can hide selected cards or the list overlay.

### Object detail and lot state

- Object detail load state lives in `ObjectDetailPage` in `apps/web/src/objects/ObjectDetailPage.tsx`: `object`, `isLoading`, `error`.
- Detail page fetches `GET /objects/slug/:slug`; cancelled effects guard stale updates through `isCancelled` local variable in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Object view model state is derived through memoized calls in `ObjectDetail`: `descriptionParagraphs`, `contentSections`, `locationLine`, `locationRows`, `parameterRows`, `carouselImages`, `mapPoints`.
- Content section derivation lives in `apps/web/src/objects/objectDetailViewModel.ts`, not in backend serializer.
- Object gallery state in `ObjectImageCarousel`: `activeSection`, `activeIndex`, `lightboxIndex`; keyboard handlers close/navigate lightbox.
- Object feed units state in `ObjectFeedUnitsSection`: `units`, `page`, `total`, `totalPages`, `hasDiscountPrices`, many filter fields, `sortBy`, `sortDirection`, `mediaCarouselUnit`, `isLoading`, `error`.
- Initial lot filters are read once from current URL by `getInitialObjectFeedUnitFiltersFromLocation()` in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Lot detail route state in `ObjectLotDetailPage`: `object`, `unit`, `isLoading`, `error`; it fetches object by slug, then `GET /objects/:id/feed-units/:unitId`.
- Lot media carousel state in `ObjectLotMediaCarousel` and `ObjectFeedMediaCarousel`: `activeIndex`, `fullscreenMedia`; keyboard navigation is attached to `document`/`window`.
- Risk: object detail combines object serializer, feed unit serializer, media URLs, Yandex map and local view model formatting; changes should be verified across gallery, files, map and lots.

### Admin users state

- User admin state lives in `apps/web/src/admin/UsersAdminPage.tsx`: `users`, `roles`, `selectedUser`, `form`, `search`, `statusFilter`, `roleFilter`, `page`, `totalPages`, `total`, loading/submitting/notice/error flags.
- Role permissions display is derived by `groupPermissionsByScope()` in `apps/web/src/admin/UsersAdminPage.tsx`.
- Action disabled logic is derived from `canCreate`, `canUpdate`, `canDelete` in `apps/web/src/admin/UsersAdminPage.tsx`.
- Loading uses debounced `setTimeout(..., 180)` before `loadUsers()` in `apps/web/src/admin/UsersAdminPage.tsx`.
- Risk: changing user role/status/password may clear sessions in backend `apps/api/src/users/users.service.ts`, so frontend state should be checked after admin edits.

### Admin objects state

- Object admin list/editor state lives in `apps/web/src/admin/ObjectsAdminPage.tsx`; this is the largest frontend state container.

## Deep backend/API state and logic index

Дата углубленного backend/API-индекса: 2026-06-01.

Сканировался `apps/api` полностью, кроме `apps/api/dist` и `apps/api/node_modules`. Этот раздел фиксирует backend state, request parsing and service logic, подтвержденные конкретными файлами.

### Module and Request State

- Nest composition lives in `apps/api/src/app.module.ts`; runtime CORS/port state lives in `apps/api/src/main.ts`.
- Feature modules import `AuthModule` and `PrismaModule` where guards/services need auth and DB: `apps/api/src/users/users.module.ts`, `apps/api/src/objects/objects.module.ts`, `apps/api/src/map/map.module.ts`, `apps/api/src/catalog-links/catalog-links.module.ts`, `apps/api/src/directories/directories.module.ts`, `apps/api/src/feeds/feeds.module.ts`, `apps/api/src/wordpress-import/wordpress-import.module.ts`.
- `FilesModule` exports `FilesService` for `UsersModule`, `ObjectsModule` and `FeedsModule`, confirmed in `apps/api/src/files/files.module.ts`.
- Risk: changing module imports can break DI for guards, `FilesService`, `JwtModule` or `PrismaService`.

### Auth Session and Cookie Logic

- Refresh session state lives in `UserSession` and legacy `User.refreshTokenHash` fields in `apps/api/prisma/schema.prisma`.
- `AuthService.login()` creates access/refresh/media tokens in `apps/api/src/auth/auth.service.ts`.
- `AuthService.refresh()` reads the refresh cookie via `getCookieValue()` from `apps/api/src/auth/cookies.ts`, resolves a `UserSession` or legacy refresh session, then rotates tokens.
- `AuthController.login()`, `AuthController.refresh()` and `AuthController.verifyEmailRegistration()` set both refresh and media cookies in `apps/api/src/auth/auth.controller.ts`.
- `AuthController.logout()` clears refresh and media cookies using the same names/options from `apps/api/src/auth/cookies.ts`.
- `JwtAuthGuard` in `apps/api/src/auth/jwt-auth.guard.ts` requires a Bearer access token and ACTIVE non-deleted user.
- `MediaTokenGuard` in `apps/api/src/auth/media-token.guard.ts` requires media cookie scope `files:read`.
- Risk: `apps/web/src/admin/api.ts` refresh retry, `apps/web/src/auth/AuthProvider.tsx` bootstrapping and `apps/web/src/files/SecureImage.tsx` media display depend on these cookies and CORS credentials.

### RBAC Logic

- Required permissions are attached by `RequirePermissions()` in `apps/api/src/auth/permissions.decorator.ts`.
- `PermissionsGuard` in `apps/api/src/auth/permissions.guard.ts` requires every permission listed on controller method.
- Permissions and role bundles are seeded in `apps/api/prisma/seed.ts`; `admin` receives all permissions, `editor` receives object/directory/file permissions, `user` receives read-only object/directory permissions.
- Risk: `audit-log:read` is seeded in `apps/api/prisma/seed.ts`, but no audit log endpoint was found in `apps/api/src`.

### Object Query and Serializer Logic

- Object list query parsing is in `ObjectsService.list()` in `apps/api/src/objects/objects.service.ts`; supported query includes search/status/sort/directory/KRT/completion/manual price/lot/coordinate/presentation filters.
- Catalog search uses `findCatalogSearchObjectIds()` in `apps/api/src/objects/object-search.ts` and `createSearchContainsFilters()` in `apps/api/src/search/search-filters.ts`.
- List responses use `objectListInclude`; detail responses use `objectDetailInclude` in `apps/api/src/objects/objects.service.ts`.
- `serializeObjectBase()`, `serializeObjectSummary()` and `serializeObjectDetail()` manually convert Prisma data to shared object contracts in `apps/api/src/objects/objects.service.ts`.
- Decimal money fields serialize to strings; coordinates serialize to numbers; `featuresJson` is returned as JSON.
- Risk: changing `RealEstateObject` response shape affects `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx` and `apps/web/src/map/YandexMap.tsx`.

### Object Lifecycle and Media Logic

- `POST /objects` always creates `DRAFT`; non-draft status in body is rejected in `ObjectsService.create()` in `apps/api/src/objects/objects.service.ts`.
- `PATCH /objects/:id` validates completion, coordinates, developer/location/metro ids and published required fields in `ObjectsService.update()`.
- `POST /objects/:id/publish` and `PATCH /objects/:id/status` route through publish/archive logic in `ObjectsService.publish()` and `ObjectsService.updateStatus()`.
- Gallery state is controlled by `uploadGalleryImageStream()`, `replaceGallery()`, `updateGalleryLayout()`, `sortGallery()` and `deleteGalleryImage()` in `apps/api/src/objects/objects.service.ts`.
- Linked object file state is controlled by `uploadObjectFile()` and `deleteObjectFile()` in `apps/api/src/objects/objects.service.ts`.
- Risk: gallery stream/batch combines raw uploads, staged file ids, cover selection, section assignment and cleanup permissions.

### Map Query Logic

- `MapService.listObjects()` in `apps/api/src/map/map.service.ts` reuses catalog-like filters and always adds non-null latitude/longitude.
- `/map/objects` returns `{items,total}` with `MapObject` shape from `packages/shared/src/index.ts`, not full object detail.
- Map `limit` defaults to 1000 and caps at 2000 in `apps/api/src/map/map.service.ts`.
- Risk: filter drift from `ObjectsService.list()` breaks `/catalog/map` parity with `/catalog`.

### File and Storage Logic

- Upload validation constants live in `apps/api/src/files/file-upload.constants.ts`: images default 10 MB, PDFs 50 MB, feed XML 100 MB unless env overrides.
- `FilesService.uploadFile()` and `FilesService.uploadFileStream()` store original files through `S3StorageService`, generate variants through `apps/api/src/files/image-variants.ts`, then create `File` and `FileVariant`.
- `FilesService.getContent()` resolves `variant=thumbnail|card|detail|original`, falls back to original when a requested variant is missing.
- `FilesService.delete()` refuses deletion when the file is linked by profile photos, object images, object files or feed XML sources.
- Risk: `FeedMediaAsset` link count is not included in the current delete refusal count in `apps/api/src/files/files.service.ts`; feed media file deletion behavior should be reviewed before changing delete logic.

### User Logic

- `UsersService.list()` parses pagination/search/status/role filters in `apps/api/src/users/users.service.ts`.
- `UsersService.create()` creates users and writes `user.create` audit rows.
- `UsersService.update()` can change email/name/role/status/password; role/status/password changes clear refresh tokens and sessions.
- `UsersService.updateOwnProfile()`, `changeOwnPassword()` and `uploadOwnProfilePhoto()` return `AuthUser`-shaped users and write audit rows.
- Risk: own password change currently updates password and returns `AuthUser`; admin password/status/role changes clear sessions, so expectations differ by endpoint.

### Import Logic

- WordPress API service `apps/api/src/wordpress-import/wordpress-import.service.ts` runs `pnpm --filter @platforma/wp-import run preview|run`, holds one active command lock and returns the latest `ImportReport` created after command start.
- Feed API service `apps/api/src/feeds/feeds.service.ts` runs feed analyze/preview/run through `pnpm --filter @platforma/feed-import`; run mode creates a pending `FeedImportRun`, queues detached work and returns immediately.
- Feed run queue concurrency is `3`; stop logic uses active child process map, `/proc` scan and `pgrep`, confirmed in `apps/api/src/feeds/feeds.service.ts`.
- `/feed-import/preview` and `/feed-import/run` endpoints were not found; feed preview/run state is under `/feeds/sources/:id/preview|run`.
- Risk: import idempotency lives in `tools/wp-import/src` and `tools/feed-import/src`, while API services only orchestrate command execution and report/run discovery.

### Audit Logic

- Object actions call `logObjectAction()` in `apps/api/src/objects/objects.service.ts`.
- User actions call `logUserAction()` in `apps/api/src/users/users.service.ts`.
- WordPress importer reads audit logs to restore latest admin values, confirmed by `tools/wp-import/src/importer.ts` and `tools/wp-import/tests/importer-manual-overrides.test.cjs`.
- No audit log controller or shared audit response type was found in `apps/api/src` or `packages/shared/src/index.ts`.
- Route mode is derived from `pathname`: exact `/admin/objects/new`, exact `/admin/objects`, and UUID edit regex `/admin/objects/:id/edit`.
- List state: `objects`, directories, `search`, `statusFilter`, advanced location search fields, `sortBy`, `sortDirection`, `page`, `totalPages`, `total`, loading/error/notice.
- Editor form state is `ObjectFormState` in `apps/web/src/admin/ObjectsAdminPage.tsx`; it includes title, description, architecture/infrastructure/filling, layouts URL, prices, completion, address, coordinates, developer, locations, metro and `featuresText`.
- Validation is local in `validateObjectForm()` in `apps/web/src/admin/ObjectsAdminPage.tsx`; it checks title, completion dependencies, coordinate parse, URL protocol, text lengths and `featuresText` object JSON.
- Payload mapping is local in `createPayloadFromForm()` in `apps/web/src/admin/ObjectsAdminPage.tsx`; it parses coordinates, normalizes price/ceiling height, maps location IDs and parses JSON.
- Quick edit persistence is delegated to `apps/web/src/admin/objectQuickEditPersistence.ts`; display normalization/search is in `apps/web/src/admin/objectQuickEditTransforms.ts`.
- Gallery modal state: `isGalleryModalOpen`, `galleryDraftItems`, `galleryCoverDraftId`, `galleryDeletedImageIds`, `galleryModalError`, `galleryModalProgress`, `galleryModalProgressPercent`, plus refs `galleryDraftItemsRef` and `galleryModalSaveInFlightRef`.
- Gallery save flow reconciles current backend gallery, uploads new images through `/objects/:id/gallery/stream`, saves layout through `/objects/:id/gallery/batch`, and attempts cleanup via `DELETE /files/:fileId`.
- Linked PDF state: `objectFiles`, `objectFileType`, `objectFileTitle`, `isUploading`; create route can create object before uploading PDFs.
- Risk: create-before-upload and staged gallery cleanup are fragile; permission gates `files:upload`, `files:delete`, `objects:update`, `objects:create` must be checked together.

### Admin catalog links, import and feeds state

- Catalog links state lives in `apps/web/src/admin/CatalogLinksAdminPage.tsx`: `links`, `developers`, `publishedObjects`, loading/submitting/error/notice.
- Catalog links options are derived from loaded links and published objects through `mergeDevelopers()`, `mergePublishedObjects()` and `mergeKrtOptions()` in `apps/web/src/admin/CatalogLinksAdminPage.tsx`.
- Catalog link save validates targets locally via `validateCatalogLinks()` and saves all items with `PUT /catalog-links/admin`.
- WordPress import state lives in `apps/web/src/admin/ImportAdminPage.tsx`: `reports`, `selectedReport`, filters, pagination, `runningMode`, loading/error/notice.
- Import commands use browser confirm for `run` in `apps/web/src/admin/ImportAdminPage.tsx`.
- Feed admin state lives in `apps/web/src/admin/FeedsAdminPage.tsx`: source list, directories, objects, form, analysis, selected source/run, units, multiple pages/totals, loading/submitting/running/stopping flags.
- Feed route mode is derived from `pathname` in `apps/web/src/admin/FeedsAdminPage.tsx`: list, create and UUID edit.
- Feed polling interval is `feedRunPollMs = 2000` in `apps/web/src/admin/FeedsAdminPage.tsx`.
- Risk: catalog links depend on valid published object slugs; import/feed pages trigger backend long-running commands and should be checked for disabled states, polling and stale selected rows.

### Frontend style state

- Global styles and design tokens are in `apps/web/src/styles.css`; theme overrides are in `apps/web/src/app-theme.css`.
- `html[data-app-theme]` from `apps/web/src/appTheme.ts` drives broad CSS variable overrides in `apps/web/src/app-theme.css`.
- Route-width and layout behavior uses broad selectors like `.workspace:has(.catalog-page)`, `.workspace:has(.object-detail-page)`, `.workspace:has(.admin-users)`, `.workspace:has(.admin-objects)`, `.workspace:has(.admin-catalog-links)`, `.workspace:has(.admin-feeds)`, `.workspace:has(.admin-import)` in `apps/web/src/styles.css`.
- Protected frontend model from `rules/frontend.md` maps to CSS and state in `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/styles.css`.
- Risk: changing class names or global selectors can silently affect multiple routes; style changes need manual QA in both `minimal-luxury` and `dark-premium`.

## Deep import state and logic index

Дата углубленного import-индекса: 2026-06-01.

Подробный import-index: `docs/IMPORT_INDEX.md`.

### WordPress import state and logic

- CLI command state is parsed from `process.argv[2]` in `tools/wp-import/src/index.ts`: `preview`, `run`, or `repair preview|run`.
- Env state is loaded in order from root `.env`, `apps/api/.env`, `tools/wp-import/.env` by `tools/wp-import/src/env.ts`.
- WP source state is read into `WpSourceData` by `WordPressReadonlyClient.fetchSourceData()` in `tools/wp-import/src/wordpress-client.ts`: site URL, published posts, post meta, object terms, terms, term meta, referenced attachments and attachment local file metadata.
- Mapping state is `MappedImport` from `mapWordPressSource()` in `tools/wp-import/src/mapper.ts`: mapped objects, warnings, errors and summary counters.
- Preview state creates and finishes `ImportReport` but skips object/media persistence because `persistMappedImport()` is called only when `mode === 'run'` in `tools/wp-import/src/importer.ts`.
- Run state persists each mapped object inside a Prisma transaction for object/directories/links, then persists media outside that transaction through `persistObjectMedia()` in `tools/wp-import/src/importer.ts`.
- Manual override state is reconstructed from `AuditLog.metadata.changes` in `loadManualObjectOverrides()` and `collectManualObjectOverrides()` in `tools/wp-import/src/importer.ts`.
- Imported media state is reconciled by current imported WP attachment ids and `sourceMetaKey`: stale imported `ObjectImage` and `ObjectFile` links are deleted in `persistObjectMedia()` in `tools/wp-import/src/importer.ts`.
- Archive state is applied only after full run with no `WP_IMPORT_LIMIT`, through `archiveImportedObjectsMissingFromSource()` in `tools/wp-import/src/importer.ts`.
- API active command state is an in-memory `activeCommand` in `apps/api/src/wordpress-import/wordpress-import.service.ts`; it prevents concurrent WP preview/run in the same API process.
- Frontend state is in `apps/web/src/admin/ImportAdminPage.tsx`: report list, selected report, mode/status filters, pagination, running mode, error and notice.

### WordPress repair state and logic

- Repair state is CLI-only and starts from `executeRepair(mode)` in `tools/wp-import/src/repair.ts`.
- Repair preview calculates location candidates and developer alias plans but does not write because writes are guarded by `if (mode === 'run')` in `tools/wp-import/src/repair.ts`.
- Location repair state finds objects whose current primary location is `area` and a linked location is `district`, then updates `RealEstateObject.primaryLocationId` and `ObjectLocation.isPrimary` in `tools/wp-import/src/repair.ts`.
- Developer repair state loads alias groups through `tools/wp-import/src/developer-aliases.ts`, chooses a target developer, moves objects from duplicates, deletes empty duplicate developers, renames target and updates `normalizedName` in `tools/wp-import/src/repair.ts`.
- Repair does not update `ImportReport`, has no admin UI and has no HTTP endpoint in `apps/api/src/wordpress-import/wordpress-import.controller.ts`.

### Feed import state and logic

- Feed source state is stored in `FeedSource` and `FeedSourceMapping` in `apps/api/prisma/schema.prisma` and serialized by `apps/api/src/feeds/feeds.service.ts`.
- Feed admin frontend state lives in `apps/web/src/admin/FeedsAdminPage.tsx`: sources, directories, objects, source form, analysis, selected source, runs, selected run, units, pagination, running/stopping flags and notices.
- Analyze state is transient: `apps/api/src/feeds/feeds.service.ts` writes an uploaded XML file to a temp dir if needed, runs `@platforma/feed-import analyze`, reads JSON output, then removes the temp dir.
- Parser state is normalized into `NormalizedFeedUnit[]` and warnings by format-specific parsers in `tools/feed-import/src/index.ts`.
- Routing state is controlled by source-level filter/mappings: if active mappings exist, `routeFeedUnitsForSource()` routes units by mapping filters; otherwise it routes filtered units to `FeedSource.objectId` in `tools/feed-import/src/index.ts`.
- Feed preview creates a `FeedImportRun`, parses/routes units and builds a plan, but skips `persistFeedImportRun()` because persistence is guarded by `options.mode === 'run'` in `tools/feed-import/src/index.ts`.
- Feed run state is queued by `apps/api/src/feeds/feeds.service.ts`: `POST /feeds/sources/:id/run` creates a pending run, writes queued progress and returns immediately.
- Feed run process state is detached when `runId` is provided to `runFeedImportCli()` in `apps/api/src/feeds/feeds.service.ts`; active child processes are tracked by run id in memory.
- Feed run progress state is stored in `FeedImportRun.summaryJson.progress` by `apps/api/src/feeds/feeds.service.ts` and `tools/feed-import/src/index.ts`.
- Feed polling state is in `apps/web/src/admin/FeedsAdminPage.tsx`; selected pending runs are polled through `GET /feeds/runs/:id` every 2000 ms.
- Feed run persistence upserts `FeedUnit`, syncs residential/commercial details, syncs media links, archives missing units and refreshes object feed aggregates in `tools/feed-import/src/index.ts`.
- Feed media state is deduped by `FeedMediaAsset.sourceUrl`; failed media URLs are cached per run and become warnings in `tools/feed-import/src/index.ts`.
- Feed FILE source state depends on `FeedSource.xmlFileId -> File.key` and `FeedImportStorage.getObject()` in `tools/feed-import/src/storage.ts`.

### Import logic breakage points

- Preview/run naming must stay aligned across root scripts in `package.json`, package scripts in `tools/wp-import/package.json` / `tools/feed-import/package.json`, API shell arguments in `apps/api/src/wordpress-import/wordpress-import.service.ts` / `apps/api/src/feeds/feeds.service.ts`, and CLI parsers in `tools/wp-import/src/index.ts` / `tools/feed-import/src/index.ts`.
- WP manual override preservation depends on object update audit metadata shape from `apps/api/src/objects/objects.service.ts` and reader logic in `tools/wp-import/src/importer.ts`.
- Feed source mappings depend on analysis filter keys generated in `tools/feed-import/src/index.ts`, frontend suggestions in `apps/web/src/admin/feedSourceMatching.ts` and backend validation in `apps/api/src/feeds/feeds.service.ts`.
- Import UI stale state is possible because WordPress commands are long-running synchronous API calls, while feed run returns a pending run and relies on polling in `apps/web/src/admin/FeedsAdminPage.tsx`.
