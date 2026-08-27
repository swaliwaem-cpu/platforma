import {
  normalizeCandidateUrl,
  type AssistantSourceCatalogProjectEvidence,
} from './assistant-source-discovery-identity';

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

export function buildKnownProjectUrls(projectKey: string, developerDomain: string) {
  const genericKeyWords = new Set(['zhiloj', 'zhilye', 'kompleks', 'kvartal', 'zhk', 'dom', 'project']);
  const normalizedKey = projectKey
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
      urls.push(`https://${developerDomain}${path}`);
      if (urls.length === 20) return urls;
    }
  }
  return urls;
}
