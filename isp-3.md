# План реализации карточки объекта, параметров, карусели и карты

## Правило выполнения

- Каждый пункт выполнения отмечается чекбоксом.
- Невыполненный пункт: `[ ]`.
- Выполненный пункт: `[x]`.
- По мере выполнения нужно обновлять этот файл и менять `[ ]` на `[x]`.
- Изменения делать небольшими блоками: сначала контракт данных, затем админка, затем публичная карточка, затем проверка.
- Не добавлять новые библиотеки, зависимости, сборщики или фреймворки.
- Не откатывать существующие изменения в рабочем дереве, если они не относятся к этой задаче.
- После backend-этапа запускать API tests.
- После frontend-этапа запускать `pnpm build:web`.
- После полного этапа запускать итоговую проверку из раздела `Verification`.

## Цель

Сделать детальную страницу объекта ближе к референсу: крупный заголовок, строка района и окружения, широкая карусель, блок основных параметров, CTA-кнопки презентации и планировок, затем большая карта шириной как карусель и высотой около `70svh`.

Дополнительно нужно добавить в админку ручное редактирование недостающих параметров объекта отдельными полями БД.

## Контекст текущих данных

Уже есть поля и связи, которые можно использовать без новой схемы:

- [x] `priceFrom` -> параметр `Цена от`.
- [x] `pricePerMeterFrom` -> параметр `За метр от`.
- [x] `completionYear` + `completionQuarter` -> параметр `Срок сдачи`.
- [x] `developer.name` -> параметр `Застройщик`.
- [x] `primaryLocation` и `locations` типа `DISTRICT` -> район под заголовком и fallback для параметров.
- [x] `locations` типа `AREA` -> окружение под заголовком.
- [x] `layoutsUrl` -> активная/неактивная кнопка `Показать планировки и цены`.
- [x] `files` типа `PRESENTATION` -> активная/неактивная кнопка `Показать презентацию`.
- [x] `images` -> карусель.
- [x] `latitude` и `longitude` -> точка на карте.

Нужно добавить новые ручные поля:

- [x] `krtName` -> параметр `КРТ`.
- [x] `apartmentAreaRange` -> параметр `Площадь квартир`.
- [x] `ceilingHeight` -> параметр `Высота потолков`.
- [x] `propertyClass` -> параметр `Класс недвижимости`.
- [x] `floorRange` -> параметр `Этажность`.
- [x] `apartmentsCountText` -> параметр `Количество квартир`.

## Implementation Checklist

### Этап 1. Подготовить тесты API для новых полей

- [x] Открыть `apps/api/tests/services.test.cjs`.
- [x] Расширить helper `objectRecord()` новыми nullable полями:
  - `krtName: null`;
  - `apartmentAreaRange: null`;
  - `ceilingHeight: null`;
  - `propertyClass: null`;
  - `floorRange: null`;
  - `apartmentsCountText: null`.
- [x] Добавить тест `ObjectsService.create saves manual detail parameters and serializes them`.
- [x] В тесте создать `prisma` mock, который проверяет, что `realEstateObject.create()` получает:
  - `krtName: 'Большое Сити'`;
  - `apartmentAreaRange: 'От 35 м²'`;
  - `ceilingHeight: '3,1 метра'`;
  - `propertyClass: 'Премиум-класс'`;
  - `floorRange: '8 - 25 этажей'`;
  - `apartmentsCountText: '672 квартиры'`.
- [x] В этом же тесте вернуть из `findFirst()` объект с этими полями и проверить, что `result.object` содержит те же значения.
- [x] Добавить тест `ObjectsService.update clears empty manual detail parameters`.
- [x] В тесте передать в `update()` пустые строки для всех новых полей и проверить, что `realEstateObject.update().data` получает `null`.
- [x] Добавить тест `ObjectsService.create rejects too long manual detail parameters`.
- [x] В тесте проверить минимум два лимита:
  - `krtName` длиннее 240 символов дает `BadRequestException`;
  - `ceilingHeight` длиннее 120 символов дает `BadRequestException`.
