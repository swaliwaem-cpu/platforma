require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectStatus, UserStatus } = require('@prisma/client');

const { AuthController } = require('../dist/auth/auth.controller.js');
const { ObjectsController } = require('../dist/objects/objects.controller.js');
const { WordpressImportController } = require('../dist/wordpress-import/wordpress-import.controller.js');

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

function makeAdminUser() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@example.test',
    name: 'Admin',
    status: UserStatus.ACTIVE,
    role: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'admin',
    },
    permissions: [
      'objects:read',
      'objects:create',
      'objects:update',
      'objects:publish',
      'users:read',
      'users:create',
      'users:update',
      'users:delete',
      'import:preview',
      'import:run',
    ],
  };
}

test('smoke: login -> admin creates object -> publish -> catalog -> object details', async () => {
  const admin = makeAdminUser();
  const authController = new AuthController({
    login: async (email, password) => {
      assert.equal(email, 'admin@example.test');
      assert.equal(password, 'correct-password');

      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: admin,
      };
    },
  });

  let storedObject = null;
  const objectsController = new ObjectsController({
    create: async (body, actor) => {
      assert.equal(actor.id, admin.id);
      storedObject = {
        id: '33333333-3333-4333-8333-333333333333',
        title: body.title,
        slug: 'zhk-smoke',
        status: ObjectStatus.DRAFT,
        latitude: null,
        longitude: null,
      };

      return { object: storedObject };
    },
    publish: async (id, actor) => {
      assert.equal(id, storedObject.id);
      assert.equal(actor.id, admin.id);
      storedObject = {
        ...storedObject,
        status: ObjectStatus.PUBLISHED,
        latitude: 55.751244,
        longitude: 37.618423,
      };

      return { object: storedObject };
    },
    list: async (query) => {
      assert.equal(query.status, 'published');

      return {
        items: storedObject?.status === ObjectStatus.PUBLISHED ? [storedObject] : [],
        total: storedObject?.status === ObjectStatus.PUBLISHED ? 1 : 0,
        page: 1,
        limit: 20,
        totalPages: 1,
      };
    },
    getBySlug: async (slug) => {
      assert.equal(slug, storedObject.slug);

      return { object: storedObject };
    },
  });

  const login = await authController.login(
    { email: 'admin@example.test', password: 'correct-password' },
    makeResponse(),
  );
  const request = { headers: { authorization: `Bearer ${login.accessToken}` } };
  const created = await objectsController.create({ title: 'ЖК Smoke' }, login.user, request);
  const published = await objectsController.publish(created.object.id, login.user, request);
  const catalog = await objectsController.list({ status: 'published' });
  const details = await objectsController.getBySlug(catalog.items[0].slug);

  assert.equal(created.object.status, ObjectStatus.DRAFT);
  assert.equal(published.object.status, ObjectStatus.PUBLISHED);
  assert.equal(catalog.total, 1);
  assert.equal(details.object.slug, 'zhk-smoke');
  assert.equal(details.object.latitude, 55.751244);
});

test('smoke: import preview -> import run -> repeated import run stays idempotent', async () => {
  const reports = [];
  const importedWpPostIds = new Set();
  const controller = new WordpressImportController({
    runImportCommand: async (mode) => {
      if (mode === 'preview') {
        const report = {
          id: 'preview-report',
          mode: 'PREVIEW',
          status: 'SUCCESS',
          summaryJson: {
            dryRun: true,
            objectsFound: 2,
            objectsCreated: 0,
            objectsUpdated: 0,
            objectsFailed: 0,
          },
        };
        reports.push(report);

        return { report };
      }

      const created = [101, 102].filter((wpPostId) => !importedWpPostIds.has(wpPostId));

      for (const wpPostId of created) {
        importedWpPostIds.add(wpPostId);
      }

      const report = {
        id: `run-report-${reports.length}`,
        mode: 'RUN',
        status: 'SUCCESS',
        summaryJson: {
          dryRun: false,
          objectsFound: 2,
          objectsCreated: created.length,
          objectsUpdated: 2 - created.length,
          objectsFailed: 0,
        },
      };
      reports.push(report);

      return { report };
    },
    listReports: async () => ({ items: reports }),
  });

  const preview = await controller.runPreview();
  const firstRun = await controller.runImport();
  const secondRun = await controller.runImport();
  const reportList = await controller.listReports({});

  assert.equal(preview.report.summaryJson.dryRun, true);
  assert.equal(firstRun.report.summaryJson.objectsCreated, 2);
  assert.equal(firstRun.report.summaryJson.objectsUpdated, 0);
  assert.equal(secondRun.report.summaryJson.objectsCreated, 0);
  assert.equal(secondRun.report.summaryJson.objectsUpdated, 2);
  assert.equal(importedWpPostIds.size, 2);
  assert.equal(reportList.items.length, 3);
});

test('smoke: catalog and details tolerate missing coordinates', async () => {
  const objectWithoutCoordinates = {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'ЖК Без координат',
    slug: 'zhk-bez-koordinat',
    status: ObjectStatus.PUBLISHED,
    latitude: null,
    longitude: null,
  };
  const controller = new ObjectsController({
    list: async () => ({
      items: [objectWithoutCoordinates],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    }),
    getBySlug: async () => ({ object: objectWithoutCoordinates }),
  });

  const catalog = await controller.list({ hasCoordinates: 'false' });
  const details = await controller.getBySlug(catalog.items[0].slug);

  assert.equal(catalog.items[0].latitude, null);
  assert.equal(catalog.items[0].longitude, null);
  assert.equal(details.object.slug, 'zhk-bez-koordinat');
});
