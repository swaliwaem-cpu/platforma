import {
  normalizeCandidateUrl,
  relatedHosts,
} from './assistant-source-discovery-identity';

export type AssistantSourceDiscoveryRegistrySource = {
  id: string;
  state: string;
  type: string;
  canonicalUrl: string;
  projectKey: string | null;
  developerKey: string | null;
  connectorKey: string;
  connectorConfig: unknown;
  latestRevision: {
    processingStatus: string;
    checksum: string;
  } | null;
};

type RegistryProject = {
  projectKey: string;
  developerKey: string;
};

export function findRegisteredProjectSource(
  project: RegistryProject,
  sources: readonly AssistantSourceDiscoveryRegistrySource[],
) {
  for (const source of sources) {
    if (source.state !== 'ACTIVE'
      || source.type !== 'DEVELOPMENT_PAGE'
      || source.connectorKey !== 'OFFICIAL_HTML'
      || source.projectKey !== project.projectKey
      || source.developerKey !== project.developerKey
      || source.latestRevision?.processingStatus !== 'INDEXED'
      || !/^[a-f0-9]{64}$/u.test(source.latestRevision.checksum)) continue;
    try {
      const allowedHosts = readRegistryAllowedHosts(source);
      if (!allowedHosts) continue;
      return {
        source,
        canonicalUrl: normalizeCandidateUrl(source.canonicalUrl),
        allowedHosts,
      };
    } catch {
      // Invalid registry rows never establish a trusted deterministic source.
    }
  }
  return null;
}

export function findRegisteredDeveloperSources(
  project: RegistryProject,
  sources: readonly AssistantSourceDiscoveryRegistrySource[],
) {
  return sources.flatMap((source) => {
    if (source.state !== 'ACTIVE'
      || source.type !== 'DEVELOPER_PROMOTION'
      || source.connectorKey !== 'OFFICIAL_HTML'
      || source.projectKey !== null
      || source.developerKey !== project.developerKey
      || source.latestRevision?.processingStatus !== 'INDEXED'
      || !/^[a-f0-9]{64}$/u.test(source.latestRevision.checksum)) return [];
    try {
      const allowedHosts = readRegistryAllowedHosts(source);
      if (!allowedHosts) return [];
      return [{
        source,
        canonicalUrl: normalizeCandidateUrl(source.canonicalUrl),
        allowedHosts,
      }];
    } catch {
      return [];
    }
  });
}

function readRegistryAllowedHosts(source: AssistantSourceDiscoveryRegistrySource) {
  const canonicalHostname = new URL(normalizeCandidateUrl(source.canonicalUrl)).hostname
    .toLocaleLowerCase('en-US')
    .replace(/\.$/u, '');
  if (!isRecord(source.connectorConfig)) return null;
  const configured = source.connectorConfig.allowedHosts;
  if (!Array.isArray(configured) || configured.length === 0 || configured.length > 10) return null;
  const explicitHosts: string[] = [];
  for (const value of configured) {
    const hostname = normalizeStoredHostname(value);
    if (!hostname) return null;
    explicitHosts.push(hostname);
  }
  const canonicalHosts = relatedHosts(canonicalHostname);
  if (!canonicalHosts.some((hostname) => explicitHosts.includes(hostname))) return null;
  const allowedHosts = new Set([...canonicalHosts, ...explicitHosts]);
  if (allowedHosts.size > 10) return null;
  for (const explicitHost of explicitHosts) {
    for (const relatedHost of relatedHosts(explicitHost)) {
      if (allowedHosts.size === 10) break;
      allowedHosts.add(relatedHost);
    }
  }
  return [...allowedHosts];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStoredHostname(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/\.$/u, '');
  if (!normalized || normalized.length > 253 || normalized.includes('/')) return null;
  try {
    const parsed = new URL(`https://${normalized}/`);
    return parsed.host === normalized && parsed.hostname === normalized ? normalized : null;
  } catch {
    return null;
  }
}
