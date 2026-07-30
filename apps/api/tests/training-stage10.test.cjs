require('reflect-metadata');

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const test = require('node:test');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const {
  HealthController,
} = require('../dist/health/health.controller.js');
const {
  TrainingOpenAiConfig,
} = require('../dist/training/openai/training-openai.config.js');
const {
  TrainingFeatureGuard,
} = require('../dist/training/training-feature.guard.js');
const {
  TrainingOperationsController,
} = require('../dist/training/training-operations.controller.js');
const {
  assertTrainingDeploymentIsolation,
} = require('../dist/training/training-deployment.config.js');
const {
  CURRENT_TRAINING_POLICY,
} = require('../dist/training/training-policy.seed.js');
const {
  buildSafeTrainingLogRecord,
  formatTrainingErrorForLog,
  readTrainingCorrelationId,
  resolveTrainingCorrelationId,
  safeTrainingFailureMessage,
  writeSafeTrainingLog,
} = require('../dist/training/training-safe-log.js');
const {
  encodePolicyAcceptStartCallback,
  parseTrainingTelegramCallback,
} = require('../dist/training/telegram/training-telegram.callback.js');
const {
  TrainingTelegramConfig,
} = require('../dist/training/telegram/training-telegram.config.js');
const {
  TrainingTelegramWorkerService,
} = require('../dist/training/telegram/training-telegram-worker.service.js');
const {
  TrainingTelegramWebhookService,
} = require('../dist/training/telegram/training-telegram-webhook.service.js');
const {
  WEBHOOK_MAX_CONNECTIONS,
  executeWebhookCommand,
} = require('../scripts/training-telegram-webhook.cjs');

const rootDir = resolve(__dirname, '../../..');

test('versioned policy source has a stable checksum and explicit approval', () => {
  const checksum = createHash('sha256')
    .update(
      JSON.stringify({
        version: CURRENT_TRAINING_POLICY.version,
        title: CURRENT_TRAINING_POLICY.title,
        body: CURRENT_TRAINING_POLICY.body,
        effectiveAt: CURRENT_TRAINING_POLICY.effectiveAt,
      }),
      'utf8',
    )
    .digest('hex');
  assert.equal(CURRENT_TRAINING_POLICY.checksum, checksum);
  assert.equal(CURRENT_TRAINING_POLICY.approvalStatus, 'APPROVED');
  for (const phrase of [
    'Голосовые сообщения',
    'хранятся бессрочно',
    'расшифровываются',
    'искусственного интеллекта',
    'уполномоченным администраторам',
  ]) {
    assert.match(CURRENT_TRAINING_POLICY.body, new RegExp(phrase, 'u'));
  }
});

test('feature disable rejects ingress and leaves persisted worker jobs untouched', async () => {
  const disabled = {
    isEnabled: () => false,
    assertEnabled() {
      const error = new Error('disabled');
      error.response = { code: 'TRAINING_DISABLED' };
      throw error;
    },
  };
  assert.throws(
    () => new TrainingFeatureGuard(disabled).canActivate({}),
    (error) => error.response.code === 'TRAINING_DISABLED',
  );

  let attemptedClaim = false;
  const worker = new TrainingTelegramWorkerService(
    {
      trainingJob: {
        findFirst: async () => {
          attemptedClaim = true;
          return null;
        },
      },
    },
    {
      workerPollMs: 250,
      workerLeaseMs: 30_000,
      workerHeartbeatMs: 5_000,
      workerDrainTimeoutMs: 10_000,
    },
    {},
    {},
    disabled,
  );
  worker.onModuleInit();
  await worker.drainNow();
  assert.equal(attemptedClaim, false);
});

