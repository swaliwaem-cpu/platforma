import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

type TrainingEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

const BUCKET_PATTERN = /^(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u;
const PLACEHOLDER_PATTERN = /(?:change[-_ ]?me|placeholder|example|your[-_ ]|dummy|test[-_ ]?(?:key|token|secret)|^fake$)/iu;
const TELEGRAM_WEBHOOK_PATHS = new Set([
  '/training/telegram/webhook',
  '/api/training/telegram/webhook',
]);

export class TrainingRuntimeConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TrainingRuntimeConfigError';
  }
}

export function isTrainingModuleEnabled(environment: TrainingEnvironment = process.env) {
  const raw = environment.TRAINING_MODULE_ENABLED;

  if (raw === undefined || raw.trim() === '') return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new TrainingRuntimeConfigError('TRAINING_MODULE_ENABLED_INVALID');
}

export function validateTrainingRuntimeConfig(
  environment: TrainingEnvironment = process.env,
) {
  const enabled = isTrainingModuleEnabled(environment);

  if (environment.NODE_ENV !== 'production') return { enabled };
  if (environment.TRAINING_MODULE_ENABLED === undefined) {
    throw new TrainingRuntimeConfigError('TRAINING_MODULE_ENABLED_REQUIRED');
  }
  if (!enabled) return { enabled };

  requireExact(environment, 'TELEGRAM_TRANSPORT_MODE', 'real');
  requireSecret(environment, 'TELEGRAM_BOT_TOKEN', 24);
  requireValue(environment, 'TELEGRAM_BOT_USERNAME', 5);
  requireSecret(environment, 'TELEGRAM_WEBHOOK_SECRET', 16);
  requireExact(environment, 'TRAINING_AI_MODE', 'openai');
  requireSecret(environment, 'OPENAI_API_KEY', 20);
  requireValue(environment, 'OPENAI_TRANSCRIPTION_MODEL', 3);
  requireValue(environment, 'OPENAI_QUESTION_GENERATION_MODEL', 3);
  requirePreferredValue(
    environment,
    'OPENAI_EVALUATOR_MODEL',
    'OPENAI_EVALUATION_MODEL',
    3,
  );

  validateHttpsUrl(environment, 'PUBLIC_APP_URL', false);
  validateHttpsUrl(environment, 'TELEGRAM_WEBHOOK_URL', true);

  const buckets = [
    requireBucket(environment, 'MINIO_BUCKET'),
    requireBucket(environment, 'TRAINING_AUDIO_BUCKET'),
    requireBucket(environment, 'TRAINING_MATERIAL_BUCKET'),
  ];

  if (new Set(buckets).size !== buckets.length) {
    throw new TrainingRuntimeConfigError('TRAINING_BUCKETS_NOT_DISTINCT');
  }

  return { enabled };
}

@Injectable()
export class TrainingFeatureGuard implements CanActivate {
  canActivate() {
    if (isTrainingModuleEnabled()) return true;

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'TRAINING_MODULE_DISABLED',
    });
  }
}

function requireExact(
  environment: TrainingEnvironment,
  key: string,
  expected: string,
) {
  if (environment[key]?.trim().toLowerCase() !== expected) {
    throw new TrainingRuntimeConfigError(`${key}_INVALID`);
  }
}

function requireValue(environment: TrainingEnvironment, key: string, minimumLength: number) {
  const value = environment[key]?.trim();

  if (!value || value.length < minimumLength || PLACEHOLDER_PATTERN.test(value)) {
    throw new TrainingRuntimeConfigError(`${key}_INVALID`);
  }

  return value;
}

function requirePreferredValue(
  environment: TrainingEnvironment,
  primaryKey: string,
  fallbackKey: string,
  minimumLength: number,
) {
  if (environment[primaryKey]?.trim()) {
    return requireValue(environment, primaryKey, minimumLength);
  }
  return requireValue(environment, fallbackKey, minimumLength);
}

function requireSecret(environment: TrainingEnvironment, key: string, minimumLength: number) {
  return requireValue(environment, key, minimumLength);
}

function validateHttpsUrl(
  environment: TrainingEnvironment,
  key: string,
  requireWebhookPath: boolean,
) {
  const raw = requireValue(environment, key, 8);
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new TrainingRuntimeConfigError(`${key}_INVALID`);
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    isUnsafeProductionHostname(url.hostname) ||
    (requireWebhookPath &&
      (!TELEGRAM_WEBHOOK_PATHS.has(url.pathname) || Boolean(url.search)))
  ) {
    throw new TrainingRuntimeConfigError(`${key}_INVALID`);
  }
}

function isUnsafeProductionHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');

  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.example') ||
    normalized.endsWith('.invalid')
  ) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);

  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;

    return (
      octets.some((octet) => octet > 255) ||
      first === 10 ||
      first === 127 ||
      first === 0 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function requireBucket(environment: TrainingEnvironment, key: string) {
  const bucket = environment[key]?.trim().toLowerCase();

  if (
    !bucket ||
    !BUCKET_PATTERN.test(bucket) ||
    bucket.includes('..') ||
    bucket.includes('.-') ||
    bucket.includes('-.')
  ) {
    throw new TrainingRuntimeConfigError(`${key}_INVALID`);
  }

  return bucket;
}
