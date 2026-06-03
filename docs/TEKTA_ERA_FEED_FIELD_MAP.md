# Tekta Era Feed Field Map

Дата проверки: 2026-06-02.

Источник: `https://tekta.ru/xml/era/Era.xml`.

Парсер: `tools/feed-import/src/index.ts`, `TektaXmlFeedParser`.

## Краткий вывод

- Корень фида: `projects.project`.
- В текущем XML есть 1 проект, 6 корпусов, 30 account-записей, 2048 квартир, 16 commerce-записей, 63 `mhmts`, 238 кладовок и 387 машиномест.
- Текущий `TektaXmlFeedParser` читает только `projects.project.flats.flat` и `projects.project.offices.office`.
- В текущем Era-фиде `offices.office` отсутствует, а коммерция лежит в `commerces.commerce`, поэтому коммерческие помещения сейчас не импортируются.
- `commerces`, `mhmtses`, `pantries`, `parkings`, `korpuses` и `accounts` текущим parser'ом не нормализуются в `FeedUnit`.
- Все поля импортированной квартиры сохраняются в `rawPayload`; типизированно раскладывается только часть полей.
- Срок сдачи parser берет из `project.IntEstimatedCompletionDate`; в текущем фиде поле пустое.
- Media parser берет из `flat.IntLayoutCode`, `flat.IntLinkPhoto`, `flat.IntProjectPhoto` только если значение является `http(s)` URL; в текущем фиде `IntLayoutCode` содержит внутренние UNC-пути `\\crm-storage\...`, поэтому media не импортируются.

## Статусы в текущем фиде

| Секция | Кол-во | Статусы |
| --- | ---: | --- |
| `flats.flat` | 2048 | `Продан`: 999, `Скрывать на сайте`: 8, `Резерв`: 771, `Устная бронь`: 10, `Свободен`: 250, `Платная бронь`: 10 |
| `commerces.commerce` | 16 | `Продан`: 16 |
| `mhmtses.mhmts` | 63 | `Свободен`: 26, `Резерв`: 19, `Снято с продажи`: 6, `Продан`: 10, `Платная бронь`: 2 |
| `pantries.pantry` | 238 | `Продан`: 164, `Резерв`: 37, `Свободен`: 28, `Платная бронь`: 9 |
| `parkings.parking` | 387 | `Продан`: 256, `Резерв`: 90, `Свободен`: 21, `Снято с продажи`: 16, `Платная бронь`: 4 |

Parser statuses для импортируемых квартир:

| XML `Status` | Наш `FeedUnit.status` |
| --- | --- |
| `Свободен` | `AVAILABLE` |
| `Устная бронь` | `BOOKED` |
| `Платная бронь` | `BOOKED` |
| `Резерв` | `RESERVED` |
| `Продан` | `SOLD` |
| `Снято с продажи` | `ARCHIVED` |
| `Сдан` | юнит пропускается |
| `Скрывать на сайте` | юнит пропускается |
| неизвестный статус | `UNKNOWN` + warning |

## Project fields

Путь: `projects.project`.

