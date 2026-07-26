require('reflect-metadata');

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const { TrainingModule } = require('../dist/training/training.module.js');
const {
  encodeFinishCallback,
  encodeProjectCallback,
  encodeStartCallback,
  parseTrainingTelegramCallback,
} = require('../dist/training/telegram/training-telegram.callback.js');
const {
  TrainingTelegramConfig,
} = require('../dist/training/telegram/training-telegram.config.js');
const {
  TrainingTelegramController,
  TrainingTelegramWebhookController,
} = require('../dist/training/telegram/training-telegram.controller.js');
const {
  hashTrainingLinkToken,
} = require('../dist/training/telegram/training-telegram-link.service.js');
const {
  FakeTrainingTelegramTransport,
  FetchTrainingTelegramTransport,
  TRAINING_TELEGRAM_TRANSPORT,
  TrainingTelegramTransportError,
} = require('../dist/training/telegram/training-telegram.transport.js');
const {
  sanitizeTelegramUpdate,
} = require('../dist/training/telegram/training-telegram.update.js');
const {
  TrainingTelegramWebhookService,
} = require('../dist/training/telegram/training-telegram-webhook.service.js');

const rootDir = resolve(__dirname, '../../..');
const apiPackage = JSON.parse(
  readFileSync(resolve(rootDir, 'apps/api/package.json'), 'utf8'),
);
const productionCompose = readFileSync(
  resolve(rootDir, 'docker-compose.production.yml'),
  'utf8',
);
const developmentCompose = readFileSync(
  resolve(rootDir, 'docker-compose.yml'),
  'utf8',
);
const apiDockerfile = readFileSync(
  resolve(rootDir, 'apps/api/Dockerfile'),
  'utf8',
);
const bootstrapSource = readFileSync(
  resolve(rootDir, 'apps/api/src/main.ts'),
  'utf8',
);

test('Telegram callback_data stays below 64 bytes and identifies exact entities', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const questionId = '22222222-2222-4222-8222-222222222222';
  const project = encodeProjectCallback(projectId);
  const start = encodeStartCallback(projectId);
  const finish = encodeFinishCallback(questionId);

  for (const value of [project, start, finish]) {
    assert.ok(Buffer.byteLength(value, 'utf8') <= 64);
  }
  assert.deepEqual(parseTrainingTelegramCallback(project), {
    action: 'PROJECT',
    projectId,
  });
  assert.deepEqual(parseTrainingTelegramCallback(start), {
    action: 'START',
    projectId,
  });
  assert.deepEqual(parseTrainingTelegramCallback(finish), {
    action: 'FINISH',
    attemptQuestionId: questionId,
  });
  assert.deepEqual(parseTrainingTelegramCallback('tr:projects'), {
    action: 'PROJECTS',
  });
  assert.equal(parseTrainingTelegramCallback('tr:f:not-a-uuid'), null);
});

test('webhook sanitization stores only a link-token hash', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDE_1234567890';
  const ingress = sanitizeTelegramUpdate(
    privateTextUpdate(1, 10, `/start ${token}`),
    new Date('2026-07-26T10:00:00.000Z'),
  );
  const serialized = JSON.stringify(ingress.payload);

  assert.equal(ingress.payload.content.kind, 'COMMAND');
  assert.equal(ingress.payload.content.command, 'START');
  assert.equal(ingress.payload.content.startTokenHash, hashTrainingLinkToken(token));
  assert.equal(serialized.includes(token), false);
  assert.equal(ingress.payload.content.startTokenHash.length, 64);
});

test('only message.voice is classified as voice', () => {
  const voice = sanitizeTelegramUpdate({
    update_id: 2,
    message: {
      message_id: 20,
      date: 1_785_057_600,
      chat: { id: 100, type: 'private' },
      from: { id: 100, first_name: 'User' },
      voice: {
        file_id: 'voice-file',
        file_unique_id: 'voice-unique',
        duration: 12,
      },
    },
  });
  const audio = sanitizeTelegramUpdate({
    update_id: 3,
    message: {
      message_id: 21,
      date: 1_785_057_600,
      chat: { id: 100, type: 'private' },
      from: { id: 100, first_name: 'User' },
      audio: { file_id: 'audio-file' },
    },
  });

  assert.equal(voice.payload.content.kind, 'VOICE');
  assert.equal(audio.payload.content.kind, 'REJECTED');
  assert.equal(audio.payload.content.rejectedType, 'audio');
});

