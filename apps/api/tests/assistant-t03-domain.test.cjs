require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PATH_METADATA } = require('@nestjs/common/constants');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const {
  AssistantSourcesController,
} = require('../dist/assistant/sources/assistant-sources.controller.js');
const {
  AssistantEmbeddingGateway,
  AssistantEmbeddingError,
  assistantEmbeddingBenchmarkDatasetSha256,
} = require('../dist/assistant/sources/assistant-embedding.gateway.js');
const {
  AssistantSourceRegistryService,
} = require('../dist/assistant/sources/assistant-source-registry.service.js');
const {
  buildAssistantKnowledgeAnswer,
} = require('../dist/assistant/sources/assistant-knowledge-answer.js');
const {
  createAssistantKnowledgePageContext,
  createAssistantKnowledgeQueryContext,
  extractAssistantKnowledgeProjectReferenceClause,
  hasExplicitAssistantKnowledgeProjectReference,
  isDelimitedAssistantKnowledgeProjectReference,
  requiresAssistantKnowledgeCurrentVerification,
  resolveAssistantKnowledgeProjectIdentity,
} = require('../dist/assistant/sources/assistant-knowledge-policy.js');
const {
  AssistantCurrentFactRefreshCoordinator,
} = require('../dist/assistant/sources/assistant-current-fact-refresh.service.js');
const {
  AssistantAnswerService,
} = require('../dist/assistant/assistant-answer.service.js');
const {
  AssistantService,
} = require('../dist/assistant/assistant.service.js');
const {
  AssistantPlannerFallbackValidationError,
  AssistantQueryPlanner,
} = require('../dist/assistant/assistant-query-planner.js');
const {
  createAssistantPlannerGateway,
} = require('../dist/assistant/assistant-planner-gateway.js');

test('Assistant T03 source administration uses one independent additive permission', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, AssistantSourcesController), 'assistant/sources');
  assert.deepEqual(Reflect.getMetadata(PERMISSIONS_KEY, AssistantSourcesController), [
    'assistant:sources:manage',
  ]);
  assert.equal(Reflect.getMetadata(PERMISSIONS_KEY, AssistantSourcesController.prototype.list), undefined);
  assert.equal(Reflect.getMetadata(PERMISSIONS_KEY, AssistantSourcesController.prototype.refresh), undefined);
  assert.equal(Reflect.getMetadata(PERMISSIONS_KEY, AssistantSourcesController.prototype.refreshProject), undefined);
});

test('Assistant T03 source registry accepts catalog coverage beyond the former pilot caps', async () => {
  const now = new Date('2026-08-29T12:00:00.000Z');
  const createdSource = {
    id: '99999999-9999-4999-8999-999999999999',
    canonicalUrl: 'https://developer-eight.example/projects/project-21',
    type: 'DEVELOPMENT_PAGE',
    state: 'ACTIVE',
    priority: 100,
    scheduleMinutes: 1440,
    connectorKey: 'OFFICIAL_HTML',
    connectorConfigJson: { allowedHosts: ['developer-eight.example'] },
    projectKey: 'project-21',
    developerKey: 'developer-eight',
    nextRefreshAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastIndexedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now,
    revisions: [],
    jobs: [],
    _count: { revisions: 0, facts: 0, chunks: 0 },
  };
  let createCalls = 0;
  const registered = Array.from({ length: 20 }, (_, index) => ({
    projectKey: `registered-${index}`,
    developerKey: `developer-${index % 7}`,
  }));
  const transaction = {
    async $executeRaw() { return 1; },
    assistantKnowledgeSource: {
      async findUnique() { return null; },
      async findMany() { return registered; },
      async create() {
        createCalls += 1;
        return createdSource;
      },
    },
  };
  const service = new AssistantSourceRegistryService({
    async $transaction(operation) { return operation(transaction); },
    assistantKnowledgeSource: {
      async findMany() { return []; },
    },
  }, {
    get() { return {}; },
    list() { return []; },
  });

  const registeredResult = await service.register(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    {
      canonicalUrl: createdSource.canonicalUrl,
      type: 'DEVELOPMENT_PAGE',
      state: 'ACTIVE',
      priority: 100,
      scheduleMinutes: 1440,
      connectorKey: 'OFFICIAL_HTML',
      connectorConfig: { allowedHosts: ['developer-eight.example'] },
      projectKey: createdSource.projectKey,
      developerKey: createdSource.developerKey,
    },
  );
  const listResult = await service.list();

  assert.equal(createCalls, 1);
  assert.equal(registeredResult.source.projectKey, 'project-21');
  assert.deepEqual(listResult.coverage, {
    mode: 'ALL_PUBLISHED_RESIDENTIAL_PROJECTS_WITH_DEVELOPER',
  });
  assert.equal(listResult.pilot, undefined);
});

test('Assistant T03 fake planner routes official project and promotion questions to grounded facts', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const project = await planner.plan({
    messages: ['Расскажи про архитектуру и инфраструктуру ЖК Северный сад'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
  });
  const promotion = await planner.plan({
    messages: ['Какая семейная ипотека действует в ЖК Северный сад?'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
  });

  assert.equal(project.intent.taskType, 'FACT');
  assert.equal(project.intent.needsClarification, false);
  assert.equal(promotion.intent.taskType, 'FACT');
  assert.equal(promotion.intent.needsClarification, false);
});

test('Assistant T03 fake embedding gateway batches changed chunks deterministically without network', async () => {
  const gateway = new AssistantEmbeddingGateway({ ASSISTANT_EMBEDDING_MODE: 'fake' });
  const first = await gateway.embed(['Архитектура проекта', 'Семейная ипотека']);
  const second = await gateway.embed(['Архитектура проекта']);

  assert.equal(first.model, 'assistant-hash-embedding-v1');
  assert.equal(first.vectors.length, 2);
  assert.equal(first.vectors[0].length, 64);
  assert.equal(gateway.getDimensions(), 64);
  assert.deepEqual(first.vectors[0], second.vectors[0]);
  assert.notDeepEqual(first.vectors[0], first.vectors[1]);
});

test('Assistant T03 production Alibaba embeddings require the exact reproducible benchmark winner', () => {
  const environment = {
    ASSISTANT_EMBEDDING_MODE: 'alibaba',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-v4',
    ASSISTANT_EMBEDDING_DIMENSIONS: '256',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ALIBABA_API_KEY: 'test-only',
    DEPLOYMENT_ENV: 'production',
  };
  assert.throws(
    () => new AssistantEmbeddingGateway(environment),
    (error) => error instanceof AssistantEmbeddingError
      && error.code === 'ASSISTANT_EMBEDDING_BENCHMARK_WINNER_REQUIRED',
  );

  const gateway = new AssistantEmbeddingGateway({
    ...environment,
    ASSISTANT_EMBEDDING_BENCHMARK_WINNER:
      `text-embedding-v4:256:${assistantEmbeddingBenchmarkDatasetSha256}`,
  });
  assert.equal(gateway.getModel(), 'text-embedding-v4');
  assert.equal(gateway.getDimensions(), 256);
});

test('Assistant T03 Alibaba embedding gateway validates the configured benchmark winner and response shape', async () => {
  const calls = [];
  const ledgerEvents = [];
  const gateway = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'alibaba',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-v4',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ALIBABA_API_KEY: 'test-only',
  }, async (url, init) => {
    ledgerEvents.push('fetch');
    calls.push({ url, init });
    return new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
      model: 'text-embedding-v4',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, embeddingBudgetStub(ledgerEvents));

  const result = await gateway.embed(['первый', 'второй'], embeddingContext());

  assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    model: 'text-embedding-v4',
    input: ['первый', 'второй'],
    dimensions: 3,
    encoding_format: 'float',
  });
  assert.deepEqual(ledgerEvents, ['reserve', 'fetch', 'settle']);

  const invalid = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'alibaba',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-v4',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ALIBABA_API_KEY: 'test-only',
  }, async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 }),
  embeddingBudgetStub([]));
  await assert.rejects(
    invalid.embed(['текст'], embeddingContext()),
    (error) => error instanceof AssistantEmbeddingError && error.code === 'ASSISTANT_EMBEDDING_RESPONSE_INVALID',
  );
});