| XML field | Что это | Mapping в parser |
| --- | --- | --- |
| `Idp` | GUID проекта в CRM Tekta | Не используется |
| `IntName` | Название проекта, здесь `ERA` | `context.projectName`; fallback для `FeedUnit.projectName`; добавляется в `rawPayload.TektaProjectName` |
| `IntPostAdress` | Почтовый/проектный адрес | Fallback для `FeedUnit.address`, если нет `IntBuildingAddress` |
| `IntProjectSite` | Сайт проекта | Не используется |
| `IntBuildingAddress` | Адрес строительства | `FeedUnit.address` |
| `IntEmailOfSalesDepartment` | Email отдела продаж | Не используется |
| `IntTotalArea` | Общая площадь проекта | Не используется |
| `IntUnitRoomArea` | Жилая/комнатная площадь проекта | Не используется |
| `IntTotalNumberObjects` | Общее количество объектов проекта | Не используется |
| `IntEstimatedCompletionDate` | Срок сдачи текстом | `completionYear`, `completionQuarter` через `parseTektaCompletion`; сейчас пустое |
| `IntTermLeaseAgreement` | Срок/дата договора аренды или передачи | Не используется; сейчас пустое |
| `IntNumberFirstRegistrationDdu` | Номер первой регистрации ДДУ | Не используется |
| `IntNumberOfDaysVerbalReservation` | Дней устной брони | Не используется |
| `IntProjectCharacteristics` | Характеристики проекта | Не используется |
| `IntLinkPhoto` | Ссылка на фото проекта | На уровне проекта не используется для media |
| `IntProjectPhoto` | Фото проекта | На уровне проекта не используется для media |
| `IntClosedTerritory` | Закрытая территория, флаг | Не используется |
| `IntAvailabilityThroughputSystem` | Пропускная система, флаг | Не используется |
| `IntAvailabilitySecurity` | Охрана, флаг | Не используется |
| `IntEntryByPass` | Въезд по пропускам, флаг | Не используется |
| `IntSecureParkingAvailable` | Охраняемая парковка, флаг | Не используется |
| `IntNumberParkingSpaces` | Количество машиномест | Не используется |
| `IntAvailabilityGuestParkingSpaces` | Гостевые парковочные места, флаг | Не используется |
| `IntNumberGuestParkingSpaces` | Количество гостевых мест | Не используется |
| `IntIsLight` | Освещение, флаг | Не используется |
| `IntAvailabilityWaterSupply` | Водоснабжение, флаг | Не используется |
| `IntPresenceOfHeat` | Отопление, флаг | Не используется |
| `IntAvailabilityElectricity` | Электричество, флаг | Не используется |
| `IntAvailabilityAutomaticGates` | Автоматические ворота, флаг | Не используется |
| `IntVideoSurveillance` | Видеонаблюдение, флаг | Не используется |
| `IntPresenceFireAlarmSystem` | Пожарная сигнализация, флаг | Не используется |
| `IntIsFireExtinguishingSystem` | Система пожаротушения, флаг | Не используется |
| `IntAssembling` | Монтаж/сборка, флаг | Не используется |
| `IntPresenceViewingPit` | Смотровая яма, флаг | Не используется |
| `IntCarWash` | Автомойка, флаг | Не используется |
| `IntAvailabilityCarService` | Автосервис, флаг | Не используется |
| `IntAvailabilityBasement` | Подвал, флаг | Не используется |
| `IntGarageInNewBuilding` | Гараж в новостройке, флаг | Не используется |
| `IntEliteRealEstate` | Элитная недвижимость, флаг | Не используется |
| `IntWallMaterial` | Материал стен | Не используется |
| `IntHighway` | Шоссе | Не используется |
| `IntDistanceAlongHighwayToMkad` | Расстояние до МКАД | Не используется |
| `IntGeographicalLatitude` | Широта проекта | Не используется |
| `IntGeographicalLongitude` | Долгота проекта | Не используется |
| `IntNearestMetroStation` | Ближайшее метро | Не используется |
| `IntNearestRailwayStation` | Ближайшая ж/д станция | Не используется |
| `IntTimetoMetroByTransport` | Время до метро транспортом | Не используется |
| `IntTimetoMetroOnFoot` | Время до метро пешком | Не используется |
| `korpuses` | Список корпусов | Секция не читается |
| `flats` | Список квартир | Читается: `flats.flat` |
| `commerces` | Коммерческие помещения | Не читается текущим parser'ом |
| `mhmtses` | МХМТС/хоз. помещения Tekta | Не читается текущим parser'ом |
| `pantries` | Кладовки | Не читается текущим parser'ом |
| `parkings` | Машиноместа | Не читается текущим parser'ом |

## Korpus and account fields

Пути: `projects.project.korpuses.korpus`, `projects.project.korpuses.korpus.accounts.account`.

