# Etalon CIAN Feed Import Design

## Goal

Improve the existing `CIAN_XML` feed importer so Etalon-style CIAN-compatible feeds import into the same normalized lot model as other developer feeds.

The immediate target feed is:

`https://newsite.etalongroup.ru/upload/feed/msk/Cian/feed.xml`

The importer must keep `CIAN_XML` as the format. Do not introduce an `ETALON_*` format because future developer feeds should converge into the same normalized import pipeline.

## Scope

Update `tools/feed-import` parsing, analysis, routing filters, shared feed analysis types, admin mapping helpers, and tests for CIAN-compatible XML feeds that use Etalon field placement.

In scope:

- parse Etalon fallback fields inside `CIAN_XML`;
- improve `analyze` output for CIAN feeds so object mappings can be created per residential project;
- support CIAN multi-object mappings by project, building, address, and external id;
- expose CIAN analysis fields through shared contracts used by the admin UI;
- preserve existing Yandex feed behavior;
- preserve existing CIAN fixture behavior.

Out of scope:

- no new dependencies;
- no Prisma schema changes;
- no production data import;
- no seed, WordPress import, media backfill, or content rewrite;
- no separate feed format.

## Etalon Field Mapping

For `CIAN_XML`, keep current CIAN field reads first and add Etalon-compatible fallbacks:

- `status`: read `Booking.Status`; if it is missing, default to `AVAILABLE`.
- `title`: read XML `title`; fallback to the existing generated CIAN title.
- `developerName`: read `Developer.Name`; keep existing Yandex/sales-agent logic as a fallback for analysis.
- `projectName`: read `JKSchema.Name`.
- `building`: read `Building.Name`; fallback to `JKSchema.House.Name`.
- `section`: read `Section`; fallback to `JKSchema.House.Flat.SectionNumber`.
- `apartmentNumber`: read `FlatNumber`; fallback to `JKSchema.House.Flat.FlatNumber`.
- `rooms`: read `RoomsCount`; fallback to `FlatRoomsCount`.
- `FlatRoomsCount = 9` maps to `rooms = 0` because Etalon uses it for studios.
- `livingArea`: keep current `LivingArea`.
- `kitchenArea`: keep current `KitchenArea`.
- `price`, `currency`, `area`, `floor`, and `address` keep current reads.

Unknown explicit statuses must still produce warnings. Only a missing status defaults to `AVAILABLE`.

## Media Mapping

For `CIAN_XML`, import both layout images and regular photos:

- collect every `LayoutPhoto.FullUrl` as media label `layout-photo`;
- collect every `Photos.PhotoSchema.FullUrl` as media label `photo`;
- keep URL deduplication.

This must handle both a single `LayoutPhoto.FullUrl` and multiple repeated `FullUrl` values inside one `LayoutPhoto` block.

## Analysis And Object Mapping

For Etalon-style CIAN feeds, Platforma object means residential project, not building корпус.

`createFeedSourceAnalysis` should group CIAN units by:

1. `projectName` from `JKSchema.Name`;
2. fallback to `building`;
3. fallback to `address`;
4. fallback to `externalId`.

The analysis object should include enough values to build mappings:

- `projectNames`;
- `buildingNames`;
- `addresses`;
- `externalIds` only when needed for narrow manual routing.

For CIAN groups, generated `filterJson` should prefer:

1. `{ "projectNames": [...] }` when the group has one or more project names;
2. `{ "buildingNames": [...] }` when there is no project name but a building is known;
3. `{ "addressIncludes": [...] }` when only an address is known;
4. `{ "externalIds": [...] }` only for narrow fallback cases.

For the Etalon feed, analysis should show projects such as `Шагал`, `Нагатино Ай-Лэнд`, `Воксхолл`, `Мариин Парк`, `Соколин Парк`, and `Арбат 2`.

The analysis card title shown in the admin UI must be the residential project name from `JKSchema.Name`. It must not use address-only titles when a project name exists.

## Routing Filters

Keep the current Yandex filter behavior and extend routing filters so CIAN mappings can route units by normalized fields:

- `externalIds`;
- `projectNames`;
- `buildingNames`;
- `addressIncludes`;

For Yandex feeds, existing `yandexBuildingIds` and `yandexHouseIds` remain supported.

When active mappings exist, route each unit to the first mapping whose filter matches. When no active mapping matches, skip that unit. When no mappings exist, keep the existing fallback-object behavior.

## Admin UI Impact

The current feeds admin screen can continue sending raw mapping `filterJson`. If its mapping helpers display analysis groups, they should preserve the new CIAN analysis fields instead of showing empty filters for CIAN feeds.

Shared feed analysis contracts should include `projectNames` and allow CIAN `filterJson` values.

The analysis list should display project names as row/card headings and can show addresses and building names as secondary details. For the Etalon feed, the first visible headings should be names like `Шагал`, `Нагатино Ай-Лэнд`, and `Воксхолл`, not `г. Москва...`.

The summary warning label should remain a warning counter, not an error counter. Missing `Booking.Status` in an Etalon-style CIAN feed should not increment that counter after the parser defaults missing statuses to `AVAILABLE`.

No new UI dependency or layout redesign is required.

## Testing

Add or update tests in `tools/feed-import/tests/parser.test.cjs` and `tools/feed-import/tests/import-engine.test.cjs`.

Parser tests:

- Etalon-style CIAN objects without `Booking.Status` parse as `AVAILABLE` without status warnings.
- `FlatRoomsCount = 9` maps to `rooms = 0`.
- `JKSchema.House.Name` becomes `building`.
- `JKSchema.House.Flat.FlatNumber` becomes `apartmentNumber`.
- XML `title` is used as the normalized title.
- `Developer.Name` is available for analysis.
- all layout photo URLs and regular photo URLs are collected.

Analysis tests:

- Etalon-style CIAN units group by `JKSchema.Name`.
- Etalon-style CIAN analysis group titles use ЖК names instead of addresses when `JKSchema.Name` exists.
- analysis exposes project names, building names, addresses, and mapping filter JSON for CIAN groups.

Routing tests:

- CIAN mappings route units by `projectNames`.
- CIAN mappings can narrow routing by `buildingNames` or `addressIncludes`.
- existing Yandex mapping tests remain green.

Manual QA:

- Run read-only analyze for the Etalon URL and confirm it parses all units with no missing-status warning flood.
- In admin, create URL source as `CIAN_XML`, analyze it, map each ЖК to one Platforma object, and preview before any run.
- Confirm lots show project-level grouping while each lot still carries its корпус in `building`.