test('Assistant T03 embedding timeout remains active while the provider response body is read', async () => {
  const ledgerEvents = [];
  const gateway = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'alibaba',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-v4',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    ASSISTANT_EMBEDDING_TIMEOUT_MS: '100',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ALIBABA_API_KEY: 'test-only',
  }, async () => ({
    ok: true,
    status: 200,
    async json() {
      await new Promise((resolve) => setTimeout(resolve, 1_000).unref());
      return { data: [{ index: 0, embedding: [1, 0, 0] }] };
    },
  }), embeddingBudgetStub(ledgerEvents));

  const startedAt = Date.now();
  await assert.rejects(
    gateway.embed(['текст'], embeddingContext()),
    (error) => error instanceof AssistantEmbeddingError
      && error.code === 'ASSISTANT_EMBEDDING_TIMEOUT'
      && error.retryable === true,
  );
  assert.equal(Date.now() - startedAt < 500, true);
  assert.deepEqual(ledgerEvents, ['reserve', 'settle']);
});

test('PIDAFIX1 Alibaba embeddings require live, paid, supported pricing and ledger before HTTP', async () => {
  const base = {
    ASSISTANT_EMBEDDING_MODE: 'alibaba',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-v4',
    ASSISTANT_EMBEDDING_DIMENSIONS: '256',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ALIBABA_API_KEY: 'test-only',
  };
  let fetchCalls = 0;
  let reserveCalls = 0;
  const fetchStub = async () => {
    fetchCalls += 1;
    throw new Error('must not fetch');
  };
  const budget = {
    async reserve() {
      reserveCalls += 1;
      throw new Error('must not reserve');
    },
    async settle() {},
  };

  assert.throws(
    () => new AssistantEmbeddingGateway(base, fetchStub, budget),
    (error) => error.code === 'ASSISTANT_EMBEDDING_LIVE_REQUIRED',
  );
  assert.throws(
    () => new AssistantEmbeddingGateway({ ...base, ASSISTANT_EMBEDDING_LIVE: 'true' }, fetchStub, budget),
    (error) => error.code === 'ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () => new AssistantEmbeddingGateway({
      ...base,
      ASSISTANT_EMBEDDING_LIVE: 'true',
      ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
      ASSISTANT_EMBEDDING_MODEL: 'unknown-embedding-model',
    }, fetchStub, budget),
    (error) => error.code === 'ASSISTANT_EMBEDDING_MODEL_UNPRICED',
  );
  assert.equal(fetchCalls, 0);
  assert.equal(reserveCalls, 0);
});

test('PIDAFIX1 embedding budget conflict prevents the provider HTTP call', async () => {
  let fetchCalls = 0;
  const gateway = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'alibaba',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-v4',
    ASSISTANT_EMBEDDING_DIMENSIONS: '256',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    ALIBABA_API_KEY: 'test-only',
  }, async () => {
    fetchCalls += 1;
    throw new Error('provider must not be called');
  }, {
    async reserve() { throw new Error('ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED'); },
    async settle() { throw new Error('settle must not be called'); },
  });

  await assert.rejects(
    gateway.embed(['текст'], embeddingContext()),
    (error) => error instanceof AssistantEmbeddingError
      && error.code === 'ASSISTANT_EMBEDDING_RESERVATION_FAILED',
  );
  assert.equal(fetchCalls, 0);
});

test('PIDAFIX1 planner and retrieval share one monotonic physical attempt allocator', async () => {
  const ordinals = [];
  let validationCalls = 0;
  const fakePlanner = createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' });
  const planner = new AssistantQueryPlanner({
    async plan(request) {
      ordinals.push(`planner:${request.attemptOrdinal}`);
      return fakePlanner.plan(request);
    },
  });

  const result = await planner.planWithValidation(
    {
      messages: ['Расскажи про проект'],
      context: null,
      operationRunId: '10000000-0000-4000-8000-000000000001',
      executionId: '20000000-0000-4000-8000-000000000001',
    },
    async (_intent, _request, attempts) => {
      validationCalls += 1;
      if (validationCalls === 1) {
        ordinals.push(`embedding:${attempts.nextAttemptOrdinal()}`);
        throw new AssistantPlannerFallbackValidationError('ASSISTANT_TEST_FALLBACK');
      }
      return 'accepted';
    },
  );

  assert.equal(result.value, 'accepted');
  assert.deepEqual(ordinals, ['planner:1', 'embedding:2', 'planner:3']);
});

function embeddingContext() {
  return {
    operation: 'EMBEDDING_RETRIEVAL',
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    nextAttemptOrdinal: () => 2,
  };
}

function embeddingBudgetStub(events) {
  return {
    async reserve(input) {
      events.push('reserve');
      assert.equal(input.operation, 'EMBEDDING_RETRIEVAL');
      assert.equal(input.attemptOrdinal, 2);
      assert.match(input.reservedCostUsd, /^0\.\d{8}$/u);
      return {
        id: '30000000-0000-4000-8000-000000000001',
        operationRunId: input.operationRunId,
        executionId: input.executionId,
        attemptOrdinal: input.attemptOrdinal,
        provider: 'alibaba',
        model: input.model,
        serviceTier: input.serviceTier,
        usageDate: new Date('2026-08-28T00:00:00.000Z'),
        reservationExpiresAt: new Date('2026-08-28T00:02:00.000Z'),
        reservedCostUsd: input.reservedCostUsd,
      };
    },
    async settle(input) {
      events.push('settle');
      assert.equal(input.webSearchCalls, 0);
    },
  };
}

test('Assistant T03 knowledge answer uses deterministic authority, direct external links and visible freshness', () => {
  const fetchedAt = '2026-08-25T08:00:00.000Z';
  const answer = buildAssistantKnowledgeAnswer([
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000010',
      sourceType: 'BANK_PROMOTION',
      kind: 'STATIC_DESCRIPTION',
      label: 'Описание банка',
      value: 'Неофициальное описание проекта.',
      sourcePriority: 900,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000011',
      sourceType: 'DEVELOPMENT_PAGE',
      kind: 'STATIC_DESCRIPTION',
      label: 'ЖК Северный сад',
      value: 'Официальное описание жилого комплекса.',
      sourcePriority: 100,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000012',
      sourceType: 'BANK_PROMOTION',
      kind: 'PROMOTION',
      label: 'Семейная ипотека',
      value: 'Ставка 3,5% до 30 сентября.',
      sourcePriority: 100,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000014',
      sourceType: 'DEVELOPMENT_PAGE',
      kind: 'PROMOTION',
      label: 'Ступенчатая рассрочка',
      value: 'Взнос 30%, затем 12 ежемесячных платежей.',
      sourcePriority: 100,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000013',
      sourceType: 'DEVELOPMENT_PAGE',
      kind: 'EXTERNAL_LOT',
      label: '2-комнатная квартира 67 м²',
      value: {
        title: '2-комнатная квартира 67 м²',
        priceRub: 23900000,
        availability: 'AVAILABLE',
        rooms: 2,
        area: 67,
        href: 'https://developer.example/apartments/lot-42',
      },
      canonicalUrl: 'https://developer.example/apartments/lot-42',
    }),
  ], new Date('2026-08-25T18:00:00.000Z'));

  assert.equal(answer.answer.kind, 'KNOWLEDGE_RESULTS');
  assert.equal(answer.answer.facts[0].label, 'ЖК Северный сад');
  assert.equal(answer.answer.facts.some((fact) => fact.label === 'Описание банка'), false);
  assert.equal(answer.answer.facts.some((fact) => fact.label === 'Семейная ипотека'), true);
  assert.equal(answer.answer.facts.some((fact) => fact.label === 'Ступенчатая рассрочка'), true);
  assert.deepEqual(answer.answer.externalLots[0], {
    id: '00000000-0000-4000-8000-000000000013',
    title: '2-комнатная квартира 67 м²',
    subtitle: '2-комнатная · 67 м²',
    priceRub: 23900000,
    availabilityLabel: 'В продаже на официальном сайте',
    freshnessLabel: 'обновлено 10 часов назад',
    isStale: false,
    href: 'https://developer.example/apartments/lot-42',
  });
  assert.equal(JSON.stringify(answer.answer).includes('sourceRevisionId'), false);
  assert.match(answer.content, /официальным данным/iu);
  assert.equal(fetchedAt, answer.evidence[0].fetchedAt);
});

