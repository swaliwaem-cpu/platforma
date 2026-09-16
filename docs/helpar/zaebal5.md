# 05: Реальное гео POINT, LINE и AREA

**Parent spec:** `docs/helpar/fix-zaebal.md`

**What to build:** Белорусский вокзал, ТТК, МКАД, Садовое кольцо и Арбат разрешаются в доверенные POINT/LINE/AREA geometry с корректной московской identity. Search применяет `ST_DWithin` или `ST_Covers`, а карта показывает фактическую геометрию. Фрагменты, centroid и approximate fallback отклоняются fail-closed.

**Blocked by:** 01: Canonical geo и единый product submission path.

**Status:** ready-for-agent

- [ ] До реализации добавлены RED provider-contract тесты на purpose, Russian inflection, missing city, identity/scope, completeness, response size и cache version.
- [ ] Live runtime contract содержит обязательный bounded geo cache TTL с configuration test.
- [ ] Provider request различает `FULL_GEOMETRY`, `METADATA` и `BOUNDS`; polygon GeoJSON запрашивается только для AREA full geometry.
- [ ] POINT, LINE identity и Moscow bbox lookup не запрашивают polygon data; существующий response-size cap не увеличен.
- [ ] Белорусский вокзал canonicalized в именительный русский вариант с Moscow/RU scope, сохраняя inflected user aliases.
- [ ] ТТК, МКАД и Садовое кольцо проходят только по exact allowlisted name/OSM identity, highway class и RU scope.
- [ ] Отсутствие `candidate.city` само по себе не отклоняет известную кольцевую дорогу; явная другая страна, неверная identity/class отклоняются.
- [ ] Road bbox берётся из ожидаемого Moscow scope; Overpass принимает только complete exact-tag relation со всеми members и valid LINE geometry, без centroid/fragments/ways-only/point fallback.
- [ ] Арбат проходит только по bounded exact names/namedetails и allowlisted OSM identity; явный другой город, wrong type/class, way/centroid и ambiguity отклоняются.
- [ ] Rejection categories различают identity, scope, shape и size без сохранения raw provider payload.
- [ ] Geo identity/cache version повышена; старые negative cache entries не маскируют исправления; Prisma migration не добавлена.
- [ ] Disposable PostGIS tests доказывают POINT/LINE через `ST_DWithin`, AREA через `ST_Covers`, stable cache и отсутствие provider recall при повторном browser use.
- [ ] Authenticated browser E2E доказывает resolver → persisted geometry → search → real MapLibre POINT/LINE/AREA rendering с hard caps и без approximate fallback.
- [ ] Targeted FIX-GEO1/provider/PostgreSQL/browser suites проходят на stub providers вместе с затронутым build, релевантными full gates и `git diff --check`.
- [ ] Реальный Geo canary не запускается без отдельной свежей команды с лимитами из тикета 06.
- [ ] Disposable-ресурсы очищены, unrelated dirty/untracked-файлы сохранены, изменения оформлены одним scoped local commit без push/deploy.

