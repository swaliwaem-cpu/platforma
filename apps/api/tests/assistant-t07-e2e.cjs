require('reflect-metadata');

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { deflateSync } = require('node:zlib');
const { hash } = require('argon2');
const { NestFactory } = require('@nestjs/core');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright-core');
const {
  computeAssistantRolloutApprovalDigest,
} = require('../dist/assistant/rollout/assistant-rollout-preflight.js');
const {
  loadAssistantEvalRunRecordsByIds,
} = require('../scripts/assistant-eval-runtime.cjs');
const {
  createT07OwnershipFilters,
  installTerminationHandlers,
  removeT07OwnedDockerResources,
  runCommand: runRuntimeCommand,
} = require('../scripts/assistant-pidafix3-runtime.cjs');

const lineReferenceGeometry = {
  type: 'LineString',
  coordinates: [
    [37.5804, 55.7663],
    [37.6216, 55.7765],
    [37.6576, 55.7554],
    [37.6427, 55.7243],
    [37.6004, 55.7175],
    [37.5741, 55.7412],
    [37.5804, 55.7663],
  ],
};
const areaReferenceGeometry = {
  type: 'Polygon',
  coordinates: [[
    [37.565, 55.744],
    [37.603, 55.744],
    [37.606, 55.763],
    [37.571, 55.765],
    [37.565, 55.744],
  ]],
};

const root = resolve(__dirname, '../../..');
const apiRoot = resolve(root, 'apps/api');
const webRoot = resolve(root, 'apps/web');
const prismaRoot = resolve(apiRoot, 'prisma');
const resourceSuffix = process.env.ASSISTANT_T07_RESOURCE_SUFFIX ?? randomUUID().slice(0, 8);
assert.match(resourceSuffix, /^[a-f0-9]{8}$/u, 'ASSISTANT_T07_RESOURCE_SUFFIX_INVALID');
const parentProject = process.env.ASSISTANT_T07_PARENT_PROJECT ?? null;
if (parentProject !== null) {
  assert.match(parentProject, /^platforma-pidafix3-[a-f0-9]{8}$/u, 'ASSISTANT_T07_PARENT_PROJECT_INVALID');
}
const dockerOwnership = createT07OwnershipFilters(resourceSuffix);
const dockerResourceLabels = [
  '--label', dockerOwnership.label,
  ...(parentProject ? ['--label', `com.platforma.assistant-t07.parent=${parentProject}`] : []),
];
const container = `platforma-assistant-t07-${resourceSuffix}`;
const network = `${container}-network`;
const databasePassword = `assistant-t07-${randomUUID()}`;
const apiImage = process.env.ASSISTANT_T07_API_IMAGE || 'platforma-api:local';
const postgresImage = process.env.ASSISTANT_T07_POSTGRES_IMAGE || 'platforma-postgres:16-postgis3.5-pgvector0.8.6';
const password = 'AssistantT07!';
const manualQaEnabled = process.env.ASSISTANT_T07_MANUAL_QA_HOLD === 'true';
let postgresPort;
let apiOrigin;
let webOrigin;
let prisma;
let apiApp;
let browser;
let sourceServer;
let sourceRequests = [];
let providerStubRequests = { openai: 0, locationiq: 0, overpass: 0 };
let deniedOutboundRequests = [];
const originalFetch = globalThis.fetch;
let webProcess;
let cleanupPromise = null;

const termination = installTerminationHandlers({
  onSignal: () => { void cleanup().catch(() => {}); },
});
void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = termination.exitCode ?? 1;
}).finally(() => termination.dispose());

async function main() {
  let primaryError = null;
  try {
    if (process.env.ASSISTANT_T07_SKIP_DOCKER_BUILD !== 'true') {
      await run('docker', ['compose', 'build', 'postgres', 'api'], { timeout: 300_000 });
    }
    postgresPort = await reservePort();
    await run('docker', ['network', 'create', ...dockerResourceLabels, network]);
    await startPostgres();
    await verifyMigrationReplay();
    configureSafeEnvironment(databaseUrl('platforma'));
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl('platforma') } } });
    await prisma.$connect();
    const sourceOrigin = await startSourceStub();
    configureProviderStubs(sourceOrigin);
    installOutboundDenyHook();
    const fixtures = await seed(sourceOrigin);

    const { AppModule } = require('../dist/app.module.js');
    apiApp = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    const apiPort = await reservePort();
    const webPort = await reservePort();
    apiOrigin = `http://127.0.0.1:${apiPort}`;
    webOrigin = `http://127.0.0.1:${webPort}`;
    process.env.WEB_ORIGIN = webOrigin;
    apiApp.enableCors({ origin: webOrigin, credentials: true });
    await apiApp.listen(apiPort, '127.0.0.1');
    assert.deepEqual(new Set((await prisma.assistantRolloutEvent.findMany({
      select: { stage: true },
    })).map(({ stage }) => stage)), new Set(['ADMINS', 'PILOT', 'ALL']));
    await assert.rejects(
      () => prisma.assistantRolloutEvent.updateMany({
        where: { stage: 'ADMINS' },
        data: { startedAt: new Date() },
      }),
      /ASSISTANT_ROLLOUT_EVENTS_ARE_IMMUTABLE/u,
    );
    await ingestSource(fixtures.admin.user.id, sourceOrigin);
    await startWeb(webPort, sourceOrigin);
    browser = await chromium.launch({ headless: true });

    const journey = await userJourney(fixtures);
    const [loadedEvalRun] = await loadAssistantEvalRunRecordsByIds(
      prisma,
      [journey.exactRun.id],
    );
    const persistedAssistantMessage = await prisma.assistantMessage.findFirstOrThrow({
      where: { assistantRun: { id: journey.exactRun.id } },
      select: { content: true, answerJson: true },
    });
    assert.equal(loadedEvalRun.answer.content, persistedAssistantMessage.content);
    assert.equal(loadedEvalRun.answer.kind, persistedAssistantMessage.answerJson.kind);
    await alternativeGeoJourney(fixtures, journey.primaryMarkerColor);
    await securityJourney(fixtures, journey);
    await adminJourney(fixtures, journey);
    await mobileJourney(fixtures);
    await mapDegradationJourney(fixtures, 'style');
    await mapDegradationJourney(fixtures, 'tile');
    fixtures.connectedGeo = await seedConnectedGeoFixtures(fixtures.connectedGeoSeed);
    await lineGeoJourney(fixtures);
    await areaGeoJourney(fixtures);
    await holdForManualQa(fixtures.regular.user.email);
    assert.equal(sourceRequests.length >= 1, true, 'stub source connector was not used');
    await writeProviderEvidence(await assertOutboundProviderIsolation());
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], 'ASSISTANT_T07_E2E_AND_CLEANUP_FAILED');
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  process.stdout.write('ASSISTANT_T07_E2E_OK\n');
}

async function startPostgres() {
  await run('docker', [
    'run', '--detach', '--rm', ...dockerResourceLabels, '--name', container, '--platform', 'linux/amd64',
    '--env', 'POSTGRES_DB=platforma', '--env', 'POSTGRES_USER=platforma',
    '--env', 'POSTGRES_PASSWORD', '--network', network,
    '--network-alias', 'postgres',
    '--publish', `127.0.0.1:${postgresPort}:5432`,
    postgresImage,
  ], { env: { POSTGRES_PASSWORD: databasePassword } });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await run('docker', [
      'exec', container, 'pg_isready', '--host', '127.0.0.1',
      '--username', 'platforma', '--dbname', 'platforma',
    ], { allowFailure: true, timeout: 5_000 });
    if (ready.status === 0) return;
    await delay(250);
  }
  throw new Error('ASSISTANT_T07_POSTGRES_NOT_READY');
}

