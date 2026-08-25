require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { gunzipSync } = require('node:zlib');

const databaseUrl = process.env.ASSISTANT_T03_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Assistant T03 PostgreSQL integration (set ASSISTANT_T03_TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.NODE_ENV = 'test';
  process.env.ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS = 'true';
  process.env.ASSISTANT_EMBEDDING_MODE = 'fake';
  process.env.ASSISTANT_SOURCE_WORKER_ENABLED = 'false';
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_ACCESS_SECRET = 'assistant-t03-http-access-secret';

  const {
    AssistantKnowledgeSourceType,
    AssistantSourceJobStatus,
    AssistantSourceJobTrigger,
    PrismaClient,
    UserStatus,
  } = require('@prisma/client');
  const { JwtService } = require('@nestjs/jwt');
  const { NestFactory } = require('@nestjs/core');
  const {
    AssistantEmbeddingGateway,
  } = require('../dist/assistant/sources/assistant-embedding.gateway.js');
  const {
    AssistantKnowledgeRetrievalService,
  } = require('../dist/assistant/sources/assistant-knowledge-retrieval.service.js');
  const {
    buildAssistantKnowledgeAnswer,
  } = require('../dist/assistant/sources/assistant-knowledge-answer.js');
  const {
    AssistantSourceConnectorRegistry,
  } = require('../dist/assistant/sources/assistant-source-connector.registry.js');
  const {
    AssistantSourceIngestionService,
  } = require('../dist/assistant/sources/assistant-source-ingestion.service.js');
  const {
    AssistantSourceRegistryService,
  } = require('../dist/assistant/sources/assistant-source-registry.service.js');
  const {
    AssistantSourceWorker,
  } = require('../dist/assistant/sources/assistant-source.worker.js');
  const {
    OfficialSourceExtractor,
  } = require('../dist/assistant/sources/official-source.extractor.js');
  const {
    AssistantSourcesModule,
  } = require('../dist/assistant/sources/assistant-sources.module.js');

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  test('Assistant T03 runs register → revision → extraction → hybrid retrieval → grounded answer with checksum no-op', async () => {
    await prisma.assistantKnowledgeSource.updateMany({
      data: { state: 'PAUSED', nextRefreshAt: null },
    });
    const originalHtml = await readFile(resolve(__dirname, 'fixtures/assistant/official-development.html'));
    let currentHtml = originalHtml;
    const fetchCalls = [];
    const connector = {
      async fetch(source) {
        fetchCalls.push(source.canonicalUrl);
        return {
          finalUrl: source.canonicalUrl,
          statusCode: 200,
          contentType: 'text/html',
          checksum: createHash('sha256').update(currentHtml).digest('hex'),
          payload: currentHtml,
          etag: `"${createHash('sha256').update(currentHtml).digest('hex').slice(0, 12)}"`,
          lastModified: 'Tue, 25 Aug 2026 08:00:00 GMT',
          redirects: [],
        };
      },
    };
    const connectorRegistry = new AssistantSourceConnectorRegistry(connector);
    const baseEmbeddings = new AssistantEmbeddingGateway({ ASSISTANT_EMBEDDING_MODE: 'fake' });
    const embeddingCalls = [];
    const embeddings = {
      isEnabled: () => true,
      getModel: () => baseEmbeddings.getModel(),
      async embed(values) {
        embeddingCalls.push([...values]);
        return baseEmbeddings.embed(values);
      },
    };
    const registry = new AssistantSourceRegistryService(prisma, connectorRegistry);
    const ingestion = new AssistantSourceIngestionService(
      prisma,
      connectorRegistry,
      new OfficialSourceExtractor(),
      embeddings,
    );
    const actorId = await createActor();
    const sourceCanonicalUrl = `https://developer.example/projects/severny-sad/${randomUUID()}`;
    const registered = await registry.register(actorId, {
      canonicalUrl: sourceCanonicalUrl,
      type: 'DEVELOPMENT_PAGE',
      state: 'ACTIVE',
      priority: 100,
      scheduleMinutes: 1440,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: { allowedHosts: ['developer.example'] },
      projectKey: 'severny-sad',
      developerKey: 'developer-example',
    });
    const sourceId = registered.source.id;

    const disabledAggregator = await registry.register(actorId, {
      canonicalUrl: `https://aggregator.example/projects/${randomUUID()}`,
      type: 'AGGREGATOR_CIAN',
      state: 'DISABLED',
      priority: 10,
      scheduleMinutes: 1440,
      connectorKey: 'CIAN',
      connectorConfig: { allowedHosts: ['aggregator.example'] },
      projectKey: null,
      developerKey: null,
    });
    await assert.rejects(
      registry.update(disabledAggregator.source.id, { state: 'ACTIVE' }),
      /ASSISTANT_SOURCE_AGGREGATOR_MUST_BE_DISABLED/u,
    );

    const first = await ingestion.ingest(sourceId);
    assert.equal(first.outcome, 'INDEXED');
    assert.equal(first.facts >= 5, true);
    assert.equal(first.chunks > 0, true);
    assert.equal(first.embeddedChunks, first.chunks);
    assert.equal(fetchCalls.length, 1);
    assert.equal(embeddingCalls.length, 1);

    const firstRevision = await prisma.assistantSourceRevision.findUniqueOrThrow({
      where: { id: first.revisionId },
    });
    assert.deepEqual(gunzipSync(firstRevision.rawPayload), originalHtml);
    assert.equal(firstRevision.processingStatus, 'INDEXED');
    assert.equal(firstRevision.previousRevisionId, null);
    assert.equal(await prisma.assistantSourceFact.count({
      where: { sourceRevisionId: first.revisionId, isActive: true },
    }), first.facts);
    assert.equal(await prisma.assistantSourceChunk.count({
      where: { sourceRevisionId: first.revisionId, isActive: true, embeddingModel: 'assistant-hash-embedding-v1' },
    }), first.chunks);

    const unchanged = await ingestion.ingest(sourceId);
    assert.equal(unchanged.outcome, 'UNCHANGED');
    assert.equal(unchanged.revisionId, first.revisionId);
    assert.equal(await prisma.assistantSourceRevision.count({ where: { sourceId } }), 1);
    assert.equal(embeddingCalls.length, 1);

    const intent = createIntent({ taskType: 'FACT' });
    const retrieval = new AssistantKnowledgeRetrievalService(prisma, baseEmbeddings);
    const evidence = await retrieval.retrieve({
      query: 'Какая семейная ипотека в ЖК Северный сад?',
      intent,
      includeExternalLots: false,
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    const promotion = evidence.find(({ kind }) => kind === 'PROMOTION');
    assert.ok(promotion);
    assert.equal(promotion.sourceRevisionId, first.revisionId);
    assert.equal(promotion.retrievalChannels.includes('STRUCTURED_SQL'), true);
    assert.equal(promotion.retrievalChannels.includes('POSTGRES_FTS'), true);
    assert.equal(promotion.retrievalChannels.includes('PGVECTOR'), true);

    const lotEvidence = await retrieval.retrieve({
      query: 'Двушка в Северном саду до 24 млн',
      intent: createIntent({
        hardFilters: { ...emptyFilters(), budgetMaxRub: 24_000_000, rooms: [2] },
      }),
      includeExternalLots: true,
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    const answer = buildAssistantKnowledgeAnswer(lotEvidence, new Date('2026-08-25T18:00:00.000Z'));
    assert.equal(answer.answer.externalLots.length, 1);
    assert.equal(answer.answer.externalLots[0].href, 'https://developer.example/apartments/lot-42');
    assert.equal(answer.evidence[0].sourceRevisionId, first.revisionId);

    currentHtml = Buffer.from(originalHtml.toString('utf8').replace(
      'Ставка 3,5% при покупке до 30 сентября 2026 года.',
      'Ставка 2,9% при покупке до 31 октября 2026 года.',
    ));
    const second = await ingestion.ingest(sourceId);
    assert.equal(second.outcome, 'INDEXED');
    assert.notEqual(second.revisionId, first.revisionId);
    const secondRevision = await prisma.assistantSourceRevision.findUniqueOrThrow({ where: { id: second.revisionId } });
    assert.equal(secondRevision.previousRevisionId, first.revisionId);
    assert.equal(await prisma.assistantSourceRevision.count({ where: { sourceId } }), 2);
    assert.equal(await prisma.assistantSourceFact.count({
      where: { sourceRevisionId: first.revisionId, isActive: true },
    }), 0);
    assert.equal(await prisma.assistantSourceChunk.count({
      where: { sourceRevisionId: first.revisionId, isActive: true },
    }), 0);

    const refreshedEvidence = await retrieval.retrieve({
      query: 'Какая семейная ипотека в ЖК Северный сад?',
      intent,
      includeExternalLots: false,
      now: new Date('2026-08-25T18:01:00.000Z'),
    });
    assert.equal(refreshedEvidence.some(({ sourceRevisionId }) => sourceRevisionId === second.revisionId), true);
    assert.equal(refreshedEvidence.some(({ sourceRevisionId }) => sourceRevisionId === first.revisionId), false);

    await assert.rejects(
      prisma.assistantSourceRevision.update({
        where: { id: first.revisionId },
        data: { checksum: 'a'.repeat(64) },
      }),
      /immutable/iu,
    );
    await assert.rejects(
      prisma.assistantSourceRevision.delete({ where: { id: first.revisionId } }),
      /retained indefinitely/iu,
    );

    const queued = await registry.queueManualRefresh(sourceId, actorId, randomUUID());
    await prisma.assistantSourceJob.update({
      where: { id: queued.job.id },
      data: {
        status: AssistantSourceJobStatus.RUNNING,
        attempt: 1,
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date('2026-08-25T06:00:00.000Z'),
      },
    });
    let recoveredRuns = 0;
    const worker = new AssistantSourceWorker(prisma, {
      async ingest() {
        recoveredRuns += 1;
        return { outcome: 'UNCHANGED' };
      },
    });
    await worker.runOnce(new Date('2026-08-25T07:00:00.000Z'));
    const recovered = await prisma.assistantSourceJob.findUniqueOrThrow({ where: { id: queued.job.id } });
    assert.equal(recovered.status, 'COMPLETED');
    assert.equal(recoveredRuns, 1);
  });

  test('Assistant T03 source HTTP API enforces 401, independent 403 and permitted health/refresh access', async () => {
    const deniedId = await createActor();
    const permittedId = await createActor(['assistant:sources:manage']);
    const [denied, permitted] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: deniedId } }),
      prisma.user.findUniqueOrThrow({ where: { id: permittedId } }),
    ]);
    const jwt = new JwtService();
    const sign = (user) => jwt.sign({ sub: user.id, email: user.email, type: 'access' }, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: '15m',
    });
    const app = await NestFactory.create(AssistantSourcesModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      assert.equal((await fetch(`${origin}/assistant/sources`)).status, 401);
      assert.equal((await fetch(`${origin}/assistant/sources`, {
        headers: { authorization: `Bearer ${sign(denied)}` },
      })).status, 403);
      const list = await fetch(`${origin}/assistant/sources`, {
        headers: { authorization: `Bearer ${sign(permitted)}` },
      });
      assert.equal(list.status, 200);
      const body = await list.json();
      assert.equal(Array.isArray(body.items), true);
      assert.equal(body.connectors.find(({ key }) => key === 'CIAN').enabled, false);

      const source = body.items.find(({ state }) => state === 'ACTIVE');
      assert.ok(source);
      const refresh = await fetch(`${origin}/assistant/sources/${source.id}/refresh`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sign(permitted)}`,
          'Idempotency-Key': randomUUID(),
        },
      });
      assert.equal(refresh.status, 202);
    } finally {
      await app.close();
    }
  });

  async function createActor(permissionKeys = []) {
    const role = await prisma.role.create({
      data: { name: `assistant-t03-${randomUUID()}`, description: 'Assistant T03 disposable test role' },
    });
    for (const key of permissionKeys) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key },
      });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@assistant-t03.test`,
        passwordHash: 'test-only',
        roleId: role.id,
        status: UserStatus.ACTIVE,
      },
    });
    return user.id;
  }

  function createIntent(overrides = {}) {
    return {
      taskType: 'SEARCH',
      comparisonTargets: [],
      hardFilters: emptyFilters(),
      softPreferences: emptyFilters(),
      requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
      needsClarification: false,
      clarificationQuestion: null,
      ...overrides,
    };
  }

  function emptyFilters() {
    return {
      budgetMinRub: null,
      budgetMaxRub: null,
      rooms: [],
      district: null,
      metro: null,
      developer: null,
      completionYearMin: null,
      completionYearMax: null,
      completionQuarter: null,
      objectType: 'RESIDENTIAL',
      propertyClass: null,
      areaMin: null,
      areaMax: null,
      floorMin: null,
      floorMax: null,
    };
  }
}
