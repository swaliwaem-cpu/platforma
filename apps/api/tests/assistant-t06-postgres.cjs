require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { after, before, test } = require('node:test');
const { JwtService } = require('@nestjs/jwt');
const { NestFactory } = require('@nestjs/core');
const { PrismaClient } = require('@prisma/client');

const databaseUrl = process.env.ASSISTANT_T06_TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('ASSISTANT_T06_TEST_DATABASE_URL_REQUIRED');

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.ASSISTANT_MODULE_ENABLED = 'true';
process.env.ASSISTANT_AI_MODE = 'fake';
process.env.ASSISTANT_EMBEDDING_MODE = 'fake';
process.env.ASSISTANT_GEO_PROVIDER_MODE = 'fake';
process.env.ASSISTANT_SOURCE_WORKER_ENABLED = 'false';
process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
process.env.TRAINING_MODULE_ENABLED = 'false';
process.env.TRAINING_AI_MODE = 'fake';
process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
process.env.JWT_ACCESS_SECRET = 'assistant-t06-postgres-secret';

const { AppModule } = require('../dist/app.module.js');
const { AssistantQueryPlanner } = require('../dist/assistant/assistant-query-planner.js');
const {
  createAssistantPlannerGateway,
} = require('../dist/assistant/assistant-planner-gateway.js');
const {
  AssistantRetentionService,
} = require('../dist/assistant/operations/assistant-retention.service.js');
const {
  AssistantUsageBudgetService,
} = require('../dist/assistant/operations/assistant-usage-budget.service.js');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const suffix = randomUUID().slice(0, 8);
const jwt = new JwtService();
let app;
let baseUrl;
let fixtures;

before(async () => {
  await prisma.$connect();
  fixtures = await createFixtures();
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (app) await app.close();
  await cleanupFixtures();
  await prisma.$disconnect();
});

test('Assistant T06 feedback and audit enforce 401/403/IDOR and keep review classification independent', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway());
  const plannerInput = {
    messages: ['Найди двухкомнатную квартиру до 20 млн рублей'],
    context: null,
  };
  const planBeforeFeedback = await planner.plan(plannerInput);

  assert.equal((await fetch(`${baseUrl}/assistant/audit/runs`)).status, 401);
  assert.equal((await httpJson('/assistant/audit/runs', {
    token: fixtures.owner.token,
  })).status, 403);
  assert.equal((await fetch(
    `${baseUrl}/assistant/messages/${fixtures.run.assistantMessageId}/feedback`,
    { method: 'POST' },
  )).status, 401);

  const idor = await httpJson(
    `/assistant/messages/${fixtures.run.assistantMessageId}/feedback`,
    {
      method: 'POST',
      token: fixtures.other.token,
      body: { rating: 'DISLIKE', reason: 'WRONG_FACT', comment: 'Чужой ответ' },
    },
  );
  assert.equal(idor.status, 404);

  const saved = await httpJson(
    `/assistant/messages/${fixtures.run.assistantMessageId}/feedback`,
    {
      method: 'POST',
      token: fixtures.owner.token,
      body: {
        rating: 'DISLIKE',
        reason: 'WRONG_FACT',
        comment: 'Цена в ответе устарела',
      },
    },
  );
  assert.equal(saved.status, 201);
  assert.equal(saved.body.feedback.rating, 'DISLIKE');
  assert.equal(await prisma.assistantFeedback.count({ where: { runId: fixtures.run.id } }), 1);
  assert.equal(await prisma.assistantReviewItem.count({ where: { runId: fixtures.run.id } }), 1);

  const updated = await httpJson(
    `/assistant/messages/${fixtures.run.assistantMessageId}/feedback`,
    {
      method: 'POST',
      token: fixtures.owner.token,
      body: { rating: 'LIKE', reason: null, comment: null },
    },
  );
  assert.equal(updated.status, 201);
  assert.equal(updated.body.feedback.id, saved.body.feedback.id);
  assert.equal(await prisma.assistantFeedback.count({ where: { runId: fixtures.run.id } }), 1);
  assert.equal(await prisma.assistantReviewItem.count({ where: { runId: fixtures.run.id } }), 1);

  await httpJson(`/assistant/messages/${fixtures.run.assistantMessageId}/feedback`, {
    method: 'POST',
    token: fixtures.owner.token,
    body: {
      rating: 'DISLIKE',
      reason: 'WRONG_FACT',
      comment: 'Цена в ответе устарела',
    },
  });

  const negative = await httpJson('/assistant/audit/runs?issues=NEGATIVE_FEEDBACK', {
    token: fixtures.audit.token,
  });
  assert.equal(negative.status, 200);
  assert.equal(negative.body.items.some(({ id }) => id === fixtures.run.id), true);
  const detail = await httpJson(`/assistant/audit/runs/${fixtures.run.id}`, {
    token: fixtures.audit.token,
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.run.request, fixtures.run.query);
  assert.equal(detail.body.run.finalAnswer, fixtures.run.answer);
  assert.equal(detail.body.run.structuredIntent.taskType, 'SEARCH');
  assert.equal(detail.body.run.audit.rankingDecisions[0].outcome, 'PRIMARY');
  assert.equal(detail.body.run.evidence[0].feedUnitId, 'unit-t06');
  assert.equal(detail.body.run.telemetry[0].model, 'gpt-5.6-luna');
  assert.equal(JSON.stringify(detail.body).includes('rawPayload'), false);
  assert.equal(JSON.stringify(detail.body).includes('credential'), false);

  const reviewId = detail.body.run.review.id;
  const reviewed = await httpJson(`/assistant/audit/reviews/${reviewId}`, {
    method: 'PATCH',
    token: fixtures.audit.token,
    body: {
      classification: 'USER_RATING_INCORRECT',
      comment: 'Evidence подтверждает цену на момент ответа',
    },
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.review.classification, 'USER_RATING_INCORRECT');
  assert.equal((await prisma.assistantFeedback.findUniqueOrThrow({
    where: { runId: fixtures.run.id },
  })).rating, 'DISLIKE');

  const [sources, geo, aliases, metrics] = await Promise.all([
    httpJson('/assistant/audit/sources', { token: fixtures.audit.token }),
    httpJson('/assistant/audit/geo/operations', { token: fixtures.audit.token }),
    httpJson('/assistant/audit/geo/aliases', { token: fixtures.audit.token }),
    httpJson('/assistant/audit/metrics', { token: fixtures.audit.token }),
  ]);
  assert.equal(sources.body.items.some(({ id }) => id === fixtures.source.id), true);
  assert.equal(geo.body.items.some(({ id }) => id === fixtures.geoOperation.id), true);
  assert.equal(aliases.body.items.some(({ id }) => id === fixtures.alias.id), true);
  assert.equal(metrics.body.items.some(({ provider }) => provider === `fixture-${suffix}`), true);

  const planAfterFeedback = await planner.plan(plannerInput);
  assert.deepEqual(planAfterFeedback.intent, planBeforeFeedback.intent);
});

