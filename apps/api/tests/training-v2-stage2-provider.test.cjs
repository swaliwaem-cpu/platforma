require('reflect-metadata');

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  NativeTrainingTelegramClient,
  TrainingTelegramClientError,
} = require('../dist/training/training-telegram-client.js');

test('native Telegram client covers methods, bounded retry, timeout and safe errors', async (t) => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_TEST_API_ORIGIN: process.env.TELEGRAM_TEST_API_ORIGIN,
    TELEGRAM_REQUEST_TIMEOUT_MS: process.env.TELEGRAM_REQUEST_TIMEOUT_MS,
  };
  const token = 'stage2-provider-secret-token';
  const attempts = new Map();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const operation = url.pathname.split('/').at(-1);
    const attempt = (attempts.get(operation) ?? 0) + 1;
    attempts.set(operation, attempt);
    let body = '';

    for await (const chunk of request) body += chunk;
    requests.push({ operation, body });

    if (operation === 'sendMessage') {
      const payload = JSON.parse(body);

      if (payload.text === 'permanent') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error_code: 400 }));
        return;
      }

      if (attempt === 1) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error_code: 500 }));
        return;
      }
    }

    if (operation === 'answerCallbackQuery') {
      const payload = JSON.parse(body);

      if (payload.callback_query_id === 'timeout') return;
      if (attempt === 1) {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error_code: 429 }));
        return;
      }
    }

    if (operation === 'getFile') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        result: { file_path: 'voice/test.oga', file_size: 9 },
      }));
      return;
    }

    if (url.pathname.includes('/file/')) {
      response.writeHead(200, {
        'Content-Type': 'audio/ogg',
        'Content-Length': '9',
      });
      response.end(Buffer.from('OggS-test'));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: {} }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_TEST_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  process.env.TELEGRAM_REQUEST_TIMEOUT_MS = '1000';
  const client = new NativeTrainingTelegramClient();

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await client.sendMessage({ chatId: 123n, text: 'question' });
  await client.answerCallbackQuery('callback', 'accepted');
  const file = await client.getFile('telegram-file-id');
  const download = await client.downloadFile(file.filePath, 100);

  assert.equal(attempts.get('sendMessage'), 2);
  assert.equal(attempts.get('answerCallbackQuery'), 2);
  assert.deepEqual(file, { filePath: 'voice/test.oga', sizeBytes: 9 });
  assert.equal(download.body.toString(), 'OggS-test');
  assert.equal(download.mimeType, 'audio/ogg');
  assert.equal(
    requests.some(({ body }) => body.includes('telegram-file-id')),
    true,
  );

  await assert.rejects(
    () => client.sendMessage({ chatId: 123n, text: 'permanent' }),
    (error) => {
      assert.equal(error instanceof TrainingTelegramClientError, true);
      assert.equal(error.code, 'HTTP_400');
      assert.equal(error.retryable, false);
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
  process.env.TELEGRAM_REQUEST_TIMEOUT_MS = '100';
  await assert.rejects(
    () => client.answerCallbackQuery('timeout'),
    (error) => {
      assert.equal(error instanceof TrainingTelegramClientError, true);
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});
