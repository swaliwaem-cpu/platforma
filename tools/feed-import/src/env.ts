import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type FeedImportConfig = {
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
  loadDotEnvFile(resolve(rootDir, 'tools/feed-import/.env'));
}

export function loadFeedImportConfig() {
  loadEnvFiles();

  return {
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
  } satisfies FeedImportConfig;
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

function getEnv(key: string, fallback: string) {
  const value = process.env[key]?.trim();

  return value || fallback;
}

function normalizeEndpoint(value: string) {
  return value.replace(/\/+$/u, '');
}