test('Assistant T06 server budgets atomically enforce minute and daily limits and record safe metrics', async () => {
  const budgets = new AssistantUsageBudgetService(prisma);
  const now = new Date('2026-08-26T15:32:24.000Z');
  const reservation = await budgets.reserve({
    provider: `budget-${suffix}`,
    model: 'model-safe-name',
    perMinuteLimit: 1,
    dailyLimit: 1,
    now,
    errorPrefix: 'ASSISTANT_TEST',
  });
  await budgets.complete({
    reservation,
    outcome: 'ACCEPTED',
    inputTokens: 10,
    outputTokens: 4,
    reasoningTokens: 2,
    totalTokens: 16,
    durationMs: 25,
  });
  await assert.rejects(
    budgets.reserve({
      provider: `budget-${suffix}`,
      model: 'model-safe-name',
      perMinuteLimit: 1,
      dailyLimit: 1,
      now,
      errorPrefix: 'ASSISTANT_TEST',
    }),
    (error) => error.code === 'ASSISTANT_TEST_MINUTE_BUDGET_EXHAUSTED',
  );
  const buckets = await prisma.assistantUsageMetric.findMany({
    where: { provider: `budget-${suffix}` },
  });
  assert.equal(buckets.length, 2);
  assert.equal(buckets.every(({ requestCount }) => requestCount === 1), true);
  assert.equal(buckets.every(({ completedCount }) => completedCount === 1), true);
  assert.equal(buckets.every(({ totalTokens }) => totalTokens === 16n), true);
});

