const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseAssistantGeoBrowserInput,
  parseAssistantGeoBrowserContext,
  parseAssistantGeoStoredContext,
  parseAssistantGeoStoredValue,
  parseAssistantReferenceGeometry,
} = require('../dist/assistant/geo/assistant-geo-contract.js');
const {
  AssistantPlaceResolverService,
  createCacheKey,
  parseResolveInput,
  parseResolveInputs,
  stripAssistantGeoClauses,
} = require('../dist/assistant/geo/assistant-place-resolver.service.js');
const {
  extractAssistantExplicitHardFilters,
} = require('../dist/assistant/assistant-query-planner.js');
const { AssistantService } = require('../dist/assistant/assistant.service.js');
const {
  AssistantGeoLandmarkService,
} = require('../dist/assistant/geo/assistant-geo-landmark.service.js');
const {
  AssistantGeoProviderError,
  LocationIqGeoProvider,
} = require('../dist/assistant/geo/assistant-geo-provider.js');
const {
  AssistantGeoProviderPolicyService,
} = require('../dist/assistant/geo/assistant-geo-provider-policy.service.js');
const {
  AssistantGeoUsageLedgerService,
  AssistantGeoUsageLedgerError,
} = require('../dist/assistant/geo/assistant-geo-usage-ledger.service.js');
const {
  selectAssistantGeoProviderCandidates,
} = require('../dist/assistant/geo/assistant-geo-landmark-identity.js');
const {
  AssistantOverpassCollector,
  AssistantOverpassError,
} = require('../dist/assistant/geo/assistant-overpass-collector.js');

const landmarkId = '11111111-1111-4111-8111-111111111111';

test('FIX-GEO1 browser accepts only a trusted landmark id or a validated manual point', () => {
  assert.deepEqual(parseAssistantGeoBrowserInput({
    referenceType: 'LANDMARK',
    landmarkId,
    mode: 'NEAR',
  }), {
    referenceType: 'LANDMARK',
    landmarkId,
    mode: 'NEAR',
    distanceMeters: null,
  });
  assert.deepEqual(parseAssistantGeoBrowserInput({
    referenceType: 'MANUAL_POINT',
    point: { latitude: 55.751244, longitude: 37.618423, label: 'Точка на карте' },
    mode: 'NEAR',
  }), {
    referenceType: 'MANUAL_POINT',
    point: { latitude: 55.751244, longitude: 37.618423, label: 'Точка на карте' },
    mode: 'NEAR',
    distanceMeters: 2_000,
  });

  for (const invalid of [
    { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR', geometry: { type: 'Point', coordinates: [0, 0] } },
    { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR', kind: 'LINE' },
    { referenceType: 'MANUAL_POINT', point: { latitude: 55, longitude: 37, label: 'Точка' }, mode: 'INSIDE' },
    { anchor: { latitude: 55, longitude: 37, label: 'Подделка', source: 'PLACE' }, radiusMeters: 2_000 },
  ]) {
    assert.throws(() => parseAssistantGeoBrowserInput(invalid), /ASSISTANT_GEO_INPUT_INVALID/u);
  }
});

test('FIX-GEO2 fake INSIDE selection accepts only areas or genuinely closed line boundaries', () => {
  const base = {
    id: 'fake-ring', label: 'Садовое кольцо', latitude: 55.75, longitude: 37.61,
    city: 'Москва', countryCode: 'ru', geometryKind: 'LINE', geometryComplete: true,
  };
  const closed = {
    ...base,
    referenceGeometry: {
      type: 'LineString',
      coordinates: [[37.5, 55.7], [37.7, 55.7], [37.7, 55.8], [37.5, 55.7]],
    },
  };
  const open = {
    ...base,
    id: 'fake-open-road',
    referenceGeometry: {
      type: 'LineString',
      coordinates: [[37.5, 55.7], [37.7, 55.7], [37.7, 55.8]],
    },
  };

  assert.deepEqual(selectAssistantGeoProviderCandidates(
    [closed, open], { mode: 'INSIDE' }, 'fake',
  ), [closed]);
});

test('Assistant composite geo accepts a bounded ALL set and rejects duplicate or oversized input', () => {
  const secondLandmarkId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(parseAssistantGeoBrowserContext({
    operator: 'ALL',
    constraints: [
      { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR', distanceMeters: 1_000 },
      { referenceType: 'LANDMARK', landmarkId: secondLandmarkId, mode: 'NEAR' },
    ],
  }), {
    operator: 'ALL',
    constraints: [
      { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR', distanceMeters: 1_000 },
      { referenceType: 'LANDMARK', landmarkId: secondLandmarkId, mode: 'NEAR', distanceMeters: null },
    ],
  });

  for (const invalid of [
    { operator: 'ALL', constraints: [] },
    {
      operator: 'ALL',
      constraints: Array.from({ length: 6 }, (_, index) => ({
        referenceType: 'LANDMARK',
        landmarkId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
        mode: 'NEAR',
      })),
    },
    {
      operator: 'ALL',
      constraints: [
        { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR' },
        { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR' },
      ],
    },
  ]) {
    assert.throws(() => parseAssistantGeoBrowserContext(invalid), /ASSISTANT_GEO_INPUT_INVALID/u);
  }
});

test('ZAEBAL1 browser geo preserves resolver slot identity and source span', () => {
  assert.deepEqual(parseAssistantGeoBrowserContext({
    referenceType: 'LANDMARK',
    landmarkId,
    mode: 'NEAR',
    distanceMeters: 900,
    slotId: 'geo-1',
    sourceSpan: { start: 0, end: 34 },
  }), {
    referenceType: 'LANDMARK',
    landmarkId,
    mode: 'NEAR',
    distanceMeters: 900,
    slotId: 'geo-1',
    sourceSpan: { start: 0, end: 34 },
  });
});

test('FIX-GEO1 stored legacy point is normalized into the canonical discriminated union', () => {
  assert.deepEqual(parseAssistantGeoStoredContext({
    anchor: {
      latitude: 55.751244,
      longitude: 37.618423,
      label: 'Кремль',
      source: 'PLACE',
    },
    radiusMeters: 3_000,
  }), {
    kind: 'POINT',
    mode: 'NEAR',
    label: 'Кремль',
    point: { latitude: 55.751244, longitude: 37.618423 },
    distanceMeters: 3_000,
    source: 'LANDMARK',
  });
});

test('Assistant composite geo stored context keeps independently validated constraints', () => {
  const secondLandmarkId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(parseAssistantGeoStoredValue({
    operator: 'ALL',
    constraints: [
      {
        kind: 'POINT', mode: 'NEAR', label: 'Школа № 123',
        point: { latitude: 55.75, longitude: 37.61 },
        distanceMeters: 1_000, source: 'LANDMARK', landmarkId,
      },
      {
        kind: 'AREA', mode: 'NEAR', label: 'Парк Горького',
        landmarkId: secondLandmarkId, distanceMeters: 2_000, source: 'LANDMARK',
      },
    ],
  }), {
    operator: 'ALL',
    constraints: [
      {
        kind: 'POINT', mode: 'NEAR', label: 'Школа № 123',
        point: { latitude: 55.75, longitude: 37.61 },
        distanceMeters: 1_000, source: 'LANDMARK', landmarkId,
      },
      {
        kind: 'AREA', mode: 'NEAR', label: 'Парк Горького',
        landmarkId: secondLandmarkId, distanceMeters: 2_000, source: 'LANDMARK',
      },
    ],
  });
});

test('Assistant composite browser geo materializes every trusted landmark in input order', async () => {
  const secondLandmarkId = '22222222-2222-4222-8222-222222222222';
  const service = new AssistantGeoLandmarkService({});
  service.findTrustedById = async (id) => id === landmarkId
    ? {
        id,
        kind: 'POINT',
        label: 'Школа № 123',
        city: 'Москва',
        countryCode: 'ru',
        source: 'PLACE',
        point: { latitude: 55.75, longitude: 37.61 },
      }
    : {
        id: secondLandmarkId,
        kind: 'AREA',
        label: 'Парк Горького',
        city: 'Москва',
        countryCode: 'ru',
        source: 'PLACE',
      };

  const result = await service.materializeBrowserContext({
    operator: 'ALL',
    constraints: [
      { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR', distanceMeters: 500 },
      { referenceType: 'LANDMARK', landmarkId: secondLandmarkId, mode: 'INSIDE' },
    ],
  });

  assert.equal(result.operator, 'ALL');
  assert.deepEqual(result.constraints.map(({ label, mode }) => ({ label, mode })), [
    { label: 'Школа № 123', mode: 'NEAR' },
    { label: 'Парк Горького', mode: 'INSIDE' },
  ]);
  assert.equal(result.constraints[0].distanceMeters, 500);
});

test('Assistant composite browser geo rejects duplicates created by canonical default distances', async () => {
  const service = new AssistantGeoLandmarkService({});
  service.findTrustedById = async () => ({
    id: landmarkId,
    kind: 'POINT',
    label: 'Школа № 123',
    city: 'Москва',
    countryCode: 'ru',
    source: 'PLACE',
    point: { latitude: 55.75, longitude: 37.61 },
  });

  await assert.rejects(service.materializeBrowserContext({
    operator: 'ALL',
    constraints: [
      { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR' },
      { referenceType: 'LANDMARK', landmarkId, mode: 'NEAR', distanceMeters: 2_000 },
    ],
  }), /ASSISTANT_GEO_INPUT_INVALID/u);
});

test('Assistant composite geo answer view survives the persisted response boundary', () => {
  const service = Object.create(AssistantService.prototype);
  const view = service.parseStoredGeoView({
    operator: 'ALL',
    constraints: [
      {
        kind: 'POINT', mode: 'NEAR', label: 'Школа',
        point: { latitude: 55.75, longitude: 37.61 },
        distanceMeters: 1_000, source: 'MANUAL',
        referenceGeometry: { type: 'Point', coordinates: [37.61, 55.75] },
        searchArea: {
          type: 'Polygon',
          coordinates: [[[37.60, 55.74], [37.62, 55.74], [37.62, 55.76], [37.60, 55.76], [37.60, 55.74]]],
        },
      },
      {
        kind: 'POINT', mode: 'NEAR', label: 'Парк',
        point: { latitude: 55.76, longitude: 37.62 },
        distanceMeters: 2_000, source: 'MANUAL',
        referenceGeometry: { type: 'Point', coordinates: [37.62, 55.76] },
        searchArea: {
          type: 'Polygon',
          coordinates: [[[37.59, 55.73], [37.65, 55.73], [37.65, 55.79], [37.59, 55.79], [37.59, 55.73]]],
        },
      },
    ],
    markers: [],
  });

  assert.equal(view.operator, 'ALL');
  assert.deepEqual(view.constraints.map(({ label }) => label), ['Школа', 'Парк']);
});

test('FIX-GEO1 parser separates the landmark from rooms and a budget written in millions', () => {
  const phrase = 'Найди мне квартиру возле Садового кольца, например, однокомнатную, бюджет до 35 миллионов.';
  const parsed = parseResolveInput({ content: phrase, locale: 'ru', country: 'ru' });
  assert.equal(parsed.placeQuery, 'Садовое кольцо');
  assert.equal(parsed.mode, 'NEAR');
  assert.equal(parsed.explicitDistanceMeters, null);

  const filters = extractAssistantExplicitHardFilters([phrase]);
  assert.deepEqual(filters.rooms, [1]);
  assert.equal(filters.budgetMaxRub, 35_000_000);

  const reordered = parseResolveInput({
    content: 'Однокомнатную квартиру до 35 миллионов найди возле Садового кольца.',
  });
  assert.equal(reordered.placeQuery, 'Садовое кольцо');
  assert.equal(reordered.mode, 'NEAR');
});

test('Assistant composite geo parser preserves repeated natural-language landmarks as ALL constraints', () => {
  const content = 'у воды у реки возле парка такого-то возле моста около школы такой-то';
  const parsed = parseResolveInputs({ content, locale: 'ru', country: 'ru' });

  assert.equal(parsed.operator, 'ALL');
  assert.deepEqual(parsed.constraints.map((constraint) => ({
    sourceText: constraint.sourceText,
    placeQuery: constraint.placeQuery,
    mode: constraint.mode,
    category: constraint.category,
    resolutionPolicy: constraint.resolutionPolicy,
  })), [
    { sourceText: 'воды', placeQuery: 'вода', mode: 'NEAR', category: 'WATER', resolutionPolicy: 'REFINE_REQUIRED' },
    { sourceText: 'реки', placeQuery: 'река', mode: 'NEAR', category: 'RIVER', resolutionPolicy: 'REFINE_REQUIRED' },
    { sourceText: 'парка такого-то', placeQuery: 'парк такого-то', mode: 'NEAR', category: 'PARK', resolutionPolicy: 'REFINE_REQUIRED' },
    { sourceText: 'моста', placeQuery: 'мост', mode: 'NEAR', category: 'BRIDGE', resolutionPolicy: 'REFINE_REQUIRED' },
    { sourceText: 'школы такой-то', placeQuery: 'школа такой-то', mode: 'NEAR', category: 'SCHOOL', resolutionPolicy: 'REFINE_REQUIRED' },
  ]);
});

test('Assistant geo parser rejects disjunctions instead of silently turning them into ALL', () => {
  for (const connector of ['или', 'либо', 'либо же']) {
    assert.throws(() => parseResolveInputs({
      content: `возле парка Горького ${connector} около школы № 123`,
    }), /ASSISTANT_GEO_BOOLEAN_OPERATOR_UNSUPPORTED/u);
  }

  assert.doesNotThrow(() => parseResolveInputs({
    content: 'возле парка Горького, 2 или 3 комнаты',
  }));
  assert.equal(parseResolveInput({ content: 'возле кафе Или' }).placeQuery, 'кафе Или');
});

test('Assistant geo parser excludes non-landmark subjects introduced by у', async () => {
  const phrases = [
    'у метро Белорусская',
    'у застройщика ПИК',
    'у собственника',
    'у риелтора',
    'у агента',
    'у девелопера',
    'у меня',
  ];
  let providerCalls = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    {
      ...createUnusedProvider(),
      async searchWithTelemetry() {
        providerCalls += 1;
        return { providerCallCount: 1, candidates: [] };
      },
    },
    { findTrustedByQuery: async () => { throw new Error('UNEXPECTED_LANDMARK_LOOKUP'); } },
  );

  for (const content of phrases) {
    assert.equal(parseResolveInputs({ content }).constraints.length, 0);
    assert.deepEqual(await resolver.resolve({ content }), { status: 'NOT_APPLICABLE' });
  }
  assert.equal(providerCalls, 0);
});

test('Assistant geo parser keeps legacy trailing radius syntax outside the place name', () => {
  for (const [content, distanceMeters] of [
    ['рядом с Павелецкая Плаза в радиусе 2 км', 2_000],
    ['рядом с Садовым кольцом до 3 км', 3_000],
    ['рядом с Садовым кольцом до 500 м', 500],
    ['рядом с Павелецкая Плаза, в радиусе 2 км', 2_000],
    ['рядом с Павелецкая Плаза и в радиусе 2 км', 2_000],
    ['рядом с Павелецкая Плаза — в радиусе 2 км', 2_000],
  ]) {
    const parsed = parseResolveInput({ content });
    assert.equal(parsed.placeQuery, content.includes('Садовым') ? 'Садовое кольцо' : 'Павелецкая Плаза');
    assert.equal(parsed.explicitDistanceMeters, distanceMeters);
  }
});

test('Assistant geo parser trims hard-filter conjunctions from the landmark query', () => {
  for (const content of [
    'в 2 км от парка Горького и до 35 млн',
    'в 2 км от парка Горького и двухкомнатную',
  ]) {
    const parsed = parseResolveInput({ content });
    assert.equal(parsed.placeQuery, 'парк Горького');
    assert.equal(parsed.explicitDistanceMeters, 2_000);
  }
});

test('Assistant geo parser keeps prefix placeholders explicit and provider-free', async () => {
  const content = 'у ближайшей ко мне реки у какой-то школы возле какого-нибудь парка около школы такой то';
  const parsed = parseResolveInputs({ content });
  assert.deepEqual(parsed.constraints.map(({ category, resolutionPolicy }) => ({ category, resolutionPolicy })), [
    { category: 'RIVER', resolutionPolicy: 'REFINE_REQUIRED' },
    { category: 'SCHOOL', resolutionPolicy: 'REFINE_REQUIRED' },
    { category: 'PARK', resolutionPolicy: 'REFINE_REQUIRED' },
    { category: 'SCHOOL', resolutionPolicy: 'REFINE_REQUIRED' },
  ]);

  let providerCalls = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    {
      ...createUnusedProvider(),
      async searchWithTelemetry() {
        providerCalls += 1;
        return { providerCallCount: 1, candidates: [] };
      },
    },
    { findTrustedByQuery: async () => { throw new Error('UNEXPECTED_LANDMARK_LOOKUP'); } },
  );
  const result = await resolver.resolve({ content });
  assert.equal(result.status, 'COMPOSITE');
  assert.equal(providerCalls, 0);
});

test('Assistant geo parser protects common quote styles from clause and hard-filter splitting', () => {
  for (const quotedName of [
    '«Парк до 35 млн у реки»',
    '"Парк до 35 млн у реки"',
    '“Парк до 35 млн у реки”',
    '„Парк до 35 млн у реки”',
  ]) {
    const parsed = parseResolveInputs({ content: `возле ${quotedName} до 40 млн` });
    assert.equal(parsed.constraints.length, 1);
    assert.equal(parsed.constraints[0].placeQuery, 'парк до 35 млн у реки');
  }
  const named = parseResolveInput({ content: 'возле “кафе у реки”' });
  assert.equal(named.placeQuery, 'кафе у реки');
  assert.equal(named.category, null);
});

test('Assistant composite geo parser separates named landmarks, distances and hard filters', () => {
  const content = [
    'Двухкомнатную до 35 млн в районе Хамовники',
    'не дальше 500 м от школы № 123 и в 2 км от парка Горького',
  ].join(' ');
  const parsed = parseResolveInputs({ content, locale: 'ru', country: 'ru' });
  const filters = extractAssistantExplicitHardFilters([content]);

  assert.deepEqual(parsed.constraints.map((constraint) => ({
    placeQuery: constraint.placeQuery,
    explicitDistanceMeters: constraint.explicitDistanceMeters,
    resolutionPolicy: constraint.resolutionPolicy,
  })), [
    { placeQuery: 'школа № 123', explicitDistanceMeters: 500, resolutionPolicy: 'LOOKUP' },
    { placeQuery: 'парк Горького', explicitDistanceMeters: 2_000, resolutionPolicy: 'LOOKUP' },
  ]);
  assert.deepEqual(filters.rooms, [2]);
  assert.equal(filters.budgetMaxRub, 35_000_000);
  assert.equal(filters.district, 'Хамовники');
});

test('Assistant composite geo resolver keeps generic landmark slots explicit without provider calls', async () => {
  let landmarkCalls = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    createUnusedProvider(),
    {
      async findTrustedByQuery() {
        landmarkCalls += 1;
        throw new Error('UNEXPECTED_LANDMARK_LOOKUP');
      },
    },
  );

  const result = await resolver.resolve({
    content: 'у воды у реки возле парка такого-то возле моста около школы такой-то',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'COMPOSITE');
  assert.equal(result.operator, 'ALL');
  assert.deepEqual(result.constraints.map(({ slotId, sourceText, status }) => ({ slotId, sourceText, status })), [
    { slotId: 'geo-1', sourceText: 'воды', status: 'REFINE_REQUIRED' },
    { slotId: 'geo-2', sourceText: 'реки', status: 'REFINE_REQUIRED' },
    { slotId: 'geo-3', sourceText: 'парка такого-то', status: 'REFINE_REQUIRED' },
    { slotId: 'geo-4', sourceText: 'моста', status: 'REFINE_REQUIRED' },
    { slotId: 'geo-5', sourceText: 'школы такой-то', status: 'REFINE_REQUIRED' },
  ]);
  assert.equal(landmarkCalls, 0);
});

test('Assistant composite geo resolver resolves named slots independently from trusted storage', async () => {
  const schoolId = '33333333-3333-4333-8333-333333333333';
  const parkId = '44444444-4444-4444-8444-444444444444';
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    createUnusedProvider(),
    {
      async findTrustedByQuery({ normalizedQuery }) {
        if (normalizedQuery === 'школа no 123') {
          return [{
            id: schoolId,
            kind: 'POINT',
            label: 'Школа № 123',
            city: 'Москва',
            countryCode: 'ru',
            source: 'PLACE',
            point: { latitude: 55.75, longitude: 37.61 },
          }];
        }
        if (normalizedQuery === 'парк горького') {
          return [{
            id: parkId,
            kind: 'AREA',
            label: 'Парк Горького',
            city: 'Москва',
            countryCode: 'ru',
            source: 'PLACE',
          }];
        }
        return [];
      },
    },
  );

  const result = await resolver.resolve({
    content: 'не дальше 500 м от школы № 123 и в 2 км от парка Горького',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'COMPOSITE');
  assert.deepEqual(result.constraints.map((constraint) => ({
    status: constraint.status,
    label: constraint.status === 'RESOLVED' ? constraint.candidates[0].label : null,
    distanceMeters: constraint.status === 'RESOLVED' ? constraint.candidates[0].distanceMeters : null,
  })), [
    { status: 'RESOLVED', label: 'Школа № 123', distanceMeters: 500 },
    { status: 'RESOLVED', label: 'Парк Горького', distanceMeters: 2_000 },
  ]);
});

test('Assistant geo resolver treats a district-shaped unknown place as a landmark candidate', async () => {
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    createUnusedProvider(),
    {
      async findTrustedByQuery() {
        return [{
          id: landmarkId,
          kind: 'POINT',
          label: 'Павелецкая Плаза',
          city: 'Москва',
          countryCode: 'ru',
          source: 'PLACE',
          point: { latitude: 55.7312, longitude: 37.6364 },
        }];
      },
    },
  );

  const result = await resolver.resolve({
    content: 'двухкомнатная до 50 млн в районе Павелецкая Плаза',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.placeQuery, 'Павелецкая Плаза');
  assert.equal(result.candidates[0].kind, 'POINT');
  assert.equal(result.candidates[0].distanceMeters, 2_000);
});

test('Assistant geo resolver leaves a known administrative district to the query planner', async () => {
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ districtNames: ['Хамовники'] }),
    createUnusedProvider(),
    {
      async findTrustedByQuery() {
        throw new Error('UNEXPECTED_LANDMARK_LOOKUP');
      },
    },
  );

  const result = await resolver.resolve({
    content: 'двухкомнатная до 50 млн в районе Хамовники',
    locale: 'ru',
    country: 'ru',
  });

  assert.deepEqual(result, { status: 'NOT_APPLICABLE' });
});

test('Assistant geo resolver does not treat a generic question about a district as a landmark fallback', async () => {
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    createUnusedProvider(),
    {
      async findTrustedByQuery() {
        throw new Error('UNEXPECTED_LANDMARK_LOOKUP');
      },
    },
  );

  const result = await resolver.resolve({
    content: 'Какой район лучше для семьи?',
    locale: 'ru',
    country: 'ru',
  });

  assert.deepEqual(result, { status: 'NOT_APPLICABLE' });
});

test('Assistant geo resolver uses the same ё/e normalization as district search', async () => {
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ districtNames: ['Хорошёво-Мнёвники'] }),
    createUnusedProvider(),
    {
      async findTrustedByQuery() {
        throw new Error('UNEXPECTED_LANDMARK_LOOKUP');
      },
    },
  );

  const result = await resolver.resolve({
    content: 'двухкомнатная до 50 млн в районе Хорошево-Мневники',
    locale: 'ru',
    country: 'ru',
  });

  assert.deepEqual(result, { status: 'NOT_APPLICABLE' });
});