async function verifyMigrationReplay() {
  await migrate(prismaRoot, internalDatabaseUrl('platforma'));
  await migrationStatus(prismaRoot, internalDatabaseUrl('platforma'));
  await run('docker', ['exec', container, 'createdb', '--username', 'platforma', 'platforma_upgrade']);
  const temporary = await createPreGeoPrisma();
  try {
    await migrate(temporary, internalDatabaseUrl('platforma_upgrade'));
    await run('docker', [
      'exec', container, 'psql', '--username', 'platforma', '--dbname', 'platforma_upgrade',
      '--set', 'ON_ERROR_STOP=1', '--command', [
        'INSERT INTO real_estate_objects',
        '(id, title, slug, status, type, latitude, longitude, created_at, updated_at)',
        "VALUES (gen_random_uuid(), 'T07 upgrade object', 't07-upgrade-object', 'published',",
        "'residential', 55.751244, 37.618423, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      ].join(' '),
    ]);
    await migrate(prismaRoot, internalDatabaseUrl('platforma_upgrade'));
    await migrationStatus(prismaRoot, internalDatabaseUrl('platforma_upgrade'));
    const upgrade = new PrismaClient({ datasources: { db: { url: databaseUrl('platforma_upgrade') } } });
    try {
      const [row] = await upgrade.$queryRawUnsafe(`
        SELECT latitude::text, longitude::text,
          search_point IS NOT NULL AS "hasSearchPoint",
          ST_SRID(search_point::geometry) AS srid
        FROM real_estate_objects WHERE slug = 't07-upgrade-object'
      `);
      assert.deepEqual(row, {
        latitude: '55.751244', longitude: '37.618423', hasSearchPoint: true, srid: 4326,
      });
    } finally {
      await upgrade.$disconnect();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function createPreGeoPrisma() {
  const target = await mkdtemp(join(tmpdir(), 'platforma-t07-prisma-'));
  await mkdir(resolve(target, 'migrations'));
  await cp(resolve(prismaRoot, 'schema.prisma'), resolve(target, 'schema.prisma'));
  await cp(resolve(prismaRoot, 'migrations/migration_lock.toml'), resolve(target, 'migrations/migration_lock.toml'));
  const entries = await readdir(resolve(prismaRoot, 'migrations'), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name >= '20260826120000_add_assistant_t05_geo_search') continue;
    await cp(resolve(prismaRoot, 'migrations', entry.name), resolve(target, 'migrations', entry.name), {
      recursive: true,
    });
  }
  return target;
}

function migrate(directory, url) {
  return run('docker', [
    'run', '--rm', ...dockerResourceLabels, '--network', network,
    '--env', 'DATABASE_URL',
    '--volume', `${directory}:/app/apps/api/prisma:ro`,
    apiImage,
    'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'deploy',
    '--schema', '/app/apps/api/prisma/schema.prisma',
  ], { env: { DATABASE_URL: url }, timeout: 120_000 });
}

function migrationStatus(directory, url) {
  return run('docker', [
    'run', '--rm', ...dockerResourceLabels, '--network', network,
    '--env', 'DATABASE_URL',
    '--volume', `${directory}:/app/apps/api/prisma:ro`,
    apiImage,
    'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'status',
    '--schema', '/app/apps/api/prisma/schema.prisma',
  ], { env: { DATABASE_URL: url }, timeout: 60_000 });
}

function configureSafeEnvironment(url) {
  Object.assign(process.env, {
    DATABASE_URL: url, NODE_ENV: 'test', FEED_AUTO_IMPORT_ENABLED: 'false',
    TRAINING_MODULE_ENABLED: 'false', TRAINING_AI_MODE: 'fake', TELEGRAM_TRANSPORT_MODE: 'fake',
    ASSISTANT_MODULE_ENABLED: 'true', ASSISTANT_ROLLOUT_STAGE: 'ALL', ASSISTANT_AI_MODE: 'fake',
    ASSISTANT_EMBEDDING_MODE: 'fake', ASSISTANT_FAKE_STEP_DELAY_MS: '500',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true', ASSISTANT_GEO_PROVIDER_MODE: 'fake',
    ASSISTANT_GEO_PROVIDER_RPS: '20', ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '100',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '1000', ASSISTANT_GEO_CACHE_TTL_SECONDS: '3600',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'true', ASSISTANT_SOURCE_WORKER_ENABLED: 'false',
    ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS: 'true', ASSISTANT_MODEL_REQUESTS_PER_MINUTE: '100',
    ASSISTANT_MODEL_REQUESTS_PER_DAY: '1000', JWT_ACCESS_SECRET: 'assistant-t07-local-access-secret',
    JWT_REFRESH_SECRET: 'assistant-t07-local-refresh-secret', S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'test-only', S3_SECRET_ACCESS_KEY: 'test-only', MINIO_BUCKET: 'assistant-t07',
  });
  delete process.env.OPENAI_API_KEY;
  delete process.env.LOCATIONIQ_API_KEY;
  delete process.env.OPENROUTESERVICE_API_KEY;
}

async function startSourceStub() {
  const html = await readFile(resolve(__dirname, 'fixtures/assistant/official-development.html'));
  const mapTile = createDeterministicMapTile();
  sourceServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const provider = Object.keys(providerStubRequests).find((key) => (
      pathname.startsWith(`/__provider_stub__/${key}`)
    ));
    if (provider) {
      providerStubRequests[provider] += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"provider transport is disabled in ASSISTANT_T07"}');
      return;
    }
    if (pathname === '/__map_fixture__/style.json') {
      const fixtureOrigin = `http://${request.headers.host}`;
      const style = JSON.stringify({
        version: 8,
        sources: {
          rasterFixture: {
            type: 'raster',
            tiles: [`${fixtureOrigin}/__map_fixture__/tiles/{z}/{x}/{y}.png`],
            tileSize: 256,
            minzoom: 0,
            maxzoom: 14,
          },
          localAttribution: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#eef2f0' } },
          {
            id: 'raster-fixture',
            type: 'raster',
            source: 'rasterFixture',
            paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 },
          },
          { id: 'attribution-source', type: 'circle', source: 'localAttribution', paint: { 'circle-radius': 0 } },
        ],
      });
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(style),
      });
      response.end(style);
      return;
    }
    if (pathname.startsWith('/__map_fixture__/tiles/')) {
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'image/png',
        'content-length': mapTile.length,
      });
      response.end(mapTile);
      return;
    }
    sourceRequests.push(pathname);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', etag: '"assistant-t07-fixture"',
      'last-modified': 'Wed, 26 Aug 2026 08:00:00 GMT',
    });
    response.end(html);
  });
  await new Promise((done) => sourceServer.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${sourceServer.address().port}`;
}

function configureProviderStubs(sourceOrigin) {
  Object.assign(process.env, {
    ASSISTANT_OPENAI_BASE_URL: `${sourceOrigin}/__provider_stub__/openai`,
    LOCATIONIQ_API_URL: `${sourceOrigin}/__provider_stub__/locationiq`,
    ASSISTANT_OVERPASS_URL: `${sourceOrigin}/__provider_stub__/overpass`,
  });
}

function installOutboundDenyHook() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (/^(?:api\.openai\.com|[^.]+\.locationiq\.com|overpass-api\.de)$/iu.test(url.hostname)) {
      const safeTarget = `${url.protocol}//${url.hostname}${url.pathname}`;
      deniedOutboundRequests.push(safeTarget);
      throw new Error(`ASSISTANT_T07_OUTBOUND_DENIED:${safeTarget}`);
    }
    return originalFetch(input, init);
  };
}

async function assertOutboundProviderIsolation() {
  assert.deepEqual(providerStubRequests, { openai: 0, locationiq: 0, overpass: 0 });
  assert.deepEqual(deniedOutboundRequests, []);
  const locationIqAttempts = await prisma.assistantGeoUsageAttempt.count({
    where: { provider: { in: ['locationiq', 'overpass'] } },
  });
  const openAiAttempts = await prisma.assistantAiUsageAttempt.count({
    where: { provider: 'openai' },
  });
  assert.equal(locationIqAttempts, 0);
  assert.equal(openAiAttempts, 0);
  return {
    version: 1,
    transportStubCalls: { ...providerStubRequests },
    persistedUsageAttempts: { openai: openAiAttempts, locationiq: 0, overpass: 0 },
    deniedRemoteRequests: deniedOutboundRequests.length,
  };
}

