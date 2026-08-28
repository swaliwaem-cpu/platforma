require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { gunzipSync } = require('node:zlib');

const databaseUrl = process.env.ASSISTANT_T03_TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('ASSISTANT_T03_TEST_DATABASE_URL_REQUIRED');

{
  process.env.NODE_ENV = 'test';
  process.env.ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS = 'true';
  process.env.ASSISTANT_EMBEDDING_MODE = 'fake';
  process.env.ASSISTANT_SOURCE_WORKER_ENABLED = 'false';
  process.env.ASSISTANT_EXTERNAL_CONNECTORS_ENABLED = 'true';
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
    OfficialHtmlSourceConnector,
  } = require('../dist/assistant/sources/official-html-source.connector.js');
  const {
    AssistantSourcesModule,
  } = require('../dist/assistant/sources/assistant-sources.module.js');

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  test('Assistant T03 runs real HTTP connector → revision → extraction → hybrid retrieval → grounded answer', async (context) => {
    await prisma.assistantKnowledgeSource.updateMany({
      data: { state: 'PAUSED', nextRefreshAt: null },
    });
    const originalHtml = await readFile(resolve(__dirname, 'fixtures/assistant/official-development.html'));
    let currentHtml = originalHtml;
    let currentContentType = 'text/html; charset=utf-8';
    const fetchCalls = [];
    let concurrentRequestCount = 0;
    let sameChecksumRequestCount = 0;
    let signalFirstConcurrentRequest;
    const firstConcurrentRequest = new Promise((resolveRequest) => {
      signalFirstConcurrentRequest = resolveRequest;
    });
    const concurrentNewerHtml = Buffer.from(originalHtml.toString('utf8').replace(
      'Ставка 3,5% при покупке до 30 сентября 2026 года.',
      'Ставка 1,1% при покупке до 31 декабря 2026 года.',
    ));
    const sameChecksumOlderHtml = Buffer.from(`<!doctype html><html><body><main>
      <h1>ЖК Гонка checksum</h1><h2>Архитектура</h2>
      <p>Гонка X canonical revision должна оставаться активной.</p>
    </main></body></html>`);
    const sameChecksumIntermediateHtml = Buffer.from(`<!doctype html><html><body><main>
      <h1>ЖК Гонка checksum</h1><h2>Архитектура</h2>
      <p>Гонка Y intermediate revision не должна оставаться активной.</p>
    </main></body></html>`);
    let signalFirstSameChecksumRequest;
    const firstSameChecksumRequest = new Promise((resolveRequest) => {
      signalFirstSameChecksumRequest = resolveRequest;
    });
    let releaseFirstSameChecksumResponse;
    const firstSameChecksumResponseReleased = new Promise((resolveResponse) => {
      releaseFirstSameChecksumResponse = resolveResponse;
    });
    const server = createServer((request, response) => {
      fetchCalls.push(request.url);
      const isConcurrent = request.url?.includes('/projects/concurrent/') === true;
      const isSameChecksum = request.url?.includes('/projects/same-checksum/') === true;
      const concurrentIndex = isConcurrent ? ++concurrentRequestCount : 0;
      const sameChecksumIndex = isSameChecksum ? ++sameChecksumRequestCount : 0;
      const payload = isSameChecksum
        ? sameChecksumIndex === 2
          ? sameChecksumIntermediateHtml
          : sameChecksumOlderHtml
        : concurrentIndex === 1
          ? originalHtml
          : concurrentIndex === 2
            ? concurrentNewerHtml
            : currentHtml;
      const send = () => {
        response.writeHead(200, {
          'content-type': isConcurrent ? 'text/html; charset=utf-8' : currentContentType,
          etag: `"${createHash('sha256').update(payload).digest('hex').slice(0, 12)}"`,
          'last-modified': 'Tue, 25 Aug 2026 08:00:00 GMT',
        });
        response.end(payload);
      };
      if (concurrentIndex === 1) {
        signalFirstConcurrentRequest();
        setTimeout(send, 120);
      } else if (sameChecksumIndex === 1) {
        signalFirstSameChecksumRequest();
        void firstSameChecksumResponseReleased.then(send);
      } else {
        send();
      }
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
    const address = server.address();
    const connector = new OfficialHtmlSourceConnector({
      allowHttp: true,
      allowPrivateNetwork: true,
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const connectorRegistry = new AssistantSourceConnectorRegistry(connector);
    const baseEmbeddings = new AssistantEmbeddingGateway({ ASSISTANT_EMBEDDING_MODE: 'fake' });
    const embeddingCalls = [];
    let sameChecksumEmbeddingCalls = 0;
    let signalFirstSameChecksumEmbedding;
    const firstSameChecksumEmbedding = new Promise((resolveEmbedding) => {
      signalFirstSameChecksumEmbedding = resolveEmbedding;
    });
    let releaseFirstSameChecksumEmbedding;
    const firstSameChecksumEmbeddingReleased = new Promise((resolveEmbedding) => {
      releaseFirstSameChecksumEmbedding = resolveEmbedding;
    });
    const embeddings = {
      isEnabled: () => true,
      getModel: () => baseEmbeddings.getModel(),
      getDimensions: () => baseEmbeddings.getDimensions(),
      async embed(values) {
        embeddingCalls.push([...values]);
        if (values.some((value) => value.includes('Гонка X canonical revision'))) {
          sameChecksumEmbeddingCalls += 1;
          if (sameChecksumEmbeddingCalls === 1) {
            signalFirstSameChecksumEmbedding();
            await firstSameChecksumEmbeddingReleased;
          }
        }
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
    const sourceCanonicalUrl = `http://developer.example:${address.port}/projects/severny-sad/${randomUUID()}`;
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
      where: {
        sourceRevisionId: first.revisionId,
        isActive: true,
        embeddingModel: 'assistant-hash-embedding-v1',
        embeddingDimensions: 64,
      },
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
      context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
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
      context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    const answer = buildAssistantKnowledgeAnswer(lotEvidence, new Date('2026-08-25T18:00:00.000Z'));
    assert.equal(answer.answer.externalLots.length, 1);
    assert.equal(answer.answer.externalLots[0].href, 'https://developer.example/apartments/lot-42');
    assert.equal(answer.evidence[0].sourceRevisionId, first.revisionId);

    const rejectedLotEvidence = await retrieval.retrieve({
      query: 'Большая квартира на высоком этаже в Северном саду',
      intent: createIntent({
        hardFilters: { ...emptyFilters(), areaMin: 80, floorMin: 9 },
      }),
      includeExternalLots: true,
      context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    assert.equal(rejectedLotEvidence.some(({ kind }) => kind === 'EXTERNAL_LOT'), false);

    const matchingLotEvidence = await retrieval.retrieve({
      query: 'Квартира 67 м² на 8 этаже в Северном саду',
      intent: createIntent({
        hardFilters: { ...emptyFilters(), areaMin: 65, areaMax: 70, floorMin: 8, floorMax: 8 },
      }),
      includeExternalLots: true,
      context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    assert.equal(matchingLotEvidence.filter(({ kind }) => kind === 'EXTERNAL_LOT').length, 1);

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
      context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
      now: new Date('2026-08-25T18:01:00.000Z'),
    });
    assert.equal(refreshedEvidence.some(({ sourceRevisionId }) => sourceRevisionId === second.revisionId), true);
    assert.equal(refreshedEvidence.some(({ sourceRevisionId }) => sourceRevisionId === first.revisionId), false);

    currentHtml = originalHtml;
    const third = await ingestion.ingest(sourceId);
    assert.equal(third.outcome, 'INDEXED');
    assert.notEqual(third.revisionId, first.revisionId);
    assert.notEqual(third.revisionId, second.revisionId);
    const thirdRevision = await prisma.assistantSourceRevision.findUniqueOrThrow({ where: { id: third.revisionId } });
    assert.equal(thirdRevision.previousRevisionId, second.revisionId);
    assert.equal(thirdRevision.checksum, firstRevision.checksum);
    assert.equal(await prisma.assistantSourceRevision.count({ where: { sourceId } }), 3);
    assert.equal(await prisma.assistantSourceFact.count({
      where: { sourceRevisionId: second.revisionId, isActive: true },
    }), 0);

    const concurrentSource = await registry.register(actorId, {
      canonicalUrl: `http://developer.example:${address.port}/projects/concurrent/${randomUUID()}`,
      type: 'DEVELOPMENT_PAGE',
      state: 'ACTIVE',
      priority: 100,
      scheduleMinutes: 1_440,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: { allowedHosts: ['developer.example'] },
      projectKey: 'concurrent-sad',
      developerKey: 'developer-concurrent',
    });
    const olderIngestion = ingestion.ingest(concurrentSource.source.id);
    await firstConcurrentRequest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const newerIngestion = ingestion.ingest(concurrentSource.source.id);
    await Promise.all([olderIngestion, newerIngestion]);
    const concurrentActivePromotions = await prisma.assistantSourceFact.findMany({
      where: {
        sourceId: concurrentSource.source.id,
        kind: 'PROMOTION',
        isActive: true,
      },
      select: { searchText: true },
    });
    assert.equal(concurrentActivePromotions.length > 0, true);
    assert.equal(concurrentActivePromotions.some(({ searchText }) => /1,1%/u.test(searchText)), true);
    assert.equal(concurrentActivePromotions.some(({ searchText }) => /3,5%/u.test(searchText)), false);
    const concurrentRevisions = await prisma.assistantSourceRevision.findMany({
      where: { sourceId: concurrentSource.source.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, previousRevisionId: true },
    });
    assert.equal(concurrentRevisions.length, 2);
    assert.equal(concurrentRevisions[1].previousRevisionId, concurrentRevisions[0].id);

    const sameChecksumSource = await registry.register(actorId, {
      canonicalUrl: `http://developer.example:${address.port}/projects/same-checksum/${randomUUID()}`,
      type: 'DEVELOPMENT_PAGE',
      state: 'ACTIVE',
      priority: 100,
      scheduleMinutes: 1_440,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: { allowedHosts: ['developer.example'] },
      projectKey: 'same-checksum-sad',
      developerKey: 'developer-same-checksum',
    });
    const olderSameChecksumIngestion = ingestion.ingest(sameChecksumSource.source.id);
    await firstSameChecksumRequest;
    const intermediateSameChecksumIngestion = await ingestion.ingest(sameChecksumSource.source.id);
    assert.equal(intermediateSameChecksumIngestion.outcome, 'INDEXED');
    await prisma.assistantKnowledgeSource.update({
      where: { id: sameChecksumSource.source.id },
      data: {
        lastErrorCode: 'SOURCE_STALE_ERROR',
        lastErrorMessage: 'SOURCE_STALE_ERROR',
      },
    });
    const newerSameChecksumIngestion = ingestion.ingest(sameChecksumSource.source.id);
    await firstSameChecksumEmbedding;
    releaseFirstSameChecksumResponse();
    const sameChecksumRevision = await waitForRevisionStatus(
      sameChecksumSource.source.id,
      createHash('sha256').update(sameChecksumOlderHtml).digest('hex'),
      'INDEXED',
    );
    releaseFirstSameChecksumEmbedding();
    await Promise.all([olderSameChecksumIngestion, newerSameChecksumIngestion]);
    const sameChecksumActiveFacts = await prisma.assistantSourceFact.findMany({
      where: { sourceId: sameChecksumSource.source.id, isActive: true },
      select: { searchText: true, sourceRevisionId: true },
    });
    assert.equal(sameChecksumActiveFacts.length > 0, true);
    assert.equal(sameChecksumActiveFacts.every(({ sourceRevisionId }) => (
      sourceRevisionId === sameChecksumRevision.id
    )), true);
    assert.equal(sameChecksumActiveFacts.some(({ searchText }) => /Гонка X canonical revision/u.test(searchText)), true);
    assert.equal(sameChecksumActiveFacts.some(({ searchText }) => /Гонка Y intermediate revision/u.test(searchText)), false);
    const sameChecksumSourceHealth = await prisma.assistantKnowledgeSource.findUniqueOrThrow({
      where: { id: sameChecksumSource.source.id },
    });
    assert.equal(sameChecksumSourceHealth.lastSuccessAt.toISOString(), sameChecksumSourceHealth.lastAttemptAt.toISOString());
    assert.equal(sameChecksumSourceHealth.lastIndexedAt.toISOString(), sameChecksumRevision.fetchedAt.toISOString());
    assert.equal(sameChecksumSourceHealth.lastErrorCode, null);
    assert.equal(sameChecksumSourceHealth.lastErrorMessage, null);

    const otherSource = await registry.register(actorId, {
      canonicalUrl: `http://developer.example:${address.port}/projects/yuzhny-sad/${randomUUID()}`,
      type: 'DEVELOPMENT_PAGE',
      state: 'ACTIVE',
      priority: 1_000,
      scheduleMinutes: 1_440,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: { allowedHosts: ['developer.example'] },
      projectKey: 'yuzhny-sad',
      developerKey: 'developer-other',
    });
    currentHtml = Buffer.from(originalHtml.toString('utf8')
      .replaceAll('Северный сад', 'Южный сад')
      .replace('Ставка 3,5%', 'Ставка 0,1%'));
    await ingestion.ingest(otherSource.source.id);
    const scopedEvidence = await retrieval.retrieve({
      query: 'Какая архитектура и ипотека у проекта?',
      intent,
      includeExternalLots: false,
      context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
      now: new Date('2026-08-25T18:02:00.000Z'),
    });
    assert.equal(scopedEvidence.length > 0, true);
    assert.equal(scopedEvidence.every(({ projectKey }) => projectKey === 'severny-sad'), true);

    const developerPromotion = await registry.register(actorId, {
      canonicalUrl: `http://developer.example:${address.port}/promotions/developer/${randomUUID()}`,
      type: 'DEVELOPER_PROMOTION',
      state: 'ACTIVE',
      priority: 100,
      scheduleMinutes: 1_440,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: { allowedHosts: ['developer.example'] },
      projectKey: null,
      developerKey: 'developer-example',
    });
    currentHtml = Buffer.from(`<!doctype html><html><body><main>
      <h1>Акции застройщика</h1><h2>Семейная ипотека застройщика</h2>
      <p>Ставка 4,4% для проектов developer-example.</p>
    </main></body></html>`);
    await ingestion.ingest(developerPromotion.source.id);
    const bankPromotion = await registry.register(actorId, {
      canonicalUrl: `http://developer.example:${address.port}/promotions/bank/${randomUUID()}`,
      type: 'BANK_PROMOTION',
      state: 'ACTIVE',
      priority: 900,
      scheduleMinutes: 1_440,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: { allowedHosts: ['developer.example'] },
      projectKey: null,
      developerKey: null,
    });
    currentHtml = Buffer.from(`<!doctype html><html><body><main>
      <h1>Акции банка</h1><h2>Семейная ипотека банка</h2>
      <p>Ставка 5,5% для новостроек из партнёрского списка.</p>
    </main></body></html>`);
    await ingestion.ingest(bankPromotion.source.id);
    const sharedPromotionInput = {
      query: 'Какая семейная ипотека действует?',
      intent,
      includeExternalLots: false,
      context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
      now: new Date('2026-08-25T18:03:00.000Z'),
    };
    const sharedPromotionsBeforePriorityUpdate = (await retrieval.retrieve(sharedPromotionInput))
      .filter(({ sourceId: evidenceSourceId }) => (
        evidenceSourceId === developerPromotion.source.id || evidenceSourceId === bankPromotion.source.id
      ));
    assert.deepEqual(
      new Set(sharedPromotionsBeforePriorityUpdate.map(({ sourceId: evidenceSourceId }) => evidenceSourceId)),
      new Set([developerPromotion.source.id, bankPromotion.source.id]),
    );
    assert.equal(sharedPromotionsBeforePriorityUpdate[0].sourceId, bankPromotion.source.id);

    await registry.update(developerPromotion.source.id, { priority: 1_000 });
    const sharedPromotionsAfterPriorityUpdate = (await retrieval.retrieve({
      ...sharedPromotionInput,
      now: new Date('2026-08-25T18:04:00.000Z'),
    })).filter(({ sourceId: evidenceSourceId }) => (
      evidenceSourceId === developerPromotion.source.id || evidenceSourceId === bankPromotion.source.id
    ));
    assert.deepEqual(
      new Set(sharedPromotionsAfterPriorityUpdate.map(({ sourceId: evidenceSourceId }) => evidenceSourceId)),
      new Set([developerPromotion.source.id, bankPromotion.source.id]),
    );
    assert.equal(sharedPromotionsAfterPriorityUpdate[0].sourceId, developerPromotion.source.id);
    assert.equal(sharedPromotionsAfterPriorityUpdate[0].sourcePriority, 1_000);

    const activeFactIdsBeforeFailedExtraction = (await prisma.assistantSourceFact.findMany({
      where: { sourceId, isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    })).map(({ id }) => id);
    currentContentType = 'application/json';
    currentHtml = Buffer.from('{"broken":');
    await assert.rejects(
      ingestion.ingest(sourceId),
      /SOURCE_EXTRACTION_EMPTY/u,
    );
    const failedRevision = await prisma.assistantSourceRevision.findFirstOrThrow({
      where: { sourceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    assert.equal(failedRevision.processingStatus, 'FAILED');
    assert.equal(failedRevision.processingErrorCode, 'SOURCE_EXTRACTION_EMPTY');
    assert.equal(await prisma.assistantSourceFact.count({ where: { sourceRevisionId: failedRevision.id } }), 0);
    assert.equal(await prisma.assistantSourceChunk.count({ where: { sourceRevisionId: failedRevision.id } }), 0);
    assert.deepEqual((await prisma.assistantSourceFact.findMany({
      where: { sourceId, isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    })).map(({ id }) => id), activeFactIdsBeforeFailedExtraction);
    currentContentType = 'text/html; charset=utf-8';
    currentHtml = originalHtml;

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

    const olderValidJob = await registry.queueManualRefresh(sourceId, actorId, randomUUID());
    await prisma.assistantSourceJob.update({
      where: { id: olderValidJob.job.id },
      data: { availableAt: new Date('2000-01-01T00:00:00.000Z') },
    });
    let signalOlderValidAttempt;
    const olderValidAttemptStarted = new Promise((resolveAttempt) => {
      signalOlderValidAttempt = resolveAttempt;
    });
    let releaseOlderValidAttempt;
    const olderValidAttemptReleased = new Promise((resolveAttempt) => {
      releaseOlderValidAttempt = resolveAttempt;
    });
    let olderValidHealthAt;
    const olderValidWorker = new AssistantSourceWorker(prisma, {
      async ingest(_workerSourceId, fence) {
        assert.ok(fence.attemptStartedAt instanceof Date);
        olderValidHealthAt = fence.attemptStartedAt;
        signalOlderValidAttempt();
        await olderValidAttemptReleased;
        throw { code: 'SOURCE_OLDER_VALID_JOB_FAILED', retryable: false };
      },
    });
    const olderValidRun = olderValidWorker.runOnce(new Date());
    await olderValidAttemptStarted;
    const newerValidJob = await registry.queueManualRefresh(sourceId, actorId, randomUUID());
    await prisma.assistantSourceJob.update({
      where: { id: newerValidJob.job.id },
      data: { availableAt: new Date('2000-01-01T00:00:00.000Z') },
    });
    let newerValidHealthAt;
    const newerValidWorker = new AssistantSourceWorker(prisma, {
      async ingest(_workerSourceId, fence) {
        assert.ok(fence.attemptStartedAt instanceof Date);
        newerValidHealthAt = fence.attemptStartedAt;
        await prisma.assistantKnowledgeSource.update({
          where: { id: sourceId },
          data: {
            lastAttemptAt: newerValidHealthAt,
            lastSuccessAt: newerValidHealthAt,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        return { outcome: 'UNCHANGED' };
      },
    });
    await newerValidWorker.runOnce(new Date());
    assert.equal(newerValidHealthAt > olderValidHealthAt, true);
    releaseOlderValidAttempt();
    await olderValidRun;
    const latestValidHealth = await prisma.assistantKnowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(latestValidHealth.lastAttemptAt.toISOString(), newerValidHealthAt.toISOString());
    assert.equal(latestValidHealth.lastSuccessAt.toISOString(), newerValidHealthAt.toISOString());
    assert.equal(latestValidHealth.lastErrorCode, null);
    assert.equal(latestValidHealth.lastErrorMessage, null);

    const fencedJob = await registry.queueManualRefresh(sourceId, actorId, randomUUID());
    await prisma.assistantSourceJob.update({
      where: { id: fencedJob.job.id },
      data: {
        status: AssistantSourceJobStatus.RUNNING,
        attempt: 1,
        leaseOwner: 'expired-worker',
        leaseExpiresAt: new Date('2026-08-25T06:00:00.000Z'),
      },
    });
    const revisionCountBeforeLostLease = await prisma.assistantSourceRevision.count({ where: { sourceId } });
    await assert.rejects(
      ingestion.ingest(sourceId, {
        jobId: fencedJob.job.id,
        leaseOwner: 'expired-worker',
        attemptStartedAt: new Date('2026-08-25T06:00:00.000Z'),
      }),
      /SOURCE_JOB_LEASE_LOST/u,
    );
    assert.equal(await prisma.assistantSourceRevision.count({ where: { sourceId } }), revisionCountBeforeLostLease);
    await prisma.assistantSourceJob.update({
      where: { id: fencedJob.job.id },
      data: {
        status: AssistantSourceJobStatus.FAILED,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: 'SOURCE_JOB_LEASE_LOST',
        completedAt: new Date(),
      },
    });

    const exhaustedJob = await registry.queueManualRefresh(sourceId, actorId, randomUUID());
    await prisma.assistantSourceJob.update({
      where: { id: exhaustedJob.job.id },
      data: {
        status: AssistantSourceJobStatus.RUNNING,
        attempt: 3,
        maxAttempts: 3,
        leaseOwner: 'exhausted-worker',
        leaseExpiresAt: new Date('2026-08-25T06:00:00.000Z'),
      },
    });

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
    const stolenJob = await registry.queueManualRefresh(sourceId, actorId, randomUUID());
    await prisma.assistantSourceJob.update({
      where: { id: stolenJob.job.id },
      data: { availableAt: new Date('2026-08-25T06:00:00.000Z') },
    });
    const replacementHealthAt = new Date('2026-08-25T07:00:30.000Z');
    let recoveredRuns = 0;
    const worker = new AssistantSourceWorker(prisma, {
      async ingest(_workerSourceId, fence) {
        if (fence.jobId === stolenJob.job.id) {
          await prisma.assistantSourceJob.update({
            where: { id: fence.jobId },
            data: {
              leaseOwner: 'replacement-worker',
              leaseExpiresAt: new Date('2099-08-25T08:00:00.000Z'),
            },
          });
          await prisma.assistantKnowledgeSource.update({
            where: { id: sourceId },
            data: {
              lastSuccessAt: replacementHealthAt,
              lastErrorCode: null,
              lastErrorMessage: null,
            },
          });
          throw { code: 'SOURCE_OLD_WORKER_FAILED', retryable: true };
        }
        recoveredRuns += 1;
        return { outcome: 'UNCHANGED' };
      },
    });
    await worker.runOnce(new Date('2026-08-25T07:00:00.000Z'));
    const recovered = await prisma.assistantSourceJob.findUniqueOrThrow({ where: { id: queued.job.id } });
    const exhausted = await prisma.assistantSourceJob.findUniqueOrThrow({ where: { id: exhaustedJob.job.id } });
    const stolen = await prisma.assistantSourceJob.findUniqueOrThrow({ where: { id: stolenJob.job.id } });
    const sourceHealth = await prisma.assistantKnowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
    assert.equal(recovered.status, 'COMPLETED');
    assert.equal(exhausted.status, 'FAILED');
    assert.equal(exhausted.errorCode, 'SOURCE_JOB_RETRY_EXHAUSTED');
    assert.equal(stolen.status, 'RUNNING');
    assert.equal(stolen.leaseOwner, 'replacement-worker');
    assert.equal(sourceHealth.lastSuccessAt.toISOString(), replacementHealthAt.toISOString());
    assert.equal(sourceHealth.lastErrorCode, null);
    assert.equal(recoveredRuns, 1);
    await prisma.assistantSourceJob.update({
      where: { id: stolenJob.job.id },
      data: {
        status: AssistantSourceJobStatus.FAILED,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: 'SOURCE_JOB_LEASE_LOST',
        completedAt: new Date(),
      },
    });
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

      const projectRefreshKey = randomUUID();
      const projectRefresh = await fetch(`${origin}/assistant/sources/projects/${source.projectKey}/refresh`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sign(permitted)}`,
          'Idempotency-Key': projectRefreshKey,
        },
      });
      assert.equal(projectRefresh.status, 202);
      const projectRefreshBody = await projectRefresh.json();
      assert.equal(projectRefreshBody.projectKey, source.projectKey);
      assert.equal(projectRefreshBody.jobs.length > 0, true);
      assert.equal(projectRefreshBody.jobs.every(({ sourceId }) => body.items.some(
        (item) => item.id === sourceId && item.projectKey === source.projectKey,
      )), true);

      const repeatedProjectRefresh = await fetch(`${origin}/assistant/sources/projects/${source.projectKey}/refresh`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sign(permitted)}`,
          'Idempotency-Key': projectRefreshKey,
        },
      });
      assert.equal(repeatedProjectRefresh.status, 202);
      assert.deepEqual(
        (await repeatedProjectRefresh.json()).jobs.map(({ id }) => id),
        projectRefreshBody.jobs.map(({ id }) => id),
      );
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

  async function waitForRevisionStatus(sourceId, checksum, processingStatus) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const revision = await prisma.assistantSourceRevision.findFirst({
        where: { sourceId, checksum, processingStatus },
      });
      if (revision) return revision;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error(`REVISION_STATUS_TIMEOUT:${processingStatus}`);
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