test('Assistant geo resolver checks the original district before landmark identity canonicalization', async () => {
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ districtNames: ['Арбат'] }),
    createUnusedProvider(),
    {
      async findTrustedByQuery() {
        throw new Error('UNEXPECTED_LANDMARK_LOOKUP');
      },
    },
  );

  const result = await resolver.resolve({
    content: 'двухкомнатная до 50 млн в районе Арбат',
    locale: 'ru',
    country: 'ru',
  });

  assert.deepEqual(result, { status: 'NOT_APPLICABLE' });
});

test('Assistant geo resolver recognizes an administrative district in a natural Russian case', async () => {
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({
      districtNames: ['Хамовники'],
      districtMorphology: { хамовников: 'Хамовники' },
    }),
    createUnusedProvider(),
    {
      async findTrustedByQuery() {
        throw new Error('UNEXPECTED_LANDMARK_LOOKUP');
      },
    },
  );

  const result = await resolver.resolve({
    content: 'двухкомнатная до 50 млн в районе Хамовников',
    locale: 'ru',
    country: 'ru',
  });

  assert.deepEqual(result, { status: 'NOT_APPLICABLE' });
});

test('Assistant parsers preserve a separate district and landmark in either order', () => {
  for (const content of [
    'двухкомнатная до 50 млн в районе Хамовники рядом с Павелецкая Плаза',
    'двухкомнатная до 50 млн рядом с Павелецкая Плаза в районе Хамовники',
    'двухкомнатная рядом с Павелецкая Плаза в районе Хамовники, до 60 млн',
    'двухкомнатная в районе Хамовники рядом с Павелецкая Плаза до 60 млн',
  ]) {
    const geo = parseResolveInput({ content, locale: 'ru', country: 'ru' });
    const filters = extractAssistantExplicitHardFilters([content]);

    assert.equal(geo.placeQuery, 'Павелецкая Плаза', content);
    assert.equal(filters.district, 'Хамовники', content);
  }
});

