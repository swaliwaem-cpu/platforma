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
} = require('../dist/assistant/sources/assistant-source-discovery.service.js');
const {
  ASSISTANT_SOURCE_DISCOVERY_PROMPT_VERSION,
  aggregateTelemetry,
} = require('../dist/assistant/sources/assistant-source-discovery-provider.js');
const {
  ASSISTANT_SOURCE_DISCOVERY_VALIDATOR_VERSION,
  checkpointAssistantSourceDiscoveryResult,
  readAssistantSourceDiscoveryCheckpoint,
  writeAssistantSourceDiscoveryCheckpoint,
} = require('../dist/assistant/sources/assistant-source-discovery-checkpoint.js');
const {
  addAssistantUsd,
  calculateAssistantAiCost,
  formatAssistantUsd,
  parseAssistantUsd,
} = require('../dist/assistant/operations/assistant-ai-cost.js');
const {
  AssistantAiUsageBudgetService,
  readAssistantDailyUsdBudget,
} = require('../dist/assistant/operations/assistant-ai-usage-budget.service.js');
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

const maximumPilotDevelopers = 7;
const maximumPilotProjects = 20;

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
    let checkpoint = readAssistantSourceDiscoveryCheckpoint(checkpointPath, fingerprint);
    const checkpointIdentities = new Set(options.refresh
      ? []
      : Object.values(checkpoint.entries).map(({ projectKey, developerKey }) => (
        `${projectKey}\u0000${developerKey}`
      )));
    const excludedProjectKeys = new Set(options.excludedProjectKeys);
    const selectProjects = dependencies.selectProjects ?? selectPilotProjects;
    const projects = await selectProjects(
      prisma,
      options.limit,
      options.missingOnly,
      excludedProjectKeys,
    );
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
    const checkpointHits = projects.filter(({ projectKey, developerKey }) => (
      checkpointIdentities.has(`${projectKey}\u0000${developerKey}`)
        && !registryProjectIdentities.has(`${projectKey}\u0000${developerKey}`)
    )).length;
    const pendingProjects = projects.filter(({ projectKey, developerKey }) => (
      registryProjectIdentities.has(`${projectKey}\u0000${developerKey}`)
        || !checkpointIdentities.has(`${projectKey}\u0000${developerKey}`)
    ));
    const runId = dependencies.runId
      ?? createAssistantSourceDiscoveryOperationRunId(checkpointPath);
    const executionId = dependencies.executionId ?? randomUUID();
    const maximumEstimatedUsd = options.maxCostUsd;
    if (!options.live) {
      const report = createReport(options, [], [], {
        runId,
        selectedProjects: projects,
        maximumEstimatedUsd,
        checkpointHits,
      });
      if (!input.silent) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report;
    }

    const discoveryEnvironment = {
      ...environment,
      ASSISTANT_SOURCE_DISCOVERY_MODEL,
      ASSISTANT_SOURCE_DISCOVERY_MAX_PROVIDER_CALLS: String(Math.min(35, pendingProjects.length * 3)),
      ASSISTANT_SOURCE_DISCOVERY_MAX_TERRA_FALLBACKS: String(Math.min(2, pendingProjects.length)),
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
    rejectDuplicateCanonicalUrls(results);

    for (const result of results) {
      if (result.status === 'ERROR') continue;
      checkpoint = checkpointAssistantSourceDiscoveryResult(checkpoint, result);
    }
    writeAssistantSourceDiscoveryCheckpoint(checkpointPath, checkpoint);

    const applyResults = options.apply
      ? await applyVerifiedSources(application, prisma, results)
      : [];
    const report = createReport(options, results, applyResults, {
      runId,
      selectedProjects: projects,
      maximumEstimatedUsd,
      checkpointHits,
    });
    if (!input.silent) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.summary.verified + checkpointHits !== projects.length
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
  const limit = readIntegerArgument(values, '--limit', 1, 1, maximumPilotProjects);
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

async function selectPilotProjects(prisma, limit, missingOnly, excludedProjectKeys) {
  const registered = missingOnly
    ? await prisma.assistantKnowledgeSource.findMany({
      where: {
        type: { in: ['DEVELOPMENT_PAGE', 'DEVELOPER_PROMOTION', 'BANK_PROMOTION'] },
      },
      select: {
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
      },
    })
    : [];
  const allRegisteredProjectKeys = new Set(registered.flatMap(({ projectKey }) => (
    projectKey ? [projectKey] : []
  )));
  const registrySources = registered.map(({ connectorConfigJson, revisions, ...source }) => ({
    ...source,
    connectorConfig: connectorConfigJson,
    latestRevision: revisions[0] ?? null,
  }));
  const developerKeys = new Set(registered.flatMap(({ developerKey }) => developerKey ? [developerKey] : []));
  const pilotProjectKeys = new Set(allRegisteredProjectKeys);
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
    take: 500,
  });
  objects.sort((left, right) => (
    (right.feedUnitsCount ?? 0) - (left.feedUnitsCount ?? 0)
      || left.title.localeCompare(right.title, 'ru')
  ));
  const selected = [];
  let capacityBlocked = false;
  for (const object of objects) {
    if (!object.developer) continue;
    const developerKey = object.developer.slug
      || object.developer.normalizedName
      || object.developer.name;
    if (excludedProjectKeys.has(object.slug)
      || findRegisteredProjectSource({
        projectKey: object.slug,
        developerKey,
      }, registrySources)) continue;
    if (!pilotProjectKeys.has(object.slug) && pilotProjectKeys.size >= maximumPilotProjects) {
      capacityBlocked = true;
      continue;
    }
    if (!developerKeys.has(developerKey) && developerKeys.size >= maximumPilotDevelopers) continue;
    developerKeys.add(developerKey);
    pilotProjectKeys.add(object.slug);
    selected.push({
      projectKey: object.slug,
      title: object.title,
      developerKey,
      developerName: object.developer.name,
      address: object.address,
    });
    if (selected.length === limit) break;
  }
  if (selected.length !== limit) {
    if (capacityBlocked) throw new Error('ASSISTANT_SOURCE_DISCOVERY_PILOT_PROJECT_LIMIT');
    throw new Error('ASSISTANT_SOURCE_DISCOVERY_PILOT_SELECTION_INSUFFICIENT');
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
    select: {
      id: true,
      state: true,
      type: true,
      canonicalUrl: true,
      projectKey: true,
      developerKey: true,
      connectorKey: true,
      connectorConfigJson: true,
      revisions: {
        where: { processingStatus: 'INDEXED' },
        orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { processingStatus: true, checksum: true },
      },
    },
  });
  return sources.map(({ connectorConfigJson, revisions, ...source }) => ({
    ...source,
    connectorConfig: connectorConfigJson,
    latestRevision: revisions[0] ?? null,
  }));
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
            ? error.phaseTelemetry
              ? aggregateTelemetry([error.phaseTelemetry])
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
  const tokenUsage = results.reduce((total, result) => {
    const usage = result.telemetry;
    total.inputTokens += usage?.inputTokens ?? 0;
    total.cachedInputTokens += usage?.cachedInputTokens ?? 0;
    total.cacheWriteInputTokens += usage?.cacheWriteInputTokens ?? 0;
    total.outputTokens += usage?.outputTokens ?? 0;
    total.reasoningTokens += usage?.reasoningTokens ?? 0;
    total.totalTokens += usage?.totalTokens ?? 0;
    total.webSearchCalls += usage?.webSearchCalls ?? 0;
    return total;
  }, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    webSearchCalls: 0,
  });
  const phases = results.flatMap((result) => result.telemetry?.phases ?? []);
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
    runId: context.runId,
    mode: options.live ? (options.apply ? 'LIVE_APPLY' : 'LIVE_PREVIEW') : 'DRY_RUN',
    generatedAt: new Date().toISOString(),
    selection: {
      requestedProjects: options.limit,
      maximumDevelopers: maximumPilotDevelopers,
      concurrency: options.concurrency,
      missingOnly: options.missingOnly,
      refresh: options.refresh,
      selectedProjectKeys: context.selectedProjects.map(({ projectKey }) => projectKey),
      maximumEstimatedUsd: context.maximumEstimatedUsd,
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
      providerRequests: phases.length,
      lunaCalls: phases.filter(({ model }) => model === ASSISTANT_SOURCE_DISCOVERY_MODEL).length,
      terraCalls: phases.filter(({ model }) => model === ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL).length,
      fallbackCalls: phases.filter(({ model }) => model === ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL).length,
      developerCacheHits: results.filter(({ developerCacheHit }) => developerCacheHit).length,
      checkpointEntriesSkipped: context.checkpointHits,
      tokenUsage,
      estimatedUsd,
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
  if ((environment.DEPLOYMENT_ENV || '').trim().toLocaleLowerCase('en-US') === 'production') {
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
  selectPilotProjects,
};