- [x] Запустить `pnpm --filter @platforma/api test`.
- [x] Зафиксировать ожидаемый RED-результат: тесты должны падать из-за отсутствия новых полей в сервисе/схеме.

### Этап 2. Расширить Prisma-схему и миграцию

- [x] Открыть `apps/api/prisma/schema.prisma`.
- [x] В модель `RealEstateObject` после `layoutsUrl` или рядом с публичными параметрами добавить:
  - `krtName String? @map("krt_name") @db.VarChar(240)`;
  - `apartmentAreaRange String? @map("apartment_area_range") @db.VarChar(120)`;
  - `ceilingHeight String? @map("ceiling_height") @db.VarChar(120)`;
  - `propertyClass String? @map("property_class") @db.VarChar(120)`;
  - `floorRange String? @map("floor_range") @db.VarChar(120)`;
  - `apartmentsCountText String? @map("apartments_count_text") @db.VarChar(120)`.
- [x] Создать файл `apps/api/prisma/migrations/20260511120000_add_object_detail_parameters/migration.sql`.
- [x] В миграцию добавить SQL:
  - `ALTER TABLE "real_estate_objects" ADD COLUMN "krt_name" VARCHAR(240);`
  - `ALTER TABLE "real_estate_objects" ADD COLUMN "apartment_area_range" VARCHAR(120);`
  - `ALTER TABLE "real_estate_objects" ADD COLUMN "ceiling_height" VARCHAR(120);`
  - `ALTER TABLE "real_estate_objects" ADD COLUMN "property_class" VARCHAR(120);`
  - `ALTER TABLE "real_estate_objects" ADD COLUMN "floor_range" VARCHAR(120);`
  - `ALTER TABLE "real_estate_objects" ADD COLUMN "apartments_count_text" VARCHAR(120);`
- [x] Запустить `pnpm db:generate`.
- [x] Если Prisma Client сгенерирован успешно, перейти к API-сервису.

### Этап 3. Обновить shared-контракт

- [x] Открыть `packages/shared/src/index.ts`.
- [x] В `RealEstateObjectBase` после `layoutsUrl` добавить поля:
  - `krtName: string | null;`
  - `apartmentAreaRange: string | null;`
  - `ceilingHeight: string | null;`
  - `propertyClass: string | null;`
  - `floorRange: string | null;`
  - `apartmentsCountText: string | null;`
- [x] Не добавлять новые routes, response wrappers или отдельные типы, если существующих `ObjectResponse`, `RealEstateObjectSummary`, `RealEstateObjectDetail` достаточно.
- [x] Проверить, что `MapObject` не расширяется этими полями, потому что карта каталога не использует блок основных параметров.

### Этап 4. Обновить `ObjectsService`

- [x] Открыть `apps/api/src/objects/objects.service.ts`.
- [x] В `CreateObjectBody` добавить optional unknown-поля:
  - `krtName?: unknown`;
  - `apartmentAreaRange?: unknown`;
  - `ceilingHeight?: unknown`;
  - `propertyClass?: unknown`;
  - `floorRange?: unknown`;
  - `apartmentsCountText?: unknown`.
- [x] В `create()` распарсить поля через `parseNullableText`:
  - `krtName`, лимит 240;
  - остальные новые поля, лимит 120.
- [x] В `realEstateObject.create({ data })` добавить условные вставки новых полей по текущему паттерну `...(field !== undefined ? { field } : {})`.
- [x] В `update()` добавить обработку каждого нового поля:
  - если поле есть в body, распарсить;
  - пустую строку превращать в `null`;
  - сравнить с текущим значением объекта;
  - записать изменение в `data`;
  - записать изменение в `changes`;
  - выставить `hasScalarChanges = true`.
- [x] Не добавлять новые поля в `validatePublishRequirements`, чтобы публикация не зависела от ручного заполнения параметров.
- [x] В `serializeObjectBase()` вернуть новые поля в API response.
- [x] В `toAuditSnapshot()` добавить новые поля.
- [x] Запустить `pnpm --filter @platforma/api test`.
- [x] Зафиксировать GREEN-результат: новые тесты и старые API tests проходят.

