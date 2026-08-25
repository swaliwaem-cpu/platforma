const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const test = require('node:test');

const {
  AssistantGeoConfigError,
  parseAssistantGeoSearchInput,
} = require('../dist/assistant/geo/assistant-geo-contract.js');
const {
  parseResolveInput,
} = require('../dist/assistant/geo/assistant-place-resolver.service.js');
const {
  AssistantAnswerService,
} = require('../dist/assistant/assistant-answer.service.js');
const {
  createEmptyAssistantSearchFilters,
} = require('../dist/assistant/assistant-query-planner.js');

test('Assistant T05 radius contract validates a manual anchor within configured hard bounds', () => {
  const input = parseAssistantGeoSearchInput({
    anchor: {
      latitude: 55.751244,
      longitude: 37.618423,
      label: 'Выбранная точка',
      source: 'MANUAL',
    },
    radiusMeters: 2_000,
  }, {
    ASSISTANT_GEO_RADIUS_MIN_METERS: '100',
    ASSISTANT_GEO_RADIUS_MAX_METERS: '20000',
  });
  assert.deepEqual(input, {
    anchor: {
      latitude: 55.751244,
      longitude: 37.618423,
      label: 'Выбранная точка',
      source: 'MANUAL',
    },
    radiusMeters: 2_000,
  });
  for (const invalid of [
    { anchor: { latitude: 91, longitude: 37, label: 'Точка', source: 'MANUAL' }, radiusMeters: 2_000 },
    { anchor: { latitude: 55, longitude: 37, label: 'Точка', source: 'MANUAL' }, radiusMeters: 0 },
    { anchor: { latitude: 55, longitude: 37, label: 'Точка', source: 'MANUAL' }, radiusMeters: 20_001 },
  ]) {
    assert.throws(
      () => parseAssistantGeoSearchInput(invalid, {
        ASSISTANT_GEO_RADIUS_MIN_METERS: '100',
        ASSISTANT_GEO_RADIUS_MAX_METERS: '20000',
      }),
      /ASSISTANT_GEO_(?:ANCHOR|RADIUS)_INVALID/u,
    );
  }

  assert.throws(
    () => parseAssistantGeoSearchInput({
      anchor: input.anchor,
      radiusMeters: 2_000,
    }, {
      ASSISTANT_GEO_RADIUS_MIN_METERS: 'not-a-number',
      ASSISTANT_GEO_RADIUS_MAX_METERS: '20000',
    }),
    (error) => error instanceof AssistantGeoConfigError
      && error.code === 'ASSISTANT_GEO_RADIUS_MIN_METERS_INVALID',
  );
});

test('Assistant T05 resolver ignores an ordinary Russian preposition without an explicit geo phrase', () => {
  assert.equal(parseResolveInput({ content: 'Что зависит от ставки?' }), null);
});

test('Assistant T05 geo search never replaces radius-filtered results with unbounded Knowledge Base lots', async () => {
  let knowledgeCalls = 0;
  const filters = createEmptyAssistantSearchFilters();
  const intent = {
    taskType: 'SEARCH',
    comparisonTargets: [],
    hardFilters: filters,
    softPreferences: filters,
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
  const geo = {
    anchor: { latitude: 55.751244, longitude: 37.618423, label: 'Точка', source: 'MANUAL' },
    radiusMeters: 2_000,
  };
  const service = new AssistantAnswerService(
    {
      async planWithValidation(_input, validate) {
        return { value: await validate(intent), intent, telemetry: [] };
      },
    },
    {
      async search() {
        return {
          exact: [],
          alternatives: [],
          geo: {
            ...geo,
            polygon: {
              type: 'Polygon',
              coordinates: [[[37.61, 55.74], [37.62, 55.74], [37.62, 55.75], [37.61, 55.74]]],
            },
          },
        };
      },
    },
    { async retrieve() { knowledgeCalls += 1; return []; } },
  );

  const result = await service.answer({ messages: ['Найди рядом'], context: null, geo });

  assert.equal(result.answer.kind, 'REFUSAL');
  assert.equal(knowledgeCalls, 0);
});

test('Assistant T05 migration derives nullable geography from canonical object coordinates only', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../prisma/migrations/20260826120000_add_assistant_t05_geo_search/migration.sql',
  ), 'utf8');
  const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
  const objectModel = schema.match(/model RealEstateObject \{[\s\S]*?\n\}/u)?.[0] ?? '';
  const feedUnitModel = schema.match(/model FeedUnit \{[\s\S]*?\n\}/u)?.[0] ?? '';

  assert.match(migration, /ADD COLUMN "search_point" geography\(Point, 4326\)[\s\S]*GENERATED ALWAYS AS/iu);
  assert.match(migration, /"latitude" IS NOT NULL[\s\S]*"longitude" IS NOT NULL/iu);
  assert.match(migration, /"latitude" BETWEEN -90 AND 90[\s\S]*"longitude" BETWEEN -180 AND 180/iu);
  assert.match(
    migration,
    /ST_SetSRID\(\s*ST_MakePoint\("longitude"::double precision, "latitude"::double precision\),\s*4326\s*\)::geography/iu,
  );
  assert.match(migration, /CREATE INDEX "real_estate_objects_search_point_gist"[\s\S]*USING GIST \("search_point"\)/iu);
  assert.match(objectModel, /searchPoint\s+Unsupported\("geography\(Point, 4326\)"\)\?\s+@map\("search_point"\)/u);
  assert.doesNotMatch(feedUnitModel, /latitude|longitude|searchPoint/u);
});

