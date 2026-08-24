require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
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

  test('authenticated user receives one persisted grounded run with safe progress and idempotent replay', async () => {
    const created = await createConversation();
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
    assert.match(completed.assistantMessage.content, /максимальный бюджет/iu);
    assert.match(completed.assistantMessage.content, /комнатность/iu);
    assert.equal(completed.assistantMessage.answer.kind, 'CLARIFICATION');

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
    assert.equal(detail.body.conversation.messages[1].answer.kind, 'CLARIFICATION');

    const conflict = await sendMessage(
      created.body.conversation.id,
      { ...input, content: 'Другой запрос' },
      idempotencyKey,
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.message, 'ASSISTANT_IDEMPOTENCY_KEY_REUSED');
  });

  test('grounded search reads current FeedUnit price on every run and persists private evidence telemetry', async () => {
    const fixture = await createSearchFixture();
    try {
      const firstConversation = await createConversation();
      const query = {
        content: 'Нужна двушка до 25 млн в районе Хамовники у метро Спортивная от Тест Девелопмент, сдача до 2028 года',
        context: null,
      };
      const firstQueued = await sendMessage(firstConversation.body.conversation.id, query, randomUUID());
      const first = await waitForRun(firstQueued.body.run.id, ownerToken);

      assert.equal(first.status, 'COMPLETED');
      assert.equal(first.assistantMessage.answer.kind, 'SEARCH_RESULTS');
      assert.equal(first.assistantMessage.answer.exactResults.length, 3);
      assert.equal(first.assistantMessage.answer.alternatives.length, 0);
      assert.deepEqual(first.assistantMessage.answer.exactResults.map(({ priceRub }) => priceRub), [20_000_000, 21_000_000, 22_000_000]);
      assert.equal(first.assistantMessage.answer.exactResults[0].pdfs[0].href, `/media/files/${fixture.file.id}/content?download=true`);
      assert.equal(first.telemetry, undefined);
      assert.equal(first.evidence, undefined);

      const persistedFirst = await prisma.assistantRun.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(persistedFirst.intentJson.hardFilters.budgetMaxRub, 25_000_000);
      assert.equal(persistedFirst.evidenceJson.length, 3);
      assert.deepEqual(persistedFirst.telemetryJson.map(({ model, reasoningEffort, outcome }) => [model, reasoningEffort, outcome]), [
        ['gpt-5.6-luna', 'medium', 'ACCEPTED'],
      ]);

      await prisma.feedUnit.update({
        where: { id: fixture.units[1].id },
        data: { effectivePrice: 19_000_000 },
      });
      const secondConversation = await createConversation();
      const secondQueued = await sendMessage(secondConversation.body.conversation.id, query, randomUUID());
      const second = await waitForRun(secondQueued.body.run.id, ownerToken);

      assert.deepEqual(second.assistantMessage.answer.exactResults.map(({ priceRub }) => priceRub), [19_000_000, 20_000_000, 22_000_000]);
      const persistedSecond = await prisma.assistantRun.findUniqueOrThrow({ where: { id: second.id } });
      assert.equal(persistedSecond.evidenceJson[0].priceRub, 19_000_000);
    } finally {
      await deleteSearchFixture(fixture);
    }
  });

  test('conversation and run ownership fail closed without exposing another user data', async () => {
    const created = await createConversation();
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
    const old = await createConversation();
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

    const pagedIds = Array.from({ length: 55 }, () => randomUUID());
    await prisma.assistantConversation.createMany({
      data: pagedIds.map((id, index) => ({
        id,
        ownerUserId: owner.id,
        creationKey: randomUUID(),
        title: `Страница истории ${index}`,
      })),
    });
    const visibleIds = new Set();
    let cursor = null;
    do {
      const page = await request(`/assistant/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
        token: ownerToken,
      });
      assert.equal(page.status, 200);
      page.body.items.forEach((item) => visibleIds.add(item.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.equal(pagedIds.every((id) => visibleIds.has(id)), true);
    assert.equal((await request('/assistant/conversations?cursor=broken', { token: ownerToken })).status, 400);
  });

  test('conversation creation replays one result after a lost response', async () => {
    const idempotencyKey = randomUUID();
    const first = await createConversation(idempotencyKey);
    const replay = await createConversation(idempotencyKey);

    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.conversation.id, first.body.conversation.id);
    assert.equal(await prisma.assistantConversation.count({
      where: { ownerUserId: owner.id, creationKey: idempotencyKey },
    }), 1);
  });

  test('concurrent failed-run retry never returns a stale failed snapshot or duplicates work', async () => {
    const created = await createConversation();
    const content = 'Повтори конкурентно';
    const idempotencyKey = randomUUID();
    const userMessage = await prisma.assistantMessage.create({
      data: {
        conversationId: created.body.conversation.id,
        role: 'USER',
        content,
      },
    });
    const failed = await prisma.assistantRun.create({
      data: {
        ownerUserId: owner.id,
        conversationId: created.body.conversation.id,
        userMessageId: userMessage.id,
        idempotencyKey,
        requestHash: hashAssistantRequest(created.body.conversation.id, content),
        status: 'FAILED',
        startedAt: new Date(Date.now() - 2_000),
        completedAt: new Date(Date.now() - 1_000),
        errorCode: 'ASSISTANT_FAKE_RUN_FAILED',
      },
    });

    const responses = await Promise.all([
      sendMessage(created.body.conversation.id, { content, context: null }, idempotencyKey),
      sendMessage(created.body.conversation.id, { content, context: null }, idempotencyKey),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [202, 202]);
    assert.equal(responses.some((response) => response.body.run.status === 'FAILED'), false);

    await waitForRun(failed.id, ownerToken);
    assert.equal(await prisma.assistantRun.count({ where: { id: failed.id } }), 1);
    assert.equal(await prisma.assistantMessage.count({
      where: { conversationId: created.body.conversation.id, role: 'USER' },
    }), 1);
  });

  test('persisted running work is recovered after its original process disappears', async () => {
    const created = await createConversation();
    const content = 'Восстанови запуск';
    const userMessage = await prisma.assistantMessage.create({
      data: {
        conversationId: created.body.conversation.id,
        role: 'USER',
        content,
      },
    });
    const staleRun = await prisma.assistantRun.create({
      data: {
        ownerUserId: owner.id,
        conversationId: created.body.conversation.id,
        userMessageId: userMessage.id,
        idempotencyKey: randomUUID(),
        requestHash: hashAssistantRequest(created.body.conversation.id, content),
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 60_000),
        leaseOwner: 'dead-process',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      },
    });

    const recovered = await waitForRun(staleRun.id, ownerToken);
    assert.equal(recovered.status, 'COMPLETED');
    assert.equal(recovered.assistantMessage.answer.kind, 'CLARIFICATION');
  });

  test('conversation message bound remains enforced under concurrent sends', async () => {
    const created = await createConversation();
    await prisma.assistantMessage.createMany({
      data: Array.from({ length: 198 }, (_, index) => ({
        conversationId: created.body.conversation.id,
        role: 'USER',
        content: `Ограниченный контекст ${index}`,
      })),
    });

    const responses = await Promise.all([
      sendMessage(created.body.conversation.id, { content: 'Запрос A' }, randomUUID()),
      sendMessage(created.body.conversation.id, { content: 'Запрос B' }, randomUUID()),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [202, 409]);
  });

  test('same idempotency key replays at the conversation message bound', async () => {
    const created = await createConversation();
    await prisma.assistantMessage.createMany({
      data: Array.from({ length: 198 }, (_, index) => ({
        conversationId: created.body.conversation.id,
        role: 'USER',
        content: `Контекст идемпотентного повтора ${index}`,
      })),
    });

    const idempotencyKey = randomUUID();
    const responses = await Promise.all([
      sendMessage(created.body.conversation.id, { content: 'Один запрос' }, idempotencyKey),
      sendMessage(created.body.conversation.id, { content: 'Один запрос' }, idempotencyKey),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [202, 202]);
    assert.equal(responses[0].body.run.id, responses[1].body.run.id);

    await waitForRun(responses[0].body.run.id, ownerToken);
    assert.equal(await prisma.assistantRun.count({
      where: { conversationId: created.body.conversation.id },
    }), 1);
    assert.equal(await prisma.assistantMessage.count({
      where: { conversationId: created.body.conversation.id },
    }), 200);
  });

  function createConversation(idempotencyKey = randomUUID()) {
    return request('/assistant/conversations', {
      method: 'POST',
      token: ownerToken,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  function sendMessage(conversationId, body, idempotencyKey) {
    return request(`/assistant/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: ownerToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    });
  }

  function hashAssistantRequest(conversationId, content) {
    return createHash('sha256')
      .update(JSON.stringify({ conversationId, content, context: null }))
      .digest('hex');
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

  async function createSearchFixture() {
    const suffix = randomUUID().slice(0, 8);
    const developer = await prisma.developer.create({
      data: { name: `Тест Девелопмент ${suffix}` },
    });
    const district = await prisma.location.create({
      data: { name: 'Хамовники', slug: `hamovniki-${suffix}`, type: 'DISTRICT' },
    });
    const metro = await prisma.metroStation.create({
      data: { name: 'Спортивная', slug: `sportivnaya-${suffix}`, lineName: `Тестовая ${suffix}` },
    });
    const object = await prisma.realEstateObject.create({
      data: {
        title: `ЖК Тест ${suffix}`,
        slug: `zhk-test-${suffix}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        developerId: developer.id,
        primaryLocationId: district.id,
        completionYear: 2027,
        completionQuarter: 3,
        feedUpdatedAt: new Date(),
        metroStations: { create: { metroStationId: metro.id } },
      },
    });
    const file = await prisma.file.create({
      data: {
        key: `assistant-t02/${suffix}/project.pdf`,
        originalName: 'project.pdf',
        mimeType: 'application/pdf',
      },
    });
    await prisma.objectFile.create({
      data: {
        objectId: object.id,
        fileId: file.id,
        type: 'PRESENTATION',
        title: 'Презентация проекта',
      },
    });
    const source = await prisma.feedSource.create({
      data: {
        url: `https://example.test/${suffix}.xml`,
        format: 'CIAN_XML',
        developerId: developer.id,
        objectId: object.id,
        isActive: true,
        lastSuccessAt: new Date(),
      },
    });
    const units = [];
    for (const [index, price] of [20_000_000, 21_000_000, 22_000_000, 23_000_000, 27_000_000].entries()) {
      units.push(await prisma.feedUnit.create({
        data: {
          sourceId: source.id,
          objectId: object.id,
          externalId: `assistant-${suffix}-${index}`,
          type: 'RESIDENTIAL',
          status: 'AVAILABLE',
          title: `Квартира ${index + 1}`,
          rooms: 2,
          effectivePrice: price,
          currency: 'RUB',
          area: 60 + index,
          floor: 8 + index,
          completionYear: 2027,
          completionQuarter: 3,
        },
      }));
    }
    return { developer, district, metro, object, file, source, units };
  }

  async function deleteSearchFixture(fixture) {
    await prisma.feedSource.deleteMany({ where: { id: fixture.source.id } });
    await prisma.realEstateObject.deleteMany({ where: { id: fixture.object.id } });
    await prisma.file.deleteMany({ where: { id: fixture.file.id } });
    await prisma.metroStation.deleteMany({ where: { id: fixture.metro.id } });
    await prisma.location.deleteMany({ where: { id: fixture.district.id } });
    await prisma.developer.deleteMany({ where: { id: fixture.developer.id } });
  }
}
