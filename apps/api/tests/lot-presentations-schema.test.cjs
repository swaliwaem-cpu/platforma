const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const sharedTypesPath = path.join(rootDir, 'packages/shared/src/index.ts');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260618120000_add_lot_presentations/migration.sql',
);
const appModulePath = path.join(rootDir, 'apps/api/src/app.module.ts');
const modulePath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations.module.ts');
const controllerPath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations.controller.ts');
const servicePath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations.service.ts');
const pdfServicePath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations-pdf.service.ts');
const dockerfilePath = path.join(rootDir, 'apps/api/Dockerfile');
const pdfRegularFontPath = path.join(rootDir, 'apps/api/assets/fonts/NotoSans-Regular.ttf');
const pdfBoldFontPath = path.join(rootDir, 'apps/api/assets/fonts/NotoSans-Bold.ttf');
const pdfFontLicensePath = path.join(rootDir, 'apps/api/assets/fonts/OFL.txt');

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Prisma schema defines lot presentation collections, documents and broker contacts', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /brokerPhone\s+String\?\s+@map\("broker_phone"\)\s+@db\.VarChar\(64\)/);
  assert.match(schema, /brokerEmail\s+String\?\s+@map\("broker_email"\)\s+@db\.VarChar\(320\)/);
  assert.match(schema, /model LotPresentationCollection \{[\s\S]*userId\s+String\s+@map\("user_id"\)\s+@db\.Uuid[\s\S]*items\s+LotPresentationCollectionItem\[\][\s\S]*documents\s+LotPresentationDocument\[\][\s\S]*@@index\(\[userId, createdAt\]\)[\s\S]*@@map\("lot_presentation_collections"\)[\s\S]*\}/);
  assert.match(schema, /model LotPresentationCollectionItem \{[\s\S]*collectionId\s+String\s+@map\("collection_id"\)\s+@db\.Uuid[\s\S]*unitId\s+String\s+@map\("unit_id"\)\s+@db\.Uuid[\s\S]*@@unique\(\[collectionId, unitId\]\)[\s\S]*@@map\("lot_presentation_collection_items"\)[\s\S]*\}/);
  assert.match(schema, /model LotPresentationDocument \{[\s\S]*collectionId\s+String\?\s+@map\("collection_id"\)\s+@db\.Uuid[\s\S]*fileId\s+String\s+@map\("file_id"\)\s+@db\.Uuid[\s\S]*items\s+LotPresentationDocumentItem\[\][\s\S]*@@map\("lot_presentation_documents"\)[\s\S]*\}/);
  assert.match(schema, /model LotPresentationDocumentItem \{[\s\S]*documentId\s+String\s+@map\("document_id"\)\s+@db\.Uuid[\s\S]*unitId\s+String\s+@map\("unit_id"\)\s+@db\.Uuid[\s\S]*sortOrder\s+Int\s+@map\("sort_order"\)[\s\S]*@@id\(\[documentId, unitId\]\)[\s\S]*@@map\("lot_presentation_document_items"\)[\s\S]*\}/);
});

test('lot presentation migration creates tables, indexes and broker contact columns', () => {
  const migration = readProjectFile(migrationPath);

  assert.match(migration, /ALTER TABLE "users" ADD COLUMN "broker_phone" VARCHAR\(64\)/);
  assert.match(migration, /ALTER TABLE "users" ADD COLUMN "broker_email" VARCHAR\(320\)/);
  assert.match(migration, /CREATE TABLE "lot_presentation_collections"/);
  assert.match(migration, /CREATE TABLE "lot_presentation_collection_items"/);
  assert.match(migration, /CREATE TABLE "lot_presentation_documents"/);
  assert.match(migration, /CREATE TABLE "lot_presentation_document_items"/);
  assert.match(migration, /CREATE INDEX "lot_presentation_collections_user_id_created_at_idx"/);
  assert.match(migration, /CREATE UNIQUE INDEX "lot_presentation_collection_items_collection_id_unit_id_key"/);
  assert.match(migration, /CONSTRAINT "lot_presentation_document_items_pkey" PRIMARY KEY \("document_id", "unit_id"\)/);
  assert.match(migration, /ON DELETE CASCADE ON UPDATE CASCADE/);
});

