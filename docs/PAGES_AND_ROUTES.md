# Pages and Routes

Дата индексации: 2026-06-01.

Главный frontend router находится в `apps/web/src/App.tsx`. API client и refresh retry находятся в `apps/web/src/admin/api.ts`. Auth state и frontend permission checks находятся в `apps/web/src/auth/AuthProvider.tsx`.

## Route map

| Route | Entry component | Дочерние компоненты/зоны | Permissions | API consumers | Query params | States | Риски |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/login` | `LoginPage` в `apps/web/src/App.tsx` | Login/register forms, password-at-registration, activation token verify | Нет; если user уже есть, router ведет дальше | `POST /auth/login`, `POST /auth/register/request`, `POST /auth/register/verify` через `apps/web/src/admin/api.ts` | `auth_token` | loading/submitting, error, notice | Password policy продублирован в `apps/web/src/App.tsx` и `apps/api/src/auth/auth.controller.ts`; refresh cookies зависят от `apps/api/src/auth/cookies.ts` |
| `/cabinet` | `CabinetHome` в `apps/web/src/App.tsx` | Profile, password, profile photo, section links, `ProfileAvatar`, `SecureProfileImage` | Authenticated user | `PATCH /users/me`, `PATCH /users/me/password`, `POST /users/me/profile-photo`, media image URL from `apps/web/src/files/SecureImage.tsx` | Нет | submitting, error, notice | Media photo зависит от media cookie и `apps/api/src/files/media.controller.ts`; permissions filter скрывает links |
| `/catalog` | `CatalogPage` в `apps/web/src/catalog/CatalogPage.tsx` | `CatalogQuickLinks`, filters, sort bar, card/list view | `objects:read` in `apps/web/src/App.tsx`; backend `GET /objects` also requires `objects:read` | `GET /objects`, `GET /catalog-links`, `GET /developers`, `GET /locations`, `GET /metro` | `search`, `developerId`, `krtName`, `locationId`, `areaId`, `metroStationId`, `completionYear`, `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax`, `sortBy`, `sortDirection`, `page`, `limit`, `view=list` | initial loading, load more loading, directories loading/error, catalog links loading/error, empty, API error | Query params являются источником правды; lot filters меняют backend filtering in `apps/api/src/objects/objects.service.ts`; catalog cards зависят от shared `RealEstateObjectSummary` |
| `/catalog/map` | `CatalogPage` в `apps/web/src/catalog/CatalogPage.tsx` with map mode | `CatalogMapView`, `YandexMap`, map overlay, selected object card | `objects:read`; backend `GET /map/objects` requires `objects:read` | `GET /map/objects`, plus same directories/links as `/catalog` | Same as `/catalog`, route itself encodes map view; `hasCoordinates=false` branch exists in component state but not serialized by current UI | map loading, map error, empty/no coordinates, directories/catalog links states | Map endpoint must stay compatible with filters; `YandexMap` loads JS API with optional `VITE_YANDEX_MAPS_API_KEY`; no-key behavior depends on external Yandex API |
| `/objects/:slug` | `ObjectDetailPage` in `apps/web/src/objects/ObjectDetailPage.tsx` | `ObjectDetail`, `ObjectImageCarousel`, `ObjectFeedUnitsSection`, `YandexMap`, file buttons, location/content sections | `objects:read`; edit link only when `admin:access` and `objects:update` | `GET /objects/slug/:slug`, `GET /objects/:id/feed-units`, file/media content URLs | No route query for object itself. Initial lot filters are read from `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax` if present in current URL | object loading/error/not found, gallery empty, files empty, feed units loading/error/empty, map empty coordinates | Detail page depends on full `RealEstateObjectDetail`; catalog carries lot filters into detail links; secure file/media access depends on `apps/web/src/files/SecureImage.tsx` and backend media token |
| `/admin` | `AdminHome` in `apps/web/src/App.tsx` | Admin cards/links filtered by permissions | `admin:access` | Нет direct API in component | Нет | denied via `AccessDenied` | Frontend links must match routes and backend permissions in `apps/api/src/prisma/seed.ts` |
| `/admin/users` | `UsersAdminPage` in `apps/web/src/admin/UsersAdminPage.tsx` | Users table, filters, create/edit modal, activation/deactivation | Route requires `admin:access` and `users:read`; actions require `users:create`, `users:update`, `users:delete` | `GET /users/roles`, `GET /users`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/activate`, `POST /users/:id/deactivate` | `search`, `status`, `roleId`, `page` are component state, not router source of truth | loading, submitting, empty, error, notice, confirm deactivate | Changing roles/status clears sessions in `apps/api/src/users/users.service.ts`; current user deactivation is guarded in UI and backend behavior needs care |
| `/admin/objects` | `ObjectsAdminPage` in `apps/web/src/admin/ObjectsAdminPage.tsx` | `ObjectQuickEditTable`, filters, pagination, quick edit | Route requires `admin:access` and `objects:read`; quick actions use `objects:update` or `objects:publish` | `GET /objects`, `GET /developers`, `GET /locations`, `GET /metro`, quick edit `PATCH /objects/:id`, `PATCH /objects/:id/status` | Search/status/district/area/metro/sort/page are component state | loading, empty, error, notice, per-cell saving | Quick edit transforms in `apps/web/src/admin/objectQuickEditTransforms.ts` must match backend validators in `apps/api/src/objects/objects.service.ts` |
| `/admin/objects/new` | `ObjectsAdminPage` create mode in `apps/web/src/admin/ObjectsAdminPage.tsx` | Object form, directory selects, linked files, gallery draft modal | Route requires `admin:access` and `objects:read`; create action requires `objects:create`; uploads require `files:upload` plus update permissions in component | `POST /objects`, `POST /objects/:id/files`, `POST /objects/:id/gallery/stream`, `PATCH /objects/:id/gallery/batch`, directories endpoints | None | form validation, submitting, upload errors, gallery staged/draft states | Create mode may create object before file/gallery persistence; failure cleanup depends on `DELETE /files/:fileId` and `files:delete` |
| `/admin/objects/:id/edit` | `ObjectsAdminPage` edit mode in `apps/web/src/admin/ObjectsAdminPage.tsx` | Same form/gallery/files editor | Route requires `admin:access` and `objects:read`; save requires `objects:update`; publish requires `objects:publish`; uploads/delete require files permissions | `GET /objects/:id`, `PATCH /objects/:id`, `POST /objects/:id/publish`, files/gallery endpoints | None | detail loading/error, validation, submitting, publish errors, gallery errors | Published object required fields are protected by backend lifecycle in `apps/api/src/objects/objects.service.ts`; gallery batch is fragile |
| `/admin/import` | `ImportAdminPage` in `apps/web/src/admin/ImportAdminPage.tsx` | Reports table, selected report, preview/run buttons | Route requires `admin:access` and `import:preview`; run action needs `import:run` | `GET /wordpress-import/reports`, `GET /wordpress-import/reports/:id`, `POST /wordpress-import/preview`, `POST /wordpress-import/run` | mode/status/page are component state | reports loading, running mode, empty, error, notice | Backend runs shell command with one active lock in `apps/api/src/wordpress-import/wordpress-import.service.ts`; report shape comes from `ImportReport` |
| `/admin/catalog-links` | `CatalogLinksAdminPage` in `apps/web/src/admin/CatalogLinksAdminPage.tsx` | Developer/KRT/Sales start columns, object/developer lookups | Route requires `admin:access` and `objects:update`; backend same for admin endpoints | `GET /catalog-links/admin`, `PUT /catalog-links/admin`, `GET /developers`, paginated `GET /objects?status=PUBLISHED` | None | loading, saving, empty, validation errors, notice | Public links rely on target validity in `apps/api/src/catalog-links/catalog-links.service.ts`; sales links depend on object slug |

