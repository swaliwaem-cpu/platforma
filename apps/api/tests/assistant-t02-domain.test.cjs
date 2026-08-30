require('reflect-metadata');

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { test } = require('node:test');

const {
  AssistantPlannerError,
  AssistantQueryPlanner,
  createAssistantComparisonTargetVariants,
} = require('../dist/assistant/assistant-query-planner.js');
const {
  AssistantAnswerValidationError,
  buildAssistantSearchAnswer,
  validateAssistantSearchAnswer,
} = require('../dist/assistant/assistant-search-ranking.js');
const {
  buildAssistantComparisonAnswer,
} = require('../dist/assistant/assistant-comparison-answer.js');
const {
  AssistantOpenAiPlannerGateway,
  createAssistantPlannerGateway,
} = require('../dist/assistant/assistant-planner-gateway.js');
const {
  AssistantAnswerService,
} = require('../dist/assistant/assistant-answer.service.js');
const {
  AssistantSearchService,
} = require('../dist/assistant/assistant-search.service.js');
const {
  AssistantService,
} = require('../dist/assistant/assistant.service.js');

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

test('Assistant T02 fake planner keeps a district from the previous turn and accepts bounded area ranges', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({
    messages: ['Нужна квартира в районе Хамовники', 'До 25 млн, двушка, площадь 55–70 м²'],
    context: null,
  });

  assert.equal(result.intent.hardFilters.district, 'Хамовники');
  assert.equal(result.intent.hardFilters.budgetMaxRub, 25_000_000);
  assert.deepEqual(result.intent.hardFilters.rooms, [2]);
  assert.equal(result.intent.hardFilters.areaMin, 55);
  assert.equal(result.intent.hardFilters.areaMax, 70);
  assert.equal(result.intent.needsClarification, false);
});

test('Assistant T02 planner consumes a district filter resolved as the same trusted landmark', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({
    messages: ['двухкомнатная до 50 млн в районе Павелецкая Плаза'],
    context: {
      pageContext: null,
      districtResolution: {
        input: 'Павелецкая Плаза',
        canonicalName: null,
        resolvedByGeo: true,
      },
      geo: {
        hasGeoConstraint: true,
        kind: 'POINT',
        mode: 'NEAR',
        label: 'Павелецкая Плаза',
        source: 'LANDMARK',
        landmarkId: '11111111-1111-4111-8111-111111111111',
        distanceMeters: 2_000,
      },
    },
  });

  assert.equal(result.intent.hardFilters.district, null);
  assert.deepEqual(result.intent.hardFilters.rooms, [2]);
  assert.equal(result.intent.hardFilters.budgetMaxRub, 50_000_000);
  assert.equal(result.intent.needsClarification, false);
});

test('Assistant T02 planner preserves a district separate from the trusted landmark', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({
    messages: ['двухкомнатная до 50 млн в районе Хамовники рядом с Павелецкая Плаза'],
    context: {
      pageContext: null,
      geo: {
        hasGeoConstraint: true,
        kind: 'POINT',
        mode: 'NEAR',
        label: 'Павелецкая Плаза',
        source: 'LANDMARK',
        landmarkId: '11111111-1111-4111-8111-111111111111',
        distanceMeters: 2_000,
      },
    },
  });

  assert.equal(result.intent.hardFilters.district, 'Хамовники');
  assert.deepEqual(result.intent.hardFilters.rooms, [2]);
  assert.equal(result.intent.hardFilters.budgetMaxRub, 50_000_000);
  assert.equal(result.intent.needsClarification, false);
});

test('Assistant T02 planner keeps a district when a manual point reuses its label', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({
    messages: ['двухкомнатная до 50 млн в районе Хамовники'],
    context: {
      pageContext: null,
      geo: {
        hasGeoConstraint: true,
        kind: 'POINT',
        mode: 'NEAR',
        label: 'Хамовники',
        source: 'MANUAL',
        distanceMeters: 2_000,
      },
    },
  });

  assert.equal(result.intent.hardFilters.district, 'Хамовники');
});

test('Assistant T02 planner consumes punctuation and a canonical alias resolved as a trusted landmark', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));
  const cases = [
    ['двухкомнатная до 50 млн в районе Павелецкая Плаза?', 'Павелецкая Плаза'],
    ['двухкомнатная до 50 млн в районе Третьего транспортного кольца', 'ТТК'],
  ];

  for (const [message, label] of cases) {
    const result = await planner.plan({
      messages: [message],
      context: {
        pageContext: null,
        districtResolution: {
          input: message.includes('Третьего') ? 'Третьего транспортного кольца' : 'Павелецкая Плаза',
          canonicalName: null,
          resolvedByGeo: true,
        },
        geo: {
          hasGeoConstraint: true,
          kind: 'POINT',
          mode: 'NEAR',
          label,
          source: 'LANDMARK',
          landmarkId: '11111111-1111-4111-8111-111111111111',
          distanceMeters: 2_000,
        },
      },
    });

    assert.equal(result.intent.hardFilters.district, null, message);
  }
});

test('Assistant T02 planner consumes a server-verified landmark alias even when the display label differs', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({
    messages: ['двухкомнатная до 50 млн в районе Павелецкой Плазы'],
    context: {
      pageContext: null,
      districtResolution: {
        input: 'Павелецкой Плазы',
        canonicalName: null,
        resolvedByGeo: true,
      },
      geo: {
        hasGeoConstraint: true,
        kind: 'POINT',
        mode: 'NEAR',
        label: 'Ручная точка Павелецкая',
        source: 'LANDMARK',
        landmarkId: '11111111-1111-4111-8111-111111111111',
        distanceMeters: 2_000,
      },
    },
  });

  assert.equal(result.intent.hardFilters.district, null);
});

