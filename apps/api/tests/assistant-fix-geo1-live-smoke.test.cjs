const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');

const {
  createLocalProviderStubs,
  parseSmokeArguments,
  readDisposableDatabaseUrl,
  readPidafix2TestDatabaseUrl,
  runAssistantFixGeo1LocalStubSmoke,
  smokeCases,
  validateRuntimeSnapshot,
} = require('../scripts/assistant-fix-geo1-live-smoke.cjs');

const validArguments = [
  '--run-local-stubs',
  '--max-locationiq-attempts', '7',
  '--max-overpass-attempts', '3',
  '--max-total-attempts', '10',
];

test('PIDAFIX2 smoke CLI requires exact budgets, local opt-in and a bounded case', () => {
  assert.deepEqual(parseSmokeArguments(validArguments), {
    locationiq: 7, overpass: 3, total: 10, case: null,
  });
  assert.equal(parseSmokeArguments([...validArguments, '--case', 'ttk']).case, 'ttk');
  for (const invalid of [
    [],
    validArguments.filter((argument) => argument !== '--run-local-stubs'),
    validArguments.slice(0, -2),
    [...validArguments, '--unknown'],
    [...validArguments, '--case', 'other'],
    [...validArguments, '--case', 'ttk', '--case', 'mkad'],
    validArguments.map((argument) => argument === '7' ? '8' : argument),
  ]) assert.throws(() => parseSmokeArguments(invalid), /ASSISTANT_FIX_GEO1_LOCAL_STUB_/u);
});

test('PIDAFIX2 smoke readiness rejects fake, remote, real-key and non-disposable runtime', () => {
  const baseline = createRuntimeSnapshot();
  assert.equal(validateRuntimeSnapshot(baseline, createInvocationEnvironment()).dummyApiKey, 'pidafix2-local-stub');
  const mutations = [
    ['ASSISTANT_GEO_PROVIDER_MODE', 'fake'],
    ['LOCATIONIQ_API_URL', 'https://us1.locationiq.com/v1/search'],
    ['LOCATIONIQ_API_KEY', 'real-looking-key'],
    ['DATABASE_URL', 'postgresql://platforma:test@postgres:5432/platforma'],
    ['DEPLOYMENT_ENV', 'production'],
    ['ASSISTANT_FIX_GEO1_LOCAL_STUB_API_URL', 'http://127.0.0.1:33091/api'],
    ['ASSISTANT_GEO_PROVIDER_MAX_RETRIES', '1'],
    ['ASSISTANT_OVERPASS_ENABLED', 'false'],
    ['ASSISTANT_GEO_CACHE_TTL_SECONDS', '59'],
    ['ASSISTANT_GEO_CACHE_TTL_SECONDS', '31536001'],
    ['ASSISTANT_GEO_CACHE_TTL_SECONDS', 'not-a-number'],
  ];
  for (const [key, value] of mutations) {
    const snapshot = createRuntimeSnapshot();
    snapshot.environment[key] = value;
    assert.throws(() => validateRuntimeSnapshot(snapshot, createInvocationEnvironment()));
  }
});

test('PIDAFIX2 disposable database guards require bounded name tokens', () => {
  assert.match(readDisposableDatabaseUrl('postgresql://postgres@127.0.0.1:5432/platforma_test'), /platforma_test/u);
  assert.match(readPidafix2TestDatabaseUrl('postgresql://postgres@127.0.0.1:5432/platforma_pidafix2_fresh_test'), /pidafix2/u);
  for (const unsafe of [
    'postgresql://postgres@127.0.0.1:5432/platforma_latest',
    'postgresql://postgres@127.0.0.1:5432/platforma_contest',
  ]) assert.throws(() => readDisposableDatabaseUrl(unsafe), /DISPOSABLE_DATABASE_REQUIRED/u);
  assert.throws(
    () => readPidafix2TestDatabaseUrl('postgresql://postgres@127.0.0.1:5432/platforma_test'),
    /PIDAFIX2_TEST_DATABASE_REQUIRED/u,
  );
});

test('PIDAFIX2 smoke reconciles exact batch receipts, usage and stub counters', async () => {
  const closed = [];
  let currentCase = null;
  const result = await runAssistantFixGeo1LocalStubSmoke({
    argv: validArguments,
    environment: createInvocationEnvironment(),
    runtime: { read: async () => createRuntimeSnapshot() },
    output: { write: () => {} },
    api: {
      async resolve(smokeCase) {
        return {
          status: 'RESOLVED',
          placeQuery: smokeCase.label,
          candidates: [{ kind: smokeCase.kind, mode: smokeCase.mode }],
        };
      },
    },
    ledger: {
      assertClean: async () => {},
      readCase: async (query) => createCaseAudit(
        Object.values(smokeCases).find(({ canonicalQuery }) => canonicalQuery === query),
      ),
      readUsageTotals: async () => createUsageTotals({ locationiq: 7, overpass: 3 }),
      close: async () => { closed.push('ledger'); },
    },
    stubs: {
      start: async () => {},
      setCase: (smokeCase) => { currentCase = smokeCase; },
      readCaseCounts: () => providerCounts(currentCase.attempts),
      readTotals: () => ({ locationiq: 7, overpass: 3 }),
      close: async () => { closed.push('stubs'); },
    },
  });
  assert.deepEqual(result, {
    locationiq: 7, overpass: 3, total: 10, cases: ['sadovoe', 'ttk', 'mkad', 'arbat'],
  });
  assert.deepEqual(new Set(closed), new Set(['ledger', 'stubs']));
});

