require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { Prisma, PrismaClient } = require('@prisma/client');

const databaseUrl = process.env.ASSISTANT_T05_TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('ASSISTANT_T05_TEST_DATABASE_URL_REQUIRED');

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.ASSISTANT_MODULE_ENABLED = 'true';
process.env.ASSISTANT_ROLLOUT_STAGE = 'ADMINS';
process.env.ASSISTANT_AI_MODE = 'fake';
process.env.ASSISTANT_EMBEDDING_MODE = 'fake';
process.env.ASSISTANT_GEO_PROVIDER_MODE = 'fake';
process.env.ASSISTANT_GEO_PROVIDER_ENABLED = 'true';
process.env.ASSISTANT_GEO_PROVIDER_RPS = '20';
process.env.ASSISTANT_GEO_PROVIDER_DAILY_BUDGET = '100';
process.env.ASSISTANT_GEO_CACHE_TTL_SECONDS = '3600';
process.env.ASSISTANT_SOURCE_WORKER_ENABLED = 'false';
process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
process.env.TRAINING_MODULE_ENABLED = 'false';
process.env.TRAINING_AI_MODE = 'fake';
process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
process.env.JWT_ACCESS_SECRET = 'assistant-t05-postgres-secret';

const { createEmptyAssistantSearchFilters } = require('../dist/assistant/assistant-query-planner.js');
const { AssistantSearchService } = require('../dist/assistant/assistant-search.service.js');
const { AssistantGeoLandmarkService } = require('../dist/assistant/geo/assistant-geo-landmark.service.js');
const {
  AssistantMetroTravelTimeService,
  AssistantMetroTravelTimeUnavailableError,
} = require('../dist/assistant/geo/assistant-metro-travel-time.service.js');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const landmarks = new AssistantGeoLandmarkService(prisma);
const search = new AssistantSearchService(prisma, landmarks);
const suffix = randomUUID().slice(0, 8);
const anchor = {
  latitude: 55.751244,
  longitude: 37.618423,
  label: 'Кремль',
  source: 'MANUAL',
};
const geo = { anchor, radiusMeters: 2_000 };
const landmarkIds = {
  line: randomUUID(),
  area: randomUUID(),
  refresh: randomUUID(),
  moscowPoint: randomUUID(),
  yekaterinburgPoint: randomUUID(),
  identityV1: randomUUID(),
  identityV2: randomUUID(),
  identityConfirmed: randomUUID(),
};
let fixture;

before(async () => {
  await prisma.$connect();
  fixture = await createFixture();
  await createGeometryLandmarks();
});

after(async () => {
  await prisma.assistantObjectMetroRouteFact.deleteMany({
    where: { object: { slug: { startsWith: `assistant-t05-${suffix}-` } } },
  });
  await prisma.assistantMetroAccessPoint.deleteMany({
    where: { datasetVersion: { startsWith: `assistant-t05-${suffix}-` } },
  });
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM assistant_geo_landmarks
    WHERE id IN (
      ${landmarkIds.line}::uuid,
      ${landmarkIds.area}::uuid,
      ${landmarkIds.refresh}::uuid,
      ${landmarkIds.moscowPoint}::uuid,
      ${landmarkIds.yekaterinburgPoint}::uuid,
      ${landmarkIds.identityV1}::uuid,
      ${landmarkIds.identityV2}::uuid,
      ${landmarkIds.identityConfirmed}::uuid
    )
  `);
  if (fixture?.source?.id) await prisma.feedSource.deleteMany({ where: { id: fixture.source.id } });
  await prisma.realEstateObject.deleteMany({
    where: { slug: { startsWith: `assistant-t05-${suffix}-` } },
  });
  if (fixture?.developer?.id) await prisma.developer.deleteMany({ where: { id: fixture.developer.id } });
  await prisma.$disconnect();
});

test('Assistant T05 radius search keeps inside and boundary FeedUnits, excludes null/outside, and orders by distance', async () => {
  const result = await search.search(createIntent({}), null, geo);

  assert.deepEqual(result.exact.map(({ unitId }) => unitId), [
    fixture.units.inside500.id,
    fixture.units.inside1000.id,
    fixture.units.boundary.id,
  ]);
  assert.deepEqual(result.exact.map(({ distanceMeters }) => Math.round(distanceMeters)), [500, 1_000, 2_000]);
  assert.equal(result.geo.kind, 'POINT');
  assert.equal(result.geo.mode, 'NEAR');
  assert.equal(result.geo.label, anchor.label);
  assert.deepEqual(result.geo.point, {
    latitude: anchor.latitude,
    longitude: anchor.longitude,
  });
  assert.equal(result.geo.distanceMeters, 2_000);
  assert.equal(result.geo.referenceGeometry.type, 'Point');
  assert.match(result.geo.searchArea.type, /^(?:Multi)?Polygon$/u);
});

test('Assistant T05 migration backfills pre-existing valid coordinates without changing canonical values', async () => {
  const scratchTable = `assistant_t05_backfill_${suffix.replaceAll('-', '')}`;
  const migration = readFileSync(resolve(
    __dirname,
    '../prisma/migrations/20260826120000_add_assistant_t05_geo_search/migration.sql',
  ), 'utf8');
  const addSearchPoint = migration.match(
    /ALTER TABLE "real_estate_objects"[\s\S]*?\) STORED;/u,
  )?.[0];
  assert.ok(addSearchPoint);

  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${scratchTable}" (
        label TEXT PRIMARY KEY,
        latitude NUMERIC(9, 6),
        longitude NUMERIC(9, 6)
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "${scratchTable}" (label, latitude, longitude) VALUES
        ('valid', 56.837700, 60.603800),
        ('partial', 56.837700, NULL),
        ('invalid', 91.000000, 60.603800)
    `);
    await prisma.$executeRawUnsafe(addSearchPoint.replace(
      'ALTER TABLE "real_estate_objects"',
      `ALTER TABLE "${scratchTable}"`,
    ));
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        label,
        latitude::text AS latitude,
        longitude::text AS longitude,
        search_point IS NOT NULL AS has_point,
        CASE WHEN search_point IS NULL THEN NULL ELSE ST_SRID(search_point::geometry) END AS srid
      FROM "${scratchTable}"
      ORDER BY label
    `);

    assert.deepEqual(rows, [
      { label: 'invalid', latitude: '91.000000', longitude: '60.603800', has_point: false, srid: null },
      { label: 'partial', latitude: '56.837700', longitude: null, has_point: false, srid: null },
      { label: 'valid', latitude: '56.837700', longitude: '60.603800', has_point: true, srid: 4326 },
    ]);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${scratchTable}"`);
  }
});

