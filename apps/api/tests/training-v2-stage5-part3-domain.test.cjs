require('reflect-metadata');

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { test } = require('node:test');

const { ServiceUnavailableException } = require('@nestjs/common');

const { HealthController } = require('../dist/health/health.controller.js');
const {
  TrainingFeatureGuard,
  TrainingRuntimeConfigError,
  isTrainingCrossProjectGenerationReuseEnabled,
  isTrainingModuleEnabled,
  validateTrainingRuntimeConfig,
} = require('../dist/training/training-runtime-config.js');
const {
  readQuestionGenerationRoutingConfig,
} = require('../dist/training/training-question-generation-router.js');
const {
  ALLOWED_UPDATES,
  createOperation,
  executeWebhookCommand,
  validateWebhookUrl,
} = require('../scripts/training-telegram-webhook.cjs');

function validProductionEnvironment() {
  return {
    NODE_ENV: 'production',
    TRAINING_MODULE_ENABLED: 'true',
    TELEGRAM_TRANSPORT_MODE: 'real',
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_123456',
    TELEGRAM_BOT_USERNAME: 'platforma_training_bot',
    TELEGRAM_WEBHOOK_SECRET: 'safe_webhook_secret_123456',
    TELEGRAM_WEBHOOK_URL: 'https://training.fluffywhite.moscow/training/telegram/webhook',
    TRAINING_AI_MODE: 'openai',
    OPENAI_API_KEY: 'sk-live-project-key-value-123456',
    OPENAI_TRANSCRIPTION_MODEL: 'gpt-transcribe-production',
    OPENAI_QUESTION_GENERATION_MODEL: 'gpt-5.6-terra',
    OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS: '30000',
    OPENAI_EVALUATOR_MODEL: 'gpt-5.6-terra',
    PUBLIC_APP_URL: 'https://platforma.fluffywhite.moscow',
    MINIO_BUCKET: 'platforma',
    TRAINING_AUDIO_BUCKET: 'platforma-training-audio',
    TRAINING_MATERIAL_BUCKET: 'platforma-training-materials',
  };
}

test('Training module flag is strict and defaults enabled outside production validation', () => {
  assert.equal(isTrainingModuleEnabled({}), true);
  assert.equal(isTrainingModuleEnabled({ TRAINING_MODULE_ENABLED: 'true' }), true);
  assert.equal(isTrainingModuleEnabled({ TRAINING_MODULE_ENABLED: 'false' }), false);
  assert.throws(
    () => isTrainingModuleEnabled({ TRAINING_MODULE_ENABLED: 'TRUE' }),
    (error) => error instanceof TrainingRuntimeConfigError &&
      error.code === 'TRAINING_MODULE_ENABLED_INVALID',
  );
});

test('cross-project generation reuse flag is strict and defaults disabled', () => {
  assert.equal(isTrainingCrossProjectGenerationReuseEnabled({}), false);
  assert.equal(isTrainingCrossProjectGenerationReuseEnabled({
    TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'true',
  }), true);
  assert.equal(isTrainingCrossProjectGenerationReuseEnabled({
    TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'false',
  }), false);
  assert.throws(
    () => isTrainingCrossProjectGenerationReuseEnabled({
      TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'TRUE',
    }),
    (error) => error instanceof TrainingRuntimeConfigError &&
      error.code === 'TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED_INVALID',
  );
});

test('question generation routing defaults to terra_only and requires exact official models', () => {
  assert.deepEqual(readQuestionGenerationRoutingConfig({}), {
    strategy: 'terra_only',
    routingVersion: 'luna-terra-router-v1',
    validatorVersion: 'training-question-validator-v1',
    primaryModel: 'gpt-5.6-terra',
    fallbackModel: null,
    terraModel: 'gpt-5.6-terra',
    lunaModel: 'gpt-5.6-luna',
  });
  assert.equal(readQuestionGenerationRoutingConfig({
    OPENAI_QUESTION_GENERATION_STRATEGY: 'luna_then_terra',
  }).primaryModel, 'gpt-5.6-luna');
  assert.throws(
    () => readQuestionGenerationRoutingConfig({
      OPENAI_QUESTION_GENERATION_MODEL: 'gpt-5.6-luna',
    }),
    /OPENAI_QUESTION_GENERATION_MODEL_INVALID/,
  );
});

test('production disabled mode preserves a safe fake configuration', () => {
  assert.deepEqual(validateTrainingRuntimeConfig({
    NODE_ENV: 'production',
    TRAINING_MODULE_ENABLED: 'false',
    TELEGRAM_TRANSPORT_MODE: 'fake',
    TRAINING_AI_MODE: 'fake',
  }), { enabled: false });
});

