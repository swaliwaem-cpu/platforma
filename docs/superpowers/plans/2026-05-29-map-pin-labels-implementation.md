# Map Pin Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable map labels for real estate objects and render SVG-based dot/pin markers on the Yandex map.

**Architecture:** Store the admin-editable label as `RealEstateObject.mapName`/`map_name` with API validation and serialization. The catalog map receives `mapName`, derives a 6-character fallback from `title` when empty, and passes the resolved label into the Yandex marker template that switches between dot and pin at `zoom >= 14`.

**Tech Stack:** Prisma, NestJS, React, Vite, TypeScript, Yandex Maps JS API, Node test runner.

---

### Task 1: Persist `mapName`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260529143000_add_object_map_name/migration.sql`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/objects/objects.service.ts`
- Modify: `apps/api/src/map/map.service.ts`
- Test: `apps/api/tests/services.test.cjs`

- [x] **Step 1: Write failing API tests**

Add tests that prove `ObjectsService.update` accepts `mapName`, clears it to `null`, rejects values longer than 16 characters, and that `MapService` serializes `mapName`.

- [x] **Step 2: Run API tests to verify failure**

Run: `pnpm --filter @platforma/api test`

Expected: FAIL because `mapName` is missing from schema/service serialization.

- [x] **Step 3: Add schema, migration, shared types, API parse/update/serialization**

Add `mapName String? @map("map_name") @db.VarChar(16)` to `RealEstateObject`, create the SQL migration, add `mapName` to `RealEstateObjectBase` and `MapObject`, parse it in object create/update, and include it in object/map serializers.

- [x] **Step 4: Run API tests to verify pass**

Run: `pnpm --filter @platforma/api test`

Expected: PASS.

### Task 2: Add Quick Edit Column

**Files:**
- Modify: `apps/web/src/admin/ObjectQuickEditTable.tsx`
- Modify: `apps/web/src/admin/objectQuickEditPersistence.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/tests/admin-object-quick-edit-table.test.mjs`

- [x] **Step 1: Write failing web quick-edit tests**

Update table tests to expect the final `Имя карты` column, `mapName` display/draft values, max length support, and PATCH payload `{ mapName: value | null }`.

- [x] **Step 2: Run web tests to verify failure**

Run: `pnpm --filter @platforma/web test -- admin-object-quick-edit-table.test.mjs`

Expected: FAIL because the quick-edit column and persistence mapping are missing.

- [x] **Step 3: Implement quick-edit column**

Add `mapName` as the last `ObjectQuickEditColumnKey`, include it in text payload columns, display and draft helpers, and add a compact column width.

- [x] **Step 4: Run web quick-edit tests to verify pass**

Run: `pnpm --filter @platforma/web test -- admin-object-quick-edit-table.test.mjs`

Expected: PASS.

### Task 3: Render SVG Dot/Pin Markers

**Files:**
- Create: `apps/web/src/map/mapMarkerLabels.ts`
- Modify: `apps/web/src/map/YandexMap.tsx`
- Modify: `apps/web/src/catalog/CatalogPage.tsx`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/public/map-marker-dot.svg`
- Create: `apps/web/public/map-marker-pin.svg`
- Test: `apps/web/tests/yandex-map-markers.test.mjs`

- [x] **Step 1: Write failing map marker tests**

Add tests for fallback label cleanup, `mapName` usage, dot/pin class structure, `zoom >= 14`, SVG asset references, and pin coordinate offset anchored at the bottom center.

- [x] **Step 2: Run map marker tests to verify failure**

Run: `pnpm --filter @platforma/web test -- yandex-map-markers.test.mjs`

Expected: FAIL because marker label helper and SVG marker template are missing.

- [x] **Step 3: Copy SVG assets into web public assets**

Copy root `Ресурс 4.svg` to `apps/web/public/map-marker-dot.svg` and `Ресурс 5.svg` to `apps/web/public/map-marker-pin.svg`.

- [x] **Step 4: Implement label fallback and marker template**

Create `resolveMapMarkerLabel`, use `object.mapName` or the cleaned first 6 characters from `title`, replace the current pill marker template with dot/pin layers, keep selection/click behavior, and set `iconOffset` to bottom-center anchor values.

- [x] **Step 5: Run map marker tests to verify pass**

Run: `pnpm --filter @platforma/web test -- yandex-map-markers.test.mjs`

Expected: PASS.

### Task 4: Build and Verify

**Files:**
- All files changed in Tasks 1-3

- [x] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @platforma/api test
pnpm --filter @platforma/web test -- admin-object-quick-edit-table.test.mjs
pnpm --filter @platforma/web test -- yandex-map-markers.test.mjs
```

Expected: PASS.

- [x] **Step 2: Run production builds**

Run:

```bash
pnpm build:api
pnpm build:web
```

Expected: PASS.

- [x] **Step 3: Review git diff and commit implementation**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files changed plus user-provided SVG source files if they remain untracked.

Commit implementation files with:

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260529143000_add_object_map_name/migration.sql packages/shared/src/index.ts apps/api/src/objects/objects.service.ts apps/api/src/map/map.service.ts apps/api/tests/services.test.cjs apps/web/src/admin/ObjectQuickEditTable.tsx apps/web/src/admin/objectQuickEditPersistence.ts apps/web/src/catalog/CatalogPage.tsx apps/web/src/map/YandexMap.tsx apps/web/src/map/mapMarkerLabels.ts apps/web/src/styles.css apps/web/tests/admin-object-quick-edit-table.test.mjs apps/web/tests/yandex-map-markers.test.mjs apps/web/public/map-marker-dot.svg apps/web/public/map-marker-pin.svg docs/superpowers/plans/2026-05-29-map-pin-labels-implementation.md
git commit -m "feat: add map pin labels"
```
