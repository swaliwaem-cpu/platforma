require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { PrismaClient } = require('@prisma/client');

const databaseUrl = process.env.ASSISTANT_FIX_TOKEN_TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('ASSISTANT_FIX_TOKEN_TEST_DATABASE_URL_REQUIRED');

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.ASSISTANT_AI_MODE = 'fake';
process.env.ASSISTANT_EMBEDDING_MODE = 'fake';
process.env.ASSISTANT_GEO_PROVIDER_MODE = 'fake';
process.env.TRAINING_AI_MODE = 'fake';
process.env.TELEGRAM_TRANSPORT_MODE = 'fake';

const {
  AssistantAiUsageBudgetService,
} = require('../dist/assistant/operations/assistant-ai-usage-budget.service.js');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const service = new AssistantAiUsageBudgetService(prisma);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const provider = `openai-fix-${suffix}`;
const firstDay = new Date('2098-08-27T00:00:00.000Z');
const secondDay = new Date('2098-08-28T00:00:00.000Z');
const thirdDay = new Date('2098-08-29T00:00:00.000Z');

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.assistantAiUsageAttempt.deleteMany({ where: { provider } });
  await prisma.assistantAiDailyBudget.deleteMany({ where: { provider } });
  await prisma.$disconnect();
});

test('FIX-TOKEN atomically shares one provider/day USD budget across planner and discovery', async () => {
  const lunaRunId = runId('luna-planner');
  const terraRunId = runId('terra-discovery');
  const luna = await reserve({
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId: lunaRunId,
    now: firstDay,
  });
  const terra = await reserve({
    model: 'gpt-5.6-terra',
    operation: 'SOURCE_DISCOVERY',
    operationRunId: terraRunId,
    now: firstDay,
  });

  const race = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => reserve({
    model: index % 2 === 0 ? 'gpt-5.6-luna' : 'gpt-5.6-terra',
    operation: index % 2 === 0 ? 'SOURCE_DISCOVERY' : 'PLANNER',
    operationRunId: runId(`race-${index}`),
    now: firstDay,
  })));
  const raceReservations = race
    .filter(({ status }) => status === 'fulfilled')
    .map(({ value }) => value);
  const rejected = race.filter(({ status }) => status === 'rejected');

  assert.equal(raceReservations.length, 1);
  assert.equal(rejected.length, 7);
  assert.equal(rejected.every(({ reason }) => (
    reason.code === 'ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED'
  )), true);
  assert.equal(await prisma.assistantAiUsageAttempt.count({ where: { provider } }), 3);

  const budget = await readBudget(firstDay);
  assert.equal(budget.budgetLimitUsd.toFixed(8), '0.30000000');
  assert.equal(budget.reservedCostUsd.toFixed(8), '0.30000000');
  assert.equal(budget.settledCostUsd.toFixed(8), '0.00000000');

  await assert.rejects(
    reserve({
      model: 'gpt-5.6-luna',
      operation: 'PLANNER',
      operationRunId: lunaRunId,
      now: firstDay,
    }),
    (error) => error.code === 'ASSISTANT_AI_ATTEMPT_DUPLICATE',
  );
  assert.equal(await prisma.assistantAiUsageAttempt.count({ where: { provider } }), 3);

  const settlements = await Promise.all([
    settleLuna(luna),
    settleLuna(luna),
  ]);
  assert.deepEqual(settlements.sort(), [false, true]);

  await service.settle({
    reservation: terra,
    actualModel: 'gpt-5.6-terra',
    outcome: 'PROVIDER_ERROR',
    errorCode: 'ASSISTANT_SOURCE_DISCOVERY_TIMEOUT',
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    webSearchCalls: null,
    durationMs: 500,
  });

  const settledBudget = await readBudget(firstDay);
  assert.equal(settledBudget.reservedCostUsd.toFixed(8), '0.10000000');
  assert.equal(settledBudget.settledCostUsd.toFixed(8), '0.10002890');

  const attempts = await prisma.assistantAiUsageAttempt.findMany({
    where: { id: { in: [luna.id, terra.id] } },
    orderBy: { requestedModel: 'asc' },
  });
  const lunaAttempt = attempts.find(({ id }) => id === luna.id);
  const terraAttempt = attempts.find(({ id }) => id === terra.id);
  assert.equal(lunaAttempt.pricingStatus, 'PRICED');
  assert.equal(lunaAttempt.cachedInputTokens, 20n);
  assert.equal(lunaAttempt.cacheWriteInputTokens, 10n);
  assert.equal(lunaAttempt.webSearchCalls, 0);
  assert.equal(lunaAttempt.chargedCostUsd.toFixed(8), '0.00002890');
  assert.equal(terraAttempt.pricingStatus, 'USAGE_INCOMPLETE');
  assert.equal(terraAttempt.chargedCostUsd.toFixed(8), '0.10000000');

  await assert.rejects(
    reserve({
      model: 'gpt-5.6-luna',
      operation: 'PLANNER',
      operationRunId: runId('same-day-after-crash'),
      now: firstDay,
    }),
    (error) => error.code === 'ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED',
  );

  const rollover = await reserve({
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId: runId('utc-rollover'),
    now: secondDay,
  });
  assert.equal(rollover.usageDate.toISOString(), secondDay.toISOString());
  assert.equal((await readBudget(secondDay)).reservedCostUsd.toFixed(8), '0.10000000');
});

test('FIX-TOKEN records an actual charge above reserve without hiding the overage', async () => {
  const reservation = await service.reserve({
    provider,
    model: 'gpt-5.6-terra',
    operation: 'SOURCE_DISCOVERY',
    operationRunId: runId('reserve-exceeded'),
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.00000100',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    now: thirdDay,
  });

  assert.equal(await service.settle({
    reservation,
    actualModel: 'gpt-5.6-terra',
    outcome: 'ACCEPTED',
    errorCode: null,
    inputTokens: 1_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningTokens: 50,
    totalTokens: 1_100,
    webSearchCalls: 1,
    durationMs: 250,
  }), true);

  const attempt = await prisma.assistantAiUsageAttempt.findUniqueOrThrow({
    where: { id: reservation.id },
  });
  assert.equal(attempt.pricingStatus, 'RESERVE_EXCEEDED');
  assert.equal(attempt.reservedCostUsd.toFixed(8), '0.00000100');
  assert.equal(attempt.chargedCostUsd.toFixed(8), '0.01320000');
  assert.equal((await readBudget(thirdDay)).settledCostUsd.toFixed(8), '0.01320000');
});

function runId(label) {
  return `fix-token-${suffix}-${label}`;
}

function reserve({ model, operation, operationRunId, now }) {
  return service.reserve({
    provider,
    model,
    operation,
    operationRunId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    isFallback: model === 'gpt-5.6-terra',
    now,
  });
}

function settleLuna(reservation) {
  return service.settle({
    reservation,
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
  });
}

function readBudget(usageDate) {
  return prisma.assistantAiDailyBudget.findUniqueOrThrow({
    where: { provider_usageDate: { provider, usageDate } },
  });
}
