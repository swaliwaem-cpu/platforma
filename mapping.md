# WordPress -> новая платформа: аудит и маппинг данных

Дата аудита: 2026-05-05.

Источник:

- Локальный сайт: `https://testfw.local`.
- WordPress URL в базе: `http://testfw.local/`.
- База данных: `local`.
- Префикс таблиц: `wp_`.
- Файлы uploads: `/Users/nick/Local Sites/testfw/app/public/wp-content/uploads`.
- Активная тема: `nedvizhimost`.
- Ключевые плагины: `advanced-custom-fields-pro`, `wp-all-import-pro`, `wp-all-export-pro`, `rank-math`, `contact-form-7`.

Важно: доступ к базе был подтверждён пользователем для операций чтения. Фактический пользователь LocalWP не является отдельным read-only пользователем, поэтому для будущего автоматического импортёра лучше создать отдельного MySQL-пользователя только с `SELECT`.

## 1. Основной источник объектов

Основной `post_type` объектов недвижимости:

```txt
nedvizhimosts
```

Количество записей:

| Статус WordPress | Количество | Рекомендуемый статус в новой БД |
|---|---:|---|
| `publish` | 294 | `published` |
| `draft` | 8 | `draft` |
| `private` | 1 | `draft`, до ручного решения |

Дополнительные post types, найденные в теме:

| post_type | Назначение | Количество |
|---|---|---:|
| `commercials` | офисные помещения | 18 |
| `osobnyakis` | особняки | 3 |
| `blogs` | блог | 19 |

Для текущего MVP импортировать как основные объекты нужно `nedvizhimosts`.

Явно не импортируем на текущем этапе:

- `osobnyakis` — особняки исключены по уточнению пользователя;
- `blogs` — блог не входит в закрытую платформу объектов.

`commercials` не включать в первый импорт автоматически. Если офисные помещения понадобятся, добавить их отдельным решением перед реализацией импортёра.

## 2. Основные таблицы WordPress

Используемые таблицы:

- `wp_posts` — объекты, attachments, ACF field groups.
- `wp_postmeta` — ACF-значения объектов.
- `wp_terms` — справочники фильтров.
- `wp_term_taxonomy` — структура таксономий.
- `wp_term_relationships` — связи объектов с терминами.
- `wp_termmeta` — метаданные терминов, особенно линии метро.
- `wp_options` — site URL, активные плагины, ACF options.

## 3. ACF

ACF используется активно.

Главная группа полей объектов:

```txt
ID: 441
Название: Динамическое редактирование контента страницы объекта
Location: post_type == nedvizhimosts OR commercials OR osobnyakis
```

Основные ACF-поля объекта:

| ACF field | Тип | Назначение |
|---|---|---|
| `zagolovok_1` | text | H1 / отображаемый заголовок |
| `korotkoe_opisanie` | textarea | краткое описание карточки/объекта |
| `imya_zastrojshhika` | text | имя застройщика |
| `kolichestvo_komnat` | text | текстовое количество комнат |
| `stoimost` | text | базовая цена объекта |
| `stoimost_1` ... `stoimost_5` | text | цены по студии/комнатам |
| `za_m2` | text | цена за м2 |
| `czena_opczionalna` | true_false | символическая/опциональная цена |
| `izobrazhenie_1` | image | главное фоновое изображение |
| `izobrazhenie_miniatyura` | image | миниатюра карточки |
| `czikl_vyvoda_galerei` | repeater | галерея объекта |
| `czikl_vyvoda_miniatyur_v_kartochke` | repeater | миниатюры карточки |
| `pdf_fajl` | file | презентация / PDF-файл |
| `opisanie_2`, `opisanie_3`, `opisanie_4_1`, `opisanie_4_2`, `opisanie_5` | textarea | контентные описания |
| `czikl_vyvoda_czen` | repeater | характеристики / технические подробности |
| `czikl_vyvoda_komnat` | repeater | карточки комнат/планировок |
| `czikl_vyvoda_tabov` | repeater | подробные табы |
| `karta_koordinaty` | text | координаты объекта |
| `czikl_vyvoda_blizhajshih_obektov` | repeater | ближайшие объекты/места текстом |
| `czikl_vyvoda_mest_ryadom` | repeater | места рядом с координатами и изображениями |
| `pohozhie_zhilye_kompleksy` | relationship | похожие ЖК |
| `vklvykl`, `zagolovok_11`, `faq_text_hide`, `czikl_vyvoda_vopros_otvetov` | mixed | FAQ |