test('webhook rejects oversized payload before persistence and keeps a controlled ACK', async () => {
  let transactions = 0;
  const webhook = new TrainingTelegramWebhookService(
    {
      $transaction: async () => {
        transactions += 1;
      },
    },
    {
      webhookSecret: 'local-test-secret',
      webhookMaxBodyBytes: 64,
    },
  );
  const result = await webhook.acceptUpdate({
    update_id: 1,
    message: { text: 'x'.repeat(100) },
  });
  assert.deepEqual(result, {
    ok: true,
    duplicate: false,
    queued: false,
    rejected: true,
  });
  assert.equal(transactions, 0);
});

test('safe training logs whitelist correlation fields and never include raw errors', () => {
  const secret = 'sensitive-token-value';
  const transcript = 'full employee transcript';
  const error = new Error(`${secret} ${transcript}`);
  const formatted = formatTrainingErrorForLog(error);
  const persisted = safeTrainingFailureMessage(error, 'Training job failed');
  const record = buildSafeTrainingLogRecord('training.test', {
    correlationId: 'telegram-update:10',
    jobId: 'job-10',
    token: secret,
    transcript,
    payload: { unsafe: true },
  });
  const emitted = [];
  const sink = {
    log: (message) => emitted.push(message),
    warn: (message) => emitted.push(message),
    error: (message) => emitted.push(message),
  };
  writeSafeTrainingLog(sink, 'log', 'training.production.path', {
    correlationId: 'telegram-update:10',
    jobId: 'job-10',
    prompt: transcript,
    authorization: secret,
    error,
  });
  const serialized = JSON.stringify({
    formatted,
    persisted,
    record,
    emitted,
  });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(transcript), false);
  assert.equal(record.correlationId, 'telegram-update:10');
  assert.equal(record.jobId, 'job-10');
  assert.equal('payload' in record, false);
  assert.equal(
    readTrainingCorrelationId('telegram-update:10'),
    'telegram-update:10',
  );
  assert.equal(readTrainingCorrelationId('unsafe correlation\nvalue'), null);
  assert.equal(
    resolveTrainingCorrelationId(
      undefined,
      'training-answer:11111111-1111-4111-8111-111111111111',
    ),
    'training-answer:11111111-1111-4111-8111-111111111111',
  );
  assert.equal(
    resolveTrainingCorrelationId(undefined, 'unsafe fallback value'),
    null,
  );
});

test('Telegram policy callback is bounded and restores the project correlation', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const callback = encodePolicyAcceptStartCallback(projectId);
  assert.ok(Buffer.byteLength(callback, 'utf8') <= 64);
  assert.deepEqual(parseTrainingTelegramCallback(callback), {
    action: 'POLICY_ACCEPT_START',
    projectId,
  });
  assert.deepEqual(parseTrainingTelegramCallback('tr:accept'), {
    action: 'POLICY_ACCEPT',
  });
});

test('staging fake provider opt-in is explicit and production rejects it', () => {
  assert.throws(
    () =>
      new TrainingOpenAiConfig({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'staging',
        TRAINING_MODULE_ENABLED: 'true',
        OPENAI_PROVIDER_MODE: 'fake',
      }),
    /STAGING_ALLOW_FAKE_PROVIDERS=true/u,
  );
  const staging = new TrainingOpenAiConfig({
    NODE_ENV: 'production',
    DEPLOYMENT_ENV: 'staging',
    TRAINING_MODULE_ENABLED: 'true',
    OPENAI_PROVIDER_MODE: 'fake',
    STAGING_ALLOW_FAKE_PROVIDERS: 'true',
  });
  assert.equal(staging.providerMode, 'fake');
  assert.throws(
    () =>
      new TrainingOpenAiConfig({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        TRAINING_MODULE_ENABLED: 'true',
        OPENAI_PROVIDER_MODE: 'real',
        STAGING_ALLOW_FAKE_PROVIDERS: 'true',
      }),
    /STAGING_ALLOW_FAKE_PROVIDERS is forbidden/u,
  );
});

