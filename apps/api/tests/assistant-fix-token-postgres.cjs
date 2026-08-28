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
  AssistantUsageBudgetService,
} = require('../dist/assistant/operations/assistant-usage-budget.service.js');
const {
  AssistantRunProcessor,
} = require('../dist/assistant/assistant-run.processor.js');
const {
  createEmptyAssistantSearchFilters,
} = require('../dist/assistant/assistant-query-planner.js');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const service = new AssistantAiUsageBudgetService(prisma);
const requestBudgets = new AssistantUsageBudgetService(prisma);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const provider = `openai-fix-${suffix}`;
const expiryProvider = `openai-expiry-${suffix}`;
const reconcileProvider = `openai-reconcile-${suffix}`;
const planProvider = `openai-plan-${suffix}`;
const embeddingProvider = `openai-embedding-${suffix}`;
const requestProvider = `openai-request-${suffix}`;
const planUsageDate = new Date('2100-01-01T00:00:00.000Z');
const firstDay = new Date('2098-08-27T00:00:00.000Z');
const secondDay = new Date('2098-08-28T00:00:00.000Z');
const thirdDay = new Date('2098-08-29T00:00:00.000Z');
const fourthDay = new Date('2098-08-30T00:00:00.000Z');
const fifthDay = new Date('2098-08-31T00:00:00.000Z');
const sixthDay = new Date('2098-09-01T00:00:00.000Z');
const seventhDay = new Date('2098-09-02T00:00:00.000Z');
const eighthDay = new Date('2098-09-03T00:00:00.000Z');
const ninthDay = new Date('2098-09-04T00:00:00.000Z');
const tenthDay = new Date('2098-09-05T00:00:00.000Z');
const eleventhDay = new Date('2098-09-06T12:00:00.000Z');
const assistantFixtures = [];

process.env.ASSISTANT_MODULE_ENABLED = 'true';
process.env.ASSISTANT_FAKE_STEP_DELAY_MS = '0';

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.assistantUsageMetric.deleteMany({ where: { provider: requestProvider } });
  await prisma.assistantAiUsageAttempt.deleteMany({
    where: { provider: { in: [
      provider,
      expiryProvider,
      reconcileProvider,
      planProvider,
      embeddingProvider,
    ] } },
  });
  await prisma.assistantAiExecutionFence.deleteMany({
    where: { operationRunId: { startsWith: `fix-token-${suffix}-` } },
  });
  await prisma.assistantAiDailyBudget.deleteMany({
    where: { provider: { in: [
      provider,
      expiryProvider,
      reconcileProvider,
      planProvider,
      embeddingProvider,
    ] } },
  });
  for (const fixture of assistantFixtures) {
    await prisma.assistantRun.deleteMany({ where: { id: fixture.run.id } });
    await prisma.assistantMessage.deleteMany({ where: { conversationId: fixture.conversation.id } });
    await prisma.assistantConversation.deleteMany({ where: { id: fixture.conversation.id } });
    await prisma.user.deleteMany({ where: { id: fixture.user.id } });
    await prisma.role.deleteMany({ where: { id: fixture.role.id } });
  }
  await prisma.$disconnect();
});