async function writeProviderEvidence(evidence) {
  const evidencePath = process.env.ASSISTANT_T07_PROVIDER_EVIDENCE_PATH;
  const nonce = process.env.ASSISTANT_T07_PROVIDER_EVIDENCE_NONCE;
  if (evidencePath === undefined && nonce === undefined) return;
  assert.equal(typeof evidencePath, 'string', 'ASSISTANT_T07_PROVIDER_EVIDENCE_PATH_REQUIRED');
  assert.equal(resolve(evidencePath), evidencePath, 'ASSISTANT_T07_PROVIDER_EVIDENCE_PATH_MUST_BE_ABSOLUTE');
  assert.match(nonce ?? '', /^[a-f0-9]{16}$/u, 'ASSISTANT_T07_PROVIDER_EVIDENCE_NONCE_INVALID');
  await writeFile(evidencePath, `${JSON.stringify({ ...evidence, nonce }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

async function seed(sourceOrigin) {
  const keys = [
    'objects:read', 'developers:read', 'locations:read', 'metro:read',
    'assistant:audit:read', 'assistant:sources:manage', 'admin:access',
  ];
  const permissionIds = new Map();
  for (const key of keys) {
    const permission = await prisma.permission.upsert({
      where: { key }, update: {}, create: { key, description: key },
    });
    permissionIds.set(key, permission.id);
  }
  const ordinaryKeys = keys.slice(0, 4);
  const regular = await createUser('user', ordinaryKeys.map((key) => permissionIds.get(key)));
  const other = await createUser('other', ordinaryKeys.map((key) => permissionIds.get(key)));
  const additionalPilots = [];
  for (let index = 3; index <= 10; index += 1) {
    additionalPilots.push(await createUser(
      `pilot-${index}`,
      ordinaryKeys.map((key) => permissionIds.get(key)),
    ));
  }
  const admin = await createUser('admin', keys.map((key) => permissionIds.get(key)));
  const pilotUserIds = [
    regular.user.id,
    other.user.id,
    ...additionalPilots.map(({ user }) => user.id),
  ]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  process.env.ASSISTANT_PILOT_USER_IDS = pilotUserIds.join(',');
  await assert.rejects(
    () => prisma.assistantRolloutEvent.create({ data: rolloutEventData('ALL', pilotUserIds) }),
    /ASSISTANT_ROLLOUT_PREVIOUS_STAGE_EVENT_REQUIRED/u,
  );
  await assert.rejects(
    () => prisma.assistantRolloutEvent.create({
      data: {
        ...rolloutEventData('PILOT', pilotUserIds),
        approvalJson: { kind: 'ASSISTANT_ROLLOUT_PREFLIGHT', passed: false, targetStage: 'PILOT' },
      },
    }),
    /ASSISTANT_ROLLOUT_STAGE_APPROVAL_INVALID/u,
  );
  await prisma.assistantRolloutEvent.create({ data: rolloutEventData('PILOT', pilotUserIds) });
  await prisma.assistantRolloutEvent.create({ data: rolloutEventData('ALL', pilotUserIds) });
  const developer = await prisma.developer.create({ data: { name: 'Тест Девелопмент', slug: 'test-development' } });
  const moscow = await prisma.location.create({
    data: { name: 'Москва', slug: 'assistant-t07-moscow', type: 'CUSTOM' },
  });
  const district = await prisma.location.create({
    data: { name: 'Хамовники', slug: 'assistant-t07-hamovniki', type: 'DISTRICT', parentId: moscow.id },
  });
  const area = await prisma.location.create({ data: { name: 'ЦАО', slug: 'assistant-t07-cao', type: 'AREA' } });
  const metro = await prisma.metroStation.create({
    data: { name: 'Спортивная', slug: 'assistant-t07-sportivnaya', lineName: 'Сокольническая', lineColor: '#D6083B' },
  });
  const objects = [];
  for (const [index, meters] of [300, 700, 1_100, 1_500, 1_900, 2_500].entries()) {
    const point = projectNorth(55.7312, meters);
    objects.push(await prisma.realEstateObject.create({
      data: {
        title: index === 0 ? 'ЖК Северный сад' : `ЖК T07 ${index + 1}`,
        slug: index === 0 ? 'severny-sad' : `assistant-t07-object-${index + 1}`,
        status: 'PUBLISHED', type: 'RESIDENTIAL', address: `Москва, тестовый адрес ${index + 1}`,
        developerId: developer.id, primaryLocationId: district.id,
        completionYear: 2027, completionQuarter: 3,
        feedUpdatedAt: oldDate(), latitude: point.latitude, longitude: point.longitude,
        publishedAt: new Date(), locations: { create: { locationId: area.id } },
        metroStations: { create: { metroStationId: metro.id } },
      },
    }));
  }
  const pdf = await prisma.file.create({
    data: { key: `assistant-t07/${randomUUID()}/presentation.pdf`, originalName: 'project.pdf', mimeType: 'application/pdf' },
  });
  await prisma.objectFile.create({
    data: { objectId: objects[0].id, fileId: pdf.id, type: 'PRESENTATION', title: 'Презентация проекта' },
  });
  const units = [];
  for (const [index, object] of objects.entries()) {
    const source = await prisma.feedSource.create({
      data: {
        sourceKind: 'URL', url: `${sourceOrigin}/feeds/${index + 1}.xml`, format: 'CIAN_XML',
        developerId: developer.id, objectId: object.id, isActive: true, lastSuccessAt: new Date(),
      },
    });
    units.push(await prisma.feedUnit.create({
      data: {
        sourceId: source.id, objectId: object.id, externalId: `assistant-t07-unit-${index + 1}`,
        type: 'RESIDENTIAL', status: 'AVAILABLE', title: `2-комнатная квартира ${index + 1}`,
        rooms: 2, effectivePrice: [20e6, 21e6, 22e6, 28e6, 29e6, 19.5e6][index],
        effectivePricePerMeter: 330_000 + index * 5_000, currency: 'RUB', area: 60 + index,
        floor: 8 + index, completionYear: 2027, completionQuarter: 3,
        createdAt: oldDate(), updatedAt: oldDate(),
      },
    }));
  }
  const connectedGeoSeed = {
    sourceOrigin,
    developerId: developer.id,
    districtId: district.id,
    areaId: area.id,
  };
  return { regular, other, admin, objects, units, connectedGeoSeed };
}

async function seedConnectedGeoFixtures({ sourceOrigin, developerId, districtId, areaId }) {
  const [points] = await prisma.$queryRawUnsafe(`
    WITH
      line AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geometry
      ),
      area AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON($2), 4326) AS geometry
      ),
      line_buffer_1km AS (
        SELECT dumped.geom
        FROM line
        CROSS JOIN LATERAL ST_Dump(ST_Buffer(line.geometry::geography, 1025)::geometry) dumped
        ORDER BY ST_Area(dumped.geom) DESC
        LIMIT 1
      ),
      line_buffer_5km AS (
        SELECT dumped.geom
        FROM line
        CROSS JOIN LATERAL ST_Dump(ST_Buffer(line.geometry::geography, 5025)::geometry) dumped
        ORDER BY ST_Area(dumped.geom) DESC
        LIMIT 1
      ),
      area_buffer AS (
        SELECT dumped.geom
        FROM area
        CROSS JOIN LATERAL ST_Dump(ST_Buffer(area.geometry::geography, 25)::geometry) dumped
        ORDER BY ST_Area(dumped.geom) DESC
        LIMIT 1
      ),
      fixture_points AS (
        SELECT
          ST_LineInterpolatePoint(line.geometry, 0.05) AS line_a,
          ST_LineInterpolatePoint(line.geometry, 0.55) AS line_b,
          ST_PointN(ST_ExteriorRing(line_buffer_1km.geom), 1) AS line_override_outside,
          ST_PointN(ST_ExteriorRing(line_buffer_5km.geom), 1) AS line_default_outside,
          ST_LineInterpolatePoint(
            ST_MakeLine(
              ST_LineInterpolatePoint(ST_ExteriorRing(area.geometry), 0.1),
              ST_PointOnSurface(area.geometry)
            ),
            0.05
          ) AS area_inside,
          ST_PointN(ST_ExteriorRing(area_buffer.geom), 1) AS area_outside,
          line.geometry AS line_geometry,
          area.geometry AS area_geometry
        FROM line, area, line_buffer_1km, line_buffer_5km, area_buffer
      )
    SELECT
      ST_X(line_a)::double precision AS "lineALongitude",
      ST_Y(line_a)::double precision AS "lineALatitude",
      ST_X(line_b)::double precision AS "lineBLongitude",
      ST_Y(line_b)::double precision AS "lineBLatitude",
      ST_X(line_override_outside)::double precision AS "lineOverrideLongitude",
      ST_Y(line_override_outside)::double precision AS "lineOverrideLatitude",
      ST_Distance(line_geometry::geography, line_override_outside::geography)::double precision
        AS "lineOverrideDistance",
      ST_X(line_default_outside)::double precision AS "lineDefaultOutsideLongitude",
      ST_Y(line_default_outside)::double precision AS "lineDefaultOutsideLatitude",
      ST_Distance(line_geometry::geography, line_default_outside::geography)::double precision
        AS "lineDefaultOutsideDistance",
      ST_X(area_inside)::double precision AS "areaInsideLongitude",
      ST_Y(area_inside)::double precision AS "areaInsideLatitude",
      ST_Covers(area_geometry, area_inside) AS "areaInsideCovered",
      ST_Distance(ST_PointOnSurface(area_geometry)::geography, area_inside::geography)::double precision
        AS "areaInsideCentroidDistance",
      ST_X(area_outside)::double precision AS "areaOutsideLongitude",
      ST_Y(area_outside)::double precision AS "areaOutsideLatitude",
      ST_Covers(area_geometry, area_outside) AS "areaOutsideCovered",
      ST_Distance(ST_Boundary(area_geometry)::geography, area_outside::geography)::double precision
        AS "areaOutsideBoundaryDistance"
    FROM fixture_points
  `, JSON.stringify(lineReferenceGeometry), JSON.stringify(areaReferenceGeometry));
  assert.ok(points, 'connected geo fixture points were not created');
  assert.ok(points.lineOverrideDistance > 1_000 && points.lineOverrideDistance < 1_100);
  assert.ok(points.lineDefaultOutsideDistance > 5_000 && points.lineDefaultOutsideDistance < 5_100);
  assert.equal(points.areaInsideCovered, true);
  assert.ok(points.areaInsideCentroidDistance > 500);
  assert.equal(points.areaOutsideCovered, false);
  assert.ok(points.areaOutsideBoundaryDistance > 0 && points.areaOutsideBoundaryDistance < 60);

  const shared = { sourceOrigin, developerId, districtId, areaId };
  const units = {
    lineA: await createConnectedGeoOffer(shared, {
      key: 'line-a', title: 'ЖК Линия A', rooms: 1, priceRub: 24_000_000,
      latitude: points.lineALatitude, longitude: points.lineALongitude,
    }),
    lineB: await createConnectedGeoOffer(shared, {
      key: 'line-b', title: 'ЖК Линия B', rooms: 1, priceRub: 26_000_000,
      latitude: points.lineBLatitude, longitude: points.lineBLongitude,
    }),
    lineOverrideOutside: await createConnectedGeoOffer(shared, {
      key: 'line-override-outside', title: 'ЖК Линия дальше 1 км', rooms: 1, priceRub: 28_000_000,
      latitude: points.lineOverrideLatitude, longitude: points.lineOverrideLongitude,
    }),
    lineDefaultOutside: await createConnectedGeoOffer(shared, {
      key: 'line-default-outside', title: 'ЖК Линия дальше 5 км', rooms: 1, priceRub: 25_000_000,
      latitude: points.lineDefaultOutsideLatitude, longitude: points.lineDefaultOutsideLongitude,
    }),
    lineWrongRooms: await createConnectedGeoOffer(shared, {
      key: 'line-wrong-rooms', title: 'ЖК Линия неверная комнатность', rooms: 2, priceRub: 24_000_000,
      latitude: points.lineALatitude, longitude: points.lineALongitude,
    }),
    lineOverBudget: await createConnectedGeoOffer(shared, {
      key: 'line-over-budget', title: 'ЖК Линия выше бюджета', rooms: 1, priceRub: 35_000_000,
      latitude: points.lineBLatitude, longitude: points.lineBLongitude,
    }),
    areaInside: await createConnectedGeoOffer(shared, {
      key: 'area-inside', title: 'ЖК Внутри Арбата', rooms: 3, priceRub: 36_000_000,
      latitude: points.areaInsideLatitude, longitude: points.areaInsideLongitude,
    }),
    areaOutside: await createConnectedGeoOffer(shared, {
      key: 'area-outside', title: 'ЖК За границей Арбата', rooms: 3, priceRub: 36_000_000,
      latitude: points.areaOutsideLatitude, longitude: points.areaOutsideLongitude,
    }),
    areaWrongRooms: await createConnectedGeoOffer(shared, {
      key: 'area-wrong-rooms', title: 'ЖК Арбат неверная комнатность', rooms: 2, priceRub: 36_000_000,
      latitude: points.areaInsideLatitude, longitude: points.areaInsideLongitude,
    }),
    areaOverBudget: await createConnectedGeoOffer(shared, {
      key: 'area-over-budget', title: 'ЖК Арбат выше бюджета', rooms: 3, priceRub: 45_000_000,
      latitude: points.areaInsideLatitude, longitude: points.areaInsideLongitude,
    }),
  };
  return { units, metrics: points };
}

async function createConnectedGeoOffer(shared, input) {
  const object = await prisma.realEstateObject.create({
    data: {
      title: input.title,
      slug: `assistant-t07-${input.key}`,
      status: 'PUBLISHED',
      type: 'RESIDENTIAL',
      address: `Москва, PIDAFIX3 ${input.key}`,
      developerId: shared.developerId,
      primaryLocationId: shared.districtId,
      feedUpdatedAt: oldDate(),
      latitude: input.latitude,
      longitude: input.longitude,
      publishedAt: new Date(),
      locations: { create: { locationId: shared.areaId } },
    },
  });
  const source = await prisma.feedSource.create({
    data: {
      sourceKind: 'URL',
      url: `${shared.sourceOrigin}/feeds/${input.key}.xml`,
      format: 'CIAN_XML',
      developerId: shared.developerId,
      objectId: object.id,
      isActive: true,
      lastSuccessAt: new Date(),
    },
  });
  return prisma.feedUnit.create({
    data: {
      sourceId: source.id,
      objectId: object.id,
      externalId: `assistant-t07-${input.key}`,
      type: 'RESIDENTIAL',
      status: 'AVAILABLE',
      title: `${input.rooms}-комнатная квартира ${input.key}`,
      rooms: input.rooms,
      effectivePrice: input.priceRub,
      effectivePricePerMeter: 400_000,
      currency: 'RUB',
      area: 60 + input.rooms * 10,
      floor: 8,
      createdAt: oldDate(),
      updatedAt: oldDate(),
    },
  });
}

function rolloutEventData(stage, pilotUserIds) {
  const startedAt = new Date();
  const approvalJson = {
    kind: 'ASSISTANT_ROLLOUT_PREFLIGHT',
    passed: true,
    currentStage: stage === 'PILOT' ? 'ADMINS' : 'PILOT',
    targetStage: stage,
    stageStartedAt: startedAt.toISOString(),
    eval: { version: 'assistant-eval-v1', passed: true, caseCount: 200 },
    sourceHealth: { passed: true, activeSourceCount: 1, unhealthySourceIds: [] },
    budgets: { passed: true, missing: [] },
    pilotCohort: {
      passed: true,
      configuredCount: 10,
      userIds: pilotUserIds,
      missingUserIds: [],
      ineligibleUserIds: [],
    },
    observation: {
      passed: true,
      runCount: 10,
      uniqueUserCount: 10,
      missingPilotUserIds: [],
      blockers: [],
    },
    criticalErrorCount: 0,
  };
  return {
    stage,
    startedAt,
    approvalJson,
    gateDigest: computeAssistantRolloutApprovalDigest(approvalJson),
  };
}

async function createUser(label, permissionIds) {
  const suffix = randomUUID().slice(0, 8);
  const role = await prisma.role.create({
    data: {
      name: `assistant-t07-${label}-${suffix}`,
      permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `assistant-t07-${label}-${suffix}@example.test`, name: `Assistant T07 ${label}`,
      passwordHash: await hash(password), roleId: role.id, status: 'ACTIVE',
    },
  });
  return { user, role };
}

async function ingestSource(actorId, origin) {
  const { AssistantSourceRegistryService } = require('../dist/assistant/sources/assistant-source-registry.service.js');
  const { AssistantSourceIngestionService } = require('../dist/assistant/sources/assistant-source-ingestion.service.js');
  const { AssistantSourceConnectorRegistry } = require('../dist/assistant/sources/assistant-source-connector.registry.js');
  const { OfficialHtmlSourceConnector } = require('../dist/assistant/sources/official-html-source.connector.js');
  const { OfficialSourceExtractor } = require('../dist/assistant/sources/official-source.extractor.js');
  const { AssistantEmbeddingGateway } = require('../dist/assistant/sources/assistant-embedding.gateway.js');
  const connectorRegistry = new AssistantSourceConnectorRegistry(new OfficialHtmlSourceConnector({
    allowHttp: true,
    allowPrivateNetwork: true,
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  const registry = new AssistantSourceRegistryService(prisma, connectorRegistry);
  const ingestion = new AssistantSourceIngestionService(
    prisma,
    connectorRegistry,
    new OfficialSourceExtractor(),
    new AssistantEmbeddingGateway({ ASSISTANT_EMBEDDING_MODE: 'fake' }),
  );
  const sourcePort = new URL(origin).port;
  const registered = await registry.register(actorId, {
    canonicalUrl: `http://developer.example:${sourcePort}/projects/severny-sad`,
    type: 'DEVELOPMENT_PAGE', state: 'ACTIVE',
    connectorKey: 'OFFICIAL_HTML', connectorConfig: { allowedHosts: ['developer.example'] },
    projectKey: 'severny-sad', developerKey: 'test-development', priority: 100, scheduleMinutes: 1_440,
  });
  const result = await ingestion.ingest(registered.source.id);
  assert.equal(result.outcome, 'INDEXED');
  await prisma.assistantKnowledgeSource.update({
    where: { id: registered.source.id },
    data: { canonicalUrl: 'https://developer.example/projects/severny-sad' },
  });
  await prisma.assistantSourceFact.updateMany({
    where: { sourceId: registered.source.id, kind: { not: 'EXTERNAL_LOT' } },
    data: { canonicalUrl: 'https://developer.example/projects/severny-sad' },
  });
}

async function startWeb(port, sourceOrigin) {
  await run('pnpm', ['--filter', '@platforma/web', 'build'], {
    env: { VITE_API_URL: apiOrigin }, timeout: 120_000,
  });
  webProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: webRoot,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), MAP_PROVIDER_ENABLED: 'true',
      MAP_STYLE_URL: manualQaEnabled
        ? `${sourceOrigin}/__map_fixture__/style.json`
        : 'https://map-fixtures.test/style.json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(webOrigin)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('ASSISTANT_T07_WEB_NOT_READY');
}

async function holdForManualQa(email) {
  if (!manualQaEnabled) return;
  let resume;
  let timeoutId;
  let handleInterrupt;
  const resumed = new Promise((resolveResume) => { resume = resolveResume; });
  const timedOut = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('ASSISTANT_T07_MANUAL_QA_TIMEOUT')), 20 * 60_000);
  });
  const interrupted = new Promise((_, reject) => {
    handleInterrupt = () => reject(
      termination.abortSignal.reason ?? new Error('ASSISTANT_T07_MANUAL_QA_INTERRUPTED'),
    );
    if (termination.abortSignal.aborted) handleInterrupt();
    else termination.abortSignal.addEventListener('abort', handleInterrupt, { once: true });
  });
  const handleResume = () => resume();
  process.once('SIGUSR1', handleResume);
  process.stdout.write(`ASSISTANT_T07_MANUAL_QA_READY ${JSON.stringify({
    webOrigin,
    email,
    resumeSignal: 'SIGUSR1',
  })}\n`);
  try {
    await Promise.race([resumed, timedOut, interrupted]);
  } finally {
    clearTimeout(timeoutId);
    process.off('SIGUSR1', handleResume);
    termination.abortSignal.removeEventListener('abort', handleInterrupt);
  }
}

async function userJourney(fixtures) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const requestedUrls = [];
  const failedRequestUrls = [];
  const unauthorizedUrls = [];
  const serviceUnavailableUrls = [];
  const runtimeErrors = [];
  const runtimeErrorDetailPromises = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  page.on('requestfailed', (request) => failedRequestUrls.push({
    url: request.url(),
    errorText: request.failure()?.errorText ?? null,
  }));
  page.on('response', (response) => {
    if (response.status() === 401) unauthorizedUrls.push(response.url());
    if (response.status() === 503) serviceUnavailableUrls.push(response.url());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      runtimeErrors.push(`${message.type()}: ${message.text()}`);
      runtimeErrorDetailPromises.push(Promise.all(message.args().slice(1).map(async (argument) => {
        try {
          return String(await argument.jsonValue());
        } catch {
          return '<unavailable>';
        }
      })).then((arguments_) => ({
        arguments: arguments_,
        location: message.location(),
        pageUrl: page.url(),
      })));
    }
  });
  await installMapFixture(page);
  try {
    const session = await login(page, fixtures.regular.user);
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    const input = page.getByLabel('Сообщение помощнику');

    let forcedRetryFailure = false;
    await page.route(`${apiOrigin}/assistant/conversations`, async (route) => {
      if (route.request().method() !== 'POST' || forcedRetryFailure) return route.continue();
      forcedRetryFailure = true;
      process.env.ASSISTANT_MODULE_ENABLED = 'false';
      try {
        const response = await route.fetch();
        await route.fulfill({ response });
      } finally {
        process.env.ASSISTANT_MODULE_ENABLED = 'true';
      }
    });
    await submit(page, input, 'Найди подходящий объект');
    await page.getByRole('button', { name: 'Повторить отправку' }).waitFor();
    const progress = await captureProgress(page, async () => {
      await page.getByRole('button', { name: 'Повторить отправку' }).click();
      await page.getByText(/Уточните, пожалуйста:.*максимальный бюджет/u).waitFor();
    });
    for (const label of ['Понимаю запрос', 'Ищу данные', 'Сравниваю варианты', 'Формирую ответ']) {
      assert.equal(progress.includes(label), true, `missing progress label: ${label}`);
    }
    process.env.ASSISTANT_FAKE_STEP_DELAY_MS = '50';

    const exactQuery = 'Нужна двушка до 25 млн в районе Хамовники у метро Спортивная от Тест Девелопмент, сдача до 2028 года';
    await submit(page, input, exactQuery);
    const exactArticle = await waitForAssistantArticle(page, exactQuery);
    await exactArticle.getByRole('heading', { name: 'Лучшие по этим критериям' }).waitFor();
    assert.equal(await exactArticle.locator('.assistant-result-card').count(), 3);
    await exactArticle.getByText(/данные могут быть устаревшими/u).first().waitFor();
    assert.equal(await exactArticle.getByRole('link', { name: 'Презентация проекта' }).count(), 1);
    const exactRun = await prisma.assistantRun.findFirstOrThrow({
      where: { ownerUserId: fixtures.regular.user.id, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, conversationId: true },
    });
    await exactArticle.getByRole('button', { name: 'Ответ не помог' }).click();
    await exactArticle.getByLabel(/Причина/u).selectOption('STALE_DATA');
    await exactArticle.getByLabel(/Комментарий/u).fill('Проверьте дату обновления');
    await exactArticle.getByRole('button', { name: 'Сохранить оценку' }).click();
    await exactArticle.getByText('Спасибо, оценка попадёт на проверку.').waitFor();

    await page.getByRole('button', { name: 'История разговоров' }).click();
    const history = page.getByRole('complementary', { name: 'История разговоров' });
    await history.waitFor();
    assert.equal(await history.locator('.assistant-history-item').count() >= 1, true);
    await history.getByRole('button', { name: 'Новый разговор' }).click();

    const alternativeQuery = 'Нужна двушка до 19 млн в районе Хамовники у метро Спортивная от Тест Девелопмент';
    await submit(page, input, alternativeQuery);
    const alternativeArticle = await waitForAssistantArticle(page, alternativeQuery);
    try {
      await alternativeArticle.getByRole('heading', { name: 'Альтернативы' }).waitFor();
    } catch (error) {
      const latest = await prisma.assistantRun.findFirst({
        where: { ownerUserId: fixtures.regular.user.id },
        orderBy: { createdAt: 'desc' },
        include: { assistantMessage: true },
      });
      throw new Error(`${error.message}\nT07 latest run: ${JSON.stringify({
        status: latest?.status,
        errorCode: latest?.errorCode,
        intent: latest?.intentJson,
        answer: latest?.assistantMessage?.answerJson,
      })}`);
    }
    assert.equal(await alternativeArticle.locator('.assistant-result-card').count(), 2);

    await startNewConversation(page);
    await navigateSpa(page, '/objects/severny-sad');
    await page.getByText('Текущий ЖК', { exact: true }).waitFor();
    const factualQuery = 'Что известно об архитектуре ЖК Северный сад?';
    await submit(page, input, factualQuery);
    const factualArticle = await waitForAssistantArticle(page, factualQuery);
    try {
      await factualArticle.getByRole('heading', { name: 'Подтверждённые факты' }).waitFor();
    } catch (error) {
      const latest = await prisma.assistantRun.findFirst({
        where: { ownerUserId: fixtures.regular.user.id, userMessage: { content: factualQuery } },
        include: { assistantMessage: true },
      });
      const facts = await prisma.assistantSourceFact.findMany({
        select: { kind: true, label: true, source: { select: { canonicalUrl: true, projectKey: true } } },
      });
      throw new Error(`${error.message}\nT07 factual: ${JSON.stringify({
        run: latest && { status: latest.status, intent: latest.intentJson, answer: latest.assistantMessage?.answerJson },
        facts,
      })}`);
    }
    await factualArticle.getByText(/Кирпичные фасады/u).first().waitFor();
    await startNewConversation(page);
    const installmentQuery = 'Какие точные условия ступенчатой рассрочки действуют в Северном саду?';
    await submit(page, input, installmentQuery);
    const installmentArticle = await waitForAssistantArticle(page, installmentQuery);
    await installmentArticle.getByRole('heading', { name: 'Подтверждённые факты' }).waitFor();
    await installmentArticle.getByText('Ступенчатая рассрочка', { exact: true }).waitFor();
    const installmentFact = await prisma.assistantSourceFact.findFirstOrThrow({
      where: { kind: 'PROMOTION', label: 'Ступенчатая рассрочка', isActive: true },
      select: { valueJson: true },
    });
    assert.match(String(installmentFact.valueJson), /Первоначальный взнос 30%/u);
    assert.match(String(installmentFact.valueJson), /12 ежемесячных платежей/u);
    assert.match(String(installmentFact.valueJson), /15 декабря 2027 года/u);
    await startNewConversation(page);
    const externalQuery = 'Найди двушку от 66 м² до 24 млн в Северном саду';
    await submit(page, input, externalQuery);
    const externalArticle = await waitForAssistantArticle(page, externalQuery);
    try {
      await externalArticle.getByRole('heading', { name: 'На официальном сайте застройщика' }).waitFor();
    } catch (error) {
      const latest = await prisma.assistantRun.findFirst({
        where: { ownerUserId: fixtures.regular.user.id, userMessage: { content: externalQuery } },
        include: { assistantMessage: true },
      });
      const externalFacts = await prisma.assistantSourceFact.findMany({
        where: { kind: 'EXTERNAL_LOT' }, select: { canonicalUrl: true, valueJson: true, searchText: true },
      });
      throw new Error(`${error.message}\nT07 external lot: ${JSON.stringify({
        run: latest && { status: latest.status, intent: latest.intentJson, answer: latest.assistantMessage?.answerJson },
        externalFacts,
      })}`);
    }
    await externalArticle.getByText('23 900 000 ₽', { exact: true }).waitFor();
    assert.match(
      await externalArticle.locator('a.assistant-result-title').getAttribute('href'),
      /^https:\/\/developer\.example\//u,
    );

    await navigateSpa(page, '/cabinet');
    await startNewConversation(page);
    const namedGeoQuery = 'Найди двушку до 25 млн рядом с Павелецкая Плаза в радиусе 2 км';
    await submit(page, input, namedGeoQuery);
    await page.getByText('Павелецкая Плаза · до 2 км', { exact: true }).waitFor();
    const distances = page.locator('.assistant-result-distance');
    await distances.last().waitFor();
    for (const text of await distances.allTextContents()) {
      assert.ok(parseDistanceMeters(text) <= 2_000, `result escaped radius: ${text}`);
    }
    const assistantDialog = page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
    assert.equal(await assistantDialog.getByText('ЖК T07 6', { exact: true }).count(), 0);
    const geoRun = await prisma.assistantRun.findFirstOrThrow({
      where: {
        ownerUserId: fixtures.regular.user.id,
        userMessage: { content: namedGeoQuery },
      },
      include: { assistantMessage: true },
    });
    const geoMarkers = geoRun.assistantMessage?.answerJson?.geo?.markers ?? [];
    assert.equal(
      geoMarkers.filter(({ kind }) => kind === 'PRIMARY').length,
      3,
      `geo answer did not retain primary markers: ${JSON.stringify(geoRun.assistantMessage?.answerJson)}`,
    );
    assert.equal(geoMarkers.filter(({ kind }) => kind === 'ALTERNATIVE').length, 0);
    await page.locator('.map-price-marker--primary').first().waitFor();
    assert.equal(await page.locator('.map-price-marker--primary').count(), 3);
    const primaryMarkerColor = await page.locator('.map-price-marker--primary .map-price-marker-dot').first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await assistantDialog.locator('.assistant-geo-result-map').last().scrollIntoViewIfNeeded();
    await captureQaScreenshot(page, 'desktop-assistant-geo.png', assistantDialog);

    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    await startNewConversation(page);
    const ambiguityQuery = 'Найди в радиусе 2 км от Площадь неоднознач';
    await submit(page, input, ambiguityQuery);
    const ambiguous = page.locator('[data-assistant-geo-candidates] .assistant-geo-candidates button');
    await ambiguous.first().waitFor();
    assert.equal(await ambiguous.count(), 3);
    await ambiguous.nth(1).click();
    await page.locator('[data-assistant-geo-chip]').waitFor();
    await waitForAssistantArticle(page, ambiguityQuery);

    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    await startNewConversation(page);
    await submit(page, input, 'Найди в радиусе 2 км от geocoder unavailable');
    await page.getByText(/Геокодер сейчас недоступен/u).waitFor();
    const runsBeforeManual = await countUserRuns(fixtures.regular.user.id);
    const operationsBeforeManual = await prisma.assistantGeoOperation.count();
    await page.getByRole('button', { name: 'Указать на карте' }).click();
    const picker = page.getByRole('region', { name: 'Выбор точки и радиуса' });
    await picker.getByRole('button', { name: '2 км' }).click();
    assert.equal(await countUserRuns(fixtures.regular.user.id), runsBeforeManual);
    await picker.getByRole('button', { name: 'Подтвердить точку' }).click();
    await waitForCount(() => countUserRuns(fixtures.regular.user.id), runsBeforeManual + 1);
    assert.equal(await prisma.assistantGeoOperation.count(), operationsBeforeManual);
    await waitForAssistantArticle(page, 'Найди в радиусе 2 км от geocoder unavailable');
    const runsBeforeMove = await countUserRuns(fixtures.regular.user.id);
    await page.getByRole('button', { name: 'Изменить точку и расстояние' }).click();
    await picker.getByRole('button', { name: '3 км' }).click();
    await picker.getByRole('button', { name: 'Подтвердить точку' }).click();
    await waitForCount(() => countUserRuns(fixtures.regular.user.id), runsBeforeMove + 1);
    assert.equal(await prisma.assistantGeoOperation.count(), operationsBeforeManual);

    await page.getByRole('button', { name: 'Закрыть помощника' }).click();
    await navigateSpa(page, '/catalog/map?lotRooms=2&lotPriceMax=25000000');
    assert.equal(new URL(page.url()).searchParams.get('lotRooms'), '2');
    assert.equal(new URL(page.url()).searchParams.get('lotPriceMax'), '25000000');
    const catalogMap = page.getByRole('region', { name: 'Карта объектов' });
    const marker = catalogMap.locator('.map-price-marker').first();
    await marker.waitFor();
    await marker.click();
    assert.equal(await marker.getAttribute('aria-pressed'), 'true');
    const selectedListItem = catalogMap.locator('.catalog-map-list-item--selected');
    await selectedListItem.waitFor();
    assert.equal((await selectedListItem.innerText()).trim().length > 0, true);
    assert.equal(new URL(page.url()).searchParams.get('lotRooms'), '2');
    assert.equal(new URL(page.url()).searchParams.get('lotPriceMax'), '25000000');
    await captureQaScreenshot(page, 'desktop-catalog-map.png', catalogMap);
    await catalogMap.getByRole('button', { name: 'Скрыть/показать' }).click();
    await catalogMap.getByRole('button', { name: 'Показать список' }).waitFor();
    await catalogMap.getByRole('button', { name: 'Открыть карту на весь экран' }).click();
    const closeFullscreen = catalogMap.getByRole('button', { name: 'Закрыть полноэкранную карту' });
    await closeFullscreen.focus();
    await page.keyboard.press('Enter');
    await catalogMap.locator('.platform-map-shell[data-map-fullscreen="false"]').waitFor();
    await catalogMap.getByText('OpenFreeMap', { exact: true }).waitFor();
    await catalogMap.getByText('OpenStreetMap', { exact: true }).waitFor();
    await navigateSpa(page, '/objects/severny-sad');
    await page.getByRole('region', { name: 'Карта объекта' }).locator('.map-price-marker').waitFor();

    assertProviderIsolation(requestedUrls);
    assert.equal(requestedUrls.some((url) => (
      url.startsWith('https://map-fixtures.test/tiles/')
      || url.includes('/__map_fixture__/tiles/')
    )), true);
    assert.deepEqual(failedRequestUrls.filter(({ url, errorText }) => (
      !/\.(?:woff2?|ttf)(?:\?.*)?$/u.test(url)
      && !(url === `${apiOrigin}/assistant/config` && errorText === 'net::ERR_ABORTED')
      && !((
        url.startsWith('https://map-fixtures.test/tiles/')
        || url.includes('/__map_fixture__/tiles/')
      ) && errorText === 'net::ERR_ABORTED')
    )), []);
    assert.equal(unauthorizedUrls.length >= 1, true);
    assert.deepEqual(unauthorizedUrls.filter((url) => url !== `${apiOrigin}/auth/refresh`), []);
    assert.deepEqual([...new Set(serviceUnavailableUrls)], [`${apiOrigin}/assistant/conversations`]);
    const filteredRuntimeErrors = runtimeErrors.filter((message) => (
      !/Failed to load resource: the server responded with a status of 503/iu.test(message)
      && !/Failed to load resource: the server responded with a status of 401/iu.test(message)
      && !/GL Driver Message .*GPU stall due to ReadPixels/iu.test(message)
    ));
    if (filteredRuntimeErrors.length > 0) {
      process.stderr.write(`${JSON.stringify({
        filteredRuntimeErrors,
        runtimeErrorDetails: await Promise.all(runtimeErrorDetailPromises),
      }, null, 2)}\n`);
    }
    assert.deepEqual(filteredRuntimeErrors, []);
    return { accessToken: session.accessToken, exactRun, exactQuery, primaryMarkerColor };
  } finally {
    process.env.ASSISTANT_MODULE_ENABLED = 'true';
    await context.close();
  }
}

async function alternativeGeoJourney(fixtures, primaryMarkerColor) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const requestedUrls = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  await installMapFixture(page);
  try {
    await login(page, fixtures.regular.user);
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    await startNewConversation(page);
    const query = 'Найди двушку до 19 млн рядом с Павелецкая Плаза в радиусе 2 км';
    const input = page.getByLabel('Сообщение помощнику');
    await submit(page, input, query);
    const article = await waitForAssistantArticle(page, query);
    await article.getByRole('heading', { name: 'Альтернативы' }).waitFor();
    await page.getByText('Павелецкая Плаза · до 2 км', { exact: true }).waitFor();
    const distances = article.locator('.assistant-result-distance');
    await distances.last().waitFor();
    for (const text of await distances.allTextContents()) {
      assert.ok(parseDistanceMeters(text) <= 2_000, `alternative escaped radius: ${text}`);
    }
    assert.equal(await article.locator('.assistant-result-card').count(), 2);
    assert.equal(await page.locator('.map-price-marker--primary').count(), 0);
    await page.locator('.map-price-marker--alternative').first().waitFor();
    assert.equal(await page.locator('.map-price-marker--alternative').count(), 2);
    const alternativeMarkerColor = await page
      .locator('.map-price-marker--alternative .map-price-marker-dot').first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(primaryMarkerColor, alternativeMarkerColor);
    const dialog = page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
    await dialog.locator('.assistant-geo-result-map').last().scrollIntoViewIfNeeded();
    await captureQaScreenshot(page, 'desktop-assistant-geo-alternatives.png', dialog);
    const run = await prisma.assistantRun.findFirstOrThrow({
      where: { ownerUserId: fixtures.regular.user.id, userMessage: { content: query } },
      include: { assistantMessage: true },
    });
    const markers = run.assistantMessage?.answerJson?.geo?.markers ?? [];
    assert.equal(markers.filter(({ kind }) => kind === 'PRIMARY').length, 0);
    assert.equal(markers.filter(({ kind }) => kind === 'ALTERNATIVE').length, 2);
    assertProviderIsolation(requestedUrls);
  } finally {
    await context.close();
  }
}

async function lineGeoJourney(fixtures) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const requestedUrls = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  await installMapFixture(page);
  try {
    await login(page, fixtures.regular.user);
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    await startNewConversation(page);
    const input = page.getByLabel('Сообщение помощнику');
    const operationIdsBeforeDefault = await readGeoOperationIds(fixtures.regular.user.id, 'садовое кольцо');
    const query = 'Найди однокомнатную квартиру до 30 млн рядом с Садовым кольцом';
    await submit(page, input, query);
    const article = await waitForAssistantArticle(page, query);
    await article.getByRole('heading', { name: 'Лучшие по этим критериям' }).waitFor();
    await assertResultTitles(article, ['ЖК Линия A', 'ЖК Линия B', 'ЖК Линия дальше 1 км']);
    for (const title of ['ЖК Линия дальше 5 км', 'ЖК Линия неверная комнатность', 'ЖК Линия выше бюджета']) {
      assert.equal(await article.getByText(title, { exact: true }).count(), 0);
    }
    await page.getByText('Садовое кольцо · до 5 км от всей дороги', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Выбор точки и радиуса' }).count(), 0);
    await assertGeoResultMap(article, {
      ariaLabel: 'Результаты до 5 км от всей дороги Садовое кольцо',
      mode: 'NEAR', referenceType: 'LineString', primaryMarkers: 3,
    });
    const defaultRun = await assertConnectedGeoRun({
      fixtures,
      query,
      expectedKeys: ['lineA', 'lineB', 'lineOverrideOutside'],
      excludedKeys: ['lineDefaultOutside', 'lineWrongRooms', 'lineOverBudget'],
      kind: 'LINE', mode: 'NEAR', label: 'Садовое кольцо', distanceMeters: 5_000,
      rooms: [1], budgetMaxRub: 30_000_000,
    });
    await assertLandmarkGeometry(defaultRun.answer.geo, 'LINE');
    await assertNewGeoOperation({
      actorUserId: fixtures.regular.user.id,
      normalizedQuery: 'садовое кольцо',
      previousIds: operationIdsBeforeDefault,
      provider: 'fake',
      providerCallCount: 1,
    });

    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    await startNewConversation(page);
    const operationIdsBeforeOverride = await readGeoOperationIds(fixtures.regular.user.id, 'садовое кольцо');
    const overrideQuery = 'Найди однокомнатную квартиру до 30 млн в радиусе 1 км от Садового кольца';
    await submit(page, input, overrideQuery);
    const overrideArticle = await waitForAssistantArticle(page, overrideQuery);
    await overrideArticle.getByRole('heading', { name: 'Лучшие по этим критериям' }).waitFor();
    await assertResultTitles(overrideArticle, ['ЖК Линия A', 'ЖК Линия B']);
    for (const title of [
      'ЖК Линия дальше 1 км', 'ЖК Линия дальше 5 км',
      'ЖК Линия неверная комнатность', 'ЖК Линия выше бюджета',
    ]) {
      assert.equal(await overrideArticle.getByText(title, { exact: true }).count(), 0);
    }
    await page.getByText('Садовое кольцо · до 1 км от всей дороги', { exact: true }).waitFor();
    await assertGeoResultMap(overrideArticle, {
      ariaLabel: 'Результаты до 1 км от всей дороги Садовое кольцо',
      mode: 'NEAR', referenceType: 'LineString', primaryMarkers: 2,
    });
    const overrideRun = await assertConnectedGeoRun({
      fixtures,
      query: overrideQuery,
      expectedKeys: ['lineA', 'lineB'],
      excludedKeys: [
        'lineOverrideOutside', 'lineDefaultOutside', 'lineWrongRooms', 'lineOverBudget',
      ],
      kind: 'LINE', mode: 'NEAR', label: 'Садовое кольцо', distanceMeters: 1_000,
      rooms: [1], budgetMaxRub: 30_000_000,
    });
    assert.equal(overrideRun.answer.geo.landmarkId, defaultRun.answer.geo.landmarkId);
    await assertLandmarkGeometry(overrideRun.answer.geo, 'LINE');
    await assertNewGeoOperation({
      actorUserId: fixtures.regular.user.id,
      normalizedQuery: 'садовое кольцо',
      previousIds: operationIdsBeforeOverride,
      provider: 'landmark_db',
      providerCallCount: 0,
    });
    const dialog = page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
    await overrideArticle.locator('.assistant-geo-result-map').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    )), true);
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
    await captureQaScreenshot(page, 'desktop-assistant-geo-line.png', dialog);

    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    await startNewConversation(page);
    const operationIdsBeforeAlternative = await readGeoOperationIds(fixtures.regular.user.id, 'садовое кольцо');
    const alternativeQuery = 'Найди однокомнатную квартиру до 18 млн рядом с Садовым кольцом';
    await submit(page, input, alternativeQuery);
    const alternativeArticle = await waitForAssistantArticle(page, alternativeQuery);
    await alternativeArticle.getByText(
      'Точных совпадений нет. Показываю ближайшие альтернативы с явными отклонениями.',
      { exact: true },
    ).waitFor();
    await alternativeArticle.getByText('Точных совпадений нет.', { exact: true }).waitFor();
    await alternativeArticle.getByRole('heading', { name: 'Альтернативы' }).waitFor();
    await assertResultTitles(alternativeArticle, ['ЖК Линия A']);
    await alternativeArticle.getByText('Бюджет выше на 6 млн ₽', { exact: true }).waitFor();
    for (const title of [
      'ЖК Линия B', 'ЖК Линия дальше 1 км', 'ЖК Линия дальше 5 км',
      'ЖК Линия неверная комнатность', 'ЖК Линия выше бюджета',
    ]) {
      assert.equal(await alternativeArticle.getByText(title, { exact: true }).count(), 0);
    }
    await page.getByText('Садовое кольцо · до 5 км от всей дороги', { exact: true }).waitFor();
    await assertGeoResultMap(alternativeArticle, {
      ariaLabel: 'Результаты до 5 км от всей дороги Садовое кольцо',
      mode: 'NEAR', referenceType: 'LineString', primaryMarkers: 0, alternativeMarkers: 1,
    });
    const alternativeRun = await assertConnectedGeoRun({
      fixtures,
      query: alternativeQuery,
      expectedKeys: [],
      alternativeKeys: ['lineA'],
      excludedKeys: [
        'lineB', 'lineOverrideOutside', 'lineDefaultOutside', 'lineWrongRooms', 'lineOverBudget',
      ],
      kind: 'LINE', mode: 'NEAR', label: 'Садовое кольцо', distanceMeters: 5_000,
      rooms: [1], budgetMaxRub: 18_000_000,
    });
    assert.equal(alternativeRun.answer.geo.landmarkId, defaultRun.answer.geo.landmarkId);
    assert.deepEqual(alternativeRun.answer.alternatives[0].deviations, [
      { type: 'BUDGET', label: 'Бюджет выше на 6 млн ₽' },
    ]);
    assert.deepEqual(alternativeRun.run.evidenceJson[0].deviations, [
      { type: 'BUDGET', label: 'Бюджет выше на 6 млн ₽' },
    ]);
    assert.deepEqual(
      alternativeRun.answer.geo.markers.map(({ unitId, kind: markerKind }) => ({ unitId, kind: markerKind })),
      [{ unitId: fixtures.connectedGeo.units.lineA.id, kind: 'ALTERNATIVE' }],
    );
    assert.ok(alternativeRun.answer.geo.markers[0].distanceMeters <= 5_000);
    await assertLandmarkGeometry(alternativeRun.answer.geo, 'LINE');
    await assertNewGeoOperation({
      actorUserId: fixtures.regular.user.id,
      normalizedQuery: 'садовое кольцо',
      previousIds: operationIdsBeforeAlternative,
      provider: 'landmark_db',
      providerCallCount: 0,
    });
    await alternativeArticle.locator('.assistant-geo-result-map').scrollIntoViewIfNeeded();
    await captureQaScreenshot(page, 'desktop-assistant-geo-line-alternative.png', dialog);
    assertProviderIsolation(requestedUrls);
  } finally {
    await context.close();
  }
}

async function areaGeoJourney(fixtures) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const requestedUrls = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  await installMapFixture(page);
  try {
    await login(page, fixtures.regular.user);
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    await startNewConversation(page);
    const input = page.getByLabel('Сообщение помощнику');
    const operationIdsBefore = await readGeoOperationIds(fixtures.regular.user.id, 'район арбат');
    const query = 'Найди трёхкомнатную квартиру до 40 млн внутри района Арбат';
    await submit(page, input, query);
    const article = await waitForAssistantArticle(page, query);
    await article.getByRole('heading', { name: 'Лучшие по этим критериям' }).waitFor();
    await assertResultTitles(article, ['ЖК Внутри Арбата']);
    for (const title of ['ЖК За границей Арбата', 'ЖК Арбат неверная комнатность', 'ЖК Арбат выше бюджета']) {
      assert.equal(await article.getByText(title, { exact: true }).count(), 0);
    }
    await page.getByText('внутри района Арбат', { exact: true }).waitFor();
    assert.equal(await article.locator('.assistant-result-distance').count(), 0);
    await assertGeoResultMap(article, {
      ariaLabel: 'Результаты внутри области район Арбат',
      mode: 'INSIDE', referenceType: 'Polygon', searchAreaType: 'Polygon', primaryMarkers: 1,
    });
    const run = await assertConnectedGeoRun({
      fixtures,
      query,
      expectedKeys: ['areaInside'],
      excludedKeys: ['areaOutside', 'areaWrongRooms', 'areaOverBudget'],
      kind: 'AREA', mode: 'INSIDE', label: 'район Арбат', distanceMeters: null,
      rooms: [3], budgetMaxRub: 40_000_000,
    });
    await assertLandmarkGeometry(run.answer.geo, 'AREA');
    await assertNewGeoOperation({
      actorUserId: fixtures.regular.user.id,
      normalizedQuery: 'район арбат',
      previousIds: operationIdsBefore,
      provider: 'fake',
      providerCallCount: 1,
    });
    const dialog = page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
    await article.locator('.assistant-geo-result-map').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    )), true);
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
    await captureQaScreenshot(page, 'mobile-assistant-geo-area.png', dialog);
    assertProviderIsolation(requestedUrls);
  } finally {
    await context.close();
  }
}

async function assertResultTitles(article, expectedTitles) {
  const titles = article.locator('a.assistant-result-title');
  await titles.last().waitFor();
  assert.deepEqual(
    new Set((await titles.allTextContents()).map((title) => title.trim())),
    new Set(expectedTitles),
  );
}