test('Assistant T05 PostGIS geography predicate includes the meter-precision boundary', async () => {
  const [boundary] = await prisma.$queryRawUnsafe(`
    WITH origin AS (
      SELECT ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography AS point
    ), projected AS (
      SELECT point, ST_Project(point, 1999.99, radians(180)) AS boundary_point FROM origin
    )
    SELECT
      ST_DWithin(point, boundary_point, 2000) AS included,
      ST_Distance(point, boundary_point) AS distance
    FROM projected
  `);
  assert.equal(boundary.included, true);
  assert.equal(Math.abs(Number(boundary.distance) - 1_999.99) < 0.001, true);
});

test('Assistant T05 radius remains a hard filter while existing lot filters are combined server-side', async () => {
  const result = await search.search(createIntent({ rooms: [2], floorMin: 7, budgetMaxRub: 19_000_000 }), null, geo);

  assert.deepEqual(result.exact.map(({ unitId }) => unitId), [fixture.units.boundary.id]);
  assert.equal(result.alternatives.every(({ distanceMeters }) => distanceMeters <= geo.radiusMeters), true);
});

test('Assistant FIX-GEO1 searches from the full road and keeps lot filters combined', async () => {
  const lineGeo = {
    kind: 'LINE',
    mode: 'NEAR',
    label: 'Тестовая длинная дорога',
    landmarkId: landmarkIds.line,
    distanceMeters: 1_500,
    source: 'LANDMARK',
  };
  const result = await search.search(createIntent({}), null, lineGeo);
  assert.deepEqual(new Set(result.exact.map(({ unitId }) => unitId)), new Set([
    fixture.units.inside500.id,
    fixture.units.inside1000.id,
    fixture.units.boundary.id,
  ]));
  assert.equal(result.geo.referenceGeometry.type, 'LineString');
  assert.match(result.geo.searchArea.type, /^(?:Multi)?Polygon$/u);
  assert.equal(result.exact.every(({ distanceMeters }) => distanceMeters <= 1_500), true);

  const bothSides = await search.search(createIntent({}), null, {
    ...lineGeo,
    distanceMeters: 2_200,
  });
  assert.equal(bothSides.exact.some(({ unitId }) => unitId === fixture.units.inside1000.id), true);
  assert.equal(bothSides.exact.some(({ unitId }) => unitId === fixture.units.outside.id), true);

  const filtered = await search.search(
    createIntent({ rooms: [2], floorMin: 7, budgetMaxRub: 19_000_000 }),
    null,
    lineGeo,
  );
  assert.deepEqual(filtered.exact.map(({ unitId }) => unitId), [fixture.units.boundary.id]);
});

test('Assistant FIX-GEO1 uses the full area boundary for NEAR and ST_Covers for INSIDE', async () => {
  const near = await search.search(createIntent({}), null, {
    kind: 'AREA',
    mode: 'NEAR',
    label: 'Тестовый район',
    landmarkId: landmarkIds.area,
    distanceMeters: 950,
    source: 'LANDMARK',
  });
  assert.deepEqual(new Set(near.exact.map(({ unitId }) => unitId)), new Set([
    fixture.units.inside500.id,
    fixture.units.inside1000.id,
    fixture.units.boundary.id,
  ]));
  assert.equal(near.exact.every(({ distanceMeters }) => typeof distanceMeters === 'number' && distanceMeters > 0), true);
  assert.equal(near.geo.referenceGeometry.type, 'Polygon');

  const inside = await search.search(createIntent({}), null, {
    kind: 'AREA',
    mode: 'INSIDE',
    label: 'Тестовый район',
    landmarkId: landmarkIds.area,
    source: 'LANDMARK',
  });
  assert.deepEqual(new Set(inside.exact.map(({ unitId }) => unitId)), new Set([
    fixture.units.inside500.id,
    fixture.units.inside1000.id,
  ]));
  assert.equal(inside.exact.every(({ distanceMeters }) => distanceMeters === null), true);
  assert.deepEqual(inside.geo.searchArea, inside.geo.referenceGeometry);
});

