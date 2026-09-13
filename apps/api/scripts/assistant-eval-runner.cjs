#!/usr/bin/env node

'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { open, unlink, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { mapAssistantProductSubmission } = require('@platforma/shared/assistant-product-submission');

const {
  assistantEvalEvaluatorVersion,
  computeAssistantEvalDatasetSha256,
  loadAssistantEvalDataset,
  readAssistantEvalArtifactRunIds,
} = require('../dist/assistant/eval/assistant-eval.js');
const {
  formatAssistantUsd,
  parseAssistantUsd,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  assessAssistantProviderBudgetContract,
  countAssistantRolloutCriticalErrors,
} = require('../dist/assistant/rollout/assistant-rollout-preflight.js');
const {
  assistantEvalRuntimeContractVersion,
  createAssistantEvalDatabaseFingerprint,
} = require('../dist/assistant/eval/assistant-eval-runtime-contract.js');

const runnerVersion = 'assistant-eval-runner-v1';
const expectedCaseCount = 200;
const maximumIdempotentPostAttempts = 3;
const recoveryPollsPerAttempt = 3;
const maximumRunPolls = 600;
const pollIntervalMs = 180;
const apiRequestTimeoutMs = 15_000;
const maximumApiResponseBytes = 1_024 * 1_024;
const maximumAuthRefreshes = 32;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeCodePattern = /^[A-Z][A-Z0-9_]{2,119}$/u;
const terminalRunStatuses = new Set(['COMPLETED', 'FAILED']);

