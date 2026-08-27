import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AssistantSourceDiscoveryResult } from './assistant-source-discovery.service';

export const ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION = 1;
export const ASSISTANT_SOURCE_DISCOVERY_VALIDATOR_VERSION = 'assistant-source-discovery-validator-v2';

export type AssistantSourceDiscoveryCheckpointFingerprint = {
  primaryModel: string;
  fallbackModel: string;
  promptVersion: string;
  validatorVersion: string;
};

export type AssistantSourceDiscoveryCheckpointEntry = {
  projectKey: string;
  developerKey: string;
  status: AssistantSourceDiscoveryResult['status'];
  errorCode: string | null;
  canonicalUrl: string | null;
  developerCanonicalUrl: string | null;
  officialProjectName: string | null;
  officialDeveloperName: string | null;
  matchKind: AssistantSourceDiscoveryResult['matchKind'];
  contentChecksum: string | null;
  processedAt: string;
};

type AssistantSourceDiscoveryCheckpoint = {
  version: typeof ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION;
  fingerprint: AssistantSourceDiscoveryCheckpointFingerprint;
  entries: Record<string, AssistantSourceDiscoveryCheckpointEntry>;
};

export function readAssistantSourceDiscoveryCheckpoint(
  path: string,
  fingerprint: AssistantSourceDiscoveryCheckpointFingerprint,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return createEmptyCheckpoint(fingerprint);
  }
  if (!isRecord(parsed)
    || parsed.version !== ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION
    || !sameFingerprint(parsed.fingerprint, fingerprint)
    || !isRecord(parsed.entries)) {
    return createEmptyCheckpoint(fingerprint);
  }
  const entries = Object.fromEntries(Object.entries(parsed.entries).flatMap(([key, value]) => {
    const entry = parseEntry(value);
    return entry && key === entry.projectKey ? [[key, entry]] : [];
  }));
  return { version: ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION, fingerprint, entries };
}

export function writeAssistantSourceDiscoveryCheckpoint(
  path: string,
  checkpoint: AssistantSourceDiscoveryCheckpoint,
) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function checkpointAssistantSourceDiscoveryResult(
  checkpoint: AssistantSourceDiscoveryCheckpoint,
  result: AssistantSourceDiscoveryResult,
  processedAt = new Date(),
) {
  return {
    ...checkpoint,
    entries: {
      ...checkpoint.entries,
      [result.project.projectKey]: {
        projectKey: result.project.projectKey,
        developerKey: result.project.developerKey,
        status: result.status,
        errorCode: boundedNullable(result.errorCode, 120),
        canonicalUrl: sanitizeCheckpointUrl(result.canonicalUrl),
        developerCanonicalUrl: sanitizeCheckpointUrl(result.developerCanonicalUrl),
        officialProjectName: boundedNullable(result.officialProjectName, 160),
        officialDeveloperName: boundedNullable(result.officialDeveloperName, 160),
        matchKind: result.matchKind,
        contentChecksum: /^[a-f0-9]{64}$/u.test(result.contentChecksum ?? '')
          ? result.contentChecksum
          : null,
        processedAt: processedAt.toISOString(),
      },
    },
  };
}

export function createEmptyCheckpoint(
  fingerprint: AssistantSourceDiscoveryCheckpointFingerprint,
): AssistantSourceDiscoveryCheckpoint {
  return {
    version: ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION,
    fingerprint,
    entries: {},
  };
}

function parseEntry(value: unknown): AssistantSourceDiscoveryCheckpointEntry | null {
  if (!isRecord(value)
    || typeof value.projectKey !== 'string'
    || typeof value.developerKey !== 'string'
    || !['VERIFIED', 'NOT_FOUND', 'REJECTED'].includes(String(value.status))
    || typeof value.processedAt !== 'string') return null;
  return {
    projectKey: value.projectKey.slice(0, 120),
    developerKey: value.developerKey.slice(0, 120),
    status: value.status as AssistantSourceDiscoveryCheckpointEntry['status'],
    errorCode: boundedNullable(value.errorCode, 120),
    canonicalUrl: sanitizeCheckpointUrl(value.canonicalUrl),
    developerCanonicalUrl: sanitizeCheckpointUrl(value.developerCanonicalUrl),
    officialProjectName: boundedNullable(value.officialProjectName, 160),
    officialDeveloperName: boundedNullable(value.officialDeveloperName, 160),
    matchKind: value.matchKind === 'EXACT'
      || value.matchKind === 'TRANSLITERATION'
      || value.matchKind === 'RENAMED'
      ? value.matchKind
      : null,
    contentChecksum: typeof value.contentChecksum === 'string'
      && /^[a-f0-9]{64}$/u.test(value.contentChecksum)
      ? value.contentChecksum
      : null,
    processedAt: value.processedAt,
  };
}

function sanitizeCheckpointUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function sameFingerprint(value: unknown, expected: AssistantSourceDiscoveryCheckpointFingerprint) {
  return isRecord(value)
    && value.primaryModel === expected.primaryModel
    && value.fallbackModel === expected.fallbackModel
    && value.promptVersion === expected.promptVersion
    && value.validatorVersion === expected.validatorVersion;
}

function boundedNullable(value: unknown, maximumLength: number) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maximumLength)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
