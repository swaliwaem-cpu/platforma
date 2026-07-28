require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BadRequestException, ForbiddenException } = require('@nestjs/common');
const { UserStatus } = require('@prisma/client');

const { AuthController } = require('../dist/auth/auth.controller.js');
const { CatalogLinksController } = require('../dist/catalog-links/catalog-links.controller.js');
const { FeedsController } = require('../dist/feeds/feeds.controller.js');
const { getMediaCookieName, getRefreshCookieName } = require('../dist/auth/cookies.js');
const { MediaController } = require('../dist/files/media.controller.js');
const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');
const { ObjectsController } = require('../dist/objects/objects.controller.js');
const { UsersController } = require('../dist/users/users.controller.js');
const { WordpressImportController } = require('../dist/wordpress-import/wordpress-import.controller.js');

const rootDir = path.resolve(__dirname, '../../..');
const sharedTypesPath = path.join(rootDir, 'packages/shared/src/index.ts');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const objectTypeMigrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260710120000_add_real_estate_object_type/migration.sql',
);
const seedPath = path.join(rootDir, 'apps/api/src/prisma/seed.ts');
const feedsModulePath = path.join(rootDir, 'apps/api/src/feeds/feeds.module.ts');

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@example.test',
  name: 'Admin',
  status: UserStatus.ACTIVE,
  role: { id: '22222222-2222-4222-8222-222222222222', name: 'admin' },
  permissions: ['objects:read', 'users:read'],
};

function makeResponse() {
  return {
    cookies: [],
    clearedCookies: [],
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
    },
    clearCookie(name, options) {
      this.clearedCookies.push({ name, options });
    },
  };
}

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function getPermissions(controller, methodName) {
  return Reflect.getMetadata(PERMISSIONS_KEY, controller.prototype[methodName]) ?? [];
}

function makeContext(request, handler, controller) {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  };
}

function metadataReflector() {
  return {
    getAllAndOverride: (key, targets) => Reflect.getMetadata(key, targets[0]) ?? Reflect.getMetadata(key, targets[1]) ?? [],
  };
}

test('AuthController normalizes login email and keeps refresh token in httpOnly cookie only', async () => {
  const calls = {};
  const controller = new AuthController({
    login: async (email, password) => {
      calls.login = { email, password };

      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        mediaToken: 'media-token',
        user,
      };
    },
  });
  const response = makeResponse();

  const result = await controller.login({ email: ' Admin@Example.Test ', password: 'secret' }, response);

  assert.deepEqual(calls.login, { email: 'admin@example.test', password: 'secret' });
  assert.deepEqual(result, { accessToken: 'access-token', user });
  assert.equal('refreshToken' in result, false);
  assert.equal(response.cookies[0].name, getRefreshCookieName());
  assert.equal(response.cookies[0].value, 'refresh-token');
  assert.equal(response.cookies[0].options.httpOnly, true);
  assert.equal(response.cookies[1].name, getMediaCookieName());
  assert.equal(response.cookies[1].value, 'media-token');
  assert.equal(response.cookies[1].options.httpOnly, true);
  assert.equal(response.cookies[1].options.maxAge, 200 * 60 * 1000);
});

test('AuthController validates login body', async () => {
  const controller = new AuthController({
    login: async () => assert.fail('Auth service must not be called for invalid login body'),
  });

  await assert.rejects(
    () => controller.login({ email: 'admin@example.test' }, makeResponse()),
    BadRequestException,
  );
});

test('AuthController starts email registration with normalized email', async () => {
  const calls = {};
  const controller = new AuthController({
    requestEmailRegistration: async (input, request) => {
      calls.requestEmailRegistration = { input, request };

      return { ok: true };
    },
  });
  const request = { headers: { 'user-agent': 'node-test' }, ip: '127.0.0.1' };

  const result = await controller.requestEmailRegistration(
    {
      email: ' User@Example.Test ',
      password: 'Strong!1',
      passwordConfirmation: 'Strong!1',
    },
    request,
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.requestEmailRegistration, {
    input: {
      email: 'user@example.test',
      password: 'Strong!1',
      passwordConfirmation: 'Strong!1',
    },
    request,
  });
});

