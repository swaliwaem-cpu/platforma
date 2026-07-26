import { Injectable } from '@nestjs/common';

import { parseTrainingModuleEnabled } from '../training.config';

const DEFAULT_LINK_TOKEN_TTL_MINUTES = 15;
const DEFAULT_WORKER_POLL_MS = 250;
const DEFAULT_WORKER_LEASE_MS = 30_000;
const DEFAULT_WORKER_HEARTBEAT_MS = 5_000;
const DEFAULT_WORKER_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_PUBLIC_APP_URL = 'http://localhost:5173';

export type TrainingTelegramTransportMode = 'fake' | 'real';

@Injectable()
export class TrainingTelegramConfig {
  readonly transportMode: TrainingTelegramTransportMode;
  readonly botToken: string;
  readonly botUsername: string;
  readonly webhookSecret: string;
  readonly webhookUrl: string;
  readonly linkTokenTtlMinutes: number;
  readonly workerPollMs: number;
  readonly workerLeaseMs: number;
  readonly workerHeartbeatMs: number;
  readonly workerDrainTimeoutMs: number;
  readonly publicTrainingUrl: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
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
      (nodeEnv === 'production' && trainingEnabled);
    if (nodeEnv === 'production' && trainingEnabled) {
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