test('staging isolation rejects production DB, bucket, URL and bot identifiers', () => {
  const valid = createStagingIsolationEnvironment();
  assert.doesNotThrow(() => assertTrainingDeploymentIsolation(valid));

  const invalidEnvironments = [
    {
      ...valid,
      KNOWN_PRODUCTION_DATABASE_IDENTITIES:
        'postgres:5432/platforma_staging',
    },
    {
      ...valid,
      TRAINING_DOCUMENT_BUCKET: valid.MINIO_BUCKET,
    },
    {
      ...valid,
      TRAINING_AUDIO_BUCKET: 'platforma-general-live',
    },
    {
      ...valid,
      PUBLIC_APP_URL: 'https://app.fluffywhite.internal',
    },
    {
      ...valid,
      TELEGRAM_BOT_USERNAME: 'platforma_training_bot',
    },
  ];
  for (const environment of invalidEnvironments) {
    assert.throws(() => assertTrainingDeploymentIsolation(environment));
  }

  const password = 'must-not-appear-in-errors';
  assert.throws(
    () =>
      assertTrainingDeploymentIsolation({
        ...valid,
        DATABASE_URL: `postgresql://stage:${password}@prod-db.internal:5432/platforma?schema=public`,
      }),
    (error) => !String(error).includes(password),
  );
});