test('PIDAFIX2 smoke surfaces cleanup failures after closing every resource', async () => {
  const closeAttempts = [];
  await assert.rejects(runAssistantFixGeo1LocalStubSmoke({
    argv: [...validArguments, '--case', 'arbat'],
    environment: createInvocationEnvironment(),
    runtime: { read: async () => createRuntimeSnapshot() },
    output: { write: () => {} },
    api: {
      resolve: async () => ({
        status: 'RESOLVED',
        placeQuery: smokeCases.arbat.label,
        candidates: [{ kind: smokeCases.arbat.kind, mode: smokeCases.arbat.mode }],
      }),
    },
    ledger: {
      assertClean: async () => {},
      readCase: async () => createCaseAudit(smokeCases.arbat),
      readUsageTotals: async () => createUsageTotals({ locationiq: 1, overpass: 0 }),
      close: async () => { closeAttempts.push('ledger'); throw new Error('LEDGER_CLOSE_FAILED'); },
    },
    stubs: {
      start: async () => {},
      setCase: () => {},
      readCaseCounts: () => ({ locationiq: 1, overpass: 0 }),
      readTotals: () => ({ locationiq: 1, overpass: 0 }),
      close: async () => { closeAttempts.push('stubs'); throw new Error('STUBS_CLOSE_FAILED'); },
    },
  }), (error) => error instanceof AggregateError
    && error.message === 'ASSISTANT_FIX_GEO1_LOCAL_STUB_CLEANUP_FAILED'
    && error.errors.some(({ message }) => message === 'LEDGER_CLOSE_FAILED')
    && error.errors.some(({ message }) => message === 'STUBS_CLOSE_FAILED'));
  assert.deepEqual(new Set(closeAttempts), new Set(['ledger', 'stubs']));
});

test('PIDAFIX2 smoke rejects cache false-positive and stops before the next case', async () => {
  let apiCalls = 0;
  let closed = 0;
  await assert.rejects(runAssistantFixGeo1LocalStubSmoke({
    argv: validArguments,
    environment: createInvocationEnvironment(),
    runtime: { read: async () => createRuntimeSnapshot() },
    output: { write: () => {} },
    api: {
      async resolve(smokeCase) {
        apiCalls += 1;
        return { status: 'RESOLVED', placeQuery: smokeCase.label,
          candidates: [{ kind: smokeCase.kind, mode: smokeCase.mode }] };
      },
    },
    ledger: {
      assertClean: async () => {},
      readCase: async () => {
        const audit = createCaseAudit(smokeCases.sadovoe);
        audit.operation.cacheHit = true;
        return audit;
      },
      readUsageTotals: async () => [],
      close: async () => { closed += 1; },
    },
    stubs: {
      start: async () => {}, setCase: () => {}, readCaseCounts: () => ({ locationiq: 2, overpass: 1 }),
      readTotals: () => ({ locationiq: 2, overpass: 1 }), close: async () => { closed += 1; },
    },
  }), /cache hit/u);
  assert.equal(apiCalls, 1);
  assert.equal(closed, 2);
});

test('PIDAFIX2 smoke rejects an actual provider endpoint leaked into audit data', async () => {
  const runtime = createRuntimeSnapshot();
  await assert.rejects(runAssistantFixGeo1LocalStubSmoke({
    argv: [...validArguments, '--case', 'arbat'],
    environment: createInvocationEnvironment(),
    runtime: { read: async () => runtime },
    output: { write: () => {} },
    api: {
      resolve: async () => ({ status: 'RESOLVED', placeQuery: smokeCases.arbat.label,
        candidates: [{ kind: smokeCases.arbat.kind, mode: smokeCases.arbat.mode }] }),
    },
    ledger: {
      assertClean: async () => {},
      readCase: async () => {
        const audit = createCaseAudit(smokeCases.arbat);
        audit.landmarks[0].sourceMetadata = { requestUrl: runtime.environment.LOCATIONIQ_API_URL };
        return audit;
      },
      readUsageTotals: async () => createUsageTotals({ locationiq: 1, overpass: 0 }),
      close: async () => {},
    },
    stubs: {
      start: async () => {}, setCase: () => {}, readCaseCounts: () => ({ locationiq: 1, overpass: 0 }),
      readTotals: () => ({ locationiq: 1, overpass: 0 }), close: async () => {},
    },
  }), /leaked provider URL/u);
});

