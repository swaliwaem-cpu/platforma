# Lot Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global object filters through matching lots and detailed server-side filters for the object detail lot table.

**Architecture:** Keep the existing API endpoints and add query params parsed by the existing service classes. Global catalog and map filters create one combined `feedUnits.some` condition; object detail lot filters extend the existing `FeedUnitWhereInput`.

**Tech Stack:** NestJS, Prisma, React, Vite, node:test.

---

### Task 1: Backend Global Lot Filters

**Files:**
- Modify: `apps/api/src/objects/objects.service.ts`
- Modify: `apps/api/src/map/map.service.ts`
- Test: `apps/api/tests/services.test.cjs`

- [ ] **Step 1: Write failing backend tests**

Add tests showing `/objects` and `/map/objects` build `feedUnits.some` with `price`, `rooms`, and `floor`, and do not rely on manual `priceFrom`.

- [ ] **Step 2: Run backend tests and verify RED**

Run: `pnpm --filter @platforma/api test`

Expected: tests fail because `lotPriceMin`, `lotRooms`, and `lotFloorMin` are not implemented.

- [ ] **Step 3: Implement global lot filters**

Extend the list query types with `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax`. Add a helper that parses all selected lot filters and returns:

```ts
{
  feedUnits: {
    some: {
      ...(priceRange ? { price: priceRange } : {}),
      ...(rooms !== undefined ? { rooms } : {}),
      ...(floorRange ? { floor: floorRange } : {}),
    },
  },
}
```

- [ ] **Step 4: Run backend tests and verify GREEN**

Run: `pnpm --filter @platforma/api test`

Expected: PASS.

### Task 2: Backend Object Detail Lot Filters

**Files:**
- Modify: `apps/api/src/objects/objects.service.ts`
- Test: `apps/api/tests/services.test.cjs`

- [ ] **Step 1: Write failing backend tests**

Add tests for `/objects/:id/feed-units` filters: `priceMin`, `priceMax`, `pricePerMeterMin`, `pricePerMeterMax`, `areaMin`, `areaMax`, `rooms`, `floorMin`, `floorMax`, `completionYear`, `completionQuarter`. Add rejection checks for invalid ranges and quarter without year.

- [ ] **Step 2: Run backend tests and verify RED**

Run: `pnpm --filter @platforma/api test`

Expected: tests fail because the new feed unit filters are not implemented.

- [ ] **Step 3: Implement feed unit filters**

Extend `ListObjectFeedUnitsQuery` and add range filters to the existing `filters` array:

```ts
filters.push({ price: { gte: priceMin, lte: priceMax } });
filters.push({ pricePerMeter: { gte: pricePerMeterMin, lte: pricePerMeterMax } });
filters.push({ area: { gte: areaMin, lte: areaMax } });
filters.push({ rooms });
filters.push({ floor: { gte: floorMin, lte: floorMax } });
filters.push({ completionYear, completionQuarter });
```

Only push fields that are selected.

- [ ] **Step 4: Run backend tests and verify GREEN**

Run: `pnpm --filter @platforma/api test`

Expected: PASS.

### Task 3: Frontend Catalog Filters

**Files:**
- Modify: `apps/web/src/catalog/CatalogPage.tsx`
- Test: `apps/web/tests/catalog-lot-filters.test.mjs`

- [ ] **Step 1: Write failing frontend tests**

Add source tests for catalog filter state, URL params, API params, labels, and active filter count.

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `pnpm --filter @platforma/web test`

Expected: tests fail because the global lot filters are not wired.

- [ ] **Step 3: Implement catalog filters**

Add `lotPriceMin`, `lotPriceMax`, `lotRooms`, `lotFloorMin`, `lotFloorMax` to `CatalogFilters`, parse/build URL params, send API params, and render compact controls in the existing expanded filter panel.

- [ ] **Step 4: Run frontend tests and verify GREEN**

Run: `pnpm --filter @platforma/web test`

Expected: PASS.

### Task 4: Frontend Object Detail Lot Filters

**Files:**
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/tests/object-detail-feed-units.test.mjs`

- [ ] **Step 1: Write failing frontend tests**

Extend existing source tests to assert object detail requests include price, price per meter, area, floor, rooms, year, and quarter params; reset clears the new filters.

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `pnpm --filter @platforma/web test`

Expected: tests fail because the object lot filters are not rendered or sent.

- [ ] **Step 3: Implement object detail filters**

Add state, request params, reset logic, compact toolbar controls, and responsive styles for the new lot filters.

- [ ] **Step 4: Run frontend tests and verify GREEN**

Run: `pnpm --filter @platforma/web test`

Expected: PASS.

### Task 5: Final Verification

**Files:**
- Verify: repo-wide build/test state

- [ ] **Step 1: Run focused test suites**

Run:

```bash
pnpm --filter @platforma/api test
pnpm --filter @platforma/web test
```

- [ ] **Step 2: Run builds**

Run:

```bash
pnpm build:api
pnpm build:web
```

- [ ] **Step 3: Review diff**

Run:

```bash
git diff --stat
git diff -- apps/api/src/objects/objects.service.ts apps/api/src/map/map.service.ts apps/web/src/catalog/CatalogPage.tsx apps/web/src/objects/ObjectDetailPage.tsx apps/web/src/styles.css
```
