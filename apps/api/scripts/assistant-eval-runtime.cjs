'use strict';

const { createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');

const {
  assistantEvalCategories,
  assistantEvalEvaluatorVersion,
  assistantEvalZeroToleranceViolations,
  computeAssistantEvalDatasetSha256,
  readAssistantEvalArtifactRunIds,
  scoreAssistantEval,
} = require('../dist/assistant/eval/assistant-eval.js');
const {
  parseResolveInputs,
} = require('../dist/assistant/geo/assistant-place-resolver.service.js');
const {
  createAssistantEvalDatabaseFingerprint,
} = require('../dist/assistant/eval/assistant-eval-runtime-contract.js');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^[a-f0-9]{64}$/u;
const safeCodePattern = /^[A-Z][A-Z0-9_]{2,119}$/u;
const internalErrorCodePattern = /^ASSISTANT_[A-Z0-9_]{2,109}$/u;
const usdPattern = /^\d+\.\d{8}$/u;
const tokenCountPattern = /^(?:0|[1-9]\d*)$/u;
const alibabaModels = new Set(['qwen-flash', 'qwen3.8-max', 'qwen-plus', 'qwen-max']);
const assistantQualityFlags = new Set([
  'HARD_FILTER_VIOLATION',
  'UNSUPPORTED_FACT',
  'STALE_PRICE_UNLABELED',
  'BROKEN_LINK',
  'MODEL_FALLBACK',
  'PROVIDER_ERROR',
  'LATENCY_BREACH',
]);
const evalViolationSet = new Set(assistantEvalZeroToleranceViolations);
const geoProviders = new Set([
  'alias',
  'fake',
  'landmark_db',
  'locationiq',
  'overpass',
]);
const geoResolutionStatuses = new Set([
  'AMBIGUOUS',
  'NOT_APPLICABLE',
  'NOT_FOUND',
  'REFINE_REQUIRED',
  'RESOLVED',
  'UNAVAILABLE',
]);
const cleanupResourceKeys = ['databases', 'containers', 'networks', 'volumes', 'images'];
const cleanupResourceIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,239}$/u;

async function loadAssistantEvalDatabaseIdentity(prisma) {
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
  return {
    ...rows[0],
    fingerprint: createAssistantEvalDatabaseFingerprint(rows[0]),
  };
}

async function loadAssistantEvalDatabaseFingerprint(prisma) {
  return (await loadAssistantEvalDatabaseIdentity(prisma)).fingerprint;
}

async function loadAssistantEvalRunRecords(prisma, dataset, artifact, now = new Date()) {
  const runIds = readAssistantEvalArtifactRunIds(dataset, artifact, now);
  return loadAssistantEvalRunRecordsByIds(prisma, runIds, now);
}

