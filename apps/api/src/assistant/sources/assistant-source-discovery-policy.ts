import {
  normalizeCandidateUrl,
  type AssistantSourceCatalogProjectEvidence,
} from './assistant-source-discovery-identity';

export const ASSISTANT_SOURCE_DISCOVERY_MODEL = 'gpt-5.6-luna';
export const ASSISTANT_SOURCE_DISCOVERY_FALLBACK_MODEL = 'gpt-5.6-terra';
export const maximumSourceDiscoveryProviderCalls = 35;
export const maximumSourceDiscoveryCallsPerProject = 3;
export const maximumSourceDiscoveryTerraFallbacks = 2;

export type AssistantSourceDiscoveryModelRole = 'LUNA' | 'TERRA';

type AssistantSourceDiscoveryCallReceipt = {
  projectKey: string;
  isFallback: boolean;
  reservedCostUnits: bigint;
  active: boolean;
};

type AssistantSourceDiscoveryCallAuthorization =
  | { allowed: true; receipt: AssistantSourceDiscoveryCallReceipt }
  | { allowed: false; errorCode: string };

export class AssistantSourceDiscoveryCallPolicy {
  private providerCallCount = 0;
  private terraFallbackCount = 0;
  private runReservedCostUnits = 0n;
  private readonly projectCallCounts = new Map<string, number>();

  constructor(
    private readonly maximumProviderCalls: number,
    private readonly maximumTerraFallbacks: number,
  ) {}

  async withProject<Value>(projectKey: string, operation: () => Promise<Value>): Promise<Value> {
    this.projectCallCounts.set(projectKey, 0);
    try {
      return await operation();
    } finally {
      this.projectCallCounts.delete(projectKey);
    }
  }

  authorizeProviderCall(input: {
    projectKey: string;
    isFallback: boolean;
    reservedCostUnits: bigint;
    maximumRunCostUnits: bigint | null;
  }): AssistantSourceDiscoveryCallAuthorization {
    const projectCalls = this.projectCallCounts.get(input.projectKey);
    if (projectCalls === undefined) {
      return {
        allowed: false,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_CALL_STATE_INVALID',
      };
    }
    if (projectCalls >= maximumSourceDiscoveryCallsPerProject) {
      return {
        allowed: false,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_PROJECT_CALL_BUDGET_EXHAUSTED',
      };
    }
    if (this.providerCallCount >= this.maximumProviderCalls) {
      return {
        allowed: false,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_BATCH_CALL_BUDGET_EXHAUSTED',
      };
    }
    if (input.isFallback && this.terraFallbackCount >= this.maximumTerraFallbacks) {
      return {
        allowed: false,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_TERRA_BUDGET_EXHAUSTED',
      };
    }
    if (input.maximumRunCostUnits !== null
      && this.runReservedCostUnits + input.reservedCostUnits > input.maximumRunCostUnits) {
      return {
        allowed: false,
        errorCode: 'ASSISTANT_SOURCE_DISCOVERY_COST_BUDGET_EXHAUSTED',
      };
    }

    const receipt: AssistantSourceDiscoveryCallReceipt = {
      projectKey: input.projectKey,
      isFallback: input.isFallback,
      reservedCostUnits: input.reservedCostUnits,
      active: true,
    };
    this.projectCallCounts.set(input.projectKey, projectCalls + 1);
    this.providerCallCount += 1;
    if (input.isFallback) this.terraFallbackCount += 1;
    this.runReservedCostUnits += input.reservedCostUnits;
    return { allowed: true, receipt };
  }

  rollbackProviderCall(receipt: AssistantSourceDiscoveryCallReceipt) {
    if (!receipt.active) return;
    receipt.active = false;
    const projectCalls = this.projectCallCounts.get(receipt.projectKey);
    if (projectCalls !== undefined) {
      this.projectCallCounts.set(receipt.projectKey, Math.max(0, projectCalls - 1));
    }
    this.providerCallCount = Math.max(0, this.providerCallCount - 1);
    if (receipt.isFallback) {
      this.terraFallbackCount = Math.max(0, this.terraFallbackCount - 1);
    }
    this.runReservedCostUnits -= receipt.reservedCostUnits;
  }
}

export type AssistantSourceDiscoveryTransitionInput =
  | {
    outcome: 'PROVIDER_ERROR';
    model: AssistantSourceDiscoveryModelRole;
    errorCode: string;
    retryCount: number;
  }
  | {
    outcome: 'SOURCE_CONNECTOR_ERROR';
    errorCode: string;
    retryCount: number;
  }
  | {
    outcome: 'MALFORMED_OUTPUT'
      | 'LOCAL_VALIDATION_REJECTED'
      | 'NOT_FOUND_WITH_CATALOG_EVIDENCE'
      | 'NOT_FOUND'
      | 'ACCEPTED';
    model: AssistantSourceDiscoveryModelRole;
  };

export type AssistantSourceDiscoveryTransition =
  | 'ACCEPT'
  | 'FALLBACK_TERRA'
  | 'RETRY_CONNECTOR'
  | 'RETRY_LUNA'
  | 'STOP';

export function decideAssistantSourceDiscoveryTransition(
  input: AssistantSourceDiscoveryTransitionInput,
): AssistantSourceDiscoveryTransition {
  if (input.outcome === 'PROVIDER_ERROR') {
    return input.model === 'LUNA'
      && input.retryCount < 1
      && isRetryableLunaProviderError(input.errorCode)
      ? 'RETRY_LUNA'
      : 'STOP';
  }
  if (input.outcome === 'SOURCE_CONNECTOR_ERROR') {
    return input.retryCount < 1 && isRetryableSourceConnectorError(input.errorCode)
      ? 'RETRY_CONNECTOR'
      : 'STOP';
  }
  if (input.outcome === 'ACCEPTED') return 'ACCEPT';
  if ((input.outcome === 'LOCAL_VALIDATION_REJECTED'
      || input.outcome === 'NOT_FOUND_WITH_CATALOG_EVIDENCE')
    && input.model === 'LUNA') {
    return 'FALLBACK_TERRA';
  }
  return 'STOP';
}

