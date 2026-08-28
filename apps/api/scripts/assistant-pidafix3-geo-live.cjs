const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, readFile, stat, writeFile } = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { hash } = require('argon2');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright-core');

const {
  calculateTaskDiffSha,
  cleanupComposeProject,
  createBaselineGateManifest,
  createSafeEnvironment,
  migrateDatabase,
  redact,
  reservePort,
  runCommand,
  runRecorded,
  seedMigrationBaseline,
} = require('./assistant-pidafix3-baseline.cjs');
const {
  installTerminationHandlers,
  validateLocalDockerDaemon,
} = require('./assistant-pidafix3-runtime.cjs');

const root = resolve(__dirname, '../../..');
const composeFile = resolve(root, 'docker-compose.assistant-pidafix3.yml');
const liveComposeFile = resolve(root, 'docker-compose.assistant-pidafix3-geo-live.yml');
const exactCaps = Object.freeze({ locationiq: 8, overpass: 3, total: 11 });
const baselineMaximumAgeMs = 24 * 60 * 60_000;
const requiredBaselineSetupIds = Object.freeze([
  'compose-config', 'compose-build', 'postgres-up',
  'migrate-platforma_pidafix3', 'migration-status-platforma_pidafix3',
  'create-db-fix_token_test', 'migrate-fix_token_test', 'migration-status-fix_token_test',
  'create-db-t03_test', 'migrate-t03_test', 'migration-status-t03_test',
  'create-db-t05_test', 'migrate-t05_test', 'migration-status-t05_test',
  'create-db-pidafix2_test', 'migrate-pidafix2_test', 'migration-status-pidafix2_test',
  'api-web-up', 'compose-down', 'image-rm-postgres', 'image-rm-api', 'image-rm-web',
]);
const requiredBaselineGates = Object.freeze(createBaselineGateManifest());
const geoLiveCases = Object.freeze([
  {
    slug: 'point',
    content: 'Найди квартиру возле Белорусского вокзала',
    label: 'Белорусского вокзала',
    normalizedQuery: 'белорусского вокзала',
    kind: 'POINT', mode: 'NEAR', provider: 'locationiq', attempts: ['locationiq'],
  },
  {
    slug: 'sadovoe', content: 'Найди квартиру рядом с Садовым кольцом', label: 'Садовое кольцо',
    normalizedQuery: 'садовое кольцо', kind: 'LINE', mode: 'NEAR', provider: 'overpass',
    attempts: ['locationiq', 'locationiq', 'overpass'],
  },
  {
    slug: 'ttk', content: 'Найди квартиру рядом с ТТК', label: 'ТТК',
    normalizedQuery: 'третье транспортное кольцо', kind: 'LINE', mode: 'NEAR', provider: 'overpass',
    attempts: ['locationiq', 'locationiq', 'overpass'],
  },
  {
    slug: 'mkad', content: 'Найди квартиру рядом с МКАД', label: 'МКАД',
    normalizedQuery: 'московская кольцевая автодорога', kind: 'LINE', mode: 'NEAR', provider: 'overpass',
    attempts: ['locationiq', 'locationiq', 'overpass'],
  },
  {
    slug: 'arbat', content: 'Найди квартиру внутри района Арбат', label: 'район Арбат',
    normalizedQuery: 'район арбат', kind: 'AREA', mode: 'INSIDE', provider: 'locationiq', attempts: ['locationiq'],
  },
]);