test('Assistant T02 planner promotes model-extracted soft values marked as mandatory by the user', async () => {
  const planner = new AssistantQueryPlanner({
    async plan() {
      return validIntent({
        hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2] },
        softPreferences: { ...emptyFilters(), district: 'Хамовники' },
      });
    },
  });

  const result = await planner.plan({ messages: ['Двушка до 25 млн, только Хамовники'], context: null });

  assert.equal(result.intent.hardFilters.district, 'Хамовники');
  assert.equal(result.intent.needsClarification, false);
});

test('Assistant T02 planner pins every explicit supported hard filter instead of trusting model placement', async () => {
  const planner = new AssistantQueryPlanner({
    async plan() {
      return validIntent({
        softPreferences: {
          ...emptyFilters(),
          district: 'Хамовники',
          metro: 'Спортивная',
          developer: 'ПИК',
          completionYearMax: 2028,
          completionQuarter: 3,
          propertyClass: 'бизнес',
          areaMin: 55,
          floorMin: 5,
        },
      });
    },
  });

  const result = await planner.plan({
    messages: [
      'Нужна двушка до 25 млн в районе Хамовники у метро Спортивная от ПИК, '
        + 'бизнес-класс, площадь от 55 м², не ниже 5 этажа, сдача до 2028 года, 3 квартал',
    ],
    context: null,
  });

  assert.deepEqual(result.intent.hardFilters, {
    ...emptyFilters(),
    budgetMaxRub: 25_000_000,
    rooms: [2],
    district: 'Хамовники',
    metro: 'Спортивная',
    developer: 'ПИК',
    completionYearMax: 2028,
    completionQuarter: 3,
    propertyClass: 'бизнес',
    areaMin: 55,
    floorMin: 5,
  });
  assert.equal(result.intent.needsClarification, false);
});

test('Assistant T02 planner preserves high reasoning across a multi-turn comparison', async () => {
  const calls = [];
  const planner = new AssistantQueryPlanner({
    async plan(request) {
      calls.push(request);
      return validIntent({ hardFilters: { ...emptyFilters(), budgetMaxRub: 30_000_000, rooms: [2], metro: 'Сокол' } });
    },
  });

  await planner.plan({
    messages: ['Сравни варианты и учти скрытые расходы', 'До 30 млн, две комнаты, метро Сокол'],
    context: null,
  });

  assert.equal(calls[0].reasoningEffort, 'high');
});

test('Assistant T02 planner bounds comparison criteria and normalizes a confirmed instrumental target', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({
    messages: ['Сравни застройщика ПИК с Самолётом по цене, двушки до 25 млн у метро Спортивная'],
    context: null,
  });

  assert.deepEqual(result.intent.comparisonTargets, ['ПИК', 'Самолётом']);
  assert.deepEqual(result.intent.comparisonTargetModes, ['EXACT', 'INSTRUMENTAL']);
  assert.equal(result.intent.hardFilters.developer, null);
  assert.equal(result.intent.needsClarification, false);
});

test('Assistant T02 planner marks an inflected adjective comparison target as instrumental', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({
    messages: ['Сравни ЖК Первый с Вторым по цене, двушки до 25 млн у метро Спортивная'],
    context: null,
  });

  assert.deepEqual(result.intent.comparisonTargets, ['Первый', 'Вторым']);
  assert.deepEqual(result.intent.comparisonTargetModes, ['EXACT', 'INSTRUMENTAL']);
  assert.equal(result.intent.needsClarification, false);
});

test('Assistant T02 comparison variants stay bounded across multiword and ambiguous adjective forms', () => {
  assert.deepEqual(
    createAssistantComparisonTargetVariants('Сердцем Столицы', 'INSTRUMENTAL').slice(0, 2),
    ['Сердцем Столицы', 'Сердце Столицы'],
  );
  assert.equal(createAssistantComparisonTargetVariants('Большим', 'INSTRUMENTAL').includes('Большой'), true);
  assert.equal(createAssistantComparisonTargetVariants('Третьим', 'INSTRUMENTAL').includes('Третий'), true);
  assert.equal(
    createAssistantComparisonTargetVariants('Европейским Большим Берегом', 'INSTRUMENTAL').length <= 12,
    true,
  );
});

