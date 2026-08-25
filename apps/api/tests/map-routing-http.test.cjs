require('reflect-metadata');

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');

const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard.js');
const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');
const { MapController } = require('../dist/map/map.controller.js');
const { MapRoutingService } = require('../dist/map/map-routing.service.js');
const { MapService } = require('../dist/map/map.service.js');
const { PrismaService } = require('../dist/prisma/prisma.service.js');

test('walking routes HTTP endpoint enforces auth, objects:read and server-side validation', { concurrency: false }, async () => {
  let providerCalls = 0;
  const providerServer = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      providerCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          providerCalls === 1
            ? { distances: [[920]], durations: [[680]] }
            : { distances: [[980]], durations: [[720]] },
        ),
      );
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const providerAddress = providerServer.address();
  assert.equal(typeof providerAddress, 'object');

  const previousEnvironment = captureEnvironment([
    'JWT_ACCESS_SECRET',
    'OPENROUTESERVICE_API_KEY',
    'OPENROUTESERVICE_API_URL',
    'OPENROUTESERVICE_MAX_RETRIES',
  ]);
  process.env.JWT_ACCESS_SECRET = 'map-routing-http-secret';
  process.env.OPENROUTESERVICE_API_KEY = 'map-routing-http-provider-key';
  process.env.OPENROUTESERVICE_API_URL = `http://127.0.0.1:${providerAddress.port}`;
  process.env.OPENROUTESERVICE_MAX_RETRIES = '0';

  const users = new Map([
    ['allowed-user', makeUser('allowed-user', ['objects:read'])],
    ['admin-user', makeUser('admin-user', ['objects:read', 'admin:access'])],
    ['denied-user', makeUser('denied-user', [])],
  ]);
  const routeCache = new Map();
  const prisma = {
    user: {
      findFirst: async ({ where }) => users.get(where.id) ?? null,
    },
    mapWalkingRouteCache: {
      findMany: async ({ where }) =>
        [...new Set(where.cacheKey.in)].flatMap((cacheKey) =>
          routeCache.has(cacheKey) ? [routeCache.get(cacheKey)] : [],
        ),
      upsert: async ({ where, create, update }) => {
        const value = routeCache.has(where.cacheKey)
          ? { ...routeCache.get(where.cacheKey), ...update }
          : { ...create };
        routeCache.set(where.cacheKey, value);
        return value;
      },
    },
    $transaction: async (operations) => Promise.all(operations),
  };

  class MapRoutingHttpTestModule {}
  Module({
    controllers: [MapController],
    providers: [
      JwtService,
      JwtAuthGuard,
      PermissionsGuard,
      MapRoutingService,
      { provide: PrismaService, useValue: prisma },
      { provide: MapService, useValue: { listObjects: async () => ({ items: [], total: 0 }) } },
    ],
  })(MapRoutingHttpTestModule);

  const jwt = new JwtService();
  const allowedToken = jwt.sign(
    { sub: 'allowed-user', email: 'allowed@example.test', type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const deniedToken = jwt.sign(
    { sub: 'denied-user', email: 'denied@example.test', type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const adminToken = jwt.sign(
    { sub: 'admin-user', email: 'admin@example.test', type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  let app;

  try {
    app = await NestFactory.create(MapRoutingHttpTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const appAddress = app.getHttpServer().address();
    assert.equal(typeof appAddress, 'object');
    const baseUrl = `http://127.0.0.1:${appAddress.port}`;
    const validBody = {
      origin: [55.75, 37.61],
      destinations: [[55.76, 37.62]],
    };

    assert.equal((await request(baseUrl, validBody)).status, 401);
    assert.equal((await request(baseUrl, validBody, deniedToken)).status, 403);

    const allowed = await request(baseUrl, validBody, allowedToken);
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, {
      routes: [{ destinationIndex: 0, distanceMeters: 920, durationSeconds: 680 }],
    });

    const invalid = await request(baseUrl, { origin: [95, 37.61], destinations: [[55.76, 37.62]] }, allowedToken);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.message, 'Origin coordinates are invalid');

    assert.equal((await request(baseUrl, validBody, undefined, '/map/walking-routes/refresh')).status, 401);
    assert.equal((await request(baseUrl, validBody, allowedToken, '/map/walking-routes/refresh')).status, 403);
    assert.deepEqual(await request(baseUrl, validBody, adminToken, '/map/walking-routes/refresh'), {
      status: 200,
      body: { routes: [{ destinationIndex: 0, distanceMeters: 980, durationSeconds: 720 }] },
    });
    assert.equal(providerCalls, 2);
  } finally {
    await app?.close();
    await new Promise((resolve, reject) => providerServer.close((error) => (error ? reject(error) : resolve())));
    restoreCapturedEnvironment(previousEnvironment);
  }
});

async function request(baseUrl, body, token, pathname = '/map/walking-routes') {
  const response = await fetch(`${baseUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    method: 'POST',
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function makeUser(id, permissions) {
  return {
    id,
    email: `${id}@example.test`,
    name: id,
    brokerPhone: null,
    brokerEmail: null,
    status: 'ACTIVE',
    role: {
      id: `${id}-role`,
      name: 'user',
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
    profilePhotoFile: null,
  };
}

function captureEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreCapturedEnvironment(environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