## Existing adjacent routes

These routes exist in code but were outside the mandatory route checklist:

| Route | Entry component | Подтверждение |
| --- | --- | --- |
| `/objects/:slug/lots/:unitId` | `ObjectLotDetailPage` | `apps/web/src/App.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx` |
| `/admin/feeds` | `FeedsAdminPage` | `apps/web/src/App.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx` |
| `/admin/feeds/new` | `FeedsAdminPage` create mode | `apps/web/src/App.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx` |
| `/admin/feeds/:id/edit` | `FeedsAdminPage` edit mode | `apps/web/src/App.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx` |

## Permission source

Frontend checks: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`.

Backend checks: `apps/api/src/auth/jwt-auth.guard.ts`, `apps/api/src/auth/permissions.guard.ts`, `apps/api/src/auth/permissions.decorator.ts`, controllers in `apps/api/src`.

Seeded permission names and role defaults: `apps/api/prisma/seed.ts`.

## Loading/empty/error/denied patterns

- Global initial auth loading uses `Загрузка` shell in `apps/web/src/App.tsx`.
- Denied routes use `AccessDenied` in `apps/web/src/App.tsx`.
- Catalog/list/map states live in `apps/web/src/catalog/CatalogPage.tsx`.
- Object/detail/lot states live in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Admin empty/error/loading states use local components and `AdminEmptyState` patterns in `apps/web/src/admin`.

## Deep frontend index

Дата углубленного frontend-индекса: 2026-06-01.

Сканировался `apps/web` полностью, кроме `dist` и `node_modules`. Найдено 39 frontend source-файлов `.ts`, `.tsx`, `.css` в `apps/web/src`, подтверждено `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/admin`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css`.

