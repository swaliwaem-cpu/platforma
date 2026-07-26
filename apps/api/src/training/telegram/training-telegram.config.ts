import { Injectable } from '@nestjs/common';

const DEFAULT_LINK_TOKEN_TTL_MINUTES = 15;
const DEFAULT_WORKER_POLL_MS = 250;
const DEFAULT_PUBLIC_APP_URL = 'http://localhost:5173';

@Injectable()
export class TrainingTelegramConfig {
  readonly botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  readonly botUsername = normalizeBotUsername(process.env.TELEGRAM_BOT_USERNAME);
  readonly webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  readonly webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim() ?? '';
  readonly linkTokenTtlMinutes = readBoundedInteger(
    'TELEGRAM_LINK_TOKEN_TTL_MINUTES',
    process.env.TELEGRAM_LINK_TOKEN_TTL_MINUTES,
    DEFAULT_LINK_TOKEN_TTL_MINUTES,
    1,
    60,
  );
  readonly workerPollMs = readBoundedInteger(
    'TELEGRAM_WORKER_POLL_MS',
    process.env.TELEGRAM_WORKER_POLL_MS,
    DEFAULT_WORKER_POLL_MS,
    50,
    60_000,
  );
  readonly publicTrainingUrl = buildPublicTrainingUrl(
    process.env.PUBLIC_APP_URL ?? DEFAULT_PUBLIC_APP_URL,
  );

  get usesFakeTransport() {
    return this.botToken.length === 0;
  }
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

function buildPublicTrainingUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_APP_URL must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_APP_URL must use http or https');
  }
  url.pathname = '/training';
  url.search = '';
  url.hash = '';
  return url.toString();
}