async function loadAssistantEvalRunRecordsByIds(prisma, runIds, now = new Date()) {
  const runs = await prisma.assistantRun.findMany({
    where: { id: { in: runIds } },
    select: {
      id: true,
      ownerUserId: true,
      status: true,
      createdAt: true,
      completedAt: true,
      intentJson: true,
      evidenceJson: true,
      telemetryJson: true,
      auditJson: true,
      qualityFlags: true,
      latencyMs: true,
      conversation: { select: { ownerUserId: true } },
      userMessage: { select: { content: true, contextJson: true, geoContextJson: true } },
      assistantMessage: { select: { content: true, answerJson: true } },
      owner: {
        select: {
          role: {
            select: {
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });
  const ownerUserIds = [...new Set(runs.map(({ ownerUserId }) => ownerUserId))];
  const earliest = runs.reduce((value, run) => Math.min(value, run.createdAt.getTime()), now.getTime());
  const geoOperations = ownerUserIds.length === 0 ? [] : await prisma.assistantGeoOperation.findMany({
    where: {
      actorUserId: { in: ownerUserIds },
      createdAt: {
        gte: new Date(earliest - 30_000),
        lte: now,
      },
    },
    select: {
      actorUserId: true,
      normalizedQuery: true,
      providerCallCount: true,
      createdAt: true,
    },
  });
  const attributionRuns = runs.map((run) => ({
    ...run,
    expectedGeoOperationCount: readExpectedAssistantEvalGeoOperationCount(
      run.userMessage.geoContextJson,
    ),
    expectedGeoOperationQueries: readExpectedAssistantEvalGeoOperationQueries(
      run.userMessage.content,
      run.userMessage.geoContextJson,
    ),
  }));
  const geoProviderCallsByRun = attributeAssistantEvalGeoProviderCalls(
    attributionRuns,
    geoOperations,
  );

  return runs.map((run) => ({
    id: run.id,
    ownerUserId: run.ownerUserId,
    conversationOwnerUserId: run.conversation.ownerUserId,
    ownerPermissions: run.owner.role.permissions.map(({ permission }) => permission.key),
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    query: run.userMessage.content,
    context: run.userMessage.contextJson,
    geoContext: run.userMessage.geoContextJson,
    answer: mergeAssistantMessage(run.assistantMessage),
    evidence: run.evidenceJson,
    intent: run.intentJson,
    audit: run.auditJson,
    qualityFlags: run.qualityFlags,
    latencyMs: run.latencyMs,
    telemetry: run.telemetryJson,
    geoProviderCalls: geoProviderCallsByRun.get(run.id) ?? 0,
  }));
}

function attributeAssistantEvalGeoProviderCalls(runs, operations) {
  const result = new Map(runs.map(({ id }) => [id, 0]));
  const operationsByRun = assignAssistantEvalGeoOperations(runs, operations);
  for (const [runId, runOperations] of operationsByRun) {
    result.set(runId, runOperations.reduce((total, operation) => (
      total + operation.providerCallCount
    ), 0));
  }
  return result;
}

function readExpectedAssistantEvalGeoOperationCount(value) {
  if (value === null) return 0;
  if (!isRecord(value)) throw new Error('ASSISTANT_EVAL_GEO_CONTEXT_INVALID');
  if (value.operator === 'ALL') {
    if (!Array.isArray(value.constraints)
      || value.constraints.length < 2
      || value.constraints.length > 5) {
      throw new Error('ASSISTANT_EVAL_GEO_CONTEXT_INVALID');
    }
    return value.constraints.length;
  }
  return 1;
}

function readExpectedAssistantEvalGeoOperationQueries(query, geoContext) {
  const expectedCount = readExpectedAssistantEvalGeoOperationCount(geoContext);
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('ASSISTANT_EVAL_GEO_CONTEXT_INVALID');
  }
  let constraints;
  try {
    constraints = parseResolveInputs({ content: query }).constraints;
  } catch {
    throw new Error('ASSISTANT_EVAL_GEO_CONTEXT_INVALID');
  }
  const normalizedQueries = constraints.map(({ normalizedQuery }) => normalizedQuery);
  if (normalizedQueries.length !== expectedCount
    || normalizedQueries.some((value) => typeof value !== 'string' || value === '')) {
    throw new Error('ASSISTANT_EVAL_GEO_CONTEXT_INVALID');
  }
  return normalizedQueries;
}

function assignAssistantEvalGeoOperations(runs, operations) {
  const result = new Map(runs.map(({ id }) => [id, []]));
  const runsByActor = new Map();
  for (const run of runs) {
    const actorRuns = runsByActor.get(run.ownerUserId) ?? [];
    actorRuns.push(run);
    runsByActor.set(run.ownerUserId, actorRuns);
  }
  for (const actorRuns of runsByActor.values()) {
    actorRuns.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }
  const orderedOperations = [...operations].sort((left, right) => (
    left.createdAt.getTime() - right.createdAt.getTime()
  ));
  for (const operation of orderedOperations) {
    if (!operation.actorUserId || !Number.isSafeInteger(operation.providerCallCount)
      || operation.providerCallCount < 0) continue;
    const matchingRun = (runsByActor.get(operation.actorUserId) ?? []).find((run) => {
      const differenceMs = run.createdAt.getTime() - operation.createdAt.getTime();
      return differenceMs >= 0 && differenceMs <= 30_000;
    });
    if (!matchingRun) continue;
    result.get(matchingRun.id).push(operation);
  }
  for (const run of runs) {
    if (run.expectedGeoOperationCount !== undefined
      && result.get(run.id).length !== run.expectedGeoOperationCount) {
      throw new Error('ASSISTANT_EVAL_GEO_ATTRIBUTION_AMBIGUOUS');
    }
    if (run.expectedGeoOperationQueries !== undefined) {
      const actualQueries = result.get(run.id).map(({ normalizedQuery }) => normalizedQuery);
      if (actualQueries.some((value) => typeof value !== 'string' || value === '')
        || JSON.stringify([...actualQueries].sort())
          !== JSON.stringify([...run.expectedGeoOperationQueries].sort())) {
        throw new Error('ASSISTANT_EVAL_GEO_ATTRIBUTION_AMBIGUOUS');
      }
    }
  }
  return result;
}

async function loadAssistantEvalProviderReceipts(prisma, records, now = new Date()) {
  if (!Array.isArray(records)) throw new Error('ASSISTANT_EVAL_EVIDENCE_RUNS_INVALID');
  const runs = records.map((record) => ({
    id: record.id,
    ownerUserId: record.ownerUserId,
    createdAt: readDate(record.createdAt, 'ASSISTANT_EVAL_EVIDENCE_RUNS_INVALID'),
    expectedGeoOperationCount: readExpectedAssistantEvalGeoOperationCount(record.geoContext),
    expectedGeoOperationQueries: readExpectedAssistantEvalGeoOperationQueries(
      record.query,
      record.geoContext,
    ),
  }));
  const receiptsByRun = new Map(runs.map(({ id }) => [id, []]));
  if (runs.length === 0) return receiptsByRun;
  const runIds = runs.map(({ id }) => id);
  const ownerUserIds = [...new Set(runs.map(({ ownerUserId }) => ownerUserId))];
  const earliest = Math.min(...runs.map(({ createdAt }) => createdAt.getTime()));
  const [aiAttempts, geoOperations] = await Promise.all([
    prisma.assistantAiUsageAttempt.findMany({
      where: { operationRunId: { in: runIds } },
      orderBy: [
        { operationRunId: 'asc' },
        { executionId: 'asc' },
        { attemptOrdinal: 'asc' },
      ],
      select: {
        id: true,
        operationRunId: true,
        executionId: true,
        attemptOrdinal: true,
        operation: true,
        provider: true,
        requestedModel: true,
        actualModel: true,
        status: true,
        outcome: true,
        errorCode: true,
        pricingStatus: true,
        reservedCostUsd: true,
        chargedCostUsd: true,
        totalTokens: true,
        webSearchCalls: true,
        durationMs: true,
        createdAt: true,
        settledAt: true,
      },
    }),
    prisma.assistantGeoOperation.findMany({
      where: {
        actorUserId: { in: ownerUserIds },
        createdAt: {
          gte: new Date(earliest - 30_000),
          lte: now,
        },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        actorUserId: true,
        normalizedQuery: true,
        provider: true,
        status: true,
        durationMs: true,
        cacheHit: true,
        providerCallCount: true,
        errorCode: true,
        createdAt: true,
        usageAttempts: {
          orderBy: { attemptOrdinal: 'asc' },
          select: {
            id: true,
            attemptOrdinal: true,
            provider: true,
            status: true,
            outcome: true,
            errorCode: true,
            durationMs: true,
            createdAt: true,
            settledAt: true,
          },
        },
      },
    }),
  ]);

  for (const attempt of aiAttempts) {
    const receipts = receiptsByRun.get(attempt.operationRunId);
    if (!receipts) throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPT_RUN_INVALID');
    receipts.push({
      receiptType: 'AI',
      receiptId: attempt.id,
      executionId: attempt.executionId,
      attemptOrdinal: attempt.attemptOrdinal,
      provider: attempt.provider,
      operation: attempt.operation,
      requestedModel: attempt.requestedModel,
      actualModel: attempt.actualModel,
      status: attempt.status,
      outcome: attempt.outcome,
      errorCode: attempt.errorCode,
      pricingStatus: attempt.pricingStatus,
      reservedCostUsd: readDecimal(attempt.reservedCostUsd),
      chargedCostUsd: attempt.chargedCostUsd === null ? null : readDecimal(attempt.chargedCostUsd),
      totalTokens: attempt.totalTokens === null ? null : attempt.totalTokens.toString(),
      webSearchCalls: attempt.webSearchCalls,
      durationMs: attempt.durationMs,
      createdAt: attempt.createdAt.toISOString(),
      settledAt: attempt.settledAt?.toISOString() ?? null,
    });
  }

  const geoOperationsByRun = assignAssistantEvalGeoOperations(runs, geoOperations);
  for (const [runId, runOperations] of geoOperationsByRun) {
    const receipts = receiptsByRun.get(runId);
    for (const operation of runOperations) {
      receipts.push({
        receiptType: 'GEO_OPERATION',
        operationId: operation.id,
        provider: operation.provider,
        status: operation.status,
        errorCode: operation.errorCode,
        durationMs: operation.durationMs,
        cacheHit: operation.cacheHit,
        providerCallCount: operation.providerCallCount,
        createdAt: operation.createdAt.toISOString(),
      });
      for (const attempt of operation.usageAttempts) {
        receipts.push({
          receiptType: 'GEO',
          receiptId: attempt.id,
          operationId: operation.id,
          attemptOrdinal: attempt.attemptOrdinal,
          provider: attempt.provider,
          status: attempt.status,
          outcome: attempt.outcome,
          errorCode: attempt.errorCode,
          durationMs: attempt.durationMs,
          cacheHit: operation.cacheHit,
          providerCallCount: operation.providerCallCount,
          createdAt: attempt.createdAt.toISOString(),
          settledAt: attempt.settledAt?.toISOString() ?? null,
        });
      }
    }
  }
  return receiptsByRun;
}

function readDecimal(value) {
  if (!value || typeof value.toFixed !== 'function') {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID');
  }
  return requireUsd(value.toFixed(8));
}

function createAssistantEvalEvidenceBundle(input) {
  const generatedAt = readDate(input.generatedAt, 'ASSISTANT_EVAL_EVIDENCE_CLOCK_INVALID');
  readAssistantEvalArtifactRunIds(input.dataset, input.artifact, generatedAt);
  const references = input.artifact.runs;
  const recordById = uniqueMap(input.records, 'id', 'ASSISTANT_EVAL_EVIDENCE_RUNS_INVALID');
  const resultById = uniqueMap(
    input.evaluation?.results,
    'id',
    'ASSISTANT_EVAL_EVIDENCE_RESULTS_INVALID',
  );
  const provenanceById = uniqueMap(
    input.evaluation?.provenance,
    'id',
    'ASSISTANT_EVAL_EVIDENCE_PROVENANCE_INVALID',
  );
  const knownRunIds = new Set(references.map(({ runId }) => runId));
  if (!(input.providerReceiptsByRun instanceof Map)
    || recordById.size !== references.length
    || resultById.size !== references.length
    || provenanceById.size !== references.length
    || input.providerReceiptsByRun.size !== references.length
    || [...input.providerReceiptsByRun.keys()].some((runId) => !knownRunIds.has(runId))
    || references.some(({ runId }) => !input.providerReceiptsByRun.has(runId))) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_INCOMPLETE');
  }

  const expectedRunner = {
    datasetVersion: input.dataset.version,
    datasetSha256: computeAssistantEvalDatasetSha256(input.dataset),
    evaluatorVersion: assistantEvalEvaluatorVersion,
    evaluatedAt: input.artifact.evaluatedAt,
    caseCount: references.length,
    manifestRunMappingSha256: digestJson(references),
  };
  const runner = readRunnerReport(input.runnerReport, expectedRunner);
  if (requireDigest(input.databaseFingerprint, 'ASSISTANT_EVAL_EVIDENCE_DATABASE_MISMATCH')
    !== runner.databaseFingerprint) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_DATABASE_MISMATCH');
  }
  const cleanup = readCleanup(input.runnerReport?.cleanup, runner.databaseFingerprint);

  const cases = references.map(({ caseId, runId }) => {
    const record = recordById.get(runId);
    const result = resultById.get(caseId);
    const provenance = provenanceById.get(caseId);
    if (!record || !result || !provenance || provenance.runId !== runId) {
      throw new Error('ASSISTANT_EVAL_EVIDENCE_CORRELATION_INVALID');
    }
    if (record.status !== 'COMPLETED') throw new Error('ASSISTANT_EVAL_EVIDENCE_RUN_INVALID');
    const providerReceipts = input.providerReceiptsByRun.get(runId).map(readProviderReceipt);
    const quality = {
      passed: requireBoolean(result.passed, 'ASSISTANT_EVAL_EVIDENCE_RESULT_INVALID'),
      qualityScore: requireRate(result.qualityScore, 'ASSISTANT_EVAL_EVIDENCE_RESULT_INVALID'),
      qualityFlags: readAllowlistedStringArray(
        record.qualityFlags,
        assistantQualityFlags,
        'ASSISTANT_EVAL_EVIDENCE_RUN_INVALID',
      ),
      violations: readAllowlistedStringArray(
        result.violations,
        evalViolationSet,
        'ASSISTANT_EVAL_EVIDENCE_RESULT_INVALID',
      ),
      latencyMs: requireNonNegativeInteger(
        result.latencyMs,
        'ASSISTANT_EVAL_EVIDENCE_RESULT_INVALID',
      ),
      modelAttempts: requireNonNegativeInteger(
        result.modelAttempts,
        'ASSISTANT_EVAL_EVIDENCE_RESULT_INVALID',
      ),
      totalTokens: requireNonNegativeInteger(
        result.totalTokens,
        'ASSISTANT_EVAL_EVIDENCE_RESULT_INVALID',
      ),
      geoProviderCalls: requireNonNegativeInteger(
        result.geoProviderCalls,
        'ASSISTANT_EVAL_EVIDENCE_RESULT_INVALID',
      ),
    };
    assertCaseProviderReceiptCoverage(providerReceipts, quality, runner.providerMode);
    return {
      caseId,
      runId,
      status: 'COMPLETED',
      createdAt: requireIsoTimestamp(record.createdAt, 'ASSISTANT_EVAL_EVIDENCE_RUN_INVALID'),
      completedAt: requireIsoTimestamp(record.completedAt, 'ASSISTANT_EVAL_EVIDENCE_RUN_INVALID'),
      provenance: {
        answerDigest: requireDigest(
          provenance.answerDigest,
          'ASSISTANT_EVAL_EVIDENCE_PROVENANCE_INVALID',
        ),
        evidenceDigest: requireDigest(
          provenance.evidenceDigest,
          'ASSISTANT_EVAL_EVIDENCE_PROVENANCE_INVALID',
        ),
      },
      evidenceRevisions: readEvidenceRevisions(record.audit, record.evidence),
      providerReceipts,
      quality,
    };
  });
  if (cases.reduce((total, item) => total + item.quality.modelAttempts, 0)
    !== runner.modelRequestCount) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID');
  }
  const effectiveCostUnits = cases.reduce((total, item) => total + item.providerReceipts
    .filter(({ receiptType }) => receiptType === 'AI')
    .reduce((caseTotal, receipt) => caseTotal + usdUnits(receipt.chargedCostUsd), 0n), 0n);
  if (effectiveCostUnits !== usdUnits(runner.effectiveCostUsd)) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RUNNER_COST_MISMATCH');
  }

  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    dataset: {
      version: input.dataset.version,
      sha256: computeAssistantEvalDatasetSha256(input.dataset),
      caseCount: input.dataset.cases.length,
    },
    evaluator: {
      version: assistantEvalEvaluatorVersion,
      evaluatedAt: input.artifact.evaluatedAt,
    },
    runner,
    verdict: readEvalSummary(input.summary, input.dataset),
    cases,
    cleanup,
  };
}

