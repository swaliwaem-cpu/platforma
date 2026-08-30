import { AssistantRunStatus } from '@prisma/client';
import { createHash } from 'node:crypto';

import {
  isAssistantGeoProviderEnabled,
  type AssistantRolloutStage,
} from '../assistant-runtime-config';
import { parseAssistantUsd } from '../operations/assistant-ai-cost';
import { readAssistantPaidProviderReadiness } from '../operations/assistant-paid-readiness';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

type AssistantSourceHealthRecord = {
  id: string;
  lastSuccessAt: Date | null;
  lastIndexedAt: Date | null;
  lastErrorCode: string | null;
};

type AssistantRolloutRunRecord = {
  ownerUserId: string;
  status: AssistantRunStatus | 'COMPLETED' | 'FAILED';
  qualityFlags: string[];
};

type AssistantProviderBudgetContractAttempt = {
  operationRunId: string;
  executionId: string;
  attemptOrdinal: number;
  operation: string;
  requestedModel?: string;
  actualModel?: string | null;
  status: string;
  outcome: string | null;
  pricingStatus: string;
  reservedCostUsd: string | { toFixed(fractionDigits: number): string };
  chargedCostUsd: string | { toFixed(fractionDigits: number): string } | null;
  inputTokens?: number | bigint | null;
  cachedInputTokens?: number | bigint | null;
  cacheWriteInputTokens?: number | bigint | null;
  outputTokens?: number | bigint | null;
  reasoningTokens?: number | bigint | null;
  totalTokens?: number | bigint | null;
  webSearchCalls: number | null;
};

type AssistantProviderReportedUsage = {
  operationRunId: string;
  attemptOrdinal?: number | null;
  model: string;
  inputTokens: number | bigint | null;
  cachedInputTokens: number | bigint | null;
  cacheWriteInputTokens: number | bigint | null;
  outputTokens: number | bigint | null;
  reasoningTokens: number | bigint | null;
  totalTokens: number | bigint | null;
  webSearchCalls: number | bigint | null;
};

type AssistantProviderReportedUsageComparison = {
  operationRunIds: string[];
  operations?: string[];
  executions?: Array<{ operationRunId: string; executionId: string }>;
  reportedUsage: AssistantProviderReportedUsage[];
};

type AssistantGeoUsageAttemptRecord = {
  id: string;
  operationId: string;
  attemptOrdinal: number;
  provider: string;
  status: string;
  outcome: string | null;
  errorCode: string | null;
  durationMs: number | null;
  minuteStartedAt: Date;
  dayStartedAt: Date;
  createdAt: Date;
  settledAt: Date | null;
};

type AssistantRolloutObservationRunRecord = AssistantRolloutRunRecord & {
  completedAt: Date | null;
};

type AssistantPilotUserRecord = {
  id: string;
  status: string;
  deletedAt: Date | null;
  permissions: string[];
};

const maximumSourceAgeMs = 36 * 60 * 60 * 1_000;
const criticalQualityFlags = new Set([
  'HARD_FILTER_VIOLATION',
  'UNSUPPORTED_FACT',
  'STALE_PRICE_UNLABELED',
  'BROKEN_LINK',
]);
const providerBudgetContractViolation = 'PROVIDER_BUDGET_CONTRACT_VIOLATION';
const providerUsageFields = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
  'webSearchCalls',
] as const;
const pilotMinimumUsers = 8;
const pilotMaximumUsers = 12;
const administrativePermissions = new Set([
  'admin:access',
  'assistant:audit:read',
  'assistant:sources:manage',
]);

type AssistantRolloutEventRecord = {
  stage: string;
  gateDigest: string;
  approvalJson: unknown;
  startedAt: Date;
};