test('PIDAFIX2 parser keeps UI label, user alias and canonical provider identity separate', () => {
  const ttkInputs = [
    ['ТТК', 'ттк'],
    ['Третьего транспортного кольца', 'третьего транспортного кольца'],
    ['Третьим транспортным кольцом', 'третьим транспортным кольцом'],
  ];
  for (const [phrase, userAlias] of ttkInputs) {
    const parsed = parseResolveInput({ content: `Найди квартиру возле ${phrase}`, locale: 'ru', country: 'ru' });
    assert.equal(parsed.placeQuery, 'ТТК');
    assert.equal(parsed.normalizedQuery, 'третье транспортное кольцо');
    assert.equal(parsed.providerQuery, 'третье транспортное кольцо');
    assert.equal(parsed.userAlias, userAlias);
    assert.deepEqual(parsed.aliases, ['ттк', 'третье транспортное кольцо']);
  }

  const mkad = parseResolveInput({
    content: 'Найди квартиру около московской кольцевой автомобильной дороги',
    locale: 'ru',
    country: 'ru',
  });
  assert.equal(mkad.placeQuery, 'МКАД');
  assert.equal(mkad.normalizedQuery, 'московская кольцевая автодорога');
  assert.equal(mkad.providerQuery, 'московская кольцевая автодорога');
  assert.deepEqual(mkad.aliases, [
    'мкад',
    'московская кольцевая автодорога',
    'московская кольцевая автомобильная дорога',
  ]);

  const canonical = parseResolveInput({ content: 'Найди квартиру возле ТТК', locale: 'ru', country: 'ru' });
  const implicitScope = parseResolveInput({ content: 'Найди квартиру возле ТТК', locale: 'ru', country: null });
  const inflected = parseResolveInput({
    content: 'Найди квартиру возле Третьего транспортного кольца', locale: 'ru', country: 'ru',
  });
  assert.equal(createCacheKey(canonical), createCacheKey(inflected));
  assert.equal(createCacheKey(canonical), createCacheKey(implicitScope));
  assert.notEqual(
    createCacheKey(canonical),
    createCacheKey({ ...canonical, providerViewbox: null }),
  );
  assert.deepEqual(canonical.overpassRelationIds, ['2094286']);
  assert.deepEqual(parseResolveInput({
    content: 'Найди квартиру возле Садового кольца', locale: 'ru', country: 'ru',
  }).overpassRelationIds, ['2094267']);
  assert.deepEqual(mkad.overpassRelationIds, ['2094222']);
});

test('ZAEBAL5 keeps every supported Belorussky inflection on the strict POINT identity path', () => {
  for (const [phrase, userAlias] of [
    ['Белорусский вокзал', 'белорусский вокзал'],
    ['Белорусского вокзала', 'белорусского вокзала'],
    ['Белорусскому вокзалу', 'белорусскому вокзалу'],
    ['Белорусским вокзалом', 'белорусским вокзалом'],
    ['Белорусском вокзале', 'белорусском вокзале'],
  ]) {
    const parsed = parseResolveInput({
      content: `Найди квартиру рядом с ${phrase}`,
      locale: 'ru',
      country: 'ru',
    });
    assert.equal(parsed.placeQuery, 'Белорусский вокзал', phrase);
    assert.equal(parsed.normalizedQuery, 'белорусский вокзал', phrase);
    assert.equal(parsed.userAlias, userAlias, phrase);
    assert.equal(parsed.expectedKind, 'POINT', phrase);
    assert.equal(parsed.expectedCity, 'Москва', phrase);
    assert.equal(parsed.expectedCountry, 'ru', phrase);
    assert.ok(parsed.candidatePolicy, phrase);
  }
});

test('ZAEBAL5 resolves inflected Belorussky station only through exact Moscow POINT identity', async () => {
  const providerRequests = [];
  const saved = [];
  const provider = {
    getProviderName: () => 'locationiq',
    getCacheRetentionMs: () => 3_600_000,
    async searchWithTelemetry(request) {
      providerRequests.push(request);
      return {
        providerCallCount: 1,
        candidates: [{
          id: 'belorussky-station',
          label: 'Белорусский вокзал, Москва',
          names: ['Москва-Пассажирская-Смоленская', 'Белорусский вокзал'],
          latitude: 55.7763,
          longitude: 37.5801,
          city: null,
          countryCode: 'ru',
          geometryKind: 'POINT',
          geometryComplete: true,
          entityClass: 'railway',
          entityType: 'station',
          osmType: 'way',
          osmId: '219145035',
        }],
      };
    },
  };
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    provider,
    {
      findTrustedByQuery: async () => [],
      findTrustedById: async () => null,
      async saveVerified(input) {
        saved.push(input);
        return {
          id: '12121212-1212-4212-8212-121212121212',
          kind: 'POINT',
          label: input.label,
          city: input.city,
          countryCode: input.country,
          source: 'PLACE',
          point: { latitude: 55.7763, longitude: 37.5801 },
        };
      },
    },
  );

  const result = await resolver.resolve({
    content: 'Найди квартиру в 900 м от Белорусского вокзала',
    locale: 'ru',
    country: null,
  });

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.placeQuery, 'Белорусский вокзал');
  assert.equal(result.candidates[0].kind, 'POINT');
  assert.equal(result.candidates[0].distanceMeters, 900);
  assert.deepEqual(providerRequests, [{
    purpose: 'METADATA',
    expectedKind: 'POINT',
    query: 'Белорусский вокзал',
    locale: 'ru',
    country: 'ru',
    viewbox: [37.3, 55.5, 37.9, 55.9],
  }]);
  assert.equal(saved[0].label, 'Белорусский вокзал');
  assert.equal(saved[0].normalizedQuery, 'белорусский вокзал');
  assert.deepEqual(saved[0].aliases, ['белорусский вокзал', 'белорусского вокзала']);
  assert.equal(saved[0].country, 'ru');
  assert.equal(saved[0].city, 'Москва');
});

test('PIDAFIX2 resolver uses canonical provider query and persists bounded identity provenance', async () => {
  const providerQueries = [];
  const overpassRequests = [];
  const saved = [];
  const provider = {
    getProviderName: () => 'locationiq',
    getCacheRetentionMs: () => 3_600_000,
    async searchWithTelemetry(request) {
      providerQueries.push(request.query);
      return providerQueries.length === 1
        ? {
            providerCallCount: 1,
            candidates: [{
              id: 'ttk-fragment',
              label: 'Третье транспортное кольцо, Москва',
              latitude: 55.75,
              longitude: 37.62,
              city: null,
              countryCode: 'ru',
              geometryKind: 'LINE',
              geometryComplete: false,
              entityClass: 'highway',
              osmType: 'way',
              osmId: '10',
            }],
          }
        : {
            providerCallCount: 1,
            candidates: [{
              id: 'moscow',
              label: 'Москва, Россия',
              latitude: 55.75,
              longitude: 37.62,
              city: null,
              countryCode: 'ru',
              geometryKind: 'AREA',
              geometryComplete: false,
              entityClass: 'boundary',
              entityType: 'administrative',
              osmType: 'relation',
              osmId: '2555133',
              boundingBox: [37.3, 55.5, 37.9, 55.9],
              names: ['Москва'],
            }],
          };
    },
  };
  const landmarks = {
    findTrustedByQuery: async () => [],
    findTrustedById: async () => null,
    async saveVerified(input) {
      saved.push(input);
      return {
        id: '56565656-5656-4565-8565-565656565656',
        kind: 'LINE',
        label: input.label,
        city: input.city,
        countryCode: input.country,
        source: 'PLACE',
      };
    },
  };
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    provider,
    landmarks,
    {
      async collect(request) {
        overpassRequests.push(request);
        return {
          geometry: {
            type: 'LineString',
            coordinates: [[37.5, 55.7], [37.6, 55.8], [37.5, 55.7]],
          },
          externalId: 'road/ttk',
          entityType: 'road',
        };
      },
    },
  );

  const result = await resolver.resolve({
    content: 'Найди квартиру возле Третьего транспортного кольца',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.placeQuery, 'ТТК');
  assert.deepEqual(providerQueries, ['третье транспортное кольцо', 'Москва']);
  assert.deepEqual(overpassRequests[0].tagValues, ['ТТК', 'Третье транспортное кольцо']);
  assert.deepEqual(overpassRequests[0].relationIds, ['2094286']);
  assert.equal(saved[0].label, 'ТТК');
  assert.equal(saved[0].normalizedQuery, 'третье транспортное кольцо');
  assert.deepEqual(saved[0].aliases, [
    'ттк',
    'третье транспортное кольцо',
    'третьего транспортного кольца',
  ]);
  assert.equal(saved[0].sourceMetadata.identityVersion, 2);
  assert.equal(saved[0].sourceMetadata.userAlias, 'третьего транспортного кольца');
  assert.equal(saved[0].sourceMetadata.providerQuery, 'третье транспортное кольцо');
});

test('PIDAFIX2 DB-first lookup includes bounded canonical aliases for legacy manual landmarks', async () => {
  let lookupInput;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    createUnusedProvider(),
    {
      async findTrustedByQuery(input) {
        lookupInput = input;
        return [{
          id: '45454545-4545-4454-8454-454545454545',
          kind: 'POINT',
          label: 'Ручная точка ТТК',
          city: 'Москва',
          countryCode: 'ru',
          source: 'ALIAS',
          point: { latitude: 55.75, longitude: 37.62 },
        }];
      },
      findTrustedById: async () => null,
    },
  );

  const result = await resolver.resolve({ content: 'Найди квартиру возле ТТК', locale: 'ru', country: null });
  assert.equal(result.status, 'RESOLVED');
  assert.deepEqual(lookupInput.normalizedQueries, ['третье транспортное кольцо', 'ттк']);
  assert.equal(lookupInput.country, 'ru');
  assert.deepEqual(lookupInput.viewbox, [37.3, 55.5, 37.9, 55.9]);
  assert.equal(lookupInput.minimumIdentityVersion, 2);
});