## 4. Маппинг объекта

| WordPress | Новая БД | Правило |
|---|---|---|
| `wp_posts.ID` | `RealEstateObject.wpPostId` | сохранить для идемпотентного импорта |
| `wp_posts.post_title` | `RealEstateObject.title` | основной fallback-заголовок |
| `wp_postmeta.zagolovok_1` | `RealEstateObject.title` или `featuresJson.h1` | использовать как отображаемый H1, если заполнен |
| `wp_posts.post_name` | `RealEstateObject.slug` | сохранить slug |
| `wp_posts.post_status` | `RealEstateObject.status` | `publish -> published`, `draft/private -> draft` |
| `wp_posts.post_content` | `RealEstateObject.description` | почти не заполнен, использовать только как fallback |
| `wp_postmeta.korotkoe_opisanie` | `RealEstateObject.description` / `featuresJson.shortDescription` | основной источник краткого описания |
| `wp_postmeta.imya_zastrojshhika` | `Developer.name` | создавать/переиспользовать застройщика по имени |
| `wp_postmeta.stoimost` | `RealEstateObject.priceFrom` | парсить как число |
| `wp_postmeta.za_m2` | `RealEstateObject.pricePerMeterFrom` | парсить как число |
| `wp_postmeta.karta_koordinaty` | `RealEstateObject.latitude`, `longitude` | формат `55.761684, 37.549320` |
| `wp_postmeta.pdf_fajl` | `ObjectFile type=presentation` | attachment ID |
| `wp_postmeta.izobrazhenie_miniatyura` | `ObjectImage.isCover` | attachment ID, приоритет для карточки |
| `wp_postmeta.izobrazhenie_1` | `ObjectImage` | attachment ID, hero/cover fallback |
| `wp_postmeta.czikl_vyvoda_galerei_{n}_izobrazhenie` | `ObjectImage[]` | gallery images, сортировка по `{n}` |
| `wp_postmeta.czikl_vyvoda_galerei_{n}_izobrazhenie_alt` | `ObjectImage.alt` | alt |
| `wp_postmeta.czikl_vyvoda_galerei_{n}_izobrazhenie_title` | `ObjectImage.title` или metadata | title |
| `wp_postmeta.czikl_vyvoda_komnat_*` | `ObjectFile` / `featuresJson.rooms` | планировки и цены комнат |
| `wp_postmeta.czikl_vyvoda_czen_*` | `featuresJson.characteristics` | технические характеристики |
| `wp_postmeta.czikl_vyvoda_tabov_*` | `featuresJson.tabs` | дополнительные вкладки |
| `wp_postmeta.czikl_vyvoda_mest_ryadom_*` | `featuresJson.nearbyPlaces` | места рядом, координаты и изображения |
| `wp_postmeta.pohozhie_zhilye_kompleksy` | `featuresJson.relatedWpPostIds` | relationship хранит массив WP post IDs |

Примечание: для импортёра лучше хранить сложные лендинговые секции в `featuresJson` на первом этапе, а в нормализованные таблицы выносить только то, что нужно для каталога, фильтров, карточек, карты и детальной страницы.

## 5. Покрытие ключевых полей

Всего объектов `nedvizhimosts`: 303.

| Поле | Заполнено | Пусто | Пример |
|---|---:|---:|---|
| `zagolovok_1` | 302/303 | 1 | `ЖК Red Side` |
| `korotkoe_opisanie` | 299/303 | 4 | `RedSide — жилой комплекс...` |
| `stoimost` | 215/303 | 88 | `41700000` |
| `za_m2` | 251/303 | 52 | `603700` |
| `imya_zastrojshhika` | 301/303 | 2 | `INSIGMA` |
| `karta_koordinaty` | 300/303 | 3 | `55.761684, 37.549320` |
| `izobrazhenie_1` | 300/303 | 3 | attachment ID |
| `izobrazhenie_miniatyura` | 299/303 | 4 | attachment ID |
| `czikl_vyvoda_galerei` | 300/303 | 3 | count |
| `czikl_vyvoda_miniatyur_v_kartochke` | 299/303 | 4 | count |
| `pdf_fajl` | 17/303 | 286 | attachment ID |
| `czikl_vyvoda_czen` | 302/303 | 1 | count |
| `czikl_vyvoda_komnat` | 36/303 | 267 | count |
| `czikl_vyvoda_tabov` | 102/303 | 201 | count |
| `czikl_vyvoda_mest_ryadom` | 297/303 | 6 | count |
| `pohozhie_zhilye_kompleksy` | 41/303 | 262 | serialized relationship array |