### Этап 5. Обновить админку объекта

- [x] Открыть `apps/web/src/admin/ObjectsAdminPage.tsx`.
- [x] В `ObjectFormState` добавить:
  - `krtName: string`;
  - `apartmentAreaRange: string`;
  - `ceilingHeight: string`;
  - `propertyClass: string`;
  - `floorRange: string`;
  - `apartmentsCountText: string`.
- [x] В `emptyForm` добавить эти поля с пустыми строками.
- [x] В `createFormFromObject()` заполнить новые поля из `object`.
- [x] В `createPayloadFromForm()` отправлять новые поля через `emptyToNull()`.
- [x] В `validateObjectForm()` добавить frontend-проверку длины:
  - `krtName` не больше 240 символов;
  - остальные новые поля не больше 120 символов.
- [x] В форме редактора добавить новый `ObjectFormSection` после секции `Цены и сроки` и до секции `Локация`.
- [x] Назвать секцию `Параметры карточки`.
- [x] Описание секции: `Ручные значения для блока основных параметров на публичной карточке.`
- [x] Добавить поля формы:
  - label `КРТ`, input `object-krt-name`, value `props.form.krtName`;
  - label `Площадь квартир`, input `object-apartment-area-range`, placeholder `От 35 м²`;
  - label `Высота потолков`, input `object-ceiling-height`, placeholder `3,1 метра`;
  - label `Класс недвижимости`, input `object-property-class`, placeholder `Премиум-класс`;
  - label `Этажность`, input `object-floor-range`, placeholder `8 - 25 этажей`;
  - label `Количество квартир`, input `object-apartments-count-text`, placeholder `672 квартиры`.
- [x] Не менять загрузку изображений, PDF, сортировку галереи, permissions и publish workflow.
- [x] Проверить, что форма создания и форма редактирования используют один и тот же набор новых полей.

### Этап 6. Перестроить публичную страницу объекта

- [x] Открыть `apps/web/src/objects/ObjectDetailPage.tsx`.
- [x] В `ObjectDetail` оставить загрузку объекта и существующий `YandexMap`.
- [x] Собрать `presentationFile` как первый файл с `type === 'PRESENTATION'`.
- [x] Оставить `otherFiles` для вторичного файлового блока, но не дублировать презентацию в этом блоке.
- [x] Добавить helper `getObjectLocationLine(object)`, который возвращает:
  - `district`;
  - `areas`;
  - строку формата `Район / Окружение`;
  - fallback `Район и окружение не указаны`.
- [x] Добавить helper `getObjectParameterRows(object)`, который возвращает 10 строк строго в порядке:
  - `Цена от` -> `formatPrice(object.priceFrom)`;
  - `Застройщик` -> `object.developer?.name ?? 'Не указано'`;
  - `КРТ` -> `object.krtName ?? 'Не указано'`;
  - `Площадь квартир` -> `object.apartmentAreaRange ?? 'Не указано'`;
  - `Высота потолков` -> `object.ceilingHeight ?? 'Не указано'`;
  - `За метр от` -> `formatPrice(object.pricePerMeterFrom)`;
  - `Срок сдачи` -> `formatCompletion(object.completionYear, object.completionQuarter)`;
  - `Класс недвижимости` -> `object.propertyClass ?? 'Не указано'`;
  - `Этажность` -> `object.floorRange ?? 'Не указано'`;
  - `Количество квартир` -> `object.apartmentsCountText ?? 'Не указано'`.
- [x] Убедиться, что `formatPrice(null)` и `formatCompletion(null, null)` возвращают `Не указано`, а не старые тексты `Не указана`.
- [x] Перестроить JSX страницы в порядке:
  - back button `Вернуться к каталогу`;
  - крупный title `object.title`;
  - строка района/окружения;
  - статусный badge только для не опубликованных объектов;
  - широкая `ObjectImageCarousel`;
  - section `Основные параметры`;
  - CTA row с двумя кнопками;
  - section `Локация и расположение` с `YandexMap`;
  - section `Описание и особенности`;
  - section `Файлы и документы`;
  - section `Район, окружение и метро`.
