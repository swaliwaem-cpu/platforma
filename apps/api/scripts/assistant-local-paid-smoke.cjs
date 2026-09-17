#!/usr/bin/env node

'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { mapAssistantProductSubmission } = require('@platforma/shared/assistant-product-submission');

const {
  addAssistantUsd,
  estimateAssistantAiCallCost,
  formatAssistantUsd,
  parseAssistantUsd,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  createAssistantPlannerRequestBody,
} = require('../dist/assistant/assistant-planner-gateway.js');
const {
  ASSISTANT_LUNA_MODEL,
  ASSISTANT_TERRA_MODEL,
} = require('../dist/assistant/assistant-query-planner.js');
const {
  readAssistantPaidProviderReadiness,
} = require('../dist/assistant/operations/assistant-paid-readiness.js');

const smokeName = 'assistant-local-paid-smoke-v1';
const canaryLimits = Object.freeze({
  userRequests: 2,
  modelAttempts: 4,
  maximumCostUsd: '0.50000000',
});
const canaryCases = Object.freeze([
  {
    id: 'structured_search',
    content: 'Найди 2-комнатную квартиру до 25 млн рублей в районе Хамовники.',
  },
  {
    id: 'mortgage_installment',
    content: 'Сравни ипотеку и рассрочку для квартиры до 30 млн рублей с первоначальным взносом 20%.',
  },
]);
const terminalRunStatuses = new Set(['COMPLETED', 'FAILED']);
const maximumPolls = 240;
const maximumTotalDurationMs = 5 * 60_000;
const apiRequestTimeoutMs = 10_000;
const ledgerOperationTimeoutMs = 10_000;
const maximumIdempotentPostAttempts = 3;
const recoveryPollsPerAttempt = 3;
const maximumApiResponseBytes = 1 * 1_024 * 1_024;

async function runAssistantLocalPaidSmoke(input = {}) {
  const argv = input.argv ?? process.argv.slice(2);
  if (!argv.includes('--live')) {
    if (argv.length > 0) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ARGUMENT_INVALID');
    }
    return {
      smoke: smokeName,
      mode: 'DRY_RUN',
      passed: true,
      limits: canaryLimits,
      providerCalls: 0,
    };
  }
  const environment = input.environment ?? process.env;
  const lifecycle = { ledger: null, disconnectAttempted: false };
  try {
    return await runLiveAssistantLocalPaidSmoke(input, environment, lifecycle);
  } finally {
    delete environment.ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN;
    if (lifecycle.ledger !== null && !lifecycle.disconnectAttempted) {
      try {
        await runBounded(
          () => lifecycle.ledger.disconnect?.(),
          Date.now() + ledgerOperationTimeoutMs,
          ledgerOperationTimeoutMs,
          'ASSISTANT_LOCAL_PAID_SMOKE_DISCONNECT_FAILED',
        );
      } catch {
        // Preserve the primary initialization/runtime failure.
      }
    }
  }
}