test('FIX-GEO2 materializes three-nearest metro routes, filters at 300 seconds, and invalidates stale facts', { concurrency: false }, async () => {
  let routeCalls = 0;
  const inside500Latitude = Number(fixture.objects.inside500.latitude);
  const routing = {
    async getWalkingRoutes({ origin, destinations }) {
      routeCalls += 1;
      const duration = Math.abs(origin[0] - inside500Latitude) < 0.00001 ? 240 : 301;
      return {
        routes: destinations.map((_, destinationIndex) => ({
          destinationIndex,
          durationSeconds: duration + destinationIndex * 10,
          distanceMeters: 300 + destinationIndex * 20,
        })),
      };
    },
  };
  const metroTravelTimes = new AssistantMetroTravelTimeService(prisma, routing);
  const travelSearch = new AssistantSearchService(prisma, landmarks, metroTravelTimes);
  const geoJson = {
    type: 'FeatureCollection',
    features: [
      ['node/1', 'Таганская', 37.62, 55.74],
      ['node/2', 'Марксистская', 37.64, 55.74],
      ['node/3', 'Павелецкая', 37.63, 55.73],
    ].map(([id, name, longitude, latitude]) => ({
      type: 'Feature',
      id,
      properties: { name, osm_id: id },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    })),
  };
  const version1 = `assistant-t05-${suffix}-v1`;
  const version2 = `assistant-t05-${suffix}-v2`;
  const intent = {
    ...createIntent({}),
    schemaVersion: 'AssistantLogicalPlanV1',
    predicates: [{
      type: 'TRAVEL_TIME', mode: 'WALK', destination: 'NEAREST_METRO',
      operator: 'LTE', value: 5, unit: 'MINUTES',
    }],
    clarificationReason: null,
  };
  const areaGeo = {
    kind: 'AREA', mode: 'INSIDE', label: 'Тестовый район',
    landmarkId: landmarkIds.area, source: 'LANDMARK',
  };
  const originalLatitude = Number(fixture.objects.inside500.latitude);

  try {
    await metroTravelTimes.importAccessPoints(geoJson, version1);
    await metroTravelTimes.importAccessPoints(geoJson, version1);
    assert.equal(await prisma.assistantMetroAccessPoint.count({
      where: { datasetVersion: version1, isActive: true },
    }), 3);
    const changedDataset = structuredClone(geoJson);
    changedDataset.features[0].geometry.coordinates[0] += 0.01;
    await assert.rejects(
      metroTravelTimes.importAccessPoints(changedDataset, version1),
      (error) => error instanceof AssistantMetroTravelTimeUnavailableError
        && error.code === 'ASSISTANT_METRO_DATASET_VERSION_CONFLICT',
    );
    await assert.rejects(
      metroTravelTimes.refreshPublishedObjects(),
      (error) => error instanceof AssistantMetroTravelTimeUnavailableError
        && error.code === 'ASSISTANT_METRO_PUBLISHED_COORDINATES_INCOMPLETE',
    );

    const initial = await travelSearch.search(intent, null, areaGeo);
    assert.deepEqual(initial.exact.map(({ unitId }) => unitId), [fixture.units.inside500.id]);
    assert.deepEqual(initial.exact[0].walkingMetro, {
      stationName: 'Таганская',
      durationSeconds: 240,
    });
    assert.equal(routeCalls, 2);

    const materializedFact = await prisma.assistantObjectMetroRouteFact.findUniqueOrThrow({
      where: { objectId: fixture.objects.inside500.id },
      select: { metroAccessPointId: true },
    });
    await prisma.$executeRawUnsafe('ANALYZE assistant_metro_access_points');
    await prisma.$executeRawUnsafe('ANALYZE assistant_object_metro_route_facts');
    const indexPlans = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return Promise.all([
        transaction.$queryRawUnsafe(`
          EXPLAIN (FORMAT JSON)
          SELECT id FROM assistant_metro_access_points
          WHERE is_active = TRUE
          ORDER BY location <-> ST_SetSRID(ST_MakePoint(37.62, 55.74), 4326)::geography
          LIMIT 3
        `),
        transaction.$queryRaw(Prisma.sql`
          EXPLAIN (FORMAT JSON)
          SELECT object_id FROM assistant_object_metro_route_facts
          WHERE metro_access_point_id = ${materializedFact.metroAccessPointId}::uuid
        `),
      ]);
    });
    assert.equal(findPlanIndex(
      indexPlans[0][0]['QUERY PLAN'][0].Plan,
      'assistant_metro_access_points_location_gist_idx',
    ), true);
    assert.equal(findPlanIndex(
      indexPlans[1][0]['QUERY PLAN'][0].Plan,
      'assistant_object_metro_route_facts_metro_access_point_id_idx',
    ), true);

    await metroTravelTimes.importAccessPoints(geoJson, version2);
    await travelSearch.search(intent, null, areaGeo);
    assert.equal(routeCalls, 4);
    const versionedFacts = await prisma.assistantObjectMetroRouteFact.findMany({
      where: { objectId: { in: [fixture.objects.inside500.id, fixture.objects.inside1000.id] } },
      select: { accessDatasetVersion: true },
    });
    assert.equal(versionedFacts.every(({ accessDatasetVersion }) => accessDatasetVersion === version2), true);

    await prisma.realEstateObject.update({
      where: { id: fixture.objects.inside500.id },
      data: { latitude: originalLatitude + 0.000001 },
    });
    await travelSearch.search(intent, null, areaGeo);
    assert.equal(routeCalls, 5);

    await prisma.assistantObjectMetroRouteFact.update({
      where: { objectId: fixture.objects.inside500.id },
      data: { routingProfile: 'obsolete-profile' },
    });
    await travelSearch.search(intent, null, areaGeo);
    assert.equal(routeCalls, 6);

    const concurrentImportSearch = new AssistantSearchService(prisma, landmarks, {
      async ensureFacts(objects, deadlineAt, budget) {
        await metroTravelTimes.ensureFacts(objects, deadlineAt, budget);
        await metroTravelTimes.importAccessPoints(geoJson, version1);
      },
    });
    await assert.rejects(
      concurrentImportSearch.search(intent, null, areaGeo),
      (error) => error.code === 'ASSISTANT_METRO_ROUTE_COVERAGE_GAP',
      'a dataset change between coverage and the result snapshot must not return partial results',
    );

    await prisma.assistantObjectMetroRouteFact.deleteMany({
      where: { object: { slug: { startsWith: `assistant-t05-${suffix}-` } } },
    });
    await assert.rejects(
      travelSearch.search(intent, null, null),
      (error) => error instanceof AssistantMetroTravelTimeUnavailableError
        && error.code === 'ASSISTANT_METRO_ROUTE_COVERAGE_GAP',
    );
    assert.equal(routeCalls, 6);
  } finally {
    await prisma.realEstateObject.update({
      where: { id: fixture.objects.inside500.id },
      data: { latitude: originalLatitude },
    });
    await prisma.assistantObjectMetroRouteFact.deleteMany({
      where: { object: { slug: { startsWith: `assistant-t05-${suffix}-` } } },
    });
    await prisma.assistantMetroAccessPoint.deleteMany({
      where: { datasetVersion: { in: [version1, version2] } },
    });
  }
});

test('FIX-GEO2 full metro refresh paginates every published object and fails closed on concurrent drift', { concurrency: false }, async () => {
  const version = `assistant-t05-${suffix}-refresh`;
  const geoJson = {
    type: 'FeatureCollection',
    features: [
      ['node/refresh-1', 'Курская', 37.66, 55.76],
      ['node/refresh-2', 'Чкаловская', 37.66, 55.755],
      ['node/refresh-3', 'Бауманская', 37.68, 55.77],
    ].map(([id, name, longitude, latitude]) => ({
      type: 'Feature',
      id,
      properties: { name, osm_id: id },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    })),
  };
  let mutateFirstObject = false;
  let firstObject;
  let routeCalls = 0;
  const metroTravelTimes = new AssistantMetroTravelTimeService(prisma, {
    async getWalkingRoutes({ destinations }) {
      routeCalls += 1;
      if (mutateFirstObject && routeCalls === 1) {
        await prisma.realEstateObject.update({
          where: { id: firstObject.id },
          data: { latitude: Number(firstObject.latitude) + 0.000001 },
        });
      }
      return {
        routes: destinations.map((_, destinationIndex) => ({
          destinationIndex,
          durationSeconds: 180 + destinationIndex * 10,
          distanceMeters: 200 + destinationIndex * 20,
        })),
      };
    },
  });

  try {
    await prisma.realEstateObject.update({
      where: { id: fixture.objects.nullCoordinates.id },
      data: { latitude: anchor.latitude, longitude: anchor.longitude },
    });
    const published = await prisma.realEstateObject.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, latitude: true },
    });
    firstObject = published[0];
    await metroTravelTimes.importAccessPoints(geoJson, version);

    const complete = await metroTravelTimes.refreshPublishedObjects();
    assert.deepEqual(complete, { publishedObjects: published.length, refreshed: published.length });
    assert.equal(routeCalls, published.length);

    routeCalls = 0;
    mutateFirstObject = true;
    await assert.rejects(
      metroTravelTimes.refreshPublishedObjects(),
      (error) => error instanceof AssistantMetroTravelTimeUnavailableError
        && error.code === 'ASSISTANT_METRO_ROUTE_COVERAGE_GAP',
    );
    assert.equal(routeCalls, published.length);
  } finally {
    if (firstObject && firstObject.id !== fixture.objects.nullCoordinates.id) {
      await prisma.realEstateObject.update({
        where: { id: firstObject.id },
        data: { latitude: firstObject.latitude },
      });
    }
    await prisma.realEstateObject.update({
      where: { id: fixture.objects.nullCoordinates.id },
      data: { latitude: null, longitude: null },
    });
    await prisma.assistantObjectMetroRouteFact.deleteMany({
      where: { object: { slug: { startsWith: `assistant-t05-${suffix}-` } } },
    });
    await prisma.assistantMetroAccessPoint.deleteMany({ where: { datasetVersion: version } });
  }
});