test('Assistant T02 planner treats real catalog metro and object type filters as hard context', async () => {
  const planner = new AssistantQueryPlanner({ async plan() { return validIntent(); } });

  const result = await planner.plan({
    messages: ['Коммерческое помещение до 25 млн'],
    context: {
      kind: 'CATALOG_FILTERS',
      key: 'metroStationId=11111111-1111-4111-8111-111111111111&type=COMMERCIAL',
      label: 'Фильтры каталога',
    },
  });

  assert.equal(result.intent.hardFilters.objectType, 'COMMERCIAL');
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

test('Assistant T02 renders a feed-backed studio card with current commercial facts', () => {
  const intent = validIntent({
    hardFilters: { ...emptyFilters(), budgetMaxRub: 19_000_000, rooms: [0] },
  });
  const evidence = candidate('11111111-1111-4111-8111-111111111111', {
    lotTitle: null,
    priceRub: 18_500_000,
    rooms: 0,
    area: 31.5,
    floor: 7,
    updatedAt: '2026-08-24T11:30:00.000Z',
  });
  const now = new Date('2026-08-24T12:00:00.000Z');

  const answer = buildAssistantSearchAnswer(intent, [evidence], [], now);

  assert.equal(answer.exactResults.length, 1);
  assert.deepEqual(answer.exactResults[0], {
    unitId: evidence.unitId,
    title: 'ЖК Тест',
    subtitle: 'Студия · 31,5 м² · 7 этаж',
    priceRub: 18_500_000,
    availabilityLabel: 'В продаже',
    freshnessLabel: 'обновлено менее часа назад',
    isStale: false,
    href: `/objects/zhk-test/lots/${evidence.unitId}`,
    facts: ['Хамовники', 'м. Спортивная', 'Тест Девелопмент', '3 кв. 2027'],
    pdfs: [{
      title: 'Презентация проекта',
      href: '/media/files/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/content?download=true',
    }],
    deviations: [],
  });
  validateAssistantSearchAnswer(answer, [evidence], intent, now);
});

test('Assistant T02 ranking keeps an exact total and exposes only the next five grounded results', () => {
  const intent = validIntent();
  const candidates = Array.from({ length: 10 }, (_, index) => candidate(
    `${String(index + 1).padStart(8, '0')}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    { priceRub: 20_000_000 + index * 1_000_000 },
  ));
  const now = new Date('2026-08-24T12:00:00.000Z');

  const answer = buildAssistantSearchAnswer(intent, candidates, [], now, 17);

  assert.equal(answer.totalExactResults, 17);
  assert.deepEqual(
    answer.exactResults.map(({ unitId }) => unitId),
    candidates.slice(0, 3).map(({ unitId }) => unitId),
  );
  assert.deepEqual(
    answer.additionalExactResults.map(({ unitId }) => unitId),
    candidates.slice(3, 8).map(({ unitId }) => unitId),
  );
  assert.deepEqual(answer.alternatives, []);
  validateAssistantSearchAnswer(answer, candidates, intent, now, 17);
  assert.equal(buildAssistantSearchAnswer(intent, candidates, [], now).totalExactResults, 10);

  for (const mutation of [
    (copy) => { copy.totalExactResults = 7; },
    (copy) => { copy.additionalExactResults[0] = structuredClone(copy.exactResults[0]); },
    (copy) => { copy.additionalExactResults[0].href = '/objects/invented'; },
  ]) {
    const tampered = structuredClone(answer);
    mutation(tampered);
    assert.throws(
      () => validateAssistantSearchAnswer(tampered, candidates, intent, now, 17),
      (error) => error instanceof AssistantAnswerValidationError,
    );
  }
});

test('Assistant T02 ranking deduplicates evidence and rejects a total that cannot be restored', () => {
  const intent = validIntent();
  const first = candidate('11111111-1111-4111-8111-111111111111');
  const second = candidate('22222222-2222-4222-8222-222222222222', { priceRub: 21_000_000 });
  const now = new Date('2026-08-24T12:00:00.000Z');

  const answer = buildAssistantSearchAnswer(intent, [first, { ...first }, second], [], now, 2);

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [first.unitId, second.unitId]);
  assert.throws(
    () => buildAssistantSearchAnswer(intent, [first, second], [], now, 3),
    (error) => error instanceof AssistantAnswerValidationError
      && error.code === 'ASSISTANT_SEARCH_TOTAL_INVALID',
  );
  assert.throws(
    () => buildAssistantSearchAnswer(intent, [], [], now, 1),
    (error) => error instanceof AssistantAnswerValidationError
      && error.code === 'ASSISTANT_SEARCH_TOTAL_INVALID',
  );
});

test('Assistant T02 stored answer parser keeps legacy results and rejects a partial new contract', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');
  const answer = buildAssistantSearchAnswer(
    validIntent(),
    [candidate('11111111-1111-4111-8111-111111111111')],
    [],
    now,
  );
  const legacy = structuredClone(answer);
  delete legacy.totalExactResults;
  delete legacy.additionalExactResults;
  const service = Object.create(AssistantService.prototype);

  const restored = service.parseStoredAnswer(legacy);

  assert.equal(restored.kind, 'SEARCH_RESULTS');
  assert.deepEqual(restored.exactResults, legacy.exactResults);
  assert.equal(restored.totalExactResults, undefined);
  assert.equal(restored.additionalExactResults, undefined);
  assert.equal(service.parseStoredAnswer({ ...legacy, totalExactResults: 1 }), null);

  const boundaryAnswer = structuredClone(legacy);
  boundaryAnswer.exactResults[0].distanceMeters = 2_001.5;
  boundaryAnswer.geo = {
    anchor: { latitude: 55.7, longitude: 37.5, label: 'Тестовая точка', source: 'MANUAL' },
    radiusMeters: 2_000,
    polygon: {
      type: 'Polygon',
      coordinates: [[[37.49, 55.69], [37.51, 55.69], [37.5, 55.71], [37.49, 55.69]]],
    },
    markers: [{
      unitId: boundaryAnswer.exactResults[0].unitId,
      latitude: 55.7,
      longitude: 37.5,
      distanceMeters: 2_001.5,
      kind: 'PRIMARY',
    }],
  };
  assert.notEqual(service.parseStoredAnswer(boundaryAnswer), null);
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

test('Assistant T02 comparison returns grounded representatives for both explicit targets', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ПИК', 'Самолёт'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const candidates = [
    candidate('11111111-1111-4111-8111-111111111111', { developer: 'ПИК', priceRub: 20_000_000 }),
    candidate('22222222-2222-4222-8222-222222222222', { developer: 'ПИК', priceRub: 21_000_000 }),
    candidate('33333333-3333-4333-8333-333333333333', { developer: 'Самолёт', priceRub: 24_000_000 }),
  ];

  const answer = buildAssistantSearchAnswer(intent, candidates, [], new Date('2026-08-24T12:00:00.000Z'));

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
  ]);
  assert.match(answer.content, /двум выбранным вариантам/iu);
});

test('Assistant T02 comparison fallback total counts every eligible candidate beyond the eight-card preview', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ПИК', 'Самолёт'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const candidates = Array.from({ length: 10 }, (_, index) => candidate(
    `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    {
      developer: index < 5 ? 'ПИК' : 'Самолёт',
      priceRub: 20_000_000 + index * 100_000,
    },
  ));

  const answer = buildAssistantSearchAnswer(
    intent,
    candidates,
    [],
    new Date('2026-08-24T12:00:00.000Z'),
  );

  assert.equal(answer.totalExactResults, 10);
  assert.equal(answer.exactResults.length, 3);
  assert.equal(answer.additionalExactResults.length, 5);
});

test('Assistant T02 comparison keeps independent grounded groups when both targets match', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ПИК', 'Самолёт'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2] },
  });
  const answer = buildAssistantComparisonAnswer(intent, [
    {
      target: 'ПИК',
      evidence: [candidate('11111111-1111-4111-8111-111111111111', {
        developer: 'ПИК',
        priceRub: 20_000_000,
        completionYear: 2027,
        completionQuarter: 3,
        metros: ['Спортивная'],
      })],
      totalExactResults: 121,
    },
    {
      target: 'Самолёт',
      evidence: [candidate('22222222-2222-4222-8222-222222222222', {
        developer: 'Самолёт',
        priceRub: 24_000_000,
        completionYear: 2026,
        completionQuarter: 4,
        metros: ['Фили'],
      })],
      totalExactResults: 1,
    },
  ], new Date('2026-08-24T12:00:00.000Z'));

  assert.equal(answer.answer.kind, 'COMPARISON_RESULTS');
  assert.deepEqual(answer.answer.groups.map(({ target, status, totalExactResults }) => ({
    target,
    status,
    totalExactResults,
  })), [
    { target: 'ПИК', status: 'MATCHED', totalExactResults: 121 },
    { target: 'Самолёт', status: 'MATCHED', totalExactResults: 1 },
  ]);
  assert.deepEqual(answer.answer.groups[0].summary, {
    minimumPriceRub: 20_000_000,
    completion: ['3 кв. 2027'],
    metros: ['Спортивная'],
  });
});

