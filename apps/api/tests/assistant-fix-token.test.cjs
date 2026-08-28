const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
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
  AssistantAiUsageBudgetService,
} = require('../dist/assistant/operations/assistant-ai-usage-budget.service.js');
const {
  AssistantModelUsagePolicyService,
} = require('../dist/assistant/operations/assistant-model-usage-policy.service.js');
const {
  AssistantQueryPlanner,
} = require('../dist/assistant/assistant-query-planner.js');
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
  selectPilotProjects,
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

test('FIX-TOKEN rejects an unsupported service tier before creating a reservation', async () => {
  let transactionCalls = 0;
  const service = new AssistantAiUsageBudgetService({
    async $transaction() {
      transactionCalls += 1;
      throw new Error('transaction must not start');
    },
  });

  await assert.rejects(service.reserve({
    provider: 'openai',
    model: 'gpt-5.6-luna',
    serviceTier: 'flex',
    operation: 'PLANNER',
    operationRunId: randomUUID(),
    executionId: randomUUID(),
    attemptOrdinal: 1,
    dailyBudgetUsd: '1.00000000',
    reservedCostUsd: '0.10000000',
  }), (error) => error.code === 'ASSISTANT_AI_SERVICE_TIER_UNPRICED');
  assert.equal(transactionCalls, 0);
});

test('FIX-TOKEN retries settlement database failures within a bounded limit', async () => {
  let transactionCalls = 0;
  const service = new AssistantAiUsageBudgetService({
    async $transaction() {
      transactionCalls += 1;
      if (transactionCalls < 3) throw new Error('simulated transient database error');
      return false;
    },
  });

  assert.equal(await service.settle(settlementFixture()), false);
  assert.equal(transactionCalls, 3);
});

test('FIX-TOKEN surfaces a safe error after bounded settlement retries are exhausted', async () => {
  let transactionCalls = 0;
  const service = new AssistantAiUsageBudgetService({
    async $transaction() {
      transactionCalls += 1;
      throw new Error('simulated persistent database error');
    },
  });

  await assert.rejects(
    service.settle(settlementFixture()),
    (error) => error.code === 'ASSISTANT_AI_USAGE_SETTLEMENT_FAILED',
  );
  assert.equal(transactionCalls, 3);
});

test('FIX-TOKEN surfaces the final settlement failure without attempting Terra', async () => {
  let gatewayCalls = 0;
  let settlementCalls = 0;
  const planner = new AssistantQueryPlanner({
    async plan(request) {
      gatewayCalls += 1;
      assert.equal(request.attemptOrdinal, 1);
      return createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }).plan(request);
    },
  }, {
    async beforeAttempt() { return {}; },
    async afterAttempt() {
      settlementCalls += 1;
      const error = new Error('safe settlement failure');
      error.code = 'ASSISTANT_AI_USAGE_SETTLEMENT_FAILED';
      throw error;
    },
  });

  await assert.rejects(
    planner.planWithValidation({ messages: ['Подбери квартиру'], context: null }, async () => null),
    (error) => error.code === 'ASSISTANT_AI_USAGE_SETTLEMENT_FAILED'
      && error.telemetry.length === 1
      && error.telemetry[0].outcome === 'ACCEPTED',
  );
  assert.equal(gatewayCalls, 1);
  assert.equal(settlementCalls, 1);
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
      ASSISTANT_QUERY_PLANNER_LIVE: 'true',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'false',
      OPENAI_API_KEY: 'key-alone-is-not-permission',
    }),
    /ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED/u,
  );
});

test('FIX-TOKEN planner refuses paid OpenAI calls without its explicit live flag', () => {
  let httpCalls = 0;

  assert.throws(
    () => createAssistantPlannerGateway({
      ASSISTANT_AI_MODE: 'openai',
      ASSISTANT_QUERY_PLANNER_LIVE: 'false',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
      OPENAI_API_KEY: 'key-and-confirmation-are-not-live-permission',
    }, async () => {
      httpCalls += 1;
      throw new Error('HTTP must not be reached without the planner live flag');
    }),
    /ASSISTANT_QUERY_PLANNER_LIVE_REQUIRED/u,
  );
  assert.equal(httpCalls, 0);
});

