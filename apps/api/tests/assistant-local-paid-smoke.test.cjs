const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const {
  runAssistantLocalPaidSmoke,
} = require('../scripts/assistant-local-paid-smoke.cjs');

test('PIDAFIX1 local paid smoke defaults to dry-run with zero API and ledger calls', async () => {
  let apiCalls = 0;
  let ledgerCalls = 0;

  const report = await runAssistantLocalPaidSmoke({
    argv: [],
    environment: {},
    runtime: { isContainer: false },
    api: {
      async request() {
        apiCalls += 1;
        throw new Error('API_MUST_NOT_BE_CALLED');
      },
    },
    ledger: {
      async inspectReadiness() {
        ledgerCalls += 1;
        throw new Error('LEDGER_MUST_NOT_BE_CALLED');
      },
    },
  });

  assert.deepEqual(report, {
    smoke: 'assistant-local-paid-smoke-v1',
    mode: 'DRY_RUN',
    passed: true,
    limits: {
      userRequests: 2,
      modelAttempts: 4,
      maximumCostUsd: '0.50000000',
    },
    providerCalls: 0,
  });
  assert.equal(apiCalls, 0);
  assert.equal(ledgerCalls, 0);
});

test('PIDAFIX1 local paid smoke rejects missing or excessive hard caps before boundaries', async () => {
  const blockedArguments = [
    ['--live'],
    ['--live', '--limit', '3', '--max-attempts', '4', '--max-cost-usd', '0.50'],
    ['--live', '--limit', '2', '--max-attempts', '5', '--max-cost-usd', '0.50'],
    ['--live', '--limit', '2', '--max-attempts', '4', '--max-cost-usd', '0.51'],
  ];
  let boundaryCalls = 0;

  for (const argv of blockedArguments) {
    await assert.rejects(
      runAssistantLocalPaidSmoke({
        argv,
        environment: {},
        runtime: { isContainer: false },
        api: { async request() { boundaryCalls += 1; } },
        ledger: { async inspectReadiness() { boundaryCalls += 1; } },
      }),
      /ASSISTANT_LOCAL_PAID_SMOKE_(?:LIMITS_REQUIRED|LIMIT_EXCEEDED)/u,
    );
  }

  assert.equal(boundaryCalls, 0);
});

test('PIDAFIX1 local paid smoke rejects a mistyped live flag instead of silently dry-running', async () => {
  await assert.rejects(
    runAssistantLocalPaidSmoke({ argv: ['--lve'] }),
    /ASSISTANT_LOCAL_PAID_SMOKE_ARGUMENT_INVALID/u,
  );
});

test('PIDAFIX1 local paid smoke rejects incomplete API runtime readiness before DB or HTTP', async () => {
  let boundaryCalls = 0;
  await assert.rejects(
    runAssistantLocalPaidSmoke({
      argv: ['--live', '--limit', '2', '--max-attempts', '4', '--max-cost-usd', '0.50'],
      environment: { ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN: 'not-a-real-token' },
      runtime: {
        isContainer: true,
        isApiProcess: true,
        apiEnvironment: { ASSISTANT_AI_MODE: 'openai' },
      },
      api: { async request() { boundaryCalls += 1; } },
      ledger: { async inspectReadiness() { boundaryCalls += 1; } },
    }),
    /ASSISTANT_LOCAL_PAID_SMOKE_READINESS_FAILED/u,
  );
  assert.equal(boundaryCalls, 0);
});

test('PIDAFIX1 local paid smoke blocks backlog and unfinished ledger before HTTP', async () => {
  let apiCalls = 0;
  let ledgerCalls = 0;
  await assert.rejects(
    runAssistantLocalPaidSmoke({
      argv: ['--live', '--limit', '2', '--max-attempts', '4', '--max-cost-usd', '0.50'],
      environment: { ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN: 'not-a-real-token' },
      runtime: {
        isContainer: true,
        isApiProcess: true,
        apiEnvironment: readyApiEnvironment(),
      },
      api: { async request() { apiCalls += 1; } },
      ledger: {
        async inspectReadiness() {
          ledgerCalls += 1;
          return { pendingOrRunningRuns: 1, reservedAttempts: 1 };
        },
      },
    }),
    /ASSISTANT_LOCAL_PAID_SMOKE_BACKLOG_NOT_EMPTY/u,
  );
  assert.equal(apiCalls, 0);
  assert.equal(ledgerCalls, 1);
});

test('PIDAFIX1 local paid smoke runs two requests sequentially and reports persisted ledger cost', async () => {
  const events = [];
  const attempts = new Map([
    ['10000000-0000-4000-8000-000000000001', [paidAttempt({
      operationRunId: '10000000-0000-4000-8000-000000000001',
      executionId: '20000000-0000-4000-8000-000000000001',
      chargedCostUsd: '0.01000000',
    })]],
    ['10000000-0000-4000-8000-000000000002', [paidAttempt({
      operationRunId: '10000000-0000-4000-8000-000000000002',
      executionId: '20000000-0000-4000-8000-000000000002',
      chargedCostUsd: '0.02000000',
    })]],
  ]);
  let nextConversation = 0;
  let nextRun = 0;
  const lostRuns = new Map();
  const runKeys = [];
  let delayedCommitVisible = false;

  const report = await runAssistantLocalPaidSmoke({
    argv: ['--live', '--limit', '2', '--max-attempts', '4', '--max-cost-usd', '0.50'],
    environment: { ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN: 'temporary-access-token' },
    runtime: {
      isContainer: true,
      isApiProcess: true,
      apiEnvironment: readyApiEnvironment(),
    },
    now: () => new Date('2026-08-28T12:00:00.000Z'),
    sleep: async () => {},
    api: {
      async checkConfig() {
        events.push('api:config');
        return { enabled: true };
      },
      async createConversation({ caseId }) {
        nextConversation += 1;
        events.push(`api:create:${caseId}`);
        return { conversationId: `30000000-0000-4000-8000-${String(nextConversation).padStart(12, '0')}` };
      },
      async startRun({ caseId, idempotencyKey }) {
        runKeys.push(idempotencyKey);
        events.push(`api:start:${caseId}`);
        if (caseId === 'structured_search' && runKeys.length === 2) {
          delayedCommitVisible = true;
          throw new Error('simulated repeated lost response');
        }
        nextRun += 1;
        const started = {
          runId: `10000000-0000-4000-8000-${String(nextRun).padStart(12, '0')}`,
          status: 'PENDING',
        };
        if (caseId === 'structured_search') {
          lostRuns.set(idempotencyKey, started);
          throw new Error('simulated lost 202 response');
        }
        return started;
      },
      async getRun({ runId }) {
        events.push(`api:poll:${runId.slice(-1)}`);
        return { runId, status: 'COMPLETED', errorCode: null };
      },
    },
    ledger: {
      async inspectReadiness() {
        events.push('ledger:ready');
        return { pendingOrRunningRuns: 0, reservedAttempts: 0 };
      },
      async loadAttempts(runIds) {
        events.push(`ledger:load:${runIds.map((id) => id.slice(-1)).join('')}`);
        return runIds.flatMap((runId) => attempts.get(runId) ?? []);
      },
      async recoverRun(idempotencyKey) {
        events.push('ledger:recover-run');
        return delayedCommitVisible ? lostRuns.get(idempotencyKey) ?? null : null;
      },
      async cleanupConversations(conversationIds) {
        events.push(`ledger:cleanup:${conversationIds.length}`);
      },
      async disconnect() {
        events.push('ledger:disconnect');
      },
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.mode, 'LIVE');
  assert.equal(report.results.length, 2);
  assert.deepEqual(report.ledger, {
    attempts: 2,
    effectiveCostUsd: '0.03000000',
    webSearchCalls: 0,
    reservedAttempts: 0,
    unknownWebSearchAttempts: 0,
  });
  assert.equal(events.indexOf('ledger:load:1') < events.indexOf('api:create:mortgage_installment'), true);
  assert.equal(events.includes('ledger:recover-run'), true);
  assert.equal(runKeys[0], runKeys[1]);
  assert.deepEqual(events.slice(-2), ['ledger:cleanup:2', 'ledger:disconnect']);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('temporary-access-token'), false);
  assert.equal(serialized.includes('ипотек'), false);
});

test('PIDAFIX1 local paid smoke reports a red RESERVED attempt at full persisted reserve', async () => {
  let createCalls = 0;
  const runId = '10000000-0000-4000-8000-000000000001';
  const report = await runAssistantLocalPaidSmoke({
    argv: ['--live', '--limit', '2', '--max-attempts', '4', '--max-cost-usd', '0.50'],
    environment: { ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN: 'temporary-access-token' },
    runtime: {
      isContainer: true,
      isApiProcess: true,
      apiEnvironment: readyApiEnvironment(),
    },
    sleep: async () => {},
    api: {
      async checkConfig() { return { enabled: true }; },
      async createConversation() {
        createCalls += 1;
        return { conversationId: '30000000-0000-4000-8000-000000000001' };
      },
      async startRun() { return { runId, status: 'PENDING' }; },
      async getRun() {
        return { runId, status: 'FAILED', errorCode: 'ASSISTANT_PROVIDER_TIMEOUT' };
      },
    },
    ledger: {
      async inspectReadiness() {
        return { pendingOrRunningRuns: 0, reservedAttempts: 0 };
      },
      async loadAttempts(runIds) {
        assert.deepEqual(runIds, [runId]);
        return [paidAttempt({
          operationRunId: runId,
          status: 'RESERVED',
          reservedCostUsd: '0.20000000',
          chargedCostUsd: null,
          webSearchCalls: null,
        })];
      },
      async cleanupConversations() {},
      async disconnect() {},
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'ASSISTANT_PROVIDER_TIMEOUT');
  assert.equal(report.providerCalls, 1);
  assert.deepEqual(report.ledger, {
    attempts: 1,
    effectiveCostUsd: '0.20000000',
    webSearchCalls: 0,
    reservedAttempts: 1,
    unknownWebSearchAttempts: 1,
  });
  assert.equal(createCalls, 1);
});

test('PIDAFIX1 local paid smoke does not report final provider calls for a non-terminal run', async () => {
  const runId = '10000000-0000-4000-8000-000000000001';
  const report = await runAssistantLocalPaidSmoke({
    argv: ['--live', '--limit', '2', '--max-attempts', '4', '--max-cost-usd', '0.50'],
    environment: { ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN: 'temporary-access-token' },
    runtime: {
      isContainer: true,
      isApiProcess: true,
      apiEnvironment: readyApiEnvironment(),
    },
    sleep: async () => {},
    api: {
      async checkConfig() { return { enabled: true }; },
      async createConversation() {
        return { conversationId: '30000000-0000-4000-8000-000000000001' };
      },
      async startRun() { return { runId, status: 'PENDING' }; },
      async getRun() { return { runId, status: 'RUNNING', errorCode: null }; },
    },
    ledger: {
      async inspectReadiness() {
        return { pendingOrRunningRuns: 0, reservedAttempts: 0 };
      },
      async loadAttempts(runIds) {
        assert.deepEqual(runIds, [runId]);
        return [paidAttempt({
          operationRunId: runId,
          status: 'RESERVED',
          reservedCostUsd: '0.20000000',
          chargedCostUsd: null,
          webSearchCalls: null,
        })];
      },
      async cleanupConversations() {},
      async disconnect() {},
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'ASSISTANT_LOCAL_PAID_SMOKE_RUN_TIMEOUT');
  assert.equal(report.nonTerminalRuns, 1);
  assert.equal(report.ledgerFinal, false);
  assert.equal(report.providerCalls, null);
  assert.equal(report.ledger.effectiveCostUsd, '0.20000000');
});

test('PIDAFIX1 local paid smoke bounds a stalled ledger before HTTP', async () => {
  let apiCalls = 0;
  await assert.rejects(runAssistantLocalPaidSmoke({
    argv: ['--live', '--limit', '2', '--max-attempts', '4', '--max-cost-usd', '0.50'],
    environment: { ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN: 'temporary-access-token' },
    runtime: {
      isContainer: true,
      isApiProcess: true,
      apiEnvironment: readyApiEnvironment(),
    },
    operationTimeoutMs: 10,
    api: {
      async checkConfig() {
        apiCalls += 1;
        return { enabled: true };
      },
    },
    ledger: {
      async inspectReadiness() { return new Promise(() => {}); },
      async disconnect() {},
    },
  }), /ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED/u);
  assert.equal(apiCalls, 0);
});

test('PIDAFIX1 Compose can disable every background worker and passes the token outside argv', () => {
  const compose = readFileSync(resolve(__dirname, '../../../docker-compose.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'));
  assert.match(compose,
    /TRAINING_MATERIAL_WORKER_ENABLED:\s*\$\{TRAINING_MATERIAL_WORKER_ENABLED:-true\}/u);
  assert.match(compose,
    /TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED:\s*\$\{TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED:-true\}/u);
  assert.match(compose,
    /TRAINING_VOICE_WORKER_ENABLED:\s*\$\{TRAINING_VOICE_WORKER_ENABLED:-true\}/u);
  assert.match(packageJson.scripts['smoke:assistant:local-paid'],
    /exec -T -e ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN api node/u);
  assert.equal(packageJson.scripts['smoke:assistant:local-paid'].includes('--live'), false);
});

function readyApiEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://local:local@postgres:5432/platforma_paid_smoke?schema=public',
    ASSISTANT_LOCAL_PAID_SMOKE_DISPOSABLE_DB: 'true',
    ASSISTANT_MODULE_ENABLED: 'true',
    ASSISTANT_AI_MODE: 'openai',
    ASSISTANT_QUERY_PLANNER_LIVE: 'true',
    ASSISTANT_MODEL_REQUESTS_PER_MINUTE: '2',
    ASSISTANT_MODEL_REQUESTS_PER_DAY: '2',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'not-a-real-provider-key',
    ASSISTANT_EMBEDDING_MODE: 'disabled',
    ASSISTANT_EMBEDDING_LIVE: 'false',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'false',
    ASSISTANT_GEO_PROVIDER_MODE: 'fake',
    ASSISTANT_OVERPASS_ENABLED: 'false',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false',
    ASSISTANT_SOURCE_WORKER_ENABLED: 'false',
    ASSISTANT_SOURCE_BROWSER_FALLBACK_ENABLED: 'false',
    FEED_AUTO_IMPORT_ENABLED: 'false',
    TRAINING_MODULE_ENABLED: 'false',
    TRAINING_VOICE_WORKER_ENABLED: 'false',
    TRAINING_MATERIAL_WORKER_ENABLED: 'false',
    TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED: 'false',
    TRAINING_AI_MODE: 'fake',
    TELEGRAM_TRANSPORT_MODE: 'fake',
    ...overrides,
  };
}

function paidAttempt(overrides = {}) {
  return {
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    attemptOrdinal: 1,
    operation: 'PLANNER',
    requestedModel: 'gpt-5.6-luna',
    status: 'SETTLED',
    reservedCostUsd: '0.05000000',
    chargedCostUsd: '0.01000000',
    webSearchCalls: 0,
    ...overrides,
  };
}
