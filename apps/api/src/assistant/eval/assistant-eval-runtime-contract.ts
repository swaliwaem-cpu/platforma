import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ASSISTANT_LUNA_MODEL, ASSISTANT_TERRA_MODEL } from '../assistant-query-planner';
import {
  ASSISTANT_PLANNER_PROMPT_VERSION,
  readAssistantOpenAiTimeoutMs,
} from '../assistant-planner-gateway';
import {
  areAssistantExternalConnectorsEnabled,
  isAssistantGeoProviderEnabled,
  readAssistantCurrentFactRefreshMode,
} from '../assistant-runtime-config';
import { readAssistantPaidProviderReadiness } from '../operations/assistant-paid-readiness';
import { ASSISTANT_AI_SERVICE_TIER } from '../operations/assistant-ai-cost';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type AssistantEvalDatabaseIdentity = {
  databaseName: string;
  schemaName: string;
  serverAddress: string;
  serverPort: number;
  serverStartedAt: string;
};

export const assistantEvalRuntimeContractVersion = 'assistant-eval-runtime-v2';
export const assistantReleaseRuntimeBindingVersion = 'assistant-release-runtime-v1';

export function createAssistantEvalRuntimeContract(
  databaseIdentity: AssistantEvalDatabaseIdentity,
  environment: AssistantEnvironment = process.env,
) {
  const provider = readAssistantPaidProviderReadiness(environment);
  const releaseIdentity = readAssistantReleaseIdentity(environment);
  const runtimeModes = createAssistantEvalRuntimeModeBinding(environment);
  return {
    version: assistantEvalRuntimeContractVersion,
    databaseFingerprint: createAssistantEvalDatabaseFingerprint(databaseIdentity),
    runtimeConfigSha256: computeAssistantReleaseRuntimeConfigSha256(environment),
    releaseIdentity,
    provider: {
      readinessPassed: provider.passed,
      missing: [...provider.missing],
      aiMode: provider.effective.aiMode,
      requestsPerMinute: provider.effective.requestsPerMinute,
      requestsPerDay: provider.effective.requestsPerDay,
      dailyBudgetUsd: provider.effective.dailyBudgetUsd,
      queryPlannerLive: provider.effective.queryPlannerLive,
      paidCallsConfirmed: provider.effective.paidCallsConfirmed,
      apiKeyPresent: provider.effective.apiKeyPresent,
    },
    runtime: {
      nodeEnvironment: readOptionalEnvironmentValue(environment.NODE_ENV),
      deploymentEnvironment: readOptionalEnvironmentValue(environment.DEPLOYMENT_ENV),
      ...runtimeModes,
      openAiBaseUrlOfficial: isOfficialOpenAiBaseUrl(environment.ASSISTANT_OPENAI_BASE_URL),
    },
  };
}

export function computeAssistantReleaseRuntimeConfigSha256(
  environment: AssistantEnvironment = process.env,
) {
  return createHash('sha256').update(JSON.stringify(
    createAssistantReleaseRuntimeBinding(environment),
  )).digest('hex');
}

export function createAssistantReleaseRuntimeBinding(
  environment: AssistantEnvironment = process.env,
) {
  const provider = readAssistantPaidProviderReadiness(environment).effective;
  return {
    version: assistantReleaseRuntimeBindingVersion,
    provider: {
      aiMode: provider.aiMode,
      requestsPerMinute: provider.requestsPerMinute,
      requestsPerDay: provider.requestsPerDay,
      dailyBudgetUsd: provider.dailyBudgetUsd,
      queryPlannerLive: provider.queryPlannerLive,
      paidCallsConfirmed: provider.paidCallsConfirmed,
      apiKeyPresent: provider.apiKeyPresent,
      openAiBaseUrlOfficial: isOfficialOpenAiBaseUrl(environment.ASSISTANT_OPENAI_BASE_URL),
      timeoutMs: readAssistantOpenAiTimeoutMs(environment),
    },
    planner: {
      promptVersion: ASSISTANT_PLANNER_PROMPT_VERSION,
      primaryModel: ASSISTANT_LUNA_MODEL,
      fallbackModel: ASSISTANT_TERRA_MODEL,
      serviceTier: ASSISTANT_AI_SERVICE_TIER,
    },
    runtime: createAssistantEvalRuntimeModeBinding(environment),
  };
}

