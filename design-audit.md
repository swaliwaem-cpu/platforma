# Design Audit

Дата: 2026-05-18

Проект: внутренняя брокерская платформа Platforma.

Задача аудита: оценить только визуальный слой без изменения layout, порядка блоков, маршрутов, бизнес-логики и данных.

## Как запускать локально

Проект уже был запущен в рабочем окружении:

- Web: `http://localhost:5173`
- API: `http://localhost:3000`
- API health: `GET /health` отвечает `200`
- Docker services: `postgres`, `redis`, `minio`, `api` находятся в healthy/up состоянии

Команда web-запуска по правилам проекта:

```bash
pnpm dev:web -- --port 5173 --strictPort
```

Команда API:

```bash
pnpm dev:api
```

Важно: порт `5173` нельзя менять автоматически. Если он занят, сначала нужно остановить старый процесс или согласовать действие.

## Что было просмотрено

Открыл и просмотрел через Playwright / Chrome DevTools:

- `/login`
- `/cabinet`
- `/catalog`
- `/catalog?view=list`
- `/catalog/map`
- `/objects/zhiloj-kvartal-foriver-residence`
- `/admin`
- `/admin/users`
- `/admin/objects`
- `/admin/import`

Также проверил mobile viewport `390x844` для каталога, таблицы пользователей и раскрытого sidebar.

Browser Use runtime через `node_repl` в текущем сеансе не был доступен, поэтому использован разрешенный fallback: Playwright / Chrome DevTools.

## Общая оценка

Интерфейс уже идет в правильную сторону: он сдержанный, рабочий, без маркетинговых hero-блоков и без SaaS-фиолетового шума. Хорошо выглядят детальная страница объекта, карточки каталога с реальными изображениями, часть map markers и базовые focus states.

Главная проблема сейчас не в композиции, а в неоднородности визуальной системы. В проекте одновременно живут глобальные CSS-классы, shadcn-компоненты, catalog-токены и отдельные admin-стили. Из-за этого одни экраны выглядят собранно, а другие воспринимаются как набор похожих белых контейнеров с разной плотностью, разным весом текста и разной логикой кнопок.

Без изменения layout можно заметно поднять ощущение качества через унификацию типографики, токенов, surface/elevation, таблиц, кнопок и form controls.

## Что выглядит плохо или дешево

- Слишком много одинаковых белых панелей с одинаковыми тенями. Header, filters, quick links, tables, editor panels и cards часто конкурируют как равнозначные карточки.
- Часть экранов выглядит “карточка в карточке”: особенно admin home, users, import и catalog filters. Это делает интерфейс более декоративным, чем рабочим.
- Черные primary-кнопки в каталоге (`+ фильтры`, `Показать на карте`) визуально тяжелее синего primary в админке и зеленых object actions. Сейчас нет ясного правила, где primary blue, где ink-black, где forest.
- Sidebar в collapsed-состоянии оставляет заметную пустую вертикальную область. На mobile это особенно дорого: при ширине `390px` рабочая область сжимается примерно до `290px`.
- В раскрытом mobile sidebar контент страницы не перекрывается, а уезжает/обрезается справа. Это выглядит как технический компромисс, а не как отполированный app shell.
- В таблицах admin/users и admin/import часть данных визуально тесная, строки тяжелые, а правые action-колонки могут уходить из видимой области. Пользователь не сразу понимает, что таблица горизонтально скроллится.
- В каталоге быстрые ссылки занимают много высоты и выглядят как отдельный большой блок управления, хотя это вторичный навигационный слой.
- Disabled-кнопки иногда выглядят как просто слабый текст в активной форме, а не как системное disabled-состояние.

## Типографика

- Есть хороший базовый стиль: Inter/system, крупные заголовки, нулевой letter-spacing. Это подходит внутренней платформе.
- Размеры и веса местами скачут: `font-weight: 850/900` используется очень часто, из-за чего почти все элементы становятся одинаково важными.
- `eyebrow` выглядит слишком похожим на table headers и field labels. Нужны отдельные роли: page eyebrow, section label, table header, form label, badge text.
- На детальной странице H1 объекта сильный и премиальный, но на admin-страницах заголовки проще и слабее. Это нормально по роли, но нужно унифицировать scale.
- В таблицах данные и labels слишком близки по весу. Например, email, role badges, даты и action links спорят за внимание.
- Для чисел, цен, дат и ID стоит завести tabular numeric style: `font-variant-numeric: tabular-nums;`.

Что можно улучшить без изменения layout:

- Ввести 5-6 стабильных text roles: `display`, `page-title`, `section-title`, `body`, `label`, `data`.
- Снизить частоту `850/900`; оставить тяжелые веса только для page title, primary action, key price, active state.
- Для helper text и metadata использовать один muted-tone и один line-height.
- Для таблиц усилить различие между primary cell и secondary metadata через размер, тон и line-height.

## Отступы и плотность

- Базовая сетка близка к 8px, но в CSS смешаны `7`, `10`, `12`, `13`, `14`, `15`, `16`, `18`, `20`, `24`, `28`, `32`.
- В формах admin плотность хорошая, но на некоторых экранах много вертикальных “коробок”, которые создают ощущение длинной страницы.
- Catalog cards выглядят аккуратно, но facts внутри карточек местами перегружают низ карточки.
- Users layout на desktop визуально зажат: таблица + editor panel оставляют мало воздуха для таблицы.
- На mobile отступы внутри карточек хорошие, но app shell забирает слишком много ширины.

Что можно улучшить без изменения layout:

- Ввести spacing scale: `4`, `8`, `12`, `16`, `20`, `24`, `32`.
- Убрать случайные `13/14/15/18` там, где они не несут смысла.
- Настроить плотность таблиц отдельно от плотности cards: tables должны быть сканируемыми, но не “пухлыми”.
- Для повторяющихся panel headers использовать один vertical rhythm: eyebrow -> title -> actions.

## Цвета

Существующая палитра из `DESIGN.md` хорошая: cool neutrals, operational blue, catalog forest, quiet copper, semantic colors. Проблема в применении.

Проблемы:

- Много raw hex в `styles.css`, хотя часть токенов уже есть в `:root`.
- Синий, темный ink и зеленый конкурируют как primary actions.
- Каталог использует более зрелую token-систему, а admin-часть чаще живет на raw colors.
- Некоторые neutral states слишком близки: `#eef1f4`, `#f8fafc`, `#ffffff`, soft blue и table hover не всегда различаются по роли.
- На карте blue markers хорошо читаются, но подписи вида `от 329т/м²` выглядят технически и требуют отдельного data-format визуального решения.

Что можно улучшить без изменения layout:

- Закрепить роли цветов: `primary` для системных действий, `object` для действий по объектам, `ink` только для high-emphasis neutral actions.
- Перенести admin colors на те же CSS variables, что и catalog.
- Ограничить Accent Budget: blue/forest/copper только для active/action/status, не для декоративных подсветок.
- Сделать отдельные tokens для table hover, selected row, disabled surface, subtle surface.

## Кнопки

Сильные стороны:

- Большинство кнопок имеет нормальную высоту `38-50px`.
- Focus states в целом видимые.
- Icons из lucide используются в admin actions.

Проблемы:

- Есть несколько разных button systems: `.primary-button`, `.secondary-button`, `.admin-button`, shadcn `Button`, `.catalog-map-button`, `.catalog-card-link`, `.object-detail-action-button`.
- Primary action не всегда предсказуем: синий в admin, черный в catalog controls, зеленый в object actions.
- Hover/focus иногда меняют только фон, иногда добавляют ring, иногда shadow. Это снижает ощущение единой системы.
- Disabled state часто построен на `opacity`, из-за чего кнопки выглядят “приглушенно”, но не всегда системно.
- В catalog controls pill-кнопки выглядят аккуратно, но `Карточками / Списком` как текстовая конструкция перегружена.

Что можно улучшить без изменения layout:

- Ввести единый button token set: `primary`, `secondary`, `neutral`, `object`, `danger`, `ghost`.
- Установить общие состояния: hover, focus-visible, active, disabled.
- Для active segmented controls использовать не только цвет, но и border/ring/pressed state.
- Согласовать radius: обычные кнопки `6px`, segmented/pill controls `999px`.

## Поля и формы

Сильные стороны:

- Labels видимые, не только placeholder.
- Inputs имеют нормальную высоту и focus ring.
- В админке формы достаточно структурированы.

Проблемы:

- Inputs и selects визуально тяжелые из-за одинакового border/high contrast на больших группах.
- Placeholder иногда слишком жирный и похож на введенный текст.
- File input в кабинете выглядит как браузерный control и выбивается из премиального стиля.
- Select arrows и input icons не всегда выдержаны в одной визуальной плотности.
- Ошибки/notice выглядят как просто жирный цветной текст; им не хватает единого inline feedback-паттерна.

Что можно улучшить без изменения layout:

- Сделать tokenized input states: default, hover, focus, invalid, disabled.
- Снизить вес placeholder, усилить различие между label и value.
- Привести file input к тому же стилю, что upload/dropzone в админке.
- Для validation завести общий `field-message` с semantic colors и spacing.

## Карточки и panels

Проблемы:

- Слишком много panels имеют одинаковый radius, border, shadow и white background.
- Admin action cards выглядят простовато: заголовок, описание, кнопка, но нет тонкой иерархии внутри.
- Catalog quick links выглядят как большой table-like panel; по значимости они спорят с header и filters.
- Cabinet cards хорошо читаются, но форма профиля выглядит тяжелее, чем данные профиля.
- Некоторые nested cells (`facts`, `metrics`, `permissions`) добавляют много бордеров внутри бордеров.

Что можно улучшить без изменения layout:

- Ввести surface levels: `canvas`, `panel`, `panel-soft`, `cell`, `overlay`.
- Уменьшить shadows для обычных panels, оставить сильную elevation только для overlay/map/card hover.
- Уточнить border contrast: внешние panels сильнее, внутренние cells мягче.
- Сделать panel title spacing единым во всех секциях.

## Таблицы

Проблемы:

- Admin tables перегружены весом текста: email/title, badge, date и action link одновременно выглядят как primary.
- На mobile таблицы просто обрезаются внутри узкой области, без явного affordance горизонтального скролла.
- В users table правая action-колонка на desktop может быть частично вне видимой области из-за соседнего editor panel.
- Row hover/selected state есть, но визуально слишком близок к обычному pale blue surface.
- Import table имеет много чисел и коротких labels, но нет tabular rhythm и плотной numeric-иерархии.

Что можно улучшить без изменения layout:

- Завести table density tokens: header height, row padding, cell gap, subtext size.
- Добавить sticky/visible action affordance только визуально, если структура позволяет без изменения DOM.
- Включить `font-variant-numeric: tabular-nums` для дат, цен, durations, counters.
- Снизить border noise: использовать row separators мягче, hover сделать более уверенным.
- Добавить subtle scroll hint для overflowing tables.

## Карта

Сильные стороны:

- Карта воспринимается как полноценный рабочий режим, не как маленький виджет.
- Markers читаются поверх карты.
- Overlay-list справа соответствует защищенной модели продукта.

Проблемы:

- Overlay справа плотный и утилитарный, но визуально менее отполирован, чем object cards.
- Toggle `Скрыть/показать` выглядит технически и длинно для маленькой кнопки.
- Marker text с сокращениями вроде `т/м²` читается как внутренний debug/data формат.
- При invalid Yandex API key в консоли есть warning; визуально карта все равно открылась через доступный режим, но это стоит проверить отдельно вне дизайн-аудита.

Что можно улучшить без изменения layout:

- Уточнить typography markers/list: price label, object title, district, price per m².
- Дать overlay-list более четкий header и muted stats.
- Согласовать map marker selected state с catalog copper.

## Sidebar

Проблемы:

- Collapsed sidebar на desktop и mobile выглядит как пустая вертикальная плита с одной кнопкой.
- На mobile open sidebar сжимает контент, и правая часть страницы обрезается.
- Активный nav item хороший по контрасту, но в раскрытом состоянии sidebar визуально тяжелее, чем рабочая область.

Что можно улучшить без изменения layout:

- Сделать collapsed rail более намеренным: компактная surface, менее тяжелая тень, стабильная icon-zone.
- В open state облегчить shadow и усилить связь nav items с app shell.
- Для mobile как минимум уменьшить визуальный конфликт между sidebar и content через overlay tint/surface treatment. Это уже близко к layout-поведению, поэтому требует отдельного согласования.

## Что можно улучшить без изменения layout

1. Унифицировать tokens и убрать raw hex из новых визуальных правок.
2. Привести все button variants к единой системе states.
3. Сделать typography scale и снизить количество сверхжирных текстов.
4. Стабилизировать table density, hover, selected и disabled states.
5. Облегчить shadows у обычных panels, оставить сильные shadows только для overlays и hover cards.
6. Улучшить placeholder/helper/error styles у forms.
7. Добавить tabular nums для дат, цен, счетчиков и ID-like данных.
8. Согласовать catalog/admin surfaces, чтобы они ощущались как один продукт.
9. Смягчить visual noise от nested borders в cards/forms/tables.
10. Проверить mobile visual polish у sidebar и overflowing tables без перестройки страниц.

