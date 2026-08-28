const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const http = require('node:http');

const smokeCases = Object.freeze({
  sadovoe: {
    slug: 'sadovoe', label: 'Садовое кольцо', canonicalQuery: 'садовое кольцо',
    content: 'Найди квартиру возле Садового кольца', kind: 'LINE', mode: 'NEAR', sourceProvider: 'overpass',
    attempts: ['locationiq', 'locationiq', 'overpass'], tagValue: 'Садовое кольцо',
  },
  ttk: {
    slug: 'ttk', label: 'ТТК', canonicalQuery: 'третье транспортное кольцо',
    content: 'Найди квартиру возле ТТК', kind: 'LINE', mode: 'NEAR', sourceProvider: 'overpass',
    attempts: ['locationiq', 'locationiq', 'overpass'], tagValue: 'ТТК',
  },
  mkad: {
    slug: 'mkad', label: 'МКАД', canonicalQuery: 'московская кольцевая автодорога',
    content: 'Найди квартиру возле МКАД', kind: 'LINE', mode: 'NEAR', sourceProvider: 'overpass',
    attempts: ['locationiq', 'locationiq', 'overpass'], tagValue: 'МКАД',
  },
  arbat: {
    slug: 'arbat', label: 'район Арбат', canonicalQuery: 'район арбат',
    content: 'Найди квартиру внутри района Арбат', kind: 'AREA', mode: 'INSIDE', sourceProvider: 'locationiq',
    attempts: ['locationiq'], tagValue: null,
  },
});