test('AuthController verifies email registration and sets auth cookies', async () => {
  const calls = {};
  const controller = new AuthController({
    verifyEmailRegistration: async (body) => {
      calls.verifyEmailRegistration = body;

      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        mediaToken: 'media-token',
        user,
      };
    },
  });
  const response = makeResponse();

  const result = await controller.verifyEmailRegistration(
    {
      token: 'magic-token',
    },
    response,
  );

  assert.deepEqual(calls.verifyEmailRegistration, {
    token: 'magic-token',
  });
  assert.deepEqual(result, { accessToken: 'access-token', user });
  assert.equal('refreshToken' in result, false);
  assert.equal(response.cookies[0].name, getRefreshCookieName());
  assert.equal(response.cookies[0].value, 'refresh-token');
  assert.equal(response.cookies[1].name, getMediaCookieName());
  assert.equal(response.cookies[1].value, 'media-token');
});

test('AuthController validates email registration bodies', async () => {
  const controller = new AuthController({
    requestEmailRegistration: async () => assert.fail('Auth service must not be called for invalid email'),
    verifyEmailRegistration: async () => assert.fail('Auth service must not be called for invalid verification'),
  });

  await assert.rejects(
    () => controller.requestEmailRegistration({ email: 'not-an-email' }, { headers: {} }),
    BadRequestException,
  );
  await assert.rejects(
    () =>
      controller.requestEmailRegistration(
        {
          email: 'user@example.test',
          password: 'weak',
          passwordConfirmation: 'weak',
        },
        { headers: {} },
      ),
    BadRequestException,
  );
  await assert.rejects(
    () =>
      controller.requestEmailRegistration(
        {
          email: 'user@example.test',
          password: 'Strong!1',
          passwordConfirmation: 'Strong!2',
        },
        { headers: {} },
      ),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.verifyEmailRegistration({ email: 'user@example.test' }, makeResponse()),
    BadRequestException,
  );
  await assert.rejects(
    () =>
      controller.verifyEmailRegistration(
        {
          email: 'user@example.test',
          code: '12345',
        },
        makeResponse(),
      ),
    BadRequestException,
  );
});

test('AuthController refresh rotates cookie and logout clears it', async () => {
  const calls = {};
  const controller = new AuthController({
    refresh: async (request) => {
      calls.refresh = request;

      return {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        mediaToken: 'new-media-token',
        user,
      };
    },
    logout: async (request) => {
      calls.logout = request;
    },
  });
  const request = { headers: { cookie: `${getRefreshCookieName()}=old-refresh-token` } };
  const refreshResponse = makeResponse();
  const logoutResponse = makeResponse();

  const result = await controller.refresh(request, refreshResponse);
  await controller.logout(request, logoutResponse);

  assert.equal(result.accessToken, 'new-access-token');
  assert.equal(refreshResponse.cookies[0].value, 'new-refresh-token');
  assert.equal(refreshResponse.cookies[1].name, getMediaCookieName());
  assert.equal(refreshResponse.cookies[1].value, 'new-media-token');
  assert.deepEqual(calls.refresh, request);
  assert.deepEqual(calls.logout, request);
  assert.equal(logoutResponse.clearedCookies[0].name, getRefreshCookieName());
  assert.equal(logoutResponse.clearedCookies[1].name, getMediaCookieName());
});