function computeAssistantEvalEvidenceCoreSha256(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.runner)
    || !Array.isArray(value.cases) || !isRecord(value.cleanup)) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_DRAFT_INVALID');
  }
  const { cleanup: _cleanup, ...core } = value;
  return digestJson(core);
}

function computeAssistantEvalFinalizedEvidenceSha256(value) {
  if (!isRecord(value) || value?.cleanup?.phase !== 'FINALIZED') {
    throw new Error('ASSISTANT_EVAL_FINAL_EVIDENCE_INVALID');
  }
  return digestJson(value);
}

function finalizeAssistantEvalEvidenceBundle(draft, attestation, now = new Date()) {
  const code = 'ASSISTANT_EVAL_CLEANUP_ATTESTATION_INVALID';
  const current = readDate(now, code);
  const generatedAt = readDate(draft?.generatedAt, 'ASSISTANT_EVAL_EVIDENCE_DRAFT_INVALID');
  const databaseFingerprint = requireDigest(
    draft?.runner?.databaseFingerprint,
    'ASSISTANT_EVAL_EVIDENCE_DRAFT_INVALID',
  );
  readCleanup(draft?.cleanup, databaseFingerprint);
  if (!isRecord(attestation) || attestation.schemaVersion !== 1
    || attestation.databaseFingerprint !== databaseFingerprint
    || attestation.evidenceCoreSha256 !== computeAssistantEvalEvidenceCoreSha256(draft)
    || attestation.ordinaryLocalResourcesPreserved !== true
    || !Array.isArray(attestation.residualResources)
    || attestation.residualResources.length !== 0) {
    throw new Error(code);
  }
  const completedAt = readDate(attestation.completedAt, code);
  if (completedAt.getTime() < generatedAt.getTime()
    || completedAt.getTime() > current.getTime()) {
    throw new Error(code);
  }
  const ownedResources = readCleanupResourceMap(attestation.ownedResources, code);
  const removedResources = readCleanupResourceMap(attestation.removedResources, code);
  if (ownedResources.databases.length !== 1
    || ownedResources.databases[0] !== databaseFingerprint
    || JSON.stringify(ownedResources) !== JSON.stringify(removedResources)) {
    throw new Error(code);
  }
  return {
    ...draft,
    cleanup: {
      phase: 'FINALIZED',
      evidenceCoreSha256: attestation.evidenceCoreSha256,
      runner: draft.cleanup,
      external: {
        completedAt: completedAt.toISOString(),
        databaseFingerprint,
        ordinaryLocalResourcesPreserved: true,
        ownedResources,
        removedResources,
        residualResources: [],
      },
    },
  };
}