test('PIDAFIX2 node:http stubs accept canonical local provider requests only', async () => {
  const [locationIqPort, overpassPort] = await Promise.all([findFreePort(), findFreePort()]);
  const config = {
    dummyApiKey: 'pidafix2-local-stub',
    locationIqUrl: new URL(`http://127.0.0.1:${locationIqPort}/v1/search`),
    overpassUrl: new URL(`http://127.0.0.1:${overpassPort}/api/interpreter`),
  };
  const stubs = createLocalProviderStubs(config);
  try {
    await stubs.start();
    stubs.setCase(smokeCases.ttk);
    const initial = new URL(config.locationIqUrl);
    for (const [key, value] of Object.entries({
      key: config.dummyApiKey,
      q: smokeCases.ttk.canonicalQuery,
      format: 'json',
      addressdetails: '1',
      namedetails: '1',
      normalizeaddress: '1',
      normalizecity: '1',
      limit: '3',
      'accept-language': 'ru',
      countrycodes: 'ru',
      viewbox: '37.3,55.5,37.9,55.9',
      bounded: '1',
    })) initial.searchParams.set(key, value);
    assert.equal((await fetch(initial)).status, 200);
    initial.searchParams.set('q', 'Москва');
    assert.equal((await fetch(initial)).status, 200);
    const overpass = await fetch(config.overpassUrl, {
      method: 'POST',
      body: new URLSearchParams({ data: `relation["ref"="ТТК"];out geom;` }),
    });
    assert.equal(overpass.status, 200);
    stubs.setCase(smokeCases.arbat);
    const area = new URL(initial);
    area.searchParams.set('q', smokeCases.arbat.canonicalQuery);
    area.searchParams.set('polygon_geojson', '1');
    assert.equal((await fetch(area)).status, 200);
    assert.deepEqual(stubs.readTotals(), { locationiq: 3, overpass: 1 });
  } finally {
    await stubs.close();
  }
});

function createRuntimeSnapshot() {
  return {
    command: 'node apps/api/dist/main.js',
    environment: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://platforma:test@postgres:5432/pidafix2_disposable_test',
      ASSISTANT_FIX_GEO1_LOCAL_STUB_SMOKE: 'true',
      ASSISTANT_FIX_GEO1_LOCAL_STUB_API_URL: 'http://127.0.0.1:3000',
      ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
      ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
      LOCATIONIQ_API_KEY: 'pidafix2-local-stub',
      LOCATIONIQ_API_URL: 'http://127.0.0.1:33091/v1/search',
      ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
      ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '20',
      ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '100',
      ASSISTANT_GEO_CACHE_TTL_SECONDS: '3600',
      ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE: '2',
      ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE: '1',
      ASSISTANT_OVERPASS_ENABLED: 'true',
      ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:33092/api/interpreter',
      ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE: '20',
      ASSISTANT_OVERPASS_DAILY_BUDGET: '100',
      ASSISTANT_AI_MODE: 'fake',
      ASSISTANT_QUERY_PLANNER_LIVE: 'false',
      ASSISTANT_EMBEDDING_MODE: 'fake',
      ASSISTANT_SOURCE_WORKER_ENABLED: 'false',
      FEED_AUTO_IMPORT_ENABLED: 'false',
      TRAINING_MODULE_ENABLED: 'false',
      TELEGRAM_TRANSPORT_MODE: 'fake',
    },
  };
}

function createInvocationEnvironment() {
  return { ASSISTANT_FIX_GEO1_LOCAL_STUB_ACCESS_TOKEN: 'test-access-token-1234567890' };
}

function createCaseAudit(smokeCase) {
  return {
    operation: {
      status: 'RESOLVED', provider: smokeCase.sourceProvider, cacheHit: false, errorCode: null,
      providerCallCount: smokeCase.attempts.length,
    },
    attempts: smokeCase.attempts.map((provider, index) => ({
      provider, attemptOrdinal: index + 1, status: 'SETTLED', outcome: 'SUCCESS', errorCode: null, durationMs: 1,
    })),
    landmarks: [{ sourceProvider: smokeCase.sourceProvider, kind: smokeCase.kind }],
    caches: [{ candidatesJson: [{ id: 'safe-id' }] }],
  };
}

function providerCounts(attempts) {
  return {
    locationiq: attempts.filter((provider) => provider === 'locationiq').length,
    overpass: attempts.filter((provider) => provider === 'overpass').length,
  };
}

function createUsageTotals(counts) {
  return ['minute', 'day'].flatMap((window) => ['locationiq', 'overpass'].map((provider) => ({
    provider, window, requestCount: counts[provider], completedCount: counts[provider], errorCount: 0,
  })));
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
