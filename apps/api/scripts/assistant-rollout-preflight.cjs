#!/usr/bin/env node

'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const {
  loadAssistantEvalDataset,
} = require('../dist/assistant/eval/assistant-eval.js');
const {
  assessAssistantRolloutTransition,
  getAssistantRuntimeConfig,
} = require('../dist/assistant/assistant-runtime-config.js');
const {
  assessAssistantPilotCohort,
  assessAssistantPilotCohortAgainstApproval,
  assessAssistantEvalReleaseCompatibility,
  assessAssistantGeoUsageReceipts,
  assessAssistantProviderBudgetContract,
  collectAssistantProviderComparisonRunIds,
  assessAssistantRolloutObservation,
  assessAssistantRolloutStageRecord,
  assessAssistantSourceHealth,
  computeAssistantRolloutApprovalDigest,
  countAssistantRolloutCriticalErrors,
  createAssistantGeoUsageReceiptWhere,
  createAssistantRolloutTerminalObservationWhere,
  readAssistantOverpassBudgetLimits,
  readAssistantRolloutBudgetReadiness,
} = require('../dist/assistant/rollout/assistant-rollout-preflight.js');
const {
  computeAssistantReleaseRuntimeConfigSha256,
  readAssistantReleaseIdentity,
} = require('../dist/assistant/eval/assistant-eval-runtime-contract.js');
const {
  readAssistantEvalFinalizedEvidenceBundle,
} = require('./assistant-eval-runtime.cjs');