export function assessAssistantRolloutStageRecord(
  stage: AssistantRolloutStage,
  events: AssistantRolloutEventRecord[],
  now = new Date(),
) {
  const current = events.find((event) => event.stage === stage) ?? null;
  const stages = ['ADMINS', 'PILOT', 'ALL'];
  const stageIndex = stages.indexOf(stage);
  const previousStage = stageIndex > 0 ? stages[stageIndex - 1] : null;
  const previous = previousStage === null
    ? null
    : events.find((event) => event.stage === previousStage) ?? null;
  const requiredChain = stages.slice(0, stageIndex)
    .map((requiredStage) => events.find((event) => event.stage === requiredStage) ?? null);
  const recordedChain = [...requiredChain, current]
    .filter((event): event is AssistantRolloutEventRecord => event !== null);
  let blocker: string | null = null;
  if (requiredChain.some((event) => event === null)) {
    blocker = 'ASSISTANT_ROLLOUT_PREVIOUS_STAGE_EVENT_REQUIRED';
  } else if (requiredChain.some((event, index) => (
    index > 0 && event!.startedAt.getTime() < requiredChain[index - 1]!.startedAt.getTime()
  ))) {
    blocker = 'ASSISTANT_ROLLOUT_STAGE_EVENT_ORDER_INVALID';
  } else if (current && previous && current.startedAt.getTime() < previous.startedAt.getTime()) {
    blocker = 'ASSISTANT_ROLLOUT_STAGE_EVENT_ORDER_INVALID';
  } else if (current && current.startedAt.getTime() > now.getTime()) {
    blocker = 'ASSISTANT_ROLLOUT_STAGE_EVENT_FUTURE';
  } else if (previous && previous.startedAt.getTime() > now.getTime()) {
    blocker = 'ASSISTANT_ROLLOUT_PREVIOUS_STAGE_EVENT_FUTURE';
  } else if (recordedChain.some((event) => !hasValidAssistantRolloutApproval(event))) {
    blocker = 'ASSISTANT_ROLLOUT_STAGE_APPROVAL_INVALID';
  }
  return { passed: blocker === null, current, previous, blocker };
}

function hasValidAssistantRolloutApproval(event: AssistantRolloutEventRecord) {
  const approval = isRecord(event.approvalJson) ? event.approvalJson : null;
  if (event.stage === 'ADMINS') {
    return event.gateDigest === '0'.repeat(64)
      && approval !== null
      && hasExactKeys(approval, ['kind', 'passed', 'targetStage'])
      && approval.kind === 'MIGRATION_BASELINE'
      && approval.passed === true
      && approval.targetStage === 'ADMINS';
  }
  const evalGate = approval && isRecord(approval.eval) ? approval.eval : null;
  const sourceHealth = approval && isRecord(approval.sourceHealth) ? approval.sourceHealth : null;
  const budgets = approval && isRecord(approval.budgets) ? approval.budgets : null;
  const pilotCohort = approval && isRecord(approval.pilotCohort) ? approval.pilotCohort : null;
  const observation = approval && isRecord(approval.observation) ? approval.observation : null;
  const expectedCurrentStage = event.stage === 'PILOT' ? 'ADMINS' : 'PILOT';
  return /^[0-9a-f]{64}$/u.test(event.gateDigest)
    && !/^0{64}$/u.test(event.gateDigest)
    && approval !== null
    && hasExactKeys(approval, [
      'kind',
      'passed',
      'currentStage',
      'targetStage',
      'stageStartedAt',
      'eval',
      'sourceHealth',
      'budgets',
      'pilotCohort',
      'observation',
      'criticalErrorCount',
    ])
    && approval?.kind === 'ASSISTANT_ROLLOUT_PREFLIGHT'
    && approval.passed === true
    && approval.currentStage === expectedCurrentStage
    && approval.targetStage === event.stage
    && approval.stageStartedAt === event.startedAt.toISOString()
    && approval.criticalErrorCount === 0
    && evalGate !== null
    && hasExactKeys(evalGate, [
      'version',
      'passed',
      'caseCount',
      'providerMode',
      'evidenceCoreSha256',
      'finalizedEvidenceSha256',
    ])
    && evalGate.version === 'assistant-eval-v1'
    && evalGate.passed === true
    && evalGate.caseCount === 200
    && evalGate.providerMode === 'openai'
    && typeof evalGate.evidenceCoreSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(evalGate.evidenceCoreSha256)
    && typeof evalGate.finalizedEvidenceSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(evalGate.finalizedEvidenceSha256)
    && sourceHealth !== null
    && hasExactKeys(sourceHealth, ['passed', 'activeSourceCount', 'unhealthySourceIds'])
    && sourceHealth.passed === true
    && isPositiveIntegerValue(sourceHealth.activeSourceCount)
    && isEmptyArray(sourceHealth.unhealthySourceIds)
    && budgets !== null
    && hasExactKeys(budgets, ['passed', 'missing'])
    && budgets.passed === true
    && isEmptyArray(budgets.missing)
    && pilotCohort !== null
    && hasExactKeys(pilotCohort, [
      'passed', 'configuredCount', 'userIds', 'missingUserIds', 'ineligibleUserIds',
    ])
    && pilotCohort.passed === true
    && typeof pilotCohort.configuredCount === 'number'
    && Number.isInteger(pilotCohort.configuredCount)
    && pilotCohort.configuredCount >= pilotMinimumUsers
    && pilotCohort.configuredCount <= pilotMaximumUsers
    && isCanonicalPilotUserIds(pilotCohort.userIds, pilotCohort.configuredCount)
    && isEmptyArray(pilotCohort.missingUserIds)
    && isEmptyArray(pilotCohort.ineligibleUserIds)
    && observation !== null
    && hasExactKeys(observation, [
      'passed', 'runCount', 'uniqueUserCount', 'missingPilotUserIds', 'blockers',
    ])
    && observation.passed === true
    && isPositiveIntegerValue(observation.runCount)
    && isPositiveIntegerValue(observation.uniqueUserCount)
    && isEmptyArray(observation.missingPilotUserIds)
    && isEmptyArray(observation.blockers)
    && computeAssistantRolloutApprovalDigest(approval) === event.gateDigest;
}

