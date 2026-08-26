import { AssistantRunStatus } from '@prisma/client';
import { createHash } from 'node:crypto';

import {
  isAssistantGeoProviderEnabled,
  type AssistantRolloutStage,
} from '../assistant-runtime-config';

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
    && hasExactKeys(evalGate, ['version', 'passed', 'caseCount'])
    && evalGate.version === 'assistant-eval-v1'
    && evalGate.passed === true
    && evalGate.caseCount === 200
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
  const required = [
    'ASSISTANT_MODEL_REQUESTS_PER_MINUTE',
    'ASSISTANT_MODEL_REQUESTS_PER_DAY',
    ...(isAssistantGeoProviderEnabled(environment) ? [
      'ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE',
      'ASSISTANT_GEO_PROVIDER_DAILY_BUDGET',
    ] : []),
  ];
  const missing = required.filter((name) => !isPositiveInteger(environment[name]));
  return { passed: missing.length === 0, missing };
}

export function countAssistantRolloutCriticalErrors(runs: AssistantRolloutRunRecord[]) {
  return runs.filter((run) => run.status === AssistantRunStatus.FAILED
    || run.qualityFlags.some((flag) => criticalQualityFlags.has(flag))).length;
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
