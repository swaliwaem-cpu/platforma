#!/usr/bin/env node

'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const {
  ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION,
  estimateAssistantEmbeddingCallCost,
  formatAssistantUsd,
  parseAssistantUsd,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  AssistantAiUsageBudgetService,
} = require('../dist/assistant/operations/assistant-ai-usage-budget.service.js');
const {
  AssistantEmbeddingGateway,
  assistantEmbeddingBenchmarkDatasetSha256,
} = require('../dist/assistant/sources/assistant-embedding.gateway.js');

const benchmarkName = 'assistant-embedding-retrieval-v1';
const datasetPath = resolve(__dirname, '../tests/fixtures/assistant/embedding-benchmark-v1.json');

async function runAssistantEmbeddingBenchmark(input = {}) {
  const environment = input.environment ?? process.env;
  const argv = input.argv ?? process.argv.slice(2);
  const datasetBytes = input.datasetBytes ?? readFileSync(datasetPath);
  const dataset = readDataset(datasetBytes);
  const candidates = parseCandidates(environment.ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES);
  const plan = createBenchmarkPlan(dataset, candidates);

  if (!argv.includes('--live')) {
    assertOnlyKnownArguments(argv, false);
    return createDryRunReport(dataset, candidates, plan);
  }

  const limits = readLiveLimits(argv);
  assertLiveReadiness(environment, plan, limits);
  const ids = input.ids ?? { operationRunId: randomUUID(), executionId: randomUUID() };
  const ledger = input.ledger ?? createDefaultLedger(environment);
  const createGateway = input.createGateway ?? ((candidate) => new AssistantEmbeddingGateway({
    ...environment,
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_MODEL: candidate.model,
    ASSISTANT_EMBEDDING_DIMENSIONS: String(candidate.dimensions),
    ASSISTANT_MODEL_DAILY_BUDGET_USD: limits.maximumCostUsd,
  }, input.fetchImpl ?? fetch, ledger.usageBudgets));
  const results = [];
  let attemptOrdinal = 0;
  let failureCode = null;
  let attempts = [];
  const operationContext = {
    operation: 'EMBEDDING_BENCHMARK',
    operationRunId: ids.operationRunId,
    executionId: ids.executionId,
    nextAttemptOrdinal() {
      attemptOrdinal += 1;
      if (attemptOrdinal > limits.maximumHttpAttempts) {
        throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_ATTEMPT_LIMIT_EXCEEDED');
      }
      return attemptOrdinal;
    },
  };

  try {
    const documentTexts = dataset.documents.map(({ text }) => text);
    const queryTexts = dataset.cases.map(({ query }) => query);
    for (const candidate of candidates) {
      const gateway = createGateway(candidate);
      const startedAt = Date.now();
      const documents = await gateway.embed(documentTexts, operationContext);
      const queries = await gateway.embed(queryTexts, operationContext);
      results.push(scoreCandidate(dataset, candidate, documents, queries, Date.now() - startedAt));
    }
  } catch (error) {
    failureCode = readSafeErrorCode(error, 'ASSISTANT_EMBEDDING_BENCHMARK_FAILED');
  }

  let ledgerFailureCode = null;
  let disconnectFailureCode = null;
  try {
    attempts = await ledger.loadAttempts(ids.operationRunId, ids.executionId);
  } catch {
    ledgerFailureCode = 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_READ_FAILED';
  }
  try {
    await ledger.disconnect?.();
  } catch {
    disconnectFailureCode = 'ASSISTANT_EMBEDDING_BENCHMARK_DISCONNECT_FAILED';
  }
  results.sort(compareResults);
  if (ledgerFailureCode) {
    return createUnavailableLedgerReport({
      dataset,
      ids,
      limits,
      plan,
      results,
      errorCode: ledgerFailureCode,
    });
  }

  let summary;
  try {
    summary = summarizeAttempts(attempts, ids);
  } catch {
    return createUnavailableLedgerReport({
      dataset,
      ids,
      limits,
      plan,
      results,
      errorCode: 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_INVALID',
    });
  }
  if (summary.attempts > limits.maximumHttpAttempts
    || parseAssistantUsd(summary.effectiveCostUsd) > parseAssistantUsd(limits.maximumCostUsd)) {
    failureCode = 'ASSISTANT_EMBEDDING_BENCHMARK_PERSISTED_LIMIT_EXCEEDED';
  }
  if (summary.reservedAttempts > 0) {
    failureCode = 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_UNSETTLED';
  }
  if (!failureCode && summary.attempts !== plan.plannedHttpAttempts) {
    failureCode = 'ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_INCOMPLETE';
  }
  if (!failureCode && results.length !== candidates.length) {
    failureCode = 'ASSISTANT_EMBEDDING_BENCHMARK_RESULTS_INCOMPLETE';
  }
  failureCode ??= disconnectFailureCode;
  const passed = failureCode === null;
  const winner = passed ? results[0] ?? null : null;

  return {
    benchmark: benchmarkName,
    mode: 'LIVE',
    passed,
    errorCode: failureCode,
    datasetSha256: dataset.sha256,
    cases: dataset.cases.length,
    documents: dataset.documents.length,
    limits,
    operationRunId: ids.operationRunId,
    executionId: ids.executionId,
    plannedHttpAttempts: plan.plannedHttpAttempts,
    maximumEstimatedCostUsd: plan.maximumEstimatedCostUsd,
    providerCalls: summary.attempts,
    pricingCatalogVersion: ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION,
    ledger: summary,
    winner,
    rolloutGate: winner
      ? `${winner.model}:${winner.dimensions}:${dataset.sha256}`
      : null,
    results,
  };
}

