const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  ASSISTANT_AI_PRICING_CATALOG_VERSION,
  addAssistantUsd,
  calculateAssistantAiCost,
  estimateAssistantAiCallCost,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  AssistantModelUsagePolicyService,
} = require('../dist/assistant/operations/assistant-model-usage-policy.service.js');
const {
  createAssistantPlannerGateway,
  parseAssistantOpenAiUsage,
} = require('../dist/assistant/assistant-planner-gateway.js');
const {
  AssistantSourceDiscoveryService,
} = require('../dist/assistant/sources/assistant-source-discovery.service.js');
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

test('FIX-TOKEN repeat uses the checkpoint without discovery while refresh runs once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-repeat-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = {
    projectKey: 'checkpoint-project',
    title: 'Checkpoint project',
    developerKey: 'checkpoint-developer',
    developerName: 'Checkpoint developer',
  };
  const fingerprint = {
    primaryModel: 'gpt-5.6-luna',
    fallbackModel: 'gpt-5.6-terra',
    promptVersion: 'assistant-source-discovery-v1',
    validatorVersion: 'assistant-source-discovery-validator-v1',
  };
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
