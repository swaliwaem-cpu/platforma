#!/usr/bin/env node

'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { join, resolve } = require('node:path');
const { NestFactory } = require('@nestjs/core');

const { AssistantSourcesModule } = require('../dist/assistant/sources/assistant-sources.module.js');
const {
  AssistantSourceDiscoveryError,
  ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL,
  ASSISTANT_SOURCE_DISCOVERY_MODEL,
  AssistantSourceDiscoveryService,
  maximumSourceDiscoveryCallsPerProject,
  maximumSourceDiscoveryProviderCalls,
  maximumSourceDiscoveryTerraFallbacks,
} = require('../dist/assistant/sources/assistant-source-discovery.service.js');
const {
  ASSISTANT_SOURCE_DISCOVERY_PROMPT_VERSION,
  aggregateTelemetry,
  maximumProviderOutputTokens,
  maximumProviderRequestBytes,
  maximumReservedProviderWebSearchCalls,
} = require('../dist/assistant/sources/assistant-source-discovery-provider.js');
const {
  ASSISTANT_SOURCE_DISCOVERY_VALIDATOR_VERSION,
  backupAssistantSourceDiscoveryCheckpoint,
  checkpointAssistantSourceDiscoveryResult,
  createEmptyCheckpoint,
  readAssistantSourceDiscoveryCheckpoint,
  writeAssistantSourceDiscoveryCheckpoint,
} = require('../dist/assistant/sources/assistant-source-discovery-checkpoint.js');
const {
  ASSISTANT_AI_PRICING_CATALOG_VERSION,
  addAssistantUsd,
  calculateAssistantAiCost,
  estimateAssistantAiCallCost,
  formatAssistantUsd,
  parseAssistantUsd,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  AssistantAiUsageBudgetService,
  readAssistantDailyUsdBudget,
} = require('../dist/assistant/operations/assistant-ai-usage-budget.service.js');
const {
  assessAssistantProviderBudgetContract,
} = require('../dist/assistant/rollout/assistant-rollout-preflight.js');
const {
  AssistantSourceIngestionService,
} = require('../dist/assistant/sources/assistant-source-ingestion.service.js');
const {
  AssistantSourceRegistryService,
} = require('../dist/assistant/sources/assistant-source-registry.service.js');
const {
  findRegisteredProjectSource,
} = require('../dist/assistant/sources/assistant-source-discovery-registry.js');
const {
  relatedHosts,
} = require('../dist/assistant/sources/assistant-source-discovery-identity.js');
const { PrismaService } = require('../dist/prisma/prisma.service.js');

const maximumDiscoveryBatchProjects = 20;
const assistantUsageReportFields = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
  'webSearchCalls',
];
const discoveryRegistrySourceSelect = {
  id: true,
  projectKey: true,
  developerKey: true,
  type: true,
  state: true,
  canonicalUrl: true,
  connectorKey: true,
  connectorConfigJson: true,
  revisions: {
    where: { processingStatus: 'INDEXED' },
    orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { processingStatus: true, checksum: true },
  },
};