async function run() {
  const options = parseAssistantRolloutPreflightArguments(process.argv.slice(2), process.env);
  const {
    evidencePath,
    recordStage,
    targetStage,
  } = options;

  const runtime = getAssistantRuntimeConfig(process.env);
  const now = new Date();
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(
    resolve(__dirname, '../tests/fixtures/assistant/assistant-eval-v1.json'),
    'utf8',
  )));
  const evidence = readJsonFile(evidencePath, 'ASSISTANT_EVAL_RELEASE_EVIDENCE_INVALID');
  const validatedEvidence = readAssistantEvalFinalizedEvidenceBundle(evidence, dataset, now);
  const budgets = readAssistantRolloutBudgetReadiness(process.env);
  const prisma = new PrismaClient();
  const evalSummary = validatedEvidence.verdict;
  const evalProviderMode = validatedEvidence.runner.providerMode;
  const currentReleaseIdentity = readAssistantReleaseIdentity(process.env);
  const evalCompatibility = assessAssistantEvalReleaseCompatibility({
    runtimeConfigSha256: validatedEvidence.runner.runtimeConfigSha256,
    releaseSha: validatedEvidence.runner.releaseSha,
    releaseImageIdentity: validatedEvidence.runner.releaseImageIdentity,
  }, {
    runtimeConfigSha256: computeAssistantReleaseRuntimeConfigSha256(process.env),
    ...currentReleaseIdentity,
  });
  const evalGatePassed = evalSummary.passed
    && evalProviderMode === 'openai'
    && evalCompatibility.passed;
  let sourceHealth;
  let criticalErrorCount;
  let providerBudgetContract;
  let geoUsageContract;
  let pilotCohort;
  let observation;
  let stageRecord;
  const evidenceCoreSha256 = validatedEvidence.evidenceCoreSha256;
  const finalizedEvidenceSha256 = validatedEvidence.finalizedEvidenceSha256;
  try {
    const rolloutEvents = await prisma.assistantRolloutEvent.findMany({
      select: { stage: true, gateDigest: true, approvalJson: true, startedAt: true },
    });
    stageRecord = assessAssistantRolloutStageRecord(runtime.rolloutStage, rolloutEvents);
    if (!stageRecord.passed || !stageRecord.current) {
      throw new Error(stageRecord.blocker ?? 'ASSISTANT_ROLLOUT_STAGE_EVENT_REQUIRED');
    }
    const previousStageStartedAt = stageRecord.current.startedAt;
    const requiresPilotCohort = runtime.rolloutStage === 'PILOT' || targetStage === 'PILOT';
    const [sources, createdRuns, terminalRuns, pilotUsers, geoUsageAttempts] = await Promise.all([
      prisma.assistantKnowledgeSource.findMany({
        where: { state: 'ACTIVE' },
        select: {
          id: true,
          lastSuccessAt: true,
          lastIndexedAt: true,
          lastErrorCode: true,
        },
      }),
      prisma.assistantRun.findMany({
        where: { createdAt: { gte: previousStageStartedAt, lte: now } },
        select: {
          id: true,
          ownerUserId: true,
          status: true,
          qualityFlags: true,
        },
      }),
      prisma.assistantRun.findMany({
        where: createAssistantRolloutTerminalObservationWhere(previousStageStartedAt, now),
        select: {
          id: true,
          ownerUserId: true,
          status: true,
          qualityFlags: true,
          completedAt: true,
        },
      }),
      requiresPilotCohort
        ? prisma.user.findMany({
          where: { id: { in: runtime.pilotUserIds } },
          select: {
            id: true,
            status: true,
            deletedAt: true,
            role: {
              select: {
                permissions: {
                  select: { permission: { select: { key: true } } },
                },
              },
            },
          },
        })
        : Promise.resolve([]),
      prisma.assistantGeoUsageAttempt.findMany({
        where: createAssistantGeoUsageReceiptWhere(previousStageStartedAt, now),
        select: {
          id: true,
          operationId: true,
          attemptOrdinal: true,
          provider: true,
          status: true,
          outcome: true,
          errorCode: true,
          durationMs: true,
          minuteStartedAt: true,
          dayStartedAt: true,
          createdAt: true,
          settledAt: true,
        },
      }),
    ]);
    const initialProviderComparisonRunIds = collectAssistantProviderComparisonRunIds(
      createdRuns,
      terminalRuns,
      [],
    );
    const providerAttempts = await prisma.assistantAiUsageAttempt.findMany({
      where: {
        OR: [
          { createdAt: { gte: previousStageStartedAt, lte: now } },
          { settledAt: { gte: previousStageStartedAt, lte: now } },
          { status: 'RESERVED' },
          ...(initialProviderComparisonRunIds.length === 0 ? [] : [{
            operation: 'PLANNER',
            operationRunId: { in: initialProviderComparisonRunIds },
          }]),
        ],
      },
      select: {
        operationRunId: true,
        executionId: true,
        attemptOrdinal: true,
        operation: true,
        requestedModel: true,
        actualModel: true,
        status: true,
        outcome: true,
        pricingStatus: true,
        reservedCostUsd: true,
        chargedCostUsd: true,
        inputTokens: true,
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        totalTokens: true,
        webSearchCalls: true,
      },
    });
    const providerComparisonRunIds = collectAssistantProviderComparisonRunIds(
      createdRuns,
      terminalRuns,
      providerAttempts,
    );
    const [providerTelemetryRuns, executionFences] = providerComparisonRunIds.length === 0
      ? [[], []]
      : await Promise.all([
        prisma.assistantRun.findMany({
          where: { id: { in: providerComparisonRunIds } },
          select: { id: true, telemetryJson: true },
        }),
        prisma.assistantAiExecutionFence.findMany({
          where: { operationRunId: { in: providerComparisonRunIds } },
          select: { operationRunId: true, executionId: true },
        }),
      ]);
    sourceHealth = assessAssistantSourceHealth(sources);
    providerBudgetContract = assessAssistantProviderBudgetContract(providerAttempts, {
      operationRunIds: providerComparisonRunIds,
      operations: ['PLANNER'],
      executions: executionFences,
      reportedUsage: providerTelemetryRuns.flatMap(({ id, telemetryJson }) => (
        readAssistantOpenAiReportedUsage(id, telemetryJson)
      )),
    });
    const overpassLimits = readAssistantOverpassBudgetLimits(process.env);
    geoUsageContract = assessAssistantGeoUsageReceipts(geoUsageAttempts, {
      windowStartedAt: previousStageStartedAt,
      now,
      overpassRequestsPerMinute: overpassLimits.requestsPerMinute,
      overpassDailyBudget: overpassLimits.dailyBudget,
    });
    criticalErrorCount = countAssistantRolloutCriticalErrors(terminalRuns)
      + providerBudgetContract.violationCount
      + geoUsageContract.violationCount;
    const mappedPilotUsers = pilotUsers.map((user) => ({
      id: user.id,
      status: user.status,
      deletedAt: user.deletedAt,
      permissions: user.role.permissions.map(({ permission }) => permission.key),
    }));
    pilotCohort = requiresPilotCohort
      ? runtime.rolloutStage === 'PILOT'
        ? assessAssistantPilotCohortAgainstApproval(
            runtime.pilotUserIds,
            mappedPilotUsers,
            stageRecord.current.approvalJson,
          )
        : assessAssistantPilotCohort(runtime.pilotUserIds, mappedPilotUsers)
      : { passed: true, configuredCount: 0, userIds: [], missingUserIds: [], ineligibleUserIds: [] };
    observation = assessAssistantRolloutObservation({
      currentStage: runtime.rolloutStage,
      pilotUserIds: runtime.pilotUserIds,
      previousStageStartedAt,
      now,
      runs: terminalRuns,
    });
  } finally {
    await prisma.$disconnect();
  }
  const transition = assessAssistantRolloutTransition({
    currentStage: runtime.rolloutStage,
    targetStage,
    evalPassed: evalGatePassed,
    sourceHealthPassed: sourceHealth.passed,
    budgetsConfigured: budgets.passed,
    criticalErrorCount,
    providerBudgetContractPassed: providerBudgetContract.passed,
    pilotCohortPassed: pilotCohort.passed,
    observationPassed: observation.passed,
  });
  const output = {
    passed: transition.passed,
    currentStage: runtime.rolloutStage,
    targetStage,
    blockers: transition.blockers,
    eval: {
      version: evalSummary.datasetVersion,
      passed: evalGatePassed,
      caseCount: evalSummary.caseCount,
      providerMode: evalProviderMode,
      evidenceCoreSha256,
      finalizedEvidenceSha256,
    },
    evalCompatibility,
    sourceHealth,
    budgets,
    providerBudgetContract,
    geoUsageContract,
    pilotCohort,
    observation,
    stageRecord: {
      stage: stageRecord.current.stage,
      startedAt: stageRecord.current.startedAt.toISOString(),
    },
    criticalErrorCount,
  };
  if (recordStage && transition.passed) {
    const stageStartedAt = new Date();
    const approvalJson = {
      kind: 'ASSISTANT_ROLLOUT_PREFLIGHT',
      passed: true,
      currentStage: runtime.rolloutStage,
      targetStage,
      stageStartedAt: stageStartedAt.toISOString(),
      eval: output.eval,
      sourceHealth,
      budgets,
      pilotCohort,
      observation,
      criticalErrorCount,
    };
    const gateDigest = computeAssistantRolloutApprovalDigest(approvalJson);
    const writer = new PrismaClient();
    try {
      await writer.assistantRolloutEvent.create({
        data: { stage: targetStage, gateDigest, approvalJson, startedAt: stageStartedAt },
      });
      output.recordedStage = targetStage;
      output.approvalDigest = gateDigest;
    } finally {
      await writer.$disconnect();
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!transition.passed) process.exitCode = 2;
}

