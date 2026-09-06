const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  composeResourceFilters,
  createGatePlan,
  createSafeEnvironment,
  createTaskDiffCheckPlan,
  parseTestCount,
  redact,
  runTaskDiffCheck,
  verifyT07CurrentFactFixtureEvidence,
} = require('../scripts/assistant-pidafix3-baseline.cjs');
const {
  assertLocalDockerEndpoint,
  createT07OwnershipFilters,
  createUnverifiedProviderEvidence,
  installTerminationHandlers,
  isExpectedT07ApiNavigationAbort,
  isExpectedT07MetroTileAbort,
  removeT07OwnedDockerResources,
  runBoundedOperation,
  runCommand,
  verifyT07ProviderEvidence,
} = require('../scripts/assistant-pidafix3-runtime.cjs');

const root = resolve(__dirname, '../../..');

test('PIDAFIX3 plan keeps all external boundaries fake or disabled', () => {
  const environment = createSafeEnvironment({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'must-not-survive',
    LOCATIONIQ_API_KEY: 'must-not-survive',
    TELEGRAM_BOT_TOKEN: 'must-not-survive',
    DATABASE_URL: 'postgresql://production.example/platforma',
    S3_ENDPOINT: 'https://production-storage.example',
    S3_PUBLIC_ENDPOINT: 'https://production-cdn.example',
    S3_REGION: 'production-region',
    S3_ACCESS_KEY_ID: 'production-access-key',
    S3_SECRET_ACCESS_KEY: 'production-secret-key',
    MINIO_BUCKET: 'production-bucket',
    TRAINING_AUDIO_BUCKET: 'production-training-audio',
    ASSISTANT_QUERY_PLANNER_LIVE: 'true',
    ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE: 'true',
  });

  assert.equal(environment.PATH, '/usr/bin');
  for (const key of [
    'OPENAI_API_KEY', 'LOCATIONIQ_API_KEY', 'TELEGRAM_BOT_TOKEN',
    'DATABASE_URL', 'ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE',
  ]) {
    assert.equal(Object.hasOwn(environment, key), false);
  }
  assert.equal(environment.ASSISTANT_AI_MODE, 'fake');
  assert.equal(environment.ASSISTANT_EMBEDDING_MODE, 'fake');
  assert.equal(environment.ASSISTANT_QUERY_PLANNER_LIVE, 'false');
  assert.equal(environment.ASSISTANT_GEO_PROVIDER_MODE, 'fake');
  assert.equal(environment.ASSISTANT_OVERPASS_ENABLED, 'false');
  assert.equal(environment.ASSISTANT_CURRENT_FACT_REFRESH_MODE, 'disabled');
  assert.equal(environment.TELEGRAM_TRANSPORT_MODE, 'fake');
  assert.equal(environment.TRAINING_MODULE_ENABLED, 'false');
  assert.equal(environment.PROJECT_PRESENTATIONS_WORKER_ENABLED, 'false');
  assert.equal(environment.S3_ENDPOINT, 'http://127.0.0.1:9');
  assert.equal(environment.S3_PUBLIC_ENDPOINT, 'http://127.0.0.1:9');
  assert.equal(environment.S3_REGION, 'us-east-1');
  assert.equal(environment.S3_ACCESS_KEY_ID, 'pidafix3-disabled');
  assert.equal(environment.S3_SECRET_ACCESS_KEY, 'pidafix3-disabled');
  assert.equal(environment.MINIO_BUCKET, 'pidafix3-disabled');
  assert.equal(environment.TRAINING_AUDIO_BUCKET, 'platforma-training-audio');
});

test('PIDAFIX3 gate plan includes connected, PostgreSQL, browser and full gates in order', () => {
  assert.deepEqual(createGatePlan().map(({ id }) => id), [
    'zaebal6-unit',
    't07-domain',
    't07-targeted',
    't07-connected-e2e',
    't01-platform-catalog-postgres',
    'fix-token-unit',
    't03-discovery-unit',
    't03-connector-unit',
    'fix-token-postgres',
    't03-postgres',
    't03-browser',
    'fix-geo1-targeted',
    'fix-geo1-postgres',
    'fix-geo1-browser',
    'full-test',
    'full-build',
  ]);
});