Цены среди опубликованных объектов:

| Поле | Минимум | Максимум | Количество |
|---|---:|---:|---:|
| `stoimost` | 6 390 000 | 1 745 000 000 | 206 |
| `za_m2` | 240 116 | 12 500 000 | 242 |

## 6. Таксономии и фильтры

Основная таксономия объектов:

```txt
nedvizhimost
```

Связи с объектами:

| Таксономия | Терминов | Объектов со связями |
|---|---:|---:|
| `nedvizhimost` | 336 | 301 |
| `custom_tag-two` | 18 | 257 |

Главные родительские термины `nedvizhimost`:

| term_id | Название | slug | Назначение |
|---:|---|---|---|
| 5 | Вид недвижимости | `vid-zhilya` | тип объекта |
| 6 | Район около | `rajon-okolo` | локация/окружение |
| 8 | Метро | `metro` | линии и станции метро |
| 9 | Районы | `rajony` | районы, вложены через буквенные группы |
| 59 | Количество комнат | `kolichestvo-komnat` | фильтр комнат |
| 1300 | Этап строительства | `etap-stroitelstva` | сдан / не сдан |
| 1303 | Год | `god` | год сдачи |
| 1717 | Отделка | `otdelka` | отделка |
| 1721 | Особенности квартиры | `osobennosti-kvartiry` | особенности |
| 1736 | Сдача | `sdacha` | дополнительный фильтр сдачи |

Маппинг таксономий:

| WordPress taxonomy / terms | Новая БД |
|---|---|
| `nedvizhimost`, parent `5` | `featuresJson.objectTypes` или отдельный enum/filter |
| `nedvizhimost`, parent `6` | `Location` type `area` / `custom` |
| `nedvizhimost`, parent `8`, first level | `MetroLine` или поле `MetroStation.line` |
| `nedvizhimost`, parent under metro line | `MetroStation.name`, `slug`, `line` |
| `nedvizhimost`, parent `9`, descendants | `Location` type `district` |
| `nedvizhimost`, parent `59` | `featuresJson.rooms` / filter |
| `nedvizhimost`, parent `1300` | `featuresJson.constructionStage` |
| `nedvizhimost`, parent `1303` | `RealEstateObject.completionYear` |
| `nedvizhimost`, parent `1717` | `featuresJson.finishing` |
| `nedvizhimost`, parent `1721` | `featuresJson.apartmentFeatures` |
| `nedvizhimost`, parent `1736` | `featuresJson.handover` |
| `custom_tag-two` | tags / `featuresJson.tags`, если нужны |

Метаданные метро в `wp_termmeta`:

| termmeta key | Назначение |
|---|---|
| `czvet_metro` | цвет линии метро, например `#ff1168` |
| `ikonka_metro` | attachment ID иконки |
| `ikonka_metro_alt` | alt |
| `ikonka_metro_title` | title |

## 7. Медиа и файлы

Всего attachments в WordPress: 35 461.

Основные MIME-типы:

| MIME type | Количество |
|---|---:|
| `image/webp` | 33 160 |
| `image/jpeg` | 1 656 |
| `image/png` | 305 |
| empty MIME | 282 |
| `image/svg+xml` | 30 |
| `application/pdf` | 27 |

Медиа, реально привязанные к `nedvizhimosts` через ACF:

| Метрика | Значение |
|---|---:|
| Числовых media references | 8 093 |
| Уникальных attachment IDs | 5 999 |
| Attachment IDs без записи `attachment` | 5 |
| Уникальных существующих attachments с локальными файлами | 5 995 |
| Отсутствующих локальных файлов среди существующих attachments | 0 |

PDF / презентации:

- `pdf_fajl` заполнен у 17 объектов.
- Часть `pdf_fajl` указывает не на PDF, а на `webp`, поэтому импортёр должен проверять MIME type и не считать поле презентацией без проверки.
- Среди referenced attachments найдено 12 `application/pdf`.

Правило импорта медиа:

1. Читать attachment ID из ACF-поля.
2. Проверять наличие `wp_posts.ID` с `post_type='attachment'`.
3. Читать `_wp_attached_file`.
4. Проверять локальный файл в `wp-content/uploads`.
5. Проверять MIME type.
6. Загружать в MinIO.
7. Создавать `File`.
8. Создавать `ObjectImage` или `ObjectFile`.