test('Assistant T02 comparison preserves one matched target and one exact no-data state', () => {
  const intent = validIntent({ taskType: 'COMPARE', comparisonTargets: ['ПИК', 'Самолёт'] });
  const answer = buildAssistantComparisonAnswer(intent, [
    {
      target: 'ПИК',
      evidence: [candidate('11111111-1111-4111-8111-111111111111', { developer: 'ПИК' })],
      totalExactResults: 1,
    },
    { target: 'Самолёт', evidence: [], totalExactResults: 0 },
  ], new Date('2026-08-24T12:00:00.000Z'));

  assert.deepEqual(answer.answer.groups.map(({ status }) => status), ['MATCHED', 'NO_MATCH']);
  assert.equal(answer.answer.groups[0].exactResults.length, 1);
  assert.deepEqual(answer.answer.groups[1], {
    target: 'Самолёт',
    status: 'NO_MATCH',
    totalExactResults: 0,
    exactResults: [],
    additionalExactResults: [],
    summary: { minimumPriceRub: null, completion: [], metros: [] },
  });
  assert.doesNotMatch(answer.content, /не могу подтвердить/iu);
});

test('Assistant T02 comparison returns two specific no-data groups when neither target matches', () => {
  const intent = validIntent({ taskType: 'COMPARE', comparisonTargets: ['ПИК', 'Самолёт'] });
  const answer = buildAssistantComparisonAnswer(intent, [
    { target: 'ПИК', evidence: [], totalExactResults: 0 },
    { target: 'Самолёт', evidence: [], totalExactResults: 0 },
  ], new Date('2026-08-24T12:00:00.000Z'));

  assert.equal(answer.answer.kind, 'COMPARISON_RESULTS');
  assert.deepEqual(answer.answer.groups.map(({ target, status }) => ({ target, status })), [
    { target: 'ПИК', status: 'NO_MATCH' },
    { target: 'Самолёт', status: 'NO_MATCH' },
  ]);
});

test('Assistant T02 comparison bounds summary values and survives stored-answer round trip', () => {
  const intent = validIntent({ taskType: 'COMPARE', comparisonTargets: ['ПИК', 'Самолёт'] });
  const metros = Array.from({ length: 21 }, (_, index) => `Метро ${String(index + 1).padStart(2, '0')}`);
  const built = buildAssistantComparisonAnswer(intent, [
    {
      target: 'ПИК',
      evidence: [candidate('11111111-1111-4111-8111-111111111111', { developer: 'ПИК', metros })],
      totalExactResults: 1,
    },
    { target: 'Самолёт', evidence: [], totalExactResults: 0 },
  ], new Date('2026-08-24T12:00:00.000Z'));
  const service = Object.create(AssistantService.prototype);

  assert.equal(built.answer.groups[0].summary.metros.length, 20);
  assert.deepEqual(service.parseStoredAnswer(built.answer), built.answer);
});

