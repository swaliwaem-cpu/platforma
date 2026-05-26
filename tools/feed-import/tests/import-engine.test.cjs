const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  executeFeedImport,
  parseFeedAnalyzeCliArgs,
  parseFeedImportCliArgs,
} = require('../dist/index.js');

const fixedDate = new Date('2026-05-23T10:00:00.000Z');

function makeYandexFeed({ secondMediaUrl = 'https://cdn.test/b.png' } = {}) {
  return `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="unit-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>Москва</address><apartment>11</apartment></location>
        <price><value>10000000</value><currency>RUR</currency></price>
        <area><value>50</value></area>
        <floor>7</floor>
        <rooms>2</rooms>
        <built-year>2028</built-year>
        <ready-quarter>4</ready-quarter>
        <image tag="plan">https://cdn.test/a.png</image>
      </offer>
      <offer internal-id="unit-2">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <location><address>Москва</address><apartment>12</apartment></location>
        <price><value>12000000</value><currency>RUR</currency></price>
        <area><value>60</value></area>
        <floor>9</floor>
        <rooms>3</rooms>
        <built-year>2027</built-year>
        <ready-quarter>2</ready-quarter>
        <image>${secondMediaUrl}</image>
        <image>${secondMediaUrl}</image>
      </offer>
    </realty-feed>`;
}

function makeMultiBuildingYandexFeed() {
  return `<?xml version="1.0"?>
    <realty-feed>
      <offer internal-id="nagatino-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <Address>Москва, ЮАО, Даниловский, пр-кт Андропова</Address>
        <price><value>10000000</value><currency>RUB</currency></price>
        <area><value>25.3</value></area>
        <floor>29</floor>
        <studio>true</studio>
        <building-name>Нагатино Ай-Лэнд</building-name>
        <yandex-building-id>2133018</yandex-building-id>
        <yandex-house-id>2923598</yandex-house-id>
      </offer>
      <offer internal-id="shagal-1">
        <type>продажа</type>
        <property-type>жилая</property-type>
        <category>квартира</category>
        <Address>г. Москва, ЮАО, ул. Автозаводская, вл. 23</Address>
        <price><value>12000000</value><currency>RUB</currency></price>
        <area><value>40.1</value></area>
        <floor>7</floor>
        <rooms>2</rooms>
        <building-name>Шагал</building-name>
        <yandex-building-id>2577904</yandex-building-id>
        <yandex-house-id>3401695</yandex-house-id>
      </offer>
    </realty-feed>`;
}

test('parseFeedImportCliArgs accepts preview/run with source id', () => {
  assert.deepEqual(parseFeedImportCliArgs(['preview', '--source', 'source-1']), {
    command: 'preview',
    sourceId: 'source-1',
  });
  assert.deepEqual(parseFeedImportCliArgs(['run', '--source=source-1']), {
    command: 'run',
    sourceId: 'source-1',
  });
  assert.equal(parseFeedImportCliArgs(['preview']), null);
  assert.equal(parseFeedImportCliArgs(['bad', '--source', 'source-1']), null);
});

test('parseFeedAnalyzeCliArgs accepts pnpm argument separator', () => {
  assert.deepEqual(
    parseFeedAnalyzeCliArgs([
      'analyze',
      '--',
      '--format',
      'YANDEX_REALTY',
      '--file',
      '/tmp/feed.xml',
      '--output',
      '/tmp/analysis.json',
    ]),
    {
      command: 'analyze',
      format: 'YANDEX_REALTY',
      url: null,
      filePath: '/tmp/feed.xml',
      outputPath: '/tmp/analysis.json',
    },
  );
});