test('private chat boundary rejects groups and channels before queuing', () => {
  const groupIngress = sanitizeTelegramUpdate({
    update_id: 4,
    message: {
      message_id: 22,
      date: 1_785_057_600,
      chat: { id: -100, type: 'group' },
      from: { id: 100, first_name: 'User' },
      text: '/start',
    },
  });
  const channelIngress = sanitizeTelegramUpdate({
    update_id: 5,
    channel_post: {
      message_id: 23,
      date: 1_785_057_600,
      chat: { id: -101, type: 'channel' },
      text: '/start',
    },
  });

  for (const ingress of [groupIngress, channelIngress]) {
    assert.equal(ingress.rejectionCode, 'PRIVATE_CHAT_REQUIRED');
    assert.equal(ingress.payload, undefined);
    assert.equal(ingress.jobIdempotencyKey, undefined);
  }
});

test('webhook secret comparison rejects a wrong secret', () => {
  const service = new TrainingTelegramWebhookService(
    {},
    { webhookSecret: 'correct-secret' },
  );
  assert.throws(
    () => service.verifySecret('wrong-secret'),
    /Telegram webhook secret is invalid/,
  );
  assert.doesNotThrow(() => service.verifySecret('correct-secret'));
});

test('fake Telegram transport is deterministic and idempotent', async () => {
  const transport = new FakeTrainingTelegramTransport();
  const input = {
    idempotencyKey: 'message:1',
    chatId: '100',
    text: 'Hello',
  };
  await transport.sendMessage(input);
  await transport.sendMessage(input);
  await transport.answerCallbackQuery({
    idempotencyKey: 'callback:1',
    callbackQueryId: 'callback-id',
  });
  await transport.answerCallbackQuery({
    idempotencyKey: 'callback:1',
    callbackQueryId: 'callback-id',
  });

  assert.equal(transport.deliveries.length, 2);
  assert.deepEqual(
    transport.deliveries.map((delivery) => delivery.operation),
    ['SEND_MESSAGE', 'ANSWER_CALLBACK'],
  );
});

test('fetch Telegram transport uses server-side Bot API without an SDK', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  try {
    const transport = new FetchTrainingTelegramTransport(
      '123456:TEST_TOKEN',
      'https://telegram.test',
    );
    await transport.sendMessage({
      idempotencyKey: 'fetch:1',
      chatId: '100',
      text: 'Test',
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /telegram\.test\/bot.*\/sendMessage$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(apiPackage.dependencies.telegraf, undefined);
  assert.equal(apiPackage.dependencies.grammy, undefined);
});

test('Telegram controllers expose employee and unguarded webhook routes', () => {
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingTelegramController.prototype.getAccount,
    ),
    ['training:take'],
  );
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingTelegramController.prototype.createProjectStartLink,
    ),
    ['training:take'],
  );
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingTelegramController.prototype.getAttempt,
    ),
    ['training:own-results:read'],
  );
  const controllers = Reflect.getMetadata('controllers', TrainingModule);
  const providers = Reflect.getMetadata('providers', TrainingModule);
  assert.ok(controllers.includes(TrainingTelegramController));
  assert.ok(controllers.includes(TrainingTelegramWebhookController));
  assert.ok(
    providers.some(
      (provider) => provider?.provide === TRAINING_TELEGRAM_TRANSPORT,
    ),
  );
});

test('Telegram config permits fake transport for local development', () => {
  const config = new TrainingTelegramConfig({
    NODE_ENV: 'development',
    TRAINING_MODULE_ENABLED: 'false',
    TELEGRAM_TRANSPORT_MODE: 'fake',
    TELEGRAM_BOT_USERNAME: 'platforma_training_bot',
    PUBLIC_APP_URL: 'http://localhost:5173',
  });

  assert.equal(config.transportMode, 'fake');
  assert.equal(config.usesFakeTransport, true);
  assert.equal(config.linkTokenTtlMinutes, 15);
  assert.equal(config.publicTrainingUrl, 'http://localhost:5173/training');
});