## 8. Координаты и карта

Источник координат объекта:

```txt
wp_postmeta.karta_koordinaty
```

Формат:

```txt
55.761684, 37.549320
```

Покрытие:

- заполнено у 300 из 303 объектов;
- 3 объекта без координат.

Также есть координаты мест рядом:

```txt
czikl_vyvoda_mest_ryadom_{n}_koordinaty
```

Их стоит импортировать в `featuresJson.nearbyPlaces`, но для карты каталога использовать только `karta_koordinaty`.

## 9. Застройщики

Источник:

```txt
wp_postmeta.imya_zastrojshhika
```

Покрытие:

- заполнено у 301 из 303 объектов;
- 2 объекта без застройщика.

Правило:

- нормализовать строку;
- создавать `Developer` по уникальному имени;
- сохранять связь `RealEstateObject.developerId`;
- если имя пустое, оставлять `developerId = null` и фиксировать warning в import report.

## 10. Риски импорта

| Риск | Деталь | Что сделать |
|---|---|---|
| Не все цены заполнены | `stoimost` пустой у 88 объектов, `za_m2` пустой у 52 объектов | это ожидаемое качество исходных данных; импортировать как `null`, фиксировать informational warning |
| Координаты отсутствуют у 3 объектов | карта будет неполной | это ожидаемое качество исходных данных; импортировать объект без marker, показать в отчёте |
| Застройщик отсутствует у 2 объектов | не будет связи с `Developer` | это ожидаемое качество исходных данных; импортировать без developer, показать informational warning |
| `pdf_fajl` не всегда PDF | среди значений есть `webp` | проверять MIME перед созданием presentation |
| 5 media references указывают на отсутствующие attachment-записи | файл нельзя импортировать по ID | фиксировать error/warning по объекту и meta_key |
| `post_content` почти пустой | заполнен только у 1 из 303 объектов | брать описание из ACF-полей |
| Районы вложены через буквенные группы | parent `9` содержит буквы, реальные районы лежат глубже | импортировать descendants, а буквенные группы не считать районами |
| Метро вложено в два уровня | parent `8` -> линия -> станции | импортировать line и station отдельно |
| Есть соседний каталог `commercials` | использует ту же ACF-группу, но не включён в первый импорт автоматически | принять отдельное решение перед импортом, если офисы понадобятся |
| `osobnyakis` найден в WordPress | особняки исключены по уточнению пользователя | не импортировать на текущем этапе |
| Текущий DB user не read-only | LocalWP user имеет больше прав | для автоматического импортёра создать отдельного `SELECT`-пользователя |

Пустые бизнес-поля в исходной WordPress-базе не считаются ошибкой импорта. Импортёр должен быть устойчивым к неполным данным: сохранять доступные значения, ставить `null` там, где поле пустое, и добавлять такие случаи в отчёт как предупреждения/заметки, а не как блокирующие ошибки.

## 11. Рекомендуемый алгоритм preview

1. Подключиться к WordPress DB.
2. Найти `nedvizhimosts` со статусами `publish`, `draft`, `private`.
3. Для каждого объекта прочитать базовые поля из `wp_posts`.
4. Прочитать все ACF meta из `wp_postmeta`.
5. Распарсить `karta_koordinaty`.
6. Распарсить цены как числа.
7. Найти/подготовить `Developer` по `imya_zastrojshhika`.
8. Собрать термины `nedvizhimost`.
9. Разложить taxonomy terms по группам: тип, район, метро, комнаты, год, отделка, особенности.
10. Собрать media references из обложки, миниатюры, галереи, комнат, табов и PDF.
11. Проверить attachments и локальные файлы.
12. Сформировать `ImportReport` без записи в новую БД.

## 12. Рекомендуемый алгоритм commit

1. Запускать commit только после успешного preview.
2. Использовать `wpPostId` как основной ключ идемпотентности.
3. Использовать `slug` как дополнительный ключ.
4. Создать/обновить `Developer`.
5. Создать/обновить `Location` и `MetroStation` из taxonomy terms.
6. Создать/обновить `RealEstateObject`.
7. Создать/обновить связи с метро и локациями.
8. Импортировать media в MinIO и создать `File`.
9. Создать/обновить `ObjectImage` и `ObjectFile`.
10. Сохранить сложные секции в `featuresJson`.
11. Сохранить отчёт импорта.
12. Повторный запуск не должен создавать дубликаты.
