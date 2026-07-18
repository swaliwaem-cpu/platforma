const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

const { BadRequestException } = require('@nestjs/common');
const {
  extractPdfNearbyPlaces,
  LotPresentationsService,
} = require('../dist/lot-presentations/lot-presentations.service.js');
const {
  LotPresentationsPdfService,
} = require('../dist/lot-presentations/lot-presentations-pdf.service.js');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const sharedTypesPath = path.join(rootDir, 'packages/shared/src/index.ts');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260618120000_add_lot_presentations/migration.sql',
);
const workspaceMigrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260629140000_add_lot_presentation_workspace/migration.sql',
);
const appModulePath = path.join(rootDir, 'apps/api/src/app.module.ts');
const modulePath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations.module.ts');
const controllerPath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations.controller.ts');
const accessGuardPath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations-access.guard.ts');
const servicePath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations.service.ts');
const pdfServicePath = path.join(rootDir, 'apps/api/src/lot-presentations/lot-presentations-pdf.service.ts');
const dockerfilePath = path.join(rootDir, 'apps/api/Dockerfile');
const pdfRegularFontPath = path.join(rootDir, 'apps/api/assets/fonts/NotoSans-Regular.ttf');
const pdfBoldFontPath = path.join(rootDir, 'apps/api/assets/fonts/NotoSans-Bold.ttf');
const pdfFontLicensePath = path.join(rootDir, 'apps/api/assets/fonts/OFL.txt');
const finishRoughPath = path.join(rootDir, 'apps/api/assets/lot-presentations/finishes/rough.png');
const finishFinePath = path.join(rootDir, 'apps/api/assets/lot-presentations/finishes/fine.png');
const finishWithFinishPath = path.join(rootDir, 'apps/api/assets/lot-presentations/finishes/with-finish.png');

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
  assert.match(sharedTypes, /export const LOT_PRESENTATION_FINISH_TYPES = \['ROUGH', 'FINE', 'WITH_FINISH'\] as const;/);
  assert.match(sharedTypes, /export type LotPresentationFinishType = \(typeof LOT_PRESENTATION_FINISH_TYPES\)\[number\];/);
  assert.match(sharedTypes, /export const LOT_PRESENTATION_FINISH_LABELS = \{[\s\S]*ROUGH: 'Черновая отделка \(бетон\)',[\s\S]*FINE: 'Предчистовая отделка \(вайт-бокс\)',[\s\S]*WITH_FINISH: 'Чистовая отделка \(дизайнерская\)',[\s\S]*\}/);
  assert.match(sharedTypes, /export type LotPresentationUnitFinish = \{[\s\S]*unitId: string;[\s\S]*finishType: LotPresentationFinishType;[\s\S]*\};/);
  assert.match(sharedTypes, /export type CreateLotPresentationDocumentInput = \{[\s\S]*collectionId\?: string \| null;[\s\S]*unitIds\?: string\[\];[\s\S]*unitFinishes: LotPresentationUnitFinish\[\];[\s\S]*\};/);
});

