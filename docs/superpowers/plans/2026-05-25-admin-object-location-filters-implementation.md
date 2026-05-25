# Admin Object Location Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add expandable admin object list filters for district, area, and metro text search.

**Architecture:** Extend `/objects` with text query params `districtSearch`, `areaSearch`, and `metroSearch`. Reuse the existing unified search variants through API helper filters. Add a compact `+ Фильтры` panel in `ObjectsAdminPage` without changing the quick edit table layout.

**Tech Stack:** NestJS, Prisma, React, TypeScript, node:test.

---

### Task 1: Backend Text Filters

**Files:**
- Modify: `apps/api/src/objects/objects.service.ts`
- Test: `apps/api/tests/services.test.cjs`

- [x] Write failing tests for `districtSearch`, `areaSearch`, and `metroSearch`.
- [x] Run `pnpm --filter @platforma/api test` and confirm the new tests fail.
- [x] Implement filters using unified search variants.
- [x] Run `pnpm --filter @platforma/api test` and confirm tests pass.

### Task 2: Frontend Expandable Filters

**Files:**
- Modify: `apps/web/src/admin/ObjectsAdminPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/tests/admin-object-quick-edit-table.test.mjs`

- [x] Write failing source tests for `+ Фильтры`, filter fields, API params, reset, and active state.
- [x] Run `pnpm --filter @platforma/web test` and confirm the new tests fail.
- [x] Add state and UI for `Районы`, `Окружение`, and `Метро`.
- [x] Run `pnpm --filter @platforma/web test` and confirm tests pass.

### Task 3: Verification

**Files:**
- Verify changed workspace files.

- [x] Run `pnpm --filter @platforma/api test`.
- [x] Run `pnpm --filter @platforma/web test`.
- [x] Run `pnpm build:api`.
- [x] Run `pnpm build:web`.
- [x] Verify `http://localhost:5173/` renders without page errors.
