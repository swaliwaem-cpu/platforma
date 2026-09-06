require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { Prisma, PrismaClient } = require('@prisma/client');

const {
  createLocalProviderStubs,
  readPidafix2TestDatabaseUrl,
  runAssistantFixGeo1LocalStubSmoke,
  smokeCases,
} = require('../scripts/assistant-fix-geo1-live-smoke.cjs');
const configuredDatabaseUrl = process.env.ASSISTANT_PIDAFIX2_TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error('ASSISTANT_PIDAFIX2_TEST_DATABASE_URL_REQUIRED');
const databaseUrl = readPidafix2TestDatabaseUrl(configuredDatabaseUrl);

process.env.DATABASE_URL = databaseUrl;

const { AssistantUsageBudgetService } = require('../dist/assistant/operations/assistant-usage-budget.service.js');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let ledger;
const operationIds = [];

before(async () => {
  const {
    AssistantGeoUsageLedgerService,
  } = require('../dist/assistant/geo/assistant-geo-usage-ledger.service.js');
  await prisma.$connect();
  ledger = new AssistantGeoUsageLedgerService(
    prisma,
    new AssistantUsageBudgetService(prisma),
    {
      ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE: '2',
      ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE: '1',
      ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '20',
      ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '100',
      ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE: '20',
      ASSISTANT_OVERPASS_DAILY_BUDGET: '100',
    },
  );
});