async function runLiveAssistantLocalPaidSmoke(input, environment, lifecycle) {
  const argv = input.argv ?? process.argv.slice(2);
  const limits = readLiveLimits(argv);
  const runtime = input.runtime ?? readApiRuntime();
  const readiness = readAssistantLocalPaidSmokeReadiness(
    runtime.apiEnvironment ?? {},
    environment,
    runtime,
    limits,
  );
  if (!readiness.passed) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_READINESS_FAILED');
  }
  const operationTimeoutMs = readInternalOperationTimeout(input.operationTimeoutMs);
  lifecycle.ledger = input.ledger ?? createDefaultLedger(runtime.apiEnvironment, operationTimeoutMs);
  const ledger = lifecycle.ledger;
  const api = input.api ?? createLoopbackApi(runtime.apiEnvironment, input.fetchImpl ?? fetch);
  const sleep = input.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const conversationIds = [];
  const runRecords = [];
  let maximumEstimatedCostUsd = null;
  let failureCode = null;
  let ledgerErrorCode = null;
  let cleanupErrorCode = null;
  const totalDeadline = Date.now() + maximumTotalDurationMs;
  const finalizationReserveMs = Math.min(30_000, operationTimeoutMs * 3);
  const workDeadline = totalDeadline - finalizationReserveMs;

  try {
    let ledgerReadiness;
    try {
      ledgerReadiness = await runBounded(
        () => ledger.inspectReadiness(),
        workDeadline,
        operationTimeoutMs,
        'ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED',
      );
    } catch {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED');
    }
    if (!isNonNegativeInteger(ledgerReadiness?.pendingOrRunningRuns)
      || !isNonNegativeInteger(ledgerReadiness?.reservedAttempts)) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED');
    }
    if (ledgerReadiness.pendingOrRunningRuns > 0) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_BACKLOG_NOT_EMPTY');
    }
    if (ledgerReadiness.reservedAttempts > 0) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_UNFINISHED');
    }
    maximumEstimatedCostUsd = estimateCanaryMaximumCostUsd();
    if (parseAssistantUsd(maximumEstimatedCostUsd) > parseAssistantUsd(limits.maximumCostUsd)) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ESTIMATE_EXCEEDS_CAP');
    }
    if (typeof api.resolveGeo !== 'function') {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_GEO_RESOLVER_REQUIRED');
    }
    const accessToken = readAccessToken(environment);
    const config = await callApi(
      () => api.checkConfig({ accessToken }),
      workDeadline,
      operationTimeoutMs,
    );
    if (config?.enabled !== true) throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ACTOR_NOT_ENABLED');

    for (const smokeCase of canaryCases) {
      assertWithinDeadline(workDeadline);
      const resolution = await callApi(
        () => api.resolveGeo({ accessToken, content: smokeCase.content, caseId: smokeCase.id }),
        workDeadline,
        operationTimeoutMs,
      );
      const preparedBody = prepareAssistantProductSubmission(smokeCase.content, resolution);
      const conversationKey = randomUUID();
      const created = await callApiWithRecovery(
        async () => {
          const value = await api.createConversation({
            accessToken,
            idempotencyKey: conversationKey,
            caseId: smokeCase.id,
          });
          return { conversationId: requireUuid(value?.conversationId) };
        },
        () => ledger.recoverConversation?.(conversationKey),
        { deadline: workDeadline, operationTimeoutMs, sleep },
      );
      const conversationId = requireUuid(created?.conversationId);
      if (conversationIds.includes(conversationId)) {
        throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_CONVERSATION_ID_REUSED');
      }
      conversationIds.push(conversationId);
      const runKey = randomUUID();
      const runRecord = {
        caseId: smokeCase.id,
        idempotencyKey: runKey,
        runId: null,
        status: null,
        errorCode: null,
      };
      runRecords.push(runRecord);
      const started = await callApiWithRecovery(
        async () => {
          const value = await api.startRun({
            accessToken,
            conversationId,
            idempotencyKey: runKey,
            caseId: smokeCase.id,
            body: preparedBody,
          });
          return {
            runId: requireUuid(value?.runId),
            status: readRunStatus(value?.status),
          };
        },
        () => ledger.recoverRun?.(runKey),
        { deadline: workDeadline, operationTimeoutMs, sleep },
      );
      const runId = requireUuid(started?.runId);
      runRecord.runId = runId;
      runRecord.status = readRunStatus(started?.status);
      if (runRecords.some((record) => record !== runRecord && record.runId === runId)) {
        throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_RUN_ID_REUSED');
      }
      const terminal = await waitForTerminalRun(api, {
        accessToken,
        runId,
        initialStatus: started?.status,
        sleep,
        deadline: workDeadline,
        operationTimeoutMs,
      });
      runRecord.status = terminal.status;
      runRecord.errorCode = readSafeCode(terminal.errorCode);
      if (terminal.status !== 'COMPLETED') {
        throw new Error(readSafeCode(terminal.errorCode) ?? 'ASSISTANT_LOCAL_PAID_SMOKE_RUN_FAILED');
      }
      const settledAttempts = await waitForSettledAttempts(
        ledger,
        [runId],
        sleep,
        workDeadline,
        operationTimeoutMs,
      );
      assertPaidSmokeRunCoverage(settledAttempts, [runId]);
      assertPaidSmokeLedger(summarizePaidSmokeAttempts(settledAttempts), limits);
    }
  } catch (error) {
    failureCode = normalizeSmokeError(error).message;
  }

  let unresolvedRuns = 0;
  for (const record of runRecords.filter(({ runId }) => runId === null)) {
    try {
      const recovered = await recoverPersistedValue(
        () => ledger.recoverRun?.(record.idempotencyKey),
        { deadline: totalDeadline, operationTimeoutMs, sleep },
      );
      if (!recovered) {
        unresolvedRuns += 1;
        continue;
      }
      record.runId = requireUuid(recovered.runId);
      record.status = readRunStatus(recovered.status);
    } catch {
      unresolvedRuns += 1;
      ledgerErrorCode = 'ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED';
    }
  }

  const runIds = runRecords.flatMap(({ runId }) => runId === null ? [] : [runId]);
  const nonTerminalRuns = runRecords.filter(({ runId, status }) => (
    runId !== null && !terminalRunStatuses.has(status)
  )).length;
  let ledgerSummary = null;
  if (runRecords.length > 0 && unresolvedRuns === 0) {
    try {
      const finalAttempts = await loadAttempts(
        ledger,
        runIds,
        totalDeadline,
        operationTimeoutMs,
      );
      ledgerSummary = summarizePaidSmokeAttempts(finalAttempts);
      try {
        assertPaidSmokeRunCoverage(finalAttempts, runIds);
        assertPaidSmokeLedger(ledgerSummary, limits);
      } catch (error) {
        ledgerErrorCode = normalizeSmokeError(error).message;
      }
    } catch {
      ledgerErrorCode = 'ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED';
    }
  } else if (unresolvedRuns > 0) {
    ledgerErrorCode = 'ASSISTANT_LOCAL_PAID_SMOKE_RUN_ID_UNRESOLVED';
  }

  try {
    await runBounded(
      () => ledger.cleanupConversations?.([...conversationIds]),
      totalDeadline,
      operationTimeoutMs,
      'ASSISTANT_LOCAL_PAID_SMOKE_CLEANUP_FAILED',
    );
  } catch {
    cleanupErrorCode = 'ASSISTANT_LOCAL_PAID_SMOKE_CLEANUP_FAILED';
  }
  try {
    await runBounded(
      () => {
        lifecycle.disconnectAttempted = true;
        return ledger.disconnect?.();
      },
      totalDeadline,
      operationTimeoutMs,
      'ASSISTANT_LOCAL_PAID_SMOKE_DISCONNECT_FAILED',
    );
  } catch {
    cleanupErrorCode ??= 'ASSISTANT_LOCAL_PAID_SMOKE_DISCONNECT_FAILED';
  }

  if (runRecords.length === 0) {
    throw new Error(failureCode ?? ledgerErrorCode ?? cleanupErrorCode
      ?? 'ASSISTANT_LOCAL_PAID_SMOKE_FAILED');
  }

  const errorCode = ledgerErrorCode === 'ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED'
    || ledgerErrorCode === 'ASSISTANT_LOCAL_PAID_SMOKE_RUN_ID_UNRESOLVED'
    ? ledgerErrorCode
    : failureCode ?? ledgerErrorCode ?? cleanupErrorCode;
  const passed = errorCode === null
    && cleanupErrorCode === null
    && runRecords.length === limits.userRequests
    && runRecords.every(({ status }) => status === 'COMPLETED');
  const ledgerFinal = ledgerSummary !== null
    && unresolvedRuns === 0
    && nonTerminalRuns === 0;
  return {
    smoke: smokeName,
    mode: 'LIVE',
    passed,
    errorCode,
    ledgerErrorCode,
    cleanupErrorCode,
    limits: canaryLimits,
    maximumEstimatedCostUsd,
    providerCalls: ledgerFinal ? ledgerSummary.attempts : null,
    readiness: readiness.effective,
    results: runRecords.flatMap((record) => record.runId === null ? [] : [{
      caseId: record.caseId,
      runId: record.runId,
      status: record.status,
      errorCode: record.errorCode,
    }]),
    unresolvedRuns,
    nonTerminalRuns,
    ledgerFinal,
    ledger: ledgerSummary ?? {
      status: 'UNAVAILABLE',
      errorCode: ledgerErrorCode ?? 'ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED',
    },
    cleanup: {
      processResourcesReleased: cleanupErrorCode === null,
      conversationDataRetainedInDisposableDatabase: true,
    },
  };
}

