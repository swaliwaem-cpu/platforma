# Codex Log

## 2026-07-07 - Web users admin route CSS splitting

Задача:

- Продолжить безопасный route-level CSS split после catalog/admin/object splits: вынести стили `UsersAdminPage` в lazy route CSS, не трогая незавершённые лоты, `LotPresentationsPage`, shared карту, object/detail flows и theme overrides.

Изменения:

- `apps/web/src/admin/users-admin-route.css` - добавлен route-local CSS slice для `UsersAdminPage`: `.admin-users`, users toolbar/layout/table columns, deactivated row state, user form, role permissions panel, role permission chips, deactivation confirm и users mobile rules.
- `apps/web/src/admin/UsersAdminPage.tsx` - добавлен lazy route CSS import `./users-admin-route.css`.
- `apps/web/src/styles.css` - удалены вынесенные users-only selectors; global/shared стили оставлены: `.workspace:has(.admin-users)`, shell/sidebar, generic toolbar/table/panel/status/form styles, base `.role-pill`, base `.permission-chip`, `panel-count`, shared map/object/detail/lots/presentations styles.
- `apps/web/tests/users-admin-route-css-splitting.test.mjs` - добавлена regression-проверка отдельного users route CSS, отсутствия root/object/presentations imports, отсутствия users selectors в `styles.css` и protected shared selectors в route CSS.
- `apps/web/tests/admin-route-css-splitting.test.mjs` - добавлен guard, что общий admin route CSS не содержит users-admin selectors.

Проверки:

- RED: `cd apps/web && node --test tests/users-admin-route-css-splitting.test.mjs` сначала падал на отсутствующем `users-admin-route.css`/import и users selectors в глобальном `styles.css`.
- `cd apps/web && node --test tests/users-admin-route-css-splitting.test.mjs tests/objects-admin-route-css-splitting.test.mjs tests/admin-route-css-splitting.test.mjs tests/app-route-code-splitting.test.mjs tests/app-theme.test.mjs tests/sidebar-outside-click.test.mjs tests/sidebar-navigation.test.mjs tests/secure-image-variants.test.mjs tests/lot-presentations-page.test.mjs`
- `pnpm --filter @platforma/web test`
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --filter @platforma/web build`
- `git diff --check`
- В build output CSS разделён на `dist/assets/index-CHaWrkID.css` (`161.52 kB`), `dist/assets/UsersAdminPage-CK2Ipv1u.css` (`3.68 kB`), `dist/assets/CatalogPage-CQJlh0Xx.css` (`30.83 kB`), `dist/assets/admin-route-pages-BgFmrFRd.css` (`13.89 kB`) и `dist/assets/ObjectsAdminPage-GQ5zloYi.css` (`17.76 kB`).
- В `/tmp/platforma-web-users-css-split-build.log` строка `Some chunks are larger than 500 kB` не найдена.

Ручная проверка:

- Перед приёмкой открыть `/admin/users` и проверить list/table, filters, create/edit form, role permissions panel, deactivation confirmation.
- Проверить `/admin/users` в обеих темах и mobile width около `760px`.
- Smoke-check shared routes: `/cabinet`, `/admin/objects`, `/admin/catalog-links`, `/admin/feeds`, `/admin/import`, `/catalog`, `/catalog/map`, `/objects/:slug`, `/objects/:slug/lots/:unitId`, `/presentations`.
- `LotPresentationsPage` и лоты в этом шаге не менялись и не импортируют users route CSS.

## 2026-07-05 - Web catalog route CSS splitting

Задача:

- Продолжить безопасный route-level CSS split для Vite chunk warning: вынести стили публичного `CatalogPage` в lazy route CSS, не трогая незавершённые лоты и `LotPresentationsPage`.

Изменения:

- `apps/web/src/catalog/catalog-route.css` - добавлен route-local CSS slice для `CatalogPage`: root/header/view controls, filters, sort, quick links, grid/list/cards, pagination, catalog map overlay/list и route-owned `.map-object-card`.
- `apps/web/src/catalog/CatalogPage.tsx` - добавлен lazy route CSS import `./catalog-route.css`.
- `apps/web/src/styles.css` - удалены вынесенные catalog selectors; global shell/shared стили оставлены: `.workspace:has(.catalog-page)`, `:root --catalog-*`, `multi-select-dropdown`, `panel-count`, `YandexMap`, markers, fallback, balloon, object/detail/lots/presentations/admin styles.
- `apps/web/tests/catalog-route-css-splitting.test.mjs` - добавлена regression-проверка отдельного catalog route CSS, отсутствия root/object/presentations imports, отсутствия catalog selectors в `styles.css` и protected shared selectors в route CSS.
- `apps/web/tests/catalog-quick-links-page.test.mjs`, `apps/web/tests/catalog-pagination-controls.test.mjs`, `apps/web/tests/catalog-lot-filters.test.mjs`, `apps/web/tests/catalog-card-badges.test.mjs`, `apps/web/tests/yandex-map-markers.test.mjs` - source-based style checks теперь читают базовый и catalog route CSS.

Проверки:

- RED: `cd apps/web && node --test tests/catalog-route-css-splitting.test.mjs` сначала падал на отсутствующем `catalog-route.css`/import и catalog selectors в глобальном `styles.css`.
- `cd apps/web && node --test tests/catalog-route-css-splitting.test.mjs tests/catalog-quick-links-page.test.mjs tests/catalog-pagination-controls.test.mjs tests/catalog-lot-filters.test.mjs tests/catalog-card-badges.test.mjs tests/yandex-map-markers.test.mjs tests/app-route-code-splitting.test.mjs tests/object-detail-styles.test.mjs tests/object-lot-detail-page.test.mjs tests/lot-presentations-page.test.mjs`
- `pnpm --filter @platforma/web test`
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --filter @platforma/web build`
- `git diff --check`
- В build output CSS разделён на `dist/assets/index-BsUWvFJc.css` (`164.87 kB`), `dist/assets/CatalogPage-CQJlh0Xx.css` (`30.83 kB`), `dist/assets/admin-route-pages-BgFmrFRd.css` (`13.89 kB`) и `dist/assets/ObjectsAdminPage-GQ5zloYi.css` (`17.76 kB`).
- В `/tmp/platforma-web-catalog-css-split-build.log` строка `Some chunks are larger than 500 kB` не найдена.

Ручная проверка:

- Перед приёмкой открыть `/catalog`, `/catalog?view=list`, `/catalog/map` и проверить filters/sort/quick links/cards/list/pagination/map overlay/selected map card.
- Smoke-check shared routes: `/objects/:slug` с картой, `/objects/:slug/lots/:unitId`, `/presentations`, `/admin/objects`, `/admin/catalog-links`, `/admin/feeds`, `/admin/import`.
- Проверить темы `minimal-luxury` и `dark-premium`, а также mobile widths около `980px`, `760px`, `700px`.
- `LotPresentationsPage` и лоты в этом шаге не менялись и не импортируют catalog route CSS.

## 2026-07-05 - Web objects admin route CSS splitting

Задача:

- Продолжить route-level CSS split для Vite chunk warning: вынести стили `ObjectsAdminPage` в отдельный lazy route CSS, не трогая незавершённые лоты и `LotPresentationsPage`.

Изменения:

- `apps/web/src/admin/objects-admin-route.css` - добавлен route-local CSS slice для `ObjectsAdminPage`: root layout `.admin-objects`, quick edit table, object editor/form/preview, media upload, file list, gallery modal/tile grid и object-specific responsive rules.
- `apps/web/src/admin/ObjectsAdminPage.tsx` - добавлен lazy route CSS import `./objects-admin-route.css`.
- `apps/web/src/styles.css` - удалены вынесенные object-admin selectors; global shell/shared стили оставлены: `.workspace:has(.admin-objects)`, `admin-ui`, `searchable-multi-select`, `multi-select-dropdown`, `panel-count`, public catalog/object/detail/lots/presentations styles.
- `apps/web/tests/objects-admin-route-css-splitting.test.mjs` - добавлена regression-проверка отдельного object route CSS, отсутствия root/presentations imports, отсутствия object selectors в `styles.css` и protected selectors в route CSS.
- `apps/web/tests/admin-object-quick-edit-table.test.mjs`, `apps/web/tests/admin-gallery-styles.test.mjs`, `apps/web/tests/admin-file-list-styles.test.mjs` - source-based style checks теперь читают базовый и object route CSS.

Проверки:

- RED: `cd apps/web && node --test tests/objects-admin-route-css-splitting.test.mjs` сначала падал на отсутствующем `objects-admin-route.css`/import и object selectors в глобальном `styles.css`.
- `cd apps/web && node --test tests/objects-admin-route-css-splitting.test.mjs tests/admin-object-quick-edit-table.test.mjs tests/admin-gallery-styles.test.mjs tests/admin-file-list-styles.test.mjs tests/admin-gallery-state.test.mjs tests/admin-object-file-upload.test.mjs tests/admin-object-create-route.test.mjs tests/admin-object-location-search-selects.test.mjs tests/app-route-code-splitting.test.mjs tests/lot-presentations-page.test.mjs`
- `pnpm --filter @platforma/web test`
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --filter @platforma/web build`
- `git diff --check`
- В build output CSS разделён на `dist/assets/index-DTrPdpdi.css` (`201.05 kB`), `dist/assets/admin-route-pages-BgFmrFRd.css` (`13.89 kB`) и `dist/assets/ObjectsAdminPage-GQ5zloYi.css` (`17.76 kB`).
- В `/tmp/platforma-web-objects-css-split-build.log` строка `Some chunks are larger than 500 kB` не найдена.

Ручная проверка:

- Перед приёмкой открыть `/admin/objects`, `/admin/objects/new`, `/admin/objects/:id/edit` и проверить quick edit table, create-before-upload flow, gallery modal, PDF upload/delete, mobile layout.
- Smoke-check shared/public routes: `/admin/catalog-links`, `/admin/feeds`, `/admin/import`, `/catalog`, `/catalog?view=list`, `/catalog/map`, `/objects/:slug`, `/objects/:slug/lots/:unitId`, `/presentations`.
- `LotPresentationsPage` и лоты в этом шаге не менялись и не импортируют object route CSS.

## 2026-07-05 - Web admin route CSS splitting

Задача:

- Сделать отдельный безопасный CSS route-level split для ленивых admin routes после Vite code-splitting шага, не трогая незавершённые лоты и `LotPresentationsPage`.

Изменения:

- `apps/web/src/admin/admin-route-pages.css` - вынесен первый безопасный route-local CSS slice для `CatalogLinksAdminPage`, `FeedsAdminPage`, `ImportAdminPage`: catalog links, feed source/editor/import/progress/status styles.
- `apps/web/src/admin/CatalogLinksAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/ImportAdminPage.tsx` - добавлен lazy route CSS import `./admin-route-pages.css`.
- `apps/web/src/styles.css` - удалён вынесенный admin-only slice; глобальные shell/theme, object/detail/catalog/map/lots/presentations styles оставлены в основном stylesheet.
- `apps/web/tests/admin-route-css-splitting.test.mjs` - добавлена regression-проверка: `App.tsx` сохраняет глобальные CSS imports, admin lazy pages импортируют route CSS, `LotPresentationsPage` его не импортирует, protected selectors не попали в route CSS.
- `apps/web/tests/admin-feeds-page.test.mjs` - source-based feed style check теперь читает базовый и route-local CSS.
- `apps/web/tests/object-detail-styles.test.mjs` - source-based проверка приведена к существующей группировке object-detail CSS, где общие grid-свойства и per-grid columns находятся в отдельных правилах.

Проверки:

- RED: `cd apps/web && node --test tests/admin-route-css-splitting.test.mjs` сначала падал на отсутствующем route CSS file/import и на admin selectors в глобальном `styles.css`.
- `cd apps/web && node --test tests/admin-route-css-splitting.test.mjs tests/admin-feeds-page.test.mjs tests/admin-catalog-links-page.test.mjs tests/admin-catalog-links-route.test.mjs tests/admin-feeds-route.test.mjs tests/app-route-code-splitting.test.mjs tests/lot-presentations-page.test.mjs`
- `cd apps/web && node --test tests/object-detail-styles.test.mjs tests/admin-route-css-splitting.test.mjs`
- `pnpm --filter @platforma/web test`
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --filter @platforma/web build`
- `git diff --check`
- В build output CSS разделён на `dist/assets/index-CM242Zg1.css` (`218.43 kB`) и `dist/assets/admin-route-pages-BgFmrFRd.css` (`13.89 kB`).
- В `/tmp/platforma-web-css-split-build.log` строка `Some chunks are larger than 500 kB` не найдена.

Ручная проверка:

- Перед приёмкой открыть `/admin/catalog-links`, `/admin/feeds`, `/admin/feeds/new`, `/admin/feeds/:id/edit`, `/admin/import` и проверить layout/form/table/progress states.
- Smoke-check после CSS split: `/admin`, `/catalog`, `/catalog?view=list`, `/catalog/map`, `/objects/:slug`, `/objects/:slug/lots/:unitId`, `/presentations`.
- `LotPresentationsPage` и лоты в этом шаге не менялись и не импортируют route-local admin CSS.

## 2026-07-05 - Web route-level code splitting

Задача:

- Сделать отдельный безопасный route-level lazy/code-splitting шаг для Vite chunk warning, не трогая незавершённую зону лотов-презентаций.

Изменения:

- `apps/web/src/App.tsx` - тяжёлые route pages переведены на `React.lazy`: `CatalogPage`, `ObjectDetailPage`, `ObjectLotDetailPage`, `UsersAdminPage`, `ObjectsAdminPage`, `CatalogLinksAdminPage`, `FeedsAdminPage`, `ImportAdminPage`; добавлен общий `Suspense` fallback внутри `workspace`.
- `apps/web/src/App.tsx` - auth shell, sidebar, login, cabinet/admin home, permission gates и `LotPresentationsPage` оставлены синхронными; порядок route branches и checks по правам сохранён.
- `apps/web/tests/app-route-code-splitting.test.mjs` - добавлена regression-проверка lazy imports, `Suspense` boundary и static import для `LotPresentationsPage`.
- `apps/web/tests/admin-catalog-links-route.test.mjs`, `apps/web/tests/admin-feeds-route.test.mjs`, `apps/web/tests/object-lot-detail-page.test.mjs` - route source checks обновлены под lazy imports без изменения ожидаемых маршрутов.

Проверки:

- RED: `cd apps/web && node --test tests/app-route-code-splitting.test.mjs tests/admin-feeds-route.test.mjs tests/admin-catalog-links-route.test.mjs tests/object-lot-detail-page.test.mjs tests/lot-presentations-page.test.mjs` сначала падал на отсутствующих lazy imports и `Suspense`.
- `cd apps/web && node --test tests/app-route-code-splitting.test.mjs tests/admin-feeds-route.test.mjs tests/admin-catalog-links-route.test.mjs tests/object-lot-detail-page.test.mjs tests/lot-presentations-page.test.mjs tests/sidebar-navigation.test.mjs tests/docker-logo-asset.test.mjs`
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --filter @platforma/web test`
- `pnpm --filter @platforma/web build`
- `git diff --check`
- В build output главный `index` chunk стал `263.08 kB`; route chunks вынесены отдельно: `CatalogPage`, `ObjectDetailPage`, `ObjectsAdminPage`, `FeedsAdminPage`, `UsersAdminPage`, `CatalogLinksAdminPage`, `ImportAdminPage`.
- В `/tmp/platforma-web-build.log` строка `Some chunks are larger than 500 kB` не найдена.

Ручная проверка:

- Перед приёмкой открыть `/catalog`, `/catalog?view=list`, `/catalog/map`, `/objects/:slug`, `/objects/:slug/lots/:unitId`, `/admin/users`, `/admin/objects`, `/admin/objects/new`, `/admin/objects/:id/edit`, `/admin/catalog-links`, `/admin/feeds`, `/admin/feeds/new`, `/admin/feeds/:id/edit`, `/admin/import` под пользователем с нужными правами.
- Отдельно проверить denied state для admin/object routes под пользователем без прав: lazy page chunk не должен менять поведение `AccessDenied`.
- `LotPresentationsPage` в этом шаге не дробился и не менялся.

## 2026-07-05 - Object detail helper extraction

Задача:

- Продолжить безопасное дробление frontend: вынести чистые helper-функции из `ObjectDetailPage.tsx` в `objectDetailViewModel.ts` без изменения JSX, CSS, API, роутинга и map/balloon логики.

Изменения:

- `apps/web/src/objects/objectDetailViewModel.ts` - добавлены exports для media/date/file/url/carousel/content helpers: `FeedMediaWithFile`, `hasFeedMediaFile`, `wrapCarouselIndex`, `formatMediaCount`, `formatObjectFeedUpdatedAt`, `getFeedMediaTitle`, `getFeedMediaDownloadFileName`, `getDescriptionParagraphs`, `getCarouselImages`, `getImageDownloadFileName`, `formatFileSize`, `getExternalObjectUrl`.
- `apps/web/src/objects/ObjectDetailPage.tsx` - удалены локальные дубликаты этих helpers и подключены exports из view model; `getObjectMapPoints`, `buildObjectMapBalloon`, `escapeHtml`, `normalizeLineColor`, CSS и JSX не менялись.
- `apps/web/tests/object-detail-view-model.test.mjs` - добавлены прямые regression-тесты на вынесенные helpers.
- `apps/web/tests/object-detail-styles.test.mjs`, `apps/web/tests/object-lot-detail-page.test.mjs` - обновлены source-based проверки под новую границу view model.

Проверки:

- RED: `cd apps/web && node --test tests/object-detail-view-model.test.mjs` сначала падал на отсутствующем export `formatFileSize`.
- `cd apps/web && node --test tests/object-detail-view-model.test.mjs tests/object-detail-feed-units.test.mjs tests/object-lot-detail-page.test.mjs tests/object-detail-styles.test.mjs tests/object-detail-carousel.test.mjs`
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --filter @platforma/web test`
- `pnpm --filter @platforma/web build`

Ручная проверка:

- Перед приёмкой открыть `/objects/:slug` и `/objects/:slug/lots/:unitId`, проверить галерею, скачивание оригинала, файлы/размеры, aerotour link, timestamp обновления лотов, feed media carousel/fullscreen и объект с координатами/без координат.
- `pnpm --filter @platforma/web build` сохраняет прежнее Vite warning про chunk больше 500 kB; это следующий отдельный шаг оптимизации route-level code splitting.

## 2026-06-29 - Lot presentation workspace implementation

Задача:

- Реализовать сохранённую пользовательскую вкладку `В работе` для PDF-презентаций лотов, плиточный вид лотов в работе и подборках, прямое добавление лота из объекта и контекстные комментарии.

Изменения:

- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql` - добавлены workspace items и comments для presentation collection items.
- `packages/shared/src/index.ts` - добавлены контракты workspace/comment.
- `apps/api/src/lot-presentations/lot-presentations.controller.ts`, `apps/api/src/lot-presentations/lot-presentations.service.ts` - добавлены workspace endpoints и comment endpoints.
- `apps/web/src/presentations/LotCollectionAction.tsx`, `apps/web/src/presentations/LotPresentationsPage.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/styles.css` - добавлен UI `В работе`, плитки лотов, direct add action, comment modal и collection picker.
- `apps/api/tests/lot-presentations-schema.test.cjs`, `apps/web/tests/lot-presentations-page.test.mjs`, `apps/web/tests/object-detail-feed-units.test.mjs` - обновлены регрессии.

Проверки:

- `node --test apps/api/tests/lot-presentations-schema.test.cjs`
- `pnpm --filter @platforma/api prisma:generate`
- `pnpm --filter @platforma/api build`
- `node --test apps/web/tests/lot-presentations-page.test.mjs apps/web/tests/object-detail-feed-units.test.mjs`
- `pnpm --filter @platforma/web build`
- `pnpm --filter @platforma/api test`
- `pnpm --filter @platforma/web test`
- `pnpm build`

Ручная проверка:

- `pnpm dev:web -- --port 5173 --strictPort` не был оставлен запущенным: порт `5173` уже занят процессом `com.docke`, а Vite автоматически ушёл на `5174`; этот процесс был остановлен, чтобы не использовать неутверждённый порт.
- Перед приёмкой вручную проверить `/presentations`, добавление лота из объекта, скачивание PDF, комментарии, добавление в подборку и очистку `В работе`.

## 2026-06-29 - Lot presentation workspace implementation plan

Задача:

- Подготовить детальный implementation plan для реализации сохранённой вкладки `В работе`, плиточных лотов и контекстных комментариев в PDF-презентациях.

Изменения:

- `docs/superpowers/plans/2026-06-29-lot-presentation-workspace-implementation.md` - добавлен пошаговый план реализации с задачами по Prisma/shared/API/frontend/tests/docs.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверки:

- Application code не менялся, сборка и тесты не запускались.

Ручная проверка:

- Перед началом реализации выбрать способ исполнения плана: subagent-driven или inline execution.

## 2026-06-29 - Lot presentation workspace design

Задача:

- Спроектировать новую рабочую зону PDF-презентаций лотов по референсу: вкладка `В работе`, компактные плитки до 5 в ряд, сохранение состояния на пользователя, контекстные комментарии и вкладка `Мои подборки`.

Изменения:

- `docs/superpowers/specs/2026-06-29-lot-presentation-workspace-design.md` - добавлен согласованный дизайн data model, API, UI-потоков, ошибок и проверок.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверки:

- Application code не менялся, сборка и тесты не запускались.

Ручная проверка:

- Перед реализацией перечитать spec и подтвердить, что поведение `В работе`, комментариев и подборок описано верно.

## 2026-06-18 - Lot presentation template visual options

Задача:

- Подготовить визуальные варианты шаблона PDF-презентации лотов перед проектированием новой фичи.

Изменения:

- `docs/lot-presentation-template-options.html` - добавлен статический preview с тремя направлениями оформления: спокойный editorial, деловой data sheet и акцентная галерейная подача; в выбранный вариант 1 добавлена ценовая плашка над планировкой из варианта 2.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверки:

- Application code не менялся, сборка и тесты не запускались.

Ручная проверка:

- Открыть `docs/lot-presentation-template-options.html` и выбрать один из трех вариантов как основу для будущего PDF-шаблона.

## 2026-06-12 - Catalog search ё normalization diagnosis and fix

Задача:

- Проверить production-ошибку на каталоге с поиском `Пыжёвский`, где UI показывал `Не удалось связаться с сервером`.

Диагностика:

- Production checkout `/opt/platforma` на `b458f77`, рабочее дерево чистое.
- Production containers: `api`, `postgres`, `redis`, `minio` healthy; `web` up.
- Public `https://api.broker.fluffywhite.moscow/health` возвращает `status=ok`, `database=ok`, `postgis=true`.
- Production CORS preflight для `https://broker.fluffywhite.moscow` на `/objects` возвращает `204` с `Access-Control-Allow-Origin: https://broker.fluffywhite.moscow`.
- Production web bundle собран с `https://api.broker.fluffywhite.moscow`; runtime env: `WEB_ORIGIN=https://broker.fluffywhite.moscow`, `VITE_API_URL=https://api.broker.fluffywhite.moscow`.
- Nginx/API логи не показали 5xx или upstream errors; реальные браузерные `/objects`, `/map/objects`, directory и media requests отвечали `200/204`.
- По точному request `search=Пыжёвский` production API отвечал `200`, но пустой выдачей.
- В production DB объект есть: `Клубный дом Пыжёвский`, slug `klubnyj-dom-pyzhyovskij`.
- Root cause для пустой выдачи: input search нормализуется `ё -> е`, а SQL-поля `title/developer/address/location` нормализовали только case/dots. Поэтому pattern `%пыжевский%` не матчился с DB value `Пыжёвский`.
- Production read-only SQL check: старое условие дало `old_match=0`, новое `replace(... 'ё','е')` дало `new_match=1`.
- Текст `Не удалось связаться с сервером` остался классифицирован как client-side fetch failure/CORS/network symptom: server-side evidence for current production API outage не найдено.

Изменения:

- `apps/api/src/objects/object-search.ts` - catalog/map raw SQL search fields now normalize `ё -> е` before dot removal and LIKE matching.
- `apps/api/tests/services.test.cjs` - добавлена регрессия на `Пыжёвский`; существующие search SQL expectations обновлены под `ё` normalization.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Деплой:

- Локально создан commit `245bc66 fix(api): normalize yo in catalog search` и запушен в `origin/on-ser`.
- Production `/opt/platforma` fast-forwarded с `b458f77` до `245bc66`.
- Выполнено `docker compose -f docker-compose.prod.yml up -d --build api`; пересобран и перезапущен только `api`, `web` не менялся.

Проверки:

- RED: `pnpm --filter @platforma/api build && cd apps/api && node --test --test-name-pattern "normalizes ё" tests/services.test.cjs` - сначала падал на старой SQL-форме без `replace(... 'ё','е')`.
- GREEN targeted: `pnpm --filter @platforma/api build && cd apps/api && node --test --test-name-pattern "normalizes ё|ignores dots|transliteration" tests/services.test.cjs` - 4/4 passed.
- Full API: `pnpm --filter @platforma/api test` - 184/184 passed.
- Production compose after deploy: `api`, `postgres`, `redis`, `minio` healthy; `web` up.
- Production public `https://api.broker.fluffywhite.moscow/health` вернул `status=ok`, `database=ok`, `postgis=true`.
- Production logs after deploy: `No pending migrations to apply`, `Nest application successfully started`.
- Production protected API smoke with temporary access token: `/objects?search=Пыжёвский&status=PUBLISHED` and `/map/objects?search=Пыжёвский&status=PUBLISHED` both returned `total=1`, title `Клубный дом Пыжёвский`.

Ручная проверка:

- После deploy открыть `/catalog?search=Пыжёвский` и `/catalog/map?search=Пыжёвский`, убедиться, что `Клубный дом Пыжёвский` находится в списке/на карте.
- Если UI снова покажет `Не удалось связаться с сервером`, проверить DevTools Network на фактический failed request/origin, потому что server-side API/CORS/nginx health в ходе диагностики были нормальными.

## 2026-06-11 - Production deploy Kortros TATE CIAN parser fix

Задача:

- Залить на production исправление `CianXmlFeedParser` для фида Kortros TATE `https://feeds.kortros.ru/brk/?obj=tate`.

Деплой:

- Локально на `on-ser` создан commit `fa9514a fix(feed-import): parse kortros tate discounts` и запушен в `origin/on-ser`.
- Production `/opt/platforma` был на `46baea0`, рабочее дерево было чистым.
- Production fast-forwarded до `fa9514a`.
- Выполнено `docker compose -f docker-compose.prod.yml up -d --build api`; пересобран и перезапущен только `api`, `web` не менялся.

Проверки:

- Перед push: `pnpm --filter @platforma/feed-import test` - 61/61 passed; `git diff --check` - clean.
- Production compose после деплоя: `api`, `postgres`, `redis`, `minio` healthy; `web` up.
- Production local `/health` и public `https://api.broker.fluffywhite.moscow/health` вернули `status=ok`, `database=ok`, `postgis=true`.
- Production API log после рестарта содержит `Nest application successfully started`.
- Production parser smoke внутри API-контейнера на `https://feeds.kortros.ru/brk/?obj=tate`: `format=CIAN_XML`, `units=255`, `warnings=0`, `withPrice=255`, `withDiscountPrice=249`, `withEffectivePrice=255`, `gluedMediaTotal=0`, first `price=47681058.00`, `discountPrice=39575278.00`, `effectivePrice=39575278.00`.

Спорное:

- `realtyFloorLayout` из фида TATE по-прежнему не импортируется; текущая правка касается CIAN prices и склеенных `FullUrl` image URLs.
- Production runtime-деплой выполнен на commit `fa9514a`; эта запись является doc-only follow-up.

Ручная проверка:

- В `/admin/feeds` создать или обновить source для `ЖК ТАТЕ (Тейт)`, выполнить preview/run и проверить, что у акционных лотов появились `discountPrice`/`effectivePrice`, а фото Башни Б не дают `MEDIA_DOWNLOAD_FAILED` по склеенным URL.

## 2026-06-11 - Kortros TATE CIAN feed compatibility check

Задача:

- Проверить фид `https://feeds.kortros.ru/brk/?obj=tate` на совместимость с текущим feed importer.

Диагностика:

- Фид доступен по URL, возвращает `200 OK`, `Content-Type: text/xml; charset=utf-8`, размер скачанного XML `671696` bytes.
- XML имеет CIAN-подобную структуру `<feed><object>` и определяется автоанализом как `CIAN_XML`.
- `@platforma/feed-import analyze` с `AUTO` и с явным `CIAN_XML` разобрал 255 residential лотов по одному объекту `ЖК "TATE"`, warnings `0`.
- Все 255 лотов имеют `externalId`, `price/effectivePrice`, `area`, `floor`, `rooms`, `currency`, `address`, `projectName`, `building`, номер квартиры и `kitchenArea`.
- Диапазоны нормализованных данных: цены `19154871.00-230934080.00`, площади `30.08-206.56`, этажи `3-47`, комнаты `1/2/3/4/5`; корпуса `Башня A` и `Башня Б`.
- Analyze предложил `filterJson: {"projectNames":["ЖК \"TATE\""]}`.
- В локальной базе найден published object `ЖК ТАТЕ (Тейт)` и developer `Кортрос`; существующего `FeedSource` для `feeds.kortros.ru/brk/?obj=tate` не найдено, текущих `FeedUnit` для объекта `0`.
- Найдено 4 уникальные склеенные image-ссылки вида `http://feeds.kortros.ru/uploadshttp://feeds.kortros.ru/uploads/img/tate/cian/1.jpeg`; в сыром XML нет пробела между `uploads` и `http`, а вариант с пробелом все равно был бы двумя URL в одном поле.
- В `promotion_date` у 249 лотов есть текстовая старая цена `Стоимость без акции ...`; до правки CIAN parser не считал это `discountPrice`, потому что цена не передана отдельным структурным полем `oldprice`/`DiscountPrice`.
- В фиде нет completion-полей, поэтому `completionYear`/`completionQuarter` будут `null`; `realtyFloorLayout` в текущем `collectCianMedia()` не импортируется, импортируются `LayoutPhoto` и `Photos`.
- После правки parser-а все 255 лотов имеют `price` и `effectivePrice`, 249 лотов имеют `discountPrice`; склеенных media URL в нормализованном результате `0`.

Изменения:

- `tools/feed-import/src/index.ts` - CIAN parser теперь извлекает old/base price из `promotion_date` по тексту `Стоимость без акции ...`, а `BargainTerms.Price` сохраняет как `discountPrice`, если он ниже base price; media URL с несколькими `http(s)://` в одном `FullUrl` разбираются на candidates, лишний URL-префикс отбрасывается.
- `tools/feed-import/tests/parser.test.cjs` - добавлены регрессии на Kortros TATE `promotion_date` prices и склеенный/разделенный пробелом absolute media URL.
- `docs/CODEX_LOG.md` - добавлена текущая запись о диагностике.

Проверки:

- `curl -L --fail --max-time 120 -I https://feeds.kortros.ru/brk/?obj=tate` - `200 OK`.
- `curl -L --fail --max-time 120 https://feeds.kortros.ru/brk/?obj=tate -o /tmp/platforma-kortros-tate-feed.xml` - XML скачан.
- `pnpm --filter @platforma/feed-import run analyze -- --format AUTO --source-kind URL --url https://feeds.kortros.ru/brk/?obj=tate --output /tmp/platforma-kortros-tate-analysis.json` - passed, `CIAN_XML`, 255 units, 0 warnings.
- `pnpm --filter @platforma/feed-import run analyze -- --format CIAN_XML --source-kind FILE --file /tmp/platforma-kortros-tate-feed.xml --output /tmp/platforma-kortros-tate-analysis-cian.json` - passed, 255 units, 0 warnings.
- RED: `pnpm --filter @platforma/feed-import build && cd tools/feed-import && node --test --test-name-pattern "Kortros promotion_date|duplicated absolute prefix" tests/parser.test.cjs` сначала падал на старом `price` и склеенном media URL.
- GREEN: тот же targeted test passed; warning regression test passed.
- `pnpm --filter @platforma/feed-import test` - 61/61 passed.
- `pnpm --filter @platforma/feed-import run analyze -- --format AUTO --source-kind FILE --file /tmp/platforma-kortros-tate-feed-latest.xml --output /tmp/platforma-kortros-tate-analysis-fixed.json` - passed, `CIAN_XML`, 255 units, 0 warnings.
- `node` script через `createFeedParserForFormat('CIAN_XML')` - normalized parse stats checked.
- `node` script после правки по реальному TATE XML - `withPrice=255`, `withDiscountPrice=249`, `withEffectivePrice=255`, `gluedMediaTotal=0`, first lot `price=47681058.00`, `discountPrice=39575278.00`.
- `curl -I` для корректных media examples - `200`; для старой склеенной ссылки `uploadshttp://.../1.jpeg` - `404`.
- Read-only local DB query по `real_estate_objects`, `developers`, `feed_sources`, `feed_units`.

Ручная проверка:

- В `/admin/feeds` создать URL source с format `CIAN_XML`, developer `Кортрос`, object `ЖК ТАТЕ (Тейт)`, при желании с source filter `{"projectNames":["ЖК \"TATE\""]}`.
- Перед production run выполнить preview и проверить, что 255 лотов попали в нужный ЖК.
- После деплоя правки выполнить preview/run по source и проверить, что у 249 акционных лотов появились `discountPrice`/`effectivePrice`, а фото Башни Б скачиваются без `MEDIA_DOWNLOAD_FAILED` по склеенным URL.
- Если нужны floor layout media из `realtyFloorLayout`, нужна отдельная доработка parser-а.

## 2026-06-11 - Production deploy Strana CIAN price parser fix

Задача:

- Залить на production исправление `CianXmlFeedParser` для lower-case `price/oldprice` в фидах Страны.

Деплой:

- Локально проверен `on-ser`, выполнен commit `eb77c45 fix(feed-import): read lowercase cian prices` и push в `origin/on-ser`.
- Production `/opt/platforma` был на `d97b196`, рабочее дерево было чистым.
- Production fast-forwarded до `eb77c45`.
- Выполнено `docker compose -f docker-compose.prod.yml up -d --build api`; пересобран и перезапущен только `api`, `web` не менялся.

Проверки:

- Перед push: `pnpm --filter @platforma/feed-import test` - 59/59 passed; `git diff --check` - clean.
- Production compose: `api`, `postgres`, `redis`, `minio` healthy; `web` up.
- Production local `/health` и public `https://api.broker.fluffywhite.moscow/health` вернули `status=ok`, `database=ok`, `postgis=true`.
- Production API log после рестарта содержит `Nest application successfully started`.
- Production parser smoke внутри API-контейнера на `https://sk.mgcom.ru/strana-dev/cian_city.xml`: `format=CIAN_XML`, `units=181`, `warnings=0`, `missingPrice=0`, `missingEffectivePrice=0`, first `price=60760000.00`, `effectivePrice=49820000.00`.
- Production source `83d1d6af-c8eb-4c67-a8e5-c18d1cf3c006` (`INDEX_URL` на Google Sheet Страны) после рестарта автоматически получил preview/run: run `bc3203ff-38d1-4a03-9816-0309753c7b3a` success, `updated=1053`, `warningsCount=0`, `errorsCount=0`.
- Production DB после run: `feed_units` source `83d1d6af-c8eb-4c67-a8e5-c18d1cf3c006` - `units=1053`, `with_price=1053`, `with_discount_price=1053`, `with_effective_price=1053`, min effective price `9658027.00`, max `280400000.00`.
- Object feed aggregates обновлены для 4 mapped objects: `АУРУС Резиденции`, `Репаблик`, `ЖК Страна.Парковая`, `Страна.Заречная`.

Спорное:

- В production source настроены 4 active mappings из 5 строк Google Sheet; `Страна Озерная` из таблицы не была в active mappings, поэтому ее агрегаты не обновлялись этим source.
- Финальная production проверка после runtime-деплоя была на commit `eb77c45`; эта запись является doc-only follow-up.

Ручная проверка:

- Открыть `/admin/feeds` source `83d1d6af-c8eb-4c67-a8e5-c18d1cf3c006`, проверить список mappings и добавить/исправить mapping для `Страна Озерная`, если этот ЖК должен импортироваться из таблицы.
- Открыть публичные карточки mapped ЖК и убедиться, что цены/диапазоны лотов отображаются.

## 2026-06-11 - Strana CIAN feeds lowercase price import fix

Задача:

- Проверить фиды из Google Sheets `1gAQe9RqES84w_CL4JflyKEgTvi_btFmj2uc8LAPvQ_g`, где после импорта не появились цены, и найти причину.

Диагностика:

- В таблице найдены 5 CIAN URL: `cian_zarechnaya_broker.xml`, `cian_parkovaya_broker.xml`, `cian_republic_broker.xml`, `cian_ozernaya_broker.xml`, `cian_city.xml`.
- Все 5 XML скачиваются, определяются как `CIAN_XML` и содержат лоты в `<feed><object>`.
- В XML цены есть, но в формате `<BargainTerms><price><value>...</value><currency>RUR</currency></price><oldprice><value>...</value>...</oldprice></BargainTerms>`.
- До правки `CianXmlFeedParser` читал только `BargainTerms.Price` и `BargainTerms.Currency`, поэтому на этих фидах `price`, `discountPrice`, `effectivePrice`, `pricePerMeter` и `currency` становились `null` без warnings.
- После правки на всех 5 реальных XML `missingPrice=0`, `missingEffectivePrice=0`, `warnings=0`; `oldprice` сохраняется как base `price`, `price` сохраняется как `discountPrice/effectivePrice`.
- В локальной БД read-only проверка не нашла `FeedSource` с этими 5 URL, поэтому существующие локальные импортированные units не обновлялись.

Изменения:

- `tools/feed-import/src/index.ts` - CIAN parser теперь читает lower-case `price.value`, lower-case `oldprice.value`, currency из вложенного lower-case price и считает текущую lower-case `price` скидочной ценой, если `oldprice` больше.
- `tools/feed-import/tests/parser.test.cjs` - добавлена регрессия на Strana-style CIAN `price/oldprice`.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверки:

- RED: `pnpm --filter @platforma/feed-import build && cd tools/feed-import && node --test --test-name-pattern "Strana lowercase price" tests/parser.test.cjs` сначала падал на `unit.price === null`.
- GREEN: тот же targeted test passed.
- `pnpm --filter @platforma/feed-import test` - 59/59 passed.
- `node` parse script по 5 скачанным Strana CIAN XML - все цены и effective prices заполнены, warnings `0`.
- Read-only local DB query по `feed_sources.url` для этих 5 URL - 0 rows.

Ручная проверка:

- После деплоя правки выполнить `preview`, затем `run` по созданным production sources; если units уже были импортированы с `null` prices, только `run` обновит `FeedUnit` и объектные feed aggregates.

## 2026-06-11 - Strana Development Yandex feed compatibility check

Задача:

- Проверить фид `https://sk.mgcom.ru/strana-dev/ya_realty_city.xml` на совместимость с текущим feed importer.

Диагностика:

- Фид доступен по URL, возвращает `200 OK`, `Content-Type: text/xml`, размер `710075` bytes, `Last-Modified: Thu, 11 Jun 2026 07:26:00 GMT`.
- XML имеет root `realty-feed` и определяется автоанализом как `YANDEX_REALTY`.
- `@platforma/feed-import analyze` разобрал 181 лот, 1 объект `АУРУС Резиденции`, developer `Страна Девелопмент`, warnings `0`.
- Анализатор предложил filterJson по `buildingNames: ["АУРУС Резиденции"]`, `yandexBuildingIds: ["4538694"]`, `yandexHouseIds: ["4538765"]`, `addressIncludes: ["2-й Красногвардейский проезд"]`.
- Нормализованные лоты: residential `181`, available `181`, rooms `1/2/3`, prices/discount prices заполнены у всех, area/floor/rooms/projectName/address/building заполнены у всех, completion `2031 Q4`.
- Медиа: 1447 image-ссылок, 7-8 на лот; выборочные HEAD-проверки plan image и project image вернули `200` и `image/jpeg`.
- В локальной базе read-only найден published object `Жилой комплекс АУРУС Резиденции (Страна.Сити)` и developer `Страна Девелопмент`, к которым source можно привязать.

Изменения:

- `docs/CODEX_LOG.md` - добавлена текущая запись о диагностике.

Проверки:

- `curl -L --fail --max-time 120 https://sk.mgcom.ru/strana-dev/ya_realty_city.xml` - XML скачан.
- `pnpm --filter @platforma/feed-import run analyze -- --format AUTO --source-kind URL --url https://sk.mgcom.ru/strana-dev/ya_realty_city.xml --output /tmp/platforma-mgcom-strana-analysis.json` - passed, `YANDEX_REALTY`, 181 units, 1 object, 0 warnings.
- `node` script через `createFeedParserForFormat('YANDEX_REALTY')` - normalized parse passed, 181 units, 0 parser warnings.
- `docker compose exec -T postgres psql ... select ... from real_estate_objects/developers` - read-only проверка существующих object/developer.

Ручная проверка:

- В `/admin/feeds` выполнить analyze с `AUTO` или сразу выбрать `YANDEX_REALTY`; сам URL source сохранить с format `YANDEX_REALTY`, developer `Страна Девелопмент`, object `Жилой комплекс АУРУС Резиденции (Страна.Сити)`.
- Перед production run выполнить preview по source и сверить, что 181 лот попали в нужный ЖК; run не запускался в рамках диагностики.

## 2026-06-11 - Feed source mapping editor from edit mode

Задача:

- В режиме редактирования фида показать, какие ЖК сохранены в сопоставлении, и добавить кнопку для повторного открытия режима сопоставления как при первичной настройке.

Изменения:

- `apps/web/src/admin/FeedsAdminPage.tsx` - в метаданных source строка `ЖК` теперь показывает список сохраненных связок `объект фида -> ЖК`; добавлена кнопка `Редактировать сопоставление`, которая запускает тот же разбор фида и скроллит к `FeedSourceAnalysisPanel`.
- `apps/web/src/styles.css` - добавлены компактные responsive-стили для списка сопоставлений.
- `apps/web/src/app-theme.css` - новые элементы включены в theme-aware селекторы для темной админки.
- `apps/web/tests/admin-feeds-page.test.mjs` - добавлена регрессия на повторное открытие редактора сопоставлений из режима редактирования фида.
- Follow-up: исправлена разметка mappings summary - `.details-list` и theme-стили теперь применяются только к прямым строкам, а полный список mappings показывается только в edit mode, не в узкой боковой панели списка фидов.

Проверки:

- RED: новый тест `feeds admin editor can reopen and inspect saved source mappings` сначала падал на отсутствии `openSourceMappingsEditor`.
- GREEN: `pnpm --filter @platforma/web test -- admin-feeds-page.test.mjs` - 236/236 passed.
- `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- Browser fallback: `http://localhost:5174/admin/feeds` открылся до экрана входа без UI crash; полноценная проверка админки не выполнена, потому что backend CORS разрешает `localhost:5173`, а временный Vite поднялся на `5174`.
- Production follow-up: commit `687e656` запушен в `origin/on-ser`, production `/opt/platforma` fast-forwarded с `b0bd6ed` до `687e656`, пересобраны и перезапущены контейнеры `api` и `web`; публичный bundle `/assets/index-DLxokO5-.js` содержит `Редактировать сопоставление`.
- Layout follow-up: `pnpm --filter @platforma/web test -- admin-feeds-page.test.mjs` - 237/237 passed; `pnpm build:web` - passed.

Ручная проверка:

- Открыть `/admin/feeds/:id/edit` у source с несколькими mappings, убедиться, что в поле `ЖК` виден список связок и кнопка `Редактировать сопоставление`.
- Нажать кнопку, дождаться разбора фида, проверить, что открылся блок `Разбор фида` с текущими select-сопоставлениями и сохранение применяет измененные mappings.

## 2026-06-10 - Brusnika Yandex feed compatibility

Задача:

- Проверить фид Брусники `https://moskva.brusnika.ru/feed/yandex-msk/` на совместимость с текущим feed importer и адаптировать парсер при необходимости.

Диагностика:

- Фид скачался как XML `realty-feed` размером около 5.18 MB и определяется как `YANDEX_REALTY`.
- До правки парсер вытаскивал 975 лотов и 6 объектов, но давал 607 предупреждений `INVALID_INTEGER` по `balconyCount`: значения Брусники приходят как `балкон`, `лоджия`, `2 балкона`, `2 лоджии` и похожие текстовые формы.
- Также `<category>flat</category>` попадал в `FeedUnit.title` как английское `flat`.

Изменения:

- `tools/feed-import/src/index.ts` - Yandex-парсер нормализует `category=flat` в `квартира` для заголовка лота и переводит текстовые значения `balcony`/`balconies` в числовой `balconyCount` без warnings.
- `tools/feed-import/tests/parser.test.cjs` - добавлена регрессия на Brusnika-style Yandex XML с `category=flat`, `лоджия`, `2 балкона`, `2 лоджии`.
- `docs/CODEX_LOG.md` - добавлена эта запись.

Проверки:

- RED: новая регрессия `YandexRealtyFeedParser normalizes Brusnika flat category and textual balcony values` сначала падала на старом коде с `INVALID_INTEGER` по `balconyCount`.
- GREEN: `pnpm --filter @platforma/feed-import build && cd tools/feed-import && node --test --test-name-pattern "Brusnika" tests/parser.test.cjs` - 1/1 passed.
- `pnpm --filter @platforma/feed-import test` - 58/58 passed.
- `pnpm --filter @platforma/feed-import run analyze -- --format AUTO --source-kind URL --url https://moskva.brusnika.ru/feed/yandex-msk/ --output /tmp/brusnika-feed-analysis.json` - format `YANDEX_REALTY`, developer `Брусника`, 975 лотов, 6 объектов, 0 warnings.

Ручная проверка:

- В `/admin/feeds` создать URL source для Брусники с format `YANDEX_REALTY` или `AUTO`, проверить suggested mappings: `Первый квартал`, `Квартал «Метроном»`, `Квартал Герцена`, `Квартал «МОНС»`, `Дом «А»`, `Квартал «Издание»`.
- Перед production run выполнить preview по source и сверить привязку mappings к существующим объектам Platforma.

## 2026-06-06 - Production deploy aerotour and latest on-ser updates

Задача:

- Залить на production последние 4 коммита ветки `on-ser`: lot filters/ruble mask/floor-plan badge/aerotour links.

Деплой:

- Локальная ветка `on-ser` была на 4 коммита впереди `origin/on-ser`: `6352f88`, `7f5c47e`, `2a1cac5`, `09343b7`.
- Перед push прогнаны свежие локальные проверки: `pnpm test`, `pnpm build`, `git diff --check`.
- `on-ser` запушен в `origin/on-ser` с `0520aab` до `09343b7`.
- Production checkout `/opt/platforma` был на `0520aab` и fast-forwarded до `09343b7`.
- Перед пересборкой создан production backup `/opt/platforma-deploy-backups/20260605T201854Z-aerotour-deploy`: git state, compose state, API health и `platforma.sql.gz` размером 28 MB.
- Выполнен `docker compose -f docker-compose.prod.yml up -d --build api web`; контейнеры `platforma-api-1` и `platforma-web-1` пересозданы.

Проверки:

- Production `docker compose -f docker-compose.prod.yml ps` - `api`, `postgres`, `redis`, `minio` healthy; `web` up.
- Production local API `/health` и public API `https://api.broker.fluffywhite.moscow/health` вернули `status=ok`, `database=ok`, `postgis=true`.
- Production public web `https://broker.fluffywhite.moscow/` вернул `200 OK`.
- Prisma migration `20260605190000_add_object_aerotour_url` применена; API log показывает `All migrations have been successfully applied` и `Nest application successfully started`.
- Production DB check: `real_estate_objects.aerotour_url` существует как `character varying(2048)`.
- Production web bundle содержит `aerotour-icon-7fw9A1GP.png`, `index-IxrDLll8.css`, `index-C39g35Mh.js`.
- Public asset `https://broker.fluffywhite.moscow/assets/aerotour-icon-7fw9A1GP.png` вернул `200 OK`, `Content-Type: image/png`, `Content-Length: 13261`.
- Production feed scheduler после API restart завершил цикл с `sources=9`, `previewed=8`, `runsQueued=8`, `failed=1`; свежие feed run statuses за 15 минут: `success=8`, `partial=8`.

Спорное:

- В свежем API log после рестарта есть отдельная ошибка scheduler по feed source `90699a52-7849-4979-af3a-8c7b13d440a5`: `Feed import run not found`. Web/API health и deploy не пострадали, но source стоит проверить отдельно в `/admin/feeds`.

Ручная проверка:

- Открыть production каталог и объект с заполненным `Аэротур`, проверить бейдж в каталоге, кнопку/иконку на карточке ЖК и лота.
- В админке заполнить/очистить поле `Аэротур` у тестового ЖК и убедиться, что значение сохраняется и публичный UI появляется/скрывается.
- Открыть `/admin/feeds` и посмотреть source `90699a52-7849-4979-af3a-8c7b13d440a5`, который дал scheduler `partial/error`.

## 2026-06-05 - Object aerotour link and catalog badge

Задача:

- Добавить для ЖК ссылку на аэротур/аэропанораму.
- Показывать поле в админке, кнопку в публичной карточке ЖК и бейдж на обложке карточки каталога только при заполненной ссылке.

Изменения:

- `apps/api/prisma/schema.prisma` и миграция `20260605190000_add_object_aerotour_url` - добавлено nullable-поле `aerotour_url`.
- `packages/shared/src/index.ts` - публичный контракт `RealEstateObjectBase` расширен полем `aerotourUrl`.
- `apps/api/src/objects/objects.service.ts` - ссылка нормализуется, валидируется как `http://`/`https://`, сохраняется, очищается и попадает в сериализацию/audit snapshot.
- `apps/web/src/admin/ObjectsAdminPage.tsx` - поле `Аэротур` добавлено между блоками `Наполнение` и `Планировки и цены`.
- `apps/web/src/objects/ObjectDetailPage.tsx` - в блоке файлов публичной карточки добавлена кнопка `Аэротур`; она видна только при заполненной ссылке и открывается в новой вкладке.
- `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css` - добавлен бейдж аэротура рядом с бейджами планировок/PDF; цвета разделены для светлой и темной темы.
- Follow-up: публичная кнопка и бейдж аэротура теперь проверяют не просто truthy-значение, а непустой валидный `http://`/`https://` URL после `trim()`, чтобы пустые/пробельные/старые некорректные значения не занимали слот.
- `aerotour-icon.png` - добавлена корневая PNG-иконка из предоставленного источника; запеченный фон исходника преобразован в прозрачный alpha-канал.
- `apps/web/Dockerfile` - новый PNG-asset копируется в production build.
- Добавлены и обновлены API/web-регрессии на схему, миграцию, контракт, сохранение, валидацию, админское поле, публичную кнопку и бейдж каталога.

Проверки:

- RED: targeted API/web тесты сначала падали на отсутствующем поле, миграции, контракте, админском поле, публичной кнопке и бейдже.
- GREEN: `pnpm --filter @platforma/api build && node --test apps/api/tests/object-aerotour-schema.test.cjs apps/api/tests/api-contract.test.cjs apps/api/tests/services.test.cjs` - 92/92 passed.
- GREEN: `pnpm --filter @platforma/web exec node --test tests/catalog-card-badges.test.mjs tests/admin-object-content-sections.test.mjs tests/object-detail-styles.test.mjs` - 21/21 passed.
- `pnpm test` - passed: feed-import 57/57, wp-import 17/17, web 234/234, api 183/183.
- `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- `git diff --check` - clean.
- `docker compose up -d --build api web` - пересобраны и перезапущены локальные контейнеры.
- `curl http://localhost:3000/health` - `status: ok`, `database: ok`, `postgis: true`.
- `curl -I http://localhost:5173/` - `200 OK`.
- Postgres check: колонка `real_estate_objects.aerotour_url` существует как `varchar(2048)`.
- Browser plugin path не сработал: `Browser is not available: iab`; выполнен fallback через Playwright.
- Playwright fallback: временно заполнен `aerotour_url` у `Жилой комплекс Dream Riva`, проверен бейдж в `/catalog?search=Dream%20Riva` - PNG asset отдается из production build, овал золотой, иконка `14.4px`, `filter: brightness(0)`.
- Playwright fallback: `/objects/zhiloj-kompleks-dream-riva` показывает `Презентация`, `Аэротур`, `Планировки` в одной строке; ссылка `Аэротур` имеет `target="_blank"` и `rel="noopener noreferrer nofollow"`.
- После визуальной проверки тестовое значение `aerotour_url` у Dream Riva возвращено в `NULL`.
- Playwright screenshots: `/tmp/platforma-aerotour-catalog.png`, `/tmp/platforma-aerotour-object-detail.png`.
- Follow-up GREEN: `pnpm --filter @platforma/web exec node --test tests/catalog-card-badges.test.mjs tests/object-detail-styles.test.mjs` - 17/17 passed.
- Follow-up: `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- Follow-up: `docker compose up -d --build web` - локальный production web bundle пересобран.
- Follow-up Playwright fallback: у `Мангазея в Богородском` с `aerotour_url = NULL` в `/objects/zhk-mangazeya-v-bogorodskom` нет ни ссылки, ни кнопки `Аэротур`, блок файлов показывает `ПрезентацияПланировки`.
- Follow-up Playwright fallback: при временно заполненном `aerotour_url` кнопка `Аэротур` появляется с корректным `href`, `target="_blank"` и `rel="noopener noreferrer nofollow"`; после проверки поле возвращено в `NULL`.
- Lot follow-up: в header карточки лота добавлена кликабельная иконка аэротура, использующая `aerotourUrl` родительского ЖК; без валидной `http://`/`https://` ссылки иконка полностью скрыта.
- Lot follow-up GREEN: `pnpm --filter @platforma/web test` - 235/235 passed.
- Lot follow-up: `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- Lot follow-up: `docker compose up -d --build web` - локальный production web bundle пересобран.
- Lot follow-up Playwright fallback: `/objects/zhiloj-kompleks-aura/lots/4a00f84d-5d32-4944-8d20-848a25e16a41` с заполненным `aerotour_url` показывает icon-link `Открыть аэротур` с `href=https://www.avito.ru/`, `target="_blank"`, золотым овалом и PNG-иконкой.
- Lot follow-up Playwright fallback: при временно очищенном `aerotour_url` у `ЖК АУРА` icon-link на лоте отсутствует; после проверки исходное значение `https://www.avito.ru/` восстановлено.

Ручная проверка:

- В админке ЖК заполнить `Аэротур`, сохранить и убедиться, что поле восстанавливается после перезагрузки.
- В публичной карточке ЖК проверить, что `Аэротур` появляется в строке файлов рядом с презентацией и планировками и открывается в новой вкладке.
- В каталоге проверить бейдж аэротура на карточке с заполненной ссылкой в светлой и темной теме; на объектах без ссылки бейджа быть не должно.

## 2026-06-05 - Local full-stack dev server startup

Задача:

- Поднять локальный сервер со всеми зависимостями.

Действия:

- Запущен Docker Desktop, так как Docker daemon сначала был недоступен.
- Проверены workspace-зависимости через `pnpm install --frozen-lockfile`; lockfile был актуален, `node_modules` уже присутствовал.
- Подняты инфраструктурные сервисы `postgres`, `redis`, `minio` через `docker compose up -d postgres redis minio`.
- Сгенерирован Prisma Client через `pnpm db:generate`.
- `pnpm db:migrate` был остановлен, потому что `prisma migrate dev` запросил имя новой миграции; новые миграции в рамках задачи запуска не создавались.
- Применение существующих миграций проверено через `pnpm --filter @platforma/api exec prisma migrate deploy`; pending migrations не было.
- Запущен seed через `pnpm db:seed`.
- Локальные `pnpm dev:api` и `pnpm dev:web -- --port 5173 --strictPort` были запущены и проверены, но затем остановлены, чтобы не оставлять интерактивные tool-сессии.
- Финальный full-stack поднят detached-командой `docker compose up -d --build api web`.

Проверки:

- `curl http://localhost:3000/health` - `status: ok`, `database: ok`, `postgis: true`.
- `curl -I http://localhost:5173/` - `200 OK`.
- `docker compose ps` - `api`, `postgres`, `redis`, `minio` healthy; `web` running.
- `lsof -nP -iTCP:3000 -sTCP:LISTEN` - порт слушает Docker.
- `lsof -nP -iTCP:5173 -sTCP:LISTEN` - порт слушает Docker.

Ручная проверка:

- Открыть `http://localhost:5173/` и залогиниться локальным seeded admin.
- Учесть, что текущий финальный web-процесс - Docker-сборка, а не Vite HMR dev server.
- Если потребуется привести Prisma schema к migrations, отдельно решить, создавать ли новую миграцию.

## 2026-06-05 - Local web dev server availability check

Задача:

- Проверить, почему локальная web-страница недоступна.

Диагностика:

- `localhost:5173` не слушался: `lsof -nP -iTCP:5173 -sTCP:LISTEN` не нашел процесса, `curl http://localhost:5173/` возвращал connection refused.
- API был доступен: `localhost:3000/health` вернул `status: ok`, `database: ok`, `postgis: true`.
- Docker-сервисы `api`, `postgres`, `redis`, `minio` были запущены и healthy.

Действия:

- Запущен web dev server командой `pnpm dev:web -- --port 5173 --strictPort`.
- Vite поднялся на `http://localhost:5173/`.

Проверки:

- `curl -I http://localhost:5173/` - `200 OK`.
- `curl http://localhost:3000/health` - `status: ok`, `database: ok`, `postgis: true`.
- `lsof -nP -iTCP:5173 -sTCP:LISTEN` - порт слушает `node`.
- Browser plugin path не сработал: `Browser is not available: iab`; standalone Playwright fallback не использовался, потому что для задачи хватило HTTP/runtime-проверок.

Ручная проверка:

- Открыть `http://localhost:5173/` в браузере и залогиниться/перейти в нужный раздел.
- Если страница снова станет недоступной, проверить, не остановилась ли текущая `pnpm dev:web` сессия.

## 2026-06-05 - Catalog imported lots floor plan badge

Задача:

- Добавить на карточки ЖК в каталоге иконку планировки рядом с PDF, если у объекта есть импортированные лоты.
- Иконку сделать SVG-ассетом в корне проекта и задать отдельные цвета для светлой и темной темы.

Изменения:

- `floor-plan.svg` - добавлен корневой SVG-ассет планировки.
- `apps/web/src/catalog/CatalogPage.tsx` - карточка каталога импортирует SVG и показывает бейдж планировки при `feedUnitsCount > 0`; `null`, `0` и некорректные значения бейдж не показывают. PDF-бейдж и бейдж планировки объединены в правую группу документов.
- `apps/web/src/styles.css` - добавлены стили группы документных бейджей; иконка планировки рендерится как `img`, а не CSS mask, чтобы не превращаться в залитый квадрат при сбое mask/custom property. Для иконки усилен селектор внутри `.catalog-card-media`, чтобы ее не перебивали стили карточного изображения.
- `apps/web/src/app-theme.css` - добавлены отдельные цвета/фон/бордер для бейджа планировки в `minimal-luxury` и `dark-premium`, а также theme override для `filter`/`object-fit`, чтобы общий dark media filter не применялся к иконке.
- `apps/web/Dockerfile` - корневой `floor-plan.svg` копируется в Docker build context рядом с логотипом.
- `apps/web/tests/catalog-card-badges.test.mjs` - добавлена регрессия на условие `feedUnitsCount > 0`, SVG-ассет, Docker copy, theme-aware стили и защиту от перебивания иконки стилями `.catalog-card-media img`.

Исправление после визуального фидбека:

- Старый SVG был не похож на предоставленный референс, а CSS mask не применился в браузере, из-за чего бейдж выглядел как однотонный квадрат.
- `floor-plan.svg` заменен на SVG-силуэт, построенный по alpha mask исходной PNG-иконки `noun_floor_plan_658525_000000.png`.
- Рендер переведен с `span` + CSS mask на обычный `<img src={floorPlanIconUrl}>` с theme-aware `filter`.
- Иконка внутри овала уменьшена с `24px` до `14.4px` - на 40%.
- Темная тема: фон бейджа планировки переведен на `--app-theme-primary`, как у кнопки `+ Фильтры`, сама иконка стала черной.
- Светлая тема: фон бейджа планировки переведен на золотой `--app-theme-accent`, сама иконка стала белой.

Проверки:

- RED: `pnpm --filter @platforma/web test -- catalog-card-badges.test.mjs` падал на отсутствующем импорте/ассете.
- RED: обновленный `catalog-card-badges.test.mjs` падал на старой stroke-иконке и на перебивании иконки общими media-стилями.
- GREEN: `pnpm --filter @platforma/web exec node --test tests/catalog-card-badges.test.mjs` - 3/3 passed.
- `pnpm --filter @platforma/web test` - 231/231 passed.
- `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- `git diff --check` - clean.
- Browser plugin path не сработал: `Browser is not available: iab`; выполнен fallback через Playwright MCP.
- Playwright fallback: `/catalog?search=Жилой комплекс Dream Riva` проверен на `390x844` и `1440x900`; бейдж планировки рендерится как `IMG`, использует новый SVG path из `floor-plan.svg`, имеет `object-fit: contain`, находится на одной строке с PDF, gap `8px`.
- Playwright screenshot: `/tmp/platforma-catalog-badges-mobile-card-scrolled-fixed-icon.png` и `/tmp/platforma-catalog-badges-desktop-fixed-icon.png` - иконка визуально отображается как планировка, не как квадрат.
- Изолированная Chrome/Playwright проверка на реальных `styles.css` и `app-theme.css`: dark фон бейджа `rgb(200, 166, 106)` совпадает с фоном `+ Фильтры`, иконка `14.4px`, `filter: brightness(0)`; light фон золотой, иконка `filter: brightness(0) invert(1)`.
- Изолированные screenshots: `/tmp/platforma-floor-plan-badge-dark-adjusted.png` и `/tmp/platforma-floor-plan-badge-light-adjusted.png`.
- Console health: только React DevTools info и ожидаемый Vite reconnect после перезапуска dev-сервера, ошибок приложения нет.

Ручная проверка:

- Открыть `/catalog` в светлой и темной теме и проверить цвет бейджа планировки.
- Найти объект с импортированными лотами и PDF, например `Жилой комплекс Dream Riva`, и убедиться, что иконка планировки стоит рядом с PDF.
- Открыть объект без импортированных лотов и убедиться, что иконка планировки не показывается.

## 2026-06-05 - Ruble masks in public price filters

Задача:

- Добавить символ рубля в ценовые поля фильтра каталога и фильтра лотов: в пустом поле он должен быть серым placeholder, а при наборе сохраняться в отображаемом значении.
- Исправить удаление цифр через Backspace, когда курсор стоит после символа `₽`.

Изменения:

- `apps/web/src/lib/numberInput.ts` - добавлен `formatCurrencyInputValue()`, который возвращает пустую строку для пустого значения и `число ₽` для введенного значения; добавлен `getCurrencyInputBackspaceValue()` для удаления последней цифры, когда курсор находится после `₽`.
- `apps/web/src/catalog/CatalogPage.tsx` - ценовые поля каталога (`Цена от/до`, `Цена за метр от/до`) используют рублевые placeholders и display-маску, raw state/query остаются числовыми; Backspace после `₽` обрабатывается отдельно.
- `apps/web/src/objects/ObjectDetailPage.tsx` - ценовые поля фильтра лотов объекта используют те же рублевые placeholders, display-маску и обработку Backspace после `₽`.
- `apps/web/tests/price-input-formatting.test.mjs` - обновлена регрессия на рублевую маску, сохранение raw-значений и подключение обработчика Backspace.

Проверки:

- `pnpm --filter @platforma/web test -- price-input-formatting.test.mjs catalog-lot-filters.test.mjs object-detail-feed-units.test.mjs` - 228/228 passed.
- `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- `git diff --check` - clean.
- Browser/Playwright visual fallback не завершился: страница Playwright была закрыта до проверки.

Ручная проверка:

- Открыть `/catalog`, раскрыть фильтры и проверить, что четыре ценовых поля показывают серый placeholder с `₽` пустыми и `123 ₽` при вводе.
- В этих же полях поставить курсор после `₽`, нажать Backspace и проверить, что удаляется последняя цифра, а не только временно исчезает знак рубля.
- Открыть страницу объекта с блоком `Лоты` и проверить такое же поведение в `Цена от/до` и `Цена за метр от/до`.

## 2026-06-05 - Object lot filter visual layout

Задача:

- Перестроить визуал фильтра лотов на странице объекта: перенести `Сбросить` вправо, выровнять ширину полей цены с полями цены за метр, поставить `Цена за метр от/до` под ценой, а `Комнаты` под `Тип`.

Изменения:

- `apps/web/src/objects/ObjectDetailPage.tsx` - добавлены layout-классы полям фильтра лотов, `Комнаты` и `Цена за метр от/до` переставлены в разметке под нужные колонки, reset-кнопка получила отдельный класс.
- `apps/web/src/styles.css` - фильтр лотов переведен на явную CSS grid-раскладку с парными колонками цены/цены за метр, правым reset и адаптивными сбросами grid-позиций.
- `apps/web/tests/object-detail-feed-units.test.mjs` - обновлены регрессии на классы и позиции ключевых элементов фильтра лотов.

Проверки:

- `pnpm --filter @platforma/web test -- object-detail-feed-units.test.mjs` - 228/228 passed.
- `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- `git diff --check` - clean.
- Playwright fallback: открыт `http://localhost:5173/objects/zhiloj-kvartal-foriver-residence`, проверены bounding boxes фильтра; `Тип` и `Комнаты` совпадают по X, `Цена от/до` и `Цена за метр от/до` совпадают по X/width, reset находится справа.

Ручная проверка:

- Открыть страницу объекта с блоком `Лоты` и убедиться, что визуал фильтра соответствует макету на desktop и не ломается на узкой ширине.

## 2026-06-05 - Catalog filter reset button placement

Задача:

- Переместить кнопку `Сбросить` рядом с кнопкой `Скрыть фильтры` в фильтре каталога и сделать ее такого же размера.

Изменения:

- `apps/web/src/catalog/CatalogPage.tsx` - кнопка `Сбросить` вынесена из нижней части раскрытых фильтров в верхнюю строку действий рядом с toggle-кнопкой фильтров.
- `apps/web/src/styles.css` - добавлены стили для верхней группы действий и одинаковых габаритов кнопок `Сбросить` / `Скрыть фильтры`, включая мобильную раскладку.
- `apps/web/tests/catalog-lot-filters.test.mjs` - добавлена регрессия на новое расположение reset-кнопки и общую геометрию кнопок.

Проверки:

- `pnpm --filter @platforma/web test -- catalog-lot-filters.test.mjs` - 228/228 passed.
- `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- `git diff --check` - clean.

Ручная проверка:

- Открыть `/catalog`, раскрыть фильтры и убедиться, что `Сбросить` находится рядом с `Скрыть фильтры`, обе кнопки одинаковой высоты и ширины.
- Проверить мобильную ширину: поиск остается сверху, кнопки стоят под ним на всю ширину.

## 2026-06-05 - Catalog lot price-per-meter filters

Задача:

- Переделать фильтры лотов в каталоге: пары цены и этажа сделать визуально половинными.
- Исправить неверную трактовку `М2`: вместо площади лота в каталоге нужен фильтр цены за квадратный метр, как уже было в фильтре лотов объекта.
- Сделать фильтр `Цена за метр от` / `Цена за метр до` сквозным из каталога в блок лотов объекта.

Изменения:

- `apps/web/src/catalog/CatalogPage.tsx` - добавлены `lotPricePerMeterMin` и `lotPricePerMeterMax`, поля `Цена за метр от/до`, сериализация в URL, API params и ссылки на объект; ошибочные `lotAreaMin/lotAreaMax` удалены из каталога.
- `apps/web/src/objects/ObjectDetailPage.tsx` - существующие поля `Цена за метр от/до` инициализируются из `lotPricePerMeterMin/lotPricePerMeterMax` при переходе из каталога; `М2 от/до` в фильтре лотов объекта не добавлялись.
- `apps/api/src/objects/objects.service.ts` - `GET /objects` фильтрует объекты по цене за метр лота через `FeedUnit.effectivePricePerMeter` и учитывает этот фильтр в `matchedFeedUnitsCount`.
- `apps/api/src/map/map.service.ts` - `GET /map/objects` поддерживает те же `lotPricePerMeterMin/lotPricePerMeterMax`.
- `apps/web/src/styles.css` - добавлены локальные сетки для половинных пар полей.
- `apps/web/tests/catalog-lot-filters.test.mjs`, `apps/web/tests/object-detail-feed-units.test.mjs`, `apps/api/tests/services.test.cjs` - обновлены регрессии на price-per-meter параметры, UI и сквозную инициализацию объектного фильтра.
- `docs/PAGES_AND_ROUTES.md`, `docs/FEATURE_MAP.md`, `docs/STATE_AND_LOGIC.md` - актуализированы query params для lot-фильтров.

Проверки:

- `pnpm --filter @platforma/web test -- catalog-lot-filters.test.mjs object-detail-feed-units.test.mjs` - 227/227 passed.
- `pnpm --filter @platforma/api test -- --test-name-pattern "filters objects by matching lot price per meter|MapService.listObjects filters objects by matching lot price per meter"` - 179/179 passed.
- `pnpm build:web` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- `pnpm build:api` - passed.
- `curl -I http://localhost:5173/catalog` - 200 OK.
- `docker compose up -d --build api` - API rebuilt and started; `platforma-api-1` health is `healthy`, container dist contains `lotPricePerMeterMin`.
- Browser QA не выполнен: Browser-подключение вернуло `Browser is not available: iab`.
- Диагностика: красные тесты подтвердили, что прежняя реализация искала площадь лота, а не цену за метр; после правки каталог и карта строят фильтр `effectivePricePerMeter`.

Ручная проверка:

- Открыть `/catalog`, раскрыть фильтры и проверить, что `Цена от/до`, `Цена за метр от/до`, `Этаж от/до` стоят половинными парами и корректно пишутся в query params.
- Перейти из каталога в объект с заполненными `lotPricePerMeterMin/lotPricePerMeterMax` и убедиться, что в блоке `Лоты` заполнены существующие поля `Цена за метр от/до`.
- Проверить `/catalog/map` с этими же фильтрами цены за метр.

## 2026-06-04 - Sminex index feed duplicate merge

Задача:

- Исправить production-причину дублей Sminex: в `index_url` один и тот же лот приходит из CIAN и Yandex Realty дочерних XML с одинаковым raw external id, но разными namespaced `externalId`.

Изменения:

- `tools/feed-import/src/index.ts` - для Sminex `INDEX_URL` после routing добавлен merge duplicate-групп по `objectId + raw externalId`; merge срабатывает только если в группе есть CIAN и Yandex Realty и совпадают apartment number, floor, rooms, area, effective price и completion.
- `tools/feed-import/src/index.ts` - canonical unit выбирается из CIAN; из Yandex добирается осмысленный `building`, media URL объединяются без дублей, а CIAN `section`, title и residential details остаются основой.
- `tools/feed-import/src/index.ts` - placeholder values `-`, `—`, `–` в building/project/section полях нормализуются в `null`, чтобы дефисы из фида не попадали в group header.
- `tools/feed-import/src/index.ts` - duplicate-группы внутри raw external id дополнительно кластеризуются по параметрам лота, чтобы совместимая CIAN/Yandex-пара мерджилась, даже если рядом есть отдельный CIAN-вариант с тем же raw id, но другой ценой.
- `tools/feed-import/tests/import-engine.test.cjs` - добавлена регрессия на Sminex `Палашёвский 11`: existing CIAN + Yandex строки с raw id `000110621` становятся одним активным CIAN-лотом, Yandex external id архивируется, building берется из Yandex, media объединяются, а второй CIAN-вариант с другой ценой остается отдельным лотом.

Проверки:

- RED: новый `executeFeedImport merges Sminex index duplicates by raw external id using CIAN as canonical unit` падал на текущем коде с `2 !== 1`.
- GREEN: `pnpm --filter @platforma/feed-import build && node --test tools/feed-import/tests/import-engine.test.cjs` - 24/24 passed.
- `pnpm --filter @platforma/feed-import test` - 56/56 passed.
- RED для production-хвоста с третьим CIAN-вариантом падал с `3 !== 2`; после кластеризации `pnpm --filter @platforma/feed-import test` - 56/56 passed.
- Production: перед изменением данных создан backup `/opt/platforma-deploy-backups/20260604T114741Z-sminex-dedupe/platforma.sql.gz`.
- Production: `/opt/platforma` fast-forwarded до `24b2185`, затем до `14f9732`; `api` пересобран и перезапущен через `docker compose -f docker-compose.prod.yml up -d --build api`.
- Production Sminex source `28bae656-f2d2-4750-8742-c7dae2954245`: preview/run после первого коммита давали `unitsParsed=1425`, первый run заархивировал `478` строк; после кластеризации preview давал `unitsParsed=1390`, `archived=35`, следующий run убрал оставшийся хвост.
- Production final SQL: active Sminex duplicate signatures `0`, extra rows `0`; `Дом «Палашёвский 11»` имеет `feed_units_count=49`, active units `49`, buildings только `Палашёвский 11`.
- Production health: `api`, `postgres`, `redis`, `minio` healthy; local/public API `/health` ok; public web `/` вернул `200`.

Ручная проверка:

- После production deploy и Sminex run открыть `dom-palashyovskij-11`: `feed_units_count` должен снизиться с 98 до 49, заголовок группы должен быть `Палашёвский 11`, строки квартир №1/18/34 должны быть без парных дублей.
- Проверить остальные затронутые Sminex объекты: `Тишинский бульвар`, `LIFE TIME`, `Лаврушинский`, `Ильинка 3/8`, `Чистые Пруды`, `Достижение`, `Обыденский 1`.

## 2026-06-04 - Production Sminex feed duplicate diagnosis

Задача:

- Проверить production-жалобу: в объектах Sminex видны дубли лотов, а в заголовке группы у `Палашёвский 11` отображается `-, Палашёвский 11`.

Диагностика:

- Production-проверки выполнялись read-only: SQL по `feed_sources`, `feed_source_mappings`, `feed_import_runs`, `feed_units`, `feed_residential_unit_details`, `feed_unit_media`; плюс выборочная проверка внешних XML Sminex.
- У Sminex активен один source `index_url` `https://feeds.sminex.com/xml/`, последний успешный run `2026-06-04 10:36 UTC`, `unitsParsed: 1924`.
- `Дом «Палашёвский 11»` подключен через mapping `{"projectNames": ["Палашёвский 11"]}` и имеет `feed_units_count = 98`.
- Для `Палашёвский 11` найдено 49 duplicate signatures: 98 активных строк вместо 49 уникальных лотов. Пример: `000110621` приходит как `92759562754a:000110621` из `PLSH_YandexRealty_4194373_.xml` и как `fa577960a2d7:000110621` из `PLSH_Cian_5763981_.xml`; номер квартиры, этаж, комнатность, площадь, цена и срок сдачи совпадают.
- Та же схема затрагивает 8 объектов Sminex: `Тишинский бульвар` 214 лишних строк, `LIFE TIME` 123, `Лаврушинский` 74, `Палашёвский 11` 49, `Ильинка 3/8` 24, `Чистые Пруды` 13, `Достижение` 9, `Обыденский 1` 7.
- Причина `-, Палашёвский 11`: в CIAN XML для этих строк `JKSchema/House/Name` равен `-`; parser кладет это в `FeedUnit.building`, а API группирует заголовок по уникальным `building`.

Рекомендация:

- Добавить dedupe/merge для routed units внутри `index_url` Sminex: группировать по `objectId + raw/un-namespaced externalId` и подтверждать совпадением apartment number, floor, rooms, area, effective price и completion. В merged unit сохранять один стабильный `externalId`, брать осмысленный `building` из Yandex, секцию/номер из более структурированного CIAN, объединять media URL и нормализовать residential title до `Квартира №...`.
- Нормализовать placeholder text вроде `-`/`—`/пустых значений в building/project/house fields, чтобы они не попадали в заголовки групп даже без dedupe.
- После фикса прогнать Sminex preview, затем run: лишние external ids должны уйти из parsed set и автоматически архивироваться штатной логикой `persistFeedImportRun`.

Ручная проверка:

- После фикса открыть `dom-palashyovskij-11`: группа должна показывать `Палашёвский 11` без `-,`, а строки квартир №1/18/34 должны быть по одной.
- Проверить остальные 7 затронутых объектов Sminex на отсутствие пар CIAN/Yandex дублей.

## 2026-06-04 - Production deploy discount lot updates

Задача:

- Залить на production изменения по сортировке скидочной цены и обычной цене за м² в карточке лота.

Деплой:

- Локальная ветка `on-ser` запушена в `origin/on-ser` с `7ec47f7` до `893e335`.
- Production checkout `/opt/platforma` обновлен fast-forward до `893e335`.
- Перед пересборкой создан production backup `/opt/platforma-deploy-backups/20260604T083152Z`: `git-head-before.txt`, `git-log-before.txt`, `compose-ps-before.txt`, `api-health-before.json`, `platforma.sql.gz`.
- Выполнено `docker compose -f docker-compose.prod.yml up -d --build api web`; контейнеры `platforma-api-1` и `platforma-web-1` пересозданы.

Проверки:

- Локально: `pnpm --filter @platforma/api test -- services.test.cjs` - 178/178 passed.
- Локально: `pnpm --filter @platforma/web test -- object-detail-feed-units.test.mjs object-lot-detail-page.test.mjs` - 227/227 passed.
- Локально: `pnpm --filter @platforma/web build` - passed, осталось штатное предупреждение Vite о чанке больше 500 kB.
- Локально: `pnpm --filter @platforma/api build` - passed.
- Production: `docker compose -f docker-compose.prod.yml ps` - `api`, `postgres`, `redis`, `minio` healthy; `web` up.
- Production: `http://127.0.0.1:3000/health` и `https://api.broker.fluffywhite.moscow/health` вернули `status: ok`, `database: ok`, `postgis: true`.
- Production: `http://127.0.0.1:5173/` и `https://broker.fluffywhite.moscow/` вернули `200 OK`.
- Production: хвост логов API без ошибок, `Nest application successfully started`; web слушает `0.0.0.0:5173`.

Ручная проверка:

- Открыть страницу объекта с лотами, раскрыть группу, проверить сортировку по `Цена со скидкой` и жирное выделение только реальной скидки.
- Открыть карточку лота с реальной скидкой и проверить обычную цену за м² в строке `Обычная цена`.

## 2026-06-04 - Lot discount ordinary price per meter

Задача:

- В карточке лота со скидкой добавить к строке обычной цены обычную цену за м² тем же шрифтом и цветом.

Изменения:

- `apps/web/src/objects/ObjectDetailPage.tsx` - строка `Обычная цена` в карточке лота теперь дополнительно показывает `· .../м²`, если у лота есть реальная скидка и можно определить обычную цену за м².
- `apps/web/src/objects/ObjectDetailPage.tsx` - добавлены helpers для обычной цены за м²: сначала используется `unit.pricePerMeter`, затем fallback `unit.price / unit.area`.
- `apps/web/tests/object-lot-detail-page.test.mjs` - расширена регрессия для карточки лота со скидкой.

Проверки:

- `pnpm --filter @platforma/web test -- object-lot-detail-page.test.mjs` - сначала expected fail на новом поле, после правки 227/227 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- Открыть карточку лота с реальной скидкой и проверить, что строка обычной цены показывает обычную цену за м² рядом с обычной ценой, в том же стиле.

## 2026-06-04 - Discount price emphasis and sorting

Задача:

- В таблице лотов выделять жирным реальную цену со скидкой.
- Добавить сортировку по колонке `Цена со скидкой`.

Изменения:

- `apps/web/src/objects/ObjectDetailPage.tsx` - колонка `Цена со скидкой` теперь использует `ObjectFeedSortableHead` с `sortBy=discountPrice`.
- `apps/web/src/objects/ObjectDetailPage.tsx` - значение скидочной цены оборачивается в `<strong>` только когда `hasFeedUnitRealDiscount(unit)` подтверждает скидку ниже базовой цены.
- `apps/api/src/objects/objects.service.ts` - `sortBy=discountPrice` для feed lots мапится на `effectivePrice`, чтобы сортировать по фактической цене с учетом скидки и fallback на обычную цену.
- `apps/web/tests/object-detail-feed-units.test.mjs`, `apps/api/tests/services.test.cjs` - добавлены RED/GREEN регрессии на новый sortable header, жирное выделение и backend `orderBy`.

Проверки:

- `pnpm --filter @platforma/web test -- object-detail-feed-units.test.mjs` - сначала 3 expected fail, после правки 227/227 passed.
- `pnpm --filter @platforma/api test -- services.test.cjs` - сначала 1 expected fail, после правки 178/178 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- Открыть страницу объекта с лотами, раскрыть группу, проверить жирное выделение только у строк с реальной скидкой и сортировку по заголовку `Цена со скидкой`.

## 2026-06-04 - Production slow loading diagnosis and nginx gzip hotfix

Задача:

- Проверить жалобы на медленную загрузку production, хотя раньше интерфейс грузился быстро.

Диагностика:

- Production containers healthy; host load/RAM/disk/IO нормальные: CPU idle высокий, swap 0, IO wait 0.
- Локальные health/web checks внутри сервера отвечали примерно за 5 ms, публичные `/` и `/health` примерно за 0.6 s с учетом TLS/сети.
- Основные приватные endpoints после авторизации быстрые: `/objects?limit=24` около 0.10-0.12 s через public API после gzip, справочники `/developers`, `/locations`, `/metro` около 0.04-0.05 s.
- Медленный кандидат найден в `/map/objects?limit=500`: endpoint возвращал 299 объектов с координатами и 4702 `object_images` records, потому что `MapService` сериализует всю галерею каждого объекта для popup previews.
- До hotfix public `/map/objects?limit=500` отдавался без сжатия: `Content-Length` около 4.5 MB, TTFB около 1.1 s.
- В nginx `gzip on`, но `gzip_types` был закомментирован, поэтому `application/json` не сжимался.

Production hotfix:

- На production сделан backup `/etc/nginx/nginx.conf.bak-20260604-0729-platforma-gzip`.
- В `/etc/nginx/nginx.conf` включены `gzip_vary`, `gzip_proxied`, `gzip_comp_level`, `gzip_buffers`, `gzip_http_version` и `gzip_types` для `application/json`, JS/CSS/XML.
- `nginx -t` успешен, выполнен `systemctl reload nginx`.

Проверки:

- После reload `/map/objects?limit=500` с `Accept-Encoding: gzip` возвращает `Content-Encoding: gzip`.
- Сетевой размер `/map/objects?limit=500` уменьшился примерно с 4.5 MB до 0.9 MB.
- Остальные API checks после gzip успешны: `/objects`, `/developers`, `/locations`, `/metro`.

Рекомендация:

- Сделать кодовый performance-fix для карты: не отдавать всю галерею всех объектов в `/map/objects`, а возвращать только `coverImage` или лениво подгружать галерею выбранного объекта. Оценка по production response: `coverOnly` уменьшает JSON примерно до 0.95 MB raw / 0.14 MB gzip.

## 2026-06-04 - Admin gallery batch upload concurrency

Задача:

- Разобрать жалобы того же сотрудника на общую медленность платформы во время загрузки фотографий в разные ЖК.

Диагностика:

- Production-аудит показал, что проблема проявляется именно в рабочих upload-сессиях галереи: например, `Клубный дом OPUS (Опус)` грузился 29 фото за ~303 s и 39 фото за ~385 s, то есть около 10 s на файл.
- Серверные ресурсы в момент проверки были нормальными; многие другие пачки того же пользователя проходили быстро, поэтому это не постоянная деградация CPU/RAM/DB.
- Frontend `uploadGalleryDraftFiles()` загружал новые изображения строго последовательно, а API для каждого файла синхронно сохраняет оригинал и генерирует 3 image variants через `sharp`.

Изменения:

- `apps/web/src/admin/ObjectsAdminPage.tsx` - загрузка новых файлов галереи переведена на ограниченный параллелизм `galleryUploadConcurrency = 3`; финальный `gallery/batch`, порядок draft items и cleanup staged files сохранены.
- `apps/web/tests/admin-gallery-state.test.mjs` - обновлена регрессия на bounded concurrency перед финальным сохранением layout.

Проверки:

- `pnpm --filter @platforma/web test -- admin-gallery-state.test.mjs` - фактически прогнал весь текущий web test suite, 227/227 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Production `/opt/platforma` fast-forwarded to `c73f643`; rebuilt and restarted `api` and `web` via `docker compose -f docker-compose.prod.yml up -d --build api web`.
- Post-deploy checks: `api` container healthy, `web` container up, local API `/health` `200` за ~13 ms, public API `/health` `200` за ~130 ms, public web `/` `200` за ~63 ms.
- Production web bundle contains the updated gallery upload progress text `Загружено изображений`; fresh API logs after restart show normal Nest startup without errors in the checked window.

Ручная проверка:

- После deploy загрузить пачку 20-40 фото в админке объекта и убедиться, что прогресс идет быстрее и интерфейс не выглядит зависшим на одном файле.

## 2026-06-04 - Production OPUS gallery empty-save diagnosis

Задача:

- Проверить жалобу сотрудника: при загрузке фотографий в `Клубный дом OPUS (Опус)` кажется, что ничего не сохраняется.

Диагностика:

- Production-данные не менялись; выполнялись только read-only SSH/SQL/log checks.
- Объект `klubnyj-dom-opus` найден на production, текущих `object_images` у него 0.
- Audit log показал, что `2026-06-04 06:46 UTC` пользователь `seethers@yandex.ru` успешно сохранил 29 фото через `object.gallery.batch`, а `2026-06-04 07:00 UTC` тот же пользователь из того же браузера отправил пустой `object.gallery.batch`, который удалил все 29 изображений.
- Аналогичная последовательность у `Опус` была `2026-06-04 06:35 UTC` -> 29 фото и `2026-06-04 06:40 UTC` -> пустая галерея.
- Загруженные `files` после пустого batch отсутствуют в текущей БД: backend удаляет unlinked gallery files после удаления `object_images`.
- За последние 7 дней найдены другие пустые destructive `object.gallery.batch` у того же пользователя; на момент проверки текущих фото нет у `klubnyj-dom-opus` и `famous`.
- Вероятная причина в UI: кнопка `Управлять галереей` на странице редактирования не блокируется во время `isLoading`, `openGalleryModal()` строит draft из `object?.images ?? []`, а пустой draft можно сохранить; backend трактует пустой layout как удаление всей текущей галереи.

Рекомендация:

- Добавить frontend guard: не открывать/не сохранять галерею до загрузки `object`, блокировать пустой destructive save без явного подтверждения.
- Добавить backend/API guard или явный флаг подтверждения для batch, который удаляет все существующие изображения без новых/staged/existing items.
- Для восстановления фото `Опус` нужны свежие backup/WAL/MinIO snapshots или повторная загрузка: в текущих production tables файлы уже удалены.

## 2026-06-03 - Catalog directory filter reload stability

Задача:

- Убрать моргание и подергивание экрана при кликах по нескольким выбранным пунктам в справочных dropdown-фильтрах каталога.

Изменения:

- `apps/web/src/catalog/CatalogPage.tsx` - `CatalogListView` больше не заменяет текущую выдачу на full loading panel во время фоновой перезагрузки фильтров; loading panel показывается только при первичной загрузке/очищенных результатах.
- `apps/web/tests/catalog-quick-links-page.test.mjs` - добавлена регрессия на то, что текущие результаты остаются видимыми во время перезагрузки справочных фильтров.

Проверки:

- `pnpm --filter @platforma/web test -- catalog-quick-links-page.test.mjs` - сначала RED на старом `if (isLoading)`, после фикса 227/227 passed.
- `pnpm --filter @platforma/web test -- catalog-directory-filter-search.test.mjs` - 227/227 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- В `/catalog` выбрать несколько значений в справочном dropdown и убедиться, что область выдачи не моргает loading-блоком и не дергает страницу при каждом клике.

## 2026-06-03 - Catalog directory filter multiselect bugfixes

Задача:

- Исправить два бага мультиселекта в справочных фильтрах каталога: dropdown прокручивался к началу после выбора пункта, а при двух и более выбранных значениях API возвращал `Developer/Location/Area/Metro station is invalid`.

Изменения:

- `apps/web/src/catalog/CatalogPage.tsx` - при toggle пункта больше не очищается поисковая строка и не вызывается повторный focus на поле поиска, чтобы scroll dropdown не прыгал к началу.
- `apps/api/src/objects/objects.service.ts`, `apps/api/src/map/map.service.ts` - CSV-фильтры id перед разбором нормализуют query-значение, чтобы принимать значения из `URLSearchParams` с encoded comma `%2C`, double-encoded значения и повторные query-параметры.
- `apps/web/tests/catalog-directory-filter-search.test.mjs`, `apps/api/tests/services.test.cjs` - добавлены регрессии на сохранение позиции dropdown, encoded/double-encoded CSV и повторные query-параметры для нескольких id.

Проверки:

- `pnpm --filter @platforma/web test -- catalog-directory-filter-search.test.mjs` - сначала RED на scroll-регрессию, после фикса 226/226 passed.
- `pnpm --filter @platforma/api test -- services.test.cjs` - сначала RED на encoded/double-encoded CSV и repeated query values, после фикса 178/178 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- В `/catalog` открыть dropdown любого из полей `Застройщик`, `Район`, `Окружение`, `Метро`, прокрутить вниз, выбрать пункт и убедиться, что список не возвращается к началу.
- Выбрать два и более значения в каждом справочном фильтре и убедиться, что ошибки `... is invalid` больше не появляются, а выдача обновляется.

## 2026-06-03 - Catalog directory filter multiselects

Задача:

- Разрешить выбирать несколько пунктов в поисковых фильтрах каталога `Застройщик`, `Район`, `Окружение`, `Метро`.

Изменения:

- `apps/web/src/catalog/CatalogPage.tsx` - searchable dropdown справочных фильтров переведен на мультивыбор; выбранные id нормализуются в CSV-строку в прежних query/API параметрах.
- `apps/api/src/objects/objects.service.ts` - фильтры каталога `developerId`, `locationId`, `areaId`, `metroStationId` принимают одиночный id или CSV-список id и строят Prisma-фильтры через `in` для нескольких значений.
- `apps/api/src/map/map.service.ts` - такая же поддержка CSV-списков добавлена для фильтров объектов на карте.
- `apps/web/tests/catalog-directory-filter-search.test.mjs`, `apps/api/tests/services.test.cjs` - добавлены/обновлены регрессии на мультивыбор и CSV-фильтры.

Проверки:

- `pnpm --filter @platforma/web test -- catalog-directory-filter-search.test.mjs` - 226/226 passed.
- `pnpm --filter @platforma/api test -- services.test.cjs` - 176/176 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- `git diff --check` - без whitespace-ошибок.
- Browser visual QA не выполнена полноценно: доступные Browser tools показали только `about:blank` и не дали инструментов для DOM-кликов/скриншота каталога.

Ручная проверка:

- В `/catalog` раскрыть фильтры, выбрать несколько значений в каждом из полей `Застройщик`, `Район`, `Окружение`, `Метро`, убедиться, что меню не закрывается после выбора и URL содержит CSV в соответствующем параметре.
- Проверить, что выдача каталога и карта учитывают несколько значений внутри одного фильтра как `любой из выбранных`.

## 2026-06-03 - Catalog directory filter searchable dropdowns

Задача:

- Добавить поиск внутри выпадающих фильтров каталога для полей `Застройщик`, `Район`, `Метро`, `Окружение`, как в админских ссылках каталога.

Изменения:

- `apps/web/src/catalog/CatalogPage.tsx` - четыре справочных фильтра каталога переведены с native `<select>` на локальный searchable dropdown с нормализованным поиском, ограничением выдачи до 24 вариантов, сбросом через пункт `Все ...` и сохранением прежних query/API параметров.
- `apps/web/tests/catalog-directory-filter-search.test.mjs` - добавлена регрессия на searchable dropdown для `developerId`, `locationId`, `areaId`, `metroStationId` и отсутствие старых native select в этих полях.

Проверки:

- `pnpm --filter @platforma/web test -- catalog-directory-filter-search.test.mjs` - сначала expected failure на новом тесте, после правки весь текущий web test suite прошел: 226/226 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Browser visual QA не выполнена: Browser plugin runtime поднялся, но список browser targets пустой (`agent.browsers.list()` вернул `[]`, `iab` недоступен).

Ручная проверка:

- Открыть `/catalog`, раскрыть фильтры и проверить поиск/выбор/сброс в полях `Застройщик`, `Район`, `Окружение`, `Метро`.
- Проверить, что после выбора фильтра URL обновляется теми же параметрами и выдача каталога фильтруется.

## 2026-06-03 - Production lot gallery thumbnails deploy

Задача:

- Задеплоить исправление миниатюр галереи на странице отдельного лота.

Действия:

- `6186262 fix(web): place lot gallery thumbnails below media` запушен в `origin/on-ser`.
- На production `/opt/platforma` выполнен fast-forward pull `07220ee..6186262`.
- Выполнен `docker compose -f docker-compose.prod.yml up -d --build web`; compose пересоздал `web` и `api`.

Проверки:

- `docker compose -f docker-compose.prod.yml ps` - `api` healthy, `web` up, `postgres`/`redis`/`minio` healthy.
- `GET http://127.0.0.1:3000/health` и `GET https://api.broker.fluffywhite.moscow/health` - `status=ok`, `database=ok`, `postgis=true`.
- `GET https://broker.fluffywhite.moscow/` отдает CSS asset `/assets/index-CDtAFUhq.css`.
- Production CSS содержит lot gallery правила `object-lot-media-carousel`, `display:flex`, `flex-direction:column`.
- Свежий API log после restart: `Scheduled feed import cycle finished: sources=9, previewed=9, runsQueued=9, skipped=0, failed=0`.

Ручная проверка:

- Открыть production страницу лота с несколькими media, сделать hard refresh и проверить, что миниатюры расположены под изображением.

## 2026-06-03 - Lot gallery thumbnails below media

Задача:

- Опустить миниатюры галереи на странице отдельного лота ниже контейнера изображения, чтобы они не перекрывали планировку/фото.

Изменения:

- `apps/web/src/styles.css` - lot media carousel переведен в вертикальный flex-flow; активный media stage стал обычным flex-элементом, а `object-lot-thumbnail-zone` вынесена в отдельную строку под stage с явным `relative`-позиционированием.
- `apps/web/tests/object-lot-detail-page.test.mjs` - добавлена регрессия на то, что thumbnails отдельного лота не наследуют глобальное overlay-позиционирование общей галереи.

Проверки:

- `pnpm --filter @platforma/web test -- object-lot-detail-page.test.mjs` - сначала expected failure на новом тесте, после CSS-правки 225/225 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Playwright visual QA на локальном лоте `zhiloj-kompleks-aura/lots/4a00f84d-5d32-4944-8d20-848a25e16a41`: desktop `overlapsStage=false`, mobile `overlapsStage=false`; `.object-lot-media-stage`, `.object-lot-thumbnail-zone` и `.carousel-thumbnails` рендерятся как `position: relative`.

Ручная проверка:

- Открыть production страницу лота с несколькими media и убедиться, что миниатюры идут под изображением, а не поверх нижней части планировки/фото.

## 2026-06-03 - Production favicon deploy

Задача:

- Задеплоить favicon на production.

Действия:

- `d49af38 feat(web): add favicon` запушен в `origin/on-ser`.
- На production `/opt/platforma` выполнен fast-forward pull до `d49af38`.
- Выполнен `docker compose -f docker-compose.prod.yml up -d --build web`; из-за compose dependency graph пересоздались `web` и `api`.

Проверки:

- `docker compose -f docker-compose.prod.yml ps` - `web` up, `api` healthy, `postgres`/`redis`/`minio` healthy.
- `GET http://127.0.0.1:3000/health` и `GET https://api.broker.fluffywhite.moscow/health` - `status=ok`, `database=ok`, `postgis=true`.
- `GET https://broker.fluffywhite.moscow/` содержит `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`.
- `GET https://broker.fluffywhite.moscow/favicon.svg` - `200`, `image/svg+xml`, `54273` bytes; checksum совпадает с `apps/web/public/favicon.svg`.
- После API restart production feed scheduler завершил цикл: `sources=9, previewed=9, runsQueued=9, skipped=0, failed=0`; свежих pending runs после ожидания не осталось.

Ручная проверка:

- Открыть `https://broker.fluffywhite.moscow/`, сделать hard refresh и проверить иконку вкладки.

## 2026-06-03 - Web favicon

Задача:

- Сделать favicon из существующего `_Fluffy_White_1-02.svg`.

Изменения:

- `apps/web/public/favicon.svg` - добавлен public favicon на основе существующего SVG-логотипа.
- `apps/web/index.html` - подключен favicon через `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`.

Проверки:

- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Проверено, что `apps/web/dist/favicon.svg` появляется после сборки.

Ручная проверка:

- Открыть приложение в браузере и проверить иконку вкладки; если белый SVG плохо виден на светлой теме браузера, сделать отдельную favicon-версию с темным фоном.

## 2026-06-03 - Production rebuild after latest patches

Задача:

- Довезти последние патчи на production, потому что изменения не были видны в интерфейсе.

Диагностика:

- Production `/opt/platforma` был на `1bdc4a5`, а локальная ветка `on-ser` была на `82bf0bd`.
- `origin/on-ser` сначала был на `4dfd763`; локальный `82bf0bd` не был запушен.
- Production `.env` использует `broker.fluffywhite.moscow` и `api.broker.fluffywhite.moscow`; домен `.ru` отвечает другим старым HTML.

Действия:

- Запушен `on-ser` в `origin` до `82bf0bd`.
- На production выполнен fast-forward pull `1bdc4a5..82bf0bd`.
- Пересобраны и пересозданы production контейнеры `api` и `web` через `docker compose -f docker-compose.prod.yml up -d --build api web`.

Проверки:

- `docker compose -f docker-compose.prod.yml ps` - `api` healthy, `web` up, `postgres`/`redis`/`minio` healthy.
- `GET http://127.0.0.1:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- `GET https://api.broker.fluffywhite.moscow/health` - `status=ok`, `database=ok`, `postgis=true`.
- `GET https://broker.fluffywhite.moscow/` - `200 OK`, отдает production HTML с новым CSS asset.
- API log подтвердил scheduler: `Scheduled feed import cycle finished: sources=9, previewed=9, runsQueued=9, skipped=0, failed=0`.
- Production DB показала свежие feed runs после рестарта: preview `success/partial`, run `success/partial`, без pending за последние 10 минут на момент проверки.

Ручная проверка:

- Открыть `https://broker.fluffywhite.moscow/`, при необходимости сделать hard refresh из-за браузерного кеша.
- Проверить страницу лота `/objects/:slug/lots/:unitId` и галереи в светлой/темной теме.
- Проверить `/admin/feeds`, что новые preview/run появились после production scheduler.

## 2026-06-03 - Theme-aware gallery backgrounds

Задача:

- Сделать фон галерей соответствующим активной теме: в темной теме оставить темный фон, в светлой использовать светлый.

Изменения:

- `apps/web/src/app-theme.css` - добавлены theme variables для gallery backdrop/surface/stage и переопределения для object carousel lightbox, lot media carousel, feed media carousel/fullscreen.
- `apps/web/tests/app-theme.test.mjs` - добавлена регрессия на theme-aware фоны галерей.

