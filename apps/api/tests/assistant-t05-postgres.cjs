require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient } = require('@prisma/client');

const databaseUrl = process.env.ASSISTANT_T05_TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('ASSISTANT_T05_TEST_DATABASE_URL_REQUIRED');

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.ASSISTANT_MODULE_ENABLED = 'true';
process.env.ASSISTANT_AI_MODE = 'fake';
process.env.ASSISTANT_EMBEDDING_MODE = 'fake';
process.env.ASSISTANT_GEO_PROVIDER_MODE = 'fake';
process.env.ASSISTANT_GEO_PROVIDER_RPS = '20';
process.env.ASSISTANT_GEO_PROVIDER_DAILY_BUDGET = '100';
process.env.ASSISTANT_GEO_CACHE_TTL_SECONDS = '3600';
process.env.ASSISTANT_SOURCE_WORKER_ENABLED = 'false';
process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
process.env.TRAINING_MODULE_ENABLED = 'false';
process.env.TRAINING_AI_MODE = 'fake';
process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
process.env.JWT_ACCESS_SECRET = 'assistant-t05-postgres-secret';

const { createEmptyAssistantSearchFilters } = require('../dist/assistant/assistant-query-planner.js');
const { AssistantSearchService } = require('../dist/assistant/assistant-search.service.js');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const search = new AssistantSearchService(prisma);
const suffix = randomUUID().slice(0, 8);
const anchor = {
  latitude: 55.751244,
  longitude: 37.618423,
  label: 'Кремль',
  source: 'MANUAL',
};
const geo = { anchor, radiusMeters: 2_000 };
let fixture;

before(async () => {
  await prisma.$connect();
  fixture = await createFixture();
});

after(async () => {
  if (fixture?.source?.id) await prisma.feedSource.deleteMany({ where: { id: fixture.source.id } });
  await prisma.realEstateObject.deleteMany({
    where: { slug: { startsWith: `assistant-t05-${suffix}-` } },
  });
  if (fixture?.developer?.id) await prisma.developer.deleteMany({ where: { id: fixture.developer.id } });
  await prisma.$disconnect();
});

test('Assistant T05 radius search keeps inside and boundary FeedUnits, excludes null/outside, and orders by distance', async () => {
  const result = await search.search(createIntent({}), null, geo);

  assert.deepEqual(result.exact.map(({ unitId }) => unitId), [
    fixture.units.inside500.id,
    fixture.units.inside1000.id,
    fixture.units.boundary.id,
  ]);
  assert.deepEqual(result.exact.map(({ distanceMeters }) => Math.round(distanceMeters)), [500, 1_000, 2_000]);
  assert.deepEqual(result.geo.anchor, anchor);
  assert.equal(result.geo.radiusMeters, 2_000);
  assert.equal(result.geo.polygon.type, 'Polygon');
  assert.equal(result.geo.polygon.coordinates[0].length >= 33, true);
});

test('Assistant T05 PostGIS geography predicate includes the meter-precision boundary', async () => {
  const [boundary] = await prisma.$queryRawUnsafe(`
    WITH origin AS (
      SELECT ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography AS point
    ), projected AS (
      SELECT point, ST_Project(point, 1999.99, radians(180)) AS boundary_point FROM origin
    )
    SELECT
      ST_DWithin(point, boundary_point, 2000) AS included,
      ST_Distance(point, boundary_point) AS distance
    FROM projected
  `);
  assert.equal(boundary.included, true);
  assert.equal(Math.abs(Number(boundary.distance) - 1_999.99) < 0.001, true);
});

test('Assistant T05 radius remains a hard filter while existing lot filters are combined server-side', async () => {
  const result = await search.search(createIntent({ rooms: [2], floorMin: 7, budgetMaxRub: 19_000_000 }), null, geo);

  assert.deepEqual(result.exact.map(({ unitId }) => unitId), [fixture.units.boundary.id]);
  assert.equal(result.alternatives.every(({ distanceMeters }) => distanceMeters <= geo.radiusMeters), true);
});