async function waitForTerminalRun(api, input) {
  let status = readRunStatus(input.initialStatus);
  let latest = { runId: input.runId, status, errorCode: null };
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    assertWithinDeadline(input.deadline);
    if (terminalRunStatuses.has(status)) return latest;
    latest = await callApi(
      () => api.getRun({
        accessToken: input.accessToken,
        runId: input.runId,
      }),
      input.deadline,
      input.operationTimeoutMs,
    );
    if (latest?.runId !== input.runId) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_RUN_RESPONSE_INVALID');
    }
    status = readRunStatus(latest.status);
    if (!terminalRunStatuses.has(status)) {
      await sleepBounded(input.sleep, 500, input.deadline, input.operationTimeoutMs);
    }
  }
  throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_RUN_TIMEOUT');
}

async function waitForSettledAttempts(ledger, runIds, sleep, deadline, operationTimeoutMs) {
  let attempts = [];
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    assertWithinDeadline(deadline);
    attempts = await loadAttempts(ledger, runIds, deadline, operationTimeoutMs);
    if (attempts.length > 0 && attempts.every(({ status }) => status === 'SETTLED')) {
      return attempts;
    }
    if (poll + 1 < maximumPolls) {
      await sleepBounded(sleep, 500, deadline, operationTimeoutMs);
    }
  }
  if (attempts.some(({ status }) => status === 'RESERVED')) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_UNSETTLED');
  }
  throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_EMPTY');
}

async function loadAttempts(ledger, runIds, deadline, operationTimeoutMs) {
  try {
    const attempts = await runBounded(
      () => ledger.loadAttempts(runIds),
      deadline,
      operationTimeoutMs,
      'ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED',
    );
    if (!Array.isArray(attempts)) throw new Error('invalid');
    return attempts;
  } catch {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED');
  }
}

