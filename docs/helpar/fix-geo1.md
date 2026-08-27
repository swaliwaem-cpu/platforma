# FIX-GEO1: Геопоиск по полной геометрии ориентира

**What to build:** заменить модель «любое место = точка + радиус» на поиск по реальной геометрии ориентира: точке, всей дороге или границе района.

**Status:** ready-for-agent

## Поведение

- [ ] Парсер отделяет ориентир от остальных фильтров. В эталонном запросе извлекаются `Садовое кольцо`, 1 комната и бюджет до 35 млн.
- [ ] Поддерживаются режимы `NEAR` и `INSIDE`.
- [ ] Явно указанное расстояние всегда имеет приоритет.
- [ ] Без расстояния применяется default: 2 км для точек, 5 км для дорог, колец и районов.
- [ ] `NEAR + POINT` считается от координаты; `NEAR + LINE` — от всей длины дороги; `NEAR + AREA` — от всей границы района.
- [ ] `INSIDE + AREA` использует попадание внутрь полигона без радиуса.
- [ ] Центр, centroid или случайный участок дороги не используются как замена полной геометрии.
- [ ] Если полную геометрию доказать нельзя, помощник честно предлагает уточнение или ручную точку.

## Resolver, данные и PostGIS

- [ ] Shared-контракт становится discriminated union для `POINT | LINE | AREA`, `NEAR | INSIDE` и optional `distanceMeters`.
- [ ] Backend принимает от browser только trusted landmark ID либо validated point; произвольный GeoJSON клиента в поиск не допускается.
- [ ] Additive migration создаёт `assistant_geo_landmarks` с PostGIS geometry SRID 4326, GiST index, aliases, source metadata, confirmation state и expiry.
- [ ] Старый `{ anchor, radiusMeters }` читается для существующей истории и нормализуется в новый point-контракт.
- [ ] Resolver сначала использует подтверждённую геометрию БД, затем cache, после этого LocationIQ и OSM collector.
- [ ] LocationIQ запрашивает и валидирует GeoJSON для точек и площадей. API официально поддерживает `polygon_geojson`: [LocationIQ Search API](https://docs.locationiq.com/reference/search).
- [ ] Для дорог OSM/Overpass collector получает все одноимённые ways/relations в границах подтверждённого города и объединяет их в `LineString/MultiLineString`.
- [ ] Overpass-запросы используют bounded timeout/response size, single-flight, circuit breaker и cache TTL 30 дней; подтверждённые записи не истекают автоматически.
- [ ] Truncated, oversized, invalid или неоднозначная геометрия отклоняется целиком. Отдельные LocationIQ-фрагменты не склеиваются молча.
- [ ] Overpass является настраиваемым SLA-free provider: его отказ не ломает cached, point и manual search. Геометрию `way/relation` получать через `out geom`: [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL).
- [ ] Provider cache и telemetry не содержат ключей или raw payload; публичные Overpass rate limits учитываются fail-closed поведением: [Overpass limits](https://wiki.openstreetmap.org/wiki/Overpass_API/Wording).

## Поиск и интерфейс

- [ ] PostGIS применяет `ST_DWithin` к точке, полной линии либо границе полигона; `INSIDE` использует `ST_Covers`.
- [ ] Все geo predicates работают совместно с бюджетом, комнатностью и остальными lot/object filters.
- [ ] Ответ возвращает reference geometry, итоговую search area `Polygon | MultiPolygon`, markers и meaningful distance только для `NEAR`.
- [ ] Карта показывает линию/границу ориентира и реальную буферную зону; anchor-marker остаётся только для `POINT`.
- [ ] Geo-chip явно пишет: «Садовое кольцо · до 5 км от всей дороги», «Белорусский вокзал · до 2 км» или «внутри района Арбат».
- [ ] Ошибочный экран «Добавить радиус» больше не появляется, когда применим default.
- [ ] Routing, travel time и расстояние по дорогам в этот фикс не входят.

## Проверки и приёмка

- [ ] Domain tests покрывают исходную фразу пользователя, перестановку фильтров, явный override расстояния, defaults 2/5 км и `INSIDE`.
- [ ] Fake LocationIQ/Overpass tests покрывают полную дорогу, район, aliases, разные города, cache hit, timeout, truncation и fail-closed.
- [ ] Disposable PostGIS tests проверяют обе стороны дороги, всю окружность района, polygon containment, boundary cases, distance ordering и GiST plan.
- [ ] Browser E2E подтверждает отсутствие radius-dialog, сохранение бюджета/комнатности и корректные line/area слои desktop/mobile.
- [ ] Автотесты не обращаются к реальным LocationIQ или Overpass; отдельный bounded smoke проверяет Садовое кольцо, ТТК, МКАД и район Арбат.
- [ ] Запускаются targeted assistant tests, API/web builds, migration replay и общий `pnpm test`; production deploy в этот тикет не входит.