test('Assistant T05 LocationIQ adapter keeps credentials server-side and returns at most three normalized candidates', async (context) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(new URL(request.url, 'http://provider.test'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([
      {
        place_id: 'ekb-plotinka',
        display_name: 'Исторический сквер, Екатеринбург, Россия',
        lat: '56.837704',
        lon: '60.603753',
        type: 'attraction',
        address: { city: 'Екатеринбург', country_code: 'ru' },
      },
      {
        place_id: 'ekb-dam',
        display_name: 'Плотина, Екатеринбург, Россия',
        lat: '56.837913',
        lon: '60.604260',
        type: 'dam',
        address: { city: 'Екатеринбург', country_code: 'ru' },
      },
      {
        place_id: 'ekb-square',
        display_name: 'Площадь Исторического сквера, Екатеринбург',
        lat: '56.837500',
        lon: '60.603100',
        type: 'square',
        address: { city: 'Екатеринбург', country_code: 'ru' },
      },
      {
        place_id: 'fourth-must-be-dropped',
        display_name: 'Лишний результат',
        lat: '56.8',
        lon: '60.6',
        type: 'square',
        address: { city: 'Екатеринбург', country_code: 'ru' },
      },
    ]));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const {
    LocationIqGeoProvider,
  } = require('../dist/assistant/geo/assistant-geo-provider.js');
  const provider = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'server-only-locationiq-key',
    LOCATIONIQ_API_URL: `http://127.0.0.1:${address.port}/v1/search`,
    ASSISTANT_GEO_PROVIDER_TIMEOUT_MS: '1000',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '1',
  });

  const result = await provider.search({
    query: 'Плотинка, Екатеринбург',
    locale: 'ru',
    country: 'ru',
    viewbox: null,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('key'), 'server-only-locationiq-key');
  assert.equal(requests[0].searchParams.get('q'), 'Плотинка, Екатеринбург');
  assert.equal(requests[0].searchParams.get('accept-language'), 'ru');
  assert.equal(requests[0].searchParams.get('countrycodes'), 'ru');
  assert.equal(requests[0].searchParams.get('limit'), '3');
  assert.deepEqual(result.map(({ id, label, latitude, longitude, city, countryCode }) => ({
    id,
    label,
    latitude,
    longitude,
    city,
    countryCode,
  })), [
    {
      id: 'ekb-plotinka',
      label: 'Исторический сквер, Екатеринбург, Россия',
      latitude: 56.837704,
      longitude: 60.603753,
      city: 'Екатеринбург',
      countryCode: 'ru',
    },
    {
      id: 'ekb-dam',
      label: 'Плотина, Екатеринбург, Россия',
      latitude: 56.837913,
      longitude: 60.60426,
      city: 'Екатеринбург',
      countryCode: 'ru',
    },
    {
      id: 'ekb-square',
      label: 'Площадь Исторического сквера, Екатеринбург',
      latitude: 56.8375,
      longitude: 60.6031,
      city: 'Екатеринбург',
      countryCode: 'ru',
    },
  ]);
  assert.equal(JSON.stringify(result).includes('server-only-locationiq-key'), false);
  assert.equal(JSON.stringify(result).includes('type'), false);
});