test('production Compose fixes real mode and requires every Telegram value', () => {
  assert.match(
    developmentCompose,
    /^\s*NODE_ENV:\s*\$\{NODE_ENV:-development\}\s*$/mu,
  );
  assert.match(
    developmentCompose,
    /^\s*TELEGRAM_TRANSPORT_MODE:\s*\$\{TELEGRAM_TRANSPORT_MODE:-fake\}\s*$/mu,
  );
  assert.match(productionCompose, /^\s*NODE_ENV:\s*production\s*$/mu);
  assert.match(
    productionCompose,
    /^\s*TELEGRAM_TRANSPORT_MODE:\s*real\s*$/mu,
  );
  for (const name of [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_USERNAME',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_WEBHOOK_URL',
    'PUBLIC_APP_URL',
  ]) {
    const assignment = productionCompose
      .split('\n')
      .find((line) => line.trimStart().startsWith(`${name}:`));
    assert.ok(assignment, `${name} must be present in production Compose`);
    assert.match(
      assignment,
      new RegExp(`\\$\\{${name}:\\?${name} is required\\}`, 'u'),
    );
    assert.doesNotMatch(
      assignment,
      /localhost|127\.0\.0\.1|platforma_training_bot|\$\{[^}]+:-/iu,
    );
  }
});

