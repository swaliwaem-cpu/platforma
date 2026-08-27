const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Prisma } = require('@prisma/client');

const {
  ASSISTANT_AI_PRICING_CATALOG_VERSION,
  addAssistantUsd,
  calculateAssistantAiCost,
  estimateAssistantAiCallCost,
  parseAssistantUsd,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  AssistantModelUsagePolicyService,
} = require('../dist/assistant/operations/assistant-model-usage-policy.service.js');
const {
  createAssistantPlannerGateway,
  parseAssistantOpenAiUsage,
} = require('../dist/assistant/assistant-planner-gateway.js');
const {
  AssistantSourceDiscoveryError,
  AssistantSourceDiscoveryService,
} = require('../dist/assistant/sources/assistant-source-discovery.service.js');
const {
  SourceConnectorError,
} = require('../dist/assistant/sources/official-html-source.connector.js');
const {
  checkpointAssistantSourceDiscoveryResult,
  createEmptyCheckpoint,
  readAssistantSourceDiscoveryCheckpoint,
  writeAssistantSourceDiscoveryCheckpoint,
} = require('../dist/assistant/sources/assistant-source-discovery-checkpoint.js');
const {
  createReport,
  discoverProjects,
  parseArguments,
  runAssistantSourceDiscovery,
} = require('../scripts/assistant-source-discovery.cjs');

const fixture = JSON.parse(readFileSync(
  join(__dirname, 'fixtures/assistant/discovery-usage-2026-08-26-27.json'),
  'utf8',
));

test('FIX-TOKEN cost catalog reproduces the observed discovery bill exactly', () => {
  assert.equal(ASSISTANT_AI_PRICING_CATALOG_VERSION, fixture.catalogVersion);
  const costs = fixture.buckets.flatMap((bucket) => {
    const modelCosts = bucket.models.map((usage) => calculateAssistantAiCost({
      ...usage,
      webSearchCalls: 0,
    }));
    return [
      ...modelCosts,
      calculateAssistantAiCost({
        model: 'gpt-5.6-luna',
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        webSearchCalls: bucket.webSearchCalls,
      }),
    ];
  });

  assert.equal(costs.every(({ status }) => status === 'PRICED'), true);
  assert.equal(addAssistantUsd(costs.map(({ estimatedUsd }) => estimatedUsd)), fixture.expectedUsd);
});

test('FIX-TOKEN cost catalog rejects incomplete or contradictory usage instead of underbilling', () => {
  assert.equal(calculateAssistantAiCost({
    model: 'gpt-5.6-luna',
    inputTokens: 100,
    cachedInputTokens: null,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    webSearchCalls: 0,
  }).status, 'USAGE_INCOMPLETE');

  assert.equal(calculateAssistantAiCost({
    model: 'gpt-5.6-luna',
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 30,
    outputTokens: 5,
    webSearchCalls: 0,
  }).status, 'USAGE_INVALID');
});

test('FIX-TOKEN cost catalog applies standard and long-context rates at the exact boundary', () => {
  const standard = calculateAssistantAiCost({
    model: 'gpt-5.6-luna',
    inputTokens: 272_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    webSearchCalls: 0,
  });
  const long = calculateAssistantAiCost({
    model: 'gpt-5.6-luna',
    inputTokens: 272_001,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    webSearchCalls: 0,
  });

  assert.equal(standard.estimatedUsd, '0.05440000');
  assert.equal(long.estimatedUsd, '0.10880040');
});

test('FIX-TOKEN cost catalog prices cached, cache-write and Web Search usage separately', () => {
  const priced = calculateAssistantAiCost({
    model: 'gpt-5.6-luna',
    inputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    cacheWriteInputTokens: 500_000,
    outputTokens: 0,
    webSearchCalls: 1,
    pricingTier: 'standard',
  });
  const conservative = estimateAssistantAiCallCost({
    model: 'gpt-5.6-luna',
    requestBytes: 1,
    maxOutputTokens: 0,
    maxWebSearchCalls: 0,
  });

  assert.equal(priced.estimatedUsd, '0.14500000');
  assert.equal(conservative.estimatedUsd, '0.00102425');
});

