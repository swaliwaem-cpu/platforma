import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const assistantRolloutStages = ['ADMINS', 'PILOT', 'ALL'] as const;
export type AssistantRolloutStage = (typeof assistantRolloutStages)[number];

export type AssistantRuntimeConfig = {
  assistantEnabled: boolean;
  geoProviderEnabled: boolean;
  externalConnectorsEnabled: boolean;
  rolloutStage: AssistantRolloutStage;
  pilotUserIds: string[];
};

export class AssistantRuntimeConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantRuntimeConfigError';
  }
}

export function isAssistantModuleEnabled(
  environment: AssistantEnvironment = process.env,
) {
  return readBoolean(environment.ASSISTANT_MODULE_ENABLED, false, 'ASSISTANT_MODULE_ENABLED_INVALID');
}

export function isAssistantGeoProviderEnabled(
  environment: AssistantEnvironment = process.env,
) {
  return readBoolean(
    environment.ASSISTANT_GEO_PROVIDER_ENABLED,
    false,
    'ASSISTANT_GEO_PROVIDER_ENABLED_INVALID',
  );
}

export function areAssistantExternalConnectorsEnabled(
  environment: AssistantEnvironment = process.env,
) {
  return readBoolean(
    environment.ASSISTANT_EXTERNAL_CONNECTORS_ENABLED,
    false,
    'ASSISTANT_EXTERNAL_CONNECTORS_ENABLED_INVALID',
  );
}

export function getAssistantRuntimeConfig(
  environment: AssistantEnvironment = process.env,
): AssistantRuntimeConfig {
  return {
    assistantEnabled: isAssistantModuleEnabled(environment),
    geoProviderEnabled: isAssistantGeoProviderEnabled(environment),
    externalConnectorsEnabled: areAssistantExternalConnectorsEnabled(environment),
    rolloutStage: readRolloutStage(environment.ASSISTANT_ROLLOUT_STAGE),
    pilotUserIds: readPilotUserIds(environment.ASSISTANT_PILOT_USER_IDS),
  };
}

export function isAssistantEnabledForActor(
  actor: Pick<AuthenticatedUser, 'id' | 'permissions'> | undefined,
  environment: AssistantEnvironment = process.env,
) {
  if (!isAssistantModuleEnabled(environment) || !actor) return false;
  const permissions = new Set(actor.permissions);
  if (!permissions.has('objects:read')) return false;
  if (isAssistantAdministrator(permissions)) return true;
  const stage = readRolloutStage(environment.ASSISTANT_ROLLOUT_STAGE);
  if (stage === 'ADMINS') return false;
  if (stage === 'ALL') return true;
  return readPilotUserIds(environment.ASSISTANT_PILOT_USER_IDS).includes(actor.id);
}

export function assessAssistantRolloutTransition(input: {
  currentStage: AssistantRolloutStage;
  targetStage: AssistantRolloutStage;
  evalPassed: boolean;
  sourceHealthPassed: boolean;
  budgetsConfigured: boolean;
  criticalErrorCount: number;
  providerBudgetContractPassed: boolean;
  pilotCohortPassed: boolean;
  observationPassed: boolean;
}) {
  const blockers: string[] = [];
  const currentIndex = assistantRolloutStages.indexOf(input.currentStage);
  const targetIndex = assistantRolloutStages.indexOf(input.targetStage);
  if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
    blockers.push('ASSISTANT_ROLLOUT_STAGE_NOT_SEQUENTIAL');
  }
  if (!input.evalPassed) blockers.push('ASSISTANT_ROLLOUT_EVAL_FAILED');
  if (!input.sourceHealthPassed) blockers.push('ASSISTANT_ROLLOUT_SOURCE_HEALTH_FAILED');
  if (!input.budgetsConfigured) blockers.push('ASSISTANT_ROLLOUT_BUDGETS_NOT_CONFIGURED');
  if (!Number.isInteger(input.criticalErrorCount) || input.criticalErrorCount !== 0) {
    blockers.push('ASSISTANT_ROLLOUT_CRITICAL_ERRORS_PRESENT');
  }
  if (input.providerBudgetContractPassed !== true) {
    blockers.push('PROVIDER_BUDGET_CONTRACT_VIOLATION');
  }
  if (!input.pilotCohortPassed) blockers.push('ASSISTANT_ROLLOUT_PILOT_COHORT_INVALID');
  if (!input.observationPassed) blockers.push('ASSISTANT_ROLLOUT_OBSERVATION_INSUFFICIENT');
  return { passed: blockers.length === 0, blockers };
}

@Injectable()
export class AssistantFeatureGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    if (isAssistantEnabledForActor(request.user)) return true;

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      message: isAssistantModuleEnabled()
        ? 'ASSISTANT_ROLLOUT_UNAVAILABLE'
        : 'ASSISTANT_MODULE_DISABLED',
    });
  }
}

@Injectable()
export class AssistantExternalConnectorsGuard implements CanActivate {
  canActivate() {
    if (areAssistantExternalConnectorsEnabled()) return true;

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'ASSISTANT_EXTERNAL_CONNECTORS_DISABLED',
    });
  }
}

function readBoolean(value: string | undefined, fallback: boolean, code: string) {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AssistantRuntimeConfigError(code);
}

function readRolloutStage(value: string | undefined): AssistantRolloutStage {
  const normalized = (value ?? 'ADMINS').trim().toLocaleUpperCase('en-US');
  if (assistantRolloutStages.includes(normalized as AssistantRolloutStage)) {
    return normalized as AssistantRolloutStage;
  }
  throw new AssistantRuntimeConfigError('ASSISTANT_ROLLOUT_STAGE_INVALID');
}

function readPilotUserIds(value: string | undefined) {
  if (value === undefined || value.trim() === '') return [];
  const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (ids.length > 20 || ids.some((id) => !uuidPattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new AssistantRuntimeConfigError('ASSISTANT_PILOT_USER_IDS_INVALID');
  }
  return ids;
}

function isAssistantAdministrator(permissions: Set<string>) {
  return permissions.has('admin:access')
    || permissions.has('assistant:audit:read')
    || permissions.has('assistant:sources:manage');
}