async function runAssistantEvalRunner(input = {}) {
  const environment = input.environment ?? process.env;
  let limits;
  let dataset;
  try {
    limits = readLimits(input.limits);
    dataset = input.dataset ?? loadFrozenDataset();
    assertFrozenDataset(dataset);
    if (input.enforceRuntimeSafety === true
      || (input.product === undefined && input.persistence === undefined)) {
      assertAssistantEvalRuntimeSafety(environment);
    }
  } catch (error) {
    scrubAssistantEvalEnvironment(environment);
    throw error;
  }
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((durationMs) => new Promise((done) => setTimeout(done, durationMs)));
  const createId = input.randomUUID ?? randomUUID;
  const writeManifest = input.writeManifest ?? ((artifact) => writeManifestExclusive(
    readManifestPath(input.manifestPath),
    artifact,
  ));
  const writeReport = input.writeReport ?? (async () => {});
  const maximumCostUnits = parseAssistantUsd(limits.maximumCostUsd);
  const rateLimiter = createRollingRateLimiter(limits.requestsPerMinute, now, sleep);
  const idempotencyKeys = new Set();
  const conversationIds = new Set();
  const runIds = [];
  const expectedRuns = [];
  const references = [];
  let product = input.product ?? null;
  let persistence = input.persistence ?? null;
  let accessToken = null;
  let actorId = null;
  let authRefreshCount = 0;
  let manifest = null;
  let runtimeContract = null;
  let databaseFingerprint = null;
  let modelRequestCount = 0;
  let effectiveCostUsd = '0.00000000';
  let report = null;
  let primaryError = null;
  const cleanupErrors = [];
  const callProduct = async (operation) => {
    try {
      return await operation(accessToken);
    } catch (error) {
      if (error?.message !== 'ASSISTANT_EVAL_API_HTTP_401') throw error;
      if (typeof product?.refreshAccessToken !== 'function'
        || authRefreshCount >= maximumAuthRefreshes) {
        throw new Error('ASSISTANT_EVAL_AUTH_REFRESH_REQUIRED');
      }
      authRefreshCount += 1;
      const refreshed = await product.refreshAccessToken();
      accessToken = readRefreshedAccessToken(refreshed?.accessToken ?? refreshed);
      const refreshedActorId = refreshed?.actorId ?? null;
      if (actorId !== null && refreshedActorId !== actorId) {
        throw new Error('ASSISTANT_EVAL_AUTH_ACTOR_CHANGED');
      }
      return operation(accessToken);
    }
  };

  try {
    product ??= createProductClient(environment);
    persistence ??= createPersistence(environment);
    accessToken = readOptionalAccessToken(environment);
    if (accessToken === null) {
      if (typeof product.refreshAccessToken !== 'function') {
        throw new Error('ASSISTANT_EVAL_ACCESS_TOKEN_REQUIRED');
      }
      const authenticated = await product.refreshAccessToken();
      accessToken = readRefreshedAccessToken(authenticated?.accessToken ?? authenticated);
    }
    const actor = await callProduct((token) => product.getActor({ accessToken: token }));
    actorId = requireUuid(actor?.id, 'ASSISTANT_EVAL_ACTOR_INVALID');
    const config = await callProduct((token) => product.checkConfig({ accessToken: token }));
    if (config?.enabled !== true) throw new Error('ASSISTANT_EVAL_ACTOR_NOT_ENABLED');
    [runtimeContract, databaseFingerprint] = await Promise.all([
      callProduct((token) => product.checkEvalRuntime({ accessToken: token })),
      persistence.getDatabaseFingerprint(),
    ]);
    assertAssistantEvalRuntimeHandshake(runtimeContract, databaseFingerprint, limits);

    for (const evalCase of dataset.cases) {
      if (modelRequestCount >= limits.dailyRequestCap) {
        throw new Error('ASSISTANT_EVAL_DAILY_REQUEST_CAP_EXHAUSTED');
      }
      const effectiveCostUnits = parseAssistantUsd(effectiveCostUsd);
      if (runIds.length > 0 && effectiveCostUnits > 0n
        && effectiveCostUnits >= maximumCostUnits) {
        throw new Error('ASSISTANT_EVAL_USD_CAP_EXHAUSTED');
      }
      await rateLimiter.acquire();

      const resolution = await callProduct((token) => product.resolveGeo({
        accessToken: token,
        evalCase,
      }));
      const decision = mapAssistantProductSubmission(evalCase.query, resolution, null);
      if (decision.status !== 'READY') {
        throw new Error('ASSISTANT_EVAL_GEO_CONFIRMATION_REQUIRED');
      }

      const idempotencyKey = requireUuid(createId(), 'ASSISTANT_EVAL_IDEMPOTENCY_KEY_INVALID');
      if (idempotencyKeys.has(idempotencyKey)) {
        throw new Error('ASSISTANT_EVAL_IDEMPOTENCY_KEY_REUSED');
      }
      idempotencyKeys.add(idempotencyKey);

      const created = await callIdempotentPostWithRecovery(
        () => callProduct((token) => product.createConversation({
          accessToken: token,
          evalCase,
          idempotencyKey,
        })),
        () => persistence.recoverConversation({ actorId, idempotencyKey }),
        sleep,
      );
      const conversationId = requireUuid(
        created?.conversationId,
        'ASSISTANT_EVAL_CONVERSATION_RESPONSE_INVALID',
      );
      if (conversationIds.has(conversationId)) {
        throw new Error('ASSISTANT_EVAL_CONVERSATION_ID_REUSED');
      }
      conversationIds.add(conversationId);

      const started = await callIdempotentPostWithRecovery(
        () => callProduct((token) => product.startRun({
          accessToken: token,
          evalCase,
          conversationId,
          idempotencyKey,
          body: {
            content: decision.body.content,
            context: null,
            geo: decision.body.geo ?? null,
          },
        })),
        () => persistence.recoverRun({ actorId, idempotencyKey }),
        sleep,
      );
      const runId = requireUuid(started?.runId, 'ASSISTANT_EVAL_RUN_RESPONSE_INVALID');
      if (runIds.includes(runId)) throw new Error('ASSISTANT_EVAL_RUN_ID_REUSED');
      const terminal = await waitForTerminalRun(product, {
        callProduct,
        evalCase,
        initialStatus: started?.status,
        runId,
        sleep,
      });
      if (terminal.status !== 'COMPLETED') {
        throw new Error(readSafeCode(terminal.errorCode) ?? 'ASSISTANT_EVAL_RUN_FAILED');
      }
      runIds.push(runId);
      expectedRuns.push({ runId, conversationId, idempotencyKey });
      references.push({ caseId: evalCase.id, runId });

      const inspection = await persistence.inspectRuns({
        actorId,
        evalCase,
        expectedRuns: [...expectedRuns],
        providerMode: runtimeContract.provider.aiMode,
        runIds: [...runIds],
      });
      validateInspection(inspection, runIds);
      modelRequestCount = inspection.modelRequestCount;
      effectiveCostUsd = formatAssistantUsd(parseAssistantUsd(inspection.effectiveCostUsd));
      const criticalViolation = inspection.criticalViolations[0];
      if (criticalViolation) throw new Error(readSafeCode(criticalViolation)
        ?? 'ASSISTANT_EVAL_CRITICAL_VIOLATION');
      if (modelRequestCount > limits.dailyRequestCap) {
        throw new Error('ASSISTANT_EVAL_DAILY_REQUEST_CAP_EXCEEDED');
      }
      if (parseAssistantUsd(effectiveCostUsd) > maximumCostUnits) {
        throw new Error('ASSISTANT_EVAL_USD_CAP_EXCEEDED');
      }
    }

    manifest = createManifest(dataset, references, now());
    report = {
      runnerVersion,
      passed: true,
      datasetVersion: dataset.version,
      datasetSha256: manifest.datasetSha256,
      evaluatorVersion: manifest.evaluatorVersion,
      evaluatedAt: manifest.evaluatedAt,
      caseCount: dataset.cases.length,
      completedRunCount: references.length,
      modelRequestCount,
      effectiveCostUsd,
      providerMode: runtimeContract.provider.aiMode,
      runtimeConfigSha256: runtimeContract.runtimeConfigSha256,
      releaseSha: runtimeContract.releaseIdentity.releaseSha,
      releaseImageIdentity: runtimeContract.releaseIdentity.releaseImageIdentity,
      databaseFingerprint,
      manifestRunMappingSha256: digestJson(manifest.runs),
      limits,
      cleanup: {
        persistenceClosed: false,
        credentialsScrubbed: false,
        persistedEvidenceRetained: true,
        runnerOwnedResources: [
          {
            type: 'DATABASE_CONNECTION',
            identifier: databaseFingerprint,
            disposition: 'CLOSED',
          },
          {
            type: 'IN_MEMORY_CREDENTIALS',
            identifier: 'assistant-eval-auth',
            disposition: 'SCRUBBED',
          },
        ],
        externalDisposableDatabase: {
          fingerprint: databaseFingerprint,
          owner: 'CALLER',
          disposition: 'RETAINED_FOR_EVALUATOR',
        },
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    scrubAssistantEvalEnvironment(environment);
    accessToken = null;
    try {
      if (product) {
        if (typeof product.scrubAuth !== 'function') {
          throw new Error('ASSISTANT_EVAL_AUTH_SCRUBBER_REQUIRED');
        }
        product.scrubAuth();
        if (report) report.cleanup.credentialsScrubbed = true;
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (persistence) {
        await persistence.close();
        if (report) report.cleanup.persistenceClosed = true;
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'ASSISTANT_EVAL_RUN_AND_CLEANUP_FAILED',
    );
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'ASSISTANT_EVAL_CLEANUP_FAILED');
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (primaryError) throw primaryError;
  await writeReport(report);
  await writeManifest(manifest);
  return report;
}

function createManifest(dataset, references, evaluatedAtValue) {
  const evaluatedAt = evaluatedAtValue instanceof Date ? evaluatedAtValue : new Date(evaluatedAtValue);
  if (!Number.isFinite(evaluatedAt.getTime())) throw new Error('ASSISTANT_EVAL_CLOCK_INVALID');
  const artifact = {
    datasetVersion: dataset.version,
    datasetSha256: computeAssistantEvalDatasetSha256(dataset),
    evaluatorVersion: assistantEvalEvaluatorVersion,
    evaluatedAt: evaluatedAt.toISOString(),
    runs: references.map(({ caseId, runId }) => ({ caseId, runId })),
  };
  readAssistantEvalArtifactRunIds(dataset, artifact, evaluatedAt);
  return artifact;
}

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateInspection(value, expectedRunIds) {
  if (!value || !Array.isArray(value.runs)
    || value.runs.length !== expectedRunIds.length
    || !Number.isSafeInteger(value.modelRequestCount)
    || value.modelRequestCount < 0
    || typeof value.effectiveCostUsd !== 'string'
    || !Array.isArray(value.criticalViolations)
    || value.criticalViolations.some((item) => typeof item !== 'string')) {
    throw new Error('ASSISTANT_EVAL_PERSISTENCE_INSPECTION_INVALID');
  }
  const expected = new Set(expectedRunIds);
  if (new Set(value.runs.map(({ id }) => id)).size !== expected.size
    || value.runs.some((run) => !run || !expected.has(run.id)
      || run.status !== 'COMPLETED'
      || !Array.isArray(run.qualityFlags))) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_RUNS_INVALID');
  }
  try {
    parseAssistantUsd(value.effectiveCostUsd);
  } catch {
    throw new Error('ASSISTANT_EVAL_PERSISTENCE_INSPECTION_INVALID');
  }
}

function findAssistantEvalProviderCoverageViolations(runs, attempts, providerMode) {
  if (!Array.isArray(runs) || !Array.isArray(attempts)
    || !['fake', 'alibaba'].includes(providerMode)) {
    return ['ASSISTANT_EVAL_PROVIDER_RECEIPTS_INCOMPLETE'];
  }
  const runById = new Map();
  for (const run of runs) {
    if (!run || typeof run.id !== 'string' || runById.has(run.id)
      || !Array.isArray(run.telemetryJson)) {
      return ['ASSISTANT_EVAL_PROVIDER_RECEIPTS_INCOMPLETE'];
    }
    runById.set(run.id, run);
  }
  if (attempts.some((attempt) => !attempt || attempt.operation !== 'PLANNER'
    || !runById.has(attempt.operationRunId))) {
    return ['ASSISTANT_EVAL_PROVIDER_RECEIPTS_UNEXPECTED'];
  }
  if (providerMode === 'fake') {
    return attempts.length === 0
      ? []
      : ['ASSISTANT_EVAL_PROVIDER_RECEIPTS_UNEXPECTED'];
  }
  for (const run of runs) {
    const receipts = attempts.filter(({ operationRunId }) => operationRunId === run.id)
      .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
    if (receipts.length !== run.telemetryJson.length
      || new Set(receipts.map(({ executionId }) => executionId)).size !== 1) {
      return ['ASSISTANT_EVAL_PROVIDER_RECEIPTS_INCOMPLETE'];
    }
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      const telemetry = run.telemetryJson[index];
      if (!telemetry || typeof telemetry !== 'object'
        || receipt.attemptOrdinal !== index + 1
        || receipt.status !== 'SETTLED'
        || (receipt.actualModel ?? receipt.requestedModel) !== telemetry.model
        || receipt.outcome !== telemetry.outcome
        || !sameProviderUsageValue(receipt.totalTokens, telemetry.totalTokens)) {
        return ['ASSISTANT_EVAL_PROVIDER_RECEIPTS_INCOMPLETE'];
      }
    }
  }
  return [];
}

function validateAssistantEvalPersistedRunIsolation(runs, expectedRuns, actorId) {
  if (!Array.isArray(runs) || !Array.isArray(expectedRuns)
    || runs.length !== expectedRuns.length || !uuidPattern.test(actorId)) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_RUN_ISOLATION_INVALID');
  }
  const expectedByRunId = new Map(expectedRuns.map((expected) => [expected.runId, expected]));
  if (expectedByRunId.size !== expectedRuns.length || runs.some((run) => {
    const expected = expectedByRunId.get(run?.id);
    return !expected
      || run.ownerUserId !== actorId
      || run.conversationId !== expected.conversationId
      || run.idempotencyKey !== expected.idempotencyKey
      || run.conversation?.ownerUserId !== actorId
      || run.conversation?.creationKey !== expected.idempotencyKey;
  })) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_RUN_ISOLATION_INVALID');
  }
}

