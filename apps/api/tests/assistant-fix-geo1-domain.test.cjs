const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseAssistantGeoBrowserInput,
  parseAssistantGeoStoredContext,
  parseAssistantReferenceGeometry,
} = require('../dist/assistant/geo/assistant-geo-contract.js');
const {
  AssistantPlaceResolverService,
  createCacheKey,
  parseResolveInput,
} = require('../dist/assistant/geo/assistant-place-resolver.service.js');
const {
  extractAssistantExplicitHardFilters,
} = require('../dist/assistant/assistant-query-planner.js');
const {
  AssistantGeoProviderError,
  LocationIqGeoProvider,
} = require('../dist/assistant/geo/assistant-geo-provider.js');
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
            }],
          }
        : {
            providerCallCount: 1,
            candidates: [{
              id: 'provider-city',
              label: 'Москва',
              latitude: 55.75,
              longitude: 37.62,
              city: 'Москва',
              countryCode: 'ru',
              geometryKind: 'AREA',
              geometryComplete: true,
              boundingBox: [37.3, 55.5, 37.9, 55.9],
              referenceGeometry: {
                type: 'Polygon',
                coordinates: [[[37.3, 55.5], [37.9, 55.5], [37.9, 55.9], [37.3, 55.5]]],
              },
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

  const result = await provider.search({ query: 'район Арбат', locale: 'ru', country: 'ru', viewbox: null });
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
  await assert.rejects(malformed.search({ query: 'Broken', locale: 'ru', country: null, viewbox: null }), (error) => (
    error instanceof AssistantGeoProviderError && error.code === 'ASSISTANT_GEO_PROVIDER_GEOMETRY_INVALID'
  ));

  const oversized = new LocationIqGeoProvider({
    LOCATIONIQ_API_KEY: 'test-only-key',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:3009/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
  }, async () => new Response(`[{"padding":"${'x'.repeat(300_000)}"}]`, { status: 200 }));
  await assert.rejects(oversized.search({ query: 'Huge', locale: 'ru', country: null, viewbox: null }), (error) => (
    error instanceof AssistantGeoProviderError && error.code === 'ASSISTANT_GEO_PROVIDER_RESPONSE_TOO_LARGE'
  ));
});

test('FIX-GEO1 Overpass uses one bounded single-flight request and returns the whole multiline road', async () => {
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
      elements: [
        {
          type: 'way', id: 10, tags: { name: 'Садовое кольцо' },
          geometry: [{ lat: 55.74, lon: 37.58 }, { lat: 55.76, lon: 37.61 }],
        },
        {
          type: 'way', id: 11, tags: { name: 'Садовое кольцо' },
          geometry: [{ lat: 55.76, lon: 37.61 }, { lat: 55.75, lon: 37.65 }],
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const request = {
    name: 'Садовое кольцо',
    city: 'Москва',
    cityBounds: [37.3, 55.5, 37.9, 55.9],
  };
  const [first, second] = await Promise.all([collector.collect(request), collector.collect(request)]);
  assert.equal(fetchCalls, 1);
  assert.equal(first.geometry.type, 'MultiLineString');
  assert.deepEqual(second, first);
  assert.match(postedQuery, /\[out:json\]\[timeout:\d+\]\[maxsize:\d+\]/u);
  assert.match(postedQuery, /\(55\.5,37\.3,55\.9,37\.9\)/u);
  assert.match(postedQuery, /out geom;/u);
});

test('FIX-GEO1 Overpass fails closed on a truncated success payload', async () => {
  const collector = new AssistantOverpassCollector({
    ASSISTANT_OVERPASS_ENABLED: 'true',
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:3010/api/interpreter',
  }, async () => new Response(JSON.stringify({ remark: 'runtime error: Query timed out', elements: [] }), { status: 200 }));
  await assert.rejects(collector.collect({
    name: 'Садовое кольцо',
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
        type: 'way',
        id: index + 1,
        tags: { name: requestNames[index] },
        geometry: [{ lat: 55.7 + index * 0.01, lon: 37.5 }, { lat: 55.71 + index * 0.01, lon: 37.6 }],
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
    assistantGeoCache: {
      findFirst: async () => options.cache ?? null,
      deleteMany: async () => {
        options.onCacheDelete?.();
        return { count: options.cache ? 1 : 0 };
      },
      upsert: async (input) => {
        options.onCacheWrite?.(input);
        return {};
      },
    },
    assistantGeoOperation: {
      create: async (input) => {
        options.onOperation?.(input);
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