if (require.main === module) {
  void runAssistantFixGeo1LocalStubSmoke().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'ASSISTANT_FIX_GEO1_LOCAL_STUB_SMOKE_FAILED'}\n`);
    process.exitCode = 1;
  });
}

async function runAssistantFixGeo1LocalStubSmoke(options = {}) {
  const cli = parseSmokeArguments(options.argv ?? process.argv.slice(2));
  const environment = options.environment ?? process.env;
  const snapshot = await (options.runtime ?? createProcRuntime()).read();
  const config = validateRuntimeSnapshot(snapshot, environment);
  const accessToken = readSecret(environment.ASSISTANT_FIX_GEO1_LOCAL_STUB_ACCESS_TOKEN,
    'ASSISTANT_FIX_GEO1_LOCAL_STUB_ACCESS_TOKEN_REQUIRED');
  const selectedCases = cli.case ? [smokeCases[cli.case]] : Object.values(smokeCases);
  const output = options.output ?? process.stdout;
  const ledger = options.ledger ?? createPrismaSmokeLedger(config.databaseUrl);
  const stubs = options.stubs ?? createLocalProviderStubs(config);
  const api = options.api ?? createSmokeApiClient(config.apiUrl, accessToken, config.timeoutMs);
  const spent = { locationiq: 0, overpass: 0, total: 0 };
  let result;
  let primaryError = null;

  try {
    await ledger.assertClean();
    await stubs.start();
    for (const smokeCase of selectedCases) {
      assertRemainingBudget(cli, spent, smokeCase);
      stubs.setCase(smokeCase);
      const payload = await api.resolve(smokeCase);
      assertResolutionPayload(payload, smokeCase);
      const audit = await ledger.readCase(smokeCase.canonicalQuery);
      assertCaseAudit(audit, smokeCase, config);
      spent.locationiq += audit.attempts.filter(({ provider }) => provider === 'locationiq').length;
      spent.overpass += audit.attempts.filter(({ provider }) => provider === 'overpass').length;
      spent.total += audit.attempts.length;
      assertSpentWithinBudget(cli, spent);
      assert.deepEqual(stubs.readCaseCounts(smokeCase.slug), {
        locationiq: smokeCase.attempts.filter((provider) => provider === 'locationiq').length,
        overpass: smokeCase.attempts.filter((provider) => provider === 'overpass').length,
      }, `${smokeCase.slug}: stub counters`);
      output.write(`${smokeCase.label}: ${smokeCase.kind}/${smokeCase.mode} OK\n`);
    }
    for (const smokeCase of selectedCases) {
      assertCaseAudit(await ledger.readCase(smokeCase.canonicalQuery), smokeCase, config);
    }
    assert.deepEqual(stubs.readTotals(), { locationiq: spent.locationiq, overpass: spent.overpass });
    assertUsageTotals(await ledger.readUsageTotals(), spent);
    if (!cli.case) assert.deepEqual(spent, { locationiq: 7, overpass: 3, total: 10 });
    output.write(`ASSISTANT_FIX_GEO1_LOCAL_STUB_SMOKE_OK locationiq=${spent.locationiq} overpass=${spent.overpass} total=${spent.total}\n`);
    result = { ...spent, cases: selectedCases.map(({ slug }) => slug) };
  } catch (error) {
    primaryError = error;
  }
  const cleanup = await Promise.allSettled([stubs.close(), ledger.close()]);
  if (environment === process.env) delete process.env.ASSISTANT_FIX_GEO1_LOCAL_STUB_ACCESS_TOKEN;
  const cleanupErrors = cleanup.flatMap((entry) => entry.status === 'rejected' ? [entry.reason] : []);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'ASSISTANT_FIX_GEO1_LOCAL_STUB_CLEANUP_FAILED',
    );
  }
  if (primaryError) throw primaryError;
  return result;
}

function parseSmokeArguments(argv) {
  if (!Array.isArray(argv)) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_ARGS_INVALID');
  const values = new Map();
  let runLocalStubs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--run-local-stubs') {
      if (runLocalStubs) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_ARG_DUPLICATE');
      runLocalStubs = true;
      continue;
    }
    if (!['--max-locationiq-attempts', '--max-overpass-attempts', '--max-total-attempts', '--case'].includes(argument)) {
      throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_ARG_UNKNOWN');
    }
    if (values.has(argument)) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_ARG_DUPLICATE');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_ARG_VALUE_REQUIRED');
    values.set(argument, value);
    index += 1;
  }
  if (!runLocalStubs) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_OPT_IN_REQUIRED');
  const locationiq = readExactCliLimit(values.get('--max-locationiq-attempts'), 7, 'LOCATIONIQ');
  const overpass = readExactCliLimit(values.get('--max-overpass-attempts'), 3, 'OVERPASS');
  const total = readExactCliLimit(values.get('--max-total-attempts'), 10, 'TOTAL');
  const selectedCase = values.get('--case') ?? null;
  if (selectedCase !== null && !Object.hasOwn(smokeCases, selectedCase)) {
    throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_CASE_INVALID');
  }
  return { locationiq, overpass, total, case: selectedCase };
}

function validateRuntimeSnapshot(snapshot, invocationEnvironment = process.env) {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.environment !== 'object') {
    throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_RUNTIME_INVALID');
  }
  const environment = snapshot.environment;
  if (!String(snapshot.command ?? '').includes('node') || !String(snapshot.command ?? '').includes('apps/api/dist/main.js')) {
    throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_API_PROCESS_REQUIRED');
  }
  if (['production', 'staging'].includes(environment.NODE_ENV)
    || ['production', 'staging'].includes(environment.DEPLOYMENT_ENV)) {
    throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_ENV_FORBIDDEN');
  }
  for (const [key, expected] of Object.entries({
    ASSISTANT_FIX_GEO1_LOCAL_STUB_SMOKE: 'true',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
    ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE: '2',
    ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE: '1',
    ASSISTANT_AI_MODE: 'fake',
    ASSISTANT_QUERY_PLANNER_LIVE: 'false',
    ASSISTANT_EMBEDDING_MODE: 'fake',
    ASSISTANT_SOURCE_WORKER_ENABLED: 'false',
    FEED_AUTO_IMPORT_ENABLED: 'false',
    TRAINING_MODULE_ENABLED: 'false',
    TELEGRAM_TRANSPORT_MODE: 'fake',
  })) expectEnvironment(environment, key, expected);
  for (const key of ['ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE', 'ASSISTANT_GEO_PROVIDER_DAILY_BUDGET',
    'ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE', 'ASSISTANT_OVERPASS_DAILY_BUDGET']) {
    readPositiveInteger(environment[key], `${key}_REQUIRED`);
  }
  const dummyApiKey = environment.LOCATIONIQ_API_KEY;
  if (dummyApiKey !== 'pidafix2-local-stub') throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_DUMMY_KEY_REQUIRED');
  const locationIqUrl = readLoopbackUrl(environment.LOCATIONIQ_API_URL, 'LOCATIONIQ_API_URL');
  const overpassUrl = readLoopbackUrl(environment.ASSISTANT_OVERPASS_URL, 'ASSISTANT_OVERPASS_URL');
  if (locationIqUrl.origin === overpassUrl.origin) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_ENDPOINTS_MUST_BE_DISTINCT');
  const apiUrl = readLoopbackUrl(environment.ASSISTANT_FIX_GEO1_LOCAL_STUB_API_URL
    ?? invocationEnvironment.ASSISTANT_FIX_GEO1_LOCAL_STUB_API_URL, 'ASSISTANT_FIX_GEO1_LOCAL_STUB_API_URL');
  if ([locationIqUrl, overpassUrl].some((endpoint) => endpoint.origin === apiUrl.origin)) {
    throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_API_ORIGIN_MUST_BE_DISTINCT');
  }
  return {
    apiUrl,
    databaseUrl: readDisposableDatabaseUrl(environment.DATABASE_URL),
    dummyApiKey,
    locationIqUrl,
    overpassUrl,
    timeoutMs: readBoundedInteger(invocationEnvironment.ASSISTANT_FIX_GEO1_LOCAL_STUB_TIMEOUT_MS,
      20_000, 1_000, 30_000, 'ASSISTANT_FIX_GEO1_LOCAL_STUB_TIMEOUT_INVALID'),
  };
}

function createProcRuntime() {
  return {
    async read() {
      try {
        return {
          environment: parseNullSeparated(readFileSync('/proc/1/environ')),
          command: readFileSync('/proc/1/cmdline', 'utf8').replace(/\0/gu, ' ').trim(),
        };
      } catch {
        throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_CONTAINER_RUNTIME_REQUIRED');
      }
    },
  };
}

function createPrismaSmokeLedger(databaseUrl) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  return {
    async assertClean() {
      await prisma.$connect();
      const counts = await Promise.all([
        prisma.assistantGeoOperation.count(), prisma.assistantGeoUsageAttempt.count(),
        prisma.assistantGeoCache.count(), prisma.assistantGeoLandmark.count(),
        prisma.assistantUsageMetric.count({ where: { provider: { in: ['locationiq', 'overpass'] } } }),
      ]);
      if (counts.some((count) => count !== 0)) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_DATABASE_NOT_CLEAN');
    },
    async readCase(normalizedQuery) {
      const operations = await prisma.assistantGeoOperation.findMany({ where: { normalizedQuery }, orderBy: { createdAt: 'asc' } });
      if (operations.length !== 1) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_OPERATION_INVALID');
      const operation = operations[0];
      const [attempts, landmarks, caches] = await Promise.all([
        prisma.assistantGeoUsageAttempt.findMany({ where: { operationId: operation.id }, orderBy: { attemptOrdinal: 'asc' } }),
        prisma.assistantGeoLandmark.findMany({ where: { normalizedQuery } }),
        prisma.assistantGeoCache.findMany({ where: { normalizedQuery } }),
      ]);
      return { operation, attempts, landmarks, caches };
    },
    async readUsageTotals() {
      const rows = await prisma.assistantUsageMetric.groupBy({
        by: ['provider', 'window'], where: { provider: { in: ['locationiq', 'overpass'] } },
        _sum: { requestCount: true, completedCount: true, errorCount: true },
      });
      return rows.map((row) => ({ provider: row.provider, window: String(row.window).toLowerCase(),
        requestCount: row._sum.requestCount ?? 0, completedCount: row._sum.completedCount ?? 0,
        errorCount: row._sum.errorCount ?? 0 }));
    },
    close: () => prisma.$disconnect(),
  };
}

function createLocalProviderStubs(config) {
  let activeCase = null;
  const counts = new Map(Object.keys(smokeCases).map((slug) => [slug, { locationiq: 0, overpass: 0 }]));
  const locationIqServer = http.createServer((request, response) => {
    void handleLocationIqStub(request, response, config, activeCase, counts).catch((error) => sendJson(response, 500,
      { error: error instanceof Error ? error.message : 'STUB_ERROR' }));
  });
  const overpassServer = http.createServer((request, response) => {
    void handleOverpassStub(request, response, config, activeCase, counts).catch((error) => sendJson(response, 500,
      { error: error instanceof Error ? error.message : 'STUB_ERROR' }));
  });
  return {
    async start() { await Promise.all([listenExact(locationIqServer, config.locationIqUrl), listenExact(overpassServer, config.overpassUrl)]); },
    setCase(smokeCase) { activeCase = smokeCase; },
    readCaseCounts(slug) { return { ...counts.get(slug) }; },
    readTotals() {
      return [...counts.values()].reduce((total, count) => ({
        locationiq: total.locationiq + count.locationiq, overpass: total.overpass + count.overpass,
      }), { locationiq: 0, overpass: 0 });
    },
    async close() {
      const results = await Promise.allSettled([closeServer(locationIqServer), closeServer(overpassServer)]);
      const errors = results.flatMap((entry) => entry.status === 'rejected' ? [entry.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'ASSISTANT_FIX_GEO1_LOCAL_STUB_SERVER_CLEANUP_FAILED');
    },
  };
}

function createSmokeApiClient(apiUrl, accessToken, timeoutMs) {
  return { async resolve(smokeCase) {
    const response = await fetch(new URL('/assistant/geo/resolve', apiUrl), {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: smokeCase.content, locale: 'ru', country: 'ru' }),
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(response.status, 201, `${smokeCase.slug}: HTTP ${response.status}`);
    return readBoundedJson(response, 128 * 1_024);
  } };
}

async function handleLocationIqStub(request, response, config, activeCase, counts) {
  if (!activeCase) throw new Error('ASSISTANT_FIX_GEO1_STUB_CASE_REQUIRED');
  const url = new URL(request.url, config.locationIqUrl);
  if (request.method !== 'GET' || url.pathname !== config.locationIqUrl.pathname
    || url.searchParams.get('key') !== config.dummyApiKey || url.searchParams.get('format') !== 'json'
    || url.searchParams.get('polygon_geojson') !== '1' || url.searchParams.get('addressdetails') !== '1'
    || url.searchParams.get('countrycodes') !== 'ru') return sendJson(response, 400, { error: 'LOCATIONIQ_STUB_REQUEST_INVALID' });
  const query = url.searchParams.get('q');
  counts.get(activeCase.slug).locationiq += 1;
  if (query === 'Москва' && activeCase.kind === 'LINE') return sendJson(response, 200, [moscowAreaFixture()]);
  if (query !== activeCase.canonicalQuery) return sendJson(response, 400, { error: 'LOCATIONIQ_STUB_QUERY_INVALID' });
  if (activeCase.kind === 'AREA') return sendJson(response, 200, [arbatAreaFixture()]);
  return sendJson(response, 200, [{
    place_id: `road-${activeCase.slug}`, display_name: `${activeCase.label}, Москва`, lat: '55.75', lon: '37.62',
    class: 'highway', type: 'primary', osm_type: 'way', osm_id: `10${activeCase.slug.length}`,
    boundingbox: ['55.5', '55.9', '37.3', '37.9'], address: { city: 'Москва', country_code: 'ru' },
    geojson: { type: 'Point', coordinates: [37.62, 55.75] },
  }]);
}

async function handleOverpassStub(request, response, config, activeCase, counts) {
  if (!activeCase || activeCase.kind !== 'LINE') throw new Error('ASSISTANT_FIX_GEO1_STUB_ROAD_CASE_REQUIRED');
  const url = new URL(request.url, config.overpassUrl);
  if (request.method !== 'POST' || url.pathname !== config.overpassUrl.pathname) return sendJson(response, 400, { error: 'OVERPASS_STUB_REQUEST_INVALID' });
  const query = new URLSearchParams(await readRequestBody(request, 256 * 1_024)).get('data') ?? '';
  if (!query.includes('relation[') || query.includes('way[') || !query.includes(JSON.stringify(activeCase.tagValue))) {
    return sendJson(response, 400, { error: 'OVERPASS_STUB_QUERY_INVALID' });
  }
  counts.get(activeCase.slug).overpass += 1;
  const roadIndex = ['sadovoe', 'ttk', 'mkad'].indexOf(activeCase.slug);
  if (roadIndex < 0) throw new Error('ASSISTANT_FIX_GEO1_STUB_ROAD_IDENTITY_INVALID');
  const relationId = 500 + roadIndex;
  const memberRef = 1_000 + roadIndex * 10;
  return sendJson(response, 200, { elements: [{
    type: 'relation', id: relationId, tags: { type: 'route', route: 'road', ref: activeCase.tagValue },
    members: [
      { type: 'way', ref: memberRef + 1, geometry: [{ lat: 55.7, lon: 37.5 }, { lat: 55.8, lon: 37.7 }] },
      { type: 'way', ref: memberRef + 2, geometry: [{ lat: 55.8, lon: 37.7 }, { lat: 55.7, lon: 37.5 }] },
    ],
  }] });
}

function assertResolutionPayload(payload, smokeCase) {
  assert.equal(payload.status, 'RESOLVED', `${smokeCase.slug}: status`);
  assert.equal(payload.placeQuery, smokeCase.label, `${smokeCase.slug}: label`);
  assert.equal(payload.candidates?.length, 1, `${smokeCase.slug}: expected one candidate`);
  assert.equal(payload.candidates[0]?.kind, smokeCase.kind, `${smokeCase.slug}: kind`);
  assert.equal(payload.candidates[0]?.mode, smokeCase.mode, `${smokeCase.slug}: mode`);
}

function assertCaseAudit(audit, smokeCase, config) {
  assert.equal(audit.operation.status, 'RESOLVED', `${smokeCase.slug}: operation status`);
  assert.equal(audit.operation.provider, smokeCase.sourceProvider, `${smokeCase.slug}: operation provider`);
  assert.equal(audit.operation.cacheHit, false, `${smokeCase.slug}: cache hit`);
  assert.equal(audit.operation.errorCode, null, `${smokeCase.slug}: operation error`);
  assert.equal(audit.operation.providerCallCount, smokeCase.attempts.length, `${smokeCase.slug}: operation calls`);
  assert.deepEqual(audit.attempts.map(({ provider }) => provider), smokeCase.attempts, `${smokeCase.slug}: receipts`);
  assert.deepEqual(audit.attempts.map(({ attemptOrdinal }) => attemptOrdinal), smokeCase.attempts.map((_, index) => index + 1));
  for (const attempt of audit.attempts) {
    assert.equal(attempt.status, 'SETTLED'); assert.equal(attempt.outcome, 'SUCCESS'); assert.equal(attempt.errorCode, null);
    assert.ok(Number.isInteger(attempt.durationMs) && attempt.durationMs >= 0);
  }
  assert.equal(audit.landmarks.length, 1, `${smokeCase.slug}: landmark count`);
  assert.equal(audit.landmarks[0].sourceProvider, smokeCase.sourceProvider, `${smokeCase.slug}: landmark provider`);
  assert.equal(audit.landmarks[0].kind, smokeCase.kind, `${smokeCase.slug}: landmark kind`);
  assert.equal(audit.caches.length, 1, `${smokeCase.slug}: cache count`);
  assert.notEqual(audit.caches[0].candidatesJson.length, 0, `${smokeCase.slug}: negative cache`);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(config.dummyApiKey), false, `${smokeCase.slug}: leaked provider key`);
  for (const endpoint of [config.locationIqUrl, config.overpassUrl]) {
    assert.equal(serialized.includes(endpoint.href), false, `${smokeCase.slug}: leaked provider URL`);
  }
}

function assertUsageTotals(rows, spent) {
  for (const window of ['minute', 'day']) for (const provider of ['locationiq', 'overpass']) {
    const totals = rows.filter((row) => row.window === window && row.provider === provider).reduce((sum, row) => ({
      requests: sum.requests + row.requestCount, completed: sum.completed + row.completedCount, errors: sum.errors + row.errorCount,
    }), { requests: 0, completed: 0, errors: 0 });
    const expected = spent[provider];
    assert.deepEqual(totals, { requests: expected, completed: expected, errors: 0 }, `${provider}/${window}`);
  }
}

function assertRemainingBudget(cli, spent, smokeCase) {
  const locationiq = smokeCase.attempts.filter((provider) => provider === 'locationiq').length;
  const overpass = smokeCase.attempts.filter((provider) => provider === 'overpass').length;
  if (spent.locationiq + locationiq > cli.locationiq || spent.overpass + overpass > cli.overpass
    || spent.total + smokeCase.attempts.length > cli.total) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_BUDGET_EXHAUSTED');
}

function assertSpentWithinBudget(cli, spent) {
  if (spent.locationiq > cli.locationiq || spent.overpass > cli.overpass || spent.total > cli.total) {
    throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_BUDGET_EXCEEDED');
  }
}

function readExactCliLimit(value, expected, name) {
  if (value === undefined) throw new Error(`ASSISTANT_FIX_GEO1_LOCAL_STUB_MAX_${name}_REQUIRED`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed !== expected) throw new Error(`ASSISTANT_FIX_GEO1_LOCAL_STUB_MAX_${name}_INVALID`);
  return parsed;
}

function readDisposableDatabaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_DATABASE_URL_INVALID'); }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (url.protocol !== 'postgresql:' || !['postgres', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/(?:^|[_-])(?:pidafix2|smoke|test|disposable)(?:$|[_-])/iu.test(databaseName)) {
    throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_DISPOSABLE_DATABASE_REQUIRED');
  }
  return url.toString();
}

function readPidafix2TestDatabaseUrl(value) {
  const databaseUrl = readDisposableDatabaseUrl(value);
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  if (!/(?:^|[_-])pidafix2(?:$|[_-])/iu.test(databaseName)) {
    throw new Error('ASSISTANT_PIDAFIX2_TEST_DATABASE_REQUIRED');
  }
  return databaseUrl;
}

function readLoopbackUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name}_INVALID`); }
  if (url.protocol !== 'http:' || !isLoopback(url.hostname) || url.username || url.password || url.search || url.hash
    || !url.port || Number(url.port) < 1_024) throw new Error(`${name}_LOCAL_ONLY`);
  return url;
}