### Entry and routing

- Main entry: `apps/web/src/main.tsx` вызывает `initAppTheme()` из `apps/web/src/appTheme.ts`, затем монтирует `<App />` через `createRoot(...).render(<StrictMode><App /></StrictMode>)`.
- App composition root: `apps/web/src/App.tsx` импортирует глобальные стили `apps/web/src/styles.css` и `apps/web/src/app-theme.css`, оборачивает routes в `AuthProvider` из `apps/web/src/auth/AuthProvider.tsx`.
- Client routing ручной: `usePathname()` в `apps/web/src/App.tsx` хранит `window.location.pathname`, слушает `popstate`, перехватывает внутренние `<a href>` через `document.addEventListener('click', ...)`, проверяет путь через `isAppRoute()`, затем делает `window.history.pushState(...)`.
- Programmatic navigation ручной: `navigate(nextPathname)` в `apps/web/src/App.tsx` делает `window.history.pushState(null, '', nextPathname)` и обновляет local state.
- App routes whitelist: `isAppRoute()` в `apps/web/src/App.tsx` пропускает `/`, `/login`, `/cabinet`, `/catalog`, `/catalog/*`, `/admin`, `/admin/*`, `/objects/*`.
- Login redirect: если `pathname === '/login'`, `AppRoutes` показывает `LoginPage` и после успеха ведет на `/cabinet`; если пользователя нет и путь не `/login`, показывается `LoginPage`, а после успеха путь сохраняется, кроме `/`, который ведет на `/cabinet`. Подтверждение: `apps/web/src/App.tsx`.
- Access denied: `AccessDenied` определен в `apps/web/src/App.tsx`; используется при нехватке `admin:access`, `users:read`, `objects:read`, `objects:update`, `feeds:read`, `import:preview`.
- Frontend permissions source: `user.permissions` из `AuthProvider` в `apps/web/src/auth/AuthProvider.tsx`; `hasPermission(permission)` проверяет `user?.permissions.includes(permission)`.
- Top nav permissions: `navItems` в `apps/web/src/App.tsx` скрывает `/catalog` без `objects:read` и `/admin` без `admin:access`; `/cabinet` доступен authenticated user.
- Cabinet section permissions: `cabinetSections` в `apps/web/src/App.tsx` показывает ссылки на `/catalog`, `/catalog/map`, `/admin/objects`, `/admin/users`, `/admin/catalog-links`, `/admin/feeds`, `/admin/import` только при нужных permissions.

