const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const {
  createBaselineGateManifest,
} = require('../scripts/assistant-pidafix3-baseline.cjs');

const {
  assertProviderCountersUnchanged,
  assertRemainingBudget,
  assertSpentWithinBudget,
  createGeoLiveEnvironment,
  createLocalMapStyle,
  createProviderCallReport,
  createTerminationAwareFetch,
  executeGeoCasesSequentially,
  exactCaps,
  geoIdentityVersion,
  geoLiveCases,
  parseGeoLiveArguments,
  summarizeProviderAttemptRows,
  validateFakeBaselineReport,
} = require('../scripts/assistant-pidafix3-geo-live.cjs');

const root = resolve(__dirname, '../../..');
const exactArguments = [
  '--run-live-geo',
  '--max-locationiq-attempts', '8',
  '--max-overpass-attempts', '3',
  '--max-total-attempts', '11',
  '--baseline-report', '/tmp/pidafix3-baseline-report.json',
];

test('PIDAFIX3 Geo live CLI is dry-run by default and requires exact opt-in caps', () => {
  assert.deepEqual(parseGeoLiveArguments([]), {
    execute: false, locationiq: 8, overpass: 3, total: 11, baselineReport: null,
  });
  assert.deepEqual(parseGeoLiveArguments(exactArguments), {
    execute: true,
    locationiq: 8,
    overpass: 3,
    total: 11,
    baselineReport: '/tmp/pidafix3-baseline-report.json',
  });
  for (const invalid of [
    exactArguments.filter((argument) => argument !== '--run-live-geo'),
    exactArguments.filter((argument) => argument !== '--baseline-report'),
    exactArguments.map((argument) => argument === '8' ? '9' : argument),
    [...exactArguments, '--unknown'],
    [...exactArguments, '--run-live-geo'],
  ]) assert.throws(() => parseGeoLiveArguments(invalid), /PIDAFIX3_GEO_LIVE_/u);
});

test('PIDAFIX3 Geo live cases have deterministic order and exact aggregate caps', () => {
  assert.deepEqual(geoLiveCases.map(({ slug }) => slug), ['point', 'sadovoe', 'ttk', 'mkad', 'arbat']);
  const totals = geoLiveCases.reduce((spent, smokeCase) => {
    spent.locationiq += smokeCase.attempts.filter((provider) => provider === 'locationiq').length;
    spent.overpass += smokeCase.attempts.filter((provider) => provider === 'overpass').length;
    spent.total += smokeCase.attempts.length;
    return spent;
  }, { locationiq: 0, overpass: 0, total: 0 });
  assert.deepEqual(totals, exactCaps);
  assert.deepEqual(geoLiveCases.filter(({ kind }) => kind === 'LINE').map(({ provider }) => provider), [
    'overpass', 'overpass', 'overpass',
  ]);
  assert.equal(geoIdentityVersion, 2);
  assert.equal(geoLiveCases[0].label, 'Белорусский вокзал');
  assert.equal(geoLiveCases[0].normalizedQuery, 'белорусский вокзал');
});

test('PIDAFIX3 Geo live budget stops before a next physical case and rejects overspend', () => {
  const spent = { locationiq: 8, overpass: 3, total: 11 };
  assert.throws(() => assertRemainingBudget(spent, geoLiveCases.at(-1), exactCaps), /BUDGET_EXHAUSTED/u);
  assert.throws(() => assertSpentWithinBudget({ locationiq: 9, overpass: 3, total: 12 }, exactCaps), /BUDGET_EXCEEDED/u);
  assert.doesNotThrow(() => assertRemainingBudget({ locationiq: 0, overpass: 0, total: 0 }, geoLiveCases[0], exactCaps));
});