test('PIDAFIX3 cleanup filters are scoped to one exact Compose project', () => {
  const filters = composeResourceFilters('platforma-pidafix3-deadbeef');
  for (const args of Object.values(filters)) {
    assert.equal(args.includes('label=com.docker.compose.project=platforma-pidafix3-deadbeef'), true);
  }
  assert.throws(() => composeResourceFilters('platforma'), /did not match/u);
});

test('PIDAFIX3 task diff check covers tracked and untracked task files without mutating the index', () => {
  const plan = createTaskDiffCheckPlan();
  assert.deepEqual(plan.trackedArgs.slice(0, 4), ['diff', '--check', 'HEAD', '--']);
  assert.deepEqual(plan.listTrackedArgs.slice(0, 3), ['ls-files', '--cached', '--']);
  assert.equal(plan.paths.includes('apps/api/scripts/assistant-pidafix3-geo-live.cjs'), true);
  assert.equal(plan.paths.includes('apps/api/scripts/assistant-eval-runner.cjs'), true);
  assert.equal(plan.paths.includes('apps/api/src/assistant/rollout/assistant-rollout-preflight.ts'), true);
  assert.equal(plan.paths.includes('apps/api/tests/assistant-t02-domain.test.cjs'), true);
  assert.equal(plan.paths.includes('apps/api/tests/assistant-t01-postgres.test.cjs'), true);
  assert.equal(plan.paths.includes('apps/api/src/assistant/catalog/assistant-platform-catalog.service.ts'), true);
  assert.equal(plan.paths.includes('packages/shared/src/assistant.ts'), true);
  assert.equal(plan.paths.includes('apps/api/tests/assistant-t03-postgres.cjs'), true);
  assert.equal(plan.paths.includes('apps/api/tests/assistant-t07-domain.test.cjs'), true);
  assert.equal(plan.paths.includes('docker-compose.yml'), true);
  assert.equal(plan.paths.includes('docs/helpar/t07-manual-qa.md'), true);
  assert.deepEqual(plan.untrackedArgs('apps/api/scripts/assistant-pidafix3-geo-live.cjs'), [
    'diff', '--no-index', '--check', '--', '/dev/null',
    'apps/api/scripts/assistant-pidafix3-geo-live.cjs',
  ]);
});

test('PIDAFIX3 task diff check validates the current untracked implementation files', async () => {
  const records = [];
  await runTaskDiffCheck(records, createSafeEnvironment(process.env), []);
  assert.equal(records.length, 1);
  assert.equal(records[0].exitCode, 0);
  assert.equal(records[0].checkedUntrackedPaths.every((path) => (
    createTaskDiffCheckPlan().paths.includes(path)
  )), true);
});

test('PIDAFIX3 report helpers redact credentials and count TAP tests', () => {
  const secret = 'pidafix3-secret';
  assert.equal(redact(`Bearer ${secret} postgresql://user:${secret}@127.0.0.1/db`, [secret]),
    'Bearer <redacted> postgresql://<redacted>@127.0.0.1/db');
  assert.equal(parseTestCount('# tests 4\nℹ tests 7\napps/api test: ℹ tests 750\n'), 761);
  assert.equal(parseTestCount('ASSISTANT_T07_E2E_OK\n'), null);
});

test('PIDAFIX3 baseline requires exact 20-case offline current-fact evidence', () => {
  assert.deepEqual(verifyT07CurrentFactFixtureEvidence([
    'ASSISTANT_T07_MORTGAGE_FIXTURE_OK:20',
    'ASSISTANT_T07_E2E_OK',
  ].join('\n')), {
    status: 'verified',
    scope: 't07-connected-e2e',
    caseCount: 20,
    mode: 'fixture',
    externalConnectorsEnabled: false,
  });
  for (const output of [
    'ASSISTANT_T07_E2E_OK',
    'ASSISTANT_T07_MORTGAGE_FIXTURE_OK:19\nASSISTANT_T07_E2E_OK',
    'ASSISTANT_T07_MORTGAGE_FIXTURE_OK:20',
  ]) {
    assert.throws(
      () => verifyT07CurrentFactFixtureEvidence(output),
      /PIDAFIX3_CURRENT_FACT_FIXTURE_EVIDENCE_INVALID/u,
    );
  }
});

