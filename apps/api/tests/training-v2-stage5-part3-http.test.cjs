require('reflect-metadata');

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 5 Part 3 HTTP scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.TRAINING_MODULE_ENABLED = 'false';
  process.env.TRAINING_VOICE_WORKER_ENABLED = 'false';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.JWT_ACCESS_SECRET = 'stage5-part3-http-access-secret';

  const { AppModule } = require('../dist/app.module.js');
  let app;
  let baseUrl;

  before(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => app?.close());

  test('disabled module keeps config and health safe while blocking employee/admin actions', async () => {
    const config = await request('/training/config');
    assert.deepEqual(config, { status: 200, body: { enabled: false } });

    const employee = await request('/training/projects');
    assert.equal(employee.status, 503);
    assert.equal(employee.body.message, 'TRAINING_MODULE_DISABLED');

    const admin = await request('/training/admin/projects');
    assert.equal(admin.status, 503);
    assert.equal(admin.body.message, 'TRAINING_MODULE_DISABLED');

    const health = await request('/health');
    assert.deepEqual(health, {
      status: 200,
      body: { status: 'ok', database: 'ok', training: 'disabled' },
    });
    assert.deepEqual(Object.keys(health.body).sort(), ['database', 'status', 'training']);
  });

  test('disabled webhook is a controlled no-op without secret or domain writes', async () => {
    const before = await request('/training/telegram/webhook', {
      method: 'POST',
      body: {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123 },
          chat: { id: 123, type: 'private' },
          voice: { file_id: 'ignored', file_unique_id: 'ignored', duration: 1 },
        },
      },
    });

    assert.deepEqual(before, { status: 200, body: { ok: true, disabled: true } });
  });

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
}