function summarizePaidSmokeAttempts(attempts) {
  let effectiveCost = 0n;
  let webSearchCalls = 0;
  let reservedAttempts = 0;
  let unknownWebSearchAttempts = 0;
  const identities = new Set();
  for (const attempt of attempts) {
    if (!attempt || attempt.operation !== 'PLANNER'
      || (attempt.requestedModel !== ASSISTANT_LUNA_MODEL
        && attempt.requestedModel !== ASSISTANT_TERRA_MODEL)
      || !Number.isSafeInteger(attempt.attemptOrdinal)
      || attempt.attemptOrdinal < 1
      || typeof attempt.operationRunId !== 'string'
      || typeof attempt.executionId !== 'string') {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_INVALID');
    }
    const identity = `${attempt.operationRunId}\0${attempt.executionId}\0${attempt.attemptOrdinal}`;
    if (identities.has(identity)) throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_INVALID');
    identities.add(identity);
    if (isNonNegativeInteger(attempt.webSearchCalls)) webSearchCalls += attempt.webSearchCalls;
    else unknownWebSearchAttempts += 1;
    if (attempt.status === 'SETTLED'
      && attempt.chargedCostUsd !== null
      && attempt.chargedCostUsd !== undefined) {
      effectiveCost += readPersistedUsd(attempt.chargedCostUsd);
    } else {
      reservedAttempts += 1;
      effectiveCost += readPersistedUsd(attempt.reservedCostUsd);
    }
  }
  return {
    attempts: attempts.length,
    effectiveCostUsd: formatAssistantUsd(effectiveCost),
    webSearchCalls,
    reservedAttempts,
    unknownWebSearchAttempts,
  };
}

function assertPaidSmokeRunCoverage(attempts, runIds) {
  const expectedRunIds = new Set(runIds);
  if (expectedRunIds.size !== runIds.length) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_RUN_ID_REUSED');
  }
  const coveredRunIds = new Set();
  for (const attempt of attempts) {
    if (!attempt || !expectedRunIds.has(attempt.operationRunId)) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_RUN_COVERAGE_INVALID');
    }
    coveredRunIds.add(attempt.operationRunId);
  }
  if (coveredRunIds.size !== expectedRunIds.size) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_RUN_COVERAGE_INVALID');
  }
}

function assertPaidSmokeLedger(summary, limits) {
  if (summary.attempts > limits.modelAttempts) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ATTEMPT_LIMIT_EXCEEDED');
  }
  if (parseAssistantUsd(summary.effectiveCostUsd) > parseAssistantUsd(limits.maximumCostUsd)) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_COST_LIMIT_EXCEEDED');
  }
  if (summary.webSearchCalls !== 0) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_WEB_SEARCH_FORBIDDEN');
  }
  if (summary.unknownWebSearchAttempts !== 0) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_WEB_SEARCH_UNKNOWN');
  }
  if (summary.reservedAttempts !== 0) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_UNSETTLED');
  }
}