after(async () => {
  if (operationIds.length > 0) {
    await prisma.assistantGeoOperation.deleteMany({ where: { id: { in: operationIds } } });
  }
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM assistant_usage_metrics
    WHERE "provider" IN ('locationiq', 'overpass')
  `);
  await prisma.$disconnect();
});

test('PIDAFIX2 atomically reserves and settles 2 LocationIQ plus 1 Overpass attempts per resolution', async () => {
  await clearUsage();
  const operationId = await createOperation();
  await ledger.runResolution(operationId, async () => {
    const first = await ledger.reserve('locationiq');
    await ledger.settle(first, { outcome: 'SUCCESS', errorCode: null, durationMs: 4 });
    const second = await ledger.reserve('locationiq');
    await ledger.settle(second, { outcome: 'ERROR', errorCode: 'ASSISTANT_GEO_PROVIDER_TIMEOUT', durationMs: 8 });

    await assert.rejects(
      ledger.reserve('locationiq'),
      (error) => error.code === 'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED',
    );

    const overpass = await ledger.reserve('overpass');
    await ledger.settle(overpass, { outcome: 'SUCCESS', errorCode: null, durationMs: 12 });
    await assert.rejects(
      ledger.reserve('overpass'),
      (error) => error.code === 'ASSISTANT_GEO_OVERPASS_RESOLUTION_BUDGET_EXHAUSTED',
    );
  });

  const attempts = await prisma.$queryRaw(Prisma.sql`
    SELECT
      "attempt_ordinal" AS "attemptOrdinal",
      "provider",
      "status",
      "outcome",
      "error_code" AS "errorCode"
    FROM assistant_geo_usage_attempts
    WHERE "operation_id" = ${operationId}::uuid
    ORDER BY "attempt_ordinal"
  `);
  assert.deepEqual(attempts, [
    { attemptOrdinal: 1, provider: 'locationiq', status: 'SETTLED', outcome: 'SUCCESS', errorCode: null },
    { attemptOrdinal: 2, provider: 'locationiq', status: 'SETTLED', outcome: 'ERROR', errorCode: 'ASSISTANT_GEO_PROVIDER_TIMEOUT' },
    { attemptOrdinal: 3, provider: 'overpass', status: 'SETTLED', outcome: 'SUCCESS', errorCode: null },
  ]);

  const operation = await prisma.assistantGeoOperation.findUniqueOrThrow({
    where: { id: operationId },
    select: { providerCallCount: true },
  });
  assert.equal(operation.providerCallCount, 3);

  const daily = await prisma.$queryRaw(Prisma.sql`
    SELECT "provider", "request_count" AS "requestCount",
      "completed_count" AS "completedCount", "error_count" AS "errorCount"
    FROM assistant_usage_metrics
    WHERE "window" = 'day'::assistant_usage_window
      AND "provider" IN ('locationiq', 'overpass')
    ORDER BY "provider"
  `);
  assert.deepEqual(daily, [
    { provider: 'locationiq', requestCount: 2, completedCount: 1, errorCount: 1 },
    { provider: 'overpass', requestCount: 1, completedCount: 1, errorCount: 0 },
  ]);
});

test('PIDAFIX2 concurrent reservations cannot overspend resolution caps', async () => {
  await clearUsage();
  const operationId = await createOperation();
  const locationIq = await ledger.runResolution(operationId, () => Promise.allSettled(
    Array.from({ length: 8 }, () => ledger.reserve('locationiq')),
  ));
  const locationIqReservations = locationIq.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const locationIqErrors = locationIq.flatMap((result) => result.status === 'rejected' ? [result.reason.code] : []);
  assert.equal(locationIqReservations.length, 2);
  assert.deepEqual(locationIqErrors, Array(6).fill('ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED'));

  const overpass = await ledger.runResolution(operationId, () => Promise.allSettled(
    Array.from({ length: 5 }, () => ledger.reserve('overpass')),
  ));
  const overpassReservations = overpass.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const overpassErrors = overpass.flatMap((result) => result.status === 'rejected' ? [result.reason.code] : []);
  assert.equal(overpassReservations.length, 1);
  assert.deepEqual(overpassErrors, Array(4).fill('ASSISTANT_GEO_OVERPASS_RESOLUTION_BUDGET_EXHAUSTED'));

  await Promise.all([...locationIqReservations, ...overpassReservations].map((reservation) => (
    ledger.settle(reservation, { outcome: 'SUCCESS', errorCode: null, durationMs: 1 })
  )));
  const [receipt] = await prisma.$queryRaw(Prisma.sql`
    SELECT
      COUNT(*)::int AS "attemptCount",
      COUNT(*) FILTER (WHERE "status" = 'SETTLED')::int AS "settledCount"
    FROM assistant_geo_usage_attempts
    WHERE "operation_id" = ${operationId}::uuid
  `);
  assert.deepEqual(receipt, { attemptCount: 3, settledCount: 3 });

  const buckets = await prisma.$queryRaw(Prisma.sql`
    SELECT "provider", "request_count" AS "requestCount"
    FROM assistant_usage_metrics
    WHERE "window" = 'day'::assistant_usage_window
      AND "provider" IN ('locationiq', 'overpass')
    ORDER BY "provider"
  `);
  assert.deepEqual(buckets, [
    { provider: 'locationiq', requestCount: 2 },
    { provider: 'overpass', requestCount: 1 },
  ]);
});

test('PIDAFIX2 real resolver uses local HTTP stubs, persisted provenance and provider TTLs', async () => {
  await clearUsage();
  const normalizedQueries = [smokeCases.ttk.canonicalQuery, smokeCases.arbat.canonicalQuery];
  await prisma.assistantGeoCache.deleteMany({ where: { normalizedQuery: { in: normalizedQueries } } });
  await prisma.assistantGeoLandmark.deleteMany({ where: { normalizedQuery: { in: normalizedQueries } } });
  await prisma.assistantGeoOperation.deleteMany({ where: { normalizedQuery: { in: normalizedQueries } } });
  const locationIqPort = await findFreePort();
  let overpassPort = await findFreePort();
  while (overpassPort === locationIqPort) overpassPort = await findFreePort();
  const locationIqUrl = new URL(`http://127.0.0.1:${locationIqPort}/v1/search`);
  const overpassUrl = new URL(`http://127.0.0.1:${overpassPort}/api/interpreter`);
  const environment = {
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
    LOCATIONIQ_API_KEY: 'pidafix2-local-stub',
    LOCATIONIQ_API_URL: locationIqUrl.toString(),
    ASSISTANT_GEO_PROVIDER_TIMEOUT_MS: '1000',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
    ASSISTANT_GEO_PROVIDER_RPS: '20',
    ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '20',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '100',
    ASSISTANT_GEO_CACHE_TTL_SECONDS: '600',
    ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE: '2',
    ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE: '1',
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: overpassUrl.toString(),
    ASSISTANT_OVERPASS_TIMEOUT_MS: '1000',
    ASSISTANT_OVERPASS_RPS: '5',
    ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE: '20',
    ASSISTANT_OVERPASS_DAILY_BUDGET: '100',
  };
  const stubs = createLocalProviderStubs({
    dummyApiKey: environment.LOCATIONIQ_API_KEY,
    locationIqUrl,
    overpassUrl,
  });
  const budgets = new AssistantUsageBudgetService(prisma);
  const {
    AssistantGeoUsageLedgerService,
  } = require('../dist/assistant/geo/assistant-geo-usage-ledger.service.js');
  const {
    LocationIqGeoProvider,
  } = require('../dist/assistant/geo/assistant-geo-provider.js');
  const {
    AssistantGeoProviderPolicyService,
  } = require('../dist/assistant/geo/assistant-geo-provider-policy.service.js');
  const {
    AssistantOverpassCollector,
  } = require('../dist/assistant/geo/assistant-overpass-collector.js');
  const {
    AssistantGeoLandmarkService,
  } = require('../dist/assistant/geo/assistant-geo-landmark.service.js');
  const {
    AssistantPlaceResolverService,
  } = require('../dist/assistant/geo/assistant-place-resolver.service.js');
  const integrationLedger = new AssistantGeoUsageLedgerService(prisma, budgets, environment);
  const policy = new AssistantGeoProviderPolicyService(
    prisma,
    new LocationIqGeoProvider(environment),
    environment,
    undefined,
    async () => {},
    budgets,
    integrationLedger,
  );
  const landmarkRepository = new AssistantGeoLandmarkService(prisma);
  const resolver = new AssistantPlaceResolverService(
    prisma,
    policy,
    landmarkRepository,
    new AssistantOverpassCollector(environment, fetch, Date.now, async () => {}, integrationLedger,
      (geometry) => landmarkRepository.isClosedRoadBoundary(geometry)),
    integrationLedger,
  );

  try {
    await stubs.start();
    stubs.setCase(smokeCases.ttk);
    const road = await resolver.resolve({ content: smokeCases.ttk.content, locale: 'ru', country: 'ru' });
    assert.equal(road.status, 'RESOLVED');
    assert.equal(road.candidates[0].kind, 'LINE');
    stubs.setCase(smokeCases.arbat);
    const area = await resolver.resolve({ content: smokeCases.arbat.content, locale: 'ru', country: 'ru' });
    assert.equal(area.status, 'RESOLVED');
    assert.equal(area.candidates[0].kind, 'AREA');

    const operations = await prisma.assistantGeoOperation.findMany({
      where: { normalizedQuery: { in: normalizedQueries } },
      orderBy: { createdAt: 'asc' },
      include: { usageAttempts: { orderBy: { attemptOrdinal: 'asc' } } },
    });
    operationIds.push(...operations.map(({ id }) => id));
    assert.equal(operations.length, 2);
    const roadOperation = operations.find(({ normalizedQuery }) => normalizedQuery === smokeCases.ttk.canonicalQuery);
    const areaOperation = operations.find(({ normalizedQuery }) => normalizedQuery === smokeCases.arbat.canonicalQuery);
    assert.deepEqual({ provider: roadOperation.provider, status: roadOperation.status, calls: roadOperation.providerCallCount },
      { provider: 'overpass', status: 'RESOLVED', calls: 3 });
    assert.deepEqual(roadOperation.usageAttempts.map(({ provider, status, outcome }) => ({ provider, status, outcome })), [
      { provider: 'locationiq', status: 'SETTLED', outcome: 'SUCCESS' },
      { provider: 'locationiq', status: 'SETTLED', outcome: 'SUCCESS' },
      { provider: 'overpass', status: 'SETTLED', outcome: 'SUCCESS' },
    ]);
    assert.deepEqual({ provider: areaOperation.provider, status: areaOperation.status, calls: areaOperation.providerCallCount },
      { provider: 'locationiq', status: 'RESOLVED', calls: 1 });
    assert.deepEqual(areaOperation.usageAttempts.map(({ provider, status, outcome }) => ({ provider, status, outcome })), [
      { provider: 'locationiq', status: 'SETTLED', outcome: 'SUCCESS' },
    ]);

    const landmarks = await prisma.assistantGeoLandmark.findMany({
      where: { normalizedQuery: { in: normalizedQueries } },
      select: { normalizedQuery: true, sourceProvider: true, expiresAt: true },
    });
    const caches = await prisma.assistantGeoCache.findMany({
      where: { normalizedQuery: { in: normalizedQueries } },
      select: { normalizedQuery: true, expiresAt: true },
    });
    const now = Date.now();
    const roadLandmark = landmarks.find(({ normalizedQuery }) => normalizedQuery === smokeCases.ttk.canonicalQuery);
    const areaLandmark = landmarks.find(({ normalizedQuery }) => normalizedQuery === smokeCases.arbat.canonicalQuery);
    const roadCache = caches.find(({ normalizedQuery }) => normalizedQuery === smokeCases.ttk.canonicalQuery);
    const areaCache = caches.find(({ normalizedQuery }) => normalizedQuery === smokeCases.arbat.canonicalQuery);
    assert.equal(roadLandmark.sourceProvider, 'overpass');
    assert.ok(roadLandmark.expiresAt.getTime() - now > 29 * 24 * 60 * 60 * 1_000);
    assert.equal(areaLandmark.sourceProvider, 'locationiq');
    assert.ok(areaLandmark.expiresAt.getTime() - now > 590_000);
    assert.ok(roadCache.expiresAt <= roadLandmark.expiresAt);
    assert.ok(areaCache.expiresAt <= areaLandmark.expiresAt);
    assert.ok(roadCache.expiresAt.getTime() - now <= 600_000);
    assert.ok(areaCache.expiresAt.getTime() - now <= 600_000);
    assert.deepEqual(stubs.readTotals(), { locationiq: 3, overpass: 1 });
  } finally {
    await stubs.close();
    await prisma.assistantGeoCache.deleteMany({ where: { normalizedQuery: { in: normalizedQueries } } });
    await prisma.assistantGeoLandmark.deleteMany({ where: { normalizedQuery: { in: normalizedQueries } } });
    await prisma.assistantGeoOperation.deleteMany({ where: { normalizedQuery: { in: normalizedQueries } } });
  }
});