### Routes tied to `App.tsx`

Все основные SPA routes завязаны на ручные условия в `apps/web/src/App.tsx`; добавление нового frontend route требует изменения `isAppRoute()`, active section logic и render branch.

| Route | Где выбирается в `App.tsx` | Component | Permission gate |
| --- | --- | --- | --- |
| `/login` | `pathname === '/login'` | `LoginPage` in `apps/web/src/App.tsx` | none |
| `/` | unauthenticated redirect target logic; authenticated falls to cabinet branch | `CabinetHome` in `apps/web/src/App.tsx` | authenticated |
| `/cabinet` | default non-admin/non-catalog branch | `CabinetHome` in `apps/web/src/App.tsx` | authenticated |
| `/catalog` | `activeSection === 'catalog'` | `CatalogPage` in `apps/web/src/catalog/CatalogPage.tsx` | `objects:read` |
| `/catalog/map` | `activeSection === 'catalog'`; `CatalogPage` reads `pathname` | `CatalogPage` map mode in `apps/web/src/catalog/CatalogPage.tsx` | `objects:read` |
| `/objects/:slug` | `parseObjectSlug(pathname)` | `ObjectDetailPage` in `apps/web/src/objects/ObjectDetailPage.tsx` | `objects:read` |
| `/objects/:slug/lots/:unitId` | `parseObjectLotRoute(pathname)` | `ObjectLotDetailPage` in `apps/web/src/objects/ObjectDetailPage.tsx` | `objects:read` |
| `/admin` | `activeSection === 'admin'` fallback | `AdminHome` in `apps/web/src/App.tsx` | `admin:access` |
| `/admin/users` | `pathname.startsWith('/admin/users')` | `UsersAdminPage` in `apps/web/src/admin/UsersAdminPage.tsx` | `admin:access`, `users:read` |
| `/admin/objects` | `pathname.startsWith('/admin/objects')` | `ObjectsAdminPage` in `apps/web/src/admin/ObjectsAdminPage.tsx` | `admin:access`, `objects:read` |
| `/admin/objects/new` | same branch, parsed inside `ObjectsAdminPage` | `ObjectsAdminPage` create mode | route `objects:read`; action `objects:create` |
| `/admin/objects/:id/edit` | same branch, parsed inside `ObjectsAdminPage` | `ObjectsAdminPage` edit mode | route `objects:read`; save `objects:update`; publish `objects:publish` |
| `/admin/catalog-links` | `pathname.startsWith('/admin/catalog-links')` | `CatalogLinksAdminPage` in `apps/web/src/admin/CatalogLinksAdminPage.tsx` | `admin:access`, `objects:update` |
| `/admin/feeds` | `pathname.startsWith('/admin/feeds')` | `FeedsAdminPage` in `apps/web/src/admin/FeedsAdminPage.tsx` | `admin:access`, `feeds:read` |
| `/admin/feeds/new` | same branch, parsed inside `FeedsAdminPage` | `FeedsAdminPage` create mode | route `feeds:read`; actions `feeds:manage`, `feeds:run` |
| `/admin/feeds/:id/edit` | same branch, parsed inside `FeedsAdminPage` | `FeedsAdminPage` edit mode | route `feeds:read`; actions `feeds:manage`, `feeds:run` |
| `/admin/import` | `pathname.startsWith('/admin/import')` | `ImportAdminPage` in `apps/web/src/admin/ImportAdminPage.tsx` | `admin:access`, `import:preview`; run action `import:run` |

### Auth and cabinet