if (require.main === module) {
  const cli = parseGeoLiveArguments(process.argv.slice(2));
  if (!cli.execute) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      cases: geoLiveCases.map(({ slug }) => slug),
      maximumExternalCalls: exactCaps,
      costUsd: null,
      hint: 'A new explicit user command and --run-live-geo with exact caps are required.',
    }, null, 2)}\n`);
  } else {
    const termination = installTerminationHandlers();
    const providerKey = process.env.LOCATIONIQ_API_KEY ?? '';
    void runGeoLiveSmoke(cli, { termination }).catch((error) => {
      process.stderr.write(`${redact(error instanceof Error ? error.message : error, [providerKey])}\n`);
      process.exitCode = termination.exitCode ?? 1;
    }).finally(() => termination.dispose());
  }
}

function parseGeoLiveArguments(argv) {
  if (!Array.isArray(argv)) throw new Error('PIDAFIX3_GEO_LIVE_ARGS_INVALID');
  if (argv.length === 0) return { execute: false, ...exactCaps, baselineReport: null };
  let execute = false;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--run-live-geo') {
      if (execute) throw new Error('PIDAFIX3_GEO_LIVE_ARG_DUPLICATE');
      execute = true;
      continue;
    }
    if (![
      '--max-locationiq-attempts', '--max-overpass-attempts', '--max-total-attempts', '--baseline-report',
    ].includes(argument)) throw new Error('PIDAFIX3_GEO_LIVE_ARG_UNKNOWN');
    if (values.has(argument)) throw new Error('PIDAFIX3_GEO_LIVE_ARG_DUPLICATE');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('PIDAFIX3_GEO_LIVE_ARG_VALUE_REQUIRED');
    values.set(argument, value);
    index += 1;
  }
  if (!execute) throw new Error('PIDAFIX3_GEO_LIVE_OPT_IN_REQUIRED');
  const locationiq = readExactLimit(values.get('--max-locationiq-attempts'), exactCaps.locationiq, 'LOCATIONIQ');
  const overpass = readExactLimit(values.get('--max-overpass-attempts'), exactCaps.overpass, 'OVERPASS');
  const total = readExactLimit(values.get('--max-total-attempts'), exactCaps.total, 'TOTAL');
  const baselineReport = values.get('--baseline-report');
  if (!baselineReport || !isAbsolute(baselineReport)) throw new Error('PIDAFIX3_GEO_LIVE_BASELINE_REPORT_ABSOLUTE_REQUIRED');
  return { execute: true, locationiq, overpass, total, baselineReport };
}

function readExactLimit(value, expected, name) {
  if (value === undefined) throw new Error(`PIDAFIX3_GEO_LIVE_MAX_${name}_REQUIRED`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed !== expected) throw new Error(`PIDAFIX3_GEO_LIVE_MAX_${name}_INVALID`);
  return parsed;
}

function validateFakeBaselineReport(report, expected) {
  assert.equal(report?.version, 1, 'PIDAFIX3_GEO_LIVE_BASELINE_VERSION_INVALID');
  assert.equal(report.head, expected.head, 'PIDAFIX3_GEO_LIVE_BASELINE_HEAD_MISMATCH');
  assert.equal(report.taskDiffSha256, expected.taskDiffSha256, 'PIDAFIX3_GEO_LIVE_BASELINE_DIFF_MISMATCH');
  assert.equal(Object.hasOwn(report, 'failure'), false, 'PIDAFIX3_GEO_LIVE_BASELINE_HAS_FAILURE');
  const startedAt = readCanonicalTimestamp(report.startedAt, 'STARTED_AT');
  const finishedAt = readCanonicalTimestamp(report.finishedAt, 'FINISHED_AT');
  const nowMs = expected.nowMs ?? Date.now();
  assert.ok(startedAt <= finishedAt, 'PIDAFIX3_GEO_LIVE_BASELINE_TIME_ORDER_INVALID');
  assert.ok(finishedAt <= nowMs + 60_000, 'PIDAFIX3_GEO_LIVE_BASELINE_FROM_FUTURE');
  assert.ok(nowMs - finishedAt <= baselineMaximumAgeMs, 'PIDAFIX3_GEO_LIVE_BASELINE_STALE');
  assert.deepEqual(report.setup?.map(({ id }) => id), requiredBaselineSetupIds,
    'PIDAFIX3_GEO_LIVE_BASELINE_SETUP_INCOMPLETE');
  assert.equal(report.setup.every(({ exitCode }) => exitCode === 0), true,
    'PIDAFIX3_GEO_LIVE_BASELINE_SETUP_FAILED');
  assert.deepEqual(report.gates?.map(({ id, command }) => ({ id, command })), requiredBaselineGates,
    'PIDAFIX3_GEO_LIVE_BASELINE_GATES_INCOMPLETE');
  assert.equal(report.gates.every(({ exitCode }) => exitCode === 0), true, 'PIDAFIX3_GEO_LIVE_BASELINE_GATE_FAILED');
  assert.deepEqual(report.readiness, {
    healthStatus: 200,
    webStatus: 200,
    unauthenticatedAssistantStatus: 401,
    authenticatedAssistantStatus: 200,
    assistantEnabled: true,
    permissionKeys: ['objects:read', 'admin:access'],
    seedMode: 'minimal-rbac-without-db-seed',
    assistantBacklog: 0,
    postgisVersion: report.readiness?.postgisVersion,
    landmarkTable: 'assistant_geo_landmarks',
  }, 'PIDAFIX3_GEO_LIVE_BASELINE_READINESS_INVALID');
  assert.match(report.readiness.postgisVersion, /^3\./u, 'PIDAFIX3_GEO_LIVE_BASELINE_POSTGIS_INVALID');
  assert.deepEqual(report.manualQa, { requested: true, runtimeReady: true, completed: true },
    'PIDAFIX3_GEO_LIVE_BASELINE_MANUAL_QA_INCOMPLETE');
  assert.equal(report.cleanup?.completed, true, 'PIDAFIX3_GEO_LIVE_BASELINE_CLEANUP_INCOMPLETE');
  assert.deepEqual(report.cleanup?.residualResources, {
    containers: [], networks: [], volumes: [], nestedContainers: [], nestedNetworks: [], images: [],
  }, 'PIDAFIX3_GEO_LIVE_BASELINE_RESOURCES_REMAIN');
  assert.equal(report.cleanup?.preexistingContainersPreserved, true,
    'PIDAFIX3_GEO_LIVE_BASELINE_PREEXISTING_CONTAINERS_CHANGED');
  assert.equal(report.cleanup?.exactImageTagsRemoved, true,
    'PIDAFIX3_GEO_LIVE_BASELINE_IMAGES_REMAIN');
  assert.equal(report.externalProviderEvidence?.status, 'verified', 'PIDAFIX3_GEO_LIVE_BASELINE_EGRESS_UNVERIFIED');
  assert.deepEqual(report.externalProviderEvidence?.calls, { openai: 0, locationiq: 0, overpass: 0 });
  assert.deepEqual(report.externalProviderEvidence?.persistedUsageAttempts,
    { openai: 0, locationiq: 0, overpass: 0 });
  assert.equal(report.externalProviderEvidence?.deniedRemoteRequests, 0);
  assert.equal(report.costUsd, 0, 'PIDAFIX3_GEO_LIVE_BASELINE_COST_INVALID');
  return true;
}

function readCanonicalTimestamp(value, name) {
  assert.equal(typeof value, 'string', `PIDAFIX3_GEO_LIVE_BASELINE_${name}_INVALID`);
  const timestamp = Date.parse(value);
  assert.equal(Number.isFinite(timestamp), true, `PIDAFIX3_GEO_LIVE_BASELINE_${name}_INVALID`);
  assert.equal(new Date(timestamp).toISOString(), value, `PIDAFIX3_GEO_LIVE_BASELINE_${name}_INVALID`);
  return timestamp;
}

function createGeoLiveEnvironment(baseEnvironment, values) {
  if (Object.hasOwn(baseEnvironment, 'ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE')) {
    throw new Error('PIDAFIX3_GEO_LIVE_LEGACY_REMOTE_FLAG_FORBIDDEN');
  }
  const providerKey = readSecret(baseEnvironment.LOCATIONIQ_API_KEY, 'PIDAFIX3_GEO_LIVE_LOCATIONIQ_KEY_REQUIRED');
  const environment = createSafeEnvironment(baseEnvironment, {
    PIDAFIX3_POSTGRES_IMAGE: `platforma-pidafix3-geo-postgres:${values.suffix}`,
    PIDAFIX3_API_IMAGE: `platforma-pidafix3-geo-api:${values.suffix}`,
    PIDAFIX3_WEB_IMAGE: `platforma-pidafix3-geo-web:${values.suffix}`,
    PIDAFIX3_POSTGRES_PASSWORD: values.postgresPassword,
    PIDAFIX3_POSTGRES_PORT: String(values.postgresPort),
    PIDAFIX3_API_PORT: String(values.apiPort),
    PIDAFIX3_WEB_PORT: String(values.webPort),
    PIDAFIX3_MAP_PORT: String(values.mapPort),
    PIDAFIX3_JWT_ACCESS_SECRET: `pidafix3-geo-access-${randomUUID()}`,
    PIDAFIX3_JWT_REFRESH_SECRET: `pidafix3-geo-refresh-${randomUUID()}`,
    PIDAFIX3_JWT_MEDIA_SECRET: `pidafix3-geo-media-${randomUUID()}`,
    PIDAFIX3_EMAIL_AUTH_SECRET: `pidafix3-geo-email-${randomUUID()}`,
    PIDAFIX3_LOCATIONIQ_API_KEY: providerKey,
  });
  return environment;
}

async function runGeoLiveSmoke(cli, options = {}) {
  const termination = options.termination ?? createNoopTermination();
  termination.throwIfRequested();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const project = `platforma-pidafix3-${suffix}`;
  const values = {
    suffix,
    postgresPassword: `p${randomUUID().replaceAll('-', '')}`,
    postgresPort: await reservePort(),
    apiPort: await reservePort(),
    webPort: await reservePort(),
    mapPort: await reservePort(),
  };
  const initialEnvironment = createGeoLiveEnvironment(process.env, values);
  const dockerTarget = await validateLocalDockerDaemon(initialEnvironment);
  const environment = dockerTarget.environment;
  const qaDirectory = await mkdtemp(join(tmpdir(), `platforma-pidafix3-geo-live-${suffix}-`));
  const report = {
    version: 1,
    mode: 'geo-live',
    project,
    startedAt: new Date().toISOString(),
    head: await readTextCommand('git', ['rev-parse', 'HEAD'], environment),
    taskDiffSha256: await calculateTaskDiffSha(environment),
    baselineReport: cli.baselineReport,
    dockerTarget: dockerTarget.facts,
    caps: { locationiq: cli.locationiq, overpass: cli.overpass, total: cli.total },
    providerCalls: { status: 'not-measured', locationiq: null, overpass: null, total: null },
    providerCallEvidence: { status: 'not-measured', statuses: null },
    costUsd: null,
    costReason: 'Provider plan pricing is external and is not inferred by Platforma.',
    setup: [],
    cases: [],
    browser: { completed: false, providerCountersUnchanged: false, externalRequests: [] },
    screenshots: { directory: qaDirectory, files: [] },
    cleanup: { completed: false },
  };
  const providerKey = environment.PIDAFIX3_LOCATIONIQ_API_KEY;
  const secrets = [
    providerKey,
    values.postgresPassword,
    environment.PIDAFIX3_JWT_ACCESS_SECRET,
    environment.PIDAFIX3_JWT_REFRESH_SECRET,
    environment.PIDAFIX3_JWT_MEDIA_SECRET,
    environment.PIDAFIX3_EMAIL_AUTH_SECRET,
  ];
  const compose = [
    'compose', '--env-file', '/dev/null', '--file', composeFile, '--file', liveComposeFile,
    '--project-name', project,
  ];
  const hostDatabaseUrl = databaseUrl(values);
  secrets.push(hostDatabaseUrl);
  const beforeContainers = new Set(splitLines(await readTextCommand('docker', ['ps', '--quiet'], environment)));
  let prisma = null;
  let mapServer = null;
  let mapRequests = null;
  let browser = null;
  let primaryError = null;
  let cleanupError = null;
  let credentials = null;
  let apiMayBeRunning = false;
  let providerBoundaryStopPromise = null;
  const stopProviderBoundary = () => {
    if (!apiMayBeRunning) return null;
    providerBoundaryStopPromise ??= runCommand('docker', [
      ...compose, 'kill', '--signal', 'SIGKILL', 'api',
    ], { env: environment, cwd: root, timeoutMs: 30_000, allowDuringShutdown: true });
    return providerBoundaryStopPromise;
  };
  const handleTermination = () => {
    void browser?.close();
    setImmediate(() => { void stopProviderBoundary()?.catch(() => {}); });
  };
  termination.abortSignal?.addEventListener('abort', handleTermination, { once: true });

  try {
    termination.throwIfRequested();
    const baselineFile = await stat(cli.baselineReport);
    assert.equal(baselineFile.isFile(), true);
    assert.equal(baselineFile.mode & 0o077, 0, 'PIDAFIX3_GEO_LIVE_BASELINE_REPORT_MODE_UNSAFE');
    validateFakeBaselineReport(JSON.parse(await readFile(cli.baselineReport, 'utf8')), {
      head: report.head,
      taskDiffSha256: report.taskDiffSha256,
    });
    await runRecorded(report.setup, 'compose-config', 'docker', [...compose, 'config', '--quiet'], {
      env: environment, secrets,
    });
    await runRecorded(report.setup, 'compose-build', 'docker', [...compose, 'build', 'postgres', 'api', 'web'], {
      env: environment, secrets, timeoutMs: 15 * 60_000,
    });
    await runRecorded(report.setup, 'postgres-up', 'docker', [...compose, 'up', '--detach', '--wait', 'postgres'], {
      env: environment, secrets, timeoutMs: 3 * 60_000,
    });
    await migrateDatabase({ compose, composeEnvironment: environment, name: 'platforma_pidafix3', report, secrets });
    await seedMigrationBaseline(hostDatabaseUrl);
    prisma = new PrismaClient({ datasources: { db: { url: hostDatabaseUrl } } });
    await prisma.$connect();
    await assertCleanGeoDatabase(prisma);
    await reconcileProviderCallReport(prisma, report, cli);
    credentials = await seedGeoLiveUser(prisma);
    ({ server: mapServer, requests: mapRequests } = await startMapStub(values.mapPort));
    apiMayBeRunning = true;
    await runRecorded(report.setup, 'api-web-up', 'docker', [
      ...compose, 'up', '--detach', '--wait', 'api', 'web',
    ], { env: environment, secrets, timeoutMs: 5 * 60_000 });
    const apiOrigin = `http://127.0.0.1:${values.apiPort}`;
    const webOrigin = `http://127.0.0.1:${values.webPort}`;
    const terminationAwareFetch = createTerminationAwareFetch(termination.abortSignal);
    await assertLoopbackRuntimeReady(apiOrigin, webOrigin, terminationAwareFetch, termination.abortSignal);
    const accessToken = await loginApi(apiOrigin, credentials, terminationAwareFetch);
    const resolved = new Map();
    const { spent } = await executeGeoCasesSequentially(geoLiveCases, cli, {
      termination,
      executeCase: async (smokeCase) => {
        const payload = await resolveCase(apiOrigin, accessToken, smokeCase, terminationAwareFetch);
        const audit = await readCaseAudit(prisma, credentials.userId, smokeCase, payload);
        report.cases.push(audit.report);
        resolved.set(smokeCase.slug, audit);
        await reconcileProviderCallReport(prisma, report, cli);
        return audit;
      },
    });
    assert.deepEqual(spent, exactCaps);
    termination.throwIfRequested();
    const fixtures = await seedBrowserOffers(prisma, resolved);
    const beforeBrowser = await readProviderCounters(prisma);
    browser = await chromium.launch({ headless: true });
    const browserResult = await runSavedLandmarkBrowserProof({
      apiOrigin,
      browser,
      credentials,
      fixtures,
      mapOrigin: `http://127.0.0.1:${values.mapPort}`,
      mapRequests,
      qaDirectory,
      resolved,
      webOrigin,
    });
    const afterBrowser = await readProviderCounters(prisma);
    assertProviderCountersUnchanged(beforeBrowser, afterBrowser);
    const landmarkDbOperations = await assertBrowserLandmarkReuse(prisma, credentials.userId);
    const persistedSearchRuns = await assertSavedLandmarkSearchRuns({
      actorUserId: credentials.userId,
      fixtures,
      prisma,
      resolved,
    });
    report.browser = {
      ...browserResult,
      completed: true,
      providerCountersUnchanged: true,
      landmarkDbOperations,
      persistedSearchRuns,
    };
    report.screenshots.files = browserResult.screenshots;
    termination.throwIfRequested();
  } catch (error) {
    const logs = await runCommand('docker', [
      ...compose, 'logs', '--no-color', '--tail', '200', 'postgres', 'api', 'web',
    ], { env: environment, cwd: root, timeoutMs: 30_000, allowDuringShutdown: true });
    const safeLogs = redact(`${logs.stdout}\n${logs.stderr}`.trim(), secrets);
    primaryError = new Error(`${error instanceof Error ? error.message : String(error)}${safeLogs ? `\nRuntime logs:\n${safeLogs}` : ''}`);
    report.failure = redact(primaryError.message, secrets);
  } finally {
    const closeErrors = [];
    await collectError(closeErrors, async () => browser?.close());
    if (apiMayBeRunning) {
      report.providerCalls = { status: 'unverified', locationiq: null, overpass: null, total: null };
      report.providerCallEvidence = { status: 'unverified', statuses: null };
      let stopResult = null;
      await collectError(closeErrors, async () => { stopResult = await stopProviderBoundary(); });
      if (stopResult && stopResult.status !== 0) {
        closeErrors.push(new Error('PIDAFIX3_GEO_LIVE_PROVIDER_BOUNDARY_STOP_FAILED'));
      }
    }
    if (prisma) {
      await collectError(closeErrors, async () => reconcileProviderCallReport(prisma, report, cli));
    }
    await collectError(closeErrors, async () => closeServer(mapServer));
    await collectError(closeErrors, async () => prisma?.$disconnect());
    try {
      await cleanupComposeProject({
        beforeContainers,
        compose,
        composeEnvironment: environment,
        project,
        report,
        secrets,
        taskImages: [
          environment.PIDAFIX3_POSTGRES_IMAGE,
          environment.PIDAFIX3_API_IMAGE,
          environment.PIDAFIX3_WEB_IMAGE,
        ],
      });
    } catch (error) {
      closeErrors.push(error);
    }
    if (closeErrors.length > 0) cleanupError = new AggregateError(closeErrors, 'PIDAFIX3_GEO_LIVE_CLEANUP_FAILED');
    delete process.env.LOCATIONIQ_API_KEY;
    delete environment.PIDAFIX3_LOCATIONIQ_API_KEY;
    termination.abortSignal?.removeEventListener('abort', handleTermination);
    if (!primaryError) {
      try {
        termination.throwIfRequested();
      } catch (error) {
        primaryError = error;
        report.failure = error.message;
      }
    }
    report.finishedAt = new Date().toISOString();
    if (cleanupError) report.cleanup.error = redact(cleanupError.message, secrets);
    const reportPath = join(qaDirectory, 'pidafix3-geo-live-report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`PIDAFIX3_GEO_LIVE_REPORT=${reportPath}\n`);
  }

  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'PIDAFIX3_GEO_LIVE_AND_CLEANUP_FAILED');
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  termination.throwIfRequested();
  process.stdout.write('ASSISTANT_PIDAFIX3_GEO_LIVE_OK\n');
}