function sameProviderUsageValue(left, right) {
  const normalize = (value) => {
    if (value === null || value === undefined) return 'UNKNOWN';
    if (typeof value === 'bigint' && value >= 0n) return `KNOWN:${value}`;
    if (Number.isSafeInteger(value) && value >= 0) return `KNOWN:${value}`;
    return 'INVALID';
  };
  const leftValue = normalize(left);
  return leftValue !== 'INVALID' && leftValue === normalize(right);
}

async function waitForTerminalRun(product, input) {
  let latest = {
    runId: input.runId,
    status: readRunStatus(input.initialStatus),
    errorCode: null,
  };
  for (let poll = 0; poll < maximumRunPolls; poll += 1) {
    if (terminalRunStatuses.has(latest.status)) return latest;
    latest = await input.callProduct((accessToken) => product.getRun({
      accessToken,
      evalCase: input.evalCase,
      runId: input.runId,
    }));
    if (latest?.runId !== input.runId) throw new Error('ASSISTANT_EVAL_RUN_RESPONSE_INVALID');
    latest = {
      runId: latest.runId,
      status: readRunStatus(latest.status),
      errorCode: latest.errorCode,
    };
    if (!terminalRunStatuses.has(latest.status)) await input.sleep(pollIntervalMs);
  }
  throw new Error('ASSISTANT_EVAL_RUN_TIMEOUT');
}