test('Assistant T06 retention removes full audits at 30 days and aggregate metrics at 180 days but preserves revisions', async () => {
  const old = new Date('2026-01-01T00:00:00.000Z');
  const recent = new Date('2026-08-20T00:00:00.000Z');
  const now = new Date('2026-08-26T16:00:00.000Z');
  const oldRun = await createRun(fixtures.owner.user.id, old, 'Старый запрос T06', 'Старый ответ T06');
  const recentRun = await createRun(fixtures.owner.user.id, recent, 'Свежий запрос T06', 'Свежий ответ T06');
  await Promise.all([
    prisma.assistantFeedback.create({
      data: { runId: oldRun.id, ownerUserId: fixtures.owner.user.id, rating: 'DISLIKE' },
    }).then((feedback) => prisma.assistantReviewItem.create({
      data: { runId: oldRun.id, feedbackId: feedback.id },
    })),
    prisma.assistantGeoOperation.create({
      data: {
        normalizedQuery: `old-${suffix}`,
        provider: 'fake',
        status: 'RESOLVED',
        durationMs: 3,
        createdAt: old,
      },
    }),
    prisma.assistantGeoOperation.create({
      data: {
        normalizedQuery: `recent-${suffix}`,
        provider: 'fake',
        status: 'RESOLVED',
        durationMs: 3,
        createdAt: recent,
      },
    }),
    prisma.assistantUsageMetric.create({
      data: {
        provider: `retention-${suffix}`,
        model: 'old',
        window: 'DAY',
        windowStartedAt: old,
      },
    }),
    prisma.assistantUsageMetric.create({
      data: {
        provider: `retention-${suffix}`,
        model: 'recent',
        window: 'DAY',
        windowStartedAt: recent,
      },
    }),
  ]);
  const revisionCountBefore = await prisma.assistantSourceRevision.count({
    where: { id: fixtures.revision.id },
  });

  const result = await new AssistantRetentionService(prisma).runCleanup(now);

  assert.equal(result.conversations >= 1, true);
  assert.equal(await prisma.assistantRun.count({ where: { id: oldRun.id } }), 0);
  assert.equal(await prisma.assistantConversation.count({ where: { id: oldRun.conversationId } }), 0);
  assert.equal(await prisma.assistantRun.count({ where: { id: recentRun.id } }), 1);
  assert.equal(await prisma.assistantUsageMetric.count({
    where: { provider: `retention-${suffix}`, model: 'old' },
  }), 0);
  assert.equal(await prisma.assistantUsageMetric.count({
    where: { provider: `retention-${suffix}`, model: 'recent' },
  }), 1);
  assert.equal(await prisma.assistantSourceRevision.count({
    where: { id: fixtures.revision.id },
  }), revisionCountBefore);
});

async function createFixtures() {
  const objectsRead = await upsertPermission('objects:read');
  const auditRead = await upsertPermission('assistant:audit:read');
  const owner = await createUser('owner', [objectsRead.id]);
  const other = await createUser('other', [objectsRead.id]);
  const audit = await createUser('audit', [objectsRead.id, auditRead.id]);
  const run = await createRun(
    owner.user.id,
    new Date('2026-08-26T12:00:00.000Z'),
    'Найди квартиру рядом с Плотинкой',
    'Подходит квартира за 19 млн рублей.',
  );
  const source = await prisma.assistantKnowledgeSource.create({
    data: {
      canonicalUrl: `https://developer.example/t06/${suffix}`,
      type: 'DEVELOPMENT_PAGE',
      state: 'ACTIVE',
      connectorKey: 'OFFICIAL_HTML',
      connectorConfigJson: { allowedHosts: ['developer.example'] },
      projectKey: `project-${suffix}`,
      createdByUserId: audit.user.id,
      lastSuccessAt: new Date('2026-08-26T11:00:00.000Z'),
      lastIndexedAt: new Date('2026-08-26T11:00:00.000Z'),
    },
  });
  const payload = gzipSync(Buffer.from('assistant t06 immutable revision'));
  const revision = await prisma.assistantSourceRevision.create({
    data: {
      sourceId: source.id,
      checksum: createHash('sha256').update(payload).digest('hex'),
      rawPayload: payload,
      rawSizeBytes: payload.length,
      contentType: 'text/html',
      finalUrl: source.canonicalUrl,
      httpStatus: 200,
      fetchedAt: new Date('2026-08-26T11:00:00.000Z'),
      processingStatus: 'INDEXED',
    },
  });
  const alias = await prisma.assistantGeoAlias.create({
    data: {
      normalizedQuery: `плотинка-${suffix}`,
      query: `Плотинка ${suffix}`,
      locale: 'ru',
      country: 'ru',
      label: 'Плотинка, Екатеринбург',
      city: 'Екатеринбург',
      countryCode: 'ru',
      latitude: 56.8377,
      longitude: 60.6038,
      createdByUserId: audit.user.id,
    },
  });
  const geoOperation = await prisma.assistantGeoOperation.create({
    data: {
      actorUserId: owner.user.id,
      normalizedQuery: `плотинка-${suffix}`,
      provider: 'fake',
      status: 'RESOLVED',
      durationMs: 17,
      cacheHit: false,
      providerCallCount: 1,
    },
  });
  await prisma.assistantUsageMetric.create({
    data: {
      provider: `fixture-${suffix}`,
      model: 'gpt-5.6-luna',
      window: 'DAY',
      windowStartedAt: new Date('2026-08-26T00:00:00.000Z'),
      requestCount: 2,
      completedCount: 2,
      inputTokens: 20n,
      outputTokens: 8n,
      totalTokens: 28n,
      totalLatencyMs: 100n,
    },
  });
  return { owner, other, audit, run, source, revision, alias, geoOperation };
}

