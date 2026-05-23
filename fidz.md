# Пошаговый план реализации фидов застройщиков

## Summary

Цель: сделать отдельную систему фидов с ручным запуском из админки, хранением лотов в основной Postgres DB, скачиванием медиа в MinIO, отдельными feed-агрегатами для ЖК и показом лотов на странице ЖК.

Основные зоны изменений: `apps/api`, `apps/web`, `packages/shared`, новый `tools/feed-import`, Prisma schema и миграции.

Важно: исходные фиды для реализации и тестовых fixtures лежат в папке `fdz` в корне проекта.

## Checklist

### Этап 1. Подготовка

- [x] Проверить, что реализация перенесена в основную ветку `on-ser`; временный worktree и ветка `feat/feed-import` удалены.
- [x] Зафиксировать два XML-файла из `fdz` как тестовые fixtures для Yandex Realty и Cian/Sminex.
- [x] Добавить новый workspace-пакет `tools/feed-import`.
- [x] Подключить `fast-xml-parser` только для нового импортёра.
- [x] Добавить root scripts: `feed-import:preview`, `feed-import:run`.
- [x] Проверить, что существующий `tools/wp-import` не меняет поведение.

### Этап 2. Prisma schema и миграция

- [x] Добавить enum для формата фида: `YANDEX_REALTY`, `CIAN_XML`.
- [x] Добавить enum для типа лота: `RESIDENTIAL`, `COMMERCIAL`.
- [x] Добавить enum для статуса лота: `AVAILABLE`, `BOOKED`, `RESERVED`, `SOLD`, `ARCHIVED`, `UNKNOWN`.
- [x] Добавить `FeedSource` с URL, форматом, `developerId`, `objectId`, активностью и датами запусков.
- [x] Добавить `FeedImportRun` для отчётов preview/run.
- [x] Добавить общую таблицу `FeedUnit`.
- [x] Добавить `FeedResidentialUnitDetails`.
- [x] Добавить `FeedCommercialUnitDetails`.
- [x] Добавить `FeedMediaAsset` с unique `sourceUrl`.
- [x] Добавить `FeedUnitMedia`.
- [x] Добавить feed-агрегаты в `RealEstateObject`: цена от, цена за метр, диапазоны, количество, срок, `feedUpdatedAt`.
- [x] Добавить индексы для `sourceId + externalId`, `objectId + status`, цены, площади и media URL.
- [x] Создать миграцию.
- [x] Запустить `pnpm db:generate`.
- [x] Добавить schema/tests на новые таблицы и индексы.

### Этап 3. Shared-типы

- [x] Добавить feed enums/types в `packages/shared`.
- [x] Добавить типы `FeedSource`, `FeedImportRun`, `FeedUnit`, `FeedMedia`.
- [x] Добавить response types для списка источников, отчётов и лотов.
- [x] Расширить типы объекта feed-агрегатами.
- [x] Обновить API contract tests.

### Этап 4. Парсеры XML

- [x] В `tools/feed-import` добавить общий тип `NormalizedFeedUnit`.
- [x] Добавить общий интерфейс `FeedParser`.
- [x] Реализовать загрузку XML по публичному URL.
- [x] Реализовать `YandexRealtyFeedParser`.
- [x] Реализовать `CianXmlFeedParser`.
- [x] Нормализовать статусы: `free -> AVAILABLE`, `booked -> BOOKED`, неизвестное -> `UNKNOWN`.
- [x] Нормализовать цену, валюту, площадь, этаж, комнаты, срок сдачи, адрес, корпус/секцию.
- [x] Собирать все media URL из фида.
- [x] Добавить parser tests на оба fixture.
- [x] Добавить tests на неизвестные/битые поля и warnings.

### Этап 5. Import engine

- [x] Добавить CLI: `preview --source <id>` и `run --source <id>`.
- [x] Загружать `FeedSource` из основной БД.
- [x] В preview считать created/updated/archived/media/warnings/errors без записи лотов.
- [x] В run делать upsert `FeedUnit` по `sourceId + externalId`.
- [x] В run обновлять residential/commercial detail-таблицы.
- [x] Архивировать лоты источника, которых нет в новом фиде.
- [x] Дедуплицировать media по `sourceUrl`.
- [x] Скачивать все media в MinIO.
- [x] Генерировать image variants так же, как в текущем файловом пайплайне.
- [x] Ошибки отдельных media писать в warnings, не валить весь импорт.
- [x] Создавать `FeedImportRun` для preview и run.
- [x] Обновлять `FeedSource.lastPreviewAt`, `lastRunAt`, `lastSuccessAt`.
- [x] Добавить tests на preview, run, архивирование, media dedupe и partial status.

### Этап 6. Feed-агрегаты ЖК

