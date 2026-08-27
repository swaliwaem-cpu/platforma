import { randomUUID } from 'node:crypto';

import {
  OfficialHtmlSourceConnector,
  SourceConnectorError,
  type SourceConnectorFetchResult,
} from './official-html-source.connector';
import {
  extractLinkedOfficialDeveloperUrls,
  extractOfficialProjectLinks,
  findDeveloperAlias,
  findProjectCatalogEvidence,
  hasMultipleProjectCatalogEntries,
  inferOfficialProjectNameFromPage,
  isBlockedDomain,
  isUrlWithinAllowedHosts,
  normalizeHostname,
  normalizeCandidateUrl,
  readProjectIdentityError,
  relatedHosts,
  verifyProjectIdentity,
  type AssistantSourceIdentityMatchKind,
  type AssistantSourceCatalogProjectEvidence,
  type AssistantSourceIdentityProject,
} from './assistant-source-discovery-identity';
import {
  AssistantSourceDiscoveryError,
  ASSISTANT_SOURCE_DISCOVERY_PROMPT_VERSION,
  aggregateTelemetry,
  collectCitationUrls,
  createDeveloperDiscoveryRequestBody,
  createPhaseTelemetry,
  createProjectDiscoveryRequestBody,
  isRecord,
  maximumProviderResponseBytes,
  parseDeveloperCandidate,
  parseProjectCandidate,
  readBoundedInteger,
  readBoundedJson,
  readBoundedString,
  readDiscoveryCode,
  readOptionalString,
  type AssistantSourceDiscoveryPhase,
  type AssistantSourceDiscoveryPhaseTelemetry,
  type AssistantSourceDiscoveryTelemetry,
} from './assistant-source-discovery-provider';
import { ASSISTANT_SOURCE_DISCOVERY_VALIDATOR_VERSION } from './assistant-source-discovery-checkpoint';
import {
  buildKnownProjectUrls,
  catalogCodeMatchesUrl,
  createDeveloperCacheKey,
  isNarrowNonResidentialDeveloperUrl,
  isSameCanonicalPage,
  uniqueUrls,
} from './assistant-source-discovery-policy';
import {
  findRegisteredDeveloperSources,
  findRegisteredProjectSource,
  type AssistantSourceDiscoveryRegistrySource,
} from './assistant-source-discovery-registry';
import {
  ASSISTANT_AI_SERVICE_TIER,
  estimateAssistantAiCallCost,
  parseAssistantUsd,
} from '../operations/assistant-ai-cost';
import {
  AssistantAiUsageBudgetService,
  type AssistantAiUsageReservation,
} from '../operations/assistant-ai-usage-budget.service';

export { AssistantSourceDiscoveryError } from './assistant-source-discovery-provider';
export type {
  AssistantSourceDiscoveryPhase,
  AssistantSourceDiscoveryPhaseTelemetry,
  AssistantSourceDiscoveryTelemetry,
} from './assistant-source-discovery-provider';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

type AssistantSourceDiscoveryServiceOptions = {
  usageBudgets: AssistantAiUsageBudgetService;
  dailyBudgetUsd: string;
  maximumRunCostUsd: string;
  operationRunId: string;
  executionId: string;
};

export const ASSISTANT_SOURCE_DISCOVERY_MODEL = 'gpt-5.6-luna';
export const ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL = 'gpt-5.6-terra';
const defaultTimeoutMs = 60_000;
const developerCacheTtlMs = 15 * 60_000;
const maximumDeveloperCacheEntries = 50;
export type AssistantSourceDiscoveryProject = AssistantSourceIdentityProject;

export type AssistantSourceDiscoveryMatchKind = AssistantSourceIdentityMatchKind;

export type { AssistantSourceDiscoveryRegistrySource } from './assistant-source-discovery-registry';

export type AssistantSourceDiscoverySeed = {
  registrySources?: readonly AssistantSourceDiscoveryRegistrySource[];
};

export type AssistantSourceDiscoveryResult = {
  status: 'VERIFIED' | 'NOT_FOUND' | 'REJECTED';
  project: AssistantSourceDiscoveryProject;
  developerCanonicalUrl: string | null;
  officialDeveloperName: string | null;
  canonicalUrl: string | null;
  officialProjectName: string | null;
  matchKind: AssistantSourceDiscoveryMatchKind | null;
  reason: string;
  errorCode: string | null;
  citations: string[];
  developerCitations: string[];
  projectCitations: string[];
  matchedProjectAlias: string | null;
  matchedPlatformProjectAlias: string | null;
  matchedOfficialProjectAlias: string | null;
  matchedDeveloperAlias: string | null;
  matchedAddress: boolean;
  contentChecksum: string | null;
  developerCacheHit: boolean;
  telemetry: AssistantSourceDiscoveryTelemetry;
};

type SourceConnector = Pick<OfficialHtmlSourceConnector, 'fetch'>;

type VerifiedDeveloper = {
  canonicalUrl: string;
  allowedHosts: string[];
  catalogUrls: string[];
  officialName: string;
  matchedAlias: string;
  citations: string[];
};

type DeveloperResolutionSuccess = {
  status: 'VERIFIED';
  developer: VerifiedDeveloper;
  phaseTelemetries: AssistantSourceDiscoveryPhaseTelemetry[];
  cacheHit: boolean;
};

type DeveloperResolutionFailure = {
  status: 'NOT_FOUND' | 'REJECTED';
  reason: string;
  errorCode: string | null;
  developerCanonicalUrl: string | null;
  officialDeveloperName: string | null;
  developerCitations: string[];
  telemetry: AssistantSourceDiscoveryTelemetry;
};

type DeveloperCacheEntry = {
  expiresAt: number;
  promise: Promise<DeveloperResolutionSuccess | DeveloperResolutionFailure>;
};

type VerifiedProjectCatalogEvidence = AssistantSourceCatalogProjectEvidence & {
  page: SourceConnectorFetchResult;
};

type AlternativeDeveloperPage = {
  page: SourceConnectorFetchResult | null;
  canonicalUrl: string | null;
  candidate: ReturnType<typeof parseDeveloperCandidate>;
  citations: string[];
  phaseTelemetry: AssistantSourceDiscoveryPhaseTelemetry;
};