- [x] Заменить текущий двухколоночный `.object-detail-hero` с summary справа на самостоятельную карусель без правой колонки.
- [x] Реализовать CTA `Показать презентацию` через существующую безопасную загрузку файла.
- [x] Для активной презентации использовать кнопку с текстом `Показать презентацию`.
- [x] Для отсутствующей презентации использовать disabled button с текстом `Презентация отсутствует`.
- [x] Для активного `layoutsUrl` использовать ссылку-кнопку с текстом `Показать планировки и цены`, `target="_blank"`, `rel="noopener noreferrer nofollow"`, `referrerPolicy="no-referrer"`.
- [x] Для отсутствующего `layoutsUrl` использовать disabled button с текстом `Планировки отсутствуют`.
- [x] Существующие `YandexMap`, `getObjectMapPoints()`, `buildObjectMapBalloon()` и marker behavior не менять по логике.

### Этап 7. Обновить стили публичной карточки

- [x] Открыть `apps/web/src/styles.css`.
- [x] Для `.object-detail-page` на desktop задать `width: min(80vw, 1760px)` и `max-width: none`.
- [x] На mobile вернуть `width: 100%`.
- [x] Обновить `.object-detail-header`, чтобы заголовок был крупным, читаемым и не выглядел как маленький panel title.
- [x] Добавить класс для строки района/окружения, например `.object-detail-location-line`.
- [x] Карусель сделать широкой standalone-секцией:
  - радиус `8px`;
  - border `1px solid #d6dde5`;
  - shadow как у текущих panels;
  - overflow hidden;
  - без вложенной правой summary-колонки.
- [x] Для desktop-карусели задать стабильную высоту через `min-height` и/или `aspect-ratio`, чтобы фото не схлопывались.
- [x] Сохранить видимые стрелки, counter и thumbnails.
- [x] Добавить `.object-parameters-section` без декоративного hero-стиля.
- [x] Добавить `.object-parameters-grid`:
  - desktop: `grid-template-columns: repeat(5, minmax(0, 1fr))`;
  - gap около `10px`;
  - каждая ячейка на `#f8fafc`;
  - border `1px solid #e0e6ed`;
  - radius `8px` или меньше.
- [x] На tablet перестроить параметры в 2 колонки.
- [x] На mobile перестроить параметры в 1 колонку.
- [x] Добавить `.object-detail-actions` для двух CTA-кнопок в одну строку на desktop и в колонку на mobile.
- [x] Активную кнопку презентации сделать primary/object CTA в текущей спокойной стилистике.
- [x] Disabled-кнопки сделать визуально неактивными, но читаемыми.
- [x] Для `.object-map-section .yandex-map-shell`, `.object-map-section .yandex-map`, `.object-map-section .map-fallback` задать:
  - `height: 70svh`;
  - `min-height: 520px`.
- [x] В mobile media query для карты задать `min-height: 420px`.
- [x] Убедиться, что карта не превращается в маленький вторичный блок.
- [x] Не добавлять SaaS-градиенты, случайные декоративные элементы, новые icon packs или новые fonts.

### Этап 8. Проверить TypeScript и сборки

- [x] Запустить `pnpm db:generate`.
- [x] Ожидаемый результат: Prisma Client сгенерирован без ошибок.
- [x] Запустить `pnpm --filter @platforma/api test`.
- [x] Ожидаемый результат: API tests проходят.
- [x] Запустить `pnpm build:web`.
- [x] Ожидаемый результат: TypeScript и Vite build проходят.
- [x] Если `pnpm build:web` выявит ошибки shared-типа, исправить контракт в `packages/shared/src/index.ts` или места потребления, не обходить типы через `as any`.

### Этап 9. Manual QA публичной карточки

