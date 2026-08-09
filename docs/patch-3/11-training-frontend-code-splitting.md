# 11. Ленивое подключение frontend-модуля обучения

Статус: предложение к реализации  
Приоритет: P3  
Область: web bundle, первоначальная загрузка

## Проблема

`App.tsx` синхронно импортирует `TrainingRoutes`, а `TrainingRoutes.tsx` синхронно импортирует все employee и admin страницы. Поэтому код обучения загружается даже пользователям, которые его не открывают или не имеют соответствующих прав.

Затрагиваемые участки:

- `apps/web/src/App.tsx`;
- `apps/web/src/training/TrainingRoutes.tsx`;
- loading/error states;
- Vite chunking и browser fixtures.

## Целевое решение

Разделить как минимум на два route chunk:

- employee training;
- admin training.

Внутри admin chunk дополнительно можно лениво загружать тяжёлые editor/results/ranking страницы, если bundle-анализ подтверждает эффект. Использовать стандартные `React.lazy` и `Suspense`, не добавляя новый router или библиотеку.

## UX

- Loading state должен использовать существующий визуальный язык модуля.
- Ошибка загрузки chunk должна показывать понятное действие «Обновить страницу».
- Проверка `trainingEnabled` и permissions остаётся до отображения маршрута.
- Нельзя кратковременно показывать запрещённую admin-страницу до завершения проверки доступа.

## Границы

- Не менять маршруты и public API.
- Не переписывать самодельную навигацию на новый router.
- Не создавать отдельный chunk для каждого маленького компонента.
- Не оптимизировать только raw size: сравнивать gzip/brotli и фактический initial request waterfall.

## Критерии приёмки

- Начальная страница не загружает training page chunks до перехода в модуль.
- Employee не загружает admin training chunk.
- Deep link после refresh корректно загружает нужный chunk.
- RBAC и fail-closed `/training/config` поведение не меняются.
- Browser tests покрывают loading, chunk error, employee и admin deep links.
- В отчёте зафиксированы размеры initial bundle до и после.