test('Assistant T03 knowledge query keeps one active scope continuation and bounds old history', () => {
  const context = { kind: 'OBJECT', key: 'severny-sad', label: 'Текущий ЖК' };
  const projectIdentities = [
    { projectKey: 'severny-sad', objectTitle: 'ЖК Северный сад' },
    { projectKey: 'severny-sad-2', objectTitle: 'ЖК Северный сад 2' },
    { projectKey: 'dom-na-mosfilmovskoy', objectTitle: 'ЖК Дом на Мосфильмовской' },
  ];
  assert.equal(createAssistantKnowledgeQueryContext([
    `Старый контекст ${'x'.repeat(1_200)}`,
    'Какая ипотека действует сейчас?',
    'В ЖК Северный сад',
  ], context), 'В ЖК Северный сад\nКакая ипотека действует сейчас?');
  assert.equal(createAssistantKnowledgeQueryContext([
    'Какая ипотека действует сейчас?',
    'Расскажи про архитектуру проекта',
  ], context), 'Расскажи про архитектуру проекта');
  assert.equal(createAssistantKnowledgeQueryContext([
    'Какая ипотека действует сейчас?',
    'В ЖК Южный парк',
  ], null), 'В ЖК Южный парк\nКакая ипотека действует сейчас?');
  const resolveProject = (query, identities = projectIdentities) => {
    const reference = extractAssistantKnowledgeProjectReferenceClause(query);
    return reference ? resolveAssistantKnowledgeProjectIdentity(reference, identities, {
      allowReferenceTail: hasExplicitAssistantKnowledgeProjectReference(query)
        && !isDelimitedAssistantKnowledgeProjectReference(query),
      referenceQuery: query,
    }) : null;
  };
  assert.equal(
    resolveProject('Какая ипотека в ЖК Дом на Мосфильмовской по ипотеке?')?.projectKey,
    'dom-na-mosfilmovskoy',
  );
  for (const query of [
    'Какая ипотека в ЖК Северный сад актуальна сегодня?',
    'Какая ипотека в ЖК Северный сад на текущий момент?',
    'Какая ипотека в ЖК Северный сад на данный момент?',
    'Какая ипотека в ЖК Северный сад на сегодня?',
    'Какая ипотека в ЖК Северный сад доступна сейчас?',
    'Какая ипотека в ЖК Северный сад на текущих условиях?',
    'Какая ипотека в ЖК Северный сад по актуальным условиям?',
    'Какая ипотека в ЖК Северный сад по состоянию на сегодня?',
    'Какие акции в ЖК Северный сад прямо сейчас?',
    'Какие акции в ЖК Северный сад всё ещё действуют?',
    'Есть ли в ЖК «Северный сад» с паркингом?',
    'Есть ли в ЖК Северный сад с паркингом?',
    'Есть ли в ЖК Северный сад по инфраструктуре?',
    'Есть ли в ЖК Северный сад детский сад?',
    'Что есть в ЖК Северный сад из инфраструктуры?',
    'Есть ли в ЖК Северный сад подземный паркинг на 100 мест?',
    'Какие акции в ЖК Северный сад для ипотеки?',
    'Есть ли в ЖК «Северный сад» детский сад?',
    'Какая ипотека сейчас доступна в ЖК «Северный сад» для семей с детьми?',
    'Действует ли ипотека в ЖК Северный сад только для семей с детьми?',
    'Какая ипотека сейчас в ЖК Северный сад доступна многодетным семьям?',
    'Какая ипотека сейчас в ЖК Северный сад доступна семьям с детьми?',
    'Какая ипотека сейчас в ЖК Северный сад подходит семьям с детьми?',
    'Какая рассрочка действует в ЖК Северный сад с первоначальным взносом?',
    'Какая ипотека действует в ЖК Северный сад со ставкой 5%?',
    'Какая ипотека действует в ЖК Северный сад сейчас для семей с детьми?',
    'Какая ипотека в ЖК Северный сад актуальна сегодня для семей с детьми?',
    'Какие акции в ЖК Северный сад всё ещё действуют для семей с детьми?',
    'Какая ипотека в ЖК Северный сад для семей с детьми доступна сейчас?',
  ]) {
    assert.equal(resolveProject(query)?.projectKey, 'severny-sad');
  }
  assert.equal(resolveProject('Какая ипотека в ЖК Северный сад 2?')?.projectKey, 'severny-sad-2');
  assert.equal(resolveProject('Какая ипотека в ЖК Северный сад 3?'), null);
  assert.equal(resolveProject('Какая ипотека в ЖК Северный?'), null);
  assert.equal(resolveProject('Какая ипотека в ЖК Дом на Набережной сейчас?', [
    { projectKey: 'dom', objectTitle: 'ЖК Дом' },
  ]), null);
  assert.equal(resolveProject('Какая ипотека в ЖК Дом на Набережной на покупку?', [
    { projectKey: 'dom', objectTitle: 'ЖК Дом' },
  ]), null);
  for (const query of [
    'Какая ипотека действует в ЖК Дом без Границ?',
    'Какая ипотека действует в ЖК Дом с Маяком?',
    'Какая ипотека действует в ЖК Дом для Новой жизни?',
    'Какая ипотека действует в ЖК Дом у метро?',
    'Какая ипотека действует в ЖК Дом рядом с метро?',
    'Какая ипотека действует в ЖК Дом с паркингом?',
    'Есть ли ипотека в ЖК Дом с паркингом?',
    'Есть ли сейчас действующая ипотека в ЖК Дом с Паркингом?',
    'Паркинг не интересует. Какая ипотека в ЖК Дом с Паркингом?',
    'Паркинг не интересует\nКакая ипотека в ЖК Дом с Паркингом?',
    'Паркинг не интересует\r\nКакая ипотека в ЖК Дом с Паркингом?',
    'Паркинг не интересует… Какая ипотека в ЖК Дом с Паркингом?',
    'Паркинг не интересует — Какая ипотека в ЖК Дом с Паркингом?',
    'Паркинг не интересует - Какая ипотека в ЖК Дом с Паркингом?',
    'Паркинг не интересует – Какая ипотека в ЖК Дом с Паркингом?',
  ]) {
    assert.equal(resolveProject(query, [
      { projectKey: 'dom', objectTitle: 'ЖК Дом' },
    ]), null, query);
  }
  assert.equal(resolveProject('Какая ипотека в ЖК «Дом у метро»?', [
    { projectKey: 'dom', objectTitle: 'ЖК Дом' },
  ]), null);
  assert.equal(resolveProject('Есть ли в ЖК новая ипотека?', [
    { projectKey: 'novaya', objectTitle: 'ЖК Новая' },
  ]), null);
  for (const query of [
    'Какая ипотека в ЖК Дом на Набережной по ипотеке?',
    'Есть ли в ЖК Дом на Набережной с паркингом?',
  ]) {
    assert.equal(resolveProject(query, [
      { projectKey: 'dom', objectTitle: 'ЖК Дом' },
    ]), null, query);
  }
  assert.equal(resolveProject('Какая ипотека в ЖК Северный сад?', [
    projectIdentities[0],
    { projectKey: 'duplicate-severny-sad', objectTitle: 'Северный сад' },
  ]), null);
  for (const query of [
    'Какая ипотека в ЖК «Северный сад»?',
    'Какая ипотека в ЖК "Северный сад"?',
    'Какая ипотека в ЖК (Северный сад)?',
  ]) {
    assert.equal(hasExplicitAssistantKnowledgeProjectReference(query), true, query);
    assert.equal(resolveProject(query)?.projectKey, 'severny-sad');
  }
  for (const query of [
    'Что в ЖК есть из инфраструктуры?',
    'Какая ипотека в ЖК сейчас действует?',
    'Что в ЖК сегодня доступно?',
    'Как в ЖК работает паркинг?',
    'Что в ЖК с паркингом?',
    'Что в ЖК по инфраструктуре?',
    'Есть ли в ЖК детский сад?',
    'Какая ипотека в ЖК на сегодня?',
    'Какая ипотека в ЖК на текущий момент?',
    'Есть ли в ЖК семейная ипотека?',
    'Есть ли в ЖК подземный паркинг?',
    'Какая ипотека действует в ЖК для семей с детьми?',
    'Действует ли в ЖК ипотека для семей с детьми?',
    'Действует ли в ЖК семейная ипотека?',
    'Действует ли в ЖК рассрочка без первоначального взноса?',
    'Какая ипотека действует в ЖК для IT-специалистов?',
    'Действует ли в ЖК рассрочка без процентов?',
    'Действует ли в ЖК ипотека для самозанятых?',
    'Действует ли в ЖК ипотека для граждан РФ?',
    'Действует ли в ЖК семейная ипотека для IT-специалистов?',
    'Что доступно в ЖК сегодня?',
  ]) {
    assert.equal(hasExplicitAssistantKnowledgeProjectReference(query), false, query);
    assert.deepEqual(createAssistantKnowledgePageContext([query], context), context);
  }
  assert.equal(hasExplicitAssistantKnowledgeProjectReference('Что в ЖК «Сегодня»?'), true);
  assert.equal(hasExplicitAssistantKnowledgeProjectReference('Какая ипотека в ЖК Сегодня?'), true);
  assert.equal(hasExplicitAssistantKnowledgeProjectReference('Есть ли в ЖК южный паркс ипотека?'), true);
  assert.equal(hasExplicitAssistantKnowledgeProjectReference('Какая ипотека в ЖК сад у моря?'), true);

  const bounded = createAssistantKnowledgeQueryContext([
    `Какая семейная ипотека действует сейчас? ${'Дополнительный контекст. '.repeat(80)}`,
    'В ЖК Северный сад',
  ], context);
  assert.equal(bounded.length, 1_000);
  assert.match(bounded, /^В ЖК Северный сад\nКакая семейная ипотека действует сейчас\?/u);
  assert.equal(createAssistantKnowledgePageContext([
    'Какая ипотека действует сейчас?',
    'В ЖК Северный сад',
  ], context), null);
  assert.equal(createAssistantKnowledgePageContext([
    'Какая ипотека действует сейчас в ЖК Южный парк?',
  ], context), null);
  const semanticContext = { ...context, label: 'ЖК Северный сад' };
  assert.equal(createAssistantKnowledgePageContext([
    'Какая ипотека действует сейчас?',
    'В ЖК Северный сад',
  ], semanticContext), null);
});

