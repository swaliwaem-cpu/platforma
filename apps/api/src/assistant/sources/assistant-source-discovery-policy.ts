import {
  normalizeCandidateUrl,
  type AssistantSourceCatalogProjectEvidence,
} from './assistant-source-discovery-identity';

export type AssistantSourceDiscoveryModelRole = 'LUNA' | 'TERRA';

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

function isRetryableSourceConnectorError(errorCode: string) {
  return errorCode === 'SOURCE_FETCH_TIMEOUT'
    || errorCode === 'SOURCE_BROWSER_TIMEOUT'
    || errorCode === 'SOURCE_NETWORK_FAILED'
    || errorCode === 'SOURCE_DNS_FAILED'
    || errorCode === 'SOURCE_HTTP_RETRYABLE';
}