## Рекомендуемые дизайн-токены

### Fonts

```css
--font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: "SFMono-Regular", "SF Mono", Consolas, monospace;
--font-weight-regular: 400;
--font-weight-medium: 600;
--font-weight-bold: 750;
--font-weight-heavy: 850;
```

### Type scale

```css
--text-xs: 12px;
--text-sm: 13px;
--text-md: 14px;
--text-base: 16px;
--text-title: 22px;
--text-page: 28px;
--text-display: 40px;
```

### Colors

```css
--color-ink-900: #18202a;
--color-ink-800: #303b47;
--color-ink-700: #536172;
--color-ink-600: #6d7885;

--color-canvas: #eef1f4;
--color-surface: #ffffff;
--color-surface-soft: #f8fafc;
--color-surface-muted: #f2f4f7;

--color-border-strong: #bcc7d3;
--color-border: #d6dde5;
--color-border-soft: #e0e6ed;

--color-primary: #2563eb;
--color-primary-deep: #174ea6;
--color-primary-soft: #edf4ff;

--color-object: #1f6b5b;
--color-object-deep: #19584b;
--color-object-soft: #eaf6f1;

--color-accent-copper: #a45f3d;
--color-accent-copper-soft: #fbefe7;

--color-success: #19733d;
--color-success-soft: #e7f7ed;
--color-warning: #855b00;
--color-warning-soft: #fff7df;
--color-danger: #b42318;
--color-danger-soft: #fff4f2;
```

### Spacing

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
```

### Radius

```css
--radius-xs: 4px;
--radius-sm: 6px;
--radius-md: 8px;
--radius-pill: 999px;
```

### Shadows

```css
--shadow-panel: 0 10px 28px rgb(24 32 42 / 6%);
--shadow-card: 0 14px 34px rgb(24 32 42 / 8%);
--shadow-card-hover: 0 20px 48px rgb(24 32 42 / 12%);
--shadow-overlay: 0 24px 70px rgb(24 32 42 / 16%);
--shadow-focus-primary: 0 0 0 3px rgb(37 99 235 / 16%);
--shadow-focus-object: 0 0 0 3px rgb(31 107 91 / 16%);
```

### Borders

```css
--border-width-default: 1px;
--border-subtle: 1px solid var(--color-border-soft);
--border-default: 1px solid var(--color-border);
--border-strong: 1px solid var(--color-border-strong);
```

## 3-4 визуальных направления

### 1. Quiet Brokerage Desk

Самое безопасное направление для текущего продукта. Сохраняет светлую тему, cool neutrals, border-first surfaces, сдержанные shadows, blue для system actions и forest для object actions. Основной выигрыш: продукт станет дороже без заметного редизайна.

Подходит для первого этапа.

### 2. Dense Operations Console

Более рабочее и плотное направление для admin/users/import/objects. Меньше теней, больше table clarity, четче headers, tabular nums, спокойные row states. Каталог остается визуальнее, админка становится быстрее для сканирования.

Подходит для второго этапа после унификации tokens.

### 3. Premium Real Estate Catalog

Акцент на карточках объектов, фото, detail page и карте. Чуть больше editorial-качества в typography, мягче cards, аккуратнее image overlays, выразительнее price/location facts. Без hero и без изменения структуры.

Подходит для каталога и object detail.

### 4. Map-First Broker Workspace

Визуально усиливает карту как равноправный режим: лучше markers, selected state, overlay-list, map object card, map fallback. Не меняет protected map model, а делает ее более убедительной и менее технической.

Подходит как отдельный согласованный блок, потому что карта является ключевой продуктовой поверхностью.

## Рекомендуемый порядок дальнейших визуальных правок

1. Зафиксировать tokens и button/input/table state rules.
2. Привести admin и catalog к одной token-системе.
3. Улучшить таблицы и формы, потому что они дают максимальный прирост качества без риска для layout.
4. Затем полировать catalog cards, map overlays и object detail.
5. Отдельно согласовать mobile sidebar/table overflow, потому что там визуальные проблемы близки к поведению layout.

## Спорные места

- Mobile sidebar: визуально просится overlay-поведение, но это уже может считаться изменением layout/поведения.
- Быстрые ссылки каталога: можно сделать визуально легче без переноса, но вопрос их продуктовой важности лучше подтвердить.
- Черный primary в catalog controls: выглядит уверенно, но спорит с blue primary; нужно выбрать правило.
- Сильный вес `850/900`: дает уверенность, но при массовом применении делает экран шумным.