function readAssistantEvalFinalizedEvidenceBundle(value, dataset, now = new Date()) {
  const code = 'ASSISTANT_EVAL_FINAL_EVIDENCE_INVALID';
  const current = readDate(now, code);
  if (!isRecord(value) || value.schemaVersion !== 1
    || !hasExactKeys(value, [
      'schemaVersion',
      'generatedAt',
      'dataset',
      'evaluator',
      'runner',
      'verdict',
      'cases',
      'cleanup',
    ])
    || !isRecord(value.dataset)
    || !hasExactKeys(value.dataset, ['version', 'sha256', 'caseCount'])
    || value.dataset.version !== dataset?.version
    || value.dataset.sha256 !== computeAssistantEvalDatasetSha256(dataset)
    || value.dataset.caseCount !== dataset.cases.length
    || !isRecord(value.evaluator)
    || !hasExactKeys(value.evaluator, ['version', 'evaluatedAt'])
    || value.evaluator.version !== assistantEvalEvaluatorVersion
    || !Array.isArray(value.cases)
    || value.cases.length !== dataset.cases.length) {
    throw new Error(code);
  }
  const generatedAt = readDate(value.generatedAt, code);
  const evaluatedAt = readDate(value.evaluator.evaluatedAt, code);
  const maximumAgeMs = 24 * 60 * 60 * 1_000;
  if (generatedAt.getTime() < evaluatedAt.getTime()
    || generatedAt.getTime() > current.getTime()
    || current.getTime() - generatedAt.getTime() > maximumAgeMs
    || evaluatedAt.getTime() > current.getTime()
    || current.getTime() - evaluatedAt.getTime() > maximumAgeMs) {
    throw new Error(code);
  }

  const runIds = new Set();
  const providerReceiptIds = new Set();
  const cases = value.cases.map((item, index) => {
    if (!isRecord(item) || !hasExactKeys(item, [
      'caseId',
      'runId',
      'status',
      'createdAt',
      'completedAt',
      'provenance',
      'evidenceRevisions',
      'providerReceipts',
      'quality',
    ])
      || item.caseId !== dataset.cases[index]?.id
      || item.status !== 'COMPLETED'
      || runIds.has(item.runId)) {
      throw new Error(code);
    }
    const runId = requireUuid(item.runId, code);
    runIds.add(runId);
    const createdAt = readDate(item.createdAt, code);
    const completedAt = readDate(item.completedAt, code);
    if (createdAt.getTime() > completedAt.getTime()
      || completedAt.getTime() > evaluatedAt.getTime()
      || evaluatedAt.getTime() - createdAt.getTime() > maximumAgeMs) {
      throw new Error(code);
    }
    if (!isRecord(item.provenance)
      || !hasExactKeys(item.provenance, ['answerDigest', 'evidenceDigest'])) {
      throw new Error(code);
    }
    const evidenceRevisions = readSanitizedEvidenceRevisions(item.evidenceRevisions, code);
    const providerReceipts = readSanitizedProviderReceipts(item.providerReceipts, code);
    for (const receipt of providerReceipts) {
      const identifier = receipt.receiptType === 'GEO_OPERATION'
        ? `GEO_OPERATION:${receipt.operationId}`
        : `${receipt.receiptType}:${receipt.receiptId}`;
      if (providerReceiptIds.has(identifier)) throw new Error(code);
      providerReceiptIds.add(identifier);
    }
    const quality = readSanitizedQuality(item.quality, code);
    assertCaseProviderReceiptCoverage(providerReceipts, quality, value.runner?.providerMode);
    return {
      caseId: item.caseId,
      runId,
      status: 'COMPLETED',
      createdAt: createdAt.toISOString(),
      completedAt: completedAt.toISOString(),
      provenance: {
        answerDigest: requireDigest(item.provenance.answerDigest, code),
        evidenceDigest: requireDigest(item.provenance.evidenceDigest, code),
      },
      evidenceRevisions,
      providerReceipts,
      quality,
    };
  });
  if (JSON.stringify(cases) !== JSON.stringify(value.cases)) throw new Error(code);

  const expectedRunner = {
    datasetVersion: dataset.version,
    datasetSha256: value.dataset.sha256,
    evaluatorVersion: assistantEvalEvaluatorVersion,
    evaluatedAt: evaluatedAt.toISOString(),
    caseCount: cases.length,
    manifestRunMappingSha256: digestJson(cases.map(({ caseId, runId }) => ({ caseId, runId }))),
  };
  const runner = readRunnerReport(value.runner, expectedRunner);
  if (JSON.stringify(runner) !== JSON.stringify(value.runner)
    || cases.reduce((total, item) => total + item.quality.modelAttempts, 0)
      !== runner.modelRequestCount) {
    throw new Error(code);
  }
  const effectiveCostUnits = cases.reduce((total, item) => total + item.providerReceipts
    .filter(({ receiptType }) => receiptType === 'AI')
    .reduce((caseTotal, receipt) => caseTotal + usdUnits(receipt.chargedCostUsd), 0n), 0n);
  if (effectiveCostUnits !== usdUnits(runner.effectiveCostUsd)) throw new Error(code);

  const verdict = readEvalSummary(value.verdict, dataset);
  const recomputedVerdict = scoreAssistantEval(dataset, {
    datasetVersion: dataset.version,
    results: cases.map(({ caseId, quality }) => ({ id: caseId, ...quality })),
  });
  if (JSON.stringify(verdict) !== JSON.stringify(value.verdict)
    || JSON.stringify(recomputedVerdict) !== JSON.stringify(verdict)) {
    throw new Error(code);
  }
  const cleanup = readFinalizedCleanup(value.cleanup, {
    current,
    databaseFingerprint: runner.databaseFingerprint,
    evidence: value,
    generatedAt,
  });
  return {
    evidenceCoreSha256: cleanup.evidenceCoreSha256,
    finalizedEvidenceSha256: computeAssistantEvalFinalizedEvidenceSha256(value),
    runner,
    verdict,
    cleanup,
  };
}

function readAssistantEvalDraftEvidenceBundle(value, dataset, now = new Date()) {
  const code = 'ASSISTANT_EVAL_EVIDENCE_DRAFT_INVALID';
  const current = readDate(now, code);
  const databaseFingerprint = requireDigest(value?.runner?.databaseFingerprint, code);
  readCleanup(value?.cleanup, databaseFingerprint);
  const emptyResources = {
    databases: [databaseFingerprint],
    containers: [],
    networks: [],
    volumes: [],
    images: [],
  };
  const finalized = finalizeAssistantEvalEvidenceBundle(value, {
    schemaVersion: 1,
    completedAt: current.toISOString(),
    evidenceCoreSha256: computeAssistantEvalEvidenceCoreSha256(value),
    databaseFingerprint,
    ordinaryLocalResourcesPreserved: true,
    ownedResources: emptyResources,
    removedResources: emptyResources,
    residualResources: [],
  }, current);
  const validated = readAssistantEvalFinalizedEvidenceBundle(finalized, dataset, current);
  return { ...validated, cleanup: readCleanup(value.cleanup, databaseFingerprint) };
}

function readSanitizedEvidenceRevisions(value, code) {
  if (!Array.isArray(value)) throw new Error(code);
  const revisions = value.map((revision) => {
    if (!isRecord(revision)
      || !hasExactKeys(revision, ['kind', 'evidenceId', 'revisionId', 'observedAt'])) {
      throw new Error(code);
    }
    return readEvidenceRevision(revision);
  });
  if (new Set(revisions.map(evidenceRevisionKey)).size !== revisions.length) throw new Error(code);
  return revisions;
}

function readSanitizedProviderReceipts(value, code) {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((receipt) => readSanitizedProviderReceipt(receipt, code));
}

function readSanitizedProviderReceipt(value, code) {
  if (!isRecord(value)) throw new Error(code);
  if (value.receiptType === 'AI') {
    if (!hasExactKeys(value, [
      'receiptType', 'receiptId', 'executionId', 'attemptOrdinal', 'provider', 'operation',
      'requestedModel', 'actualModel', 'status', 'outcome', 'errorCodeDigest',
      'pricingStatus', 'reservedCostUsd', 'chargedCostUsd', 'totalTokens',
      'webSearchCalls', 'durationMs', 'createdAt', 'settledAt',
    ])
      || value.provider !== 'alibaba'
      || value.operation !== 'PLANNER'
      || value.status !== 'SETTLED'
      || !['ACCEPTED', 'LOCAL_VALIDATION_FAILED', 'PROVIDER_ERROR'].includes(value.outcome)
      || value.pricingStatus !== 'PRICED') {
      throw new Error(code);
    }
    const receipt = {
      receiptType: 'AI',
      receiptId: requireUuid(value.receiptId, code),
      executionId: requireUuid(value.executionId, code),
      attemptOrdinal: requirePositiveInteger(value.attemptOrdinal, code),
      provider: 'alibaba',
      operation: 'PLANNER',
      requestedModel: readAlibabaModel(value.requestedModel, code),
      actualModel: value.actualModel === null ? null : readAlibabaModel(value.actualModel, code),
      status: 'SETTLED',
      outcome: value.outcome,
      errorCodeDigest: readOptionalDigest(value.errorCodeDigest, code),
      pricingStatus: 'PRICED',
      reservedCostUsd: requireUsd(value.reservedCostUsd, code),
      chargedCostUsd: requireUsd(value.chargedCostUsd, code),
      totalTokens: readOptionalTokenCount(value.totalTokens, code),
      webSearchCalls: readOptionalNonNegativeInteger(value.webSearchCalls, code),
      durationMs: readOptionalNonNegativeInteger(value.durationMs, code),
      createdAt: requireIsoTimestamp(value.createdAt, code),
      settledAt: requireIsoTimestamp(value.settledAt, code),
    };
    if (usdUnits(receipt.chargedCostUsd) > usdUnits(receipt.reservedCostUsd)
      || receipt.outcome === 'ACCEPTED'
        && (receipt.actualModel === null
          || receipt.totalTokens === null
          || receipt.errorCodeDigest !== null)) {
      throw new Error(code);
    }
    return receipt;
  }
  if (value.receiptType === 'GEO_OPERATION') {
    if (!hasExactKeys(value, [
      'receiptType', 'operationId', 'provider', 'status', 'errorCodeDigest', 'durationMs',
      'cacheHit', 'providerCallCount', 'createdAt',
    ])
      || !geoProviders.has(value.provider)
      || !geoResolutionStatuses.has(value.status)
      || typeof value.cacheHit !== 'boolean') {
      throw new Error(code);
    }
    return {
      receiptType: 'GEO_OPERATION',
      operationId: requireUuid(value.operationId, code),
      provider: value.provider,
      status: value.status,
      errorCodeDigest: readOptionalDigest(value.errorCodeDigest, code),
      durationMs: requireNonNegativeInteger(value.durationMs, code),
      cacheHit: value.cacheHit,
      providerCallCount: requireNonNegativeInteger(value.providerCallCount, code),
      createdAt: requireIsoTimestamp(value.createdAt, code),
    };
  }
  if (value.receiptType === 'GEO') {
    if (!hasExactKeys(value, [
      'receiptType', 'receiptId', 'operationId', 'attemptOrdinal', 'provider', 'status',
      'outcome', 'errorCodeDigest', 'durationMs', 'cacheHit', 'providerCallCount',
      'createdAt', 'settledAt',
    ])
      || !['locationiq', 'overpass'].includes(value.provider)
      || value.status !== 'SETTLED'
      || !['SUCCESS', 'ERROR'].includes(value.outcome)
      || typeof value.cacheHit !== 'boolean') {
      throw new Error(code);
    }
    const receipt = {
      receiptType: 'GEO',
      receiptId: requireUuid(value.receiptId, code),
      operationId: requireUuid(value.operationId, code),
      attemptOrdinal: requirePositiveInteger(value.attemptOrdinal, code),
      provider: value.provider,
      status: 'SETTLED',
      outcome: value.outcome,
      errorCodeDigest: readOptionalDigest(value.errorCodeDigest, code),
      durationMs: readOptionalNonNegativeInteger(value.durationMs, code),
      cacheHit: value.cacheHit,
      providerCallCount: requireNonNegativeInteger(value.providerCallCount, code),
      createdAt: requireIsoTimestamp(value.createdAt, code),
      settledAt: requireIsoTimestamp(value.settledAt, code),
    };
    if (receipt.outcome === 'SUCCESS' && receipt.errorCodeDigest !== null
      || receipt.outcome === 'ERROR' && receipt.errorCodeDigest === null) {
      throw new Error(code);
    }
    return receipt;
  }
  throw new Error(code);
}

function readSanitizedQuality(value, code) {
  if (!isRecord(value) || !hasExactKeys(value, [
    'passed',
    'qualityScore',
    'qualityFlags',
    'violations',
    'latencyMs',
    'modelAttempts',
    'totalTokens',
    'geoProviderCalls',
  ])) throw new Error(code);
  return {
    passed: requireBoolean(value.passed, code),
    qualityScore: requireRate(value.qualityScore, code),
    qualityFlags: readAllowlistedStringArray(value.qualityFlags, assistantQualityFlags, code),
    violations: readAllowlistedStringArray(value.violations, evalViolationSet, code),
    latencyMs: requireNonNegativeInteger(value.latencyMs, code),
    modelAttempts: requireNonNegativeInteger(value.modelAttempts, code),
    totalTokens: requireNonNegativeInteger(value.totalTokens, code),
    geoProviderCalls: requireNonNegativeInteger(value.geoProviderCalls, code),
  };
}