test('shared package exports lot presentation contracts', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type AuthUser = \{[\s\S]*brokerPhone: string \| null;[\s\S]*brokerEmail: string \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type LotPresentationLot = FeedUnit & \{[\s\S]*object: LotPresentationObject;[\s\S]*hasPlanImage: boolean;[\s\S]*\};/);
  assert.match(sharedTypes, /export type LotPresentationCollection = \{[\s\S]*name: string;[\s\S]*itemsCount: number;[\s\S]*containsRequestedUnit: boolean \| null;[\s\S]*items: LotPresentationCollectionItem\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type LotPresentationDocument = \{[\s\S]*collectionId: string \| null;[\s\S]*file: ObjectStoredFile;[\s\S]*unitsCount: number;[\s\S]*items: LotPresentationDocumentItem\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type CreateLotPresentationDocumentInput = \{[\s\S]*collectionId\?: string \| null;[\s\S]*unitIds\?: string\[\];[\s\S]*\};/);
});

test('lot presentation API is guarded, registered and exposes collection/document routes', () => {
  const appModule = readProjectFile(appModulePath);
  const moduleSource = readProjectFile(modulePath);
  const controller = readProjectFile(controllerPath);
  const dockerfile = readProjectFile(dockerfilePath);

  assert.match(appModule, /LotPresentationsModule/);
  assert.match(moduleSource, /import \{ AuthModule \} from '\.\.\/auth\/auth\.module';/);
  assert.match(moduleSource, /imports: \[AuthModule, PrismaModule, FilesModule\]/);
  assert.match(moduleSource, /controllers: \[LotPresentationsController\]/);
  assert.match(moduleSource, /providers: \[LotPresentationsService, LotPresentationsPdfService\]/);
  assert.match(controller, /@Controller\('lot-presentations'\)[\s\S]*@UseGuards\(JwtAuthGuard\)/);
  assert.match(controller, /@Get\('lots'\)[\s\S]*listLots/);
  assert.match(controller, /@Get\('collections'\)[\s\S]*listCollections/);
  assert.match(controller, /@Post\('collections'\)[\s\S]*createCollection/);
  assert.match(controller, /@Patch\('collections\/:collectionId'\)[\s\S]*updateCollection/);
  assert.match(controller, /@Delete\('collections\/:collectionId'\)[\s\S]*deleteCollection/);
  assert.match(controller, /@Post\('documents'\)[\s\S]*createDocument/);
  assert.match(controller, /@Get\('documents\/:documentId\/content'\)[\s\S]*Content-Disposition/);
  assert.match(dockerfile, /COPY _Fluffy_White_1-02\.svg \.\/_Fluffy_White_1-02\.svg/);
});

test('lot presentation service enforces available lots, plan images and broker contacts', () => {
  const service = readProjectFile(servicePath);
  const pdfService = readProjectFile(pdfServicePath);

  assert.match(service, /const presentationStatuses = \[[\s\S]*FeedUnitStatus\.AVAILABLE,[\s\S]*FeedUnitStatus\.BOOKED,[\s\S]*FeedUnitStatus\.RESERVED,[\s\S]*\] as const;/);
  assert.doesNotMatch(service, /presentationStatuses = \[[\s\S]*FeedUnitStatus\.SOLD/);
  assert.match(service, /const maxPresentationLotsListLimit = 500;/);
  assert.match(service, /const limit = Math\.min\(this\.parsePositiveInteger\(query\.limit, 30\), maxPresentationLotsListLimit\);/);
  assert.match(service, /const objectId = query\.objectId\?\.trim\(\);[\s\S]*objectId: this\.parseUuid\(objectId, 'Object is invalid'\)/);
  assert.match(service, /const sortedUnits = \[\.\.\.units\]\.sort\(\(leftUnit, rightUnit\) => this\.compareUnitsByPrice\(leftUnit, rightUnit\)\);/);
  assert.match(service, /if \(!actor\.brokerPhone \|\| !actor\.brokerEmail\)/);
  assert.match(service, /\.find\(\(unit\) => !this\.hasPlanImage\(unit\)\)/);
  assert.match(service, /groupsByObjectId/);
  assert.match(service, /getGroupMinPrice/);
  assert.match(pdfService, /object\.description/);
  assert.match(pdfService, /'Описание проекта'/);
  assert.match(pdfService, /'_Fluffy_White_1-02\.svg'/);
  assert.match(pdfService, /NotoSans-Regular\.ttf/);
  assert.match(pdfService, /NotoSans-Bold\.ttf/);
  assert.doesNotMatch(pdfService, /noto-sans-cyrillic-\d+-normal\.woff/);
  assert.ok(fs.existsSync(pdfRegularFontPath));
  assert.ok(fs.existsSync(pdfBoldFontPath));
  assert.ok(fs.existsSync(pdfFontLicensePath));
  assert.match(pdfService, /drawPriceStrip/);
});