test('API controllers expose expected permission contracts', () => {
  assert.deepEqual(getPermissions(CatalogLinksController, 'list'), ['objects:read']);
  assert.deepEqual(getPermissions(CatalogLinksController, 'listAdmin'), ['admin:access', 'objects:update']);
  assert.deepEqual(getPermissions(CatalogLinksController, 'updateAdmin'), ['admin:access', 'objects:update']);
  assert.deepEqual(getPermissions(ObjectsController, 'list'), ['objects:read']);
  assert.deepEqual(getPermissions(ObjectsController, 'listFeedUnits'), ['objects:read']);
  assert.deepEqual(getPermissions(ObjectsController, 'listFeedUnitGroups'), ['objects:read']);
  assert.deepEqual(getPermissions(ObjectsController, 'getFeedUnit'), ['objects:read']);
  assert.deepEqual(getPermissions(ObjectsController, 'create'), ['objects:create']);
  assert.deepEqual(getPermissions(ObjectsController, 'publish'), ['objects:publish']);
  assert.deepEqual(getPermissions(ObjectsController, 'updateStatus'), ['objects:publish']);
  assert.deepEqual(getPermissions(ObjectsController, 'uploadGalleryImageStream'), ['objects:update', 'files:upload']);
  assert.deepEqual(getPermissions(ObjectsController, 'updateGalleryLayout'), ['objects:update']);
  assert.deepEqual(getPermissions(ObjectsController, 'uploadObjectFile'), ['objects:update', 'files:upload']);
  assert.deepEqual(getPermissions(UsersController, 'create'), ['users:create']);
  assert.deepEqual(getPermissions(UsersController, 'deactivate'), ['users:delete']);
  assert.deepEqual(getPermissions(WordpressImportController, 'runPreview'), ['import:preview']);
  assert.deepEqual(getPermissions(WordpressImportController, 'runImport'), ['import:run']);
  assert.deepEqual(getPermissions(FeedsController, 'listSources'), ['feeds:read']);
  assert.deepEqual(getPermissions(FeedsController, 'createSource'), ['feeds:manage']);
  assert.deepEqual(getPermissions(FeedsController, 'updateSource'), ['feeds:manage']);
  assert.deepEqual(getPermissions(FeedsController, 'deleteSource'), ['feeds:manage']);
  assert.deepEqual(getPermissions(FeedsController, 'analyzeFeed'), ['feeds:manage']);
  assert.deepEqual(getPermissions(FeedsController, 'runPreview'), ['feeds:run']);
  assert.deepEqual(getPermissions(FeedsController, 'runImport'), ['feeds:run']);
  assert.deepEqual(getPermissions(FeedsController, 'listSourceRuns'), ['feeds:read']);
  assert.deepEqual(getPermissions(FeedsController, 'getRun'), ['feeds:read']);
  assert.deepEqual(getPermissions(FeedsController, 'listUnits'), ['feeds:read']);
  assert.deepEqual(getPermissions(MediaController, 'getContent'), []);
});