Проверки:

- `pnpm --filter @platforma/web test -- app-theme.test.mjs` - сначала expected failure на отсутствующих gallery theme variables/overrides, после правки 224/224 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Browser visual QA не выполнена: Browser plugin target list пустой, `iab` недоступен. Локальные web/API процессы при этом слушают `5173` и `3000`.

Ручная проверка:

- Открыть страницу лота и объектную галерею в `theme=d` и `theme=c`.
- В светлой теме проверить фон вокруг `contain`-изображений, thumbnails zone и lightbox/fullscreen.
- В темной теме проверить, что фон остался темным как раньше.

## 2026-06-03 - Local API dev auth repair

Задача:

- Восстановить локальный вход `admin@example.com` после того, как frontend на `localhost:5173` показывал ошибку проверки email/password.

Диагностика:

- Frontend был запущен и ходил в `VITE_API_URL=http://localhost:3000`.
- API на `localhost:3000` не был запущен; из-за этого в web log были `Failed to fetch` на `/auth/refresh`.
- После запуска API прямой login показал, что локальный admin password hash не совпадал с ожидаемым dev-паролем.

Изменения:

- Запущен локальный API в `screen`-сессии `platforma-api`; лог: `/tmp/platforma-api.log`.
- В ignored local env `apps/api/.env` восстановлено ожидаемое значение `ADMIN_PASSWORD`.
- В локальной Postgres DB обновлен password hash пользователя `admin@example.com`.

Проверки:

- `GET http://localhost:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- `POST http://localhost:3000/auth/login` для `admin@example.com` с ожидаемым dev-паролем - `200 OK`.
- Login со старым неверным значением - `401 Unauthorized`.

## 2026-06-03 - Object lot split card layout

Задача:

- Перестроить карточку отдельного лота по выбранному варианту A: галерея слева, паспорт характеристик справа.
- Показывать `Цена со скидкой` только когда `discountPrice` реально меньше обычной `price`; иначе показывать просто `Цена`.

Изменения:

- `apps/web/src/objects/ObjectDetailPage.tsx` - страница лота теперь рендерит единый `object-lot-split-card` с media panel и info panel; статус перенесен в правую колонку.
- `apps/web/src/objects/ObjectDetailPage.tsx` - добавлены `hasFeedUnitRealDiscount()` и `getObjectLotPriceSummary()` для строгой логики отображения скидки.
- `apps/web/src/styles.css` - добавлены стили двух равных колонок, правой паспортной колонки с пунктирными линиями и мобильного stacking.
- `apps/web/tests/object-lot-detail-page.test.mjs` - обновлены проверки layout и условия показа скидочной цены.
- `docs/superpowers/plans/2026-06-03-lot-card-split-layout.md` - сохранен рабочий implementation plan.

Проверки:

- `pnpm --filter @platforma/web test -- object-lot-detail-page.test.mjs` - сначала expected failures на отсутствующем split layout и discount helper, после правки 223/223 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- Открыть `/objects/:slug/lots/:unitId` и проверить desktop/mobile layout.
- Проверить лот с реальной скидкой: справа должно быть `Цена со скидкой` и строка `Обычная цена`.
- Проверить лот без скидки, с равной скидочной ценой или с большей скидочной ценой: справа должно быть только `Цена`.
- Проверить лот без медиа и лот с несколькими медиа.

## 2026-06-02 - Object lot feed update timestamp

Задача:

- В блоке лотов на странице объекта показать мелкую строку с временем последнего обновления лотов ЖК.

Изменения:

- `apps/web/src/objects/ObjectDetailPage.tsx` - под заголовком `Лоты` добавлен вывод `Обновлено: DD.MM.YYYY HH:mm` из существующего `object.feedUpdatedAt`; если дата отсутствует или некорректна, строка не отображается.
- `apps/web/src/styles.css` - добавлены компактные стили для подписи обновления.
- `apps/web/tests/object-detail-feed-units.test.mjs` - добавлена RED/GREEN проверка на вывод подписи и форматтер даты.

Проверки:

- `pnpm --filter @platforma/web test -- object-detail-feed-units.test.mjs` - сначала expected failure на отсутствующей подписи, после правки 221/221 passed.
- `pnpm --filter @platforma/web build` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- Открыть страницу объекта с импортированными лотами и проверить строку под заголовком `Лоты` в светлой и темной теме.

## 2026-06-02 - Production feed auto preview and conditional run

Задача:

- На production автоматически запускать preview активных feed sources каждые 2 часа.
- Если preview показывает изменения, автоматически запускать run фида.

Изменения:

- `apps/api/src/feeds/feeds.service.ts` - добавлен production-only scheduler без новых зависимостей: при старте API запускает первый цикл, затем повторяет каждые 2 часа.
- Scheduler берет активные не удаленные `FeedSource`, последовательно запускает preview и ставит run в существующую очередь только если preview summary содержит изменения: `created`, `updated`, `archived` или новые/обработанные media counters.
- Scheduler пропускает источник, если по нему уже идет ручной/автоматический preview/run, и не запускает run после failed preview.
- `apps/api/tests/feeds-module.test.cjs` - добавлены RED/GREEN регрессии на conditional run, overlap guard и production lifecycle таймера.

Проверки:

- `pnpm --filter @platforma/api test -- feeds-module` - сначала expected failures на отсутствующих scheduler methods и failed-preview counter, после правки 174/174 passed.

Ручная проверка:

- После deploy production проверить `docker compose -f docker-compose.prod.yml logs --since ... api` на строку `Scheduled feed import cycle finished`.
- В `/admin/feeds` проверить появление PREVIEW runs и RUN только для источников с изменениями.

## 2026-06-02 - Feed discounts and grouped lot table update

Задача:

- Для активных production feed sources закрепить парсинг обычной цены, цены со скидкой и срока сдачи.
- На странице объекта в grouped list лотов заменить колонку `План` на `Медиа`, добавить `Цена со скидкой` после `Цена`, считать `За м²` от effective/discount price и не раскрывать группы автоматически при загрузке.

Production-инвентаризация:

- Production проверен в режиме чтения, application code и данные на сервере не менялись.
- Активные не удаленные источники фидов: 9.
- Активные форматы: `CIAN_XML`, `YANDEX_REALTY`, `FSK_XML`, `TEKTA_XML`.
- Production и локальный workspace на одном commit `57e058b`.
- В production feed units уже есть скидки у `YANDEX_REALTY`, `TEKTA_XML` и части index-источников MR Group, а сроки сдачи заполнены у `YANDEX_REALTY`, `FSK_XML`, части `CIAN_XML` и Tekta Twelve.

Изменения:

- `tools/feed-import/src/index.ts` - CIAN parser теперь читает скидочную цену из common discount fields и срок сдачи из `JKSchema.House.Deadline.Date`; FSK parser хранит базовую `Price_tot` как `price`, а меньшую `Price_tot_sale` как `discountPrice`, сохраняя старый fallback, когда есть только sale-поля.
- `tools/feed-import/tests/parser.test.cjs` - добавлены RED/GREEN регрессии на CIAN discount/house deadline и FSK base/sale price.
- `apps/web/src/objects/ObjectDetailPage.tsx` - grouped lots больше не раскрываются автоматически после загрузки; `Медиа` перенесена на место `План`; после `Цена` добавлена `Цена со скидкой`; `Цена` показывает базовую цену, скидочная колонка использует `discountPrice ?? price`, `За м²` остается от effective price.
- `apps/web/tests/object-detail-feed-units.test.mjs` - обновлены регрессии grouped lots под свернутое состояние и новый порядок/смысл колонок.
- `docs/superpowers/plans/2026-06-02-feed-discount-lot-table-implementation.md` - добавлен рабочий implementation plan с чекбоксами.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверки:

- `pnpm --filter @platforma/feed-import test -- parser` - сначала 2 expected fail, после правки 55/55 passed.
- `pnpm --filter @platforma/web test -- object-detail-feed-units` - сначала 4 expected fail, после правки 220/220 passed.
- `pnpm --filter @platforma/feed-import test` - 55/55 passed.
- `pnpm --filter @platforma/api test -- api-contract services` - 171/171 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- Открыть объект с лотами и проверить, что при загрузке все сроки/комнатности свернуты.
- Раскрыть группу вручную и проверить порядок колонок: `Медиа`, `Корпус`, `Секц.`, `Эт.`, `Номер квартиры`, `Площадь`, `Цена`, `Цена со скидкой`, `За м²`, `Статус`.
- На лотах без скидки проверить, что `Цена` и `Цена со скидкой` одинаковые.
- После deploy/run feed imports на production проверить несколько объектов Tekta, Forma/Yandex, FSK и CIAN index sources.

## 2026-06-02 - Tekta Era feed field map

Задача:

- Дать полный список полей фида `https://tekta.ru/xml/era/Era.xml` и сопоставить их с текущим `TektaXmlFeedParser`.

Диагностика:

- Свежий XML успешно скачан; размер около 5.86 MB, `last-modified: Tue, 02 Jun 2026 09:39:09 GMT`.
- Фид содержит 1 проект, 6 корпусов, 30 account-записей, 2048 квартир, 16 commerce-записей, 63 `mhmts`, 238 кладовок и 387 машиномест.
- Текущий `TektaXmlFeedParser` импортирует только `projects.project.flats.flat` и ожидаемый путь `projects.project.offices.office`; в Era-фиде `offices.office` отсутствует.
- `commerces.commerce`, `mhmtses.mhmts`, `pantries.pantry`, `parkings.parking`, `korpuses.korpus` и `accounts.account` текущим parser'ом не нормализуются в `FeedUnit`.
- Все поля импортированной квартиры сохраняются в `rawPayload`; типизированно раскладывается только часть полей.

Изменения:

- `docs/TEKTA_ERA_FEED_FIELD_MAP.md` - добавлена карта полей Tekta Era с описанием и parser mapping.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

## 2026-06-02 - Tekta Era discount price inspection

Задача:

- Проверить, отдает ли фид `https://tekta.ru/xml/era/Era.xml` цену со скидкой.

Диагностика:

- В фиде 2048 `flat`, из них 1041 с активными для продажи/бронирования статусами.
- Основная цена есть в `IntCost` для всех 2048 лотов.
- Скидочная цена для сайта есть в `IntDiscountedCostForSite`; найдено 61 лот со скидкой во всем фиде и 33 активных лота со скидкой.
- Скидочная цена за м² есть в `IntDiscountedPriceForSite`; количество совпадает с `IntDiscountedCostForSite`.
- Размер скидки также отдается в `IntDiscountSiteRub` и `IntDiscountSitePercentage`.
- Текущий `TektaXmlFeedParser` уже читает `IntDiscountedCostForSite` как `discountPrice`, `IntDiscountedPriceForSite` как `discountPricePerMeter`, а `effectivePrice` берет скидочную цену при наличии.
- `IntConclusionContractPriceCost` тоже часто меньше `IntCost`, но текущий parser его не использует как скидку; это похоже на отдельную договорную/контрактную цену, особенно часто у проданных лотов.

Изменения:

- Application code не менялся.
- `docs/CODEX_LOG.md` - добавлена текущая запись о диагностике.

## 2026-06-02 - Tekta Era feed media and completion inspection

Задача:

- Детально проверить фид `https://tekta.ru/xml/era/Era.xml`: отдает ли он media и срок сдачи.

Диагностика:

- Фид успешно скачан, размер около 5.86 MB, корень XML: `<projects>`.
- Структура распознана текущим CLI как `TEKTA_XML`; `analyze` нашел 2040 импортируемых юнитов, `warningsCount=0`.
- В сыром XML найдено 2048 непустых `IntLayoutCode`, но все значения являются внутренними UNC-путями `\\crm-storage\CRM\Era\...`, а не публичными `http(s)` URL.
- В сыром XML нет публичных media URL, кроме `IntProjectSite=http://era.center/`; `IntLinkPhoto` и `IntProjectPhoto` пустые.
- `IntEstimatedCompletionDate` и `IntTermLeaseAgreement` присутствуют на уровне проекта, но пустые.
- Прямой прогон `TektaXmlFeedParser` по скачанному XML вернул `mediaItems=0`, `completionUnits=0`.

Изменения:

- Application code не менялся.
- `docs/CODEX_LOG.md` - добавлена текущая запись о диагностике.

Вывод:

- Фид отдает планировки только как внутренние пути `crm-storage`, которые importer не может скачать как media.
- Срок сдачи в этом фиде не отдается в заполненном виде; текущий parser берет Tekta-срок из `IntEstimatedCompletionDate`.

## 2026-06-02 - Local auth server diagnosis

Задача:

- Разобраться, почему локальный сервер показывает ошибку неверного пароля при входе.

Диагностика:

- `localhost:5173` отвечал как Vite web server, но `localhost:3000` сначала не слушал API.
- Запущен `pnpm dev:api`; NestJS успешно смонтировал auth routes и другие backend routes.
- `GET /health` после запуска API вернул `status=ok`, `database=ok`, `postgis=true`.
- Прямой `POST /auth/login` с `ADMIN_EMAIL`/`ADMIN_PASSWORD` из `apps/api/.env` вернул `200`, активного пользователя с ролью `admin` и access token.

Изменения:

- Application code не менялся.
- `docs/CODEX_LOG.md` - добавлена текущая запись о диагностике.

Вывод:

- Причина была в том, что локальный API на `3000` не был запущен; frontend показывал общий текст ошибки входа.

## 2026-06-02 - Registration password activation flow

Задача:

- Изменить регистрацию: пароль задается сразу в форме, письмо активирует аккаунт по ссылке, пароль в письме не отправляется.

Изменения:

- `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/styles.css` - регистрация теперь показывает email, `Придумайте пароль`, `Подтвердите пароль`, чекбокс показа пароля; `auth_token` из письма подтверждается автоматически.
- `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/mail.service.ts`, `apps/api/src/auth/auth.types.ts`, `packages/shared/src/index.ts` - `register/request` принимает пароль и сохраняет argon2-хеш для `INVITED` пользователя; `register/verify` активирует пользователя по token/code без пароля; письмо содержит только ссылку активации.
- `apps/api/tests/api-contract.test.cjs`, `apps/api/tests/services.test.cjs`, `apps/web/tests/login-copy.test.mjs` - обновлены регрессии под новый auth flow и запрет старого поля кода в форме.
- `docs/API_AND_DATA.md`, `docs/PAGES_AND_ROUTES.md`, `docs/FEATURE_MAP.md`, `docs/STATE_AND_LOGIC.md`, `docs/RISK_ZONES.md` - обновлены auth-контракты, route/state/risk описания.

Проверки:

- `pnpm --filter @platforma/web exec node --test tests/login-copy.test.mjs` - сначала fail на старом UI/контракте, после правки 3/3 passed.
- `pnpm --filter @platforma/api test -- api-contract services` - сначала fail на старом API/сервисе, после правки 171/171 passed; повторный финальный прогон 171/171 passed.
- `pnpm --filter @platforma/web test` - 220/220 passed.
- `pnpm build:api` - successful.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Visual fallback через Playwright на `http://127.0.0.1:5174/login` и `?theme=c`: форма регистрации содержит 3 поля, не содержит `registration-code`, toggle меняет password type на text, темная тема использует `dark-premium` цвета.

Ограничения:

- Browser plugin не смог подключиться к in-app browser: `Browser is not available: iab`; визуальная проверка выполнена через Playwright fallback.
- В локальной visual-проверке API не был поднят, поэтому консоль показывала ожидаемый failed refresh к `localhost:3000/auth/refresh`.

## 2026-06-02 - Dark theme grouped lots contrast

Задача:

- Исправить белые поверхности и плохо читаемый текст в grouped list лотов в темной теме.

Изменения:

- `apps/web/src/styles.css` - grouped lot list переведен с жестких светлых цветов на `--app-theme-*` токены для summary rows, фильтров, таблицы, строк, media preview, статусов, skeleton/error/empty states.
- `apps/web/tests/object-detail-feed-units.test.mjs` - добавлена регрессия, запрещающая прямые белые фоны и темный текст в grouped lot surfaces.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверки:

- `pnpm --filter @platforma/web test -- object-detail-feed-units` - сначала fail на старом CSS, после правки 220/220 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Rendered fallback через Playwright: темная тема `dark-premium`, проверены computed styles для grouped list; белые фоны не обнаружены, скрин `/tmp/platforma-dark-lots-check.png`.

## 2026-06-02 - Gallery navigation static active state

Задача:

- Исправить прыжок кнопок переключения при нажатии во всех галереях.

Изменения:

- `apps/web/src/app-theme.css` - расширено `:active`-исключение для навигационных кнопок галерей, чтобы centered-кнопки сохраняли `transform: translateY(-50%)` при нажатии.
- `apps/web/tests/object-detail-styles.test.mjs` - обновлен регрессионный тест на обычную карусель, lightbox, карту, feed media carousel и fullscreen media navigation.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверки:

- `pnpm --filter @platforma/web exec node --test tests/object-detail-styles.test.mjs` - сначала fail на старом CSS, после правки 12/12 passed.
- `pnpm --filter @platforma/web test` - 219/219 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Rendered fallback через Playwright на `http://localhost:5173`: для `.carousel-button`, `.carousel-modal-button`, `.map-object-card-gallery-button`, `.object-feed-media-carousel-nav`, `.object-feed-media-fullscreen-nav` при зажатом клике `topDelta=0`, `leftDelta=0`.

Ограничения:

- Browser plugin не смог подключиться к in-app browser: `Browser is not available: iab`; визуальная проверка выполнена через Playwright fallback.

## 2026-06-01 - Lot grouped list implementation

Задача:

- Реализовать grouped list лотов на странице объекта по `docs/superpowers/specs/2026-06-01-lot-grouped-list-design.md`.

Изменения:

- `packages/shared/src/index.ts` - добавлены контракты `FeedUnitRoomGroupSummary`, `FeedUnitGroupSummary`, `FeedUnitGroupsResponse`.
- `apps/api/src/objects/objects.controller.ts` - добавлен `GET /objects/:id/feed-units/groups` с permission `objects:read`.
- `apps/api/src/objects/objects.controller.ts` - добавлен fallback для `:unitId === "groups"`, чтобы `GET /objects/:id/feed-units/groups` не попадал в обработчик одного лота при фактическом порядке matching routes.
- `apps/api/src/objects/objects.service.ts` - добавлена grouped-выборка лотов без page pagination, переиспользование фильтров, группировка по сроку сдачи и комнатности, агрегаты площадей/цен по всем отфильтрованным лотам.
- `apps/web/src/objects/ObjectDetailPage.tsx` - flat lot table заменена на grouped view: группы срока сдачи, строки комнатности, раскрытие первой группы, `Показать еще` по 20 лотов, новые колонки `План`, `Корпус`, `Секц.`, `Эт.`, `Номер квартиры`, `Площадь`, `Цена`, `За м²`, `Статус`, `Медиа`.
- `apps/web/src/styles.css` - добавлены компактные стили grouped lots и мобильная адаптация summary rows.
- `apps/api/tests/api-contract.test.cjs`, `apps/api/tests/services.test.cjs`, `apps/web/tests/object-detail-feed-units.test.mjs` - добавлены и обновлены проверки grouped endpoint/UI.

Проверки:

- `pnpm --filter @platforma/api test -- api-contract services` - 171/171 passed.
- `pnpm --filter @platforma/web test -- object-detail-feed-units` - 219/219 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- Browser plugin не смог подключиться к in-app browser: `Browser is not available: iab`.
- Нужно вручную открыть `/objects/:slug` на объекте с несколькими сроками сдачи и проверить раскрытие групп, фильтры, сортировку внутри строк, `Показать еще`, mobile width и media carousel.

## 2026-06-01 - Lot grouped list design

Задача:

- Согласовать дизайн большой фичи: группировка лотов на странице объекта по сроку сдачи и комнатности.

Изменения:

- `docs/superpowers/specs/2026-06-01-lot-grouped-list-design.md` - добавлена design spec: группировка по сроку сдачи, строки по `rooms`, раскрытие первой группы, `20` лотов до `Показать еще`, агрегаты по всем отфильтрованным лотам, колонка `Номер квартиры`.
- `.gitignore` - добавлен `.superpowers/`, чтобы временные HTML-мокапы visual companion не попадали в git.

Проверки:

- Code checks не запускались: изменения только в документации и `.gitignore`.

Ручная проверка:

- Пользователь просмотрел visual companion mockup и подтвердил модель с правкой `Лот` -> `Номер квартиры`.

## 2026-06-01

Исправлено название квартир в CIAN-фидах Пионера.

Изменены файлы:

- `tools/feed-import/src/index.ts` - CIAN parser теперь читает номер квартиры из `<Apartment>` после `FlatNumber`; при отсутствии явного `title` residential title становится `Квартира №<номер>`, а для объектов/источников Пионера это правило применяется принудительно.
- `tools/feed-import/tests/parser.test.cjs` - добавлены parser-регрессы на Pioneer XML с `<Apartment>КВ-01006</Apartment>` и CIAN XML без явного `title`.
- `tools/feed-import/tests/import-engine.test.cjs` - добавлен run-регресс на Pioneer CIAN source без `SubAgent`, чтобы title переписывался по source developer/url.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверено:

- `pnpm --filter @platforma/feed-import test`.

Добавлен новый формат feed import `TEKTA_XML` для XML фидов Tekta.

Изменены файлы:

- `tools/feed-import/src/index.ts` - добавлен `TektaXmlFeedParser`, auto-detect корня `<projects>`, нормализация квартир и офисов, пропуск машиномест, пропуск статусов `Сдан` и `Скрывать на сайте`, маппинг `Устная бронь` и `Платная бронь` в `BOOKED`.
- `tools/feed-import/tests/fixtures/tekta.xml` - добавлен fixture формата Tekta.
- `tools/feed-import/tests/parser.test.cjs` и `tools/feed-import/tests/package-contract.test.cjs` - добавлены проверки parser, analysis, detect и fixture contract.
- `packages/shared/src/index.ts`, `apps/api/src/feeds/feeds.service.ts`, `apps/api/prisma/schema.prisma` - `TEKTA_XML` добавлен в shared/API/Prisma формат.
- `apps/api/prisma/migrations/20260601120000_add_tekta_feed_format/migration.sql` - добавлено значение `tekta_xml` в enum `feed_format`.
- `apps/api/tests/feed-schema.test.cjs`, `apps/api/tests/feeds-module.test.cjs`, `apps/api/tests/api-contract.test.cjs` - обновлены schema/API/shared проверки; добавлена проверка сохранения `INDEX_URL` источника с `TEKTA_XML`.
- `docs/PROJECT_INDEX.md`, `docs/PROJECT_STRUCTURE.md`, `docs/IMPORT_INDEX.md`, `docs/CODEX_LOG.md` - обновлены import-документы.

Проверено:

- `pnpm --filter @platforma/feed-import test`;
- `pnpm --filter @platforma/api test`;
- `pnpm --filter @platforma/web test`;
- `pnpm --filter @platforma/shared build`;
- `pnpm --filter @platforma/web build`;
- `node tools/feed-import/dist/index.js analyze --format AUTO --url <Tekta URL>` для `twelve`, `era`, `ever`, `air2`, `пыжёвский`.

Результат live-analyze:

- `twelve` -> `TEKTA_XML`, 934 лота;
- `era` -> `TEKTA_XML`, 2040 лотов;
- `ever` -> `TEKTA_XML`, 186 лотов;
- `air2` -> `TEKTA_XML`, 77 лотов;
- `пыжёвский` -> `TEKTA_XML`, 57 лотов.

Ограничения:

- Машиноместа Tekta игнорируются по решению задачи.
- Медиа/планировки импортируются только при публичных HTTP(S) URL; внутренние `\\crm-storage\...` пути не импортируются.

Исправлен баг формы нового источника фида: ссылка больше не очищается при разборе, если во время запроса обновился access token.

Изменены файлы:

- `apps/web/src/admin/FeedsAdminPage.tsx` - reset формы ограничен сменой маршрута формы; результат `/feeds/analyze` возвращает в форму `url` и `xmlFile` из отправленного снимка.
- `apps/web/tests/admin-feeds-page.test.mjs` - добавлены регрессионные проверки на сохранение источника после разбора и отсутствие reset формы при refresh токена.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверено:

- `pnpm --filter @platforma/web exec node --test tests/admin-feeds-page.test.mjs`;
- `pnpm --filter @platforma/web test`;
- `pnpm --filter @platforma/web build`.

Ручная проверка:

- На `/admin/feeds/new` вставить URL, нажать `Разобрать`, дождаться анализа и проверить, что ссылка остается в поле, а `Сохранить` не требует вводить источник заново.

Создан постоянный task protocol для Codex, чтобы не вставлять стартовый контекстный промт вручную перед каждой задачей.

Изменены документы:

- `docs/CODEX_TASK_PROTOCOL.md` - новый постоянный протокол: что читать перед задачей, что делать перед изменениями, ограничения во время работы и формат действий после изменений.
- `AGENTS.md` - добавлена короткая ссылка на task protocol в раздел `Перед любой задачей` и `Карта проекта`.
- `docs/PROJECT_INDEX.md` - `docs/CODEX_TASK_PROTOCOL.md` добавлен как обязательный документ перед любой задачей.
- `docs/DOCS_INVENTORY.md` - новый протокол добавлен в active-документы.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Ограничения соблюдены:

- application code не менялся;
- изменения внесены только в markdown-документацию;
- `AGENTS.md` остался короткой навигационной инструкцией, без вставки полного протокола.

Проведена финальная проверка качества активной документации проекта.

Исправлены документы:

- `docs/DOCS_INVENTORY.md` - добавлены существующие active-документы `docs/IMPORT_INDEX.md` и `docs/PRODUCT_AND_UI_CONTEXT.md`; обновлено описание проверки ссылок.
- `rules/backend.md` - добавлено правило для feed import analyze/preview/run/stop и API `/feeds/*`.
- `rules/commands.md` - добавлены `pnpm --filter @platforma/feed-import test` и package-level analyze command.
- `docs/PROJECT_INDEX.md` - `docs/IMPORT_INDEX.md` добавлен в главные индексы и import-навигацию.
- `docs/API_AND_DATA.md` - отсутствующие `/feed-import/preview` и `/feed-import/run` вынесены из endpoint-таблицы в warning, чтобы не воспринимались как актуальные API endpoints.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверялось:

- `AGENTS.md`, `rules/*.md`, active-документы из `docs/DOCS_INVENTORY.md`;
- `package.json`, workspace package scripts и `pnpm-workspace.yaml`;
- frontend routes в `apps/web/src/App.tsx`;
- backend endpoints в `apps/api/src/*/*.controller.ts`;
- упоминания удаленных `PRODUCT.md`, `DESIGN.md`, `plan.md`, `mapping.md`, `plus.md`, `isp-*.md`.

Ограничения соблюдены:

- application code не менялся;
- изменения внесены только в markdown-документацию;
- большие куски документации не дублировались.

Обновлена навигация Codex под актуальную документацию проекта.

Изменены документы:

- `AGENTS.md` - добавлены короткий порядок чтения перед задачами и раздел `Карта проекта` со ссылками только на существующие `docs/*.md`.
- `rules/project.md` - добавлены актуальные ссылки на `docs/IMPORT_INDEX.md` и `docs/PRODUCT_AND_UI_CONTEXT.md`.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Проверено:

- `docs/IMPORT_INDEX.md` и `docs/PRODUCT_AND_UI_CONTEXT.md` существуют;
- устаревших ссылок на удаленные `PRODUCT.md`, `DESIGN.md`, `plan.md`, `mapping.md`, `isp-*.md` в `rules/project.md` не осталось;
- application code не менялся.

Восстановлен компактный продуктовый/UI-контекст проекта для Codex.

Создан новый документ:

- `docs/PRODUCT_AND_UI_CONTEXT.md`

Обновлены документы:

- `docs/PROJECT_INDEX.md`
- `docs/FEATURE_MAP.md`
- `docs/RISK_ZONES.md`
- `docs/CODEX_LOG.md`

Ограничения соблюдены:

- application code не менялся;
- дизайн не менялся;
- рефакторинг не выполнялся;
- изменения внесены только в markdown-документацию;
- большие удаленные продуктовые/design-документы не восстанавливались;
- ссылки на удаленные markdown-файлы не добавлялись.

Перед работой прочитаны:

- `AGENTS.md`;
- `rules/communication.md`, `rules/workflow.md`, `rules/code-style.md`, `rules/project.md`, `rules/commands.md`, `rules/frontend.md`, `rules/backend.md`, `rules/files-and-secrets.md`, `rules/final-response.md`;
- `docs/PROJECT_INDEX.md`, `docs/PAGES_AND_ROUTES.md`, `docs/FEATURE_MAP.md`, `docs/RISK_ZONES.md`;
- `apps/web/src/styles.css`;
- основные frontend-компоненты: `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/admin`, `apps/web/src/components`.

Ключевые выводы компактного контекста подтверждены путями:

- продукт: закрытая внутренняя брокерская платформа для объектов недвижимости, подтверждено `rules/project.md`, `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`;
- UI-характер: спокойный, плотный, читаемый рабочий интерфейс, не лендинг и не decorative AI/SaaS design, подтверждено `rules/frontend.md`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css`;
- защищенные flows: каталог, карта, список/карточки, фильтры, permissions и import flows, подтверждено `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/ImportAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `docs/RISK_ZONES.md`.

Выполнена первичная инициализация актуальной документации.

Markdown-файлы, реально найденные до создания новых документов:

- `.agents/skills/ui-ux-pro-max/SKILL.md`
- `AGENTS.md`
- `docs/manual-qa-checklist.md`
- `docs/staging-production-env-checklist.md`
- `docs/superpowers/plans/2026-05-25-admin-object-location-filters-implementation.md`
- `docs/superpowers/plans/2026-05-25-lot-filters-implementation.md`
- `docs/superpowers/plans/2026-05-25-unified-search-normalization-implementation.md`
- `docs/superpowers/plans/2026-05-27-avito-feed-import.md`
- `docs/superpowers/plans/2026-05-27-etalon-cian-feed-import-implementation.md`
- `docs/superpowers/plans/2026-05-27-unified-feed-index-import-implementation.md`
- `docs/superpowers/plans/2026-05-29-map-pin-labels-implementation.md`
- `docs/superpowers/specs/2026-05-25-lot-filters-design.md`
- `docs/superpowers/specs/2026-05-25-unified-search-normalization-design.md`
- `docs/superpowers/specs/2026-05-27-etalon-cian-feed-import-design.md`
- `docs/superpowers/specs/2026-05-27-unified-feed-index-import-design.md`
- `docs/superpowers/specs/2026-05-29-map-pin-labels-design.md`
- `rules/backend.md`
- `rules/code-style.md`
- `rules/commands.md`
- `rules/communication.md`
- `rules/files-and-secrets.md`
- `rules/final-response.md`
- `rules/frontend.md`
- `rules/project.md`
- `rules/workflow.md`

Созданы новые документы:

- `docs/DOCS_INVENTORY.md`
- `docs/CODEX_LOG.md`

Проверка ссылок:

- Битых markdown-ссылок в `AGENTS.md` и `rules/*.md` не найдено.
- Устаревшие упоминания отсутствующих документов были найдены в `rules/project.md` и убраны.

Выполнен полный инженерный индекс проекта для Codex.

Созданы новые документы:

- `docs/PROJECT_INDEX.md`
- `docs/PROJECT_STRUCTURE.md`
- `docs/PAGES_AND_ROUTES.md`
- `docs/FEATURE_MAP.md`
- `docs/API_AND_DATA.md`
- `docs/STATE_AND_LOGIC.md`
- `docs/RISK_ZONES.md`

Обновлены документы:

- `docs/DOCS_INVENTORY.md`
- `docs/CODEX_LOG.md`
- `rules/project.md`

Изученные зоны:

- правила проекта: `AGENTS.md`, `rules/communication.md`, `rules/workflow.md`, `rules/code-style.md`, `rules/project.md`, `rules/commands.md`, `rules/frontend.md`, `rules/backend.md`, `rules/files-and-secrets.md`, `rules/final-response.md`;
- текущая документация: `docs/DOCS_INVENTORY.md`, `docs/manual-qa-checklist.md`, `docs/staging-production-env-checklist.md`;
- workspace/package scripts: `package.json`, `pnpm-workspace.yaml`, `apps/web/package.json`, `apps/api/package.json`, `packages/shared/package.json`, `tools/wp-import/package.json`, `tools/feed-import/package.json`;
- frontend routes/state: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/admin`;
- backend API/data: `apps/api/src/app.module.ts`, `apps/api/src/auth`, `apps/api/src/users`, `apps/api/src/objects`, `apps/api/src/map`, `apps/api/src/files`, `apps/api/src/catalog-links`, `apps/api/src/directories`, `apps/api/src/feeds`, `apps/api/src/wordpress-import`;
- Prisma: `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations`, `apps/api/prisma/seed.ts`;
- shared contracts: `packages/shared/src/index.ts`, `packages/shared/src/search-normalization.mjs`, `packages/shared/src/search-normalization.cjs`, `packages/shared/src/search-normalization.d.cts`;
- import tools: `tools/wp-import/src`, `tools/feed-import/src`;
- tests: `apps/web/tests`, `apps/api/tests`, `tools/wp-import/tests`, `tools/feed-import/tests`;
- env/docker: `.env.example`, `apps/api/.env.example`, `apps/web/.env.example`, `tools/wp-import/.env.example`, `docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker/postgres/init/01-enable-postgis.sql`.

Зоны, оставшиеся неясными:

- прямое использование Redis в application code не найдено, хотя Redis есть в `.env.example`, `apps/api/.env.example`, `docker-compose.yml`;
- dedicated audit log API/UI не найден, хотя `AuditLog` есть в `apps/api/prisma/schema.prisma` и сервисы пишут audit rows;
- dedicated tests для `tools/wp-import/src/repair.ts` не найдены;
- `tools/feed-import/.env.example` не найден.

Выполнен глубокий frontend-индекс проекта по `apps/web`.

Ограничения соблюдены:

- application code не менялся;
- дизайн не менялся;
- рефакторинг не выполнялся;
- зависимости не устанавливались;
- изменения внесены только в markdown-документацию;
- `dist` и `node_modules` не индексировались.

Перед работой прочитаны:

- `AGENTS.md`;
- `rules/communication.md`;
- `rules/workflow.md`;
- `rules/code-style.md`;
- `rules/project.md`;
- `rules/commands.md`;
- `rules/frontend.md`;
- `rules/backend.md`;
- `rules/files-and-secrets.md`;
- `rules/final-response.md`;
- `docs/DOCS_INVENTORY.md`;
- `docs/PROJECT_INDEX.md`;
- `docs/PROJECT_STRUCTURE.md`;
- `docs/PAGES_AND_ROUTES.md`;
- `docs/FEATURE_MAP.md`;
- `docs/RISK_ZONES.md`;
- `docs/CODEX_LOG.md`;
- `docs/STATE_AND_LOGIC.md`.

Изученные frontend-зоны:

- entry/theme/routing: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/appTheme.ts`;
- auth/API/media: `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`, `apps/web/src/files/SecureImage.tsx`, `apps/web/src/files/fileDisplay.ts`;
- catalog/map: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/map/mapMarkerLabels.ts`;
- object detail/lots: `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/objects/objectDetailViewModel.ts`;
- admin: `apps/web/src/admin/UsersAdminPage.tsx`, `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/ObjectQuickEditTable.tsx`, `apps/web/src/admin/objectQuickEditPersistence.ts`, `apps/web/src/admin/objectQuickEditTransforms.ts`, `apps/web/src/admin/CatalogLinksAdminPage.tsx`, `apps/web/src/admin/ImportAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/feedSourceMatching.ts`, `apps/web/src/admin/AdminUi.tsx`;
- shared frontend components/helpers: `apps/web/src/components/MultiSelectDropdown.tsx`, `apps/web/src/components/ui`, `apps/web/src/lib/numberInput.ts`, `apps/web/src/lib/utils.ts`;
- styles/assets/tests: `apps/web/src/styles.css`, `apps/web/src/app-theme.css`, `apps/web/public/map-marker-pin.svg`, `apps/web/public/map-marker-dot.svg`, `apps/web/tests`.

Обновлены документы:

- `docs/PAGES_AND_ROUTES.md` - добавлен deep frontend index по entry/routing, auth/cabinet, catalog, catalog map, object detail, admin и styles.
- `docs/FEATURE_MAP.md` - добавлен deep frontend feature index с frontend/backend/shared/API/tests/рисками/проверками.
- `docs/STATE_AND_LOGIC.md` - добавлен deep frontend state and logic index по shell, auth, secure media, catalog, map, object detail, admin и styles.
- `docs/RISK_ZONES.md` - добавлен deep frontend risk index и отдельные App.tsx/styles risk notes.
- `docs/CODEX_LOG.md` - добавлена текущая запись о frontend-индексе.

Самые хрупкие frontend-зоны:

- `apps/web/src/App.tsx` - ручной router, permission gates, login redirect, cabinet, admin home и global style imports находятся в одном файле.
- `apps/web/src/auth/AuthProvider.tsx` + `apps/web/src/admin/api.ts` - refresh/session retry и browser auth events должны совпадать с backend cookies/CORS.
- `apps/web/src/catalog/CatalogPage.tsx` - query params являются source of truth для каталога, а lot filters переносятся в `/objects/:slug`.
- `apps/web/src/map/YandexMap.tsx` + `apps/web/src/catalog/CatalogPage.tsx` - Yandex no-key mode, marker labels, selected card и list overlay являются защищенной функциональной моделью.
- `apps/web/src/objects/ObjectDetailPage.tsx` + `apps/web/src/objects/objectDetailViewModel.ts` - detail page зависит от полного `RealEstateObjectDetail`, media cookie, map fallback и feed units.
- `apps/web/src/admin/ObjectsAdminPage.tsx` - object lifecycle, create-before-upload, gallery stream/batch, PDF uploads, local validation and permissions are tightly coupled.
- `apps/web/src/styles.css` + `apps/web/src/app-theme.css` - broad global selectors affect shell, catalog, map, object detail and admin in both themes.

Ручные проверки после frontend-правок:

- direct URL reload and navigation for `/login`, `/cabinet`, `/catalog`, `/catalog?view=list`, `/catalog/map`, `/objects/:slug`, `/objects/:slug/lots/:unitId`, `/admin`, `/admin/users`, `/admin/objects`, `/admin/objects/new`, `/admin/objects/:id/edit`, `/admin/catalog-links`, `/admin/import`, `/admin/feeds`;
- login, logout, expired-token refresh retry, registration by code/token, profile save, password change, profile photo upload/display;
- catalog filters, quick links, sort, pagination, load more, card/list switch, object links with lot filters;
- `/catalog/map` with and without `VITE_YANDEX_MAPS_API_KEY`, selected marker/card, list overlay, empty coordinates and fullscreen;
- object detail gallery, section filters, files/downloads, map fallback, feed lot filters/sorting/pagination and lot detail;
- admin users create/edit/deactivate/reactivate;
- admin objects list filters, quick edit, create/edit/publish, gallery upload/reorder/cover/delete, PDF upload/delete;
- admin catalog links save and public rendering;
- WordPress import preview/run states and feed source analyze/preview/run/stop states;
- visual QA in `minimal-luxury` and `dark-premium` for desktop and mobile widths.

Выполнен глубокий backend/API-индекс проекта по `apps/api`.

Ограничения соблюдены:

- application code не менялся;
- Prisma schema не менялась;
- миграции не создавались;
- рефакторинг не выполнялся;
- зависимости не устанавливались;
- изменения внесены только в markdown-документацию;
- `apps/api/dist` и `apps/api/node_modules` не индексировались как source.

Перед работой прочитаны:

- `AGENTS.md`;
- `rules/communication.md`;
- `rules/workflow.md`;
- `rules/code-style.md`;
- `rules/project.md`;
- `rules/commands.md`;
- `rules/frontend.md`;
- `rules/backend.md`;
- `rules/files-and-secrets.md`;
- `rules/final-response.md`;
- `docs/DOCS_INVENTORY.md`;
- `docs/PROJECT_INDEX.md`;
- `docs/PROJECT_STRUCTURE.md`;
- `docs/FEATURE_MAP.md`;
- `docs/API_AND_DATA.md`;
- `docs/RISK_ZONES.md`;
- `docs/CODEX_LOG.md`;
- `docs/STATE_AND_LOGIC.md`.

Изученные backend/API-зоны:

- API shell/modules: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`;
- auth/RBAC/cookies/media token: `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/cookies.ts`, `apps/api/src/auth/jwt-auth.guard.ts`, `apps/api/src/auth/permissions.guard.ts`, `apps/api/src/auth/permissions.decorator.ts`, `apps/api/src/auth/media-token.guard.ts`, `apps/api/src/auth/mail.service.ts`;
- Prisma service/seed/schema: `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/prisma/prisma.module.ts`, `apps/api/prisma/seed.ts`, `apps/api/prisma/schema.prisma`;
- users: `apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.service.ts`, `apps/api/src/users/users.module.ts`;
- objects/search: `apps/api/src/objects/objects.controller.ts`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/objects/object-search.ts`, `apps/api/src/search/search-filters.ts`;
- map: `apps/api/src/map/map.controller.ts`, `apps/api/src/map/map.service.ts`, `apps/api/src/map/map.module.ts`;
- files/storage/media: `apps/api/src/files/files.controller.ts`, `apps/api/src/files/media.controller.ts`, `apps/api/src/files/files.service.ts`, `apps/api/src/files/s3-storage.service.ts`, `apps/api/src/files/image-variants.ts`, `apps/api/src/files/file-upload.constants.ts`;
- directories: `apps/api/src/directories/directories.controller.ts`, `apps/api/src/directories/directories.service.ts`;
- catalog links: `apps/api/src/catalog-links/catalog-links.controller.ts`, `apps/api/src/catalog-links/catalog-links.service.ts`;
- WordPress import API: `apps/api/src/wordpress-import/wordpress-import.controller.ts`, `apps/api/src/wordpress-import/wordpress-import.service.ts`;
- feed import API: `apps/api/src/feeds/feeds.controller.ts`, `apps/api/src/feeds/feeds.service.ts`;
- shared contracts: `packages/shared/src/index.ts`;
- frontend API consumers: `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/admin`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/files/SecureImage.tsx`;
- API tests: `apps/api/tests`;
- import tests/tools touched as context: `tools/wp-import/tests`, `tools/feed-import/tests`, `tools/wp-import/src`, `tools/feed-import/src`.

Обновлены документы:

- `docs/API_AND_DATA.md` - добавлен deep backend/API index: architecture, endpoint table, Prisma/data map, shared/API breakage points.
- `docs/FEATURE_MAP.md` - добавлен backend/API feature index по modules, auth/RBAC, users, objects, directories/map/catalog links, files, imports, audit log.
- `docs/STATE_AND_LOGIC.md` - добавлен backend/API state and logic index по sessions, RBAC, object queries, files, imports, audit.
- `docs/RISK_ZONES.md` - добавлен backend/API risk index, most dangerous endpoints and backend test set.
- `docs/PROJECT_STRUCTURE.md` - добавлен backend/API structure index, controllers/services/guards/tests/absence checks.
- `docs/CODEX_LOG.md` - добавлена текущая запись о backend/API-индексе.

Проверенные endpoint-факты:

- `/health`, `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/me`, `/users`, `/users/me`, `/users/me/profile-photo`, `/objects`, `/objects/:id`, `/objects/slug/:slug`, `/map/objects`, `/files/upload`, `/files/:id`, `/wordpress-import/preview`, `/wordpress-import/run`, `/catalog-links`, `/catalog-links/admin` существуют в `apps/api/src`.
- `/feed-import/preview` и `/feed-import/run` не найдены в `apps/api/src`; актуальные endpoints: `POST /feeds/sources/:id/preview` и `POST /feeds/sources/:id/run`.
- Dedicated audit log endpoints не найдены в `apps/api/src`; `AuditLog` model and writes exist in `apps/api/prisma/schema.prisma`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/users/users.service.ts`.

Наиболее опасные endpoints:

- `GET /objects`, `GET /objects/:id`, `GET /objects/slug/:slug` - shared object response for catalog/admin/detail.
- `PATCH /objects/:id`, `PATCH /objects/:id/status`, `POST /objects/:id/publish` - object lifecycle and publish validation.
- `POST /objects/:id/gallery/stream`, `PATCH /objects/:id/gallery/batch`, `DELETE /objects/:id/gallery/:imageId` - staged gallery/file cleanup.
- `POST /files/upload`, `GET /files/:id/content`, `GET /media/files/:id/content`, `DELETE /files/:id` - storage, variants, media cookie and linked delete protection.
- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` - access token, refresh cookie, media cookie and CORS behavior.
- `GET /map/objects` - map/catalog filter parity and coordinate-only response.
- `POST /wordpress-import/run` - mutates objects/media and can archive imported objects.
- `POST /feeds/sources/:id/run`, `POST /feeds/runs/:id/stop` - detached feed import queue and process stop logic.

Тесты после backend-изменений:

- `pnpm --filter @platforma/api test`;
- `pnpm --filter @platforma/wp-import test` after WordPress import changes;
- `pnpm --filter @platforma/feed-import test` after feed import/parser/media changes;
- `pnpm test` after shared contracts, permissions, object response, auth/cookies, files/media or Prisma-adjacent changes.

Выполнен глубокий import-индекс проекта: WordPress import, WordPress repair logic и feed import.

Ограничения соблюдены:

- application code не менялся;
- import run не запускался;
- repair run не запускался;
- feed import run не запускался;
- рефакторинг не выполнялся;
- зависимости не устанавливались;
- изменения внесены только в markdown-документацию.

Перед работой прочитаны:

- `AGENTS.md`;
- `rules/communication.md`;
- `rules/workflow.md`;
- `rules/code-style.md`;
- `rules/project.md`;
- `rules/commands.md`;
- `rules/frontend.md`;
- `rules/backend.md`;
- `rules/files-and-secrets.md`;
- `rules/final-response.md`;
- `docs/DOCS_INVENTORY.md`;
- `docs/PROJECT_INDEX.md`;
- `docs/API_AND_DATA.md`;
- `docs/FEATURE_MAP.md`;
- `docs/RISK_ZONES.md`;
- `docs/staging-production-env-checklist.md`;
- `package.json`;
- `tools/wp-import/package.json`;
- `tools/feed-import/package.json`.

Изученные import-зоны:

- WordPress import CLI/source/mapping/persist/storage/tests: `tools/wp-import/src/index.ts`, `tools/wp-import/src/env.ts`, `tools/wp-import/src/wordpress-client.ts`, `tools/wp-import/src/mapper.ts`, `tools/wp-import/src/importer.ts`, `tools/wp-import/src/storage.ts`, `tools/wp-import/src/image-variants.ts`, `tools/wp-import/src/types.ts`, `tools/wp-import/tests`;
- WordPress repair: `tools/wp-import/src/repair.ts`, `tools/wp-import/src/developer-aliases.ts`;
- WordPress API/UI: `apps/api/src/wordpress-import/wordpress-import.controller.ts`, `apps/api/src/wordpress-import/wordpress-import.service.ts`, `apps/api/src/wordpress-import/wordpress-import.module.ts`, `apps/web/src/admin/ImportAdminPage.tsx`, route gates in `apps/web/src/App.tsx`;
- feed import parser/engine/storage/tests: `tools/feed-import/src/index.ts`, `tools/feed-import/src/env.ts`, `tools/feed-import/src/storage.ts`, `tools/feed-import/src/image-variants.ts`, `tools/feed-import/tests`;
- feed API/UI: `apps/api/src/feeds/feeds.controller.ts`, `apps/api/src/feeds/feeds.service.ts`, `apps/api/src/feeds/feeds.module.ts`, `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/feedSourceMatching.ts`;
- shared contracts: `packages/shared/src/index.ts`;
- Prisma models: `apps/api/prisma/schema.prisma`;
- file/XML checks and storage-adjacent code: `apps/api/src/files/file-upload.constants.ts`, `apps/api/src/files/files.service.ts`;
- env examples: `.env.example`, `apps/api/.env.example`, `apps/web/.env.example`, `tools/wp-import/.env.example`.

Обновлены документы:

- `docs/IMPORT_INDEX.md` - создан полный import index с overview, WordPress import, repair, feed import, API/admin UI и рисками.
- `docs/FEATURE_MAP.md` - добавлен deep import feature index.
- `docs/API_AND_DATA.md` - добавлен deep import API/data index.
- `docs/STATE_AND_LOGIC.md` - добавлен deep import state and logic index.
- `docs/RISK_ZONES.md` - добавлен deep import risk index.
- `docs/CODEX_LOG.md` - добавлена текущая запись.

Ключевые выводы import-индекса:

- WordPress import читает только published posts configured by `WP_POST_TYPE`, default `nedvizhimosts`, confirmed in `tools/wp-import/src/env.ts` and `tools/wp-import/src/wordpress-client.ts`.
- WordPress preview writes `ImportReport` but does not persist objects/media because persistence is guarded by `mode === 'run'` in `tools/wp-import/src/importer.ts`.
- WordPress run idempotency relies on `wpPostId`, `wpAttachmentId`, slug conflict handling, imported media cleanup and manual override replay from `AuditLog` in `tools/wp-import/src/importer.ts`.
- WordPress full run can archive previously imported objects missing from current WP source only when `WP_IMPORT_LIMIT` is empty/null, confirmed in `tools/wp-import/src/importer.ts`.
- Repair is separate CLI-only logic with no HTTP endpoint and no `ImportReport`; it mutates primary locations and developers through `tools/wp-import/src/repair.ts`.
- Feed import HTTP surface is under `/feeds/*`; `/feed-import/preview` and `/feed-import/run` endpoints were not found in `apps/api/src`.
- Feed preview writes `FeedImportRun` but does not persist units/media/object aggregates because persistence is guarded by `options.mode === 'run'` in `tools/feed-import/src/index.ts`.
- Feed run is queued/detached by `apps/api/src/feeds/feeds.service.ts`; progress is stored in `FeedImportRun.summaryJson.progress` and polled by `apps/web/src/admin/FeedsAdminPage.tsx`.
- Feed run idempotency relies on unique `(sourceId, externalId)`, `FeedMediaAsset.sourceUrl`, media link replacement and archived missing units in `tools/feed-import/src/index.ts`.

