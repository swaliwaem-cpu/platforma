# Lot Presentation Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent per-user `В работе` workspace for lot PDF presentations, with compact lot tiles, contextual comments, and direct add-to-workspace actions from object pages.

**Architecture:** Store workspace items as first-class Prisma rows keyed by `(userId, unitId)`, and store collection comments on `LotPresentationCollectionItem`. Reuse the existing `LotPresentationsService` lot serializer and PDF `unitIds` generation path, while splitting frontend behavior into workspace actions, reusable lot tile UI, and collection picker/comment modals.

**Tech Stack:** NestJS 11, Prisma 6, React 19, TypeScript, Vite, existing `node:test` regression style, existing CSS in `apps/web/src/styles.css`, no new dependencies.

---

## File Structure

- Modify `apps/api/prisma/schema.prisma`: add `LotPresentationWorkspaceItem`, relations on `User` and `FeedUnit`, and `comment` on `LotPresentationCollectionItem`.
- Create `apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql`: add table, indexes, relation constraints, and collection item comment column.
- Modify `packages/shared/src/index.ts`: add workspace/comment contracts and collection item comment field.
- Modify `apps/api/src/lot-presentations/lot-presentations.controller.ts`: add workspace routes and item comment route for collections.
- Modify `apps/api/src/lot-presentations/lot-presentations.service.ts`: implement workspace CRUD, comment validation, collection item comment update, and serializers.
- Modify `apps/api/tests/lot-presentations-schema.test.cjs`: add schema, migration, shared and route regressions.
- Modify `apps/web/src/presentations/LotCollectionAction.tsx`: replace object-page behavior with direct workspace add action.
- Modify `apps/web/src/presentations/LotPresentationsPage.tsx`: add tabs, workspace loading/actions, compact lot tile grid, comment modal, collection picker from workspace, collection grid view.
- Modify `apps/web/src/objects/ObjectDetailPage.tsx`: keep using the action component but update import/component expectations.
- Modify `apps/web/src/styles.css`: replace list-row presentation styles with compact tile/grid styles and tab/comment/picker styles.
- Modify `apps/web/tests/lot-presentations-page.test.mjs`: update source-level frontend regressions.
- Modify `apps/web/tests/object-detail-feed-units.test.mjs`: update table action assertion.
- Modify `docs/CODEX_LOG.md`: record implementation and checks after code work.

---

## Task 1: Prisma And Shared Contracts

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/tests/lot-presentations-schema.test.cjs`

- [ ] **Step 1: Write failing schema and contract tests**

Add these assertions to `apps/api/tests/lot-presentations-schema.test.cjs`.

```js
const workspaceMigrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql',
);

test('Prisma schema defines lot presentation workspace items and item comments', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /lotPresentationWorkspaceItems\s+LotPresentationWorkspaceItem\[\]/);
  assert.match(schema, /comment\s+String\?\s+@db\.VarChar\(1000\)/);
  assert.match(schema, /model LotPresentationWorkspaceItem \{[\s\S]*userId\s+String\s+@map\("user_id"\)\s+@db\.Uuid[\s\S]*unitId\s+String\s+@map\("unit_id"\)\s+@db\.Uuid[\s\S]*comment\s+String\?\s+@db\.VarChar\(1000\)[\s\S]*@@unique\(\[userId, unitId\]\)[\s\S]*@@index\(\[userId, sortOrder\]\)[\s\S]*@@map\("lot_presentation_workspace_items"\)[\s\S]*\}/);
});