test('PIDAFIX3 Compose file contains only postgres, api and web services', async () => {
  const source = await readFile(resolve(root, 'docker-compose.assistant-pidafix3.yml'), 'utf8');
  const services = source.slice(source.indexOf('services:\n') + 'services:\n'.length, source.indexOf('\nvolumes:'));
  const serviceNames = [...services.matchAll(/^  ([a-z][a-z0-9-]+):$/gmu)].map(([, name]) => name);
  assert.deepEqual(serviceNames, ['postgres', 'api', 'web']);
  assert.match(source, /ASSISTANT_AI_MODE: fake/u);
  assert.match(source, /ASSISTANT_EMBEDDING_MODE: fake/u);
  assert.match(source, /ASSISTANT_GEO_PROVIDER_MODE: fake/u);
  assert.match(source, /PROJECT_PRESENTATIONS_WORKER_ENABLED: "false"/u);
  assert.match(source, /127\.0\.0\.1:\$\{PIDAFIX3_API_PORT/u);
  assert.doesNotMatch(source, /^  (?:redis|minio|.*worker):$/mu);
  assert.doesNotMatch(source, /OPENAI_API_KEY:/u);
  assert.doesNotMatch(source, /LOCATIONIQ_API_KEY:/u);
});

test('PIDAFIX3 T03 PostgreSQL fixture explicitly opts into its local HTTP connector', async () => {
  const source = await readFile(resolve(root, 'apps/api/tests/assistant-t03-postgres.cjs'), 'utf8');
  assert.match(source, /ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS = 'true'/u);
  assert.match(source, /ASSISTANT_EXTERNAL_CONNECTORS_ENABLED = 'true'/u);
  assert.match(source, /ASSISTANT_CURRENT_FACT_REFRESH_MODE = 'live'/u);
});

test('PIDAFIX3 Docker guard accepts a local unix socket and rejects remote endpoints', async () => {
  await assert.doesNotReject(assertLocalDockerEndpoint('unix:///tmp/pidafix3-docker.sock', async () => ({
    isSocket: () => true,
  })));
  for (const endpoint of [
    'tcp://127.0.0.1:2375',
    'ssh://docker.example',
    'https://docker.example',
    'unix://relative.sock',
  ]) {
    await assert.rejects(assertLocalDockerEndpoint(endpoint, async () => ({ isSocket: () => true })));
  }
});

test('PIDAFIX3 command timeout kills a TERM-ignoring descendant after its parent exits', { skip: process.platform === 'win32' }, async () => {
  const source = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
    "child.stdout.once('data', () => process.stdout.write(String(child.pid)));",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, ['-e', source], {
    cwd: root,
    timeoutMs: 1_000,
    killGraceMs: 100,
  });
  assert.equal(result.status, 124);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.match(result.stdout, /^\d+$/u);
  const grandchildPid = Number(result.stdout);
  assert.equal(Number.isInteger(grandchildPid), true);
  try {
    await assertProcessGone(grandchildPid);
  } finally {
    try {
      process.kill(grandchildPid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
});

async function assertProcessGone(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.fail(`PIDAFIX3 descendant ${pid} survived process-group cleanup`);
}

test('PIDAFIX3 termination exposes an abort signal and a fail-closed checkpoint', () => {
  const signalTarget = new EventEmitter();
  const observed = [];
  const termination = installTerminationHandlers({
    signalTarget,
    onSignal: (signal) => observed.push(signal),
  });
  try {
    assert.equal(termination.abortSignal.aborted, false);
    assert.doesNotThrow(() => termination.throwIfRequested());
    signalTarget.emit('SIGTERM');
    assert.equal(termination.signal, 'SIGTERM');
    assert.equal(termination.exitCode, 143);
    assert.equal(termination.abortSignal.aborted, true);
    assert.deepEqual(observed, ['SIGTERM']);
    assert.throws(() => termination.throwIfRequested(), /PIDAFIX3_INTERRUPTED_BY_SIGTERM/u);
  } finally {
    termination.dispose();
  }
});

test('PIDAFIX3 bounded readiness work aborts promptly and propagates the parent reason', async () => {
  const controller = new AbortController();
  let signalSeenByOperation;
  let resolveStarted;
  const started = new Promise((resolveStart) => { resolveStarted = resolveStart; });
  const operation = runBoundedOperation('READINESS_DATABASE', (signal) => {
    signalSeenByOperation = signal;
    resolveStarted();
    return new Promise(() => {});
  }, { abortSignal: controller.signal, timeoutMs: 5_000 });

  await started;
  controller.abort(new Error('PIDAFIX3_INTERRUPTED_BY_SIGTERM'));

  await assert.rejects(operation, /PIDAFIX3_INTERRUPTED_BY_SIGTERM/u);
  assert.equal(signalSeenByOperation.aborted, true);
});

test('PIDAFIX3 bounded readiness work fails closed on its own deadline', async () => {
  await assert.rejects(
    runBoundedOperation('READINESS_HTTP', () => new Promise(() => {}), { timeoutMs: 20 }),
    /PIDAFIX3_READINESS_HTTP_TIMEOUT/u,
  );
});

test('PIDAFIX3 T07 ownership filters select only one exact run', () => {
  assert.deepEqual(createT07OwnershipFilters('deadbeef'), {
    label: 'com.platforma.assistant-t07.run=deadbeef',
    filter: 'label=com.platforma.assistant-t07.run=deadbeef',
    containers: [
      'ps', '--all', '--quiet', '--filter', 'label=com.platforma.assistant-t07.run=deadbeef',
    ],
    networks: [
      'network', 'ls', '--quiet', '--filter', 'label=com.platforma.assistant-t07.run=deadbeef',
    ],
  });
  assert.throws(() => createT07OwnershipFilters('not-exact'), /did not match/u);
});

test('PIDAFIX3 T07 only tolerates navigation-aborted assistant reads', () => {
  const apiOrigin = 'http://127.0.0.1:61013';
  for (const url of [
    `${apiOrigin}/assistant/config`,
    `${apiOrigin}/assistant/conversations`,
  ]) {
    assert.equal(isExpectedT07ApiNavigationAbort({
      method: 'GET',
      url,
      errorText: 'net::ERR_ABORTED',
    }, apiOrigin), true);
  }
  for (const failure of [
    {
      method: 'POST',
      url: `${apiOrigin}/assistant/conversations`,
      errorText: 'net::ERR_ABORTED',
    },
    {
      method: 'GET',
      url: `${apiOrigin}/assistant/conversations`,
      errorText: 'net::ERR_CONNECTION_RESET',
    },
    {
      method: 'GET',
      url: `${apiOrigin}/assistant/messages`,
      errorText: 'net::ERR_ABORTED',
    },
    {
      method: 'GET',
      url: 'http://127.0.0.1:61014/assistant/conversations',
      errorText: 'net::ERR_ABORTED',
    },
  ]) {
    assert.equal(isExpectedT07ApiNavigationAbort(failure, apiOrigin), false);
  }
});

test('FIX-GEO2 T07 only tolerates cancellation of the exact local metro tile GET', () => {
  const webOrigin = 'http://127.0.0.1:61014';
  const expected = { method: 'GET', url: `${webOrigin}/__map_fixture__/metro.pbf`, errorText: 'net::ERR_ABORTED' };
  assert.equal(isExpectedT07MetroTileAbort(expected, webOrigin), true);
  for (const failure of [
    { ...expected, method: 'POST' },
    { ...expected, errorText: 'net::ERR_CONNECTION_RESET' },
    { ...expected, errorText: 'net::ERR_FAILED' },
    { ...expected, url: 'http://127.0.0.1:61015/__map_fixture__/metro.pbf' },
    { ...expected, url: 'https://external.example/__map_fixture__/metro.pbf' },
    { ...expected, url: `${webOrigin}/__map_fixture__/other.pbf` },
    { ...expected, url: `${webOrigin}/assistant/messages` },
  ]) assert.equal(isExpectedT07MetroTileAbort(failure, webOrigin), false);
});

test('PIDAFIX3 T07 ownership cleanup removes every exact-label container and verifies absence', async () => {
  const ownership = createT07OwnershipFilters('deadbeef');
  const calls = [];
  const listResults = ['postgres-id\nmigration-id\n', '', ''];
  let now = 0;
  await removeT07OwnedDockerResources('container', ownership, async (args) => {
    calls.push(args);
    if (args[0] === 'ps') return { stdout: listResults.shift() ?? '' };
    assert.deepEqual(args, ['rm', '--force', 'postgres-id', 'migration-id']);
    return { stdout: '' };
  }, {
    deadlineMs: 1_000,
    settleMs: 50,
    pollMs: 50,
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
  });

  assert.deepEqual(calls, [
    ownership.containers,
    ['rm', '--force', 'postgres-id', 'migration-id'],
    ownership.containers,
    ownership.containers,
  ]);
});

test('PIDAFIX3 T07 ownership cleanup fails closed when an exact-label resource survives', async () => {
  const ownership = createT07OwnershipFilters('deadbeef');
  let now = 0;
  await assert.rejects(
    removeT07OwnedDockerResources('network', ownership, async (args) => ({
      stdout: args[0] === 'network' && args[1] === 'ls' ? 'survivor-id\n' : '',
    }), {
      deadlineMs: 100,
      settleMs: 50,
      pollMs: 50,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
    }),
    /ASSISTANT_T07_NETWORK_CLEANUP_INCOMPLETE/u,
  );
});

test('PIDAFIX3 provider evidence stays unknown until a nonce-bound T07 artifact is verified', () => {
  assert.deepEqual(createUnverifiedProviderEvidence(), {
    status: 'not-measured',
    scope: 't07-connected-e2e',
    calls: { openai: null, locationiq: null, overpass: null },
    persistedUsageAttempts: { openai: null, locationiq: null, overpass: null },
    deniedRemoteRequests: null,
  });
  const nonce = '0123456789abcdef';
  const artifact = {
    version: 1,
    nonce,
    transportStubCalls: { openai: 0, locationiq: 0, overpass: 0 },
    persistedUsageAttempts: { openai: 0, locationiq: 0, overpass: 0 },
    deniedRemoteRequests: 0,
  };
  assert.equal(verifyT07ProviderEvidence(artifact, nonce).status, 'verified');
  assert.throws(() => verifyT07ProviderEvidence({ ...artifact, nonce: 'fedcba9876543210' }, nonce));
  assert.throws(() => verifyT07ProviderEvidence({
    ...artifact,
    transportStubCalls: { openai: 1, locationiq: 0, overpass: 0 },
  }, nonce));
});

test('PIDAFIX3 cleanup and nested T07 resources use exact labels and image refs', async () => {
  const [baselineSource, t07Source] = await Promise.all([
    readFile(resolve(root, 'apps/api/scripts/assistant-pidafix3-baseline.cjs'), 'utf8'),
    readFile(resolve(root, 'apps/api/tests/assistant-t07-e2e.cjs'), 'utf8'),
  ]);
  assert.match(baselineSource, /com\.platforma\.assistant-t07\.parent=/u);
  assert.match(baselineSource, /'image', 'rm', '--force', image/u);
  assert.doesNotMatch(baselineSource, /docker[^\n]*(?:system|image)\s+prune/u);
  assert.match(t07Source, /dockerResourceLabels/u);
  assert.match(t07Source, /ASSISTANT_T07_PARENT_PROJECT/u);
  assert.match(t07Source, /removeOwnedDockerResources\('container'\)/u);
  assert.match(t07Source, /removeOwnedDockerResources\('network'\)/u);
  assert.match(t07Source, /termination\.abortSignal\.addEventListener\('abort'/u);
  assert.match(t07Source, /Promise\.race\(\[resumed, timedOut, interrupted\]\)/u);
});
