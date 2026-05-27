# Unified Feed Index Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement unified feed analysis/import for single XML feeds and live index URLs with one selected platform, existing-developer matching, and editable ЖК mappings.

**Architecture:** Extend the current feed source model with `INDEX_URL`, keeping the selected platform in existing `format`. Add feed-import discovery/detection helpers that can return either index discovery or full analysis, and route `INDEX_URL` preview/run through the same persistence engine after re-reading the index. Keep auto-matching conservative and reversible in the admin UI: suggestions prefill selects, but saving only uses confirmed existing entities.

**Tech Stack:** TypeScript, NestJS, Prisma/Postgres enum migrations, React admin UI, `@platforma/feed-import`, Node test runner, `pnpm`.

---

### Task 1: Shared Contracts And Prisma Source Kind

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260527010000_add_index_feed_source_kind/migration.sql`
- Modify: `apps/api/tests/api-contract.test.cjs`
- Modify: `apps/api/tests/feed-schema.test.cjs`

- [ ] **Step 1: Write failing contract/schema tests**

Add expectations that `FeedSourceKind` includes `INDEX_URL`, `FeedSourceAnalysisResponse` can carry `discovery: FeedIndexDiscovery | null` and `analysis: FeedSourceAnalysis | null`, and Prisma maps `INDEX_URL @map("index_url")`.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
pnpm --filter @platforma/api test
```

Expected: API contract/schema tests fail on missing `INDEX_URL`, discovery types, and migration.

- [ ] **Step 3: Implement contracts and migration**

Update shared `FeedSourceKind`, add `FeedIndexFileCandidate`, `FeedIndexPlatformCandidate`, `FeedIndexDiscovery`, and widen `FeedSourceAnalysisResponse`. Add Prisma enum value and migration:

```sql
ALTER TYPE "feed_source_kind" ADD VALUE 'index_url';
```

- [ ] **Step 4: Run API tests**

Run:

```bash
pnpm --filter @platforma/api test
```

Expected: contract/schema tests pass.

### Task 2: Feed Detection, Index Discovery, And Analysis

**Files:**
- Modify: `tools/feed-import/src/index.ts`
- Modify: `tools/feed-import/tests/parser.test.cjs`
- Modify: `tools/feed-import/tests/import-engine.test.cjs`

- [ ] **Step 1: Write failing feed-import tests**

Add tests for:

- `detectFeedFormatFromXml` returning `YANDEX_REALTY`, `CIAN_XML`, and `AVITO_XML`;
- `discoverFeedIndexLinks` extracting relative and absolute `.xml` links from an index HTML page;
- `analyzeFeedSourceInput({ format: 'AUTO', sourceKind: 'INDEX_URL', url })` returning discovery only;
- `analyzeFeedSourceInput({ format: 'CIAN_XML', sourceKind: 'INDEX_URL', url })` returning merged analysis for only CIAN XML files;
- `executeFeedImport` importing only selected platform files for an `INDEX_URL` source.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
pnpm --filter @platforma/feed-import test
```

Expected: tests fail because helpers, `AUTO`, and `INDEX_URL` are not implemented.

- [ ] **Step 3: Implement feed-import detection and discovery**

Add focused helpers in `tools/feed-import/src/index.ts`:

- `detectFeedFormatFromXml(xml: string): FeedSourceFormat | null`;
- `discoverFeedIndexLinks(html: string, baseUrl: string): string[]`;
- `createFeedIndexDiscovery(params): Promise<FeedIndexDiscovery>`;
- `analyzeFeedSourceInput` support for `format: 'AUTO'` and `sourceKind: 'INDEX_URL'`;
- CLI args `--source-kind INDEX_URL` and `--format AUTO`.

- [ ] **Step 4: Implement INDEX_URL import path**

In `executeFeedImport`, replace direct single-XML parsing with `parseFeedSource(source, options)`. For `INDEX_URL`, re-read the index, keep only XML files with `source.format`, parse them, namespace `externalId` with a stable XML URL hash, and merge warnings.

- [ ] **Step 5: Run feed-import tests**

Run:

```bash
pnpm --filter @platforma/feed-import test
```

Expected: feed-import tests pass.

### Task 3: API Analyze And Source Validation

**Files:**
- Modify: `apps/api/src/feeds/feeds.service.ts`
- Modify: `apps/api/tests/feeds-module.test.cjs`

- [ ] **Step 1: Write failing API service tests**

Add tests that:

- `analyzeSource` accepts `sourceKind=INDEX_URL` and `format=AUTO`, returning `{ discovery, analysis: null }`;
- selected index platform analysis returns `{ discovery: null, analysis }`;
- `createSource` accepts `INDEX_URL` with URL and concrete format;
- `createSource` rejects persisted `format=AUTO`.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
pnpm --filter @platforma/api test
```

Expected: feeds module tests fail on `INDEX_URL`/`AUTO` handling.

- [ ] **Step 3: Implement API support**

Update `parseFormat` usage so persisted sources require a real `FeedFormat`, while analyze allows `AUTO`. Treat `INDEX_URL` as URL-backed in create/update/analyze. Pass `--source-kind` and `--format` through `runFeedAnalyzeCli`, and parse CLI output as the full `{ discovery, analysis }` response.

- [ ] **Step 4: Run API tests**

Run:

```bash
pnpm --filter @platforma/api test
```

Expected: API tests pass.

### Task 4: Admin Wizard And Conservative Auto-Mapping

**Files:**
- Modify: `apps/web/src/admin/FeedsAdminPage.tsx`
- Modify: `apps/web/tests/admin-feeds-page.test.mjs`

- [ ] **Step 1: Write failing web tests**

Add tests for:

- source kind option `Индекс XML`;
- format option `Авто`;
- platform discovery rendering and platform selection handler;
- source save refusing `AUTO`;
- conservative matching helpers: developer preselection, object suggestion by normalized title, unmatched rows staying excluded.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
pnpm --filter @platforma/web test
```

Expected: web tests fail on missing UI and helpers.

- [ ] **Step 3: Implement admin flow**

Extend form state with `format: FeedFormat | 'AUTO'` for UI only and add `sourceDiscovery` state. Add `INDEX_URL` source-kind radio. Initial analyze with index and `AUTO` shows platform candidates; selecting one platform sets concrete `format` and re-runs analysis. Create local matching helpers that normalize names, preselect a developer when one clear existing match exists, and preselect ЖК only for high-confidence matches under that developer.

- [ ] **Step 4: Run web tests**

Run:

```bash
pnpm --filter @platforma/web test
```

Expected: web tests pass.

### Task 5: Full Verification And Commit

**Files:**
- All files changed in previous tasks.

- [ ] **Step 1: Run full tests**

Run:

```bash
pnpm test
```

Expected: all workspace tests pass.

- [ ] **Step 2: Run build**

Run:

```bash
pnpm build
```

Expected: all workspace builds pass.

- [ ] **Step 3: Run diff check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 4: Commit implementation**

Run:

```bash
git add apps/api apps/web packages/shared tools/feed-import docs/superpowers/plans/2026-05-27-unified-feed-index-import-implementation.md
git commit -m "feat: add unified feed index import"
```

Expected: implementation committed on `on-ser`.