function readFinalizedCleanup(value, input) {
  const code = 'ASSISTANT_EVAL_FINAL_EVIDENCE_INVALID';
  if (!isRecord(value) || !hasExactKeys(value, [
    'phase', 'evidenceCoreSha256', 'runner', 'external',
  ])
    || value.phase !== 'FINALIZED'
    || value.evidenceCoreSha256 !== computeAssistantEvalEvidenceCoreSha256(input.evidence)
    || !isRecord(value.external)
    || !hasExactKeys(value.external, [
      'completedAt',
      'databaseFingerprint',
      'ordinaryLocalResourcesPreserved',
      'ownedResources',
      'removedResources',
      'residualResources',
    ])
    || value.external.databaseFingerprint !== input.databaseFingerprint
    || value.external.ordinaryLocalResourcesPreserved !== true
    || !Array.isArray(value.external.residualResources)
    || value.external.residualResources.length !== 0) {
    throw new Error(code);
  }
  const runner = readCleanup(value.runner, input.databaseFingerprint);
  const completedAt = readDate(value.external.completedAt, code);
  const ownedResources = readCleanupResourceMap(value.external.ownedResources, code);
  const removedResources = readCleanupResourceMap(value.external.removedResources, code);
  if (completedAt.getTime() < input.generatedAt.getTime()
    || completedAt.getTime() > input.current.getTime()
    || ownedResources.databases.length !== 1
    || ownedResources.databases[0] !== input.databaseFingerprint
    || JSON.stringify(ownedResources) !== JSON.stringify(removedResources)) {
    throw new Error(code);
  }
  const cleanup = {
    phase: 'FINALIZED',
    evidenceCoreSha256: value.evidenceCoreSha256,
    runner,
    external: {
      completedAt: completedAt.toISOString(),
      databaseFingerprint: input.databaseFingerprint,
      ordinaryLocalResourcesPreserved: true,
      ownedResources,
      removedResources,
      residualResources: [],
    },
  };
  if (JSON.stringify(cleanup) !== JSON.stringify(value)) throw new Error(code);
  return cleanup;
}

function readCleanupResourceMap(value, code) {
  if (!isRecord(value)
    || Object.keys(value).length !== cleanupResourceKeys.length
    || cleanupResourceKeys.some((key) => !(key in value))) {
    throw new Error(code);
  }
  return Object.fromEntries(cleanupResourceKeys.map((key) => {
    const identifiers = value[key];
    if (!Array.isArray(identifiers)
      || identifiers.some((identifier) => (
        typeof identifier !== 'string' || !cleanupResourceIdentifierPattern.test(identifier)
      ))
      || new Set(identifiers).size !== identifiers.length) {
      throw new Error(code);
    }
    return [key, [...identifiers].sort()];
  }));
}

function readEvidenceRevisions(audit, evidence) {
  const revisions = isRecord(audit) ? audit.evidenceRevisions : null;
  if (!Array.isArray(revisions) || !Array.isArray(evidence)) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_REVISIONS_INVALID');
  }
  const sanitized = revisions.map((revision) => readEvidenceRevision(revision));
  const expected = evidence.map((item) => evidenceRevisionFromPersistedEvidence(item));
  if (new Set(sanitized.map(evidenceRevisionKey)).size !== sanitized.length
    || new Set(expected.map(evidenceRevisionKey)).size !== expected.length
    || sanitized.length !== expected.length
    || sanitized.some((revision) => !expected.some((item) => (
      evidenceRevisionKey(item) === evidenceRevisionKey(revision)
    )))) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_REVISIONS_INVALID');
  }
  return sanitized;
}

function readProviderReceipt(value) {
  if (!isRecord(value)) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID');
  }
  if (value.receiptType === 'AI') return readAiProviderReceipt(value);
  if (value.receiptType === 'GEO_OPERATION') return readGeoOperationReceipt(value);
  if (value.receiptType === 'GEO') return readGeoProviderReceipt(value);
  throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID');
}

function readRunnerReport(value, expected) {
  if (!isRecord(value)) throw new Error('ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID');
  const limits = value.limits;
  if (!isRecord(limits)
    || value.runnerVersion !== 'assistant-eval-runner-v1'
    || value.passed !== true
    || value.datasetVersion !== expected.datasetVersion
    || value.datasetSha256 !== expected.datasetSha256
    || value.evaluatorVersion !== expected.evaluatorVersion
    || value.evaluatedAt !== expected.evaluatedAt
    || value.caseCount !== expected.caseCount
    || value.completedRunCount !== expected.caseCount
    || !['fake', 'alibaba'].includes(value.providerMode)
    || !digestPattern.test(value.runtimeConfigSha256)
    || typeof value.releaseSha !== 'string'
    || !/^[0-9a-f]{40}$/u.test(value.releaseSha)
    || value.releaseImageIdentity !== null
      && (typeof value.releaseImageIdentity !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(value.releaseImageIdentity))
    || !digestPattern.test(value.databaseFingerprint)
    || value.manifestRunMappingSha256 !== expected.manifestRunMappingSha256) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID');
  }
  const requestsPerMinute = requirePositiveInteger(
    limits.requestsPerMinute,
    'ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID',
  );
  const dailyRequestCap = requirePositiveInteger(
    limits.dailyRequestCap,
    'ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID',
  );
  const maximumCostUsd = requireUsd(
    limits.maximumCostUsd,
    'ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID',
  );
  const effectiveCostUsd = requireUsd(
    value.effectiveCostUsd,
    'ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID',
  );
  if (usdUnits(effectiveCostUsd) > usdUnits(maximumCostUsd)
    || value.providerMode === 'fake' && usdUnits(effectiveCostUsd) !== 0n) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID');
  }
  return {
    runnerVersion: 'assistant-eval-runner-v1',
    passed: true,
    datasetVersion: value.datasetVersion,
    datasetSha256: value.datasetSha256,
    evaluatorVersion: value.evaluatorVersion,
    evaluatedAt: value.evaluatedAt,
    caseCount: value.caseCount,
    completedRunCount: requireNonNegativeInteger(
      value.completedRunCount,
      'ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID',
    ),
    modelRequestCount: requireNonNegativeInteger(
      value.modelRequestCount,
      'ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID',
    ),
    effectiveCostUsd,
    providerMode: value.providerMode,
    runtimeConfigSha256: value.runtimeConfigSha256,
    releaseSha: value.releaseSha,
    releaseImageIdentity: value.releaseImageIdentity,
    databaseFingerprint: value.databaseFingerprint,
    manifestRunMappingSha256: value.manifestRunMappingSha256,
    limits: {
      requestsPerMinute,
      dailyRequestCap,
      maximumCostUsd,
    },
  };
}

