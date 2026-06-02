# Feed Discount Lot Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Все активные feed formats должны корректно давать обычную цену, скидочную цену, effective price, срок сдачи, а grouped lot table должна показывать скидочную цену отдельной колонкой и стартовать свернутой.

**Architecture:** Существующие Prisma/shared contracts уже содержат `price`, `discountPrice`, `effectivePrice`, `pricePerMeter`, `discountPricePerMeter`, `effectivePricePerMeter`, `completionYear` и `completionQuarter`, поэтому схема БД не меняется. Правки остаются в parser normalization, object lot API grouping behavior and React lot table rendering.

**Tech Stack:** TypeScript, NestJS, Prisma, React, Vite, Node test runner, pnpm workspace.

---

### Task 1: Feed Parser Regression Tests

**Files:**
- Modify: `tools/feed-import/tests/parser.test.cjs`
- Modify: `tools/feed-import/tests/fixtures/tekta.xml`

- [x] Add failing tests that prove `FSK_XML` separates base price and sale price when both are present.
- [x] Add failing tests that prove `CIAN_XML` can parse discount price and completion fields from known alternative nodes.
- [x] Run `pnpm --filter @platforma/feed-import test -- parser` and confirm the new tests fail for missing behavior.

### Task 2: Feed Parser Implementation

**Files:**
- Modify: `tools/feed-import/src/index.ts`

- [x] Implement minimal FSK discount fallback: base `Price_tot`, discount `Price_tot_sale` when it is lower and positive, effective from discount.
- [x] Implement minimal CIAN discount fallback from common fields without changing existing price behavior.
- [x] Keep Yandex and Tekta behavior stable, covered by tests.
- [x] Run `pnpm --filter @platforma/feed-import test -- parser` and confirm parser tests pass.

### Task 3: Backend Grouping Guard

**Files:**
- Modify: `apps/api/tests/services.test.cjs`
- Modify: `apps/api/src/objects/objects.service.ts` only if RED proves backend change is needed.

- [x] Add/adjust tests proving grouped lot `priceMin`/`priceMax` use `effectivePrice`.
- [x] Run `pnpm --filter @platforma/api test -- services` and confirm current behavior.
- [x] If needed, patch `ObjectsService` minimally and rerun targeted API tests.

### Task 4: Object Detail Lot Table UI

**Files:**
- Modify: `apps/web/tests/object-detail-feed-units.test.mjs`
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`
- Modify: `apps/web/src/styles.css` only if table layout needs width/alignment adjustment.

- [x] Add failing tests for all groups collapsed on load.
- [x] Add failing tests for columns: `Медиа`, `Корпус`, `Секц.`, `Эт.`, `Номер квартиры`, `Площадь`, `Цена`, `Цена со скидкой`, `За м²`, `Статус`.
- [x] Add failing tests that `Цена` uses `unit.price`, `Цена со скидкой` uses `discountPrice ?? price`, and `За м²` uses effective/discounted value.
- [x] Run `pnpm --filter @platforma/web test -- object-detail-feed-units` and confirm failures.
- [x] Patch `ObjectDetailPage.tsx`: remove `setDefaultExpandedLotGroups` auto-open, remove `План`, move `Медиа` first, add `Цена со скидкой`.
- [x] Update `feedUnitsTableColumnCount` from `10` to `10` only if total stays ten after column replacement; otherwise update to actual count.
- [x] Rerun `pnpm --filter @platforma/web test -- object-detail-feed-units`.

### Task 5: Verification And Docs

**Files:**
- Modify: `docs/CODEX_LOG.md`

- [x] Run `pnpm --filter @platforma/feed-import test`.
- [x] Run `pnpm --filter @platforma/api test -- api-contract services`.
- [x] Run `pnpm --filter @platforma/web test -- object-detail-feed-units`.
- [x] Run `pnpm build:web` if UI code changed.
- [x] Append a new `docs/CODEX_LOG.md` entry without removing existing local uncommitted log entries.
- [x] Report exact files, checks, manual QA and production rollout notes.