async function assertCleanGeoDatabase(prisma) {
  const [database] = await prisma.$queryRawUnsafe(`
    SELECT current_database() AS name,
      COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS "appliedMigrations",
      COUNT(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::int AS "badMigrations"
    FROM _prisma_migrations
  `);
  assert.match(database.name, /(?:^|[_-])pidafix3(?:$|[_-])/u);
  assert.ok(database.appliedMigrations > 0);
  assert.equal(database.badMigrations, 0);
  const counts = await Promise.all([
    prisma.assistantGeoOperation.count(),
    prisma.assistantGeoUsageAttempt.count(),
    prisma.assistantGeoCache.count(),
    prisma.assistantGeoLandmark.count(),
    prisma.assistantUsageMetric.count({ where: { provider: { in: ['locationiq', 'overpass'] } } }),
  ]);
  assert.deepEqual(counts, [0, 0, 0, 0, 0], 'PIDAFIX3_GEO_LIVE_DATABASE_NOT_CLEAN');
}

function createNoopTermination() {
  return {
    abortSignal: null,
    signal: null,
    throwIfRequested() {},
  };
}

function createTerminationAwareFetch(abortSignal, fetchImpl = globalThis.fetch) {
  assert.equal(typeof fetchImpl, 'function');
  return async (input, init = {}) => {
    abortSignal?.throwIfAborted();
    const signals = [init.signal, abortSignal].filter(Boolean);
    const response = await fetchImpl(input, {
      ...init,
      ...(signals.length === 0 ? {} : {
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      }),
    });
    abortSignal?.throwIfAborted();
    return response;
  };
}

