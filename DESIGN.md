---
name: Platforma
description: "Закрытая внутренняя брокерская платформа, где карточки каталога и карта имеют равный вес."
colors:
  ink-900: "#18202a"
  ink-800: "#303b47"
  ink-700: "#536172"
  ink-600: "#66736f"
  canvas: "#eef1f4"
  surface-panel: "#ffffff"
  surface-soft: "#f8fafc"
  surface-map-soft: "#eef3f7"
  surface-catalog: "#f4f6f3"
  border-strong: "#bcc7d3"
  border-default: "#d6dde5"
  border-soft: "#e0e6ed"
  primary-blue: "#2563eb"
  primary-blue-deep: "#174ea6"
  primary-blue-soft: "#edf4ff"
  catalog-forest: "#1f6b5b"
  catalog-forest-deep: "#19584b"
  catalog-copper: "#a45f3d"
  success-green: "#19733d"
  success-soft: "#e7f7ed"
  warning-amber: "#855b00"
  warning-soft: "#fff7df"
  danger-red: "#b42318"
  danger-soft: "#fff4f2"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0"
rounded:
  sm: "6px"
  md: "8px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "18px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary-blue}"
    textColor: "{colors.surface-panel}"
    rounded: "{rounded.sm}"
    padding: "12px 14px"
  button-secondary:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink-800}"
    rounded: "{rounded.sm}"
    padding: "12px 14px"
  input:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.sm}"
    padding: "12px 14px"
  content-panel:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.md}"
    padding: "32px"
  catalog-card:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.md}"
    padding: "16px"
  map-marker:
    backgroundColor: "{colors.primary-blue}"
    textColor: "{colors.surface-panel}"
    rounded: "{rounded.pill}"
    padding: "0 14px 0 25px"
---

# Design System: Platforma

## 1. Overview

**Creative North Star: "Закрытый брокерский стол"**

Platforma - рабочий внутренний продукт, а не маркетинговая страница. Интерфейс должен ощущаться как спокойный премиальный стол брокера: структурный, быстрый, уверенный и пригодный для ежедневной повторяющейся работы. Визуальный язык поддерживает сравнение, проверку, карту, редактирование и администрирование без театрального декора.

Физическая сцена продукта: брокер, редактор или администратор работает за desktop или laptop в офисной среде, часто сравнивает много объектов и переключается между списком, карточками, картой и детальной страницей. Светлая тема является базовой, потому что она сохраняет читаемость карт, фотографий, таблиц, форм и длинных описаний в дневной операционной работе.

Система отвергает SaaS-фиолетовые градиенты, generic AI-дизайн, стекломорфизм, случайные эмодзи, огромные hero-блоки, слабый контраст, детские цвета и декоративный UI, который замедляет пользователя. Будущие редизайн-правки должны выполняться небольшими согласованными блоками.

**Key Characteristics:**

- сдержанный светлый product UI с высокой информационной плотностью;
- карта и карточки объектов как равные первичные поверхности;
- иерархия через отступы, вес шрифта и состояния, а не через декоративность;
- премиальная сдержанность: стабильные компоненты, сильный контраст, точный ритм;
- ощущение быстрой рабочей системы с короткими transitions и без page-load хореографии.

## 2. Colors

Палитра строится на сдержанных прохладных нейтралях, функциональном синем акценте, приземленном catalog green для действий с объектами и редком copper-акценте для объектных badges.

### Primary

- **Operational Blue** (`#2563eb`): primary actions, focus rings, active navigation, selected table states и map price markers, если нет более точного состояния.
- **Deep Operational Blue** (`#174ea6`): links, active sort states и контрастный текст на pale blue surfaces.
- **Soft Operational Blue** (`#edf4ff`): selected navigation, role pills и active row backgrounds.

### Secondary

- **Catalog Forest** (`#1f6b5b`): object-card actions и real estate calls to action. Использовать, когда действие относится к исследованию объекта, а не к системному администрированию.
- **Deep Catalog Forest** (`#19584b`): hover и focus treatment для forest actions.
- **Quiet Copper** (`#a45f3d`): редкий теплый акцент для presentations, media badges, selected map context и object metadata, который должен выделяться без ощущения ошибки.

### Neutral

- **Ink 900** (`#18202a`): основной текст интерфейса, panel titles, map popup titles.
- **Ink 800** (`#303b47`): body text, table cells, form labels.
- **Ink 700** (`#536172`): helper text, metadata, table headers, empty state descriptions.
- **Canvas** (`#eef1f4`): фон приложения за shell.
- **Panel White** (`#ffffff`): текущая поверхность panels и sidebar. В новых редизайн-шагах лучше двигаться к слегка тонированной поверхности, но только после согласования.
- **Soft Surface** (`#f8fafc`): metric cells, detail rows, list items и компактные повторяющиеся блоки.
- **Border Default** (`#d6dde5`): границы panels, pagination, map panels.
- **Border Soft** (`#e0e6ed`): table row dividers и внутренние separators.

### Semantic

- **Success Green** (`#19733d` на `#e7f7ed`): успешные imports, published objects, active users, positive notices.
- **Warning Amber** (`#855b00` на `#fff7df`): invited users, draft objects, partial imports, состояния, которым нужно внимание, но не ошибка.
- **Danger Red** (`#b42318` на `#fff4f2`): destructive actions, blocked users, failed imports, validation errors.

### Named Rules

**The Accent Budget Rule.** Blue и forest должны занимать примерно до 10 процентов обычного рабочего экрана. Их редкость сохраняет смысл.

**The No Purple SaaS Rule.** Не вводить purple-blue gradients, neon highlights и декоративные gradient fills.

**The State Must Read Rule.** Каждый semantic color должен сопровождаться текстом или структурным признаком. Одного цвета недостаточно.

## 3. Typography

**Display Font:** Inter с system UI fallbacks.
**Body Font:** Inter с system UI fallbacks.
**Label/Mono Font:** отдельная mono family не заведена.

**Character:** Типографика утилитарная и премиальная за счет сдержанности. Одна sans family несет headings, labels, data, controls и body copy. Иерархия строится на размере, весе, отступах и layout.

### Hierarchy

- **Display** (700, 32px, 1.1): название продукта в sidebar и редкие top-level product titles.
- **Headline** (700, 28px, 1.2): page titles для catalog, map, admin и object views.
- **Title** (700, 22px, 1.25): panel headings, editor headings, import report headings.
- **Body** (400, 16px, 1.6): длинные описания, empty states, detail copy. Проза по возможности остается в диапазоне 65-75ch.
- **Data Body** (400-800, 14px, 1.35-1.5): table cells, object facts, metadata rows, compact list items.
- **Label** (700-900, 12-13px, 1.2): table headers, badges, chips, eyebrow labels, compact controls.

### Named Rules

**The No Display Font Rule.** Не добавлять декоративные display fonts в labels, buttons, forms, tables или map controls.

**The Legible Density Rule.** Плотные экраны допустимы, но текст не должен ощущаться сжатым. Базовый ритм: 12-18px для компактных групп и ясное разделение строк.

## 4. Elevation

Система использует гибрид borders, tonal surfaces и restrained shadows. Panels обычно задаются 1px cool border и мягкой ambient shadow. Map overlays и object cards могут подниматься сильнее, потому что находятся поверх пространственного контента. Blur и glass effects не используются как декор.

### Shadow Vocabulary

- **Panel Ambient** (`box-shadow: 0 16px 40px rgb(24 32 42 / 8%)`): login panel, content panel, tables, filters, map panel, object detail surfaces.
- **Catalog Card Rest** (`box-shadow: 0 18px 44px rgb(28 37 36 / 9%)`): object cards at rest.
- **Catalog Card Hover** (`box-shadow: 0 24px 58px rgb(28 37 36 / 14%)`): object card hover или focus-within.
- **Map Overlay** (`box-shadow: 0 18px 50px rgb(24 32 42 / 16%)`): map side list и floating cards.
- **Map Card Strong** (`box-shadow: 0 24px 70px rgb(24 32 42 / 18%)`): selected object card above the map.
- **Focus Glow** (`box-shadow: 0 0 0 3px rgb(37 99 235 / 16%)`): form focus и primary focus reinforcement.

### Named Rules

**The Border First Rule.** Сначала использовать borders и tonal layers, затем усиливать shadow. Сильная elevation резервируется для overlays, selected object context и active map surfaces.

**The No Glass Rule.** Полупрозрачные map overlays допустимы ради читаемости, но blur-backed glassmorphism и декоративные frosted panels не использовать.

## 5. Components

### Buttons

- **Shape:** компактные rounded rectangles для product controls (6px) и pills только для map или catalog mode toggles (999px).
- **Primary:** blue `#2563eb` с текущим white text, padding 12px 14px, weight 700-900.
- **Object CTA:** forest `#1f6b5b` для catalog card links и object-specific actions.
- **Hover / Focus:** переход к более глубокому цвету и 3px translucent focus ring. Transitions держать около 180ms.
- **Secondary:** white surface, cool border `#c6d0dc`, ink text. Использовать для navigation, pagination, reset, back и low-risk actions.
- **Danger / Success:** semantic soft background с semantic text. Использовать только когда действие или статус действительно требуют этого смысла.

### Chips

- **Style:** pill shape, 12px text, weight 800, soft background, meaning через текст.
- **Use:** roles, permissions, object status, presentation availability, location tags и compact facts.
- **State:** selected chips должны менять background и text, не полагаться только на border.

### Cards / Containers

- **Corner Style:** 8px для panels и object cards, 6px для inner metric cells и file rows.
- **Background:** white panels для основных surfaces, `#f8fafc` для nested data rows, `#f4f6f3` для catalog media fallback.
- **Shadow Strategy:** Panel Ambient для рабочих panels, более сильные card shadows только для catalog cards, map overlays и selected context.
- **Border:** стандартный 1px cool border. Не использовать colored side stripes.
- **Internal Padding:** 16px для cards, 18px для filters, 24px для editor panels и detail sections, 32px для centered content panels.

### Inputs / Fields

- **Style:** white background, `#bcc7d3` border, 6px radius, padding 12px 14px.
- **Focus:** blue border `#2563eb` и 3px translucent blue ring.
- **Error:** red copy `#b42318` с понятным текстом ошибки. В будущих правках ошибки лучше размещать inline рядом с релевантным полем.
- **Disabled:** снижать контраст аккуратно, не опуская текст ниже читаемого уровня.

### Navigation

- **Sidebar:** desktop column 280px, white surface, padding 28px, cool right border.
- **Active State:** blue border, pale blue surface, deep blue text.
- **Mobile:** переход в single-column top block с bottom border. Nav items остаются full width.
- **Rule:** labels навигации остаются короткими и рабочими: `Кабинет`, `Каталог`, `Админка`.

### Tables

- **Structure:** full-width data tables внутри bordered panels с horizontal scroll при необходимости.
- **Headers:** 12px uppercase, muted ink, weight 800.
- **Rows:** padding 13px 18px, 1px top divider, selected rows используют pale blue.
- **Empty State:** empty text остается центрированным и прямым. Не использовать illustrated empty states для admin tables.

### Object Cards

- **Role:** object cards не декоративные tiles. Это units сравнения цены, застройщика, локации, метро, media state и перехода в detail.
- **Media:** использовать реальные изображения объектов, когда они есть. Fallbacks должны быть спокойными и структурными.
- **Motion:** image scale на hover может быть мягким. Transform держать ниже 1.04, duration около 260ms.
- **Facts:** компактные bordered cells допустимы. Не прятать ключевые price и location facts за hover.

### Map

- **Role:** map является первичной рабочей поверхностью наравне с catalog.
- **Markers:** price markers используют pill shape, blue default, сильный text и достаточно shadow, чтобы читаться поверх карты.
- **Selected Object:** selected markers и floating object cards должны быть очевидны через color и structure.
- **Panels:** map lists и object cards могут плавать поверх карты, но должны оставаться читаемыми на desktop и mobile.
- **Fallback:** no-coordinate и API-error states должны быть явными, спокойными и actionable.
- **Protected Behavior:** существующий функционал карты, placeholders, balloons, плейсхолдеры, балуны и список объектов рядом сохраняются. Список объектов рядом должен иметь право накладываться поверх карты. Допустима стилизация этих элементов, но не изменение их сути, логики, структуры или роли в workflow.

## 6. Do's and Don'ts

### Do:

- **Do** воспринимай `/catalog` и `/catalog/map` как два первичных вида одного workflow.
- **Do** сохраняй ощущение продукта: премиальный, спокойный, надежный, профессиональный, быстрый.
- **Do** используй текущую Inter/system typography direction, пока отдельное дизайн-решение ее не заменит.
- **Do** сохраняй сильный contrast для table text, badges, map markers, form labels и object facts.
- **Do** используй blue для core system actions и forest для object exploration actions.
- **Do** держи cards с radius 8px или меньше, кроме намеренных pill-компонентов.
- **Do** сохраняй текущую карту как обязательную рабочую модель: placeholders, balloons, плейсхолдеры, балуны и список объектов рядом поверх карты.
- **Do** показывай clear loading, empty, error, validation, permission, import и publication states.
- **Do** предлагай UI-улучшения небольшими блоками и жди согласования перед правками application code.

### Don't:

- **Don't** используй SaaS-фиолетовые градиенты.
- **Don't** создавай generic AI-дизайн.
- **Don't** используй декоративный стекломорфизм.
- **Don't** добавляй случайные эмодзи.
- **Don't** строй огромные hero-блоки для внутреннего продукта.
- **Don't** допускай слабый contrast.
- **Don't** используй детские цвета.
- **Don't** превращай карту во вторичный виджет под карточками объектов.
- **Don't** меняй существующий функционал карты, placeholders, balloons, плейсхолдеры, балуны или список объектов рядом. Можно стилизовать, но нельзя менять суть, удалять или переносить список из overlay-модели без отдельного согласования.
- **Don't** используй gradient text.
- **Don't** используй colored side-stripe borders на cards, rows, callouts или alerts.
- **Don't** создавай repeated identical icon-card grids.
- **Don't** добавляй новые dependencies, icon packs, fonts или UI frameworks без согласования.