test('executeFeedImport preview counts changes without writing feed units or media', async () => {
  const { db, state } = createFakeDb({
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
      makeUnit({ id: 'stale-1', externalId: 'stale-1', status: 'AVAILABLE' }),
    ],
    mediaAssets: [
      {
        id: 'asset-a',
        sourceUrl: 'https://cdn.test/a.png',
        fileId: 'file-a',
        contentType: 'image/png',
        checksum: 'checksum-a',
      },
    ],
  });
  const unitSnapshot = JSON.stringify(state.units);

  const result = await executeFeedImport({
    mode: 'preview',
    sourceId: 'source-1',
    db,
    xmlFetcher: async () => makeYandexFeed(),
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.archived, 1);
  assert.deepEqual(result.summary.media, {
    total: 2,
    unique: 2,
    existing: 1,
    created: 1,
    downloaded: 0,
    failed: 0,
    variantsCreated: 0,
  });
  assert.equal(JSON.stringify(state.units), unitSnapshot);
  assert.equal(state.unitMedia.length, 0);
  assert.equal(state.storagePuts.length, 0);
  assert.equal(state.object.feedUpdatedAt, null);
  assert.equal(state.runs[0].mode, 'PREVIEW');
  assert.equal(state.runs[0].status, 'SUCCESS');
  assert.deepEqual(state.source.lastPreviewAt, fixedDate);
  assert.equal(state.source.lastRunAt, null);
});

test('executeFeedImport applies Yandex source filter before planning changes', async () => {
  const { db } = createFakeDb({
    source: {
      filterJson: {
        buildingNames: ['Нагатино Ай-Лэнд'],
        yandexBuildingIds: ['2133018'],
      },
    },
  });

  const result = await executeFeedImport({
    mode: 'preview',
    sourceId: 'source-1',
    db,
    xmlFetcher: async () => makeMultiBuildingYandexFeed(),
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 1);
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 0);
  assert.equal(result.summary.archived, 0);
  assert.deepEqual(result.warnings, []);
});

test('executeFeedImport routes Yandex units through active source mappings', async () => {
  const { db, state } = createFakeDb({
    source: {
      objectId: null,
      mappings: [
        makeSourceMapping({
          id: 'mapping-nagatino',
          objectId: 'object-1',
          sourceKey: 'nagatino',
          sourceTitle: 'Нагатино Ай-Лэнд',
          filterJson: {
            buildingNames: ['Нагатино Ай-Лэнд'],
            yandexBuildingIds: ['2133018'],
          },
        }),
        makeSourceMapping({
          id: 'mapping-shagal',
          objectId: 'object-2',
          sourceKey: 'shagal',
          sourceTitle: 'Шагал',
          filterJson: {
            buildingNames: ['Шагал'],
            yandexBuildingIds: ['2577904'],
          },
        }),
      ],
    },
    objects: [
      makeObjectAggregate({ id: 'object-1' }),
      makeObjectAggregate({ id: 'object-2' }),
      makeObjectAggregate({
        id: 'object-3',
        feedUnitsCount: 1,
        feedUnitsCountText: '1 лот',
        feedUpdatedAt: new Date('2026-05-22T10:00:00.000Z'),
      }),
    ],
    units: [
      makeUnit({
        id: 'stale-removed-mapping',
        objectId: 'object-3',
        externalId: 'removed-mapping-1',
        status: 'AVAILABLE',
        price: '5000000.00',
        area: '20.00',
        floor: 3,
      }),
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeMultiBuildingYandexFeed(),
    now: () => fixedDate,
  });

  const nagatinoUnit = state.units.find((unit) => unit.externalId === 'nagatino-1');
  const shagalUnit = state.units.find((unit) => unit.externalId === 'shagal-1');
  const staleUnit = state.units.find((unit) => unit.externalId === 'removed-mapping-1');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.unitsParsed, 2);
  assert.equal(nagatinoUnit.objectId, 'object-1');
  assert.equal(shagalUnit.objectId, 'object-2');
  assert.equal(staleUnit.status, 'ARCHIVED');
  assert.deepEqual(staleUnit.archivedAt, fixedDate);
  assert.equal(state.objects.get('object-1').feedUnitsCount, 1);
  assert.equal(state.objects.get('object-2').feedUnitsCount, 1);
  assert.equal(state.objects.get('object-3').feedUnitsCount, null);
  assert.deepEqual(state.refreshedObjectIds.sort(), ['object-1', 'object-2', 'object-3']);
});

