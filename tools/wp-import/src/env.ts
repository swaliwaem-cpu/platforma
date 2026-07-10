import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RealEstateObjectType } from '@prisma/client';

import {
  getWordPressImportProfile,
  WordPressImportProfile,
  WordPressImportProfileName,
} from './profiles';

export type ImportConfig = {
  wp: {
    host: string;
    port: number;
    socketPath: string | null;
    user: string;
    password: string;
    database: string;
    tablePrefix: string;
    uploadsPath: string;
    profileName: WordPressImportProfileName;
    profile: WordPressImportProfile;
    postType: string;
    taxonomies: readonly string[];
    sourcePathPrefix: string;
    objectType: RealEstateObjectType;
    importFiles: boolean;
    importLimit: number | null;
  };
  postgres: {
    databaseUrl: string | null;
  };
  s3: {
    endpoint: string;
    publicEndpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
};

const rootDir = resolve(__dirname, '../../..');

export function loadEnvFiles() {
  loadDotEnvFile(resolve(rootDir, '.env'));
  loadDotEnvFile(resolve(rootDir, 'apps/api/.env'));
  loadDotEnvFile(resolve(rootDir, 'tools/wp-import/.env'));
}

export function loadImportConfig() {
  loadEnvFiles();

  const tablePrefix = getEnv('WP_TABLE_PREFIX', 'wp_');
  const profile = getWordPressImportProfile(getEnv('WP_IMPORT_PROFILE', 'residential'));

  if (!/^[a-zA-Z0-9_]+$/u.test(tablePrefix)) {
    throw new Error('WP_TABLE_PREFIX can contain only letters, numbers and underscores');
  }

  return {
    wp: {
      host: getEnv('WP_DB_HOST', '127.0.0.1'),
      port: getPositiveIntegerEnv('WP_DB_PORT', 3306),
      socketPath: getOptionalEnv('WP_DB_SOCKET'),
      user: getRequiredEnv('WP_DB_USER'),
      password: getEnv('WP_DB_PASSWORD', ''),
      database: getRequiredEnv('WP_DB_NAME'),
      tablePrefix,
      uploadsPath: getRequiredEnv('WP_UPLOADS_PATH'),
      profileName: profile.name,
      profile,
      postType: profile.postType,
      taxonomies: profile.taxonomies,
      sourcePathPrefix: profile.sourcePathPrefix,
      objectType: profile.objectType,
      importFiles: profile.importFiles,
      importLimit: getNullablePositiveIntegerEnv('WP_IMPORT_LIMIT'),
    },
    postgres: {
      databaseUrl: process.env.DATABASE_URL?.trim() || null,
    },
    s3: {
      endpoint: normalizeEndpoint(getEnv('S3_ENDPOINT', 'http://localhost:9000')),
      publicEndpoint: normalizeEndpoint(getEnv('S3_PUBLIC_ENDPOINT', getEnv('S3_ENDPOINT', 'http://localhost:9000'))),
      region: getEnv('S3_REGION', 'us-east-1'),
      accessKeyId: getEnv('S3_ACCESS_KEY_ID', 'platforma'),
      secretAccessKey: getEnv('S3_SECRET_ACCESS_KEY', 'platforma_password'),
      bucket: getEnv('MINIO_BUCKET', 'platforma'),
    },
  } satisfies ImportConfig;
}

function loadDotEnvFile(path: string) {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, 'utf8');

  for (const line of content.split(/\r?\n/u)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');

    if (separatorIndex < 1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();

    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function getRequiredEnv(key: string) {
  const value = process.env[key]?.trim();

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function getEnv(key: string, fallback: string) {
  const value = process.env[key]?.trim();

  return value || fallback;
}

function getOptionalEnv(key: string) {
  const value = process.env[key]?.trim();

  return value || null;
}

function getPositiveIntegerEnv(key: string, fallback: number) {
  const value = process.env[key]?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsed;
}

function getNullablePositiveIntegerEnv(key: string) {
  const value = process.env[key]?.trim();

  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsed;
}

function normalizeEndpoint(value: string) {
  return value.replace(/\/+$/u, '');
}