test('PIDAFIX2 trusted landmark identity matches a stored alias independently of its display label', async () => {
  let lookup;
  const landmarks = new AssistantGeoLandmarkService({
    $queryRaw: async (query) => {
      lookup = query;
      return [{ id: landmarkId }];
    },
  });

  const matched = await landmarks.matchesTrustedIdentity(landmarkId, [
    'Павелецкой Плазы',
    'Павелецкая Плаза',
  ]);

  assert.equal(matched, true);
  assert.match(lookup.strings.join(''), /normalized_query"::text/u);
  assert.deepEqual(
    lookup.values.filter((value) => typeof value === 'string' && value.includes('павелецк')),
    ['павелецкой плазы', 'павелецкая плаза'],
  );
});

test('FIX-GEO1 explicit distance wins and INSIDE has no distance', () => {
  const near = parseResolveInput({
    content: 'Найди квартиру не дальше 3 км от Садового кольца, 1-комнатную до 35 млн',
  });
  assert.equal(near.placeQuery, 'Садовое кольцо');
  assert.equal(near.mode, 'NEAR');
  assert.equal(near.explicitDistanceMeters, 3_000);

  const commonNear = parseResolveInput({
    content: 'Найди квартиру в 1,5 км от Садового кольца, до 35 млн',
  });
  assert.equal(commonNear.placeQuery, 'Садовое кольцо');
  assert.equal(commonNear.explicitDistanceMeters, 1_500);

  const inside = parseResolveInput({
    content: 'Найди квартиру внутри района Арбат, бюджет до 35 млн',
  });
  assert.equal(inside.placeQuery, 'район Арбат');
  assert.equal(inside.mode, 'INSIDE');
  assert.equal(inside.explicitDistanceMeters, null);
});

test('ZAEBAL1 deterministic inspector covers required geo phrases with stable slots and spans', () => {
  const cases = [
    ['в 900 м от Белорусского вокзала', 'Белорусский вокзал', 'NEAR', 900],
    ['у МКАД', 'МКАД', 'NEAR', null],
    ['внутри района Арбат', 'район Арбат', 'INSIDE', null],
  ];
  for (const [content, placeQuery, mode, explicitDistanceMeters] of cases) {
    const parsed = parseResolveInputs({ content });
    assert.equal(parsed.constraints.length, 1, content);
    assert.deepEqual({
      slotId: parsed.constraints[0].slotId,
      sourceSpan: parsed.constraints[0].sourceSpan,
      placeQuery: parsed.constraints[0].placeQuery,
      mode: parsed.constraints[0].mode,
      explicitDistanceMeters: parsed.constraints[0].explicitDistanceMeters,
    }, {
      slotId: 'geo-1',
      sourceSpan: { start: 0, end: content.length },
      placeQuery,
      mode,
      explicitDistanceMeters,
    });
  }

  const composite = parseResolveInputs({ content: 'рядом с ТТК и рядом с Москва-Сити' });
  assert.equal(composite.operator, 'ALL');
  assert.deepEqual(composite.constraints.map(({ slotId, placeQuery }) => ({ slotId, placeQuery })), [
    { slotId: 'geo-1', placeQuery: 'ТТК' },
    { slotId: 'geo-2', placeQuery: 'Москва-Сити' },
  ]);

  const full = 'Двухкомнатная в районе Хамовники и внутри района Арбат до 50 млн';
  const inspected = parseResolveInput({ content: full });
  assert.equal(full.slice(inspected.sourceSpan.start, inspected.sourceSpan.end), 'внутри района Арбат');
  const sanitized = stripAssistantGeoClauses(full);
  assert.equal(sanitized.includes('Арбат'), false);
  assert.equal(extractAssistantExplicitHardFilters([sanitized]).district, 'Хамовники');

  assert.equal(parseResolveInputs({ content: 'Найди рядом с выбранной точкой' }).constraints.length, 0);
});

test('ZAEBAL1 sanitizer preserves a comma-delimited district between composite geo clauses', () => {
  for (const districtClause of ['в районе Хамовники', 'район Хамовники']) {
    const content = `Найди в 5 км от ТТК, ${districtClause}, и в 2 км от Москва-Сити`;
    const parsed = parseResolveInputs({ content });
    assert.deepEqual(parsed.constraints.map(({ placeQuery }) => placeQuery), ['ТТК', 'Москва-Сити']);

    const sanitized = stripAssistantGeoClauses(content);
    assert.equal(sanitized.includes('ТТК'), false);
    assert.equal(sanitized.includes('Москва-Сити'), false);
    assert.equal(extractAssistantExplicitHardFilters([sanitized]).district, 'Хамовники');
  }
});

test('FIX-GEO2 direct geo-bearing message proceeds to persistence without browser geo', async () => {
  let sideEffects = 0;
  const afterGuard = new Error('AFTER_RAW_MESSAGE_GUARD');
  const fail = async () => {
    sideEffects += 1;
    throw afterGuard;
  };
  const service = new AssistantService({
    assistantRun: { findUnique: fail },
    assistantConversation: { findFirst: fail },
    $transaction: fail,
  }, { enqueue: fail }, { materializeBrowserContext: fail });

  await assert.rejects(service.startRun({
    conversationId: '10000000-0000-4000-8000-000000000001',
    ownerUserId: '20000000-0000-4000-8000-000000000001',
    idempotencyKey: '30000000-0000-4000-8000-000000000001',
    body: { content: 'в 900 м от Белорусского вокзала' },
  }), (error) => error === afterGuard);
  assert.equal(sideEffects, 1);
});

test('ZAEBAL1 message boundary preserves source spans when content contains repeated whitespace', async () => {
  const content = 'Найди   в 900 м от Белорусского вокзала';
  const inspected = parseResolveInput({ content });
  const afterGuard = new Error('AFTER_CANONICAL_GEO_GUARD');
  const service = new AssistantService({
    assistantRun: { async findUnique() { throw afterGuard; } },
  }, {}, {});

  await assert.rejects(service.startRun({
    conversationId: '10000000-0000-4000-8000-000000000001',
    ownerUserId: '20000000-0000-4000-8000-000000000001',
    idempotencyKey: '30000000-0000-4000-8000-000000000001',
    body: {
      content,
      geo: {
        referenceType: 'MANUAL_POINT',
        point: { latitude: 55.7763, longitude: 37.5801, label: 'Белорусский вокзал' },
        mode: 'NEAR',
        distanceMeters: 900,
        slotId: inspected.slotId,
        sourceSpan: inspected.sourceSpan,
      },
    },
  }), (error) => error === afterGuard);
});

test('ZAEBAL1 confirmed manual point keeps matching slot metadata while overriding distance', async () => {
  const content = 'Найди в радиусе 2 км от geocoder unavailable';
  const inspected = parseResolveInput({ content });
  const afterGuard = new Error('AFTER_CANONICAL_GEO_GUARD');
  const service = new AssistantService({
    assistantRun: { async findUnique() { throw afterGuard; } },
  }, {}, {});

  await assert.rejects(service.startRun({
    conversationId: '10000000-0000-4000-8000-000000000001',
    ownerUserId: '20000000-0000-4000-8000-000000000001',
    idempotencyKey: '30000000-0000-4000-8000-000000000001',
    body: {
      content,
      geo: {
        referenceType: 'MANUAL_POINT',
        point: { latitude: 55.751244, longitude: 37.618423, label: 'Точка на карте' },
        mode: 'NEAR',
        distanceMeters: 3_000,
        slotId: inspected.slotId,
        sourceSpan: inspected.sourceSpan,
      },
    },
  }), (error) => error === afterGuard);
});

test('FIX-GEO1 geometry cache keeps NEAR and INSIDE negative results isolated', () => {
  const base = {
    placeQuery: 'район Арбат',
    locale: 'ru',
    country: 'ru',
    viewbox: null,
  };
  assert.notEqual(
    createCacheKey({ ...base, mode: 'NEAR' }),
    createCacheKey({ ...base, mode: 'INSIDE' }),
  );
});

test('FIX-GEO1 resolver applies 2 km for points, 5 km for full landmarks and keeps explicit override', async () => {
  const pointId = '22222222-2222-4222-8222-222222222222';
  const lineId = '33333333-3333-4333-8333-333333333333';
  const landmarks = {
    async findTrustedByQuery({ normalizedQuery }) {
      return normalizedQuery.includes('вокзал')
        ? [{
            id: pointId,
            kind: 'POINT',
            label: 'Белорусский вокзал',
            city: 'Москва',
            countryCode: 'ru',
            source: 'PLACE',
            point: { latitude: 55.7763, longitude: 37.5801 },
          }]
        : [{
            id: lineId,
            kind: 'LINE',
            label: 'Садовое кольцо',
            city: 'Москва',
            countryCode: 'ru',
            source: 'PLACE',
          }];
    },
  };
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma(),
    createUnusedProvider(),
    landmarks,
  );

  const point = await resolver.resolve({ content: 'Найди квартиру возле Белорусского вокзала' });
  const line = await resolver.resolve({ content: 'Найди квартиру возле Садового кольца' });
  const override = await resolver.resolve({ content: 'Найди квартиру не дальше 3 км от Садового кольца' });
  assert.equal(point.candidates[0].distanceMeters, 2_000);
  assert.equal(line.candidates[0].distanceMeters, 5_000);
  assert.equal(override.candidates[0].distanceMeters, 3_000);
});

test('FIX-GEO1 stale landmark cache falls through to providers instead of becoming a false NOT_FOUND', async () => {
  let cacheDeletes = 0;
  let cacheWrites = 0;
  let providerCalls = 0;
  const freshId = '44444444-4444-4444-8444-444444444444';
  const prisma = createResolverPrisma({
    cache: {
      candidatesJson: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'LINE',
        label: 'Садовое кольцо',
        city: 'Москва',
        countryCode: 'ru',
        source: 'PLACE',
      }],
    },
    onCacheDelete: () => { cacheDeletes += 1; },
    onCacheWrite: () => { cacheWrites += 1; },
  });
  const provider = {
    ...createUnusedProvider(),
    async searchWithTelemetry() {
      providerCalls += 1;
      return {
        providerCallCount: 1,
        candidates: [{
          id: 'provider-road',
          label: 'Садовое кольцо',
          latitude: 55.75,
          longitude: 37.62,
          city: 'Москва',
          countryCode: 'ru',
          geometryKind: 'LINE',
          geometryComplete: true,
          referenceGeometry: {
            type: 'LineString',
            coordinates: [[37.58, 55.74], [37.66, 55.76]],
          },
        }],
      };
    },
  };
  const landmarks = {
    findTrustedByQuery: async () => [],
    findTrustedById: async () => null,
    async saveVerified() {
      return {
        id: freshId,
        kind: 'LINE',
        label: 'Садовое кольцо',
        city: 'Москва',
        countryCode: 'ru',
        source: 'PLACE',
      };
    },
  };
  const resolver = new AssistantPlaceResolverService(prisma, provider, landmarks);
  const result = await resolver.resolve({ content: 'Найди квартиру возле Садового кольца' });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.candidates[0].id, freshId);
  assert.equal(providerCalls, 1);
  assert.equal(cacheDeletes, 1);
  assert.equal(cacheWrites, 1);
});

test('FIX-GEO1 valid geometry cache rehydrates a trusted landmark without provider spend', async () => {
  const cachedId = '45454545-4545-4454-8454-454545454545';
  const operations = [];
  const prisma = createResolverPrisma({
    cache: {
      candidatesJson: [{
        id: cachedId,
        kind: 'LINE',
        label: 'Садовое кольцо',
        city: 'Москва',
        countryCode: 'ru',
        source: 'PLACE',
      }],
    },
    onOperation: (operation) => operations.push(operation),
  });
  const resolver = new AssistantPlaceResolverService(
    prisma,
    createUnusedProvider(),
    {
      findTrustedByQuery: async () => [],
      findTrustedById: async (id) => id === cachedId ? {
        id: cachedId,
        kind: 'LINE',
        label: 'Садовое кольцо',
        city: 'Москва',
        countryCode: 'ru',
        source: 'PLACE',
      } : null,
    },
  );

  const result = await resolver.resolve({ content: 'Найди квартиру возле Садового кольца' });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.candidates[0].id, cachedId);
  assert.equal(operations.at(-1).data.cacheHit, true);
  assert.equal(operations.at(-1).data.providerCallCount, 0);
});