test('executeFeedImport reads uploaded XML feed sources from storage', async () => {
  const { db, state } = createFakeDb({
    source: {
      sourceKind: 'FILE',
      url: null,
      xmlFileId: 'file-feed-1',
      xmlFile: {
        id: 'file-feed-1',
        key: 'uploads/2026/05/developer-feed.xml',
        url: 'https://minio.test/platforma/uploads/2026/05/developer-feed.xml',
        originalName: 'developer-feed.xml',
        mimeType: 'application/xml',
      },
    },
  });
  state.storageObjects.set('uploads/2026/05/developer-feed.xml', Buffer.from(makeYandexFeed()));

  const result = await executeFeedImport({
    mode: 'preview',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    now: () => fixedDate,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.created, 2);
  assert.equal(state.storageGets[0], 'uploads/2026/05/developer-feed.xml');
  assert.equal(state.runs[0].status, 'SUCCESS');
});

test('executeFeedImport rejects file feed sources without storage client', async () => {
  const { db } = createFakeDb({
    source: {
      sourceKind: 'FILE',
      url: null,
      xmlFileId: 'file-feed-1',
      xmlFile: {
        id: 'file-feed-1',
        key: 'uploads/2026/05/developer-feed.xml',
        originalName: 'developer-feed.xml',
        mimeType: 'application/xml',
      },
    },
  });

  await assert.rejects(
    () =>
      executeFeedImport({
        mode: 'preview',
        sourceId: 'source-1',
        db,
        now: () => fixedDate,
      }),
    /requires storage client/,
  );
});

test('executeFeedImport run upserts units, details, archives stale units and deduplicates media', async () => {
  const { db, state } = createFakeDb({
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
      makeUnit({ id: 'stale-1', externalId: 'stale-1', status: 'AVAILABLE' }),
    ],
    mediaAssets: [
      {
        id: 'asset-a',
        sourceUrl: 'https://cdn.test/a.png',
        fileId: 'file-a',
        contentType: 'image/png',
        checksum: 'checksum-a',
      },
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed(),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/png',
      originalName: 'b.png',
    }),
    imageVariantGenerator: async (body, key) => [
      {
        variant: 'THUMBNAIL',
        key: `${key}.thumbnail.webp`,
        body,
        mimeType: 'image/webp',
        width: 10,
        height: 10,
        sizeBytes: BigInt(body.length),
        checksum: 'variant-checksum',
      },
    ],
    now: () => fixedDate,
  });

  const unit1 = state.units.find((unit) => unit.externalId === 'unit-1');
  const unit2 = state.units.find((unit) => unit.externalId === 'unit-2');
  const stale = state.units.find((unit) => unit.externalId === 'stale-1');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.archived, 1);
  assert.equal(result.summary.media.existing, 1);
  assert.equal(result.summary.media.created, 1);
  assert.equal(result.summary.media.downloaded, 1);
  assert.equal(result.summary.media.variantsCreated, 1);
  assert.equal(unit1.price, '10000000.00');
  assert.equal(unit1.archivedAt, null);
  assert.equal(unit2.status, 'AVAILABLE');
  assert.equal(stale.status, 'ARCHIVED');
  assert.deepEqual(stale.archivedAt, fixedDate);
  assert.equal(state.residentialDetails.get(unit1.id).apartmentNumber, '11');
  assert.equal(state.residentialDetails.get(unit2.id).apartmentNumber, '12');
  assert.equal(state.mediaAssets.length, 2);
  assert.equal(state.files.length, 1);
  assert.equal(state.fileVariants.length, 1);
  assert.equal(state.unitMedia.length, 2);
  assert.deepEqual(state.source.lastRunAt, fixedDate);
  assert.deepEqual(state.source.lastSuccessAt, fixedDate);
});

test('executeFeedImport run writes pending progress while processing units', async () => {
  const { db, state } = createFakeDb();

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed(),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/png',
      originalName: 'image.png',
    }),
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  const progressUpdates = state.runUpdates
    .map((update) => update.summaryJson?.progress)
    .filter(Boolean);

  assert.ok(progressUpdates.length >= 3);
  assert.deepEqual(progressUpdates[0], {
    stage: 'PROCESSING_UNITS',
    unitsTotal: 2,
    unitsProcessed: 0,
    unitsRemaining: 2,
    mediaTotal: 2,
    mediaProcessed: 0,
    mediaRemaining: 2,
    updatedAt: fixedDate.toISOString(),
  });
  assert.equal(progressUpdates.some((progress) => progress.unitsProcessed === 1 && progress.unitsRemaining === 1), true);
  assert.equal(progressUpdates.some((progress) => progress.stage === 'REFRESHING_OBJECT'), true);
  assert.equal(result.summary.progress.stage, 'COMPLETED');
  assert.equal(result.summary.progress.unitsProcessed, 2);
  assert.equal(result.summary.progress.unitsRemaining, 0);
  assert.equal(result.summary.progress.mediaProcessed, 2);
  assert.equal(result.summary.progress.mediaRemaining, 0);
});

