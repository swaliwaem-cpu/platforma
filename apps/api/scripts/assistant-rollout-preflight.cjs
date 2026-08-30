#!/usr/bin/env node

'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const {
  evaluateAssistantEvalArtifact,
  loadAssistantEvalDataset,
  scoreAssistantEval,
} = require('../dist/assistant/eval/assistant-eval.js');
const {
  assessAssistantRolloutTransition,
  getAssistantRuntimeConfig,
} = require('../dist/assistant/assistant-runtime-config.js');
const {
  assessAssistantPilotCohort,
  assessAssistantPilotCohortAgainstApproval,
  assessAssistantProviderBudgetContract,
  collectAssistantProviderComparisonRunIds,
  assessAssistantRolloutObservation,
  assessAssistantRolloutStageRecord,
  assessAssistantSourceHealth,
  computeAssistantRolloutApprovalDigest,
  countAssistantRolloutCriticalErrors,
  readAssistantRolloutBudgetReadiness,
} = require('../dist/assistant/rollout/assistant-rollout-preflight.js');
const { loadAssistantEvalRunRecords } = require('./assistant-eval-runtime.cjs');

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'ASSISTANT_ROLLOUT_PREFLIGHT_FAILED'}\n`);
  process.exitCode = 1;
});

async function run() {
  const recordStage = process.argv.includes('--record-stage');
  const resultsPath = readArgument('--eval-results') ?? process.env.ASSISTANT_EVAL_RESULTS_PATH;
  const targetStage = readArgument('--target-stage') ?? process.env.ASSISTANT_ROLLOUT_TARGET_STAGE;
  if (!resultsPath) throw new Error('ASSISTANT_EVAL_RESULTS_PATH_REQUIRED');
  if (!targetStage) throw new Error('ASSISTANT_ROLLOUT_TARGET_STAGE_REQUIRED');

  const runtime = getAssistantRuntimeConfig(process.env);
  const now = new Date();
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(
    resolve(__dirname, '../tests/fixtures/assistant/assistant-eval-v1.json'),
    'utf8',
  )));
  const artifact = JSON.parse(readFileSync(resolve(resultsPath), 'utf8'));
  const budgets = readAssistantRolloutBudgetReadiness(process.env);
  const prisma = new PrismaClient();
  let evalSummary;
  let sourceHealth;
  let criticalErrorCount;
  let providerBudgetContract;
  let pilotCohort;
  let observation;
  let stageRecord;
  try {
    const evalRunRecords = await loadAssistantEvalRunRecords(prisma, dataset, artifact);
    evalSummary = scoreAssistantEval(
      dataset,
      evaluateAssistantEvalArtifact(dataset, artifact, evalRunRecords),
    );
    const rolloutEvents = await prisma.assistantRolloutEvent.findMany({
      select: { stage: true, gateDigest: true, approvalJson: true, startedAt: true },
    });
    stageRecord = assessAssistantRolloutStageRecord(runtime.rolloutStage, rolloutEvents);
    if (!stageRecord.passed || !stageRecord.current) {
      throw new Error(stageRecord.blocker ?? 'ASSISTANT_ROLLOUT_STAGE_EVENT_REQUIRED');
    }
    const previousStageStartedAt = stageRecord.current.startedAt;
    const requiresPilotCohort = runtime.rolloutStage === 'PILOT' || targetStage === 'PILOT';
    const [sources, runs, observationRuns, pilotUsers] = await Promise.all([
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
        where: {
          status: 'COMPLETED',
          completedAt: { gte: previousStageStartedAt, lte: now },
        },
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
    ]);
    const initialProviderComparisonRunIds = collectAssistantProviderComparisonRunIds(
      runs,
      observationRuns,
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
      runs,
      observationRuns,
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
    criticalErrorCount = countAssistantRolloutCriticalErrors(runs)
      + providerBudgetContract.violationCount;
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
      runs: observationRuns,
    });
  } finally {
    await prisma.$disconnect();
  }
  const transition = assessAssistantRolloutTransition({
    currentStage: runtime.rolloutStage,
    targetStage,
    evalPassed: evalSummary.passed,
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
      passed: evalSummary.passed,
      caseCount: evalSummary.caseCount,
    },
    sourceHealth,
    budgets,
    providerBudgetContract,
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

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
