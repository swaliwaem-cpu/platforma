# Реализация тем C/D с переключателем в sidebar

## Summary

- [x] Реализовать два выбранных визуальных режима: `D — Minimal Luxury` как тему по умолчанию и `C — Dark Premium` как темную тему.
- [x] Заменить временный preview-механизм `?theme=a|b|c|d` на постоянную систему темы с `localStorage`.
- [x] Добавить аккуратную icon-only кнопку переключения D↔C в раскрытом sidebar под бренд-блоком с логотипом.
- [x] Не менять маршруты, порядок страниц и бизнес-логику.

## Key Changes

### Theme model

- [x] Переименовать или заменить `apps/web/src/designPreview.ts` на постоянный theme-модуль, например `apps/web/src/appTheme.ts`.
- [x] Ввести тип `AppTheme = 'minimal-luxury' | 'dark-premium'`.
- [x] Сделать default theme: `'minimal-luxury'`.
- [x] Сделать storage key: `platforma.theme`.
- [x] Реализовать правило `?theme=d` → `minimal-luxury`.
- [x] Реализовать правило `?theme=c` → `dark-premium`.
- [x] Сделать так, чтобы query param выигрывал у `localStorage` и сохранял выбор.
- [x] Если query param отсутствует, читать тему из `localStorage`.
- [x] Если значения нет или оно невалидное, применять `minimal-luxury`.
- [x] Удалить поддержку `a` и `b` из runtime.

### CSS themes

- [x] Переименовать `apps/web/src/design-preview.css` в production-файл, например `apps/web/src/app-theme.css`.
- [x] Оставить только две темы: `html[data-app-theme="minimal-luxury"]` на базе варианта D.
- [x] Оставить только две темы: `html[data-app-theme="dark-premium"]` на базе варианта C.
- [x] Перенести общие selectors из preview CSS на `data-app-theme`.
- [x] Сохранить текущий layout.
- [x] Менять только цвета, border, shadow, focus/hover states, surfaces и typography tone.
- [x] Для dark theme явно сохранить читаемые `focus-visible`, disabled, error/success/warning states.

### App initialization

- [x] В `apps/web/src/main.tsx` заменить `initDesignPreviewTheme()` на `initAppTheme()`.
- [x] `initAppTheme()` должен выставлять `document.documentElement.dataset.appTheme` до `createRoot(...)`.
- [x] В `apps/web/src/App.tsx` заменить импорт `design-preview.css` на `app-theme.css`.

### Sidebar switcher

- [x] В `AppRoutes` добавить состояние темы через helper/hook из `appTheme.ts`.
- [x] Добавить кнопку между `sidebar-brand` и `nav-list`.
- [x] Визуально привязать кнопку к зоне логотипа.
- [x] Использовать `MoonIcon` из `lucide-react` для перехода в dark theme.
- [x] Использовать `SunIcon` из `lucide-react` для возврата в light/minimal theme.
- [x] Кнопка должна быть `type="button"`.
- [x] Кнопка должна иметь `className="theme-toggle"`.
- [x] `aria-label`: `Включить темную тему` или `Включить светлую тему`.
- [x] `title`: `Включить темную тему` или `Включить светлую тему`.
- [x] `tabIndex={isSidebarOpen ? 0 : -1}`.
- [x] Не отображать отдельный текст в интерфейсе.
- [x] При клике менять `data-app-theme`.
- [x] При клике сохранять тему в `localStorage`.
- [x] При клике не менять URL.

## Test Plan

### Unit/source tests

- [x] Обновить `apps/web/tests/design-preview.test.mjs` или заменить на `apps/web/tests/app-theme.test.mjs`.
- [x] Проверить default theme = `minimal-luxury`.
- [x] Проверить, что `?theme=c` распознается как `dark-premium`.
- [x] Проверить, что `?theme=d` распознается как `minimal-luxury`.
- [x] Проверить, что `?theme=a`, `?theme=b` и мусорные значения игнорируются.
- [x] Проверить, что используется `platforma.theme`.
- [x] Проверить, что `main.tsx` вызывает `initAppTheme()`.
- [x] Проверить, что `App.tsx` импортирует `app-theme.css`.
- [x] Проверить, что в `App.tsx` есть `.theme-toggle`.
- [x] Проверить, что в `App.tsx` есть lucide icons для переключателя.
- [x] Проверить, что CSS содержит `data-app-theme="minimal-luxury"`.
- [x] Проверить, что CSS содержит `data-app-theme="dark-premium"`.
- [x] Проверить, что CSS больше не содержит runtime-селекторы `data-design-preview="a"` и `data-design-preview="b"`.

### Commands

- [x] Запустить `pnpm --filter @platforma/web test`.
- [x] Запустить `pnpm build:web`.

### Browser QA

- [x] Desktop `1440x1100`: войти в приложение.
- [x] Desktop `1440x1100`: открыть sidebar.
- [x] Desktop `1440x1100`: проверить кнопку под логотипом.
- [x] Desktop `1440x1100`: переключить D→C→D.
- [x] Desktop `1440x1100`: обновить страницу и убедиться, что тема сохранилась.
- [x] Mobile `390x844`: проверить `/catalog`.
- [x] Mobile `390x844`: проверить `/admin/users`.
- [x] Mobile `390x844`: проверить `/catalog/map`.
- [x] Mobile `390x844`: проверить `/objects/zhiloj-kvartal-foriver-residence`.
- [x] Mobile `390x844`: убедиться, что нет горизонтального overflow.
- [x] Mobile `390x844`: проверить, что кнопка темы не ломает sidebar.
- [x] Проверить console: не должно быть новых ошибок, кроме уже известного предупреждения Yandex API key, если оно останется.

## Assumptions

- [x] Основная светлая тема: вариант D `Minimal Luxury`.
- [x] Темная тема: вариант C `Dark Premium`.
- [x] Переключатель: одна аккуратная icon-only кнопка.
- [x] Выбор темы запоминается через `localStorage`.
- [x] `?theme=c|d` остается как удобный QA/deep-link override.
- [x] `?theme=a|b` удаляются из runtime.
- [x] Новые библиотеки не добавляются.