test('production enabled mode requires real providers, HTTPS and pairwise distinct buckets', () => {
  assert.deepEqual(validateTrainingRuntimeConfig(validProductionEnvironment()), { enabled: true });
  assert.deepEqual(validateTrainingRuntimeConfig({
    ...validProductionEnvironment(),
    TELEGRAM_WEBHOOK_URL:
      'https://training.fluffywhite.moscow/api/training/telegram/webhook',
  }), { enabled: true });

  const invalidCases = [
    ['TELEGRAM_TRANSPORT_MODE', 'fake'],
    ['TRAINING_AI_MODE', 'fake'],
    ['TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED', 'TRUE'],
    ['OPENAI_QUESTION_GENERATION_STRATEGY', 'luna_first'],
    ['OPENAI_QUESTION_GENERATION_MODEL', 'gpt-5.6-luna'],
    ['OPENAI_QUESTION_GENERATION_LUNA_MODEL', 'gpt-5.6-terra'],
    ['PUBLIC_APP_URL', 'http://platforma.fluffywhite.moscow'],
    ['PUBLIC_APP_URL', 'https://127.0.0.1'],
    ['PUBLIC_APP_URL', 'https://10.1.2.3'],
    ['TELEGRAM_WEBHOOK_URL', 'https://training.fluffywhite.moscow/not-webhook'],
    ['TELEGRAM_WEBHOOK_URL', 'https://localhost/training/telegram/webhook'],
    ['TRAINING_AUDIO_BUCKET', 'platforma'],
    ['TRAINING_MATERIAL_BUCKET', 'Invalid_Bucket'],
    ['OPENAI_QUESTION_GENERATION_MODEL', ''],
    ['OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS', '4999'],
    ['OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS', '120001'],
    ['OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS', 'not-a-number'],
    ['OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS', '   '],
    ['OPENAI_EVALUATOR_MODEL', ''],
  ];

  for (const [key, value] of invalidCases) {
    const environment = { ...validProductionEnvironment(), [key]: value };
    assert.throws(() => validateTrainingRuntimeConfig(environment), TrainingRuntimeConfigError);
  }
});

test('production evaluator model validation follows primary then legacy fallback precedence', () => {
  const legacyOnly = validProductionEnvironment();
  delete legacyOnly.OPENAI_EVALUATOR_MODEL;
  legacyOnly.OPENAI_EVALUATION_MODEL = 'gpt-5.6-terra';
  assert.deepEqual(validateTrainingRuntimeConfig(legacyOnly), { enabled: true });

  const invalidPrimary = {
    ...legacyOnly,
    OPENAI_EVALUATOR_MODEL: 'placeholder',
  };
  assert.throws(
    () => validateTrainingRuntimeConfig(invalidPrimary),
    (error) => error instanceof TrainingRuntimeConfigError &&
      error.code === 'OPENAI_EVALUATOR_MODEL_INVALID',
  );
});

test('production validation errors are redacted and never contain configured secrets', () => {
  const environment = validProductionEnvironment();
  environment.PUBLIC_APP_URL = `https://${environment.TELEGRAM_WEBHOOK_SECRET}.localhost`;

  assert.throws(
    () => validateTrainingRuntimeConfig(environment),
    (error) => {
      assert.equal(error instanceof TrainingRuntimeConfigError, true);
      assert.equal(error.message, 'PUBLIC_APP_URL_INVALID');
      assert.doesNotMatch(error.message, /safe_webhook_secret|sk-live/iu);
      return true;
    },
  );
});

test('feature guard blocks disabled actions with one safe code', () => {
  const previous = process.env.TRAINING_MODULE_ENABLED;
  process.env.TRAINING_MODULE_ENABLED = 'false';

  try {
    assert.throws(
      () => new TrainingFeatureGuard().canActivate(),
      (error) => error instanceof ServiceUnavailableException &&
        error.getResponse().message === 'TRAINING_MODULE_DISABLED',
    );
  } finally {
    if (previous === undefined) delete process.env.TRAINING_MODULE_ENABLED;
    else process.env.TRAINING_MODULE_ENABLED = previous;
  }
});

