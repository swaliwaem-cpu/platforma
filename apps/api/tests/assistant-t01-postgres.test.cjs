require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { JwtService } = require('@nestjs/jwt');
const { NestFactory } = require('@nestjs/core');
const { PrismaClient, UserStatus } = require('@prisma/client');

const databaseUrl = process.env.ASSISTANT_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Assistant T01 PostgreSQL scenarios require the targeted runner', () => {
    assert.equal(process.env.ASSISTANT_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.ASSISTANT_MODULE_ENABLED = 'true';
  process.env.ASSISTANT_FAKE_STEP_DELAY_MS = '1';
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'assistant-t01-http-access-secret';
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TRAINING_MODULE_ENABLED = 'false';

  const { AppModule } = require('../dist/app.module.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let owner;
  let otherUser;
  let deniedUser;
  let ownerToken;
  let otherToken;
  let deniedToken;

  before(async () => {
    await prisma.$connect();
    await clearData();
    owner = await createUser('owner', true);
    otherUser = await createUser('other', true);
    deniedUser = await createUser('denied', false);
    ownerToken = signAccessToken(owner);
    otherToken = signAccessToken(otherUser);
    deniedToken = signAccessToken(deniedUser);

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
    await clearData();
    await prisma.$disconnect();
  });

  test('assistant config and actions require auth, objects read permission and enabled feature state', async () => {
    assert.equal((await request('/assistant/config')).status, 401);
    assert.equal((await request('/assistant/config', { token: deniedToken })).status, 403);
    assert.deepEqual(await request('/assistant/config', { token: ownerToken }), {
      status: 200,
      body: { enabled: true },
    });

    process.env.ASSISTANT_MODULE_ENABLED = 'false';
    try {
      assert.deepEqual(await request('/assistant/config', { token: ownerToken }), {
        status: 200,
        body: { enabled: false },
      });
      const blocked = await request('/assistant/conversations', {
        method: 'POST',
        token: ownerToken,
      });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.body.message, 'ASSISTANT_MODULE_DISABLED');
    } finally {
      process.env.ASSISTANT_MODULE_ENABLED = 'true';
    }
  });

  test('authenticated user receives one persisted fake run with safe progress and idempotent replay', async () => {
    const created = await request('/assistant/conversations', {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.conversation.ownerUserId, undefined);
    assert.equal(created.body.conversation.title, 'Новый разговор');

    const input = {
      content: 'Найди подходящий объект',
      context: {
        kind: 'OBJECT',
        key: 'zhk-test',
        label: 'Текущий ЖК',
      },
    };
    const idempotencyKey = randomUUID();
    const queued = await sendMessage(created.body.conversation.id, input, idempotencyKey);
    assert.equal(queued.status, 202);
    assert.equal(queued.body.run.status === 'PENDING' || queued.body.run.status === 'RUNNING', true);

    const completed = await waitForRun(queued.body.run.id, ownerToken);
    assert.equal(completed.status, 'COMPLETED');
    assert.deepEqual(
      completed.progressEvents.map(({ step, label }) => [step, label]),
      [
        ['UNDERSTANDING', 'Понимаю запрос'],
        ['SEARCHING', 'Ищу данные'],
        ['COMPARING', 'Сравниваю варианты'],
        ['ANSWERING', 'Формирую ответ'],
      ],
    );
    assert.equal(
      completed.assistantMessage.content,
      'Тестовый помощник получил запрос: «Найди подходящий объект».',
    );

    const replay = await sendMessage(created.body.conversation.id, input, idempotencyKey);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.run.id, completed.id);

    const detail = await request(`/assistant/conversations/${created.body.conversation.id}`, {
      token: ownerToken,
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(
      detail.body.conversation.messages.map((message) => message.role),
      ['USER', 'ASSISTANT'],
    );
    assert.deepEqual(detail.body.conversation.messages[0].context, input.context);
    assert.equal(detail.body.conversation.messages[1].context, null);

    const conflict = await sendMessage(
      created.body.conversation.id,
      { ...input, content: 'Другой запрос' },
      idempotencyKey,
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.message, 'ASSISTANT_IDEMPOTENCY_KEY_REUSED');
  });

  test('conversation and run ownership fail closed without exposing another user data', async () => {
    const created = await request('/assistant/conversations', {
      method: 'POST',
      token: ownerToken,
    });
    const queued = await sendMessage(
      created.body.conversation.id,
      { content: 'Приватный запрос', context: null },
      randomUUID(),
    );
    await waitForRun(queued.body.run.id, ownerToken);

    assert.equal((await request(
      `/assistant/conversations/${created.body.conversation.id}`,
      { token: otherToken },
    )).status, 404);
    assert.equal((await request(
      `/assistant/runs/${queued.body.run.id}`,
      { token: otherToken },
    )).status, 404);

    const ownerHistory = await request('/assistant/conversations', { token: ownerToken });
    const otherHistory = await request('/assistant/conversations', { token: otherToken });
    assert.equal(ownerHistory.body.items.some((item) => item.id === created.body.conversation.id), true);
    assert.equal(otherHistory.body.items.some((item) => item.id === created.body.conversation.id), false);
  });

  test('history excludes conversations inactive for more than 30 days and input validation is bounded', async () => {
    const old = await request('/assistant/conversations', {
      method: 'POST',
      token: ownerToken,
    });
    await prisma.assistantConversation.update({
      where: { id: old.body.conversation.id },
      data: { updatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });

    const history = await request('/assistant/conversations', { token: ownerToken });
    assert.equal(history.body.items.some((item) => item.id === old.body.conversation.id), false);
    assert.equal((await sendMessage(old.body.conversation.id, { content: '   ' }, randomUUID())).status, 400);
    assert.equal((await request(`/assistant/conversations/${old.body.conversation.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'Без ключа' },
    })).status, 400);
  });

  function sendMessage(conversationId, body, idempotencyKey) {
    return request(`/assistant/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: ownerToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    });
  }

  async function waitForRun(runId, token) {
    const deadline = Date.now() + 3_000;

    do {
      const response = await request(`/assistant/runs/${runId}`, { token });
      if (response.status !== 200) throw new Error(`RUN_READ_FAILED_${response.status}`);
      if (response.body.run.status === 'COMPLETED' || response.body.run.status === 'FAILED') {
        return response.body.run;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);

    throw new Error('ASSISTANT_RUN_TIMEOUT');
  }

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }

  function signAccessToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, type: 'access' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '1h' },
    );
  }

  async function createUser(label, canReadObjects) {
    const permission = canReadObjects
      ? await prisma.permission.upsert({
          where: { key: 'objects:read' },
          update: {},
          create: { key: 'objects:read', description: 'Read objects' },
        })
      : null;
    const role = await prisma.role.create({
      data: {
        name: `assistant-t01-${label}-${randomUUID().slice(0, 8)}`,
        description: label,
        ...(permission
          ? { permissions: { create: { permissionId: permission.id } } }
          : {}),
      },
    });

    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@assistant-t01.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }

  async function clearData() {
    if (prisma.assistantRun) await prisma.assistantRun.deleteMany();
    if (prisma.assistantMessage) await prisma.assistantMessage.deleteMany();
    if (prisma.assistantConversation) await prisma.assistantConversation.deleteMany();
    await prisma.user.deleteMany({
      where: { email: { endsWith: '@assistant-t01.test' } },
    });
    await prisma.role.deleteMany({
      where: { name: { startsWith: 'assistant-t01-' } },
    });
  }
}
