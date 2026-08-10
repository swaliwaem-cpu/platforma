const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const {
  estimateTrainingAiCost,
  TRAINING_AI_PRICING_SNAPSHOTS,
} = require('../dist/training/training-ai-pricing.js');
const {
  TrainingOpenAIClient,
  TrainingOpenAIError,
} = require('../dist/training/training-openai-client.js');
const {
  parseTrainingAiUsageReportQuery,
} = require('../dist/training/training.validation.js');

test('versioned pricing separates uncached, cached, cache-write and output tokens', () => {
  const estimate = estimateTrainingAiCost('gpt-5.6-terra', {
    inputTokens: 100,
    cachedTokens: 40,
    cacheWriteTokens: 10,
    outputTokens: 50,
    reasoningTokens: 12,
    totalTokens: 150,
  }, new Date('2026-08-08T00:00:00.000Z'));

  assert.equal(TRAINING_AI_PRICING_SNAPSHOTS.length, 1);
  assert.deepEqual(estimate, {
    pricingVersion: 'openai-standard-pricing-2026-08-07',
    pricingStatus: 'estimated',
    estimatedCostUsd: '0.00073300',
  });
  assert.equal(
    estimateTrainingAiCost('unpriced-model', null, new Date('2026-08-08')).pricingStatus,
    'model_unpriced',
  );
  assert.equal(
    estimateTrainingAiCost('gpt-5.6-terra', null, new Date('2026-08-08')).pricingStatus,
    'usage_incomplete',
  );
});

test('OpenAI client observes transport, provider, local validation and accepted attempts once', async () => {
  const observations = [];
  const operationRunId = randomUUID();
  let calls = 0;
  const client = new TrainingOpenAIClient('test-key', async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('synthetic network failure');
    if (calls === 2) {
      return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    }
    if (calls === 3) {
      return new Response(JSON.stringify({ accepted: false }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-local' },
      });
    }
    return new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-ok' },
    });
  }, 'https://openai.invalid/v1');

  const response = await client.request({
    path: '/responses',
    body: '{}',
    contentType: 'application/json',
    clientRequestId: operationRunId,
    policy: { timeoutMs: 5_000, maxRetries: 3 },
    parse: async (httpResponse) => {
      const value = await httpResponse.json();
      if (!value.accepted) throw new TrainingOpenAIError('LOCAL_SCHEMA_INVALID', true);
      return value;
    },
    observeAttempt: (observation) => observations.push(observation),
  });

  assert.equal(response.attempts, 4);
  assert.deepEqual(observations.map((item) => item.attempt), [1, 2, 3, 4]);
  assert.deepEqual(observations.map((item) => item.outcome), [
    'transport_error',
    'provider_error',
    'local_validation_failed',
    'accepted',
  ]);
  assert.deepEqual(observations.map((item) => item.errorCode), [
    'OPENAI_NETWORK_ERROR',
    'OPENAI_RATE_LIMITED',
    'LOCAL_SCHEMA_INVALID',
    null,
  ]);
  assert.equal(observations.every((item) => item.clientRequestId === operationRunId), true);
});

test('AI usage report query is bounded and accepts internal correlation filters', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');
  const projectId = randomUUID();
  const attemptId = randomUUID();
  const operationRunId = randomUUID();
  const parsed = parseTrainingAiUsageReportQuery({
    projectId,
    attemptId,
    operationRunId,
  }, now);

  assert.equal(parsed.to.toISOString(), now.toISOString());
  assert.equal(parsed.from.toISOString(), '2026-07-09T12:00:00.000Z');
  assert.deepEqual(
    [parsed.projectId, parsed.attemptId, parsed.operationRunId],
    [projectId, attemptId, operationRunId],
  );
  assert.throws(
    () => parseTrainingAiUsageReportQuery({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-08-08T00:00:00.000Z',
    }, now),
    /must not exceed 93 days/u,
  );
  assert.throws(
    () => parseTrainingAiUsageReportQuery({ from: now.toISOString(), to: now.toISOString() }, now),
    /from must be before to/u,
  );
});

test('migration defines durable constrained rows without sensitive payload columns', () => {
  const migration = readFileSync(
    'prisma/migrations/20260808160000_add_training_ai_usage_events/migration.sql',
    'utf8',
  );

  assert.match(migration, /CREATE TABLE "training_ai_usage_events"/u);
  assert.match(migration, /training_ai_usage_events_run_attempt_key/u);
  assert.match(migration, /ON DELETE SET NULL/u);
  assert.match(migration, /"estimated_cost_usd" NUMERIC\(18, 8\)/u);
  assert.doesNotMatch(migration, /prompt_text|transcript|source_excerpt|provider_body|api_key|raw_error/iu);
});