- Auth state: `accessToken`, `user`, `isLoading` live in `apps/web/src/auth/AuthProvider.tsx`.
- Initial refresh/me equivalent: on mount `AuthProvider` calls `POST /auth/refresh` with `credentials: 'include'`; separate frontend `GET /auth/me` consumer was not found in `apps/web/src`, although endpoint is documented in backend docs.
- Login: `login(email, password)` in `apps/web/src/auth/AuthProvider.tsx` calls `POST /auth/login`, stores `AuthResponse`, updates `apiRequest` token via `setApiAccessToken`.
- Logout: `logout()` in `apps/web/src/auth/AuthProvider.tsx` calls `POST /auth/logout` with credentials and clears frontend auth state.
- Registration: `LoginPage` in `apps/web/src/App.tsx` collects email/password/confirmation before `requestEmailRegistration()`, then activation uses `auth_token` from the email link through `verifyEmailRegistration()` in `apps/web/src/auth/AuthProvider.tsx`.
- API refresh retry: `apiRequest()` in `apps/web/src/admin/api.ts` retries once after `401` by calling `POST /auth/refresh`, updates global token, dispatches `platforma-auth-updated`; failed refresh dispatches `platforma-auth-cleared`.
- Profile update: `CabinetHome` in `apps/web/src/App.tsx` sends `PATCH /users/me` and updates `AuthProvider` user via `updateUser`.
- Profile photo upload: `CabinetHome` sends `POST /users/me/profile-photo` with `FormData`; display uses `ProfileAvatar` and `SecureProfileImage` in `apps/web/src/App.tsx`, with media URL from `buildMediaFileContentUrl()` in `apps/web/src/files/SecureImage.tsx`.
- Password change: `CabinetHome` sends `PATCH /users/me/password`; frontend only checks repeated new password equality, backend policy lives outside frontend.
- Permissions display: cabinet expands `cabinetSections`, renders `permission-chip-list` from `apps/web/src/App.tsx`; admin users role permissions display is in `apps/web/src/admin/UsersAdminPage.tsx`.
- Auth/cabinet risks: session correctness depends on `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`, backend cookies in `apps/api/src/auth/cookies.ts`, CORS in `apps/api/src/main.ts`, media guards in `apps/api/src/auth/media-token.guard.ts`, and image URLs in `apps/web/src/files/SecureImage.tsx`.

### Catalog

- Catalog entry: `/catalog` renders `CatalogPage` from `apps/web/src/catalog/CatalogPage.tsx` through `App.tsx` gate `objects:read`.
- View modes: `parseCatalogViewMode()` in `apps/web/src/catalog/CatalogPage.tsx` reads `view=list`; default is cards. `CatalogViewActions` toggles card/list mode and navigates to `/catalog/map`.
- Filters: `CatalogFilters` in `apps/web/src/catalog/CatalogPage.tsx` handles `search`, `developerId`, `locationId`, `areaId`, `metroStationId`, `completionYear`, `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax`.
- Query params source of truth: `parseCatalogFilters()` and `buildCatalogQuery()` in `apps/web/src/catalog/CatalogPage.tsx` serialize public catalog state; `completionQuarter`, `status`, `hasPresentation`, `hasCoordinates` are in internal filter type but not serialized by current public catalog UI.
- Pagination: `CatalogListView` in `apps/web/src/catalog/CatalogPage.tsx` supports `page`, `limit` values `25`, `50`, `75`, previous/next select, and "Показать еще"; API path is `GET /objects`.
- Sort: `CatalogSortBar` in `apps/web/src/catalog/CatalogPage.tsx` supports `createdAt`, `priceFrom`, `pricePerMeterFrom`, `completionDate` with `asc`/`desc`.
- Quick links: `CatalogQuickLinks` in `apps/web/src/catalog/CatalogPage.tsx` loads `GET /catalog-links`, groups `DEVELOPER`, `KRT`, `SALES_START`; developer/KRT links rewrite `/catalog` query, sales links open `/objects/:slug`.
- Directories: `CatalogPage` loads `GET /developers?limit=500`, `GET /locations?type=DISTRICT&limit=500`, `GET /locations?type=AREA&limit=500`, `GET /metro?limit=500`.
- Object links: cards/list items use `buildCatalogObjectHref()` in `apps/web/src/catalog/CatalogPage.tsx`; active lot filters are carried into `/objects/:slug` as `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax`.
- Relation to `/objects`: catalog list/card opens object detail route `/objects/:slug`, handled by `ObjectDetailPage` in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Relation to `/catalog/map`: same `CatalogPage` renders map mode when `pathname === '/catalog/map'`; current query string is preserved when switching list/map.
- States: `CatalogPage` has initial loading, load-more loading, directory loading/error, catalog links loading/error, list empty, API error; exact state fields are in `apps/web/src/catalog/CatalogPage.tsx`.
- Catalog risks: URL query names must stay aligned with `GET /objects` parser in `apps/api/src/objects/objects.service.ts` and shared shapes in `packages/shared/src/index.ts`; lot filters rely on feed units and `matchedFeedUnitsCount`.