export function computeAssistantRolloutApprovalDigest(approval: unknown) {
  return createHash('sha256').update(stableStringify(approval)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('ASSISTANT_ROLLOUT_APPROVAL_NOT_SERIALIZABLE');
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === [...expectedKeys].sort()[index]);
}

function isEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length === 0;
}

function isPositiveIntegerValue(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isCanonicalPilotUserIds(value: unknown, expectedCount: number) {
  if (!Array.isArray(value)
    || value.length !== expectedCount
    || value.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) return false;
  return new Set(value).size === value.length
    && value.every((id, index) => index === 0 || value[index - 1]!.localeCompare(id, 'en-US') < 0);
}

export function assessAssistantSourceHealth(
  sources: AssistantSourceHealthRecord[],
  now = new Date(),
) {
  const oldestHealthyTimestamp = now.getTime() - maximumSourceAgeMs;
  const unhealthySourceIds = sources.filter((source) => {
    const lastSuccessAt = source.lastSuccessAt?.getTime() ?? 0;
    const lastIndexedAt = source.lastIndexedAt?.getTime() ?? 0;
    return source.lastErrorCode !== null
      || lastSuccessAt < oldestHealthyTimestamp
      || lastIndexedAt < oldestHealthyTimestamp;
  }).map(({ id }) => id);

  return {
    passed: sources.length > 0 && unhealthySourceIds.length === 0,
    activeSourceCount: sources.length,
    unhealthySourceIds,
  };
}

export function readAssistantRolloutBudgetReadiness(
  environment: AssistantEnvironment = process.env,
) {
  const providerReadiness = readAssistantPaidProviderReadiness(environment);
  const geoRequired = isAssistantGeoProviderEnabled(environment) ? [
      { name: 'ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE', minimum: 1, maximum: 1_000_000 },
      { name: 'ASSISTANT_GEO_PROVIDER_DAILY_BUDGET', minimum: 1, maximum: 1_000_000 },
      { name: 'ASSISTANT_GEO_CACHE_TTL_SECONDS', minimum: 60, maximum: 31_536_000 },
    ] : [];
  const overpassLimits = readAssistantOverpassBudgetLimits(environment);
  const overpassRequired = overpassLimits.enabled === true ? [
    { name: 'ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE', value: overpassLimits.requestsPerMinute },
    { name: 'ASSISTANT_OVERPASS_DAILY_BUDGET', value: overpassLimits.dailyBudget },
  ] : [];
  const missing = [
    ...providerReadiness.missing,
    ...(overpassLimits.enabled === null ? ['ASSISTANT_OVERPASS_ENABLED'] : []),
    ...geoRequired.filter(({ name, minimum, maximum }) => (
      !isBoundedInteger(environment[name], minimum, maximum)
    )).map(({ name }) => name),
    ...overpassRequired.filter(({ value }) => value === null).map(({ name }) => name),
  ];
  return { passed: missing.length === 0, missing };
}

export function readAssistantOverpassBudgetLimits(
  environment: AssistantEnvironment = process.env,
) {
  const enabled = readOptionalBoolean(environment.ASSISTANT_OVERPASS_ENABLED, false);
  return {
    enabled,
    requestsPerMinute: enabled === true && isBoundedInteger(
      environment.ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE,
      1,
      1_000_000,
    ) ? Number(environment.ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE) : null,
    dailyBudget: enabled === true && isBoundedInteger(
      environment.ASSISTANT_OVERPASS_DAILY_BUDGET,
      1,
      1_000_000,
    ) ? Number(environment.ASSISTANT_OVERPASS_DAILY_BUDGET) : null,
  };
}

export function countAssistantRolloutCriticalErrors(runs: AssistantRolloutRunRecord[]) {
  return runs.filter((run) => run.status === AssistantRunStatus.FAILED
    || run.qualityFlags.some((flag) => criticalQualityFlags.has(flag))).length;
}

export function createAssistantRolloutTerminalObservationWhere(
  previousStageStartedAt: Date,
  now: Date,
) {
  return {
    status: { in: [AssistantRunStatus.COMPLETED, AssistantRunStatus.FAILED] },
    completedAt: { gte: previousStageStartedAt, lte: now },
  };
}

export function createAssistantGeoUsageReceiptWhere(
  windowStartedAt: Date,
  now: Date,
) {
  const dayStartedAt = startOfUtcDay(windowStartedAt);
  return {
    OR: [
      { createdAt: { gte: windowStartedAt, lte: now } },
      { settledAt: { gte: windowStartedAt, lte: now } },
      { status: { not: 'SETTLED' } },
      { outcome: null },
      { outcome: { notIn: ['SUCCESS', 'ERROR'] } },
      { settledAt: null },
      { provider: 'overpass', createdAt: { gte: dayStartedAt, lte: now } },
    ],
  };
}

export function assessAssistantEvalReleaseCompatibility(
  evidence: {
    runtimeConfigSha256: unknown;
    releaseSha: unknown;
    releaseImageIdentity: unknown;
  },
  current: {
    runtimeConfigSha256: unknown;
    releaseSha: unknown;
    releaseImageIdentity: unknown;
  },
) {
  const blockers: string[] = [];
  if (!isDigest(evidence.runtimeConfigSha256) || !isDigest(current.runtimeConfigSha256)) {
    blockers.push('ASSISTANT_EVAL_RUNTIME_CONFIG_BINDING_INVALID');
  } else if (evidence.runtimeConfigSha256 !== current.runtimeConfigSha256) {
    blockers.push('ASSISTANT_EVAL_RUNTIME_CONFIG_MISMATCH');
  }
  if (!isReleaseSha(evidence.releaseSha) || !isReleaseSha(current.releaseSha)) {
    blockers.push('ASSISTANT_EVAL_RELEASE_SHA_INVALID');
  } else if (evidence.releaseSha !== current.releaseSha) {
    blockers.push('ASSISTANT_EVAL_RELEASE_SHA_MISMATCH');
  }
  if (!isReleaseImageIdentity(evidence.releaseImageIdentity)
    || !isReleaseImageIdentity(current.releaseImageIdentity)) {
    blockers.push('ASSISTANT_EVAL_RELEASE_IMAGE_IDENTITY_INVALID');
  } else if (evidence.releaseImageIdentity !== current.releaseImageIdentity) {
    blockers.push('ASSISTANT_EVAL_RELEASE_IMAGE_IDENTITY_MISMATCH');
  }
  return { passed: blockers.length === 0, blockers };
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isReleaseSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isReleaseImageIdentity(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function assessAssistantProviderBudgetContract(
  attempts: AssistantProviderBudgetContractAttempt[],
  comparison?: AssistantProviderReportedUsageComparison,
) {
  const seenReceipts = new Set<string>();
  const violatingReceipts = attempts.flatMap((attempt) => {
    const reasons: string[] = [];
    const receiptKey = `${attempt.operationRunId}\u0000${attempt.executionId}\u0000${attempt.attemptOrdinal}`;
    if (seenReceipts.has(receiptKey)) reasons.push('RECEIPT_REPORTED_USAGE_MISMATCH');
    seenReceipts.add(receiptKey);

    if (attempt.status === 'RESERVED') reasons.push('ATTEMPT_RESERVED');
    try {
      const reservedCostUnits = parseAssistantUsd(readAssistantProviderUsd(attempt.reservedCostUsd));
      const chargedCostUnits = attempt.chargedCostUsd === null
        ? null
        : parseAssistantUsd(readAssistantProviderUsd(attempt.chargedCostUsd));
      if (attempt.pricingStatus === 'RESERVE_EXCEEDED'
        || (chargedCostUnits !== null && chargedCostUnits > reservedCostUnits)) {
        reasons.push('CHARGE_EXCEEDS_RESERVE');
      } else if (attempt.status === 'SETTLED' && chargedCostUnits === null) {
        reasons.push('RECEIPT_REPORTED_USAGE_MISMATCH');
      }
    } catch {
      reasons.push('RECEIPT_REPORTED_USAGE_MISMATCH');
    }

    if (attempt.operation === 'SOURCE_DISCOVERY'
      && attempt.status === 'SETTLED'
      && (attempt.outcome === 'PROVIDER_SUCCESS'
        || attempt.outcome === 'PROVIDER_CONTRACT_VIOLATION')
      && attempt.webSearchCalls !== 1) {
      reasons.push('TOOL_CALL_CONTRACT_VIOLATION');
    }
    const uniqueReasons = [...new Set(reasons)];
    return uniqueReasons.length === 0 ? [] : [{
      operationRunId: readAssistantProviderReceiptPart(attempt.operationRunId, 160),
      executionId: readAssistantProviderReceiptPart(attempt.executionId, 36),
      attemptOrdinal: Number.isSafeInteger(attempt.attemptOrdinal) && attempt.attemptOrdinal > 0
        ? attempt.attemptOrdinal
        : -1,
      reasons: uniqueReasons,
    }];
  });
  const reportedUsageMismatches = comparison
    ? assessAssistantReportedUsage(attempts, comparison)
    : [];
  const violationCount = violatingReceipts.length + reportedUsageMismatches.length;
  return {
    passed: violationCount === 0,
    condition: violationCount === 0 ? null : providerBudgetContractViolation,
    violationCount,
    violatingReceipts,
    reportedUsageMismatches,
  };
}

export function assessAssistantGeoUsageReceipts(
  attempts: AssistantGeoUsageAttemptRecord[],
  limits: {
    windowStartedAt: Date;
    now: Date;
    overpassRequestsPerMinute: number | null;
    overpassDailyBudget: number | null;
  },
) {
  const seenReceipts = new Set<string>();
  const violatingReceipts = attempts.flatMap((attempt) => {
    const reasons: string[] = [];
    const receiptKey = `${attempt.operationId}\u0000${attempt.attemptOrdinal}`;
    if (seenReceipts.has(receiptKey)) reasons.push('RECEIPT_DUPLICATED');
    seenReceipts.add(receiptKey);
    if (!uuidPattern.test(attempt.id) || !uuidPattern.test(attempt.operationId)
      || !Number.isSafeInteger(attempt.attemptOrdinal) || attempt.attemptOrdinal < 1) {
      reasons.push('RECEIPT_IDENTITY_INVALID');
    }
    if (!['locationiq', 'overpass'].includes(attempt.provider)) reasons.push('PROVIDER_UNKNOWN');
    if (attempt.status === 'RESERVED') reasons.push('ATTEMPT_RESERVED');
    else if (attempt.status !== 'SETTLED') reasons.push('ATTEMPT_UNSETTLED');
    if (!['SUCCESS', 'ERROR'].includes(attempt.outcome ?? '')) reasons.push('OUTCOME_UNKNOWN');
    if (!isValidDate(attempt.settledAt)
      || attempt.settledAt.getTime() > limits.now.getTime()
      || !isValidDate(attempt.createdAt)
      || attempt.createdAt.getTime() > attempt.settledAt.getTime()) {
      reasons.push('SETTLEMENT_MISSING');
    }
    if (!Number.isSafeInteger(attempt.durationMs) || attempt.durationMs! < 0) {
      reasons.push('USAGE_METRIC_UNKNOWN');
    }
    if (attempt.outcome === 'SUCCESS' && attempt.errorCode !== null
      || attempt.outcome === 'ERROR' && (typeof attempt.errorCode !== 'string'
        || !/^[A-Z0-9_]{3,120}$/u.test(attempt.errorCode))) {
      reasons.push('OUTCOME_METADATA_INVALID');
    }
    const uniqueReasons = [...new Set(reasons)];
    return uniqueReasons.length === 0 ? [] : [{
      id: uuidPattern.test(attempt.id) ? attempt.id : 'INVALID',
      operationId: uuidPattern.test(attempt.operationId) ? attempt.operationId : 'INVALID',
      attemptOrdinal: Number.isSafeInteger(attempt.attemptOrdinal) && attempt.attemptOrdinal > 0
        ? attempt.attemptOrdinal
        : -1,
      provider: ['locationiq', 'overpass'].includes(attempt.provider)
        ? attempt.provider
        : 'UNKNOWN',
      reasons: uniqueReasons,
    }];
  });
  const dayStartedAt = startOfUtcDay(limits.windowStartedAt);
  const minuteStartedAt = startOfUtcMinute(limits.windowStartedAt);
  const overpassAttempts = attempts.filter((attempt) => attempt.provider === 'overpass'
    && isValidDate(attempt.createdAt)
    && attempt.createdAt.getTime() >= dayStartedAt.getTime()
    && attempt.createdAt.getTime() <= limits.now.getTime());
  const exceededBuckets = [
    ...readExceededGeoUsageBuckets(
      overpassAttempts,
      'MINUTE',
      limits.overpassRequestsPerMinute,
      (attempt) => attempt.minuteStartedAt,
      minuteStartedAt,
      limits.now,
    ),
    ...readExceededGeoUsageBuckets(
      overpassAttempts,
      'DAY',
      limits.overpassDailyBudget,
      (attempt) => attempt.dayStartedAt,
      dayStartedAt,
      limits.now,
    ),
  ];
  const violationCount = violatingReceipts.length + exceededBuckets.length;
  return {
    passed: violationCount === 0,
    condition: violationCount === 0 ? null : 'GEO_USAGE_CONTRACT_VIOLATION',
    violationCount,
    violatingReceipts,
    exceededBuckets,
  };
}

function readExceededGeoUsageBuckets(
  attempts: AssistantGeoUsageAttemptRecord[],
  window: 'MINUTE' | 'DAY',
  limit: number | null,
  readStartedAt: (attempt: AssistantGeoUsageAttemptRecord) => Date,
  minimumStartedAt: Date,
  maximumStartedAt: Date,
) {
  if (!Number.isSafeInteger(limit) || limit! < 1) return [];
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    const startedAt = readStartedAt(attempt);
    if (!isValidDate(startedAt)
      || startedAt.getTime() < minimumStartedAt.getTime()
      || startedAt.getTime() > maximumStartedAt.getTime()) continue;
    const key = startedAt.toISOString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].flatMap(([startedAt, count]) => count > limit! ? [{
    provider: 'overpass',
    window,
    startedAt,
    count,
    limit: limit!,
  }] : []);
}

function isValidDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function startOfUtcMinute(value: Date) {
  const startedAt = new Date(value);
  startedAt.setUTCSeconds(0, 0);
  return startedAt;
}

function startOfUtcDay(value: Date) {
  const startedAt = new Date(value);
  startedAt.setUTCHours(0, 0, 0, 0);
  return startedAt;
}

export function collectAssistantProviderComparisonRunIds(
  createdRuns: readonly { id: string }[],
  observationRuns: readonly { id: string }[],
  attempts: readonly { operation: string; operationRunId: string }[],
) {
  return [...new Set([
    ...createdRuns.map(({ id }) => id),
    ...observationRuns.map(({ id }) => id),
    ...attempts.flatMap(({ operation, operationRunId }) => (
      operation === 'PLANNER' ? [operationRunId] : []
    )),
  ])];
}

export function assessAssistantPilotCohort(
  configuredUserIds: string[],
  users: AssistantPilotUserRecord[],
) {
  const userById = new Map(users.map((user) => [user.id, user]));
  const missingUserIds = configuredUserIds.filter((id) => !userById.has(id));
  const ineligibleUserIds = configuredUserIds.filter((id) => {
    const user = userById.get(id);
    if (!user) return false;
    const permissions = new Set(user.permissions);
    return user.status !== 'ACTIVE'
      || user.deletedAt !== null
      || !permissions.has('objects:read')
      || [...administrativePermissions].some((permission) => permissions.has(permission));
  });
  return {
    passed: configuredUserIds.length >= pilotMinimumUsers
      && configuredUserIds.length <= pilotMaximumUsers
      && new Set(configuredUserIds).size === configuredUserIds.length
      && missingUserIds.length === 0
      && ineligibleUserIds.length === 0,
    configuredCount: configuredUserIds.length,
    userIds: [...configuredUserIds].sort((left, right) => left.localeCompare(right, 'en-US')),
    missingUserIds,
    ineligibleUserIds,
  };
}

export function assessAssistantPilotCohortAgainstApproval(
  configuredUserIds: string[],
  users: AssistantPilotUserRecord[],
  approvalValue: unknown,
) {
  const live = assessAssistantPilotCohort(configuredUserIds, users);
  const approval = isRecord(approvalValue) ? approvalValue : null;
  const approvedCohort = approval && isRecord(approval.pilotCohort)
    ? approval.pilotCohort
    : null;
  const approvalMatches = approvedCohort !== null
    && isCanonicalPilotUserIds(approvedCohort.userIds, live.configuredCount)
    && stableStringify(approvedCohort.userIds) === stableStringify(live.userIds);
  return { ...live, passed: live.passed && approvalMatches };
}

export function assessAssistantRolloutObservation(input: {
  currentStage: AssistantRolloutStage;
  pilotUserIds: string[];
  previousStageStartedAt: Date;
  now?: Date;
  runs: AssistantRolloutObservationRunRecord[];
}) {
  const now = input.now ?? new Date();
  const blockers: string[] = [];
  if (input.previousStageStartedAt.getTime() > now.getTime()) {
    blockers.push('ASSISTANT_ROLLOUT_OBSERVATION_STARTED_AT_FUTURE');
  }
  const completedRuns = input.runs.filter((run) => run.status === AssistantRunStatus.COMPLETED
    && run.completedAt !== null
    && run.completedAt.getTime() >= input.previousStageStartedAt.getTime()
    && run.completedAt.getTime() <= now.getTime());
  if (completedRuns.length === 0) blockers.push('ASSISTANT_ROLLOUT_OBSERVATION_RUNS_REQUIRED');
  const observedUserIds = new Set(completedRuns.map(({ ownerUserId }) => ownerUserId));
  const missingPilotUserIds = input.currentStage === 'PILOT'
    ? input.pilotUserIds.filter((id) => !observedUserIds.has(id))
    : [];
  if (missingPilotUserIds.length > 0) {
    blockers.push('ASSISTANT_ROLLOUT_OBSERVATION_PILOT_COVERAGE_INCOMPLETE');
  }
  return {
    passed: blockers.length === 0,
    runCount: completedRuns.length,
    uniqueUserCount: observedUserIds.size,
    missingPilotUserIds,
    blockers,
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isPositiveInteger(value: string | undefined) {
  if (value === undefined || value.trim() === '') return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function isBoundedInteger(value: string | undefined, minimum: number, maximum: number) {
  if (!isPositiveInteger(value)) return false;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum;
}

function readOptionalBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function readAssistantProviderUsd(
  value: string | { toFixed(fractionDigits: number): string },
) {
  return typeof value === 'string' ? value : value.toFixed(8);
}

function readAssistantProviderReceiptPart(value: string, maximumLength: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    ? value
    : 'INVALID';
}

function assessAssistantReportedUsage(
  attempts: AssistantProviderBudgetContractAttempt[],
  comparison: AssistantProviderReportedUsageComparison,
) {
  const operationRunIds = [...new Set(comparison.operationRunIds)];
  const comparedOperations = comparison.operations
    ? new Set(comparison.operations)
    : null;
  return operationRunIds.flatMap((operationRunId) => {
    const executionId = comparison.executions?.find((execution) => (
      execution.operationRunId === operationRunId
    ))?.executionId;
    const receiptAttempts = attempts.filter((attempt) => (
      attempt.operationRunId === operationRunId
        && (executionId === undefined || attempt.executionId === executionId)
        && (comparedOperations === null || comparedOperations.has(attempt.operation))
    )).sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
    const reportedAttempts = orderAssistantProviderReportedUsage(
      comparison.reportedUsage.filter((attempt) => (
      attempt.operationRunId === operationRunId
      )),
    );
    const mismatchedFields: string[] = [];
    if (receiptAttempts.length !== reportedAttempts.length) {
      mismatchedFields.push('attemptCount');
    }
    const comparableAttemptCount = Math.min(receiptAttempts.length, reportedAttempts.length);
    for (let index = 0; index < comparableAttemptCount; index += 1) {
      const receipt = receiptAttempts[index]!;
      const reported = reportedAttempts[index]!;
      if (reported.attemptOrdinal !== undefined
        && receipt.attemptOrdinal !== reported.attemptOrdinal) {
        pushAssistantProviderMismatchField(mismatchedFields, 'attemptOrdinal');
      }
      const receiptModel = receipt.actualModel ?? receipt.requestedModel;
      if (typeof receiptModel !== 'string' || receiptModel !== reported.model) {
        pushAssistantProviderMismatchField(mismatchedFields, 'model');
      }
      for (const field of providerUsageFields) {
        if (!sameAssistantProviderUsageValue(receipt[field] ?? null, reported[field])) {
          pushAssistantProviderMismatchField(mismatchedFields, field);
        }
      }
    }
    return mismatchedFields.length === 0 ? [] : [{
      operationRunId: readAssistantProviderReceiptPart(operationRunId, 160),
      receiptAttemptCount: receiptAttempts.length,
      reportedAttemptCount: reportedAttempts.length,
      fields: mismatchedFields,
    }];
  });
}

function orderAssistantProviderReportedUsage(
  reportedUsage: AssistantProviderReportedUsage[],
) {
  const canOrderByAttempt = reportedUsage.every(({ attemptOrdinal }) => (
    Number.isSafeInteger(attemptOrdinal) && attemptOrdinal! > 0
  )) && new Set(reportedUsage.map(({ attemptOrdinal }) => attemptOrdinal)).size
    === reportedUsage.length;
  return canOrderByAttempt
    ? [...reportedUsage].sort((left, right) => left.attemptOrdinal! - right.attemptOrdinal!)
    : reportedUsage;
}

function pushAssistantProviderMismatchField(fields: string[], field: string) {
  if (!fields.includes(field)) fields.push(field);
}

function sameAssistantProviderUsageValue(
  receiptValue: number | bigint | null,
  reportedValue: number | bigint | null,
) {
  const receiptKey = assistantProviderUsageValueKey(receiptValue);
  const reportedKey = assistantProviderUsageValueKey(reportedValue);
  return receiptKey !== null && receiptKey === reportedKey;
}

function assistantProviderUsageValueKey(value: number | bigint | null) {
  if (value === null) return 'UNKNOWN';
  if (typeof value === 'bigint' && value >= 0n) return `KNOWN:${value}`;
  if (Number.isSafeInteger(value) && value >= 0) return `KNOWN:${value}`;
  return null;
}
