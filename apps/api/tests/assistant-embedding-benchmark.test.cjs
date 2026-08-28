const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createBoundedDatabaseUrl,
  runAssistantEmbeddingBenchmark,
} = require('../scripts/assistant-embedding-benchmark.cjs');

const candidates = JSON.stringify([
  { model: 'text-embedding-3-small', dimensions: 256 },
  { model: 'text-embedding-3-large', dimensions: 512 },
]);

test('PIDAFIX1 embedding benchmark is a zero-boundary dry-run by default', async () => {
  let boundaries = 0;
  const report = await runAssistantEmbeddingBenchmark({
    argv: [],
    environment: { ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES: candidates },
    createGateway() {
      boundaries += 1;
      throw new Error('gateway must not be created');
    },
    ledger: {
      async loadAttempts() {
        boundaries += 1;
        throw new Error('ledger must not be read');
      },
    },
  });

  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.passed, true);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.plannedHttpAttempts, 4);
  assert.match(report.maximumEstimatedCostUsd, /^0\.\d{8}$/u);
  assert.equal(boundaries, 0);
});

test('PIDAFIX1 embedding benchmark requires bounded live caps before any boundary', async () => {
  let boundaries = 0;
  await assert.rejects(runAssistantEmbeddingBenchmark({
    argv: ['--live'],
    environment: { ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES: candidates },
    createGateway() { boundaries += 1; },
    ledger: { async loadAttempts() { boundaries += 1; } },
  }), /ASSISTANT_EMBEDDING_BENCHMARK_LIMITS_REQUIRED/u);
  assert.equal(boundaries, 0);
});

test('PIDAFIX1 embedding benchmark counts physical batches and reports persisted effective cost', async () => {
  const events = [];
  const operationRunId = '10000000-0000-4000-8000-000000000001';
  const executionId = '20000000-0000-4000-8000-000000000001';
  const report = await runAssistantEmbeddingBenchmark({
    argv: ['--live', '--max-http-attempts', '4', '--max-cost-usd', '0.50'],
    environment: readyEnvironment(),
    ids: { operationRunId, executionId },
    createGateway(candidate) {
      return {
        async embed(values, context) {
          const ordinal = context.nextAttemptOrdinal();
          events.push(`embed:${candidate.model}:${ordinal}:${values.length}`);
          return {
            model: candidate.model,
            vectors: values.map((_value, index) => vector(candidate.dimensions, index)),
          };
        },
      };
    },
    ledger: {
      async loadAttempts(runId, leaseId) {
        events.push('ledger:load');
        assert.equal(runId, operationRunId);
        assert.equal(leaseId, executionId);
        return [1, 2, 3, 4].map((attemptOrdinal) => ({
          operationRunId,
          executionId,
          attemptOrdinal,
          operation: 'EMBEDDING_BENCHMARK',
          status: 'SETTLED',
          reservedCostUsd: '0.01000000',
          chargedCostUsd: '0.00100000',
          inputTokens: 10,
        }));
      },
      async disconnect() { events.push('ledger:disconnect'); },
    },
  });

  assert.equal(report.mode, 'LIVE');
  assert.equal(report.passed, true);
  assert.equal(report.providerCalls, 4);
  assert.equal(report.ledger.effectiveCostUsd, '0.00400000');
  assert.equal(report.ledger.reservedAttempts, 0);
  assert.deepEqual(events.slice(-2), ['ledger:load', 'ledger:disconnect']);
  assert.equal(JSON.stringify(report).includes('test-only-provider-key'), false);
});

