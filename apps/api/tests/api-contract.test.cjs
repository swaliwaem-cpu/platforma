require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException, ForbiddenException } = require('@nestjs/common');
const { UserStatus } = require('@prisma/client');

const { AuthController } = require('../dist/auth/auth.controller.js');
const { getRefreshCookieName } = require('../dist/auth/cookies.js');
const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');
const { ObjectsController } = require('../dist/objects/objects.controller.js');
const { UsersController } = require('../dist/users/users.controller.js');
const { WordpressImportController } = require('../dist/wordpress-import/wordpress-import.controller.js');

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

test('AuthController refresh rotates cookie and logout clears it', async () => {
  const calls = {};
  const controller = new AuthController({
    refresh: async (request) => {
      calls.refresh = request;

      return {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
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
  assert.deepEqual(calls.refresh, request);
  assert.deepEqual(calls.logout, request);
  assert.equal(logoutResponse.clearedCookies[0].name, getRefreshCookieName());
});

test('API controllers expose expected permission contracts', () => {
  assert.deepEqual(getPermissions(ObjectsController, 'list'), ['objects:read']);
  assert.deepEqual(getPermissions(ObjectsController, 'create'), ['objects:create']);
  assert.deepEqual(getPermissions(ObjectsController, 'publish'), ['objects:publish']);
  assert.deepEqual(getPermissions(ObjectsController, 'uploadObjectFile'), ['objects:update', 'files:upload']);
  assert.deepEqual(getPermissions(UsersController, 'create'), ['users:create']);
  assert.deepEqual(getPermissions(UsersController, 'deactivate'), ['users:delete']);
  assert.deepEqual(getPermissions(WordpressImportController, 'runPreview'), ['import:preview']);
  assert.deepEqual(getPermissions(WordpressImportController, 'runImport'), ['import:run']);
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
    create: async (body, actor, request) => {
      calls.push(['create', body, actor, request]);
      return { object: { id: 'object-id', ...body } };
    },
    publish: async (id, actor, request) => {
      calls.push(['publish', id, actor, request]);
      return { object: { id, status: 'PUBLISHED' } };
    },
  });
  const request = { headers: {} };

  await controller.list({ status: 'published' });
  await controller.getBySlug('zhk-testovyy');
  await controller.create({ title: 'ЖК Тестовый' }, user, request);
  await controller.publish('object-id', user, request);

  assert.deepEqual(calls.map((call) => call[0]), ['list', 'getBySlug', 'create', 'publish']);
  assert.deepEqual(calls[0][1], { status: 'published' });
  assert.equal(calls[1][1], 'zhk-testovyy');
  assert.equal(calls[2][2], user);
  assert.equal(calls[3][1], 'object-id');
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
