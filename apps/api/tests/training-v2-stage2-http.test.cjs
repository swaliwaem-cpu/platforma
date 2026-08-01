require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const {
  PrismaClient,
  TrainingProjectStatus,
  TrainingQuestionType,
  UserStatus,
} = require('@prisma/client');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 2 HTTP scenarios require the targeted runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'training-v2-stage2-http-secret';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'stage2-http-webhook-secret';
  process.env.TELEGRAM_BOT_USERNAME = 'platforma_stage2_test_bot';

  const { TrainingModule } = require('../dist/training/training.module.js');
  const {
    FakeTrainingTelegramClient,
  } = require('../dist/training/training-telegram-client.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let client;
  let employee;
  let employeeToken;
  let project;

  before(async () => {
    await prisma.$connect();
    await clearTrainingData();
    employee = await createUser('stage2-http-employee');
    employeeToken = signAccessToken(employee);
    project = await createProject('Stage 2 HTTP', true);

    app = await NestFactory.create(TrainingModule, { logger: false });
    client = app.get(FakeTrainingTelegramClient);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
    await clearTrainingData();
    await prisma.$disconnect();
  });

  test('account and project-bound link endpoints enforce auth and availability', async () => {
    assert.equal((await request('/training/telegram/account')).status, 401);

    const account = await request('/training/telegram/account', { token: employeeToken });
    assert.equal(account.status, 200);
    assert.deepEqual(account.body, { linked: false, username: null, linkedAt: null });

    const link = await request(`/training/projects/${project.id}/telegram-link`, {
      token: employeeToken,
      method: 'POST',
    });
    assert.equal(link.status, 201);
    assert.match(link.body.url, /^https:\/\/t\.me\/platforma_stage2_test_bot\?start=/u);
    assert.equal(typeof link.body.expiresAt, 'string');
    assert.deepEqual(link.body.account, account.body);

    const rawToken = new URL(link.body.url).searchParams.get('start');
    const stored = await prisma.trainingTelegramLinkToken.findFirstOrThrow({
      where: { userId: employee.id, projectId: project.id },
    });
    assert.equal(stored.tokenHash.includes(rawToken), false);
    const ttlMs = stored.expiresAt.getTime() - stored.createdAt.getTime();
    assert.equal(ttlMs > 899_000 && ttlMs <= 900_000, true);

    const closed = await createProject('Closed Stage 2 HTTP', false);
    const closedLink = await request(`/training/projects/${closed.id}/telegram-link`, {
      token: employeeToken,
      method: 'POST',
    });
    assert.equal(closedLink.status >= 400, true);
  });

  test('webhook secret/private boundary and voice-only input keep HTTP work short', async () => {
    const wrongSecret = await webhook({ update_id: 1 }, 'wrong');
    assert.equal(wrongSecret.status, 403);

    const messagesBeforeGroup = client.sentMessages.length;
    const group = await webhook({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 501 },
        chat: { id: -501, type: 'group' },
        text: '/start ignored',
      },
    });
    assert.equal(group.status, 200);
    assert.equal(client.sentMessages.length, messagesBeforeGroup);

    const link = await request(`/training/projects/${project.id}/telegram-link`, {
      token: employeeToken,
      method: 'POST',
    });
    const rawToken = new URL(link.body.url).searchParams.get('start');
    assert.equal((await webhook(startUpdate(501, rawToken))).status, 200);
    const token = await prisma.trainingTelegramLinkToken.findFirstOrThrow({
      where: { userId: employee.id, usedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(
      (await webhook(callbackUpdate(501, `tr:start:${token.id}`, 'start-http'))).status,
      200,
    );

    const beforeRejected = await prisma.trainingAnswer.count();
    await webhook(messageUpdate(501, 10, { text: 'Обычный текст' }));
    await webhook(messageUpdate(501, 11, {
      audio: { file_id: 'audio-file', file_unique_id: 'audio-unique', duration: 1 },
    }));
    assert.equal(await prisma.trainingAnswer.count(), beforeRejected);
    assert.equal(
      client.sentMessages.filter(
        (message) => message.text === 'Ответ отправьте голосовым сообщением',
      ).length,
      2,
    );

    const voiceResponse = await webhook(messageUpdate(501, 12, {
      voice: {
        file_id: 'voice-file',
        file_unique_id: 'voice-unique',
        duration: 2,
        file_size: 1000,
      },
    }));
    assert.equal(voiceResponse.status, 200);
    assert.equal(await prisma.trainingAnswerSegment.count(), 1);
    assert.equal(
      client.sentMessages.some((message) =>
        message.inlineKeyboard?.flat().some((button) => button.text === 'Завершить ответ'),
      ),
      true,
    );

    const oversized = await webhook({ update_id: 99, ignored: 'x'.repeat(70 * 1024) });
    assert.equal(oversized.status, 413);
    assert.equal((await webhook({ update_id: 100, unknown: true })).status, 200);
  });

  test('webhook ACK does not wait for outbound Telegram network delivery', async () => {
    const originalSendMessage = client.sendMessage.bind(client);
    let releaseDelivery;
    const deliveryBarrier = new Promise((resolve) => { releaseDelivery = resolve; });
    let deliveryStarted = false;
    client.sendMessage = async (input) => {
      deliveryStarted = true;
      await deliveryBarrier;
      await originalSendMessage(input);
    };

    try {
      const startedAt = Date.now();
      const response = await webhook(messageUpdate(501, 101, { text: 'Не voice' }));
      const elapsedMs = Date.now() - startedAt;

      assert.equal(response.status, 200);
      assert.equal(elapsedMs < 500, true);
      await waitFor(() => deliveryStarted);
    } finally {
      releaseDelivery();
      await waitFor(() =>
        client.sentMessages.some(
          (message) => message.text === 'Ответ отправьте голосовым сообщением',
        ),
      );
      client.sendMessage = originalSendMessage;
    }
  });

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
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  function webhook(body, secret = process.env.TELEGRAM_WEBHOOK_SECRET) {
    return request('/training/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body,
    });
  }

  function signAccessToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, type: 'access' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '1h' },
    );
  }

  async function waitFor(predicate) {
    const deadline = Date.now() + 2_000;

    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for webhook delivery');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function createUser(label) {
    const permission = await prisma.permission.upsert({
      where: { key: 'training:participate' },
      update: {},
      create: { key: 'training:participate', description: 'Participate' },
    });
    const role = await prisma.role.create({
      data: {
        name: `training-test-${randomUUID().slice(0, 8)}`,
        description: label,
        permissions: { create: { permissionId: permission.id } },
      },
    });

    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }

  function createProject(title, isOpen) {
    return prisma.trainingProject.create({
      data: {
        title,
        description: null,
        status: isOpen ? TrainingProjectStatus.PUBLISHED : TrainingProjectStatus.DRAFT,
        isOpen,
        sortOrder: 0,
        attemptLimit: 3,
        timeLimitSeconds: 420,
        passScore: 75,
        allowRetakeAfterPass: true,
        questions: {
          create: [
            { type: TrainingQuestionType.MAIN, text: `${title} main`, position: 1 },
            ...Array.from({ length: 10 }, (_, index) => ({
              type: TrainingQuestionType.FOLLOW_UP,
              text: `${title} follow-up ${index + 1}`,
              position: index + 1,
            })),
          ],
        },
      },
    });
  }

  function startUpdate(telegramId, rawToken) {
    return messageUpdate(telegramId, 1, { text: `/start ${rawToken}` });
  }

  function messageUpdate(telegramId, messageId, payload) {
    return {
      update_id: messageId,
      message: {
        message_id: messageId,
        from: { id: telegramId, username: 'stage2_http' },
        chat: { id: telegramId, type: 'private' },
        ...payload,
      },
    };
  }

  function callbackUpdate(telegramId, data, callbackId) {
    return {
      update_id: 3,
      callback_query: {
        id: callbackId,
        from: { id: telegramId, username: 'stage2_http' },
        message: { chat: { id: telegramId, type: 'private' } },
        data,
      },
    };
  }

  async function clearTrainingData() {
    await prisma.trainingAnswerSegment.deleteMany();
    await prisma.trainingAnswer.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingTelegramLinkToken.deleteMany();
    await prisma.trainingTelegramAccount.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-test-' } } });
  }
}