### Catalog map

- Route: `/catalog/map` uses `CatalogPage` in `apps/web/src/catalog/CatalogPage.tsx`; `isMapView` switches from list API to `loadMapObjects()`.
- API: `loadMapObjects()` calls `GET /map/objects` with `buildObjectsParams(filters, false)`; map mode uses `limit=1000`, sort params and same public filters as catalog.
- Yandex map: `YandexMap` in `apps/web/src/map/YandexMap.tsx` loads `https://api-maps.yandex.ru/2.1/?lang=ru_RU` and adds `apikey` only when `VITE_YANDEX_MAPS_API_KEY` is non-empty.
- No-key mode: if `apps/web/.env.example`/runtime env leaves `VITE_YANDEX_MAPS_API_KEY` empty, `YandexMap` still appends only `lang=ru_RU`; behavior depends on external Yandex JS API availability.
- Markers: `mapObjectToPoint()` in `apps/web/src/catalog/CatalogPage.tsx` creates `YandexMapPoint`; label is resolved by `resolveMapMarkerLabel()` in `apps/web/src/map/mapMarkerLabels.ts`; custom marker HTML is created in `apps/web/src/map/YandexMap.tsx`.
- Clusters: no clusterer implementation was found in `apps/web/src/map/YandexMap.tsx`; all points are added as individual `ymaps.Placemark`.
- Balloons/popups: `buildMapBalloon()` in `apps/web/src/catalog/CatalogPage.tsx` builds HTML for Yandex balloon content, but markers set `openBalloonOnClick: false`; click selects object and opens React `MapObjectCard`.
- Selected object: `CatalogMapView` in `apps/web/src/catalog/CatalogPage.tsx` tracks `selectedObjectId`; selected marker gets `map-price-marker--selected` class in `apps/web/src/map/YandexMap.tsx`; details render in `MapObjectCard`.
- List overlay: `CatalogMapView` renders `catalog-map-list` inside map overlay portal when points exist; filters visible objects by current map bounds from `onBoundsChange`.
- Empty/no coordinates: `filters.hasCoordinates === 'false'` returns a content panel; empty `points` shows `map-fallback` from `YandexMap`.
- Map risks: protected model from `rules/frontend.md` includes map, placeholders, balloons, list beside/over map; changes require manual QA of `/catalog/map`, selected card, marker labels, no-key behavior, fullscreen and list overlay.

### Object detail