Зоны, требующие ручной проверки:

- WP preview on staging: verify report creation and no object/media writes.
- WP run on staging: verify duplicate prevention, media import, manual override preservation and archive count when `WP_IMPORT_LIMIT` is empty.
- WP repair preview: inspect location candidates and developer alias plans before any repair run.
- Feed analyze: verify URL, FILE and INDEX_URL sources, generated `filterJson` and frontend suggestions.
- Feed preview: verify run summary without units/media/object aggregate writes.
- Feed run: verify queue/progress/polling, duplicate prevention, archived units, media warnings/variants and object feed aggregates.
- Feed stop: verify queued and running stop behavior through `POST /feeds/runs/:id/stop`.
- Env/storage: verify `WP_DB_*`, `WP_UPLOADS_PATH`, read-only WP DB user, `S3_*`, `MINIO_BUCKET`, XML upload MIME/size and missing file behavior.

## 2026-06-01 - Regions Development CIAN feed statuses

Задача:

- Адаптировать feed importer под фид Regions Development `https://api.vnedrim-crm.ru/pb/pb12521/feeds/dt_all_cian.xml`, чтобы наличие лотов отображалось актуально.

Изменения:

- `tools/feed-import/src/index.ts` - CIAN parser теперь читает статусы в порядке `Booking.Status` -> `fl_status` -> numeric `Status`.
- `tools/feed-import/src/index.ts` - `unavailable` нормализуется в `ARCHIVED`, чтобы недоступные лоты не попадали в активное наличие.
- `tools/feed-import/src/index.ts` - numeric CIAN fallback мапит `0` -> `AVAILABLE`, `1` -> `BOOKED`, `2` -> `SOLD`.
- `tools/feed-import/tests/parser.test.cjs` - добавлен тест Regions Development для `fl_status`, приоритета `Booking.Status` и numeric fallback.

Проверки:

- `pnpm --filter @platforma/feed-import test` - 52/52 passed.
- `pnpm --filter @platforma/feed-import run analyze -- --format AUTO --url https://api.vnedrim-crm.ru/pb/pb12521/feeds/dt_all_cian.xml` - формат `CIAN_XML`, `471` units, `0` warnings.
- Дополнительная проверка парсером живого URL: `SOLD 408`, `AVAILABLE 44`, `BOOKED 18`, `ARCHIVED 1`.

Ручная проверка:

- Перед production run проверить preview/run источника Regions Development в админке и убедиться, что активное наличие по объекту показывает только `AVAILABLE`/`BOOKED`/`RESERVED`, без проданных `SOLD`.

## 2026-06-01 - Admin object gallery media modal readability

Задача:

- Улучшить окно управления/загрузки медиа в редакторе объекта: белый читаемый текст в темной теме, превью крупнее, изображения без обрезки.

Изменения:

- `apps/web/src/styles.css` - размеры cover slot и карточек галереи увеличены примерно на 30%; превью галереи и обложки переведены на `object-fit: contain`.
- `apps/web/src/app-theme.css` - добавлен scoped dark-theme override для текста внутри `gallery-modal`.
- `apps/web/tests/admin-gallery-styles.test.mjs` - обновлены style-проверки размеров, `object-fit: contain` и белого текста в темной теме.

Проверки:

- `pnpm --filter @platforma/web test -- admin-gallery-styles` - 215/215 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.
- Playwright fallback на `http://localhost:5173/?theme=c` - computed styles подтвердили `rgb(255, 255, 255)`, `object-fit: contain`, `min-height: 244px` для карточки и `234px` для cover slot.

Ручная проверка:

- Открыть `/admin/objects/:id/edit` в темной теме, нажать `Управлять галереей`, проверить читаемость названий/labels/select, размер превью и отсутствие обрезки вертикальных/горизонтальных изображений.

## 2026-06-01 - Admin object gallery full-size overlay

Задача:

- Добавить иконку поверх превью изображения в модальном окне управления галереей, чтобы по клику открывать это изображение в полном размере в новой вкладке.

Изменения:

- `apps/web/src/admin/ObjectsAdminPage.tsx` - в карточку draft-изображения добавлен overlay-link с `ExternalLinkIcon`; ссылка ведет на original media URL через `buildMediaFileContentUrl`.
- `apps/web/src/styles.css` - добавлены стили для компактной overlay-иконки в левом верхнем углу превью.
- `apps/web/tests/admin-gallery-state.test.mjs` - добавлена проверка full-size overlay и original media URL.
- `apps/web/tests/admin-gallery-styles.test.mjs` - добавлена проверка позиционирования overlay-иконки.

Проверки:

- `pnpm --filter @platforma/web test -- admin-gallery` - 217/217 passed.
- `pnpm build:web` - production build successful; осталось штатное предупреждение Vite о чанке больше 500 kB.

Ручная проверка:

- Открыть `/admin/objects/:id/edit`, нажать `Управлять галереей`, кликнуть overlay-иконку на существующем изображении и убедиться, что новая вкладка открывает original image.

## 2026-06-01 - Feed source URL preserved during analysis

Задача:

- Исправить production-баг в `/admin/feeds/new`, где после вставки URL и нажатия `Разобрать` поле источника могло очиститься.

Изменения:

- `apps/web/src/admin/FeedsAdminPage.tsx` - добавлен ref на input источника и синхронизация формы с живым значением поля перед запуском анализа.
- `apps/web/src/admin/FeedsAdminPage.tsx` - результат анализа больше не может перезаписать непустой URL пустым значением из stale state.
- `apps/web/tests/admin-feeds-page.test.mjs` - обновлены проверки формы разбора фида под новую защиту.

Проверки:

- `pnpm --filter @platforma/web test` - 213/213 passed.
- `pnpm build:web` - production build successful.

Ручная проверка:

- На production открыть `/admin/feeds/new`, вставить URL фида, нажать `Разобрать` и убедиться, что поле источника остается заполненным во время и после разбора.

## 2026-06-01 - Feed source list developer title

Задача:

- В списке фидов поменять местами заголовок и подпись источника: сверху показывать застройщика, ниже - количество/название сопоставленных ЖК.

Изменения:

- `apps/web/src/admin/FeedsAdminPage.tsx` - в ячейке источника главным текстом теперь выводится `source.developer.name`, а строкой ниже `getSourceObjectTitle(source)`.
- `apps/web/tests/admin-feeds-page.test.mjs` - добавлена проверка порядка строк в списке источников.

Проверки:

- `pnpm --filter @platforma/web test` - 214/214 passed.
- `pnpm build:web` - production build successful.

Ручная проверка:

- Открыть `/admin/feeds` и убедиться, что в таблице сверху идет застройщик, под ним количество/название ЖК, а URL остается третьей строкой.

## 2026-06-01 - Feed lot external id hidden

Задача:

- Скрыть строку `ID` в списке лотов фидов для всех застройщиков.

Изменения:

- `apps/web/src/admin/FeedsAdminPage.tsx` - из строки лота удален вывод `ID {unit.externalId}`.
- `apps/web/src/admin/FeedsAdminPage.tsx` - заголовок лота теперь использует `getFeedUnitTitle(unit)` с fallback `Лот без названия`, чтобы внешний ID не всплывал вместо названия.
- `apps/web/tests/admin-feeds-page.test.mjs` - добавлена проверка, что строка ID не рендерится в админском списке лотов.

Проверки:

- `pnpm --filter @platforma/web test` - 214/214 passed.
- `pnpm build:web` - production build successful.

Ручная проверка:

- Открыть лоты любого фида в `/admin/feeds` и убедиться, что под названием лота больше нет строки `ID ...`.

## 2026-06-01 - Feed lot completion display

Задача:

- Выводить срок сдачи лота из фидов в списке лотов и карточке лота.
- Формат квартала на frontend: `1кв`, `2кв`, `3кв`, `4кв`; если квартала нет, показывать только год.

Изменения:

- `tools/feed-import/src/index.ts` - CIAN parser теперь берет срок сдачи из `CompletionYear/CompletionQuarter`, `BuildYear`, snake case полей и fallback `Building.Deadline.Year/Quarter`.
- `tools/feed-import/src/index.ts` - нормализация квартала поддерживает числовой формат `1кв..4кв` и текстовые значения CIAN `first/second/third/fourth`.
- `apps/web/src/objects/ObjectDetailPage.tsx` - в таблицу лотов добавлена колонка `Срок сдачи` перед `Медиа`.
- `apps/web/src/objects/ObjectDetailPage.tsx` - в карточку лота добавлена отдельная плашка `Срок сдачи`.
- `tools/feed-import/tests/parser.test.cjs`, `apps/web/tests/object-detail-feed-units.test.mjs`, `apps/web/tests/object-lot-detail-page.test.mjs` - обновлены проверки парсинга и отображения.

Проверки:

- `pnpm --filter @platforma/feed-import test` - 53/53 passed.
- `pnpm --filter @platforma/web test` - 214/214 passed.
- `pnpm build:web` - production build successful.

Ручная проверка:

- Открыть `/objects/:slug`, проверить колонку `Срок сдачи` в таблице лотов перед `Медиа`.
- Открыть `/objects/:slug/lots/:unitId`, проверить плашку `Срок сдачи` в параметрах лота.

## 2026-06-01 - Feed run panel developer title

Задача:

- В блоке запуска выбранного фида показывать застройщика, а не количество ЖК в сопоставлении.

Изменения:

- `apps/web/src/admin/FeedsAdminPage.tsx` - заголовок `SourceRunControlPanel` теперь выводит `source.developer.name`.
- `apps/web/tests/admin-feeds-page.test.mjs` - добавлена проверка заголовка блока запуска.

Проверки:

- `pnpm --filter @platforma/web test` - 214/214 passed.
- `pnpm build:web` - production build successful.

Ручная проверка:

- Открыть `/admin/feeds`, выбрать источник и убедиться, что в блоке `Запуск` видно название застройщика.

## 2026-06-03 - MR Group feed lot duplicate investigation

Задача:

- На production выяснить, почему в grouped lot table по объектам MR Group видны дубли лотов.

Вывод:

- Production-данные не менялись; выполнялась только диагностика.
- Причина дублей: старые индивидуальные URL `FeedSource` были soft-deleted, но их `FeedUnit` остались в публичных активных статусах.
- Новый MR Group `INDEX_URL` source импортирует те же лоты под другим `sourceId` и с namespaced `externalId`, поэтому уникальность `(sourceId, externalId)` не дедуплицирует старые и новые строки.
- Object detail lot endpoint выбирает `FeedUnit` по `objectId/status` и не исключает units, чей `source.deletedAt` не `null`.

Проверки:

- На production проверены `developers`, `real_estate_objects`, `feed_sources`, `feed_units`, `feed_source_mappings`, `feed_import_runs`.
- Для `zhk-cityzen`: текущий source дает 126 лотов в `3 кв. 2027` и 206 в `3 кв. 2029`, удаленный source дает 335 лотов в `Срок не указан`; 332 лота совпадают по исходному external id.

Ручная проверка:

- После будущего исправления открыть `/objects/zhk-cityzen` и другие MR Group объекты с lot groups и убедиться, что лоты из soft-deleted sources не попадают в публичные группы и агрегаты.

## 2026-06-03 - Remove soft-deleted feed source lots from public data

Задача:

- Убрать production-дубли лотов из soft-deleted feed sources и не допускать их повторного попадания в публичные списки/агрегаты.

Изменения:

- `apps/api/src/objects/objects.service.ts` - публичные lot endpoints, lot detail и catalog lot filters теперь исключают `FeedUnit` из sources с `deletedAt`.
- `apps/api/src/feeds/feeds.service.ts` - удаление feed source теперь архивирует связанные неархивные `FeedUnit`.
- `tools/feed-import/src/index.ts` - пересчет object feed aggregates теперь учитывает только units из не удаленных sources.
- `apps/api/tests/feeds-module.test.cjs`, `apps/api/tests/services.test.cjs`, `tools/feed-import/tests/import-engine.test.cjs` - обновлены регрессии под новое правило.

Production repair:

- В production архивированы 4 929 неархивных `FeedUnit` из soft-deleted sources.
- Пересчитаны feed aggregates для 16 затронутых объектов.
- После repair у soft-deleted sources осталось 0 публично активных units.
- Для `zhk-cityzen` осталось 332 актуальных лота: 126 в `3 кв. 2027` и 206 в `3 кв. 2029`; группа `Срок не указан` из старого source убрана.

Проверки:

- `pnpm --filter @platforma/api test -- services feeds-module` - 174/174 passed.
- `pnpm --filter @platforma/feed-import test` - 55/55 passed.
- Production SQL checks: `deleted_source_public_units = 0` по MR Group; `zhk-cityzen.feed_units_count = 332`.

Ручная проверка:

- Открыть `/objects/zhk-cityzen` и убедиться, что в блоке `Лоты` нет группы `Срок не указан` на 335 лотов.
- Проверить несколько других MR Group объектов из каталога: количество лотов должно совпадать с active non-deleted source units.

## 2026-06-03 - Production feed duplicate audit

Задача:

- После удаления дублей MR Group пройтись по всем production feed sources и проверить, нет ли аналогичных случаев.

Диагностика:

- Проверены все 9 active non-deleted feed sources: Forma, MR Group, Regions Development, Sminex, Tekta Group, Мангазея, Пионер, ФСК, Эталон.
- У soft-deleted sources осталось 0 public/non-archived units.
- Inconsistent flags не найдены: нет deleted-but-active sources и нет not-deleted inactive sources.
- Расхождений `real_estate_objects.feed_units_count` с active non-deleted public `FeedUnit` не найдено.
- Active source URL duplicates не найдены.
- Дублей по исходному raw external id между active non-deleted sources не найдено.
- Один и тот же raw external id из одного feed scope не маршрутизирован в разные объекты.
- Пересечений active URL source с active index source URLs не найдено.
- Strict duplicates по объекту/корпусу/секции/номеру/этажу/площади/цене не найдены.

Наблюдения:

- Есть 127 групп с одинаковым объектом/корпусом/секцией/номером квартиры внутри одного active Sminex source, но у пар отличаются external id, площадь и цена; cross-source дублей среди них нет.
- Есть лоты без срока сдачи у Tekta Group и Эталон, но они не дублируются с лотами со сроком по raw external id.

Изменения:

- Application code и production data не менялись.
- `docs/CODEX_LOG.md` - добавлена запись о production-аудите.

## 2026-06-03 - MR Group Veer room grouping production diagnosis

Задача:

- Проверить production-сигнал, что у `Жилой комплекс Веер 2` после удаления дублей MR Group лоты будто попадают только в `2-к.кв`, а студии и другие комнатности исчезли.

Вывод:

- Production-данные `veer-2` не схлопнулись: публичные active units из non-deleted MR Group source распределены как `rooms=0` - 94, `rooms=1` - 400, `rooms=2` - 287, `rooms=3` - 74, `rooms=4` - 2.
- По срокам сдачи распределение тоже корректное: `3 кв. 2028` и `3 кв. 2030` содержат несколько room groups, включая студии.
- Raw payload MR Group для студий приходит как `FlatRoomsCount=9`, importer сохраняет их в `rooms=0`; `FlatRoomsCount=1..4` сохраняется в соответствующие `rooms=1..4`.
- Backend room grouping подписывает `rooms=0` как `Студии`, `rooms=1..5` как `{n}-к.кв`; отдельной логики, которая превращает все в `2-к.кв`, не найдено.
- Вероятная причина наблюдения в UI: объект открыт из каталога или по URL с query-параметром `lotRooms=2`. `CatalogPage` добавляет текущие lot-фильтры в ссылку объекта, а `ObjectFeedUnitsSection` читает `lotRooms` из `window.location.search` и отправляет его в API как `rooms`.

Изменения:

- Application code и production data не менялись.
- `docs/CODEX_LOG.md` - добавлена запись о диагностике `Жилой комплекс Веер 2`.

## 2026-06-04 - Lot card media safe area

Задача:

- В галерее внутри карточки лота добавить внутреннюю охранную зону 15px по периметру между контейнером и изображением.

Изменения:

- `apps/web/src/styles.css` - для `.object-lot-media-carousel .object-lot-media-image` добавлен `inset: 15px` и уменьшение `width/height` на 30px, чтобы основное изображение лота не прижималось к краям контейнера.
- `apps/web/tests/object-lot-detail-page.test.mjs` - обновлена регрессия на CSS-правило лотовой галереи.

Проверки:

- `pnpm --filter @platforma/web test -- object-lot-detail-page.test.mjs` - 227/227 passed.
- `pnpm build:web` - passed.

Ручная проверка:

- Открыть `/objects/:slug/lots/:unitId` с медиа и убедиться, что основное изображение в карточке лота имеет внутренний отступ 15px со всех сторон.

## 2026-06-04 - Normalize delivered feed completion groups

Задача:

- На production проверить `ЖК СОУЛ`, где сданный корпус отображался как `1 кв. 1970`, пройтись по фидам на такие же проблемы и исправить отображение.

Диагностика:

- Production scan показал, что у Forma/Yandex для `ЖК СОУЛ` два активных лота имеют `building-state=hand_over`, `built-year=1970`, `ready-quarter=1`.
- Дополнительная проверка активных лотов нашла сданные корпуса по raw-флагам у Forma, MR Group и Sminex; у Sminex West Garden часть лотов была с техническим `completion_year=1`.

Изменения:

- `tools/feed-import/src/index.ts` - Yandex `building-state=hand_over/hand-over` и CIAN `Deadline.IsComplete=true` теперь считаются сданными корпусами и не переносят технические `completionYear/completionQuarter` в импортированные лоты.
- `apps/api/src/objects/objects.service.ts` - группы лотов по сроку сдачи теперь показывают `Сдан` для сданных корпусов по `rawPayload`, а также для уже сохраненных технических годов `< 1900`.
- `tools/feed-import/tests/parser.test.cjs` - добавлены регрессии на Yandex `hand_over` и CIAN `IsComplete=true`.
- `apps/api/tests/services.test.cjs` - добавлена регрессия, что старые production-значения `1970`/`1` с raw-флагами группируются как `Сдан`.

Проверки:

- `pnpm --filter @platforma/feed-import test -- --test-name-pattern "YandexRealtyFeedParser treats hand-over|CianXmlFeedParser reads completion"` - 57/57 passed.
- `pnpm --filter @platforma/api test -- --test-name-pattern "ObjectsService.listFeedUnitGroups labels delivered"` - 179/179 passed.

Ручная проверка:

- После деплоя открыть `ЖК СОУЛ` на production и убедиться, что группа сданного корпуса отображается как `Сдан`, а не `1 кв. 1970`.
- Проверить другие объекты со сданными корпусами из MR Group/Sminex/Forma, чтобы в блоке фида не осталось групп вида `1 кв. 1` или старых кварталов для `IsComplete=true`.

## 2026-06-03 - Preserve expanded lot groups while sorting

Задача:

- Исправить поведение grouped lot table на странице объекта: при клике по сортировке колонок список должен обновляться по сортировке без схлопывания раскрытых групп лотов.

Изменения:

- `apps/web/src/objects/ObjectDetailPage.tsx` - сортировка больше не очищает `visibleRoomLotCounts`; успешный reload лотов сбрасывает раскрытые completion/room groups только при изменении объекта или lot-фильтров, но не при изменении `sortBy/sortDirection`.
- `apps/web/tests/object-detail-feed-units.test.mjs` - добавлена регрессия, что сортировка сохраняет раскрытые группы лотов.

Проверки:

- `pnpm --filter @platforma/web test -- object-detail-feed-units.test.mjs` - 222/222 passed.
- `pnpm --filter @platforma/web build` - passed.

Ручная проверка:

- На странице объекта раскрыть срок сдачи и room group, нажать сортировку по нескольким колонкам и убедиться, что раскрытая таблица остается видимой, а строки меняют порядок.

## 2026-06-03 - Map object title link

Задача:

- В режиме карты добавить переход на страницу объекта при клике по названию объекта в выбранной карточке.

Изменения:

- `apps/web/src/catalog/CatalogPage.tsx` - заголовок `MapObjectCard` теперь является ссылкой на страницу объекта через существующий `buildCatalogObjectHref()`.
- `apps/web/src/styles.css` - добавлен стиль для ссылки заголовка карты, чтобы сохранить прежний вид заголовка.
- `apps/web/tests/catalog-quick-links-page.test.mjs` - добавлена регрессия на ссылку в заголовке map-card.

Проверки:

- `pnpm --filter @platforma/web test -- catalog-quick-links-page.test.mjs` - 227/227 passed.
- `pnpm --filter @platforma/web build` - passed.

Ручная проверка:

- Открыть `/catalog/map`, выбрать объект на карте и убедиться, что клик по названию в карточке открывает страницу объекта.

## 2026-06-03 - Hide KRT and apartment count in object parameters

Задача:

- В публичной карточке ЖК скрыть плашки `КРТ` и `Количество квартир` из блока `Основные параметры`, не удаляя данные объекта.

Изменения:

- `apps/web/src/objects/objectDetailViewModel.ts` - публичный список параметров больше не возвращает строки `КРТ` и `Количество квартир`.
- `apps/web/tests/object-detail-view-model.test.mjs` - обновлена регрессия, что эти данные могут быть во входном объекте, но не попадают в публичные rows.

Проверки:

- `pnpm --filter @platforma/web test -- object-detail-view-model.test.mjs` - 227/227 passed.
- `pnpm --filter @platforma/web build` - passed.

Ручная проверка:

- Открыть страницу любого ЖК и убедиться, что в блоке `Основные параметры` не отображаются плашки `КРТ` и `Количество квартир`.

## 2026-06-18 - Lot PDF presentation collections

Задача:

- Добавить именованные подборки лотов и генерацию PDF-презентаций по одному, выбранным или всем лотам подборки.
- Подтянуть в PDF данные текущего брокера, контакты из профиля, планировку лота и описание проекта.

Изменения:

- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260618120000_add_lot_presentations/migration.sql` - добавлены контакты брокера в `User`, таблицы подборок, позиций подборок, PDF-документов и связей документов с лотами.
- `apps/api/src/lot-presentations/*` - добавлены guarded API для лотов/подборок/PDF и генератор PDF на `pdfkit` с Noto Sans Cyrillic, логотипом FluffyWhite, ценовой плашкой, страницами лотов и страницами проектов.
- `apps/api/src/lot-presentations/lot-presentations.module.ts` - модуль импортирует `AuthModule`, чтобы `JwtAuthGuard` корректно поднимался в runtime.
- `apps/api/src/users/users.service.ts`, auth/shared contracts - контакты брокера сохраняются в профиле текущего пользователя и доступны в `AuthUser`.
- `apps/web/src/presentations/*`, `apps/web/src/App.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/styles.css` - добавлен раздел `Подборки`, UI управления подборками/PDF, кнопка на карточке лота и иконка в таблице лотов.
- `apps/web/src/styles.css` - модалка добавления лота в подборку переведена на `app-theme` цвета, чтобы окно читалось в темной теме.
- `apps/api/Dockerfile`, `apps/api/package.json`, `pnpm-lock.yaml` - API image включает логотип, добавлены `pdfkit` и шрифты.
- `apps/api/tests/lot-presentations-schema.test.cjs`, `apps/api/tests/services.test.cjs`, `apps/web/tests/lot-presentations-page.test.mjs`, `apps/web/tests/object-detail-feed-units.test.mjs` - добавлены и обновлены регрессии на новые контракты и UI-входы.

Проверки:

- `pnpm db:generate` - passed.
- `pnpm --filter @platforma/api test` - 190/190 passed.
- `pnpm --filter @platforma/web test` - 242/242 passed.
- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 6/6 passed.
- `pnpm build:web` - passed; Vite оставил только предупреждение о размере чанка.
- `curl -I http://localhost:5174/presentations` - 200 OK.
- `docker compose up -d --build api web` - контейнеры пересобраны; миграция `20260618120000_add_lot_presentations` применена.
- `docker compose up -d --build web` - web-контейнер пересобран для `http://localhost:5173`.
- `curl -fsS http://localhost:3000/health` - `{"status":"ok","database":"ok","postgis":true}`.
- `curl -I http://localhost:5173/presentations` - 200 OK.

Ручная проверка:

- Применить миграцию, войти брокером, заполнить телефон/почту в профиле, создать несколько подборок, добавить лот из карточки и из таблицы лотов.
- В темной теме открыть модалку `Добавить в подборку` и проверить контраст заголовков, текста, поля ввода и кнопки закрытия.
- Скачать PDF для одного лота, выбранных лотов и всей подборки; проверить предупреждение при лоте без планировки.
- Проверить PDF для лотов из одного ЖК и из разных ЖК: порядок групп по цене, страницы лотов перед страницей проекта, описание из `object.description`, до 6 изображений проекта.

Спорные места:

- Визуальную проверку через in-app Browser выполнить не удалось: в окружении не было доступного browser target (`iab` недоступен). Docker web пересобран и доступен на `http://localhost:5173/`.

## 2026-06-18 - Fix PDF presentation font coverage

Задача:

- Исправить квадраты в PDF-презентациях лотов: subset-шрифт `noto-sans-cyrillic` покрывал кириллицу, но не покрывал цифры, латиницу и символы вроде `₽`, `№`, `²`.

Изменения:

- `apps/api/assets/fonts/NotoSans-Regular.ttf`, `apps/api/assets/fonts/NotoSans-Bold.ttf`, `apps/api/assets/fonts/OFL.txt` - добавлены полноценные TTF-шрифты Noto Sans для PDF-генератора и лицензия OFL.
- `apps/api/src/lot-presentations/lot-presentations-pdf.service.ts` - PDF-генератор переключен с `@fontsource` subset `.woff` на локальные TTF assets с fallback-поиском пути для `src`/`dist`/Docker-сценариев.
- `apps/api/tests/lot-presentations-schema.test.cjs` - регрессия теперь проверяет наличие локальных TTF/OFL и запрещает возврат к `noto-sans-cyrillic-*.woff`.
- `apps/api/package.json`, `pnpm-lock.yaml` - удалена больше не используемая зависимость `@fontsource/noto-sans`.

Проверки:

- `pnpm --filter @platforma/api test -- --test-name-pattern "lot presentation service enforces"` - passed, фактически прошел весь API-набор `190/190`; повторно passed после удаления `@fontsource/noto-sans`.
- Cmap-проверка через `fontkit` подтвердила, что оба TTF покрывают пример `Соколин Парк квартира № 12 28 000 000 ₽ За м² FW user@example.com`.
- Сгенерирован временный PDF с новым шрифтом без ошибок, затем удален.

Ручная проверка:

- Скачать свежую PDF-презентацию лота и проверить, что в цене, площади, номере квартиры, контактах брокера и заголовках нет квадратов.

Спорные места:

- В окружении не было `pdftotext`/`mutool`/`qpdf`, поэтому автоматическое извлечение текста из PDF не запускалось.

## 2026-06-20 - Rebuild API with fixed PDF fonts

Задача:

- Повторно проверить квадраты в PDF после font fix: запущенный API всё ещё генерировал презентации старым `noto-sans-cyrillic` subset.

Изменения:

- Код не менялся; пересобран и пересоздан Docker `api`-контейнер, чтобы в runtime попал текущий `lot-presentations-pdf.service.ts` с локальными `NotoSans-Regular.ttf`/`NotoSans-Bold.ttf`.

Проверки:

- До пересборки `docker compose exec api grep ...` показал в контейнере старые ссылки на `@fontsource/noto-sans/files/noto-sans-cyrillic-*.woff`.
- `docker compose up -d --build api` - passed.
- После пересборки `dist/lot-presentations-pdf.service.js` в контейнере использует `NotoSans-Regular.ttf` и `NotoSans-Bold.ttf`; файлы `apps/api/assets/fonts/*` присутствуют внутри контейнера.
- `curl -fsS http://localhost:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- Smoke-генерация PDF внутри контейнера со строками `Квартал «Метроном», flat, № 1272` и `28 000 000 ₽ За м²` - `pdf-smoke-ok`.

Ручная проверка:

- Сгенерировать новый PDF-документ после пересборки API. Уже созданные ранее PDF в истории остаются старыми файлами и могут продолжать показывать квадраты.

Спорные места:

- Визуальный просмотр нового PDF вручную всё ещё нужен; автоматический PDF renderer/text extractor в окружении не установлен.

## 2026-06-21 - Refine lot PDF presentations UI

Задача:

- Переработать экран `Подборки` по согласованному варианту 2: убрать простыню лотов, оставить единый поиск, убрать кнопку `Контакты брокера`, добавить понятный просмотр созданных PDF и перенести создание подборки в блок подборок как кнопку `+`.

Изменения:

- `apps/web/src/presentations/LotPresentationsPage.tsx` - экран переведен на двухколоночный layout: слева подборки с кнопкой `+`, справа рабочая зона с поиском, действиями PDF и списком выбранных лотов. История созданных PDF открывается отдельной боковой панелью по кнопке `Созданные PDF`.
- `apps/web/src/styles.css` - обновлены стили для двухколоночной сетки, компактного поиска с popover-результатами, summary-счетчиков и drawer-панели PDF.
- `apps/web/tests/lot-presentations-page.test.mjs` - добавлена регрессия на согласованный layout: отсутствие `Контакты брокера`, отсутствие правой простыни лотов, наличие `+` в блоке подборок и popover-поиска.
- `apps/web/src/presentations/LotPresentationsPage.tsx`, `apps/web/src/styles.css` - по визуальным правкам варианта 2 кнопка `Созданные PDF` сделана компактнее с иконкой в одну строку, действия `Вся подборка`/`Выбранные` зафиксированы в одной строке, строка поиска расширена в рабочей зоне.
- `apps/web/tests/lot-presentations-page.test.mjs` - регрессия дополнена проверками компактной верхней кнопки, широкой поисковой колонки и горизонтальной группы PDF-действий.

Проверки:

- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 7/7 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- `docker compose up -d --build web` - web пересобран и поднят на `http://localhost:5173`; compose также пересоздал API-контейнер.
- `curl -fsS http://localhost:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- `curl -I http://localhost:5173/presentations` - 200 OK.
- Повторно после визуальных правок: `node --test apps/web/tests/lot-presentations-page.test.mjs` - 7/7 passed.
- Повторно после визуальных правок: `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- Повторно после визуальных правок: `docker compose up -d --build web` - web/API контейнеры пересобраны и запущены.
- Повторно после визуальных правок: `curl -fsS http://localhost:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- Повторно после визуальных правок: `curl -I http://localhost:5173/presentations` - 200 OK.

Ручная проверка:

- Открыть `http://localhost:5173/presentations`, проверить двухколоночный layout, создание подборки через `+`, поиск лотов в рабочей зоне, добавление лота из popover, скачивание `Вся подборка`/`Выбранные`, открытие и закрытие панели `Созданные PDF`.

Спорные места:

- DevTools Browser открыл `http://localhost:5173/presentations`, но без авторизованной сессии показал `/login`; доступные DevTools-команды не позволили выполнить логин, поэтому визуальная проверка самого экрана `Подборки` остается ручной.

## 2026-06-21 - Install Playwright for web QA

Задача:

- Установить Playwright и проверить, что он запускается на локальном web-приложении.

Изменения:

- `apps/web/package.json`, `pnpm-lock.yaml` - добавлен `@playwright/test` в devDependencies web-пакета.
- Локально через `pnpm --filter @platforma/web exec playwright install chromium` установлен Chromium/Headless Shell в cache Playwright пользователя.

Проверки:

- `pnpm --filter @platforma/web exec playwright --version` - `Version 1.61.0`.
- `curl -I http://localhost:5173/presentations` - 200 OK.
- `pnpm --filter @platforma/web exec playwright screenshot --browser=chromium http://localhost:5173/presentations /tmp/platforma-playwright-presentations.png` - passed, screenshot login screen created.
- Playwright API smoke через `chromium.launch()` открыл `http://localhost:5173/presentations`, подтвердил title `Platforma`, видимость `FluffyWhite` и кнопки `Войти`; неожиданных console errors нет.
- `pnpm --filter @platforma/web test` - 244/244 passed.

Ручная проверка:

- При необходимости использовать `/tmp/platforma-playwright-presentations.png` как быстрый smoke-скрин текущего unauthenticated состояния.

Спорные места:

- В unauthenticated smoke ожидаемо появляется console сообщение `401 (Unauthorized)` от auth refresh; оно отфильтровано как ожидаемое состояние без сессии.

## 2026-06-23 - Production same-origin API proxy

Задача:

- Убрать для браузера отдельный API-поддомен на production и перевести web bundle на same-origin `/api`, чтобы снизить риск iPad/WebKit/CORS-сбоев при загрузке каталога.

Изменения:

- Production nginx: добавлен `location /api/` на `broker.fluffywhite.moscow` с проксированием в `127.0.0.1:3000` и снятием `/api/`-префикса.
- Production env: `VITE_API_URL` изменен с `https://api.broker.fluffywhite.moscow` на `/api`.
- `.env.example` - добавлен комментарий про production `VITE_API_URL=/api`.
- `docs/staging-production-env-checklist.md` - добавлено правило same-origin `/api` и проверка `/api/health`.

Бэкап:

- `/root/platforma-backups/20260623T160946Z-same-origin-api` на production: nginx config, compose/env и `platforma-db.dump`.

Проверки:

- `nginx -t` на production - passed.
- `curl -fsS https://broker.fluffywhite.moscow/api/health` - `status=ok`, `database=ok`, `postgis=true`.
- `curl -fsS https://api.broker.fluffywhite.moscow/health` - fallback API-домен жив.
- `docker compose --env-file .env -f docker-compose.prod.yml up -d --build web` на production - web image rebuilt with `VITE_API_URL="/api"`; compose также пересоздал API-контейнер из cached image.
- Production containers после deploy: `platforma-web-1` up, `platforma-api-1` healthy, Postgres/Redis/MinIO healthy.
- Новый web bundle `index-DeFRxFvR.js` содержит `/api` и не содержит `api.broker.fluffywhite.moscow`.
- `curl https://broker.fluffywhite.moscow/api/objects` с invalid bearer возвращает ожидаемый `401` через same-origin path.

Ручная проверка:

- На iPad очистить данные сайтов `broker.fluffywhite.moscow` и `api.broker.fluffywhite.moscow`, перелогиниться и открыть `/catalog`.

Спорные места:

- После перехода cookies будут выдаваться на `broker.fluffywhite.moscow`; пользователям может понадобиться повторный вход.
- Dedicated `api.broker.fluffywhite.moscow` оставлен как fallback, но production web bundle больше не зависит от него.

## 2026-06-21 - Compact collection rename confirm button

Задача:

- В режиме переименования подборки заменить крупную кнопку `OK` на компактную icon-кнопку с галочкой, размером как кнопка редактирования.

Изменения:

- `apps/web/src/presentations/LotPresentationsPage.tsx` - submit-кнопка формы переименования теперь использует `icon-action-button`, `CheckIcon` и доступное имя `Сохранить название подборки`.
- `apps/web/tests/lot-presentations-page.test.mjs` - добавлена регрессия, запрещающая возврат к текстовой `OK`-кнопке.

Проверки:

- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 7/7 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- `docker compose up -d --build web` - web/API контейнеры пересобраны и запущены.
- `curl -fsS http://localhost:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- `curl -I http://localhost:5173/presentations` - 200 OK.
- Playwright desktop smoke в светлой теме - кнопка сохранения переименования `36x36`, без текста, внутри 1 SVG.
- Playwright desktop smoke в `dark-premium` - кнопка сохранения переименования `36x36`, без текста, внутри 1 SVG.

Ручная проверка:

- На `http://localhost:5173/presentations` нажать карандаш у подборки и проверить, что справа от поля названия видна компактная кнопка с галочкой.

Спорные места:

- Playwright smoke использовал локальную admin seed-учетку `admin@example.com` / `12345`; в другом окружении для визуальной проверки понадобится актуальная учетная запись.

## 2026-06-21 - Create collection modal visual options

Задача:

- Подготовить 3 визуальных варианта небольшой модалки создания подборки перед изменением рабочей логики.

Изменения:

- `docs/create-collection-modal-options.html` - добавлен интерактивно открываемый HTML-preview с тремя вариантами: центральная компактная модалка, контекстный поповер от плюса и плотная рабочая панель.

Проверки:

- `pnpm --filter @platforma/web exec playwright screenshot --browser=chromium file:///Users/nick/Documents/platforma/docs/create-collection-modal-options.html /tmp/create-collection-modal-options.png` - passed, все 3 варианта отрисованы.
- `open /Users/nick/Documents/platforma/docs/create-collection-modal-options.html` - preview открыт локально в браузере.

Ручная проверка:

- Выбрать один из трех вариантов в открытом HTML-preview перед внедрением в `LotPresentationsPage`.

Спорные места:

- Рабочая логика `/presentations` пока не менялась: это только визуальное согласование модалки.

## 2026-06-21 - Implement compact create collection modal

Задача:

- Внедрить выбранный вариант 1: при нажатии `+` в блоке подборок открывать небольшую центральную модалку с полем названия и компактными кнопками `Создать`/`Отмена`.

Изменения:

- `apps/web/src/presentations/LotPresentationsPage.tsx` - создание подборки переведено с мгновенного автосоздания на modal-flow: `+` открывает форму, пустое название валидируется внутри модалки, `Escape`, фон и `Отмена` закрывают окно без запроса.
- `apps/web/src/styles.css` - добавлены стили компактной центральной модалки, поля и маленьких кнопок без растягивания.
- `apps/web/tests/lot-presentations-page.test.mjs` - добавлена регрессия на modal-flow создания подборки и запрет возврата к прямому `handleCreateCollection()` по клику на `+`.

Проверки:

- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 8/8 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- `docker compose up -d --build web` - web/API контейнеры пересобраны и запущены.
- `curl -fsS http://localhost:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- `curl -I http://localhost:5173/presentations` - 200 OK.
- Playwright desktop smoke в светлой теме - модалка `380x217`, поле `342x42`, кнопки `80x38` и `84x38`, ошибка пустого названия внутри модалки.
- Playwright desktop smoke в `dark-premium` - модалка `380x217`, кнопки `78x38` и `81x38`, неожиданных console errors нет.
- Playwright mobile smoke `390x844` в `dark-premium` - модалка `350x217`, кнопки остаются в одной строке.
- Playwright submit smoke - через UI создана подборка `Playwright modal ...`, она стала выбранной по `collectionId`, после проверки удалена через API; неожиданных console errors нет.

Ручная проверка:

- На `http://localhost:5173/presentations` нажать `+`, ввести название подборки, нажать `Создать` и проверить, что новая подборка появилась слева и стала выбранной.

Спорные места:

- Playwright smoke использовал локальную admin seed-учетку `admin@example.com` / `12345`; в другом окружении для визуальной проверки понадобится актуальная учетная запись.

## 2026-06-21 - Open project lots modal from presentation search

Задача:

- Изменить строку поиска на экране `Подборки`: при поиске и выборе ЖК открывать модалку со всеми лотами проекта во вложенной структуре, с добавлением в текущую подборку и кнопкой закрытия. Быстрое добавление отдельного лота из popover убрано.

Изменения:

- `apps/web/src/presentations/LotPresentationsPage.tsx` - поиск переведен с отдельных лотов на результаты проектов; выбор проекта открывает modal-flow с группировкой по сроку сдачи и комнатности, таблицей лотов в стиле блока `Лоты` на странице объекта и кнопками добавления в активную подборку.
- `apps/api/src/lot-presentations/lot-presentations.service.ts` - `GET /lot-presentations/lots` получил фильтр `objectId` и лимит до 500 лотов для загрузки лотов одного ЖК без зависимости от `objects:read`.
- `apps/web/src/styles.css` - добавлены стили проектных результатов поиска и большой модалки лотов ЖК, переиспользующие существующие `object-feed-*` таблицы/группы.
- `apps/web/tests/lot-presentations-page.test.mjs`, `apps/api/tests/lot-presentations-schema.test.cjs` - добавлены регрессии на проектный поиск, модалку лотов ЖК и backend-фильтр `objectId`.

Проверки:

- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 9/9 passed.
- `node --test apps/api/tests/lot-presentations-schema.test.cjs` - 5/5 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- `pnpm --filter @platforma/api test` - 190/190 passed.
- `docker compose up -d --build api web` - fresh API/Web контейнеры пересобраны и запущены.
- `curl -fsS http://localhost:3000/health` - `status=ok`, `database=ok`, `postgis=true`.
- `curl -I http://localhost:5173/presentations` - 200 OK.
- Playwright smoke на `http://localhost:5173/presentations` с локальной admin seed-учеткой: поиск `Жилой квартал СИТИДЗЕН`, найден 1 проект, открыта модалка `Лоты ЖК`, найдено 2 completion-группы и 5 room-групп после раскрытия, неожиданных console errors нет.

Ручная проверка:

- На `http://localhost:5173/presentations` ввести название ЖК в строку поиска, выбрать проект, раскрыть группы лотов, добавить несколько лотов в активную подборку, закрыть модалку кнопкой `X` и проверить обновление счетчика/списка подборки.

Спорные места:

- Поиск проектов строится поверх доступных для презентаций лотов: ЖК без доступных лотов в выдачу не попадет.
- In-app Browser в текущей сессии был недоступен (`iab`), поэтому визуальный smoke выполнен через Playwright fallback.

## 2026-06-29 - Remove presentation picker reload flicker

Задача:

- Убрать мигание экрана при добавлении лота из рабочей зоны в подборку.

Изменения:

- `apps/web/src/presentations/LotPresentationsPage.tsx` - добавление лота в подборку больше не вызывает полный `loadCollections()` и `loadWorkspace()` в успешном пути; обновляется только измененная подборка, `collectionIds` нужного лота и локальный порядок подборок.
- `apps/web/tests/lot-presentations-page.test.mjs` - добавлена регрессия, запрещающая полный reload рабочей зоны при добавлении лота через picker.

Проверки:

- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 12/12 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- `pnpm --filter @platforma/web test` - 249/249 passed.

Ручная проверка:

- На `http://localhost:5173/presentations` открыть picker подборок у лота, добавить лот в существующую подборку и убедиться, что фон под модалкой не мигает.

Спорные места:

- Для одиночного добавления лота page-level success notice убран, чтобы не сдвигать контент под модалкой; ошибки по-прежнему отображаются в модалке.

## 2026-06-29 - Polish presentation workspace controls

Задача:

- Оставлять вкладку `В работе` открытой по умолчанию, выровнять кнопки рабочей зоны в одну аккуратную строку и упростить нижнюю форму создания подборки в picker-модалке.

Изменения:

- `apps/web/src/presentations/LotPresentationsPage.tsx` - убран initial auto-switch во вкладку `Мои подборки` при наличии `collectionId`; закрытие picker-а вынесено в единый обработчик; форма создания подборки внутри picker-а получила кнопки `ОК` и `Отмена`.
- `apps/web/src/styles.css` - toolbar рабочей зоны больше не растягивает кнопки на всю ширину; нижняя форма picker-а переведена в вертикальный layout: поле названия сверху, две кнопки снизу.
- `apps/web/tests/lot-presentations-page.test.mjs` - добавлены регрессии на дефолтную вкладку `В работе`, компактный toolbar и новую форму picker-а.

Проверки:

- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 12/12 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- `pnpm --filter @platforma/web test` - 249/249 passed.

Ручная проверка:

- На `http://localhost:5173/presentations` обновить страницу и проверить, что активна вкладка `В работе`, кнопки `Скачать все`, `Очистить всё`, `Добавить подборку` стоят рядом, а в picker-е новая подборка создается через поле названия и кнопки `ОК` / `Отмена`.

Спорные места:

- Прямое открытие URL с `collectionId` больше не переключает страницу в `Мои подборки` при загрузке; переключение остается при клике по подборке внутри интерфейса и при `popstate`.

## 2026-06-29 - Add collection tooltip to presentation lot tiles

Задача:

- При наведении на кнопку добавления лота в подборку показывать через 0.5 секунды подсказку со списком подборок, в которых уже есть конкретный лот.

Изменения:

- `apps/web/src/presentations/LotPresentationsPage.tsx` - рабочие плитки лотов получают имена подборок через `item.unit.collectionIds`; кнопка `Добавить в подборку` выводит доступный tooltip с заголовком `Подборка:` и именами только тех подборок, где уже есть этот лот.
- `apps/web/src/styles.css` - добавлено локальное оформление speech-bubble подсказки с хвостиком, скрытым состоянием и задержкой появления 0.5 секунды на hover/focus.
- `apps/web/tests/lot-presentations-page.test.mjs` - добавлена регрессия на передачу per-lot списка имен подборок, `aria-describedby`, `role="tooltip"` и CSS-задержку.

Проверки:

- `node --test apps/web/tests/lot-presentations-page.test.mjs` - 13/13 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил только предупреждение о размере чанка.
- `pnpm --filter @platforma/web test` - 250/250 passed.
- Playwright MCP открыл `http://localhost:5173/presentations`, но без авторизованной сессии попал на логин; единственная console error была ожидаемым `401` на `/auth/refresh`.
- Диагностика `localhost:5173` показала, что страницу отдавал Docker-контейнер `platforma-web-1` со старым production bundle без строк `Подборка:` / `lot-collection-tooltip`; локальный `apps/web/dist` был скопирован в `/app/apps/web/dist` контейнера после неудачной Docker-пересборки из-за `EAI_AGAIN registry.npmjs.org`.

Ручная проверка:

- В залогиненном браузере на `http://localhost:5173/presentations` навести курсор на кнопку папки у лота, который уже состоит в одной или нескольких подборках, подождать 0.5 секунды и проверить заголовок `Подборка:` со списком только этих подборок.

Спорные места:

- Если конкретный лот еще не находится ни в одной подборке, tooltip не показывается, чтобы не добавлять пустое окно; модалка добавления по клику продолжает показывать все подборки.

## 2026-07-04 - Extract catalog filter helpers

Задача:

- Начать оптимизацию фронтенда в отдельной ветке с безопасного первого среза: уменьшить перегруженный `CatalogPage.tsx` без изменения UI, CSS и поведения каталога.

Изменения:

- `apps/web/src/catalog/catalogFilters.ts` - вынесены типы фильтров каталога, default state, options и чистые helpers для URL/query/API params, sort, page size, room/id filters и sanitizing.
- `apps/web/src/catalog/CatalogPage.tsx` - страница теперь импортирует catalog filter helpers из отдельного модуля; JSX, className, стили и public flow не менялись.
- `apps/web/tests/catalog-lot-filters.test.mjs`, `apps/web/tests/catalog-directory-filter-search.test.mjs`, `apps/web/tests/catalog-pagination-controls.test.mjs`, `apps/web/tests/catalog-quick-links-page.test.mjs` - source-based проверки перенаправлены на новый helper-модуль там, где проверяется логика фильтров.

Проверки:

- `node --test apps/web/tests/catalog-lot-filters.test.mjs apps/web/tests/catalog-directory-filter-search.test.mjs apps/web/tests/catalog-pagination-controls.test.mjs apps/web/tests/catalog-quick-links-page.test.mjs` - 23/23 passed.
- `pnpm --filter @platforma/web test` - 250/250 passed.
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false` - passed.

Ручная проверка:

- Открыть `/catalog`, `/catalog?view=list`, `/catalog/map`; проверить поиск, advanced filters, sort, pagination, переключение cards/list и переход в `/objects/:slug` с активными lot filters.

Спорные места:

- Визуальную проверку не запускал, потому что в этом срезе не менялись разметка и CSS.
- Следующий безопасный frontend-срез: pure helpers из `ObjectDetailPage.tsx` или `LotPresentationsPage.tsx`; API/data-flow и защищённые media/download/map flows лучше не дробить первым шагом.

## 2026-07-05 - Extract object detail feed unit helpers

Задача:

- Продолжить оптимизацию фронтенда следующим безопасным срезом: уменьшить `ObjectDetailPage.tsx`, вынеся pure helpers для лотов и фильтров в существующий view-model без изменения UI, CSS и data-flow.

Изменения:

- `apps/web/src/objects/objectDetailViewModel.ts` - вынесены типы sort/filter, labels/options, парсинг initial lot filters из URL, room filter helpers, lot path builder, price/area/fact formatters и discount helpers.
- `apps/web/src/objects/ObjectDetailPage.tsx` - страница теперь импортирует feed unit helpers из view-model; компоненты, JSX, className, API-запросы и состояние загрузки не менялись.
- `apps/web/tests/object-detail-feed-units.test.mjs`, `apps/web/tests/object-lot-detail-page.test.mjs` - source-based проверки перенаправлены на view-model там, где проверяется вынесенная pure logic.
- `apps/web/tests/object-detail-view-model.test.mjs` - добавлены прямые unit-проверки lot view-model helpers, включая legacy empty labels и дробное форматирование.

Проверки:

- `node --test apps/web/tests/object-detail-view-model.test.mjs apps/web/tests/object-detail-feed-units.test.mjs apps/web/tests/object-lot-detail-page.test.mjs` - 30/30 passed.
- `pnpm --filter @platforma/web exec tsc -p tsconfig.json --noEmit --pretty false` - passed.
- `pnpm --filter @platforma/web test` - 253/253 passed.
- `pnpm --filter @platforma/web build` - passed; Vite оставил прежнее предупреждение о большом JS chunk.

Ручная проверка:

- Открыть `/objects/:slug` и проверить блок `Лоты`: initial filters из URL каталога, фильтры, сортировку, раскрытие групп, media carousel и переход в `/objects/:slug/lots/:unitId`.

Спорные места:

- Route-level lazy imports отложены в отдельный срез, потому что это runtime-изменение `App.tsx` и manual routing/loading behavior.
- Визуальную проверку не запускал, потому что CSS/разметка не менялись.