function createUnavailableLedgerReport(input) {
  return {
    benchmark: benchmarkName,
    mode: 'LIVE',
    passed: false,
    errorCode: input.errorCode,
    datasetSha256: input.dataset.sha256,
    cases: input.dataset.cases.length,
    documents: input.dataset.documents.length,
    limits: input.limits,
    operationRunId: input.ids.operationRunId,
    executionId: input.ids.executionId,
    plannedHttpAttempts: input.plan.plannedHttpAttempts,
    maximumEstimatedCostUsd: input.plan.maximumEstimatedCostUsd,
    providerCalls: null,
    pricingCatalogVersion: ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION,
    ledger: { status: 'UNAVAILABLE', errorCode: input.errorCode },
    winner: null,
    rolloutGate: null,
    results: input.results,
  };
}

function createDryRunReport(dataset, candidates, plan) {
  return {
    benchmark: benchmarkName,
    mode: 'DRY_RUN',
    passed: true,
    datasetSha256: dataset.sha256,
    cases: dataset.cases.length,
    documents: dataset.documents.length,
    candidates,
    plannedHttpAttempts: plan.plannedHttpAttempts,
    maximumEstimatedCostUsd: plan.maximumEstimatedCostUsd,
    providerCalls: 0,
    pricingCatalogVersion: ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION,
  };
}

function createBenchmarkPlan(dataset, candidates) {
  const documentBytes = dataset.documents.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
  const queryBytes = dataset.cases.reduce((sum, item) => sum + Buffer.byteLength(item.query), 0);
  let maximumEstimatedCostUnits = 0n;
  for (const candidate of candidates) {
    for (const inputBytes of [documentBytes, queryBytes]) {
      const estimate = estimateAssistantEmbeddingCallCost({ ...candidate, inputBytes });
      if (estimate.status === 'MODEL_UNPRICED') {
        throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_MODEL_UNPRICED');
      }
      if (estimate.status === 'DIMENSIONS_UNSUPPORTED') {
        throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_DIMENSIONS_UNSUPPORTED');
      }
      if (estimate.status !== 'PRICED' || estimate.estimatedUsdUnits === null) {
        throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_COST_UNPRICED');
      }
      maximumEstimatedCostUnits += estimate.estimatedUsdUnits;
    }
  }
  return {
    plannedHttpAttempts: candidates.length * 2,
    maximumEstimatedCostUsd: formatAssistantUsd(maximumEstimatedCostUnits),
  };
}