async function callIdempotentPostWithRecovery(operation, recover, sleep) {
  let lastError = null;
  for (let attempt = 1; attempt <= maximumIdempotentPostAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error?.retryable !== true) throw error;
      lastError = error;
    }
    for (let recoveryPoll = 0; recoveryPoll < recoveryPollsPerAttempt; recoveryPoll += 1) {
      const recovered = await recover();
      if (recovered) return recovered;
      if (recoveryPoll + 1 < recoveryPollsPerAttempt) await sleep(50);
    }
  }
  throw lastError ?? new Error('ASSISTANT_EVAL_IDEMPOTENT_POST_FAILED');
}

function createRollingRateLimiter(requestsPerMinute, now, sleep) {
  const starts = [];
  return {
    async acquire() {
      while (true) {
        const current = readClockMs(now);
        while (starts.length > 0 && starts[0] <= current - 60_000) starts.shift();
        if (starts.length < requestsPerMinute) {
          starts.push(current);
          return;
        }
        await sleep(Math.max(1, starts[0] + 60_000 - current));
      }
    },
  };
}

function readLimits(value) {
  if (!value || typeof value !== 'object') throw new Error('ASSISTANT_EVAL_LIMITS_REQUIRED');
  if (!Number.isSafeInteger(value.requestsPerMinute) || value.requestsPerMinute < 1
    || !Number.isSafeInteger(value.dailyRequestCap) || value.dailyRequestCap < 1
    || typeof value.maximumCostUsd !== 'string') {
    throw new Error('ASSISTANT_EVAL_LIMITS_INVALID');
  }
  let maximumCostUsd;
  try {
    const units = parseAssistantUsd(value.maximumCostUsd);
    if (units < 0n) throw new Error('negative');
    maximumCostUsd = formatAssistantUsd(units);
  } catch {
    throw new Error('ASSISTANT_EVAL_LIMITS_INVALID');
  }
  return {
    requestsPerMinute: value.requestsPerMinute,
    dailyRequestCap: value.dailyRequestCap,
    maximumCostUsd,
  };
}

function assertAssistantEvalRuntimeSafety(environment) {
  const deployed = [environment.NODE_ENV, environment.DEPLOYMENT_ENV]
    .some((value) => ['production', 'staging'].includes(value?.trim().toLocaleLowerCase('en-US')));
  if (deployed
    || !isDisposableDatabaseUrl(environment.DATABASE_URL)
    || !readLoginCredentials(environment)) {
    throw new Error('ASSISTANT_EVAL_DISPOSABLE_RUNTIME_REQUIRED');
  }
  try {
    readLoopbackOrigin(environment.ASSISTANT_EVAL_API_ORIGIN);
  } catch {
    throw new Error('ASSISTANT_EVAL_DISPOSABLE_RUNTIME_REQUIRED');
  }
}