test('Assistant T03 current-condition vocabulary covers natural recency clauses', () => {
  for (const query of [
    'Какая ипотека доступна сейчас?',
    'Какая ипотека актуальна сегодня?',
    'Какая ипотека на текущий момент?',
    'Какая ипотека на данный момент?',
    'Какие последние условия рассрочки?',
    'Какие свежие условия ипотеки?',
    'Какие условия по состоянию на сегодня?',
    'Действительна ли акция?',
    'Действительны ли условия рассрочки?',
    'Условие действительно?',
    'Предложение ещё действительно?',
    'Предложение действительно до конца месяца?',
    'Предложение действительно до завтра?',
    'Условие действительно до 1 сентября?',
    'Какие акции действуют прямо сейчас?',
    'Какие акции всё ещё действуют?',
    'Ипотека всё ещё доступна?',
    'Акция ещё в силе?',
    'Действует ли ипотека?',
    'Действуют ли акции?',
    'Действует ли семейная ипотека?',
    'Действует ли в ЖК ипотека?',
    'Действует ли в ЖК семейная ипотека?',
    'Действует ли в ЖК рассрочка без первоначального взноса?',
    'Какая ипотека действует в ЖК для IT-специалистов?',
    'Действует ли в ЖК рассрочка без процентов?',
    'Действует ли в ЖК ипотека для самозанятых?',
    'Действует ли в ЖК ипотека для граждан РФ?',
    'Действует ли в ЖК семейная ипотека для IT-специалистов?',
    'До какого числа действует акция?',
    'Сколько действует скидка?',
    'Как долго действует ипотека?',
    'Как долго будет действовать акция?',
    'До какого числа акция будет действовать?',
    'Как долго ипотека будет действовать?',
    'Сколько ещё скидка будет действовать?',
    'До какого числа в ЖК Северный сад действует ипотека?',
    'Когда действует акция?',
    'До какого месяца действует акция?',
    'По какое число действует акция?',
    'Сколько времени действует скидка?',
    'Как долго доступна ипотека?',
    'До какого числа доступна ипотека?',
    'Когда закончится акция?',
    'Когда истекает срок предложения?',
    'Когда заканчивается акция?',
    'До какого квартала действует акция?',
    'Как семейная ипотека действует до конца года?',
    'Почему акция действует до 30 сентября?',
    'Акция закончится завтра?',
    'Акция заканчивается завтра?',
    'Срок предложения истекает завтра?',
    'Ипотека будет доступна с января?',
    'Когда истечёт срок предложения?',
    'Когда истекут условия предложения?',
    'Почему акция действует до конца сентября?',
    'Почему акция действует до конца 2026 года?',
    'Акция закончится 30 сентября?',
    'Срок предложения истечёт 30 сентября?',
    'Акция закончится в сентябре?',
    '30 сентября акция закончится?',
    'В сентябре акция закончится?',
    'Акция закончится 30.09.2026?',
    '30.09.2026 акция закончится?',
    'Завтра акция закончится?',
    '31.12.2026 акция закончится?',
    'До конца сентября действует акция?',
    'Как семейная ипотека действует сейчас?',
    'Действует ли в ЖК «Северный сад» семейная ипотека?',
  ]) {
    assert.equal(requiresAssistantKnowledgeCurrentVerification(query), true, query);
  }
  assert.equal(
    requiresAssistantKnowledgeCurrentVerification('Расскажи об архитектуре проекта'),
    false,
  );
  for (const query of [
    'Действительно ли в ЖК Северный сад есть паркинг?',
    'Условия действительно выгодные?',
    'Предложение действительно интересное?',
    'Акция действительно закончилась?',
    'Предложение действительно на редкость выгодное?',
    'Условия действительно до смешного выгодные?',
    'Предложение действительно по сути интересное?',
    'Как действует паркинг?',
    'На кого действует скидка?',
    'На кого скидка действует?',
    'Как рассрочка действует при досрочной оплате?',
    'Как семейная ипотека действует при досрочной оплате?',
    'Почему в ЖК «Северный сад» семейная ипотека действует при досрочной оплате?',
    'Почему скидка действует только при покупке до 30 миллионов рублей?',
    'Как рассрочка действует при взносе до 30 процентов стоимости?',
    'Акция закончилась вчера?',
    'Почему скидка действует только при покупке до максимальной суммы?',
    'Как рассрочка действует при покупке до магазина?',
    'Почему акция действует с материнским капиталом?',
    'Как рассрочка действует с маленьким взносом?',
    'Почему скидка действует с максимальной суммой покупки?',
    'Как ипотека действует со ставкой 3.5%?',
    'Как рассрочка действует при взносе 1/3 стоимости?',
    'Как действует акция «Август»?',
    'На кого скидка действует в ЖК «Северный сад»?',
  ]) {
    assert.equal(requiresAssistantKnowledgeCurrentVerification(query), false, query);
  }
  assert.equal(requiresAssistantKnowledgeCurrentVerification(createAssistantKnowledgeQueryContext([
    'На кого скидка действует?',
    'В ЖК Северный сад',
  ], null)), false);
});

test('Assistant T03 knowledge freshness follows the latest successful source verification', () => {
  const answer = buildAssistantKnowledgeAnswer([
    knowledgeEvidence({
      fetchedAt: '2026-08-20T08:00:00.000Z',
      observedAt: '2026-08-20T08:00:00.000Z',
      verifiedAt: '2026-08-25T17:30:00.000Z',
    }),
  ], new Date('2026-08-25T18:00:00.000Z'));

  assert.deepEqual(answer.answer.facts[0], {
    id: '00000000-0000-4000-8000-000000000001',
    label: 'Факт',
    value: 'Значение',
    sourceLabel: 'Официальный сайт проекта · developer.example',
    sourceUrl: 'https://developer.example/project',
    verifiedAt: '2026-08-25T17:30:00.000Z',
    freshnessLabel: 'обновлено менее часа назад',
    isStale: false,
  });
});

