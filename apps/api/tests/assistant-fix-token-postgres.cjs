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
const {
  AssistantRunProcessor,
} = require('../dist/assistant/assistant-run.processor.js');
const {
  createEmptyAssistantSearchFilters,
} = require('../dist/assistant/assistant-query-planner.js');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const service = new AssistantAiUsageBudgetService(prisma);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const provider = `openai-fix-${suffix}`;
const firstDay = new Date('2098-08-27T00:00:00.000Z');
const secondDay = new Date('2098-08-28T00:00:00.000Z');
const thirdDay = new Date('2098-08-29T00:00:00.000Z');
const fourthDay = new Date('2098-08-30T00:00:00.000Z');
const assistantFixtures = [];

process.env.ASSISTANT_MODULE_ENABLED = 'true';
process.env.ASSISTANT_FAKE_STEP_DELAY_MS = '0';

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.assistantAiUsageAttempt.deleteMany({ where: { provider } });
  await prisma.assistantAiDailyBudget.deleteMany({ where: { provider } });
  for (const fixture of assistantFixtures) {
    await prisma.assistantRun.deleteMany({ where: { id: fixture.run.id } });
    await prisma.assistantMessage.deleteMany({ where: { conversationId: fixture.conversation.id } });
    await prisma.assistantConversation.deleteMany({ where: { id: fixture.conversation.id } });
    await prisma.user.deleteMany({ where: { id: fixture.user.id } });
    await prisma.role.deleteMany({ where: { id: fixture.role.id } });
  }
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

test('FIX-TOKEN recovers an expired AssistantRun lease and starts a new execution after reconciling its reserve', async () => {
  const fixture = await createExpiredAssistantRun();
  assistantFixtures.push(fixture);
  const oldExecutionId = randomUUID();
  const usageNow = new Date();
  const oldReservation = await service.reserve({
    provider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId: fixture.run.id,
    executionId: oldExecutionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.50000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    reservationExpiresAt: new Date(usageNow.getTime() - 60_000),
    now: usageNow,
  });
  let executionIdSeen = null;
  let reconciledSnapshotAtAnswer = null;
  const answerService = {
    async answer(input) {
      reconciledSnapshotAtAnswer = await prisma.assistantAiUsageAttempt.findUniqueOrThrow({
        where: { id: oldReservation.id },
        select: {
          status: true,
          outcome: true,
          errorCode: true,
          reservedCostUsd: true,
          estimatedCostUsd: true,
          chargedCostUsd: true,
          settledAt: true,
        },
      });
      assert.equal(reconciledSnapshotAtAnswer.status, 'SETTLED');
      assert.equal(reconciledSnapshotAtAnswer.outcome, 'UNKNOWN_AFTER_CRASH');
      assert.equal(reconciledSnapshotAtAnswer.reservedCostUsd.toFixed(8), '0.10000000');
      assert.equal(reconciledSnapshotAtAnswer.estimatedCostUsd, null);
      assert.equal(reconciledSnapshotAtAnswer.chargedCostUsd.toFixed(8), '0.10000000');
      assert.ok(reconciledSnapshotAtAnswer.settledAt instanceof Date);

      executionIdSeen = input.executionId;
      assert.match(
        executionIdSeen,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
      assert.notEqual(executionIdSeen, oldExecutionId);
      const reservation = await service.reserve({
        provider,
        model: 'gpt-5.6-luna',
        operation: 'PLANNER',
        operationRunId: fixture.run.id,
        executionId: executionIdSeen,
        attemptOrdinal: 1,
        dailyBudgetUsd: '0.50000000',
        reservedCostUsd: '0.10000000',
        reasoningEffort: 'medium',
        promptVersion: 'test-prompt-v1',
        validatorVersion: 'test-validator-v1',
        reservationExpiresAt: new Date(Date.now() + 120_000),
        now: usageNow,
      });
      await settleLuna(reservation);
      const filters = createEmptyAssistantSearchFilters();
      return {
        content: 'Уточните, пожалуйста, параметры поиска.',
        answer: { kind: 'CLARIFICATION' },
        intent: {
          taskType: 'SEARCH',
          comparisonTargets: [],
          hardFilters: filters,
          softPreferences: filters,
          requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
          needsClarification: true,
          clarificationQuestion: 'Уточните, пожалуйста, параметры поиска.',
        },
        evidence: [],
        candidateEvidence: [],
        telemetry: [],
      };
    },
  };
  const processor = new AssistantRunProcessor(prisma, answerService, service);

  let terminalRun;
  try {
    await processor.onModuleInit();
    terminalRun = await waitForTerminalRun(fixture.run.id);
  } finally {
    await processor.onModuleDestroy();
  }

  assert.equal(terminalRun.status, 'COMPLETED');
  assert.ok(reconciledSnapshotAtAnswer);
  assert.notEqual(executionIdSeen, oldExecutionId);
  const attempts = await prisma.assistantAiUsageAttempt.findMany({
    where: { operationRunId: fixture.run.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      executionId: true,
      attemptOrdinal: true,
      status: true,
      outcome: true,
      errorCode: true,
      reservedCostUsd: true,
      estimatedCostUsd: true,
      chargedCostUsd: true,
      settledAt: true,
    },
  });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(({ attemptOrdinal }) => attemptOrdinal), [1, 1]);
  assert.equal(new Set(attempts.map(({ executionId }) => executionId)).size, 2);
  const oldAttempt = attempts.find(({ executionId }) => executionId === oldExecutionId);
  const newAttempt = attempts.find(({ executionId }) => executionId === executionIdSeen);
  assert.equal(oldAttempt.outcome, 'UNKNOWN_AFTER_CRASH');
  assert.match(oldAttempt.errorCode, /^ASSISTANT_AI_[A-Z0-9_]+$/u);
  assert.equal(oldAttempt.chargedCostUsd.toFixed(8), '0.10000000');
  assert.equal(newAttempt.outcome, 'ACCEPTED');
  assert.equal(newAttempt.chargedCostUsd.toFixed(8), '0.00002890');
  const budget = await readBudgetSnapshot(oldReservation.usageDate);
  assert.equal(budget.reservedCostUsd.toFixed(8), '0.00000000');
  assert.equal(budget.settledCostUsd.toFixed(8), '0.10002890');
});