function assertAssistantEvalRuntimeHandshake(value, databaseFingerprint, limits) {
  const provider = value?.provider;
  const runtime = value?.runtime;
  const releaseIdentity = value?.releaseIdentity;
  if (value?.version !== assistantEvalRuntimeContractVersion
    || typeof value.databaseFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.databaseFingerprint)
    || value.databaseFingerprint !== databaseFingerprint
    || !provider || !runtime
    || provider.readinessPassed !== true
    || !Array.isArray(provider.missing) || provider.missing.length !== 0
    || !['fake', 'alibaba'].includes(provider.aiMode)
    || !Number.isSafeInteger(provider.requestsPerMinute)
    || !Number.isSafeInteger(provider.requestsPerDay)
    || provider.requestsPerMinute < 1
    || provider.requestsPerDay < 1
    || typeof provider.queryPlannerLive !== 'boolean'
    || typeof provider.paidCallsConfirmed !== 'boolean'
    || typeof provider.apiKeyPresent !== 'boolean'
    || !['disabled', 'fake'].includes(runtime.embeddingMode)) {
    throw new Error('ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID');
  }
  if (typeof value.runtimeConfigSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.runtimeConfigSha256)) {
    throw new Error('ASSISTANT_EVAL_RUNTIME_BINDING_INVALID');
  }
  if (!releaseIdentity || typeof releaseIdentity !== 'object'
    || Array.isArray(releaseIdentity)
    || Object.keys(releaseIdentity).sort().join(',') !== 'releaseImageIdentity,releaseSha'
    || typeof releaseIdentity.releaseSha !== 'string'
    || !/^[a-f0-9]{40}$/u.test(releaseIdentity.releaseSha)
    || releaseIdentity.releaseImageIdentity !== null
      && (typeof releaseIdentity.releaseImageIdentity !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(releaseIdentity.releaseImageIdentity))) {
    throw new Error('ASSISTANT_EVAL_RELEASE_IDENTITY_INVALID');
  }
  const nodeEnvironment = runtime.nodeEnvironment?.trim().toLocaleLowerCase('en-US') ?? null;
  const deploymentEnvironment = runtime.deploymentEnvironment
    ?.trim().toLocaleLowerCase('en-US') ?? null;
  if (['production', 'staging'].includes(nodeEnvironment)
    || ['production', 'staging'].includes(deploymentEnvironment)
    || runtime.geoProviderEnabled !== false
    || runtime.externalConnectorsEnabled !== false
    || runtime.sourceDiscoveryLive !== false
    || runtime.embeddingLive !== false) {
    throw new Error('ASSISTANT_EVAL_UNBOUNDED_PROVIDER_ENABLED');
  }
  if (runtime.currentFactRefreshMode !== 'fixture') {
    throw new Error('ASSISTANT_EVAL_CURRENT_FACT_FIXTURE_REQUIRED');
  }
  if (provider.requestsPerMinute > limits.requestsPerMinute
    || provider.requestsPerDay > limits.dailyRequestCap) {
    throw new Error('ASSISTANT_EVAL_RUNTIME_BUDGET_EXCEEDS_CAP');
  }
  if (provider.aiMode === 'fake'
    && (provider.dailyBudgetUsd !== null
      || provider.queryPlannerLive !== false
      || provider.paidCallsConfirmed !== false)) {
    throw new Error('ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID');
  }
  if (provider.aiMode === 'alibaba') {
    if (provider.queryPlannerLive !== true
      || provider.paidCallsConfirmed !== true
      || provider.apiKeyPresent !== true
      || runtime.alibabaBaseUrlOfficial !== true
      || typeof provider.dailyBudgetUsd !== 'string') {
      throw new Error('ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID');
    }
    let dailyBudgetUnits;
    try {
      dailyBudgetUnits = parseAssistantUsd(provider.dailyBudgetUsd);
    } catch {
      throw new Error('ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID');
    }
    if (dailyBudgetUnits > parseAssistantUsd(limits.maximumCostUsd)) {
      throw new Error('ASSISTANT_EVAL_RUNTIME_BUDGET_EXCEEDS_CAP');
    }
  }
}

function isDisposableDatabaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
    return ['postgresql:', 'postgres:'].includes(parsed.protocol)
      && ['postgres', 'localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      && /(?:^|[_-])(?:eval|test|disposable|smoke)(?:$|[_-])/iu.test(databaseName)
      && !parsed.hash;
  } catch {
    return false;
  }
}

function assertFrozenDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.cases) || dataset.cases.length !== expectedCaseCount) {
    throw new Error('ASSISTANT_EVAL_DATASET_CASE_COUNT_INVALID');
  }
}