test('Assistant T03 stored fact contract accepts complete source metadata and legacy cards only', () => {
  const built = buildAssistantKnowledgeAnswer([knowledgeEvidence()]);
  const service = Object.create(AssistantService.prototype);

  assert.deepEqual(service.parseStoredAnswer(built.answer), built.answer);
  const partial = structuredClone(built.answer);
  delete partial.facts[0].verifiedAt;
  assert.equal(service.parseStoredAnswer(partial), null);
  const legacy = structuredClone(built.answer);
  delete legacy.facts[0].sourceLabel;
  delete legacy.facts[0].sourceUrl;
  delete legacy.facts[0].verifiedAt;
  assert.notEqual(service.parseStoredAnswer(legacy), null);
  assert.deepEqual(service.parseStoredAnswer({ kind: 'REFUSAL', code: 'SOURCE_NOT_CONNECTED' }), {
    kind: 'REFUSAL',
    code: 'SOURCE_NOT_CONNECTED',
  });
});

test('Assistant T03 installment facts apply relevance before resolving source conflicts', () => {
  const answer = buildAssistantKnowledgeAnswer([
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000021',
      kind: 'ARCHITECTURE',
      label: 'Архитектура проекта',
      value: 'Фасады разработаны известным бюро.',
      retrievalScore: 100,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000022',
      sourceId: '00000000-0000-4000-8000-000000000032',
      sourceRevisionId: '00000000-0000-4000-8000-000000000042',
      sourceType: 'BANK_PROMOTION',
      sourcePriority: 900,
      kind: 'PROMOTION',
      label: 'Рассрочка',
      value: 'Первоначальный взнос 20%.',
      sourceLabel: 'Официальный сайт банка · bank.example',
      sourceUrl: 'https://bank.example/installment',
      canonicalUrl: 'https://bank.example/installment',
      projectKey: null,
      developerKey: null,
      retrievalScore: 20,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000023',
      sourceId: '00000000-0000-4000-8000-000000000033',
      sourceRevisionId: '00000000-0000-4000-8000-000000000043',
      kind: 'PROMOTION',
      label: 'Условия рассрочки',
      value: 'Первоначальный взнос 30%.',
      retrievalScore: 1,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000024',
      kind: 'STATIC_DESCRIPTION',
      label: 'Маркетинговое описание',
      value: 'Новая философия городской жизни.',
      retrievalScore: 90,
    }),
  ], new Date('2026-08-25T18:00:00.000Z'), 'Какие сейчас условия рассрочки?');

  assert.deepEqual(answer.answer.facts.map((fact) => fact.id), [
    '00000000-0000-4000-8000-000000000023',
  ]);
  assert.match(answer.content, /источники расходятся/iu);
  assert.match(answer.content, /официальн\S* сайт\S* проекта/iu);
});

test('Assistant T03 installment facts prefer a focused promotion over a broad page aggregate', () => {
  const answer = buildAssistantKnowledgeAnswer([
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000001',
      kind: 'PROMOTION',
      label: 'ЖК Северный сад',
      value: [
        'Архитектура Кирпичные фасады.',
        'Семейная ипотека Ставка 3,5%.',
        'Ступенчатая рассрочка Первоначальный взнос 30%, затем 12 ежемесячных платежей.',
      ].join(' '),
      retrievalScore: 5,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000099',
      kind: 'PROMOTION',
      label: 'Ступенчатая рассрочка',
      value: 'Первоначальный взнос 30%, затем 12 ежемесячных платежей.',
      retrievalScore: 5,
    }),
  ], new Date('2026-08-25T18:00:00.000Z'), 'Какие точные условия ступенчатой рассрочки?');

  assert.deepEqual(answer.answer.facts.map((fact) => fact.label), ['Ступенчатая рассрочка']);
});

test('Assistant T03 mortgage facts prefer a focused heading over a generic promotions aggregate', () => {
  const answer = buildAssistantKnowledgeAnswer([
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000091',
      sourceId: '00000000-0000-4000-8000-000000000031',
      sourceRevisionId: '00000000-0000-4000-8000-000000000041',
      sourceType: 'DEVELOPER_PROMOTION',
      kind: 'PROMOTION',
      label: 'Акции застройщика',
      value: 'Акции застройщика Семейная ипотека застройщика Ставка 4,4%.',
      retrievalScore: 8,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000092',
      sourceId: '00000000-0000-4000-8000-000000000031',
      sourceRevisionId: '00000000-0000-4000-8000-000000000041',
      sourceType: 'DEVELOPER_PROMOTION',
      kind: 'PROMOTION',
      label: 'Семейная ипотека застройщика',
      value: 'Ставка 4,4%.',
      retrievalScore: 8,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000093',
      sourceId: '00000000-0000-4000-8000-000000000032',
      sourceRevisionId: '00000000-0000-4000-8000-000000000042',
      sourceType: 'BANK_PROMOTION',
      sourcePriority: 900,
      kind: 'PROMOTION',
      label: 'Акции банка',
      value: 'Акции банка Семейная ипотека банка Ставка 5,5%.',
      retrievalScore: 9,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000094',
      sourceId: '00000000-0000-4000-8000-000000000032',
      sourceRevisionId: '00000000-0000-4000-8000-000000000042',
      sourceType: 'BANK_PROMOTION',
      sourcePriority: 900,
      kind: 'PROMOTION',
      label: 'Семейная ипотека банка',
      value: 'Ставка 5,5%.',
      retrievalScore: 9,
    }),
  ], new Date('2026-08-25T18:00:00.000Z'), 'Какая семейная ипотека действует?');

  assert.deepEqual(answer.answer.facts.map(({ id }) => id), [
    '00000000-0000-4000-8000-000000000094',
  ]);
  assert.match(answer.content, /источники расходятся/iu);
});

test('Assistant T03 keeps distinct installment offers from the same official source', () => {
  const answer = buildAssistantKnowledgeAnswer([
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000081',
      kind: 'PROMOTION',
      label: 'Ступенчатая рассрочка',
      value: 'Первоначальный взнос 30%, затем 12 ежемесячных платежей.',
      retrievalScore: 8,
    }),
    knowledgeEvidence({
      factId: '00000000-0000-4000-8000-000000000082',
      kind: 'PROMOTION',
      label: 'Рассрочка без удорожания',
      value: 'Первоначальный взнос 50%, остаток через 6 месяцев.',
      retrievalScore: 7,
    }),
  ], new Date('2026-08-25T18:00:00.000Z'), 'Какие условия рассрочки доступны?');

  assert.deepEqual(answer.answer.facts.map(({ label }) => label), [
    'Ступенчатая рассрочка',
    'Рассрочка без удорожания',
  ]);
  assert.doesNotMatch(answer.content, /источники расходятся/iu);
});

test('Assistant T03 answer service uses an official external lot only after Platforma has no exact match', async () => {
  const intent = {
    taskType: 'SEARCH',
    comparisonTargets: [],
    hardFilters: { ...emptySearchFilters(), budgetMaxRub: 24_000_000, rooms: [2] },
    softPreferences: emptySearchFilters(),
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
  let retrievalCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return intent; } }),
    { async search() { return { exact: [], alternatives: [] }; } },
    {
      async retrieve({ includeExternalLots, embeddingOperation }) {
        retrievalCalls += 1;
        assert.equal(includeExternalLots, true);
        assert.equal(embeddingOperation.operationRunId, '10000000-0000-4000-8000-000000000001');
        assert.equal(embeddingOperation.executionId, '20000000-0000-4000-8000-000000000001');
        assert.equal(embeddingOperation.nextAttemptOrdinal(), 2);
        return [knowledgeEvidence({
          kind: 'EXTERNAL_LOT',
          label: '2-комнатная квартира 67 м²',
          value: {
            title: '2-комнатная квартира 67 м²',
            priceRub: 23900000,
            availability: 'AVAILABLE',
            rooms: 2,
            area: 67,
            href: 'https://developer.example/apartments/lot-42',
          },
          canonicalUrl: 'https://developer.example/apartments/lot-42',
        })];
      },
    },
  );

  const result = await service.answer({
    messages: ['Двушка до 24 млн в Северном саду'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'Текущий ЖК' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
  });

  assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
  assert.equal(result.answer.externalLots[0].href, 'https://developer.example/apartments/lot-42');
  assert.equal(result.evidence[0].sourceRevisionId, '00000000-0000-4000-8000-000000000003');
  assert.equal(retrievalCalls, 1);
});