test('Assistant production resolver persists an official KB ADDRESS after a provider miss', async () => {
  const factId = '56565656-5656-4565-8565-565656565656';
  const observedAt = new Date('2026-08-31T00:00:00.000Z');
  const saved = [];
  const cacheWrites = [];
  const operations = [];
  let providerCalls = 0;
  const prisma = createResolverPrisma({
    knowledgeFacts: [{
      id: factId,
      observedAt,
      valueJson: {
        label: 'Missing Knowledge Plaza, Москва',
        latitude: 55.7308,
        longitude: 37.6337,
        city: 'Москва',
        countryCode: 'ru',
      },
    }],
    onKnowledgeQuery: (input) => {
      assert.equal(input.where.kind, 'ADDRESS');
      assert.equal(input.where.isActive, true);
      assert.equal(input.where.source.state, 'ACTIVE');
      assert.equal(input.where.source.type, 'DEVELOPMENT_PAGE');
    },
    onCacheWrite: (input) => cacheWrites.push(input),
    onOperation: (input) => operations.push(input),
  });
  const resolver = new AssistantPlaceResolverService(
    prisma,
    {
      getProviderName: () => 'fake',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry() {
        providerCalls += 1;
        return { providerCallCount: 1, candidates: [] };
      },
    },
    {
      findTrustedByQuery: async () => [],
      findTrustedById: async () => null,
      async saveVerified(input) {
        saved.push(input);
        return {
          id: '57575757-5757-4575-8575-575757575757',
          kind: 'POINT',
          label: input.label,
          city: input.city,
          countryCode: input.country,
          source: 'KNOWLEDGE',
          point: { latitude: 55.7308, longitude: 37.6337 },
        };
      },
    },
  );

  const result = await resolver.resolve({
    content: 'Найди квартиру рядом с Missing Knowledge Plaza',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.candidates[0].source, 'KNOWLEDGE');
  assert.deepEqual(result.candidates[0].point, { latitude: 55.7308, longitude: 37.6337 });
  assert.equal(providerCalls, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sourceProvider, 'knowledge');
  assert.equal(saved[0].sourceExternalId, factId);
  assert.deepEqual(saved[0].geometry, { type: 'Point', coordinates: [37.6337, 55.7308] });
  assert.equal(cacheWrites.length, 1);
  assert.equal(cacheWrites[0].create.candidatesJson[0].source, 'KNOWLEDGE');
  assert.equal(operations.at(-1).data.provider, 'fake');
  assert.equal(operations.at(-1).data.providerCallCount, 1);
  assert.equal(operations.at(-1).data.status, 'RESOLVED');
});

test('Assistant production resolver checks KB ADDRESS behind an existing negative cache', async () => {
  let providerCalls = 0;
  const cacheWrites = [];
  const operations = [];
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({
      cache: { candidatesJson: [] },
      knowledgeFacts: [{
        id: '60606060-6060-4060-8060-606060606060',
        observedAt: new Date('2026-08-31T00:00:00.000Z'),
        valueJson: {
          label: 'Cached Knowledge Plaza, Москва',
          latitude: 55.7308,
          longitude: 37.6337,
          city: 'Москва',
          countryCode: 'ru',
        },
      }],
      onCacheWrite: (input) => cacheWrites.push(input),
      onOperation: (input) => operations.push(input),
    }),
    {
      getProviderName: () => 'fake',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry() {
        providerCalls += 1;
        return { providerCallCount: 1, candidates: [] };
      },
    },
    {
      findTrustedByQuery: async () => [],
      findTrustedById: async () => null,
      async saveVerified(input) {
        return {
          id: '61616161-6161-4161-8161-616161616161',
          kind: 'POINT',
          label: input.label,
          city: input.city,
          countryCode: input.country,
          source: 'KNOWLEDGE',
          point: { latitude: 55.7308, longitude: 37.6337 },
        };
      },
    },
  );

  const result = await resolver.resolve({
    content: 'Найди квартиру рядом с Cached Knowledge Plaza',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.candidates[0].source, 'KNOWLEDGE');
  assert.equal(providerCalls, 0);
  assert.equal(cacheWrites.length, 1);
  assert.equal(operations.at(-1).data.provider, 'knowledge_base');
  assert.equal(operations.at(-1).data.providerCallCount, 0);
  assert.equal(operations.at(-1).data.cacheHit, false);
});

test('Assistant production resolver uses KB ADDRESS on provider error without negative cache', async () => {
  const cacheWrites = [];
  const operations = [];
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({
      knowledgeFacts: [{
        id: '58585858-5858-4585-8585-585858585858',
        observedAt: new Date('2026-08-31T00:00:00.000Z'),
        valueJson: {
          label: 'Unavailable Knowledge Plaza, Москва',
          latitude: 55.7308,
          longitude: 37.6337,
          city: 'Москва',
          countryCode: 'ru',
        },
      }],
      onCacheWrite: (input) => cacheWrites.push(input),
      onOperation: (input) => operations.push(input),
    }),
    {
      getProviderName: () => 'fake',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry() {
        const error = new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_UNAVAILABLE', true);
        error.providerCallCount = 1;
        throw error;
      },
    },
    {
      findTrustedByQuery: async () => [],
      findTrustedById: async () => null,
      async saveVerified(input) {
        return {
          id: '59595959-5959-4595-8595-595959595959',
          kind: 'POINT',
          label: input.label,
          city: input.city,
          countryCode: input.country,
          source: 'KNOWLEDGE',
          point: { latitude: 55.7308, longitude: 37.6337 },
        };
      },
    },
  );

  const result = await resolver.resolve({
    content: 'Найди квартиру рядом с Unavailable Knowledge Plaza',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.candidates[0].source, 'KNOWLEDGE');
  assert.equal(cacheWrites.length, 0);
  assert.equal(operations.at(-1).data.status, 'RESOLVED');
  assert.equal(operations.at(-1).data.providerCallCount, 1);
  assert.equal(operations.at(-1).data.errorCode, 'ASSISTANT_GEO_PROVIDER_UNAVAILABLE');
});

test('Assistant KB ADDRESS fallback never downgrades LINE or INSIDE to a point', async () => {
  let knowledgeQueries = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ onKnowledgeQuery: () => { knowledgeQueries += 1; } }),
    {
      getProviderName: () => 'fake',
      getCacheRetentionMs: () => 3_600_000,
      searchWithTelemetry: async () => ({ providerCallCount: 1, candidates: [] }),
    },
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
  );

  const line = await resolver.resolve({ content: 'Найди квартиру возле Садового кольца' });
  const area = await resolver.resolve({ content: 'Найди квартиру внутри района Арбат' });

  assert.equal(line.status, 'NOT_FOUND');
  assert.equal(area.status, 'NOT_FOUND');
  assert.equal(knowledgeQueries, 0);
});

test('FIX-GEO1 Overpass outage is UNAVAILABLE, counted and never negative-cached', async () => {
  let providerCalls = 0;
  let cacheWrites = 0;
  const operations = [];
  const prisma = createResolverPrisma({
    onCacheWrite: () => { cacheWrites += 1; },
    onOperation: (operation) => operations.push(operation),
  });
  const provider = {
    ...createUnusedProvider(),
    async searchWithTelemetry() {
      providerCalls += 1;
      return providerCalls === 1
        ? {
            providerCallCount: 1,
            candidates: [{
              id: 'provider-road',
              label: 'Садовое кольцо',
              latitude: 55.75,
              longitude: 37.62,
              city: 'Москва',
              countryCode: 'ru',
              geometryKind: 'LINE',
              geometryComplete: false,
              entityClass: 'highway',
            }],
          }
        : {
            providerCallCount: 1,
            candidates: [{
              id: 'provider-city',
              label: 'Москва, Россия',
              latitude: 55.75,
              longitude: 37.62,
              city: null,
              countryCode: 'ru',
              geometryKind: 'AREA',
              geometryComplete: false,
              entityClass: 'boundary',
              entityType: 'administrative',
              osmType: 'relation',
              osmId: '2555133',
              boundingBox: [37.3, 55.5, 37.9, 55.9],
              names: ['Москва'],
            }],
          };
    },
  };
  const resolver = new AssistantPlaceResolverService(
    prisma,
    provider,
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
    { collect: async () => { throw new AssistantOverpassError('ASSISTANT_OVERPASS_TIMEOUT', true); } },
  );
  const result = await resolver.resolve({ content: 'Найди квартиру возле Садового кольца' });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(cacheWrites, 0);
  assert.equal(operations.at(-1).data.providerCallCount, 3);
  assert.equal(operations.at(-1).data.errorCode, 'ASSISTANT_OVERPASS_TIMEOUT');
});

test('PIDAFIX2 resolver owns one tracked operation and memoizes city and Overpass within it', async () => {
  const operationEvents = [];
  const providerQueries = [];
  let overpassCalls = 0;
  let savedCalls = 0;
  const prisma = createResolverPrisma({
    onOperationCreate: (input) => operationEvents.push(['create', input]),
    onOperationUpdate: (input) => operationEvents.push(['update', input]),
  });
  const provider = {
    getProviderName: () => 'locationiq',
    getCacheRetentionMs: () => 3_600_000,
    async searchWithTelemetry(request) {
      providerQueries.push(request.query);
      if (request.query === 'Москва') {
        return {
          providerCallCount: 1,
          candidates: [{
            id: 'moscow', label: 'Москва, Россия', latitude: 55.75, longitude: 37.62,
            city: null, countryCode: 'ru', geometryKind: 'AREA', geometryComplete: false,
            entityClass: 'boundary', entityType: 'administrative', osmType: 'relation',
            osmId: '2555133', names: ['Москва'],
            boundingBox: [37.3, 55.5, 37.9, 55.9],
          }],
        };
      }
      const fragment = (id) => ({
        id, label: 'ТТК, Москва', latitude: 55.75, longitude: 37.62,
        city: 'Москва', countryCode: 'ru', geometryKind: 'LINE', geometryComplete: false,
        entityClass: 'highway', osmType: 'way', osmId: id,
      });
      return { providerCallCount: 1, candidates: [fragment('10'), fragment('11')] };
    },
  };
  const landmarks = {
    findTrustedByQuery: async () => [],
    findTrustedById: async () => null,
    async saveVerified(input) {
      savedCalls += 1;
      const remainingMs = input.expiresAt.getTime() - Date.now();
      assert.ok(remainingMs > 29 * 24 * 60 * 60 * 1_000 && remainingMs <= 30 * 24 * 60 * 60 * 1_000);
      return {
        id: '67676767-6767-4676-8676-676767676767',
        kind: 'LINE', label: input.label, city: input.city, countryCode: input.country, source: 'PLACE',
      };
    },
  };
  const usageLedger = {
    async runResolution(operationId, task) {
      operationEvents.push(['context', operationId]);
      return task();
    },
  };
  const resolver = new AssistantPlaceResolverService(
    prisma,
    provider,
    landmarks,
    {
      async collect() {
        overpassCalls += 1;
        return {
          geometry: { type: 'LineString', coordinates: [[37.5, 55.7], [37.6, 55.8], [37.5, 55.7]] },
          externalId: 'overpass/ttk',
          entityType: 'road',
        };
      },
    },
    usageLedger,
  );

  const result = await resolver.resolve({ content: 'Найди квартиру возле ТТК', locale: 'ru', country: 'ru' });
  assert.equal(result.status, 'RESOLVED');
  assert.deepEqual(providerQueries, ['третье транспортное кольцо', 'Москва']);
  assert.equal(overpassCalls, 1);
  assert.equal(savedCalls, 2);
  assert.equal(operationEvents[0][0], 'create');
  assert.equal(operationEvents[0][1].data.status, 'RUNNING');
  assert.equal(operationEvents[0][1].data.provider, 'locationiq');
  assert.equal(operationEvents[1][0], 'context');
  assert.equal(operationEvents[1][1], operationEvents[0][1].data.id);
  assert.equal(operationEvents.at(-1)[0], 'update');
  assert.equal(Object.hasOwn(operationEvents.at(-1)[1].data, 'provider'), false);
  assert.equal(operationEvents.at(-1)[1].data.status, 'RESOLVED');
});

test('Assistant composite geo shares one physical-attempt budget across all named slots', async () => {
  const providerQueries = [];
  const operationEvents = [];
  const operationIds = [];
  let resolutionContexts = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({
      onOperationCreate: (input) => operationEvents.push(['create', input]),
      onOperationUpdate: (input) => operationEvents.push(['update', input]),
    }),
    {
      getProviderName: () => 'locationiq',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry(request) {
        providerQueries.push(request.query);
        return { providerCallCount: 1, candidates: [] };
      },
    },
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
    undefined,
    {
      async runResolution(operationId, task) {
        operationIds.push(operationId);
        resolutionContexts += 1;
        if (resolutionContexts > 2) {
          throw new AssistantGeoProviderError(
            'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED',
            false,
          );
        }
        return task();
      },
    },
  );

  const result = await resolver.resolve({
    content: 'возле парка Горького около школы № 123 у моста Багратион у реки Москва',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'COMPOSITE');
  assert.deepEqual(result.constraints.map(({ status }) => status), [
    'NOT_FOUND', 'NOT_FOUND', 'UNAVAILABLE', 'UNAVAILABLE',
  ]);
  assert.equal(providerQueries.length, 2);
  assert.equal(new Set(operationIds).size, 1);
  assert.equal(operationEvents.filter(([event]) => event === 'create').length, 1);
  assert.equal(operationEvents.filter(([event]) => event === 'update').length, 1);
  assert.match(operationEvents[0][1].data.normalizedQuery, /^composite-all:[0-9a-f]{64}$/u);
  assert.equal(operationEvents.at(-1)[1].data.status, 'UNAVAILABLE');
  assert.equal(
    operationEvents.at(-1)[1].data.errorCode,
    'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED',
  );
});

test('Assistant composite geo keeps slot-specific provider failures isolated', async () => {
  let providerCalls = 0;
  const operationUpdates = [];
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ onOperationUpdate: (input) => operationUpdates.push(input) }),
    {
      getProviderName: () => 'locationiq',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry() {
        providerCalls += 1;
        if (providerCalls === 1) {
          throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_GEOMETRY_REJECTED', false);
        }
        return { providerCallCount: 1, candidates: [] };
      },
    },
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
    undefined,
    { runResolution: async (_operationId, task) => task() },
  );

  const result = await resolver.resolve({
    content: 'возле парка Горького около школы № 123',
    locale: 'ru',
    country: 'ru',
  });

  assert.equal(result.status, 'COMPOSITE');
  assert.deepEqual(result.constraints.map(({ status }) => status), ['UNAVAILABLE', 'NOT_FOUND']);
  assert.equal(providerCalls, 2);
  assert.equal(operationUpdates.length, 1);
  assert.equal(operationUpdates[0].data.status, 'UNAVAILABLE');
  assert.equal(operationUpdates[0].data.errorCode, 'ASSISTANT_GEO_PROVIDER_GEOMETRY_REJECTED');
});

test('Assistant composite audit stays UNAVAILABLE when KB resolves only the exhausted provider slot', async () => {
  let providerCalls = 0;
  const operationUpdates = [];
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({
      knowledgeFacts: (input) => input.where.searchText.contains === 'Missing Knowledge Plaza'
        ? [{
            id: '62626262-6262-4262-8262-626262626262',
            observedAt: new Date('2026-08-31T00:00:00.000Z'),
            valueJson: {
              label: 'Missing Knowledge Plaza, Москва',
              latitude: 55.7308,
              longitude: 37.6337,
              city: 'Москва',
              countryCode: 'ru',
            },
          }]
        : [],
      onOperationUpdate: (input) => operationUpdates.push(input),
    }),
    {
      getProviderName: () => 'locationiq',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry() {
        providerCalls += 1;
        const error = new AssistantGeoProviderError(
          'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED',
          false,
        );
        error.providerCallCount = 1;
        throw error;
      },
    },
    {
      findTrustedByQuery: async () => [],
      findTrustedById: async () => null,
      async saveVerified(input) {
        return {
          id: '63636363-6363-4363-8363-636363636363',
          kind: 'POINT',
          label: input.label,
          city: input.city,
          countryCode: input.country,
          source: 'KNOWLEDGE',
          point: { latitude: 55.7308, longitude: 37.6337 },
        };
      },
    },
    undefined,
    { runResolution: async (_operationId, task) => task() },
  );

  const result = await resolver.resolve({
    content: 'возле Missing Knowledge Plaza около Second Missing Place',
    locale: 'ru',
    country: 'ru',
  });

  assert.deepEqual(result.constraints.map(({ status }) => status), ['RESOLVED', 'UNAVAILABLE']);
  assert.equal(providerCalls, 1);
  assert.equal(operationUpdates.length, 1);
  assert.equal(operationUpdates[0].data.status, 'UNAVAILABLE');
  assert.equal(
    operationUpdates[0].data.errorCode,
    'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED',
  );
});