function loadFrozenDataset() {
  return loadAssistantEvalDataset(JSON.parse(readFileSync(resolve(
    __dirname,
    '../tests/fixtures/assistant/assistant-eval-v1.json',
  ), 'utf8')));
}

function createProductClient(environment, fetchImpl = fetch) {
  const origin = readLoopbackOrigin(environment.ASSISTANT_EVAL_API_ORIGIN);
  let credentials = readLoginCredentials(environment);
  const request = (path, input) => requestBoundedJson(fetchImpl, `${origin}${path}`, input);
  return {
    async getActor({ accessToken }) {
      const payload = await request('/auth/me', { accessToken, method: 'GET', expectedStatuses: [200] });
      return { id: payload?.user?.id };
    },
    checkConfig: ({ accessToken }) => request('/assistant/config', {
      accessToken, method: 'GET', expectedStatuses: [200],
    }),
    checkEvalRuntime: ({ accessToken }) => request('/assistant/eval/runtime', {
      accessToken, method: 'GET', expectedStatuses: [200],
    }),
    resolveGeo: ({ accessToken, evalCase }) => request('/assistant/geo/resolve', {
      accessToken,
      method: 'POST',
      body: { content: evalCase.query, locale: 'ru', country: null },
      expectedStatuses: [200, 201],
    }),
    async createConversation({ accessToken, idempotencyKey }) {
      const payload = await request('/assistant/conversations', {
        accessToken, idempotencyKey, method: 'POST', expectedStatuses: [200, 201],
      });
      return { conversationId: payload?.conversation?.id };
    },
    async startRun({ accessToken, conversationId, idempotencyKey, body }) {
      const payload = await request(`/assistant/conversations/${conversationId}/messages`, {
        accessToken, idempotencyKey, method: 'POST', body, expectedStatuses: [202],
      });
      return { runId: payload?.run?.id, status: payload?.run?.status };
    },
    async getRun({ accessToken, runId }) {
      const payload = await request(`/assistant/runs/${runId}`, {
        accessToken, method: 'GET', expectedStatuses: [200],
      });
      return {
        runId: payload?.run?.id,
        status: payload?.run?.status,
        errorCode: payload?.run?.errorCode,
      };
    },
    async refreshAccessToken() {
      if (!credentials) throw new Error('ASSISTANT_EVAL_AUTH_REFRESH_REQUIRED');
      const payload = await request('/auth/login', {
        method: 'POST',
        body: credentials,
        expectedStatuses: [200],
      });
      return {
        accessToken: readRefreshedAccessToken(payload?.accessToken),
        actorId: requireUuid(payload?.user?.id, 'ASSISTANT_EVAL_ACTOR_INVALID'),
      };
    },
    scrubAuth() {
      credentials = null;
    },
  };
}

