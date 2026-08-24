require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  AssistantPlannerError,
  AssistantQueryPlanner,
} = require('../dist/assistant/assistant-query-planner.js');
const {
  AssistantAnswerValidationError,
  buildAssistantSearchAnswer,
  validateAssistantSearchAnswer,
} = require('../dist/assistant/assistant-search-ranking.js');
const {
  createAssistantPlannerGateway,
} = require('../dist/assistant/assistant-planner-gateway.js');
const {
  AssistantAnswerService,
} = require('../dist/assistant/assistant-answer.service.js');

test('Assistant T02 planner routes ordinary and complex requests to the required Luna effort', async () => {
  const calls = [];
  const planner = new AssistantQueryPlanner({
    async plan(request) {
      calls.push(request);
      return validIntent({
        hardFilters: request.messages[0].includes('25 млн')
          ? { ...emptyFilters(), budgetMaxRub: 25_000_000 }
          : emptyFilters(),
      });
    },
  });

  await planner.plan({ messages: ['Квартира до 25 млн'], context: null });
  await planner.plan({ messages: ['Сравни варианты и учти скрытые расходы'], context: null });

  assert.deepEqual(
    calls.map(({ model, reasoningEffort }) => [model, reasoningEffort]),
    [
      ['gpt-5.6-luna', 'medium'],
      ['gpt-5.6-luna', 'high'],
    ],
  );
});

test('Assistant T02 planner allows exactly one Terra medium fallback after local validation failure', async () => {
  const calls = [];
  const planner = new AssistantQueryPlanner({
    async plan(request) {
      calls.push(request);
      if (request.model === 'gpt-5.6-luna') return { taskType: 'SEARCH' };
      return validIntent({ hardFilters: { ...emptyFilters(), rooms: [2] } });
    },
  });

  const result = await planner.plan({ messages: ['Нужна двухкомнатная квартира'], context: null });

  assert.deepEqual(result.intent.hardFilters.rooms, [2]);
  assert.deepEqual(
    calls.map(({ model, reasoningEffort }) => [model, reasoningEffort]),
    [
      ['gpt-5.6-luna', 'medium'],
      ['gpt-5.6-terra', 'medium'],
    ],
  );
  assert.deepEqual(
    result.telemetry.map(({ model, outcome, isFallback }) => [model, outcome, isFallback]),
    [
      ['gpt-5.6-luna', 'LOCAL_VALIDATION_FAILED', false],
      ['gpt-5.6-terra', 'ACCEPTED', true],
    ],
  );
});

test('Assistant T02 planner stops after invalid Luna and Terra responses', async () => {
  let attempts = 0;
  const planner = new AssistantQueryPlanner({
    async plan() {
      attempts += 1;
      return { taskType: 'SEARCH' };
    },
  });

  await assert.rejects(
    planner.plan({ messages: ['Нужна квартира до 20 млн'], context: null }),
    (error) => error instanceof AssistantPlannerError && error.code === 'ASSISTANT_INTENT_INVALID',
  );
  assert.equal(attempts, 2);
});

test('Assistant T02 planner pins explicit hard filters and asks only for missing critical facts', async () => {
  const planner = new AssistantQueryPlanner({
    async plan() {
      return validIntent();
    },
  });

  const result = await planner.plan({
    messages: ['Ищу до 25 млн'],
    context: null,
  });

  assert.equal(result.intent.hardFilters.budgetMaxRub, 25_000_000);
  assert.equal(result.intent.needsClarification, true);
  assert.match(result.intent.clarificationQuestion, /комнатность/iu);
  assert.match(result.intent.clarificationQuestion, /район или метро/iu);
  assert.doesNotMatch(result.intent.clarificationQuestion, /бюджет/iu);
});

test('Assistant T02 planner keeps previously stated conditions and applies the page context', async () => {
  const planner = new AssistantQueryPlanner({
    async plan() {
      return validIntent();
    },
  });

  const result = await planner.plan({
    messages: ['Бюджет до 30 млн', 'Нужна двушка'],
    context: { kind: 'OBJECT', key: 'zhk-test', label: 'Текущий ЖК' },
  });

  assert.equal(result.intent.hardFilters.budgetMaxRub, 30_000_000);
  assert.deepEqual(result.intent.hardFilters.rooms, [2]);
  assert.equal(result.intent.needsClarification, false);
  assert.equal(result.intent.clarificationQuestion, null);
});

test('Assistant T02 planner imposes a safe legal and tax boundary independently of model wording', async () => {
  const planner = new AssistantQueryPlanner({
    async plan() {
      return validIntent();
    },
  });

  const result = await planner.plan({
    messages: ['Какой налог и что написать в договоре покупки?'],
    context: null,
  });

  assert.equal(result.intent.taskType, 'LEGAL_TAX');
  assert.equal(result.intent.needsClarification, false);
  assert.equal(result.intent.clarificationQuestion, null);
});