test('FIX-TOKEN keeps provider/day budget atomic while settlement races reconciliation', async () => {
  const gate = deferred();
  const reservationInputs = Array.from({ length: 8 }, (_, index) => ({
    model: index % 2 === 0 ? 'gpt-5.6-luna' : 'gpt-5.6-terra',
    operation: index % 2 === 0 ? 'PLANNER' : 'SOURCE_DISCOVERY',
    operationRunId: runId(`reconcile-race-${index}`),
    executionId: randomUUID(),
  }));
  const reservationRace = reservationInputs.map(async (input) => {
    await gate.promise;
    const reservation = await service.reserve({
      provider,
      model: input.model,
      operation: input.operation,
      operationRunId: input.operationRunId,
      executionId: input.executionId,
      attemptOrdinal: 1,
      dailyBudgetUsd: '0.30000000',
      reservedCostUsd: '0.05000000',
      reasoningEffort: 'medium',
      promptVersion: 'test-prompt-v1',
      validatorVersion: 'test-validator-v1',
      isFallback: input.model === 'gpt-5.6-terra',
      reservationExpiresAt: new Date(fourthDay.getTime() + 30_000),
      now: fourthDay,
    });
    return { input, reservation };
  });
  gate.resolve();
  const reservationOutcomes = await Promise.allSettled(reservationRace);
  const fulfilled = reservationOutcomes
    .filter(({ status }) => status === 'fulfilled')
    .map(({ value }) => value);
  const rejected = reservationOutcomes.filter(({ status }) => status === 'rejected');

  assert.equal(fulfilled.length, 6);
  assert.equal(rejected.length, 2);
  assert.equal(rejected.every(({ reason }) => (
    reason.code === 'ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED'
  )), true);
  const raceAttempts = await prisma.assistantAiUsageAttempt.findMany({
    where: { id: { in: fulfilled.map(({ reservation }) => reservation.id) } },
    select: { id: true, operation: true, status: true },
  });
  assert.equal(raceAttempts.length, 6);
  assert.equal(raceAttempts.every(({ status }) => status === 'RESERVED'), true);
  assert.ok(raceAttempts.filter(({ operation }) => operation === 'PLANNER').length >= 2);
  assert.ok(raceAttempts.filter(({ operation }) => operation === 'SOURCE_DISCOVERY').length >= 2);
  const beforeRaceBudget = await readBudgetSnapshot(fourthDay);
  assert.equal(beforeRaceBudget.reservedCostUsd.toFixed(8), '0.30000000');
  assert.equal(beforeRaceBudget.settledCostUsd.toFixed(8), '0.00000000');
  assert.equal(
    beforeRaceBudget.reservedCostUsd.add(beforeRaceBudget.settledCostUsd)
      .lte(beforeRaceBudget.budgetLimitUsd),
    true,
  );

  const target = fulfilled.find(({ input }) => input.model === 'gpt-5.6-luna');
  assert.ok(target);
  const reconciliationNow = new Date(fourthDay.getTime() + 120_000);
  const settlementRace = await Promise.allSettled([
    settleLuna(target.reservation),
    ...Array.from({ length: 4 }, () => service.reconcileExpiredReservations({
      operationRunId: target.input.operationRunId,
      now: reconciliationNow,
    })),
  ]);
  assert.equal(settlementRace.every(({ status }) => status === 'fulfilled'), true);

  const settledAttempt = await readAttemptSnapshot(target.reservation.id);
  const chargedCostUsd = settledAttempt.chargedCostUsd.toFixed(8);
  assert.equal(['0.00002890', '0.05000000'].includes(chargedCostUsd), true);
  assert.equal(['ACCEPTED', 'UNKNOWN_AFTER_CRASH'].includes(settledAttempt.outcome), true);
  const afterRaceBudget = await readBudgetSnapshot(fourthDay);
  assert.equal(afterRaceBudget.reservedCostUsd.toFixed(8), '0.25000000');
  assert.equal(afterRaceBudget.settledCostUsd.toFixed(8), chargedCostUsd);
  assert.equal(
    afterRaceBudget.reservedCostUsd.add(afterRaceBudget.settledCostUsd)
      .lte(afterRaceBudget.budgetLimitUsd),
    true,
  );

  const immutableAttempt = serializeAttemptSnapshot(settledAttempt);
  const immutableBudget = serializeBudgetSnapshot(afterRaceBudget);
  const repeated = await Promise.allSettled([
    settleLuna(target.reservation),
    service.reconcileExpiredReservations({
      operationRunId: target.input.operationRunId,
      now: reconciliationNow,
    }),
    service.reconcileExpiredReservations({
      operationRunId: target.input.operationRunId,
      now: reconciliationNow,
    }),
  ]);
  assert.equal(repeated.every(({ status }) => status === 'fulfilled'), true);
  assert.deepEqual(
    serializeAttemptSnapshot(await readAttemptSnapshot(target.reservation.id)),
    immutableAttempt,
  );
  assert.deepEqual(serializeBudgetSnapshot(await readBudgetSnapshot(fourthDay)), immutableBudget);
});