function readEvalSummary(value, dataset) {
  if (!isRecord(value) || !isRecord(value.categoryPassRates) || !Array.isArray(value.gates)) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID');
  }
  if (value.datasetVersion !== dataset.version
    || value.caseCount !== dataset.cases.length
    || Object.keys(value.categoryPassRates).length !== assistantEvalCategories.length
    || assistantEvalCategories.some((category) => !(category in value.categoryPassRates))) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID');
  }
  const categoryPassRates = Object.fromEntries(assistantEvalCategories.map((category) => [
    category,
    requireRate(value.categoryPassRates[category], 'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID'),
  ]));
  const seenGateCodes = new Set();
  return {
    datasetVersion: value.datasetVersion,
    passed: requireBoolean(value.passed, 'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID'),
    caseCount: value.caseCount,
    overallPassRate: requireRate(
      value.overallPassRate,
      'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID',
    ),
    averageQualityScore: requireRate(
      value.averageQualityScore,
      'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID',
    ),
    p95LatencyMs: requireNonNegativeNumber(
      value.p95LatencyMs,
      'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID',
    ),
    averageModelAttempts: requireNonNegativeNumber(
      value.averageModelAttempts,
      'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID',
    ),
    averageTotalTokens: requireNonNegativeNumber(
      value.averageTotalTokens,
      'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID',
    ),
    averageGeoProviderCalls: requireNonNegativeNumber(
      value.averageGeoProviderCalls,
      'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID',
    ),
    categoryPassRates,
    gates: value.gates.map((gate) => {
      if (!isRecord(gate) || !safeCodePattern.test(gate.code) || seenGateCodes.has(gate.code)) {
        throw new Error('ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID');
      }
      seenGateCodes.add(gate.code);
      return {
        code: gate.code,
        passed: requireBoolean(gate.passed, 'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID'),
        actual: requireNonNegativeNumber(gate.actual, 'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID'),
        threshold: requireNonNegativeNumber(
          gate.threshold,
          'ASSISTANT_EVAL_EVIDENCE_SUMMARY_INVALID',
        ),
      };
    }),
  };
}

function readCleanup(value, databaseFingerprint) {
  if (!isRecord(value)
    || value.persistenceClosed !== true
    || value.credentialsScrubbed !== true
    || value.persistedEvidenceRetained !== true
    || !Array.isArray(value.runnerOwnedResources)
    || value.runnerOwnedResources.length !== 2
    || !isRecord(value.externalDisposableDatabase)) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_CLEANUP_INVALID');
  }
  const resources = value.runnerOwnedResources.map((resource) => {
    if (!isRecord(resource)) throw new Error('ASSISTANT_EVAL_EVIDENCE_CLEANUP_INVALID');
    if (resource.type === 'DATABASE_CONNECTION'
      && resource.identifier === databaseFingerprint
      && resource.disposition === 'CLOSED') {
      return { type: resource.type, identifier: resource.identifier, disposition: resource.disposition };
    }
    if (resource.type === 'IN_MEMORY_CREDENTIALS'
      && resource.identifier === 'assistant-eval-auth'
      && resource.disposition === 'SCRUBBED') {
      return { type: resource.type, identifier: resource.identifier, disposition: resource.disposition };
    }
    throw new Error('ASSISTANT_EVAL_EVIDENCE_CLEANUP_INVALID');
  });
  if (new Set(resources.map(({ type }) => type)).size !== 2
    || value.externalDisposableDatabase.fingerprint !== databaseFingerprint
    || value.externalDisposableDatabase.owner !== 'CALLER'
    || value.externalDisposableDatabase.disposition !== 'RETAINED_FOR_EVALUATOR') {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_CLEANUP_INVALID');
  }
  return {
    persistenceClosed: true,
    credentialsScrubbed: true,
    persistedEvidenceRetained: true,
    runnerOwnedResources: resources,
    externalDisposableDatabase: {
      fingerprint: databaseFingerprint,
      owner: 'CALLER',
      disposition: 'RETAINED_FOR_EVALUATOR',
    },
  };
}

function readEvidenceRevision(value) {
  const code = 'ASSISTANT_EVAL_EVIDENCE_REVISIONS_INVALID';
  if (!isRecord(value)
    || !['PLATFORMA_FEED_UNIT', 'PLATFORMA_OBJECT', 'KNOWLEDGE_SOURCE'].includes(value.kind)) {
    throw new Error(code);
  }
  return {
    kind: value.kind,
    evidenceId: requireUuid(value.evidenceId, code),
    revisionId: requireUuid(value.revisionId, code),
    observedAt: requireIsoTimestamp(value.observedAt, code),
  };
}

function evidenceRevisionFromPersistedEvidence(value) {
  const code = 'ASSISTANT_EVAL_EVIDENCE_REVISIONS_INVALID';
  if (!isRecord(value)) throw new Error(code);
  if (uuidPattern.test(value.unitId)) {
    return {
      kind: 'PLATFORMA_FEED_UNIT',
      evidenceId: value.unitId,
      revisionId: value.unitId,
      observedAt: requireIsoTimestamp(value.updatedAt, code),
    };
  }
  if (value.evidenceType === 'PLATFORMA_OBJECT' && uuidPattern.test(value.objectId)) {
    return {
      kind: 'PLATFORMA_OBJECT',
      evidenceId: value.objectId,
      revisionId: value.objectId,
      observedAt: requireIsoTimestamp(value.updatedAt, code),
    };
  }
  if (uuidPattern.test(value.factId) && uuidPattern.test(value.sourceRevisionId)) {
    return {
      kind: 'KNOWLEDGE_SOURCE',
      evidenceId: value.factId,
      revisionId: value.sourceRevisionId,
      observedAt: requireIsoTimestamp(value.fetchedAt, code),
    };
  }
  throw new Error(code);
}

function evidenceRevisionKey(value) {
  return JSON.stringify([value.kind, value.evidenceId, value.revisionId, value.observedAt]);
}

function readAiProviderReceipt(value) {
  const code = 'ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID';
  const receiptId = requireUuid(value.receiptId, code);
  const executionId = requireUuid(value.executionId, code);
  const attemptOrdinal = requirePositiveInteger(value.attemptOrdinal, code);
  if (value.provider !== 'alibaba'
    || value.operation !== 'PLANNER'
    || value.status !== 'SETTLED'
    || !['ACCEPTED', 'LOCAL_VALIDATION_FAILED', 'PROVIDER_ERROR'].includes(value.outcome)
    || value.pricingStatus !== 'PRICED') {
    throw new Error(code);
  }
  const requestedModel = readAlibabaModel(value.requestedModel, code);
  const actualModel = value.actualModel === null
    ? null
    : readAlibabaModel(value.actualModel, code);
  const errorCode = readOptionalInternalErrorCode(value.errorCode, code);
  const reservedCostUsd = requireUsd(value.reservedCostUsd, code);
  const chargedCostUsd = requireUsd(value.chargedCostUsd, code);
  const totalTokens = readOptionalTokenCount(value.totalTokens, code);
  const webSearchCalls = readOptionalNonNegativeInteger(value.webSearchCalls, code);
  const durationMs = readOptionalNonNegativeInteger(value.durationMs, code);
  const createdAt = requireIsoTimestamp(value.createdAt, code);
  const settledAt = requireIsoTimestamp(value.settledAt, code);
  if (usdUnits(chargedCostUsd) > usdUnits(reservedCostUsd)
    || value.outcome === 'ACCEPTED' && (actualModel === null || totalTokens === null || errorCode !== null)) {
    throw new Error(code);
  }
  return {
    receiptType: 'AI',
    receiptId,
    executionId,
    attemptOrdinal,
    provider: 'alibaba',
    operation: 'PLANNER',
    requestedModel,
    actualModel,
    status: 'SETTLED',
    outcome: value.outcome,
    errorCodeDigest: digestInternalErrorCode(errorCode),
    pricingStatus: 'PRICED',
    reservedCostUsd,
    chargedCostUsd,
    totalTokens,
    webSearchCalls,
    durationMs,
    createdAt,
    settledAt,
  };
}

