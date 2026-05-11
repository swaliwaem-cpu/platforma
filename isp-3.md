# План `isp-3.md`: карточка объекта, параметры, карусель и карта

## Summary

- Перестроить публичную страницу объекта: сверху крупный читаемый заголовок, под ним строка `район / окружение`, затем широкая карусель примерно на `80vw`.
- Между каруселью и картой вывести блок `Основные параметры` из 10 ячеек в порядке со скриншота. Пустые значения не скрывать, показывать `Не указано`.
- Карту сделать такой же ширины, как карусель, с высотой `70svh`; существующую логику `YandexMap`, маркеры, fallback и balloon не менять.
- Добавить в админку редактирование недостающих параметров отдельными полями БД. Новые зависимости не добавлять.

## Existing Fields Audit

- Уже есть и можно заполнять автоматически: `priceFrom`, `pricePerMeterFrom`, `completionYear`, `completionQuarter`, `developer.name`, `primaryLocation`, `locations` типа `AREA`, `layoutsUrl`, `files` типа `PRESENTATION`, `images`, `latitude`, `longitude`.
- Новые редактируемые поля: `krtName`, `apartmentAreaRange`, `ceilingHeight`, `propertyClass`, `floorRange`, `apartmentsCountText`.
- Блок параметров выводить так: `Цена от`, `Застройщик`, `КРТ`, `Площадь квартир`, `Высота потолков`, `За метр от`, `Срок сдачи`, `Класс недвижимости`, `Этажность`, `Количество квартир`.

## Key Changes

- В `apps/api/prisma/schema.prisma` добавить nullable string-поля в `RealEstateObject` и миграцию `apps/api/prisma/migrations/20260511120000_add_object_detail_parameters/migration.sql`:
  `krt_name VARCHAR(240)`, `apartment_area_range VARCHAR(120)`, `ceiling_height VARCHAR(120)`, `property_class VARCHAR(120)`, `floor_range VARCHAR(120)`, `apartments_count_text VARCHAR(120)`.
- В `packages/shared/src/index.ts` добавить эти поля в `RealEstateObjectBase`; новые маршруты не нужны.
- В `apps/api/src/objects/objects.service.ts` принять поля в `POST /objects` и `PATCH /objects/:id`, валидировать через `parseNullableText`, сохранять, сериализовать и включать в audit snapshot. В publish requirements их не добавлять.
- В `apps/web/src/admin/ObjectsAdminPage.tsx` добавить поля в `ObjectFormState`, `emptyForm`, `createFormFromObject`, `createPayloadFromForm`, frontend-валидацию длины и отдельную секцию формы `Параметры карточки`.
- В `apps/web/src/objects/ObjectDetailPage.tsx` убрать текущий двухколоночный hero-summary, собрать новый порядок: заголовок -> локационная строка -> карусель -> `Основные параметры` -> CTA-кнопки -> `Локация и расположение` с большой картой -> вторичные блоки описания/файлов/метро.
- Кнопки: активная `Показать презентацию` открывает первый `PRESENTATION` файл; если файла нет, disabled `Презентация отсутствует`. Активная `Показать планировки и цены` ведет на `layoutsUrl`; если ссылки нет, disabled `Планировки отсутствуют`.

## Styling

- В `apps/web/src/styles.css` задать `.object-detail-page` шириной `min(80vw, 1760px)` на desktop и `100%` на mobile.
- Карусель сделать самостоятельной широкой поверхностью с радиусом `8px`, без правой summary-колонки; точки/миниатюры оставить читаемыми.
- Параметры оформить плотной сеткой `5 x 2` на desktop, `2 x 5` на tablet и `1 x 10` на mobile; ячейки на мягкой поверхности `#f8fafc`, без скрытия пустых значений.
- `.object-map-section .yandex-map-shell`, `.yandex-map`, `.map-fallback` выставить `height: 70svh`, `min-height: 520px` на desktop и `min-height: 420px` на mobile.
- Сохранить общую стилистику Platforma: светлый рабочий UI, контрастный текст, радиусы до `8px`, без новых градиентов и декоративных эффектов.

## Test Plan

- API: обновить `apps/api/tests/services.test.cjs`, проверить create/update/serialize новых полей, null при пустых строках, ошибку при превышении длины.
- Сборка и генерация: `pnpm db:generate`, `pnpm --filter @platforma/api test`, `pnpm build:web`.
- Manual QA: открыть объект с заполненными и пустыми новыми полями, проверить порядок параметров, disabled/active состояния двух кнопок, открытие презентации, переход по `layoutsUrl`.
- Responsive QA: desktop и mobile для страницы объекта; проверить отсутствие horizontal overflow, читаемый заголовок, карусель около 80% ширины, карта 70% высоты экрана.
- Admin QA: создать/отредактировать объект, сохранить новые поля, перезагрузить форму и публичную карточку.

## Assumptions

- Новые параметры являются display-строками, поэтому админ вводит значения сразу в публичном виде: например `От 35 м²`, `3,1 метра`, `8 - 25 этажей`.
- WordPress import новые ручные поля не заполняет и не должен перетирать при обновлениях, если они не передаются в import payload.
- Текущее рабочее дерево уже содержит изменения; при реализации их не откатывать.
- В текущем Plan Mode файлы не изменялись. Первым действием при реализации нужно сохранить этот план в `isp-3.md`.