function assertLiveReadiness(environment, plan, limits) {
  if (environment.ASSISTANT_EMBEDDING_BENCHMARK_ENABLED !== 'true') {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_ENABLED_REQUIRED');
  }
  if (environment.ASSISTANT_EMBEDDING_LIVE !== 'true') {
    throw new Error('ASSISTANT_EMBEDDING_LIVE_REQUIRED');
  }
  if (environment.ASSISTANT_PAID_CALLS_CONFIRMED !== 'true') {
    throw new Error('ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED');
  }
  if (typeof environment.OPENAI_API_KEY !== 'string' || !environment.OPENAI_API_KEY.trim()) {
    throw new Error('OPENAI_API_KEY_REQUIRED');
  }
  if (environment.NODE_ENV === 'production'
    || environment.DEPLOYMENT_ENV === 'production'
    || environment.DEPLOYMENT_ENV === 'staging') {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_PRODUCTION_FORBIDDEN');
  }
  if (environment.ASSISTANT_LOCAL_PAID_SMOKE_DISPOSABLE_DB !== 'true'
    || !isDisposableDatabaseUrl(environment.DATABASE_URL)) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_DISPOSABLE_DB_REQUIRED');
  }
  if (plan.plannedHttpAttempts > limits.maximumHttpAttempts) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_ATTEMPT_LIMIT_EXCEEDED');
  }
  if (parseAssistantUsd(plan.maximumEstimatedCostUsd) > parseAssistantUsd(limits.maximumCostUsd)) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_COST_LIMIT_EXCEEDED');
  }
}

function scoreCandidate(dataset, candidate, documents, queries, durationMs) {
  if (documents.model !== candidate.model || queries.model !== candidate.model
    || documents.vectors.length !== dataset.documents.length
    || queries.vectors.length !== dataset.cases.length) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_RESPONSE_INVALID');
  }
  const rankings = queries.vectors.map((queryVector) => dataset.documents
    .map((document, index) => ({ id: document.id, score: cosine(queryVector, documents.vectors[index]) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)));
  const reciprocalRanks = rankings.map((ranking, index) => {
    const relevant = new Set(dataset.cases[index].relevantDocumentIds);
    const rank = ranking.findIndex(({ id }) => relevant.has(id));
    return rank === -1 ? 0 : 1 / (rank + 1);
  });
  const recallAt3 = rankings.filter((ranking, index) => {
    const relevant = new Set(dataset.cases[index].relevantDocumentIds);
    return ranking.slice(0, 3).some(({ id }) => relevant.has(id));
  }).length / rankings.length;
  return {
    model: candidate.model,
    dimensions: candidate.dimensions,
    meanReciprocalRank: round(mean(reciprocalRanks)),
    recallAt3: round(recallAt3),
    durationMs,
  };
}

function summarizeAttempts(attempts, ids) {
  if (!Array.isArray(attempts)) throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_INVALID');
  let effectiveCostUnits = 0n;
  let reservedAttempts = 0;
  let inputTokens = 0;
  let unknownUsageAttempts = 0;
  const ordinals = new Set();
  for (const attempt of attempts) {
    if (!attempt || attempt.operationRunId !== ids.operationRunId
      || attempt.executionId !== ids.executionId
      || attempt.operation !== 'EMBEDDING_BENCHMARK'
      || !Number.isSafeInteger(attempt.attemptOrdinal)
      || attempt.attemptOrdinal < 1
      || ordinals.has(attempt.attemptOrdinal)) {
      throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_INVALID');
    }
    ordinals.add(attempt.attemptOrdinal);
    if (Number.isSafeInteger(attempt.inputTokens) && attempt.inputTokens >= 0) inputTokens += attempt.inputTokens;
    else unknownUsageAttempts += 1;
    if (attempt.status === 'SETTLED'
      && attempt.chargedCostUsd !== null
      && attempt.chargedCostUsd !== undefined) {
      effectiveCostUnits += readUsd(attempt.chargedCostUsd);
    } else {
      reservedAttempts += 1;
      effectiveCostUnits += readUsd(attempt.reservedCostUsd);
    }
  }
  return {
    attempts: attempts.length,
    inputTokens,
    unknownUsageAttempts,
    reservedAttempts,
    effectiveCostUsd: formatAssistantUsd(effectiveCostUnits),
  };
}

function createDefaultLedger(environment) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
  return {
    usageBudgets: new AssistantAiUsageBudgetService(prisma),
    async loadAttempts(operationRunId, executionId) {
      return prisma.assistantAiUsageAttempt.findMany({
        where: { operationRunId, executionId, operation: 'EMBEDDING_BENCHMARK' },
        orderBy: { attemptOrdinal: 'asc' },
        select: {
          operationRunId: true,
          executionId: true,
          attemptOrdinal: true,
          operation: true,
          status: true,
          reservedCostUsd: true,
          chargedCostUsd: true,
          inputTokens: true,
        },
      });
    },
    async disconnect() { await prisma.$disconnect(); },
  };
}

function readDataset(bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== assistantEmbeddingBenchmarkDatasetSha256) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_DATASET_HASH_MISMATCH');
  }
  let dataset;
  try { dataset = JSON.parse(bytes.toString('utf8')); } catch {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_DATASET_INVALID');
  }
  if (!dataset || !Array.isArray(dataset.documents) || !Array.isArray(dataset.cases)
    || dataset.documents.length === 0 || dataset.cases.length === 0
    || dataset.documents.some((item) => !item || typeof item.id !== 'string' || typeof item.text !== 'string')
    || dataset.cases.some((item) => !item || typeof item.query !== 'string'
      || !Array.isArray(item.relevantDocumentIds))) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_DATASET_INVALID');
  }
  return { ...dataset, sha256 };
}

function parseCandidates(value) {
  if (!value) throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_REQUIRED');
  let parsed;
  try { parsed = JSON.parse(value); } catch {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 5) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_INVALID');
  }
  const candidates = parsed.map((candidate) => {
    if (!candidate || typeof candidate !== 'object'
      || typeof candidate.model !== 'string' || !candidate.model.trim()
      || !Number.isInteger(candidate.dimensions)) {
      throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_INVALID');
    }
    return { model: candidate.model.trim(), dimensions: candidate.dimensions };
  });
  if (new Set(candidates.map(({ model, dimensions }) => `${model}:${dimensions}`)).size !== candidates.length) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_CANDIDATES_INVALID');
  }
  return candidates;
}

function readLiveLimits(argv) {
  assertOnlyKnownArguments(argv, true);
  const maximumHttpAttempts = Number(readArgument(argv, '--max-http-attempts'));
  const rawMaximumCostUsd = readArgument(argv, '--max-cost-usd');
  if (!Number.isSafeInteger(maximumHttpAttempts) || maximumHttpAttempts < 1 || maximumHttpAttempts > 100) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LIMITS_INVALID');
  }
  let maximumCostUsd;
  try { maximumCostUsd = formatAssistantUsd(parseAssistantUsd(rawMaximumCostUsd)); } catch {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LIMITS_INVALID');
  }
  if (parseAssistantUsd(maximumCostUsd) === 0n) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LIMITS_INVALID');
  }
  return { maximumHttpAttempts, maximumCostUsd };
}

function assertOnlyKnownArguments(argv, live) {
  const expected = live ? new Set(['--live', '--max-http-attempts', '--max-cost-usd']) : new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!expected.has(argument)) throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_ARGUMENT_INVALID');
    if (argument !== '--live') index += 1;
  }
  if (live && argv.filter((value) => value === '--live').length !== 1) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_ARGUMENT_INVALID');
  }
}

function readArgument(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LIMITS_REQUIRED');
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LIMITS_REQUIRED');
  return value;
}

function isDisposableDatabaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    const localHosts = new Set(['postgres', 'localhost', '127.0.0.1', '[::1]']);
    const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
    return (url.protocol === 'postgresql:' || url.protocol === 'postgres:')
      && localHosts.has(url.hostname)
      && /(?:smoke|test|disposable|benchmark)/iu.test(database)
      && !url.hash;
  } catch { return false; }
}

function readUsd(value) {
  const normalized = typeof value === 'string'
    ? value
    : value && typeof value.toFixed === 'function' ? value.toFixed(8) : null;
  if (normalized === null) throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_INVALID');
  try { return parseAssistantUsd(normalized); } catch {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_LEDGER_INVALID');
  }
}

function readSafeErrorCode(error, fallback) {
  const value = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,119}$/u.test(value) ? value : fallback;
}

function compareResults(left, right) {
  return right.meanReciprocalRank - left.meanReciprocalRank
    || right.recallAt3 - left.recallAt3
    || left.durationMs - right.durationMs
    || left.model.localeCompare(right.model);
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_RESPONSE_INVALID');
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  if (!Number.isFinite(denominator) || denominator === 0) {
    throw new Error('ASSISTANT_EMBEDDING_BENCHMARK_RESPONSE_INVALID');
  }
  return dot / denominator;
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function round(value) { return Number(value.toFixed(6)); }

async function main() {
  const report = await runAssistantEmbeddingBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${readSafeErrorCode(error, 'ASSISTANT_EMBEDDING_BENCHMARK_FAILED')}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseCandidates, runAssistantEmbeddingBenchmark };
