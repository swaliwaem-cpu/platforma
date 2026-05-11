# План исправлений админки

## Правило выполнения

- Каждый пункт выполнения отмечается чекбоксом.
- Невыполненный пункт: `[ ]`.
- Выполненный пункт: `[x]`.
- По мере выполнения нужно обновлять этот файл и менять `[ ]` на `[x]`.
- Изменения делать небольшими UI-блоками без изменения бизнес-логики, API, ролей, маршрутов и поведения форм.
- После каждого крупного этапа запускать `pnpm build:web`.

## Контекст

Админка делится на четыре направления:

1. Общий polish всей админки небольшими правками.
2. Углубление админки объектов.
3. Углубление пользователей и ролей.
4. Углубление импорта WordPress.

Первый пункт уже выполнен как базовый слой: подключён `shadcn`, добавлены общие admin-компоненты, приведены к единому виду `/admin`, `/admin/objects`, `/admin/users`, `/admin/import`.

## Implementation Checklist

### Этап 1. Общий UI polish всей админки

- [x] Инициализировать `shadcn` в `apps/web`.
- [x] Добавить базовые компоненты `shadcn`: `button`, `card`, `table`, `badge`, `alert`, `empty`, `skeleton`, `input`, `field`.
- [x] Настроить alias `@/* -> src/*` для frontend.
- [x] Добавить общий слой `AdminUi.tsx` для кнопок, панелей, статусов, alert и empty state.
- [x] Привести входной экран `/admin` к карточкам разделов.
- [x] Привести таблицы пользователей, объектов и импорта к единому table-паттерну.
- [x] Заменить разрозненные уведомления на общий `AdminAlert`.
- [x] Заменить status pills на общий `AdminStatusBadge`.
- [x] Сохранить существующую бизнес-логику, API, маршруты и обработчики.
- [x] Запустить `pnpm build:web`.

Результат проверки:

- `pnpm build:web`: passed.
- `shadcn info`: компоненты установлены, registry `@shadcn` настроен.
- Без авторизации в браузере открывается login-экран; полноценный визуальный QA админки требует пользователя с правами.

### Этап 2. Доработать админку объектов

- [x] Проверить `/admin/objects` под пользователем с правами.
- [x] Улучшить таблицу объектов: читаемость длинных названий, slug, статусы, сортировка, пустое состояние.
- [x] Улучшить toolbar объектов: поиск, фильтр статуса, primary action `Новый объект`.
- [x] Улучшить `/admin/objects/new` и `/admin/objects/:id/edit`: визуально разделить основные данные, локации, цены и JSON-поля.
- [x] Сделать блок предпросмотра объекта более информативным: статус, цена, адрес, короткое описание, обложка.
- [x] Упорядочить media/PDF панели: загрузка, список, порядок, удаление.
- [x] Проверить мобильную раскладку списка и редактора объекта.
- [x] Запустить `pnpm build:web`.

Результат проверки:

- `pnpm build:web`: passed.
- Playwright fallback: `/admin/objects` desktop/mobile и `/admin/objects/:id/edit` desktop/mobile проверены с мокнутым admin auth/API.
- Проверены видимость списка, длинного названия, slug, toolbar, reset поиска, секции редактора, preview, media/PDF панели.
- Browser runtime для in-app browser недоступен в сессии: нет `node_repl js`, поэтому использован Playwright MCP fallback.
- Реальный QA с backend-сессией и пользователем с правами всё ещё желательно пройти вручную.

### Этап 3. Доработать пользователей и роли

- [x] Проверить `/admin/users` под пользователем с правами.
- [x] Улучшить таблицу пользователей: email, имя, роль, статус, дата создания, выбранная строка.
- [x] Улучшить форму создания/редактирования пользователя через единый field layout.
- [x] Сделать блок прав выбранной роли более сканируемым, без длинной строки permissions.
- [x] Проверить состояния кнопок по permissions: create, update, deactivate, activate.
- [x] Рассмотреть замену `window.confirm` для деактивации на shadcn `alert-dialog`, если это не усложнит первый проход.
- [x] Проверить empty/error/notice состояния.
- [x] Запустить `pnpm build:web`.

Результат проверки:

- `pnpm build:web`: passed.
- Playwright fallback: `/admin/users` desktop/mobile проверен с мокнутым admin auth/API.
- Проверены таблица пользователей, выбранная строка, role permissions, reset фильтров и inline-подтверждение деактивации.
- Проверены disabled-состояния кнопок без permissions: create, update/save, deactivate.
- Browser runtime для in-app browser недоступен в сессии: нет `node_repl js`; Playwright MCP был заблокирован занятым профилем, поэтому использован временный `npx playwright` fallback с системным Chrome.
- Реальный QA с backend-сессией и пользователем с правами всё ещё желательно пройти вручную.

### Этап 4. Доработать импорт WordPress

- [x] Проверить `/admin/import` под пользователем с правами.
- [x] Улучшить header actions: `Preview`, `Run`, `Обновить`, `Назад`, disabled/loading состояния.
- [x] Улучшить таблицу отчётов: старт, длительность, режим, статус, объекты, warnings, errors.
- [x] Улучшить панель выбранного отчёта: summary metrics, warnings, errors, источник, время старта/финиша.
- [x] Сделать warnings/errors удобнее для чтения, сохранив текущие данные отчёта.
- [x] Проверить состояния `PENDING`, `SUCCESS`, `PARTIAL`, `FAILED`.
- [x] Проверить empty/error/notice состояния.
- [x] Запустить `pnpm build:web`.

Результат проверки:

- `pnpm build:web`: passed.
- Playwright fallback: `/admin/import` desktop/mobile проверен с мокнутым admin auth/API.
- Проверены header actions, disabled/loading labels, таблица отчётов со стартом/длительностью/режимом/статусом/метриками, detail panel, summary metrics, warnings/errors cards и raw source details.
- Проверены статусы `PENDING`, `SUCCESS`, `PARTIAL`, `FAILED`, фильтр по статусу, reset фильтров, запуск `Preview`, notice, empty state и error alert.
- Browser runtime для in-app browser недоступен в сессии: нет `node_repl js`, поэтому использован Playwright MCP fallback.
- Реальный QA с backend-сессией и пользователем с правами всё ещё желательно пройти вручную.

### Этап 5. Manual QA

- [x] Проверить `/admin`.
- [x] Проверить `/admin/objects`.
- [x] Проверить `/admin/objects/new`.
- [x] Проверить `/admin/objects/:id/edit`.
- [x] Проверить `/admin/users`.
- [x] Проверить `/admin/import`.
- [x] Проверить desktop ширину.
- [x] Проверить mobile ширину.
- [x] Проверить keyboard focus states.
- [x] Проверить, что обычный пользователь без прав не получает доступ к admin-разделам.

Результат проверки:

- `pnpm build:web`: passed.
- QA выполнен на локальной связке `http://localhost:5173` + `http://localhost:3000` под реальным admin-пользователем.
- Playwright fallback: Browser Use недоступен в сессии из-за отсутствия `node_repl js`, Playwright MCP заблокирован занятым Chrome-профилем, поэтому использован временный Playwright в `/tmp` с системным Chrome.
- Проверены desktop `1440x1000` и mobile `390x844` для `/admin`, `/admin/objects`, `/admin/objects/new`, `/admin/objects/:id/edit`, `/admin/users`, `/admin/import`.
- Проверены page identity, непустой render, отсутствие Vite/framework overlay, отсутствие релевантных console/page errors, отсутствие body-level horizontal overflow и обрезанных control labels.
- Проверена навигация из `/admin` в `/admin/objects` через action card.
- Keyboard focus states проверены tab-навигацией по sidebar/header и toolbar search: видимый focus ring на `input.admin-toolbar-search`.
- Доступ обычного пользователя без `admin:access` проверен на mocked frontend session без записи в базу: `/admin` показывает `Недостаточно прав`, admin navigation скрыта.
- Скриншоты и machine-readable результат сохранены вне репозитория: `/tmp/platforma-admin-qa/result.json`.
- Реальный QA с настоящими credentials обычного пользователя без прав всё ещё желательно пройти вручную, если такие credentials есть.

## Public Interfaces

- Backend API не меняется.
- Shared-типы не меняются.
- Frontend routes не меняются.
- Добавляется frontend alias `@/*`.
- Добавляется локальный shadcn config `apps/web/components.json`.
- Новые UI-зависимости допустимы только из shadcn init/add и уже установлены на этапе 1.

## Assumptions

- Админка остаётся светлой, спокойной, рабочей и плотной по данным.
- Не добавляем декоративный hero, SaaS-градиенты, стекломорфизм и случайные визуальные эффекты.
- Первый этап считается базовым UI-слоем, следующие этапы углубляют конкретные сценарии без переписывания логики.
