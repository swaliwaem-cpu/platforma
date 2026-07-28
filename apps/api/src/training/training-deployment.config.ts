export type TrainingDeploymentEnvironment =
  | 'development'
  | 'test'
  | 'staging'
  | 'production';

export function readTrainingDeploymentEnvironment(
  env: NodeJS.ProcessEnv,
): TrainingDeploymentEnvironment {
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  const explicit = env.DEPLOYMENT_ENV?.trim().toLowerCase();
  const deployment =
    explicit ||
    (nodeEnv === 'production'
      ? 'production'
      : nodeEnv === 'test'
        ? 'test'
        : 'development');
  if (
    !['development', 'test', 'staging', 'production'].includes(deployment)
  ) {
    throw new Error(
      'DEPLOYMENT_ENV must be development, test, staging or production',
    );
  }
  if (
    (deployment === 'staging' || deployment === 'production') &&
    nodeEnv !== 'production'
  ) {
    throw new Error(
      'NODE_ENV=production is required for staging and production deployments',
    );
  }
  return deployment as TrainingDeploymentEnvironment;
}

export function allowStagingFakeProviders(env: NodeJS.ProcessEnv) {
  const value = env.STAGING_ALLOW_FAKE_PROVIDERS?.trim().toLowerCase();
  if (value === undefined || value === '') return false;
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      'STAGING_ALLOW_FAKE_PROVIDERS must be "true" or "false"',
    );
  }
  return value === 'true';
}

export function assertTrainingDeploymentIsolation(env: NodeJS.ProcessEnv) {
  if (readTrainingDeploymentEnvironment(env) !== 'staging') return;

  const databaseUrl = parsePostgresUrl(env.DATABASE_URL);
  const allowedDatabaseHosts = readRequiredList(
    env,
    'STAGING_DATABASE_ALLOWED_HOSTS',
  );
  const expectedDatabaseName = readRequiredIdentifier(
    env,
    'STAGING_DATABASE_NAME',
  );
  const productionDatabaseIdentities = readRequiredList(
    env,
    'KNOWN_PRODUCTION_DATABASE_IDENTITIES',
  ).map(normalizeDatabaseIdentity);
  const databaseIdentity = toDatabaseIdentity(databaseUrl);
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (!allowedDatabaseHosts.includes(databaseUrl.hostname.toLowerCase())) {
    throw new Error('Staging database host is not explicitly allowed');
  }
  if (databaseName !== expectedDatabaseName) {
    throw new Error('Staging database name does not match the expected name');
  }
  if (
    productionDatabaseIdentities.includes(databaseIdentity) ||
    isProductionLike(databaseIdentity)
  ) {
    throw new Error('Staging database identity is production-like');
  }

  const buckets = [
    readRequiredIdentifier(env, 'MINIO_BUCKET'),
    readRequiredIdentifier(env, 'TRAINING_DOCUMENT_BUCKET'),
    readRequiredIdentifier(env, 'TRAINING_AUDIO_BUCKET'),
  ];
  if (new Set(buckets).size !== buckets.length) {
    throw new Error('Staging general, document and audio buckets must differ');
  }
  const productionBuckets = new Set(
    readRequiredList(env, 'KNOWN_PRODUCTION_BUCKETS'),
  );
  for (const bucket of buckets) {
    if (
      productionBuckets.has(bucket.toLowerCase()) ||
      isProductionLike(bucket) ||
      isUnsafePlaceholder(bucket) ||
      ['platforma', 'platforma-training-private', 'platforma-training-audio-private'].includes(
        bucket.toLowerCase(),
      )
    ) {
      throw new Error('Staging bucket identifier is unsafe');
    }
  }

  const stagingHosts = readRequiredList(env, 'STAGING_PUBLIC_HOSTS');
  const productionHosts = new Set(
    readRequiredList(env, 'KNOWN_PRODUCTION_PUBLIC_HOSTS'),
  );
  for (const key of [
    'S3_PUBLIC_ENDPOINT',
    'TELEGRAM_WEBHOOK_URL',
    'PUBLIC_APP_URL',
    'WEB_ORIGIN',
    'VITE_API_URL',
  ]) {
    const host = readHttpsHost(env, key);
    if (
      !stagingHosts.includes(host) ||
      productionHosts.has(host) ||
      isProductionLike(host)
    ) {
      throw new Error(`${key} does not identify an isolated staging host`);
    }
  }

  const botUsername = readRequiredIdentifier(env, 'TELEGRAM_BOT_USERNAME')
    .replace(/^@/u, '')
    .toLowerCase();
  const productionBotUsernames = new Set(
    readRequiredList(env, 'KNOWN_PRODUCTION_TELEGRAM_BOT_USERNAMES').map(
      (value) => value.replace(/^@/u, ''),
    ),
  );
  if (
    productionBotUsernames.has(botUsername) ||
    isProductionLike(botUsername) ||
    isUnsafePlaceholder(botUsername)
  ) {
    throw new Error('Staging Telegram bot username is unsafe');
  }
}

function parsePostgresUrl(rawValue: string | undefined) {
  let parsed: URL;
  try {
    parsed = new URL(rawValue ?? '');
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.pathname.length <= 1
  ) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  return parsed;
}

function readRequiredList(env: NodeJS.ProcessEnv, key: string) {
  const values = (env[key] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || values.some(isUnsafePlaceholder)) {
    throw new Error(`${key} must contain explicit non-placeholder identifiers`);
  }
  return [...new Set(values)];
}

function readRequiredIdentifier(env: NodeJS.ProcessEnv, key: string) {
  const value = (env[key] ?? '').trim();
  if (!value || isUnsafePlaceholder(value)) {
    throw new Error(`${key} must be an explicit non-placeholder value`);
  }
  return value;
}

function readHttpsHost(env: NodeJS.ProcessEnv, key: string) {
  const rawValue = readRequiredIdentifier(env, key);
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${key} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(`${key} must be an absolute HTTPS URL`);
  }
  return parsed.hostname.toLowerCase();
}

function toDatabaseIdentity(url: URL) {
  const port = url.port || '5432';
  const databaseName = decodeURIComponent(url.pathname.slice(1)).toLowerCase();
  return `${url.hostname.toLowerCase()}:${port}/${databaseName}`;
}

function normalizeDatabaseIdentity(value: string) {
  const match = /^([^:/\s]+)(?::(\d+))?\/([^/\s]+)$/u.exec(value);
  if (!match) {
    throw new Error(
      'KNOWN_PRODUCTION_DATABASE_IDENTITIES must use host:port/database',
    );
  }
  const [, host, port, databaseName] = match;
  if (!host || !databaseName) {
    throw new Error(
      'KNOWN_PRODUCTION_DATABASE_IDENTITIES must use host:port/database',
    );
  }
  return `${host.toLowerCase()}:${port || '5432'}/${databaseName.toLowerCase()}`;
}

function isUnsafePlaceholder(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    /(?:replace[_-]?with|change[_-]?me|placeholder|your-domain|example|fake|^test$)/u.test(
      normalized,
    )
  );
}

function isProductionLike(value: string) {
  return /(?:^|[._:/-])(prod|production|live|primary)(?:$|[._:/-])/iu.test(
    value,
  );
}