function createAssistantEvalRuntimeModeBinding(environment: AssistantEnvironment) {
  return {
    geoProviderEnabled: isAssistantGeoProviderEnabled(environment),
    externalConnectorsEnabled: areAssistantExternalConnectorsEnabled(environment),
    currentFactRefreshMode: readAssistantCurrentFactRefreshMode(environment),
    sourceDiscoveryLive: environment.ASSISTANT_SOURCE_DISCOVERY_LIVE === 'true',
    embeddingMode: readEmbeddingMode(environment.ASSISTANT_EMBEDDING_MODE),
    embeddingLive: environment.ASSISTANT_EMBEDDING_LIVE === 'true',
  };
}

export function readAssistantReleaseIdentity(
  environment: AssistantEnvironment = process.env,
) {
  const releaseSha = environment.ASSISTANT_RELEASE_SHA?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
    throw new Error('ASSISTANT_RELEASE_SHA_INVALID');
  }
  const rawImageIdentity = environment.ASSISTANT_RELEASE_IMAGE_IDENTITY?.trim() ?? '';
  if (rawImageIdentity === 'none') {
    return { releaseSha, releaseImageIdentity: null };
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(rawImageIdentity)) {
    throw new Error('ASSISTANT_RELEASE_IMAGE_IDENTITY_INVALID');
  }
  return { releaseSha, releaseImageIdentity: rawImageIdentity };
}

export async function loadAssistantEvalRuntimeContract(
  prisma: PrismaService,
  environment: AssistantEnvironment = process.env,
) {
  const rows = await prisma.$queryRaw<AssistantEvalDatabaseIdentity[]>(Prisma.sql`
    SELECT
      current_database() AS "databaseName",
      current_schema() AS "schemaName",
      COALESCE(inet_server_addr()::text, 'local') AS "serverAddress",
      inet_server_port() AS "serverPort",
      pg_postmaster_start_time()::text AS "serverStartedAt"
  `);
  if (rows.length !== 1) throw new Error('ASSISTANT_EVAL_DATABASE_IDENTITY_INVALID');
  return createAssistantEvalRuntimeContract(rows[0]!, environment);
}

export function createAssistantEvalDatabaseFingerprint(value: AssistantEvalDatabaseIdentity) {
  if (!isBoundedString(value.databaseName, 256)
    || !isBoundedString(value.schemaName, 256)
    || !isBoundedString(value.serverAddress, 256)
    || !Number.isSafeInteger(value.serverPort)
    || value.serverPort < 1
    || value.serverPort > 65_535
    || !isBoundedString(value.serverStartedAt, 80)
    || !Number.isFinite(Date.parse(value.serverStartedAt))) {
    throw new Error('ASSISTANT_EVAL_DATABASE_IDENTITY_INVALID');
  }
  return createHash('sha256').update(JSON.stringify([
    value.databaseName,
    value.schemaName,
    value.serverAddress,
    value.serverPort,
    new Date(value.serverStartedAt).toISOString(),
  ])).digest('hex');
}

function isOfficialOpenAiBaseUrl(value: string | undefined) {
  try {
    const parsed = new URL(value?.trim() || 'https://api.openai.com/v1');
    return parsed.protocol === 'https:'
      && parsed.hostname === 'api.openai.com'
      && (parsed.pathname === '/v1' || parsed.pathname === '/v1/')
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function readEmbeddingMode(value: string | undefined) {
  const normalized = (value ?? 'disabled').trim().toLocaleLowerCase('en-US');
  return ['disabled', 'fake', 'openai'].includes(normalized) ? normalized : null;
}

function readOptionalEnvironmentValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length <= 40 ? normalized : null;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}
