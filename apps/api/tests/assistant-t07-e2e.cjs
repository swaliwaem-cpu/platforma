require('reflect-metadata');

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { cp, mkdir, mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
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

const root = resolve(__dirname, '../../..');
const apiRoot = resolve(root, 'apps/api');
const webRoot = resolve(root, 'apps/web');
const prismaRoot = resolve(apiRoot, 'prisma');
const container = `platforma-assistant-t07-${randomUUID().slice(0, 8)}`;
const network = `${container}-network`;
const databasePassword = `assistant-t07-${randomUUID()}`;
const password = 'AssistantT07!';
let postgresPort;
let apiOrigin;
let webOrigin;
let prisma;
let apiApp;
let browser;
let sourceServer;
let sourceRequests = [];
let webProcess;

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  try {
    if (process.env.ASSISTANT_T07_SKIP_DOCKER_BUILD !== 'true') {
      await run('docker', ['compose', 'build', 'postgres', 'api'], { timeout: 300_000 });
    }
    postgresPort = await reservePort();
    await run('docker', ['network', 'create', network]);
    await startPostgres();
    await verifyMigrationReplay();
    configureSafeEnvironment(databaseUrl('platforma'));
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl('platforma') } } });
    await prisma.$connect();
    const sourceOrigin = await startSourceStub();
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
    await startWeb(webPort);
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
    assert.equal(sourceRequests.length >= 1, true, 'stub source connector was not used');
    process.stdout.write('ASSISTANT_T07_E2E_OK\n');
  } finally {
    await cleanup();
  }
}

async function startPostgres() {
  await run('docker', [
    'run', '--detach', '--rm', '--name', container, '--platform', 'linux/amd64',
    '--env', 'POSTGRES_DB=platforma', '--env', 'POSTGRES_USER=platforma',
    '--env', `POSTGRES_PASSWORD=${databasePassword}`, '--network', network,
    '--network-alias', 'postgres',
    '--publish', `127.0.0.1:${postgresPort}:5432`,
    'platforma-postgres:16-postgis3.5-pgvector0.8.6',
  ]);
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
    'run', '--rm', '--network', network,
    '--env', `DATABASE_URL=${url}`,
    '--volume', `${directory}:/app/apps/api/prisma:ro`,
    'platforma-api:local',
    'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'deploy',
    '--schema', '/app/apps/api/prisma/schema.prisma',
  ], { timeout: 120_000 });
}

function migrationStatus(directory, url) {
  return run('docker', [
    'run', '--rm', '--network', network,
    '--env', `DATABASE_URL=${url}`,
    '--volume', `${directory}:/app/apps/api/prisma:ro`,
    'platforma-api:local',
    'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'status',
    '--schema', '/app/apps/api/prisma/schema.prisma',
  ], { timeout: 60_000 });
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
  sourceServer = createServer((request, response) => {
    sourceRequests.push(request.url ?? '/');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', etag: '"assistant-t07-fixture"',
      'last-modified': 'Wed, 26 Aug 2026 08:00:00 GMT',
    });
    response.end(html);
  });
  await new Promise((done) => sourceServer.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${sourceServer.address().port}`;
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
  return { regular, other, admin, objects, units };
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

async function startWeb(port) {
  await run('pnpm', ['--filter', '@platforma/web', 'build'], {
    env: { VITE_API_URL: apiOrigin }, timeout: 120_000,
  });
  webProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: webRoot,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), MAP_PROVIDER_ENABLED: 'true',
      MAP_STYLE_URL: 'https://map-fixtures.test/style.json',
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

async function userJourney(fixtures) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const requestedUrls = [];
  const failedRequestUrls = [];
  const unauthorizedUrls = [];
  const serviceUnavailableUrls = [];
  const runtimeErrors = [];
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
    await page.getByText('Павелецкая Плаза · 2 км', { exact: true }).waitFor();
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
    await page.getByRole('button', { name: 'Изменить точку и радиус' }).click();
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
    assert.equal(requestedUrls.some((url) => url.startsWith('https://map-fixtures.test/tiles/')), true);
    assert.deepEqual(failedRequestUrls.filter(({ url, errorText }) => (
      !/\.(?:woff2?|ttf)(?:\?.*)?$/u.test(url)
      && !(url === `${apiOrigin}/assistant/config` && errorText === 'net::ERR_ABORTED')
      && !(url.startsWith('https://map-fixtures.test/tiles/') && errorText === 'net::ERR_ABORTED')
    )), []);
    assert.equal(unauthorizedUrls.length >= 1, true);
    assert.deepEqual(unauthorizedUrls.filter((url) => url !== `${apiOrigin}/auth/refresh`), []);
    assert.deepEqual([...new Set(serviceUnavailableUrls)], [`${apiOrigin}/assistant/conversations`]);
    assert.deepEqual(runtimeErrors.filter((message) => (
      !/Failed to load resource: the server responded with a status of 503/iu.test(message)
      && !/Failed to load resource: the server responded with a status of 401/iu.test(message)
      && !/GL Driver Message .*GPU stall due to ReadPixels/iu.test(message)
    )), []);
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
    await page.getByText('Павелецкая Плаза · 2 км', { exact: true }).waitFor();
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
    await page.route('https://map-fixtures.test/style.json', (route) => route.fulfill({
      status: options.styleStatus,
      contentType: 'text/plain',
      body: 'fixture style unavailable',
    }));
    await page.route(/\.(?:woff2?|ttf)(?:\?.*)?$/u, (route) => route.abort());
    return;
  }
  const tileFixture = createDeterministicMapTile();
  await page.route(/https:\/\/map-fixtures\.test\/tiles\/.*\.png/u, (route) => route.fulfill({
    status: options.tileStatus ?? 200,
    contentType: options.tileStatus ? 'text/plain' : 'image/png',
    body: options.tileStatus ? 'fixture tile unavailable' : tileFixture,
  }));
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
    /openai|locationiq|api-maps\.yandex|yandex\.net\/maps|tiles\.openfreemap|openrouteservice/iu.test(url)
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
  const result = await new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, options.timeout ?? 60_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timer);
      done({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function cleanup() {
  if (browser) await browser.close().catch(() => undefined);
  if (webProcess && !webProcess.killed) webProcess.kill('SIGTERM');
  if (apiApp) await apiApp.close().catch(() => undefined);
  if (prisma) await prisma.$disconnect().catch(() => undefined);
  if (sourceServer) await new Promise((done) => sourceServer.close(done));
  await run('docker', ['rm', '--force', container], { allowFailure: true, timeout: 15_000 })
    .catch(() => undefined);
  await run('docker', ['network', 'rm', network], { allowFailure: true, timeout: 15_000 })
    .catch(() => undefined);
}
