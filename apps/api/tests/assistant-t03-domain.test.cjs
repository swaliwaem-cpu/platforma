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
  buildAssistantKnowledgeAnswer,
} = require('../dist/assistant/sources/assistant-knowledge-answer.js');
const {
  AssistantAnswerService,
} = require('../dist/assistant/assistant-answer.service.js');
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

test('Assistant T03 production OpenAI embeddings require the exact reproducible benchmark winner', () => {
  const environment = {
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '256',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'test-only',
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
      `text-embedding-3-small:256:${assistantEmbeddingBenchmarkDatasetSha256}`,
  });
  assert.equal(gateway.getModel(), 'text-embedding-3-small');
  assert.equal(gateway.getDimensions(), 256);
});

test('Assistant T03 OpenAI embedding gateway validates the configured benchmark winner and response shape', async () => {
  const calls = [];
  const ledgerEvents = [];
  const gateway = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'test-only',
  }, async (url, init) => {
    ledgerEvents.push('fetch');
    calls.push({ url, init });
    return new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, embeddingBudgetStub(ledgerEvents));

  const result = await gateway.embed(['первый', 'второй'], embeddingContext());

  assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    model: 'text-embedding-3-small',
    input: ['первый', 'второй'],
    dimensions: 3,
    encoding_format: 'float',
  });
  assert.deepEqual(ledgerEvents, ['reserve', 'fetch', 'settle']);

  const invalid = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'test-only',
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
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    ASSISTANT_EMBEDDING_TIMEOUT_MS: '100',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'test-only',
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

test('PIDAFIX1 OpenAI embeddings require live, paid, supported pricing and ledger before HTTP', async () => {
  const base = {
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '256',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    OPENAI_API_KEY: 'test-only',
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
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_LIVE: 'true',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '256',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'test-only',
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
        provider: 'openai',
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
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    operationRunId: '10000000-0000-4000-8000-000000000001',
    executionId: '20000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T18:00:00.000Z'),
  });

  assert.equal(result.answer.kind, 'KNOWLEDGE_RESULTS');
  assert.equal(result.answer.externalLots[0].href, 'https://developer.example/apartments/lot-42');
  assert.equal(result.evidence[0].sourceRevisionId, '00000000-0000-4000-8000-000000000003');
  assert.equal(retrievalCalls, 1);
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
    observedAt: '2026-08-25T08:00:00.000Z',
    fetchedAt: '2026-08-25T08:00:00.000Z',
    projectKey: 'severny-sad',
    developerKey: 'developer-example',
    retrievalChannels: ['STRUCTURED_SQL'],
    retrievalScore: 1,
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