test('FIX-GEO2 nearest metro shortlist uses physical geography distance at Moscow latitude', { concurrency: false }, async () => {
  const version = `assistant-t05-${suffix}-metric`;
  const latitude = Number(fixture.objects.inside500.latitude);
  const longitude = Number(fixture.objects.inside500.longitude);
  let destinations;
  const metroTravelTimes = new AssistantMetroTravelTimeService(prisma, {
    async getWalkingRoutes(input) {
      destinations = input.destinations;
      return {
        routes: input.destinations.map((_, destinationIndex) => ({
          destinationIndex,
          durationSeconds: 120 + destinationIndex,
          distanceMeters: 150 + destinationIndex,
        })),
      };
    },
  });
  const definitions = [
    ['metric-a', 'A', longitude + 0.018, latitude],
    ['metric-b', 'B', longitude, latitude + 0.012],
    ['metric-c', 'C', longitude, latitude + 0.014],
    ['metric-d', 'D', longitude + 0.024, latitude],
  ];

  try {
    await metroTravelTimes.importAccessPoints({
      type: 'FeatureCollection',
      features: definitions.map(([id, name, pointLongitude, pointLatitude]) => ({
        type: 'Feature',
        id,
        properties: { name, osm_id: id },
        geometry: { type: 'Point', coordinates: [pointLongitude, pointLatitude] },
      })),
    }, version);
    await metroTravelTimes.ensureFacts([fixture.objects.inside500]);

    assert.deepEqual(destinations, [
      [Number(latitude.toFixed(6)), Number((longitude + 0.018).toFixed(6))],
      [Number((latitude + 0.012).toFixed(6)), Number(longitude.toFixed(6))],
      [Number(latitude.toFixed(6)), Number((longitude + 0.024).toFixed(6))],
    ]);
  } finally {
    await prisma.assistantObjectMetroRouteFact.deleteMany({
      where: { objectId: fixture.objects.inside500.id },
    });
    await prisma.assistantMetroAccessPoint.deleteMany({ where: { datasetVersion: version } });
  }
});

test('FIX-GEO2 stores a verified closed-ring boundary and its honest AREA separately', async () => {
  const sourceExternalId = `closed-ring-${suffix}`;
  const boundary = await landmarks.saveVerified({
    kind: 'LINE',
    label: 'Тестовое кольцо',
    normalizedQuery: `тестовое кольцо ${suffix}`,
    aliases: [`тестовое кольцо ${suffix}`],
    locale: 'ru',
    country: 'ru',
    city: 'Москва',
    geometry: {
      type: 'LineString',
      coordinates: [[37.5, 55.7], [37.7, 55.7], [37.7, 55.8], [37.5, 55.8], [37.5, 55.7]],
    },
    sourceProvider: 'fake',
    sourceExternalId,
    retentionMs: 60_000,
    sourceMetadata: { entityType: 'road', fetchedAt: new Date().toISOString(), version: 2 },
  });
  try {
    const area = await landmarks.saveVerifiedAreaFromBoundary(boundary.id, {
      label: 'Тестовое кольцо',
      normalizedQuery: `тестовое кольцо ${suffix}`,
      aliases: [`тестовое кольцо ${suffix}`],
      locale: 'ru',
      country: 'ru',
      city: 'Москва',
      sourceProvider: 'fake',
      sourceExternalId: `${sourceExternalId}#area`,
      retentionMs: 60_000,
      sourceMetadata: { entityType: 'road', fetchedAt: new Date().toISOString(), version: 2 },
    });
    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT id::text AS id, kind::text AS kind, GeometryType(geometry) AS geometry_type
      FROM assistant_geo_landmarks
      WHERE id IN (${boundary.id}::uuid, ${area.id}::uuid)
      ORDER BY kind
    `);
    assert.deepEqual(rows.map(({ kind, geometry_type }) => [kind, geometry_type]), [
      ['area', 'POLYGON'],
      ['line', 'LINESTRING'],
    ]);
  } finally {
    await prisma.assistantGeoLandmark.deleteMany({
      where: { sourceExternalId: { in: [sourceExternalId, `${sourceExternalId}#area`] } },
    });
  }
});

test('Assistant composite geo intersects every landmark constraint with SQL AND semantics', async () => {
  const result = await search.search(createIntent({}), null, {
    operator: 'ALL',
    constraints: [
      {
        kind: 'LINE',
        mode: 'NEAR',
        label: 'Тестовая длинная дорога',
        landmarkId: landmarkIds.line,
        distanceMeters: 1_500,
        source: 'LANDMARK',
      },
      {
        kind: 'AREA',
        mode: 'INSIDE',
        label: 'Тестовый район',
        landmarkId: landmarkIds.area,
        source: 'LANDMARK',
      },
    ],
  });

  assert.deepEqual(new Set(result.exact.map(({ unitId }) => unitId)), new Set([
    fixture.units.inside500.id,
    fixture.units.inside1000.id,
  ]));
  assert.equal(result.exact.every(({ distanceMeters }) => distanceMeters === null), true);
  assert.equal(result.geo.operator, 'ALL');
  assert.deepEqual(result.geo.constraints.map(({ kind, mode }) => ({ kind, mode })), [
    { kind: 'LINE', mode: 'NEAR' },
    { kind: 'AREA', mode: 'INSIDE' },
  ]);
});

test('Assistant FIX-GEO1 landmark constraints reject invalid geometry and GiST index is usable', async () => {
  await assert.rejects(prisma.$executeRaw(Prisma.sql`
    INSERT INTO assistant_geo_landmarks (
      kind, label, normalized_query, aliases, locale, country, geometry,
      source_provider, source_external_id, source_metadata, confirmation_state, expires_at
    ) VALUES (
      'area', 'Невалидная область', 'invalid', ARRAY['invalid'], 'ru', 'ru',
      ST_SetSRID(ST_GeomFromText('POLYGON((37 55, 38 56, 38 55, 37 56, 37 55))'), 4326),
      'fake', ${randomUUID()}, '{"version":1}'::jsonb, 'verified', CURRENT_TIMESTAMP + interval '1 day'
    )
  `), /assistant_geo_landmarks_geometry_valid/u);

  const planRows = await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    return transaction.$queryRawUnsafe(`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM assistant_geo_landmarks
      WHERE geometry && ST_MakeEnvelope(37.5, 55.6, 37.7, 55.9, 4326)
    `);
  });
  assert.equal(findPlanIndex(planRows[0]['QUERY PLAN'][0].Plan, 'assistant_geo_landmarks_geometry_gist'), true);
});