test('FIX-TOKEN local apply guard rejects NODE_ENV production before application startup', async () => {
  let applicationContextCalls = 0;

  await assert.rejects(
    runAssistantSourceDiscovery({
      argv: ['--live', '--apply'],
      environment: {
        NODE_ENV: 'production',
        ASSISTANT_AI_MODE: 'openai',
        ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
        ASSISTANT_SOURCE_DISCOVERY_LOCAL_APPLY: 'true',
        OPENAI_API_KEY: 'bounded-local-stub',
        DATABASE_URL: 'postgresql://user:password@postgres:5432/platforma?schema=public',
      },
      silent: true,
      dependencies: {
        async createApplicationContext() {
          applicationContextCalls += 1;
          throw new Error('application context must not start in production apply mode');
        },
      },
    }),
    /ASSISTANT_SOURCE_DISCOVERY_PRODUCTION_APPLY_FORBIDDEN/u,
  );
  assert.equal(applicationContextCalls, 0);
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
    assert.equal(loaded.checkpoint.entries['safe-project'].canonicalUrl, 'https://developer.example/project');
    assert.equal(loaded.checkpoint.entries['safe-project'].status, 'REJECTED');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN checkpoint read distinguishes a missing file from a valid checkpoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-checkpoint-state-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const fingerprint = checkpointFingerprint();
  try {
    const missing = readAssistantSourceDiscoveryCheckpoint(checkpointPath, fingerprint);
    assert.equal(missing.state, 'MISSING');
    assert.deepEqual(missing.checkpoint, createEmptyCheckpoint(fingerprint));

    writeAssistantSourceDiscoveryCheckpoint(checkpointPath, missing.checkpoint);
    const valid = readAssistantSourceDiscoveryCheckpoint(checkpointPath, fingerprint);
    assert.equal(valid.state, 'VALID');
    assert.deepEqual(valid.checkpoint, missing.checkpoint);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN checkpoint writer preserves unrelated temp files and leaves a private atomic result', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-checkpoint-atomic-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const staleTemporaryPath = `${checkpointPath}.tmp`;
  try {
    writeFileSync(staleTemporaryPath, 'unrelated-stale-temp', { mode: 0o600 });
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      createEmptyCheckpoint(checkpointFingerprint()),
    );

    assert.equal(readFileSync(staleTemporaryPath, 'utf8'), 'unrelated-stale-temp');
    assert.equal(statSync(checkpointPath).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(directory).sort(),
      ['checkpoint.json', 'checkpoint.json.tmp'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN checkpoint writer cleans its temp file and returns a safe error when rename fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-checkpoint-write-failure-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  try {
    mkdirSync(checkpointPath);
    assert.throws(
      () => writeAssistantSourceDiscoveryCheckpoint(
        checkpointPath,
        createEmptyCheckpoint(checkpointFingerprint()),
      ),
      (error) => error?.code === 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_WRITE_FAILED',
    );
    assert.deepEqual(readdirSync(directory), ['checkpoint.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN checkpoint persists terminal outcomes but never masks ERROR as processed', () => {
  const fingerprint = checkpointFingerprint();
  const projects = ['VERIFIED', 'NOT_FOUND', 'REJECTED', 'ERROR'].map((status, index) => ({
    ...fixTokenProject(),
    projectKey: `checkpoint-status-${index + 1}`,
    title: `Checkpoint status ${status}`,
  }));
  const checkpoint = projects.reduce((current, project, index) => (
    checkpointAssistantSourceDiscoveryResult(
      current,
      fixTokenCheckpointResult(project, ['VERIFIED', 'NOT_FOUND', 'REJECTED', 'ERROR'][index]),
    )
  ), createEmptyCheckpoint(fingerprint));

  assert.deepEqual(Object.keys(checkpoint.entries), [
    'checkpoint-status-1',
    'checkpoint-status-2',
    'checkpoint-status-3',
  ]);
  assert.deepEqual(
    Object.values(checkpoint.entries).map(({ status }) => status),
    ['VERIFIED', 'NOT_FOUND', 'REJECTED'],
  );
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
    await assertCheckpointFailureStopsProvider(
      checkpointPath,
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
      ['--live', '--refresh'],
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

test('FIX-TOKEN unknown checkpoint version stops the run before provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-version-checkpoint-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  try {
    writeFileSync(checkpointPath, JSON.stringify({
      ...createEmptyCheckpoint(checkpointFingerprint()),
      version: 2,
    }), { mode: 0o600 });
    await assertCheckpointFailureStopsProvider(
      checkpointPath,
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN malformed checkpoint entry stops the run before provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-entry-checkpoint-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = fixTokenProject();
  try {
    writeFileSync(checkpointPath, JSON.stringify({
      ...createEmptyCheckpoint(checkpointFingerprint()),
      entries: {
        [project.projectKey]: {
          projectKey: project.projectKey,
          developerKey: project.developerKey,
          status: 'VERIFIED',
          processedAt: 'not-a-timestamp',
        },
      },
    }), { mode: 0o600 });
    await assertCheckpointFailureStopsProvider(
      checkpointPath,
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN semantically incomplete VERIFIED checkpoint entry stops before provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-verified-entry-checkpoint-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = fixTokenProject();
  try {
    writeFileSync(checkpointPath, JSON.stringify({
      ...createEmptyCheckpoint(checkpointFingerprint()),
      entries: {
        [project.projectKey]: {
          projectKey: project.projectKey,
          developerKey: project.developerKey,
          status: 'VERIFIED',
          errorCode: null,
          canonicalUrl: null,
          developerCanonicalUrl: null,
          officialProjectName: null,
          officialDeveloperName: null,
          matchKind: null,
          contentChecksum: null,
          processedAt: '2026-08-28T06:00:00.000Z',
        },
      },
    }), { mode: 0o600 });
    await assertCheckpointFailureStopsProvider(
      checkpointPath,
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN refresh rotates a mismatched fingerprint through a sanitized backup before provider work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-rotate-checkpoint-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const backupDirectory = join(directory, 'backups');
  const project = fixTokenProject();
  const currentFingerprint = checkpointFingerprint();
  const oldCheckpoint = checkpointAssistantSourceDiscoveryResult(
    createEmptyCheckpoint({
      ...currentFingerprint,
      validatorVersion: 'assistant-source-discovery-validator-v1',
    }),
    fixTokenCheckpointResult(project),
  );
  const rawCheckpoint = {
    ...oldCheckpoint,
    prompt: 'must-not-survive-backup',
    entries: {
      [project.projectKey]: {
        ...oldCheckpoint.entries[project.projectKey],
        rawProviderPayload: 'https://user:password@provider.example/?api_key=secret',
      },
    },
  };
  let providerConstructedAfterBackup = false;
  const prisma = { assistantAiUsageAttempt: emptyAssistantUsageLedger() };
  const application = {
    get() { return prisma; },
    async close() {},
  };
  try {
    writeFileSync(checkpointPath, `${JSON.stringify(rawCheckpoint, null, 2)}\n`, { mode: 0o600 });
    const report = await runAssistantSourceDiscovery({
      argv: ['--live', '--refresh'],
      environment: {
        OPENAI_API_KEY: 'bounded-local-stub',
        ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
        ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
        ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
      },
      silent: true,
      dependencies: {
        async createApplicationContext() { return application; },
        async selectProjects() { return [project]; },
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
        createDiscovery() {
          const backupFiles = readdirSync(backupDirectory);
          assert.equal(backupFiles.length, 1);
          assert.equal(statSync(backupDirectory).mode & 0o777, 0o700);
          const backupPath = join(backupDirectory, backupFiles[0]);
          const backup = readFileSync(backupPath, 'utf8');
          assert.equal(backup.includes('must-not-survive-backup'), false);
          assert.equal(backup.includes('rawProviderPayload'), false);
          assert.equal(backup.includes('password'), false);
          assert.equal(backup.includes('secret'), false);
          assert.equal(statSync(backupPath).mode & 0o777, 0o600);
          providerConstructedAfterBackup = true;
          return {
            async discover() { return fixTokenCheckpointResult(project); },
          };
        },
      },
    });

    assert.equal(providerConstructedAfterBackup, true);
    assert.equal(report.summary.verified, 1);
    const current = readAssistantSourceDiscoveryCheckpoint(checkpointPath, currentFingerprint);
    assert.equal(current.state, 'VALID');
    assert.equal(current.checkpoint.entries[project.projectKey].status, 'VERIFIED');
    assert.equal(statSync(checkpointPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN refresh stops before provider work when a fingerprint backup cannot be written', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-backup-failure-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const blockingBackupPath = join(directory, 'backups');
  const project = fixTokenProject();
  let providerConstructed = false;
  const application = {
    get() { return {}; },
    async close() {},
  };
  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      checkpointAssistantSourceDiscoveryResult(
        createEmptyCheckpoint({
          ...checkpointFingerprint(),
          validatorVersion: 'assistant-source-discovery-validator-v1',
        }),
        fixTokenCheckpointResult(project),
      ),
    );
    const originalCheckpoint = readFileSync(checkpointPath, 'utf8');
    writeFileSync(blockingBackupPath, 'backup-directory-blocker', { mode: 0o600 });

    await assert.rejects(
      runAssistantSourceDiscovery({
        argv: ['--live', '--refresh'],
        environment: {
          OPENAI_API_KEY: 'bounded-local-stub',
          ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
          ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
          ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
        },
        silent: true,
        dependencies: {
          async createApplicationContext() { return application; },
          createDiscovery() {
            providerConstructed = true;
            throw new Error('provider must not be constructed');
          },
        },
      }),
      (error) => error?.code === 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_BACKUP_FAILED',
    );

    assert.equal(providerConstructed, false);
    assert.equal(readFileSync(checkpointPath, 'utf8'), originalCheckpoint);
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
  assert.equal(report.stopReason, 'ASSISTANT_SOURCE_DISCOVERY_DRY_RUN_COST_CAP_MAY_STOP');
  assert.equal(report.pricingCatalogVersion, ASSISTANT_AI_PRICING_CATALOG_VERSION);
  assert.equal(report.selection.requestedProjects, 1);
  assert.equal(report.selection.requestedCostCapUsd, '0.10000000');
  assert.notEqual(report.selection.maximumEstimatedUsd, report.selection.requestedCostCapUsd);
  assert.equal(report.selection.costCapMayStopBeforeCompletion, true);
  assert.deepEqual(report.selection.selectedProjectKeys, ['dry-run-project']);
  assert.deepEqual(report.selection.checkpointProjectKeys, []);
  assert.equal(report.summary.providerRequests, 0);
  assert.equal(report.summary.reservedUsd, '0.00000000');
  assert.equal(report.summary.estimatedUsd, '0.00000000');
  assert.equal(report.summary.chargedUsd, '0.00000000');
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
    const oneProjectSufficientCap = await runDryRunEstimate({
      projects,
      limit: 1,
      requestedCostCapUsd: '100.00000000',
      checkpointPath: join(directory, 'one-sufficient.json'),
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
    assert.equal(oneProjectLowCap.selection.costCapMayStopBeforeCompletion, true);
    assert.equal(oneProjectHighCap.selection.costCapMayStopBeforeCompletion, true);
    assert.equal(oneProjectSufficientCap.selection.costCapMayStopBeforeCompletion, false);
    assert.equal(
      oneProjectSufficientCap.stopReason,
      'ASSISTANT_SOURCE_DISCOVERY_DRY_RUN_COMPLETE',
    );
    assert.match(oneProjectLowCap.selection.maximumEstimatedUsd, /^\d+\.\d{8}$/u);
    assert.equal(
      oneProjectLowCap.selection.maximumEstimatedUsd,
      oneProjectHighCap.selection.maximumEstimatedUsd,
    );
    assert.equal(
      oneProjectLowCap.selection.maximumEstimatedUsd,
      oneProjectSufficientCap.selection.maximumEstimatedUsd,
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
    assistantAiUsageAttempt: emptyAssistantUsageLedger(),
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
    ASSISTANT_AI_MODE: 'openai',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
    ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
  };
  const dependencies = {
    async createApplicationContext() { return application; },
    usageBudgets: {
      async reconcileExpiredReservations() { return 0; },
    },
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
    assert.deepEqual(repeated.selection.checkpointProjectKeys, ['checkpoint-project']);
    assert.equal(repeated.summary.reservedUsd, '0.00000000');
    assert.equal(repeated.summary.estimatedUsd, '0.00000000');
    assert.equal(repeated.summary.chargedUsd, '0.00000000');

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

test('FIX-TOKEN refresh error removes the stale selected entry instead of masking it as processed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-refresh-error-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = fixTokenProject();
  const fingerprint = checkpointFingerprint();
  const prisma = { assistantAiUsageAttempt: emptyAssistantUsageLedger() };
  const application = {
    get() { return prisma; },
    async close() {},
  };
  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      checkpointAssistantSourceDiscoveryResult(
        createEmptyCheckpoint(fingerprint),
        fixTokenCheckpointResult(project),
      ),
    );
    const report = await runAssistantSourceDiscovery({
      argv: ['--live', '--refresh'],
      environment: {
        OPENAI_API_KEY: 'bounded-local-stub',
        ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
        ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
        ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
      },
      silent: true,
      dependencies: {
        async createApplicationContext() { return application; },
        async selectProjects() { return [project]; },
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
        createDiscovery() {
          return {
            async discover() { return fixTokenCheckpointResult(project, 'ERROR'); },
          };
        },
      },
    });

    assert.equal(report.summary.errors, 1);
    const refreshed = readAssistantSourceDiscoveryCheckpoint(checkpointPath, fingerprint);
    assert.equal(refreshed.state, 'VALID');
    assert.equal(refreshed.checkpoint.entries[project.projectKey], undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN checkpoint filtering never backfills beyond the selected candidate set', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-candidate-set-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const projects = ['checkpoint-hit', 'pending-selected', 'must-not-backfill'].map((projectKey) => ({
    ...fixTokenProject(),
    projectKey,
    title: projectKey,
  }));
  let selectionCalls = 0;
  const discoveryProjectKeys = [];
  const prisma = { assistantAiUsageAttempt: emptyAssistantUsageLedger() };
  const application = {
    get() { return prisma; },
    async close() {},
  };
  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      checkpointAssistantSourceDiscoveryResult(
        createEmptyCheckpoint(checkpointFingerprint()),
        fixTokenCheckpointResult(projects[0]),
      ),
    );
    const report = await runAssistantSourceDiscovery({
      argv: ['--live', '--limit', '2', '--max-cost-usd', '0.20000000'],
      environment: {
        OPENAI_API_KEY: 'bounded-local-stub',
        ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
        ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
        ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
      },
      silent: true,
      dependencies: {
        async createApplicationContext() { return application; },
        async selectProjects(_prisma, limit, missingOnly) {
          selectionCalls += 1;
          assert.equal(limit, 2);
          assert.equal(missingOnly, true);
          return projects.slice(0, limit);
        },
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
        createDiscovery() {
          return {
            async discover(project) {
              discoveryProjectKeys.push(project.projectKey);
              return fixTokenCheckpointResult(project);
            },
          };
        },
      },
    });

    assert.equal(selectionCalls, 1);
    assert.deepEqual(report.selection.selectedProjectKeys, ['checkpoint-hit', 'pending-selected']);
    assert.deepEqual(report.selection.checkpointProjectKeys, ['checkpoint-hit']);
    assert.equal(report.summary.checkpointEntriesSkipped, 1);
    assert.deepEqual(discoveryProjectKeys, ['pending-selected']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN live run fails closed and cleans temporary output when checkpoint write fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-live-write-failure-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = fixTokenProject();
  let discoveryCalls = 0;
  const application = {
    get() { return {}; },
    async close() {},
  };
  try {
    await assert.rejects(
      runAssistantSourceDiscovery({
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
          async selectProjects() { return [project]; },
          usageBudgets: {
            async reconcileExpiredReservations() { return 0; },
          },
          createDiscovery() {
            return {
              async discover() {
                discoveryCalls += 1;
                mkdirSync(checkpointPath);
                return fixTokenCheckpointResult(project);
              },
            };
          },
        },
      }),
      (error) => error?.code === 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_WRITE_FAILED',
    );

    assert.equal(discoveryCalls, 1);
    assert.deepEqual(readdirSync(directory), ['checkpoint.json']);
    assert.deepEqual(readdirSync(checkpointPath), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN active indexed project registry source takes priority over a checkpoint entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-registry-priority-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = {
    projectKey: 'registry-priority-project',
    title: 'Registry priority project',
    developerKey: 'registry-priority-developer',
    developerName: 'Registry priority developer',
  };
  const registryUrl = 'https://developer.example/registry-priority-project/';
  const checkpointResult = {
    status: 'NOT_FOUND',
    project,
    developerCanonicalUrl: null,
    officialDeveloperName: project.developerName,
    canonicalUrl: null,
    officialProjectName: null,
    matchKind: null,
    reason: 'stale checkpoint result',
    errorCode: null,
    citations: [],
    developerCitations: [],
    projectCitations: [],
    matchedProjectAlias: null,
    matchedPlatformProjectAlias: null,
    matchedOfficialProjectAlias: null,
    matchedDeveloperAlias: null,
    matchedAddress: false,
    contentChecksum: null,
    developerCacheHit: false,
    telemetry: null,
  };
  let providerCalls = 0;
  let connectorCalls = 0;
  const prisma = {
    assistantAiUsageAttempt: emptyAssistantUsageLedger(),
    assistantKnowledgeSource: {
      async findMany(query) {
        assert.equal(query.select.revisions.where.processingStatus, 'INDEXED');
        return [{
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          state: 'ACTIVE',
          type: 'DEVELOPMENT_PAGE',
          canonicalUrl: registryUrl,
          projectKey: project.projectKey,
          developerKey: project.developerKey,
          connectorKey: 'OFFICIAL_HTML',
          connectorConfigJson: {
            allowedHosts: ['developer.example', 'www.developer.example'],
          },
          revisions: [{ processingStatus: 'INDEXED', checksum: 'e'.repeat(64) }],
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
    ASSISTANT_AI_MODE: 'openai',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
    ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
  };

  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      checkpointAssistantSourceDiscoveryResult(
        createEmptyCheckpoint(checkpointFingerprint()),
        checkpointResult,
      ),
    );
    const report = await runAssistantSourceDiscovery({
      argv: ['--live'],
      environment,
      silent: true,
      dependencies: {
        async createApplicationContext() { return application; },
        async selectProjects() { return [project]; },
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
        createDiscovery(serviceOptions) {
          return new AssistantSourceDiscoveryService(
            {
              ...environment,
              ASSISTANT_SOURCE_DISCOVERY_LIVE: 'true',
            },
            async () => {
              providerCalls += 1;
              throw new Error('provider must not be called for a registry hit');
            },
            {
              async fetch() {
                connectorCalls += 1;
                throw new Error('connector must not be called for a project registry hit');
              },
            },
            serviceOptions,
          );
        },
      },
    });

    assert.equal(report.summary.verified, 1);
    assert.equal(report.summary.checkpointEntriesSkipped, 0);
    const updatedCheckpoint = readAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      checkpointFingerprint(),
    );
    assert.equal(updatedCheckpoint.checkpoint.entries[project.projectKey].canonicalUrl, registryUrl);
    assert.equal(providerCalls, 0);
    assert.equal(connectorCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN checkpoint identity includes the current developer key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-checkpoint-developer-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = {
    projectKey: 'shared-project-key',
    title: 'Shared project',
    developerKey: 'new-developer',
    developerName: 'New developer',
  };
  const oldProject = {
    ...project,
    developerKey: 'old-developer',
    developerName: 'Old developer',
  };
  const oldResult = {
    status: 'NOT_FOUND',
    project: oldProject,
    developerCanonicalUrl: null,
    officialDeveloperName: oldProject.developerName,
    canonicalUrl: null,
    officialProjectName: null,
    matchKind: null,
    reason: 'old developer result',
    errorCode: null,
    citations: [],
    developerCitations: [],
    projectCitations: [],
    matchedProjectAlias: null,
    matchedPlatformProjectAlias: null,
    matchedOfficialProjectAlias: null,
    matchedDeveloperAlias: null,
    matchedAddress: false,
    contentChecksum: null,
    developerCacheHit: false,
    telemetry: null,
  };
  let discoveryCalls = 0;
  const prisma = { assistantAiUsageAttempt: emptyAssistantUsageLedger() };
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

  try {
    writeAssistantSourceDiscoveryCheckpoint(
      checkpointPath,
      checkpointAssistantSourceDiscoveryResult(
        createEmptyCheckpoint(checkpointFingerprint()),
        oldResult,
      ),
    );
    const report = await runAssistantSourceDiscovery({
      argv: ['--live'],
      environment,
      silent: true,
      dependencies: {
        async createApplicationContext() { return application; },
        async selectProjects() { return [project]; },
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
        createDiscovery() {
          return {
            async discover(candidate) {
              discoveryCalls += 1;
              return { ...oldResult, status: 'NOT_FOUND', project: candidate };
            },
          };
        },
      },
    });

    assert.equal(discoveryCalls, 1);
    assert.equal(report.summary.checkpointEntriesSkipped, 0);
    assert.equal(report.summary.notFound, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('FIX-TOKEN CLI keeps one logical operation while isolating each execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-execution-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = {
    projectKey: 'execution-project',
    title: 'Execution project',
    developerKey: 'execution-developer',
    developerName: 'Execution developer',
  };
  const reconciledRunIds = [];
  const providerRunIds = [];
  const executionIds = [];
  const prisma = {
    assistantAiUsageAttempt: emptyAssistantUsageLedger(),
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
  const dependencies = {
    async createApplicationContext() { return application; },
    usageBudgets: {
      async reconcileExpiredReservations({ operationRunId }) {
        reconciledRunIds.push(operationRunId);
        return 0;
      },
    },
    createDiscovery(options) {
      assert.ok(
        reconciledRunIds.includes(options.operationRunId),
        'reservation reconciliation must finish before provider construction',
      );
      providerRunIds.push(options.operationRunId);
      executionIds.push(options.executionId);
      return {
        async discover(candidate) {
          return {
            status: 'VERIFIED',
            project: candidate,
            developerCanonicalUrl: 'https://developer.example/',
            officialDeveloperName: project.developerName,
            canonicalUrl: 'https://developer.example/execution-project',
            officialProjectName: project.title,
            matchKind: 'EXACT',
            reason: 'bounded local stub',
            errorCode: null,
            citations: [],
            developerCitations: [],
            projectCitations: [],
            matchedProjectAlias: 'execution project',
            matchedPlatformProjectAlias: 'execution project',
            matchedOfficialProjectAlias: 'execution project',
            matchedDeveloperAlias: 'execution developer',
            matchedAddress: false,
            contentChecksum: 'c'.repeat(64),
            developerCacheHit: false,
            telemetry: null,
          };
        },
      };
    },
  };
  const environment = {
    OPENAI_API_KEY: 'bounded-local-stub',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50000000',
    ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH: checkpointPath,
  };

  try {
    await runAssistantSourceDiscovery({
      argv: ['--live', '--refresh'],
      environment,
      silent: true,
      dependencies,
    });
    await runAssistantSourceDiscovery({
      argv: ['--live', '--refresh'],
      environment,
      silent: true,
      dependencies,
    });

    assert.equal(reconciledRunIds.length, 2);
    assert.deepEqual(providerRunIds, reconciledRunIds);
    assert.equal(reconciledRunIds[0], reconciledRunIds[1]);
    assert.equal(executionIds.length, 2);
    assert.notEqual(executionIds[0], executionIds[1]);
    executionIds.forEach((executionId) => assert.match(
      executionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ));
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

  assert.equal(report.runId, runId);
  assert.equal(report.mode, 'LIVE_PREVIEW');
  assert.equal(report.stopReason, 'ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED');
  assert.equal(report.pricingCatalogVersion, ASSISTANT_AI_PRICING_CATALOG_VERSION);
  assert.deepEqual(report.pricingCatalogVersions, [ASSISTANT_AI_PRICING_CATALOG_VERSION]);
  assert.deepEqual(report.selection.selectedProjectKeys, [fixTokenProject().projectKey]);
  assert.deepEqual(report.selection.checkpointProjectKeys, []);
  assert.equal(report.summary.providerRequests, 2);
  assert.equal(report.summary.lunaCalls, 2);
  assert.equal(report.summary.terraCalls, 0);
  assert.equal(report.summary.fallbackCalls, 0);
  assert.deepEqual(report.summary.tokenUsage, {
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    webSearchCalls: null,
  });
  assert.deepEqual(report.summary.knownTokenUsage, {
    inputTokens: 20,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 13,
    reasoningTokens: 5,
    totalTokens: 33,
    webSearchCalls: 1,
  });
  assert.equal(report.summary.usageUnknownAttempts, 1);
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
    attempts: [{
      ...persistedUsageAttempt({
        id: '33333333-3333-4333-8333-333333333333',
        runId,
        attemptOrdinal: 1,
        outcome: 'PROVIDER_ERROR',
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_TIMEOUT',
        reservedCostUsd: '0.01234567',
        estimatedCostUsd: null,
        chargedCostUsd: '0.01234567',
      }),
      prompt: 'must-not-enter-report',
      rawProviderResponse: 'raw-provider-secret',
      apiKey: 'sk-test-secret',
      canonicalUrl: 'https://user:password@example.test/path?token=secret#fragment',
    }],
    discoveryError: failedDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_TIMEOUT'),
  });

  assert.equal(report.pricingCatalogVersion, ASSISTANT_AI_PRICING_CATALOG_VERSION);
  assert.deepEqual(report.summary.tokenUsage, {
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    webSearchCalls: null,
  });
  assert.deepEqual(report.summary.knownTokenUsage, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    webSearchCalls: 0,
  });
  assert.equal(report.summary.usageUnknownAttempts, 1);
  assert.equal(report.summary.providerRequests, 1);
  assert.equal(report.summary.reservedUsd, '0.01234567');
  assert.equal(report.summary.estimatedUsd, null);
  assert.equal(report.summary.chargedUsd, '0.01234567');
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'must-not-enter-report',
    'raw-provider-secret',
    'sk-test-secret',
    'password',
    'token=secret',
    '#fragment',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('FIX-TOKEN live report preserves every pricing catalog version across recovery', async () => {
  const runId = 'fix-token-mixed-pricing-catalog-report';
  const nextPricingCatalogVersion = 'assistant-ai-pricing-test-v2';
  const report = await runPersistedDiscoveryReport({
    runId,
    attempts: [
      persistedUsageAttempt({
        id: '55555555-5555-4555-8555-555555555555',
        runId,
        attemptOrdinal: 1,
        outcome: 'ACCEPTED',
        inputTokens: 10n,
        cachedInputTokens: 0n,
        cacheWriteInputTokens: 0n,
        outputTokens: 5n,
        reasoningTokens: 2n,
        totalTokens: 15n,
        webSearchCalls: 1,
        reservedCostUsd: '0.01000000',
        estimatedCostUsd: '0.00001000',
        chargedCostUsd: '0.00001000',
      }),
      persistedUsageAttempt({
        id: '66666666-6666-4666-8666-666666666666',
        runId,
        attemptOrdinal: 2,
        outcome: 'NOT_FOUND',
        inputTokens: 12n,
        cachedInputTokens: 1n,
        cacheWriteInputTokens: 0n,
        outputTokens: 6n,
        reasoningTokens: 3n,
        totalTokens: 18n,
        webSearchCalls: 1,
        pricingCatalogVersion: nextPricingCatalogVersion,
        reservedCostUsd: '0.02000000',
        estimatedCostUsd: '0.00002000',
        chargedCostUsd: '0.00002000',
      }),
    ],
    discoveryError: failedDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_NOT_FOUND'),
  });

  assert.equal(report.pricingCatalogVersion, null);
  assert.deepEqual(report.pricingCatalogVersions, [
    ASSISTANT_AI_PRICING_CATALOG_VERSION,
    nextPricingCatalogVersion,
  ]);
  assert.equal(report.summary.providerRequests, 2);
  assert.equal(report.summary.chargedUsd, '0.00003000');
});

test('FIX-TOKEN live report counts Terra fallback and conservatively charges an unresolved reserve', async () => {
  const runId = 'fix-token-unresolved-terra-report';
  const report = await runPersistedDiscoveryReport({
    runId,
    attempts: [persistedUsageAttempt({
      id: '44444444-4444-4444-8444-444444444444',
      runId,
      attemptOrdinal: 1,
      requestedModel: 'gpt-5.6-terra',
      isFallback: true,
      status: 'RESERVED',
      outcome: null,
      reservedCostUsd: '0.04567890',
      estimatedCostUsd: null,
      chargedCostUsd: null,
    })],
    discoveryError: failedDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_USAGE_SETTLEMENT_FAILED'),
  });

  assert.equal(report.summary.providerRequests, 1);
  assert.equal(report.summary.lunaCalls, 0);
  assert.equal(report.summary.terraCalls, 1);
  assert.equal(report.summary.fallbackCalls, 1);
  assert.equal(report.summary.reservedUsd, '0.04567890');
  assert.equal(report.summary.estimatedUsd, null);
  assert.equal(report.summary.chargedUsd, '0.04567890');
});

test('FIX-TOKEN live report fails closed when the persisted usage ledger cannot be read', async () => {
  await assert.rejects(
    runPersistedDiscoveryReport({
      runId: 'fix-token-ledger-read-failure',
      attempts: [],
      discoveryError: failedDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_TIMEOUT'),
      ledgerError: new Error('database query contained sensitive diagnostics'),
    }),
    (error) => error?.message === 'ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_READ_FAILED',
  );
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

test('FIX-TOKEN discovery orchestration passes the persisted registry seed before provider work', async () => {
  const project = fixTokenProject();
  const registrySource = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    state: 'ACTIVE',
    type: 'DEVELOPER_PROMOTION',
    canonicalUrl: 'https://catalog.developer.example/',
    projectKey: null,
    developerKey: project.developerKey,
    connectorKey: 'OFFICIAL_HTML',
    connectorConfig: {
      allowedHosts: ['catalog.developer.example', 'www.catalog.developer.example'],
    },
    latestRevision: {
      processingStatus: 'INDEXED',
      checksum: 'd'.repeat(64),
    },
  };
  let receivedSeed = null;
  const results = await discoverProjects({
    async discover(candidate, seed) {
      receivedSeed = seed;
      return { status: 'VERIFIED', project: candidate, telemetry: { phases: [] } };
    },
  }, [project], 1, {}, {
    registrySources: [registrySource],
    includeProjectSources: true,
  });

  assert.equal(results[0].status, 'VERIFIED');
  assert.deepEqual(receivedSeed, { registrySources: [registrySource] });
});

test('FIX-TOKEN missing-only selection reuses only active indexed project sources', async () => {
  const selected = await selectPilotProjects({
    assistantKnowledgeSource: {
      async findMany(query) {
        assert.equal(query.select.revisions.where.processingStatus, 'INDEXED');
        return [
          {
            id: '11111111-1111-4111-8111-111111111111',
            projectKey: 'already-indexed',
            developerKey: 'developer',
            type: 'DEVELOPMENT_PAGE',
            state: 'ACTIVE',
            canonicalUrl: 'https://developer.example/projects/already-indexed/',
            connectorKey: 'OFFICIAL_HTML',
            connectorConfigJson: {
              allowedHosts: ['developer.example', 'www.developer.example'],
            },
            revisions: [{ processingStatus: 'INDEXED', checksum: '1'.repeat(64) }],
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            projectKey: 'needs-refresh',
            developerKey: 'developer',
            type: 'DEVELOPMENT_PAGE',
            state: 'DISABLED',
            canonicalUrl: 'https://developer.example/projects/needs-refresh/',
            connectorKey: 'OFFICIAL_HTML',
            connectorConfigJson: {
              allowedHosts: ['developer.example', 'www.developer.example'],
            },
            revisions: [{ processingStatus: 'INDEXED', checksum: '2'.repeat(64) }],
          },
        ];
      },
    },
    realEstateObject: {
      async findMany() {
        return [
          {
            title: 'Already indexed',
            slug: 'already-indexed',
            address: null,
            feedUnitsCount: 20,
            developer: { name: 'Developer', normalizedName: 'developer', slug: 'developer' },
          },
          {
            title: 'Needs refresh',
            slug: 'needs-refresh',
            address: null,
            feedUnitsCount: 10,
            developer: { name: 'Developer', normalizedName: 'developer', slug: 'developer' },
          },
        ];
      },
    },
  }, 1, true, new Set());

  assert.deepEqual(selected.map(({ projectKey }) => projectKey), ['needs-refresh']);
});

test('FIX-TOKEN pilot capacity uses the selected project-key union', async () => {
  const registered = Array.from({ length: 20 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    projectKey: index === 0 ? 'needs-refresh' : `registered-${index}`,
    developerKey: 'developer',
    type: 'DEVELOPMENT_PAGE',
    state: index === 0 ? 'DISABLED' : 'ACTIVE',
    canonicalUrl: `https://developer.example/projects/${index}/`,
    connectorKey: 'OFFICIAL_HTML',
    connectorConfigJson: {
      allowedHosts: ['developer.example', 'www.developer.example'],
    },
    revisions: [{ processingStatus: 'INDEXED', checksum: 'f'.repeat(64) }],
  }));
  const selected = await selectPilotProjects({
    assistantKnowledgeSource: {
      async findMany() { return registered; },
    },
    realEstateObject: {
      async findMany() {
        return [{
          title: 'Needs refresh',
          slug: 'needs-refresh',
          address: null,
          feedUnitsCount: 10,
          developer: { name: 'Developer', normalizedName: 'developer', slug: 'developer' },
        }];
      },
    },
  }, 1, true, new Set());

  assert.deepEqual(selected.map(({ projectKey }) => projectKey), ['needs-refresh']);
});

test('FIX-TOKEN discovery never uses Terra after parse, transport, HTTP or source-fetch failure', async (context) => {
  const scenarios = [
    {
      name: 'malformed structured output',
      failureKind: 'MALFORMED',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_OUTPUT_INVALID',
    },
    {
      name: 'missing structured output',
      failureKind: 'MISSING',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_OUTPUT_MISSING',
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
      name: 'provider HTTP 401 authorization failure',
      failureKind: 'HTTP_401',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_HTTP_401',
    },
    {
      name: 'provider HTTP 5xx',
      failureKind: 'HTTP_503',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_HTTP_503',
      permitsLunaRetry: true,
    },
    {
      name: 'provider HTTP 5xx with malformed error body',
      failureKind: 'HTTP_503_MALFORMED',
      errorCode: 'ASSISTANT_SOURCE_DISCOVERY_HTTP_503',
      permitsLunaRetry: true,
    },
    {
      name: 'official source fetch failure',
      failureKind: 'SOURCE_FETCH',
      sourceErrorCode: 'SOURCE_FETCH_TIMEOUT',
      errorCode: 'SOURCE_FETCH_TIMEOUT',
    },
    {
      name: 'official source network failure',
      failureKind: 'SOURCE_NETWORK',
      sourceErrorCode: 'SOURCE_NETWORK_FAILED',
      errorCode: 'SOURCE_NETWORK_FAILED',
    },
    {
      name: 'official source retryable HTTP failure',
      failureKind: 'SOURCE_HTTP_RETRYABLE',
      sourceErrorCode: 'SOURCE_HTTP_RETRYABLE',
      errorCode: 'SOURCE_HTTP_RETRYABLE',
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const providerBodies = [];
      let failedSourceFetches = 0;
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
          if (scenario.failureKind === 'MISSING') {
            return missingSourceDiscoveryResponse('matrix-missing');
          }
          if (scenario.failureKind === 'TIMEOUT') {
            throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_TIMEOUT');
          }
          if (scenario.failureKind === 'NETWORK') {
            throw new Error('simulated provider network failure');
          }
          if (scenario.failureKind === 'HTTP_401'
            || scenario.failureKind === 'HTTP_429'
            || scenario.failureKind === 'HTTP_503'
            || scenario.failureKind === 'HTTP_503_MALFORMED') {
            const status = scenario.failureKind === 'HTTP_401'
              ? 401
              : scenario.failureKind === 'HTTP_429'
                ? 429
                : 503;
            const body = scenario.failureKind === 'HTTP_503_MALFORMED'
              ? '{not-json'
              : JSON.stringify({ id: `matrix-http-${status}`, error: { status } });
            return new Response(body, {
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
            if (scenario.sourceErrorCode && source.canonicalUrl === candidateUrl) {
              failedSourceFetches += 1;
              throw new SourceConnectorError(scenario.sourceErrorCode, true, 504);
            }
            throw new SourceConnectorError('SOURCE_HTTP_NON_RETRYABLE', false, 404);
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
      assert.equal(requestedModels.length, scenario.permitsLunaRetry ? 3 : 2);
      assert.equal(failedSourceFetches, scenario.sourceErrorCode ? 2 : 0);
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
    promptVersion: 'assistant-source-discovery-v2',
    validatorVersion: 'assistant-source-discovery-validator-v2',
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

async function assertCheckpointFailureStopsProvider(
  checkpointPath,
  expectedCode,
  argv = ['--live'],
) {
  let providerConstructed = false;
  let runError = null;
  const application = {
    get() { return {}; },
    async close() {},
  };
  try {
    await runAssistantSourceDiscovery({
      argv,
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
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
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

async function runPersistedDiscoveryReport({
  runId,
  attempts,
  discoveryError,
  ledgerError = null,
  executionId = randomUUID(),
}) {
  const directory = mkdtempSync(join(tmpdir(), 'platforma-discovery-persisted-report-'));
  const checkpointPath = join(directory, 'checkpoint.json');
  const project = fixTokenProject();
  const prisma = {
    assistantAiUsageAttempt: {
      async findMany(query) {
        assert.equal(query.where.operationRunId, runId);
        assert.equal(query.where.executionId, executionId);
        assert.ok(query.select);
        if (ledgerError) throw ledgerError;
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
        executionId,
        async createApplicationContext() { return application; },
        async selectProjects() { return [project]; },
        usageBudgets: {
          async reconcileExpiredReservations() { return 0; },
        },
        createDiscovery(options) {
          assert.equal(options.operationRunId, runId);
          assert.equal(options.executionId, executionId);
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

function emptyAssistantUsageLedger() {
  return {
    async findMany(query) {
      assert.equal(query.where.operation, 'SOURCE_DISCOVERY');
      assert.equal(typeof query.where.operationRunId, 'string');
      assert.equal(typeof query.where.executionId, 'string');
      assert.ok(query.select);
      return [];
    },
  };
}

function persistedUsageAttempt({
  id,
  runId,
  attemptOrdinal,
  requestedModel = 'gpt-5.6-luna',
  isFallback = false,
  status = 'SETTLED',
  outcome,
  errorCode = null,
  inputTokens = null,
  cachedInputTokens = null,
  cacheWriteInputTokens = null,
  outputTokens = null,
  reasoningTokens = null,
  totalTokens = null,
  webSearchCalls = null,
  pricingCatalogVersion = ASSISTANT_AI_PRICING_CATALOG_VERSION,
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
    requestedModel,
    actualModel: status === 'SETTLED' ? requestedModel : null,
    reasoningEffort: 'medium',
    promptVersion: 'assistant-source-discovery-v1',
    validatorVersion: 'assistant-source-discovery-validator-v1',
    isFallback,
    status,
    outcome,
    errorCode,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    webSearchCalls,
    pricingCatalogVersion,
    pricingStatus: estimatedCostUsd === null ? 'USAGE_INCOMPLETE' : 'PRICED',
    reservedCostUsd: new Prisma.Decimal(reservedCostUsd),
    estimatedCostUsd: estimatedCostUsd === null ? null : new Prisma.Decimal(estimatedCostUsd),
    chargedCostUsd: chargedCostUsd === null ? null : new Prisma.Decimal(chargedCostUsd),
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

function missingSourceDiscoveryResponse(responseId) {
  return new Response(JSON.stringify({
    id: responseId,
    output: [],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 20,
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

function fixTokenCheckpointResult(project, status = 'VERIFIED') {
  return {
    status,
    project,
    developerCanonicalUrl: status === 'VERIFIED' ? 'https://developer.example/' : null,
    officialDeveloperName: project.developerName,
    canonicalUrl: status === 'VERIFIED'
      ? `https://developer.example/${project.projectKey}`
      : null,
    officialProjectName: status === 'VERIFIED' ? project.title : null,
    matchKind: status === 'VERIFIED' ? 'EXACT' : null,
    reason: 'test-only narrative',
    errorCode: status === 'REJECTED' ? 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_MISMATCH' : null,
    citations: [],
    developerCitations: [],
    projectCitations: [],
    matchedProjectAlias: null,
    matchedPlatformProjectAlias: null,
    matchedOfficialProjectAlias: null,
    matchedDeveloperAlias: null,
    matchedAddress: false,
    contentChecksum: status === 'VERIFIED' ? 'a'.repeat(64) : null,
    developerCacheHit: false,
    telemetry: { phases: [] },
  };
}

function settlementFixture() {
  const operationRunId = randomUUID();
  const executionId = randomUUID();
  const usageDate = new Date('2026-08-27T00:00:00.000Z');
  return {
    reservation: {
      id: randomUUID(),
      operationRunId,
      executionId,
      attemptOrdinal: 1,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      serviceTier: 'default',
      usageDate,
      reservationExpiresAt: new Date('2026-08-27T00:03:00.000Z'),
      reservedCostUsd: '0.10000000',
    },
    actualModel: 'gpt-5.6-luna',
    outcome: 'ACCEPTED',
    errorCode: null,
    inputTokens: 100,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 10,
    outputTokens: 10,
    reasoningTokens: 5,
    totalTokens: 110,
    webSearchCalls: 0,
    durationMs: 25,
  };
}