async function createExpiredAssistantRun() {
  const role = await prisma.role.create({
    data: { name: `fix-token-${suffix}` },
  });
  const user = await prisma.user.create({
    data: {
      email: `fix-token-${suffix}@example.test`,
      passwordHash: 'not-used',
      name: 'FIX-TOKEN recovery fixture',
      status: 'ACTIVE',
      roleId: role.id,
    },
  });
  const conversation = await prisma.assistantConversation.create({
    data: {
      ownerUserId: user.id,
      creationKey: randomUUID(),
      title: 'FIX-TOKEN recovery',
    },
  });
  const userMessage = await prisma.assistantMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'USER',
      content: 'Подбери объект для recovery-теста',
    },
  });
  const startedAt = new Date(Date.now() - 120_000);
  const run = await prisma.assistantRun.create({
    data: {
      ownerUserId: user.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      idempotencyKey: randomUUID(),
      requestHash: 'd'.repeat(64),
      status: 'RUNNING',
      progressJson: [],
      leaseOwner: `dead-worker-${suffix}`,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    },
  });
  return { role, user, conversation, userMessage, run };
}

async function waitForTerminalRun(runIdValue) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await prisma.assistantRun.findUniqueOrThrow({
      where: { id: runIdValue },
      select: { id: true, status: true, errorCode: true },
    });
    if (run.status === 'COMPLETED' || run.status === 'FAILED') return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('FIX_TOKEN_ASSISTANT_RUN_TERMINAL_TIMEOUT');
}

function readAttemptSnapshot(attemptId) {
  return prisma.assistantAiUsageAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      id: true,
      status: true,
      outcome: true,
      errorCode: true,
      reservedCostUsd: true,
      estimatedCostUsd: true,
      chargedCostUsd: true,
      settledAt: true,
    },
  });
}

function readBudgetSnapshot(usageDate) {
  return prisma.assistantAiDailyBudget.findUniqueOrThrow({
    where: { provider_usageDate: { provider, usageDate } },
    select: {
      provider: true,
      usageDate: true,
      budgetLimitUsd: true,
      reservedCostUsd: true,
      settledCostUsd: true,
      updatedAt: true,
    },
  });
}

function serializeAttemptSnapshot(attempt) {
  return {
    id: attempt.id,
    status: attempt.status,
    outcome: attempt.outcome,
    errorCode: attempt.errorCode,
    reservedCostUsd: attempt.reservedCostUsd.toFixed(8),
    estimatedCostUsd: attempt.estimatedCostUsd?.toFixed(8) ?? null,
    chargedCostUsd: attempt.chargedCostUsd?.toFixed(8) ?? null,
    settledAt: attempt.settledAt?.toISOString() ?? null,
  };
}

function serializeBudgetSnapshot(budget) {
  return {
    provider: budget.provider,
    usageDate: budget.usageDate.toISOString(),
    budgetLimitUsd: budget.budgetLimitUsd.toFixed(8),
    reservedCostUsd: budget.reservedCostUsd.toFixed(8),
    settledCostUsd: budget.settledCostUsd.toFixed(8),
    updatedAt: budget.updatedAt.toISOString(),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