test('Assistant FIX-GEO1 refresh reactivates rejected provider geometry and preserves aliases', async () => {
  const sourceExternalId = `refresh-${suffix}`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO assistant_geo_landmarks (
      id, kind, label, normalized_query, aliases, locale, country, city, geometry,
      source_provider, source_external_id, source_metadata, confirmation_state, expires_at
    ) VALUES (
      ${landmarkIds.refresh}::uuid, 'line', 'Старая дорога', 'старая дорога', ARRAY['старая дорога'],
      'ru', 'ru', 'Москва',
      ST_SetSRID(ST_GeomFromText('LINESTRING(37.58 55.74, 37.66 55.76)'), 4326),
      'fake', ${sourceExternalId}, '{"version":1}'::jsonb, 'rejected', NULL
    )
  `);
  const geometry = {
    type: 'LineString',
    coordinates: [[37.58, 55.74], [37.62, 55.76], [37.66, 55.75]],
  };
  const retentionMs = 7 * 60 * 1_000;
  const refreshStartedAt = Date.now();
  for (const normalizedQuery of ['садовое кольцо тест', 'кольцо тестовый alias']) {
    const saved = await landmarks.saveVerified({
      kind: 'LINE',
      label: 'Садовое кольцо тест',
      normalizedQuery,
      aliases: [normalizedQuery],
      locale: 'ru',
      country: 'ru',
      city: 'Москва',
      geometry,
      sourceProvider: 'fake',
      sourceExternalId,
      retentionMs,
      sourceMetadata: { entityType: 'road', fetchedAt: new Date().toISOString(), version: 1 },
    });
    assert.equal(saved.id, landmarkIds.refresh);
  }
  const refreshFinishedAt = Date.now();
  const [row] = await prisma.$queryRaw(Prisma.sql`
    SELECT
      confirmation_state::text AS state,
      aliases,
      expires_at IS NOT NULL AS "hasExpiry",
      expires_at AS "expiresAt",
      confirmed_by_user_id AS "confirmedBy"
    FROM assistant_geo_landmarks
    WHERE id = ${landmarkIds.refresh}::uuid
  `);
  assert.equal(row.state, 'verified');
  assert.equal(row.hasExpiry, true);
  assert.ok(row.expiresAt instanceof Date);
  assert.ok(row.expiresAt.getTime() >= refreshStartedAt + retentionMs - 1_000);
  assert.ok(row.expiresAt.getTime() <= refreshFinishedAt + retentionMs + 1_000);
  assert.equal(row.confirmedBy, null);
  assert.deepEqual(new Set(row.aliases), new Set([
    'старая дорога',
    'садовое кольцо тест',
    'кольцо тестовый alias',
  ]));
});

test('PIDAFIX2 confirmed landmark geometry remains non-expiring', async () => {
  const confirmed = await landmarks.saveVerified({
    kind: 'LINE',
    label: 'Попытка обновить подтвержденную дорогу',
    normalizedQuery: 'попытка обновить подтвержденную дорогу',
    aliases: ['попытка обновить подтвержденную дорогу'],
    locale: 'ru',
    country: 'ru',
    city: 'Москва',
    geometry: { type: 'LineString', coordinates: [[37.618423, 55.70], [37.618423, 55.80]] },
    sourceProvider: 'fake',
    sourceExternalId: `assistant-t05-line-${suffix}`,
    retentionMs: 7 * 60 * 1_000,
    sourceMetadata: { entityType: 'road', fetchedAt: new Date().toISOString(), version: 1 },
  });
  assert.equal(confirmed.id, landmarkIds.line);
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT id::text AS id, label, confirmation_state::text AS state, expires_at AS "expiresAt"
    FROM assistant_geo_landmarks
    WHERE id IN (${landmarkIds.line}::uuid, ${landmarkIds.area}::uuid)
    ORDER BY id
  `);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(({ expiresAt }) => expiresAt), [null, null]);
  const line = rows.find(({ id }) => id === landmarkIds.line);
  assert.equal(line.state, 'confirmed');
  assert.equal(line.label, 'Тестовая длинная дорога');
});

test('PIDAFIX2 canonical DB lookup finds a bounded legacy manual alias', async () => {
  const id = randomUUID();
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO assistant_geo_landmarks (
      id, kind, label, normalized_query, aliases, locale, country, city, geometry,
      source_provider, source_external_id, source_metadata, confirmation_state, confirmed_at, expires_at
    ) VALUES (
      ${id}::uuid, 'point', 'Ручная точка ТТК', 'ттк', ARRAY['ттк'], 'ru', 'ru', 'Москва',
      ST_SetSRID(ST_MakePoint(37.62, 55.75), 4326),
      'manual_alias', ${id}, '{"version":1}'::jsonb, 'confirmed', CURRENT_TIMESTAMP, NULL
    )
  `);
  try {
    const result = await landmarks.findTrustedByQuery({
      normalizedQuery: 'третье транспортное кольцо',
      normalizedQueries: ['третье транспортное кольцо', 'ттк'],
      mode: 'NEAR',
      locale: 'ru',
      country: 'ru',
      viewbox: null,
    });
    assert.deepEqual(result.map(({ id: resultId }) => resultId), [id]);
  } finally {
    await prisma.assistantGeoLandmark.delete({ where: { id } });
  }
});

test('ZAEBAL5 strict DB lookup ignores stale verified identity but preserves confirmed landmarks', async () => {
  const normalizedQuery = `identity version ${suffix}`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO assistant_geo_landmarks (
      id, kind, label, normalized_query, aliases, locale, country, city, geometry,
      source_provider, source_external_id, source_metadata, confirmation_state, confirmed_at, expires_at
    ) VALUES
      (
        ${landmarkIds.identityV1}::uuid, 'point', 'Старая verified identity', ${normalizedQuery},
        ARRAY[${normalizedQuery}], 'ru', 'ru', 'Москва', ST_SetSRID(ST_MakePoint(37.60, 55.75), 4326),
        'locationiq', ${`identity-v1-${suffix}`}, '{"identityVersion":1}'::jsonb,
        'verified', NULL, CURRENT_TIMESTAMP + interval '1 day'
      ),
      (
        ${landmarkIds.identityV2}::uuid, 'point', 'Актуальная verified identity', ${normalizedQuery},
        ARRAY[${normalizedQuery}], 'ru', 'ru', 'Москва', ST_SetSRID(ST_MakePoint(37.61, 55.75), 4326),
        'locationiq', ${`identity-v2-${suffix}`}, '{"identityVersion":2}'::jsonb,
        'verified', NULL, CURRENT_TIMESTAMP + interval '1 day'
      ),
      (
        ${landmarkIds.identityConfirmed}::uuid, 'point', 'Ручная confirmed identity', ${normalizedQuery},
        ARRAY[${normalizedQuery}], 'ru', 'ru', 'Москва', ST_SetSRID(ST_MakePoint(37.62, 55.75), 4326),
        'manual_alias', ${`identity-confirmed-${suffix}`}, '{"identityVersion":1}'::jsonb,
        'confirmed', CURRENT_TIMESTAMP, NULL
      )
  `);

  const strict = await landmarks.findTrustedByQuery({
    normalizedQuery,
    mode: 'NEAR',
    locale: 'ru',
    country: 'ru',
    viewbox: [37.3, 55.5, 37.9, 55.9],
    minimumIdentityVersion: 2,
  });
  assert.deepEqual(new Set(strict.map(({ id }) => id)), new Set([
    landmarkIds.identityV2,
    landmarkIds.identityConfirmed,
  ]));

  const legacyCompatible = await landmarks.findTrustedByQuery({
    normalizedQuery,
    mode: 'NEAR',
    locale: 'ru',
    country: 'ru',
    viewbox: [37.3, 55.5, 37.9, 55.9],
  });
  assert.deepEqual(new Set(legacyCompatible.map(({ id }) => id)), new Set([
    landmarkIds.identityV1,
    landmarkIds.identityV2,
    landmarkIds.identityConfirmed,
  ]));
});