async function executeGeoCasesSequentially(cases, caps, options) {
  const spent = { locationiq: 0, overpass: 0, total: 0 };
  const results = [];
  for (const smokeCase of cases) {
    options.termination?.throwIfRequested();
    assertRemainingBudget(spent, smokeCase, caps);
    const result = await options.executeCase(smokeCase);
    spent.locationiq += result.attempts.filter(({ provider }) => provider === 'locationiq').length;
    spent.overpass += result.attempts.filter(({ provider }) => provider === 'overpass').length;
    spent.total += result.attempts.length;
    assertSpentWithinBudget(spent, caps);
    results.push(result);
    options.termination?.throwIfRequested();
  }
  return { results, spent };
}

async function seedGeoLiveUser(prisma) {
  const password = `Geo-Live-${randomUUID()}`;
  const permissions = [];
  for (const key of ['objects:read', 'admin:access']) {
    permissions.push(await prisma.permission.upsert({
      where: { key }, update: {}, create: { key, description: `PIDAFIX3 Geo ${key}` },
    }));
  }
  const role = await prisma.role.create({
    data: {
      name: `pidafix3-geo-${randomUUID().slice(0, 8)}`,
      permissions: { create: permissions.map(({ id: permissionId }) => ({ permissionId })) },
    },
  });
  const email = `pidafix3-geo-${randomUUID().slice(0, 8)}@example.test`;
  const user = await prisma.user.create({
    data: { email, name: 'PIDAFIX3 Geo User', passwordHash: await hash(password), roleId: role.id, status: 'ACTIVE' },
  });
  return { email, password, userId: user.id };
}

async function assertLoopbackRuntimeReady(apiOrigin, webOrigin, fetchImpl = globalThis.fetch, abortSignal = null) {
  for (const origin of [apiOrigin, webOrigin]) {
    assertLoopbackUrl(origin);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetchImpl(origin === apiOrigin ? `${origin}/health` : origin, {
          signal: AbortSignal.timeout(5_000),
        })).ok) { ready = true; break; }
      } catch {}
      await delay(100, undefined, abortSignal ? { signal: abortSignal } : undefined);
    }
    assert.equal(ready, true, `PIDAFIX3_GEO_LIVE_NOT_READY:${origin === apiOrigin ? 'api' : 'web'}`);
  }
}

async function loginApi(apiOrigin, credentials, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${apiOrigin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, 'PIDAFIX3_GEO_LIVE_LOGIN_FAILED');
  const payload = await readBoundedJson(response, 64 * 1024);
  return readSecret(payload.accessToken, 'PIDAFIX3_GEO_LIVE_ACCESS_TOKEN_MISSING');
}

async function resolveCase(apiOrigin, accessToken, smokeCase, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${apiOrigin}/assistant/geo/resolve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: smokeCase.content, locale: 'ru', country: 'ru' }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 201, `PIDAFIX3_GEO_LIVE_${smokeCase.slug.toUpperCase()}_HTTP_${response.status}`);
  const payload = await readBoundedJson(response, 128 * 1024);
  assert.equal(payload.status, 'RESOLVED', `PIDAFIX3_GEO_LIVE_${smokeCase.slug.toUpperCase()}_${payload.status}`);
  assert.equal(payload.placeQuery, smokeCase.label);
  assert.equal(payload.candidates?.length, 1);
  assert.equal(payload.candidates[0]?.kind, smokeCase.kind);
  assert.equal(payload.candidates[0]?.mode, smokeCase.mode);
  return payload;
}

