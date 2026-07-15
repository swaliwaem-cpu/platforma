# Commercial WordPress Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import local WordPress `commercials` posts as commercial `RealEstateObject` records while leaving existing residential objects residential.

**Architecture:** Add object-level `RealEstateObjectType` to Prisma/shared/API, defaulting existing records to `RESIDENTIAL`. Add WordPress import profiles so the current residential import remains the default and a new `commercial` profile uses `postType=commercials`, taxonomies `commercial/custom_tag-three`, object type `COMMERCIAL`, commercial permalink prefix, and no PDF import.

**Tech Stack:** Prisma, NestJS service serializers, shared TypeScript contracts, Node WordPress import CLI, node:test.

---

### Task 1: Object Type Contract

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260710120000_add_real_estate_object_type/migration.sql`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/objects/objects.service.ts`
- Test: `apps/api/tests/api-contract.test.cjs`
- Test: `apps/api/tests/services.test.cjs`

- [ ] Write failing tests that require `RealEstateObject.type` in schema/shared serialization and default existing objects to `RESIDENTIAL`.
- [ ] Add Prisma enum `RealEstateObjectType` with `RESIDENTIAL` and `COMMERCIAL`.
- [ ] Add non-null `real_estate_objects.type` with DB default `residential` and an index.
- [ ] Add `RealEstateObjectType` to shared contracts and serialize it in object/map responses.
- [ ] Run targeted API contract/service tests.

### Task 2: Admin/API Object Type Flow

**Files:**
- Modify: `apps/api/src/objects/objects.service.ts`
- Modify: `apps/web/src/admin/ObjectsAdminPage.tsx`
- Modify: related web tests if existing contract snapshots require it

- [ ] Write failing service tests for create/update payload accepting `type`.
- [ ] Allow admin create/update to persist `RESIDENTIAL`/`COMMERCIAL`.
- [ ] Add minimal admin form control for object type, defaulting to `RESIDENTIAL`.
- [ ] Preserve existing objects as residential unless changed.

### Task 3: WordPress Import Profiles

**Files:**
- Create: `tools/wp-import/src/profiles.ts`
- Modify: `tools/wp-import/src/env.ts`
- Modify: `tools/wp-import/src/wordpress-client.ts`
- Modify: `tools/wp-import/src/mapper.ts`
- Modify: `tools/wp-import/src/types.ts`
- Modify: `tools/wp-import/src/importer.ts`
- Test: `tools/wp-import/tests/mapper.test.cjs`
- Test: `tools/wp-import/tests/wordpress-client-source.test.cjs`
- Test: `tools/wp-import/tests/importer-archive-source.test.cjs`

- [ ] Write failing tests for `WP_IMPORT_PROFILE=commercial`.
- [ ] Add `residential` and `commercial` profiles.
- [ ] Use profile taxonomies instead of hardcoded `nedvizhimost/custom_tag-two`.
- [ ] Map commercial objects to `RealEstateObjectType.COMMERCIAL`.
- [ ] Store commercial `sourceUrl` as `/commercial/<slug>/`.
- [ ] Disable PDF/file imports for the commercial profile.
- [ ] Preserve residential import behavior as the default.

### Task 4: Archive Isolation

**Files:**
- Modify: `tools/wp-import/src/wordpress-client.ts`
- Modify: `tools/wp-import/src/types.ts`
- Modify: `tools/wp-import/src/importer.ts`
- Test: `tools/wp-import/tests/importer-archive-source.test.cjs`

- [ ] Write failing tests showing commercial full run does not archive residential imported objects.
- [ ] Add current-profile source scope to mapped import data.
- [ ] Restrict archive queries to records imported by the same object type/profile.
- [ ] Run WP import tests.

### Task 5: Local Preview/Verification

**Files:**
- Modify: `.env.example`
- Modify: `tools/wp-import/.env.example`
- Modify: `docs/CODEX_LOG.md`

- [ ] Document `WP_IMPORT_PROFILE`.
- [ ] Run `pnpm --filter @platforma/wp-import test`.
- [ ] Run relevant API/web tests touched by object type.
- [ ] Run commercial preview with Local WP env and `WP_IMPORT_LIMIT=5`.
- [ ] Update `docs/CODEX_LOG.md`.