- [x] Открыть объект с несколькими изображениями.
- [x] Проверить, что back button остается сверху и ведет в каталог.
- [x] Проверить, что название объекта крупное и читаемое.
- [x] Проверить, что под названием показывается район и окружение.
- [x] Проверить, что карусель занимает примерно 80% ширины экрана на desktop.
- [x] Проверить, что стрелки, counter и thumbnails карусели работают.
- [x] Проверить блок `Основные параметры`:
  - порядок 10 параметров совпадает с планом;
  - заполненные значения отображаются;
  - пустые значения показывают `Не указано`;
  - блок не скрывает пустые поля.
- [x] Проверить объект с презентацией:
  - кнопка `Показать презентацию` активна;
  - PDF открывается через существующий защищенный file endpoint.
- [x] Проверить объект без презентации:
  - кнопка disabled;
  - текст `Презентация отсутствует`.
- [x] Проверить объект с `layoutsUrl`:
  - кнопка/ссылка активна;
  - открывается новая вкладка.
- [x] Проверить объект без `layoutsUrl`:
  - кнопка disabled;
  - текст `Планировки отсутствуют`.
- [x] Проверить карту:
  - ширина совпадает с каруселью;
  - высота около `70svh`;
  - marker и balloon работают как раньше;
  - fallback координат отображается, если координат нет.
- [x] Проверить описание, файлы, район/метро ниже карты.

### Этап 10. Manual QA админки

- [x] Открыть `/admin/objects/new`.
- [x] Проверить, что секция `Параметры карточки` видна и не ломает форму.
- [x] Создать объект с заполненными новыми параметрами.
- [x] Открыть созданный объект в `/admin/objects/:id/edit`.
- [x] Проверить, что новые параметры загрузились обратно в форму.
- [x] Очистить новые параметры и сохранить.
- [x] Проверить, что после перезагрузки формы поля пустые.
- [x] Открыть публичную карточку этого объекта и проверить, что пустые параметры показывают `Не указано`.
- [x] Проверить, что загрузка обложки, галереи и PDF работает как до изменений.
- [x] Проверить, что publish workflow не требует новые ручные параметры.

### Этап 11. Responsive QA

- [x] Проверить desktop viewport около `1440x1000`.
- [x] Проверить wide desktop viewport, если доступен.
- [x] Проверить mobile viewport около `390x844`.
- [x] На desktop убедиться, что параметры идут сеткой `5 x 2`.
- [x] На tablet/mobile убедиться, что параметры перестраиваются в 2 или 1 колонку без overflow.
- [x] Проверить, что длинное название объекта не перекрывает строку локации и карусель.
- [x] Проверить, что длинные значения параметров переносятся внутри ячеек.
- [x] Проверить, что CTA-кнопки не обрезают текст.
- [x] Проверить отсутствие horizontal overflow на уровне body.
- [x] Проверить видимый keyboard focus для CTA-кнопок и ссылки планировок.

## Verification

- [x] `pnpm db:generate` выполнен без ошибок.
- [x] `pnpm --filter @platforma/api test` выполнен без ошибок.
- [x] `pnpm build:web` выполнен без ошибок.
- [x] Manual QA публичной карточки выполнен.
- [x] Manual QA админки выполнен.
- [x] Responsive QA выполнен.
- [x] В финальном ответе указать:
  - что сделано;
  - какие файлы изменены;
  - что нужно проверить вручную;
  - есть ли спорные места.

## Public Interfaces

- Backend routes не меняются.
- Shared object response расширяется новыми nullable string-полями.
- Prisma schema расширяется nullable колонками без backfill.
- WordPress import не заполняет новые ручные поля.
- Публикация объекта не требует заполнения новых ручных параметров.

## Assumptions

- Новые параметры являются display-строками, поэтому админ вводит значения сразу в публичном виде: например `От 35 м²`, `3,1 метра`, `8 - 25 этажей`.
- Если значение пустое, публичная карточка показывает `Не указано`, а поле не скрывается.
- Если презентации нет, кнопка остается видимой, но disabled.
- Если ссылки на планировки нет, кнопка остается видимой, но disabled.
- Текущее рабочее дерево уже содержит изменения; при реализации их не откатывать.