test('Assistant T02 ranking applies hard filters before soft ranking and keeps at most three exact results', () => {
  const intent = validIntent({
    hardFilters: {
      ...emptyFilters(),
      budgetMaxRub: 25_000_000,
      rooms: [2],
      district: 'Хамовники',
    },
    softPreferences: { ...emptyFilters(), metro: 'Спортивная' },
  });
  const candidates = [
    candidate('11111111-1111-4111-8111-111111111111', { priceRub: 26_000_000, metros: ['Спортивная'] }),
    candidate('22222222-2222-4222-8222-222222222222', { priceRub: 24_000_000, metros: ['Фрунзенская'] }),
    candidate('33333333-3333-4333-8333-333333333333', { priceRub: 23_000_000, metros: ['Спортивная'] }),
    candidate('44444444-4444-4444-8444-444444444444', { priceRub: 22_000_000, metros: ['Спортивная'] }),
    candidate('55555555-5555-4555-8555-555555555555', { priceRub: 21_000_000, metros: ['Спортивная'] }),
  ];

  const answer = buildAssistantSearchAnswer(intent, candidates, [], new Date('2026-08-24T12:00:00.000Z'));

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [
    '55555555-5555-4555-8555-555555555555',
    '44444444-4444-4444-8444-444444444444',
    '33333333-3333-4333-8333-333333333333',
  ]);
  assert.deepEqual(answer.alternatives, []);
});

test('Assistant T02 ranking exposes at most two allowed alternatives only when exact results are absent', () => {
  const intent = validIntent({
    hardFilters: {
      ...emptyFilters(),
      budgetMaxRub: 20_000_000,
      rooms: [2],
      district: 'Хамовники',
    },
  });
  const alternatives = [
    candidate('11111111-1111-4111-8111-111111111111', {
      priceRub: 24_000_000,
      deviations: [{ type: 'BUDGET', label: 'Бюджет выше на 4 млн ₽' }],
    }),
    candidate('22222222-2222-4222-8222-222222222222', {
      rooms: 3,
      deviations: [{ type: 'ROOMS', label: '3 комнаты вместо 2' }],
    }),
    candidate('33333333-3333-4333-8333-333333333333', {
      district: 'Раменки',
      deviations: [{ type: 'DISTRICT', label: 'Близкий район: Раменки' }],
    }),
  ];

  const answer = buildAssistantSearchAnswer(intent, [], alternatives, new Date('2026-08-24T12:00:00.000Z'));

  assert.equal(answer.exactResults.length, 0);
  assert.equal(answer.alternatives.length, 2);
  assert.equal(answer.alternatives.every((item) => item.deviations.length === 1), true);
  assert.match(answer.content, /Точных совпадений нет/iu);
});

test('Assistant T02 evidence validation rejects invented price, freshness and links', () => {
  const intent = validIntent({
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], district: 'Хамовники' },
  });
  const evidence = candidate('11111111-1111-4111-8111-111111111111');
  const answer = buildAssistantSearchAnswer(intent, [evidence], [], new Date('2026-08-24T12:00:00.000Z'));

  validateAssistantSearchAnswer(answer, [evidence], intent, new Date('2026-08-24T12:00:00.000Z'));
  for (const mutation of [
    (copy) => { copy.exactResults[0].priceRub += 1; },
    (copy) => { copy.exactResults[0].freshnessLabel = 'обновлено только что'; },
    (copy) => { copy.exactResults[0].href = '/objects/invented'; },
  ]) {
    const tampered = structuredClone(answer);
    mutation(tampered);
    assert.throws(
      () => validateAssistantSearchAnswer(tampered, [evidence], intent, new Date('2026-08-24T12:00:00.000Z')),
      (error) => error instanceof AssistantAnswerValidationError,
    );
  }
});

test('Assistant T02 ranking refuses candidates that lack a required evidence fact', () => {
  const intent = validIntent({
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], district: 'Хамовники' },
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK', 'PDF'],
  });
  const withoutPdf = candidate('11111111-1111-4111-8111-111111111111', { pdfs: [] });

  const answer = buildAssistantSearchAnswer(intent, [withoutPdf], [], new Date('2026-08-24T12:00:00.000Z'));

  assert.equal(answer.exactResults.length, 0);
  assert.equal(answer.alternatives.length, 0);
  assert.match(answer.content, /Не могу подтвердить/iu);
});

test('Assistant T02 fake Luna planner extracts supported Platforma conditions without external calls', async () => {
  const gateway = createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' });
  const planner = new AssistantQueryPlanner(gateway);

  const result = await planner.plan({
    messages: ['Нужна двушка до 25 млн в районе Хамовники у метро Спортивная от ПИК, сдача до 2028 года'],
    context: null,
  });

  assert.equal(result.intent.hardFilters.budgetMaxRub, 25_000_000);
  assert.deepEqual(result.intent.hardFilters.rooms, [2]);
  assert.equal(result.intent.hardFilters.district, 'Хамовники');
  assert.equal(result.intent.hardFilters.metro, 'Спортивная');
  assert.equal(result.intent.hardFilters.developer, 'ПИК');
  assert.equal(result.intent.hardFilters.completionYearMax, 2028);
  assert.equal(result.intent.needsClarification, false);
  assert.deepEqual(result.telemetry.map(({ provider, model, reasoningEffort }) => [provider, model, reasoningEffort]), [
    ['fake', 'gpt-5.6-luna', 'medium'],
  ]);
});