test('Assistant T05 LocationIQ adapter bounds retries for 4xx, 5xx, 429 and timeout', async (context) => {
  const requests = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://provider.test');
    const scenario = url.searchParams.get('q');
    requests.set(scenario, (requests.get(scenario) ?? 0) + 1);
    if (scenario === 'bad request') {
      response.writeHead(400).end('bad request');
      return;
    }
    if (scenario === 'server retry' && requests.get(scenario) === 1) {
      response.writeHead(503).end('unavailable');
      return;
    }
    if (scenario === 'rate retry' && requests.get(scenario) === 1) {
      response.writeHead(429, { 'retry-after': '0' }).end('limited');
      return;
    }
    if (scenario === 'timeout') {
      setTimeout(() => response.writeHead(200).end('[]'), 250);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('[]');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const {
    AssistantGeoProviderError,
    LocationIqGeoProvider,
  } = require('../dist/assistant/geo/assistant-geo-provider.js');
  const provider = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-key',
    LOCATIONIQ_API_URL: `http://127.0.0.1:${address.port}/v1/search`,
    ASSISTANT_GEO_PROVIDER_TIMEOUT_MS: '100',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '1',
  }, fetch, async () => {});
  const request = (query) => ({ query, locale: 'ru', country: null, viewbox: null });

  await assert.rejects(provider.search(request('bad request')), (error) => (
    error instanceof AssistantGeoProviderError && error.httpStatus === 400 && !error.retryable
  ));
  assert.equal(requests.get('bad request'), 1);
  assert.deepEqual(await provider.search(request('server retry')), []);
  assert.equal(requests.get('server retry'), 2);
  assert.deepEqual(await provider.search(request('rate retry')), []);
  assert.equal(requests.get('rate retry'), 2);
  await assert.rejects(provider.search(request('timeout')), /ASSISTANT_GEO_PROVIDER_TIMEOUT/u);
  assert.equal(requests.get('timeout'), 2);
});

test('Assistant T05 provider policy enforces persisted budget and opens a retryable-failure circuit', async () => {
  const {
    AssistantGeoProviderPolicyService,
  } = require('../dist/assistant/geo/assistant-geo-provider-policy.service.js');
  const { AssistantGeoProviderError } = require('../dist/assistant/geo/assistant-geo-provider.js');
  let timestamp = Date.parse('2026-08-26T10:00:00.000Z');
  let providerCalls = 0;
  const provider = {
    async search() {
      providerCalls += 1;
      if (providerCalls <= 2) throw new AssistantGeoProviderError('RETRYABLE', true, 503);
      return [];
    },
  };
  const prisma = { $queryRaw: async () => [{ requestCount: providerCalls + 1 }] };
  const policy = new AssistantGeoProviderPolicyService(prisma, provider, {
    ASSISTANT_GEO_PROVIDER_MODE: 'fake',
    ASSISTANT_GEO_PROVIDER_RPS: '20',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '3',
    ASSISTANT_GEO_CACHE_TTL_SECONDS: '60',
    ASSISTANT_GEO_CIRCUIT_FAILURE_THRESHOLD: '2',
    ASSISTANT_GEO_CIRCUIT_OPEN_MS: '1000',
  }, () => new Date(timestamp), async (delay) => { timestamp += delay; });
  const request = { query: 'Плотинка', locale: 'ru', country: 'ru', viewbox: null };
  await assert.rejects(policy.search(request), /RETRYABLE/u);
  await assert.rejects(policy.search(request), /RETRYABLE/u);
  await assert.rejects(policy.search(request), /ASSISTANT_GEO_PROVIDER_CIRCUIT_OPEN/u);
  assert.equal(providerCalls, 2);
  timestamp += 1001;
  assert.deepEqual(await policy.search(request), []);
  assert.equal(providerCalls, 3);

  let exhaustedCalls = 0;
  const exhausted = new AssistantGeoProviderPolicyService(
    { $queryRaw: async () => [] },
    { async search() { exhaustedCalls += 1; return []; } },
    { ASSISTANT_GEO_PROVIDER_MODE: 'fake' },
  );
  await assert.rejects(exhausted.search(request), /ASSISTANT_GEO_PROVIDER_DAILY_BUDGET_EXHAUSTED/u);
  assert.equal(exhaustedCalls, 0);
});

