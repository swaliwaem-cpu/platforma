# Пошаговый план реализации фидов застройщиков

## Summary

Цель: сделать отдельную систему фидов с ручным запуском из админки, хранением лотов в основной Postgres DB, скачиванием медиа в MinIO, отдельными feed-агрегатами для ЖК и показом лотов на странице ЖК.

Основные зоны изменений: `apps/api`, `apps/web`, `packages/shared`, новый `tools/feed-import`, Prisma schema и миграции.

Важно: исходные фиды для реализации и тестовых fixtures лежат в папке `fdz` в корне проекта.

## Checklist

### Этап 1. Подготовка

- [ ] Проверить, что работа идёт в ветке `on-ser`.
- [ ] Зафиксировать два XML-файла из `fdz` как тестовые fixtures для Yandex Realty и Cian/Sminex.
- [ ] Добавить новый workspace-пакет `tools/feed-import`.
- [ ] Подключить `fast-xml-parser` только для нового импортёра.
- [ ] Добавить root scripts: `feed-import:preview`, `feed-import:run`.
- [ ] Проверить, что существующий `tools/wp-import` не меняет поведение.

### Этап 2. Prisma schema и миграция

- [ ] Добавить enum для формата фида: `YANDEX_REALTY`, `CIAN_XML`.
- [ ] Добавить enum для типа лота: `RESIDENTIAL`, `COMMERCIAL`.
- [ ] Добавить enum для статуса лота: `AVAILABLE`, `BOOKED`, `RESERVED`, `SOLD`, `ARCHIVED`, `UNKNOWN`.
- [ ] Добавить `FeedSource` с URL, форматом, `developerId`, `objectId`, активностью и датами запусков.
- [ ] Добавить `FeedImportRun` для отчётов preview/run.
- [ ] Добавить общую таблицу `FeedUnit`.
- [ ] Добавить `FeedResidentialUnitDetails`.
- [ ] Добавить `FeedCommercialUnitDetails`.
- [ ] Добавить `FeedMediaAsset` с unique `sourceUrl`.
- [ ] Добавить `FeedUnitMedia`.
- [ ] Добавить feed-агрегаты в `RealEstateObject`: цена от, цена за метр, диапазоны, количество, срок, `feedUpdatedAt`.
- [ ] Добавить индексы для `sourceId + externalId`, `objectId + status`, цены, площади и media URL.
- [ ] Создать миграцию.
- [ ] Запустить `pnpm db:generate`.
- [ ] Добавить schema/tests на новые таблицы и индексы.

### Этап 3. Shared-типы

- [ ] Добавить feed enums/types в `packages/shared`.
- [ ] Добавить типы `FeedSource`, `FeedImportRun`, `FeedUnit`, `FeedMedia`.
- [ ] Добавить response types для списка источников, отчётов и лотов.
- [ ] Расширить типы объекта feed-агрегатами.
- [ ] Обновить API contract tests.

### Этап 4. Парсеры XML

- [ ] В `tools/feed-import` добавить общий тип `NormalizedFeedUnit`.
- [ ] Добавить общий интерфейс `FeedParser`.
- [ ] Реализовать загрузку XML по публичному URL.
- [ ] Реализовать `YandexRealtyFeedParser`.
- [ ] Реализовать `CianXmlFeedParser`.
- [ ] Нормализовать статусы: `free -> AVAILABLE`, `booked -> BOOKED`, неизвестное -> `UNKNOWN`.
- [ ] Нормализовать цену, валюту, площадь, этаж, комнаты, срок сдачи, адрес, корпус/секцию.
- [ ] Собирать все media URL из фида.
- [ ] Добавить parser tests на оба fixture.
- [ ] Добавить tests на неизвестные/битые поля и warnings.

### Этап 5. Import engine