async function readCaseAudit(prisma, actorUserId, smokeCase, payload) {
  const operations = await prisma.assistantGeoOperation.findMany({
    where: { actorUserId, normalizedQuery: smokeCase.normalizedQuery },
    include: { usageAttempts: { orderBy: { attemptOrdinal: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  assert.equal(operations.length, 1);
  const operation = operations[0];
  const attempts = operation.usageAttempts;
  assert.equal(operation.status, 'RESOLVED');
  assert.equal(operation.provider, smokeCase.provider);
  assert.equal(operation.cacheHit, false);
  assert.equal(operation.errorCode, null);
  assert.equal(operation.providerCallCount, smokeCase.attempts.length);
  assert.deepEqual(attempts.map(({ provider }) => provider), smokeCase.attempts);
  assert.deepEqual(attempts.map(({ attemptOrdinal }) => attemptOrdinal), smokeCase.attempts.map((_, index) => index + 1));
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'SETTLED');
    assert.equal(attempt.outcome, 'SUCCESS');
    assert.equal(attempt.errorCode, null);
    assert.ok(attempt.settledAt instanceof Date);
  }
  const landmark = await prisma.assistantGeoLandmark.findUniqueOrThrow({
    where: { id: payload.candidates[0].id },
  });
  assert.equal(landmark.normalizedQuery, smokeCase.normalizedQuery);
  assert.equal(landmark.kind, smokeCase.kind);
  assert.equal(landmark.sourceProvider, smokeCase.provider);
  assert.equal(landmark.confirmationState, 'VERIFIED');
  assert.equal(landmark.aliases.includes(smokeCase.normalizedQuery), true);
  assert.match(landmark.sourceExternalId ?? '', /^(?:node|way|relation)\/\d+$/u);
  assert.equal(landmark.sourceMetadata?.identityVersion, 1);
  assert.equal(typeof landmark.sourceMetadata?.providerQuery, 'string');
  const [geometry] = await prisma.$queryRawUnsafe(`
    SELECT
      GeometryType("geometry") AS type,
      ST_IsValid("geometry") AS "isValid",
      ST_IsEmpty("geometry") AS "isEmpty",
      ST_NPoints("geometry")::int AS "pointCount",
      CASE WHEN GeometryType("geometry") IN ('LINESTRING', 'MULTILINESTRING')
        THEN ST_IsClosed("geometry") ELSE NULL END AS "isClosed",
      CASE WHEN GeometryType("geometry") IN ('LINESTRING', 'MULTILINESTRING')
        THEN ST_Length("geometry"::geography) ELSE NULL END AS "lengthMeters",
      CASE WHEN GeometryType("geometry") IN ('POLYGON', 'MULTIPOLYGON')
        THEN ST_Area("geometry"::geography) ELSE NULL END AS "areaSquareMeters",
      ST_AsEWKB("geometry") AS ewkb
    FROM assistant_geo_landmarks
    WHERE id = $1::uuid
  `, landmark.id);
  assert.equal(geometry.isValid, true);
  assert.equal(geometry.isEmpty, false);
  assert.ok(geometry.pointCount > 0);
  const allowedTypes = {
    POINT: ['POINT'], LINE: ['LINESTRING', 'MULTILINESTRING'], AREA: ['POLYGON', 'MULTIPOLYGON'],
  }[smokeCase.kind];
  assert.equal(allowedTypes.includes(geometry.type), true);
  if (smokeCase.kind === 'LINE') {
    assert.equal(geometry.isClosed, true, `${smokeCase.slug}: incomplete road geometry`);
    assert.ok(geometry.lengthMeters > 0);
  }
  if (smokeCase.kind === 'AREA') assert.ok(geometry.areaSquareMeters > 0);
  return {
    landmark,
    attempts,
    report: {
      slug: smokeCase.slug,
      status: 'RESOLVED',
      kind: smokeCase.kind,
      mode: smokeCase.mode,
      provider: smokeCase.provider,
      providerCalls: attempts.length,
      cacheHit: false,
      geometry: {
        type: geometry.type,
        pointCount: geometry.pointCount,
        sha256: createHash('sha256').update(geometry.ewkb).digest('hex'),
        ...(geometry.lengthMeters === null ? {} : { lengthMeters: Math.round(geometry.lengthMeters) }),
        ...(geometry.areaSquareMeters === null ? {} : { areaSquareMeters: Math.round(geometry.areaSquareMeters) }),
      },
    },
  };
}

function assertRemainingBudget(spent, smokeCase, caps) {
  const planned = {
    locationiq: smokeCase.attempts.filter((provider) => provider === 'locationiq').length,
    overpass: smokeCase.attempts.filter((provider) => provider === 'overpass').length,
    total: smokeCase.attempts.length,
  };
  if (spent.locationiq + planned.locationiq > caps.locationiq
    || spent.overpass + planned.overpass > caps.overpass
    || spent.total + planned.total > caps.total) throw new Error('PIDAFIX3_GEO_LIVE_BUDGET_EXHAUSTED');
}

function assertSpentWithinBudget(spent, caps) {
  if (spent.locationiq > caps.locationiq || spent.overpass > caps.overpass || spent.total > caps.total) {
    throw new Error('PIDAFIX3_GEO_LIVE_BUDGET_EXCEEDED');
  }
}

function createProviderCallReport(counts, caps) {
  const calls = {
    locationiq: counts.locationiq,
    overpass: counts.overpass,
    total: counts.locationiq + counts.overpass,
  };
  for (const value of Object.values(calls)) {
    assert.equal(Number.isInteger(value) && value >= 0, true, 'PIDAFIX3_GEO_LIVE_LEDGER_COUNT_INVALID');
  }
  assertSpentWithinBudget(calls, caps);
  return { status: 'verified-from-ledger', ...calls };
}

function summarizeProviderAttemptRows(rows, caps) {
  const counts = { locationiq: 0, overpass: 0 };
  const statuses = {
    reserved: { locationiq: 0, overpass: 0, total: 0 },
    settledSuccess: { locationiq: 0, overpass: 0, total: 0 },
    settledError: { locationiq: 0, overpass: 0, total: 0 },
  };
  for (const row of rows) {
    assert.equal(['locationiq', 'overpass'].includes(row.provider), true,
      'PIDAFIX3_GEO_LIVE_LEDGER_PROVIDER_INVALID');
    const count = row._count?._all;
    assert.equal(Number.isInteger(count) && count >= 0, true, 'PIDAFIX3_GEO_LIVE_LEDGER_COUNT_INVALID');
    counts[row.provider] += count;
    let statusKey;
    if (row.status === 'RESERVED' && row.outcome === null) statusKey = 'reserved';
    else if (row.status === 'SETTLED' && row.outcome === 'SUCCESS') statusKey = 'settledSuccess';
    else if (row.status === 'SETTLED' && row.outcome === 'ERROR') statusKey = 'settledError';
    else throw new Error('PIDAFIX3_GEO_LIVE_LEDGER_STATUS_INVALID');
    statuses[statusKey][row.provider] += count;
    statuses[statusKey].total += count;
  }
  return { calls: createProviderCallReport(counts, caps), statuses };
}

async function reconcileProviderCallReport(prisma, report, caps) {
  const rows = await prisma.assistantGeoUsageAttempt.groupBy({
    by: ['provider', 'status', 'outcome'],
    where: { provider: { in: ['locationiq', 'overpass'] } },
    _count: { _all: true },
  });
  const summary = summarizeProviderAttemptRows(rows, caps);
  report.providerCalls = summary.calls;
  report.providerCallEvidence = {
    status: 'verified-from-ledger',
    statuses: summary.statuses,
  };
  return summary;
}

async function readProviderCounters(prisma) {
  const attempts = await prisma.assistantGeoUsageAttempt.groupBy({
    by: ['provider'],
    where: { provider: { in: ['locationiq', 'overpass'] } },
    _count: { _all: true },
  });
  const counts = { locationiq: 0, overpass: 0 };
  for (const row of attempts) counts[row.provider] = row._count._all;
  return counts;
}

function assertProviderCountersUnchanged(before, after) {
  assert.deepEqual(after, before, 'PIDAFIX3_GEO_LIVE_BROWSER_RECALLED_PROVIDER');
}

async function assertBrowserLandmarkReuse(prisma, actorUserId) {
  const result = {};
  for (const smokeCase of geoLiveCases.filter(({ slug }) => ['sadovoe', 'arbat'].includes(slug))) {
    const operations = await prisma.assistantGeoOperation.findMany({
      where: { actorUserId, normalizedQuery: smokeCase.normalizedQuery },
      include: { usageAttempts: true },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(operations.length, 2, `${smokeCase.slug}: provider + browser operation required`);
    const browserOperation = operations[1];
    assert.equal(browserOperation.provider, 'landmark_db');
    assert.equal(browserOperation.status, 'RESOLVED');
    assert.equal(browserOperation.cacheHit, false);
    assert.equal(browserOperation.providerCallCount, 0);
    assert.equal(browserOperation.errorCode, null);
    assert.deepEqual(browserOperation.usageAttempts, []);
    result[smokeCase.slug] = { provider: 'landmark_db', providerCallCount: 0 };
  }
  return result;
}

async function assertSavedLandmarkSearchRuns({ actorUserId, fixtures, prisma, resolved }) {
  const cases = [
    {
      slug: 'sadovoe',
      query: 'Найди однокомнатную квартиру до 30 млн рядом с Садовым кольцом',
      fixtures: fixtures.line,
      excludedKeys: ['lineOutside', 'lineWrongRooms', 'lineOverBudget'],
      rooms: [1],
      budgetMaxRub: 30_000_000,
      kind: 'LINE',
      mode: 'NEAR',
      distanceMeters: 5_000,
    },
    {
      slug: 'arbat',
      query: 'Найди трёхкомнатную квартиру до 40 млн внутри района Арбат',
      fixtures: fixtures.area,
      excludedKeys: ['areaOutside', 'areaWrongRooms', 'areaOverBudget'],
      rooms: [3],
      budgetMaxRub: 40_000_000,
      kind: 'AREA',
      mode: 'INSIDE',
      distanceMeters: null,
    },
  ];
  const result = {};
  for (const searchCase of cases) {
    const run = await prisma.assistantRun.findFirstOrThrow({
      where: {
        ownerUserId: actorUserId,
        userMessage: { content: searchCase.query },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        userMessage: { select: { geoContextJson: true } },
        assistantMessage: { select: { answerJson: true } },
      },
    });
    assert.equal(run.status, 'COMPLETED');
    assert.deepEqual(run.intentJson.hardFilters.rooms, searchCase.rooms);
    assert.equal(run.intentJson.hardFilters.budgetMaxRub, searchCase.budgetMaxRub);
    assert.equal(run.intentJson.hardFilters.objectType, 'RESIDENTIAL');
    for (const key of ['district', 'metro', 'developer']) {
      assert.equal(run.intentJson.hardFilters[key], null);
    }
    const landmark = resolved.get(searchCase.slug).landmark;
    const answer = run.assistantMessage.answerJson;
    assert.deepEqual(run.userMessage.geoContextJson, {
      kind: searchCase.kind,
      mode: searchCase.mode,
      label: landmark.label,
      landmarkId: landmark.id,
      ...(searchCase.distanceMeters === null ? {} : { distanceMeters: searchCase.distanceMeters }),
      source: 'LANDMARK',
    });
    assert.equal(answer.geo.kind, searchCase.kind);
    assert.equal(answer.geo.mode, searchCase.mode);
    assert.equal(answer.geo.landmarkId, landmark.id);
    assert.equal(Object.hasOwn(answer.geo, 'anchor'), false);
    const primaryMarkers = answer.geo.markers.filter(({ kind }) => kind === 'PRIMARY');
    const alternativeMarkers = answer.geo.markers.filter(({ kind }) => kind === 'ALTERNATIVE');
    assert.deepEqual(primaryMarkers.map(({ unitId }) => unitId), [searchCase.fixtures.included.unit.id]);
    assert.deepEqual(alternativeMarkers, []);
    assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [searchCase.fixtures.included.unit.id]);
    assert.deepEqual(answer.alternatives, []);
    assert.deepEqual(run.evidenceJson.map(({ unitId }) => unitId), [searchCase.fixtures.included.unit.id]);
    assert.deepEqual(run.evidenceJson.map(({ objectId }) => objectId), [searchCase.fixtures.included.object.id]);
    for (const key of searchCase.excludedKeys) {
      const excluded = searchCase.fixtures[key];
      assert.equal(run.evidenceJson.some(({ unitId, objectId }) => (
        unitId === excluded.unit.id || objectId === excluded.object.id
      )), false);
    }
    const [geometry] = searchCase.kind === 'AREA'
      ? await prisma.$queryRawUnsafe(`
          SELECT ST_AsGeoJSON(geometry, 7)::jsonb AS "referenceGeometry"
          FROM assistant_geo_landmarks
          WHERE id = $1::uuid
        `, landmark.id)
      : await prisma.$queryRawUnsafe(`
          SELECT
            ST_AsGeoJSON(geometry, 7)::jsonb AS "referenceGeometry",
            ST_AsGeoJSON(ST_Buffer(geometry::geography, $1)::geometry, 7)::jsonb AS "searchArea"
          FROM assistant_geo_landmarks
          WHERE id = $2::uuid
        `, searchCase.distanceMeters, landmark.id);
    assert.deepEqual(answer.geo.referenceGeometry, geometry.referenceGeometry);
    assert.deepEqual(answer.geo.searchArea,
      searchCase.kind === 'AREA' ? geometry.referenceGeometry : geometry.searchArea);
    result[searchCase.slug] = {
      exactUnitIds: [searchCase.fixtures.included.unit.id],
      excludedUnitIds: searchCase.excludedKeys.map((key) => searchCase.fixtures[key].unit.id),
      hardFilters: { rooms: searchCase.rooms, budgetMaxRub: searchCase.budgetMaxRub },
      primaryMarkers: primaryMarkers.length,
      alternativeMarkers: alternativeMarkers.length,
      geometryMatchedPostgis: true,
    };
  }
  return result;
}

async function seedBrowserOffers(prisma, resolved) {
  const sadovoe = resolved.get('sadovoe')?.landmark;
  const arbat = resolved.get('arbat')?.landmark;
  assert.ok(sadovoe && arbat);
  const [points] = await prisma.$queryRawUnsafe(`
    WITH
      line AS (
        SELECT geometry FROM assistant_geo_landmarks WHERE id = $1::uuid
      ),
      area AS (
        SELECT geometry FROM assistant_geo_landmarks WHERE id = $2::uuid
      ),
      bearings AS (
        SELECT radians(value::double precision) AS bearing
        FROM generate_series(0, 315, 45) AS value
      ),
      line_candidates AS (
        SELECT
          ST_Project(ST_PointOnSurface(line.geometry)::geography, 20000, bearings.bearing)::geometry AS point,
          line.geometry
        FROM line CROSS JOIN bearings
      ),
      line_outside AS (
        SELECT point, ST_Distance(point::geography, geometry::geography) AS distance
        FROM line_candidates
        ORDER BY distance DESC
        LIMIT 1
      ),
      area_candidates AS (
        SELECT
          ST_Project(ST_PointOnSurface(area.geometry)::geography, 20000, bearings.bearing)::geometry AS point,
          area.geometry
        FROM area CROSS JOIN bearings
      ),
      area_outside AS (
        SELECT point, ST_Covers(geometry, point) AS covered,
          ST_Distance(point::geography, geometry::geography) AS distance
        FROM area_candidates
        ORDER BY distance DESC
        LIMIT 1
      )
    SELECT
      ST_X(ST_PointOnSurface(line.geometry))::double precision AS "lineLongitude",
      ST_Y(ST_PointOnSurface(line.geometry))::double precision AS "lineLatitude",
      ST_X(line_outside.point)::double precision AS "lineOutsideLongitude",
      ST_Y(line_outside.point)::double precision AS "lineOutsideLatitude",
      line_outside.distance::double precision AS "lineOutsideDistance",
      ST_X(ST_PointOnSurface(area.geometry))::double precision AS "areaLongitude",
      ST_Y(ST_PointOnSurface(area.geometry))::double precision AS "areaLatitude",
      ST_X(area_outside.point)::double precision AS "areaOutsideLongitude",
      ST_Y(area_outside.point)::double precision AS "areaOutsideLatitude",
      area_outside.covered AS "areaOutsideCovered",
      area_outside.distance::double precision AS "areaOutsideDistance"
    FROM line, line_outside, area, area_outside
  `, sadovoe.id, arbat.id);
  assert.ok(points.lineOutsideDistance > 5_000, 'PIDAFIX3_GEO_LIVE_LINE_OUTSIDE_FIXTURE_INVALID');
  assert.equal(points.areaOutsideCovered, false, 'PIDAFIX3_GEO_LIVE_AREA_OUTSIDE_FIXTURE_INVALID');
  assert.ok(points.areaOutsideDistance > 0, 'PIDAFIX3_GEO_LIVE_AREA_OUTSIDE_DISTANCE_INVALID');
  const developer = await prisma.developer.create({
    data: { name: 'PIDAFIX3 Geo Live', slug: `pidafix3-geo-${randomUUID().slice(0, 8)}` },
  });
  const location = await prisma.location.create({
    data: { name: 'Москва', slug: `pidafix3-geo-moscow-${randomUUID().slice(0, 8)}`, type: 'CUSTOM' },
  });
  const shared = { developerId: developer.id, locationId: location.id };
  const line = {
    included: await createGeoOffer(prisma, {
      ...shared, key: 'line-included', title: 'ЖК Live Садовое', rooms: 1, priceRub: 25_000_000,
      latitude: points.lineLatitude, longitude: points.lineLongitude,
    }),
    lineOutside: await createGeoOffer(prisma, {
      ...shared, key: 'line-outside', title: 'ЖК Live вне Садового', rooms: 1, priceRub: 25_000_000,
      latitude: points.lineOutsideLatitude, longitude: points.lineOutsideLongitude,
    }),
    lineWrongRooms: await createGeoOffer(prisma, {
      ...shared, key: 'line-wrong-rooms', title: 'ЖК Live Садовое другая комнатность', rooms: 2,
      priceRub: 25_000_000, latitude: points.lineLatitude, longitude: points.lineLongitude,
    }),
    lineOverBudget: await createGeoOffer(prisma, {
      ...shared, key: 'line-over-budget', title: 'ЖК Live Садовое выше бюджета', rooms: 1,
      priceRub: 60_000_000, latitude: points.lineLatitude, longitude: points.lineLongitude,
    }),
  };
  const area = {
    included: await createGeoOffer(prisma, {
      ...shared, key: 'area-included', title: 'ЖК Live Арбат', rooms: 3, priceRub: 35_000_000,
      latitude: points.areaLatitude, longitude: points.areaLongitude,
    }),
    areaOutside: await createGeoOffer(prisma, {
      ...shared, key: 'area-outside', title: 'ЖК Live вне Арбата', rooms: 3, priceRub: 35_000_000,
      latitude: points.areaOutsideLatitude, longitude: points.areaOutsideLongitude,
    }),
    areaWrongRooms: await createGeoOffer(prisma, {
      ...shared, key: 'area-wrong-rooms', title: 'ЖК Live Арбат другая комнатность', rooms: 2,
      priceRub: 35_000_000, latitude: points.areaLatitude, longitude: points.areaLongitude,
    }),
    areaOverBudget: await createGeoOffer(prisma, {
      ...shared, key: 'area-over-budget', title: 'ЖК Live Арбат выше бюджета', rooms: 3,
      priceRub: 80_000_000, latitude: points.areaLatitude, longitude: points.areaLongitude,
    }),
  };
  return { line, area, metrics: points };
}

async function createGeoOffer(prisma, input) {
  const object = await prisma.realEstateObject.create({
    data: {
      title: input.title,
      slug: `pidafix3-geo-live-${input.key}-${randomUUID().slice(0, 8)}`,
      status: 'PUBLISHED', type: 'RESIDENTIAL', address: 'Москва, Geo Live',
      developerId: input.developerId, primaryLocationId: input.locationId,
      latitude: input.latitude, longitude: input.longitude, publishedAt: new Date(), feedUpdatedAt: new Date(),
    },
  });
  const source = await prisma.feedSource.create({
    data: {
      sourceKind: 'URL', url: `http://127.0.0.1:9/pidafix3/${input.key}.xml`, format: 'CIAN_XML',
      developerId: input.developerId, objectId: object.id, isActive: true, lastSuccessAt: new Date(),
    },
  });
  const unit = await prisma.feedUnit.create({
    data: {
      sourceId: source.id, objectId: object.id, externalId: `pidafix3-geo-live-${input.key}`,
      type: 'RESIDENTIAL', status: 'AVAILABLE', title: `${input.rooms}-комнатная`, rooms: input.rooms,
      effectivePrice: input.priceRub, effectivePricePerMeter: 400_000, currency: 'RUB', area: 70, floor: 8,
    },
  });
  return { object, unit };
}

async function runSavedLandmarkBrowserProof(input) {
  const context = await input.browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const externalRequests = [];
  const localTileRequests = [];
  const submittedBodies = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['data:', 'blob:'].includes(url.protocol)
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
      return route.continue();
    }
    externalRequests.push(`${url.protocol}//${url.hostname}${url.pathname}`);
    return route.abort();
  });
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/tiles/')) localTileRequests.push(pathname);
    if (/\/assistant\/conversations\/[^/]+\/messages$/u.test(pathname)
      && request.method() === 'POST') submittedBodies.push(request.postDataJSON());
  });
  const screenshots = [];
  try {
    await page.goto(`${input.webOrigin}/cabinet`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email').fill(input.credentials.email);
    await page.getByLabel('Пароль', { exact: true }).fill(input.credentials.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).waitFor();
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    const inputBox = page.getByLabel('Сообщение помощнику');
    const lineQuery = 'Найди однокомнатную квартиру до 30 млн рядом с Садовым кольцом';
    await submitBrowserMessage(page, inputBox, lineQuery);
    let article = await waitForAssistantArticle(page, lineQuery);
    await article.getByText(input.fixtures.line.included.object.title, { exact: true }).waitFor();
    for (const key of ['lineOutside', 'lineWrongRooms', 'lineOverBudget']) {
      assert.equal(await article.getByText(input.fixtures.line[key].object.title, { exact: true }).count(), 0);
    }
    const lineMap = article.locator('.assistant-geo-result-map');
    await lineMap.waitFor();
    assert.match(await lineMap.getAttribute('data-reference-geometry') ?? '', /^(?:Multi)?LineString$/u);
    assert.match(await lineMap.getAttribute('data-search-area-geometry') ?? '', /^(?:Multi)?Polygon$/u);
    assert.equal(await lineMap.locator('.map-price-marker--anchor').count(), 0);
    assert.equal(await lineMap.locator('.map-price-marker--primary').count(), 1);
    assert.equal(await lineMap.locator('.map-price-marker--alternative').count(), 0);
    await article.getByText('OpenFreeMap', { exact: true }).waitFor();
    await article.getByText('OpenStreetMap', { exact: true }).waitFor();
    const lineScreenshot = join(input.qaDirectory, 'geo-live-line-browser.png');
    await page.screenshot({ path: lineScreenshot, fullPage: true });
    screenshots.push(lineScreenshot);

    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    await page.getByRole('button', { name: 'История разговоров' }).click();
    await page.getByRole('complementary', { name: 'История разговоров' })
      .getByRole('button', { name: 'Новый разговор' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const areaQuery = 'Найди трёхкомнатную квартиру до 40 млн внутри района Арбат';
    await submitBrowserMessage(page, inputBox, areaQuery);
    article = await waitForAssistantArticle(page, areaQuery);
    await article.getByText(input.fixtures.area.included.object.title, { exact: true }).waitFor();
    for (const key of ['areaOutside', 'areaWrongRooms', 'areaOverBudget']) {
      assert.equal(await article.getByText(input.fixtures.area[key].object.title, { exact: true }).count(), 0);
    }
    const areaMap = article.locator('.assistant-geo-result-map');
    await areaMap.waitFor();
    assert.match(await areaMap.getAttribute('data-reference-geometry') ?? '', /^(?:Multi)?Polygon$/u);
    assert.match(await areaMap.getAttribute('data-search-area-geometry') ?? '', /^(?:Multi)?Polygon$/u);
    assert.equal(await areaMap.locator('.map-price-marker--anchor').count(), 0);
    assert.equal(await areaMap.locator('.map-price-marker--primary').count(), 1);
    assert.equal(await areaMap.locator('.map-price-marker--alternative').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    const areaScreenshot = join(input.qaDirectory, 'geo-live-area-browser.png');
    await page.screenshot({ path: areaScreenshot, fullPage: true });
    screenshots.push(areaScreenshot);

    assert.deepEqual(externalRequests, []);
    assert.ok(localTileRequests.length > 0, 'PIDAFIX3_GEO_LIVE_LOCAL_TILES_NOT_REQUESTED');
    assert.ok(input.mapRequests.style > 0, 'PIDAFIX3_GEO_LIVE_LOCAL_STYLE_NOT_REQUESTED');
    assert.ok(input.mapRequests.tiles > 0, 'PIDAFIX3_GEO_LIVE_LOCAL_TILES_NOT_SERVED');
    assert.equal(submittedBodies.length, 2);
    assert.deepEqual(submittedBodies.map(({ geo }) => ({
      referenceType: geo.referenceType,
      landmarkId: geo.landmarkId,
    })), [
      { referenceType: 'LANDMARK', landmarkId: input.resolved.get('sadovoe').landmark.id },
      { referenceType: 'LANDMARK', landmarkId: input.resolved.get('arbat').landmark.id },
    ]);
    return {
      externalRequests,
      localMapRequests: { style: input.mapRequests.style, tiles: input.mapRequests.tiles },
      localTileRequestCount: localTileRequests.length,
      screenshots,
    };
  } finally {
    await context.close();
  }
}

async function submitBrowserMessage(page, input, content) {
  await input.fill(content);
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Отправить"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.getByRole('button', { name: 'Отправить' }).click();
}

async function waitForAssistantArticle(page, query) {
  const userArticle = page.locator('.assistant-message--user').filter({ hasText: query }).last();
  await userArticle.waitFor();
  const article = userArticle.locator('xpath=following-sibling::article[contains(@class,"assistant-message--assistant")][1]');
  await article.waitFor();
  return article;
}

async function startMapStub(port) {
  const tile = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const requests = { style: 0, tiles: 0 };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/tiles/') && pathname.endsWith('.png')) {
      requests.tiles += 1;
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'image/png',
        'content-length': tile.length,
      });
      response.end(tile);
      return;
    }
    if (pathname !== '/style.json') {
      response.writeHead(404).end();
      return;
    }
    requests.style += 1;
    const body = JSON.stringify(createLocalMapStyle(`http://${request.headers.host}`));
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  return { requests, server };
}