function readGeoOperationReceipt(value) {
  const code = 'ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID';
  if (!geoProviders.has(value.provider)
    || !geoResolutionStatuses.has(value.status)
    || typeof value.cacheHit !== 'boolean') {
    throw new Error(code);
  }
  return {
    receiptType: 'GEO_OPERATION',
    operationId: requireUuid(value.operationId, code),
    provider: value.provider,
    status: value.status,
    errorCodeDigest: digestInternalErrorCode(
      readOptionalInternalErrorCode(value.errorCode, code),
    ),
    durationMs: requireNonNegativeInteger(value.durationMs, code),
    cacheHit: value.cacheHit,
    providerCallCount: requireNonNegativeInteger(value.providerCallCount, code),
    createdAt: requireIsoTimestamp(value.createdAt, code),
  };
}

function readGeoProviderReceipt(value) {
  const code = 'ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID';
  if (!['locationiq', 'overpass'].includes(value.provider)
    || value.status !== 'SETTLED'
    || !['SUCCESS', 'ERROR'].includes(value.outcome)
    || typeof value.cacheHit !== 'boolean') {
    throw new Error(code);
  }
  const errorCode = readOptionalInternalErrorCode(value.errorCode, code);
  if (value.outcome === 'SUCCESS' && errorCode !== null
    || value.outcome === 'ERROR' && errorCode === null) throw new Error(code);
  return {
    receiptType: 'GEO',
    receiptId: requireUuid(value.receiptId, code),
    operationId: requireUuid(value.operationId, code),
    attemptOrdinal: requirePositiveInteger(value.attemptOrdinal, code),
    provider: value.provider,
    status: 'SETTLED',
    outcome: value.outcome,
    errorCodeDigest: digestInternalErrorCode(errorCode),
    durationMs: readOptionalNonNegativeInteger(value.durationMs, code),
    cacheHit: value.cacheHit,
    providerCallCount: requireNonNegativeInteger(value.providerCallCount, code),
    createdAt: requireIsoTimestamp(value.createdAt, code),
    settledAt: requireIsoTimestamp(value.settledAt, code),
  };
}

function assertCaseProviderReceiptCoverage(receipts, quality, providerMode) {
  const aiReceipts = receipts.filter(({ receiptType }) => receiptType === 'AI');
  if (providerMode === 'alibaba' && aiReceipts.length !== quality.modelAttempts
    || providerMode === 'fake' && aiReceipts.length !== 0
    || new Set(aiReceipts.map(({ receiptId }) => receiptId)).size !== aiReceipts.length
    || aiReceipts.length > 0
      && (new Set(aiReceipts.map(({ executionId }) => executionId)).size !== 1
        || [...aiReceipts].sort((left, right) => left.attemptOrdinal - right.attemptOrdinal)
          .some(({ attemptOrdinal }, index) => attemptOrdinal !== index + 1))) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPTS_INCOMPLETE');
  }
  const geoOperations = receipts.filter(({ receiptType }) => receiptType === 'GEO_OPERATION');
  const geoAttempts = receipts.filter(({ receiptType }) => receiptType === 'GEO');
  const operationIds = new Set(geoOperations.map(({ operationId }) => operationId));
  const receiptIds = new Set(geoAttempts.map(({ receiptId }) => receiptId));
  if (operationIds.size !== geoOperations.length || receiptIds.size !== geoAttempts.length
    || geoAttempts.some(({ operationId }) => !operationIds.has(operationId))) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPTS_INCOMPLETE');
  }
  for (const operation of geoOperations) {
    const attempts = geoAttempts.filter(({ operationId }) => operationId === operation.operationId);
    const ordinals = attempts.map(({ attemptOrdinal }) => attemptOrdinal).sort((left, right) => left - right);
    if (attempts.length !== operation.providerCallCount
      || attempts.some(({ providerCallCount }) => providerCallCount !== operation.providerCallCount)
      || ordinals.some((ordinal, index) => ordinal !== index + 1)) {
      throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPTS_INCOMPLETE');
    }
  }
  const geoProviderCalls = geoOperations
    .reduce((total, receipt) => total + receipt.providerCallCount, 0);
  if (geoProviderCalls !== quality.geoProviderCalls) {
    throw new Error('ASSISTANT_EVAL_EVIDENCE_RECEIPTS_INCOMPLETE');
  }
}

function requireUuid(value, code) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error(code);
  return value;
}

function requireDigest(value, code) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(code);
  return value;
}

function readOptionalDigest(value, code) {
  return value === null ? null : requireDigest(value, code);
}

function readAlibabaModel(value, code) {
  if (typeof value !== 'string' || !alibabaModels.has(value)) throw new Error(code);
  return value;
}

function readOptionalInternalErrorCode(value, code) {
  if (value === null) return null;
  if (typeof value !== 'string' || !internalErrorCodePattern.test(value)) throw new Error(code);
  return value;
}

function digestInternalErrorCode(value) {
  return value === null ? null : createHash('sha256').update(value).digest('hex');
}

function requireUsd(value, code = 'ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID') {
  if (typeof value !== 'string' || !usdPattern.test(value)) throw new Error(code);
  return value;
}

function usdUnits(value) {
  return BigInt(value.replace('.', ''));
}

function readOptionalTokenCount(value, code) {
  if (value === null) return null;
  if (typeof value !== 'string' || !tokenCountPattern.test(value)) throw new Error(code);
  return value;
}

function readOptionalNonNegativeInteger(value, code) {
  if (value === null) return null;
  return requireNonNegativeInteger(value, code);
}

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function uniqueMap(values, key, code) {
  if (!Array.isArray(values)) throw new Error(code);
  const result = new Map();
  for (const value of values) {
    if (!isRecord(value) || typeof value[key] !== 'string' || result.has(value[key])) {
      throw new Error(code);
    }
    result.set(value[key], value);
  }
  return result;
}

function requireIsoTimestamp(value, code) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(code);
  return new Date(value).toISOString();
}

function requireBoolean(value, code) {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
}

function requireNonNegativeNumber(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function requireNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function requirePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function requireRate(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(code);
  }
  return value;
}

function readAllowlistedStringArray(value, allowed, code) {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || !allowed.has(item))
    || new Set(value).size !== value.length) throw new Error(code);
  return [...value];
}

function readDate(value, code) {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(code);
  return result;
}

function mergeAssistantMessage(message) {
  if (!message || !isRecord(message.answerJson)) return null;
  return { ...message.answerJson, content: message.content };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

module.exports = {
  assignAssistantEvalGeoOperations,
  attributeAssistantEvalGeoProviderCalls,
  computeAssistantEvalEvidenceCoreSha256,
  computeAssistantEvalFinalizedEvidenceSha256,
  createAssistantEvalEvidenceBundle,
  finalizeAssistantEvalEvidenceBundle,
  loadAssistantEvalDatabaseIdentity,
  loadAssistantEvalDatabaseFingerprint,
  loadAssistantEvalProviderReceipts,
  loadAssistantEvalRunRecords,
  loadAssistantEvalRunRecordsByIds,
  readAssistantEvalDraftEvidenceBundle,
  readAssistantEvalFinalizedEvidenceBundle,
};