test('staging isolation is enforced before migrations and placeholder examples fail closed', () => {
  assert.throws(
    () =>
      assertTrainingDeploymentIsolation({
        ...createStagingIsolationEnvironment(),
        KNOWN_PRODUCTION_BUCKETS: 'REPLACE_WITH_PRODUCTION_BUCKETS',
      }),
    /explicit non-placeholder identifiers/u,
  );
  const dockerfile = readFileSync(
    resolve(rootDir, 'apps/api/Dockerfile'),
    'utf8',
  );
  assert.match(
    dockerfile,
    /training-deployment-preflight\.js && pnpm --dir apps\/api exec prisma migrate deploy/u,
  );
  const rootPackage = JSON.parse(
    readFileSync(resolve(rootDir, 'package.json'), 'utf8'),
  );
  assert.equal(
    rootPackage.scripts['training:staging'],
    'pnpm --filter @platforma/api build && node --env-file=.env.staging scripts/run-training-staging.cjs',
  );
  const stagingRunner = readFileSync(
    resolve(rootDir, 'scripts/run-training-staging.cjs'),
    'utf8',
  );
  assert.match(
    stagingRunner,
    /DEPLOYMENT_ENV=staging from \.env\.staging/u,
  );
  assert.match(
    stagingRunner,
    /training-deployment-preflight\.js/u,
  );

  const temporaryDirectory = mkdtempSync(
    resolve(tmpdir(), 'platforma-staging-preflight-'),
  );
  const environmentFile = resolve(temporaryDirectory, 'missing-marker.env');
  const environmentWithoutMarker = {
    ...createStagingIsolationEnvironment(),
  };
  delete environmentWithoutMarker.DEPLOYMENT_ENV;
  writeFileSync(
    environmentFile,
    Object.entries(environmentWithoutMarker)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        `--env-file=${environmentFile}`,
        resolve(rootDir, 'scripts/run-training-staging.cjs'),
        'preflight',
      ],
      {
        cwd: rootDir,
        env: {
          PATH: process.env.PATH,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /require DEPLOYMENT_ENV=staging from \.env\.staging/u,
    );
    writeFileSync(
      environmentFile,
      Object.entries(createStagingIsolationEnvironment())
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      { mode: 0o600 },
    );
    const validResult = spawnSync(
      process.execPath,
      [
        `--env-file=${environmentFile}`,
        resolve(rootDir, 'scripts/run-training-staging.cjs'),
        'preflight',
      ],
      {
        cwd: rootDir,
        env: {
          PATH: process.env.PATH,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(
      validResult.status,
      0,
      `${validResult.stdout}\n${validResult.stderr}`,
    );
    assert.match(
      validResult.stdout,
      /Training staging deployment preflight passed/u,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('staging Telegram config validates HTTPS and bounded abuse controls', () => {
  const config = new TrainingTelegramConfig({
    NODE_ENV: 'production',
    DEPLOYMENT_ENV: 'staging',
    TRAINING_MODULE_ENABLED: 'true',
    TELEGRAM_TRANSPORT_MODE: 'real',
    TELEGRAM_BOT_TOKEN: '100000:local-stage-fixture',
    TELEGRAM_BOT_USERNAME: 'stage_training_bot',
    TELEGRAM_WEBHOOK_SECRET: 'stage-local-secret',
    TELEGRAM_WEBHOOK_URL: 'https://api.stage.fluffywhite.ru/training/telegram/webhook',
    PUBLIC_APP_URL: 'https://app.stage.fluffywhite.ru',
    TELEGRAM_LINK_TOKEN_COOLDOWN_SECONDS: '45',
    TELEGRAM_LINK_TOKEN_MAX_ISSUES_PER_HOUR: '8',
    TELEGRAM_WEBHOOK_MAX_BODY_BYTES: '65536',
  });
  assert.equal(config.linkTokenCooldownSeconds, 45);
  assert.equal(config.linkTokenMaxIssuesPerHour, 8);
  assert.equal(config.webhookMaxBodyBytes, 65_536);
});

test('health response and operations permissions expose only safe contracts', async () => {
  const healthy = new HealthController(
    { $queryRaw: async () => [{ ok: 1 }] },
    { isEnabled: () => true },
  );
  assert.deepEqual(await healthy.check(), {
    status: 'ok',
    database: 'ok',
    training: 'ready',
  });
  const failing = new HealthController(
    {
      $queryRaw: async () => {
        throw new Error('postgresql://user:secret@private-host/database');
      },
    },
    { isEnabled: () => false },
  );
  await assert.rejects(
    failing.check(),
    (error) => {
      const serialized = JSON.stringify(error.response);
      return (
        error.response.database === 'unavailable' &&
        !serialized.includes('private-host') &&
        !serialized.includes('secret')
      );
    },
  );
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingOperationsController.prototype.getSummary,
    ),
    ['training:operations:read'],
  );
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingOperationsController.prototype.retryJob,
    ),
    ['training:operations:manage'],
  );
});

test('webhook CLI uses allowed_updates and never returns credentials', async () => {
  const calls = [];
  const env = {
    TELEGRAM_TRANSPORT_MODE: 'real',
    TELEGRAM_BOT_TOKEN: '100000:local-cli-fixture',
    TELEGRAM_WEBHOOK_SECRET: 'local-cli-secret',
    TELEGRAM_WEBHOOK_URL: 'https://api.stage.invalid/training/telegram/webhook',
  };
  const register = await executeWebhookCommand({
    command: 'register',
    env,
    apiOrigin: 'https://telegram.stub.invalid',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ ok: true, result: true }),
      };
    },
  });
  assert.deepEqual(register, { ok: true, command: 'register' });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.allowed_updates, ['message', 'callback_query']);
  assert.equal(body.max_connections, 1);
  assert.equal(body.max_connections, WEBHOOK_MAX_CONNECTIONS);
  assert.equal(body.drop_pending_updates, false);
  const serializedResult = JSON.stringify(register);
  assert.equal(serializedResult.includes(env.TELEGRAM_BOT_TOKEN), false);
  assert.equal(serializedResult.includes(env.TELEGRAM_WEBHOOK_SECRET), false);

  const status = await executeWebhookCommand({
    command: 'status',
    env: {
      TELEGRAM_TRANSPORT_MODE: 'real',
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    },
    apiOrigin: 'https://telegram.stub.invalid',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          url: 'https://api.stage.invalid/training/telegram/webhook',
          pending_update_count: 2,
          max_connections: 1,
          allowed_updates: ['message', 'callback_query'],
        },
      }),
    }),
  });
  assert.equal(status.webhook.pendingUpdateCount, 2);
  assert.equal(status.webhook.maxConnections, 1);

  await assert.rejects(
    executeWebhookCommand({
      command: 'delete',
      env,
      apiOrigin: 'https://telegram.stub.invalid',
      fetchImpl: async () => {
        throw new Error('must not be called');
      },
    }),
    /TELEGRAM_WEBHOOK_DELETE_CONFIRMED=true/u,
  );

  const deleteDryRun = await executeWebhookCommand({
    command: 'delete',
    dryRun: true,
    env: {
      TELEGRAM_TRANSPORT_MODE: 'real',
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_WEBHOOK_DELETE_CONFIRMED: 'true',
      TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES: 'true',
    },
    apiOrigin: 'https://telegram.stub.invalid',
    fetchImpl: async () => {
      throw new Error('dry-run must not call Telegram');
    },
  });
  assert.equal(deleteDryRun.dropPendingUpdates, true);
});