- Route: `/objects/:slug` is parsed by `parseObjectSlug()` in `apps/web/src/App.tsx` and renders `ObjectDetailPage` from `apps/web/src/objects/ObjectDetailPage.tsx`.
- Loading: `ObjectDetailPage` calls `GET /objects/slug/:slug`; loading/error/not-found panels are in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Description: `getDescriptionParagraphs()` in `apps/web/src/objects/ObjectDetailPage.tsx` splits `object.description` by blank lines.
- Architecture/infrastructure/filling: `getObjectContentSections()` in `apps/web/src/objects/objectDetailViewModel.ts` maps `architectureDescription`, `infrastructureDescription`, `fillingDescription` into public sections with `Не заполнено` fallback.
- Gallery: `ObjectImageCarousel` in `apps/web/src/objects/ObjectDetailPage.tsx` orders cover image first, supports section filters `ARCHITECTURE`, `INTERIORS`, `FILLING`, thumbnails, lightbox and original download through `buildMediaFileContentUrl()`.
- Files: primary presentation is first `object.files` with `type === 'PRESENTATION'`; additional files render through `FileList`; `layoutsUrl` renders external "Планировки" link. Confirmed in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Map fallback: object map uses `YandexMap`; `getObjectMapPoints()` returns empty array when `latitude` or `longitude` is null, showing object-specific fallback text in `apps/web/src/objects/ObjectDetailPage.tsx`.
- View model: formatting for parameters, location line, content sections, price/completion/ceiling height lives in `apps/web/src/objects/objectDetailViewModel.ts`.
- Lot filters from catalog: `ObjectFeedUnitsSection` reads initial `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax` from `window.location.search` once via `getInitialObjectFeedUnitFiltersFromLocation()` in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Related route: `/objects/:slug/lots/:unitId` loads object by slug and lot by `GET /objects/:id/feed-units/:unitId`; component is `ObjectLotDetailPage` in `apps/web/src/objects/ObjectDetailPage.tsx`.
- Object detail risks: full page depends on `RealEstateObjectDetail` shape from `packages/shared/src/index.ts`; media access depends on `apps/web/src/files/SecureImage.tsx` and backend media cookie; feed lot filters depend on imported `FeedUnit` data.

### Admin

- `/admin`: `AdminHome` in `apps/web/src/App.tsx`; cards filtered by `objects:read`, `users:read`, `objects:update`, `feeds:read`, `import:preview`.
- `/admin/users`: `UsersAdminPage` in `apps/web/src/admin/UsersAdminPage.tsx`; loads `GET /users/roles`, `GET /users`; form uses `POST /users`, `PATCH /users/:id`, `POST /users/:id/activate`, `POST /users/:id/deactivate`; local action permissions are `users:create`, `users:update`, `users:delete`.
- `/admin/objects`: `ObjectsAdminPage` in `apps/web/src/admin/ObjectsAdminPage.tsx`; list uses `GET /objects` plus directories, local filters `search`, `status`, `districtSearch`, `areaSearch`, `metroSearch`, pagination and quick edit via `ObjectQuickEditTable`.
- `/admin/objects/new`: create mode parsed in `ObjectsAdminPage`; form validates title, completion year/quarter, URL, content lengths, JSON, coordinates; creates through `POST /objects`; PDF/gallery upload can create object first before media persistence.
- `/admin/objects/:id/edit`: edit mode parsed by UUID regex in `ObjectsAdminPage`; loads `GET /objects/:id`, saves `PATCH /objects/:id`, publishes `POST /objects/:id/publish`, uploads PDFs through `POST /objects/:id/files`, deletes through `DELETE /objects/:id/files/:objectFileId`, gallery stages via `POST /objects/:id/gallery/stream` then saves `PATCH /objects/:id/gallery/batch`.
- `/admin/import`: `ImportAdminPage` in `apps/web/src/admin/ImportAdminPage.tsx`; reports from `GET /wordpress-import/reports`, detail from `GET /wordpress-import/reports/:id`, commands `POST /wordpress-import/preview`, `POST /wordpress-import/run`; route requires `import:preview`, run button requires `import:run`.
- `/admin/catalog-links`: `CatalogLinksAdminPage` in `apps/web/src/admin/CatalogLinksAdminPage.tsx`; loads `GET /catalog-links/admin`, `GET /developers`, published objects from paginated `GET /objects?status=PUBLISHED`; saves `PUT /catalog-links/admin`; validates target by link type.
- `/admin/feeds`: `FeedsAdminPage` in `apps/web/src/admin/FeedsAdminPage.tsx`; route exists beyond requested admin checklist and uses `feeds:read`, `feeds:manage`, `feeds:run`; keep indexed because it is wired in `App.tsx`.
- Admin forms: shared UI wrappers live in `apps/web/src/admin/AdminUi.tsx`; input components are under `apps/web/src/components/ui`.
- Admin upload: profile upload is in `apps/web/src/App.tsx`; object PDF/gallery uploads are in `apps/web/src/admin/ObjectsAdminPage.tsx`; feed XML upload is in `apps/web/src/admin/FeedsAdminPage.tsx`.
- Admin risks: `ObjectsAdminPage` is a large stateful file controlling object lifecycle, upload cleanup and gallery reconciliation; `UsersAdminPage` can change role/status; `CatalogLinksAdminPage` public links depend on target validity; `ImportAdminPage` and `FeedsAdminPage` trigger long-running backend work.