test('PIDAFIX2 assembled smoke runs through local Nest HTTP, Prisma audit and provider stubs', { concurrency: false }, async () => {
  await resetDisposableGeoState();
  operationIds.length = 0;
  const apiPort = await findFreePort();
  let locationIqPort = await findFreePort();
  while (locationIqPort === apiPort) locationIqPort = await findFreePort();
  let overpassPort = await findFreePort();
  while (overpassPort === apiPort || overpassPort === locationIqPort) overpassPort = await findFreePort();
  const environment = {
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    DEPLOYMENT_ENV: 'test',
    ASSISTANT_MODULE_ENABLED: 'true',
    ASSISTANT_ROLLOUT_STAGE: 'ADMINS',
    ASSISTANT_FIX_GEO1_LOCAL_STUB_SMOKE: 'true',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
    LOCATIONIQ_API_KEY: 'pidafix2-local-stub',
    LOCATIONIQ_API_URL: `http://127.0.0.1:${locationIqPort}/v1/search`,
    ASSISTANT_GEO_PROVIDER_TIMEOUT_MS: '1000',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
    ASSISTANT_GEO_PROVIDER_RPS: '20',
    ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '20',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '100',
    ASSISTANT_GEO_CACHE_TTL_SECONDS: '600',
    ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE: '2',
    ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE: '1',
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: `http://127.0.0.1:${overpassPort}/api/interpreter`,
    ASSISTANT_OVERPASS_TIMEOUT_MS: '1000',
    ASSISTANT_OVERPASS_RPS: '5',
    ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE: '20',
    ASSISTANT_OVERPASS_DAILY_BUDGET: '100',
    ASSISTANT_AI_MODE: 'fake',
    ASSISTANT_QUERY_PLANNER_LIVE: 'false',
    ASSISTANT_EMBEDDING_MODE: 'fake',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false',
    ASSISTANT_SOURCE_WORKER_ENABLED: 'false',
    FEED_AUTO_IMPORT_ENABLED: 'false',
    TRAINING_MODULE_ENABLED: 'false',
    TRAINING_AI_MODE: 'fake',
    TELEGRAM_TRANSPORT_MODE: 'fake',
    JWT_ACCESS_SECRET: 'assistant-pidafix2-postgres-secret',
  };
  const previousEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let app;
  let role;
  let user;
  try {
    const objectsRead = await prisma.permission.upsert({
      where: { key: 'objects:read' }, update: {},
      create: { key: 'objects:read', description: 'Read objects' },
    });
    const adminAccess = await prisma.permission.upsert({
      where: { key: 'admin:access' }, update: {},
      create: { key: 'admin:access', description: 'Access admin area' },
    });
    role = await prisma.role.create({
      data: {
        name: `assistant-pidafix2-smoke-${randomUUID()}`,
        permissions: {
          create: [objectsRead.id, adminAccess.id].map((permissionId) => ({ permissionId })),
        },
      },
    });
    user = await prisma.user.create({
      data: {
        email: `assistant-pidafix2-smoke-${randomUUID()}@example.test`,
        name: 'Assistant PIDAFIX2 smoke user',
        passwordHash: 'not-used',
        roleId: role.id,
        status: 'ACTIVE',
      },
    });
    const accessToken = new JwtService().sign(
      { sub: user.id, email: user.email, type: 'access' },
      { secret: environment.JWT_ACCESS_SECRET, expiresIn: '5m' },
    );
    const { AppModule } = require('../dist/app.module.js');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(apiPort, '127.0.0.1');
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const runtimeSnapshot = {
      command: 'node apps/api/dist/main.js',
      environment: { ...environment, ASSISTANT_FIX_GEO1_LOCAL_STUB_API_URL: apiUrl },
    };
    const result = await runAssistantFixGeo1LocalStubSmoke({
      argv: [
        '--run-local-stubs',
        '--max-locationiq-attempts', '7',
        '--max-overpass-attempts', '3',
        '--max-total-attempts', '10',
      ],
      environment: {
        ASSISTANT_FIX_GEO1_LOCAL_STUB_ACCESS_TOKEN: accessToken,
        ASSISTANT_FIX_GEO1_LOCAL_STUB_API_URL: apiUrl,
      },
      runtime: { read: async () => runtimeSnapshot },
      output: { write: () => {} },
    });
    assert.deepEqual(result, {
      locationiq: 7,
      overpass: 3,
      total: 10,
      cases: ['sadovoe', 'ttk', 'mkad', 'arbat'],
    });
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [
      async () => { if (app) await app.close(); },
      resetDisposableGeoState,
      async () => { if (user) await prisma.user.deleteMany({ where: { id: user.id } }); },
      async () => { if (role) await prisma.role.deleteMany({ where: { id: role.id } }); },
    ]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'ASSISTANT_PIDAFIX2_TEST_CLEANUP_FAILED');
    }
  }
});

async function createOperation() {
  const id = randomUUID();
  operationIds.push(id);
  await prisma.assistantGeoOperation.create({
    data: {
      id,
      normalizedQuery: `pidafix2-${id}`,
      provider: 'pending',
      status: 'RUNNING',
      durationMs: 0,
      cacheHit: false,
      providerCallCount: 0,
    },
  });
  return id;
}

async function clearUsage() {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM assistant_usage_metrics
    WHERE "provider" IN ('locationiq', 'overpass')
  `);
}

async function resetDisposableGeoState() {
  await prisma.assistantGeoCache.deleteMany();
  await prisma.assistantGeoOperation.deleteMany();
  await prisma.assistantGeoLandmark.deleteMany();
  await clearUsage();
}

function findFreePort() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