test('Assistant T02 stored answer parser restores the comparison contract and rejects status drift', () => {
  const intent = validIntent({ taskType: 'COMPARE', comparisonTargets: ['ПИК', 'Самолёт'] });
  const built = buildAssistantComparisonAnswer(intent, [
    {
      target: 'ПИК',
      evidence: [candidate('11111111-1111-4111-8111-111111111111', { developer: 'ПИК' })],
      totalExactResults: 1,
    },
    { target: 'Самолёт', evidence: [], totalExactResults: 0 },
  ], new Date('2026-08-24T12:00:00.000Z'));
  const service = Object.create(AssistantService.prototype);

  assert.deepEqual(service.parseStoredAnswer(built.answer), built.answer);
  const invalid = structuredClone(built.answer);
  invalid.groups[1].status = 'MATCHED';
  assert.equal(service.parseStoredAnswer(invalid), null);
  const missingMatchedMinimum = structuredClone(built.answer);
  missingMatchedMinimum.groups[0].summary.minimumPriceRub = null;
  assert.equal(service.parseStoredAnswer(missingMatchedMinimum), null);
  const inflatedMatchedMinimum = structuredClone(built.answer);
  inflatedMatchedMinimum.groups[0].summary.minimumPriceRub =
    inflatedMatchedMinimum.groups[0].exactResults[0].priceRub + 1;
  assert.equal(service.parseStoredAnswer(inflatedMatchedMinimum), null);
  const duplicateMetro = structuredClone(built.answer);
  duplicateMetro.groups[0].summary.metros.push(duplicateMetro.groups[0].summary.metros[0]);
  assert.equal(service.parseStoredAnswer(duplicateMetro), null);
  const duplicateAcrossGroups = structuredClone(built.answer);
  duplicateAcrossGroups.groups[1] = {
    ...structuredClone(duplicateAcrossGroups.groups[0]),
    target: 'Самолёт',
  };
  assert.equal(service.parseStoredAnswer(duplicateAcrossGroups), null);
  const sparseMatchedSummary = structuredClone(built.answer);
  sparseMatchedSummary.groups[0].summary.completion = [];
  sparseMatchedSummary.groups[0].summary.metros = [];
  assert.notEqual(service.parseStoredAnswer(sparseMatchedSummary), null);
});

test('Assistant T02 computes full summary aggregates only for comparison searches with exact rows', async () => {
  const searchService = new AssistantSearchService({
    async $transaction(callback) {
      return callback({ feedUnit: { async findMany() { return []; } } });
    },
  });
  let total = 1;
  let summaryCalls = 0;
  searchService.resolveComparisonOptions = async (_transaction, _filters, _context, options) => options;
  searchService.countCandidateRows = async () => total;
  searchService.summarizeCandidateRows = async () => {
    summaryCalls += 1;
    return { minimumPriceRub: 20_000_000, completion: [], metros: [] };
  };
  searchService.findCandidateRows = async () => [];

  await searchService.findEvidence(emptyFilters(), null, { includeComparisonSummary: false });
  assert.equal(summaryCalls, 0);
  await searchService.findEvidence(emptyFilters(), null, { includeComparisonSummary: true });
  assert.equal(summaryCalls, 1);
  total = 0;
  const empty = await searchService.findEvidence(
    emptyFilters(),
    null,
    { includeComparisonSummary: true },
  );
  assert.equal(summaryCalls, 1);
  assert.deepEqual(empty.summary, { minimumPriceRub: null, completion: [], metros: [] });
});

test('Assistant T02 comparison resolves raw exact priority for a single instrumental target', async () => {
  const searchService = new AssistantSearchService({});
  let rawCountCalls = 0;
  searchService.countCandidateRows = async (_transaction, _filters, _context, options) => {
    rawCountCalls += 1;
    assert.deepEqual(options.comparisonTargets, ['Ростелеком']);
    assert.deepEqual(options.comparisonTargetModes, ['EXACT']);
    return 1;
  };

  const resolved = await searchService.resolveComparisonOptions(
    {},
    emptyFilters(),
    null,
    {
      comparisonTargets: ['Ростелеком'],
      comparisonTargetModes: ['INSTRUMENTAL'],
      includeComparisonSummary: true,
    },
  );

  assert.equal(rawCountCalls, 1);
  assert.deepEqual(resolved.comparisonTargetModes, ['EXACT']);
});

test('Assistant T02 comparison finds a distinct pair when the best candidate matches both targets', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['Alpha', 'Beta'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const sharedCandidate = candidate('11111111-1111-4111-8111-111111111111', {
    objectTitle: 'Alpha',
    developer: 'Beta',
    priceRub: 10_000_000,
  });
  const alphaOnlyCandidate = candidate('22222222-2222-4222-8222-222222222222', {
    objectTitle: 'Alpha',
    developer: 'Other',
    priceRub: 20_000_000,
  });

  const answer = buildAssistantSearchAnswer(
    intent,
    [sharedCandidate, alphaOnlyCandidate],
    [],
    new Date('2026-08-24T12:00:00.000Z'),
    2,
  );

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [
    alphaOnlyCandidate.unitId,
    sharedCandidate.unitId,
  ]);
});