test('Docker and Nest bootstrap preserve the complete SIGTERM path', () => {
  assert.match(
    bootstrapSource,
    /app\.enableShutdownHooks\(\['SIGTERM', 'SIGINT'\]\)/u,
  );
  assert.match(developmentCompose, /^\s*stop_grace_period:\s*30s\s*$/mu);
  assert.match(
    apiDockerfile,
    /CMD \["sh", "-c", "pnpm --dir apps\/api exec prisma migrate deploy && exec node apps\/api\/dist\/main\.js"\]/u,
  );
  assert.doesNotMatch(
    apiDockerfile,
    /CMD \[[^\n]*pnpm --filter @platforma\/api start/u,
  );
});

test('Telegram config fails fast for unsafe production and incomplete real modes', () => {
  const real = {
    NODE_ENV: 'production',
    TRAINING_MODULE_ENABLED: 'true',
    TELEGRAM_TRANSPORT_MODE: 'real',
    TELEGRAM_BOT_TOKEN: 'secret-token-that-must-not-leak',
    TELEGRAM_BOT_USERNAME: '@platforma_real_bot',
    TELEGRAM_WEBHOOK_SECRET: 'secret-header-that-must-not-leak',
    TELEGRAM_WEBHOOK_URL:
      'https://api.fluffywhite.moscow/training/telegram/webhook',
    PUBLIC_APP_URL: 'https://app.fluffywhite.moscow',
  };

  assert.throws(
    () =>
      new TrainingTelegramConfig({
        ...real,
        TELEGRAM_TRANSPORT_MODE: undefined,
      }),
    /TELEGRAM_TRANSPORT_MODE is required/,
  );
  assert.throws(
    () =>
      new TrainingTelegramConfig({
        ...real,
        TELEGRAM_TRANSPORT_MODE: 'fake',
      }),
    /must be real/,
  );
  for (const name of [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_USERNAME',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_WEBHOOK_URL',
    'PUBLIC_APP_URL',
  ]) {
    assert.throws(
      () => new TrainingTelegramConfig({ ...real, [name]: '' }),
      new RegExp(`${name} is required`, 'u'),
    );
  }
  assert.throws(
    () =>
      new TrainingTelegramConfig({
        ...real,
        TELEGRAM_WEBHOOK_URL: 'http://api.example.test/webhook',
      }),
    /TELEGRAM_WEBHOOK_URL must use HTTPS/,
  );
  assert.throws(
    () =>
      new TrainingTelegramConfig({
        ...real,
        PUBLIC_APP_URL: 'http://app.example.test',
      }),
    /PUBLIC_APP_URL must use HTTPS/,
  );
  assert.throws(
    () =>
      new TrainingTelegramConfig({
        NODE_ENV: 'staging',
        TRAINING_MODULE_ENABLED: 'true',
        TELEGRAM_TRANSPORT_MODE: 'fake',
        PUBLIC_APP_URL: 'https://app.fluffywhite.moscow',
      }),
    /allowed only for local development and tests/,
  );

  const config = new TrainingTelegramConfig(real);
  assert.equal(config.transportMode, 'real');
  assert.equal(config.botUsername, 'platforma_real_bot');
  assert.equal(
    config.publicTrainingUrl,
    'https://app.fluffywhite.moscow/training',
  );
  for (const unsafe of [
    'secret-token-that-must-not-leak',
    'secret-header-that-must-not-leak',
  ]) {
    let message = '';
    try {
      new TrainingTelegramConfig({
        ...real,
        TELEGRAM_WEBHOOK_URL: unsafe,
      });
    } catch (error) {
      message = error.message;
    }
    assert.equal(message.includes(unsafe), false);
  }
});

test('production startup rejects missing secrets, local URLs and placeholders', () => {
  const real = {
    NODE_ENV: 'production',
    TRAINING_MODULE_ENABLED: 'false',
    TELEGRAM_TRANSPORT_MODE: 'real',
    TELEGRAM_BOT_TOKEN: '123456789:AAProductionTokenValue',
    TELEGRAM_BOT_USERNAME: 'platforma_real_bot',
    TELEGRAM_WEBHOOK_SECRET: 'production-webhook-secret-value',
    TELEGRAM_WEBHOOK_URL:
      'https://api.fluffywhite.moscow/training/telegram/webhook',
    PUBLIC_APP_URL: 'https://app.fluffywhite.moscow',
  };

  assert.throws(
    () =>
      new TrainingTelegramConfig({
        NODE_ENV: 'production',
        TRAINING_MODULE_ENABLED: 'false',
        TELEGRAM_TRANSPORT_MODE: 'real',
      }),
    /TELEGRAM_BOT_TOKEN is required/u,
  );
  for (const [name, value] of [
    ['TELEGRAM_BOT_TOKEN', 'REPLACE_WITH_REAL_TELEGRAM_BOT_TOKEN'],
    ['TELEGRAM_BOT_USERNAME', 'platforma_training_bot'],
    ['TELEGRAM_WEBHOOK_SECRET', 'fake-secret'],
  ]) {
    assert.throws(
      () => new TrainingTelegramConfig({ ...real, [name]: value }),
      new RegExp(`${name} must not use a placeholder value`, 'u'),
    );
  }
  for (const [name, value] of [
    [
      'TELEGRAM_WEBHOOK_URL',
      'https://localhost/training/telegram/webhook',
    ],
    ['TELEGRAM_WEBHOOK_URL', 'https://127.0.0.1/webhook'],
    ['TELEGRAM_WEBHOOK_URL', 'https://api.example.ru/webhook'],
    ['PUBLIC_APP_URL', 'https://app.example.test'],
  ]) {
    assert.throws(
      () => new TrainingTelegramConfig({ ...real, [name]: value }),
      new RegExp(`${name} must use a non-placeholder production host`, 'u'),
    );
  }
});

test('fetch Telegram transport classifies retryable and permanent failures', async () => {
  const originalFetch = global.fetch;
  const cases = [
    {
      response: telegramResponse(429, {
        ok: false,
        error_code: 429,
        parameters: { retry_after: 3 },
      }),
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: 3_000,
    },
    {
      response: telegramResponse(503, { ok: false, error_code: 503 }),
      code: 'SERVER_ERROR',
      retryable: true,
    },
    {
      response: telegramResponse(200, { ok: false, error_code: 400 }),
      code: 'PERMANENT_CLIENT_ERROR',
      retryable: false,
    },
    {
      response: telegramResponse(401, { ok: false, error_code: 401 }),
      code: 'PERMANENT_CLIENT_ERROR',
      retryable: false,
    },
    {
      response: {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('malformed JSON');
        },
      },
      code: 'INVALID_RESPONSE',
      retryable: true,
    },
    {
      error: new Error('socket closed'),
      code: 'NETWORK_ERROR',
      retryable: true,
    },
    {
      error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      code: 'TIMEOUT',
      retryable: true,
    },
  ];

  try {
    for (const current of cases) {
      global.fetch = async () => {
        if (current.error) throw current.error;
        return current.response;
      };
      const transport = new FetchTrainingTelegramTransport(
        '123456:TEST_TOKEN',
        'https://telegram.test',
      );
      await assert.rejects(
        transport.sendMessage({
          idempotencyKey: `classification:${current.code}`,
          chatId: '100',
          text: 'Test',
        }),
        (error) => {
          assert.ok(error instanceof TrainingTelegramTransportError);
          assert.equal(error.code, current.code);
          assert.equal(error.retryable, current.retryable);
          assert.equal(error.retryAfterMs, current.retryAfterMs);
          assert.equal(error.message.includes('123456:TEST_TOKEN'), false);
          return true;
        },
      );
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('unsupported or malformed Telegram payloads are acknowledged without throwing', async () => {
  const malformedPayloads = [
    { update_id: 80, message: { chat: null } },
    {
      update_id: 81,
      callback_query: {
        id: 'callback-without-message',
        from: { id: 100 },
        data: 'tr:projects',
      },
    },
    {
      update_id: 82,
      callback_query: {
        id: 'inline-callback',
        inline_message_id: 'inline-id',
        from: { id: 100 },
        data: 'tr:projects',
      },
    },
    { update_id: 83, edited_message: { message_id: 1 } },
    { update_id: 84, business_message: { message_id: 1 } },
    {
      update_id: 85,
      message: {
        message_id: 1,
        date: 1_785_057_600,
        chat: { id: 100, type: 'private' },
        sender_chat: { id: 100, type: 'private' },
        text: 'sender chat',
      },
    },
    {
      update_id: 86,
      message: {
        message_id: 1,
        date: 1_785_057_600,
        chat: { id: 100, type: 'private' },
        from: { id: 100, first_name: 'User' },
        pinned_message: { message_id: 2 },
      },
    },
    {
      update_id: 87,
      message: {
        message_id: 1,
        date: 1_785_057_600,
        chat: { id: 100, type: 'private' },
        from: { id: 100, first_name: 'User' },
        voice: { file_id: '', duration: 'invalid' },
      },
    },
    {
      update_id: 88,
      message: {
        message_id: 1,
        date: 1_785_057_600,
        chat: { id: 100, type: 'private' },
        text: 'missing from',
      },
    },
    {
      update_id: 89,
      message: {
        message_id: 1,
        date: 1_785_057_600,
        from: { id: 100, first_name: 'User' },
        text: 'missing chat',
      },
    },
    {
      update_id: 90,
      message: {
        date: 1_785_057_600,
        chat: { id: 100, type: 'private' },
        from: { id: 100, first_name: 'User' },
        text: 'missing message id',
      },
    },
  ];
  const expectedCodes = [
    'MALFORMED_TELEGRAM_UPDATE',
    'CALLBACK_MESSAGE_REQUIRED',
    'INLINE_CALLBACK_UNSUPPORTED',
    'EDITED_MESSAGE_UNSUPPORTED',
    'UNSUPPORTED_UPDATE',
    'SENDER_CHAT_UNSUPPORTED',
    'SERVICE_MESSAGE_UNSUPPORTED',
    'MALFORMED_TELEGRAM_UPDATE',
    'MALFORMED_TELEGRAM_UPDATE',
    'MALFORMED_TELEGRAM_UPDATE',
    'MALFORMED_TELEGRAM_UPDATE',
  ];

  malformedPayloads.forEach((payload, index) => {
    const ingress = sanitizeTelegramUpdate(payload);
    assert.equal(ingress.rejectionCode, expectedCodes[index]);
    assert.equal(ingress.payload, undefined);
  });

  const service = new TrainingTelegramWebhookService(
    new Proxy(
      {},
      {
        get() {
          throw new Error('database must not be called');
        },
      },
    ),
    { webhookSecret: 'test-secret' },
  );
  assert.deepEqual(await service.acceptUpdate(null), {
    ok: true,
    duplicate: false,
    queued: false,
    rejected: true,
  });
});

function privateTextUpdate(updateId, messageId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_785_057_600,
      chat: { id: 100, type: 'private' },
      from: { id: 100, first_name: 'User' },
      text,
    },
  };
}

function telegramResponse(status, payload) {
  return {
    ok: status >= 200 && status <= 299,
    status,
    json: async () => payload,
  };
}