test('training templates and frontend contain no credential-shaped values', () => {
  const files = [
    '.env.example',
    '.env.production.example',
    '.env.staging.example',
    'apps/api/.env.example',
    'apps/web/.env.example',
    'apps/web/src/training/TrainingShellPage.tsx',
    'apps/web/src/training/TrainingOperationsPage.tsx',
    'packages/shared/src/training.ts',
  ];
  const content = files
    .map((file) => {
      try {
        return readFileSync(resolve(rootDir, file), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  assert.doesNotMatch(content, /\bsk-[A-Za-z0-9_-]{20,}\b/u);
  assert.doesNotMatch(content, /\b\d{8,}:[A-Za-z0-9_-]{25,}\b/u);
  assert.doesNotMatch(
    readFileSync(
      resolve(rootDir, 'packages/shared/src/training.ts'),
      'utf8',
    ),
    /(OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|S3_SECRET_ACCESS_KEY|WEBHOOK_SECRET)/u,
  );
  assert.doesNotMatch(
    readFileSync(
      resolve(rootDir, 'apps/web/src/training/TrainingShellPage.tsx'),
      'utf8',
    ),
    /(OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|S3_SECRET_ACCESS_KEY|WEBHOOK_SECRET)/u,
  );
});

function createStagingIsolationEnvironment() {
  return {
    NODE_ENV: 'production',
    DEPLOYMENT_ENV: 'staging',
    DATABASE_URL:
      'postgresql://platforma_staging:stage-secret@postgres:5432/platforma_staging?schema=public',
    STAGING_DATABASE_ALLOWED_HOSTS: 'postgres',
    STAGING_DATABASE_NAME: 'platforma_staging',
    KNOWN_PRODUCTION_DATABASE_IDENTITIES:
      'prod-db.internal:5432/platforma',
    MINIO_BUCKET: 'platforma-staging-general',
    TRAINING_DOCUMENT_BUCKET: 'platforma-staging-documents',
    TRAINING_AUDIO_BUCKET: 'platforma-staging-audio',
    KNOWN_PRODUCTION_BUCKETS:
      'platforma-general-live,platforma-documents-live,platforma-audio-live',
    S3_PUBLIC_ENDPOINT: 'https://files.stage.fluffywhite.invalid',
    TELEGRAM_WEBHOOK_URL:
      'https://api.stage.fluffywhite.invalid/training/telegram/webhook',
    PUBLIC_APP_URL: 'https://app.stage.fluffywhite.invalid',
    WEB_ORIGIN: 'https://app.stage.fluffywhite.invalid',
    VITE_API_URL: 'https://api.stage.fluffywhite.invalid',
    STAGING_PUBLIC_HOSTS:
      'files.stage.fluffywhite.invalid,api.stage.fluffywhite.invalid,app.stage.fluffywhite.invalid',
    KNOWN_PRODUCTION_PUBLIC_HOSTS:
      'files.fluffywhite.internal,api.fluffywhite.internal,app.fluffywhite.internal',
    TELEGRAM_BOT_USERNAME: 'platforma_stage_training_bot',
    KNOWN_PRODUCTION_TELEGRAM_BOT_USERNAMES: 'platforma_training_bot',
  };
}