test('Assistant T02 comparison does not confirm a target through a partial brand substring', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ПИК', 'Строй'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const candidates = [
    candidate('11111111-1111-4111-8111-111111111111', { developer: 'ПИК' }),
    candidate('22222222-2222-4222-8222-222222222222', { developer: 'Страна' }),
  ];

  const answer = buildAssistantSearchAnswer(intent, candidates, [], new Date('2026-08-24T12:00:00.000Z'));

  assert.equal(answer.exactResults.length, 0);
  assert.match(answer.content, /Не могу подтвердить/iu);
});

test('Assistant T02 comparison resolves confirmed instrumental brands ending in -строй', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ПИК', 'Главстроем'],
    comparisonTargetModes: ['EXACT', 'INSTRUMENTAL'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const candidates = [
    candidate('11111111-1111-4111-8111-111111111111', { developer: 'ПИК' }),
    candidate('22222222-2222-4222-8222-222222222222', { developer: 'Главстрой' }),
  ];

  const answer = buildAssistantSearchAnswer(intent, candidates, [], new Date('2026-08-24T12:00:00.000Z'));

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]);
});

test('Assistant T02 comparison resolves confirmed instrumental adjective targets', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['Первый', 'Вторым'],
    comparisonTargetModes: ['EXACT', 'INSTRUMENTAL'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const candidates = [
    candidate('11111111-1111-4111-8111-111111111111', { objectTitle: 'ЖК Первый' }),
    candidate('22222222-2222-4222-8222-222222222222', { objectTitle: 'ЖК Второй' }),
  ];

  const answer = buildAssistantSearchAnswer(intent, candidates, [], new Date('2026-08-24T12:00:00.000Z'));

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]);
});

test('Assistant T02 comparison resolves a confirmed inflected word inside a multiword target', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['Событие', 'Сердцем Столицы'],
    comparisonTargetModes: ['EXACT', 'INSTRUMENTAL'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const candidates = [
    candidate('11111111-1111-4111-8111-111111111111', { objectTitle: 'ЖК Событие' }),
    candidate('22222222-2222-4222-8222-222222222222', { objectTitle: 'ЖК Сердце Столицы' }),
  ];

  const answer = buildAssistantSearchAnswer(intent, candidates, [], new Date('2026-08-24T12:00:00.000Z'));

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]);
});

test('Assistant T02 comparison keeps an exact -ом brand ahead of an instrumental fallback', () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ПИК', 'Ростелеком'],
    comparisonTargetModes: ['EXACT', 'INSTRUMENTAL'],
    hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], metro: 'Спортивная' },
  });
  const candidates = [
    candidate('11111111-1111-4111-8111-111111111111', { developer: 'Ростелек', priceRub: 10_000_000 }),
    candidate('22222222-2222-4222-8222-222222222222', { developer: 'ПИК', priceRub: 20_000_000 }),
    candidate('33333333-3333-4333-8333-333333333333', { developer: 'Ростелеком', priceRub: 24_000_000 }),
  ];

  const answer = buildAssistantSearchAnswer(intent, candidates, [], new Date('2026-08-24T12:00:00.000Z'));

  assert.deepEqual(answer.exactResults.map(({ unitId }) => unitId), [
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]);
  assert.equal(answer.totalExactResults, 2);
  assert.notEqual(Object.create(AssistantService.prototype).parseStoredAnswer(answer), null);
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

test('Assistant T02 fake Luna planner keeps absent optional filters nullable for clarification', async () => {
  const planner = new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' }));

  const result = await planner.plan({ messages: ['Найди подходящий объект'], context: null });

  assert.equal(result.intent.hardFilters.district, null);
  assert.equal(result.intent.hardFilters.metro, null);
  assert.equal(result.intent.hardFilters.developer, null);
  assert.equal(result.intent.needsClarification, true);
  assert.equal(result.telemetry.length, 1);
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
        cachedInputTokens: 20,
        cacheWriteInputTokens: 10,
        outputTokens: 80,
        reasoningTokens: 40,
        totalTokens: 240,
        webSearchCalls: 0,
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
    errorCode: null,
    isFallback: false,
    requestId: 'request-safe',
    responseId: 'response-safe',
    httpStatus: 200,
    inputTokens: 120,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 10,
    outputTokens: 80,
    reasoningTokens: 40,
    totalTokens: 240,
    webSearchCalls: 0,
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

test('Assistant T02 planner does not turn a database failure into a Terra fallback', async () => {
  const calls = [];
  const databaseError = new Error('DATABASE_UNAVAILABLE');
  const planner = new AssistantQueryPlanner({
    async plan(request) {
      calls.push(request.model);
      return validIntent({ hardFilters: { ...emptyFilters(), budgetMaxRub: 20_000_000, rooms: [1], metro: 'Сокол' } });
    },
  });

  await assert.rejects(
    planner.planWithValidation(
      { messages: ['Однушка до 20 млн у метро Сокол'], context: null },
      async () => { throw databaseError; },
    ),
    (error) => error instanceof AssistantPlannerError
      && error.code === 'ASSISTANT_PLANNER_PIPELINE_FAILED'
      && error.telemetry.length === 1,
  );
  assert.deepEqual(calls, ['gpt-5.6-luna']);
});

test('Assistant T02 OpenAI gateway uses a bounded local HTTP stub and validates the real response shape', async () => {
  await withHttpStub(async (request, response) => {
    const body = await readRequestBody(request);
    assert.equal(body.model, 'gpt-5.6-luna');
    assert.equal(body.service_tier, 'default');
    assert.equal(body.reasoning.effort, 'medium');
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 2_500);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.max_tool_calls, undefined);
    assert.equal(body.include, undefined);
    assert.equal(JSON.stringify(body.text.format.schema).includes('uniqueItems'), false);
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'stub-request-id',
    });
    response.end(JSON.stringify({
      id: 'stub-response-id',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(validIntent()) }] }],
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        total_tokens: 20,
        output_tokens_details: { reasoning_tokens: 3 },
      },
    }));
  }, async (baseUrl) => {
    const gateway = new AssistantOpenAiPlannerGateway('stub-key', fetch, baseUrl, 1_000);
    const result = await gateway.plan({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      messages: ['Нужна квартира'],
      context: null,
    });

    assert.equal(result.provider, 'openai');
    assert.equal(result.requestId, 'stub-request-id');
    assert.equal(result.responseId, 'stub-response-id');
    assert.equal(result.totalTokens, 20);
    assert.deepEqual(result.output, validIntent());
  });
});