function readAssistantLocalPaidSmokeReadiness(apiEnvironment, cliEnvironment, runtime, limits) {
  const provider = readAssistantPaidProviderReadiness(apiEnvironment);
  const blockers = provider.missing.map((name) => `MISSING_${name}`);
  const effective = provider.effective;

  if (effective.aiMode !== 'alibaba') blockers.push('ASSISTANT_AI_MODE_ALIBABA_REQUIRED');
  if (effective.requestsPerMinute === null || effective.requestsPerMinute > 2) {
    blockers.push('ASSISTANT_MODEL_REQUESTS_PER_MINUTE_TOO_HIGH');
  }
  if (effective.requestsPerDay !== 2) {
    blockers.push('ASSISTANT_MODEL_REQUESTS_PER_DAY_MUST_EQUAL_TWO');
  }
  if (effective.dailyBudgetUsd === null
    || parseAssistantUsd(effective.dailyBudgetUsd) > parseAssistantUsd(limits.maximumCostUsd)) {
    blockers.push('ASSISTANT_MODEL_DAILY_BUDGET_EXCEEDS_SMOKE_CAP');
  }
  if (!runtime.isContainer) blockers.push('ASSISTANT_LOCAL_PAID_SMOKE_CONTAINER_REQUIRED');
  if (!runtime.isApiProcess) blockers.push('ASSISTANT_LOCAL_PAID_SMOKE_API_PROCESS_REQUIRED');
  if (apiEnvironment.NODE_ENV === 'production'
    || apiEnvironment.DEPLOYMENT_ENV === 'production'
    || apiEnvironment.DEPLOYMENT_ENV === 'staging') {
    blockers.push('ASSISTANT_LOCAL_PAID_SMOKE_PRODUCTION_FORBIDDEN');
  }
  if (apiEnvironment.ASSISTANT_MODULE_ENABLED !== 'true') {
    blockers.push('ASSISTANT_MODULE_ENABLED_REQUIRED');
  }
  if (!isOfficialAlibabaBaseUrl(apiEnvironment.ASSISTANT_ALIBABA_BASE_URL)) {
    blockers.push('ASSISTANT_ALIBABA_BASE_URL_INVALID');
  }
  if (!isDisposableDatabaseUrl(apiEnvironment.DATABASE_URL)
    || apiEnvironment.ASSISTANT_LOCAL_PAID_SMOKE_DISPOSABLE_DB !== 'true') {
    blockers.push('ASSISTANT_LOCAL_PAID_SMOKE_DISPOSABLE_DB_REQUIRED');
  }
  const embeddingMode = (apiEnvironment.ASSISTANT_EMBEDDING_MODE ?? 'disabled')
    .trim().toLocaleLowerCase('en-US');
  if (embeddingMode !== 'disabled' && embeddingMode !== 'fake') {
    blockers.push('ASSISTANT_LOCAL_PAID_SMOKE_EMBEDDINGS_FORBIDDEN');
  }
  if (apiEnvironment.ASSISTANT_EMBEDDING_LIVE !== 'false') {
    blockers.push('ASSISTANT_EMBEDDING_LIVE_MUST_BE_FALSE');
  }
  for (const name of [
    'ASSISTANT_GEO_PROVIDER_ENABLED',
    'ASSISTANT_OVERPASS_ENABLED',
    'ASSISTANT_EXTERNAL_CONNECTORS_ENABLED',
    'ASSISTANT_SOURCE_WORKER_ENABLED',
    'ASSISTANT_SOURCE_BROWSER_FALLBACK_ENABLED',
    'FEED_AUTO_IMPORT_ENABLED',
    'TRAINING_MODULE_ENABLED',
    'TRAINING_VOICE_WORKER_ENABLED',
    'TRAINING_MATERIAL_WORKER_ENABLED',
    'TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED',
  ]) {
    if (apiEnvironment[name] !== 'false') blockers.push(`${name}_MUST_BE_FALSE`);
  }
  if ((apiEnvironment.ASSISTANT_GEO_PROVIDER_MODE ?? 'fake') !== 'fake') {
    blockers.push('ASSISTANT_GEO_PROVIDER_MODE_MUST_BE_FAKE');
  }
  if ((apiEnvironment.TRAINING_AI_MODE ?? 'fake') !== 'fake') {
    blockers.push('TRAINING_AI_MODE_MUST_BE_FAKE');
  }
  if ((apiEnvironment.TELEGRAM_TRANSPORT_MODE ?? 'fake') !== 'fake') {
    blockers.push('TELEGRAM_TRANSPORT_MODE_MUST_BE_FAKE');
  }
  if (!hasAccessTokenSource(cliEnvironment)) {
    blockers.push('ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN_REQUIRED');
  }

  return {
    passed: blockers.length === 0,
    blockers: [...new Set(blockers)],
    effective: {
      ...effective,
      embeddingMode,
      localDisposableDatabase: isDisposableDatabaseUrl(apiEnvironment.DATABASE_URL),
      apiRuntimeVerified: runtime.isContainer === true && runtime.isApiProcess === true,
    },
  };
}

function estimateCanaryMaximumCostUsd() {
  const costs = [];
  for (const smokeCase of canaryCases) {
    for (const [attemptOrdinal, model, reasoningEffort] of [
      [1, ASSISTANT_LUNA_MODEL, 'high'],
      [2, ASSISTANT_TERRA_MODEL, 'medium'],
    ]) {
      const body = createAssistantPlannerRequestBody({
        model,
        reasoningEffort,
        messages: [smokeCase.content],
        context: null,
        operationRunId: '10000000-0000-4000-8000-000000000001',
        executionId: '20000000-0000-4000-8000-000000000001',
        attemptOrdinal,
      });
      const estimate = estimateAssistantAiCallCost({
        model,
        requestBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
        maxOutputTokens: 2_500,
        maxWebSearchCalls: 0,
      });
      if (estimate.status !== 'PRICED' || estimate.estimatedUsd === null) {
        throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ESTIMATE_UNPRICED');
      }
      costs.push(estimate.estimatedUsd);
    }
  }
  return addAssistantUsd(costs);
}