| XML field | Что это | Mapping в parser |
| --- | --- | --- |
| `idk` | GUID корпуса | Не используется |
| `IntTradeName` | Торговое имя корпуса, например `ER1` | Не используется; parser берет корпус из `flat.Korpus` |
| `IntProjectAdress` | Адрес корпуса | Не используется |
| `KorpIntNamep` | Имя проекта для корпуса | Не используется |
| `IntHousingNumber` | Номер корпуса | Не используется; parser берет номер из `flat.Korpusnumber` |
| `IntAvailabilityElevator` | Наличие лифта, флаг | Не используется |
| `IntAdditionalInformation` | Дополнительная информация по корпусу | Не используется |
| `accounts` | Контрагенты корпуса | Не используется |
| `aid` | GUID account | Не используется |
| `AccountName` | Название контрагента | Не используется |
| `AccountType` | Тип account, например `Контрагент` | Не используется |
| `IntIncorporationForm` | Форма лица: юр./физ. | Не используется |
| `IntAccountForm` | Организационная форма | Не используется |
| `Phone` | Телефон | Не используется |
| `Address` | Адрес контрагента | Не используется |
| `IntEmail` | Email контрагента | Не используется |
| `IntValidFrom` | Дата валидности/начала | Не используется |
| `IntINN` | ИНН | Не используется |
| `IntOKVED` | ОКВЭД | Не используется |
| `IntOGRN` | ОГРН | Не используется |
| `IntOKPO` | ОКПО | Не используется |
| `IntEgrul` | ЕГРЮЛ | Не используется |
| `IntEgrip` | ЕГРИП | Не используется |

## Flat fields

Путь: `projects.project.flats.flat`.

Эта секция импортируется. В текущем XML 2048 квартир, из них 2040 нормализуются parser'ом: 8 квартир со статусом `Скрывать на сайте` пропускаются.