test('Assistant T03 current FACT performs one bounded refresh and then uses only persisted facts', async () => {
  const intent = factIntent();
  let retrievalCalls = 0;
  let refreshCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return intent; } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async retrieve() {
        retrievalCalls += 1;
        return [knowledgeEvidence({
          kind: 'PROMOTION',
          label: 'Условия рассрочки',
          value: retrievalCalls === 1 ? 'Старое persisted значение.' : 'Взнос 30%, затем 12 платежей.',
          verifiedAt: '2026-08-25T17:59:00.000Z',
        })];
      },
    },
    undefined,
    {
      async refreshForRun(input) {
        refreshCalls += 1;
        assert.equal(input.preferredSourceId, '00000000-0000-4000-8000-000000000002');
        return { status: 'COMPLETED', rawConnectorText: 'НЕ ДОЛЖНО ПОПАСТЬ В ОТВЕТ' };
      },
    },
  );

  const result = await service.answer({
    messages: ['Какие условия рассрочки действуют?'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
  });

  assert.equal(refreshCalls, 1);
  assert.equal(retrievalCalls, 2);
  assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
  assert.equal(result.answer.facts[0].value, 'Взнос 30%, затем 12 платежей.');
  assert.doesNotMatch(result.content, /НЕ ДОЛЖНО/iu);
});

test('Assistant T03 natural recency wording still performs the bounded refresh', async () => {
  for (const query of [
    'Какая ипотека в ЖК Северный сад на данный момент?',
    'Какие свежие условия ипотеки в ЖК Северный сад?',
    'Действительны ли условия рассрочки в ЖК Северный сад?',
  ]) {
    let retrievalCalls = 0;
    let refreshCalls = 0;
    const resolvedContext = { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' };
    const service = new AssistantAnswerService(
      new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
      { async search() { throw new Error('search must not run'); } },
      {
        async resolveProjectContext() { return resolvedContext; },
        async retrieve() {
          retrievalCalls += 1;
          return [knowledgeEvidence({
            kind: 'PROMOTION',
            label: /рассроч/iu.test(query) ? 'Условия рассрочки' : 'Семейная ипотека',
            value: /рассроч/iu.test(query) ? 'Взнос 30%, затем 12 платежей.' : 'Ставка 4,4%.',
            verifiedAt: '2026-08-25T17:59:00.000Z',
          })];
        },
      },
      undefined,
      {
        async refreshForRun() {
          refreshCalls += 1;
          return { status: 'COMPLETED' };
        },
      },
    );

    const result = await service.answer({
      messages: [query],
      context: null,
      operationRunId: '10000000-0000-4000-8000-000000000001',
      executionId: '20000000-0000-4000-8000-000000000001',
      now: new Date('2026-08-25T18:00:00.000Z'),
      deadlineAt: new Date(Date.now() + 10_000),
    });

    assert.equal(refreshCalls, 1, query);
    assert.equal(retrievalCalls, 2, query);
    assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
  }
});

test('Assistant T03 confirmation wording does not force a current-condition refresh', async () => {
  let retrievalCalls = 0;
  let refreshCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async retrieve() {
        retrievalCalls += 1;
        return [knowledgeEvidence({
          kind: 'STATIC_DESCRIPTION',
          label: 'Паркинг',
          value: 'В проекте предусмотрен подземный паркинг.',
          verifiedAt: '2026-08-25T17:59:00.000Z',
        })];
      },
    },
    undefined,
    {
      async refreshForRun() {
        refreshCalls += 1;
        return { status: 'COMPLETED' };
      },
    },
  );

  const result = await service.answer({
    messages: ['Действительно ли в ЖК Северный сад есть паркинг?'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
  });

  assert.equal(refreshCalls, 0);
  assert.equal(retrievalCalls, 1);
  assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
});

test('Assistant T03 current FACT keeps the active multi-turn query through retrieval and refresh', async () => {
  const queries = [];
  const retrievalContexts = [];
  let refreshCalls = 0;
  const resolvedContext = { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' };
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async resolveProjectContext(query) {
        assert.match(query, /семейная ипотека/iu);
        assert.match(query, /Северный сад/iu);
        return resolvedContext;
      },
      async retrieve({ query, context }) {
        queries.push(query);
        retrievalContexts.push(context);
        if (queries.length === 1) return [];
        return [knowledgeEvidence({
          kind: 'PROMOTION',
          label: 'Семейная ипотека',
          value: 'Ставка 4,4%.',
          verifiedAt: '2026-08-25T17:59:00.000Z',
        })];
      },
    },
    undefined,
    {
      async refreshForRun(input) {
        refreshCalls += 1;
        assert.deepEqual(input.context, resolvedContext);
        assert.equal(input.preferredSourceId, null);
        return { status: 'COMPLETED' };
      },
    },
  );

  const previousTurn = `Какая семейная ипотека действует сейчас? ${'Дополнительный старый контекст. '.repeat(60)}`;
  const result = await service.answer({
    messages: [previousTurn, 'В ЖК Северный сад'],
    context: null,
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
  });

  assert.equal(refreshCalls, 1);
  assert.equal(queries.length, 2);
  assert.equal(queries.every((query) => query.includes('семейная ипотека') && query.includes('Северный сад')), true);
  assert.equal(queries.every((query) => query.length <= 1_000), true);
  assert.deepEqual(retrievalContexts, [resolvedContext, resolvedContext]);
  assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
});

test('Assistant T03 current FACT resolves a named project over a conflicting object page', async () => {
  const originalContext = { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' };
  const resolvedContext = { kind: 'OBJECT', key: 'yuzhny-park', label: 'ЖК южный парк' };
  const retrievalContexts = [];
  let resolverCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async resolveProjectContext(query) {
        resolverCalls += 1;
        assert.match(query, /ЖК\s+«?Южный парк»?/iu);
        return resolvedContext;
      },
      async retrieve({ context }) {
        retrievalContexts.push(context);
        return [knowledgeEvidence({
          kind: 'PROMOTION',
          label: 'Семейная ипотека',
          value: 'Ставка 5,1%.',
          projectKey: 'yuzhny-park',
          verifiedAt: '2026-08-25T17:59:00.000Z',
        })];
      },
    },
    undefined,
    {
      async refreshForRun(input) {
        assert.deepEqual(input.context, resolvedContext);
        return { status: 'COMPLETED' };
      },
    },
  );

  const result = await service.answer({
    messages: ['Какая семейная ипотека действует сейчас в ЖК «Южный парк»?'],
    context: originalContext,
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
  });

  assert.equal(resolverCalls, 1);
  assert.deepEqual(retrievalContexts, [resolvedContext, resolvedContext]);
  assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
  assert.equal(result.answer.facts[0].value, 'Ставка 5,1%.');
});

test('Assistant T03 unresolved named project fails closed before retrieval or refresh', async () => {
  let retrievalCalls = 0;
  let refreshCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async resolveProjectContext() { return null; },
      async retrieve() {
        retrievalCalls += 1;
        return [knowledgeEvidence()];
      },
    },
    undefined,
    {
      async refreshForRun() {
        refreshCalls += 1;
        return { status: 'COMPLETED' };
      },
    },
  );

  const result = await service.answer({
    messages: ['Какая ипотека действует сейчас в ЖК Несуществующий?'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Несуществующий' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
  });

  assert.equal(result.answer.kind, 'REFUSAL');
  assert.equal(result.answer.code, 'SOURCE_NOT_CONNECTED');
  assert.equal(retrievalCalls, 0);
  assert.equal(refreshCalls, 0);
});