test('executeFeedImport run recalculates object feed aggregates from active units', async () => {
  const { db, state } = createFakeDb({
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
      makeUnit({ id: 'booked-1', sourceId: 'source-2', externalId: 'booked-1', status: 'BOOKED', price: '9000000.00', pricePerMeter: '150000.00', area: '30.00', floor: 2, completionYear: 2026, completionQuarter: 3 }),
      makeUnit({ id: 'reserved-1', sourceId: 'source-2', externalId: 'reserved-1', status: 'RESERVED', price: null, pricePerMeter: null, area: null, floor: null, completionYear: null, completionQuarter: null }),
      makeUnit({ id: 'sold-1', sourceId: 'source-2', externalId: 'sold-1', status: 'SOLD', price: '1000.00', pricePerMeter: '1.00', area: '1.00', floor: 1, completionYear: 2025, completionQuarter: 1 }),
      makeUnit({ id: 'other-object-1', sourceId: 'source-3', objectId: 'object-2', externalId: 'other-object-1', status: 'AVAILABLE', price: '500.00', pricePerMeter: '1.00', area: '1.00', floor: 1, completionYear: 2025, completionQuarter: 1 }),
    ],
  });

  await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed(),
    mediaDownloader: async (url) => ({
      body: Buffer.from(`body:${url}`),
      contentType: 'image/png',
      originalName: 'image.png',
    }),
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  assert.deepEqual(state.object, {
    id: 'object-1',
    feedPriceFrom: '9000000.00',
    feedPricePerMeterFrom: '150000.00',
    feedAreaRange: '30-60 м²',
    feedFloorRange: '2-9 этажей',
    feedUnitsCount: 4,
    feedUnitsCountText: '4 лота',
    feedCompletionYear: 2026,
    feedCompletionQuarter: 3,
    feedUpdatedAt: fixedDate,
  });
});

test('executeFeedImport run clears object feed aggregates when no active units remain', async () => {
  const { db, state } = createFakeDb({
    source: {
      format: 'CIAN_XML',
    },
    object: {
      feedPriceFrom: '7000000.00',
      feedPricePerMeterFrom: '200000.00',
      feedAreaRange: '35-60 м²',
      feedFloorRange: '4-12 этажей',
      feedUnitsCount: 2,
      feedUnitsCountText: '2 лота',
      feedCompletionYear: 2027,
      feedCompletionQuarter: 4,
      feedUpdatedAt: new Date('2026-05-22T10:00:00.000Z'),
    },
    units: [
      makeUnit({ id: 'existing-1', externalId: 'unit-1', status: 'AVAILABLE' }),
    ],
  });

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => `<?xml version="1.0"?>
      <feed>
        <object>
          <ExternalId>sold-1</ExternalId>
          <Booking><Status>sold</Status></Booking>
          <Address>Test object</Address>
          <Category>flatSale</Category>
          <TotalArea>45</TotalArea>
          <FloorNumber>5</FloorNumber>
          <BargainTerms><Price>7000000</Price><Currency>RUR</Currency></BargainTerms>
        </object>
      </feed>`,
    now: () => fixedDate,
  });

  assert.equal(result.summary.archived, 1);
  assert.deepEqual(state.object, {
    id: 'object-1',
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: null,
    feedUnitsCountText: null,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
  });
});