async function assertGeoResultMap(article, {
  ariaLabel,
  mode,
  referenceType,
  searchAreaType = null,
  primaryMarkers,
  alternativeMarkers = 0,
}) {
  const wrapper = article.locator('.assistant-geo-result-map');
  await wrapper.waitFor();
  assert.equal(await wrapper.getAttribute('data-geo-mode'), mode);
  assert.equal(await wrapper.getAttribute('data-reference-geometry'), referenceType);
  const actualSearchAreaType = await wrapper.getAttribute('data-search-area-geometry');
  if (searchAreaType) {
    assert.equal(actualSearchAreaType, searchAreaType);
  } else {
    assert.match(actualSearchAreaType ?? '', /^(?:Multi)?Polygon$/u);
  }
  const map = article.getByRole('region', { name: ariaLabel });
  await map.locator('canvas').waitFor();
  await map.getByText('OpenFreeMap', { exact: true }).waitFor();
  await map.getByText('OpenStreetMap', { exact: true }).waitFor();
  assert.equal(await wrapper.locator('.map-price-marker--anchor').count(), 0);
  assert.equal(await wrapper.locator('.map-price-marker--primary').count(), primaryMarkers);
  assert.equal(await wrapper.locator('.map-price-marker--alternative').count(), alternativeMarkers);
}

async function assertConnectedGeoRun({
  fixtures,
  query,
  expectedKeys,
  alternativeKeys = [],
  excludedKeys,
  kind,
  mode,
  label,
  distanceMeters,
  rooms,
  budgetMaxRub,
}) {
  const run = await prisma.assistantRun.findFirstOrThrow({
    where: {
      ownerUserId: fixtures.regular.user.id,
      userMessage: { content: query },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      userMessage: { select: { content: true, geoContextJson: true } },
      assistantMessage: { select: { answerJson: true } },
    },
  });
  const expected = expectedKeys.map((key) => fixtures.connectedGeo.units[key]);
  const alternatives = alternativeKeys.map((key) => fixtures.connectedGeo.units[key]);
  const selected = [...expected, ...alternatives];
  const excluded = excludedKeys.map((key) => fixtures.connectedGeo.units[key]);
  const answer = run.assistantMessage.answerJson;
  assert.deepEqual(run.intentJson.hardFilters.rooms, rooms);
  assert.equal(run.intentJson.hardFilters.budgetMaxRub, budgetMaxRub);
  assert.equal(run.intentJson.hardFilters.objectType, 'RESIDENTIAL');
  for (const key of ['district', 'metro', 'developer']) {
    assert.equal(run.intentJson.hardFilters[key], null);
  }
  assert.deepEqual(run.userMessage.geoContextJson, {
    kind,
    mode,
    label,
    landmarkId: answer.geo.landmarkId,
    ...(distanceMeters === null ? {} : { distanceMeters }),
    source: 'LANDMARK',
  });
  assert.equal(answer.geo.kind, kind);
  assert.equal(answer.geo.mode, mode);
  assert.equal(answer.geo.label, label);
  if (distanceMeters === null) {
    assert.equal(answer.geo.distanceMeters, undefined);
  } else {
    assert.equal(answer.geo.distanceMeters, distanceMeters);
  }
  assert.equal(Object.hasOwn(answer.geo, 'anchor'), false);
  assert.ok(answer.geo.markers.filter(({ kind: markerKind }) => markerKind === 'PRIMARY').length <= 3);
  assert.ok(answer.geo.markers.filter(({ kind: markerKind }) => markerKind === 'ALTERNATIVE').length <= 2);
  assert.deepEqual(
    new Set(answer.exactResults.map(({ unitId }) => unitId)),
    new Set(expected.map(({ id }) => id)),
  );
  assert.deepEqual(
    new Set(answer.alternatives.map(({ unitId }) => unitId)),
    new Set(alternatives.map(({ id }) => id)),
  );
  assert.deepEqual(
    new Set(run.evidenceJson.map(({ unitId }) => unitId)),
    new Set(selected.map(({ id }) => id)),
  );
  assert.deepEqual(
    new Set(run.evidenceJson.map(({ objectId }) => objectId)),
    new Set(selected.map(({ objectId }) => objectId)),
  );
  for (const offer of excluded) {
    assert.equal(run.evidenceJson.some(({ unitId, objectId }) => (
      unitId === offer.id || objectId === offer.objectId
    )), false);
  }
  const landmark = await prisma.assistantGeoLandmark.findUniqueOrThrow({
    where: { id: answer.geo.landmarkId },
    select: {
      kind: true,
      label: true,
      normalizedQuery: true,
      sourceProvider: true,
      confirmationState: true,
      expiresAt: true,
    },
  });
  assert.equal(landmark.kind, kind);
  assert.equal(landmark.label, label);
  assert.equal(landmark.normalizedQuery, kind === 'LINE' ? 'садовое кольцо' : 'район арбат');
  assert.equal(landmark.sourceProvider, 'fake');
  assert.equal(landmark.confirmationState, 'VERIFIED');
  assert.ok(landmark.expiresAt instanceof Date);
  return { answer, run };
}

async function assertLandmarkGeometry(geo, kind) {
  const [row] = kind === 'AREA'
    ? await prisma.$queryRawUnsafe(`
        SELECT ST_AsGeoJSON("geometry", 7)::jsonb AS "referenceGeometry"
        FROM "assistant_geo_landmarks"
        WHERE "id" = $1::uuid
      `, geo.landmarkId)
    : await prisma.$queryRawUnsafe(`
        SELECT
          ST_AsGeoJSON("geometry", 7)::jsonb AS "referenceGeometry",
          ST_AsGeoJSON(ST_Buffer("geometry"::geography, $1)::geometry, 7)::jsonb AS "searchArea"
        FROM "assistant_geo_landmarks"
        WHERE "id" = $2::uuid
      `, geo.distanceMeters, geo.landmarkId);
  assert.ok(row, `missing persisted ${kind} landmark geometry`);
  assert.deepEqual(geo.referenceGeometry, row.referenceGeometry);
  assert.deepEqual(geo.searchArea, kind === 'AREA' ? row.referenceGeometry : row.searchArea);
}

async function readGeoOperationIds(actorUserId, normalizedQuery) {
  return new Set((await prisma.assistantGeoOperation.findMany({
    where: { actorUserId, normalizedQuery },
    select: { id: true },
  })).map(({ id }) => id));
}

async function assertNewGeoOperation({
  actorUserId,
  normalizedQuery,
  previousIds,
  provider,
  providerCallCount,
}) {
  const operations = (await prisma.assistantGeoOperation.findMany({
    where: { actorUserId, normalizedQuery },
    include: { usageAttempts: { orderBy: { attemptOrdinal: 'asc' } } },
  })).filter(({ id }) => !previousIds.has(id));
  assert.equal(operations.length, 1);
  const [operation] = operations;
  assert.equal(operation.provider, provider);
  assert.equal(operation.status, 'RESOLVED');
  assert.equal(operation.cacheHit, false);
  assert.equal(operation.providerCallCount, providerCallCount);
  assert.equal(operation.errorCode, null);
  assert.deepEqual(operation.usageAttempts, []);
}

async function securityJourney(fixtures, journey) {
  assert.equal((await fetch(`${apiOrigin}/assistant/conversations`)).status, 401);
  const own = await httpJson(`/assistant/conversations/${journey.exactRun.conversationId}`, {
    token: journey.accessToken,
  });
  assert.equal(own.status, 200);
  const serialized = JSON.stringify(own.body);
  for (const privateKey of ['evidenceJson', 'telemetryJson', 'auditJson', 'searchPoint', 'rawPayload']) {
    assert.equal(serialized.includes(privateKey), false, `ordinary response leaked ${privateKey}`);
  }
  const other = await loginApi(fixtures.other.user);
  assert.equal((await httpJson(`/assistant/conversations/${journey.exactRun.conversationId}`, {
    token: other.accessToken,
  })).status, 404);
  assert.equal((await httpJson(`/assistant/conversations/${randomUUID()}`, {
    token: journey.accessToken,
  })).status, 404);
  assert.equal((await httpJson('/assistant/audit/runs', { token: journey.accessToken })).status, 403);
  const runtimeConfig = await (await fetch(`${webOrigin}/runtime-config.js`)).text();
  assert.doesNotMatch(runtimeConfig, /OPENAI|LOCATIONIQ|API_KEY|test-only/iu);
}

async function adminJourney(fixtures, journey) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await installMapFixture(page);
  try {
    await login(page, fixtures.admin.user, '/admin/assistant-audit');
    await page.getByRole('heading', { name: 'Аудит ответов' }).waitFor();
    await page.getByLabel('Сигнал качества').selectOption('NEGATIVE_FEEDBACK');
    const runRow = page.getByRole('row').filter({ hasText: 'Нужна двушка до 25 млн' });
    const open = runRow.getByRole('button', { name: 'Открыть' });
    await runRow.waitFor();
    await open.click();
    await page.getByRole('heading', { name: 'Candidate set' }).waitFor();
    assert.match(page.url(), new RegExp(`${journey.exactRun.id}$`, 'u'));
    for (const heading of ['Candidate set', 'Ranking decisions', 'Evidence revisions', 'Provider attempts']) {
      await page.getByRole('heading', { name: heading }).waitFor();
    }
    await page.getByRole('button', { name: 'К списку' }).click();
    await page.getByRole('tab', { name: 'Источники' }).click();
    await page.getByText('severny-sad', { exact: true }).waitFor();
    await page.getByText(/Индексация:.*Успех:/u).waitFor();
    await captureQaScreenshot(page, 'desktop-admin-source-health.png');
    await page.getByRole('button', { name: 'Refresh источника' }).click();
    await page.getByText('Refresh источника поставлен в очередь.').waitFor();
    await page.getByRole('tab', { name: 'Geo' }).click();
    await page.getByRole('heading', { name: 'Geo operations' }).waitFor();
    await page.getByLabel('Запрос').fill('Павелецкая Плаза T07');
    await page.getByLabel('Метка').fill('Павелецкая Плаза, Москва');
    await page.getByLabel('Широта').fill('55.7312');
    await page.getByLabel('Долгота').fill('37.6364');
    await page.getByRole('button', { name: 'Сохранить alias' }).click();
    await page.getByText('Internal alias подтверждён и сохранён.').waitFor();
  } finally {
    await context.close();
  }
}

async function mobileJourney(fixtures) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await installMapFixture(page);
  try {
    await login(page, fixtures.regular.user);
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    const box = await page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' }).boundingBox();
    assert.deepEqual(box && {
      x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
    }, { x: 0, y: 0, width: 390, height: 844 });
    const sendBox = await page.getByRole('button', { name: 'Отправить' }).boundingBox();
    assert.ok(sendBox && sendBox.width >= 44 && sendBox.height >= 44);
    await captureQaScreenshot(
      page,
      'mobile-assistant.png',
      page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' }),
    );
    await page.getByRole('button', { name: 'Закрыть помощника' }).click();
    await navigateSpa(page, '/catalog/map?lotRooms=2&lotPriceMax=25000000');
    const map = page.getByRole('region', { name: 'Карта объектов' });
    await map.locator('.map-price-marker').first().waitFor();
    await map.locator('.map-price-marker').first().tap();
    const fullscreenBox = await map.getByRole('button', { name: 'Открыть карту на весь экран' }).boundingBox();
    assert.ok(fullscreenBox && fullscreenBox.width >= 44 && fullscreenBox.height >= 44);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await context.close();
  }
}