test('FIX-TOKEN OpenAI mode requires an explicit daily USD budget', () => {
  assert.throws(
    () => new AssistantModelUsagePolicyService({}, {
      ASSISTANT_AI_MODE: 'openai',
      ASSISTANT_MODEL_REQUESTS_PER_MINUTE: '60',
      ASSISTANT_MODEL_REQUESTS_PER_DAY: '5000',
    }),
    /ASSISTANT_MODEL_DAILY_BUDGET_USD_REQUIRED/u,
  );
});

test('FIX-TOKEN planner refuses paid OpenAI calls without explicit confirmation', () => {
  assert.throws(
    () => createAssistantPlannerGateway({
      ASSISTANT_AI_MODE: 'openai',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'false',
      OPENAI_API_KEY: 'key-alone-is-not-permission',
    }),
    /ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED/u,
  );
});

test('FIX-TOKEN usage parser keeps cache categories and counts actual Web Search calls', () => {
  assert.deepEqual(parseAssistantOpenAiUsage({
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 12 },
    },
    output: [
      { type: 'web_search_call', id: 'search-1' },
      { type: 'message', content: [] },
    ],
  }), {
    inputTokens: 120,
    cachedInputTokens: 50,
    cacheWriteInputTokens: 20,
    outputTokens: 30,
    reasoningTokens: 12,
    totalTokens: 150,
    webSearchCalls: 1,
  });
});

test('FIX-TOKEN checkpoint is versioned, reusable and omits provider narrative and URL secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-checkpoint-'));
  const path = join(directory, 'checkpoint.json');
  const fingerprint = {
    primaryModel: 'gpt-5.6-luna',
    fallbackModel: 'gpt-5.6-terra',
    promptVersion: 'prompt-v1',
    validatorVersion: 'validator-v1',
  };
  try {
    const checkpoint = checkpointAssistantSourceDiscoveryResult(
      createEmptyCheckpoint(fingerprint),
      {
        status: 'REJECTED',
        project: {
          projectKey: 'safe-project',
          title: 'Safe project',
          developerKey: 'safe-developer',
          developerName: 'Safe developer',
        },
        developerCanonicalUrl: 'https://developer.example/?access_token=secret',
        officialDeveloperName: 'Safe developer',
        canonicalUrl: 'https://developer.example/project?signature=secret',
        officialProjectName: 'Safe project',
        matchKind: 'EXACT',
        reason: 'provider-generated narrative must not persist',
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_MISMATCH',
        citations: ['https://source.example/private'],
        developerCitations: [],
        projectCitations: [],
        matchedProjectAlias: null,
        matchedPlatformProjectAlias: null,
        matchedOfficialProjectAlias: null,
        matchedDeveloperAlias: null,
        matchedAddress: false,
        contentChecksum: 'a'.repeat(64),
        developerCacheHit: false,
        telemetry: null,
      },
      new Date('2026-08-27T12:00:00.000Z'),
    );
    writeAssistantSourceDiscoveryCheckpoint(path, checkpoint);
    const serialized = readFileSync(path, 'utf8');
    const loaded = readAssistantSourceDiscoveryCheckpoint(path, fingerprint);

    assert.equal(serialized.includes('provider-generated'), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('source.example'), false);
    assert.equal(loaded.entries['safe-project'].canonicalUrl, 'https://developer.example/project');
    assert.equal(loaded.entries['safe-project'].status, 'REJECTED');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN corrupted checkpoint stops the run before provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-corrupted-checkpoint-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  try {
    writeFileSync(checkpointPath, '{"version":1,"entries":', { mode: 0o600 });
    await assertCheckpointFailureStopsProvider(
      checkpointPath,
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN inaccessible checkpoint stops the run before provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-inaccessible-checkpoint-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      createEmptyCheckpoint(checkpointFingerprint()),
    );
    chmodSync(checkpointPath, 0o000);
    const unreadableCheckpointPath = resolveUnreadableCheckpointPath(checkpointPath);
    await assertCheckpointFailureStopsProvider(
      unreadableCheckpointPath,
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_READ_FAILED',
    );
  } finally {
    chmodSync(checkpointPath, 0o600);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN fingerprint mismatch stops the run before provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-fingerprint-checkpoint-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      createEmptyCheckpoint({
        ...checkpointFingerprint(),
        validatorVersion: 'outdated-validator-version',
      }),
    );
    await assertCheckpointFailureStopsProvider(
      checkpointPath,
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_FINGERPRINT_MISMATCH',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN discovery defaults to a one-project dry-run and never constructs a provider', async () => {
  let providerConstructed = false;
  const application = {
    get() { return {}; },
    async close() {},
  };
  const report = await runAssistantSourceDiscovery({
    argv: [],
    environment: {
      OPENAI_API_KEY: 'present-but-insufficient',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    },
    silent: true,
    dependencies: {
      async createApplicationContext() { return application; },
      async selectProjects(_prisma, limit, missingOnly) {
        assert.equal(limit, 1);
        assert.equal(missingOnly, true);
        return [{
          projectKey: 'dry-run-project',
          title: 'Dry run project',
          developerKey: 'dry-run-developer',
          developerName: 'Dry run developer',
        }];
      },
      createDiscovery() {
        providerConstructed = true;
        throw new Error('provider must not be constructed');
      },
    },
  });

  assert.equal(providerConstructed, false);
  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.selection.requestedProjects, 1);
  assert.equal(report.selection.maximumEstimatedUsd, '0.10000000');
  assert.equal(report.summary.providerRequests, 0);
});