function createDefaultLedger(apiEnvironment, operationTimeoutMs) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({
    datasources: {
      db: { url: createBoundedDatabaseUrl(apiEnvironment.DATABASE_URL, operationTimeoutMs) },
    },
  });
  return {
    async inspectReadiness() {
      const [pendingOrRunningRuns, reservedAttempts] = await Promise.all([
        prisma.assistantRun.count({ where: { status: { in: ['PENDING', 'RUNNING'] } } }),
        prisma.assistantAiUsageAttempt.count({
          where: {
            OR: [
              { status: 'RESERVED' },
              { status: 'SETTLED', chargedCostUsd: null },
            ],
          },
        }),
      ]);
      return { pendingOrRunningRuns, reservedAttempts };
    },
    async recoverConversation(creationKey) {
      const rows = await prisma.assistantConversation.findMany({
        where: { creationKey },
        select: { id: true },
        take: 2,
      });
      return rows.length === 1 ? { conversationId: rows[0].id } : null;
    },
    async recoverRun(idempotencyKey) {
      const rows = await prisma.assistantRun.findMany({
        where: { idempotencyKey },
        select: { id: true, status: true },
        take: 2,
      });
      return rows.length === 1 ? { runId: rows[0].id, status: rows[0].status } : null;
    },
    async loadAttempts(runIds) {
      return prisma.assistantAiUsageAttempt.findMany({
        where: { operationRunId: { in: runIds } },
        orderBy: [
          { operationRunId: 'asc' },
          { executionId: 'asc' },
          { attemptOrdinal: 'asc' },
        ],
        select: {
          operationRunId: true,
          executionId: true,
          attemptOrdinal: true,
          operation: true,
          requestedModel: true,
          status: true,
          reservedCostUsd: true,
          chargedCostUsd: true,
          webSearchCalls: true,
        },
      });
    },
    async cleanupConversations() {
      // The disposable database is retained until the ledger report is complete;
      // stack-level cleanup removes it without racing the run processor.
    },
    async disconnect() { await prisma.$disconnect(); },
  };
}

function createLoopbackApi(apiEnvironment, fetchImpl) {
  const port = readPort(apiEnvironment.PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = (path, input) => requestBoundedJson(fetchImpl, `${baseUrl}${path}`, input);
  return {
    async checkConfig({ accessToken }) {
      return request('/assistant/config', { accessToken, method: 'GET', expectedStatuses: [200] });
    },
    async createConversation({ accessToken, idempotencyKey }) {
      const payload = await request('/assistant/conversations', {
        accessToken,
        idempotencyKey,
        method: 'POST',
        expectedStatuses: [200, 201],
      });
      return { conversationId: payload?.conversation?.id };
    },
    async resolveGeo({ accessToken, content }) {
      return request('/assistant/geo/resolve', {
        accessToken,
        method: 'POST',
        body: { content, locale: 'ru', country: null },
        expectedStatuses: [200, 201],
      });
    },
    async startRun({ accessToken, conversationId, idempotencyKey, body }) {
      const payload = await request(`/assistant/conversations/${conversationId}/messages`, {
        accessToken,
        idempotencyKey,
        method: 'POST',
        body,
        expectedStatuses: [202],
      });
      return {
        runId: payload?.run?.id,
        status: payload?.run?.status,
      };
    },
    async getRun({ accessToken, runId }) {
      const payload = await request(`/assistant/runs/${runId}`, {
        accessToken,
        method: 'GET',
        expectedStatuses: [200],
      });
      return {
        runId: payload?.run?.id,
        status: payload?.run?.status,
        errorCode: payload?.run?.errorCode,
      };
    },
  };
}

function prepareAssistantProductSubmission(content, resolution) {
  const decision = mapAssistantProductSubmission(content, resolution);
  if (decision.status !== 'READY') throw new Error('ASSISTANT_GEO_CONFIRMATION_REQUIRED');
  return decision.body;
}

async function requestBoundedJson(fetchImpl, url, input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiRequestTimeoutMs);
  timeout.unref();
  try {
    const response = await fetchImpl(url, {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        accept: 'application/json',
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        ...(input.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: controller.signal,
    });
    if (!input.expectedStatuses.includes(response.status)) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_API_REJECTED');
    }
    return await readBoundedResponseJson(response);
  } catch (error) {
    if (error instanceof Error && readSafeCode(error.message)) throw error;
    throw new Error(controller.signal.aborted
      ? 'ASSISTANT_LOCAL_PAID_SMOKE_API_TIMEOUT'
      : 'ASSISTANT_LOCAL_PAID_SMOKE_API_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseJson(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_API_RESPONSE_INVALID');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    totalBytes += part.value.byteLength;
    if (totalBytes > maximumApiResponseBytes) {
      await reader.cancel();
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_API_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(part.value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_API_RESPONSE_INVALID');
  }
}

function readPort(value) {
  const port = value === undefined || value.trim() === '' ? 3000 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_API_PORT_INVALID');
  }
  return port;
}

function createBoundedDatabaseUrl(value, operationTimeoutMs) {
  const url = new URL(value);
  const timeoutSeconds = String(Math.max(1, Math.ceil(operationTimeoutMs / 1_000)));
  for (const name of ['connect_timeout', 'pool_timeout', 'socket_timeout']) {
    if (!url.searchParams.has(name)) url.searchParams.set(name, timeoutSeconds);
  }
  return url.toString();
}

function readInternalOperationTimeout(value) {
  if (value === undefined) return ledgerOperationTimeoutMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > ledgerOperationTimeoutMs) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_INTERNAL_TIMEOUT_INVALID');
  }
  return value;
}