test('Assistant T05 LocationIQ retries reserve RPS and daily budget per physical provider request', async () => {
  const { AssistantGeoProviderPolicyService } = require('../dist/assistant/geo/assistant-geo-provider-policy.service.js');
  const { LocationIqGeoProvider } = require('../dist/assistant/geo/assistant-geo-provider.js');
  let fetchCalls = 0;
  let reservations = 0;
  let timestamp = Date.parse('2026-08-26T10:00:00.000Z');
  const environment = {
    ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
    LOCATIONIQ_API_KEY: 'test-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '1',
    ASSISTANT_GEO_PROVIDER_RPS: '20',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '10',
    ASSISTANT_GEO_CACHE_TTL_SECONDS: '60',
  };
  const provider = new LocationIqGeoProvider(environment, async () => {
    fetchCalls += 1;
    return fetchCalls === 1
      ? new Response('unavailable', { status: 503 })
      : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {});
  const policy = new AssistantGeoProviderPolicyService(
    { $queryRaw: async () => [{ requestCount: ++reservations }] },
    provider,
    environment,
    () => new Date(timestamp),
    async (delay) => { timestamp += delay; },
  );
  assert.deepEqual(await policy.search({
    query: 'Плотинка', locale: 'ru', country: 'ru', viewbox: null,
  }), []);
  assert.equal(fetchCalls, 2);
  assert.equal(reservations, 2);
});

test('Assistant T05 resolver keeps another city explicit, prefers aliases and separates viewbox cache keys', async () => {
  const {
    AssistantPlaceResolverService,
    createCacheKey,
  } = require('../dist/assistant/geo/assistant-place-resolver.service.js');
  const providerRequests = [];
  const cacheWrites = [];
  const basePrisma = {
    assistantGeoAlias: { findUnique: async () => null },
    assistantGeoCache: {
      findFirst: async () => null,
      upsert: async (input) => { cacheWrites.push(input); },
    },
    assistantSourceFact: { findMany: async () => [] },
  };
  const provider = {
    getCacheRetentionMs: () => 60_000,
    getProviderName: () => 'fake',
    async search(request) {
      providerRequests.push(request);
      return [0, 1, 2].map((index) => ({
        id: `candidate-${index}`,
        label: `Плотинка ${index + 1}, Екатеринбург`,
        latitude: 56.837 + index * 0.001,
        longitude: 60.603 + index * 0.001,
        city: 'Екатеринбург',
        countryCode: 'ru',
      }));
    },
  };
  const resolver = new AssistantPlaceResolverService(basePrisma, provider);
  const result = await resolver.resolve({
    content: 'Найди квартиры в радиусе 2 км от Плотинки, Екатеринбург',
    locale: 'ru',
    country: 'ru',
  });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.radiusMeters, 2000);
  assert.equal(result.candidates.length, 3);
  assert.equal(providerRequests[0].query, 'Плотинки, Екатеринбург');
  assert.equal(providerRequests[0].viewbox, null);
  assert.equal(cacheWrites.length, 1);

  const noViewbox = createCacheKey({
    placeQuery: 'Плотинка', locale: 'ru', country: 'ru', viewbox: null,
  });
  const ekbViewbox = createCacheKey({
    placeQuery: 'Плотинка', locale: 'ru', country: 'ru', viewbox: [60.4, 56.7, 60.8, 56.95],
  });
  assert.notEqual(noViewbox, ekbViewbox);

  let aliasProviderCalls = 0;
  const aliasResolver = new AssistantPlaceResolverService({
    ...basePrisma,
    assistantGeoAlias: {
      findUnique: async () => ({
        id: 'alias-id', label: 'Плотинка', latitude: '56.8377000', longitude: '60.6038000',
        city: 'Екатеринбург', countryCode: 'ru',
      }),
    },
  }, {
    ...provider,
    async search() { aliasProviderCalls += 1; return []; },
  });
  const aliased = await aliasResolver.resolve({
    content: 'Покажи предложения рядом с Плотинкой радиус 1 км',
    locale: 'ru',
    country: 'ru',
  });
  assert.equal(aliased.status, 'RESOLVED');
  assert.equal(aliased.candidates[0].source, 'ALIAS');
  assert.equal(aliasProviderCalls, 0);
});

test('Assistant T05 official JSON-LD extraction stores a structured address with coordinates', () => {
  const { OfficialSourceExtractor } = require('../dist/assistant/sources/official-source.extractor.js');
  const extractor = new OfficialSourceExtractor();
  const result = extractor.extract({
    source: {
      id: 'source',
      type: 'DEVELOPMENT_PAGE',
      canonicalUrl: 'https://developer.example/project',
      projectKey: 'project',
      developerKey: 'developer',
      priority: 100,
      connectorConfig: {},
    },
    revisionId: 'revision',
    fetchedAt: new Date('2026-08-26T00:00:00.000Z'),
    contentType: 'application/ld+json',
    payload: Buffer.from(JSON.stringify({
      '@type': 'Residence',
      name: 'ЖК Тестовый',
      address: {
        streetAddress: 'ул. Тестовая, 10',
        addressLocality: 'Екатеринбург',
        addressCountry: 'RU',
      },
      geo: { latitude: '56.8377', longitude: '60.6038' },
    })),
  });
  assert.deepEqual(result.facts.find((fact) => fact.kind === 'ADDRESS')?.value, {
    label: 'ул. Тестовая, 10',
    latitude: 56.8377,
    longitude: 60.6038,
    city: 'Екатеринбург',
    countryCode: 'ru',
  });
});