| XML field | Что это | Mapping в parser |
| --- | --- | --- |
| `ObjectId` | GUID квартиры | `FeedUnit.externalId`; главный id для upsert |
| `ObjectIntName` | Внутреннее имя квартиры | Fallback для `externalId`; `residentialDetails.detailsJson.objectIntName`; также в `rawPayload` |
| `ObjectType` | Тип объекта, здесь `Квартира` | `residentialDetails.detailsJson.objectType`; также в `rawPayload` |
| `Status` | Статус продажи | `FeedUnit.status` или пропуск юнита |
| `Project` | Название проекта в строке лота | `FeedUnit.projectName`; fallback на `project.IntName` |
| `Korpus` | Корпус, например `ER2` | `FeedUnit.building` |
| `Korpusnumber` | Номер корпуса | `residentialDetails.detailsJson.corpusNumber` |
| `IntSection` | Секция | `FeedUnit.section` |
| `IntStorey` | Этаж | `FeedUnit.floor` |
| `IntProjectNumber` | Проектный номер квартиры | `residentialDetails.apartmentNumber`; используется в `FeedUnit.title` |
| `IntNumberOnVenue` | Номер на площадке | `residentialDetails.detailsJson.numberOnVenue` |
| `IntRoomCount` | Количество комнат | `FeedUnit.rooms`; если `Roominess` распознана как студия, будет `0` |
| `Roominess` | Тип комнатности/планировки, например `2Е`, `1К` | `residentialDetails.layoutType`; участвует в studio detection; `detailsJson.roominess` |
| `IntPerSquareMeterPrice` | Цена за м2 | `FeedUnit.pricePerMeter`; если пусто, parser считает из `IntCost / IntProjectedArea` |
| `IntCost` | Базовая цена | `FeedUnit.price` |
| `IntConclusionContractPriceCost` | Цена заключения договора/контрактная цена | Не используется как скидка |
| `IntDiscountedPriceForSite` | Скидочная цена за м2 для сайта | `FeedUnit.discountPricePerMeter`; участвует в `effectivePricePerMeter` |
| `IntDiscountedCostForSite` | Скидочная полная цена для сайта | `FeedUnit.discountPrice`; участвует в `effectivePrice` |
| `IntDiscountSiteRub` | Размер скидки в рублях | Не используется; остается в `rawPayload` |
| `IntDiscountSitePercentage` | Размер скидки в процентах | Не используется; остается в `rawPayload` |
| `IntProjectedArea` | Проектная площадь | `FeedUnit.area` |
| `IntTotalAreaFactor` | Площадь с коэффициентами/доп. зонами | Не используется |
| `IntNumberLayouts` | Количество планировок | Не используется |
| `IntLayoutCode` | Планировка | `FeedUnit.media` с label `layout`, но только если значение `http(s)` URL; текущие UNC-пути игнорируются |
| `IntBTINumber` | Номер БТИ | Fallback для `residentialDetails.apartmentNumber`, если нет `IntProjectNumber` |
| `IntAreaByBTI` | Площадь по БТИ | Не используется |
| `IntAfterBTICost` | Цена после БТИ | Не используется |
| `IntLivingAreaByBTI` | Жилая площадь по БТИ | `residentialDetails.livingArea` |
| `IntTer1` | Терраса/террасная зона, флаг | Не используется |
| `IntTerrace` | Терраса, флаг | Не используется |
| `IntTerassa2` | Вторая терраса, флаг | Не используется |
| `IntSauna` | Сауна, флаг | Не используется |
| `IntBathWindow` | Окно в ванной, флаг | Не используется |
| `IntCityHouse` | City house, флаг | Не используется |
| `IntDoubleFloor` | Двухуровневая квартира, флаг | Не используется |
| `IntStoreWindow` | Витринное/store window, флаг | Не используется |
| `IntTopFloor` | Верхний этаж, флаг | Не используется |
| `IntLevel2` | Второй уровень, флаг | Не используется |
| `IntPenthouse` | Пентхаус, флаг | Не используется |
| `Int2Shine` | Двухсветное пространство, флаг | Не используется |
| `IntSeparateInput` | Отдельный вход, флаг | Не используется для квартир |
| `IntMasterBedroom` | Master bedroom, флаг | Не используется |
| `IntWinterGarden` | Зимний сад, флаг | Не используется |
| `IntFrenchBalcony` | Французский балкон, флаг | Не используется |
| `IntViewCharacteristic` | Видовые характеристики | Не используется |
| `IntDecorationType` | Тип отделки, например `WB`, `Без отделки` | `residentialDetails.detailsJson.decoration` |
| `IntDescription` | Описание/примечание по лоту | Не используется |
| `IntCeilingHeight` | Высота потолка | `residentialDetails.detailsJson.ceilingHeight` |
| `IntIsNotShowWhenBooking` | Не показывать при бронировании, флаг | Не используется |
| `IntCostDou` | Цена/поле для ДОУ | Не используется |
| `ActionId` | ID акции | Не используется |
| `IntParkingSpaceGift` | Машиноместо в подарок, флаг | Не используется |
| `IntWindowsillHeightStr` | Высота подоконника | Не используется |
| `IntLoggia` | Количество/наличие лоджии | `residentialDetails.balconyCount` |
| `IntCornerGlazing` | Угловое остекление, флаг | Не используется |
| `IntMB_Bath` | Master bedroom: ванная, флаг | Не используется |
| `IntMB_Clos` | Master bedroom: гардеробная, флаг | Не используется |
| `IntMB_PClos` | Master bedroom: проходная гардеробная, флаг | Не используется |
| `IntMB_BathClos` | Master bedroom: ванная + гардеробная, флаг | Не используется |
| `IntMB_BathPClos` | Master bedroom: ванная + проходная гардеробная, флаг | Не используется |

Дополнительно parser добавляет:

| Наше поле | Значение |
| --- | --- |
| `FeedUnit.type` | `RESIDENTIAL` для всех `flat` |
| `FeedUnit.currency` | всегда `RUR` |
| `FeedUnit.title` | `Квартира №<IntProjectNumber>` или fallback |
| `FeedUnit.effectivePrice` | `discountPrice`, если есть положительное значение, иначе `price` |
| `FeedUnit.effectivePricePerMeter` | `discountPricePerMeter`, если есть положительное значение, иначе `pricePerMeter` |
| `rawPayload.DeveloperName` | всегда `Tekta` |
| `rawPayload.TektaProjectName` | `project.IntName` |

## Commerce fields

Путь: `projects.project.commerces.commerce`.

В текущем XML 16 записей, все со статусом `Продан`. Текущий parser эту секцию не читает, потому что он ожидает коммерческие юниты в `projects.project.offices.office`, а не в `commerces.commerce`.

| XML field | Что это | Mapping в parser |
| --- | --- | --- |
| `Commerceid` | GUID коммерческого помещения | Не импортируется: секция не читается |
| `CommerceIntName` | Внутреннее имя коммерческого помещения | Не импортируется |
| `ObjectType` | Тип объекта: ДОУ, коммерческое помещение, автомойка | Не импортируется |
| `Project` | Проект | Не импортируется |
| `Korpus` | Корпус | Не импортируется |
| `Korpusnumber` | Номер корпуса | Не импортируется |
| `Status` | Статус | Не импортируется |
| `IntProjectNumber` | Номер помещения | Не импортируется |
| `IntBTINumber` | Номер БТИ | Не импортируется |
| `IntStorey` | Этаж | Не импортируется |
| `IntProjectedArea` | Проектная площадь | Не импортируется |
| `IntAreaByBTI` | Площадь по БТИ | Не импортируется |
| `IntLivingAreaByBTI` | Жилая площадь по БТИ | Не импортируется |
| `IntPerSquareMeterPrice` | Цена за м2 | Не импортируется |
| `IntCost` | Базовая цена | Не импортируется |
| `IntAfterBTICost` | Цена после БТИ | Не импортируется |
| `IntDiscountedCostForSite` | Скидочная цена для сайта | Не импортируется |
| `IntDiscountedPriceForSite` | Скидочная цена за м2 для сайта | Не импортируется |
| `IntDiscountSiteRub` | Скидка в рублях | Не импортируется |
| `IntDiscountSitePercentage` | Скидка в процентах | Не импортируется |
| `IntCeilingHeight` | Высота потолка | Не импортируется |
| `IntPowerSupplyKW` | Выделенная мощность, кВт | Не импортируется |
| `IntDedicatedElectricalPower` | Выделенная электрическая мощность | Не импортируется |
| `IntHeatingKW` | Отопление, кВт | Не импортируется |
| `IntVentilationM3h` | Вентиляция, м3/ч | Не импортируется |
| `IntSewerageM3Day` | Канализация, м3/день | Не импортируется |
| `IntAirConditioningSystem` | Кондиционирование, флаг | Не импортируется |
| `IntAvailabilityElectricity` | Электричество, флаг | Не импортируется |
| `IntAvailabilityFurniture` | Мебель, флаг | Не импортируется |
| `IntAvailabilitySewerage` | Канализация, флаг | Не импортируется |
| `IntAvailabilityVentilation` | Вентиляция, флаг | Не импортируется |
| `IntAvailabilityWaterSupply` | Водоснабжение, флаг | Не импортируется |
| `IntPresenceFireAlarmSystem` | Пожарная сигнализация, флаг | Не импортируется |
| `IntPresenceOfHeat` | Отопление, флаг | Не импортируется |
| `IntConnectingGasNetworks` | Газовые сети, флаг | Не импортируется |
| `IntCommerceArea1` | Коммерческая площадь 1 | Не импортируется |
| `IntCommerceArea2` | Коммерческая площадь 2 | Не импортируется |
| `IntCommerceArea3` | Коммерческая площадь 3 | Не импортируется |
| `IntCommerceLevel1` | Коммерческий уровень 1 | Не импортируется |
| `IntCommerceLevel2` | Коммерческий уровень 2 | Не импортируется |
| `IntCommerceLevel3` | Коммерческий уровень 3 | Не импортируется |
| `IntFloorCovering` | Покрытие пола | Не импортируется |
| `IntWindowsillHeightStr` | Высота подоконника | Не импортируется |
| `IntWindowType` | Тип окон | Не импортируется |
| `ActionId` | ID акции | Не импортируется |

