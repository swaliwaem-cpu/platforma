const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '../../..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

const schema = readProjectFile('apps/api/prisma/schema.prisma');
const migration = readProjectFile(
  'apps/api/prisma/migrations/20260720120000_add_project_presentations/migration.sql',
);
const appModule = readProjectFile('apps/api/src/app.module.ts');
const moduleSource = readProjectFile(
  'apps/api/src/project-presentations/project-presentations.module.ts',
);
const controller = readProjectFile(
  'apps/api/src/project-presentations/project-presentations.controller.ts',
);
const guard = readProjectFile(
  'apps/api/src/project-presentations/project-presentations-admin.guard.ts',
);
const service = readProjectFile(
  'apps/api/src/project-presentations/project-presentations.service.ts',
);
const worker = readProjectFile(
  'apps/api/src/project-presentations/project-presentations-worker.service.ts',
);
const types = readProjectFile(
  'apps/api/src/project-presentations/project-presentations.types.ts',
);
const shared = readProjectFile('packages/shared/src/index.ts');

test('Prisma schema stores drafts, immutable document snapshots, ordered objects and assets', () => {
  assert.match(
    schema,
    /enum ProjectPresentationDocumentStatus \{[\s\S]*PENDING[\s\S]*RUNNING[\s\S]*READY[\s\S]*FAILED[\s\S]*@@map\("project_presentation_document_status"\)/,
  );
  assert.match(
    schema,
    /model ProjectPresentationDraft \{[\s\S]*ownerUserId[\s\S]*templateVersion[\s\S]*version\s+Int[\s\S]*objects\s+ProjectPresentationDraftObject\[\][\s\S]*documents\s+ProjectPresentationDocument\[\][\s\S]*@@index\(\[ownerUserId, updatedAt\]\)[\s\S]*@@map\("project_presentation_drafts"\)/,
  );
  assert.match(
    schema,
    /model ProjectPresentationDraftObject \{[\s\S]*objectId[\s\S]*sortOrder[\s\S]*imageIds\s+Json[\s\S]*advantages\s+Json[\s\S]*@@unique\(\[draftId, objectId\]\)[\s\S]*@@unique\(\[draftId, sortOrder\]\)/,
  );
  assert.match(
    schema,
    /model ProjectPresentationDocument \{[\s\S]*status\s+ProjectPresentationDocumentStatus\s+@default\(PENDING\)[\s\S]*snapshotVersion[\s\S]*snapshotJson\s+Json[\s\S]*objectsCount[\s\S]*progress[\s\S]*attempts[\s\S]*idempotencyKey[\s\S]*objects\s+ProjectPresentationDocumentObject\[\][\s\S]*assets\s+ProjectPresentationDocumentAsset\[\]/,
  );
  assert.match(
    schema,
    /@@unique\(\[ownerUserId, idempotencyKey\]\)[\s\S]*@@index\(\[status, createdAt\]\)[\s\S]*@@index\(\[ownerUserId, createdAt\]\)/,
  );
  assert.match(
    schema,
    /model ProjectPresentationDocumentObject \{[\s\S]*sourceObjectId[\s\S]*sortOrder[\s\S]*@@unique\(\[documentId, sourceObjectId\]\)[\s\S]*@@unique\(\[documentId, sortOrder\]\)/,
  );
  assert.match(
    schema,
    /model ProjectPresentationDocumentAsset \{[\s\S]*fileId[\s\S]*sourceObjectId[\s\S]*role[\s\S]*sortOrder[\s\S]*@@index\(\[documentId, sortOrder\]\)/,
  );
});

test('migration creates project presentation enum, tables, indexes and archival relations', () => {
  assert.match(
    migration,
    /CREATE TYPE "project_presentation_document_status" AS ENUM \('PENDING', 'RUNNING', 'READY', 'FAILED'\)/,
  );

  for (const table of [
    'project_presentation_drafts',
    'project_presentation_draft_objects',
    'project_presentation_documents',
    'project_presentation_document_objects',
    'project_presentation_document_assets',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }

  assert.match(
    migration,
    /CREATE UNIQUE INDEX "project_presentation_draft_objects_draft_id_sort_order_key"/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "project_presentation_documents_owner_user_id_idempotency_key_key"/,
  );
  assert.match(
    migration,
    /CREATE INDEX "project_presentation_documents_status_created_at_idx"/,
  );
  assert.match(
    migration,
    /"project_presentation_documents_draft_id_fkey"[\s\S]*ON DELETE SET NULL/,
  );
  assert.match(
    migration,
    /"project_presentation_document_objects_object_id_fkey"[\s\S]*ON DELETE SET NULL/,
  );
  assert.match(
    migration,
    /"project_presentation_document_assets_document_id_fkey"[\s\S]*ON DELETE CASCADE/,
  );
});

test('API registers the feature with JWT, local bypass and production admin role', () => {
  assert.match(
    appModule,
    /import \{ ProjectPresentationsModule \} from '\.\/project-presentations\/project-presentations\.module';/,
  );
  assert.match(appModule, /imports:\s*\[[\s\S]*ProjectPresentationsModule/);
  assert.match(moduleSource, /controllers:\s*\[ProjectPresentationsController\]/);
  assert.match(
    moduleSource,
    /providers:\s*\[[\s\S]*ProjectPresentationsAdminGuard[\s\S]*ProjectPresentationsService[\s\S]*ProjectPresentationsPdfService[\s\S]*ProjectPresentationsWorkerService/,
  );
  assert.match(controller, /@Controller\('project-presentations'\)/);
  assert.match(
    controller,
    /@UseGuards\(JwtAuthGuard, ProjectPresentationsAdminGuard\)/,
  );
  assert.match(guard, /process\.env\.NODE_ENV !== 'production'/);
  assert.match(guard, /request\.user\?\.role\.name !== 'admin'/);
  assert.match(guard, /throw new ForbiddenException/);
  assert.doesNotMatch(guard, /localhost|127\.0\.0\.1|email/);
});

test('API exposes catalog, draft editor, async PDF history, retry, download and deletion routes', () => {
  const routePatterns = [
    /@Get\('objects'\)/,
    /@Get\('drafts'\)/,
    /@Post\('drafts'\)/,
    /@Get\('drafts\/:draftId'\)/,
    /@Patch\('drafts\/:draftId'\)/,
    /@Put\('drafts\/:draftId\/objects'\)/,
    /@Delete\('drafts\/:draftId'\)/,
    /@Post\('drafts\/:draftId\/documents'\)[\s\S]*@HttpCode\(HttpStatus\.ACCEPTED\)/,
    /@Get\('documents'\)/,
    /@Get\('documents\/:documentId'\)/,
    /@Post\('documents\/:documentId\/retry'\)/,
    /@Delete\('documents\/:documentId'\)/,
    /@Get\('documents\/:documentId\/content'\)/,
  ];

  for (const pattern of routePatterns) assert.match(controller, pattern);

  assert.match(controller, /this\.worker\.kick\(\)/);
  assert.match(controller, /Content-Type', file\.mimeType \?\? 'application\/pdf'/);
  assert.match(controller, /Content-Disposition', getContentDisposition\(file\.originalName\)/);
  assert.match(controller, /return `attachment; filename="\$\{asciiName\}"; filename\*=UTF-8''/);
  assert.match(controller, /@HttpCode\(HttpStatus\.NO_CONTENT\)/);
});

test('all admins see common draft and PDF history while responses retain creator identity', () => {
  assert.match(
    service,
    /async listDrafts\(\)[\s\S]*projectPresentationDraft\.findMany\(\{[\s\S]*include: draftInclude,[\s\S]*orderBy: \{ updatedAt: 'desc' \}/,
  );
  assert.match(
    service,
    /async listDocuments\([\s\S]*projectPresentationDocument\.findMany\(\{[\s\S]*owner:[\s\S]*orderBy: \{ createdAt: 'desc' \}/,
  );
  assert.match(service, /projectPresentationDocument\.count\(\)/);
  assert.match(
    service,
    /createdBy: document\.owner \?\? \{ id: document\.ownerUserId/,
  );
  assert.doesNotMatch(
    service.match(/async listDocuments[\s\S]*?async getDocument/)?.[0] ?? '',
    /ownerUserId:\s*actor\.id/,
  );
  assert.match(service, /async deleteDraft\([\s\S]*projectPresentationDraft\.deleteMany/);
  assert.match(service, /async deleteDocument\([\s\S]*Running document cannot be deleted/);
  assert.match(service, /projectPresentationDocument\.delete\(\{ where: \{ id: document\.id \} \}\)/);
  assert.match(service, /filesService\.delete\(document\.fileId\)/);
});

test('contracts fix the 12-object limit, 4:5 page, ordered snapshot and Telegram CTA', () => {
  assert.match(types, /PROJECT_PRESENTATION_MAX_OBJECTS = 12/);
  assert.match(types, /PROJECT_PRESENTATION_PAGE_WIDTH = (\d+)/);
  assert.match(types, /PROJECT_PRESENTATION_PAGE_HEIGHT = (\d+)/);
  const width = Number(types.match(/PROJECT_PRESENTATION_PAGE_WIDTH = (\d+)/)?.[1]);
  const height = Number(types.match(/PROJECT_PRESENTATION_PAGE_HEIGHT = (\d+)/)?.[1]);
  assert.equal(width / height, 4 / 5);
  assert.match(
    types,
    /ProjectPresentationSnapshotObject = \{[\s\S]*sourceObjectId: string;[\s\S]*sortOrder: number;[\s\S]*images: ProjectPresentationSnapshotImage\[\]/,
  );
  assert.match(
    types,
    /cta: \{[\s\S]*label: '@FluffyWhite';[\s\S]*url: 'https:\/\/t\.me\/FluffyWhite';/,
  );
  assert.match(
    service,
    /parseDraftObjects\([\s\S]*value\.length > PROJECT_PRESENTATION_MAX_OBJECTS/,
  );
  assert.match(
    service,
    /for \(const \[sortOrder, input\] of inputs\.entries\(\)\)[\s\S]*sortOrder,/,
  );
  assert.match(
    service,
    /snapshotJson: snapshot as unknown as Prisma\.InputJsonValue/,
  );
  assert.match(
    service,
    /cta: \{ label: '@FluffyWhite', url: 'https:\/\/t\.me\/FluffyWhite' \}/,
  );
});

test('worker has recoverable status transitions and bounded retries', () => {
  assert.match(worker, /const maxAttempts = 3/);
  assert.match(worker, /status: ProjectPresentationDocumentStatus\.PENDING/);
  assert.match(worker, /status: ProjectPresentationDocumentStatus\.RUNNING/);
  assert.match(worker, /status: ProjectPresentationDocumentStatus\.READY/);
  assert.match(worker, /status: ProjectPresentationDocumentStatus\.FAILED/);
  assert.match(worker, /attempts: \{ increment: 1 \}/);
  assert.match(worker, /progress: Math\.max\(1, Math\.min\(progress, 99\)\)/);
  assert.match(worker, /this\.filesService\.uploadFile/);
  assert.match(worker, /progress: 100/);
  assert.match(worker, /if \(uploadedFileId\) await this\.filesService\.deleteUnlinkedFile/);
  assert.match(service, /status: ProjectPresentationDocumentStatus\.FAILED, attempts: \{ lt: 3 \}/);
});

test('shared API contracts include drafts, status history, ownership and delete/download state', () => {
  assert.match(
    shared,
    /export type ProjectPresentationDocumentStatus = 'PENDING' \| 'RUNNING' \| 'READY' \| 'FAILED'/,
  );
  assert.match(shared, /export type ProjectPresentationDraftObjectInput = \{/);
  assert.match(shared, /export type ReplaceProjectPresentationDraftObjectsInput = \{[\s\S]*version: number;[\s\S]*objects: ProjectPresentationDraftObjectInput\[\]/);
  assert.match(shared, /export type ProjectPresentationDocument = \{[\s\S]*ownerUserId: string;[\s\S]*status: ProjectPresentationDocumentStatus;[\s\S]*progress: number;[\s\S]*canDownload: boolean;/);
  assert.match(shared, /export type ProjectPresentationDocumentsResponse = \{[\s\S]*items: ProjectPresentationDocument\[\];[\s\S]*total: number;/);
});