test('PIDAFIX2 fake provider keeps legacy call-count audit when the ledger is injected', async () => {
  const operations = [];
  let ledgerContexts = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ onOperation: (input) => operations.push(input) }),
    {
      getProviderName: () => 'fake',
      getCacheRetentionMs: () => 3_600_000,
      searchWithTelemetry: async () => ({ providerCallCount: 1, candidates: [] }),
    },
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
    undefined,
    { runResolution: async (_operationId, task) => { ledgerContexts += 1; return task(); } },
  );

  const result = await resolver.resolve({ content: 'Найди квартиру возле тестовой точки' });
  assert.equal(result.status, 'NOT_FOUND');
  assert.equal(ledgerContexts, 0);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].data.provider, 'fake');
  assert.equal(operations[0].data.providerCallCount, 1);
});

test('PIDAFIX2 failure to create the tracked operation blocks provider HTTP', async () => {
  let providerCalls = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ failOperationCreate: true }),
    {
      getProviderName: () => 'locationiq',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry() {
        providerCalls += 1;
        return { providerCallCount: 1, candidates: [] };
      },
    },
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
    undefined,
    { runResolution: async (_operationId, task) => task() },
  );
  const result = await resolver.resolve({ content: 'Найди квартиру возле ТТК' });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(providerCalls, 0);
});

test('PIDAFIX2 unexpected persistence failure finalizes the tracked operation before propagating', async () => {
  const operationUpdates = [];
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({
      failCacheWrite: true,
      onOperationUpdate: (input) => operationUpdates.push(input),
    }),
    {
      getProviderName: () => 'locationiq',
      getCacheRetentionMs: () => 3_600_000,
      searchWithTelemetry: async () => ({ providerCallCount: 1, candidates: [] }),
    },
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
    undefined,
    { runResolution: async (_operationId, task) => task() },
  );

  await assert.rejects(
    resolver.resolve({ content: 'Найди квартиру возле ТТК', locale: 'ru', country: 'ru' }),
    /CACHE_WRITE_FAILED/u,
  );
  assert.equal(operationUpdates.length, 1);
  assert.equal(operationUpdates[0].data.status, 'UNAVAILABLE');
  assert.equal(Object.hasOwn(operationUpdates[0].data, 'provider'), false);
  assert.equal(operationUpdates[0].data.errorCode, 'ASSISTANT_GEO_RESOLUTION_INTERNAL_ERROR');
});

test('PIDAFIX2 API enforces exact per-resolution provider caps', () => {
  assert.throws(() => new AssistantGeoUsageLedgerService({}, {}, {
    ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE: '3',
    ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE: '1',
  }), (error) => error instanceof AssistantGeoUsageLedgerError
    && error.code === 'ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE_INVALID');
  assert.throws(() => new AssistantGeoUsageLedgerService({}, {}, {
    ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE: '2',
    ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE: '2',
  }), (error) => error instanceof AssistantGeoUsageLedgerError
    && error.code === 'ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE_INVALID');
});

test('FIX-GEO1 GeoJSON validator is exact, bounded and fail-closed', () => {
  assert.deepEqual(parseAssistantReferenceGeometry({
    type: 'MultiLineString',
    coordinates: [
      [[37.58, 55.75], [37.62, 55.76]],
      [[37.62, 55.76], [37.66, 55.74]],
    ],
  }, 'LINE'), {
    type: 'MultiLineString',
    coordinates: [
      [[37.58, 55.75], [37.62, 55.76]],
      [[37.62, 55.76], [37.66, 55.74]],
    ],
  });
  assert.deepEqual(parseAssistantReferenceGeometry({
    type: 'Polygon',
    coordinates: [[[37.58, 55.74], [37.62, 55.74], [37.62, 55.77], [37.58, 55.74]]],
  }, 'AREA').type, 'Polygon');

  for (const invalid of [
    [{ type: 'Point', coordinates: [181, 55] }, 'POINT'],
    [{ type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 56]]] }, 'AREA'],
    [{ type: 'Feature', geometry: { type: 'Point', coordinates: [37, 55] } }, 'POINT'],
    [{ type: 'LineString', coordinates: [[37, 55]] }, 'LINE'],
  ]) {
    assert.throws(() => parseAssistantReferenceGeometry(invalid[0], invalid[1]), /ASSISTANT_GEO_GEOMETRY_INVALID/u);
  }
});

test('ZAEBAL5 LocationIQ request purpose bounds polygon, metadata and Moscow bounds lookups', async () => {
  const requestedUrls = [];
  const provider = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async (url) => {
    const requestedUrl = new URL(url);
    requestedUrls.push(requestedUrl);
    const query = requestedUrl.searchParams.get('q');
    if (query === 'район Арбат') {
      return new Response(JSON.stringify([{
        place_id: 'arbat-1',
        display_name: 'район Арбат, Москва',
        lat: '55.7522',
        lon: '37.5906',
        class: 'boundary',
        type: 'administrative',
        osm_type: 'relation',
        osm_id: '1255910',
        boundingbox: ['55.744', '55.765', '37.565', '37.606'],
        address: { city: 'Москва', country_code: 'ru' },
        namedetails: { name: 'Арбат', 'name:ru': 'район Арбат' },
        geojson: {
          type: 'Polygon',
          coordinates: [[[37.565, 55.744], [37.606, 55.744], [37.606, 55.765], [37.565, 55.744]]],
        },
      }]), { status: 200 });
    }
    if (query === 'Москва') {
      return new Response(JSON.stringify([{
        place_id: 'moscow-bounds',
        display_name: 'Москва, Россия',
        lat: '55.75',
        lon: '37.62',
        class: 'boundary',
        type: 'administrative',
        osm_type: 'relation',
        osm_id: '2555133',
        boundingbox: ['55.5', '55.9', '37.3', '37.9'],
        address: { country_code: 'ru' },
        namedetails: { name: 'Москва', 'name:ru': 'Москва' },
      }]), { status: 200 });
    }
    return new Response(JSON.stringify([{
      place_id: `metadata-${requestedUrls.length}`,
      display_name: query === 'Белорусский вокзал'
        ? 'Белорусский вокзал, Москва'
        : 'Третье транспортное кольцо, Москва',
      lat: '55.75',
      lon: '37.62',
      class: query === 'Белорусский вокзал' ? 'railway' : 'highway',
      type: query === 'Белорусский вокзал' ? 'station' : 'primary',
      osm_type: 'way',
      osm_id: String(100 + requestedUrls.length),
      address: { city: 'Москва', country_code: 'ru' },
      namedetails: { name: query },
    }]), { status: 200 });
  });

  const area = await provider.search({
    purpose: 'FULL_GEOMETRY', expectedKind: 'AREA',
    query: 'район Арбат', locale: 'ru', country: 'ru', viewbox: null,
  });
  const point = await provider.search({
    purpose: 'METADATA', expectedKind: 'POINT',
    query: 'Белорусский вокзал', locale: 'ru', country: 'ru', viewbox: null,
  });
  const road = await provider.search({
    purpose: 'METADATA', expectedKind: 'LINE',
    query: 'третье транспортное кольцо', locale: 'ru', country: 'ru', viewbox: null,
  });
  const bounds = await provider.search({
    purpose: 'BOUNDS', expectedKind: 'AREA',
    query: 'Москва', locale: 'ru', country: 'ru', viewbox: null,
  });

  assert.equal(requestedUrls[0].searchParams.get('polygon_geojson'), '1');
  assert.equal(requestedUrls[0].searchParams.get('namedetails'), '1');
  for (const requestedUrl of requestedUrls.slice(1)) {
    assert.equal(requestedUrl.searchParams.has('polygon_geojson'), false);
    assert.equal(requestedUrl.searchParams.get('namedetails'), '1');
  }
  assert.equal(area[0].geometryKind, 'AREA');
  assert.equal(area[0].geometryComplete, true);
  assert.equal(point[0].geometryKind, 'POINT');
  assert.equal(point[0].referenceGeometry, undefined);
  assert.equal(road[0].geometryKind, 'LINE');
  assert.equal(road[0].geometryComplete, false);
  assert.equal(bounds[0].geometryKind, 'AREA');
  assert.equal(bounds[0].geometryComplete, false);
  assert.deepEqual(bounds[0].boundingBox, [37.3, 55.5, 37.9, 55.9]);
  assert.deepEqual(area[0].names, ['Арбат', 'район Арбат']);

  await assert.rejects(provider.search({
    query: 'Москва', locale: 'ru', country: 'ru', viewbox: null,
  }), (error) => error instanceof AssistantGeoProviderError
    && error.code === 'ASSISTANT_GEO_PURPOSE_INVALID');
  await assert.rejects(provider.search({
    purpose: 'FULL_GEOMETRY', expectedKind: 'POINT',
    query: 'Белорусский вокзал', locale: 'ru', country: 'ru', viewbox: null,
  }), (error) => error instanceof AssistantGeoProviderError
    && error.code === 'ASSISTANT_GEO_PURPOSE_INVALID');
});

test('FIX-GEO1 LocationIQ requests polygon GeoJSON and validates a complete area', async () => {
  let requestedUrl;
  const provider = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify([{
      place_id: 'arbat-1',
      display_name: 'район Арбат, Москва',
      lat: '55.7522',
      lon: '37.5906',
      class: 'boundary',
      type: 'administrative',
      osm_type: 'relation',
      osm_id: '123',
      boundingbox: ['55.744', '55.765', '37.565', '37.606'],
      address: { city: 'Москва', country_code: 'ru' },
      geojson: {
        type: 'Polygon',
        coordinates: [[[37.565, 55.744], [37.606, 55.744], [37.606, 55.765], [37.565, 55.744]]],
      },
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await provider.search({
    purpose: 'FULL_GEOMETRY', expectedKind: 'AREA',
    query: 'район Арбат', locale: 'ru', country: 'ru', viewbox: null,
  });
  assert.equal(requestedUrl.searchParams.get('polygon_geojson'), '1');
  assert.equal(requestedUrl.searchParams.get('addressdetails'), '1');
  assert.equal(requestedUrl.searchParams.get('normalizecity'), '1');
  assert.equal(result[0].geometryKind, 'AREA');
  assert.equal(result[0].referenceGeometry.type, 'Polygon');
  assert.deepEqual(result[0].boundingBox, [37.565, 55.744, 37.606, 55.765]);
  assert.equal(JSON.stringify(result).includes('test-only-key'), false);
});

test('FIX-GEO1 LocationIQ never treats a highway point as complete road geometry', async () => {
  const provider = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async () => new Response(JSON.stringify([{
    place_id: 43,
    display_name: 'Садовое кольцо, Москва',
    lat: '55.751',
    lon: '37.618',
    class: 'highway',
    type: 'primary',
    osm_type: 'way',
    osm_id: 123,
    address: { city: 'Москва', country_code: 'ru' },
    boundingbox: ['55.70', '55.80', '37.55', '37.70'],
    geojson: { type: 'Point', coordinates: [37.618, 55.751] },
  }]), { status: 200 }));

  const [result] = await provider.search({
    purpose: 'METADATA',
    expectedKind: 'LINE',
    query: 'Садовое кольцо',
    locale: 'ru',
    country: 'ru',
    viewbox: null,
  });
  assert.equal(result.geometryKind, 'LINE');
  assert.equal(result.geometryComplete, false);
  assert.equal(result.referenceGeometry, undefined);
});

test('FIX-GEO1 LocationIQ rejects malformed and oversized geometry responses as a whole', async () => {
  const malformed = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async () => new Response(JSON.stringify([{
    place_id: 'broken-area',
    display_name: 'Broken',
    lat: '55',
    lon: '37',
    geojson: { type: 'Polygon', coordinates: [[[37, 55], [38, 55], [38, 56], [37, 56]]] },
  }]), { status: 200 }));
  await assert.rejects(malformed.search({
    purpose: 'FULL_GEOMETRY', expectedKind: 'AREA',
    query: 'Broken', locale: 'ru', country: null, viewbox: null,
  }), (error) => (
    error instanceof AssistantGeoProviderError && error.code === 'ASSISTANT_GEO_PROVIDER_GEOMETRY_INVALID'
  ));

  const malformedCandidate = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async () => new Response(JSON.stringify([{
    place_id: 'missing-coordinate',
    display_name: 'Malformed non-empty response',
    lat: '55',
  }]), { status: 200 }));
  await assert.rejects(
    malformedCandidate.search({
      purpose: 'METADATA', expectedKind: null,
      query: 'Broken', locale: 'ru', country: null, viewbox: null,
    }),
    (error) => error instanceof AssistantGeoProviderError
      && error.code === 'ASSISTANT_GEO_PROVIDER_RESPONSE_INVALID',
  );

  const oversized = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async () => new Response(`[{"padding":"${'x'.repeat(300_000)}"}]`, { status: 200 }));
  await assert.rejects(oversized.search({
    purpose: 'METADATA', expectedKind: null,
    query: 'Huge', locale: 'ru', country: null, viewbox: null,
  }), (error) => (
    error instanceof AssistantGeoProviderError && error.code === 'ASSISTANT_GEO_PROVIDER_RESPONSE_TOO_LARGE'
  ));

  const tooMany = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async () => new Response(JSON.stringify(Array.from({ length: 4 }, (_, index) => ({
    place_id: `candidate-${index}`,
    display_name: `Candidate ${index}`,
    lat: String(55 + index / 100),
    lon: String(37 + index / 100),
  }))), { status: 200 }));
  await assert.rejects(
    tooMany.search({
      purpose: 'METADATA', expectedKind: null,
      query: 'Too many', locale: 'ru', country: null, viewbox: null,
    }),
    (error) => error instanceof AssistantGeoProviderError
      && error.code === 'ASSISTANT_GEO_PROVIDER_RESPONSE_INVALID',
  );
});