test('Assistant FIX-GEO1 DB-first lookup keeps same-name landmarks separated by viewbox', async () => {
  const normalizedQuery = `центральная площадь ${suffix}`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO assistant_geo_landmarks (
      id, kind, label, normalized_query, aliases, locale, country, city, geometry,
      source_provider, source_external_id, source_metadata, confirmation_state, expires_at
    ) VALUES
      (
        ${landmarkIds.moscowPoint}::uuid, 'point', 'Центральная площадь, Москва', ${normalizedQuery},
        ARRAY[${normalizedQuery}], 'ru', 'ru', 'Москва',
        ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326),
        'fake', ${`moscow-${suffix}`}, '{"version":1}'::jsonb, 'verified', CURRENT_TIMESTAMP + interval '30 days'
      ),
      (
        ${landmarkIds.yekaterinburgPoint}::uuid, 'point', 'Центральная площадь, Екатеринбург', ${normalizedQuery},
        ARRAY[${normalizedQuery}], 'ru', 'ru', 'Екатеринбург',
        ST_SetSRID(ST_MakePoint(60.603753, 56.837700), 4326),
        'fake', ${`yekaterinburg-${suffix}`}, '{"version":1}'::jsonb, 'verified', CURRENT_TIMESTAMP + interval '30 days'
      )
  `);

  const ambiguous = await landmarks.findTrustedByQuery({
    normalizedQuery,
    mode: 'NEAR',
    locale: 'ru',
    country: 'ru',
    viewbox: null,
  });
  assert.deepEqual(new Set(ambiguous.map(({ id }) => id)), new Set([
    landmarkIds.moscowPoint,
    landmarkIds.yekaterinburgPoint,
  ]));

  const moscow = await landmarks.findTrustedByQuery({
    normalizedQuery,
    mode: 'NEAR',
    locale: 'ru',
    country: 'ru',
    viewbox: [37.3, 55.5, 37.9, 55.9],
  });
  assert.deepEqual(moscow.map(({ id }) => id), [landmarkIds.moscowPoint]);

  const yekaterinburg = await landmarks.findTrustedByQuery({
    normalizedQuery,
    mode: 'NEAR',
    locale: 'ru',
    country: 'ru',
    viewbox: [60.4, 56.7, 60.8, 56.95],
  });
  assert.deepEqual(yekaterinburg.map(({ id }) => id), [landmarkIds.yekaterinburgPoint]);
});

test('Assistant T05 representative radius plan uses the generated geography GiST index', async () => {
  await prisma.$executeRawUnsafe(`
    INSERT INTO real_estate_objects (
      id, title, slug, status, type, latitude, longitude, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      'T05 plan object ' || value,
      'assistant-t05-${suffix}-plan-' || value,
      'published'::object_status,
      'residential'::real_estate_object_type,
      54 + ((value % 1000)::numeric / 1000),
      36 + ((value % 997)::numeric / 1000),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM generate_series(1, 12000) AS value
  `);
  await prisma.$executeRawUnsafe('ANALYZE real_estate_objects');
  const planRows = await prisma.$queryRawUnsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id
    FROM real_estate_objects
    WHERE search_point IS NOT NULL
      AND ST_DWithin(
        search_point,
        ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography,
        2000
      )
  `);
  const plan = planRows[0]['QUERY PLAN'][0].Plan;

  assert.equal(findPlanIndex(plan, 'real_estate_objects_search_point_gist'), true);
  assert.equal(readPlanBuffers(plan) > 0, true);
});