export class AssistantSourceDiscoveryService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maximumProviderCalls: number;
  private readonly maximumTerraFallbacks: number;
  private providerCallCount = 0;
  private terraFallbackCount = 0;
  private readonly projectCallCounts = new Map<string, number>();
  private readonly live: boolean;
  private runReservedCostUnits = 0n;
  private nextAttemptOrdinal = 1;
  private readonly developerCache = new Map<string, DeveloperCacheEntry>();
  private readonly developerCatalogCache = new Map<
    string,
    Promise<SourceConnectorFetchResult | null>
  >();
  private readonly renderedDeveloperCatalogUrls = new Set<string>();

  constructor(
    environment: AssistantEnvironment = process.env,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly sourceConnector: SourceConnector = new OfficialHtmlSourceConnector(),
    private readonly serviceOptions?: AssistantSourceDiscoveryServiceOptions,
  ) {
    this.apiKey = environment.OPENAI_API_KEY?.trim() ?? '';
    if (!this.apiKey) throw new AssistantSourceDiscoveryError('OPENAI_API_KEY_MISSING');
    this.baseUrl = environment.ASSISTANT_OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
    this.model = readBoundedString(
      environment.ASSISTANT_SOURCE_DISCOVERY_MODEL?.trim() || ASSISTANT_SOURCE_DISCOVERY_MODEL,
      160,
      'ASSISTANT_SOURCE_DISCOVERY_MODEL_INVALID',
    );
    if (this.model !== ASSISTANT_SOURCE_DISCOVERY_MODEL) {
      throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_MODEL_INVALID');
    }
    this.timeoutMs = readBoundedInteger(
      environment.ASSISTANT_SOURCE_DISCOVERY_TIMEOUT_MS,
      defaultTimeoutMs,
      5_000,
      120_000,
      'ASSISTANT_SOURCE_DISCOVERY_TIMEOUT_MS_INVALID',
    );
    this.maximumProviderCalls = readBoundedInteger(
      environment.ASSISTANT_SOURCE_DISCOVERY_MAX_PROVIDER_CALLS,
      35,
      1,
      35,
      'ASSISTANT_SOURCE_DISCOVERY_MAX_PROVIDER_CALLS_INVALID',
    );
    this.maximumTerraFallbacks = readBoundedInteger(
      environment.ASSISTANT_SOURCE_DISCOVERY_MAX_TERRA_FALLBACKS,
      2,
      0,
      2,
      'ASSISTANT_SOURCE_DISCOVERY_MAX_TERRA_FALLBACKS_INVALID',
    );
    this.live = environment.ASSISTANT_SOURCE_DISCOVERY_LIVE === 'true';
    if (this.live && environment.ASSISTANT_PAID_CALLS_CONFIRMED !== 'true') {
      throw new AssistantSourceDiscoveryError('ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED');
    }
    if (this.live && !serviceOptions) {
      throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_USAGE_BUDGET_REQUIRED');
    }
    if (!this.live && fetchImplementation === fetch) {
      throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_LIVE_REQUIRED');
    }
  }

  async discover(
    projectValue: AssistantSourceDiscoveryProject,
    seed: AssistantSourceDiscoverySeed = {},
  ): Promise<AssistantSourceDiscoveryResult> {
    const projectKey = projectValue.projectKey;
    this.projectCallCounts.set(projectKey, 0);
    try {
      return await this.discoverWithinBudget(projectValue, seed);
    } finally {
      this.projectCallCounts.delete(projectKey);
    }
  }

  private async discoverWithinBudget(
    projectValue: AssistantSourceDiscoveryProject,
    seed: AssistantSourceDiscoverySeed,
  ): Promise<AssistantSourceDiscoveryResult> {
    const project = parseProject(projectValue);
    const registeredProjectSource = findRegisteredProjectSource(project, seed.registrySources ?? []);
    if (registeredProjectSource) {
      return registeredProjectSourceResult(project, registeredProjectSource, this.model);
    }
    const developerResolution = await this.resolveDeveloper(project, seed.registrySources ?? []);
    if (developerResolution.status !== 'VERIFIED') {
      return rejectedResult({
        status: developerResolution.status,
        project,
        reason: developerResolution.reason,
        errorCode: developerResolution.errorCode,
        developerCanonicalUrl: developerResolution.developerCanonicalUrl,
        officialDeveloperName: developerResolution.officialDeveloperName,
        developerCitations: developerResolution.developerCitations,
        telemetry: developerResolution.telemetry,
      });
    }
    const {
      developer,
      phaseTelemetries: developerPhaseTelemetries,
      cacheHit: developerCacheHit,
    } = developerResolution;
    const developerCitations = developer.citations;
    let catalogEvidence = await this.findDeveloperCatalogEvidence(project, developer);
    const knownPath = await this.findProjectByKnownPaths(
      project,
      developer,
      catalogEvidence,
    );
    if (knownPath) {
      const matchedProjectAlias = knownPath.identity.matchedPlatformProjectAlias
        ?? knownPath.identity.matchedOfficialProjectAlias;
      const matchKind = catalogEvidence
        ? inferCatalogMatchKind(project, catalogEvidence)
        : inferKnownPathMatchKind(project, matchedProjectAlias);
      const canonicalPage = await this.findCanonicalProjectPage(
        project,
        knownPath.officialProjectName,
        knownPath.page,
        developer.allowedHosts,
      );
      return {
        status: 'VERIFIED',
        project,
        developerCanonicalUrl: developer.canonicalUrl,
        officialDeveloperName: developer.officialName,
        canonicalUrl: normalizeCandidateUrl(canonicalPage.finalUrl),
        officialProjectName: knownPath.officialProjectName,
        matchKind,
        reason: catalogEvidence
          ? 'Источник найден локально по официальному каталогу и ограниченному набору известных путей.'
          : 'Источник найден до обращения к модели по ограниченному набору известных путей и независимо проверен.',
        errorCode: null,
        citations: [],
        developerCitations,
        projectCitations: [],
        matchedProjectAlias,
        matchedPlatformProjectAlias: knownPath.identity.matchedPlatformProjectAlias,
        matchedOfficialProjectAlias: knownPath.identity.matchedOfficialProjectAlias,
        matchedDeveloperAlias: knownPath.identity.matchedDeveloperAlias ?? developer.matchedAlias,
        matchedAddress: knownPath.identity.matchedAddress,
        contentChecksum: canonicalPage.checksum,
        developerCacheHit,
        telemetry: telemetryFromPhases(developerPhaseTelemetries, this.model),
      };
    }
    let projectModel = this.model;
    let projectProviderResult = await this.requestCandidate(
      'PROJECT',
      project,
      developer,
      catalogEvidence ?? undefined,
    );
    let projectCitations = collectCitationUrls(projectProviderResult.value);
    const phaseTelemetries = [
      ...developerPhaseTelemetries,
      createPhaseTelemetry('PROJECT', this.model, projectProviderResult),
    ];
    const requestTerraFallback = async () => {
      projectProviderResult = await this.requestCandidate(
        'PROJECT',
        project,
        developer,
        catalogEvidence ?? undefined,
        undefined,
        ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL,
      );
      projectModel = ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL;
      projectCitations = uniqueUrls(
        projectCitations,
        collectCitationUrls(projectProviderResult.value),
      );
      phaseTelemetries.push(createPhaseTelemetry(
        'PROJECT',
        ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL,
        projectProviderResult,
      ));
    };

    projectValidation: for (;;) {
      let projectCandidate: ReturnType<typeof parseProjectCandidate>;
      try {
        projectCandidate = parseProjectCandidate(projectProviderResult.value);
      } catch (error) {
        if (projectModel === this.model) {
          await requestTerraFallback();
          continue projectValidation;
        }
        throw error;
      }
      if (projectCandidate.status === 'NOT_FOUND'
        && projectModel === this.model
        && catalogEvidence) {
        await requestTerraFallback();
        continue projectValidation;
      }
      const telemetry = aggregateTelemetry(phaseTelemetries);
      const allCitations = uniqueUrls(developerCitations, projectCitations);

      if (projectCandidate.status === 'NOT_FOUND') {
        const resolvedCatalogEvidence = catalogEvidence;
        const catalogCitationUrl = resolvedCatalogEvidence
          ? projectCitations.find((citation) => (
            isUrlWithinAllowedHosts(citation, developer.allowedHosts)
              && catalogCodeMatchesUrl(resolvedCatalogEvidence, citation)
          )) ?? null
          : null;
        if (resolvedCatalogEvidence && catalogCitationUrl) {
          const matchKind = inferCatalogMatchKind(project, resolvedCatalogEvidence);
          const catalogIdentity = resolvedCatalogEvidence.identity;
          const catalogIdentityError = readProjectIdentityError(matchKind, catalogIdentity);
          if (!catalogIdentityError) {
            return {
              status: 'VERIFIED',
              project,
              developerCanonicalUrl: developer.canonicalUrl,
              officialDeveloperName: developer.officialName,
              canonicalUrl: normalizeCandidateUrl(catalogCitationUrl),
              officialProjectName: resolvedCatalogEvidence.officialProjectName,
              matchKind,
              reason: 'Точный URL взят из результатов поиска внутри подтвержденного домена, а название и код проекта независимо подтверждены динамическим каталогом застройщика.',
              errorCode: null,
              citations: allCitations,
              developerCitations,
              projectCitations,
              matchedProjectAlias: catalogIdentity.matchedPlatformProjectAlias
                ?? catalogIdentity.matchedOfficialProjectAlias,
              matchedPlatformProjectAlias: catalogIdentity.matchedPlatformProjectAlias,
              matchedOfficialProjectAlias: catalogIdentity.matchedOfficialProjectAlias,
              matchedDeveloperAlias: catalogIdentity.matchedDeveloperAlias
                ?? developer.matchedAlias,
              matchedAddress: catalogIdentity.matchedAddress,
              contentChecksum: resolvedCatalogEvidence.page.checksum,
              developerCacheHit,
              telemetry,
            };
          }
        }
        return rejectedResult({
          status: 'NOT_FOUND',
          project,
          reason: projectCandidate.reason,
          errorCode: null,
          developerCanonicalUrl: developer.canonicalUrl,
          officialDeveloperName: developer.officialName,
          developerCitations,
          projectCitations,
          citations: allCitations,
          matchedDeveloperAlias: developer.matchedAlias,
          developerCacheHit,
          telemetry,
        });
      }

      let bridgeUrl: string | null = null;
      let projectCandidateErrorCode: string | null = null;
      try {
        bridgeUrl = normalizeCandidateUrl(projectCandidate.canonicalUrl);
      } catch (error) {
        projectCandidateErrorCode = readDiscoveryCode(
          error,
          'ASSISTANT_SOURCE_DISCOVERY_PROJECT_URL_INVALID',
        );
      }
      if (bridgeUrl && !isUrlWithinAllowedHosts(bridgeUrl, developer.allowedHosts)) {
        projectCandidateErrorCode = 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_OUTSIDE_DEVELOPER_DOMAIN';
      }
      if (!projectCandidateErrorCode
        && bridgeUrl
        && !projectCitations.some((citation) => (
          isUrlWithinAllowedHosts(citation, developer.allowedHosts)
        ))) {
        projectCandidateErrorCode = 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_CITATION_MISSING';
      }
      if (!bridgeUrl || projectCandidateErrorCode) {
        if (projectModel === this.model) {
          await requestTerraFallback();
          continue projectValidation;
        }
        return rejectedResult({
          status: 'REJECTED',
          project,
          reason: projectCandidate.reason,
          errorCode: projectCandidateErrorCode
            ?? 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_CITATION_MISSING',
          developerCanonicalUrl: developer.canonicalUrl,
          officialDeveloperName: developer.officialName,
          canonicalUrl: bridgeUrl,
          officialProjectName: projectCandidate.officialProjectName,
          matchKind: projectCandidate.matchKind,
          citations: allCitations,
          developerCitations,
          projectCitations,
          matchedDeveloperAlias: developer.matchedAlias,
          developerCacheHit,
          telemetry,
        });
      }

      let bridgePage: SourceConnectorFetchResult;
      try {
        bridgePage = await this.fetchOfficialSource(
          bridgeUrl,
          'when-empty',
          developer.allowedHosts,
        );
      } catch (error) {
        if (error instanceof SourceConnectorError
          && error.code === 'SOURCE_ANTI_BOT_CHALLENGE') {
          catalogEvidence ??= await this.findDeveloperCatalogEvidence(project, developer);
          const exactCitation = projectCitations.some((citation) => (
            isSameCanonicalPage(citation, bridgeUrl)
          ));
          const catalogCitationUrl = catalogEvidence
            ? projectCitations.find((citation) => (
              isUrlWithinAllowedHosts(citation, developer.allowedHosts)
                && catalogCodeMatchesUrl(catalogEvidence!, citation)
            )) ?? null
            : null;
          const groundedCatalogUrl = catalogEvidence
            && catalogCodeMatchesUrl(catalogEvidence, bridgeUrl)
            ? bridgeUrl
            : catalogCitationUrl;
          if (catalogEvidence
            && groundedCatalogUrl
            && (exactCitation || catalogCitationUrl !== null
              || catalogCodeMatchesUrl(catalogEvidence, bridgeUrl))) {
            const catalogIdentity = catalogEvidence.identity;
            const catalogIdentityError = readProjectIdentityError(
              projectCandidate.matchKind,
              catalogIdentity,
            );
            if (!catalogIdentityError) {
              return {
                status: 'VERIFIED',
                project,
                developerCanonicalUrl: developer.canonicalUrl,
                officialDeveloperName: developer.officialName,
                canonicalUrl: groundedCatalogUrl,
                officialProjectName: projectCandidate.officialProjectName,
                matchKind: projectCandidate.matchKind,
                reason: `${projectCandidate.reason} Точный URL подтвержден поисковым индексом официального домена, а проект — динамическим каталогом застройщика.`,
                errorCode: null,
                citations: allCitations,
                developerCitations,
                projectCitations,
                matchedProjectAlias: catalogIdentity.matchedPlatformProjectAlias
                  ?? catalogIdentity.matchedOfficialProjectAlias,
                matchedPlatformProjectAlias: catalogIdentity.matchedPlatformProjectAlias,
                matchedOfficialProjectAlias: catalogIdentity.matchedOfficialProjectAlias,
                matchedDeveloperAlias: catalogIdentity.matchedDeveloperAlias
                  ?? developer.matchedAlias,
                matchedAddress: catalogIdentity.matchedAddress,
                contentChecksum: catalogEvidence.page.checksum,
                developerCacheHit,
                telemetry,
              };
            }
          }
        }
        if (projectModel === this.model) {
          await requestTerraFallback();
          continue projectValidation;
        }
        return rejectedResult({
          status: 'REJECTED',
          project,
          reason: projectCandidate.reason,
          errorCode: error instanceof SourceConnectorError
            ? error.code
            : 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_FETCH_FAILED',
          developerCanonicalUrl: developer.canonicalUrl,
          officialDeveloperName: developer.officialName,
          canonicalUrl: bridgeUrl,
          officialProjectName: projectCandidate.officialProjectName,
          matchKind: projectCandidate.matchKind,
          citations: allCitations,
          developerCitations,
          projectCitations,
          matchedDeveloperAlias: developer.matchedAlias,
          developerCacheHit,
          telemetry,
        });
      }

      const finalBridgeUrl = normalizeCandidateUrl(bridgePage.finalUrl);
      if (!isUrlWithinAllowedHosts(finalBridgeUrl, developer.allowedHosts)) {
        if (projectModel === this.model) {
          await requestTerraFallback();
          continue projectValidation;
        }
        return rejectedResult({
          status: 'REJECTED',
          project,
          reason: projectCandidate.reason,
          errorCode: 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_OUTSIDE_DEVELOPER_DOMAIN',
          developerCanonicalUrl: developer.canonicalUrl,
          officialDeveloperName: developer.officialName,
          canonicalUrl: finalBridgeUrl,
          officialProjectName: projectCandidate.officialProjectName,
          matchKind: projectCandidate.matchKind,
          citations: allCitations,
          developerCitations,
          projectCitations,
          matchedDeveloperAlias: developer.matchedAlias,
          developerCacheHit,
          telemetry,
        });
      }

      const identity = verifyProjectIdentity(project, projectCandidate.officialProjectName, bridgePage);
      const identityErrorCode = readProjectIdentityError(projectCandidate.matchKind, identity);
      const groundedDeveloperAlias = identity.matchedDeveloperAlias ?? developer.matchedAlias;
      if (identityErrorCode) {
        if (projectModel === this.model) {
          await requestTerraFallback();
          continue projectValidation;
        }
        return rejectedResult({
          status: 'REJECTED',
          project,
          reason: projectCandidate.reason,
          errorCode: identityErrorCode,
          developerCanonicalUrl: developer.canonicalUrl,
          officialDeveloperName: developer.officialName,
          canonicalUrl: finalBridgeUrl,
          officialProjectName: projectCandidate.officialProjectName,
          matchKind: projectCandidate.matchKind,
          citations: allCitations,
          developerCitations,
          projectCitations,
          matchedProjectAlias: identity.matchedPlatformProjectAlias
            ?? identity.matchedOfficialProjectAlias,
          matchedPlatformProjectAlias: identity.matchedPlatformProjectAlias,
          matchedOfficialProjectAlias: identity.matchedOfficialProjectAlias,
          matchedDeveloperAlias: groundedDeveloperAlias,
          matchedAddress: identity.matchedAddress,
          contentChecksum: bridgePage.checksum,
          developerCacheHit,
          telemetry,
        });
      }

      const canonicalPage = await this.findCanonicalProjectPage(
        project,
        projectCandidate.officialProjectName,
        bridgePage,
        developer.allowedHosts,
      );

      return {
        status: 'VERIFIED',
        project,
        developerCanonicalUrl: developer.canonicalUrl,
        officialDeveloperName: developer.officialName,
        canonicalUrl: normalizeCandidateUrl(canonicalPage.finalUrl),
        officialProjectName: projectCandidate.officialProjectName,
        matchKind: projectCandidate.matchKind,
        reason: projectCandidate.reason,
        errorCode: null,
        citations: allCitations,
        developerCitations,
        projectCitations,
        matchedProjectAlias: identity.matchedPlatformProjectAlias
          ?? identity.matchedOfficialProjectAlias,
        matchedPlatformProjectAlias: identity.matchedPlatformProjectAlias,
        matchedOfficialProjectAlias: identity.matchedOfficialProjectAlias,
        matchedDeveloperAlias: groundedDeveloperAlias,
        matchedAddress: identity.matchedAddress,
        contentChecksum: canonicalPage.checksum,
        developerCacheHit,
        telemetry,
      };
    }
  }

  private async discoverDeveloper(
    project: AssistantSourceDiscoveryProject,
  ): Promise<DeveloperResolutionSuccess | DeveloperResolutionFailure> {
    const developerProviderResult = await this.requestCandidate('DEVELOPER', project);
    let developerCandidate = parseDeveloperCandidate(developerProviderResult.value);
    const developerPhaseTelemetry = createPhaseTelemetry(
      'DEVELOPER',
      this.model,
      developerProviderResult,
    );
    const developerPhaseTelemetries = [developerPhaseTelemetry];
    let developerCitations = collectCitationUrls(developerProviderResult.value);

    if (developerCandidate.status === 'NOT_FOUND') {
      return {
        status: 'NOT_FOUND',
        reason: developerCandidate.reason,
        errorCode: null,
        developerCanonicalUrl: null,
        officialDeveloperName: null,
        developerCitations,
        telemetry: aggregateTelemetry(developerPhaseTelemetries),
      };
    }

    let developerCandidateUrl: string | null = null;
    let developerCandidateErrorCode: string | null = null;
    let developerAllowedHosts: string[] = [];
    try {
      developerCandidateUrl = normalizeCandidateUrl(developerCandidate.canonicalUrl);
      developerAllowedHosts = relatedHosts(new URL(developerCandidateUrl).hostname);
    } catch (error) {
      developerCandidateErrorCode = readDiscoveryCode(
        error,
        'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_URL_INVALID',
      );
    }
    if (developerCandidateUrl && isBlockedDomain(new URL(developerCandidateUrl).hostname)) {
      developerCandidateErrorCode = 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_DOMAIN_BLOCKED';
    }
    if (developerCandidateUrl) {
      const hasDeveloperPerimeterCitation = developerCitations.some((citation) => (
        isUrlWithinAllowedHosts(citation, developerAllowedHosts)
      ));
      if (!hasDeveloperPerimeterCitation) {
        developerCandidateErrorCode = 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_CITATION_MISSING';
      }
    }
    if (!developerCandidateUrl || developerCandidateErrorCode) {
      return {
        status: 'REJECTED',
        reason: developerCandidate.reason,
        errorCode: developerCandidateErrorCode
          ?? 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_CITATION_MISSING',
        developerCanonicalUrl: developerCandidateUrl,
        officialDeveloperName: developerCandidate.officialDeveloperName,
        developerCitations,
        telemetry: aggregateTelemetry(developerPhaseTelemetries),
      };
    }

    let developerPage: SourceConnectorFetchResult | null = null;
    try {
      developerPage = await this.fetchOfficialSource(
        developerCandidateUrl,
        'when-empty',
        developerAllowedHosts,
      );
    } catch (error) {
      if (error instanceof SourceConnectorError && error.code === 'SOURCE_ANTI_BOT_CHALLENGE') {
        const alternative = await this.findAlternativeDeveloperPage(
          project,
          developerAllowedHosts,
          developerCitations,
        );
        developerPhaseTelemetries.push(alternative.phaseTelemetry);
        developerCitations = alternative.citations;
        if (alternative.page && alternative.canonicalUrl) {
          developerPage = alternative.page;
          developerCandidateUrl = alternative.canonicalUrl;
          if (alternative.candidate.status === 'FOUND') developerCandidate = alternative.candidate;
        }
      }
      if (!developerPage) {
        return {
          status: 'REJECTED',
          reason: developerCandidate.reason,
          errorCode: error instanceof SourceConnectorError
            ? error.code
            : 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_FETCH_FAILED',
          developerCanonicalUrl: developerCandidateUrl,
          officialDeveloperName: developerCandidate.officialDeveloperName,
          developerCitations,
          telemetry: aggregateTelemetry(developerPhaseTelemetries),
        };
      }
    }

    const initialMatchedDeveloperAlias = findDeveloperAlias(project, developerPage);
    if (!initialMatchedDeveloperAlias) {
      return {
        status: 'REJECTED',
        reason: developerCandidate.reason,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_MISMATCH',
        developerCanonicalUrl: normalizeCandidateUrl(developerPage.finalUrl),
        officialDeveloperName: developerCandidate.officialDeveloperName,
        developerCitations,
        telemetry: aggregateTelemetry(developerPhaseTelemetries),
      };
    }
    const linkedDeveloperPages = await this.findLinkedDeveloperPages(
      project,
      developerPage,
      developerAllowedHosts,
    );
    developerAllowedHosts = linkedDeveloperPages.allowedHosts;

    if (isNarrowNonResidentialDeveloperUrl(developerCandidateUrl)) {
      let renderedCandidate: SourceConnectorFetchResult | null = null;
      try {
        renderedCandidate = await this.fetchOfficialSource(
          developerCandidateUrl,
          'always',
          developerAllowedHosts,
        );
      } catch {
        // A narrow page without project evidence is replaced through the bounded alternative search below.
      }
      const linkedCatalog = linkedDeveloperPages.pages.find(({ page }) => (
        findProjectCatalogEvidence(project, page, developerAllowedHosts) !== null
      ));
      if (renderedCandidate && findProjectCatalogEvidence(
        project,
        renderedCandidate,
        developerAllowedHosts,
      )) {
        developerPage = renderedCandidate;
        this.developerCatalogCache.set(developerCandidateUrl, Promise.resolve(renderedCandidate));
        this.renderedDeveloperCatalogUrls.add(developerCandidateUrl);
      } else if (linkedCatalog) {
        developerPage = linkedCatalog.page;
        developerCandidateUrl = linkedCatalog.canonicalUrl;
      } else {
        const alternative = await this.findAlternativeDeveloperPage(
          project,
          developerAllowedHosts,
          developerCitations,
        );
        developerPhaseTelemetries.push(alternative.phaseTelemetry);
        developerCitations = alternative.citations;
        if (alternative.page && alternative.canonicalUrl) {
          developerPage = alternative.page;
          developerCandidateUrl = alternative.canonicalUrl;
          if (alternative.candidate.status === 'FOUND') developerCandidate = alternative.candidate;
        }
      }
    }

    const developerCanonicalUrl = normalizeCandidateUrl(developerPage.finalUrl);
    if (isBlockedDomain(new URL(developerCanonicalUrl).hostname)) {
      return {
        status: 'REJECTED',
        reason: developerCandidate.reason,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_DOMAIN_BLOCKED',
        developerCanonicalUrl,
        officialDeveloperName: developerCandidate.officialDeveloperName,
        developerCitations,
        telemetry: aggregateTelemetry(developerPhaseTelemetries),
      };
    }
    const matchedDeveloperAlias = findDeveloperAlias(project, developerPage);
    if (!matchedDeveloperAlias) {
      return {
        status: 'REJECTED',
        reason: developerCandidate.reason,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_MISMATCH',
        developerCanonicalUrl,
        officialDeveloperName: developerCandidate.officialDeveloperName,
        developerCitations,
        telemetry: aggregateTelemetry(developerPhaseTelemetries),
      };
    }

    const developer: VerifiedDeveloper = {
      canonicalUrl: developerCanonicalUrl,
      allowedHosts: developerAllowedHosts,
      catalogUrls: uniqueUrls(
        [developerCanonicalUrl],
        linkedDeveloperPages.pages.map(({ canonicalUrl }) => canonicalUrl),
      ),
      officialName: developerCandidate.officialDeveloperName,
      matchedAlias: matchedDeveloperAlias,
      citations: developerCitations,
    };
    this.developerCatalogCache.set(developer.canonicalUrl, Promise.resolve(developerPage));
    return {
      status: 'VERIFIED',
      developer,
      phaseTelemetries: developerPhaseTelemetries,
      cacheHit: false,
    };
  }

  private async resolveDeveloper(
    project: AssistantSourceDiscoveryProject,
    registrySources: readonly AssistantSourceDiscoveryRegistrySource[],
  ): Promise<DeveloperResolutionSuccess | DeveloperResolutionFailure> {
    const registeredSources = findRegisteredDeveloperSources(project, registrySources);
    const registeredSourceKey = registeredSources.map(({ source }) => source.id).join(',');
    const key = `${createDeveloperCacheKey(project)}\u0000${registeredSourceKey}`;
    const now = Date.now();
    const existing = this.developerCache.get(key);
    if (existing && existing.expiresAt > now) {
      const cached = await existing.promise;
      if (cached.status !== 'VERIFIED') {
        this.developerCache.delete(key);
        return cached;
      }
      return { ...cached, phaseTelemetries: [], cacheHit: true };
    }
    if (existing) this.developerCache.delete(key);
    if (this.developerCache.size >= maximumDeveloperCacheEntries) {
      const oldestKey = this.developerCache.keys().next().value as string | undefined;
      if (oldestKey) this.developerCache.delete(oldestKey);
    }
    const promise = registeredSources.length > 0
      ? this.resolveRegisteredDeveloper(project, registeredSources)
      : this.discoverDeveloper(project);
    this.developerCache.set(key, { expiresAt: now + developerCacheTtlMs, promise });
    try {
      const resolved = await promise;
      if (resolved.status !== 'VERIFIED') this.developerCache.delete(key);
      return resolved;
    } catch (error) {
      this.developerCache.delete(key);
      throw error;
    }
  }

  private async resolveRegisteredDeveloper(
    project: AssistantSourceDiscoveryProject,
    registeredSources: ReturnType<typeof findRegisteredDeveloperSources>,
  ): Promise<DeveloperResolutionSuccess | DeveloperResolutionFailure> {
    const selectedSources: typeof registeredSources = [];
    const selectedAllowedHosts = new Set<string>();
    for (const registered of registeredSources) {
      const expandedHosts = new Set([...selectedAllowedHosts, ...registered.allowedHosts]);
      if (expandedHosts.size > 10) continue;
      registered.allowedHosts.forEach((host) => selectedAllowedHosts.add(host));
      selectedSources.push(registered);
    }
    let allowedHosts = [...selectedAllowedHosts];
    const catalogUrls = new Set(selectedSources.map(({ canonicalUrl }) => canonicalUrl));
    for (const registered of selectedSources) {
      try {
        const page = await this.fetchOfficialSource(
          registered.canonicalUrl,
          'always',
          registered.allowedHosts,
        );
        const canonicalUrl = normalizeCandidateUrl(page.finalUrl);
        const matchedAlias = findDeveloperAlias(project, page);
        if (!matchedAlias) continue;
        catalogUrls.add(canonicalUrl);
        this.developerCatalogCache.set(canonicalUrl, Promise.resolve(page));
        this.renderedDeveloperCatalogUrls.add(canonicalUrl);
        const linkedDeveloperPages = await this.findLinkedDeveloperPages(
          project,
          page,
          allowedHosts,
        );
        allowedHosts = linkedDeveloperPages.allowedHosts;
        linkedDeveloperPages.pages.forEach(({ canonicalUrl: linkedCanonicalUrl }) => {
          catalogUrls.add(linkedCanonicalUrl);
        });
      } catch {
        // Try the next independently registered developer source.
      }
    }
    return {
      status: 'VERIFIED',
      developer: {
        canonicalUrl: selectedSources[0]!.canonicalUrl,
        allowedHosts,
        catalogUrls: [...catalogUrls],
        officialName: project.developerName,
        matchedAlias: project.developerName,
        citations: [],
      },
      phaseTelemetries: [],
      cacheHit: false,
    };
  }

  private async requestCandidate(
    phase: AssistantSourceDiscoveryPhase,
    project: AssistantSourceDiscoveryProject,
    developer?: VerifiedDeveloper,
    projectEvidence?: VerifiedProjectCatalogEvidence,
    developerAlternativeHosts?: readonly string[],
    model = this.model,
  ) {
    const projectCalls = this.projectCallCounts.get(project.projectKey) ?? 0;
    if (projectCalls >= 3 || this.providerCallCount >= this.maximumProviderCalls) {
      throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_CALL_BUDGET_EXHAUSTED');
    }
    const isFallback = model === ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL;
    if (isFallback) {
      if (this.terraFallbackCount >= this.maximumTerraFallbacks) {
        throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_TERRA_BUDGET_EXHAUSTED');
      }
    }
    const requestBody = phase === 'DEVELOPER'
      ? createDeveloperDiscoveryRequestBody(model, project, developerAlternativeHosts)
      : createProjectDiscoveryRequestBody(
        model,
        project,
        requireDeveloper(developer),
        projectEvidence,
      );
    this.projectCallCounts.set(project.projectKey, projectCalls + 1);
    this.providerCallCount += 1;
    if (isFallback) this.terraFallbackCount += 1;
    let aiReservation: AssistantAiUsageReservation | null;
    try {
      aiReservation = await this.reserveAiUsage(
        phase,
        model,
        requestBody,
        isFallback,
      );
    } catch (error) {
      this.projectCallCounts.set(project.projectKey, projectCalls);
      this.providerCallCount -= 1;
      if (isFallback) this.terraFallbackCount -= 1;
      throw error;
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const clientRequestId = `assistant-source-${phase.toLocaleLowerCase('en-US')}-${Date.now()}`
      .slice(0, 160);
    let timeout: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_TIMEOUT'));
      }, this.timeoutMs);
      timeout.unref();
    });
    let providerResult: Awaited<ReturnType<AssistantSourceDiscoveryService['fetchCandidate']>>;
    try {
      providerResult = await Promise.race([
        this.fetchCandidate(
          requestBody,
          clientRequestId,
          controller.signal,
        ),
        deadline,
      ]);
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      const providerError = error instanceof AssistantSourceDiscoveryError
        ? error
        : new AssistantSourceDiscoveryError(controller.signal.aborted
          ? 'ASSISTANT_SOURCE_DISCOVERY_TIMEOUT'
          : 'ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED');
      const phaseTelemetry = createFailedPhaseTelemetry(phase, model, providerError);
      try {
        await this.settleAiUsage(
          aiReservation,
          model,
          'PROVIDER_ERROR',
          providerError.code,
          null,
          Date.now() - startedAt,
        );
      } catch (settlementError) {
        throw new AssistantSourceDiscoveryError(
          readDiscoveryCode(
            settlementError,
            'ASSISTANT_SOURCE_DISCOVERY_USAGE_SETTLEMENT_FAILED',
          ),
          providerError.requestId,
          providerError.responseId,
          providerError.httpStatus,
          phaseTelemetry,
        );
      }
      throw new AssistantSourceDiscoveryError(
        providerError.code,
        providerError.requestId,
        providerError.responseId,
        providerError.httpStatus,
        phaseTelemetry,
      );
    }
    const phaseTelemetry = createPhaseTelemetry(phase, model, providerResult);
    try {
      await this.settleAiUsage(aiReservation, model, 'PROVIDER_SUCCESS', null, {
        phase,
        providerResult,
      }, Date.now() - startedAt);
    } catch (error) {
      throw new AssistantSourceDiscoveryError(
        readDiscoveryCode(error, 'ASSISTANT_SOURCE_DISCOVERY_USAGE_SETTLEMENT_FAILED'),
        providerResult.requestId,
        providerResult.responseId,
        providerResult.httpStatus,
        phaseTelemetry,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return providerResult;
  }

  private async fetchCandidate(
    requestBody: ReturnType<typeof createDeveloperDiscoveryRequestBody>
      | ReturnType<typeof createProjectDiscoveryRequestBody>,
    clientRequestId: string,
    signal: AbortSignal,
  ) {
    const response = await this.fetchImplementation(`${this.baseUrl.replace(/\/$/u, '')}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Client-Request-Id': clientRequestId,
      },
      body: JSON.stringify(requestBody),
      signal,
    });
    const requestId = readOptionalString(response.headers.get('x-request-id'), 160);
    const body = await readBoundedJson(response, maximumProviderResponseBytes);
    const responseId = isRecord(body) ? readOptionalString(body.id, 160) : null;
    if (!response.ok) {
      throw new AssistantSourceDiscoveryError(
        `ASSISTANT_SOURCE_DISCOVERY_HTTP_${response.status}`,
        requestId,
        responseId,
        response.status,
      );
    }
    if (!isRecord(body)) {
      throw new AssistantSourceDiscoveryError(
        'ASSISTANT_SOURCE_DISCOVERY_RESPONSE_INVALID',
        requestId,
        responseId,
        response.status,
      );
    }
    return { value: body, requestId, responseId, httpStatus: response.status };
  }

  private async reserveAiUsage(
    phase: AssistantSourceDiscoveryPhase,
    model: string,
    requestBody: ReturnType<typeof createDeveloperDiscoveryRequestBody>
      | ReturnType<typeof createProjectDiscoveryRequestBody>,
    isFallback: boolean,
  ) {
    if (!this.live) return null;
    const estimated = estimateAssistantAiCallCost({
      model,
      serviceTier: ASSISTANT_AI_SERVICE_TIER,
      requestBytes: Buffer.byteLength(JSON.stringify(requestBody), 'utf8'),
      maxOutputTokens: 1_600,
      maxWebSearchCalls: 1,
    });
    if (estimated.status !== 'PRICED'
      || estimated.estimatedUsd === null
      || estimated.estimatedUsdUnits === null) {
      throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_COST_UNPRICED');
    }
    const maximumRunCostUnits = parseAssistantUsd(this.serviceOptions!.maximumRunCostUsd);
    if (this.runReservedCostUnits + estimated.estimatedUsdUnits > maximumRunCostUnits) {
      throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_COST_BUDGET_EXHAUSTED');
    }
    const attemptOrdinal = this.nextAttemptOrdinal;
    this.nextAttemptOrdinal += 1;
    this.runReservedCostUnits += estimated.estimatedUsdUnits;
    try {
      return await this.serviceOptions!.usageBudgets.reserve({
        provider: 'openai',
        model,
        operation: 'SOURCE_DISCOVERY',
        operationRunId: this.serviceOptions!.operationRunId,
        executionId: this.serviceOptions!.executionId,
        attemptOrdinal,
        dailyBudgetUsd: this.serviceOptions!.dailyBudgetUsd,
        reservedCostUsd: estimated.estimatedUsd,
        serviceTier: ASSISTANT_AI_SERVICE_TIER,
        reasoningEffort: 'medium',
        promptVersion: ASSISTANT_SOURCE_DISCOVERY_PROMPT_VERSION,
        validatorVersion: ASSISTANT_SOURCE_DISCOVERY_VALIDATOR_VERSION,
        isFallback,
        providerTimeoutMs: this.timeoutMs,
      });
    } catch (error) {
      this.runReservedCostUnits -= estimated.estimatedUsdUnits;
      throw error;
    }
  }

  private async settleAiUsage(
    reservation: AssistantAiUsageReservation | null,
    requestedModel: string,
    outcome: string,
    errorCode: string | null,
    success: {
      phase: AssistantSourceDiscoveryPhase;
      providerResult: Awaited<ReturnType<AssistantSourceDiscoveryService['fetchCandidate']>>;
    } | null,
    durationMs: number,
  ) {
    if (!reservation) return;
    const telemetry = success
      ? createPhaseTelemetry(success.phase, requestedModel, success.providerResult)
      : null;
    await this.serviceOptions!.usageBudgets.settle({
      reservation,
      actualModel: telemetry?.model ?? requestedModel,
      outcome,
      errorCode,
      inputTokens: telemetry?.inputTokens ?? null,
      cachedInputTokens: telemetry?.cachedInputTokens ?? null,
      cacheWriteInputTokens: telemetry?.cacheWriteInputTokens ?? null,
      outputTokens: telemetry?.outputTokens ?? null,
      reasoningTokens: telemetry?.reasoningTokens ?? null,
      totalTokens: telemetry?.totalTokens ?? null,
      webSearchCalls: telemetry?.webSearchCalls ?? null,
      durationMs,
    });
  }

  private async fetchOfficialSource(
    canonicalUrl: string,
    browserRenderMode: 'when-empty' | 'always' = 'when-empty',
    allowedHosts?: readonly string[],
  ) {
    const hostname = normalizeHostname(new URL(canonicalUrl).hostname);
    const trustedHosts = [...new Set((allowedHosts ?? relatedHosts(hostname)).map(normalizeHostname))];
    if (trustedHosts.length === 0 || trustedHosts.length > 10
      || !isUrlWithinAllowedHosts(canonicalUrl, trustedHosts)) {
      throw new SourceConnectorError('SOURCE_REDIRECT_HOST_NOT_ALLOWED', false);
    }
    const page = await this.sourceConnector.fetch({
      id: randomUUID(),
      canonicalUrl,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: {
        allowedHosts: [...trustedHosts],
        browserRenderMode,
      },
    });
    if (!isUrlWithinAllowedHosts(page.finalUrl, trustedHosts)
      || page.redirects.some((redirect) => !isUrlWithinAllowedHosts(redirect, trustedHosts))) {
      throw new SourceConnectorError('SOURCE_REDIRECT_HOST_NOT_ALLOWED', false);
    }
    return page;
  }

  private async findDeveloperCatalogEvidence(
    project: AssistantSourceDiscoveryProject,
    developer: VerifiedDeveloper,
  ): Promise<VerifiedProjectCatalogEvidence | null> {
    for (const catalogUrl of uniqueUrls([developer.canonicalUrl], developer.catalogUrls)) {
      let page = await (this.developerCatalogCache.get(catalogUrl) ?? Promise.resolve(null));
      let evidence = page
        ? findProjectCatalogEvidence(project, page, developer.allowedHosts)
        : null;
      if (evidence) return { ...evidence, page: page! };
      if (this.renderedDeveloperCatalogUrls.has(catalogUrl)) continue;
      const catalogPromise = this.fetchOfficialSource(
        catalogUrl,
        'always',
        developer.allowedHosts,
      ).catch(() => null);
      this.developerCatalogCache.set(catalogUrl, catalogPromise);
      this.renderedDeveloperCatalogUrls.add(catalogUrl);
      page = await catalogPromise;
      if (!page) continue;
      evidence = findProjectCatalogEvidence(project, page, developer.allowedHosts);
      if (evidence) return { ...evidence, page };
    }
    return null;
  }

  private async findLinkedDeveloperPages(
    project: AssistantSourceDiscoveryProject,
    page: SourceConnectorFetchResult,
    currentAllowedHosts: readonly string[],
  ) {
    const allowedHosts = [...currentAllowedHosts];
    const pages: Array<{ canonicalUrl: string; page: SourceConnectorFetchResult }> = [];
    for (const linked of extractLinkedOfficialDeveloperUrls(page, currentAllowedHosts)) {
      const linkedUrl = linked.url;
      const linkedHosts = relatedHosts(new URL(linkedUrl).hostname);
      const usesExistingTrust = isUrlWithinAllowedHosts(linkedUrl, allowedHosts);
      const expandedHosts = usesExistingTrust
        ? [...allowedHosts]
        : [...new Set([...allowedHosts, ...linkedHosts])];
      if (expandedHosts.length > 10) continue;
      const fetchAllowedHosts = usesExistingTrust
        ? allowedHosts
        : linkedHosts;
      try {
        const linkedPage = await this.fetchOfficialSource(linkedUrl, 'always', fetchAllowedHosts);
        if (!findDeveloperAlias(project, linkedPage)) continue;
        allowedHosts.splice(0, allowedHosts.length, ...expandedHosts);
        const canonicalUrl = normalizeCandidateUrl(linkedPage.finalUrl);
        pages.push({ canonicalUrl, page: linkedPage });
        this.developerCatalogCache.set(canonicalUrl, Promise.resolve(linkedPage));
        this.renderedDeveloperCatalogUrls.add(canonicalUrl);
      } catch {
        if (linked.trustWithoutFetch) {
          allowedHosts.splice(0, allowedHosts.length, ...expandedHosts);
        }
      }
    }
    return { allowedHosts, pages };
  }

  private async findAlternativeDeveloperPage(
    project: AssistantSourceDiscoveryProject,
    allowedHosts: readonly string[],
    existingCitations: string[],
  ): Promise<AlternativeDeveloperPage> {
    const providerResult = await this.requestCandidate(
      'DEVELOPER',
      project,
      undefined,
      undefined,
      allowedHosts,
    );
    const candidate = parseDeveloperCandidate(providerResult.value);
    const phaseTelemetry = createPhaseTelemetry('DEVELOPER', this.model, providerResult);
    const citations = uniqueUrls(existingCitations, collectCitationUrls(providerResult.value));
    let proposedUrl: string | null = null;
    if (candidate.status === 'FOUND') {
      try {
        proposedUrl = normalizeCandidateUrl(candidate.canonicalUrl);
      } catch {
        // Search citations remain usable even when the structured candidate URL is malformed.
      }
    }
    const citedAlternatives = citations.filter((citation) => (
      isUrlWithinAllowedHosts(citation, allowedHosts)
      && !isBlockedDomain(new URL(citation).hostname)
    ));
    const orderedAlternatives = uniqueUrls(
      proposedUrl && citedAlternatives.some((citation) => isSameCanonicalPage(citation, proposedUrl!))
        ? [proposedUrl]
        : [],
      citedAlternatives,
    ).slice(0, 6);
    let firstVerified: { url: string; page: SourceConnectorFetchResult } | null = null;
    let catalogVerified: { url: string; page: SourceConnectorFetchResult } | null = null;
    let broadCatalogVerified: { url: string; page: SourceConnectorFetchResult } | null = null;
    for (const canonicalUrl of orderedAlternatives) {
      try {
        const page = await this.fetchOfficialSource(canonicalUrl, 'always', allowedHosts);
        if (!findDeveloperAlias(project, page)) continue;
        firstVerified ??= { url: canonicalUrl, page };
        if (findProjectCatalogEvidence(project, page, allowedHosts)) {
          catalogVerified ??= { url: canonicalUrl, page };
          if (hasMultipleProjectCatalogEntries(page)) {
            broadCatalogVerified = { url: canonicalUrl, page };
            break;
          }
        }
      } catch {
        // Anti-bot, unavailable and unrelated cited pages are skipped within the bounded perimeter.
      }
    }
    const selected = broadCatalogVerified ?? catalogVerified ?? firstVerified;
    if ((broadCatalogVerified || catalogVerified) && selected) {
      this.developerCatalogCache.set(selected.url, Promise.resolve(selected.page));
      this.renderedDeveloperCatalogUrls.add(selected.url);
    }
    return {
      page: selected?.page ?? null,
      canonicalUrl: selected?.url ?? null,
      candidate,
      citations,
      phaseTelemetry,
    };
  }

  private async findProjectByKnownPaths(
    project: AssistantSourceDiscoveryProject,
    developer: VerifiedDeveloper,
    catalogEvidence: VerifiedProjectCatalogEvidence | null,
  ) {
    const projectIdentifiers = catalogEvidence?.officialProjectCode
      ? [catalogEvidence.officialProjectCode, project.projectKey]
      : [project.projectKey];
    const catalogProjectUrls = catalogEvidence?.officialProjectUrl
      && isUrlWithinAllowedHosts(catalogEvidence.officialProjectUrl, developer.allowedHosts)
      ? [catalogEvidence.officialProjectUrl]
      : [];
    const candidateUrls = uniqueUrls(
      catalogProjectUrls,
      buildKnownProjectUrls(projectIdentifiers, developer.allowedHosts),
    ).slice(0, 20);
    for (const candidateUrl of candidateUrls) {
      try {
        const page = await this.fetchOfficialSource(
          candidateUrl,
          'when-empty',
          developer.allowedHosts,
        );
        const finalUrl = normalizeCandidateUrl(page.finalUrl);
        if (!isUrlWithinAllowedHosts(finalUrl, developer.allowedHosts)) continue;
        const officialProjectName = catalogEvidence?.officialProjectName
          ?? inferOfficialProjectNameFromPage(project, page)
          ?? project.title;
        const identity = verifyProjectIdentity(
          project,
          officialProjectName,
          page,
          { includeFinalUrl: false },
        );
        if (!identity.matchedPlatformProjectAlias || !identity.matchedOfficialProjectAlias) continue;
        return { page, identity, officialProjectName };
      } catch {
        // Missing and protected guessed paths are expected; the bounded candidate list is exhausted safely.
      }
    }
    return null;
  }

  private async findCanonicalProjectPage(
    project: AssistantSourceDiscoveryProject,
    officialProjectName: string,
    bridgePage: SourceConnectorFetchResult,
    developerAllowedHosts: readonly string[],
  ) {
    for (const externalUrl of extractOfficialProjectLinks(
      bridgePage,
      developerAllowedHosts,
    )) {
      try {
        const fetchedExternalPage = await this.fetchOfficialSource(
          externalUrl,
          'when-empty',
          relatedHosts(new URL(externalUrl).hostname),
        );
        const finalExternalUrl = normalizeCandidateUrl(fetchedExternalPage.finalUrl);
        if (isBlockedDomain(new URL(finalExternalUrl).hostname)) continue;
        const externalIdentity = verifyProjectIdentity(
          project,
          officialProjectName,
          fetchedExternalPage,
        );
        if (!externalIdentity.matchedPlatformProjectAlias
          && !externalIdentity.matchedOfficialProjectAlias) continue;
        return fetchedExternalPage;
      } catch {
        // The verified developer bridge remains canonical if its optional external link is unavailable.
      }
    }
    return bridgePage;
  }
}

function createFailedPhaseTelemetry(
  phase: AssistantSourceDiscoveryPhase,
  model: string,
  error: AssistantSourceDiscoveryError,
): AssistantSourceDiscoveryPhaseTelemetry {
  return {
    phase,
    provider: 'openai',
    model,
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
  };
}

function registeredProjectSourceResult(
  project: AssistantSourceDiscoveryProject,
  registered: NonNullable<ReturnType<typeof findRegisteredProjectSource>>,
  model: string,
): AssistantSourceDiscoveryResult {
  return {
    status: 'VERIFIED',
    project,
    developerCanonicalUrl: null,
    officialDeveloperName: project.developerName,
    canonicalUrl: registered.canonicalUrl,
    officialProjectName: project.title,
    matchKind: 'EXACT',
    reason: 'Использован существующий активный и проиндексированный официальный источник проекта.',
    errorCode: null,
    citations: [],
    developerCitations: [],
    projectCitations: [],
    matchedProjectAlias: null,
    matchedPlatformProjectAlias: null,
    matchedOfficialProjectAlias: null,
    matchedDeveloperAlias: null,
    matchedAddress: false,
    contentChecksum: registered.source.latestRevision!.checksum,
    developerCacheHit: false,
    telemetry: telemetryFromPhases([], model),
  };
}

function parseProject(value: AssistantSourceDiscoveryProject): AssistantSourceDiscoveryProject {
  if (!isRecord(value)) throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_PROJECT_INVALID');
  return {
    projectKey: readBoundedString(value.projectKey, 120, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_INVALID'),
    title: readBoundedString(value.title, 300, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_INVALID'),
    developerKey: readBoundedString(value.developerKey, 120, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_INVALID'),
    developerName: readBoundedString(value.developerName, 300, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_INVALID'),
    address: value.address === undefined || value.address === null || value.address === ''
      ? null
      : readBoundedString(value.address, 500, 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_INVALID'),
  };
}

function telemetryFromPhases(
  phases: AssistantSourceDiscoveryPhaseTelemetry[],
  model: string,
): AssistantSourceDiscoveryTelemetry {
  if (phases.length > 0) return aggregateTelemetry(phases);
  return {
    provider: 'openai',
    model,
    requestId: null,
    responseId: null,
    httpStatus: 200,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    webSearchCalls: 0,
    phases: [],
  };
}

function requireDeveloper(value: VerifiedDeveloper | undefined) {
  if (!value) throw new AssistantSourceDiscoveryError('ASSISTANT_SOURCE_DISCOVERY_DEVELOPER_REQUIRED');
  return value;
}

function inferCatalogMatchKind(
  project: AssistantSourceDiscoveryProject,
  evidence: AssistantSourceCatalogProjectEvidence,
): AssistantSourceDiscoveryMatchKind {
  const matchedAlias = evidence.identity.matchedPlatformProjectAlias
    ?? evidence.identity.matchedOfficialProjectAlias;
  return matchedAlias
    && /[a-z]/u.test(matchedAlias)
    && /\p{Script=Cyrillic}/u.test(project.title)
    ? 'TRANSLITERATION'
    : 'EXACT';
}

function inferKnownPathMatchKind(
  project: AssistantSourceDiscoveryProject,
  matchedProjectAlias: string | null,
): AssistantSourceDiscoveryMatchKind {
  const normalizedTitle = project.title
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const normalizedAlias = matchedProjectAlias
    ?.normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() ?? '';
  return normalizedAlias
    && !normalizedTitle.includes(normalizedAlias)
    && /[a-z]/u.test(normalizedAlias)
    && /\p{Script=Cyrillic}/u.test(normalizedTitle)
    ? 'TRANSLITERATION'
    : 'EXACT';
}

function rejectedResult(options: {
  status: 'NOT_FOUND' | 'REJECTED';
  project: AssistantSourceDiscoveryProject;
  reason: string;
  errorCode: string | null;
  telemetry: AssistantSourceDiscoveryTelemetry;
  developerCanonicalUrl?: string | null;
  officialDeveloperName?: string | null;
  canonicalUrl?: string | null;
  officialProjectName?: string | null;
  matchKind?: AssistantSourceDiscoveryMatchKind | null;
  citations?: string[];
  developerCitations?: string[];
  projectCitations?: string[];
  matchedProjectAlias?: string | null;
  matchedPlatformProjectAlias?: string | null;
  matchedOfficialProjectAlias?: string | null;
  matchedDeveloperAlias?: string | null;
  matchedAddress?: boolean;
  contentChecksum?: string | null;
  developerCacheHit?: boolean;
}): AssistantSourceDiscoveryResult {
  return {
    status: options.status,
    project: options.project,
    developerCanonicalUrl: options.developerCanonicalUrl ?? null,
    officialDeveloperName: options.officialDeveloperName ?? null,
    canonicalUrl: options.canonicalUrl ?? null,
    officialProjectName: options.officialProjectName ?? null,
    matchKind: options.matchKind ?? null,
    reason: options.reason,
    errorCode: options.errorCode,
    citations: options.citations ?? options.developerCitations ?? [],
    developerCitations: options.developerCitations ?? [],
    projectCitations: options.projectCitations ?? [],
    matchedProjectAlias: options.matchedProjectAlias ?? null,
    matchedPlatformProjectAlias: options.matchedPlatformProjectAlias ?? null,
    matchedOfficialProjectAlias: options.matchedOfficialProjectAlias ?? null,
    matchedDeveloperAlias: options.matchedDeveloperAlias ?? null,
    matchedAddress: options.matchedAddress ?? false,
    contentChecksum: options.contentChecksum ?? null,
    developerCacheHit: options.developerCacheHit ?? false,
    telemetry: options.telemetry,
  };
}