test('Assistant T05 representative radius plan uses the generated geography GiST index', async () => {
  await prisma.$executeRawUnsafe(`
    INSERT INTO real_estate_objects (
      id, title, slug, status, type, latitude, longitude, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      'T05 plan object ' || value,
      'assistant-t05-${suffix}-plan-' || value,
      'published'::object_status,
      'residential'::real_estate_object_type,
      54 + ((value % 1000)::numeric / 1000),
      36 + ((value % 997)::numeric / 1000),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM generate_series(1, 12000) AS value
  `);
  await prisma.$executeRawUnsafe('ANALYZE real_estate_objects');
  const planRows = await prisma.$queryRawUnsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id
    FROM real_estate_objects
    WHERE search_point IS NOT NULL
      AND ST_DWithin(
        search_point,
        ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography,
        2000
      )
  `);
  const plan = planRows[0]['QUERY PLAN'][0].Plan;

  assert.equal(findPlanIndex(plan, 'real_estate_objects_search_point_gist'), true);
  assert.equal(readPlanBuffers(plan) > 0, true);
});

test('Assistant T05 persists confirmed geo separately and serializes one grounded radius run', { concurrency: false }, async () => {
  const { AppModule } = require('../dist/app.module.js');
  const permission = await prisma.permission.upsert({
    where: { key: 'objects:read' },
    update: {},
    create: { key: 'objects:read', description: 'Read objects' },
  });
  const role = await prisma.role.create({
    data: {
      name: `assistant-t05-role-${suffix}`,
      permissions: { create: { permissionId: permission.id } },
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `assistant-t05-${suffix}@example.test`,
      name: 'Assistant T05 user',
      passwordHash: 'not-used',
      roleId: role.id,
      status: 'ACTIVE',
    },
  });
  const token = new JwtService().sign(
    { sub: user.id, email: user.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await httpJson(baseUrl, '/assistant/conversations', {
      method: 'POST',
      token,
      idempotencyKey: randomUUID(),
    });
    assert.equal(created.status, 201);
    const queued = await httpJson(
      baseUrl,
      `/assistant/conversations/${created.body.conversation.id}/messages`,
      {
        method: 'POST',
        token,
        idempotencyKey: randomUUID(),
        body: {
          content: 'Найди 2-комнатную квартиру до 25 млн рядом с выбранной точкой',
          context: null,
          geo,
        },
      },
    );
    assert.equal(queued.status, 202);
    const run = await waitForRun(baseUrl, queued.body.run.id, token);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.assistantMessage.answer.kind, 'SEARCH_RESULTS');
    assert.deepEqual(
      run.assistantMessage.answer.exactResults.map(({ unitId }) => unitId),
      [fixture.units.inside500.id, fixture.units.boundary.id],
    );
    assert.deepEqual(
      run.assistantMessage.answer.exactResults.map(({ distanceMeters }) => Math.round(distanceMeters)),
      [500, 2_000],
    );
    assert.deepEqual(run.assistantMessage.answer.geo.anchor, anchor);
    assert.equal(run.assistantMessage.answer.geo.radiusMeters, 2_000);
    assert.deepEqual(
      run.assistantMessage.answer.geo.markers.map(({ unitId, kind }) => [unitId, kind]),
      [
        [fixture.units.inside500.id, 'PRIMARY'],
        [fixture.units.boundary.id, 'PRIMARY'],
      ],
    );

    const detail = await httpJson(
      baseUrl,
      `/assistant/conversations/${created.body.conversation.id}`,
      { token },
    );
    assert.deepEqual(detail.body.conversation.messages[0].geo, geo);
    assert.deepEqual(detail.body.conversation.messages[1].answer.geo, run.assistantMessage.answer.geo);
    assert.equal(JSON.stringify(detail.body).includes('search_point'), false);
  } finally {
    await app.close();
    await prisma.assistantRun.deleteMany({ where: { ownerUserId: user.id } });
    await prisma.assistantMessage.deleteMany({ where: { conversation: { ownerUserId: user.id } } });
    await prisma.assistantConversation.deleteMany({ where: { ownerUserId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.role.delete({ where: { id: role.id } });
  }
});

test('Assistant T05 alias registry is permission-gated, separate from cache, and bypasses provider credits', { concurrency: false }, async () => {
  const { AppModule } = require('../dist/app.module.js');
  const objectsRead = await prisma.permission.upsert({
    where: { key: 'objects:read' },
    update: {},
    create: { key: 'objects:read', description: 'Read objects' },
  });
  const manageAliases = await prisma.permission.upsert({
    where: { key: 'assistant:sources:manage' },
    update: {},
    create: { key: 'assistant:sources:manage', description: 'Manage assistant sources' },
  });
  const readRole = await prisma.role.create({
    data: {
      name: `assistant-t05-read-${suffix}`,
      permissions: { create: { permissionId: objectsRead.id } },
    },
  });
  const adminRole = await prisma.role.create({
    data: {
      name: `assistant-t05-admin-${suffix}`,
      permissions: {
        create: [objectsRead.id, manageAliases.id].map((permissionId) => ({ permissionId })),
      },
    },
  });
  const [readUser, adminUser] = await Promise.all([
    prisma.user.create({
      data: {
        email: `assistant-t05-read-${suffix}@example.test`,
        name: 'Assistant T05 read user',
        passwordHash: 'not-used',
        roleId: readRole.id,
        status: 'ACTIVE',
      },
    }),
    prisma.user.create({
      data: {
        email: `assistant-t05-admin-${suffix}@example.test`,
        name: 'Assistant T05 admin user',
        passwordHash: 'not-used',
        roleId: adminRole.id,
        status: 'ACTIVE',
      },
    }),
  ]);
  const jwt = new JwtService();
  const readToken = jwt.sign(
    { sub: readUser.id, email: readUser.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const adminToken = jwt.sign(
    { sub: adminUser.id, email: adminUser.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const query = `Плотинка QA ${suffix}`;

  try {
    const denied = await httpJson(baseUrl, '/assistant/geo/aliases', {
      method: 'POST',
      token: readToken,
      body: {
        query,
        locale: 'ru',
        country: 'ru',
        candidate: {
          label: 'Плотинка, Екатеринбург',
          latitude: 56.8377,
          longitude: 60.6038,
          city: 'Екатеринбург',
          countryCode: 'ru',
        },
      },
    });
    assert.equal(denied.status, 403);

    const saved = await httpJson(baseUrl, '/assistant/geo/aliases', {
      method: 'POST',
      token: adminToken,
      body: {
        query,
        locale: 'ru',
        country: 'ru',
        candidate: {
          label: 'Плотинка, Екатеринбург',
          latitude: 56.8377,
          longitude: 60.6038,
          city: 'Екатеринбург',
          countryCode: 'ru',
        },
      },
    });
    assert.equal(saved.status, 201);

    const usageBefore = await prisma.assistantGeoProviderDailyUsage.aggregate({
      _sum: { requestCount: true },
    });
    const resolved = await httpJson(baseUrl, '/assistant/geo/resolve', {
      method: 'POST',
      token: readToken,
      body: {
        content: `Найди квартиру в радиусе 2 км от ${query}`,
        locale: 'ru',
        country: 'ru',
      },
    });
    assert.equal(resolved.status, 201);
    assert.equal(resolved.body.status, 'RESOLVED');
    assert.equal(resolved.body.candidates[0].source, 'ALIAS');
    const usageAfter = await prisma.assistantGeoProviderDailyUsage.aggregate({
      _sum: { requestCount: true },
    });
    assert.equal(usageAfter._sum.requestCount, usageBefore._sum.requestCount);
    assert.equal(await prisma.assistantGeoCache.count({
      where: { normalizedQuery: { contains: suffix } },
    }), 0);

    const deleted = await httpJson(
      baseUrl,
      `/assistant/geo/aliases/${saved.body.alias.id}`,
      { method: 'DELETE', token: adminToken },
    );
    assert.equal(deleted.status, 200);
  } finally {
    await app.close();
    await prisma.assistantGeoAlias.deleteMany({ where: { createdByUserId: adminUser.id } });
    await prisma.user.deleteMany({ where: { id: { in: [readUser.id, adminUser.id] } } });
    await prisma.role.deleteMany({ where: { id: { in: [readRole.id, adminRole.id] } } });
  }
});

async function createFixture() {
  const developer = await prisma.developer.create({ data: { name: `T05 developer ${suffix}` } });
  const coordinates = await prisma.$queryRawUnsafe(`
    SELECT label,
      ST_Y(point::geometry) AS latitude,
      ST_X(point::geometry) AS longitude
    FROM (
      VALUES
        ('inside500', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 500, radians(0))),
        ('inside1000', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 1000, radians(90))),
        ('boundary', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 1999.5, radians(180))),
        ('outside', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 2100, radians(270)))
    ) AS points(label, point)
  `);
  const objects = {};
  for (const coordinate of coordinates) {
    objects[coordinate.label] = await prisma.realEstateObject.create({
      data: {
        title: `T05 ${coordinate.label} ${suffix}`,
        slug: `assistant-t05-${suffix}-${coordinate.label}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        developerId: developer.id,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
      },
    });
  }
  objects.nullCoordinates = await prisma.realEstateObject.create({
    data: {
      title: `T05 null ${suffix}`,
      slug: `assistant-t05-${suffix}-null`,
      status: 'PUBLISHED',
      type: 'RESIDENTIAL',
      developerId: developer.id,
    },
  });

  const source = await prisma.feedSource.create({
    data: {
      url: `https://example.test/t05-${suffix}.xml`,
      format: 'CIAN_XML',
      developerId: developer.id,
      isActive: true,
    },
  });
  const unitInput = [
    ['inside500', 2, 20_000_000, 5],
    ['inside1000', 3, 10_000_000, 9],
    ['boundary', 2, 18_000_000, 10],
    ['outside', 2, 12_000_000, 12],
    ['nullCoordinates', 2, 11_000_000, 8],
  ];
  const units = {};
  for (const [key, rooms, price, floor] of unitInput) {
    units[key] = await prisma.feedUnit.create({
      data: {
        sourceId: source.id,
        objectId: objects[key].id,
        externalId: `assistant-t05-${suffix}-${key}`,
        type: 'RESIDENTIAL',
        status: 'AVAILABLE',
        title: key,
        rooms,
        effectivePrice: price,
        area: 60,
        floor,
      },
    });
  }
  return { developer, objects, source, units };
}

function createIntent(overrides) {
  return {
    taskType: 'SEARCH',
    comparisonTargets: [],
    hardFilters: { ...createEmptyAssistantSearchFilters(), ...overrides },
    softPreferences: createEmptyAssistantSearchFilters(),
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
}

function findPlanIndex(node, indexName) {
  if (!node || typeof node !== 'object') return false;
  if (node['Index Name'] === indexName) return true;
  return Array.isArray(node.Plans) && node.Plans.some((child) => findPlanIndex(child, indexName));
}

function readPlanBuffers(node) {
  if (!node || typeof node !== 'object') return 0;
  const local = Number(node['Shared Hit Blocks'] ?? 0) + Number(node['Shared Read Blocks'] ?? 0);
  return local + (Array.isArray(node.Plans)
    ? node.Plans.reduce((sum, child) => sum + readPlanBuffers(child), 0)
    : 0);
}

async function httpJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function waitForRun(baseUrl, runId, token) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await httpJson(baseUrl, `/assistant/runs/${runId}`, { token });
    if (response.body.run.status === 'COMPLETED' || response.body.run.status === 'FAILED') {
      return response.body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('ASSISTANT_T05_RUN_TIMEOUT');
}
