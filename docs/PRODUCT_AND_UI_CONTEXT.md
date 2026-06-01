# Product and UI Context

Дата восстановления: 2026-06-01.

Короткий практичный контекст для Codex. Код остается источником истины: `apps/web/src`, `apps/api/src`, `packages/shared/src`, `tools/wp-import/src`, `tools/feed-import/src`.

## Что это за продукт

`Platforma` - закрытая внутренняя брокерская платформа для работы с объектами недвижимости. Карта и каталог равноправны как основные рабочие сценарии. Подтверждение: `rules/project.md`, `apps/web/src/App.tsx`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`.

Продукт соединяет кабинет пользователя, каталог, карту, страницу объекта, админку объектов/пользователей/ссылок/фидов и импорт. Подтверждение: `docs/PAGES_AND_ROUTES.md`, `apps/web/src/App.tsx`, `apps/web/src/admin`, `apps/api/src/app.module.ts`.

## Основные пользователи

- Внутренний пользователь смотрит кабинет, доступные разделы и свой профиль. Подтверждение: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`.
- Брокер/оператор работает с каталогом, картой и карточками объектов. Подтверждение: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/objects/ObjectDetailPage.tsx`.
- Администратор управляет объектами, пользователями, быстрыми ссылками, источниками фидов и импортом. Подтверждение: `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/UsersAdminPage.tsx`, `apps/web/src/admin/CatalogLinksAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/ImportAdminPage.tsx`.

## Главные сценарии

- Кабинет: профиль, пароль, фото, список доступных разделов по permissions. Подтверждение: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Каталог: поиск, фильтры, quick links, сортировка, пагинация, карточки и список, переход в объект с lot filters. Подтверждение: `apps/web/src/catalog/CatalogPage.tsx`, `apps/api/src/objects/objects.service.ts`, `apps/api/src/catalog-links/catalog-links.service.ts`.
- Карта: `/catalog/map`, Yandex Maps, маркеры, выбранная карточка, список поверх/рядом с картой, фильтры как у каталога. Подтверждение: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/map/mapMarkerLabels.ts`, `apps/api/src/map/map.service.ts`.
- Объект: detail page по slug, галерея, файлы, карта, параметры, описания, feed lots и lot detail route. Подтверждение: `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/objects/objectDetailViewModel.ts`, `apps/api/src/objects/objects.service.ts`.
- Админка: управление пользователями, объектами, быстрыми ссылками каталога, фидами и импортом. Подтверждение: `apps/web/src/App.tsx`, `apps/web/src/admin`, `apps/api/src/users`, `apps/api/src/objects`, `apps/api/src/catalog-links`, `apps/api/src/feeds`.
- Импорт: WordPress preview/run/report, feed analyze/preview/run/stop, отдельные CLI repair flows. Подтверждение: `apps/web/src/admin/ImportAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/api/src/wordpress-import`, `apps/api/src/feeds`, `tools/wp-import/src`, `tools/feed-import/src`.

## UI-характер

- Это рабочий внутренний продукт, а не лендинг. Подтверждение: `rules/frontend.md`, `apps/web/src/App.tsx`.
- Интерфейс должен оставаться спокойным, плотным, читаемым и насыщенным данными. Подтверждение: `rules/frontend.md`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css`.
- Не использовать декоративный generic AI/SaaS стиль, hero-подачу, случайные градиенты, стекломорфизм или слабый контраст. Подтверждение: `rules/frontend.md`.
- Текущая визуальная система уже задана CSS-переменными, `Google Sans`, глобальными layout-классами и theme overrides. Подтверждение: `apps/web/src/styles.css`, `apps/web/src/app-theme.css`, `apps/web/src/appTheme.ts`.

## Что нельзя ломать

- Каталог: URL query params, фильтры, sort, pagination, cards/list switch и quick links. Подтверждение: `apps/web/src/catalog/CatalogPage.tsx`, `docs/RISK_ZONES.md`.
- Карту: Yandex no-key mode, markers, selected card, fallback, bounds list overlay and protected map/list model. Подтверждение: `rules/frontend.md`, `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`.
- Список/карточки: layout, media fallbacks, object links and lot filter handoff. Подтверждение: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/files/SecureImage.tsx`.
- Фильтры: names and serialization must stay aligned with backend search. Подтверждение: `apps/web/src/catalog/CatalogPage.tsx`, `apps/api/src/search/search-filters.ts`, `apps/api/src/objects/object-search.ts`.
- Permissions: frontend route/action gates must stay aligned with backend guards and seed data. Подтверждение: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`, `apps/api/src/auth/permissions.guard.ts`, `apps/api/prisma/seed.ts`.
- Import flows: preview/run boundaries, report views, feed queue/stop and repair separation. Подтверждение: `apps/web/src/admin/ImportAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `tools/wp-import/src/importer.ts`, `tools/wp-import/src/repair.ts`, `tools/feed-import/src/index.ts`.

## Минимальные UI-правила

- Сохранять текущий layout и app shell. Подтверждение: `apps/web/src/App.tsx`, `apps/web/src/styles.css`.
- Не менять порядок блоков без согласования, особенно в каталоге, карте, объекте и админке. Подтверждение: `rules/workflow.md`, `rules/frontend.md`, `docs/RISK_ZONES.md`.
- Не добавлять новые шрифты, иконки или UI-библиотеки без разрешения. Подтверждение: `rules/workflow.md`, `apps/web/src/styles.css`, `apps/web/package.json`.
- Сохранять accessibility states: focus, labels, errors, touch targets, contrast and reduced motion support. Подтверждение: `rules/frontend.md`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css`.
- Менять стили малыми блоками и проверять оба theme modes. Подтверждение: `rules/frontend.md`, `apps/web/src/styles.css`, `apps/web/src/app-theme.css`, `apps/web/src/appTheme.ts`.

## Что читать при UI-задачах

- Всегда: `AGENTS.md`, `rules/*.md`, `docs/PROJECT_INDEX.md`, `docs/PAGES_AND_ROUTES.md`, `docs/FEATURE_MAP.md`, `docs/RISK_ZONES.md`, этот файл.
- App shell/routing/permissions/cabinet: `apps/web/src/App.tsx`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/admin/api.ts`.
- Каталог и карта: `apps/web/src/catalog/CatalogPage.tsx`, `apps/web/src/map/YandexMap.tsx`, `apps/web/src/map/mapMarkerLabels.ts`, `apps/web/src/files/SecureImage.tsx`.
- Объект: `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/objects/objectDetailViewModel.ts`, `apps/web/src/files/fileDisplay.ts`.
- Админка: `apps/web/src/admin/ObjectsAdminPage.tsx`, `apps/web/src/admin/ObjectQuickEditTable.tsx`, `apps/web/src/admin/UsersAdminPage.tsx`, `apps/web/src/admin/CatalogLinksAdminPage.tsx`, `apps/web/src/admin/FeedsAdminPage.tsx`, `apps/web/src/admin/ImportAdminPage.tsx`, `apps/web/src/admin/AdminUi.tsx`.
- UI primitives and helpers: `apps/web/src/components/ui`, `apps/web/src/components/MultiSelectDropdown.tsx`, `apps/web/src/lib/numberInput.ts`, `apps/web/src/lib/utils.ts`.
- Styles: `apps/web/src/styles.css`, `apps/web/src/app-theme.css`, `apps/web/src/appTheme.ts`.