test('lot presentation workspace migration creates workspace table and collection comments', () => {
  const migration = readProjectFile(workspaceMigrationPath);

  assert.match(migration, /ALTER TABLE "lot_presentation_collection_items" ADD COLUMN "comment" VARCHAR\(1000\)/);
  assert.match(migration, /CREATE TABLE "lot_presentation_workspace_items"/);
  assert.match(migration, /CREATE UNIQUE INDEX "lot_presentation_workspace_items_user_id_unit_id_key"/);
  assert.match(migration, /CREATE INDEX "lot_presentation_workspace_items_user_id_sort_order_idx"/);
  assert.match(migration, /FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.match(migration, /FOREIGN KEY \("unit_id"\) REFERENCES "feed_units"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
});

test('shared package exports lot presentation workspace and comment contracts', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type LotPresentationCollectionItem = \{[\s\S]*comment: string \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type LotPresentationWorkspaceItem = \{[\s\S]*unitId: string;[\s\S]*comment: string \| null;[\s\S]*unit: LotPresentationLot;[\s\S]*\};/);
  assert.match(sharedTypes, /export type LotPresentationWorkspaceResponse = \{[\s\S]*items: LotPresentationWorkspaceItem\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type UpdateLotPresentationItemCommentInput = \{[\s\S]*comment: string \| null;[\s\S]*\};/);
});
```

- [ ] **Step 2: Run targeted API schema test and verify it fails**

Run:

```bash
node --test apps/api/tests/lot-presentations-schema.test.cjs
```

Expected: FAIL because `LotPresentationWorkspaceItem`, migration file, and shared workspace types do not exist yet.

- [ ] **Step 3: Update Prisma schema**

Patch `apps/api/prisma/schema.prisma`.

```prisma
model User {
  // keep existing fields
  lotPresentationCollections    LotPresentationCollection[]
  lotPresentationDocuments      LotPresentationDocument[]
  lotPresentationWorkspaceItems LotPresentationWorkspaceItem[]
}

model FeedUnit {
  // keep existing fields
  lotPresentationItems          LotPresentationCollectionItem[]
  lotPresentationWorkspaceItems LotPresentationWorkspaceItem[]
  lotPresentationDocumentItems  LotPresentationDocumentItem[]
}

model LotPresentationCollectionItem {
  id           String   @id @default(uuid()) @db.Uuid
  collectionId String   @map("collection_id") @db.Uuid
  unitId       String   @map("unit_id") @db.Uuid
  sortOrder    Int      @default(0) @map("sort_order")
  comment      String?  @db.VarChar(1000)
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  collection LotPresentationCollection @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  unit       FeedUnit                  @relation(fields: [unitId], references: [id], onDelete: Cascade)

  @@unique([collectionId, unitId])
  @@index([collectionId, sortOrder])
  @@index([unitId])
  @@map("lot_presentation_collection_items")
}

model LotPresentationWorkspaceItem {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  unitId    String   @map("unit_id") @db.Uuid
  sortOrder Int      @default(0) @map("sort_order")
  comment   String?  @db.VarChar(1000)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  user User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  unit FeedUnit @relation(fields: [unitId], references: [id], onDelete: Cascade)

  @@unique([userId, unitId])
  @@index([userId, sortOrder])
  @@index([unitId])
  @@map("lot_presentation_workspace_items")
}
```

- [ ] **Step 4: Add migration SQL**

Create `apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql`.

```sql
ALTER TABLE "lot_presentation_collection_items"
  ADD COLUMN "comment" VARCHAR(1000);

CREATE TABLE "lot_presentation_workspace_items" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "comment" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "lot_presentation_workspace_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lot_presentation_workspace_items_user_id_unit_id_key"
  ON "lot_presentation_workspace_items"("user_id", "unit_id");

CREATE INDEX "lot_presentation_workspace_items_user_id_sort_order_idx"
  ON "lot_presentation_workspace_items"("user_id", "sort_order");

CREATE INDEX "lot_presentation_workspace_items_unit_id_idx"
  ON "lot_presentation_workspace_items"("unit_id");

ALTER TABLE "lot_presentation_workspace_items"
  ADD CONSTRAINT "lot_presentation_workspace_items_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_workspace_items"
  ADD CONSTRAINT "lot_presentation_workspace_items_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "feed_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Update shared types**

Patch `packages/shared/src/index.ts`.

```ts
export type LotPresentationCollectionItem = {
  id: string;
  collectionId: string;
  unitId: string;
  sortOrder: number;
  comment: string | null;
  unit: LotPresentationLot;
  createdAt: string;
  updatedAt: string;
};

export type LotPresentationWorkspaceItem = {
  id: string;
  userId: string;
  unitId: string;
  sortOrder: number;
  comment: string | null;
  unit: LotPresentationLot;
  createdAt: string;
  updatedAt: string;
};

export type LotPresentationWorkspaceResponse = {
  items: LotPresentationWorkspaceItem[];
};

export type UpdateLotPresentationItemCommentInput = {
  comment: string | null;
};
```

- [ ] **Step 6: Run targeted test and Prisma generate**

Run:

```bash
node --test apps/api/tests/lot-presentations-schema.test.cjs
pnpm --filter @platforma/api prisma:generate
```

Expected: targeted test PASS; Prisma generate completes without schema errors.

- [ ] **Step 7: Commit data contracts**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql packages/shared/src/index.ts apps/api/tests/lot-presentations-schema.test.cjs
git commit -m "feat(api): add lot presentation workspace schema"
```

---

## Task 2: Backend Workspace And Comment API

**Files:**
- Modify: `apps/api/src/lot-presentations/lot-presentations.controller.ts`
- Modify: `apps/api/src/lot-presentations/lot-presentations.service.ts`
- Modify: `apps/api/tests/lot-presentations-schema.test.cjs`

- [ ] **Step 1: Write failing route and service source tests**

Add these assertions to `apps/api/tests/lot-presentations-schema.test.cjs`.

```js
test('lot presentation API exposes workspace and item comment routes', () => {
  const controller = readProjectFile(controllerPath);
  const service = readProjectFile(servicePath);

  assert.match(controller, /@Get\('workspace'\)[\s\S]*getWorkspace/);
  assert.match(controller, /@Post\('workspace\/items'\)[\s\S]*addWorkspaceItem/);
  assert.match(controller, /@Delete\('workspace\/items'\)[\s\S]*clearWorkspace/);
  assert.match(controller, /@Delete\('workspace\/items\/:unitId'\)[\s\S]*removeWorkspaceItem/);
  assert.match(controller, /@Patch\('workspace\/items\/:unitId'\)[\s\S]*updateWorkspaceItemComment/);
  assert.match(controller, /@Patch\('collections\/:collectionId\/items\/:unitId'\)[\s\S]*updateCollectionItemComment/);
  assert.match(service, /async getWorkspace\(actor: AuthenticatedUser\)/);
  assert.match(service, /async addWorkspaceItem\(body: Record<string, unknown>, actor: AuthenticatedUser\)/);
  assert.match(service, /async clearWorkspace\(actor: AuthenticatedUser\)/);
  assert.match(service, /async updateWorkspaceItemComment\(unitId: string, body: Record<string, unknown>, actor: AuthenticatedUser\)/);
  assert.match(service, /async updateCollectionItemComment\(collectionId: string, unitId: string, body: Record<string, unknown>, actor: AuthenticatedUser\)/);
  assert.match(service, /parseOptionalComment\(body\.comment\)/);
  assert.match(service, /Comment is too long/);
});
```

- [ ] **Step 2: Run targeted test and verify it fails**

Run:

```bash
node --test apps/api/tests/lot-presentations-schema.test.cjs
```

Expected: FAIL because workspace controller/service methods do not exist.

- [ ] **Step 3: Add controller routes**

Patch `apps/api/src/lot-presentations/lot-presentations.controller.ts`.

```ts
  @Get('workspace')
  async getWorkspace(@CurrentUser() actor: AuthenticatedUser) {
    return this.lotPresentationsService.getWorkspace(actor);
  }

  @Post('workspace/items')
  async addWorkspaceItem(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.addWorkspaceItem(body, actor);
  }

  @Delete('workspace/items')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearWorkspace(@CurrentUser() actor: AuthenticatedUser) {
    await this.lotPresentationsService.clearWorkspace(actor);
  }

  @Delete('workspace/items/:unitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeWorkspaceItem(
    @Param('unitId') unitId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.lotPresentationsService.removeWorkspaceItem(unitId, actor);
  }

  @Patch('workspace/items/:unitId')
  async updateWorkspaceItemComment(
    @Param('unitId') unitId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.updateWorkspaceItemComment(unitId, body, actor);
  }

  @Patch('collections/:collectionId/items/:unitId')
  async updateCollectionItemComment(
    @Param('collectionId') collectionId: string,
    @Param('unitId') unitId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.updateCollectionItemComment(collectionId, unitId, body, actor);
  }
```

Place the collection item `@Patch` route before `@Delete('collections/:collectionId/items/:unitId')` so route intent remains clear.

- [ ] **Step 4: Extend includes and record types in service**

Patch `apps/api/src/lot-presentations/lot-presentations.service.ts`.

```ts
const workspaceInclude = {
  unit: {
    include: presentationLotInclude,
  },
} satisfies Prisma.LotPresentationWorkspaceItemInclude;

type PresentationWorkspaceItemRecord = Prisma.LotPresentationWorkspaceItemGetPayload<{
  include: typeof workspaceInclude;
}>;
```

- [ ] **Step 5: Implement workspace methods**

Add methods inside `LotPresentationsService`.

```ts
  async getWorkspace(actor: AuthenticatedUser) {
    const items = await this.prisma.lotPresentationWorkspaceItem.findMany({
      where: {
        userId: actor.id,
      },
      include: workspaceInclude,
      orderBy: [
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
      ],
    });
    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId(items.map((item) => item.unitId), actor.id);

    return {
      items: items.map((item) => this.serializeWorkspaceItem(item, collectionIdsByUnitId.get(item.unitId) ?? [])),
    };
  }

  async addWorkspaceItem(body: Record<string, unknown>, actor: AuthenticatedUser) {
    const unitId = this.parseUuid(this.parseRequiredString(body.unitId, 'Lot is required'), 'Lot is invalid');

    await this.ensurePresentationUnitExists(unitId);

    const currentMaxOrder = await this.prisma.lotPresentationWorkspaceItem.aggregate({
      where: {
        userId: actor.id,
      },
      _max: {
        sortOrder: true,
      },
    });

    await this.prisma.lotPresentationWorkspaceItem.upsert({
      where: {
        userId_unitId: {
          userId: actor.id,
          unitId,
        },
      },
      update: {},
      create: {
        userId: actor.id,
        unitId,
        sortOrder: (currentMaxOrder._max.sortOrder ?? -1) + 1,
      },
    });

    return this.getWorkspace(actor);
  }

  async removeWorkspaceItem(unitId: string, actor: AuthenticatedUser) {
    const normalizedUnitId = this.parseUuid(unitId, 'Lot is invalid');

    await this.prisma.lotPresentationWorkspaceItem.deleteMany({
      where: {
        userId: actor.id,
        unitId: normalizedUnitId,
      },
    });
  }

  async clearWorkspace(actor: AuthenticatedUser) {
    await this.prisma.lotPresentationWorkspaceItem.deleteMany({
      where: {
        userId: actor.id,
      },
    });
  }

  async updateWorkspaceItemComment(unitId: string, body: Record<string, unknown>, actor: AuthenticatedUser) {
    const normalizedUnitId = this.parseUuid(unitId, 'Lot is invalid');
    const comment = this.parseOptionalComment(body.comment);

    const updatedItem = await this.prisma.lotPresentationWorkspaceItem.update({
      where: {
        userId_unitId: {
          userId: actor.id,
          unitId: normalizedUnitId,
        },
      },
      data: {
        comment,
      },
      include: workspaceInclude,
    });
    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId([updatedItem.unitId], actor.id);

    return {
      item: this.serializeWorkspaceItem(updatedItem, collectionIdsByUnitId.get(updatedItem.unitId) ?? []),
    };
  }
```

- [ ] **Step 6: Implement collection item comment update**

Add this service method.

```ts
  async updateCollectionItemComment(
    collectionId: string,
    unitId: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
  ) {
    const collection = await this.findCollectionForActor(collectionId, actor.id);
    const normalizedUnitId = this.parseUuid(unitId, 'Lot is invalid');
    const comment = this.parseOptionalComment(body.comment);

    await this.prisma.lotPresentationCollectionItem.update({
      where: {
        collectionId_unitId: {
          collectionId: collection.id,
          unitId: normalizedUnitId,
        },
      },
      data: {
        comment,
      },
    });

    return this.getCollectionResponse(collection.id, actor.id, normalizedUnitId);
  }
```

- [ ] **Step 7: Add serializers and comment parser**

Patch serializer code in `LotPresentationsService`.

```ts
  private serializeWorkspaceItem(item: PresentationWorkspaceItemRecord, collectionIds: string[]) {
    return {
      id: item.id,
      userId: item.userId,
      unitId: item.unitId,
      sortOrder: item.sortOrder,
      comment: item.comment,
      unit: this.serializeLot(item.unit, collectionIds),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }
```

Add `comment: item.comment` to the collection item serializer.

```ts
items: collection.items.map((item) => ({
  id: item.id,
  collectionId: item.collectionId,
  unitId: item.unitId,
  sortOrder: item.sortOrder,
  comment: item.comment,
  unit: this.serializeLot(item.unit, collectionIdsByUnitId.get(item.unitId) ?? []),
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
})),
```

Add parser near `parseOptionalDocumentTitle`.

```ts
  private parseOptionalComment(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Comment is invalid');
    }

    const comment = value.trim();

    if (!comment) {
      return null;
    }

    if (comment.length > 1000) {
      throw new BadRequestException('Comment is too long');
    }

    return comment;
  }
```

- [ ] **Step 8: Run backend checks**

Run:

```bash
node --test apps/api/tests/lot-presentations-schema.test.cjs
pnpm --filter @platforma/api build
```

Expected: targeted test PASS and API TypeScript build PASS.

- [ ] **Step 9: Commit backend API**

```bash
git add apps/api/src/lot-presentations/lot-presentations.controller.ts apps/api/src/lot-presentations/lot-presentations.service.ts apps/api/tests/lot-presentations-schema.test.cjs
git commit -m "feat(api): add lot presentation workspace endpoints"
```

---

## Task 3: Object Page Workspace Action

**Files:**
- Modify: `apps/web/src/presentations/LotCollectionAction.tsx`
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`
- Modify: `apps/web/tests/lot-presentations-page.test.mjs`
- Modify: `apps/web/tests/object-detail-feed-units.test.mjs`

- [ ] **Step 1: Write failing frontend action tests**

In `apps/web/tests/lot-presentations-page.test.mjs`, rename `actionSource` meaning in assertions and replace collection-action tests with workspace action expectations.

```js
test('lot workspace action adds lots directly to the saved workspace', () => {
  assert.match(actionSource, /export function LotCollectionAction/);
  assert.match(actionSource, /\/lot-presentations\/workspace\/items/);
  assert.match(actionSource, /body: JSON\.stringify\(\{ unitId \}\)/);
  assert.match(actionSource, /navigate\('\/presentations'\)/);
  assert.match(actionSource, /aria-label=\{isAdded \? 'Перейти в работу' : 'Добавить в работу'\}/);
  assert.match(actionSource, /isAdded \? \([\s\S]*'В работе'[\s\S]*\) : \([\s\S]*'Добавить в работу'[\s\S]*\)/);
  assert.doesNotMatch(actionSource, /\/lot-presentations\/collections\?unitId=/);
  assert.doesNotMatch(actionSource, /lot-collection-modal/);
  assert.doesNotMatch(actionSource, /Создать и добавить/);
});
```

In `apps/web/tests/object-detail-feed-units.test.mjs`, update assertion text.

```js
assert.match(objectFeedUnitRowSource, /<LotCollectionAction mode="icon" navigate=\{navigate\} unitId=\{unit\.id\} \/>/);
assert.match(objectFeedUnitsSectionSource, /<TableHead aria-label="В работе" \/>/);
```

- [ ] **Step 2: Run targeted web tests and verify they fail**

Run:

```bash
node --test apps/web/tests/lot-presentations-page.test.mjs apps/web/tests/object-detail-feed-units.test.mjs
```

Expected: FAIL because `LotCollectionAction` still uses collection picker endpoints.

- [ ] **Step 3: Replace action implementation**

Patch `apps/web/src/presentations/LotCollectionAction.tsx` to direct workspace add. Keep the component export name for smaller import churn.

```tsx
import { useEffect, useState } from 'react';
import { CheckIcon, FolderPlusIcon } from 'lucide-react';
import type { LotPresentationWorkspaceResponse } from '@platforma/shared';

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';

type LotCollectionActionProps = {
  unitId: string;
  navigate: (nextPathname: string) => void;
  mode?: 'button' | 'icon';
  loadStateOnMount?: boolean;
  onChanged?: () => void;
};

export function LotCollectionAction({
  unitId,
  navigate,
  mode = 'button',
  loadStateOnMount = false,
  onChanged,
}: LotCollectionActionProps) {
  const { accessToken } = useAuth();
  const [isAdded, setIsAdded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loadStateOnMount || !accessToken) {
      return;
    }

    void loadWorkspaceState();
  }, [accessToken, loadStateOnMount, unitId]);

  async function loadWorkspaceState() {
    if (!accessToken) {
      return;
    }

    try {
      const data = await apiRequest<LotPresentationWorkspaceResponse>('/lot-presentations/workspace', accessToken);
      setIsAdded(data.items.some((item) => item.unitId === unitId));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось проверить лот');
    }
  }

  async function addToWorkspace() {
    if (!accessToken || isSubmitting) {
      return;
    }

    if (isAdded) {
      navigate('/presentations');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest<LotPresentationWorkspaceResponse>('/lot-presentations/workspace/items', accessToken, {
        method: 'POST',
        body: JSON.stringify({ unitId }),
      });
      setIsAdded(true);
      onChanged?.();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось добавить лот в работу');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <span className="lot-workspace-action">
      <button
        className={
          mode === 'icon'
            ? `lot-collection-icon-button${isAdded ? ' lot-collection-icon-button--added' : ''}`
            : isAdded
              ? 'secondary-button secondary-button--fit'
              : 'primary-button primary-button--fit'
        }
        disabled={isSubmitting}
        type="button"
        aria-label={isAdded ? 'Перейти в работу' : 'Добавить в работу'}
        title={isAdded ? 'Перейти в работу' : 'Добавить в работу'}
        onClick={(event) => {
          event.stopPropagation();
          void addToWorkspace();
        }}
      >
        {mode === 'icon' ? (
          isAdded ? <CheckIcon aria-hidden="true" /> : <FolderPlusIcon aria-hidden="true" />
        ) : isAdded ? (
          'В работе'
        ) : (
          'Добавить в работу'
        )}
      </button>
      {error ? <span className="lot-workspace-action-error">{error}</span> : null}
    </span>
  );
}
```

- [ ] **Step 4: Update table heading**

Patch `apps/web/src/objects/ObjectDetailPage.tsx`.

```tsx
<TableHead aria-label="В работе" />
```

- [ ] **Step 5: Run targeted web tests**

Run:

```bash
node --test apps/web/tests/lot-presentations-page.test.mjs apps/web/tests/object-detail-feed-units.test.mjs
```

Expected: tests pass for direct workspace action and object table heading.

- [ ] **Step 6: Commit object action**

```bash
git add apps/web/src/presentations/LotCollectionAction.tsx apps/web/src/objects/ObjectDetailPage.tsx apps/web/tests/lot-presentations-page.test.mjs apps/web/tests/object-detail-feed-units.test.mjs
git commit -m "feat(web): add direct lot workspace action"
```

---

## Task 4: Presentation Page Workspace UI

**Files:**
- Modify: `apps/web/src/presentations/LotPresentationsPage.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/lot-presentations-page.test.mjs`

- [ ] **Step 1: Write failing page layout tests**

Add these tests to `apps/web/tests/lot-presentations-page.test.mjs`.

```js
test('lot presentations page has workspace and collection tabs with compact lot tiles', () => {
  assert.match(pageSource, /const \[activeTab,\s*setActiveTab\] = useState<'workspace' \| 'collections'>\('workspace'\);/);
  assert.match(pageSource, /apiRequest<LotPresentationWorkspaceResponse>\('\/lot-presentations\/workspace'/);
  assert.match(pageSource, /В работе/);
  assert.match(pageSource, /Мои подборки/);
  assert.match(pageSource, /className="lot-presentations-grid"/);
  assert.match(pageSource, /function LotPresentationLotTile/);
  assert.match(pageSource, /onDownloadOne/);
  assert.match(pageSource, /onOpenCollectionPicker/);
  assert.match(pageSource, /onOpenComment/);
  assert.match(pageSource, /onRemove/);
  assert.match(styles, /\.lot-presentations-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.lot-presentations-lot-tile\s*\{/);
  assert.match(styles, /\.lot-presentations-comment-modal\s*\{/);
});

test('workspace actions download all, clear workspace and keep collections separate', () => {
  assert.match(pageSource, /function getWorkspaceLots\(/);
  assert.match(pageSource, /title: 'В работе'/);
  assert.match(pageSource, /DELETE'[\s\S]*\/lot-presentations\/workspace\/items/);
  assert.match(pageSource, /Очистить всё/);
  assert.match(pageSource, /Скачать все/);
  assert.match(pageSource, /disabled=\{!hasBrokerContacts \|\| workspaceItems\.length === 0 \|\| isSubmitting\}/);
});

test('presentation comments are contextual and limited to 1000 characters', () => {
  assert.match(pageSource, /const commentMaxLength = 1000;/);
  assert.match(pageSource, /commentDraft\.length > commentMaxLength/);
  assert.match(pageSource, /\/lot-presentations\/workspace\/items\/\$\{encodeURIComponent\(activeCommentTarget\.unitId\)\}/);
  assert.match(pageSource, /\/lot-presentations\/collections\/\$\{encodeURIComponent\(activeCommentTarget\.collectionId\)\}\/items\/\$\{encodeURIComponent\(activeCommentTarget\.unitId\)\}/);
  assert.match(pageSource, /Комментарий сохранён/);
});
```

- [ ] **Step 2: Run page test and verify it fails**

Run:

```bash
node --test apps/web/tests/lot-presentations-page.test.mjs
```

Expected: FAIL because workspace tabs, tiles and comment modal are not implemented yet.

- [ ] **Step 3: Add workspace imports and state**

Patch `apps/web/src/presentations/LotPresentationsPage.tsx`.

```tsx
import {
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileTextIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import type {
  AuthUser,
  CreateLotPresentationDocumentInput,
  LotPresentationCollection,
  LotPresentationCollectionItem,
  LotPresentationCollectionResponse,
  LotPresentationCollectionsResponse,
  LotPresentationDocument,
  LotPresentationDocumentResponse,
  LotPresentationDocumentsResponse,
  LotPresentationLot,
  LotPresentationLotsResponse,
  LotPresentationWorkspaceItem,
  LotPresentationWorkspaceResponse,
} from '@platforma/shared';

const commentMaxLength = 1000;

type PresentationTab = 'workspace' | 'collections';

type CommentTarget =
  | {
      context: 'workspace';
      unitId: string;
      collectionId: null;
      comment: string | null;
    }
  | {
      context: 'collection';
      unitId: string;
      collectionId: string;
      comment: string | null;
    };
```

Inside `LotPresentationsPage`.

```tsx
const [activeTab, setActiveTab] = useState<PresentationTab>('workspace');
const [workspaceItems, setWorkspaceItems] = useState<LotPresentationWorkspaceItem[]>([]);
const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(true);
const [activeCommentTarget, setActiveCommentTarget] = useState<CommentTarget | null>(null);
const [commentDraft, setCommentDraft] = useState('');
const [isCollectionPickerOpenFor, setIsCollectionPickerOpenFor] = useState<LotPresentationLot | null>(null);
const [pickerCollectionName, setPickerCollectionName] = useState('');
const [pickerError, setPickerError] = useState<string | null>(null);
```

- [ ] **Step 4: Add workspace loaders and helpers**

Add these functions near current loaders.

```tsx
async function loadWorkspace() {
  if (!accessToken) {
    return;
  }

  setIsWorkspaceLoading(true);
  setError(null);

  try {
    const data = await apiRequest<LotPresentationWorkspaceResponse>('/lot-presentations/workspace', accessToken);
    setWorkspaceItems(data.items);
  } catch (caughtError) {
    setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить лоты в работе');
  } finally {
    setIsWorkspaceLoading(false);
  }
}

function getWorkspaceLots(items: LotPresentationWorkspaceItem[]) {
  return items.map((item) => item.unit);
}

async function clearWorkspace() {
  if (!accessToken || !workspaceItems.length) {
    return;
  }

  const confirmed = window.confirm('Очистить все лоты в работе? Подборки и PDF останутся.');

  if (!confirmed) {
    return;
  }

  setIsSubmitting(true);
  setError(null);

  try {
    await apiRequest('/lot-presentations/workspace/items', accessToken, { method: 'DELETE' });
    setWorkspaceItems([]);
    setNotice('Рабочая зона очищена');
  } catch (caughtError) {
    setError(caughtError instanceof Error ? caughtError.message : 'Не удалось очистить рабочую зону');
  } finally {
    setIsSubmitting(false);
  }
}

async function removeWorkspaceItem(unitId: string) {
  if (!accessToken) {
    return;
  }

  setIsSubmitting(true);
  setError(null);

  try {
    await apiRequest(`/lot-presentations/workspace/items/${encodeURIComponent(unitId)}`, accessToken, {
      method: 'DELETE',
    });
    setWorkspaceItems((current) => current.filter((item) => item.unitId !== unitId));
    setNotice('Лот удалён из работы');
  } catch (caughtError) {
    setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить лот из работы');
  } finally {
    setIsSubmitting(false);
  }
}
```

Update initial load effect.

```tsx
void loadWorkspace();
void loadCollections();
void loadDocuments();
```

- [ ] **Step 5: Add comment save logic**

Add comment modal handlers.

```tsx
function openComment(target: CommentTarget) {
  setActiveCommentTarget(target);
  setCommentDraft(target.comment ?? '');
}

async function saveComment() {
  if (!accessToken || !activeCommentTarget) {
    return;
  }

  if (commentDraft.length > commentMaxLength) {
    setError('Комментарий не может быть длиннее 1000 символов');
    return;
  }

  const body = JSON.stringify({ comment: commentDraft.trim() || null });
  const endpoint = activeCommentTarget.context === 'workspace'
    ? `/lot-presentations/workspace/items/${encodeURIComponent(activeCommentTarget.unitId)}`
    : `/lot-presentations/collections/${encodeURIComponent(activeCommentTarget.collectionId)}/items/${encodeURIComponent(activeCommentTarget.unitId)}`;

  setIsSubmitting(true);
  setError(null);

  try {
    await apiRequest(endpoint, accessToken, {
      method: 'PATCH',
      body,
    });

    if (activeCommentTarget.context === 'workspace') {
      await loadWorkspace();
    } else {
      await loadCollections();
    }

    setActiveCommentTarget(null);
    setCommentDraft('');
    setNotice('Комментарий сохранён');
  } catch (caughtError) {
    setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить комментарий');
  } finally {
    setIsSubmitting(false);
  }
}
```

- [ ] **Step 6: Add collection picker from workspace tiles**

Add function that reuses existing collection endpoint.

```tsx
async function addLotToCollection(collectionId: string, unitId: string) {
  if (!accessToken) {
    return;
  }

  setIsSubmitting(true);
  setError(null);

  try {
    await apiRequest<LotPresentationCollectionResponse>(
      `/lot-presentations/collections/${encodeURIComponent(collectionId)}/items`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ unitId }),
      },
    );
    await loadCollections();
    await loadWorkspace();
    setIsCollectionPickerOpenFor(null);
    setNotice('Лот добавлен в подборку');
  } catch (caughtError) {
    setError(caughtError instanceof Error ? caughtError.message : 'Не удалось добавить лот в подборку');
  } finally {
    setIsSubmitting(false);
  }
}
```

- [ ] **Step 7: Replace page layout with tabs and tile grids**

In render, keep the header and warning, then use this structure.

```tsx
<div className="lot-presentations-tabs" role="tablist" aria-label="Разделы презентаций">
  <button
    className={activeTab === 'workspace' ? 'lot-presentations-tab is-active' : 'lot-presentations-tab'}
    type="button"
    role="tab"
    aria-selected={activeTab === 'workspace'}
    onClick={() => setActiveTab('workspace')}
  >
    В работе
  </button>
  <button
    className={activeTab === 'collections' ? 'lot-presentations-tab is-active' : 'lot-presentations-tab'}
    type="button"
    role="tab"
    aria-selected={activeTab === 'collections'}
    onClick={() => setActiveTab('collections')}
  >
    Мои подборки
  </button>
</div>

{activeTab === 'workspace' ? (
  <section className="content-panel lot-presentations-main">
    <div className="lot-presentations-workspace-toolbar">
      <button
        className="secondary-button secondary-button--fit"
        disabled={!hasBrokerContacts || workspaceItems.length === 0 || isSubmitting}
        type="button"
        onClick={() =>
          void createAndDownloadDocument(
            { unitIds: workspaceItems.map((item) => item.unitId), title: 'В работе' },
            getWorkspaceLots(workspaceItems),
          )
        }
      >
        <DownloadIcon aria-hidden="true" />
        Скачать все
      </button>
      <button
        className="secondary-button secondary-button--fit"
        disabled={workspaceItems.length === 0 || isSubmitting}
        type="button"
        onClick={() => void clearWorkspace()}
      >
        Очистить всё
      </button>
      <button className="primary-button primary-button--fit" type="button" onClick={openCreateCollectionModal}>
        <PlusIcon aria-hidden="true" />
        Добавить подборку
      </button>
    </div>
    {isWorkspaceLoading ? <p className="muted-text">Загрузка лотов в работе</p> : null}
    {workspaceItems.length ? (
      <div className="lot-presentations-grid">
        {workspaceItems.map((item) => (
          <LotPresentationLotTile
            accessToken={accessToken ?? ''}
            comment={item.comment}
            key={item.id}
            lot={item.unit}
            onDownloadOne={() =>
              void createAndDownloadDocument({ unitIds: [item.unitId], title: getLotTitle(item.unit) }, [item.unit])
            }
            onOpenCollectionPicker={() => setIsCollectionPickerOpenFor(item.unit)}
            onOpenComment={() => openComment({ context: 'workspace', unitId: item.unitId, collectionId: null, comment: item.comment })}
            onRemove={() => void removeWorkspaceItem(item.unitId)}
          />
        ))}
      </div>
    ) : (
      <div className="lot-presentations-empty">
        <strong>В работе пока нет лотов</strong>
        <span>Добавьте лоты со страницы объекта или из таблицы лотов.</span>
      </div>
    )}
  </section>
) : (
  <div className="lot-presentations-layout">
    <aside className="content-panel lot-presentations-sidebar">
      <div className="lot-presentations-panel-header">
        <div>
          <p className="eyebrow">Коллекции</p>
          <h3>Подборки</h3>
        </div>
        <div className="lot-presentations-sidebar-actions">
          <span className="lot-presentations-collection-count">{collections.length}</span>
          <button
            className="lot-presentations-create-inline"
            disabled={isSubmitting}
            type="button"
            aria-label="Создать подборку"
            title="Создать подборку"
            onClick={openCreateCollectionModal}
          >
            <PlusIcon aria-hidden="true" />
          </button>
        </div>
      </div>

      {isCollectionsLoading ? <p className="muted-text">Загрузка подборок</p> : null}

      <div className="lot-presentations-collection-list">
        {collections.map((collection) => (
          <article
            key={collection.id}
            className={
              selectedCollection?.id === collection.id
                ? 'lot-presentations-collection is-active'
                : 'lot-presentations-collection'
            }
          >
            <button type="button" onClick={() => selectCollection(collection.id)}>
              <strong>{collection.name}</strong>
              <span>{collection.itemsCount} лотов</span>
            </button>
            <div className="lot-presentations-collection-actions">
              <button
                className="icon-action-button"
                type="button"
                aria-label="Переименовать подборку"
                onClick={() => {
                  setRenamingCollectionId(collection.id);
                  setRenameValue(collection.name);
                }}
              >
                <PencilIcon aria-hidden="true" />
              </button>
              <button
                className="icon-action-button icon-action-button--danger"
                type="button"
                aria-label="Удалить подборку"
                onClick={() => void deleteCollection(collection)}
              >
                <Trash2Icon aria-hidden="true" />
              </button>
            </div>
          </article>
        ))}
      </div>
    </aside>

    <section className="content-panel lot-presentations-main">
      <div className="lot-presentations-panel-header">
        <div>
          <p className="eyebrow">Мои подборки</p>
          <h3>{selectedCollection?.name ?? 'Подборка не выбрана'}</h3>
        </div>
        <div className="lot-presentations-actions">
          <button
            className="secondary-button secondary-button--fit"
            disabled={!hasBrokerContacts || !selectedCollection || selectedCollection.items.length === 0 || isSubmitting}
            type="button"
            onClick={() =>
              selectedCollection
                ? void createAndDownloadDocument(
                    { collectionId: selectedCollection.id, title: selectedCollection.name },
                    selectedCollection.items.map((item) => item.unit),
                  )
                : undefined
            }
          >
            <FileTextIcon aria-hidden="true" />
            Вся подборка
          </button>
        </div>
      </div>

      {selectedCollection?.items.length ? (
        <div className="lot-presentations-grid">
          {selectedCollection.items.map((item) => (
            <LotPresentationLotTile
              accessToken={accessToken ?? ''}
              comment={item.comment}
              key={item.id}
              lot={item.unit}
              onDownloadOne={() =>
                void createAndDownloadDocument(
                  {
                    collectionId: selectedCollection.id,
                    unitIds: [item.unitId],
                    title: getLotTitle(item.unit),
                  },
                  [item.unit],
                )
              }
              onOpenComment={() =>
                openComment({
                  context: 'collection',
                  unitId: item.unitId,
                  collectionId: selectedCollection.id,
                  comment: item.comment,
                })
              }
              onRemove={() => void removeLotFromSelectedCollection(item.unitId)}
            />
          ))}
        </div>
      ) : (
        <div className="lot-presentations-empty">
          <strong>В подборке пока нет лотов</strong>
          <span>Добавьте лоты из вкладки В работе или через поиск проекта.</span>
        </div>
      )}
    </section>
  </div>
)}
```

- [ ] **Step 8: Add reusable lot tile component**

Replace `LotPresentationLotRow` with tile component.

```tsx
function LotPresentationLotTile({
  accessToken,
  comment,
  lot,
  onDownloadOne,
  onOpenCollectionPicker,
  onOpenComment,
  onRemove,
}: {
  accessToken: string;
  comment: string | null;
  lot: LotPresentationLot;
  onDownloadOne: () => void;
  onOpenCollectionPicker?: () => void;
  onOpenComment: () => void;
  onRemove: () => void;
}) {
  return (
    <article className="lot-presentations-lot-tile">
      <LotThumb accessToken={accessToken} lot={lot} />
      <div className="lot-presentations-lot-tile-body">
        <h3>{getLotTitle(lot)}</h3>
        <span>{lot.object.title}</span>
        <strong>{formatPrice(lot.effectivePrice ?? lot.discountPrice ?? lot.price, lot.currency)}</strong>
        <small>{[formatArea(lot.area), formatFloor(lot.floor)].filter(Boolean).join(' · ')}</small>
        <p>{feedUnitStatusLabels[lot.status]}</p>
      </div>
      <div className="lot-presentations-tile-actions">
        <button className="icon-action-button" type="button" aria-label="Скачать PDF лота" onClick={onDownloadOne}>
          <DownloadIcon aria-hidden="true" />
        </button>
        {onOpenCollectionPicker ? (
          <button className="icon-action-button" type="button" aria-label="Добавить в подборку" onClick={onOpenCollectionPicker}>
            <FolderPlusIcon aria-hidden="true" />
          </button>
        ) : null}
        <button
          className={comment ? 'icon-action-button lot-presentations-comment-action is-active' : 'icon-action-button lot-presentations-comment-action'}
          type="button"
          aria-label={comment ? 'Открыть комментарий' : 'Добавить комментарий'}
          onClick={onOpenComment}
        >
          <MessageSquareIcon aria-hidden="true" />
        </button>
        <button className="icon-action-button icon-action-button--danger" type="button" aria-label="Удалить лот" onClick={onRemove}>
          <Trash2Icon aria-hidden="true" />
        </button>
      </div>
      <button className="lot-presentations-comment-button" type="button" onClick={onOpenComment}>
        {comment ? 'Изменить комментарий' : 'Добавить комментарий'}
      </button>
    </article>
  );
}
```

- [ ] **Step 9: Add comment and picker modals**

Add modal markup near existing modals.

```tsx
{activeCommentTarget ? (
  <div className="lot-presentations-create-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) {
      setActiveCommentTarget(null);
    }
  }}>
    <div className="lot-presentations-comment-modal" role="dialog" aria-modal="true" aria-labelledby="lot-presentations-comment-title">
      <div className="lot-presentations-create-modal-header">
        <div>
          <h3 id="lot-presentations-comment-title">Комментарий</h3>
          <p>{commentDraft.length}/{commentMaxLength}</p>
        </div>
        <button className="lot-presentations-project-modal-close" type="button" aria-label="Закрыть комментарий" onClick={() => setActiveCommentTarget(null)}>
          <XIcon aria-hidden="true" />
        </button>
      </div>
      <textarea
        className="lot-presentations-comment-textarea"
        maxLength={commentMaxLength}
        value={commentDraft}
        onChange={(event) => setCommentDraft(event.currentTarget.value)}
      />
      {commentDraft.length > commentMaxLength ? <p className="form-error">Комментарий не может быть длиннее 1000 символов</p> : null}
      <div className="lot-presentations-create-modal-actions">
        <button className="secondary-button secondary-button--fit" type="button" onClick={() => setActiveCommentTarget(null)}>Отмена</button>
        <button className="primary-button primary-button--fit" disabled={isSubmitting || commentDraft.length > commentMaxLength} type="button" onClick={() => void saveComment()}>
          Сохранить
        </button>
      </div>
    </div>
  </div>
) : null}
```

Add collection picker modal using existing `collections` state and `addLotToCollection`.

```tsx
{isCollectionPickerOpenFor ? (
  <div
    className="lot-collection-modal-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        setIsCollectionPickerOpenFor(null);
        setPickerCollectionName('');
        setPickerError(null);
      }
    }}
  >
    <div className="lot-collection-modal" role="dialog" aria-modal="true" aria-labelledby="lot-collection-picker-title">
      <header className="lot-collection-modal-header">
        <div>
          <p className="eyebrow">Подборки</p>
          <h3 id="lot-collection-picker-title">Добавить в подборку</h3>
        </div>
        <button
          className="lot-collection-modal-close"
          type="button"
          aria-label="Закрыть"
          onClick={() => {
            setIsCollectionPickerOpenFor(null);
            setPickerCollectionName('');
            setPickerError(null);
          }}
        >
          <XIcon aria-hidden="true" />
        </button>
      </header>

      <div className="lot-collection-list" aria-label="Список подборок">
        {collections.map((collection) => {
          const isAlreadyAdded = isCollectionPickerOpenFor.collectionIds.includes(collection.id);

          return (
            <button
              key={collection.id}
              className="lot-collection-choice"
              disabled={isSubmitting || isAlreadyAdded}
              type="button"
              onClick={() => void addLotToCollection(collection.id, isCollectionPickerOpenFor.id)}
            >
              <span>
                <strong>{collection.name}</strong>
                <small>{collection.itemsCount} лотов</small>
              </span>
              {isAlreadyAdded ? <CheckIcon aria-hidden="true" /> : <FolderPlusIcon aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <form
        className="lot-collection-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createCollectionAndAddPickerLot();
        }}
      >
        <label>
          Новая подборка
          <input
            placeholder="Например: Клиент Иванов"
            type="text"
            value={pickerCollectionName}
            onChange={(event) => setPickerCollectionName(event.currentTarget.value)}
          />
        </label>
        <button className="secondary-button secondary-button--fit" disabled={isSubmitting} type="submit">
          Создать и добавить
        </button>
      </form>

      {pickerError ? <p className="form-error">{pickerError}</p> : null}
    </div>
  </div>
) : null}
```

Add this helper near `addLotToCollection`.

```tsx
async function createCollectionAndAddPickerLot() {
  if (!accessToken || !isCollectionPickerOpenFor) {
    return;
  }

  const name = pickerCollectionName.trim();

  if (!name) {
    setPickerError('Введите название подборки');
    return;
  }

  setIsSubmitting(true);
  setPickerError(null);

  try {
    const data = await apiRequest<LotPresentationCollectionResponse>('/lot-presentations/collections', accessToken, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });

    await addLotToCollection(data.collection.id, isCollectionPickerOpenFor.id);
    setPickerCollectionName('');
  } catch (caughtError) {
    setPickerError(caughtError instanceof Error ? caughtError.message : 'Не удалось создать подборку');
  } finally {
    setIsSubmitting(false);
  }
}
```

- [ ] **Step 10: Add compact tile styles**

Patch `apps/web/src/styles.css`.

```css
.lot-presentations-tabs {
  display: flex;
  gap: 26px;
  border-bottom: 1px solid var(--app-theme-border-soft, #e0e6ed);
}

.lot-presentations-tab {
  position: relative;
  border: 0;
  background: transparent;
  color: var(--app-theme-ink-800, #303b47);
  padding: 0 0 12px;
  font-size: 16px;
  font-weight: 850;
  cursor: pointer;
}

.lot-presentations-tab.is-active::after {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 3px;
  border-radius: 999px;
  background: var(--app-theme-ink-900, #18202a);
  content: "";
}

.lot-presentations-workspace-toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.lot-presentations-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
}

.lot-presentations-lot-tile {
  display: grid;
  overflow: hidden;
  border: 1px solid var(--app-theme-border, #d6dde5);
  border-radius: 8px;
  background: var(--app-theme-surface, #ffffff);
}

.lot-presentations-lot-tile .lot-presentations-thumb {
  width: 100%;
  aspect-ratio: 1.2;
  border: 0;
  border-bottom: 1px solid var(--app-theme-border-soft, #e0e6ed);
  border-radius: 0;
}

.lot-presentations-lot-tile-body {
  display: grid;
  gap: 6px;
  padding: 14px;
}

.lot-presentations-lot-tile-body h3 {
  margin: 0;
  color: var(--app-theme-ink-900, #18202a);
  font-size: 15px;
  line-height: 1.3;
}

.lot-presentations-lot-tile-body span,
.lot-presentations-lot-tile-body small,
.lot-presentations-lot-tile-body p {
  margin: 0;
  color: var(--app-theme-ink-700, #6d7885);
  font-size: 12px;
  font-weight: 750;
}

.lot-presentations-lot-tile-body strong {
  color: var(--app-theme-ink-900, #18202a);
  font-size: 16px;
}

.lot-presentations-tile-actions {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  padding: 0 12px 10px;
}

.lot-presentations-comment-action.is-active {
  color: var(--app-theme-primary-deep, #775a28);
  background: var(--app-theme-primary-soft, #f7f0df);
}

.lot-presentations-comment-button {
  min-height: 42px;
  margin: 0 12px 12px;
  border: 0;
  border-radius: 999px;
  background: var(--app-theme-surface-soft, #f8fafc);
  color: var(--app-theme-ink-800, #303b47);
  font-weight: 800;
  cursor: pointer;
}

.lot-presentations-comment-modal {
  display: grid;
  width: min(460px, calc(100vw - 40px));
  gap: 14px;
  border: 1px solid var(--app-theme-border-strong, #c6d0dc);
  border-radius: 8px;
  background: var(--app-theme-surface, #ffffff);
  padding: 18px;
}

.lot-presentations-comment-textarea {
  min-height: 180px;
  resize: vertical;
  border: 1px solid var(--app-theme-border-strong, #c6d0dc);
  border-radius: 8px;
  background: var(--app-theme-control, #ffffff);
  color: var(--app-theme-ink-900, #18202a);
  padding: 12px;
}

@media (max-width: 1280px) {
  .lot-presentations-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (max-width: 980px) {
  .lot-presentations-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .lot-presentations-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 11: Run targeted frontend test and build**

Run:

```bash
node --test apps/web/tests/lot-presentations-page.test.mjs
pnpm --filter @platforma/web build
```

Expected: targeted source test PASS and web build PASS.

- [ ] **Step 12: Commit presentation page UI**

```bash
git add apps/web/src/presentations/LotPresentationsPage.tsx apps/web/src/styles.css apps/web/tests/lot-presentations-page.test.mjs
git commit -m "feat(web): add lot presentation workspace UI"
```

---

## Task 5: Verification, Docs, And Manual QA Notes

**Files:**
- Modify: `docs/CODEX_LOG.md`

- [ ] **Step 1: Run full relevant automated checks**

Run:

```bash
pnpm --filter @platforma/api test
pnpm --filter @platforma/web test
pnpm build
```

Expected:

- API tests pass, including lot presentation schema/source checks.
- Web tests pass, including lot presentation page and object detail feed unit checks.
- Full monorepo build passes.

- [ ] **Step 2: Start dev server for manual UI smoke**

Run:

```bash
pnpm dev:web -- --port 5173 --strictPort
```

Expected: Vite starts on `http://localhost:5173`. If port `5173` is busy, stop the existing process or ask the user before using another port.

- [ ] **Step 3: Manual smoke checklist**

Open `http://localhost:5173/presentations` with an authenticated session and verify:

- `В работе` opens by default.
- Empty state appears when no workspace items exist.
- Adding a lot from `/objects/:slug/lots/:unitId` moves it into `В работе`.
- `В работе` shows compact tiles; five columns fit at wide desktop width.
- Single-lot download button creates PDF for one lot.
- `Скачать все` creates PDF for all workspace lots.
- Comment modal saves a workspace comment and the active icon appears after reload.
- Adding a workspace lot to a collection keeps it in `В работе`.
- `Мои подборки` shows sidebar and selected collection lots as tiles.
- Collection comment is separate from workspace comment.
- `Очистить всё` clears only `В работе`.

- [ ] **Step 4: Update Codex log**

Add this entry to the top of `docs/CODEX_LOG.md`.

```md
## 2026-06-29 - Lot presentation workspace implementation

Задача:

- Реализовать сохранённую пользовательскую вкладку `В работе` для PDF-презентаций лотов, плиточный вид лотов в работе и подборках, прямое добавление лота из объекта и контекстные комментарии.

Изменения:

- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql` - добавлены workspace items и comments для presentation items.
- `packages/shared/src/index.ts` - добавлены контракты workspace/comment.
- `apps/api/src/lot-presentations/*` - добавлены workspace endpoints и comment endpoints.
- `apps/web/src/presentations/*`, `apps/web/src/objects/ObjectDetailPage.tsx`, `apps/web/src/styles.css` - добавлен UI `В работе`, плитки лотов, direct add action, comment modal и collection picker.
- `apps/api/tests/lot-presentations-schema.test.cjs`, `apps/web/tests/lot-presentations-page.test.mjs`, `apps/web/tests/object-detail-feed-units.test.mjs` - обновлены регрессии.

Проверки:

- `pnpm --filter @platforma/api test`
- `pnpm --filter @platforma/web test`
- `pnpm build`

Ручная проверка:

- Проверить `/presentations`, добавление лота из объекта, скачивание PDF, комментарии, добавление в подборку и очистку `В работе`.
```

- [ ] **Step 5: Commit docs and final polish**

```bash
git add docs/CODEX_LOG.md
git commit -m "docs: log lot presentation workspace implementation"
git status --short
```

Expected: working tree clean except intentionally ignored local files.
