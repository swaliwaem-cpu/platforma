import { Injectable } from '@nestjs/common';

import { parseTrainingModuleEnabled } from '../training.config';
import { readTrainingDeploymentEnvironment } from '../training-deployment.config';

const DEFAULT_LINK_TOKEN_TTL_MINUTES = 15;
const DEFAULT_LINK_TOKEN_COOLDOWN_SECONDS = 30;
const DEFAULT_LINK_TOKEN_MAX_ISSUES_PER_HOUR = 10;
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 96 * 1024;
const DEFAULT_WORKER_POLL_MS = 250;
const DEFAULT_WORKER_LEASE_MS = 30_000;
const DEFAULT_WORKER_HEARTBEAT_MS = 5_000;
const DEFAULT_WORKER_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_PUBLIC_APP_URL = 'http://localhost:5173';
const LOCAL_PRODUCTION_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
]);
const PLACEHOLDER_HOST_LABELS = new Set([
  'example',
  'fake',
  'invalid',
  'placeholder',
  'test',
  'your-domain',
]);
const PLACEHOLDER_PRODUCTION_VALUES = [
  'change-me',
  'changeme',
  'fake-secret',
  'fake-token',
  'placeholder',
  'replace-with',
  'replace_me',
  'test-secret',
  'test-token',
  'your-secret',
  'your-token',
] as const;

export type TrainingTelegramTransportMode = 'fake' | 'real';

@Injectable()
export class TrainingTelegramConfig {
  readonly transportMode: TrainingTelegramTransportMode;
  readonly botToken: string;
  readonly botUsername: string;
  readonly webhookSecret: string;
  readonly webhookUrl: string;
  readonly linkTokenTtlMinutes: number;
  readonly linkTokenCooldownSeconds: number;
  readonly linkTokenMaxIssuesPerHour: number;
  readonly webhookMaxBodyBytes: number;
  readonly workerPollMs: number;
  readonly workerLeaseMs: number;
  readonly workerHeartbeatMs: number;
  readonly workerDrainTimeoutMs: number;
  readonly publicTrainingUrl: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
    const deploymentEnvironment =
      readTrainingDeploymentEnvironment(env);
    const trainingEnabled = parseTrainingModuleEnabled(
      env.TRAINING_MODULE_ENABLED,
    );
    this.transportMode = readTransportMode(
      env.TELEGRAM_TRANSPORT_MODE,
      nodeEnv,
      trainingEnabled,
    );
    this.botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
    this.botUsername = normalizeBotUsername(env.TELEGRAM_BOT_USERNAME);
    this.webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
    this.webhookUrl = env.TELEGRAM_WEBHOOK_URL?.trim() ?? '';
    this.linkTokenTtlMinutes = readBoundedInteger(
      'TELEGRAM_LINK_TOKEN_TTL_MINUTES',
      env.TELEGRAM_LINK_TOKEN_TTL_MINUTES,
      DEFAULT_LINK_TOKEN_TTL_MINUTES,
      1,
      60,
    );
    this.linkTokenCooldownSeconds = readBoundedInteger(
      'TELEGRAM_LINK_TOKEN_COOLDOWN_SECONDS',
      env.TELEGRAM_LINK_TOKEN_COOLDOWN_SECONDS,
      DEFAULT_LINK_TOKEN_COOLDOWN_SECONDS,
      1,
      300,
    );
    this.linkTokenMaxIssuesPerHour = readBoundedInteger(
      'TELEGRAM_LINK_TOKEN_MAX_ISSUES_PER_HOUR',
      env.TELEGRAM_LINK_TOKEN_MAX_ISSUES_PER_HOUR,
      DEFAULT_LINK_TOKEN_MAX_ISSUES_PER_HOUR,
      1,
      100,
    );
    this.webhookMaxBodyBytes = readBoundedInteger(
      'TELEGRAM_WEBHOOK_MAX_BODY_BYTES',
      env.TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
      DEFAULT_WEBHOOK_MAX_BODY_BYTES,
      1_024,
      100 * 1_024,
    );
    this.workerPollMs = readBoundedInteger(
      'TELEGRAM_WORKER_POLL_MS',
      env.TELEGRAM_WORKER_POLL_MS,
      DEFAULT_WORKER_POLL_MS,
      50,
      60_000,
    );
    this.workerLeaseMs = readBoundedInteger(
      'TELEGRAM_WORKER_LEASE_MS',
      env.TELEGRAM_WORKER_LEASE_MS,
      DEFAULT_WORKER_LEASE_MS,
      50,
      300_000,
    );
    this.workerHeartbeatMs = readBoundedInteger(
      'TELEGRAM_WORKER_HEARTBEAT_MS',
      env.TELEGRAM_WORKER_HEARTBEAT_MS,
      DEFAULT_WORKER_HEARTBEAT_MS,
      10,
      60_000,
    );
    this.workerDrainTimeoutMs = readBoundedInteger(
      'TELEGRAM_WORKER_DRAIN_TIMEOUT_MS',
      env.TELEGRAM_WORKER_DRAIN_TIMEOUT_MS,
      DEFAULT_WORKER_DRAIN_TIMEOUT_MS,
      10,
      120_000,
    );
    if (this.workerHeartbeatMs >= this.workerLeaseMs) {
      throw new Error(
        'TELEGRAM_WORKER_HEARTBEAT_MS must be less than TELEGRAM_WORKER_LEASE_MS',
      );
    }

