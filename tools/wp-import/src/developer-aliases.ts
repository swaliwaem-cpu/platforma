import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DeveloperAliasConfig, DeveloperAliasGroup } from './types';

export type DeveloperAliases = {
  groups: DeveloperAliasGroup[];
  canonicalByNormalizedName: Map<string, string>;
};

const defaultAliasConfigPath = resolve(__dirname, '../developer-aliases.json');

export const emptyDeveloperAliases = createDeveloperAliases({ groups: [] });

export async function loadDeveloperAliases(path = defaultAliasConfigPath) {
  const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (!content) {
    return emptyDeveloperAliases;
  }

  const parsed = JSON.parse(content) as unknown;

  return createDeveloperAliases(parseDeveloperAliasConfig(parsed, path));
}

export function createDeveloperAliases(config: DeveloperAliasConfig) {
  const canonicalByNormalizedName = new Map<string, string>();
  const groups = config.groups.map((group) => ({
    canonicalName: normalizeDeveloperDisplayName(group.canonicalName),
    aliases: group.aliases.map((alias) => normalizeDeveloperDisplayName(alias)).filter(Boolean),
  }));

  for (const group of groups) {
    const canonicalKey = normalizeDeveloperName(group.canonicalName);

    if (!canonicalKey) {
      throw new Error('Developer alias canonicalName cannot be empty');
    }

    setAlias(canonicalByNormalizedName, canonicalKey, group.canonicalName);

    for (const alias of group.aliases) {
      const aliasKey = normalizeDeveloperName(alias);

      if (!aliasKey) {
        continue;
      }

      setAlias(canonicalByNormalizedName, aliasKey, group.canonicalName);
    }
  }

  return {
    groups,
    canonicalByNormalizedName,
  } satisfies DeveloperAliases;
}

export function resolveDeveloperName(name: string, aliases: DeveloperAliases) {
  const normalizedName = normalizeDeveloperName(name);

  return aliases.canonicalByNormalizedName.get(normalizedName) ?? normalizeDeveloperDisplayName(name);
}

export function normalizeDeveloperName(name: string) {
  return normalizeDeveloperDisplayName(name).toLowerCase();
}

export function normalizeDeveloperDisplayName(name: string) {
  return name.replace(/\s+/gu, ' ').trim();
}

function parseDeveloperAliasConfig(value: unknown, path: string) {
  if (!isRecord(value) || !Array.isArray(value.groups)) {
    throw new Error(`${path} must contain a groups array`);
  }

  return {
    groups: value.groups.map((group, index) => parseDeveloperAliasGroup(group, index, path)),
  } satisfies DeveloperAliasConfig;
}

function parseDeveloperAliasGroup(value: unknown, index: number, path: string) {
  if (!isRecord(value)) {
    throw new Error(`${path} groups[${index}] must be an object`);
  }

  if (typeof value.canonicalName !== 'string' || !normalizeDeveloperName(value.canonicalName)) {
    throw new Error(`${path} groups[${index}].canonicalName must be a non-empty string`);
  }

  if (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== 'string')) {
    throw new Error(`${path} groups[${index}].aliases must be an array of strings`);
  }

  return {
    canonicalName: value.canonicalName,
    aliases: value.aliases,
  } satisfies DeveloperAliasGroup;
}

function setAlias(canonicalByNormalizedName: Map<string, string>, normalizedName: string, canonicalName: string) {
  const existingCanonicalName = canonicalByNormalizedName.get(normalizedName);

  if (existingCanonicalName && existingCanonicalName !== canonicalName) {
    throw new Error(
      `Developer alias "${normalizedName}" is assigned to both "${existingCanonicalName}" and "${canonicalName}"`,
    );
  }

  canonicalByNormalizedName.set(normalizedName, canonicalName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