function readApiRuntime() {
  let apiEnvironment;
  let commandLine;
  try {
    apiEnvironment = readNullSeparatedEnvironment('/proc/1/environ');
    commandLine = readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean);
  } catch {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_API_RUNTIME_UNREADABLE');
  }
  return {
    isContainer: existsSync('/.dockerenv'),
    isApiProcess: commandLine[0]?.endsWith('node') === true
      && commandLine.some((argument) => /apps\/api\/dist\/main\.js$/u.test(argument)),
    apiEnvironment,
  };
}

function readNullSeparatedEnvironment(path) {
  const allowed = new Set([
    'PORT',
    'NODE_ENV',
    'DEPLOYMENT_ENV',
    'DATABASE_URL',
    'ASSISTANT_LOCAL_PAID_SMOKE_DISPOSABLE_DB',
    'ASSISTANT_MODULE_ENABLED',
    'ASSISTANT_AI_MODE',
    'ASSISTANT_QUERY_PLANNER_LIVE',
    'ASSISTANT_ALIBABA_BASE_URL',
    'ASSISTANT_MODEL_REQUESTS_PER_MINUTE',
    'ASSISTANT_MODEL_REQUESTS_PER_DAY',
    'ASSISTANT_MODEL_DAILY_BUDGET_USD',
    'ASSISTANT_PAID_CALLS_CONFIRMED',
    'ALIBABA_API_KEY',
    'ASSISTANT_EMBEDDING_MODE',
    'ASSISTANT_EMBEDDING_LIVE',
    'ASSISTANT_GEO_PROVIDER_ENABLED',
    'ASSISTANT_GEO_PROVIDER_MODE',
    'ASSISTANT_OVERPASS_ENABLED',
    'ASSISTANT_EXTERNAL_CONNECTORS_ENABLED',
    'ASSISTANT_SOURCE_WORKER_ENABLED',
    'ASSISTANT_SOURCE_BROWSER_FALLBACK_ENABLED',
    'FEED_AUTO_IMPORT_ENABLED',
    'TRAINING_MODULE_ENABLED',
    'TRAINING_VOICE_WORKER_ENABLED',
    'TRAINING_MATERIAL_WORKER_ENABLED',
    'TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED',
    'TRAINING_AI_MODE',
    'TELEGRAM_TRANSPORT_MODE',
  ]);
  const result = {};
  for (const entry of readFileSync(path, 'utf8').split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (allowed.has(name)) {
      const value = entry.slice(separator + 1);
      result[name] = name === 'ALIBABA_API_KEY' && value ? '__present__' : value;
    }
  }
  return result;
}

function hasAccessTokenSource(environment) {
  const tokenPresent = typeof environment.ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN === 'string'
    && environment.ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN.trim().length > 0;
  const fdPresent = /^(?:[3-9]|[1-9]\d+)$/u.test(
    environment.ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN_FD ?? '',
  );
  return tokenPresent !== fdPresent;
}

function isOfficialAlibabaBaseUrl(value) {
  if (value === undefined || value.trim() === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'dashscope-intl.aliyuncs.com'
      && (url.pathname === '/compatible-mode/v1' || url.pathname === '/compatible-mode/v1/')
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isDisposableDatabaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ''));
    const localHosts = new Set(['postgres', 'localhost', '127.0.0.1', '[::1]']);
    return (url.protocol === 'postgresql:' || url.protocol === 'postgres:')
      && localHosts.has(url.hostname)
      && /(?:smoke|test|disposable)/iu.test(databaseName)
      && !url.hash;
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readAccessToken(environment) {
  const fromEnvironment = typeof environment.ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN === 'string'
    ? environment.ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN.trim()
    : '';
  const fdValue = environment.ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN_FD;
  let fromFd = '';
  if (fdValue !== undefined && fdValue !== '') {
    try {
      fromFd = readFileSync(Number(fdValue), 'utf8').trim();
    } catch {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN_UNREADABLE');
    }
  }
  const accessToken = fromEnvironment || fromFd;
  if (!accessToken || accessToken.length > 8_192 || (fromEnvironment && fromFd)) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ACCESS_TOKEN_INVALID');
  }
  return accessToken;
}

async function callApi(operation, deadline, operationTimeoutMs) {
  try {
    return await runBounded(
      operation,
      deadline,
      operationTimeoutMs,
      'ASSISTANT_LOCAL_PAID_SMOKE_API_TIMEOUT',
    );
  } catch (error) {
    throw normalizeSmokeError(error, 'ASSISTANT_LOCAL_PAID_SMOKE_API_FAILED');
  }
}

async function callApiWithRecovery(operation, recovery, input) {
  let lastFailure = new Error('ASSISTANT_LOCAL_PAID_SMOKE_API_FAILED');
  for (let attempt = 1; attempt <= maximumIdempotentPostAttempts; attempt += 1) {
    try {
      return await callApi(operation, input.deadline, input.operationTimeoutMs);
    } catch (error) {
      lastFailure = normalizeSmokeError(error, 'ASSISTANT_LOCAL_PAID_SMOKE_API_FAILED');
    }
    const recovered = await recoverPersistedValue(recovery, input);
    if (recovered) return recovered;
    if (attempt < maximumIdempotentPostAttempts) {
      await sleepBounded(input.sleep, 100, input.deadline, input.operationTimeoutMs);
    }
  }
  throw lastFailure;
}