test('Assistant T02 planner records bounded usage telemetry without exposing it in the intent', async () => {
  const planner = new AssistantQueryPlanner({
    async plan() {
      return {
        output: validIntent({ hardFilters: { ...emptyFilters(), budgetMaxRub: 20_000_000, rooms: [1], metro: 'Сокол' } }),
        provider: 'openai',
        requestId: 'request-safe',
        responseId: 'response-safe',
        httpStatus: 200,
        inputTokens: 120,
        outputTokens: 80,
        reasoningTokens: 40,
        totalTokens: 240,
      };
    },
  });

  const result = await planner.plan({ messages: ['Однушка до 20 млн у метро Сокол'], context: null });

  assert.equal(result.intent.provider, undefined);
  assert.deepEqual(result.telemetry[0], {
    provider: 'openai',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    outcome: 'ACCEPTED',
    isFallback: false,
    requestId: 'request-safe',
    responseId: 'response-safe',
    httpStatus: 200,
    inputTokens: 120,
    outputTokens: 80,
    reasoningTokens: 40,
    totalTokens: 240,
    durationMs: result.telemetry[0].durationMs,
  });
});

test('Assistant T02 planner uses the same single fallback budget for downstream evidence validation', async () => {
  const calls = [];
  const planner = new AssistantQueryPlanner({
    async plan(request) {
      calls.push(request.model);
      return validIntent({ hardFilters: { ...emptyFilters(), budgetMaxRub: 20_000_000, rooms: [1], metro: 'Сокол' } });
    },
  });

  const result = await planner.planWithValidation(
    { messages: ['Однушка до 20 млн у метро Сокол'], context: null },
    async (_intent, request) => {
      if (request.model === 'gpt-5.6-luna') throw new AssistantAnswerValidationError('ASSISTANT_LINK_INVALID');
      return 'validated-answer';
    },
  );

  assert.equal(result.value, 'validated-answer');
  assert.deepEqual(calls, ['gpt-5.6-luna', 'gpt-5.6-terra']);
  assert.deepEqual(result.telemetry.map(({ outcome, isFallback }) => [outcome, isFallback]), [
    ['LOCAL_VALIDATION_FAILED', false],
    ['ACCEPTED', true],
  ]);
});

test('Assistant T02 answer service skips search for clarification and legal boundaries', async () => {
  let searchCalls = 0;
  const search = { async search() { searchCalls += 1; return { exact: [], alternatives: [] }; } };
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return validIntent(); } }),
    search,
  );

  const clarification = await service.answer({ messages: ['Нужна квартира'], context: null });
  assert.equal(clarification.answer.kind, 'CLARIFICATION');
  assert.match(clarification.content, /бюджет/iu);

  const legal = await service.answer({ messages: ['Какой налог будет по договору?'], context: null });
  assert.equal(legal.answer.kind, 'SAFE_BOUNDARY');
  assert.match(legal.content, /не заменяет консультацию/iu);
  assert.equal(searchCalls, 0);
});

test('Assistant T02 answer service returns grounded public cards and keeps internals separate', async () => {
  const evidence = candidate('11111111-1111-4111-8111-111111111111');
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({
      async plan() {
        return validIntent({
          hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], district: 'Хамовники' },
        });
      },
    }),
    { async search() { return { exact: [evidence], alternatives: [] }; } },
  );

  const result = await service.answer({
    messages: ['Двушка до 25 млн в районе Хамовники'],
    context: null,
    now: new Date('2026-08-24T12:00:00.000Z'),
  });

  assert.equal(result.answer.kind, 'SEARCH_RESULTS');
  assert.equal(result.answer.exactResults.length, 1);
  assert.equal(result.answer.alternatives.length, 0);
  assert.equal(result.answer.provider, undefined);
  assert.equal(result.answer.evidence, undefined);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.telemetry.length, 1);
});

function validIntent(overrides = {}) {
  return {
    taskType: 'SEARCH',
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

function candidate(unitId, overrides = {}) {
  return {
    unitId,
    objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    objectType: 'RESIDENTIAL',
    objectTitle: 'ЖК Тест',
    objectSlug: 'zhk-test',
    lotTitle: 'Квартира 42',
    priceRub: 20_000_000,
    availability: 'AVAILABLE',
    updatedAt: '2026-08-24T02:00:00.000Z',
    rooms: 2,
    district: 'Хамовники',
    metros: ['Спортивная'],
    developer: 'Тест Девелопмент',
    completionYear: 2027,
    completionQuarter: 3,
    propertyClass: 'Бизнес',
    area: 60,
    floor: 8,
    latitude: 55.7,
    longitude: 37.5,
    pdfs: [
      {
        fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        title: 'Презентация проекта',
      },
    ],
    deviations: [],
    ...overrides,
  };
}
