# Lot Filters Design

## Goal

Add server-side lot filters to the public broker portal so catalog, map, and object detail lot lists use the same data semantics.

## Scope

- Global catalog filters on `/catalog`.
- Global map filters on `/catalog/map`.
- Lot table filters inside object detail pages.
- API filtering for `/objects`, `/map/objects`, and `/objects/:id/feed-units`.

No new libraries, migrations, or framework changes are required.

## Global Catalog And Map Behavior

The global object list and map must show an object when at least one related `feedUnit` matches all selected lot-level filters.

Lot-level global filters:

- `Цена лота от` and `Цена лота до` filter `feed_units.price`.
- `Сколько комнат` filters `feed_units.rooms`.
- `Этаж от` and `Этаж до` filter `feed_units.floor`.

Object-level global filters:

- `Срок сдачи` remains a year-only filter on the object completion year.
- Existing developer, KRT, district, area, metro, search, status, sorting, pagination, and map behavior remain unchanged.

The old global price-object fallback behavior is replaced for the user-facing price filter: selected price bounds must not match objects only by manual `priceFrom`.

## Object Detail Lot Filters

Inside the `Лоты` section on an object detail page, add filters for the actual lot rows:

- `Этаж от` and `Этаж до` filter `feed_units.floor`.
- `Площадь от` and `Площадь до` filter `feed_units.area`.
- `Цена от` and `Цена до` filter `feed_units.price`.
- `Цена за метр от` and `Цена за метр до` filter `feed_units.pricePerMeter`.
- `Срок сдачи`: `Год` plus adjacent `Квартал`.
- `Комнаты`: dropdown with `Студия`, `1 спальня`, `2 спальни`, `3 спальни`, `4 спальни`.

If the user leaves the quarter filter empty, completion filtering uses only the selected year. If a quarter is selected, both year and quarter must match.

Existing status and type filters remain. Reset clears all lot filters and returns pagination to page 1.

## Rooms Mapping

Use the current data model directly:

- `Студия` maps to `rooms = 0`.
- `1 спальня` maps to `rooms = 1`.
- `2 спальни` maps to `rooms = 2`.
- `3 спальни` maps to `rooms = 3`.
- `4 спальни` maps to `rooms = 4`.

## API Design

Extend object list queries for `/objects` and `/map/objects` with lot-level params:

- `lotPriceMin`
- `lotPriceMax`
- `lotRooms`
- `lotFloorMin`
- `lotFloorMax`

When any of these params is present, add one `feedUnits: { some: ... }` filter that combines all selected lot conditions.

Extend `/objects/:id/feed-units` with:

- `priceMin`
- `priceMax`
- `pricePerMeterMin`
- `pricePerMeterMax`
- `areaMin`
- `areaMax`
- `rooms`
- `floorMin`
- `floorMax`
- `completionYear`
- `completionQuarter`

Validation should follow existing API parsing patterns:

- numeric range params accept sanitized positive decimals or integers as appropriate;
- invalid values return `BadRequestException`;
- min greater than max returns `BadRequestException`;
- `completionQuarter` is valid only with a selected `completionYear`.

## Frontend Design

In `CatalogPage`, add the new fields to `CatalogFilters`, URL parsing/building, active filter count, and API param building. The existing expanded filter panel remains the home for these controls.

In `ObjectDetailPage`, add state for the new lot filters, include them in the feed units request params, reset them together, and keep server sorting/pagination intact.

UI should stay compact and consistent with the current calm work-focused style. No layout model changes to catalog, map, or object details.

## Testing

Backend tests:

- `/objects` builds `feedUnits.some` for global lot price, rooms, and floor filters.
- `/map/objects` uses the same global lot filter semantics.
- `/objects/:id/feed-units` filters by price, price per meter, area, rooms, floor, year, and quarter.
- invalid ranges and quarter-without-year are rejected.

Frontend tests:

- catalog URL and API params include global lot filters;
- catalog active filter count includes the new filters;
- object detail lot requests include the new filters;
- reset clears all object detail lot filters.

Manual QA:

- Catalog and map return an object when one of its lots matches all selected lot filters.
- Catalog price filter no longer matches an object only by manual `priceFrom`.
- Object detail lot table filters rows correctly and resets to page 1.