    const strictRealConfiguration =
      this.transportMode === 'real' ||
      (deploymentEnvironment !== 'development' &&
        deploymentEnvironment !== 'test' &&
        trainingEnabled);
    if (deploymentEnvironment === 'production' && trainingEnabled) {
      if (this.transportMode !== 'real') {
        throw new Error(
          'TELEGRAM_TRANSPORT_MODE must be real when training is enabled in production',
        );
      }
    }
    if (
      this.transportMode === 'fake' &&
      !['', 'development', 'test', 'local'].includes(nodeEnv)
    ) {
      throw new Error(
        'TELEGRAM_TRANSPORT_MODE=fake is allowed only for local development and tests',
      );
    }
    if (strictRealConfiguration) {
      requireConfigured('TELEGRAM_BOT_TOKEN', this.botToken);
      requireConfigured('TELEGRAM_BOT_USERNAME', this.botUsername);
      requireConfigured('TELEGRAM_WEBHOOK_SECRET', this.webhookSecret);
      requireConfigured('TELEGRAM_WEBHOOK_URL', this.webhookUrl);
      requireConfigured('PUBLIC_APP_URL', env.PUBLIC_APP_URL?.trim() ?? '');
      assertHttpsUrl('TELEGRAM_WEBHOOK_URL', this.webhookUrl);
      assertHttpsUrl('PUBLIC_APP_URL', env.PUBLIC_APP_URL!);
    }
    if (
      deploymentEnvironment === 'staging' ||
      deploymentEnvironment === 'production'
    ) {
      assertProductionValue('TELEGRAM_BOT_TOKEN', this.botToken);
      assertProductionValue('TELEGRAM_BOT_USERNAME', this.botUsername);
      assertProductionValue('TELEGRAM_WEBHOOK_SECRET', this.webhookSecret);
      assertProductionUrl('TELEGRAM_WEBHOOK_URL', this.webhookUrl);
      assertProductionUrl('PUBLIC_APP_URL', env.PUBLIC_APP_URL ?? '');
    }
    this.publicTrainingUrl = buildPublicTrainingUrl(
      env.PUBLIC_APP_URL ?? DEFAULT_PUBLIC_APP_URL,
      strictRealConfiguration,
    );
  }

  get usesFakeTransport() {
    return this.transportMode === 'fake';
  }
}

function readTransportMode(
  value: string | undefined,
  nodeEnv: string,
  trainingEnabled: boolean,
): TrainingTelegramTransportMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'fake' || normalized === 'real') return normalized;
  if (normalized) {
    throw new Error('TELEGRAM_TRANSPORT_MODE must be fake or real');
  }
  if (trainingEnabled || nodeEnv === 'production') {
    throw new Error('TELEGRAM_TRANSPORT_MODE is required');
  }
  return 'fake';
}

function normalizeBotUsername(value: string | undefined) {
  const username = (value ?? '').trim().replace(/^@/u, '');
  if (username && !/^[A-Za-z0-9_]{5,32}$/u.test(username)) {
    throw new Error('TELEGRAM_BOT_USERNAME is invalid');
  }
  return username;
}

function readBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function requireConfigured(name: string, value: string) {
  if (!value) {
    throw new Error(`${name} is required for real Telegram transport`);
  }
}

function assertHttpsUrl(name: string, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS`);
  }
}

function assertProductionValue(name: string, value: string) {
  const normalized = value.trim().toLowerCase();
  const normalizedSeparators = normalized.replace(/[_\s]+/gu, '-');
  const isPlaceholder =
    (name === 'TELEGRAM_BOT_USERNAME' &&
      normalized === 'platforma_training_bot') ||
    PLACEHOLDER_PRODUCTION_VALUES.some(
      (placeholder) =>
        normalized.includes(placeholder) ||
        normalizedSeparators.includes(placeholder.replaceAll('_', '-')),
    );
  if (isPlaceholder) {
    throw new Error(`${name} must not use a placeholder value in production`);
  }
}

function assertProductionUrl(name: string, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  const hostname = url.hostname.toLowerCase();
  const isLoopbackIpv4 = /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  const hasPlaceholderLabel = hostname
    .split('.')
    .some((label) => PLACEHOLDER_HOST_LABELS.has(label));
  if (
    LOCAL_PRODUCTION_HOSTS.has(hostname) ||
    hostname.endsWith('.localhost') ||
    isLoopbackIpv4 ||
    hasPlaceholderLabel
  ) {
    throw new Error(`${name} must use a non-placeholder production host`);
  }
}

function buildPublicTrainingUrl(value: string, requireHttps: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_APP_URL must be an absolute URL');
  }
  if (
    (requireHttps && url.protocol !== 'https:') ||
    (!requireHttps && url.protocol !== 'http:' && url.protocol !== 'https:')
  ) {
    throw new Error(
      requireHttps
        ? 'PUBLIC_APP_URL must use HTTPS'
        : 'PUBLIC_APP_URL must use http or https',
    );
  }
  url.pathname = '/training';
  url.search = '';
  url.hash = '';
  return url.toString();
}