test('executeFeedImport run records media failures as warnings and partial status', async () => {
  const { db, state } = createFakeDb();

  const result = await executeFeedImport({
    mode: 'run',
    sourceId: 'source-1',
    db,
    storage: state.storage,
    xmlFetcher: async () => makeYandexFeed({ secondMediaUrl: 'https://cdn.test/fail.png' }),
    mediaDownloader: async (url) => {
      if (url.endsWith('/fail.png')) {
        throw new Error('download failed');
      }

      return {
        body: Buffer.from(`body:${url}`),
        contentType: 'image/png',
        originalName: 'a.png',
      };
    },
    imageVariantGenerator: async () => [],
    now: () => fixedDate,
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.some((warning) => warning.code === 'MEDIA_DOWNLOAD_FAILED'), true);
  assert.equal(result.summary.media.failed, 1);
  assert.equal(result.summary.media.downloaded, 1);
  assert.equal(state.runs[0].status, 'PARTIAL');
  assert.deepEqual(state.source.lastRunAt, fixedDate);
  assert.deepEqual(state.source.lastSuccessAt, fixedDate);
});

function createFakeDb({ source = {}, object = {}, objects = null, units = [], mediaAssets = [] } = {}) {
  const primaryObject = makeObjectAggregate({
    ...object,
    id: object.id ?? 'object-1',
  });
  const state = {
    source: {
      id: 'source-1',
      sourceKind: 'URL',
      url: 'https://feeds.test/yandex.xml',
      xmlFileId: null,
      xmlFile: null,
      format: 'YANDEX_REALTY',
      filterJson: null,
      developerId: 'developer-1',
      objectId: 'object-1',
      mappings: [],
      isActive: true,
      lastPreviewAt: null,
      lastRunAt: null,
      lastSuccessAt: null,
      ...source,
    },
    object: primaryObject,
    objects: new Map(
      (objects ?? [primaryObject]).map((currentObject) => [currentObject.id, makeObjectAggregate(currentObject)]),
    ),
    units: units.map((unit) => ({ ...unit })),
    mediaAssets: mediaAssets.map((asset) => ({ ...asset })),
    residentialDetails: new Map(),
    commercialDetails: new Map(),
    unitMedia: [],
    files: [],
    fileVariants: [],
    runs: [],
    runUpdates: [],
    storagePuts: [],
    storageGets: [],
    storageObjects: new Map(),
    refreshedObjectIds: [],
  };
  state.object = state.objects.get(primaryObject.id);
  state.storage = {
    getBucket: () => 'platforma',
    getPublicUrl: (key) => `https://minio.test/platforma/${key}`,
    getObject: async (key) => {
      state.storageGets.push(key);
      const object = state.storageObjects.get(key);

      if (!object) {
        throw new Error(`Storage object ${key} was not found`);
      }

      return object;
    },
    putObject: async (object) => {
      state.storagePuts.push(object);
    },
  };

  const db = {
    feedSource: {
      findUnique: async ({ where }) => (where.id === state.source.id ? { ...state.source } : null),
      update: async ({ where, data }) => {
        assert.equal(where.id, state.source.id);
        Object.assign(state.source, data);
        return { ...state.source };
      },
    },
    feedImportRun: {
      create: async ({ data }) => {
        const run = { id: `run-${state.runs.length + 1}`, ...data };
        state.runs.push(run);
        return { ...run };
      },
      update: async ({ where, data }) => {
        const run = state.runs.find((currentRun) => currentRun.id === where.id);
        state.runUpdates.push(data);
        Object.assign(run, data);
        return { ...run };
      },
    },
    feedUnit: {
      findMany: async ({ where }) =>
        state.units
          .filter((unit) => {
            if (where.sourceId) {
              return unit.sourceId === where.sourceId;
            }

            if (where.objectId) {
              const statuses = new Set(where.status.in);
              return unit.objectId === where.objectId && statuses.has(unit.status);
            }

            return true;
          })
          .map((unit) => ({ ...unit })),
      upsert: async ({ where, update, create }) => {
        const unique = where.sourceId_externalId;
        let unit = state.units.find(
          (currentUnit) => currentUnit.sourceId === unique.sourceId && currentUnit.externalId === unique.externalId,
        );

        if (unit) {
          Object.assign(unit, update);
        } else {
          unit = {
            id: `unit-${state.units.length + 1}`,
            ...create,
          };
          state.units.push(unit);
        }

        return { id: unit.id };
      },
      updateMany: async ({ where, data }) => {
        const notIn = new Set(where.externalId.notIn);
        let count = 0;

        for (const unit of state.units) {
          if (unit.sourceId === where.sourceId && !notIn.has(unit.externalId) && unit.status !== where.status.not) {
            Object.assign(unit, data);
            count += 1;
          }
        }

        return { count };
      },
    },
    feedResidentialUnitDetails: {
      upsert: async ({ where, update, create }) => {
        state.residentialDetails.set(where.unitId, { unitId: where.unitId, ...create, ...update });
        return state.residentialDetails.get(where.unitId);
      },
      deleteMany: async ({ where }) => {
        const existed = state.residentialDetails.delete(where.unitId);
        return { count: existed ? 1 : 0 };
      },
    },
    feedCommercialUnitDetails: {
      upsert: async ({ where, update, create }) => {
        state.commercialDetails.set(where.unitId, { unitId: where.unitId, ...create, ...update });
        return state.commercialDetails.get(where.unitId);
      },
      deleteMany: async ({ where }) => {
        const existed = state.commercialDetails.delete(where.unitId);
        return { count: existed ? 1 : 0 };
      },
    },
    feedMediaAsset: {
      findMany: async ({ where }) => {
        const sourceUrls = new Set(where.sourceUrl.in);
        return state.mediaAssets.filter((asset) => sourceUrls.has(asset.sourceUrl)).map((asset) => ({ ...asset }));
      },
      upsert: async ({ where, update, create }) => {
        let asset = state.mediaAssets.find((currentAsset) => currentAsset.sourceUrl === where.sourceUrl);

        if (asset) {
          Object.assign(asset, update);
        } else {
          asset = {
            id: `asset-${state.mediaAssets.length + 1}`,
            fileId: null,
            contentType: null,
            checksum: null,
            ...create,
          };
          state.mediaAssets.push(asset);
        }

        return { ...asset };
      },
      update: async ({ where, data }) => {
        const asset = state.mediaAssets.find((currentAsset) => currentAsset.id === where.id);
        Object.assign(asset, data);
        return { ...asset };
      },
    },
    feedUnitMedia: {
      deleteMany: async ({ where }) => {
        const previousCount = state.unitMedia.length;
        state.unitMedia = state.unitMedia.filter((link) => link.unitId !== where.unitId);
        return { count: previousCount - state.unitMedia.length };
      },
      createMany: async ({ data }) => {
        state.unitMedia.push(...data);
        return { count: data.length };
      },
    },
    file: {
      upsert: async ({ where, update, create }) => {
        const unique = where.storage_bucket_key;
        let file = state.files.find(
          (currentFile) =>
            currentFile.storage === unique.storage &&
            currentFile.bucket === unique.bucket &&
            currentFile.key === unique.key,
        );

        if (file) {
          Object.assign(file, update);
        } else {
          file = {
            id: `file-${state.files.length + 1}`,
            ...create,
          };
          state.files.push(file);
        }

        return { id: file.id };
      },
    },
    fileVariant: {
      upsert: async ({ where, update, create }) => {
        const unique = where.fileId_variant;
        let variant = state.fileVariants.find(
          (currentVariant) => currentVariant.fileId === unique.fileId && currentVariant.variant === unique.variant,
        );

        if (variant) {
          Object.assign(variant, update);
        } else {
          variant = {
            ...create,
          };
          state.fileVariants.push(variant);
        }

        return { ...variant };
      },
    },
    realEstateObject: {
      update: async ({ where, data }) => {
        const target = state.objects.get(where.id);
        assert.ok(target, `Object ${where.id} must exist in fake db`);
        state.refreshedObjectIds.push(where.id);
        Object.assign(target, data);
        return { ...target };
      },
    },
  };

  return { db, state };
}

function makeSourceMapping({
  id,
  objectId,
  sourceKey,
  sourceTitle,
  filterJson,
  isActive = true,
}) {
  return {
    id,
    sourceId: 'source-1',
    objectId,
    sourceKey,
    sourceTitle,
    filterJson,
    isActive,
  };
}

function makeObjectAggregate(overrides = {}) {
  return {
    id: 'object-1',
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: null,
    feedUnitsCountText: null,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
    ...overrides,
  };
}

function makeUnit({
  id,
  sourceId = 'source-1',
  objectId = 'object-1',
  externalId,
  status,
  price = null,
  pricePerMeter = null,
  area = null,
  floor = null,
  completionYear = null,
  completionQuarter = null,
}) {
  return {
    id,
    sourceId,
    objectId,
    externalId,
    type: 'RESIDENTIAL',
    status,
    title: null,
    address: null,
    building: null,
    section: null,
    floor,
    rooms: null,
    price,
    currency: null,
    area,
    pricePerMeter,
    completionYear,
    completionQuarter,
    rawPayload: null,
    archivedAt: null,
  };
}