if (require.main === module) {
  void runAssistantSourceDiscovery().catch((error) => {
    process.stderr.write(`${readErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}

async function runAssistantSourceDiscovery(input = {}) {
  const argv = input.argv ?? process.argv.slice(2);
  const environment = input.environment ?? process.env;
  const dependencies = input.dependencies ?? {};
  const options = parseArguments(argv);
  if (options.live) assertPaidCallsAllowed(environment);
  if (options.apply) {
    if (!options.live) throw new Error('ASSISTANT_SOURCE_DISCOVERY_APPLY_REQUIRES_LIVE');
    assertLocalApplyEnvironment(environment);
  }
  process.env.ASSISTANT_SOURCE_WORKER_ENABLED = 'false';
  process.env.ASSISTANT_EMBEDDING_MODE = 'fake';
  process.env.ASSISTANT_SOURCE_DISCOVERY_LIVE = options.live ? 'true' : 'false';

  const createApplicationContext = dependencies.createApplicationContext
    ?? (() => NestFactory.createApplicationContext(AssistantSourcesModule, { logger: false }));
  const application = await createApplicationContext();
  try {
    const prisma = application.get(PrismaService);
    const checkpointPath = environment.ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_PATH
      || join(process.cwd(), '.assistant-source-discovery', 'checkpoint-v1.json');
    const fingerprint = createCheckpointFingerprint();
    let checkpointRead;
    let checkpointBackup = null;
    try {
      checkpointRead = readAssistantSourceDiscoveryCheckpoint(checkpointPath, fingerprint);
    } catch (error) {
      if (options.refresh
        && error?.code === 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_FINGERPRINT_MISMATCH'
        && error.checkpoint) {
        if (options.live) {
          checkpointBackup = error.checkpoint;
        }
        checkpointRead = {
          state: 'MISSING',
          checkpoint: createEmptyCheckpoint(fingerprint),
        };
      } else {
        throw error;
      }
    }
    let checkpoint = checkpointRead.checkpoint;
    const checkpointIdentities = new Set(options.refresh
      ? []
      : Object.values(checkpoint.entries).map(({ projectKey, developerKey }) => (
        `${projectKey}\u0000${developerKey}`
      )));
    const excludedProjectKeys = new Set(options.excludedProjectKeys);
    const selectionContext = {
      excludedProjectIdentities: options.missingOnly ? checkpointIdentities : new Set(),
      checkpointProjectKeys: new Set(),
    };
    const selectProjects = dependencies.selectProjects ?? selectDiscoveryProjects;
    const projects = await selectProjects(
      prisma,
      options.limit,
      options.missingOnly,
      excludedProjectKeys,
      selectionContext,
    );
    if (options.refresh) {
      const selectedProjectKeys = new Set(projects.map(({ projectKey }) => projectKey));
      checkpoint = {
        ...checkpoint,
        entries: Object.fromEntries(Object.entries(checkpoint.entries).filter(([projectKey]) => (
          !selectedProjectKeys.has(projectKey)
        ))),
      };
    }
    const registrySources = projects.length === 0
      ? []
      : await (dependencies.loadRegistrySources ?? loadDiscoveryRegistrySources)(
        prisma,
        projects,
      );
    const registryProjectIdentities = new Set(options.refresh
      ? []
      : projects.flatMap((project) => (
        findRegisteredProjectSource(project, registrySources)
          ? [`${project.projectKey}\u0000${project.developerKey}`]
          : []
      )));
    const checkpointProjects = projects.filter(({ projectKey, developerKey }) => (
      checkpointIdentities.has(`${projectKey}\u0000${developerKey}`)
        && !registryProjectIdentities.has(`${projectKey}\u0000${developerKey}`)
    ));
    const checkpointHits = checkpointProjects.length;
    const reportedCheckpointProjectKeys = [...new Set([
      ...selectionContext.checkpointProjectKeys,
      ...checkpointProjects.map(({ projectKey }) => projectKey),
    ])];
    const reportedCheckpointHits = reportedCheckpointProjectKeys.length;
    const pendingProjects = projects.filter(({ projectKey, developerKey }) => (
      registryProjectIdentities.has(`${projectKey}\u0000${developerKey}`)
        || !checkpointIdentities.has(`${projectKey}\u0000${developerKey}`)
    ));
    const providerEligibleProjects = pendingProjects.filter(({ projectKey, developerKey }) => (
      !registryProjectIdentities.has(`${projectKey}\u0000${developerKey}`)
    ));
    const runId = dependencies.runId
      ?? createAssistantSourceDiscoveryOperationRunId(checkpointPath);
    const executionId = dependencies.executionId ?? randomUUID();
    const maximumEstimatedUsd = estimateMaximumDiscoveryCost(providerEligibleProjects.length);
    if (!options.live) {
      const report = createReport(options, [], [], {
        runId,
        selectedProjects: projects,
        maximumEstimatedUsd,
        checkpointHits: reportedCheckpointHits,
        checkpointProjectKeys: reportedCheckpointProjectKeys,
      });
      if (!input.silent) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report;
    }

    const discoveryEnvironment = {
      ...environment,
      ASSISTANT_SOURCE_DISCOVERY_MODEL,
      ASSISTANT_SOURCE_DISCOVERY_MAX_PROVIDER_CALLS: String(Math.min(
        maximumSourceDiscoveryProviderCalls,
        pendingProjects.length * maximumSourceDiscoveryCallsPerProject,
      )),
      ASSISTANT_SOURCE_DISCOVERY_MAX_TERRA_FALLBACKS: String(Math.min(
        maximumSourceDiscoveryTerraFallbacks,
        pendingProjects.length,
      )),
      ASSISTANT_SOURCE_DISCOVERY_LIVE: 'true',
    };
    const dailyBudgetUsd = readAssistantDailyUsdBudget(
      environment.ASSISTANT_MODEL_DAILY_BUDGET_USD,
      true,
    );
    const usageBudgets = dependencies.usageBudgets ?? new AssistantAiUsageBudgetService(prisma);
    if (typeof usageBudgets.reconcileExpiredReservations !== 'function') {
      throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_RECONCILIATION_REQUIRED');
    }
    await usageBudgets.reconcileExpiredReservations({
      operationRunId: runId,
      executionId,
    });
    const results = pendingProjects.length === 0
      ? []
      : await discoverProjects(
        (dependencies.createDiscovery
          ?? ((serviceOptions) => new AssistantSourceDiscoveryService(
            discoveryEnvironment,
            fetch,
            undefined,
            serviceOptions,
          )))({
          usageBudgets,
          dailyBudgetUsd,
          maximumRunCostUsd: options.maxCostUsd,
          operationRunId: runId,
          executionId,
        }),
        pendingProjects,
        options.concurrency,
        environment,
        {
          registrySources,
          includeProjectSources: !options.refresh,
        },
      );
    const persistedAttempts = await loadAssistantUsageAttempts(prisma, runId, executionId);
    const reportedUsage = results.flatMap((result) => (
      result.telemetry?.phases ?? []
    )).map((phase) => ({ operationRunId: runId, ...phase }));
    const providerBudgetContract = assessAssistantProviderBudgetContract(
      persistedAttempts,
      {
        operationRunIds: [runId],
        operations: ['SOURCE_DISCOVERY'],
        executions: [{ operationRunId: runId, executionId }],
        reportedUsage,
      },
    );
    if (providerBudgetContract.passed) {
      if (checkpointBackup) {
        backupAssistantSourceDiscoveryCheckpoint(checkpointPath, checkpointBackup);
      }
      rejectDuplicateCanonicalUrls(results);
      for (const result of results) {
        if (result.status === 'ERROR') continue;
        checkpoint = checkpointAssistantSourceDiscoveryResult(checkpoint, result);
      }
      writeAssistantSourceDiscoveryCheckpoint(checkpointPath, checkpoint);
    }

    const applyResults = options.apply && providerBudgetContract.passed
      ? await applyVerifiedSources(application, prisma, results)
      : [];
    const report = createReport(options, results, applyResults, {
      runId,
      selectedProjects: projects,
      maximumEstimatedUsd,
      checkpointHits: reportedCheckpointHits,
      checkpointProjectKeys: reportedCheckpointProjectKeys,
      persistedAttempts,
      providerBudgetContract,
    });
    if (!input.silent) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!providerBudgetContract.passed
      || report.summary.verified + checkpointHits !== projects.length
      || report.summary.ingestionFailed > 0) {
      if (!input.silent) process.exitCode = 2;
    }
    return report;
  } finally {
    await application.close();
  }
}

function parseArguments(values) {
  const apply = values.includes('--apply');
  const live = values.includes('--live');
  const refresh = values.includes('--refresh');
  const missingOnly = !refresh;
  const limitExplicit = values.includes('--limit');
  const maxCostExplicit = values.includes('--max-cost-usd');
  const limit = readIntegerArgument(values, '--limit', 1, 1, maximumDiscoveryBatchProjects);
  const concurrency = readIntegerArgument(values, '--concurrency', 1, 1, 4);
  const maxCostUsd = readUsdArgument(values, '--max-cost-usd', limit === 1 ? '0.10000000' : null);
  if (live && limit > 1 && (!limitExplicit || !maxCostExplicit)) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_BATCH_LIMITS_REQUIRED');
  }
  const excludedProjectKeys = readStringArguments(values, '--exclude-project-key');
  const known = new Set([
    '--apply',
    '--live',
    '--refresh',
    '--missing-only',
    '--limit',
    '--max-cost-usd',
    '--concurrency',
    '--exclude-project-key',
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!known.has(value)) throw new Error(`ASSISTANT_SOURCE_DISCOVERY_ARGUMENT_INVALID:${value}`);
    if (value === '--limit'
      || value === '--max-cost-usd'
      || value === '--concurrency'
      || value === '--exclude-project-key') index += 1;
  }
  return {
    apply,
    live,
    refresh,
    missingOnly,
    limit,
    concurrency,
    maxCostUsd,
    excludedProjectKeys,
  };
}

function readIntegerArgument(values, name, fallback, minimum, maximum) {
  const index = values.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(values[index + 1]);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`ASSISTANT_SOURCE_DISCOVERY_ARGUMENT_INVALID:${name}`);
  }
  return parsed;
}

function readStringArguments(values, name) {
  const parsed = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== name) continue;
    const value = values[index + 1];
    if (!value || value.startsWith('--') || value.length > 120) {
      throw new Error(`ASSISTANT_SOURCE_DISCOVERY_ARGUMENT_INVALID:${name}`);
    }
    parsed.push(value);
  }
  return new Set(parsed);
}

function readUsdArgument(values, name, fallback) {
  const index = values.indexOf(name);
  if (index < 0) {
    if (fallback === null) throw new Error(`ASSISTANT_SOURCE_DISCOVERY_ARGUMENT_REQUIRED:${name}`);
    return fallback;
  }
  try {
    const value = formatAssistantUsd(parseAssistantUsd(values[index + 1] ?? ''));
    if (parseAssistantUsd(value) === 0n) throw new Error('zero');
    return value;
  } catch {
    throw new Error(`ASSISTANT_SOURCE_DISCOVERY_ARGUMENT_INVALID:${name}`);
  }
}

async function selectDiscoveryProjects(
  prisma,
  limit,
  missingOnly,
  excludedProjectKeys,
  selectionContext = { excludedProjectIdentities: new Set(), checkpointProjectKeys: new Set() },
) {
  const registered = missingOnly
    ? await prisma.assistantKnowledgeSource.findMany({
      where: {
        type: { in: ['DEVELOPMENT_PAGE', 'DEVELOPER_PROMOTION', 'BANK_PROMOTION'] },
      },
      select: discoveryRegistrySourceSelect,
    })
    : [];
  const registrySources = registered.map(mapDiscoveryRegistrySource);
  const objects = await prisma.realEstateObject.findMany({
    where: {
      type: 'RESIDENTIAL',
      status: 'PUBLISHED',
      archivedAt: null,
      deletedAt: null,
      developerId: { not: null },
    },
    select: {
      title: true,
      slug: true,
      address: true,
      feedUnitsCount: true,
      developer: {
        select: { name: true, normalizedName: true, slug: true },
      },
    },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });
  objects.sort((left, right) => (
    (right.feedUnitsCount ?? 0) - (left.feedUnitsCount ?? 0)
      || left.title.localeCompare(right.title, 'ru')
  ));
  const selected = [];
  for (const object of objects) {
    if (!object.developer) continue;
    const developerKey = object.developer.slug
      || object.developer.normalizedName
      || object.developer.name;
    const projectIdentity = `${object.slug}\u0000${developerKey}`;
    if (excludedProjectKeys.has(object.slug)) continue;
    if (selectionContext.excludedProjectIdentities.has(projectIdentity)) {
      selectionContext.checkpointProjectKeys.add(object.slug);
      continue;
    }
    if (findRegisteredProjectSource({
        projectKey: object.slug,
        developerKey,
      }, registrySources)) continue;
    selected.push({
      projectKey: object.slug,
      title: object.title,
      developerKey,
      developerName: object.developer.name,
      address: object.address,
    });
    if (selected.length === limit) break;
  }
  return selected;
}

async function loadDiscoveryRegistrySources(prisma, projects) {
  if (typeof prisma.assistantKnowledgeSource?.findMany !== 'function') return [];
  const projectKeys = [...new Set(projects.map(({ projectKey }) => projectKey))];
  const developerKeys = [...new Set(projects.map(({ developerKey }) => developerKey))];
  const sources = await prisma.assistantKnowledgeSource.findMany({
    where: {
      state: 'ACTIVE',
      connectorKey: 'OFFICIAL_HTML',
      OR: [
        { type: 'DEVELOPMENT_PAGE', projectKey: { in: projectKeys } },
        { type: 'DEVELOPER_PROMOTION', projectKey: null, developerKey: { in: developerKeys } },
      ],
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: discoveryRegistrySourceSelect,
  });
  return sources.map(mapDiscoveryRegistrySource);
}

function mapDiscoveryRegistrySource({ connectorConfigJson, revisions, ...source }) {
  return {
    ...source,
    connectorConfig: connectorConfigJson,
    latestRevision: revisions[0] ?? null,
  };
}

async function discoverProjects(
  discovery,
  projects,
  concurrency,
  environment = process.env,
  seedOptions = {},
) {
  const registrySources = seedOptions.registrySources ?? [];
  const results = new Array(projects.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, projects.length) }, async () => {
    while (nextIndex < projects.length) {
      const index = nextIndex;
      nextIndex += 1;
      const project = projects[index];
      try {
        const projectRegistrySources = registrySources.filter((source) => (
          source.developerKey === project.developerKey
            && ((seedOptions.includeProjectSources !== false
                && source.type === 'DEVELOPMENT_PAGE'
                && source.projectKey === project.projectKey)
              || (source.type === 'DEVELOPER_PROMOTION' && source.projectKey === null))
        ));
        results[index] = await discovery.discover(project, {
          registrySources: projectRegistrySources,
        });
      } catch (error) {
        results[index] = {
          status: 'ERROR',
          project,
          developerCanonicalUrl: null,
          officialDeveloperName: null,
          canonicalUrl: null,
          officialProjectName: null,
          matchKind: null,
          reason: '',
          errorCode: readErrorCode(error),
          citations: [],
          developerCitations: [],
          projectCitations: [],
          matchedProjectAlias: null,
          matchedPlatformProjectAlias: null,
          matchedOfficialProjectAlias: null,
          matchedDeveloperAlias: null,
          matchedAddress: false,
          contentChecksum: null,
          developerCacheHit: false,
          telemetry: error instanceof AssistantSourceDiscoveryError
            ? error.phaseTelemetries.length > 0
              ? aggregateTelemetry(error.phaseTelemetries)
              : {
                provider: 'openai',
                model: ASSISTANT_SOURCE_DISCOVERY_MODEL,
                requestId: error.requestId,
                responseId: error.responseId,
                httpStatus: error.httpStatus,
                inputTokens: null,
                cachedInputTokens: null,
                cacheWriteInputTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                totalTokens: null,
                webSearchCalls: null,
                phases: [],
              }
            : null,
        };
      }
      process.stderr.write(
        `[${index + 1}/${projects.length}] ${project.title}: ${results[index].status}`
          + `${results[index].errorCode ? ` (${results[index].errorCode})` : ''}\n`,
      );
    }
  });
  await Promise.all(workers);
  return results;
}

function rejectDuplicateCanonicalUrls(results) {
  const seen = new Set();
  for (const result of results) {
    if (result.status !== 'VERIFIED' || !result.canonicalUrl) continue;
    if (seen.has(result.canonicalUrl)) {
      result.status = 'REJECTED';
      result.errorCode = 'ASSISTANT_SOURCE_DISCOVERY_URL_DUPLICATE';
      continue;
    }
    seen.add(result.canonicalUrl);
  }
}

async function applyVerifiedSources(application, prisma, results) {
  const registry = application.get(AssistantSourceRegistryService);
  const ingestion = application.get(AssistantSourceIngestionService);
  const actor = await prisma.user.findFirst({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      role: {
        permissions: {
          some: { permission: { key: 'assistant:sources:manage' } },
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (!actor) throw new Error('ASSISTANT_SOURCE_DISCOVERY_ACTOR_MISSING');

  const applyResults = [];
  for (const result of results) {
    if (result.status !== 'VERIFIED' || !result.canonicalUrl) continue;
    const hostname = new URL(result.canonicalUrl).hostname.toLocaleLowerCase('en-US');
    try {
      const registered = await registry.register(actor.id, {
        canonicalUrl: result.canonicalUrl,
        type: 'DEVELOPMENT_PAGE',
        state: 'ACTIVE',
        priority: 100,
        scheduleMinutes: 1_440,
        connectorKey: 'OFFICIAL_HTML',
        connectorConfig: { allowedHosts: relatedHosts(hostname) },
        projectKey: result.project.projectKey,
        developerKey: result.project.developerKey,
      });
      let ingestionResult = null;
      let ingestionErrorCode = null;
      try {
        ingestionResult = await ingestion.ingest(registered.source.id);
      } catch (error) {
        ingestionErrorCode = readErrorCode(error);
      }
      applyResults.push({
        projectKey: result.project.projectKey,
        sourceId: registered.source.id,
        canonicalUrl: registered.source.canonicalUrl,
        ingestion: ingestionResult,
        ingestionErrorCode,
      });
    } catch (error) {
      applyResults.push({
        projectKey: result.project.projectKey,
        sourceId: null,
        canonicalUrl: result.canonicalUrl,
        ingestion: null,
        ingestionErrorCode: readErrorCode(error),
      });
    }
  }
  return applyResults;
}

function createReport(options, results, applyResults, context) {
  const phases = results.flatMap((result) => result.telemetry?.phases ?? []);
  if (options.live && !Array.isArray(context.persistedAttempts)) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_REQUIRED');
  }
  if (options.live && (!context.providerBudgetContract
    || typeof context.providerBudgetContract.passed !== 'boolean')) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_ASSESSMENT_REQUIRED');
  }
  const usageSummary = options.live
    ? summarizePersistedAttempts(context.persistedAttempts)
    : summarizeInMemoryPhases(phases);
  const costCapMayStopBeforeCompletion = parseAssistantUsd(options.maxCostUsd)
    < parseAssistantUsd(context.maximumEstimatedUsd);
  return {
    runId: context.runId,
    mode: options.live ? (options.apply ? 'LIVE_APPLY' : 'LIVE_PREVIEW') : 'DRY_RUN',
    stopReason: options.live
      ? readLiveStopReason(results, applyResults, context.providerBudgetContract)
      : costCapMayStopBeforeCompletion
        ? 'ASSISTANT_SOURCE_DISCOVERY_DRY_RUN_COST_CAP_MAY_STOP'
        : 'ASSISTANT_SOURCE_DISCOVERY_DRY_RUN_COMPLETE',
    pricingCatalogVersion: usageSummary.pricingCatalogVersion,
    pricingCatalogVersions: usageSummary.pricingCatalogVersions,
    generatedAt: new Date().toISOString(),
    providerBudgetContract: options.live ? context.providerBudgetContract : {
      passed: true,
      condition: null,
      violationCount: 0,
      violatingReceipts: [],
      reportedUsageMismatches: [],
    },
    selection: {
      requestedProjects: options.limit,
      maximumBatchProjects: maximumDiscoveryBatchProjects,
      selectedProjects: context.selectedProjects.length,
      concurrency: options.concurrency,
      missingOnly: options.missingOnly,
      refresh: options.refresh,
      selectedProjectKeys: context.selectedProjects.map(({ projectKey }) => projectKey),
      checkpointProjectKeys: context.checkpointProjectKeys ?? [],
      requestedCostCapUsd: options.maxCostUsd,
      maximumEstimatedUsd: context.maximumEstimatedUsd,
      costCapMayStopBeforeCompletion,
    },
    summary: {
      verified: results.filter(({ status }) => status === 'VERIFIED').length,
      notFound: results.filter(({ status }) => status === 'NOT_FOUND').length,
      rejected: results.filter(({ status }) => status === 'REJECTED').length,
      errors: results.filter(({ status }) => status === 'ERROR').length,
      registered: applyResults.filter(({ sourceId }) => sourceId !== null).length,
      indexed: applyResults.filter(({ ingestion }) => ingestion?.outcome === 'INDEXED'
        || ingestion?.outcome === 'UNCHANGED').length,
      ingestionFailed: applyResults.filter(({ ingestionErrorCode }) => ingestionErrorCode !== null).length,
      providerRequests: usageSummary.providerRequests,
      lunaCalls: usageSummary.lunaCalls,
      terraCalls: usageSummary.terraCalls,
      fallbackCalls: usageSummary.fallbackCalls,
      developerCacheHits: results.filter(({ developerCacheHit }) => developerCacheHit).length,
      checkpointEntriesSkipped: context.checkpointHits,
      tokenUsage: usageSummary.tokenUsage,
      knownTokenUsage: usageSummary.knownTokenUsage,
      usageUnknownAttempts: usageSummary.usageUnknownAttempts,
      reservedUsd: usageSummary.reservedUsd,
      estimatedUsd: usageSummary.estimatedUsd,
      chargedUsd: usageSummary.chargedUsd,
    },
    results: results.map((result) => ({
      projectKey: result.project.projectKey,
      status: result.status,
      errorCode: result.errorCode,
      matchKind: result.matchKind,
      providerRequests: result.telemetry?.phases?.length ?? 0,
    })),
    applyResults: applyResults.map((result) => ({
      projectKey: result.projectKey,
      sourceId: result.sourceId,
      ingestionOutcome: result.ingestion?.outcome ?? null,
      ingestionErrorCode: result.ingestionErrorCode,
    })),
  };
}

async function loadAssistantUsageAttempts(prisma, operationRunId, executionId) {
  try {
    return await prisma.assistantAiUsageAttempt.findMany({
      where: { operationRunId, executionId, operation: 'SOURCE_DISCOVERY' },
      orderBy: { attemptOrdinal: 'asc' },
      select: {
        operationRunId: true,
        executionId: true,
        attemptOrdinal: true,
        operation: true,
        requestedModel: true,
        actualModel: true,
        isFallback: true,
        status: true,
        outcome: true,
        pricingStatus: true,
        inputTokens: true,
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        totalTokens: true,
        webSearchCalls: true,
        pricingCatalogVersion: true,
        reservedCostUsd: true,
        estimatedCostUsd: true,
        chargedCostUsd: true,
      },
    });
  } catch {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_READ_FAILED');
  }
}

function summarizePersistedAttempts(attempts) {
  const usage = summarizeUsageRecords(attempts, assistantUsageReportFields);
  const pricingCatalogVersions = attempts.length === 0
    ? [ASSISTANT_AI_PRICING_CATALOG_VERSION]
    : [...new Set(attempts.map(({ pricingCatalogVersion }) => (
      readPricingCatalogVersion(pricingCatalogVersion)
    )))];
  const reservedUsd = addAssistantUsd(attempts.map(({ reservedCostUsd }) => (
    readPersistedUsd(reservedCostUsd)
  )));
  const estimatedUsd = attempts.every(({ estimatedCostUsd }) => estimatedCostUsd !== null)
    ? addAssistantUsd(attempts.map(({ estimatedCostUsd }) => readPersistedUsd(estimatedCostUsd)))
    : null;
  const chargedUsd = addAssistantUsd(attempts.map((attempt) => {
    if (attempt.chargedCostUsd !== null) return readPersistedUsd(attempt.chargedCostUsd);
    if (attempt.status === 'RESERVED') return readPersistedUsd(attempt.reservedCostUsd);
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_INVALID');
  }));
  const lunaCalls = attempts.filter(({ requestedModel }) => (
    requestedModel === ASSISTANT_SOURCE_DISCOVERY_MODEL
  )).length;
  const terraCalls = attempts.filter(({ requestedModel }) => (
    requestedModel === ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL
  )).length;
  if (lunaCalls + terraCalls !== attempts.length
    || attempts.some(({ isFallback, status }) => (
      typeof isFallback !== 'boolean' || (status !== 'RESERVED' && status !== 'SETTLED')
    ))) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_INVALID');
  }
  return {
    pricingCatalogVersion: pricingCatalogVersions.length === 1
      ? pricingCatalogVersions[0]
      : null,
    pricingCatalogVersions,
    providerRequests: attempts.length,
    lunaCalls,
    terraCalls,
    fallbackCalls: attempts.filter(({ isFallback }) => isFallback).length,
    ...usage,
    reservedUsd,
    estimatedUsd,
    chargedUsd,
  };
}

function summarizeInMemoryPhases(phases) {
  const usage = summarizeUsageRecords(phases, assistantUsageReportFields);
  const phaseCosts = phases.map((phase) => calculateAssistantAiCost({
    model: phase.model,
    inputTokens: phase.inputTokens,
    cachedInputTokens: phase.cachedInputTokens,
    cacheWriteInputTokens: phase.cacheWriteInputTokens,
    outputTokens: phase.outputTokens,
    webSearchCalls: phase.webSearchCalls,
  }));
  const estimatedUsd = phaseCosts.every((cost) => cost.status === 'PRICED')
    ? addAssistantUsd(phaseCosts.map((cost) => cost.estimatedUsd))
    : null;
  return {
    pricingCatalogVersion: ASSISTANT_AI_PRICING_CATALOG_VERSION,
    pricingCatalogVersions: [ASSISTANT_AI_PRICING_CATALOG_VERSION],
    providerRequests: phases.length,
    lunaCalls: phases.filter(({ model }) => model === ASSISTANT_SOURCE_DISCOVERY_MODEL).length,
    terraCalls: phases.filter(({ model }) => model === ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL).length,
    fallbackCalls: phases.filter(({ model }) => (
      model === ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL
    )).length,
    ...usage,
    reservedUsd: phases.length === 0 ? '0.00000000' : null,
    estimatedUsd,
    chargedUsd: phases.length === 0 ? '0.00000000' : null,
  };
}

function summarizeUsageRecords(records, fields) {
  const knownTokenUsage = Object.fromEntries(fields.map((field) => [
    field,
    toSafeUsageNumber(records.reduce((sum, record) => (
      record[field] === null ? sum : sum + readUsageCount(record[field])
    ), 0n)),
  ]));
  const tokenUsage = Object.fromEntries(fields.map((field) => [
    field,
    records.every((record) => record[field] !== null)
      ? knownTokenUsage[field]
      : null,
  ]));
  return {
    tokenUsage,
    knownTokenUsage,
    usageUnknownAttempts: records.filter((record) => (
      fields.some((field) => record[field] === null)
    )).length,
  };
}

function readUsageCount(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_INVALID');
}

function readPricingCatalogVersion(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_INVALID');
  }
  return value;
}

function toSafeUsageNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_INVALID');
  }
  return Number(value);
}

function readPersistedUsd(value) {
  if (!value || typeof value.toFixed !== 'function') {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_INVALID');
  }
  try {
    return formatAssistantUsd(parseAssistantUsd(value.toFixed(8)));
  } catch {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_USAGE_LEDGER_INVALID');
  }
}

function estimateMaximumDiscoveryCost(providerEligibleProjectCount) {
  const totalCalls = Math.min(
    maximumSourceDiscoveryProviderCalls,
    providerEligibleProjectCount * maximumSourceDiscoveryCallsPerProject,
  );
  const terraCalls = Math.min(
    maximumSourceDiscoveryTerraFallbacks,
    providerEligibleProjectCount,
    totalCalls,
  );
  const lunaCalls = totalCalls - terraCalls;
  const estimateCall = (model) => {
    const estimate = estimateAssistantAiCallCost({
      model,
      requestBytes: maximumProviderRequestBytes,
      maxOutputTokens: maximumProviderOutputTokens,
      maxWebSearchCalls: maximumReservedProviderWebSearchCalls,
    });
    if (estimate.status !== 'PRICED' || estimate.estimatedUsd === null) {
      throw new Error('ASSISTANT_SOURCE_DISCOVERY_COST_UNPRICED');
    }
    return estimate.estimatedUsd;
  };
  return addAssistantUsd([
    ...Array.from({ length: lunaCalls }, () => estimateCall(ASSISTANT_SOURCE_DISCOVERY_MODEL)),
    ...Array.from({ length: terraCalls }, () => estimateCall(
      ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL,
    )),
  ]);
}

function readLiveStopReason(results, applyResults, providerBudgetContract) {
  const discoveryError = results.find(({ status, errorCode }) => (
    status === 'ERROR' && errorCode
  ))?.errorCode;
  if (discoveryError) return discoveryError;
  if (!providerBudgetContract.passed) return providerBudgetContract.condition;
  const ingestionError = applyResults.find(({ ingestionErrorCode }) => (
    ingestionErrorCode
  ))?.ingestionErrorCode;
  return ingestionError ?? 'ASSISTANT_SOURCE_DISCOVERY_COMPLETED';
}

function createAssistantSourceDiscoveryOperationRunId(checkpointPath) {
  const checkpointHash = createHash('sha256')
    .update(resolve(checkpointPath))
    .digest('hex');
  return `assistant-source-discovery:${checkpointHash}`;
}

function assertLocalApplyEnvironment(environment) {
  if (environment.ASSISTANT_SOURCE_DISCOVERY_LOCAL_APPLY !== 'true') {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_LOCAL_APPLY_CONFIRMATION_REQUIRED');
  }
  const isProduction = [environment.DEPLOYMENT_ENV, environment.NODE_ENV]
    .some((value) => ['production', 'prod'].includes(
      (value || '').trim().toLocaleLowerCase('en-US'),
    ));
  if (isProduction) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_PRODUCTION_APPLY_FORBIDDEN');
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED');
  let hostname;
  try {
    hostname = new URL(databaseUrl).hostname.toLocaleLowerCase('en-US');
  } catch {
    throw new Error('DATABASE_URL_INVALID');
  }
  if (!['127.0.0.1', 'localhost', '::1', 'postgres', 'host.docker.internal'].includes(hostname)) {
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_NONLOCAL_DATABASE_FORBIDDEN');
  }
}

function assertPaidCallsAllowed(environment) {
  if (environment.ASSISTANT_PAID_CALLS_CONFIRMED !== 'true') {
    throw new Error('ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED');
  }
  if (!environment.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY_MISSING');
  }
}

function createCheckpointFingerprint() {
  return {
    primaryModel: ASSISTANT_SOURCE_DISCOVERY_MODEL,
    fallbackModel: ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL,
    promptVersion: ASSISTANT_SOURCE_DISCOVERY_PROMPT_VERSION,
    validatorVersion: ASSISTANT_SOURCE_DISCOVERY_VALIDATOR_VERSION,
  };
}

function readErrorCode(error) {
  if (error && typeof error === 'object'
    && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]*(?::--?[a-z0-9-]+)?$/u.test(error.code)) return error.code;
  if (error instanceof Error
    && /^[A-Z][A-Z0-9_]*(?::--?[a-z0-9-]+)?$/u.test(error.message)) return error.message;
  return 'ASSISTANT_SOURCE_DISCOVERY_FAILED';
}

module.exports = {
  assertPaidCallsAllowed,
  createReport,
  discoverProjects,
  loadDiscoveryRegistrySources,
  parseArguments,
  runAssistantSourceDiscovery,
  selectDiscoveryProjects,
};