test('seed includes feed permissions for admin role', () => {
  const seed = readProjectFile(seedPath);

  assert.match(seed, /\['feeds:read', 'Read feed sources and units'\]/);
  assert.match(seed, /\['feeds:manage', 'Manage feed sources'\]/);
  assert.match(seed, /\['feeds:run', 'Run feed imports'\]/);
  assert.match(
    seed,
    /admin:\s*\[[\s\S]*\.\.\.NON_TRAINING_PERMISSION_DEFINITIONS\.map\(\(\[key\]\) => key\)/,
  );
});

test('FeedsModule imports AuthModule for guarded feed routes', () => {
  const moduleSource = readProjectFile(feedsModulePath);

  assert.match(moduleSource, /import \{ AuthModule \} from '\.\.\/auth\/auth\.module';/);
  assert.match(moduleSource, /import \{ FilesModule \} from '\.\.\/files\/files\.module';/);
  assert.match(moduleSource, /imports: \[AuthModule, FilesModule, PrismaModule\]/);
});

test('shared package exports feed API contracts', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type FeedFormat = 'YANDEX_REALTY' \| 'CIAN_XML' \| 'AVITO_XML' \| 'FSK_XML' \| 'TEKTA_XML';/);
  assert.match(sharedTypes, /export type FeedSourceKind = 'URL' \| 'FILE' \| 'INDEX_URL';/);
  assert.match(sharedTypes, /export type FeedUnitType = 'RESIDENTIAL' \| 'COMMERCIAL';/);
  assert.match(sharedTypes, /export type FeedUnitStatus = 'AVAILABLE' \| 'BOOKED' \| 'RESERVED' \| 'SOLD' \| 'ARCHIVED' \| 'UNKNOWN';/);
  assert.match(sharedTypes, /export type FeedSourceMapping = \{[\s\S]*id: string;[\s\S]*sourceId: string;[\s\S]*objectId: string;[\s\S]*sourceKey: string;[\s\S]*sourceTitle: string;[\s\S]*filterJson: JsonValue;[\s\S]*isActive: boolean;[\s\S]*object: FeedSourceObject;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedSource = \{[\s\S]*sourceKind: FeedSourceKind;[\s\S]*url: string \| null;[\s\S]*xmlFileId: string \| null;[\s\S]*xmlFile: ObjectStoredFile \| null;[\s\S]*format: FeedFormat;[\s\S]*filterJson: JsonValue \| null;[\s\S]*developerId: string;[\s\S]*objectId: string \| null;[\s\S]*isActive: boolean;[\s\S]*deletedAt: string \| null;[\s\S]*lastPreviewAt: string \| null;[\s\S]*lastRunAt: string \| null;[\s\S]*lastSuccessAt: string \| null;[\s\S]*developer: ObjectDeveloper;[\s\S]*object: FeedSourceObject \| null;[\s\S]*mappings: FeedSourceMapping\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedImportRun = \{[\s\S]*sourceId: string;[\s\S]*mode: ImportMode;[\s\S]*status: ImportStatus;[\s\S]*summaryJson: JsonValue;[\s\S]*warningsJson: JsonValue;[\s\S]*errorsJson: JsonValue;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedUnit = \{[\s\S]*externalId: string;[\s\S]*type: FeedUnitType;[\s\S]*status: FeedUnitStatus;[\s\S]*price: string \| null;[\s\S]*discountPrice: string \| null;[\s\S]*effectivePrice: string \| null;[\s\S]*area: string \| null;[\s\S]*pricePerMeter: string \| null;[\s\S]*discountPricePerMeter: string \| null;[\s\S]*effectivePricePerMeter: string \| null;[\s\S]*residentialDetails: FeedResidentialUnitDetails \| null;[\s\S]*commercialDetails: FeedCommercialUnitDetails \| null;[\s\S]*media: FeedMedia\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedSourceAnalysisObject = \{[\s\S]*projectNames: string\[\];[\s\S]*externalIds: string\[\];[\s\S]*buildingNames: string\[\];[\s\S]*avitoDevelopmentIds: string\[\];[\s\S]*filterJson: Record<string, string\[\]> \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedSourceAnalysis = \{[\s\S]*developerName: string \| null;[\s\S]*unitsCount: number;[\s\S]*objects: FeedSourceAnalysisObject\[\];[\s\S]*warningsCount: number;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedIndexFileCandidate = \{[\s\S]*url: string;[\s\S]*format: FeedFormat \| null;[\s\S]*unitsCount: number;[\s\S]*warningsCount: number;[\s\S]*error: string \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedIndexPlatformCandidate = \{[\s\S]*format: FeedFormat;[\s\S]*label: string;[\s\S]*filesCount: number;[\s\S]*unitsCount: number;[\s\S]*warningsCount: number;[\s\S]*errorsCount: number;[\s\S]*files: FeedIndexFileCandidate\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedIndexDiscovery = \{[\s\S]*sourceUrl: string;[\s\S]*files: FeedIndexFileCandidate\[\];[\s\S]*platforms: FeedIndexPlatformCandidate\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedMedia = \{[\s\S]*sourceUrl: string;[\s\S]*file: ObjectStoredFile \| null;[\s\S]*sortOrder: number;[\s\S]*\};/);
});

test('shared package exports feed response contracts', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type FeedSourcesResponse = \{[\s\S]*items: FeedSource\[\];[\s\S]*total: number;[\s\S]*page: number;[\s\S]*limit: number;[\s\S]*totalPages: number;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedSourceResponse = \{[\s\S]*source: FeedSource;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedSourceAnalysisResponse = \{[\s\S]*discovery: FeedIndexDiscovery \| null;[\s\S]*analysis: FeedSourceAnalysis \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedImportRunsResponse = \{[\s\S]*items: FeedImportRun\[\];[\s\S]*total: number;[\s\S]*page: number;[\s\S]*limit: number;[\s\S]*totalPages: number;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedImportRunResponse = \{[\s\S]*run: FeedImportRun;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedUnitsResponse = \{[\s\S]*items: FeedUnit\[\];[\s\S]*total: number;[\s\S]*page: number;[\s\S]*limit: number;[\s\S]*totalPages: number;[\s\S]*hasDiscountPrices: boolean;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedUnitRoomGroupSummary = \{[\s\S]*key: string;[\s\S]*label: string;[\s\S]*total: number;[\s\S]*areaMin: string \| null;[\s\S]*areaMax: string \| null;[\s\S]*priceMin: string \| null;[\s\S]*priceMax: string \| null;[\s\S]*items: FeedUnit\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedUnitGroupSummary = \{[\s\S]*key: string;[\s\S]*label: string;[\s\S]*buildings: string\[\];[\s\S]*total: number;[\s\S]*roomGroups: FeedUnitRoomGroupSummary\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedUnitGroupsResponse = \{[\s\S]*groups: FeedUnitGroupSummary\[\];[\s\S]*total: number;[\s\S]*hasDiscountPrices: boolean;[\s\S]*\};/);
  assert.match(sharedTypes, /export type FeedUnitResponse = \{[\s\S]*unit: FeedUnit;[\s\S]*\};/);
});

test('shared object contracts include feed aggregates', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type RealEstateObjectType = 'RESIDENTIAL' \| 'COMMERCIAL';/);
  assert.match(sharedTypes, /export type RealEstateObjectBase = \{[\s\S]*type: RealEstateObjectType;[\s\S]*\};/);
  assert.match(sharedTypes, /export type RealEstateObjectBase = \{[\s\S]*aerotourUrl: string \| null;[\s\S]*layoutsUrl: string \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type RealEstateObjectBase = \{[\s\S]*feedPriceFrom: string \| null;[\s\S]*feedPricePerMeterFrom: string \| null;[\s\S]*feedAreaRange: string \| null;[\s\S]*feedFloorRange: string \| null;[\s\S]*feedUnitsCount: number \| null;[\s\S]*feedUnitsCountText: string \| null;[\s\S]*matchedFeedUnitsCount: number \| null;[\s\S]*feedCompletionYear: number \| null;[\s\S]*feedCompletionQuarter: number \| null;[\s\S]*feedUpdatedAt: string \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type MapObject = \{[\s\S]*feedPriceFrom: string \| null;[\s\S]*feedPricePerMeterFrom: string \| null;[\s\S]*feedAreaRange: string \| null;[\s\S]*feedFloorRange: string \| null;[\s\S]*feedUnitsCount: number \| null;[\s\S]*feedUnitsCountText: string \| null;[\s\S]*feedCompletionYear: number \| null;[\s\S]*feedCompletionQuarter: number \| null;[\s\S]*feedUpdatedAt: string \| null;[\s\S]*\};/);
});

test('object schema exposes residential and commercial object type', () => {
  const schema = readProjectFile(schemaPath);
  const migration = readProjectFile(objectTypeMigrationPath);

  assert.match(schema, /enum RealEstateObjectType \{[\s\S]*RESIDENTIAL\s+@map\("residential"\)[\s\S]*COMMERCIAL\s+@map\("commercial"\)[\s\S]*@@map\("real_estate_object_type"\)[\s\S]*\}/);
  assert.match(schema, /model RealEstateObject \{[\s\S]*type\s+RealEstateObjectType\s+@default\(RESIDENTIAL\)[\s\S]*\}/);
  assert.match(migration, /CREATE TYPE "real_estate_object_type" AS ENUM \('residential', 'commercial'\)/);
  assert.match(migration, /ALTER TABLE "real_estate_objects" ADD COLUMN "type" "real_estate_object_type" NOT NULL DEFAULT 'residential'/);
  assert.match(migration, /CREATE INDEX "real_estate_objects_type_idx" ON "real_estate_objects"\("type"\)/);
});

test('CatalogLinksController delegates public and admin endpoints to the service', async () => {
  const calls = [];
  const controller = new CatalogLinksController({
    listPublic: async () => {
      calls.push(['listPublic']);
      return { items: [] };
    },
    listAdmin: async () => {
      calls.push(['listAdmin']);
      return { items: [] };
    },
    updateAdmin: async (body) => {
      calls.push(['updateAdmin', body]);
      return { items: body.items };
    },
  });
  const body = { items: [{ type: 'KRT', label: 'Большое Сити', sortOrder: 0, isEnabled: true, krtName: 'Большое Сити' }] };

  await controller.list();
  await controller.listAdmin();
  const result = await controller.updateAdmin(body);

  assert.deepEqual(calls, [['listPublic'], ['listAdmin'], ['updateAdmin', body]]);
  assert.deepEqual(result, { items: body.items });
});

test('PermissionsGuard blocks regular users and editors from admin-only endpoints', () => {
  const guard = new PermissionsGuard(metadataReflector());
  const regularUserRequest = {
    headers: {},
    user: { permissions: ['objects:read'] },
  };
  const editorRequest = {
    headers: {},
    user: { permissions: ['objects:read', 'objects:create', 'objects:update', 'objects:publish'] },
  };

  assert.throws(
    () =>
      guard.canActivate(
        makeContext(regularUserRequest, UsersController.prototype.create, UsersController),
      ),
    ForbiddenException,
  );
  assert.throws(
    () =>
      guard.canActivate(
        makeContext(editorRequest, UsersController.prototype.deactivate, UsersController),
      ),
    ForbiddenException,
  );
  assert.throws(
    () =>
      guard.canActivate(
        makeContext(editorRequest, WordpressImportController.prototype.runImport, WordpressImportController),
      ),
    ForbiddenException,
  );
});

test('ObjectsController delegates catalog and admin object endpoints to the service', async () => {
  const calls = [];
  const controller = new ObjectsController({
    list: async (query) => {
      calls.push(['list', query]);
      return { items: [], total: 0 };
    },
    getBySlug: async (slug) => {
      calls.push(['getBySlug', slug]);
      return { object: { slug } };
    },
    listFeedUnits: async (id, query) => {
      calls.push(['listFeedUnits', id, query]);
      return { items: [], total: 0, page: 1, limit: 20, totalPages: 1 };
    },
    listFeedUnitGroups: async (id, query) => {
      calls.push(['listFeedUnitGroups', id, query]);
      return { groups: [], total: 0, hasDiscountPrices: false };
    },
    getFeedUnit: async (id, unitId) => {
      calls.push(['getFeedUnit', id, unitId]);
      return { unit: { id: unitId, objectId: id } };
    },
    create: async (body, actor, request) => {
      calls.push(['create', body, actor, request]);
      return { object: { id: 'object-id', ...body } };
    },
    publish: async (id, actor, request) => {
      calls.push(['publish', id, actor, request]);
      return { object: { id, status: 'PUBLISHED' } };
    },
    updateStatus: async (id, body, actor, request) => {
      calls.push(['updateStatus', id, body, actor, request]);
      return { object: { id, status: body.status } };
    },
    updateGalleryLayout: async (id, body, actor, request) => {
      calls.push(['updateGalleryLayout', id, body, actor, request]);
      return { object: { id, images: [] } };
    },
    uploadGalleryImageStream: async (id, stream, actor, request) => {
      calls.push(['uploadGalleryImageStream', id, stream, actor, request]);
      return { object: { id, images: [] }, image: { id: 'image-id' } };
    },
  });
  const request = { headers: {} };
  const galleryLayoutBody = {
    imageIds: ['22222222-2222-4222-8222-222222222222'],
    coverImageId: '22222222-2222-4222-8222-222222222222',
    imageSections: {
      '22222222-2222-4222-8222-222222222222': 'ARCHITECTURE',
    },
  };

  await controller.list({ status: 'published' });
  await controller.getBySlug('zhk-testovyy');
  await controller.listFeedUnits('object-id', { status: 'available' });
  await controller.listFeedUnitGroups('object-id', { rooms: '2' });
  await controller.getFeedUnit('object-id', 'unit-id');
  await controller.getFeedUnit('object-id', 'groups', { completionYear: '2028' });
  await controller.create({ title: 'ЖК Тестовый' }, user, request);
  await controller.publish('object-id', user, request);
  await controller.updateStatus('object-id', { status: 'ARCHIVED' }, user, request);
  await controller.updateGalleryLayout('object-id', galleryLayoutBody, user, request);
  await controller.uploadGalleryImageStream('object-id', request, user, request);

  assert.deepEqual(calls.map((call) => call[0]), [
    'list',
    'getBySlug',
    'listFeedUnits',
    'listFeedUnitGroups',
    'getFeedUnit',
    'listFeedUnitGroups',
    'create',
    'publish',
    'updateStatus',
    'updateGalleryLayout',
    'uploadGalleryImageStream',
  ]);
  assert.deepEqual(calls[0][1], { status: 'published' });
  assert.equal(calls[1][1], 'zhk-testovyy');
  assert.deepEqual(calls[2], ['listFeedUnits', 'object-id', { status: 'available' }]);
  assert.deepEqual(calls[3], ['listFeedUnitGroups', 'object-id', { rooms: '2' }]);
  assert.deepEqual(calls[4], ['getFeedUnit', 'object-id', 'unit-id']);
  assert.deepEqual(calls[5], ['listFeedUnitGroups', 'object-id', { completionYear: '2028' }]);
  assert.equal(calls[6][2], user);
  assert.equal(calls[7][1], 'object-id');
  assert.deepEqual(calls[8], ['updateStatus', 'object-id', { status: 'ARCHIVED' }, user, request]);
  assert.deepEqual(calls[9], ['updateGalleryLayout', 'object-id', galleryLayoutBody, user, request]);
  assert.deepEqual(calls[10], ['uploadGalleryImageStream', 'object-id', request, user, request]);
});

test('UsersController delegates user management endpoints to the service', async () => {
  const calls = [];
  const controller = new UsersController({
    list: async (query) => {
      calls.push(['list', query]);
      return { items: [] };
    },
    listRoles: async () => {
      calls.push(['listRoles']);
      return { items: [] };
    },
    create: async (body, actor, request) => {
      calls.push(['create', body, actor, request]);
      return { user: body };
    },
    deactivate: async (id, actor, request) => {
      calls.push(['deactivate', id, actor, request]);
    },
  });
  const request = { headers: {} };

  await controller.list({ search: 'admin' });
  await controller.listRoles();
  await controller.create({ email: 'new@example.test' }, user, request);
  await controller.deactivate('user-id', user, request);

  assert.deepEqual(calls.map((call) => call[0]), ['list', 'listRoles', 'create', 'deactivate']);
  assert.deepEqual(calls[0][1], { search: 'admin' });
  assert.equal(calls[2][2], user);
  assert.equal(calls[3][1], 'user-id');
});

test('WordpressImportController delegates preview, run and report endpoints to the service', async () => {
  const calls = [];
  const controller = new WordpressImportController({
    runImportCommand: async (mode) => {
      calls.push(['runImportCommand', mode]);
      return { report: { mode } };
    },
    listReports: async (query) => {
      calls.push(['listReports', query]);
      return { items: [] };
    },
    getReport: async (id) => {
      calls.push(['getReport', id]);
      return { report: { id } };
    },
  });

  await controller.runPreview();
  await controller.runImport();
  await controller.listReports({ mode: 'run' });
  await controller.getReport('report-id');

  assert.deepEqual(calls, [
    ['runImportCommand', 'preview'],
    ['runImportCommand', 'run'],
    ['listReports', { mode: 'run' }],
    ['getReport', 'report-id'],
  ]);
});