test('FIX-TOKEN keeps only indexes used by real budget, reconciliation and report queries', async () => {
  const planOperationRunId = runId('query-plan-target');
  const planExecutionId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "assistant_ai_daily_budgets" (
      "provider", "usage_date", "budget_limit_usd", "reserved_cost_usd", "settled_cost_usd"
    )
    SELECT
      ${planProvider},
      ${planUsageDate}::date + "series" AS "usage_date",
      CAST('1.00000000' AS numeric),
      CAST('0.00000000' AS numeric),
      CAST('0.00000000' AS numeric)
    FROM generate_series(0, 1023) AS "series"
    ON CONFLICT ("provider", "usage_date") DO NOTHING
  `;
  await prisma.$executeRaw`
    INSERT INTO "assistant_ai_usage_attempts" (
      "id", "operation_run_id", "execution_id", "execution_attempt_ordinal",
      "operation", "provider", "requested_model", "service_tier",
      "reasoning_effort", "prompt_version", "validator_version", "is_fallback",
      "status", "outcome", "pricing_catalog_version", "pricing_status",
      "reserved_cost_usd", "charged_cost_usd", "usage_date", "reservation_expires_at"
    )
    SELECT
      md5(${`fix-token-${suffix}-plan-attempt-`} || "series"::text)::uuid,
      ${`fix-token-${suffix}-plan-noise-`} || "series"::text,
      md5(${`fix-token-${suffix}-plan-execution-`} || "series"::text)::uuid,
      1,
      'SOURCE_DISCOVERY',
      ${planProvider},
      'gpt-5.6-luna',
      'default',
      'medium',
      'query-plan-prompt-v1',
      'query-plan-validator-v1',
      false,
      'SETTLED',
      'ACCEPTED',
      'openai-standard-pricing-2026-08-27',
      'PRICED',
      CAST('0.00010000' AS numeric),
      CAST('0.00010000' AS numeric),
      ${planUsageDate},
      ${planUsageDate}
    FROM generate_series(1, 2048) AS "series"
  `;
  await prisma.$executeRaw`
    INSERT INTO "assistant_ai_usage_attempts" (
      "id", "operation_run_id", "execution_id", "execution_attempt_ordinal",
      "operation", "provider", "requested_model", "service_tier",
      "reasoning_effort", "prompt_version", "validator_version", "is_fallback",
      "status", "pricing_catalog_version", "pricing_status",
      "reserved_cost_usd", "usage_date", "reservation_expires_at"
    ) VALUES (
      CAST(${randomUUID()} AS uuid),
      ${planOperationRunId},
      CAST(${planExecutionId} AS uuid),
      1,
      'SOURCE_DISCOVERY',
      ${planProvider},
      'gpt-5.6-luna',
      'default',
      'medium',
      'query-plan-prompt-v1',
      'query-plan-validator-v1',
      false,
      'RESERVED',
      'openai-standard-pricing-2026-08-27',
      'RESERVED',
      CAST('0.10000000' AS numeric),
      ${planUsageDate},
      ${new Date('2100-01-01T00:10:00.000Z')}
    )
  `;
  await prisma.$executeRaw`ANALYZE "assistant_ai_daily_budgets"`;
  await prisma.$executeRaw`ANALYZE "assistant_ai_usage_attempts"`;

  const obsoleteIndexes = await prisma.$queryRaw`
    SELECT "indexname"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "indexname" IN (
        'assistant_ai_daily_budgets_usage_date_idx',
        'assistant_ai_usage_attempts_provider_usage_date_status_idx',
        'assistant_ai_usage_attempts_operation_created_at_idx'
      )
    ORDER BY "indexname"
  `;
  assert.deepEqual(obsoleteIndexes, []);

  const reconciliationPlan = explainPlanText(await prisma.$queryRaw`
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
    SELECT
      "id",
      "execution_id" AS "executionId",
      "provider",
      "usage_date" AS "usageDate",
      "reserved_cost_usd" AS "reservedCostUsd",
      "reservation_expires_at" AS "reservationExpiresAt"
    FROM "assistant_ai_usage_attempts"
    WHERE "operation_run_id" = ${planOperationRunId}
      AND "status" = 'RESERVED'
    ORDER BY "provider", "usage_date", "id"
    FOR UPDATE
  `);
  assert.match(
    reconciliationPlan,
    /assistant_ai_usage_attempts_(?:operation_run_id_attempt_ordinal_ke|run_execution_ordinal_key)/u,
  );

  const reportPlan = explainPlanText(await prisma.$queryRaw`
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
    SELECT
      "requested_model",
      "is_fallback",
      "status",
      "input_tokens",
      "cached_input_tokens",
      "cache_write_input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "total_tokens",
      "web_search_calls",
      "pricing_catalog_version",
      "reserved_cost_usd",
      "estimated_cost_usd",
      "charged_cost_usd"
    FROM "assistant_ai_usage_attempts"
    WHERE "operation_run_id" = ${planOperationRunId}
      AND "operation" = 'SOURCE_DISCOVERY'
    ORDER BY "created_at", "id"
  `);
  assert.match(
    reportPlan,
    /assistant_ai_usage_attempts_(?:operation_run_id_attempt_ordinal_ke|run_execution_ordinal_key)/u,
  );

  const dailyBudgetPlan = explainPlanText(await prisma.$queryRaw`
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
    SELECT "provider"
    FROM "assistant_ai_daily_budgets"
    WHERE "provider" = ${planProvider}
      AND "usage_date" = ${planUsageDate}
    FOR UPDATE
  `);
  assert.match(dailyBudgetPlan, /assistant_ai_daily_budgets_pkey/u);
});

test('PIDAFIX1 persists an embedding reservation before provider work and settles actual input tokens', async () => {
  const operationRunId = runId('embedding-persisted-before-provider');
  const executionId = randomUUID();
  const reservation = await service.reserve({
    provider: embeddingProvider,
    model: 'text-embedding-3-small',
    operation: 'EMBEDDING_RETRIEVAL',
    operationRunId,
    executionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.10000000',
    reservedCostUsd: '0.00100000',
    validatorVersion: 'assistant-embedding-v1:256',
    now: ninthDay,
  });
  const beforeProvider = await prisma.assistantAiUsageAttempt.findUniqueOrThrow({
    where: { id: reservation.id },
  });
  assert.equal(beforeProvider.status, 'RESERVED');
  assert.equal(beforeProvider.operation, 'EMBEDDING_RETRIEVAL');
  assert.equal(beforeProvider.pricingCatalogVersion, 'openai-embedding-pricing-2026-08-28');

  await service.settle({
    reservation,
    actualModel: 'text-embedding-3-small',
    outcome: 'ACCEPTED',
    errorCode: null,
    inputTokens: 1_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1_000,
    webSearchCalls: 0,
    durationMs: 25,
  });
  const settled = await prisma.assistantAiUsageAttempt.findUniqueOrThrow({
    where: { id: reservation.id },
  });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.estimatedCostUsd.toFixed(8), '0.00002000');
  assert.equal(settled.chargedCostUsd.toFixed(8), '0.00002000');
});

test('PIDAFIX1 applies one atomic provider-day USD ceiling across planner and embeddings', async () => {
  const operationRunId = runId('shared-planner-embedding-ceiling');
  const executionId = randomUUID();
  const common = {
    provider: embeddingProvider,
    operationRunId,
    executionId,
    dailyBudgetUsd: '0.15000000',
    reservedCostUsd: '0.10000000',
    now: tenthDay,
  };
  const race = await Promise.allSettled([
    service.reserve({
      ...common,
      model: 'gpt-5.6-luna',
      operation: 'PLANNER',
      attemptOrdinal: 1,
    }),
    service.reserve({
      ...common,
      model: 'text-embedding-3-small',
      operation: 'EMBEDDING_RETRIEVAL',
      attemptOrdinal: 2,
    }),
  ]);
  assert.equal(race.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(race.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(race.find(({ status }) => status === 'rejected').reason.code,
    'ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED');
});

test('PIDAFIX1 request caps allow two Luna and two Terra attempts but reject the fifth', async () => {
  const reserveRequest = (model) => requestBudgets.reserve({
    provider: requestProvider,
    model,
    perMinuteLimit: 2,
    dailyLimit: 2,
    now: eleventhDay,
    errorPrefix: 'ASSISTANT_MODEL',
  });
  await reserveRequest('gpt-5.6-luna');
  await reserveRequest('gpt-5.6-luna');
  await reserveRequest('gpt-5.6-terra');
  await reserveRequest('gpt-5.6-terra');
  await assert.rejects(
    reserveRequest('gpt-5.6-luna'),
    (error) => error.code === 'ASSISTANT_MODEL_MINUTE_BUDGET_EXHAUSTED',
  );
  assert.equal(await prisma.assistantUsageMetric.count({
    where: { provider: requestProvider, window: 'DAY' },
  }), 2);
});

test('FIX-TOKEN atomically shares one provider/day USD budget across planner and discovery', async () => {
  const lunaRunId = runId('luna-planner');
  const terraRunId = runId('terra-discovery');
  const lunaExecutionId = randomUUID();
  const terraExecutionId = randomUUID();
  const luna = await reserve({
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId: lunaRunId,
    executionId: lunaExecutionId,
    now: firstDay,
  });
  const terra = await reserve({
    model: 'gpt-5.6-terra',
    operation: 'SOURCE_DISCOVERY',
    operationRunId: terraRunId,
    executionId: terraExecutionId,
    now: firstDay,
  });

  const race = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => reserve({
    model: index % 2 === 0 ? 'gpt-5.6-luna' : 'gpt-5.6-terra',
    operation: index % 2 === 0 ? 'SOURCE_DISCOVERY' : 'PLANNER',
    operationRunId: runId(`race-${index}`),
    executionId: randomUUID(),
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

  const idempotentLuna = await reserve({
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId: lunaRunId,
    executionId: lunaExecutionId,
    now: firstDay,
  });
  assert.equal(idempotentLuna.id, luna.id);
  assert.equal(await prisma.assistantAiUsageAttempt.count({ where: { provider } }), 3);

  await assert.rejects(
    service.reserve({
      provider,
      model: 'gpt-5.6-luna',
      operation: 'PLANNER',
      operationRunId: lunaRunId,
      executionId: lunaExecutionId,
      attemptOrdinal: 1,
      dailyBudgetUsd: '0.30000000',
      reservedCostUsd: '0.09000000',
      reasoningEffort: 'medium',
      promptVersion: 'test-prompt-v1',
      validatorVersion: 'test-validator-v1',
      isFallback: false,
      now: firstDay,
    }),
    (error) => error.code === 'ASSISTANT_AI_ATTEMPT_CONFLICT',
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

  await assert.rejects(
    reserve({
      model: 'gpt-5.6-luna',
      operation: 'PLANNER',
      operationRunId: lunaRunId,
      executionId: lunaExecutionId,
      now: firstDay,
    }),
    (error) => error.code === 'ASSISTANT_AI_ATTEMPT_CONFLICT',
  );
  const budgetAfterFinalizedReuse = await readBudget(firstDay);
  assert.equal(budgetAfterFinalizedReuse.reservedCostUsd.toFixed(8), '0.10000000');
  assert.equal(budgetAfterFinalizedReuse.settledCostUsd.toFixed(8), '0.10002890');
  assert.equal(await prisma.assistantAiUsageAttempt.count({ where: { provider } }), 3);

  const attempts = await prisma.assistantAiUsageAttempt.findMany({
    where: { id: { in: [luna.id, terra.id] } },
    orderBy: { requestedModel: 'asc' },
    select: {
      id: true,
      pricingStatus: true,
      cachedInputTokens: true,
      cacheWriteInputTokens: true,
      webSearchCalls: true,
      chargedCostUsd: true,
    },
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
      executionId: randomUUID(),
      now: firstDay,
    }),
    (error) => error.code === 'ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED',
  );

  const rollover = await reserve({
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId: runId('utc-rollover'),
    executionId: randomUUID(),
    now: secondDay,
  });
  assert.equal(rollover.usageDate.toISOString(), secondDay.toISOString());
  assert.equal((await readBudget(secondDay)).reservedCostUsd.toFixed(8), '0.10000000');
});

test('FIX-TOKEN reserve retries reuse persisted server-derived dates', async () => {
  const operationRunId = runId('server-derived-idempotency');
  const executionId = randomUUID();
  const input = {
    provider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId,
    executionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    isFallback: false,
  };

  const first = await service.reserve({ ...input, now: seventhDay });
  const repeated = await service.reserve({
    ...input,
    now: new Date(seventhDay.getTime() + 5),
  });

  assert.equal(repeated.id, first.id);
  assert.equal(repeated.usageDate.toISOString(), first.usageDate.toISOString());
  assert.equal(
    repeated.reservationExpiresAt.toISOString(),
    first.reservationExpiresAt.toISOString(),
  );
  await settleLuna(first);
});

test('FIX-TOKEN derived expiry starts after a blocking daily-budget wait', async () => {
  const operationRunId = runId('derived-expiry-after-lock');
  const executionId = randomUUID();
  const usageDate = new Date();
  usageDate.setUTCHours(0, 0, 0, 0);
  await prisma.assistantAiDailyBudget.upsert({
    where: { provider_usageDate: { provider: expiryProvider, usageDate } },
    create: {
      provider: expiryProvider,
      usageDate,
      budgetLimitUsd: '0.30000000',
      reservedCostUsd: '0.00000000',
      settledCostUsd: '0.00000000',
    },
    update: {
      budgetLimitUsd: '0.30000000',
      reservedCostUsd: '0.00000000',
      settledCostUsd: '0.00000000',
    },
  });
  const locked = deferred();
  const release = deferred();
  const blocker = prisma.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw`
      SELECT "provider"
      FROM "assistant_ai_daily_budgets"
      WHERE "provider" = ${expiryProvider} AND "usage_date" = ${usageDate}
      FOR UPDATE
    `;
    assert.equal(rows.length, 1);
    locked.resolve();
    await release.promise;
  });
  await locked.promise;

  const reserveStartedAt = Date.now();
  const reservePromise = service.reserve({
    provider: expiryProvider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId,
    executionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    isFallback: false,
    providerTimeoutMs: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const lockReleasedAt = Date.now();
  release.resolve();
  const reservation = await reservePromise;
  await blocker;

  assert.ok(lockReleasedAt - reserveStartedAt >= 900);
  assert.ok(
    reservation.reservationExpiresAt.getTime() - lockReleasedAt >= 64_500,
    'derived expiry must retain timeout, grace and safety after lock wait',
  );
  await settleLuna(reservation);
});

test('FIX-TOKEN reserve rejects a mismatched explicit expiry', async () => {
  const operationRunId = runId('explicit-expiry-conflict');
  const executionId = randomUUID();
  const reservationExpiresAt = new Date(eighthDay.getTime() + 300_000);
  const input = {
    provider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId,
    executionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    isFallback: false,
    reservationExpiresAt,
    now: eighthDay,
  };
  const first = await service.reserve(input);

  await assert.rejects(
    service.reserve({
      ...input,
      reservationExpiresAt: new Date(reservationExpiresAt.getTime() + 1),
    }),
    (error) => error.code === 'ASSISTANT_AI_ATTEMPT_CONFLICT',
  );
  await settleLuna(first);
});

test('FIX-TOKEN rejects a delayed reserve from an execution fenced by recovery', async () => {
  const operationRunId = runId('delayed-old-execution');
  const oldExecutionId = randomUUID();
  const nextExecutionId = randomUUID();
  const recoveryNow = new Date(fifthDay.getTime() + 60_000);
  const expiredAt = new Date(recoveryNow.getTime() - 1);
  await service.reserve({
    provider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId,
    executionId: oldExecutionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    reservationExpiresAt: expiredAt,
    now: new Date(recoveryNow.getTime() - 10_000),
  });

  await service.reconcileExpiredReservations({
    operationRunId,
    executionId: nextExecutionId,
    now: recoveryNow,
  });

  await assert.rejects(
    service.reserve({
      provider,
      model: 'gpt-5.6-terra',
      operation: 'PLANNER',
      operationRunId,
      executionId: oldExecutionId,
      attemptOrdinal: 2,
      dailyBudgetUsd: '0.30000000',
      reservedCostUsd: '0.10000000',
      reasoningEffort: 'medium',
      promptVersion: 'test-prompt-v1',
      validatorVersion: 'test-validator-v1',
      isFallback: true,
      now: recoveryNow,
    }),
    (error) => error.code === 'ASSISTANT_AI_EXECUTION_STALE',
  );

  const next = await service.reserve({
    provider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId,
    executionId: nextExecutionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    now: recoveryNow,
  });
  assert.equal(next.executionId, nextExecutionId);
});

test('FIX-TOKEN reconciliation evaluates expiry after waiting for the attempt lock', async () => {
  const operationRunId = runId('reconcile-expiry-after-lock');
  const executionId = randomUUID();
  const nextExecutionId = randomUUID();
  const reservationExpiresAt = new Date(Date.now() + 1_000);
  const reservation = await service.reserve({
    provider: reconcileProvider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId,
    executionId,
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.30000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    isFallback: false,
    reservationExpiresAt,
  });
  const locked = deferred();
  const release = deferred();
  const blocker = prisma.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw`
      SELECT "id"
      FROM "assistant_ai_usage_attempts"
      WHERE "id" = CAST(${reservation.id} AS uuid)
      FOR UPDATE
    `;
    assert.equal(rows.length, 1);
    locked.resolve();
    await release.promise;
  });
  await locked.promise;

  const reconciliation = service.reconcileExpiredReservations({
    operationRunId,
    executionId: nextExecutionId,
  });
  await new Promise((resolve) => setTimeout(
    resolve,
    Math.max(0, reservationExpiresAt.getTime() - Date.now() + 300),
  ));
  release.resolve();

  assert.equal(await reconciliation, 1);
  await blocker;
  const attempt = await prisma.assistantAiUsageAttempt.findUniqueOrThrow({
    where: { id: reservation.id },
    select: { status: true, outcome: true, chargedCostUsd: true },
  });
  assert.equal(attempt.status, 'SETTLED');
  assert.equal(attempt.outcome, 'UNKNOWN_AFTER_CRASH');
  assert.equal(attempt.chargedCostUsd.toFixed(8), '0.10000000');
});

test('FIX-TOKEN migration keeps a fail-closed compatibility path for the previous writer', async () => {
  const operationRunId = runId('legacy-writer');
  const usageDate = sixthDay;
  const firstAttemptId = randomUUID();
  const duplicateAttemptId = randomUUID();

  const insertWithPreviousWriter = (transaction, attemptId) => transaction.$queryRaw`
      INSERT INTO "assistant_ai_usage_attempts" (
        "id", "operation_run_id", "attempt_ordinal", "operation", "provider",
        "requested_model", "reasoning_effort", "prompt_version", "validator_version",
        "is_fallback", "status", "pricing_catalog_version", "pricing_status",
        "reserved_cost_usd", "usage_date"
      ) VALUES (
        CAST(${attemptId} AS uuid), ${operationRunId}, 1, 'PLANNER', ${provider},
        'gpt-5.6-luna', 'medium', 'legacy-prompt-v1', 'legacy-validator-v1',
        false, 'RESERVED', 'openai-standard-pricing-2026-08-27', 'RESERVED',
        CAST('0.01000000' AS numeric), ${usageDate}
      )
      ON CONFLICT ("operation_run_id", "attempt_ordinal") DO NOTHING
      RETURNING "id"
    `;

  let legacyTransactionReadyAt = 0;
  await prisma.$transaction(async (transaction) => {
    const inserted = await insertWithPreviousWriter(transaction, firstAttemptId);
    assert.equal(inserted.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await transaction.$executeRaw`
      INSERT INTO "assistant_ai_daily_budgets" (
        "provider", "usage_date", "budget_limit_usd", "reserved_cost_usd"
      ) VALUES (${provider}, ${usageDate}, CAST('0.30000000' AS numeric), CAST('0.01000000' AS numeric))
      ON CONFLICT ("provider", "usage_date") DO UPDATE SET
        "reserved_cost_usd" = "assistant_ai_daily_budgets"."reserved_cost_usd"
          + EXCLUDED."reserved_cost_usd"
    `;
    legacyTransactionReadyAt = Date.now();
  });

  const legacy = await prisma.assistantAiUsageAttempt.findUniqueOrThrow({
    where: { id: firstAttemptId },
    select: {
      executionId: true,
      reservationExpiresAt: true,
      dailyBudgetUsd: true,
    },
  });
  assert.match(legacy.executionId, /^[0-9a-f-]{36}$/u);
  assert.ok(legacy.reservationExpiresAt > new Date());
  assert.ok(
    legacy.reservationExpiresAt.getTime() - legacyTransactionReadyAt >= 239_500,
    'legacy expiry must be refreshed at the end of its transaction',
  );
  assert.equal(legacy.dailyBudgetUsd, null);

  assert.deepEqual(await insertWithPreviousWriter(prisma, duplicateAttemptId), []);
});

test('FIX-TOKEN records an actual charge above reserve without hiding the overage', async () => {
  const reservation = await service.reserve({
    provider,
    model: 'gpt-5.6-terra',
    operation: 'SOURCE_DISCOVERY',
    operationRunId: runId('reserve-exceeded'),
    executionId: randomUUID(),
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
    select: {
      pricingStatus: true,
      reservedCostUsd: true,
      chargedCostUsd: true,
    },
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
  const budget = await readBudget(oldReservation.usageDate);
  assert.equal(budget.reservedCostUsd.toFixed(8), '0.00000000');
  assert.equal(budget.settledCostUsd.toFixed(8), '0.10002890');
});

test('FIX-TOKEN defers a recovered AssistantRun while its previous provider reservation is active', async () => {
  const fixture = await createExpiredAssistantRun();
  assistantFixtures.push(fixture);
  const reservationExpiresAt = new Date(Date.now() + 120_000);
  const reservation = await service.reserve({
    provider,
    model: 'gpt-5.6-luna',
    operation: 'PLANNER',
    operationRunId: fixture.run.id,
    executionId: randomUUID(),
    attemptOrdinal: 1,
    dailyBudgetUsd: '0.50000000',
    reservedCostUsd: '0.10000000',
    reasoningEffort: 'medium',
    promptVersion: 'test-prompt-v1',
    validatorVersion: 'test-validator-v1',
    reservationExpiresAt,
  });
  let answerCalls = 0;
  const processor = new AssistantRunProcessor(prisma, {
    async answer() {
      answerCalls += 1;
      throw new Error('active reservation must defer the run');
    },
  }, service);

  let deferredRun;
  try {
    await processor.onModuleInit();
    deferredRun = await waitForDeferredRun(fixture.run.id, reservationExpiresAt);
  } finally {
    await processor.onModuleDestroy();
  }

  assert.equal(answerCalls, 0);
  assert.equal(deferredRun.status, 'RUNNING');
  assert.equal(deferredRun.leaseExpiresAt.toISOString(), reservationExpiresAt.toISOString());
  const attempt = await prisma.assistantAiUsageAttempt.findUniqueOrThrow({
    where: { id: reservation.id },
    select: { status: true, chargedCostUsd: true, settledAt: true },
  });
  assert.equal(attempt.status, 'RESERVED');
  assert.equal(attempt.chargedCostUsd, null);
  assert.equal(attempt.settledAt, null);
});

test('FIX-TOKEN keeps provider/day budget atomic while settlement races reconciliation', async () => {
  assert.equal(await prisma.assistantAiDailyBudget.findUnique({
    where: { provider_usageDate: { provider, usageDate: fourthDay } },
    select: { provider: true },
  }), null);
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

  assert.equal(
    fulfilled.length,
    6,
    JSON.stringify(rejected.map(({ reason }) => reason?.code ?? reason?.message)),
  );
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
  const beforeRaceBudget = await readBudget(fourthDay);
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
  const recoveryExecutionId = randomUUID();
  const settlementRace = await Promise.allSettled([
    settleLuna(target.reservation),
    ...Array.from({ length: 4 }, () => service.reconcileExpiredReservations({
      operationRunId: target.input.operationRunId,
      executionId: recoveryExecutionId,
      now: reconciliationNow,
    })),
  ]);
  assert.equal(settlementRace.every(({ status }) => status === 'fulfilled'), true);

  const settledAttempt = await readAttemptSnapshot(target.reservation.id);
  const chargedCostUsd = settledAttempt.chargedCostUsd.toFixed(8);
  assert.equal(['0.00002890', '0.05000000'].includes(chargedCostUsd), true);
  assert.equal(['ACCEPTED', 'UNKNOWN_AFTER_CRASH'].includes(settledAttempt.outcome), true);
  const afterRaceBudget = await readBudget(fourthDay);
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
      executionId: recoveryExecutionId,
      now: reconciliationNow,
    }),
    service.reconcileExpiredReservations({
      operationRunId: target.input.operationRunId,
      executionId: recoveryExecutionId,
      now: reconciliationNow,
    }),
  ]);
  assert.equal(repeated.every(({ status }) => status === 'fulfilled'), true);
  assert.deepEqual(
    serializeAttemptSnapshot(await readAttemptSnapshot(target.reservation.id)),
    immutableAttempt,
  );
  assert.deepEqual(serializeBudgetSnapshot(await readBudget(fourthDay)), immutableBudget);
});

async function createExpiredAssistantRun() {
  const fixtureSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const role = await prisma.role.create({
    data: { name: `fix-token-${suffix}-${fixtureSuffix}` },
  });
  const user = await prisma.user.create({
    data: {
      email: `fix-token-${suffix}-${fixtureSuffix}@example.test`,
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

async function waitForDeferredRun(runIdValue, reservationExpiresAt) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await prisma.assistantRun.findUniqueOrThrow({
      where: { id: runIdValue },
      select: { status: true, leaseOwner: true, leaseExpiresAt: true },
    });
    if (run.status === 'RUNNING'
      && run.leaseOwner
      && run.leaseExpiresAt?.getTime() === reservationExpiresAt.getTime()) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('FIX_TOKEN_ASSISTANT_RUN_DEFER_TIMEOUT');
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

function reserve({ model, operation, operationRunId, executionId, now }) {
  return service.reserve({
    provider,
    model,
    operation,
    operationRunId,
    executionId,
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

function explainPlanText(rows) {
  assert.equal(rows.length, 1);
  const plan = rows[0]['QUERY PLAN'];
  assert.ok(plan);
  return JSON.stringify(plan);
}