test('lot presentation finish validation covers the final residential unit snapshot exactly once', () => {
  const service = new LotPresentationsService({}, {}, {});
  const residentialA = {
    id: '11111111-1111-4111-8111-111111111111',
    externalId: 'residential-a',
    type: 'RESIDENTIAL',
    title: 'Квартира A',
  };
  const residentialB = {
    id: '22222222-2222-4222-8222-222222222222',
    externalId: 'residential-b',
    type: 'RESIDENTIAL',
    title: 'Квартира B',
  };
  const commercial = {
    id: '33333333-3333-4333-8333-333333333333',
    externalId: 'commercial',
    type: 'COMMERCIAL',
    title: 'Офис',
  };
  const foreignUnitId = '44444444-4444-4444-8444-444444444444';
  const units = [residentialB, commercial, residentialA];

  assert.deepEqual(
    service.parseUnitFinishes(
      [
        { unitId: residentialA.id, finishType: 'WITH_FINISH' },
        { unitId: residentialB.id, finishType: 'ROUGH' },
      ],
      units,
    ),
    [
      { unitId: residentialB.id, finishType: 'ROUGH' },
      { unitId: residentialA.id, finishType: 'WITH_FINISH' },
    ],
  );
  assert.deepEqual(service.parseUnitFinishes(undefined, [commercial]), []);

  assert.throws(
    () => service.parseUnitFinishes([{ unitId: residentialA.id, finishType: 'FINE' }], units),
    (error) => error instanceof BadRequestException && /\u0423\u043a\u0430\u0436\u0438\u0442\u0435 \u043e\u0442\u0434\u0435\u043b\u043a\u0443 \u0434\u043b\u044f \u043b\u043e\u0442\u0430/.test(error.message),
  );
  assert.throws(
    () => service.parseUnitFinishes(
      [
        { unitId: residentialA.id, finishType: 'FINE' },
        { unitId: residentialA.id, finishType: 'ROUGH' },
      ],
      [residentialA],
    ),
    (error) => error instanceof BadRequestException && /\u0431\u043e\u043b\u044c\u0448\u0435 \u043e\u0434\u043d\u043e\u0433\u043e \u0440\u0430\u0437\u0430/.test(error.message),
  );
  assert.throws(
    () => service.parseUnitFinishes([{ unitId: foreignUnitId, finishType: 'ROUGH' }], [residentialA]),
    (error) => error instanceof BadRequestException && /\u043d\u0435 \u0432\u0445\u043e\u0434\u0438\u0442 \u0432 \u043f\u0440\u0435\u0437\u0435\u043d\u0442\u0430\u0446\u0438\u044e/.test(error.message),
  );
  assert.throws(
    () => service.parseUnitFinishes([{ unitId: commercial.id, finishType: 'ROUGH' }], [commercial]),
    (error) => error instanceof BadRequestException && /\u043a\u043e\u043c\u043c\u0435\u0440\u0447\u0435\u0441\u043a\u043e\u0433\u043e \u043b\u043e\u0442\u0430/.test(error.message),
  );
  assert.throws(
    () => service.parseUnitFinishes([{ unitId: residentialA.id, finishType: 'UNKNOWN' }], [residentialA]),
    (error) => error instanceof BadRequestException && /\u0422\u0438\u043f \u043e\u0442\u0434\u0435\u043b\u043a\u0438 \u043d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u0435\u043d/.test(error.message),
  );
});

test('lot presentation gallery keeps the cover separate and maps thematic sections to columns', () => {
  const pdfService = new LotPresentationsPdfService({});
  const image = (id, sortOrder, section = null, isCover = false) => ({
    id,
    sortOrder,
    section,
    isCover,
    file: { id: `file-${id}` },
  });
  const thematicSelection = pdfService.selectProjectImages([
    image('interior-2', 5, 'INTERIORS'),
    image('filling-1', 6, 'FILLING'),
    image('architecture-2', 3, 'ARCHITECTURE'),
    image('cover', 0, 'ARCHITECTURE', true),
    image('interior-1', 4, 'INTERIORS'),
    image('architecture-1', 2, 'ARCHITECTURE'),
    image('filling-2', 7, 'FILLING'),
  ]);

  assert.equal(thematicSelection.hero.id, 'cover');
  assert.deepEqual(thematicSelection.architecture.map((item) => item.id), ['architecture-1', 'architecture-2']);
  assert.deepEqual(thematicSelection.interiors.map((item) => item.id), ['interior-1', 'interior-2']);
  assert.deepEqual(thematicSelection.filling.map((item) => item.id), ['filling-1', 'filling-2']);

  const fallbackSelection = pdfService.selectProjectImages([
    image('fallback-6', 6),
    image('cover', 0, null, true),
    image('fallback-2', 2),
    image('fallback-1', 1),
    image('fallback-4', 4),
    image('fallback-3', 3),
    image('fallback-5', 5),
    image('fallback-7', 7),
  ]);

  assert.equal(fallbackSelection.hero.id, 'cover');
  assert.deepEqual(
    [
      ...fallbackSelection.architecture,
      ...fallbackSelection.interiors,
      ...fallbackSelection.filling,
    ].map((item) => item.id),
    ['fallback-1', 'fallback-2', 'fallback-3', 'fallback-4', 'fallback-5', 'fallback-6'],
  );

  const partialSelection = pdfService.selectProjectImages([
    image('fallback-4', 7),
    image('interior-1', 3, 'INTERIORS'),
    image('cover', 0, 'ARCHITECTURE', true),
    image('fallback-1', 4),
    image('architecture-1', 2, 'ARCHITECTURE'),
    image('fallback-3', 6),
    image('fallback-2', 5),
  ]);

  assert.equal(partialSelection.hero.id, 'cover');
  assert.deepEqual(partialSelection.architecture.map((item) => item.id), ['architecture-1', 'fallback-1']);
  assert.deepEqual(partialSelection.interiors.map((item) => item.id), ['interior-1', 'fallback-2']);
  assert.deepEqual(partialSelection.filling.map((item) => item.id), ['fallback-3', 'fallback-4']);
  assert.deepEqual(
    new Set([
      ...partialSelection.architecture,
      ...partialSelection.interiors,
      ...partialSelection.filling,
    ].map((item) => item.id)).size,
    6,
  );
});

test('lot presentation titles wrap by whole words and plan media keep their semantic positions', () => {
  const pdfService = new LotPresentationsPdfService({});
  const doc = new PDFDocument({ autoFirstPage: false });
  pdfService.registerFonts(doc);

  const longTitle = '1-К в проекте Назаре́ Мангазея на набережной Москвы';
  const titleLayout = pdfService.getLotTitleLayout(doc, longTitle, 320);

  assert.equal(titleLayout.lines.length, 2);
  assert.equal(titleLayout.lines.join(' '), longTitle);
  doc.font('NotoSansBold').fontSize(titleLayout.fontSize);
  assert.ok(titleLayout.lines.every((line) => doc.widthOfString(line) <= 320));

  const media = (id, sortOrder, label, originalName) => ({
    sortOrder,
    label,
    mediaAsset: {
      file: {
        id,
        originalName,
        key: `feed/${originalName}`,
        url: null,
      },
    },
  });
  const mangazeyaPlans = pdfService.getLotPlanFiles({
    media: [
      media('unit-plan', 0, 'layout-photo', 'nazare_image_plan.jpeg'),
      media('floor-plan', 1, 'photo', 'nazare_floor_plan.jpeg'),
    ],
  });
  const mrGroupPlans = pdfService.getLotPlanFiles({
    media: [
      media('unit-plan', 0, 'photo', 'flat-plan.png'),
      media('floor-plan', 1, 'layout-photo', 'floor-plan.png'),
    ],
  });
  const fskPlans = pdfService.getLotPlanFiles({
    media: [
      media('unit-plan', 0, 'flat-plan', 'flat.png'),
      media('floor-plan', 1, 'floor-plan', 'floor.png'),
    ],
  });

  for (const plans of [mangazeyaPlans, mrGroupPlans, fskPlans]) {
    assert.equal(plans.plan.id, 'unit-plan');
    assert.equal(plans.floorPlan.id, 'floor-plan');
  }

  doc.end();
});

test('lot presentation media flattens transparent pixels onto a permanent light background', async () => {
  const transparentPlan = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const pdfService = new LotPresentationsPdfService({
    getContent: async () => ({ buffer: transparentPlan }),
  });

  const normalizedMedia = await pdfService.safeLoadImage('transparent-plan', 'detail');
  const { data, info } = await sharp(normalizedMedia)
    .raw()
    .toBuffer({ resolveWithObject: true });

  assert.equal(info.channels, 3);
  assert.ok(data[0] >= 248, `expected a light red channel, received ${data[0]}`);
  assert.ok(data[1] >= 248, `expected a light green channel, received ${data[1]}`);
  assert.ok(data[2] >= 245, `expected a light blue channel, received ${data[2]}`);
});

test('lot presentation nearby places normalize ACF data and keep exactly four valid rows', () => {
  assert.deepEqual(
    extractPdfNearbyPlaces({
      nearbyPlaces: [
        { nazvanie: 'Без времени', koordinaty: '55.7, 37.6' },
        {
          nazvanie: ' Даниловский рынок ',
          skolko_dobiratsya: ' 10 мин. пешком ',
          koordinaty: '55.711883, 37.620677',
        },
        {
          nazvanie: 'ТЦ Ереван Плаза',
          skolko_dobiratsya: '6 мин. пешком',
          koordinaty: '',
        },
        {
          nazvanie: 'Данилов монастырь',
          skolko_dobiratsya: '12 мин. пешком',
          koordinaty: '91, 37.630500',
        },
        null,
        {
          nazvanie: 'Новоданиловская набережная',
          skolko_dobiratsya: '15 мин. пешком',
          koordinaty: '55.698500, 37.625000',
        },
        {
          nazvanie: 'Пятое место',
          skolko_dobiratsya: '20 минут',
          koordinaty: '55.75, 37.61',
        },
      ],
    }),
    [
      {
        name: 'Даниловский рынок',
        travelTime: '10 мин. пешком',
        latitude: 55.711883,
        longitude: 37.620677,
      },
      {
        name: 'ТЦ Ереван Плаза',
        travelTime: '6 мин. пешком',
        latitude: null,
        longitude: null,
      },
      {
        name: 'Данилов монастырь',
        travelTime: '12 мин. пешком',
        latitude: null,
        longitude: null,
      },
      {
        name: 'Новоданиловская набережная',
        travelTime: '15 мин. пешком',
        latitude: 55.6985,
        longitude: 37.625,
      },
    ],
  );
  assert.deepEqual(extractPdfNearbyPlaces({ nearbyPlaces: 'invalid' }), []);
  assert.deepEqual(extractPdfNearbyPlaces(null), []);
});

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

test('lot presentation API is guarded, registered and exposes collection/document routes', () => {
  const appModule = readProjectFile(appModulePath);
  const moduleSource = readProjectFile(modulePath);
  const controller = readProjectFile(controllerPath);
  const dockerfile = readProjectFile(dockerfilePath);

  assert.match(appModule, /LotPresentationsModule/);
  assert.match(moduleSource, /import \{ AuthModule \} from '\.\.\/auth\/auth\.module';/);
  assert.match(moduleSource, /import \{ LotPresentationsAccessGuard \} from '\.\/lot-presentations-access\.guard';/);
  assert.match(moduleSource, /imports: \[AuthModule, PrismaModule, FilesModule\]/);
  assert.match(moduleSource, /controllers: \[LotPresentationsController\]/);
  assert.match(moduleSource, /providers: \[[^\]]*LotPresentationsService[\s\S]*LotPresentationsPdfService[\s\S]*LotPresentationsAccessGuard[\s\S]*\]/);
  assert.match(controller, /import \{ LotPresentationsAccessGuard \} from '\.\/lot-presentations-access\.guard';/);
  assert.match(controller, /@Controller\('lot-presentations'\)[\s\S]*@UseGuards\(JwtAuthGuard, LotPresentationsAccessGuard\)/);
  assert.match(controller, /@Get\('lots'\)[\s\S]*listLots/);
  assert.match(controller, /@Get\('collections'\)[\s\S]*listCollections/);
  assert.match(controller, /@Post\('collections'\)[\s\S]*createCollection/);
  assert.match(controller, /@Patch\('collections\/:collectionId'\)[\s\S]*updateCollection/);
  assert.match(controller, /@Delete\('collections\/:collectionId'\)[\s\S]*deleteCollection/);
  assert.match(controller, /@Post\('documents'\)[\s\S]*createDocument/);
  assert.match(controller, /@Get\('documents\/:documentId\/content'\)[\s\S]*Content-Disposition/);
  assert.match(dockerfile, /COPY _Fluffy_White_1-02\.svg \.\/_Fluffy_White_1-02\.svg/);
});

test('lot presentation access guard opens local API and restricts production by admin email', () => {
  assert.ok(fs.existsSync(accessGuardPath), 'lot presentation access guard file should exist');

  const guard = readProjectFile(accessGuardPath);

  assert.match(guard, /@Injectable\(\)[\s\S]*export class LotPresentationsAccessGuard implements CanActivate/);
  assert.match(guard, /ForbiddenException/);
  assert.match(guard, /const allowedEmail = 'admin@fluffywhite\.moscow';/);
  assert.match(guard, /process\.env\.NODE_ENV !== 'production'[\s\S]*return true;/);
  assert.match(guard, /request\.user\.email/);
  assert.match(guard, /\.trim\(\)\.toLowerCase\(\)/);
  assert.match(guard, /email !== allowedEmail[\s\S]*throw new ForbiddenException/);
});

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

test('lot presentation service enforces available lots, plan images and broker contacts', () => {
  const service = readProjectFile(servicePath);
  const pdfService = readProjectFile(pdfServicePath);
  const createDocumentSource = service.match(/async createDocument\([\s\S]*?\n  async listDocuments/)?.[0] ?? '';
  const primaryFactsSource = pdfService.match(/private drawPrimaryFacts\([\s\S]*?\n  private drawPrimaryFact/)?.[0] ?? '';
  const residentialCharacteristicsSource = pdfService.match(
    /const rows: Array<\[string, string \| null\]> = residential\s*\? \[([\s\S]*?)\]\s*: \[/,
  )?.[1] ?? '';

  assert.match(service, /const presentationStatuses = \[[\s\S]*FeedUnitStatus\.AVAILABLE,[\s\S]*FeedUnitStatus\.BOOKED,[\s\S]*FeedUnitStatus\.RESERVED,[\s\S]*\] as const;/);
  assert.doesNotMatch(service, /presentationStatuses = \[[\s\S]*FeedUnitStatus\.SOLD/);
  assert.match(service, /const maxPresentationLotsListLimit = 500;/);
  assert.match(service, /const maxDocumentUnits = 80;/);
  assert.match(createDocumentSource, /unitIds\.length > maxDocumentUnits/);
  assert.match(service, /const limit = Math\.min\(this\.parsePositiveInteger\(query\.limit, 30\), maxPresentationLotsListLimit\);/);
  assert.match(service, /const objectId = query\.objectId\?\.trim\(\);[\s\S]*objectId: this\.parseUuid\(objectId, 'Object is invalid'\)/);
  assert.match(service, /const sortedUnits = \[\.\.\.units\]\.sort\(\(leftUnit, rightUnit\) => this\.compareUnitsByPrice\(leftUnit, rightUnit\)\);/);
  assert.match(service, /if \(!actor\.brokerPhone \|\| !actor\.brokerEmail\)/);
  assert.match(service, /\.find\(\(unit\) => !this\.hasPlanImage\(unit\)\)/);
  assert.match(service, /groupsByObjectId/);
  assert.match(service, /groupsByObjectId\.set\(unit\.objectId/);
  assert.match(service, /getGroupMinPrice/);
  assert.match(createDocumentSource, /const groups = await this\.getPdfGroups\(unitIds\);[\s\S]*this\.parseUnitFinishes\(body\.unitFinishes, groups\.flatMap/);
  assert.match(service, /private parseUnitFinishes\(value: unknown, units: PdfPresentationUnit\[\]\): LotPresentationUnitFinish\[\]/);
  assert.match(service, /unit\.type === FeedUnitType\.RESIDENTIAL/);
  assert.match(service, /unit\.type !== FeedUnitType\.RESIDENTIAL[\s\S]*Отделка для коммерческого лота не указывается/);
  assert.match(service, /if \(!unit\)[\s\S]*который не входит в презентацию/);
  assert.match(service, /finishesByUnitId\.has\(unitId\)[\s\S]*указана больше одного раза/);
  assert.match(service, /residentialUnits\.find\(\(unit\) => !finishesByUnitId\.has\(unit\.id\)\)/);
  assert.match(service, /const lotPresentationFinishTypes = new Set<LotPresentationFinishType>\(\['ROUGH', 'FINE', 'WITH_FINISH'\]\);/);
  assert.match(service, /lotPresentationFinishTypes\.has\(value as LotPresentationFinishType\)/);
  assert.match(createDocumentSource, /groups,[\s\S]*title,[\s\S]*unitFinishes,/);
  assert.match(service, /photoFileId: actor\.profilePhotoFile\?\.id \?\? null/);
  assert.match(service, /isCover: 'desc' as const,[\s\S]*sortOrder: 'asc' as const/);
  assert.match(service, /latitude: firstUnit\.object\.latitude/);
  assert.match(service, /longitude: firstUnit\.object\.longitude/);
  assert.match(service, /propertyClass: firstUnit\.object\.propertyClass/);
  assert.match(service, /ceilingHeight: firstUnit\.object\.ceilingHeight/);
  assert.match(service, /completionYear: firstUnit\.object\.completionYear/);
  assert.match(service, /completionQuarter: firstUnit\.object\.completionQuarter/);
  assert.match(service, /developerName: firstUnit\.object\.developer\?\.name \?\? null/);
  assert.match(service, /images: firstUnit\.object\.images/);
  assert.match(service, /const maxPdfNearbyPlaces = 4;/);
  assert.match(service, /nearbyPlaces: extractPdfNearbyPlaces\(firstUnit\.object\.featuresJson\)/);
  assert.doesNotMatch(createDocumentSource, /comment/);
  assert.match(pdfService, /object\.description/);
  assert.match(pdfService, /'Проект в деталях'/);
  assert.match(pdfService, /'Отделка и расположение'/);
  assert.match(pdfService, /const finishType = finishTypeByUnitId\.get\(unit\.id\) \?\? null;[\s\S]*this\.drawLotPage\(doc, unit, nextPage\(\), finishType\)/);
  assert.match(primaryFactsSource, /finishType \? finishLabels\[finishType\] : '—'/);
  assert.match(primaryFactsSource, /'Класс'[\s\S]*y \+ 54, 191/);
  assert.match(primaryFactsSource, /'Отделка'[\s\S]*y \+ 108, 191, 32/);
  assert.match(primaryFactsSource, /\['Состояние', '—'\]/);
  assert.doesNotMatch(residentialCharacteristicsSource, /Площадь кухни/);
  assert.doesNotMatch(residentialCharacteristicsSource, /Высота потолков/);
  assert.doesNotMatch(residentialCharacteristicsSource, /Окна/);
  assert.doesNotMatch(residentialCharacteristicsSource, /Вид/);
  assert.match(residentialCharacteristicsSource, /\['Договор', 'ДДУ\/ДКП'\]/);
  assert.match(pdfService, /images\.hero\?\.file \?\? null, marginX, 136, contentWidth, 223/);
  assert.match(pdfService, /\[marginX, 370, 168, 196\],[\s\S]*\[marginX, 575, 168, 196\]/);
  assert.match(pdfService, /images\.architecture\[0\][\s\S]*images\.architecture\[1\][\s\S]*images\.interiors\[0\][\s\S]*images\.interiors\[1\][\s\S]*images\.filling\[0\][\s\S]*images\.filling\[1\]/);
  assert.match(pdfService, /const hasThematicSections = galleryImages\.some\(\(image\) => image\.section !== null\)/);
  assert.match(pdfService, /fallback\.slice\(0, 2\)[\s\S]*fallback\.slice\(2, 4\)[\s\S]*fallback\.slice\(4, 6\)/);
  assert.match(pdfService, /'_Fluffy_White_1-02\.svg'/);
  assert.match(pdfService, /NotoSans-Regular\.ttf/);
  assert.match(pdfService, /NotoSans-Bold\.ttf/);
  assert.doesNotMatch(pdfService, /noto-sans-cyrillic-\d+-normal\.woff/);
  assert.ok(fs.existsSync(pdfRegularFontPath));
  assert.ok(fs.existsSync(pdfBoldFontPath));
  assert.ok(fs.existsSync(pdfFontLicensePath));
  assert.ok(fs.existsSync(finishRoughPath));
  assert.ok(fs.existsSync(finishFinePath));
  assert.ok(fs.existsSync(finishWithFinishPath));
  assert.match(pdfService, /drawPriceSummary/);
  assert.match(pdfService, /getLotPlanFiles/);
  assert.match(pdfService, /getLotTitleLayout/);
  assert.match(pdfService, /titleLayout\.lines\.forEach/);
  assert.doesNotMatch(
    pdfService.match(/const titleLayout = this\.getLotTitleLayout[\s\S]*?const subtitleY/)?.[0] ?? '',
    /ellipsis: true/,
  );
  assert.match(pdfService, /drawFileFrame\(doc, plan, marginX, 223, 303, 278, 'Планировка недоступна'\)/);
  assert.match(pdfService, /drawFileFrame\(doc, floorPlan, marginX, 570, 303, 192, 'План этажа недоступен'\)/);
  assert.match(pdfService, /label.*flat-plan/s);
  assert.match(pdfService, /label.*floor-plan/s);
  assert.match(pdfService, /cover: \[width, height\]/);
  assert.match(pdfService, /drawPhotoBufferFrame\(doc, photo/);
  assert.match(pdfService, /drawPhotoBufferFrame\(doc, mapBuffer/);
  assert.match(pdfService, /const imageFrameRadius = 5;/);
  assert.match(pdfService, /roundedRect\(x, y, width, height, imageFrameRadius\)\.clip\(\)/);
  assert.match(pdfService, /'Пример состояния отделки представлен для иллюстрации, но не является конечной версией отделки'/);
  assert.match(pdfService, /this\.drawNearbyPlaces\(doc, object\.nearbyPlaces, 374, 350, 191\)/);
  assert.match(pdfService, /'МЕСТА РЯДОМ'/);
  assert.match(pdfService, /'Информация о местах рядом не указана'/);
  assert.doesNotMatch(pdfService, /'ТРАНСПОРТНАЯ ДОСТУПНОСТЬ'/);
  assert.doesNotMatch(pdfService, /'НА АВТОМОБИЛЕ'/);
  assert.match(pdfService, /drawPhotoBufferFrame\([\s\S]*finishType \? finishAssetPaths\[finishType\] : null,[\s\S]*'Фото отделки'/);
  assert.match(pdfService, /ROUGH: resolveFinishAssetPath\('rough\.png'\)/);
  assert.match(pdfService, /FINE: resolveFinishAssetPath\('fine\.png'\)/);
  assert.match(pdfService, /WITH_FINISH: resolveFinishAssetPath\('with-finish\.png'\)/);
  assert.match(pdfService, /finishType \? 'ТИП ОТДЕЛКИ' : 'БАЗОВАЯ ОТДЕЛКА'/);
  assert.match(pdfService, /finishType \? finishLabels\[finishType\] : 'Без отделки'/);
  assert.match(pdfService, /`\$\{this\.getLotTitle\(unit\)\} · \$\{this\.getLotSubtitle\(unit\)\}`/);
  assert.match(pdfService, /getProjectDetailsPageCount/);
  assert.match(pdfService, /group\.units\.filter\(\(unit\) => unit\.type === FeedUnitType\.RESIDENTIAL\)\.length/);
  assert.match(pdfService, /cleanProjectName/);
  assert.match(pdfService, /`\$\{unit\.rooms\}-К в проекте \$\{projectName\}`/);
  assert.doesNotMatch(pdfService.match(/private getLotTitle[\s\S]*?\n  }/)?.[0] ?? '', /layoutType/);
  assert.match(pdfService, /https:\/\/static-maps\.yandex\.ru\/1\.x\//);
  assert.match(pdfService, /AbortSignal\.timeout\(5000\)/);
  assert.match(pdfService, /fit: \[width - 6, height - 6\]/);
  assert.match(pdfService, /unit\.type === FeedUnitType\.COMMERCIAL/);
  assert.match(pdfService, /'ХАРАКТЕРИСТИКИ'/);
});