test('Assistant T03 quoted unknown project stays explicit and fails closed', async () => {
  let retrievalCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async resolveProjectContext(query) {
        return hasExplicitAssistantKnowledgeProjectReference(query) ? null : undefined;
      },
      async retrieve() {
        retrievalCalls += 1;
        return [knowledgeEvidence()];
      },
    },
  );

  const result = await service.answer({
    messages: ['Что сейчас действует в ЖК «Сегодня»?'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    now: new Date('2026-08-25T18:00:00.000Z'),
  });

  assert.deepEqual(result.answer, { kind: 'REFUSAL', code: 'SOURCE_NOT_CONNECTED' });
  assert.equal(retrievalCalls, 0);
});

test('Assistant T03 context-only project wording without an object page never retrieves globally', async () => {
  let retrievalCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async resolveProjectContext() { return undefined; },
      async retrieve() {
        retrievalCalls += 1;
        return [knowledgeEvidence()];
      },
    },
  );

  const result = await service.answer({
    messages: ['Какая ипотека в ЖК сейчас действует?'],
    context: null,
    now: new Date('2026-08-25T18:00:00.000Z'),
  });

  assert.deepEqual(result.answer, { kind: 'REFUSAL' });
  assert.match(result.content, /указать жк|страниц\S* объекта/iu);
  assert.equal(retrievalCalls, 0);
});

test('Assistant T03 current FACT without a project or developer scope never retrieves globally', async () => {
  let retrievalCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async retrieve() {
        retrievalCalls += 1;
        return [knowledgeEvidence()];
      },
    },
  );

  for (const query of ['Какая ипотека сейчас действует?', 'Действует ли ипотека?']) {
    const result = await service.answer({
      messages: [query],
      context: null,
      now: new Date('2026-08-25T18:00:00.000Z'),
    });
    assert.deepEqual(result.answer, { kind: 'REFUSAL' }, query);
    assert.match(result.content, /указать жк|страниц\S* объекта/iu, query);
  }
  assert.equal(retrievalCalls, 0);
});

test('Assistant T03 current FACT drops stale markers when the latest turn starts a new topic', async () => {
  const queries = [];
  let refreshCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async retrieve({ query }) {
        queries.push(query);
        return [
          knowledgeEvidence({
            factId: '00000000-0000-4000-8000-000000000071',
            kind: 'PROMOTION',
            label: 'Семейная ипотека',
            value: 'Ставка 4,4%.',
            retrievalScore: 1,
          }),
          knowledgeEvidence({
            factId: '00000000-0000-4000-8000-000000000072',
            kind: 'STATIC_DESCRIPTION',
            label: 'Архитектура проекта',
            value: 'Фасады облицованы клинкерным кирпичом.',
            retrievalScore: 10,
          }),
        ];
      },
    },
    undefined,
    {
      async refreshForRun() {
        refreshCalls += 1;
        return { status: 'COMPLETED' };
      },
    },
  );

  const result = await service.answer({
    messages: [
      `Какие условия ипотеки действуют сейчас? ${'Устаревший контекст. '.repeat(80)}`,
      'Расскажи об архитектуре проекта',
    ],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
  });

  assert.equal(refreshCalls, 0);
  assert.deepEqual(queries, ['Расскажи об архитектуре проекта']);
  assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
  assert.equal(result.answer.facts.some((fact) => fact.label === 'Архитектура проекта'), true);
});

test('Assistant T03 missing trusted source wins over a disabled connector flag', async () => {
  let sourceReads = 0;
  const coordinator = new AssistantCurrentFactRefreshCoordinator(
    {
      assistantKnowledgeSource: {
        async findMany() {
          sourceReads += 1;
          return [];
        },
      },
      assistantSourceJob: { async upsert() { throw new Error('job must not be created'); } },
    },
    { async runTargetedJob() { throw new Error('worker must not run'); } },
    { ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false' },
  );

  const result = await coordinator.refreshForRun({
    operationRunId: '10000000-0000-4000-8000-000000000001',
    context: { kind: 'OBJECT', key: 'missing-project', label: 'Неизвестный ЖК' },
    preferredSourceId: null,
    deadlineAt: new Date(Date.now() + 1_000),
  });

  assert.deepEqual(result, { status: 'SOURCE_NOT_CONNECTED' });
  assert.equal(sourceReads, 1);
});

test('Assistant T03 current refresh uses one idempotent exact-host registered source job', async () => {
  const sources = [
    currentFactSource({
      id: '00000000-0000-4000-8000-000000000051',
      priority: 900,
      connectorConfigJson: { allowedHosts: ['evil.example'] },
    }),
    currentFactSource({ id: '00000000-0000-4000-8000-000000000052' }),
    currentFactSource({
      id: '00000000-0000-4000-8000-000000000053',
      projectKey: 'other-project',
      canonicalUrl: 'https://other.example/project',
      connectorConfigJson: { allowedHosts: ['other.example'] },
    }),
  ];
  let jobStatus = 'PENDING';
  const upserts = [];
  let workerCalls = 0;
  const coordinator = new AssistantCurrentFactRefreshCoordinator(
    {
      assistantKnowledgeSource: {
        async findMany({ where }) {
          return where.id ? sources.filter(({ id }) => id === where.id) : sources;
        },
      },
      assistantSourceJob: {
        async upsert(input) {
          upserts.push(input);
          return {
            id: '00000000-0000-4000-8000-000000000061',
            sourceId: input.create.sourceId,
            status: jobStatus,
            errorCode: null,
          };
        },
      },
    },
    {
      async runTargetedJob() {
        workerCalls += 1;
        jobStatus = 'COMPLETED';
        return { status: 'COMPLETED', errorCode: null };
      },
    },
    { ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'true' },
  );
  const input = {
    operationRunId: '10000000-0000-4000-8000-000000000001',
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    preferredSourceId: null,
    deadlineAt: new Date(Date.now() + 1_000),
  };

  assert.deepEqual(await coordinator.refreshForRun(input), { status: 'COMPLETED' });
  assert.deepEqual(await coordinator.refreshForRun(input), { status: 'COMPLETED' });
  assert.deepEqual(await coordinator.refreshForRun({
    ...input,
    operationRunId: '10000000-0000-4000-8000-000000000006',
    preferredSourceId: sources[0].id,
  }), { status: 'COMPLETED' });
  assert.equal(workerCalls, 1);
  assert.equal(upserts.length, 3);
  assert.equal(upserts[0].create.sourceId, '00000000-0000-4000-8000-000000000052');
  assert.equal(upserts[2].create.sourceId, '00000000-0000-4000-8000-000000000052');
  assert.equal(upserts[0].create.maxAttempts, 1);
  assert.equal(upserts[0].create.idempotencyKey, 'current-fact:10000000-0000-4000-8000-000000000001');
});

test('Assistant T03 current refresh keeps a valid low-priority preferred source in its bounded read', async () => {
  const preferred = currentFactSource({
    id: '00000000-0000-4000-8000-000000000090',
    priority: 1,
  });
  const higherPrioritySources = Array.from({ length: 20 }, (_, index) => currentFactSource({
    id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
    priority: 1_000 - index,
  }));
  let selectedSourceId = null;
  const coordinator = new AssistantCurrentFactRefreshCoordinator(
    {
      assistantKnowledgeSource: {
        async findMany({ where, take }) {
          if (where.id === preferred.id) return [preferred];
          return higherPrioritySources.slice(0, take);
        },
      },
      assistantSourceJob: {
        async upsert(input) {
          selectedSourceId = input.create.sourceId;
          return {
            id: '00000000-0000-4000-8000-000000000091',
            sourceId: selectedSourceId,
            status: 'PENDING',
            errorCode: null,
          };
        },
      },
    },
    { async runTargetedJob() { return { status: 'COMPLETED', errorCode: null }; } },
    { ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'true' },
  );

  assert.deepEqual(await coordinator.refreshForRun({
    operationRunId: '10000000-0000-4000-8000-000000000007',
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    preferredSourceId: preferred.id,
    deadlineAt: new Date(Date.now() + 1_000),
  }), { status: 'COMPLETED' });
  assert.equal(selectedSourceId, preferred.id);
});

test('Assistant T03 current refresh fixture mode runs the persisted job with external connectors disabled', async () => {
  let upsertCalls = 0;
  let workerCalls = 0;
  const source = currentFactSource();
  const coordinator = new AssistantCurrentFactRefreshCoordinator(
    {
      assistantKnowledgeSource: {
        async findMany() { return [source]; },
      },
      assistantSourceJob: {
        async upsert(input) {
          upsertCalls += 1;
          assert.equal(input.create.sourceId, source.id);
          assert.equal(
            input.create.idempotencyKey,
            'current-fact:10000000-0000-4000-8000-000000000008',
          );
          return {
            id: '00000000-0000-4000-8000-000000000092',
            sourceId: source.id,
            status: 'PENDING',
            errorCode: null,
          };
        },
      },
    },
    {
      async runTargetedJob() {
        workerCalls += 1;
        return { status: 'COMPLETED', errorCode: null };
      },
    },
    {
      NODE_ENV: 'test',
      DEPLOYMENT_ENV: 'local',
      ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false',
      ASSISTANT_CURRENT_FACT_REFRESH_MODE: 'fixture',
    },
  );

  assert.deepEqual(await coordinator.refreshForRun({
    operationRunId: '10000000-0000-4000-8000-000000000008',
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    preferredSourceId: source.id,
    deadlineAt: new Date(Date.now() + 1_000),
  }), { status: 'COMPLETED' });
  assert.equal(upsertCalls, 1);
  assert.equal(workerCalls, 1);
});

test('Assistant T03 current refresh accepts only a developer source linked to the object registry', async () => {
  const preferredSource = currentFactSource({
    id: '00000000-0000-4000-8000-000000000054',
    canonicalUrl: 'https://developer.example/promotions',
    type: 'DEVELOPER_PROMOTION',
    projectKey: null,
  });
  let linked = true;
  let linkLookups = 0;
  let upsertCalls = 0;
  const coordinator = new AssistantCurrentFactRefreshCoordinator(
    {
      assistantKnowledgeSource: {
        async findMany() { return [preferredSource]; },
        async findFirst({ where }) {
          linkLookups += 1;
          assert.equal(where.projectKey, 'severny-sad');
          assert.equal(where.developerKey, 'developer-example');
          assert.equal(where.type, 'DEVELOPMENT_PAGE');
          assert.equal(where.state, 'ACTIVE');
          return linked ? { id: '00000000-0000-4000-8000-000000000055' } : null;
        },
      },
      assistantSourceJob: {
        async upsert(input) {
          upsertCalls += 1;
          assert.equal(input.create.sourceId, preferredSource.id);
          return {
            id: '00000000-0000-4000-8000-000000000062',
            sourceId: preferredSource.id,
            status: 'PENDING',
            errorCode: null,
          };
        },
      },
    },
    { async runTargetedJob() { return { status: 'COMPLETED', errorCode: null }; } },
    { ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'true' },
  );
  const baseInput = {
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'Текущий ЖК' },
    preferredSourceId: preferredSource.id,
    deadlineAt: new Date(Date.now() + 1_000),
  };

  assert.deepEqual(await coordinator.refreshForRun({
    ...baseInput,
    operationRunId: '10000000-0000-4000-8000-000000000003',
  }), { status: 'COMPLETED' });
  linked = false;
  assert.deepEqual(await coordinator.refreshForRun({
    ...baseInput,
    operationRunId: '10000000-0000-4000-8000-000000000004',
  }), { status: 'SOURCE_NOT_CONNECTED' });
  assert.equal(linkLookups, 2);
  assert.equal(upsertCalls, 1);
});