test('FIX-GEO2 accepts raw geo text immediately and still serializes confirmed manual geo separately', { concurrency: false }, async () => {
  const { AppModule } = require('../dist/app.module.js');
  const permission = await prisma.permission.upsert({
    where: { key: 'objects:read' },
    update: {},
    create: { key: 'objects:read', description: 'Read objects' },
  });
  const adminAccess = await prisma.permission.upsert({
    where: { key: 'admin:access' },
    update: {},
    create: { key: 'admin:access', description: 'Access admin area' },
  });
  const role = await prisma.role.create({
    data: {
      name: `assistant-t05-role-${suffix}`,
      permissions: {
        create: [permission.id, adminAccess.id].map((permissionId) => ({ permissionId })),
      },
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `assistant-t05-${suffix}@example.test`,
      name: 'Assistant T05 user',
      passwordHash: 'not-used',
      roleId: role.id,
      status: 'ACTIVE',
    },
  });
  const token = new JwtService().sign(
    { sub: user.id, email: user.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await httpJson(baseUrl, '/assistant/conversations', {
      method: 'POST',
      token,
      idempotencyKey: randomUUID(),
    });
    assert.equal(created.status, 201);
    const raw = await httpJson(
      baseUrl,
      `/assistant/conversations/${created.body.conversation.id}/messages`,
      {
        method: 'POST',
        token,
        idempotencyKey: randomUUID(),
        body: { content: 'Покажи доступные квартиры внутри Садового кольца' },
      },
    );
    assert.equal(raw.status, 202);
    const persistedRaw = await prisma.assistantRun.findUniqueOrThrow({
      where: { id: raw.body.run.id },
      select: { userMessage: { select: { content: true, geoContextJson: true } } },
    });
    assert.equal(persistedRaw.userMessage.content, 'Покажи доступные квартиры внутри Садового кольца');
    assert.equal(persistedRaw.userMessage.geoContextJson, null);
    await waitForRun(baseUrl, raw.body.run.id, token);
    const queued = await httpJson(
      baseUrl,
      `/assistant/conversations/${created.body.conversation.id}/messages`,
      {
        method: 'POST',
        token,
        idempotencyKey: randomUUID(),
        body: {
          content: 'Найди 2-комнатную квартиру до 25 млн рядом с выбранной точкой',
          context: null,
          geo,
        },
      },
    );
    assert.equal(queued.status, 202);
    const run = await waitForRun(baseUrl, queued.body.run.id, token);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.assistantMessage.answer.kind, 'SEARCH_RESULTS');
    assert.deepEqual(
      run.assistantMessage.answer.exactResults.map(({ unitId }) => unitId),
      [fixture.units.inside500.id, fixture.units.boundary.id],
    );
    assert.deepEqual(
      run.assistantMessage.answer.exactResults.map(({ distanceMeters }) => Math.round(distanceMeters)),
      [500, 2_000],
    );
    assert.equal(run.assistantMessage.answer.geo.kind, 'POINT');
    assert.equal(run.assistantMessage.answer.geo.mode, 'NEAR');
    assert.equal(run.assistantMessage.answer.geo.label, anchor.label);
    assert.deepEqual(run.assistantMessage.answer.geo.point, {
      latitude: anchor.latitude,
      longitude: anchor.longitude,
    });
    assert.equal(run.assistantMessage.answer.geo.distanceMeters, 2_000);
    assert.equal(run.assistantMessage.answer.geo.referenceGeometry.type, 'Point');
    assert.match(run.assistantMessage.answer.geo.searchArea.type, /^(?:Multi)?Polygon$/u);
    assert.deepEqual(
      run.assistantMessage.answer.geo.markers.map(({ unitId, kind }) => [unitId, kind]),
      [
        [fixture.units.inside500.id, 'PRIMARY'],
        [fixture.units.boundary.id, 'PRIMARY'],
      ],
    );

    const detail = await httpJson(
      baseUrl,
      `/assistant/conversations/${created.body.conversation.id}`,
      { token },
    );
    const rawMessage = detail.body.conversation.messages.find(
      ({ content }) => content === 'Покажи доступные квартиры внутри Садового кольца',
    );
    const manualMessage = detail.body.conversation.messages.find(
      ({ content }) => content === 'Найди 2-комнатную квартиру до 25 млн рядом с выбранной точкой',
    );
    assert.equal(rawMessage.geo, null);
    assert.deepEqual(manualMessage.geo, {
      kind: 'POINT',
      mode: 'NEAR',
      label: anchor.label,
      point: {
        latitude: anchor.latitude,
        longitude: anchor.longitude,
      },
      distanceMeters: 2_000,
      source: 'MANUAL',
    });
    assert.deepEqual(
      detail.body.conversation.messages.find(({ answer }) => answer?.geo?.kind === 'POINT').answer.geo,
      run.assistantMessage.answer.geo,
    );
    assert.equal(JSON.stringify(detail.body).includes('search_point'), false);
  } finally {
    await app.close();
    await prisma.assistantRun.deleteMany({ where: { ownerUserId: user.id } });
    await prisma.assistantMessage.deleteMany({ where: { conversation: { ownerUserId: user.id } } });
    await prisma.assistantConversation.deleteMany({ where: { ownerUserId: user.id } });
    await prisma.assistantGeoOperation.deleteMany({ where: { actorUserId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.role.delete({ where: { id: role.id } });
  }
});

test('Assistant T05 alias registry is permission-gated, separate from cache, and bypasses provider credits', { concurrency: false }, async () => {
  const { AppModule } = require('../dist/app.module.js');
  const objectsRead = await prisma.permission.upsert({
    where: { key: 'objects:read' },
    update: {},
    create: { key: 'objects:read', description: 'Read objects' },
  });
  const adminAccess = await prisma.permission.upsert({
    where: { key: 'admin:access' },
    update: {},
    create: { key: 'admin:access', description: 'Access admin area' },
  });
  const manageAliases = await prisma.permission.upsert({
    where: { key: 'assistant:sources:manage' },
    update: {},
    create: { key: 'assistant:sources:manage', description: 'Manage assistant sources' },
  });
  const readRole = await prisma.role.create({
    data: {
      name: `assistant-t05-read-${suffix}`,
      permissions: {
        create: [objectsRead.id, adminAccess.id].map((permissionId) => ({ permissionId })),
      },
    },
  });
  const adminRole = await prisma.role.create({
    data: {
      name: `assistant-t05-admin-${suffix}`,
      permissions: {
        create: [objectsRead.id, manageAliases.id].map((permissionId) => ({ permissionId })),
      },
    },
  });
  const [readUser, adminUser] = await Promise.all([
    prisma.user.create({
      data: {
        email: `assistant-t05-read-${suffix}@example.test`,
        name: 'Assistant T05 read user',
        passwordHash: 'not-used',
        roleId: readRole.id,
        status: 'ACTIVE',
      },
    }),
    prisma.user.create({
      data: {
        email: `assistant-t05-admin-${suffix}@example.test`,
        name: 'Assistant T05 admin user',
        passwordHash: 'not-used',
        roleId: adminRole.id,
        status: 'ACTIVE',
      },
    }),
  ]);
  const jwt = new JwtService();
  const readToken = jwt.sign(
    { sub: readUser.id, email: readUser.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const adminToken = jwt.sign(
    { sub: adminUser.id, email: adminUser.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
  );
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const query = `Плотинка QA ${suffix}`;

  try {
    const denied = await httpJson(baseUrl, '/assistant/geo/aliases', {
      method: 'POST',
      token: readToken,
      body: {
        query,
        locale: 'ru',
        country: 'ru',
        candidate: {
          label: 'Плотинка, Екатеринбург',
          latitude: 56.8377,
          longitude: 60.6038,
          city: 'Екатеринбург',
          countryCode: 'ru',
        },
      },
    });
    assert.equal(denied.status, 403);

    const saved = await httpJson(baseUrl, '/assistant/geo/aliases', {
      method: 'POST',
      token: adminToken,
      body: {
        query,
        locale: 'ru',
        country: 'ru',
        candidate: {
          label: 'Плотинка, Екатеринбург',
          latitude: 56.8377,
          longitude: 60.6038,
          city: 'Екатеринбург',
          countryCode: 'ru',
        },
      },
    });
    assert.equal(saved.status, 201);

    const usageBefore = await prisma.assistantGeoProviderDailyUsage.aggregate({
      _sum: { requestCount: true },
    });
    const resolved = await httpJson(baseUrl, '/assistant/geo/resolve', {
      method: 'POST',
      token: readToken,
      body: {
        content: `Найди квартиру в радиусе 2 км от ${query}`,
        locale: 'ru',
        country: 'ru',
      },
    });
    assert.equal(resolved.status, 201);
    assert.equal(resolved.body.status, 'RESOLVED');
    assert.equal(resolved.body.candidates[0].source, 'ALIAS');
    const usageAfter = await prisma.assistantGeoProviderDailyUsage.aggregate({
      _sum: { requestCount: true },
    });
    assert.equal(usageAfter._sum.requestCount, usageBefore._sum.requestCount);
    assert.equal(await prisma.assistantGeoCache.count({
      where: { normalizedQuery: { contains: suffix } },
    }), 0);

    const deleted = await httpJson(
      baseUrl,
      `/assistant/geo/aliases/${saved.body.alias.id}`,
      { method: 'DELETE', token: adminToken },
    );
    assert.equal(deleted.status, 200);
  } finally {
    await app.close();
    await prisma.assistantGeoAlias.deleteMany({ where: { createdByUserId: adminUser.id } });
    await prisma.assistantGeoOperation.deleteMany({
      where: { actorUserId: { in: [readUser.id, adminUser.id] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [readUser.id, adminUser.id] } } });
    await prisma.role.deleteMany({ where: { id: { in: [readRole.id, adminRole.id] } } });
  }
});

async function createFixture() {
  const developer = await prisma.developer.create({ data: { name: `T05 developer ${suffix}` } });
  const coordinates = await prisma.$queryRawUnsafe(`
    SELECT label,
      ST_Y(point::geometry) AS latitude,
      ST_X(point::geometry) AS longitude
    FROM (
      VALUES
        ('inside500', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 500, radians(0))),
        ('inside1000', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 1000, radians(90))),
        ('boundary', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 1999.5, radians(180))),
        ('outside', ST_Project(ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography, 2100, radians(270)))
    ) AS points(label, point)
  `);
  const objects = {};
  for (const coordinate of coordinates) {
    objects[coordinate.label] = await prisma.realEstateObject.create({
      data: {
        title: `T05 ${coordinate.label} ${suffix}`,
        slug: `assistant-t05-${suffix}-${coordinate.label}`,
        status: 'PUBLISHED',
        type: 'RESIDENTIAL',
        developerId: developer.id,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
      },
    });
  }
  objects.nullCoordinates = await prisma.realEstateObject.create({
    data: {
      title: `T05 null ${suffix}`,
      slug: `assistant-t05-${suffix}-null`,
      status: 'PUBLISHED',
      type: 'RESIDENTIAL',
      developerId: developer.id,
    },
  });

  const source = await prisma.feedSource.create({
    data: {
      url: `https://example.test/t05-${suffix}.xml`,
      format: 'CIAN_XML',
      developerId: developer.id,
      isActive: true,
    },
  });
  const unitInput = [
    ['inside500', 2, 20_000_000, 5],
    ['inside1000', 3, 10_000_000, 9],
    ['boundary', 2, 18_000_000, 10],
    ['outside', 2, 12_000_000, 12],
    ['nullCoordinates', 2, 11_000_000, 8],
  ];
  const units = {};
  for (const [key, rooms, price, floor] of unitInput) {
    units[key] = await prisma.feedUnit.create({
      data: {
        sourceId: source.id,
        objectId: objects[key].id,
        externalId: `assistant-t05-${suffix}-${key}`,
        type: 'RESIDENTIAL',
        status: 'AVAILABLE',
        title: key,
        rooms,
        effectivePrice: price,
        area: 60,
        floor,
      },
    });
  }
  return { developer, objects, source, units };
}

async function createGeometryLandmarks() {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO assistant_geo_landmarks (
      id, kind, label, normalized_query, aliases, locale, country, city, geometry,
      source_provider, source_external_id, source_metadata, confirmation_state, confirmed_at, expires_at
    ) VALUES (
      ${landmarkIds.line}::uuid,
      'line',
      'Тестовая длинная дорога',
      'тестовая длинная дорога',
      ARRAY['тестовая длинная дорога'],
      'ru',
      'ru',
      'Москва',
      ST_SetSRID(ST_MakeLine(
        ST_MakePoint(37.618423, 55.70),
        ST_MakePoint(37.618423, 55.80)
      ), 4326),
      'fake',
      ${`assistant-t05-line-${suffix}`},
      '{"entityType":"road","version":1}'::jsonb,
      'confirmed',
      CURRENT_TIMESTAMP,
      NULL
    ), (
      ${landmarkIds.area}::uuid,
      'area',
      'Тестовый район',
      'тестовый район',
      ARRAY['тестовый район'],
      'ru',
      'ru',
      'Москва',
      ST_Buffer(
        ST_SetSRID(ST_MakePoint(37.618423, 55.751244), 4326)::geography,
        1100
      )::geometry,
      'fake',
      ${`assistant-t05-area-${suffix}`},
      '{"entityType":"district","version":1}'::jsonb,
      'confirmed',
      CURRENT_TIMESTAMP,
      NULL
    )
  `);
}

function createIntent(overrides) {
  return {
    taskType: 'SEARCH',
    comparisonTargets: [],
    hardFilters: { ...createEmptyAssistantSearchFilters(), ...overrides },
    softPreferences: createEmptyAssistantSearchFilters(),
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
}

function findPlanIndex(node, indexName) {
  if (!node || typeof node !== 'object') return false;
  if (node['Index Name'] === indexName) return true;
  return Array.isArray(node.Plans) && node.Plans.some((child) => findPlanIndex(child, indexName));
}

function readPlanBuffers(node) {
  if (!node || typeof node !== 'object') return 0;
  const local = Number(node['Shared Hit Blocks'] ?? 0) + Number(node['Shared Read Blocks'] ?? 0);
  return local + (Array.isArray(node.Plans)
    ? node.Plans.reduce((sum, child) => sum + readPlanBuffers(child), 0)
    : 0);
}

async function httpJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function waitForRun(baseUrl, runId, token) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await httpJson(baseUrl, `/assistant/runs/${runId}`, { token });
    if (response.body.run.status === 'COMPLETED' || response.body.run.status === 'FAILED') {
      return response.body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('ASSISTANT_T05_RUN_TIMEOUT');
}