async function recoverPersistedValue(recovery, input) {
  if (typeof recovery !== 'function') return null;
  for (let poll = 0; poll < recoveryPollsPerAttempt; poll += 1) {
    let recovered;
    try {
      recovered = await runBounded(
        recovery,
        input.deadline,
        input.operationTimeoutMs,
        'ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED',
      );
    } catch {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_READ_FAILED');
    }
    if (recovered) return recovered;
    if (poll + 1 < recoveryPollsPerAttempt) {
      await sleepBounded(input.sleep, 100, input.deadline, input.operationTimeoutMs);
    }
  }
  return null;
}

async function sleepBounded(sleep, durationMs, deadline, operationTimeoutMs) {
  return runBounded(
    () => sleep(durationMs),
    deadline,
    Math.max(operationTimeoutMs, durationMs + 100),
    'ASSISTANT_LOCAL_PAID_SMOKE_TOTAL_TIMEOUT',
  );
}

async function runBounded(operation, deadline, timeoutMs, timeoutCode) {
  assertWithinDeadline(deadline);
  const remainingMs = Math.max(1, deadline - Date.now());
  const boundedTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutCode)), boundedTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertWithinDeadline(deadline) {
  if (!Number.isFinite(deadline) || Date.now() > deadline) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_TOTAL_TIMEOUT');
  }
}

function requireUuid(value) {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_RESPONSE_INVALID');
  }
  return value.toLocaleLowerCase('en-US');
}

function readRunStatus(value) {
  if (value === 'PENDING' || value === 'RUNNING' || terminalRunStatuses.has(value)) return value;
  throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_RUN_RESPONSE_INVALID');
}

function readSafeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,119}$/u.test(value)
    ? value
    : null;
}

function normalizeSmokeError(error, fallback = 'ASSISTANT_LOCAL_PAID_SMOKE_FAILED') {
  const code = error instanceof Error ? readSafeCode(error.message) : null;
  return new Error(code ?? fallback);
}

function readPersistedUsd(value) {
  const normalized = typeof value === 'string'
    ? value
    : value && typeof value.toFixed === 'function'
      ? value.toFixed(8)
      : null;
  if (normalized === null) throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_INVALID');
  try {
    return parseAssistantUsd(normalized);
  } catch {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LEDGER_INVALID');
  }
}

function readLiveLimits(argv) {
  const knownArguments = new Set(['--live', '--limit', '--max-attempts', '--max-cost-usd']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!knownArguments.has(argument)) {
      throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ARGUMENT_INVALID');
    }
    if (argument !== '--live') index += 1;
  }
  if (argv.filter((value) => value === '--live').length !== 1) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ARGUMENT_INVALID');
  }
  const limit = readArgument(argv, '--limit');
  const maximumAttempts = readArgument(argv, '--max-attempts');
  const maximumCostUsd = readArgument(argv, '--max-cost-usd');
  if (limit === null || maximumAttempts === null || maximumCostUsd === null) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LIMITS_REQUIRED');
  }
  const parsedLimit = Number(limit);
  const parsedMaximumAttempts = Number(maximumAttempts);
  let parsedMaximumCostUnits;
  try {
    parsedMaximumCostUnits = parseAssistantUsd(maximumCostUsd);
  } catch {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LIMITS_INVALID');
  }
  if (parsedLimit > canaryLimits.userRequests
    || parsedMaximumAttempts > canaryLimits.modelAttempts
    || parsedMaximumCostUnits > parseAssistantUsd(canaryLimits.maximumCostUsd)) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LIMIT_EXCEEDED');
  }
  if (parsedLimit !== canaryLimits.userRequests
    || parsedMaximumAttempts !== canaryLimits.modelAttempts
    || parsedMaximumCostUnits !== parseAssistantUsd(canaryLimits.maximumCostUsd)) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LIMITS_INVALID');
  }
  return {
    userRequests: parsedLimit,
    modelAttempts: parsedMaximumAttempts,
    maximumCostUsd: formatAssistantUsd(parsedMaximumCostUnits),
  };
}

function readArgument(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length !== 1) throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_ARGUMENT_DUPLICATED');
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('ASSISTANT_LOCAL_PAID_SMOKE_LIMITS_REQUIRED');
  }
  return value;
}

async function main() {
  const report = await runAssistantLocalPaidSmoke();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error
      ? error.message
      : 'ASSISTANT_LOCAL_PAID_SMOKE_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  prepareAssistantProductSubmission,
  runAssistantLocalPaidSmoke,
};