test('Assistant T02 OpenAI gateway keeps its timeout active while reading the response body', async () => {
  const gateway = new AssistantOpenAiPlannerGateway(
    'stub-key',
    createAbortableDelayedJsonFetch(),
    'http://openai.test',
    25,
  );
  await assert.rejects(
    gateway.plan({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      messages: ['Нужна квартира'],
      context: null,
    }),
    (error) => error.code === 'ASSISTANT_OPENAI_TIMEOUT',
  );
});

test('Assistant T02 planner preserves OpenAI provider failure classification in private telemetry', async () => {
  const planner = new AssistantQueryPlanner(new AssistantOpenAiPlannerGateway(
    'stub-key',
    createAbortableDelayedJsonFetch({ 'x-request-id': 'timeout-request-id' }),
    'http://openai.test',
    25,
  ));
  await assert.rejects(
    planner.plan({ messages: ['Нужна квартира'], context: null }),
    (error) => {
      assert.equal(error.code, 'ASSISTANT_OPENAI_TIMEOUT');
      assert.equal(error.telemetry[0].provider, 'openai');
      assert.equal(error.telemetry[0].errorCode, 'ASSISTANT_OPENAI_TIMEOUT');
      assert.equal(error.telemetry[0].requestId, 'timeout-request-id');
      return true;
    },
  );
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

test('Assistant T02 answer service forwards trusted geo provenance to the planner', async () => {
  let plannerContext = null;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({
      async plan(request) {
        plannerContext = request.context;
        return validIntent();
      },
    }),
    { async search() { throw new Error('UNEXPECTED_SEARCH'); } },
  );

  await service.answer({
    messages: ['Какой налог будет по договору?'],
    context: null,
    geo: {
      kind: 'POINT',
      mode: 'NEAR',
      label: 'Павелецкая Плаза',
      point: { latitude: 55.7312, longitude: 37.6364 },
      distanceMeters: 2_000,
      source: 'LANDMARK',
      landmarkId: '11111111-1111-4111-8111-111111111111',
    },
  });

  assert.equal(plannerContext.geo.source, 'LANDMARK');
  assert.equal(plannerContext.geo.landmarkId, '11111111-1111-4111-8111-111111111111');
});

test('Assistant T02 answer service canonicalizes a DB district in a natural Russian case', async () => {
  let searchedIntent = null;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' })),
    {
      async search(intent) {
        searchedIntent = intent;
        return { exact: [], alternatives: [] };
      },
    },
    undefined,
    {
      async findAdministrativeDistrict(name) {
        assert.equal(name, 'Хамовников');
        return { id: 'district-hamovniki', name: 'Хамовники' };
      },
    },
  );

  await service.answer({
    messages: ['двухкомнатная до 50 млн в районе Хамовников'],
    context: null,
  });

  assert.equal(searchedIntent.hardFilters.district, 'Хамовники');
});

test('Assistant T02 answer service consumes only a server-verified landmark alias', async () => {
  let searchedIntent = null;
  const landmarkId = '11111111-1111-4111-8111-111111111111';
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner(createAssistantPlannerGateway({ ASSISTANT_AI_MODE: 'fake' })),
    {
      async search(intent) {
        searchedIntent = intent;
        return { exact: [], alternatives: [] };
      },
    },
    undefined,
    {
      async findAdministrativeDistrict() {
        return null;
      },
      async matchesTrustedLandmark(id, query) {
        assert.equal(id, landmarkId);
        assert.equal(query, 'Павелецкой Плазы');
        return true;
      },
    },
  );

  await service.answer({
    messages: ['двухкомнатная до 50 млн в районе Павелецкой Плазы'],
    context: null,
    geo: {
      kind: 'POINT',
      mode: 'NEAR',
      label: 'Ручная точка Павелецкая',
      point: { latitude: 55.7312, longitude: 37.6364 },
      distanceMeters: 2_000,
      source: 'LANDMARK',
      landmarkId,
    },
  });

  assert.equal(searchedIntent.hardFilters.district, null);
});

