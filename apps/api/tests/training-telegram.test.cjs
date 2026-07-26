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

test('Telegram config defaults to fake transport without a bot token', () => {
  const previous = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  };
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_USERNAME = 'platforma_training_bot';
    process.env.PUBLIC_APP_URL = 'http://localhost:5173';
    const config = new TrainingTelegramConfig();
    assert.equal(config.usesFakeTransport, true);
    assert.equal(config.linkTokenTtlMinutes, 15);
    assert.equal(config.publicTrainingUrl, 'http://localhost:5173/training');
  } finally {
    restoreEnv(previous);
  }
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

function restoreEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