test('PIDAFIX2 AREA accepts one Moscow administrative relation and classifies safe rejections', async (t) => {
  const valid = {
    id: 'arbat-1', label: 'район Арбат, Москва', latitude: 55.7522, longitude: 37.5906,
    city: null, countryCode: 'ru', geometryKind: 'AREA', geometryComplete: true,
    entityClass: 'boundary', entityType: 'administrative', osmType: 'relation', osmId: '1255910',
    boundingBox: [37.565, 55.744, 37.606, 55.765],
    referenceGeometry: {
      type: 'Polygon',
      coordinates: [[[37.565, 55.744], [37.606, 55.744], [37.606, 55.765], [37.565, 55.744]]],
    },
  };
  const cases = [
    ['valid with missing city', [valid], 'RESOLVED', 1, null],
    ['wrong city', [{ ...valid, id: 'wrong-city', city: 'Екатеринбург' }], 'UNAVAILABLE', 0,
      'ASSISTANT_GEO_PROVIDER_SCOPE_REJECTED'],
    ['wrong country', [{ ...valid, id: 'wrong-country', countryCode: 'kz' }], 'UNAVAILABLE', 0,
      'ASSISTANT_GEO_PROVIDER_SCOPE_REJECTED'],
    ['wrong class', [{ ...valid, id: 'wrong-class', entityClass: 'place' }], 'UNAVAILABLE', 0,
      'ASSISTANT_GEO_PROVIDER_IDENTITY_REJECTED'],
    ['wrong osm type', [{ ...valid, id: 'wrong-osm', osmType: 'way' }], 'UNAVAILABLE', 0,
      'ASSISTANT_GEO_PROVIDER_IDENTITY_REJECTED'],
    ['wrong osm id', [{ ...valid, id: 'wrong-id', osmId: '1255911' }], 'UNAVAILABLE', 0,
      'ASSISTANT_GEO_PROVIDER_IDENTITY_REJECTED'],
    ['wrong name', [{ ...valid, id: 'wrong-name', label: 'район Басманный, Москва' }], 'UNAVAILABLE', 0,
      'ASSISTANT_GEO_PROVIDER_IDENTITY_REJECTED'],
    ['centroid only', [{
      ...valid,
      id: 'centroid',
      geometryKind: 'POINT',
      geometryComplete: true,
      referenceGeometry: undefined,
      boundingBox: null,
    }], 'UNAVAILABLE', 0, 'ASSISTANT_GEO_PROVIDER_SHAPE_REJECTED'],
    ['ambiguous', [valid, { ...valid, id: 'arbat-2' }], 'UNAVAILABLE', 0,
      'ASSISTANT_GEO_PROVIDER_IDENTITY_AMBIGUOUS'],
  ];
  for (const [name, candidates, expectedStatus, expectedSaves, expectedErrorCode] of cases) {
    await t.test(name, async () => {
      let cacheWrites = 0;
      let saves = 0;
      const operations = [];
      const resolver = new AssistantPlaceResolverService(
        createResolverPrisma({
          onCacheWrite: () => { cacheWrites += 1; },
          onOperation: (operation) => operations.push(operation),
        }),
        {
          getProviderName: () => 'locationiq',
          getCacheRetentionMs: () => 3_600_000,
          searchWithTelemetry: async () => ({ providerCallCount: 1, candidates }),
        },
        {
          findTrustedByQuery: async () => [],
          findTrustedById: async () => null,
          async saveVerified(input) {
            saves += 1;
            const remainingMs = input.expiresAt.getTime() - Date.now();
            assert.ok(remainingMs > 3_590_000 && remainingMs <= 3_600_000);
            return {
              id: '78787878-7878-4787-8787-787878787878',
              kind: 'AREA', label: input.label, city: input.city, countryCode: input.country, source: 'PLACE',
            };
          },
        },
      );
      const result = await resolver.resolve({
        content: 'Найди квартиру внутри района Арбат',
        locale: 'ru',
        country: 'ru',
      });
      assert.equal(result.status, expectedStatus);
      assert.equal(saves, expectedSaves);
      assert.equal(cacheWrites, expectedStatus === 'RESOLVED' ? 1 : 0);
      assert.equal(operations.at(-1).data.errorCode, expectedErrorCode);
      assert.equal(JSON.stringify(operations).includes('provider-secret-payload'), false);
    });
  }
});

test('ZAEBAL5 response-size rejection persists only its bounded category', async () => {
  const operations = [];
  let cacheWrites = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({
      onCacheWrite: () => { cacheWrites += 1; },
      onOperation: (operation) => operations.push(operation),
    }),
    {
      getProviderName: () => 'locationiq',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry() {
        const error = new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_TOO_LARGE', false);
        error.rawPayload = 'provider-secret-payload';
        throw error;
      },
    },
    { findTrustedByQuery: async () => [], findTrustedById: async () => null },
  );

  const result = await resolver.resolve({
    content: 'Найди квартиру рядом с Белорусским вокзалом', locale: 'ru', country: 'ru',
  });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(cacheWrites, 0);
  assert.equal(operations.at(-1).data.errorCode, 'ASSISTANT_GEO_PROVIDER_RESPONSE_TOO_LARGE');
  assert.equal(JSON.stringify(operations).includes('provider-secret-payload'), false);
});

test('PIDAFIX2 LocationIQ preserves distinct AREA relation identities until resolver ambiguity check', async () => {
  const areaFixture = (placeId, osmId) => ({
    place_id: placeId,
    display_name: 'район Арбат, Москва',
    lat: '55.7522',
    lon: '37.5906',
    class: 'boundary',
    type: 'administrative',
    osm_type: 'relation',
    osm_id: osmId,
    boundingbox: ['55.744', '55.765', '37.565', '37.606'],
    address: { city: 'Москва', country_code: 'ru' },
    geojson: {
      type: 'Polygon',
      coordinates: [[[37.565, 55.744], [37.606, 55.744], [37.606, 55.765], [37.565, 55.744]]],
    },
  });
  const adapter = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async () => new Response(JSON.stringify([
    areaFixture('arbat-one', '111'),
    areaFixture('arbat-two', '222'),
  ]), { status: 200 }));
  let cacheWrites = 0;
  let landmarkWrites = 0;
  const resolver = new AssistantPlaceResolverService(
    createResolverPrisma({ onCacheWrite: () => { cacheWrites += 1; } }),
    {
      getProviderName: () => 'locationiq',
      getCacheRetentionMs: () => 3_600_000,
      async searchWithTelemetry(request) {
        return { providerCallCount: 1, candidates: await adapter.search(request) };
      },
    },
    {
      findTrustedByQuery: async () => [],
      findTrustedById: async () => null,
      saveVerified: async () => { landmarkWrites += 1; throw new Error('UNEXPECTED_LANDMARK_WRITE'); },
    },
  );

  const result = await resolver.resolve({
    content: 'Найди квартиру внутри района Арбат',
    locale: 'ru',
    country: 'ru',
  });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(cacheWrites, 0);
  assert.equal(landmarkWrites, 0);
});

test('PIDAFIX2 LocationIQ reserves every physical fetch and blocks attempt N+1 before HTTP', async () => {
  let fetchCalls = 0;
  let reservations = 0;
  const settlements = [];
  const usageLedger = {
    async reserve(provider) {
      assert.equal(provider, 'locationiq');
      reservations += 1;
      if (reservations > 2) {
        throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED');
      }
      return { id: `attempt-${reservations}` };
    },
    async settle(reservation, input) {
      settlements.push({ reservation, input });
    },
  };
  const environment = {
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
    ASSISTANT_GEO_PROVIDER_RPS: '20',
    ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '20',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '100',
    ASSISTANT_GEO_CACHE_TTL_SECONDS: '3600',
  };
  const provider = new LocationIqGeoProvider(environment, async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify([{
      place_id: `place-${fetchCalls}`,
      display_name: 'Точка, Москва',
      lat: '55.75',
      lon: '37.62',
      address: { city: 'Москва', country_code: 'ru' },
      geojson: { type: 'Point', coordinates: [37.62, 55.75] },
    }]), { status: 200 });
  });
  const policy = new AssistantGeoProviderPolicyService(
    { $queryRaw: async () => [{ requestCount: 1 }] },
    provider,
    environment,
    () => new Date('2026-08-28T12:00:00.000Z'),
    async () => {},
    undefined,
    usageLedger,
  );
  const request = {
    purpose: 'METADATA',
    expectedKind: 'POINT',
    query: 'Точка',
    locale: 'ru',
    country: 'ru',
    viewbox: null,
  };

  await policy.searchWithTelemetry(request);
  await policy.searchWithTelemetry(request);
  await assert.rejects(policy.searchWithTelemetry(request), (error) => (
    error instanceof AssistantGeoProviderError
      && error.code === 'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED'
  ));
  assert.equal(fetchCalls, 2);
  assert.equal(reservations, 3);
  assert.deepEqual(settlements.map(({ input }) => input.outcome), ['SUCCESS', 'SUCCESS']);
});

test('PIDAFIX2 Overpass reserves and settles every physical fetch and blocks attempt N+1', async () => {
  let fetchCalls = 0;
  let reserveCalls = 0;
  const settlements = [];
  const collector = new AssistantOverpassCollector({
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:3010/api/interpreter',
    ASSISTANT_OVERPASS_RPS: '5',
  }, async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      elements: [{
        type: 'relation', id: 1, tags: { type: 'route', route: 'road', ref: 'ТТК' },
        members: [{
          type: 'way', ref: 10,
          geometry: [
            { lat: 55.7, lon: 37.5 },
            { lat: 55.8, lon: 37.6 },
            { lat: 55.7, lon: 37.5 },
          ],
        }],
      }],
    }), { status: 200 });
  }, Date.now, async () => {}, {
    async reserve(provider) {
      assert.equal(provider, 'overpass');
      reserveCalls += 1;
      if (reserveCalls > 1) {
        throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_OVERPASS_RESOLUTION_BUDGET_EXHAUSTED');
      }
      return { id: 'attempt-1' };
    },
    async settle(reservation, input) {
      settlements.push({ reservation, input });
    },
  });
  const request = {
    name: 'ТТК', tagValues: ['ТТК'], relationIds: ['1'], city: 'Москва', cityBounds: [37.3, 55.5, 37.9, 55.9],
  };

  await collector.collect(request);
  await assert.rejects(collector.collect(request), (error) => (
    error instanceof AssistantOverpassError
      && error.code === 'ASSISTANT_GEO_OVERPASS_RESOLUTION_BUDGET_EXHAUSTED'
  ));
  assert.equal(fetchCalls, 1);
  assert.equal(reserveCalls, 2);
  assert.deepEqual(settlements.map(({ input }) => input.outcome), ['SUCCESS']);
});

