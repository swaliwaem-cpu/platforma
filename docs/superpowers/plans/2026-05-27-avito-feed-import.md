# Avito Feed Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Avito XML as the third supported feed format for the unified importer.

**Architecture:** Avito support is added as a new `AVITO_XML` feed format beside Yandex Realty and CIAN XML. The parser normalizes `<Ads><Ad>` records into the existing feed unit model, and analysis groups Avito lots by `NewDevelopmentId` through a dedicated `avitoDevelopmentIds` filter key.

**Tech Stack:** NestJS API, Prisma/Postgres enum migration, React admin UI, `@platforma/feed-import`, Node test runner.

---

### Task 1: Parser And Analysis Contract

**Files:**
- Modify: `tools/feed-import/src/index.ts`
- Modify: `tools/feed-import/tests/parser.test.cjs`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/tests/api-contract.test.cjs`

- [ ] Write failing parser tests for `AvitoXmlFeedParser`: parse `<Ads><Ad>`, normalize studio rooms to `0`, media from `Image@url`, and expose `NewDevelopmentId`.
- [ ] Write failing analysis tests: Avito groups by `NewDevelopmentId` and returns `filterJson: { avitoDevelopmentIds: [...] }`.
- [ ] Add `AVITO_XML` to shared feed format contracts.
- [ ] Implement `AvitoXmlFeedParser`, Avito analysis filter creation, and Avito filter matching helpers.
- [ ] Run `pnpm --filter @platforma/feed-import test` and verify green.

### Task 2: API, Database, And Import Routing

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260527000000_add_avito_feed_format/migration.sql`
- Modify: `apps/api/tests/feed-schema.test.cjs`
- Modify: `apps/api/tests/feeds-module.test.cjs`
- Modify: `tools/feed-import/tests/import-engine.test.cjs`

- [ ] Write failing schema/API tests for `AVITO_XML`.
- [ ] Add Postgres enum migration `ALTER TYPE "feed_format" ADD VALUE 'avito_xml';`.
- [ ] Verify import routing uses `avitoDevelopmentIds` mappings and archives disappeared lots through existing run behavior.
- [ ] Run `pnpm --filter @platforma/api test` and `pnpm --filter @platforma/feed-import test`.

### Task 3: Admin UI Format Support

**Files:**
- Modify: `apps/web/src/admin/FeedsAdminPage.tsx`
- Modify: `apps/web/tests/admin-feeds-page.test.mjs`

- [ ] Write failing UI string tests for `Avito XML` option and Avito analysis fields.
- [ ] Add `AVITO_XML` label and display `avitoDevelopmentIds` in analysis details.
- [ ] Run `pnpm --filter @platforma/web test`.

### Task 4: Verification And Delivery

**Files:**
- All changed files from previous tasks.

- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `git diff --check`.
- [ ] Commit the implementation to `on-ser`.