function createPersistence(environment) {
  const { Prisma, PrismaClient } = require('@prisma/client');
  if (!environment.DATABASE_URL) throw new Error('ASSISTANT_EVAL_DATABASE_URL_REQUIRED');
  const prisma = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
  return {
    async getDatabaseFingerprint() {
      const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT
          current_database() AS "databaseName",
          current_schema() AS "schemaName",
          COALESCE(inet_server_addr()::text, 'local') AS "serverAddress",
          inet_server_port() AS "serverPort",
          pg_postmaster_start_time()::text AS "serverStartedAt"
      `);
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error('ASSISTANT_EVAL_DATABASE_IDENTITY_INVALID');
      }
      return createAssistantEvalDatabaseFingerprint(rows[0]);
    },
    async recoverConversation({ actorId, idempotencyKey }) {
      const conversation = await prisma.assistantConversation.findUnique({
        where: { ownerUserId_creationKey: { ownerUserId: actorId, creationKey: idempotencyKey } },
        select: { id: true },
      });
      return conversation ? { conversationId: conversation.id } : null;
    },
    async recoverRun({ actorId, idempotencyKey }) {
      const run = await prisma.assistantRun.findUnique({
        where: { ownerUserId_idempotencyKey: { ownerUserId: actorId, idempotencyKey } },
        select: { id: true, status: true },
      });
      return run ? { runId: run.id, status: run.status } : null;
    },
    async inspectRuns({ actorId, expectedRuns, providerMode, runIds }) {
      const [runs, attempts] = await Promise.all([
        prisma.assistantRun.findMany({
          where: { id: { in: runIds }, ownerUserId: actorId },
          select: {
            id: true,
            ownerUserId: true,
            conversationId: true,
            idempotencyKey: true,
            status: true,
            errorCode: true,
            qualityFlags: true,
            telemetryJson: true,
            conversation: {
              select: {
                ownerUserId: true,
                creationKey: true,
              },
            },
          },
        }),
        prisma.assistantAiUsageAttempt.findMany({
          where: { operationRunId: { in: runIds } },
          select: {
            operationRunId: true,
            executionId: true,
            attemptOrdinal: true,
            operation: true,
            requestedModel: true,
            actualModel: true,
            status: true,
            outcome: true,
            totalTokens: true,
            pricingStatus: true,
            reservedCostUsd: true,
            chargedCostUsd: true,
            webSearchCalls: true,
          },
        }),
      ]);
      validateAssistantEvalPersistedRunIsolation(runs, expectedRuns, actorId);
      const providerContract = assessAssistantProviderBudgetContract(attempts);
      const criticalViolations = [];
      if (countAssistantRolloutCriticalErrors(runs) > 0) {
        criticalViolations.push('ASSISTANT_ROLLOUT_CRITICAL_ERRORS_PRESENT');
      }
      if (!providerContract.passed && providerContract.condition) {
        criticalViolations.push(providerContract.condition);
      }
      criticalViolations.push(
        ...findAssistantEvalProviderCoverageViolations(runs, attempts, providerMode),
      );
      const modelRequestCount = runs.reduce((total, run) => {
        if (!Array.isArray(run.telemetryJson)) {
          throw new Error('ASSISTANT_EVAL_PERSISTED_TELEMETRY_INVALID');
        }
        return total + run.telemetryJson.length;
      }, 0);
      let effectiveCostUnits = 0n;
      for (const attempt of attempts) {
        const amount = attempt.status === 'SETTLED' && attempt.chargedCostUsd !== null
          ? attempt.chargedCostUsd
          : attempt.reservedCostUsd;
        effectiveCostUnits += parseAssistantUsd(amount.toFixed(8));
      }
      return {
        runs: runs.map(({ id, status, qualityFlags }) => ({ id, status, qualityFlags })),
        modelRequestCount,
        effectiveCostUsd: formatAssistantUsd(effectiveCostUnits),
        criticalViolations,
      };
    },
    close: () => prisma.$disconnect(),
  };
}

async function requestBoundedJson(fetchImpl, url, input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiRequestTimeoutMs);
  timeout.unref();
  try {
    const response = await fetchImpl(url, {
      method: input.method,
      redirect: 'error',
      headers: {
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
        accept: 'application/json',
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        ...(input.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: controller.signal,
    });
    if (!input.expectedStatuses.includes(response.status)) {
      const error = new Error(`ASSISTANT_EVAL_API_HTTP_${response.status}`);
      error.retryable = response.status >= 500;
      throw error;
    }
    return await readBoundedResponseJson(response);
  } catch (error) {
    if (readSafeCode(error?.message)) throw error;
    const wrapped = new Error(controller.signal.aborted
      ? 'ASSISTANT_EVAL_API_TIMEOUT'
      : 'ASSISTANT_EVAL_API_FAILED');
    wrapped.retryable = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseJson(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('ASSISTANT_EVAL_API_RESPONSE_INVALID');
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
      throw new Error('ASSISTANT_EVAL_API_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(part.value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('ASSISTANT_EVAL_API_RESPONSE_INVALID');
  }
}

async function writeManifestExclusive(path, artifact) {
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function reserveAssistantEvalOutputPair(reportPath, manifestPath) {
  let report = null;
  try {
    report = await reserveJsonOutput(reportPath);
    const manifest = await reserveJsonOutput(manifestPath);
    return {
      report,
      manifest,
      async discard() {
        const results = await Promise.allSettled([report.discard(), manifest.discard()]);
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length > 0) {
          throw new AggregateError(errors, 'ASSISTANT_EVAL_OUTPUT_CLEANUP_FAILED');
        }
      },
    };
  } catch (error) {
    let cleanupError = null;
    try {
      await report?.discard();
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'ASSISTANT_EVAL_OUTPUT_RESERVATION_FAILED',
      );
    }
    throw new Error('ASSISTANT_EVAL_OUTPUT_RESERVATION_FAILED');
  }
}

async function reserveJsonOutput(path) {
  const handle = await open(path, 'wx', 0o600);
  let closed = false;
  let discarded = false;
  return {
    async write(value) {
      if (closed || discarded) throw new Error('ASSISTANT_EVAL_OUTPUT_STATE_INVALID');
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
        closed = true;
      }
    },
    async discard() {
      if (discarded) return;
      if (!closed) {
        await handle.close();
        closed = true;
      }
      try {
        await unlink(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      discarded = true;
    },
  };
}

function parseCliArguments(argv) {
  if (argv.length === 0) return { execute: false };
  const known = new Set([
    '--execute',
    '--rpm',
    '--daily-request-cap',
    '--max-cost-usd',
    '--manifest',
    '--report',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!known.has(argument)) throw new Error('ASSISTANT_EVAL_ARGUMENT_INVALID');
    if (argument !== '--execute') index += 1;
  }
  if (argv.filter((value) => value === '--execute').length !== 1) {
    throw new Error('ASSISTANT_EVAL_ARGUMENT_INVALID');
  }
  const rpm = readCliValue(argv, '--rpm');
  const dailyRequestCap = readCliValue(argv, '--daily-request-cap');
  const maximumCostUsd = readCliValue(argv, '--max-cost-usd');
  const manifestPath = readCliValue(argv, '--manifest');
  const reportPath = readCliValue(argv, '--report');
  if ([rpm, dailyRequestCap, maximumCostUsd, manifestPath, reportPath]
    .some((value) => value === null)) {
    throw new Error('ASSISTANT_EVAL_LIMITS_REQUIRED');
  }
  const resolvedManifestPath = resolve(manifestPath);
  const resolvedReportPath = resolve(reportPath);
  if (resolvedManifestPath === resolvedReportPath) {
    throw new Error('ASSISTANT_EVAL_OUTPUT_PATHS_COLLIDE');
  }
  return {
    execute: true,
    limits: readLimits({
      requestsPerMinute: Number(rpm),
      dailyRequestCap: Number(dailyRequestCap),
      maximumCostUsd,
    }),
    manifestPath: resolvedManifestPath,
    reportPath: resolvedReportPath,
  };
}

function readCliValue(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length !== 1) throw new Error('ASSISTANT_EVAL_ARGUMENT_DUPLICATED');
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error('ASSISTANT_EVAL_ARGUMENT_INVALID');
  return value;
}

function readOptionalAccessToken(environment) {
  const value = environment.ASSISTANT_EVAL_ACCESS_TOKEN;
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  return readRefreshedAccessToken(value);
}

function readRefreshedAccessToken(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 8_192) {
    throw new Error('ASSISTANT_EVAL_ACCESS_TOKEN_INVALID');
  }
  return value.trim();
}

function readLoginCredentials(environment) {
  const dedicatedEmail = environment.ASSISTANT_EVAL_EMAIL?.trim();
  const dedicatedPassword = environment.ASSISTANT_EVAL_PASSWORD;
  if (dedicatedEmail || dedicatedPassword) {
    return dedicatedEmail && dedicatedPassword
      ? { email: dedicatedEmail.toLocaleLowerCase('en-US'), password: dedicatedPassword }
      : null;
  }
  const adminEmail = environment.ADMIN_EMAIL?.trim();
  const adminPassword = environment.ADMIN_PASSWORD;
  return adminEmail && adminPassword
    ? { email: adminEmail.toLocaleLowerCase('en-US'), password: adminPassword }
    : null;
}

function scrubAssistantEvalEnvironment(environment) {
  for (const name of [
    'ASSISTANT_EVAL_ACCESS_TOKEN',
    'ASSISTANT_EVAL_EMAIL',
    'ASSISTANT_EVAL_PASSWORD',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
  ]) delete environment[name];
}

function readManifestPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('ASSISTANT_EVAL_MANIFEST_PATH_REQUIRED');
  }
  return resolve(value);
}

function readLoopbackOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value?.trim() || 'http://127.0.0.1:3000');
  } catch {
    throw new Error('ASSISTANT_EVAL_API_ORIGIN_INVALID');
  }
  if (parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/') {
    throw new Error('ASSISTANT_EVAL_API_ORIGIN_INVALID');
  }
  return parsed.origin;
}

function requireUuid(value, code) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error(code);
  return value;
}

function readRunStatus(value) {
  if (typeof value !== 'string' || !['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'].includes(value)) {
    throw new Error('ASSISTANT_EVAL_RUN_RESPONSE_INVALID');
  }
  return value;
}

function readClockMs(value) {
  const current = value();
  const timestamp = current instanceof Date ? current.getTime() : Number(current);
  if (!Number.isFinite(timestamp)) throw new Error('ASSISTANT_EVAL_CLOCK_INVALID');
  return timestamp;
}

function readSafeCode(value) {
  return typeof value === 'string' && safeCodePattern.test(value) ? value : null;
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  if (!options.execute) {
    const dataset = loadFrozenDataset();
    process.stdout.write(`${JSON.stringify({
      runnerVersion,
      mode: 'DRY_RUN',
      passed: true,
      caseCount: dataset.cases.length,
      datasetVersion: dataset.version,
      datasetSha256: computeAssistantEvalDatasetSha256(dataset),
      providerCalls: 0,
      hint: 'Use --execute with explicit --rpm, --daily-request-cap, --max-cost-usd, --report and --manifest.',
    }, null, 2)}\n`);
    return;
  }
  const outputs = await reserveAssistantEvalOutputPair(options.reportPath, options.manifestPath);
  let report;
  try {
    report = await runAssistantEvalRunner({
      limits: options.limits,
      writeReport: (value) => outputs.report.write(value),
      writeManifest: (value) => outputs.manifest.write(value),
    });
  } catch (error) {
    try {
      await outputs.discard();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'ASSISTANT_EVAL_RUN_AND_OUTPUT_CLEANUP_FAILED');
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${readSafeCode(error?.message) ?? 'ASSISTANT_EVAL_RUNNER_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertAssistantEvalRuntimeHandshake,
  assertAssistantEvalRuntimeSafety,
  findAssistantEvalProviderCoverageViolations,
  isDisposableDatabaseUrl,
  parseCliArguments,
  requestBoundedJson,
  reserveAssistantEvalOutputPair,
  runAssistantEvalRunner,
  validateAssistantEvalPersistedRunIsolation,
};