export function assistantSourceDiscoveryModelRole(
  model: string,
  lunaModel: string,
): AssistantSourceDiscoveryModelRole {
  return model === lunaModel ? 'LUNA' : 'TERRA';
}

export function createDeveloperCacheKey(project: { developerKey: string; developerName: string }) {
  return `${project.developerKey}\u0000${project.developerName}`
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function uniqueUrls(...groups: string[][]) {
  return [...new Set(groups.flat())].slice(0, 80);
}

export function isSameCanonicalPage(left: string, right: string) {
  try {
    const normalize = (value: string) => {
      const url = new URL(normalizeCandidateUrl(value));
      url.search = '';
      url.pathname = url.pathname.replace(/\/+$/gu, '') || '/';
      return url.toString();
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

export function catalogCodeMatchesUrl(
  evidence: AssistantSourceCatalogProjectEvidence,
  value: string,
) {
  if (!evidence.officialProjectCode) return false;
  try {
    const rawSegments = new URL(normalizeCandidateUrl(value)).pathname
      .toLocaleLowerCase('en-US')
      .split('/')
      .filter(Boolean);
    if (rawSegments.some((segment) => (
      /(?:^|[-_])(?:boxrooms?|commercial|mortgage|news|offices?|parkings?|promotions?|storages?)(?:$|[-_])/u
        .test(segment)
    ))) return false;
    const segments = rawSegments
      .flatMap((segment) => [segment, segment.replace(/^zhk-/u, '')]);
    const codes = new Set([
      evidence.officialProjectCode,
      evidence.officialProjectCode.replace(/^zhk-/u, ''),
    ]);
    return segments.some((segment) => codes.has(segment));
  } catch {
    return false;
  }
}

export function isNarrowNonResidentialDeveloperUrl(value: string) {
  try {
    const url = new URL(normalizeCandidateUrl(value));
    const signal = `${url.hostname} ${url.pathname}`.toLocaleLowerCase('en-US');
    return /(?:^|[./_-])(?:art|career|forum|hr|investment|jobs?|office)(?:[./_-]|$)/u.test(signal);
  } catch {
    return false;
  }
}

export function buildKnownProjectUrls(
  projectIdentifiers: readonly string[],
  developerHosts: readonly string[],
) {
  const candidateGroups = [...new Set(projectIdentifiers)]
    .map((projectIdentifier) => buildKnownProjectUrlsForIdentifier(
      projectIdentifier,
      developerHosts,
    ));
  const urls: string[] = [];
  for (let index = 0; urls.length < 20; index += 1) {
    let foundCandidate = false;
    for (const candidates of candidateGroups) {
      const candidate = candidates[index];
      if (!candidate) continue;
      foundCandidate = true;
      if (!urls.includes(candidate)) urls.push(candidate);
      if (urls.length === 20) return urls;
    }
    if (!foundCandidate) break;
  }
  return urls;
}

function buildKnownProjectUrlsForIdentifier(
  projectIdentifier: string,
  developerHosts: readonly string[],
) {
  const genericKeyWords = new Set(['zhiloj', 'zhilye', 'kompleks', 'kvartal', 'zhk', 'dom', 'project']);
  const normalizedKey = projectIdentifier
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-|-$/gu, '');
  const words = normalizedKey.split('-').filter((word) => word && !genericKeyWords.has(word));
  const slugs = new Set<string>();
  const addSlug = (value: string) => {
    const normalized = value.replace(/^-|-$/gu, '');
    if (normalized.length >= 3 && normalized.length <= 100) slugs.add(normalized);
  };
  addSlug(words.join('-'));
  if (words.length >= 2) {
    addSlug(words.slice(0, 2).join('-'));
    addSlug(words.slice(0, 2).join(''));
    addSlug(words.slice(-2).join('-'));
    addSlug(words.slice(-2).join(''));
  }
  if (words.length === 1) addSlug(words[0] ?? '');

  const urls: string[] = [];
  for (const slug of slugs) {
    for (const path of [
      `/projects/${slug}/`,
      `/projects/zhk-${slug}/`,
      `/flats/zhk-${slug}/`,
      `/flats/${slug}/`,
    ]) {
      for (const developerHost of developerHosts) {
        urls.push(`https://${developerHost}${path}`);
      }
    }
  }
  return urls;
}

function isRetryableLunaProviderError(errorCode: string) {
  return errorCode === 'ASSISTANT_SOURCE_DISCOVERY_TIMEOUT'
    || errorCode === 'ASSISTANT_SOURCE_DISCOVERY_NETWORK_FAILED'
    || errorCode === 'ASSISTANT_SOURCE_DISCOVERY_HTTP_429'
    || /^ASSISTANT_SOURCE_DISCOVERY_HTTP_5\d\d$/u.test(errorCode);
}

export function isRetryableSourceConnectorError(errorCode: string) {
  return errorCode === 'SOURCE_FETCH_TIMEOUT'
    || errorCode === 'SOURCE_BROWSER_TIMEOUT'
    || errorCode === 'SOURCE_NETWORK_FAILED'
    || errorCode === 'SOURCE_DNS_FAILED'
    || errorCode === 'SOURCE_HTTP_RETRYABLE';
}