test('PIDAFIX1 embedding benchmark never publishes a winner from a partial red run', async () => {
  const operationRunId = '10000000-0000-4000-8000-000000000001';
  const executionId = '20000000-0000-4000-8000-000000000001';
  let gatewayCalls = 0;
  const report = await runAssistantEmbeddingBenchmark({
    argv: ['--live', '--max-http-attempts', '4', '--max-cost-usd', '0.50'],
    environment: readyEnvironment(),
    ids: { operationRunId, executionId },
    createGateway(candidate) {
      gatewayCalls += 1;
      if (gatewayCalls === 2) {
        return { async embed() { throw new Error('ASSISTANT_EMBEDDING_TIMEOUT'); } };
      }
      return {
        async embed(values, context) {
          context.nextAttemptOrdinal();
          return {
            model: candidate.model,
            vectors: values.map((_value, index) => vector(candidate.dimensions, index)),
          };
        },
      };
    },
    ledger: {
      async loadAttempts() {
        return [1, 2, 3].map((attemptOrdinal) => ({
          operationRunId,
          executionId,
          attemptOrdinal,
          operation: 'EMBEDDING_BENCHMARK',
          status: attemptOrdinal === 3 ? 'RESERVED' : 'SETTLED',
          reservedCostUsd: '0.01000000',
          chargedCostUsd: attemptOrdinal === 3 ? null : '0.00100000',
          inputTokens: attemptOrdinal === 3 ? null : 10,
        }));
      },
      async disconnect() {},
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_UNSETTLED');
  assert.equal(report.ledger.effectiveCostUsd, '0.01200000');
  assert.equal(report.winner, null);
  assert.equal(report.rolloutGate, null);
  assert.equal(report.results.length, 1);
});

test('PIDAFIX1 embedding benchmark reports an unavailable ledger instead of zero cost', async () => {
  const operationRunId = '10000000-0000-4000-8000-000000000001';
  const executionId = '20000000-0000-4000-8000-000000000001';
  const report = await runAssistantEmbeddingBenchmark({
    argv: ['--live', '--max-http-attempts', '4', '--max-cost-usd', '0.50'],
    environment: readyEnvironment(),
    ids: { operationRunId, executionId },
    createGateway(candidate) {
      return {
        async embed(values, context) {
          context.nextAttemptOrdinal();
          return {
            model: candidate.model,
            vectors: values.map((_value, index) => vector(candidate.dimensions, index)),
          };
        },
      };
    },
    ledger: {
      async loadAttempts() { throw new Error('database unavailable'); },
      async disconnect() {},
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_READ_FAILED');
  assert.equal(report.providerCalls, null);
  assert.deepEqual(report.ledger, {
    status: 'UNAVAILABLE',
    errorCode: 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_READ_FAILED',
  });
  assert.equal(report.winner, null);
  assert.equal(report.rolloutGate, null);
});

test('PIDAFIX1 embedding benchmark bounds a stalled final ledger read after provider calls', async () => {
  let disconnected = false;
  const report = await withTestDeadline(runAssistantEmbeddingBenchmark({
    argv: ['--live', '--max-http-attempts', '4', '--max-cost-usd', '0.50'],
    environment: readyEnvironment(),
    operationTimeoutMs: 10,
    createGateway: successfulGateway,
    ledger: {
      async loadAttempts() { return new Promise(() => {}); },
      async disconnect() { disconnected = true; },
    },
  }));

  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_READ_FAILED');
  assert.equal(report.providerCalls, null);
  assert.equal(disconnected, true);
});

test('PIDAFIX1 embedding benchmark bounds disconnect and reports it as red', async () => {
  const report = await withTestDeadline(runAssistantEmbeddingBenchmark({
    argv: ['--live', '--max-http-attempts', '4', '--max-cost-usd', '0.50'],
    environment: readyEnvironment(),
    operationTimeoutMs: 10,
    createGateway: successfulGateway,
    ledger: {
      async loadAttempts(operationRunId, executionId) {
        return benchmarkAttempts(operationRunId, executionId);
      },
      async disconnect() { return new Promise(() => {}); },
    },
  }));

  assert.equal(report.passed, false);
  assert.equal(report.errorCode, 'ASSISTANT_EMBEDDING_BENCHMARK_DISCONNECT_FAILED');
  assert.equal(report.providerCalls, 4);
});

test('PIDAFIX1 embedding benchmark default database URL has bounded Prisma timeouts', () => {
  const result = new URL(createBoundedDatabaseUrl(
    'postgresql://local:local@localhost:5432/embedding_benchmark_disposable?schema=private&pool_timeout=7',
    10_000,
  ));

  assert.equal(result.searchParams.get('schema'), 'private');
  assert.equal(result.searchParams.get('connect_timeout'), '10');
  assert.equal(result.searchParams.get('pool_timeout'), '7');
  assert.equal(result.searchParams.get('socket_timeout'), '10');
});

function readyEnvironment() {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://local:local@localhost:5432/embedding_benchmark_disposable',
    ASSISTANT_LOCAL_PAID_SMOKE_DISPOSABLE_DB: 'true',
    ASSISTANT_EMBEDDING_BENCHMARK_ENABLED: 'true',
    ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES: candidates,
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'test-only-provider-key',
  };
}

function vector(dimensions, seed) {
  const result = Array.from({ length: dimensions }, () => 0);
  result[seed % dimensions] = 1;
  return result;
}

function successfulGateway(candidate) {
  return {
    async embed(values, context) {
      context.nextAttemptOrdinal();
      return {
        model: candidate.model,
        vectors: values.map((_value, index) => vector(candidate.dimensions, index)),
      };
    },
  };
}

function benchmarkAttempts(operationRunId, executionId) {
  return [1, 2, 3, 4].map((attemptOrdinal) => ({
    operationRunId,
    executionId,
    attemptOrdinal,
    operation: 'EMBEDDING_BENCHMARK',
    status: 'SETTLED',
    reservedCostUsd: '0.01000000',
    chargedCostUsd: '0.00100000',
    inputTokens: 10,
  }));
}

async function withTestDeadline(operation) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('TEST_OPERATION_DID_NOT_RESOLVE')),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