async function createRun(ownerUserId, at, query, answer) {
  const conversation = await prisma.assistantConversation.create({
    data: {
      ownerUserId,
      creationKey: randomUUID(),
      title: query.slice(0, 80),
      createdAt: at,
      updatedAt: at,
    },
  });
  const [userMessage, assistantMessage] = await Promise.all([
    prisma.assistantMessage.create({
      data: { conversationId: conversation.id, role: 'USER', content: query, createdAt: at },
    }),
    prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'ASSISTANT',
        content: answer,
        answerJson: { kind: 'SEARCH_RESULTS', exactResults: [], alternativeResults: [] },
        createdAt: at,
      },
    }),
  ]);
  const run = await prisma.assistantRun.create({
    data: {
      ownerUserId,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(`${query}-${randomUUID()}`).digest('hex'),
      status: 'COMPLETED',
      progressJson: [],
      intentJson: { taskType: 'SEARCH', hardFilters: { budgetMaxRub: 20_000_000 } },
      evidenceJson: [{ feedUnitId: 'unit-t06', sourceRevision: 'feed:2026-08-26T11:00:00.000Z' }],
      telemetryJson: [{
        provider: 'fake',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        outcome: 'ACCEPTED',
        isFallback: false,
        totalTokens: 20,
        durationMs: 50,
      }],
      auditJson: {
        appliedFilters: { budgetMaxRub: 20_000_000 },
        candidateSet: [{ evidenceId: 'unit-t06', selected: true }],
        rankingDecisions: [{ candidateId: 'unit-t06', outcome: 'PRIMARY' }],
        evidenceRevisions: [{ type: 'FEED', id: 'unit-t06', revision: '2026-08-26T11:00:00.000Z' }],
      },
      qualityFlags: ['UNSUPPORTED_FACT'],
      latencyMs: 50,
      startedAt: at,
      completedAt: at,
      createdAt: at,
      updatedAt: at,
    },
  });
  return { ...run, conversationId: conversation.id, query, answer };
}

async function upsertPermission(key) {
  return prisma.permission.upsert({
    where: { key },
    update: {},
    create: { key, description: key },
  });
}

async function createUser(label, permissionIds) {
  const role = await prisma.role.create({
    data: {
      name: `assistant-t06-${label}-${suffix}`,
      permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `assistant-t06-${label}-${suffix}@example.test`,
      name: `Assistant T06 ${label}`,
      passwordHash: 'not-used',
      roleId: role.id,
      status: 'ACTIVE',
    },
  });
  const token = jwt.sign(
    { sub: user.id, email: user.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );
  return { user, role, token };
}

async function cleanupFixtures() {
  await prisma.assistantReviewItem.deleteMany({
    where: { run: { ownerUserId: { in: userIds() } } },
  });
  await prisma.assistantFeedback.deleteMany({ where: { ownerUserId: { in: userIds() } } });
  await prisma.assistantRun.deleteMany({ where: { ownerUserId: { in: userIds() } } });
  await prisma.assistantMessage.deleteMany({
    where: { conversation: { ownerUserId: { in: userIds() } } },
  });
  await prisma.assistantConversation.deleteMany({ where: { ownerUserId: { in: userIds() } } });
  await prisma.assistantGeoOperation.deleteMany({
    where: { OR: [{ actorUserId: { in: userIds() } }, { normalizedQuery: { contains: suffix } }] },
  });
  await prisma.assistantGeoAlias.deleteMany({ where: { normalizedQuery: { contains: suffix } } });
  await prisma.assistantUsageMetric.deleteMany({
    where: {
      provider: {
        in: [`fixture-${suffix}`, `budget-${suffix}`, `retention-${suffix}`],
      },
    },
  });
  for (const actor of [fixtures?.owner, fixtures?.other]) {
    if (!actor) continue;
    await prisma.user.deleteMany({ where: { id: actor.user.id } });
    await prisma.role.deleteMany({ where: { id: actor.role.id } });
  }
}

function userIds() {
  return [fixtures?.owner, fixtures?.other, fixtures?.audit]
    .filter(Boolean)
    .map(({ user }) => user.id);
}

async function httpJson(path, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}
