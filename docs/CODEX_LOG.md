# Codex Log

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