test('health response has a strict safe allowlist on success and failure', async () => {
  const previous = process.env.TRAINING_MODULE_ENABLED;
  process.env.TRAINING_MODULE_ENABLED = 'true';

  try {
    const healthy = new HealthController({ $queryRaw: async () => [{ '?column?': 1 }] });
    assert.deepEqual(await healthy.check(), {
      status: 'ok', database: 'ok', training: 'ready',
    });

    const failing = new HealthController({
      $queryRaw: async () => { throw new Error('postgresql://secret@host/private'); },
    });
    await assert.rejects(
      () => failing.check(),
      (error) => {
        assert.equal(error instanceof ServiceUnavailableException, true);
        assert.deepEqual(error.getResponse(), {
          status: 'error', database: 'unavailable', training: 'degraded',
        });
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.TRAINING_MODULE_ENABLED;
    else process.env.TRAINING_MODULE_ENABLED = previous;
  }
});

test('webhook register builds the exact secret and allowed-updates request', () => {
  const environment = validProductionEnvironment();
  const operation = createOperation('register', environment);

  assert.equal(operation.method, 'setWebhook');
  assert.equal(operation.body.url, environment.TELEGRAM_WEBHOOK_URL);
  assert.equal(operation.body.secret_token, environment.TELEGRAM_WEBHOOK_SECRET);
  assert.deepEqual(operation.body.allowed_updates, ALLOWED_UPDATES);
  assert.equal(operation.body.drop_pending_updates, false);
  assert.throws(() => validateWebhookUrl('http://example.com/training/telegram/webhook'));
  assert.throws(() => validateWebhookUrl('https://127.0.0.1/training/telegram/webhook'));
  assert.throws(() => validateWebhookUrl('https://[fd00::1]/training/telegram/webhook'));
});

test('webhook commands support dry-run, require delete confirmation and redact provider data', async () => {
  const environment = validProductionEnvironment();
  const dryRun = await executeWebhookCommand({
    action: 'register', args: ['--dry-run'], environment,
  });
  assert.deepEqual(dryRun, { ok: true, action: 'register', dryRun: true });
  await assert.rejects(
    () => executeWebhookCommand({ action: 'delete', environment }),
    /WEBHOOK_DELETE_CONFIRMATION_REQUIRED/u,
  );

  const calls = [];
  const status = await executeWebhookCommand({
    action: 'status',
    environment,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        ok: true,
        result: {
          url: environment.TELEGRAM_WEBHOOK_URL,
          pending_update_count: 7,
          last_error_date: 123,
          last_error_message: environment.TELEGRAM_WEBHOOK_SECRET,
        },
      }), { status: 200 });
    },
  });

  assert.deepEqual(status, {
    ok: true, action: 'status', registered: true, pendingUpdateCount: 7, hasLastError: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(status).includes(environment.TELEGRAM_BOT_TOKEN), false);
  assert.equal(JSON.stringify(status).includes(environment.TELEGRAM_WEBHOOK_SECRET), false);
});

test('webhook register uses only a bounded local Telegram stub in tests', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const environment = {
      ...validProductionEnvironment(),
      NODE_ENV: 'test',
      TELEGRAM_TEST_API_ORIGIN: `http://127.0.0.1:${address.port}`,
    };
    const result = await executeWebhookCommand({ action: 'register', environment });

    assert.deepEqual(result, { ok: true, action: 'register', dryRun: false });
    assert.equal(requests.length, 1);
    assert.match(requests[0].path, /^\/bot[^/]+\/setWebhook$/u);
    assert.deepEqual(requests[0].body.allowed_updates, ['message', 'callback_query']);
    assert.equal(requests[0].body.secret_token, environment.TELEGRAM_WEBHOOK_SECRET);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('production startup probe fails before Nest bootstrap with a redacted config code', () => {
  const root = resolve(__dirname, '../../..');
  const secret = 'startup-probe-secret-must-not-leak';
  const result = spawnSync(process.execPath, ['dist/main.js'], {
    cwd: resolve(root, 'apps/api'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TRAINING_MODULE_ENABLED: 'true',
      TELEGRAM_TRANSPORT_MODE: 'fake',
      TELEGRAM_WEBHOOK_SECRET: secret,
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /TELEGRAM_TRANSPORT_MODE_INVALID/u);
  assert.doesNotMatch(output, new RegExp(secret, 'u'));
});

test('Docker and ordinary-test contracts preserve signal, ffmpeg and opt-in OpenAI boundaries', () => {
  const root = resolve(__dirname, '../../..');
  const dockerfile = readFileSync(resolve(root, 'apps/api/Dockerfile'), 'utf8');
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  const main = readFileSync(resolve(root, 'apps/api/src/main.ts'), 'utf8');
  const ordinaryTests = readFileSync(resolve(root, 'apps/api/tests/run-tests.cjs'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

  assert.match(dockerfile, /apk add --no-cache chromium ffmpeg/u);
  assert.match(dockerfile, /exec node apps\/api\/dist\/main\.js/u);
  assert.match(main, /enableShutdownHooks\(\['SIGTERM', 'SIGINT'\]\)/u);
  assert.match(compose, /stop_grace_period: 30s/u);
  assert.match(compose, /TRAINING_VOICE_WORKER_CONCURRENCY/u);
  assert.doesNotMatch(compose, /training[-_ ]voice[-_ ]worker:\s*\n/iu);
  assert.match(ordinaryTests, /TRAINING_AI_MODE = 'fake'/u);
  assert.match(ordinaryTests, /delete environment\.OPENAI_API_KEY/u);
  assert.notEqual(packageJson.scripts.test, packageJson.scripts['test:training:openai:smoke']);
  assert.doesNotMatch(packageJson.scripts.test, /openai.*smoke/iu);
  assert.notEqual(
    packageJson.scripts.test,
    packageJson.scripts['benchmark:training:question-budget'],
  );
  assert.doesNotMatch(packageJson.scripts.test, /question.*budget.*benchmark/iu);
});