- [ ] Добавить CLI: `preview --source <id>` и `run --source <id>`.
- [ ] Загружать `FeedSource` из основной БД.
- [ ] В preview считать created/updated/archived/media/warnings/errors без записи лотов.
- [ ] В run делать upsert `FeedUnit` по `sourceId + externalId`.
- [ ] В run обновлять residential/commercial detail-таблицы.
- [ ] Архивировать лоты источника, которых нет в новом фиде.
- [ ] Дедуплицировать media по `sourceUrl`.
- [ ] Скачивать все media в MinIO.
- [ ] Генерировать image variants так же, как в текущем файловом пайплайне.
- [ ] Ошибки отдельных media писать в warnings, не валить весь импорт.
- [ ] Создавать `FeedImportRun` для preview и run.
- [ ] Обновлять `FeedSource.lastPreviewAt`, `lastRunAt`, `lastSuccessAt`.
- [ ] Добавить tests на preview, run, архивирование, media dedupe и partial status.

### Этап 6. Feed-агрегаты ЖК

- [ ] Реализовать пересчёт агрегатов после успешного run.
- [ ] Считать агрегаты только по `AVAILABLE`, `BOOKED`, `RESERVED`.
- [ ] Считать `feedPriceFrom`.
- [ ] Считать `feedPricePerMeterFrom`.
- [ ] Считать `feedAreaRange`.
- [ ] Считать `feedFloorRange`.
- [ ] Считать `feedUnitsCountText`.
- [ ] Считать `feedCompletionYear` и `feedCompletionQuarter`.
- [ ] При отсутствии активных лотов очищать feed-агрегаты.
- [ ] Добавить tests на агрегаты.

### Этап 7. Backend feeds module

- [ ] Добавить `FeedsModule`.
- [ ] Добавить permissions: `feeds:read`, `feeds:manage`, `feeds:run`.
- [ ] Обновить seed ролей.
- [ ] Добавить `GET /feeds/sources`.
- [ ] Добавить `POST /feeds/sources`.
- [ ] Добавить `PATCH /feeds/sources/:id`.
- [ ] Добавить `POST /feeds/sources/:id/preview`.
- [ ] Добавить `POST /feeds/sources/:id/run`.
- [ ] Добавить `GET /feeds/sources/:id/runs`.
- [ ] Добавить `GET /feeds/runs/:id`.
- [ ] Добавить `GET /feeds/units`.
- [ ] Добавить защиту от параллельного запуска одного source.
- [ ] Добавить API tests на permissions, CRUD, run endpoints и отчёты.

### Этап 8. Объекты, каталог и карта

- [ ] Расширить serialization объекта feed-агрегатами.
- [ ] В каталоге для отображения цены/площади использовать feed-значение, если оно есть.
- [ ] В фильтрах цены использовать feed-значение как приоритетное над ручным.
- [ ] В сортировке цены использовать feed-значение как приоритетное над ручным.
- [ ] Не менять ручные поля объекта в админской форме.
- [ ] Добавить `GET /objects/:id/feed-units`.
- [ ] Проверить, что карта не ломается от новых полей.
- [ ] Добавить tests на catalog fallback/filter/sort.

### Этап 9. Админка фидов

- [ ] Добавить пункт навигации `Фиды`.
- [ ] Добавить страницу списка источников.
- [ ] Добавить форму создания источника.
- [ ] Добавить форму редактирования источника.
- [ ] В форме выбирать формат, URL, застройщика и связанный ЖК.
- [ ] Добавить кнопки `Preview` и `Run`.
- [ ] Добавить список отчётов по source.
- [ ] Добавить экран деталей отчёта с summary, warnings, errors.
- [ ] Добавить таблицу лотов источника.
- [ ] Добавить фильтры лотов по статусу и типу.
- [ ] Добавить web tests на навигацию, форму, запуск и отчёты.

### Этап 10. Лоты на странице ЖК

- [ ] Добавить блок лотов в `/objects/:slug`.
- [ ] По умолчанию показывать `AVAILABLE`, `BOOKED`, `RESERVED`.
- [ ] Не показывать `ARCHIVED` брокерам.
- [ ] Добавить фильтр по статусу.
- [ ] Добавить фильтр по типу `RESIDENTIAL/COMMERCIAL`.
- [ ] Добавить колонки: статус, цена, площадь, комнаты/тип, этаж, корпус/секция, медиа.
- [ ] Использовать `SecureImage` для импортированных media.
- [ ] Добавить empty/loading/error states.
- [ ] Добавить web tests на блок лотов и фильтры.

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