function createLocalMapStyle(origin) {
  assertLoopbackUrl(origin);
  return {
    version: 8,
    sources: {
      rasterFixture: {
        type: 'raster',
        tiles: [`${origin}/tiles/{z}/{x}/{y}.png`],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 14,
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
    ],
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
}

function databaseUrl(values) {
  return `postgresql://platforma:${encodeURIComponent(values.postgresPassword)}@127.0.0.1:${values.postgresPort}/platforma_pidafix3?schema=public`;
}

function assertLoopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('PIDAFIX3_GEO_LIVE_LOOPBACK_REQUIRED');
  }
  return url;
}

function readSecret(value, code) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 8_192) throw new Error(code);
  return value;
}

async function readBoundedJson(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('PIDAFIX3_GEO_LIVE_RESPONSE_TOO_LARGE');
  const body = await response.arrayBuffer();
  if (body.byteLength > maximumBytes) throw new Error('PIDAFIX3_GEO_LIVE_RESPONSE_TOO_LARGE');
  try { return JSON.parse(Buffer.from(body).toString('utf8')); } catch { throw new Error('PIDAFIX3_GEO_LIVE_RESPONSE_INVALID'); }
}

async function readTextCommand(command, args, environment) {
  const result = await runCommand(command, args, { cwd: root, env: environment, timeoutMs: 30_000 });
  if (result.status !== 0) throw new Error(`PIDAFIX3_GEO_LIVE_COMMAND_FAILED:${command}`);
  return result.stdout.trim();
}

function splitLines(value) { return value.split('\n').map((line) => line.trim()).filter(Boolean); }

async function collectError(errors, task) {
  try { await task(); } catch (error) { errors.push(error); }
}

module.exports = {
  assertProviderCountersUnchanged,
  assertRemainingBudget,
  assertSpentWithinBudget,
  createGeoLiveEnvironment,
  createLocalMapStyle,
  createProviderCallReport,
  createTerminationAwareFetch,
  executeGeoCasesSequentially,
  exactCaps,
  geoLiveCases,
  parseGeoLiveArguments,
  summarizeProviderAttemptRows,
  validateFakeBaselineReport,
};