test('FIX-TOKEN dry-run estimate depends on the selected call mix instead of the requested cap', async () => {
  const projects = Array.from({ length: 20 }, (_, index) => {
    const sequence = String(index + 1).padStart(2, '0');
    return {
      projectKey: `dry-estimate-${sequence}`,
      title: `Dry estimate ${sequence}`,
      developerKey: `dry-developer-${sequence}`,
      developerName: `Dry developer ${sequence}`,
    };
  });
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-dry-estimate-'));
  try {
    const oneProjectLowCap = await runDryRunEstimate({
      projects,
      limit: 1,
      requestedCostCapUsd: '0.01000000',
      checkpointPath: join(directory, 'one-low.json'),
    });
    const oneProjectHighCap = await runDryRunEstimate({
      projects,
      limit: 1,
      requestedCostCapUsd: '0.02000000',
      checkpointPath: join(directory, 'one-high.json'),
    });
    const twoProjects = await runDryRunEstimate({
      projects,
      limit: 2,
      requestedCostCapUsd: '0.01000000',
      checkpointPath: join(directory, 'two-low.json'),
    });
    const threeProjects = await runDryRunEstimate({
      projects,
      limit: 3,
      requestedCostCapUsd: '0.01000000',
      checkpointPath: join(directory, 'three-low.json'),
    });
    const twelveProjects = await runDryRunEstimate({
      projects,
      limit: 12,
      requestedCostCapUsd: '0.01000000',
      checkpointPath: join(directory, 'twelve-low.json'),
    });
    const twentyProjects = await runDryRunEstimate({
      projects,
      limit: 20,
      requestedCostCapUsd: '0.01000000',
      checkpointPath: join(directory, 'twenty-low.json'),
    });

    assert.equal(oneProjectLowCap.selection.requestedCostCapUsd, '0.01000000');
    assert.equal(oneProjectHighCap.selection.requestedCostCapUsd, '0.02000000');
    assert.equal(twentyProjects.selection.requestedCostCapUsd, '0.01000000');
    assert.match(oneProjectLowCap.selection.maximumEstimatedUsd, /^\d+\.\d{8}$/u);
    assert.equal(
      oneProjectLowCap.selection.maximumEstimatedUsd,
      oneProjectHighCap.selection.maximumEstimatedUsd,
    );
    const oneProjectMaximum = parseAssistantUsd(oneProjectLowCap.selection.maximumEstimatedUsd);
    const twoProjectMaximum = parseAssistantUsd(twoProjects.selection.maximumEstimatedUsd);
    const threeProjectMaximum = parseAssistantUsd(threeProjects.selection.maximumEstimatedUsd);
    const secondProjectIncrement = twoProjectMaximum - oneProjectMaximum;
    const thirdProjectIncrement = threeProjectMaximum - twoProjectMaximum;

    assert.ok(oneProjectMaximum > 0n);
    assert.ok(thirdProjectIncrement > 0n);
    assert.ok(
      secondProjectIncrement > thirdProjectIncrement,
      'the second project adds the second permitted Terra call; the third adds Luna calls only',
    );
    assert.equal(
      twelveProjects.selection.maximumEstimatedUsd,
      twentyProjects.selection.maximumEstimatedUsd,
      'the batch estimate must stop growing after the 35-call limit',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN repeat uses the checkpoint without discovery while refresh runs once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-repeat-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = {
    projectKey: 'checkpoint-project',
    title: 'Checkpoint project',
    developerKey: 'checkpoint-developer',
    developerName: 'Checkpoint developer',
  };
  const fingerprint = checkpointFingerprint();
  const result = {
    status: 'VERIFIED',
    project,
    developerCanonicalUrl: 'https://developer.example/',
    officialDeveloperName: 'Checkpoint developer',
    canonicalUrl: 'https://developer.example/checkpoint-project',
    officialProjectName: 'Checkpoint project',
    matchKind: 'EXACT',
    reason: 'not persisted',
    errorCode: null,
    citations: [],
    developerCitations: [],
    projectCitations: [],
    matchedProjectAlias: 'checkpoint project',
    matchedPlatformProjectAlias: 'checkpoint project',
    matchedOfficialProjectAlias: 'checkpoint project',
    matchedDeveloperAlias: 'checkpoint developer',
    matchedAddress: false,
    contentChecksum: 'b'.repeat(64),
    developerCacheHit: false,
    telemetry: null,
  };
  let discoveryCalls = 0;
  const prisma = {
    assistantKnowledgeSource: {
      async findMany() { return []; },
    },
    realEstateObject: {
      async findMany() {
        return [{
          title: project.title,
          slug: project.projectKey,
          address: null,
          feedUnitsCount: 10,
          developer: {
            name: project.developerName,
            normalizedName: project.developerKey,
            slug: project.developerKey,
          },
        }];
      },
    },
  };
  const application = {
    get() { return prisma; },
    async close() {},
  };
  const environment = {
    OPENAI_API_KEY: 'bounded-local-stub',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
    ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
  };
  const dependencies = {
    async createApplicationContext() { return application; },
    usageBudgets: {},
    createDiscovery() {
      return {
        async discover(candidate) {
          discoveryCalls += 1;
          assert.equal(candidate.projectKey, project.projectKey);
          return result;
        },
      };
    },
  };

  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      checkpointAssistantSourceDiscoveryResult(
        createEmptyCheckpoint(fingerprint),
        result,
      ),
    );
    const repeated = await runAssistantSourceDiscovery({
      argv: ['--live'],
      environment,
      silent: true,
      dependencies,
    });
    assert.equal(discoveryCalls, 0);
    assert.equal(repeated.summary.checkpointEntriesSkipped, 1);

    const refreshed = await runAssistantSourceDiscovery({
      argv: ['--live', '--refresh'],
      environment,
      silent: true,
      dependencies,
    });
    assert.equal(discoveryCalls, 1);
    assert.equal(refreshed.summary.verified, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN live report preserves an early successful attempt when a later phase fails', async () => {
  const runId = 'fix-token-late-phase-report';
  const report = await runPersistedDiscoveryReport({
    runId,
    attempts: [
      persistedUsageAttempt({
        id: '11111111-1111-4111-8111-111111111111',
        runId,
        attemptOrdinal: 1,
        outcome: 'ACCEPTED',
        inputTokens: 20n,
        cachedInputTokens: 0n,
        cacheWriteInputTokens: 0n,
        outputTokens: 13n,
        reasoningTokens: 5n,
        totalTokens: 33n,
        webSearchCalls: 1,
        reservedCostUsd: '0.01000000',
        estimatedCostUsd: '0.00002000',
        chargedCostUsd: '0.00002000',
      }),
      persistedUsageAttempt({
        id: '22222222-2222-4222-8222-222222222222',
        runId,
        attemptOrdinal: 2,
        outcome: 'PROVIDER_ERROR',
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED',
        reservedCostUsd: '0.01234567',
        estimatedCostUsd: null,
        chargedCostUsd: '0.01234567',
      }),
    ],
    discoveryError: failedDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED'),
  });

  assert.equal(report.summary.providerRequests, 2);
  assert.equal(report.summary.lunaCalls, 2);
  assert.equal(report.summary.terraCalls, 0);
  assert.equal(report.summary.fallbackCalls, 0);
  assert.deepEqual(report.summary.tokenUsage, {
    inputTokens: 20,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 13,
    reasoningTokens: 5,
    totalTokens: 33,
    webSearchCalls: 1,
  });
  assert.equal(report.summary.reservedUsd, '0.02234567');
  assert.equal(report.summary.estimatedUsd, null);
  assert.equal(report.summary.chargedUsd, '0.01236567');
  assert.equal(report.results[0].status, 'ERROR');
  assert.equal(report.results[0].errorCode, 'ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED');
});

test('FIX-TOKEN live report charges the full reserve for failed persisted usage without telemetry', async () => {
  const runId = 'fix-token-unknown-usage-report';
  const report = await runPersistedDiscoveryReport({
    runId,
    attempts: [persistedUsageAttempt({
      id: '33333333-3333-4333-8333-333333333333',
      runId,
      attemptOrdinal: 1,
      outcome: 'PROVIDER_ERROR',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_TIMEOUT',
      reservedCostUsd: '0.01234567',
      estimatedCostUsd: null,
      chargedCostUsd: '0.01234567',
    })],
    discoveryError: failedDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_TIMEOUT'),
  });

  assert.equal(report.pricingCatalogVersion, ASSISTANT_AI_PRICING_CATALOG_VERSION);
  assert.equal(report.summary.providerRequests, 1);
  assert.equal(report.summary.reservedUsd, '0.01234567');
  assert.equal(report.summary.estimatedUsd, null);
  assert.equal(report.summary.chargedUsd, '0.01234567');
});

test('FIX-TOKEN discovery report counts a failed paid provider attempt without pretending it cost zero', async () => {
  const project = {
    projectKey: 'failed-provider-project',
    title: 'Failed provider project',
    developerKey: 'failed-provider-developer',
    developerName: 'Failed provider developer',
  };
  const discovery = new AssistantSourceDiscoveryService(
    {
      OPENAI_API_KEY: 'bounded-local-stub',
      ASSISTANT_SOURCE_DISCOVERY_LIVE: 'false',
    },
    async () => { throw new Error('simulated transport failure'); },
    { async fetch() { throw new Error('connector must not run'); } },
  );

  const results = await discoverProjects(discovery, [project], 1, {});
  const report = createReport(parseArguments([]), results, [], {
    runId: 'failed-provider-report',
    selectedProjects: [project],
    maximumEstimatedUsd: '0.10000000',
    checkpointHits: 0,
  });

  assert.equal(report.summary.providerRequests, 1);
  assert.equal(report.summary.lunaCalls, 1);
  assert.equal(report.summary.estimatedUsd, null);
  assert.equal(report.results[0].providerRequests, 1);
});

test('FIX-TOKEN discovery never uses Terra after parse, transport, HTTP or source-fetch failure', async (context) => {
  const scenarios = [
    {
      name: 'malformed structured output',
      failureKind: 'MALFORMED',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_OUTPUT_INVALID',
    },
    {
      name: 'provider timeout',
      failureKind: 'TIMEOUT',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_TIMEOUT',
      permitsLunaRetry: true,
    },
    {
      name: 'provider network failure',
      failureKind: 'NETWORK',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED',
      permitsLunaRetry: true,
    },
    {
      name: 'provider HTTP 429',
      failureKind: 'HTTP_429',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_HTTP_429',
      permitsLunaRetry: true,
    },
    {
      name: 'provider HTTP 5xx',
      failureKind: 'HTTP_503',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_HTTP_503',
      permitsLunaRetry: true,
    },
    {
      name: 'official source fetch failure',
      failureKind: 'SOURCE_FETCH',
      errorCode: 'SOURCE_FETCH_TIMEOUT',
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const providerBodies = [];
      const candidateUrl = 'https://developer.example/official/amber-city';
      const service = new AssistantSourceDiscoveryService(
        sourceDiscoveryEnvironment(),
        async (_url, init) => {
          const requestBody = JSON.parse(init.body);
          providerBodies.push(requestBody);
          if (requestBody.text.format.name === 'platforma_official_developer_candidate') {
            return sourceDiscoveryResponse({
              status: 'FOUND',
              canonicalUrl: 'https://developer.example/',
              officialDeveloperName: 'ФСК',
              reason: 'Официальный сайт застройщика.',
            }, ['https://developer.example/'], 'matrix-developer');
          }
          if (scenario.failureKind === 'MALFORMED') {
            return malformedSourceDiscoveryResponse('matrix-malformed');
          }
          if (scenario.failureKind === 'TIMEOUT') {
            throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_TIMEOUT');
          }
          if (scenario.failureKind === 'NETWORK') {
            throw new Error('simulated provider network failure');
          }
          if (scenario.failureKind === 'HTTP_429' || scenario.failureKind === 'HTTP_503') {
            const status = scenario.failureKind === 'HTTP_429' ? 429 : 503;
            return new Response(JSON.stringify({ id: `matrix-http-${status}`, error: { status } }), {
              status,
              headers: { 'content-type': 'application/json' },
            });
          }
          return sourceDiscoveryResponse({
            status: 'FOUND',
            canonicalUrl: candidateUrl,
            officialProjectName: 'Amber City',
            matchKind: 'EXACT',
            reason: 'Проект найден.',
          }, [candidateUrl], 'matrix-project');
        },
        {
          async fetch(source) {
            if (source.canonicalUrl === 'https://developer.example/') {
              return fetchedSourcePage(
                source.canonicalUrl,
                '<html><body>Официальный сайт застройщика ФСК</body></html>',
              );
            }
            if (scenario.failureKind === 'SOURCE_FETCH'
              && source.canonicalUrl === candidateUrl) {
              throw new SourceConnectorError('SOURCE_FETCH_TIMEOUT', true, 504);
            }
            throw new Error('known path unavailable');
          },
        },
      );

      let outcome;
      try {
        outcome = await service.discover(fixTokenProject());
      } catch (error) {
        outcome = error;
      }
      assert.equal(outcome.code ?? outcome.errorCode, scenario.errorCode);
      const requestedModels = providerBodies.map(({ model }) => model);
      assert.equal(requestedModels.includes('gpt-5.6-terra'), false);
      assert.equal(requestedModels.every((model) => model === 'gpt-5.6-luna'), true);
      assert.equal(requestedModels.length >= 2, true);
      assert.equal(requestedModels.length <= (scenario.permitsLunaRetry ? 3 : 2), true);
    });
  }
});

test('FIX-TOKEN discovery requires both live flag and explicit paid-call confirmation', async () => {
  await assert.rejects(
    runAssistantSourceDiscovery({
      argv: ['--live'],
      environment: { OPENAI_API_KEY: 'key-alone-is-not-permission' },
      silent: true,
    }),
    /ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED/u,
  );
  assert.throws(
    () => parseArguments(['--live', '--limit', '20']),
    /ASSISTANT_SOURCE_DISCOVERY_ARGUMENT_REQUIRED|ASSISTANT_SOURCE_DISCOVERY_BATCH_LIMITS_REQUIRED/u,
  );
  assert.equal(parseArguments(['--refresh']).missingOnly, false);
});

function checkpointFingerprint() {
  return {
    primaryModel: 'gpt-5.6-luna',
    fallbackModel: 'gpt-5.6-terra',
    promptVersion: 'assistant-source-discovery-v1',
    validatorVersion: 'assistant-source-discovery-validator-v1',
  };
}

function resolveUnreadableCheckpointPath(checkpointPath) {
  try {
    readFileSync(checkpointPath, 'utf8');
  } catch (error) {
    assert.equal(error?.code, 'EACCES');
    return checkpointPath;
  }

  return {
    [Symbol.toPrimitive]() {
      const error = new Error('simulated checkpoint permission denial');
      error.code = 'EACCES';
      throw error;
    },
  };
}

async function assertCheckpointFailureStopsProvider(checkpointPath, expectedCode) {
  let providerConstructed = false;
  let runError = null;
  const application = {
    get() { return {}; },
    async close() {},
  };
  try {
    await runAssistantSourceDiscovery({
      argv: ['--live'],
      environment: {
        OPENAI_API_KEY: 'bounded-local-stub',
        ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
        ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
        ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
      },
      silent: true,
      dependencies: {
        async createApplicationContext() { return application; },
        async selectProjects() { return [fixTokenProject()]; },
        usageBudgets: {},
        createDiscovery() {
          providerConstructed = true;
          return {
            async discover() { throw new Error('provider construction sentinel'); },
          };
        },
      },
    });
  } catch (error) {
    runError = error;
  }

  assert.equal(providerConstructed, false);
  assert.equal(runError?.code ?? runError?.message, expectedCode);
}

async function runDryRunEstimate({
  projects,
  limit,
  requestedCostCapUsd,
  checkpointPath,
}) {
  const application = {
    get() { return {}; },
    async close() {},
  };
  return runAssistantSourceDiscovery({
    argv: [
      '--limit', String(limit),
      '--max-cost-usd', requestedCostCapUsd,
    ],
    environment: {
      OPENAI_API_KEY: 'present-but-insufficient',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'false',
      ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
    },
    silent: true,
    dependencies: {
      async createApplicationContext() { return application; },
      async selectProjects(_prisma, selectedLimit) {
        assert.equal(selectedLimit, limit);
        return projects.slice(0, selectedLimit);
      },
      createDiscovery() {
        throw new Error('dry-run must not construct a provider');
      },
    },
  });
}

async function runPersistedDiscoveryReport({ runId, attempts, discoveryError }) {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-persisted-report-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = fixTokenProject();
  const prisma = {
    assistantAiUsageAttempt: {
      async findMany(query) {
        assert.equal(query.where.operationRunId, runId);
        assert.ok(query.select);
        return attempts;
      },
    },
  };
  const application = {
    get() { return prisma; },
    async close() {},
  };

  try {
    return await runAssistantSourceDiscovery({
      argv: ['--live'],
      environment: {
        OPENAI_API_KEY: 'bounded-local-stub',
        ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
        ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
        ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
      },
      silent: true,
      dependencies: {
        runId,
        async createApplicationContext() { return application; },
        async selectProjects() { return [project]; },
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
        createDiscovery(options) {
          assert.equal(options.operationRunId, runId);
          return {
            async discover(candidate) {
              assert.equal(candidate.projectKey, project.projectKey);
              throw discoveryError;
            },
          };
        },
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function persistedUsageAttempt({
  id,
  runId,
  attemptOrdinal,
  outcome,
  errorCode = null,
  inputTokens = null,
  cachedInputTokens = null,
  cacheWriteInputTokens = null,
  outputTokens = null,
  reasoningTokens = null,
  totalTokens = null,
  webSearchCalls = null,
  reservedCostUsd,
  estimatedCostUsd,
  chargedCostUsd,
}) {
  return {
    id,
    operationRunId: runId,
    attemptOrdinal,
    operation: 'SOURCE_DISCOVERY',
    provider: 'openai',
    requestedModel: 'gpt-5.6-luna',
    actualModel: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    promptVersion: 'assistant-source-discovery-v1',
    validatorVersion: 'assistant-source-discovery-validator-v1',
    isFallback: false,
    status: 'SETTLED',
    outcome,
    errorCode,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    webSearchCalls,
    pricingCatalogVersion: ASSISTANT_AI_PRICING_CATALOG_VERSION,
    pricingStatus: estimatedCostUsd === null ? 'USAGE_INCOMPLETE' : 'PRICED',
    reservedCostUsd: new Prisma.Decimal(reservedCostUsd),
    estimatedCostUsd: estimatedCostUsd === null ? null : new Prisma.Decimal(estimatedCostUsd),
    chargedCostUsd: new Prisma.Decimal(chargedCostUsd),
    durationMs: 25,
    usageDate: new Date('2026-08-27T00:00:00.000Z'),
    createdAt: new Date('2026-08-27T12:00:00.000Z'),
    settledAt: new Date('2026-08-27T12:00:01.000Z'),
  };
}

function failedDiscoveryError(code) {
  return new AssistantSourceDiscoveryError(code, null, null, null, {
    phase: 'PROJECT',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    requestId: null,
    responseId: null,
    httpStatus: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    webSearchCalls: null,
  });
}

function sourceDiscoveryEnvironment() {
  return {
    OPENAI_API_KEY: 'test-only',
    ASSISTANT_SOURCE_DISCOVERY_MODEL: 'gpt-5.6-luna',
  };
}

function sourceDiscoveryResponse(candidate, citations, responseId) {
  return new Response(JSON.stringify({
    id: responseId,
    output: [
      {
        type: 'web_search_call',
        action: { sources: citations.map((url) => ({ type: 'url', url })) },
      },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify(candidate),
          annotations: citations.map((url) => ({
            type: 'url_citation',
            url,
            title: 'Источник',
          })),
        }],
      },
    ],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 13,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 33,
    },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': `req-${responseId}`,
    },
  });
}

function malformedSourceDiscoveryResponse(responseId) {
  return new Response(JSON.stringify({
    id: responseId,
    output: [
      { type: 'web_search_call', action: { sources: [] } },
      {
        type: 'message',
        content: [{ type: 'output_text', text: '{not-json', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 13,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 33,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': `req-${responseId}` },
  });
}

function fetchedSourcePage(finalUrl, html) {
  return {
    finalUrl,
    statusCode: 200,
    contentType: 'text/html',
    checksum: 'f'.repeat(64),
    payload: Buffer.from(html),
    etag: null,
    lastModified: null,
    redirects: [],
  };
}

function fixTokenProject() {
  return {
    projectKey: 'zhiloj-kompleks-amber-city',
    title: 'ЖК Amber City (Эмбер сити)',
    developerKey: 'fsk',
    developerName: 'ФСК',
    address: 'Москва, Шелепихинская набережная, дом 34',
  };
}