test('PIDAFIX2 Overpass uses exact allowlisted tags and one complete road relation', async () => {
  let fetchCalls = 0;
  let postedQuery = '';
  const collector = new AssistantOverpassCollector({
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:3010/api/interpreter',
    ASSISTANT_OVERPASS_RPS: '5',
    ASSISTANT_OVERPASS_TIMEOUT_MS: '1000',
  }, async (_url, init) => {
    fetchCalls += 1;
    postedQuery = new URLSearchParams(init.body).get('data');
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({
      elements: [{
        type: 'relation',
        id: 100,
        tags: { type: 'route', route: 'road', short_name: 'Садовое кольцо' },
        members: [
          {
            type: 'way', ref: 10,
            geometry: [{ lat: 55.74, lon: 37.58 }, { lat: 55.76, lon: 37.61 }],
          },
          {
            type: 'way', ref: 11,
            geometry: [{ lat: 55.76, lon: 37.61 }, { lat: 55.74, lon: 37.58 }],
          },
        ],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const request = {
    name: 'Садовое кольцо',
    tagValues: ['Садовое кольцо', 'ТТК'],
    relationIds: ['100'],
    city: 'Москва',
    cityBounds: [37.3, 55.5, 37.9, 55.9],
  };
  const first = await collector.collect(request);
  assert.equal(fetchCalls, 1);
  assert.equal(first.geometry.type, 'MultiLineString');
  assert.equal(first.externalId, 'relation/100');
  assert.match(postedQuery, /\[out:json\]\[timeout:\d+\]\[maxsize:\d+\]/u);
  assert.match(postedQuery, /\(55\.5,37\.3,55\.9,37\.9\)/u);
  for (const key of ['name', 'official_name', 'short_name', 'alt_name', 'ref']) {
    assert.match(postedQuery, new RegExp(`relation\\["${key}"="ТТК"\\]`, 'u'));
  }
  assert.doesNotMatch(postedQuery, /way\[/u);
  assert.match(postedQuery, /out geom;/u);
});

test('PIDAFIX2 Overpass rejects ways-only, incomplete, unrelated and exactly open rings', async (t) => {
  const request = {
    name: 'ТТК',
    tagValues: ['ТТК', 'Третье транспортное кольцо'],
    relationIds: ['100'],
    city: 'Москва',
    cityBounds: [37.3, 55.5, 37.9, 55.9],
  };
  const cases = [
    ['ways-only', {
      elements: [{
        type: 'way', id: 10, tags: { ref: 'ТТК' },
        geometry: [{ lat: 55.74, lon: 37.58 }, { lat: 55.76, lon: 37.61 }],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE'],
    ['missing member geometry', {
      elements: [{
        type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'ТТК' },
        members: [{ type: 'way', ref: 10 }],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE'],
    ['unrelated relation', {
      elements: [{
        type: 'relation', id: 100, tags: { type: 'route', route: 'bus', ref: 'ТТК' },
        members: [{
          type: 'way', ref: 10,
          geometry: [{ lat: 55.74, lon: 37.58 }, { lat: 55.74, lon: 37.58 }],
        }],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_NOT_FOUND'],
    ['sibling name', {
      elements: [{
        type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'ТТК-север' },
        members: [{
          type: 'way', ref: 10,
          geometry: [
            { lat: 55.74, lon: 37.58 },
            { lat: 55.76, lon: 37.61 },
            { lat: 55.74, lon: 37.58 },
          ],
        }],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_NOT_FOUND'],
    ['wrong allowlisted relation id', {
      elements: [{
        type: 'relation', id: 999, tags: { type: 'route', route: 'road', ref: 'ТТК' },
        members: [{
          type: 'way', ref: 10,
          geometry: [
            { lat: 55.74, lon: 37.58 },
            { lat: 55.76, lon: 37.61 },
            { lat: 55.74, lon: 37.58 },
          ],
        }],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_NOT_FOUND'],
    ['invalid point', {
      elements: [{
        type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'ТТК' },
        members: [{
          type: 'way', ref: 10,
          geometry: [{ lat: 55.74, lon: 37.58 }, { lat: 55.76, lon: 200 }],
        }],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_INVALID'],
    ['exact endpoint gap', {
      elements: [{
        type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'ТТК' },
        members: [
          {
            type: 'way', ref: 10,
            geometry: [{ lat: 55.74, lon: 37.58 }, { lat: 55.76, lon: 37.61 }],
          },
          {
            type: 'way', ref: 11,
            geometry: [{ lat: 55.76, lon: 37.61 }, { lat: 55.7400001, lon: 37.58 }],
          },
        ],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE'],
    ['disconnected closed member cycles', {
      elements: [{
        type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'ТТК' },
        members: [
          {
            type: 'way', ref: 10,
            geometry: [
              { lat: 55.74, lon: 37.58 },
              { lat: 55.75, lon: 37.59 },
              { lat: 55.74, lon: 37.58 },
            ],
          },
          {
            type: 'way', ref: 11,
            geometry: [
              { lat: 55.8, lon: 37.7 },
              { lat: 55.81, lon: 37.71 },
              { lat: 55.8, lon: 37.7 },
            ],
          },
        ],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE'],
    ['branched closed member graph', {
      elements: [{
        type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'ТТК' },
        members: [
          {
            type: 'way', ref: 10,
            geometry: [
              { lat: 55.74, lon: 37.58 },
              { lat: 55.75, lon: 37.59 },
              { lat: 55.74, lon: 37.58 },
            ],
          },
          {
            type: 'way', ref: 11,
            geometry: [
              { lat: 55.74, lon: 37.58 },
              { lat: 55.73, lon: 37.57 },
              { lat: 55.74, lon: 37.58 },
            ],
          },
        ],
      }],
    }, 'ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE'],
  ];
  for (const [name, payload, code] of cases) {
    await t.test(name, async () => {
      const collector = createOverpassCollectorForPayload(payload);
      await assert.rejects(collector.collect(request), (error) => (
        error instanceof AssistantOverpassError && error.code === code
      ));
    });
  }
});

test('PIDAFIX2 Overpass ignores duplicate top-level ways, dedupes equal relations and rejects distinct fingerprints', async () => {
  const request = {
    name: 'МКАД',
    tagValues: ['МКАД'],
    relationIds: ['100', '101', '102'],
    city: 'Москва',
    cityBounds: [37.3, 55.5, 37.9, 55.9],
  };
  const members = [
    {
      type: 'way', ref: 10,
      geometry: [{ lat: 55.7, lon: 37.4 }, { lat: 55.8, lon: 37.8 }],
    },
    {
      type: 'way', ref: 11,
      geometry: [{ lat: 55.8, lon: 37.8 }, { lat: 55.7, lon: 37.4 }],
    },
  ];
  const duplicate = createOverpassCollectorForPayload({
    elements: [
      { type: 'way', id: 10, tags: { ref: 'МКАД' }, geometry: members[0].geometry },
      { type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'МКАД' }, members },
      { type: 'relation', id: 101, tags: { type: 'route', route: 'road', name: 'мкад' }, members: [...members].reverse() },
    ],
  });
  const result = await duplicate.collect(request);
  assert.equal(result.geometry.type, 'MultiLineString');

  const ambiguous = createOverpassCollectorForPayload({
    elements: [
      { type: 'relation', id: 100, tags: { type: 'route', route: 'road', ref: 'МКАД' }, members },
      {
        type: 'relation', id: 102, tags: { type: 'road', name: 'МКАД' },
        members: [{
          type: 'way', ref: 99,
          geometry: [
            { lat: 55.6, lon: 37.3 },
            { lat: 55.65, lon: 37.35 },
            { lat: 55.6, lon: 37.3 },
          ],
        }],
      },
    ],
  });
  await assert.rejects(ambiguous.collect(request), (error) => (
    error instanceof AssistantOverpassError && error.code === 'ASSISTANT_OVERPASS_GEOMETRY_AMBIGUOUS'
  ));
});

test('FIX-GEO1 Overpass fails closed on a truncated success payload', async () => {
  const collector = new AssistantOverpassCollector({
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:3010/api/interpreter',
  }, async () => new Response(JSON.stringify({ remark: 'runtime error: Query timed out', elements: [] }), { status: 200 }));
  await assert.rejects(collector.collect({
    name: 'Садовое кольцо',
    relationIds: ['2094267'],
    city: 'Москва',
    cityBounds: [37.3, 55.5, 37.9, 55.9],
  }), (error) => error instanceof AssistantOverpassError && error.code === 'ASSISTANT_OVERPASS_RESPONSE_INVALID');
});

test('FIX-GEO1 Overpass is opt-in and serializes rate slots for distinct requests', async () => {
  const disabled = new AssistantOverpassCollector({
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:3010/api/interpreter',
  }, async () => { throw new Error('UNEXPECTED_FETCH'); });
  await assert.rejects(disabled.collect({
    name: 'Садовое кольцо',
    relationIds: ['2094267'],
    city: 'Москва',
    cityBounds: [37.3, 55.5, 37.9, 55.9],
  }), (error) => error instanceof AssistantOverpassError && error.code === 'ASSISTANT_OVERPASS_DISABLED');

  let clock = 0;
  let fetchIndex = 0;
  const requestNames = ['Дорога А', 'Дорога Б', 'Дорога В'];
  const requestTimes = [];
  const pendingDelays = [];
  const collector = new AssistantOverpassCollector({
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:3010/api/interpreter',
    ASSISTANT_OVERPASS_RPS: '2',
  }, async () => {
    const index = fetchIndex;
    fetchIndex += 1;
    requestTimes.push(clock);
    return new Response(JSON.stringify({
      elements: [{
        type: 'relation',
        id: index + 1,
        tags: { type: 'route', route: 'road', name: requestNames[index] },
        members: [{
          type: 'way',
          ref: index + 1,
          geometry: [
            { lat: 55.7 + index * 0.01, lon: 37.5 },
            { lat: 55.71 + index * 0.01, lon: 37.6 },
            { lat: 55.7 + index * 0.01, lon: 37.5 },
          ],
        }],
      }],
    }), { status: 200 });
  }, () => clock, (milliseconds) => new Promise((resolve) => {
    pendingDelays.push(() => {
      clock += milliseconds;
      resolve();
    });
  }));
  const pending = Promise.all(requestNames.map((name) => collector.collect({
    name,
    relationIds: [String(requestNames.indexOf(name) + 1)],
    city: 'Москва',
    cityBounds: [37.3, 55.5, 37.9, 55.9],
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requestTimes, [0]);
  assert.equal(pendingDelays.length, 1);
  pendingDelays[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requestTimes, [0, 500]);
  assert.equal(pendingDelays.length, 2);
  pendingDelays[1]();
  await pending;
  assert.deepEqual(requestTimes, [0, 500, 1_000]);
});

function createResolverPrisma(options = {}) {
  return {
    location: {
      findFirst: async ({ where }) => {
        const query = where.name.contains.toLocaleLowerCase('ru-RU');
        const match = (options.districtNames ?? []).find((name) => (
          name.toLocaleLowerCase('ru-RU').includes(query)
        ));
        return match ? { id: `district-${match}` } : null;
      },
    },
    $queryRaw: async (query) => {
      const pattern = query.values.find((value) => typeof value === 'string' && value.startsWith('%'));
      const needle = pattern
        ?.slice(1, -1)
        .replace(/\\([\\%_])/gu, '$1')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/gu, 'е');
      const containsMatch = needle && (options.districtNames ?? []).find((name) => (
        name.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').includes(needle)
      ));
      const usesMorphology = query.strings.join('').includes('plainto_tsquery');
      const morphologyName = usesMorphology && needle ? options.districtMorphology?.[needle] : null;
      const match = containsMatch ?? morphologyName;
      return match ? [{ id: `district-${match}` }] : [];
    },
    assistantGeoCache: {
      findFirst: async () => options.cache ?? null,
      deleteMany: async () => {
        options.onCacheDelete?.();
        return { count: options.cache ? 1 : 0 };
      },
      upsert: async (input) => {
        options.onCacheWrite?.(input);
        if (options.failCacheWrite) throw new Error('CACHE_WRITE_FAILED');
        return {};
      },
    },
    assistantSourceFact: {
      findMany: async (input) => {
        options.onKnowledgeQuery?.(input);
        return typeof options.knowledgeFacts === 'function'
          ? options.knowledgeFacts(input)
          : options.knowledgeFacts ?? [];
      },
    },
    assistantGeoOperation: {
      create: async (input) => {
        if (options.failOperationCreate) throw new Error('OPERATION_CREATE_FAILED');
        options.onOperationCreate?.(input);
        options.onOperation?.(input);
        return {};
      },
      update: async (input) => {
        options.onOperationUpdate?.(input);
        return {};
      },
    },
  };
}

function createUnusedProvider() {
  return {
    getProviderName: () => 'fake',
    getCacheRetentionMs: () => 30 * 24 * 60 * 60 * 1_000,
    searchWithTelemetry: async () => {
      throw new Error('UNEXPECTED_PROVIDER_CALL');
    },
  };
}

function createOverpassCollectorForPayload(payload) {
  return new AssistantOverpassCollector({
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:3010/api/interpreter',
  }, async () => new Response(JSON.stringify(payload), { status: 200 }));
}