async function mapDegradationJourney(fixtures, outage) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await installMapFixture(page, outage === 'style' ? { styleStatus: 503 } : { tileStatus: 503 });
  try {
    await login(page, fixtures.regular.user);
    await navigateSpa(page, '/catalog/map?lotRooms=2&lotPriceMax=25000000');
    const map = page.getByRole('region', { name: 'Карта объектов' });
    await map.getByRole('heading', { name: 'Карта временно недоступна' }).waitFor();
    await page.getByRole('complementary', { name: 'Объекты на карте' })
      .getByText('ЖК Северный сад', { exact: true })
      .waitFor();
    await captureQaScreenshot(page, `desktop-map-${outage}-degradation.png`);
  } finally {
    await context.close();
  }
}

async function login(page, user, destination = '/cabinet') {
  await page.goto(`${webOrigin}${destination}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  const response = page.waitForResponse((candidate) => (
    candidate.url() === `${apiOrigin}/auth/login` && candidate.status() === 200
  ));
  await page.getByRole('button', { name: 'Войти' }).click();
  const session = await (await response).json();
  return session;
}

async function loginApi(user) {
  const response = await httpJson('/auth/login', {
    method: 'POST', body: { email: user.email, password },
  });
  assert.equal(response.status, 200);
  return response.body;
}

async function submit(page, input, content) {
  await input.fill(content);
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Отправить"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  const button = page.getByRole('button', { name: 'Отправить' });
  await button.click();
}

async function startNewConversation(page) {
  await page.getByRole('button', { name: 'История разговоров' }).click();
  const history = page.getByRole('complementary', { name: 'История разговоров' });
  await history.waitFor();
  await history.getByRole('button', { name: 'Новый разговор' }).click();
}

async function waitForAssistantArticle(page, query) {
  const userArticle = page.locator('.assistant-message--user').filter({ hasText: query }).last();
  await userArticle.waitFor();
  const assistantArticle = userArticle.locator(
    'xpath=following-sibling::article[contains(@class,"assistant-message--assistant")][1]',
  );
  await assistantArticle.waitFor();
  return assistantArticle;
}

async function captureProgress(page, action) {
  await page.evaluate(() => {
    window.__assistantT07Progress = [];
    window.__assistantT07Observer = new MutationObserver(() => {
      for (const node of document.querySelectorAll('.assistant-progress')) {
        const label = node.textContent?.trim();
        if (label && !window.__assistantT07Progress.includes(label)) window.__assistantT07Progress.push(label);
      }
    });
    window.__assistantT07Observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
  });
  await action();
  return page.evaluate(() => {
    window.__assistantT07Observer?.disconnect();
    return window.__assistantT07Progress;
  });
}

async function navigateSpa(page, pathname) {
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, pathname);
  await page.waitForTimeout(150);
}

async function installMapFixture(page, options = {}) {
  if (options.styleStatus) {
    const fulfillStyleFailure = (route) => route.fulfill({
      status: options.styleStatus,
      contentType: 'text/plain',
      body: 'fixture style unavailable',
    });
    await page.route('https://map-fixtures.test/style.json', fulfillStyleFailure);
    await page.route(/\/__map_fixture__\/style\.json(?:\?.*)?$/u, fulfillStyleFailure);
    await page.route(/\.(?:woff2?|ttf)(?:\?.*)?$/u, (route) => route.abort());
    return;
  }
  const tileFixture = createDeterministicMapTile();
  const fulfillTile = (route) => route.fulfill({
    status: options.tileStatus ?? 200,
    contentType: options.tileStatus ? 'text/plain' : 'image/png',
    body: options.tileStatus ? 'fixture tile unavailable' : tileFixture,
  });
  await page.route(/https:\/\/map-fixtures\.test\/tiles\/.*\.png/u, fulfillTile);
  await page.route(/\/__map_fixture__\/tiles\/.*\.png(?:\?.*)?$/u, fulfillTile);
  await page.route('https://map-fixtures.test/style.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      version: 8,
      sources: {
        rasterFixture: {
          type: 'raster',
          tiles: ['https://map-fixtures.test/tiles/{z}/{x}/{y}.png'],
          tileSize: 256,
          minzoom: 0,
          maxzoom: 14,
        },
        attribution: {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://openstreetmap.org">OpenStreetMap</a>',
        },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#f3f0e9' } },
        {
          id: 'raster-fixture',
          type: 'raster',
          source: 'rasterFixture',
          paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 },
        },
        { id: 'attribution-points', type: 'circle', source: 'attribution', paint: { 'circle-radius': 1 } },
      ],
    }),
  }));
  await page.route(/\.(?:woff2?|ttf)(?:\?.*)?$/u, (route) => route.abort());
}

async function captureQaScreenshot(page, name, target) {
  const directory = process.env.ASSISTANT_T07_QA_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  if (target) {
    await target.screenshot({ path: resolve(directory, name) });
    return;
  }
  await page.screenshot({ path: resolve(directory, name), fullPage: true });
}

function createDeterministicMapTile() {
  const width = 256;
  const pixels = Buffer.alloc(width * width * 4);
  fillRect(pixels, width, 0, 0, width, width, [243, 240, 233, 255]);
  fillRect(pixels, width, 20, 28, 56, 42, [218, 229, 207, 255]);
  fillRect(pixels, width, 174, 162, 58, 62, [218, 229, 207, 255]);
  drawCircle(pixels, width, 128, 128, 82, [209, 191, 151, 255], 3);
  for (const [x1, y1, x2, y2] of [
    [0, 112, 256, 146], [24, 0, 188, 256], [0, 205, 256, 58], [62, 256, 218, 0],
  ]) drawLine(pixels, width, x1, y1, x2, y2, [210, 202, 188, 255], 2);
  for (let y = 0; y < width; y += 1) {
    const x = Math.round(151 + 15 * Math.sin(y / 27));
    drawCircle(pixels, width, x, y, 4, [148, 196, 211, 255], 1);
  }
  drawCircle(pixels, width, 128, 128, 5, [234, 96, 24, 255], 1);
  const rows = Buffer.alloc((width * 4 + 1) * width);
  for (let y = 0; y < width; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    rows[rowOffset] = 0;
    pixels.copy(rows, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function fillRect(pixels, width, x, y, rectangleWidth, rectangleHeight, color) {
  for (let row = y; row < y + rectangleHeight; row += 1) {
    for (let column = x; column < x + rectangleWidth; column += 1) {
      setPixel(pixels, width, column, row, color);
    }
  }
}

function drawLine(pixels, width, x1, y1, x2, y2, color, thickness) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + (x2 - x1) * step / steps);
    const y = Math.round(y1 + (y2 - y1) * step / steps);
    drawCircle(pixels, width, x, y, thickness, color, 1);
  }
}

function drawCircle(pixels, width, centerX, centerY, radius, color, thickness) {
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance <= radius && distance >= Math.max(0, radius - thickness)) {
        setPixel(pixels, width, x, y, color);
      }
    }
  }
}

function setPixel(pixels, width, x, y, color) {
  if (x < 0 || x >= width || y < 0 || y >= width) return;
  pixels.set(color, (y * width + x) * 4);
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), data.length + 8);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertProviderIsolation(urls) {
  assert.deepEqual(urls.filter((url) => (
    /openai|locationiq|overpass|api-maps\.yandex|yandex\.net\/maps|openfreemap|openrouteservice/iu.test(url)
  )), []);
}

async function countUserRuns(userId) {
  return prisma.assistantRun.count({ where: { ownerUserId: userId } });
}

async function waitForCount(read, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await read() >= expected) return;
    await delay(25);
  }
  throw new Error(`ASSISTANT_T07_COUNT_TIMEOUT:${expected}`);
}

async function httpJson(pathname, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${apiOrigin}${pathname}`, {
    method: options.method ?? 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function projectNorth(latitude, meters) {
  return { latitude: latitude + (meters / 6_378_137) * (180 / Math.PI), longitude: 37.618423 };
}

function parseDistanceMeters(value) {
  const normalized = value.replace(',', '.');
  const numeric = Number.parseFloat(normalized.replace(/[^\d.]/gu, ''));
  if (!Number.isFinite(numeric)) throw new Error(`ASSISTANT_T07_DISTANCE_INVALID:${value}`);
  return /км/iu.test(value) ? numeric * 1_000 : numeric;
}

function oldDate() {
  return new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
}

function databaseUrl(name) {
  return `postgresql://platforma:${encodeURIComponent(databasePassword)}@127.0.0.1:${postgresPort}/${name}?schema=public`;
}

function internalDatabaseUrl(name) {
  return `postgresql://platforma:${encodeURIComponent(databasePassword)}@postgres:5432/${name}?schema=public`;
}

async function reservePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function run(command, args, options = {}) {
  const result = await runRuntimeCommand(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    timeoutMs: options.timeout ?? 60_000,
    allowDuringShutdown: options.allowDuringShutdown,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function cleanup() {
  if (cleanupPromise === null) {
    cleanupPromise = cleanupOnce();
    return cleanupPromise;
  }
  cleanupPromise = cleanupPromise.then(
    () => cleanupOwnedDockerResources(),
    async (initialError) => {
      try {
        await cleanupOwnedDockerResources();
      } catch (resweepError) {
        throw new AggregateError(
          [initialError, resweepError],
          'ASSISTANT_T07_CLEANUP_AND_RESWEEP_FAILED',
        );
      }
      throw initialError;
    },
  );
  return cleanupPromise;
}

async function cleanupOnce() {
  globalThis.fetch = originalFetch;
  const errors = [];
  await collectCleanupError(errors, async () => browser?.close());
  await collectCleanupError(errors, async () => stopChildProcess(webProcess, 5_000));
  await collectCleanupError(errors, async () => apiApp?.close());
  await collectCleanupError(errors, async () => prisma?.$disconnect());
  await collectCleanupError(errors, async () => {
    if (sourceServer?.listening) {
      await new Promise((done, reject) => sourceServer.close((error) => (error ? reject(error) : done())));
    }
  });
  await collectCleanupError(errors, cleanupOwnedDockerResources);
  if (errors.length > 0) throw new AggregateError(errors, 'ASSISTANT_T07_CLEANUP_FAILED');
}

async function cleanupOwnedDockerResources() {
  await removeOwnedDockerResources('container');
  await removeOwnedDockerResources('network');
}

async function collectCleanupError(errors, cleanupTask) {
  try {
    await cleanupTask();
  } catch (error) {
    errors.push(error);
  }
}

async function stopChildProcess(child, graceMs) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise((resolveExit) => child.once('close', resolveExit));
  const reachedGrace = await Promise.race([
    exited.then(() => false),
    delay(graceMs).then(() => true),
  ]);
  if (!reachedGrace) return;
  child.kill('SIGKILL');
  await exited;
}

async function removeOwnedDockerResources(kind) {
  await removeT07OwnedDockerResources(kind, dockerOwnership, (args) => run('docker', args, {
    timeout: 15_000,
    allowDuringShutdown: true,
  }));
}
