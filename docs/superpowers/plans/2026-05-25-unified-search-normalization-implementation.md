# Unified Search Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every free-text search understand transliteration and wrong keyboard layout input with one shared normalization helper.

**Architecture:** Add shared normalization helpers in `packages/shared` and consume them from API services and frontend quick edit. Keep existing endpoints, query params, UI, and database schema unchanged.

**Tech Stack:** TypeScript, NestJS, Prisma, React, node:test, pnpm workspaces.

---

### Task 1: Shared Search Helper

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `apps/web/tests/admin-object-quick-edit-table.test.mjs`

- [ ] **Step 1: Write failing helper assertions**

Add assertions that `createSearchVariants('Shagal')` includes `шагал`, `createSearchVariants('Ifufk')` includes `шагал`, and `matchesSearchVariants('Ifufk', ['Шагал'])` returns true.

- [ ] **Step 2: Run web tests and verify RED**

Run: `pnpm --filter @platforma/web test`

Expected: FAIL because shared helper exports do not exist yet.

- [ ] **Step 3: Implement shared helper**

Add `normalizeSearchText`, `createSearchVariants`, and `matchesSearchVariants` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run web tests and verify GREEN for helper consumers**

Run: `pnpm --filter @platforma/web test`

Expected: PASS after quick edit imports and uses the helper.

### Task 2: Catalog And Map Search

**Files:**
- Modify: `apps/api/src/objects/object-search.ts`
- Test: `apps/api/tests/services.test.cjs`

- [ ] **Step 1: Write failing API assertions**

Extend existing catalog and map search tests to expect multiple LIKE patterns including `%shagal%` and `%шагал%` for `Shagal` and `Ifufk`.

- [ ] **Step 2: Run API tests and verify RED**

Run: `pnpm --filter @platforma/api test`

Expected: FAIL because raw SQL search currently receives only one pattern.

- [ ] **Step 3: Use shared variants in raw SQL**

Update `findCatalogSearchObjectIds` to build pattern arrays from `createSearchVariants` and compare fields with `LIKE ANY`.

- [ ] **Step 4: Run API tests and verify GREEN**

Run: `pnpm --filter @platforma/api test`

Expected: PASS.

### Task 3: Prisma Search Filters

**Files:**
- Modify: `apps/api/src/directories/directories.service.ts`
- Modify: `apps/api/src/users/users.service.ts`
- Modify: `apps/api/src/objects/objects.service.ts`
- Modify: `apps/api/src/feeds/feeds.service.ts`
- Test: `apps/api/tests/services.test.cjs`
- Test: `apps/api/tests/feeds-module.test.cjs`

- [ ] **Step 1: Write failing Prisma search assertions**

Add tests showing directory, user, object feed-unit, and feed unit searches build OR filters for normalized variants.

- [ ] **Step 2: Run API tests and verify RED**

Run: `pnpm --filter @platforma/api test`

Expected: FAIL because services currently search only the trimmed original term.

- [ ] **Step 3: Implement shared Prisma filter helpers locally**

Use `createSearchVariants` in each service to expand `contains` OR filters across the existing fields.

- [ ] **Step 4: Run API tests and verify GREEN**

Run: `pnpm --filter @platforma/api test`

Expected: PASS.

### Task 4: Final Verification

**Files:**
- Verify: changed workspace files

- [ ] **Step 1: Run focused tests**

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
git diff -- packages/shared/src/index.ts apps/api/src/objects/object-search.ts apps/api/src/directories/directories.service.ts apps/api/src/users/users.service.ts apps/api/src/objects/objects.service.ts apps/api/src/feeds/feeds.service.ts apps/web/src/admin/objectQuickEditTransforms.ts
```