test('PIDAFIX3 Geo live environment keeps other paid and worker boundaries disabled', () => {
  const base = {
    PATH: '/usr/bin',
    LOCATIONIQ_API_KEY: 'locationiq-test-key-1234567890',
    ALIBABA_API_KEY: 'must-not-survive',
    ASSISTANT_QUERY_PLANNER_LIVE: 'true',
    TELEGRAM_BOT_TOKEN: 'must-not-survive',
  };
  const environment = createGeoLiveEnvironment(base, {
    suffix: 'deadbeef',
    postgresPassword: 'safe-test-password',
    postgresPort: 15432,
    apiPort: 13000,
    webPort: 15173,
    mapPort: 18080,
  });
  assert.equal(environment.PIDAFIX3_LOCATIONIQ_API_KEY, base.LOCATIONIQ_API_KEY);
  assert.equal(Object.hasOwn(environment, 'LOCATIONIQ_API_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'ALIBABA_API_KEY'), false);
  assert.equal(environment.ASSISTANT_AI_MODE, 'fake');
  assert.equal(environment.ASSISTANT_QUERY_PLANNER_LIVE, 'false');
  assert.equal(environment.ASSISTANT_EMBEDDING_MODE, 'fake');
  assert.equal(environment.ASSISTANT_SOURCE_WORKER_ENABLED, 'false');
  assert.equal(environment.TRAINING_MODULE_ENABLED, 'false');
  assert.equal(environment.TELEGRAM_TRANSPORT_MODE, 'fake');
  assert.throws(() => createGeoLiveEnvironment({
    ...base,
    ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE: 'false',
  }, {
    suffix: 'deadbeef', postgresPassword: 'x', postgresPort: 1, apiPort: 2, webPort: 3, mapPort: 4,
  }), /LEGACY_REMOTE_FLAG_FORBIDDEN/u);
});

test('PIDAFIX3 Geo live requires a matching completed fake baseline', () => {
  const now = Date.parse('2026-08-29T08:00:00.000Z');
  const baseline = {
    version: 1,
    head: 'a'.repeat(40),
    taskDiffSha256: 'b'.repeat(64),
    startedAt: '2026-08-29T07:50:00.000Z',
    finishedAt: '2026-08-29T07:59:00.000Z',
    setup: [
      'compose-config', 'compose-build', 'postgres-up',
      'migrate-platforma_pidafix3', 'migration-status-platforma_pidafix3',
      'create-db-fix_token_test', 'migrate-fix_token_test', 'migration-status-fix_token_test',
      'create-db-t03_test', 'migrate-t03_test', 'migration-status-t03_test',
      'create-db-t05_test', 'migrate-t05_test', 'migration-status-t05_test',
      'create-db-pidafix2_test', 'migrate-pidafix2_test', 'migration-status-pidafix2_test',
      'api-web-up', 'compose-down', 'image-rm-postgres', 'image-rm-api', 'image-rm-web',
    ].map((id) => ({ id, exitCode: 0 })),
    gates: createBaselineGateManifest().map((gate) => ({ ...gate, exitCode: 0 })),
    readiness: {
      healthStatus: 200,
      webStatus: 200,
      unauthenticatedAssistantStatus: 401,
      authenticatedAssistantStatus: 200,
      assistantEnabled: true,
      permissionKeys: ['objects:read', 'admin:access'],
      seedMode: 'minimal-rbac-without-db-seed',
      assistantBacklog: 0,
      postgisVersion: '3.5 USE_GEOS=1',
      landmarkTable: 'assistant_geo_landmarks',
    },
    manualQa: { requested: true, runtimeReady: true, completed: true },
    cleanup: {
      completed: true,
      residualResources: {
        containers: [], networks: [], volumes: [], nestedContainers: [], nestedNetworks: [], images: [],
      },
      preexistingContainersPreserved: true,
      exactImageTagsRemoved: true,
    },
    externalProviderEvidence: {
      status: 'verified',
      calls: { alibaba: 0, locationiq: 0, overpass: 0 },
      persistedUsageAttempts: { alibaba: 0, locationiq: 0, overpass: 0 },
      deniedRemoteRequests: 0,
    },
    costUsd: 0,
  };
  const expected = { head: baseline.head, taskDiffSha256: baseline.taskDiffSha256, nowMs: now };
  assert.equal(validateFakeBaselineReport(baseline, expected), true);
  for (const invalid of [
    { ...baseline, head: 'c'.repeat(40) },
    { ...baseline, gates: baseline.gates.slice(1) },
    { ...baseline, gates: baseline.gates.map((gate, index) => index === 0 ? { ...gate, exitCode: 1 } : gate) },
    { ...baseline, gates: baseline.gates.map((gate, index) => index === 0
      ? { ...gate, command: ['node', 'not-the-required-gate.cjs'] }
      : gate) },
    { ...baseline, setup: baseline.setup.filter(({ id }) => id !== 'migration-status-platforma_pidafix3') },
    { ...baseline, readiness: { ...baseline.readiness, assistantBacklog: 1 } },
    { ...baseline, manualQa: { requested: true, runtimeReady: true, completed: false } },
    { ...baseline, cleanup: { completed: false } },
    { ...baseline, externalProviderEvidence: { status: 'not-measured' } },
    { ...baseline, finishedAt: '2026-08-27T07:59:00.000Z' },
    { ...baseline, failure: 'failed earlier' },
  ]) assert.throws(() => validateFakeBaselineReport(invalid, expected));
});

test('PIDAFIX3 Geo live stops before the next case after termination', async () => {
  let interrupted = false;
  const visited = [];
  await assert.rejects(executeGeoCasesSequentially(geoLiveCases.slice(0, 2), exactCaps, {
    termination: {
      throwIfRequested() {
        if (interrupted) throw new Error('PIDAFIX3_INTERRUPTED_BY_SIGTERM');
      },
    },
    executeCase: async (smokeCase) => {
      visited.push(smokeCase.slug);
      interrupted = true;
      return { attempts: smokeCase.attempts.map((provider) => ({ provider })) };
    },
  }), /PIDAFIX3_INTERRUPTED_BY_SIGTERM/u);
  assert.deepEqual(visited, ['point']);
});

test('PIDAFIX3 Geo live reports partial calls from the persisted ledger', () => {
  assert.deepEqual(createProviderCallReport({ locationiq: 2, overpass: 1 }, exactCaps), {
    status: 'verified-from-ledger',
    locationiq: 2,
    overpass: 1,
    total: 3,
  });
  assert.throws(() => createProviderCallReport({ locationiq: 9, overpass: 1 }, exactCaps), /BUDGET_EXCEEDED/u);
  assert.deepEqual(summarizeProviderAttemptRows([
    { provider: 'locationiq', status: 'SETTLED', outcome: 'SUCCESS', _count: { _all: 2 } },
    { provider: 'overpass', status: 'RESERVED', outcome: null, _count: { _all: 1 } },
  ], exactCaps), {
    calls: { status: 'verified-from-ledger', locationiq: 2, overpass: 1, total: 3 },
    statuses: {
      reserved: { locationiq: 0, overpass: 1, total: 1 },
      settledSuccess: { locationiq: 2, overpass: 0, total: 2 },
      settledError: { locationiq: 0, overpass: 0, total: 0 },
    },
  });
});

test('PIDAFIX3 Geo live termination-aware fetch aborts in flight and rejects before a second call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const guardedFetch = createTerminationAwareFetch(controller.signal, async (_input, init) => {
    calls += 1;
    await new Promise((resolvePromise, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  const first = guardedFetch('http://127.0.0.1/test', { signal: AbortSignal.timeout(5_000) });
  controller.abort(new Error('PIDAFIX3_INTERRUPTED_BY_SIGINT'));
  await assert.rejects(first, /PIDAFIX3_INTERRUPTED_BY_SIGINT/u);
  await assert.rejects(guardedFetch('http://127.0.0.1/test'), /PIDAFIX3_INTERRUPTED_BY_SIGINT/u);
  assert.equal(calls, 1);
});

test('PIDAFIX3 Geo live browser proof rejects any provider counter change', () => {
  assert.doesNotThrow(() => assertProviderCountersUnchanged(
    { locationiq: 8, overpass: 3 },
    { locationiq: 8, overpass: 3 },
  ));
  assert.throws(() => assertProviderCountersUnchanged(
    { locationiq: 8, overpass: 3 },
    { locationiq: 9, overpass: 3 },
  ), /BROWSER_RECALLED_PROVIDER/u);
});

test('PIDAFIX3 Geo live Compose override has no extra services or legacy bypass', async () => {
  const [composeSource, runnerSource] = await Promise.all([
    readFile(resolve(root, 'docker-compose.assistant-pidafix3-geo-live.yml'), 'utf8'),
    readFile(resolve(root, 'apps/api/scripts/assistant-pidafix3-geo-live.cjs'), 'utf8'),
  ]);
  assert.deepEqual([...composeSource.matchAll(/^  ([a-z][a-z0-9-]+):$/gmu)].map(([, name]) => name), ['api', 'web']);
  assert.match(composeSource, /ASSISTANT_GEO_PROVIDER_MAX_RETRIES: "0"/u);
  assert.match(composeSource, /ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: "8"/u);
  assert.match(composeSource, /ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE: "3"/u);
  assert.match(composeSource, /LOCATIONIQ_API_KEY: \$\{PIDAFIX3_LOCATIONIQ_API_KEY:\?/u);
  assert.match(composeSource, /MAP_STYLE_URL: http:\/\/127\.0\.0\.1:/u);
  assert.doesNotMatch(composeSource, /ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE/u);
  assert.doesNotMatch(composeSource, /ALIBABA_API_KEY/u);
  const finallyBlock = runnerSource.slice(runnerSource.indexOf('  } finally {'));
  const stopIndex = finallyBlock.indexOf('stopResult = await stopProviderBoundary()');
  const reconciliationIndex = finallyBlock.indexOf('reconcileProviderCallReport(prisma');
  const disconnectIndex = finallyBlock.indexOf('prisma?.$disconnect()');
  assert.ok(stopIndex >= 0 && stopIndex < reconciliationIndex);
  assert.ok(reconciliationIndex >= 0 && reconciliationIndex < disconnectIndex);
});

test('PIDAFIX3 Geo live browser proof covers adversarial filters, geometry, markers and local tiles', async () => {
  const source = await readFile(resolve(root, 'apps/api/scripts/assistant-pidafix3-geo-live.cjs'), 'utf8');
  const style = createLocalMapStyle('http://127.0.0.1:18080');
  assert.deepEqual(style.sources.rasterFixture.tiles, [
    'http://127.0.0.1:18080/tiles/{z}/{x}/{y}.png',
  ]);
  assert.equal(style.layers.some(({ type, source: layerSource }) => (
    type === 'raster' && layerSource === 'rasterFixture'
  )), true);
  for (const fixture of [
    'lineOutside', 'lineWrongRooms', 'lineOverBudget',
    'areaOutside', 'areaWrongRooms', 'areaOverBudget',
  ]) assert.match(source, new RegExp(`\\b${fixture}\\b`, 'u'));
  assert.match(source, /run\.intentJson\.hardFilters/u);
  assert.match(source, /ST_AsGeoJSON\(ST_Buffer/u);
  assert.match(source, /map-price-marker--primary/u);
  assert.match(source, /map-price-marker--alternative/u);
  assert.match(source, /localTileRequests/u);
});