function parseAssistantRolloutPreflightArguments(argv, environment) {
  const valueArguments = new Set([
    '--eval-evidence',
    '--target-stage',
  ]);
  for (let index = 0; index < argv.length;) {
    const argument = argv[index];
    if (argument === '--record-stage') {
      index += 1;
      continue;
    }
    if (!valueArguments.has(argument) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('ASSISTANT_ROLLOUT_ARGUMENT_INVALID');
    }
    index += 2;
  }
  if (argv.filter((value) => value === '--record-stage').length > 1) {
    throw new Error('ASSISTANT_ROLLOUT_ARGUMENT_DUPLICATED');
  }
  const evidenceValue = readArgument(argv, '--eval-evidence')
    ?? environment.ASSISTANT_EVAL_EVIDENCE_PATH;
  const targetStage = readArgument(argv, '--target-stage')
    ?? environment.ASSISTANT_ROLLOUT_TARGET_STAGE;
  if (!evidenceValue) throw new Error('ASSISTANT_EVAL_RELEASE_EVIDENCE_REQUIRED');
  if (!targetStage) throw new Error('ASSISTANT_ROLLOUT_TARGET_STAGE_REQUIRED');
  const evidencePath = resolve(evidenceValue);
  return {
    recordStage: argv.includes('--record-stage'),
    evidencePath,
    targetStage,
  };
}

function readArgument(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length === 0) return undefined;
  if (indexes.length !== 1) throw new Error('ASSISTANT_ROLLOUT_ARGUMENT_DUPLICATED');
  return argv[indexes[0] + 1];
}

function readJsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(code);
  }
}

function readAssistantOpenAiReportedUsage(operationRunId, telemetryJson) {
  if (!Array.isArray(telemetryJson)) return [];
  return telemetryJson.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || entry.provider !== 'openai') return [];
    return [{
      operationRunId,
      model: entry.model,
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      cacheWriteInputTokens: entry.cacheWriteInputTokens,
      outputTokens: entry.outputTokens,
      reasoningTokens: entry.reasoningTokens,
      totalTokens: entry.totalTokens,
      webSearchCalls: entry.webSearchCalls,
    }];
  });
}

if (require.main === module) {
  void run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'ASSISTANT_ROLLOUT_PREFLIGHT_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseAssistantRolloutPreflightArguments, run };
