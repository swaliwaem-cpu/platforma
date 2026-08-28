import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { AssistantSourceDiscoveryResult } from './assistant-source-discovery.service';

export const ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION = 1;
export const ASSISTANT_SOURCE_DISCOVERY_VALIDATOR_VERSION = 'assistant-source-discovery-validator-v2';

export type AssistantSourceDiscoveryCheckpointErrorCode =
  | 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_BACKUP_FAILED'
  | 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID'
  | 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_FINGERPRINT_MISMATCH'
  | 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_READ_FAILED'
  | 'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_WRITE_FAILED';

export class AssistantSourceDiscoveryCheckpointError extends Error {
  constructor(
    readonly code: AssistantSourceDiscoveryCheckpointErrorCode,
    readonly checkpoint?: AssistantSourceDiscoveryCheckpoint,
  ) {
    super(code);
    this.name = 'AssistantSourceDiscoveryCheckpointError';
  }
}

export type AssistantSourceDiscoveryCheckpointFingerprint = {
  primaryModel: string;
  fallbackModel: string;
  promptVersion: string;
  validatorVersion: string;
};

export type AssistantSourceDiscoveryCheckpointEntry = {
  projectKey: string;
  developerKey: string;
  status: 'VERIFIED' | 'NOT_FOUND' | 'REJECTED';
  errorCode: string | null;
  canonicalUrl: string | null;
  developerCanonicalUrl: string | null;
  officialProjectName: string | null;
  officialDeveloperName: string | null;
  matchKind: AssistantSourceDiscoveryResult['matchKind'];
  contentChecksum: string | null;
  processedAt: string;
};

export type AssistantSourceDiscoveryCheckpoint = {
  version: typeof ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION;
  fingerprint: AssistantSourceDiscoveryCheckpointFingerprint;
  entries: Record<string, AssistantSourceDiscoveryCheckpointEntry>;
};

export type AssistantSourceDiscoveryCheckpointReadResult = {
  state: 'MISSING' | 'VALID';
  checkpoint: AssistantSourceDiscoveryCheckpoint;
};

export function readAssistantSourceDiscoveryCheckpoint(
  path: string,
  fingerprint: AssistantSourceDiscoveryCheckpointFingerprint,
): AssistantSourceDiscoveryCheckpointReadResult {
  let serialized: string;
  try {
    serialized = readFileSync(path, 'utf8');
  } catch (error) {
    if (readNodeErrorCode(error) === 'ENOENT') {
      return { state: 'MISSING', checkpoint: createEmptyCheckpoint(fingerprint) };
    }
    throw new AssistantSourceDiscoveryCheckpointError(
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_READ_FAILED',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new AssistantSourceDiscoveryCheckpointError(
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
    );
  }
  if (!isRecord(parsed)
    || parsed.version !== ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION
    || !isRecord(parsed.entries)) {
    throw new AssistantSourceDiscoveryCheckpointError(
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
    );
  }
  const storedFingerprint = parseFingerprint(parsed.fingerprint);
  if (!storedFingerprint) {
    throw new AssistantSourceDiscoveryCheckpointError(
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
    );
  }
  const entries: Record<string, AssistantSourceDiscoveryCheckpointEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    const entry = parseEntry(value);
    if (!entry || key !== entry.projectKey) {
      throw new AssistantSourceDiscoveryCheckpointError(
        'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_INVALID',
      );
    }
    entries[key] = entry;
  }
  const storedCheckpoint: AssistantSourceDiscoveryCheckpoint = {
    version: ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION,
    fingerprint: storedFingerprint,
    entries,
  };
  if (!sameFingerprint(storedFingerprint, fingerprint)) {
    throw new AssistantSourceDiscoveryCheckpointError(
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_FINGERPRINT_MISMATCH',
      storedCheckpoint,
    );
  }
  return {
    state: 'VALID',
    checkpoint: {
      version: ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_VERSION,
      fingerprint,
      entries,
    },
  };
}

export function writeAssistantSourceDiscoveryCheckpoint(
  path: string,
  checkpoint: AssistantSourceDiscoveryCheckpoint,
) {
  let temporaryPath: string | null = null;
  try {
    const directory = dirname(path);
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    temporaryPath = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    writeFileSync(temporaryPath, serialized, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
    temporaryPath = null;
  } catch {
    if (temporaryPath) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // The caller still receives a single safe fail-closed checkpoint error.
      }
    }
    throw new AssistantSourceDiscoveryCheckpointError(
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_WRITE_FAILED',
    );
  }
}

export function backupAssistantSourceDiscoveryCheckpoint(
  path: string,
  checkpoint: AssistantSourceDiscoveryCheckpoint,
  createdAt = new Date(),
) {
  const backupDirectory = join(dirname(path), 'backups');
  const timestamp = createdAt.toISOString().replace(/[:.]/gu, '-');
  const backupPath = join(
    backupDirectory,
    `${basename(path)}.${timestamp}.${randomUUID()}.json`,
  );
  try {
    writeAssistantSourceDiscoveryCheckpoint(backupPath, checkpoint);
  } catch {
    throw new AssistantSourceDiscoveryCheckpointError(
      'ASSISTANT_SOURCE_DISCOVERY_CHECKPOINT_BACKUP_FAILED',
    );
  }
  return backupPath;
}

export function checkpointAssistantSourceDiscoveryResult(
  checkpoint: AssistantSourceDiscoveryCheckpoint,
  result: AssistantSourceDiscoveryResult,
  processedAt = new Date(),
) {
  if (!isCheckpointStatus(result.status)) return checkpoint;
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
    || !isBoundedString(value.projectKey, 120)
    || !isBoundedString(value.developerKey, 120)
    || !['VERIFIED', 'NOT_FOUND', 'REJECTED'].includes(String(value.status))
    || !isNullableBoundedString(value.errorCode, 120)
    || !isCheckpointUrl(value.canonicalUrl)
    || !isCheckpointUrl(value.developerCanonicalUrl)
    || !isNullableBoundedString(value.officialProjectName, 160)
    || !isNullableBoundedString(value.officialDeveloperName, 160)
    || (value.matchKind !== null
      && value.matchKind !== 'EXACT'
      && value.matchKind !== 'TRANSLITERATION'
      && value.matchKind !== 'RENAMED')
    || (value.contentChecksum !== null
      && (typeof value.contentChecksum !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.contentChecksum)))
    || !isIsoTimestamp(value.processedAt)) return null;
  return {
    projectKey: value.projectKey,
    developerKey: value.developerKey,
    status: value.status as AssistantSourceDiscoveryCheckpointEntry['status'],
    errorCode: value.errorCode,
    canonicalUrl: value.canonicalUrl,
    developerCanonicalUrl: value.developerCanonicalUrl,
    officialProjectName: value.officialProjectName,
    officialDeveloperName: value.officialDeveloperName,
    matchKind: value.matchKind,
    contentChecksum: value.contentChecksum,
    processedAt: value.processedAt,
  };
}

function isCheckpointStatus(
  status: AssistantSourceDiscoveryResult['status'],
): status is AssistantSourceDiscoveryCheckpointEntry['status'] {
  return status === 'VERIFIED' || status === 'NOT_FOUND' || status === 'REJECTED';
}

function parseFingerprint(value: unknown): AssistantSourceDiscoveryCheckpointFingerprint | null {
  if (!isRecord(value)
    || !isBoundedString(value.primaryModel, 160)
    || !isBoundedString(value.fallbackModel, 160)
    || !isBoundedString(value.promptVersion, 160)
    || !isBoundedString(value.validatorVersion, 160)) return null;
  return {
    primaryModel: value.primaryModel,
    fallbackModel: value.fallbackModel,
    promptVersion: value.promptVersion,
    validatorVersion: value.validatorVersion,
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

function isCheckpointUrl(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && sanitizeCheckpointUrl(value) === value);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isNullableBoundedString(
  value: unknown,
  maximumLength: number,
): value is string | null {
  return value === null || isBoundedString(value, maximumLength);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
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

function readNodeErrorCode(error: unknown) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}