## MHMTS fields

Путь: `projects.project.mhmtses.mhmts`.

Текущий parser эту секцию не читает.

| XML field | Что это | Mapping в parser |
| --- | --- | --- |
| `mhmtsid` | GUID МХМТС | Не импортируется |
| `mhmtsName` | Внутреннее имя МХМТС | Не импортируется |
| `ObjectType` | Тип объекта, здесь `МХМТС` | Не импортируется |
| `Project` | Проект | Не импортируется |
| `Korpusnumber` | Номер корпуса | Не импортируется |
| `Status` | Статус | Не импортируется |
| `IntProjectNumber` | Номер | Не импортируется |
| `IntSection` | Секция | Не импортируется |
| `IntStorey` | Этаж | Не импортируется |
| `IntProjectedArea` | Площадь | Не импортируется |
| `IntPerSquareMeterPrice` | Цена за м2 | Не импортируется |
| `IntCost` | Цена | Не импортируется |
| `IntDiscountedCostForSite` | Скидочная цена | Не импортируется |
| `IntDiscountedPriceForSite` | Скидочная цена за м2 | Не импортируется |
| `IntDiscountSiteRub` | Скидка в рублях | Не импортируется |
| `IntDiscountSitePercentage` | Скидка в процентах | Не импортируется |
| `IntCeilingHeight` | Высота потолка | Не импортируется |

## Pantry fields

Путь: `projects.project.pantries.pantry`.

Текущий parser эту секцию не читает.

| XML field | Что это | Mapping в parser |
| --- | --- | --- |
| `pantryid` | GUID кладовки | Не импортируется |
| `pantryName` | Внутреннее имя кладовки | Не импортируется |
| `ObjectType` | Тип объекта, здесь `Кладовка` | Не импортируется |
| `Project` | Проект | Не импортируется |
| `Korpus` | Корпус | Не импортируется |
| `Korpusnumber` | Номер корпуса | Не импортируется |
| `Status` | Статус | Не импортируется |
| `IntProjectNumber` | Номер кладовки | Не импортируется |
| `IntBTINumber` | Номер БТИ | Не импортируется |
| `IntStorey` | Этаж | Не импортируется |
| `IntBtiFloor` | Этаж по БТИ | Не импортируется |
| `IntProjectedArea` | Проектная площадь | Не импортируется |
| `IntAreaByBTI` | Площадь по БТИ | Не импортируется |
| `IntDifferenceArea` | Разница площади | Не импортируется |
| `IntPantryArea` | Площадь кладовки | Не импортируется |
| `IntPantryHeight` | Высота кладовки | Не импортируется |
| `IntPantryLength` | Длина кладовки | Не импортируется |
| `IntPantryWidth` | Ширина кладовки | Не импортируется |
| `IntLivingAreaByBTI` | Жилая площадь по БТИ | Не импортируется |
| `IntPerSquareMeterPrice` | Цена за м2 | Не импортируется |
| `IntCost` | Цена | Не импортируется |
| `IntAfterBTICost` | Цена после БТИ | Не импортируется |
| `IntDiscountedCostForSite` | Скидочная цена | Не импортируется |
| `IntDiscountedPriceForSite` | Скидочная цена за м2 | Не импортируется |
| `IntDiscountSiteRub` | Скидка в рублях | Не импортируется |
| `IntDiscountSitePercentage` | Скидка в процентах | Не импортируется |
| `IntCeilingHeight` | Высота потолка | Не импортируется |
| `ActionId` | ID акции | Не импортируется |

## Parking fields

Путь: `projects.project.parkings.parking`.