- [x] Реализовать пересчёт агрегатов после успешного run.
- [x] Считать агрегаты только по `AVAILABLE`, `BOOKED`, `RESERVED`.
- [x] Считать `feedPriceFrom`.
- [x] Считать `feedPricePerMeterFrom`.
- [x] Считать `feedAreaRange`.
- [x] Считать `feedFloorRange`.
- [x] Считать `feedUnitsCountText`.
- [x] Считать `feedCompletionYear` и `feedCompletionQuarter`.
- [x] При отсутствии активных лотов очищать feed-агрегаты.
- [x] Добавить tests на агрегаты.

### Этап 7. Backend feeds module

- [x] Добавить `FeedsModule`.
- [x] Добавить permissions: `feeds:read`, `feeds:manage`, `feeds:run`.
- [x] Обновить seed ролей.
- [x] Добавить `GET /feeds/sources`.
- [x] Добавить `POST /feeds/sources`.
- [x] Добавить `PATCH /feeds/sources/:id`.
- [x] Добавить `POST /feeds/sources/:id/preview`.
- [x] Добавить `POST /feeds/sources/:id/run`.
- [x] Добавить `GET /feeds/sources/:id/runs`.
- [x] Добавить `GET /feeds/runs/:id`.
- [x] Добавить `GET /feeds/units`.
- [x] Добавить защиту от параллельного запуска одного source.
- [x] Добавить API tests на permissions, CRUD, run endpoints и отчёты.

### Этап 8. Объекты, каталог и карта

- [x] Расширить serialization объекта feed-агрегатами.
- [x] В каталоге для отображения цены/площади использовать feed-значение, если оно есть.
- [x] В фильтрах цены использовать feed-значение как приоритетное над ручным.
- [x] В сортировке цены использовать feed-значение как приоритетное над ручным.
- [x] Не менять ручные поля объекта в админской форме.
- [x] Добавить `GET /objects/:id/feed-units`.
- [x] Проверить, что карта не ломается от новых полей.
- [x] Добавить tests на catalog fallback/filter/sort.

### Этап 9. Админка фидов

- [x] Добавить пункт навигации `Фиды`.
- [x] Добавить страницу списка источников.
- [x] Добавить форму создания источника.
- [x] Добавить форму редактирования источника.
- [x] В форме выбирать формат, URL, застройщика и связанный ЖК.
- [x] Добавить кнопки `Preview` и `Run`.
- [x] Добавить список отчётов по source.
- [x] Добавить экран деталей отчёта с summary, warnings, errors.
- [x] Добавить таблицу лотов источника.
- [x] Добавить фильтры лотов по статусу и типу.
- [x] Добавить web tests на навигацию, форму, запуск и отчёты.

### Этап 10. Лоты на странице ЖК

- [x] Добавить блок лотов в `/objects/:slug`.
- [x] По умолчанию показывать `AVAILABLE`, `BOOKED`, `RESERVED`.
- [x] Не показывать `ARCHIVED` брокерам.
- [x] Добавить фильтр по статусу.
- [x] Добавить фильтр по типу `RESIDENTIAL/COMMERCIAL`.
- [x] Добавить колонки: статус, цена, площадь, комнаты/тип, этаж, корпус/секция, медиа.
- [x] Использовать `SecureImage` для импортированных media.
- [x] Добавить empty/loading/error states.
- [x] Добавить web tests на блок лотов и фильтры.

### Этап 11. Проверки

- [ ] Запустить `pnpm --filter @platforma/feed-import test`.
- [ ] Запустить `pnpm --filter @platforma/api test`.
- [ ] Запустить `pnpm --filter @platforma/web test`.
- [ ] Запустить `pnpm build:api`.
- [ ] Запустить `pnpm build:web`.
- [ ] Ручная проверка: создать FeedSource для Yandex fixture URL.
- [ ] Ручная проверка: запустить preview.
- [ ] Ручная проверка: запустить run.
- [ ] Ручная проверка: проверить лоты на странице ЖК.
- [ ] Ручная проверка: проверить feed-агрегаты в каталоге.
- [ ] Ручная проверка: проверить Cian/Sminex source.
- [ ] Ручная проверка: повторный run не создаёт дубли.
- [ ] Ручная проверка: удалённый из фида лот уходит в архив.

## Assumptions

- Фиды в v1 доступны по публичному URL.
- Cron/расписание не входит в первый релиз.
- ЖК не создаются автоматически: каждый `FeedSource` вручную связан с существующим объектом.
- Медиа скачиваются все, но повторяющиеся URL хранятся один раз.
- Ручные поля ЖК не затираются.
- Existing WordPress import остаётся отдельным.

## Статус

Файл создан как чеклист для будущей реализации.
