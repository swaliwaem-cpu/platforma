# Lot Grouped List Design

## Goal

Replace the flat lot table on the object detail page with a grouped lot list that matches the reference structure: primary grouping by completion date, summary rows by room count, and expandable rows with concrete lots.

This feature belongs to the object detail `Лоты` section. Catalog filters, map behavior, object cards, and import logic stay unchanged unless required to support the new lot response shape.

## Current Context

The current object detail lot section in `apps/web/src/objects/ObjectDetailPage.tsx` loads `/objects/:id/feed-units` page by page and renders a flat sortable table. The existing `FeedUnit` contract already contains the key fields needed for the new grouping:

- `completionYear` and `completionQuarter`;
- `building`, `section`, `floor`, `title`;
- `rooms`, `area`;
- `price`, `discountPrice`, `effectivePrice`;
- `pricePerMeter`, `discountPricePerMeter`, `effectivePricePerMeter`;
- `status`, `media`.

The current paginated response is not enough for correct group headers, because group totals and ranges must be calculated across all lots matching the active filters, not only the current page.

## Grouping Rules

Primary groups are completion groups:

- group key: `completionQuarter + completionYear`;
- visible label: `<quarter> кв. <year>` when both exist, `<year>` when only the year exists, `Срок не указан` when no year exists;
- group sort: known dates ascending, unknown completion last.

Each completion group header shows:

- distinct buildings included in that completion group;
- completion label;
- total number of lots in the group.

Building names are collected from `FeedUnit.building`, deduplicated and sorted using Russian numeric collation. If no buildings are available, the header uses `Корпуса не указаны`.

Secondary groups are room-count rows inside each completion group:

- `0` maps to `Студии`;
- `1` maps to `1-к.кв`;
- `2` maps to `2-к.кв`;
- `3` maps to `3-к.кв`;
- `4` maps to `4-к.кв`;
- `5` maps to `5-к.кв`;
- missing residential room count goes to `Тип не указан`;
- commercial lots use `Коммерция`.

No `2E`, `3E`, or other euro labels are inferred for this version. `layoutType` and raw feed hints are not used for group labels.

Each room row shows:

- room label;
- min and max area across all lots in the row;
- min and max effective price across all lots in the row;
- total count of lots in the row;
- expand/collapse control.

## Expansion Behavior

On first load:

- the first completion group is expanded;
- the first room row inside that group is expanded;
- all other completion groups and room rows are collapsed.

Users can expand and collapse completion groups and room rows independently. Expanding one row does not have to collapse another row.

Inside an expanded room row, render the first `20` lots. If the row has more than `20` lots, show `Показать еще N` and append the next `20` lots per click until all row lots are visible.

Filtering resets visible lot counts back to `20` per row and recomputes default expansion for the new result set.

## Sorting

Completion groups and room rows keep fixed ordering:

1. completion date ascending, unknown last;
2. room groups ascending: `Студии`, `1-к.кв`, `2-к.кв`, etc., then `Коммерция`, then `Тип не указан`.

The existing sort control applies only to concrete lots inside expanded room rows. It does not reorder completion groups or room summary rows.

Default lot sorting remains by effective price ascending.

## Lot Row Columns

The expanded lot table uses columns closer to the reference, but only with data available in the current model:

- plan/media preview;
- `Корпус`;
- `Секц.`;
- `Эт.`;
- `Номер квартиры`;
- `Площадь`;
- `Цена`;
- `За м²`;
- `Статус`;
- `Медиа`.

`Номер квартиры` uses the current lot title returned by `getFeedUnitTitle(unit)`. Missing values use the existing fallback `Лот без названия`.

The media preview uses the first media file when available, with the existing secure image behavior. The media action keeps the existing carousel behavior.

## Filters

Existing object detail lot filters stay available:

- status;
- type;
- price range;
- price per meter range;
- area range;
- rooms;
- floor range;
- completion year and quarter.

Filters apply before grouping. All group totals, ranges, buildings, and row counts are based on the filtered full lot set.

Reset clears filters, returns default expansion, and resets visible row lot counts to `20`.

## API Design

Add a grouped lot API surface for the object detail page. The preferred shape is a new endpoint:

`GET /objects/:id/feed-units/groups`

It accepts the same filters and sort params as `GET /objects/:id/feed-units`, except classic page-level pagination is not used for the grouped response.

Response shape:

```ts
type FeedUnitGroupSummary = {
  key: string;
  label: string;
  buildings: string[];
  total: number;
  roomGroups: FeedUnitRoomGroupSummary[];
};

type FeedUnitRoomGroupSummary = {
  key: string;
  label: string;
  total: number;
  areaMin: string | null;
  areaMax: string | null;
  priceMin: string | null;
  priceMax: string | null;
  items: FeedUnit[];
};

type FeedUnitGroupsResponse = {
  groups: FeedUnitGroupSummary[];
  total: number;
  hasDiscountPrices: boolean;
};
```

The backend may compute this in one filtered query for all matching lots for the object, then group in service code. This keeps aggregation labels consistent with frontend formatting and avoids adding migrations or dependencies.

For very large objects, introduce a defensive backend limit only if necessary after inspecting realistic lot counts. The frontend still shows only `20` lots per expanded row initially.

## Frontend Design

`ObjectFeedUnitsSection` becomes a grouped view:

- load grouped response instead of paginated flat response;
- keep existing filter toolbar;
- keep sort controls in the expanded lot table header;
- render completion groups, room rows, and expanded lot rows;
- keep the existing media carousel and lot-detail new-tab behavior.

The old bottom pagination is removed from the grouped view. Row-level `Показать еще` replaces it.

Styles stay compact, calm, and data-dense. The layout should remain consistent with existing `detail-section` and table styling. Mobile behavior should collapse summary rows into readable stacked summaries while the concrete lot table remains horizontally scrollable.

## Testing

Backend tests:

- grouped endpoint returns groups by completion date;
- room labels are derived only from `rooms`;
- group and room totals/ranges are based on all filtered lots;
- filters are applied before grouping;
- sort params affect only `items` inside room groups;
- unknown completion and missing room values are placed in stable fallback groups.

Frontend tests:

- object detail lot section requests the grouped endpoint with current filters and sort params;
- first completion group and first room row are open by default;
- room row renders `Номер квартиры`;
- `Показать еще` reveals lots in increments of `20`;
- reset clears filters and restores default expansion;
- media carousel and lot-detail link behavior remain available from grouped rows.

Manual QA:

- open an object with lots across multiple completion quarters;
- verify group counts, area ranges, price ranges, and building lists;
- filter by rooms, price, area, floor, and completion date;
- verify sorting inside an expanded room row;
- verify mobile width and horizontal table scroll;
- verify media preview/carousel and lot detail route.