Текущий parser эту секцию не читает. Это совпадает с предыдущим решением по Tekta: машиноместа не импортировать.

| XML field | Что это | Mapping в parser |
| --- | --- | --- |
| `parkingid` | GUID машиноместа | Не импортируется |
| `parkingName` | Внутреннее имя машиноместа | Не импортируется |
| `ObjectType` | Тип объекта, здесь `Машиноместо` | Не импортируется |
| `Project` | Проект | Не импортируется |
| `Korpusnumber` | Номер корпуса | Не импортируется |
| `Status` | Статус | Не импортируется |
| `IntProjectNumber` | Номер машиноместа | Не импортируется |
| `IntSection` | Секция | Не импортируется |
| `IntStorey` | Этаж | Не импортируется |
| `IntStage` | Стадия/уровень | Не импортируется |
| `IntProjectedArea` | Проектная площадь | Не импортируется |
| `IntParkingArea` | Площадь машиноместа | Не импортируется |
| `IntParkingArea2` | Дополнительная площадь машиноместа | Не импортируется |
| `IntParkingLength` | Длина | Не импортируется |
| `IntParkingLength2` | Дополнительная длина | Не импортируется |
| `IntParkingWidth` | Ширина | Не импортируется |
| `IntParkingWidth2` | Дополнительная ширина | Не импортируется |
| `IntParkingPrice` | Цена машиноместа | Не импортируется |
| `IntParkingPrice2` | Дополнительная цена машиноместа | Не импортируется |
| `IntParkingSpaceType` | Тип места, например `Независимое` | Не импортируется |
| `IntParkingType` | Тип парковки | Не импортируется |
| `IntPerSquareMeterPrice` | Цена за м2 | Не импортируется |
| `IntCost` | Цена | Не импортируется |
| `IntDiscountedCostForSite` | Скидочная цена | Не импортируется |
| `IntDiscountedPriceForSite` | Скидочная цена за м2 | Не импортируется |
| `IntDiscountSiteRub` | Скидка в рублях | Не импортируется |
| `IntDiscountSitePercentage` | Скидка в процентах | Не импортируется |
| `IntCeilingHeight` | Высота потолка | Не импортируется |
| `ActionId` | ID акции | Не импортируется |

## Unsupported office path

Текущий `TektaXmlFeedParser` умеет нормализовать `projects.project.offices.office`, но в текущем `Era.xml` такой секции нет.

Если Tekta отдаст именно `offices.office`, parser ожидает:

| XML field | Mapping |
| --- | --- |
| `officeId` | `FeedUnit.externalId` |
| `officeIntName` | fallback `externalId`, fallback номера, `commercialDetails.detailsJson.officeIntName` |
| `Status` | `FeedUnit.status` |
| `Project` | `FeedUnit.projectName` |
| `Korpus` | `FeedUnit.building` |
| `Korpusnumber` | `commercialDetails.detailsJson.corpusNumber` |
| `IntSection` | `FeedUnit.section` |
| `IntStorey` | `FeedUnit.floor` |
| `IntProjectNumber` | номер в title |
| `IntCost` | `FeedUnit.price` |
| `IntDiscountedCostForSite` | `FeedUnit.discountPrice` |
| `IntProjectedArea` | `FeedUnit.area` |
| `IntPerSquareMeterPrice` | `FeedUnit.pricePerMeter` |
| `IntDiscountedPriceForSite` | `FeedUnit.discountPricePerMeter` |
| `IntOfficeType` или `ObjectType` | `commercialDetails.commercialType` |
| `IntCeilingHeight` | `commercialDetails.ceilingHeight` |
| `IntPowerSupplyKW` | `commercialDetails.powerKw` |
| `IntSeparateInput` | `commercialDetails.separateEntrance` |
| `IntNumberOnVenue` | `commercialDetails.detailsJson.numberOnVenue` |
| `IntLayoutCode`, `IntLinkPhoto`, `IntProjectPhoto` | `FeedUnit.media`, только `http(s)` URL |