test('Assistant T03 current refresh waits for an already running idempotent job', async () => {
  let jobReads = 0;
  const coordinator = new AssistantCurrentFactRefreshCoordinator(
    {
      assistantKnowledgeSource: { async findMany() { return [currentFactSource()]; } },
      assistantSourceJob: {
        async upsert() {
          return {
            id: '00000000-0000-4000-8000-000000000063',
            sourceId: '00000000-0000-4000-8000-000000000050',
            status: 'RUNNING',
            errorCode: null,
          };
        },
        async findUnique() {
          jobReads += 1;
          return {
            status: jobReads === 1 ? 'RUNNING' : 'COMPLETED',
            errorCode: null,
          };
        },
      },
    },
    { async runTargetedJob() { return { status: 'RUNNING', errorCode: null }; } },
    { ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'true' },
  );

  const result = await coordinator.refreshForRun({
    operationRunId: '10000000-0000-4000-8000-000000000005',
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'Текущий ЖК' },
    preferredSourceId: '00000000-0000-4000-8000-000000000050',
    deadlineAt: new Date(Date.now() + 1_000),
  });

  assert.deepEqual(result, { status: 'COMPLETED' });
  assert.equal(jobReads, 2);
});

test('Assistant T03 current FACT reports SOURCE_NOT_CONNECTED without arbitrary fallback evidence', async () => {
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    { async retrieve() { return []; } },
    undefined,
    { async refreshForRun() { return { status: 'SOURCE_NOT_CONNECTED' }; } },
  );

  const result = await service.answer({
    messages: ['Какие актуальные условия рассрочки?'],
    context: { kind: 'OBJECT', key: 'unknown-project', label: 'Неизвестный ЖК' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
  });

  assert.deepEqual(result.answer, { kind: 'REFUSAL', code: 'SOURCE_NOT_CONNECTED' });
  assert.match(result.content, /зарегистрированн\S* источник/iu);
});

test('Assistant T03 failed current refresh never claims stale facts are current', async () => {
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return factIntent(); } }),
    { async search() { throw new Error('search must not run'); } },
    {
      async retrieve() {
        return [knowledgeEvidence({
          kind: 'PROMOTION',
          label: 'Условия рассрочки',
          value: 'Старые условия.',
          verifiedAt: '2026-08-20T08:00:00.000Z',
        })];
      },
    },
    undefined,
    { async refreshForRun() { return { status: 'FAILED' }; } },
  );

  const result = await service.answer({
    messages: ['Какие сейчас условия рассрочки?'],
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
  });

  assert.equal(result.answer.kind, 'REFUSAL');
  assert.doesNotMatch(result.content, /\b(?:сейчас|актуальн\S*)\b/iu);
  assert.match(result.content, /не удалось подтвердить/iu);
});

function knowledgeEvidence(overrides = {}) {
  return {
    evidenceType: 'KNOWLEDGE_SOURCE',
    factId: '00000000-0000-4000-8000-000000000001',
    sourceId: '00000000-0000-4000-8000-000000000002',
    sourceRevisionId: '00000000-0000-4000-8000-000000000003',
    sourceType: 'DEVELOPMENT_PAGE',
    sourcePriority: 100,
    kind: 'STATIC_DESCRIPTION',
    label: 'Факт',
    value: 'Значение',
    canonicalUrl: 'https://developer.example/project',
    sourceLabel: 'Официальный сайт проекта · developer.example',
    sourceUrl: 'https://developer.example/project',
    observedAt: '2026-08-25T08:00:00.000Z',
    fetchedAt: '2026-08-25T08:00:00.000Z',
    verifiedAt: '2026-08-25T08:00:00.000Z',
    projectKey: 'severny-sad',
    developerKey: 'developer-example',
    retrievalChannels: ['STRUCTURED_SQL'],
    retrievalScore: 1,
    ...overrides,
  };
}

function factIntent() {
  return {
    taskType: 'FACT',
    comparisonTargets: [],
    hardFilters: emptySearchFilters(),
    softPreferences: emptySearchFilters(),
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
}

function currentFactSource(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000050',
    canonicalUrl: 'https://developer.example/project',
    type: 'DEVELOPMENT_PAGE',
    state: 'ACTIVE',
    priority: 100,
    connectorKey: 'OFFICIAL_HTML',
    connectorConfigJson: { allowedHosts: ['developer.example'] },
    projectKey: 'severny-sad',
    developerKey: 'developer-example',
    ...overrides,
  };
}

function emptySearchFilters() {
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