function isLoopback(hostname) { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname); }
function expectEnvironment(environment, key, expected) {
  if (environment[key] !== expected) throw new Error(`${key}_MUST_EQUAL_${expected.toUpperCase()}`);
}
function readPositiveInteger(value, code) {
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code); return parsed;
}
function readSecret(value, code) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 8_192) throw new Error(code); return value;
}
function readBoundedInteger(value, fallback, minimum, maximum, code) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code); return parsed;
}
function parseNullSeparated(buffer) {
  return buffer.toString('utf8').split('\0').reduce((environment, entry) => {
    const separator = entry.indexOf('='); if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1); return environment;
  }, {});
}

function moscowAreaFixture() {
  return { place_id: 'moscow-area', display_name: 'Москва, Россия', lat: '55.75', lon: '37.62', class: 'boundary',
    type: 'administrative', osm_type: 'relation', osm_id: '2555133', boundingbox: ['55.5', '55.9', '37.3', '37.9'],
    address: { city: 'Москва', country_code: 'ru' }, geojson: { type: 'Polygon',
      coordinates: [[[37.3, 55.5], [37.9, 55.5], [37.9, 55.9], [37.3, 55.5]]] } };
}
function arbatAreaFixture() {
  return { place_id: 'arbat-area', display_name: 'район Арбат, Москва', lat: '55.7522', lon: '37.5906', class: 'boundary',
    type: 'administrative', osm_type: 'relation', osm_id: '1255910', boundingbox: ['55.744', '55.765', '37.565', '37.606'],
    address: { city: 'Москва', country_code: 'ru' }, geojson: { type: 'Polygon',
      coordinates: [[[37.565, 55.744], [37.606, 55.744], [37.606, 55.765], [37.565, 55.744]]] } };
}
function listenExact(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error); server.once('error', onError);
    server.listen(Number(endpoint.port), endpoint.hostname.replace(/^\[|\]$/gu, ''), () => { server.off('error', onError); resolve(); });
  });
}
function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function readRequestBody(request, maximumBytes) {
  const chunks = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > maximumBytes) throw new Error('ASSISTANT_FIX_GEO1_STUB_REQUEST_TOO_LARGE'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function sendJson(response, status, payload) {
  if (response.headersSent) return; const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); response.end(body);
}
async function readBoundedJson(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_RESPONSE_TOO_LARGE');
  const body = await response.arrayBuffer();
  if (body.byteLength > maximumBytes) throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_RESPONSE_TOO_LARGE');
  try { return JSON.parse(Buffer.from(body).toString('utf8')); } catch { throw new Error('ASSISTANT_FIX_GEO1_LOCAL_STUB_RESPONSE_INVALID'); }
}

module.exports = {
  createLocalProviderStubs,
  parseSmokeArguments,
  readDisposableDatabaseUrl,
  readPidafix2TestDatabaseUrl,
  runAssistantFixGeo1LocalStubSmoke,
  smokeCases,
  validateRuntimeSnapshot,
};