### Styles

- Global CSS entry: `apps/web/src/App.tsx` imports `apps/web/src/styles.css` and `apps/web/src/app-theme.css`; `apps/web/src/main.tsx` initializes `data-app-theme`.
- Theme logic: `apps/web/src/appTheme.ts` supports `minimal-luxury` and `dark-premium`, stores `platforma.theme`, maps query `theme=c` to dark and `theme=d` to light.
- Global classes: app shell and layout are in `apps/web/src/styles.css` with `.app-shell`, `.sidebar`, `.sidebar--open`, `.workspace`, `.page-header`, `.content-panel`.
- Cabinet/login classes: `.login-shell`, `.login-panel`, `.login-form`, `.cabinet-page`, `.profile-avatar`, `.cabinet-section-list`, `.permission-chip-list` in `apps/web/src/styles.css`.
- Catalog classes: `.catalog-page`, `.catalog-filters`, `.catalog-quick-links`, `.catalog-grid`, `.catalog-list`, `.catalog-card`, `.catalog-list-item`, `.catalog-pagination` in `apps/web/src/styles.css`.
- Map classes: `.catalog-map-layout`, `.catalog-map-panel`, `.catalog-map-list`, `.catalog-map-list-toggle`, `.yandex-map-shell`, `.yandex-map`, `.map-price-marker`, `.map-object-card`, `.map-fallback`, `.map-balloon` in `apps/web/src/styles.css`.
- Admin classes: `.admin-users`, `.admin-objects`, `.admin-catalog-links`, `.admin-feeds`, `.admin-import`, `.toolbar`, `.admin-panel`, `.admin-table`, `.object-quick-edit-table`, `.object-form-section`, `.gallery-modal`, `.catalog-links-*` in `apps/web/src/styles.css`.
- Object detail classes: `.object-detail-page`, `.object-detail-header`, `.detail-section`, `.media-gallery-frame`, `.object-image-carousel`, `.carousel-*`, `.object-parameters-grid`, `.object-feed-units-*`, `.object-content-sections` in `apps/web/src/styles.css`.
- Theme override classes: `apps/web/src/app-theme.css` overrides many global selectors under `html[data-app-theme]`, including `.sidebar`, `.content-panel`, `.catalog-page .page-header`, `.catalog-filters`, `.catalog-quick-links`, `.catalog-map-panel`, `.detail-section`, `.gallery-modal`, `.map-object-card`.
- Styles not to change without manual check: `apps/web/src/styles.css` sections for `.workspace:has(...)`, catalog cards/list, `catalog-map-*`, `yandex-map-*`, `map-price-marker-*`, `.object-image-carousel`, `.object-feed-media-*`, `.gallery-modal-*`, `.object-quick-edit-table`, plus all theme overrides in `apps/web/src/app-theme.css`.