test('Assistant T02 answer service returns grounded public cards and keeps internals separate', async () => {
  const evidence = candidate('11111111-1111-4111-8111-111111111111');
  let knowledgeCalls = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({
      async plan() {
        return validIntent({
          hardFilters: { ...emptyFilters(), budgetMaxRub: 25_000_000, rooms: [2], district: 'Хамовники' },
        });
      },
    }),
    { async search() { return { exact: [evidence], alternatives: [] }; } },
    { async retrieve() { knowledgeCalls += 1; return []; } },
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
  assert.equal(knowledgeCalls, 0);
});

test('Assistant T02 comparison searches both explicit targets outside a single page context', async () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ЖК Первый', 'ЖК Второй'],
    comparisonTargetModes: ['EXACT', 'EXACT'],
  });
  const receivedContexts = [];
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return intent; } }),
    {
      async search(searchIntent, context) {
        receivedContexts.push(context);
        const first = receivedContexts.length === 1;
        const evidence = candidate(first
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222', {
          objectTitle: first ? 'ЖК Первый' : 'ЖК Второй',
        });
        return {
          exact: [evidence],
          totalExactResults: 1,
          alternatives: [],
          geo: null,
          summary: {
            minimumPriceRub: evidence.priceRub,
            completion: ['3 кв. 2027'],
            metros: ['Спортивная'],
          },
        };
      },
    },
  );

  const result = await service.answer({
    messages: ['Сравни ЖК Первый и ЖК Второй по цене, нужны двушки до 25 млн'],
    context: { kind: 'OBJECT', key: 'zhk-pervyy', label: 'ЖК Первый' },
    now: new Date('2026-08-24T12:00:00.000Z'),
  });

  assert.deepEqual(receivedContexts, [null, null]);
  assert.deepEqual(result.answer.groups.map(({ status }) => status), ['MATCHED', 'MATCHED']);

  const catalogContext = {
    kind: 'CATALOG_FILTERS',
    key: 'locationId=10000000-0000-4000-8000-000000000001',
    label: 'Фильтры каталога',
  };
  receivedContexts.length = 0;
  await service.answer({
    messages: ['Сравни ЖК Первый и ЖК Второй по цене, нужны двушки до 25 млн'],
    context: catalogContext,
    now: new Date('2026-08-24T12:00:00.000Z'),
  });
  assert.deepEqual(receivedContexts, [catalogContext, catalogContext]);

  receivedContexts.length = 0;
  await service.answer({
    messages: ['Сравни ЖК Первый и ЖК Второй по цене, нужны двушки до 25 млн'],
    context: {
      kind: 'DEVELOPER',
      key: '10000000-0000-4000-8000-000000000002',
      label: 'Текущий застройщик',
    },
    now: new Date('2026-08-24T12:00:00.000Z'),
  });
  assert.deepEqual(receivedContexts, [null, null]);
});

test('Assistant T02 answer service assigns one matching lot to only one comparison group', async () => {
  const intent = validIntent({
    taskType: 'COMPARE',
    comparisonTargets: ['ЖК Первый', 'ЖК Второй'],
    comparisonTargetModes: ['EXACT', 'EXACT'],
  });
  const shared = candidate('11111111-1111-4111-8111-111111111111', {
    objectTitle: 'ЖК Первый',
    developer: 'ЖК Второй',
    priceRub: 10_000_000,
  });
  const alphaOnly = candidate('22222222-2222-4222-8222-222222222222', {
    objectTitle: 'ЖК Первый',
    developer: 'Other',
    priceRub: 20_000_000,
  });
  const betaOnly = candidate('33333333-3333-4333-8333-333333333333', {
    objectTitle: 'Other',
    developer: 'ЖК Второй',
    priceRub: 21_000_000,
  });
  let searchCall = 0;
  const service = new AssistantAnswerService(
    new AssistantQueryPlanner({ async plan() { return intent; } }),
    {
      async search() {
        const first = searchCall === 0;
        searchCall += 1;
        const exact = first ? [shared, alphaOnly] : [shared, betaOnly];
        return {
          exact,
          totalExactResults: 2,
          alternatives: [],
          geo: null,
          summary: {
            minimumPriceRub: 10_000_000,
            completion: ['3 кв. 2027'],
            metros: ['Спортивная'],
          },
        };
      },
    },
  );

  const result = await service.answer({
    messages: ['Сравни ЖК Первый и ЖК Второй по цене, нужны двушки до 25 млн в районе Хамовники у метро Спортивная'],
    context: null,
    now: new Date('2026-08-24T12:00:00.000Z'),
  });
  assert.equal(result.answer.kind, 'COMPARISON_RESULTS', JSON.stringify(result.answer));
  const groupIds = result.answer.groups.map((group) => [
    ...group.exactResults,
    ...group.additionalExactResults,
  ].map(({ unitId }) => unitId));
  const allIds = groupIds.flat();

  assert.deepEqual(result.answer.groups.map(({ status, totalExactResults }) => ({
    status,
    totalExactResults,
  })), [
    { status: 'MATCHED', totalExactResults: 2 },
    { status: 'MATCHED', totalExactResults: 2 },
  ]);
  assert.deepEqual(groupIds, [
    [shared.unitId, alphaOnly.unitId],
    [betaOnly.unitId],
  ]);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.deepEqual(result.evidence.map(({ unitId }) => unitId), allIds);
});

function validIntent(overrides = {}) {
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

async function withHttpStub(handler, run) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function createAbortableDelayedJsonFetch(headers = {}) {
  return async (_url, init = {}) => {
    const signal = init.signal;
    const stream = new ReadableStream({
      start(controller) {
        const abort = () => controller.error(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
