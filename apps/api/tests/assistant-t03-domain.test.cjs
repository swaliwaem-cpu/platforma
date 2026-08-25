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
} = require('../dist/assistant/sources/assistant-embedding.gateway.js');
const {
  buildAssistantKnowledgeAnswer,
} = require('../dist/assistant/sources/assistant-knowledge-answer.js');
const {
  AssistantAnswerService,
} = require('../dist/assistant/assistant-answer.service.js');
const {
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
  assert.deepEqual(first.vectors[0], second.vectors[0]);
  assert.notDeepEqual(first.vectors[0], first.vectors[1]);
});

test('Assistant T03 OpenAI embedding gateway validates the configured benchmark winner and response shape', async () => {
  const calls = [];
  const gateway = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    OPENAI_API_KEY: 'test-only',
  }, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await gateway.embed(['первый', 'второй']);

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

  const invalid = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    OPENAI_API_KEY: 'test-only',
  }, async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 }));
  await assert.rejects(
    invalid.embed(['текст']),
    (error) => error instanceof AssistantEmbeddingError && error.code === 'ASSISTANT_EMBEDDING_RESPONSE_INVALID',
  );
});

test('Assistant T03 embedding timeout remains active while the provider response body is read', async () => {
  const gateway = new AssistantEmbeddingGateway({
    ASSISTANT_EMBEDDING_MODE: 'openai',
    ASSISTANT_EMBEDDING_MODEL: 'text-embedding-3-small',
    ASSISTANT_EMBEDDING_DIMENSIONS: '3',
    ASSISTANT_EMBEDDING_TIMEOUT_MS: '100',
    OPENAI_API_KEY: 'test-only',
  }, async () => ({
    ok: true,
    status: 200,
    async json() {
      await new Promise((resolve) => setTimeout(resolve, 1_000).unref());
      return { data: [{ index: 0, embedding: [1, 0, 0] }] };
    },
  }));

  const startedAt = Date.now();
  await assert.rejects(
    gateway.embed(['текст']),
    (error) => error instanceof AssistantEmbeddingError
      && error.code === 'ASSISTANT_EMBEDDING_TIMEOUT'
      && error.retryable === true,
  );
  assert.equal(Date.now() - startedAt < 500, true);
});

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
      async retrieve({ includeExternalLots }) {
        retrievalCalls += 1;
        assert.equal(includeExternalLots, true);
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
