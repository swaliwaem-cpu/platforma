require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { ForbiddenException, UnauthorizedException } = require('@nestjs/common');
const { UserStatus } = require('@prisma/client');

const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard.js');
const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');

function makeContext(request, handler = function handler() {}, controller = class Controller {}) {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  };
}

function makeReflector(requiredPermissions) {
  return {
    getAllAndOverride: () => requiredPermissions,
  };
}

function makeActiveUser(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@example.test',
    name: 'Admin',
    status: UserStatus.ACTIVE,
    role: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'admin',
      permissions: [
        { permission: { key: 'objects:read' } },
        { permission: { key: 'users:read' } },
      ],
    },
    ...overrides,
  };
}

test('PermissionsGuard allows public handlers without required permissions', () => {
  const guard = new PermissionsGuard(makeReflector([]));

  assert.equal(guard.canActivate(makeContext({ headers: {} })), true);
});

test('PermissionsGuard allows users with every required permission', () => {
  const guard = new PermissionsGuard(makeReflector(['objects:read', 'users:read']));
  const request = {
    headers: {},
    user: {
      permissions: ['objects:read', 'users:read', 'users:update'],
    },
  };

  assert.equal(guard.canActivate(makeContext(request)), true);
});

test('PermissionsGuard denies users with missing admin permissions', () => {
  const guard = new PermissionsGuard(makeReflector(['users:update']));
  const request = {
    headers: {},
    user: {
      permissions: ['objects:read'],
    },
  };

  assert.throws(() => guard.canActivate(makeContext(request)), ForbiddenException);
});

test('JwtAuthGuard requires bearer access token', async () => {
  const guard = new JwtAuthGuard(
    { verifyAsync: async () => ({}) },
    { user: { findFirst: async () => assert.fail('DB must not be queried without token') } },
  );

  await assert.rejects(
    () => guard.canActivate(makeContext({ headers: {} })),
    UnauthorizedException,
  );
});

test('JwtAuthGuard rejects non-access tokens', async () => {
  const guard = new JwtAuthGuard(
    { verifyAsync: async () => ({ sub: 'user-id', email: 'user@example.test', type: 'refresh' }) },
    { user: { findFirst: async () => assert.fail('DB must not be queried for wrong token type') } },
  );

  await assert.rejects(
    () => guard.canActivate(makeContext({ headers: { authorization: 'Bearer refresh-token' } })),
    UnauthorizedException,
  );
});

test('JwtAuthGuard rejects inactive or deleted users', async () => {
  let findArgs = null;
  const guard = new JwtAuthGuard(
    { verifyAsync: async () => ({ sub: '11111111-1111-4111-8111-111111111111', email: 'user@example.test', type: 'access' }) },
    {
      user: {
        findFirst: async (args) => {
          findArgs = args;
          return null;
        },
      },
    },
  );

  await assert.rejects(
    () => guard.canActivate(makeContext({ headers: { authorization: 'Bearer access-token' } })),
    UnauthorizedException,
  );
  assert.equal(findArgs.where.status, UserStatus.ACTIVE);
  assert.equal(findArgs.where.deletedAt, null);
});

test('JwtAuthGuard attaches active user permissions to the request', async () => {
  let findArgs = null;
  const request = { headers: { authorization: 'Bearer access-token' } };
  const guard = new JwtAuthGuard(
    {
      verifyAsync: async (token, options) => {
        assert.equal(token, 'access-token');
        assert.equal(options.secret, 'change-me-access-secret');

        return {
          sub: '11111111-1111-4111-8111-111111111111',
          email: 'admin@example.test',
          type: 'access',
        };
      },
    },
    {
      user: {
        findFirst: async (args) => {
          findArgs = args;
          return makeActiveUser();
        },
      },
    },
  );

  assert.equal(await guard.canActivate(makeContext(request)), true);
  assert.equal(findArgs.where.id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(request.user.permissions, ['objects:read', 'users:read']);
  assert.equal(request.user.role.name, 'admin');
});
