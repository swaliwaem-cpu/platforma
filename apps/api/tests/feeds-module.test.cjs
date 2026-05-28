require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { BadRequestException, ConflictException, NotFoundException } = require('@nestjs/common');

const { FeedsController } = require('../dist/feeds/feeds.controller.js');
const { FeedsService } = require('../dist/feeds/feeds.service.js');

const feedsServiceSourcePath = resolve(__dirname, '../src/feeds/feeds.service.ts');
const apiDockerfilePath = resolve(__dirname, '../Dockerfile');

const now = new Date('2026-05-23T10:00:00.000Z');
const sourceId = '11111111-1111-4111-8111-111111111111';
const developerId = '22222222-2222-4222-8222-222222222222';
const objectId = '33333333-3333-4333-8333-333333333333';
const secondObjectId = '33333333-3333-4333-8333-444444444444';
const runId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const xmlFileId = '88888888-8888-4888-8888-888888888888';
const actor = {
  id: '99999999-9999-4999-8999-999999999999',
  role: 'admin',
  permissions: ['feeds:manage'],
};

function decimal(value) {
  return {
    toString: () => value,
    toNumber: () => Number(value),
  };
}

function developerRecord(overrides = {}) {
  return {
    id: developerId,
    wpTermId: null,
    name: 'ФСК',
    normalizedName: 'фск',
    slug: 'fsk',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function objectRecord(overrides = {}) {
  return {
    id: objectId,
    title: 'ЖК Фидовый',
    slug: 'zhk-feed',
    status: 'PUBLISHED',
    deletedAt: null,
    ...overrides,
  };
}

function sourceRecord(overrides = {}) {
  return {
    id: sourceId,
    sourceKind: 'URL',
    url: 'https://feeds.example.test/yandex.xml',
    xmlFileId: null,
    format: 'YANDEX_REALTY',
    filterJson: null,
    developerId,
    objectId,
    isActive: true,
    lastPreviewAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    developer: developerRecord(),
    object: objectRecord(),
    mappings: [],
    xmlFile: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function sourceMappingRecord(overrides = {}) {
  return {
    id: '99999999-9999-4999-8999-111111111111',
    sourceId,
    objectId,
    sourceKey: 'shagal',
    sourceTitle: 'Шагал',
    filterJson: {
      buildingNames: ['Шагал'],
      yandexBuildingIds: ['2577904'],
    },
    isActive: true,
    object: objectRecord(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runRecord(overrides = {}) {
  return {
    id: runId,
    sourceId,
    mode: 'PREVIEW',
    status: 'SUCCESS',
    startedAt: now,
    finishedAt: now,
    summaryJson: { unitsParsed: 2 },
    warningsJson: [],
    errorsJson: [],
    createdAt: now,
    ...overrides,
  };
}

function fileRecord(overrides = {}) {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    wpAttachmentId: null,
    storage: 'MINIO',
    bucket: 'platforma',
    key: 'feeds/2026/05/image.jpg',
    url: 'https://cdn.example.test/image.jpg',
    originalName: 'image.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1000n,
    checksum: 'checksum',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function unitRecord(overrides = {}) {
  return {
    id: unitId,
    sourceId,
    objectId,
    externalId: 'flat-1',
    type: 'RESIDENTIAL',
    status: 'AVAILABLE',
    title: 'Квартира 1',
    address: 'Москва',
    building: 'Корпус 1',
    section: '1',
    floor: 7,
    rooms: 2,
    price: decimal('10000000.00'),
    currency: 'RUR',
    area: decimal('50.00'),
    pricePerMeter: decimal('200000.00'),
    completionYear: 2028,
    completionQuarter: 4,
    rawPayload: { externalId: 'flat-1' },
    archivedAt: null,
    residentialDetails: {
      unitId,
      apartmentNumber: '11',
      layoutType: '2k',
      livingArea: decimal('30.00'),
      kitchenArea: decimal('10.00'),
      balconyCount: 1,
      detailsJson: { renovation: 'whitebox' },
    },
    commercialDetails: null,
    media: [
      {
        unitId,
        mediaAssetId: '77777777-7777-4777-8777-777777777777',
        sortOrder: 0,
        label: 'plan',
        createdAt: now,
        mediaAsset: {
          id: '77777777-7777-4777-8777-777777777777',
          sourceUrl: 'https://cdn.example.test/image.jpg',
          fileId: '66666666-6666-4666-8666-666666666666',
          contentType: 'image/jpeg',
          checksum: 'checksum',
          file: fileRecord(),
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('FeedsController delegates CRUD, run endpoints and reports to the service', async () => {
  const calls = [];
  const controller = new FeedsController({
    listSources: async (query) => {
      calls.push(['listSources', query]);
      return { items: [], total: 0, page: 1, limit: 20, totalPages: 1 };
    },
    createSource: async (body) => {
      calls.push(['createSource', body]);
      return { source: body };
    },
    updateSource: async (id, body) => {
      calls.push(['updateSource', id, body]);
      return { source: { id, ...body } };
    },
    analyzeSource: async (body) => {
      calls.push(['analyzeSource', body]);
      return { analysis: { developerName: 'АО «ГК «ЭТАЛОН»', unitsCount: 3, objects: [] } };
    },
    runFeedImportCommand: async (id, mode) => {
      calls.push(['runFeedImportCommand', id, mode]);
      return { run: { id: runId, sourceId: id, mode: mode === 'preview' ? 'PREVIEW' : 'RUN' } };
    },
    listSourceRuns: async (id, query) => {
      calls.push(['listSourceRuns', id, query]);
      return { items: [], total: 0, page: 1, limit: 20, totalPages: 1 };
    },
    getRun: async (id) => {
      calls.push(['getRun', id]);
      return { run: { id } };
    },
    listUnits: async (query) => {
      calls.push(['listUnits', query]);
      return { items: [], total: 0, page: 1, limit: 20, totalPages: 1 };
    },
  });

  await controller.listSources({ page: '1' });
  await controller.createSource({ url: 'https://feeds.example.test/yandex.xml' });
  await controller.updateSource(sourceId, { isActive: false });
  await controller.analyzeFeed({ sourceKind: 'URL', url: 'https://feeds.example.test/yandex.xml', format: 'YANDEX_REALTY' });
  await controller.runPreview(sourceId);
  await controller.runImport(sourceId);
  await controller.listSourceRuns(sourceId, { status: 'success' });
  await controller.getRun(runId);
  await controller.listUnits({ sourceId });

  assert.deepEqual(calls, [
    ['listSources', { page: '1' }],
    ['createSource', { url: 'https://feeds.example.test/yandex.xml' }],
    ['updateSource', sourceId, { isActive: false }],
    ['analyzeSource', { sourceKind: 'URL', url: 'https://feeds.example.test/yandex.xml', format: 'YANDEX_REALTY' }],
    ['runFeedImportCommand', sourceId, 'preview'],
    ['runFeedImportCommand', sourceId, 'run'],
    ['listSourceRuns', sourceId, { status: 'success' }],
    ['getRun', runId],
    ['listUnits', { sourceId }],
  ]);
});

test('FeedsService passes source id to feed-import CLI without an extra argv separator', () => {
  const source = readFileSync(feedsServiceSourcePath, 'utf8');

  assert.match(source, /\['--filter', '@platforma\/feed-import', '--fail-if-no-match', 'run', mode, '--source', sourceId\]/);
  assert.doesNotMatch(source, /mode,\s*'--',\s*'--source'/);
});

test('FeedsService validates feed source kind literals without relying on generated Prisma enum values', () => {
  const source = readFileSync(feedsServiceSourcePath, 'utf8');

  assert.match(source, /const supportedFeedSourceKinds = \['URL', 'FILE', 'INDEX_URL'\] as const;/);
  assert.match(source, /supportedFeedSourceKinds\.includes\(sourceKind as SupportedFeedSourceKind\)/);
  assert.doesNotMatch(source, /Object\.values\(FeedSourceKind\)\.includes\(sourceKind as FeedSourceKind\)/);
});

test('FeedsService analyzes a feed source without developer and object mapping', async () => {
  const calls = [];
  const service = new FeedsService({});
  service.runFeedAnalyzeCli = async (params) => {
    calls.push(params);

    return {
      discovery: null,
      analysis: {
        developerName: 'АО «ГК «ЭТАЛОН»',
        unitsCount: 493,
        objects: [
          {
            title: 'Шагал',
            unitsCount: 259,
            buildingNames: ['Шагал'],
            yandexBuildingIds: ['2577904'],
            yandexHouseIds: ['2895484'],
            addresses: [],
            filterJson: {
              buildingNames: ['Шагал'],
              yandexBuildingIds: ['2577904'],
              yandexHouseIds: ['2895484'],
            },
          },
        ],
        warningsCount: 0,
        warnings: [],
      },
    };
  };

  const result = await service.analyzeSource({
    sourceKind: 'URL',
    url: 'https://feeds.example.test/yandex.xml',
    format: 'YANDEX_REALTY',
  });

  assert.deepEqual(calls, [
    {
      format: 'YANDEX_REALTY',
      sourceKind: 'URL',
      url: 'https://feeds.example.test/yandex.xml',
      xmlFile: null,
    },
  ]);
  assert.equal(result.analysis.developerName, 'АО «ГК «ЭТАЛОН»');
  assert.equal(result.analysis.objects[0].title, 'Шагал');
  assert.equal(result.analysis.objects[0].unitsCount, 259);
});

test('FeedsService analyzes index URL discovery and selected platform', async () => {
  const calls = [];
  const indexUrl = 'https://feeds.sminex.test/xml/';
  const service = new FeedsService({});
  service.runFeedAnalyzeCli = async (params) => {
    calls.push(params);

    if (params.format === 'AUTO') {
      return {
        discovery: {
          sourceUrl: params.url,
          files: [],
          platforms: [
            {
              format: 'CIAN_XML',
              label: 'Cian XML',
              filesCount: 2,
              unitsCount: 22,
              warningsCount: 0,
              errorsCount: 0,
              files: [],
            },
          ],
        },
        analysis: null,
      };
    }

    return {
      discovery: null,
      analysis: {
        format: 'CIAN_XML',
        developerName: 'Смайнекс',
        unitsCount: 22,
        objects: [{ title: 'Муза', unitsCount: 22, filterJson: { projectNames: ['Муза'] } }],
        warningsCount: 0,
        warnings: [],
      },
    };
  };

  const discovery = await service.analyzeSource({
    sourceKind: 'INDEX_URL',
    url: indexUrl,
    format: 'AUTO',
  });
  const selected = await service.analyzeSource({
    sourceKind: 'INDEX_URL',
    url: indexUrl,
    format: 'CIAN_XML',
  });

  assert.deepEqual(calls, [
    {
      format: 'AUTO',
      sourceKind: 'INDEX_URL',
      url: indexUrl,
      xmlFile: null,
    },
    {
      format: 'CIAN_XML',
      sourceKind: 'INDEX_URL',
      url: indexUrl,
      xmlFile: null,
    },
  ]);
  assert.equal(discovery.discovery.platforms[0].format, 'CIAN_XML');
  assert.equal(discovery.analysis, null);
  assert.equal(selected.discovery, null);
  assert.equal(selected.analysis.objects[0].title, 'Муза');
});

test('API Docker image includes the feed-import workspace used by feed preview and run', () => {
  const dockerfile = readFileSync(apiDockerfilePath, 'utf8');

  assert.match(dockerfile, /COPY tools\/feed-import\/package\.json tools\/feed-import\/package\.json/);
  assert.match(dockerfile, /COPY --from=deps \/app\/tools\/feed-import\/node_modules \.\/tools\/feed-import\/node_modules/);
  assert.match(dockerfile, /COPY tools\/feed-import \.\/tools\/feed-import/);
});

test('FeedsService lists sources with filters and serializes related developer and object', async () => {
  const calls = [];
  const prisma = {
    $transaction: async (queries) => Promise.all(queries),
    feedSource: {
      findMany: async (args) => {
        calls.push(['feedSource.findMany', args]);
        return [sourceRecord()];
      },
      count: async (args) => {
        calls.push(['feedSource.count', args]);
        return 1;
      },
    },
  };
  const service = new FeedsService(prisma);

  const result = await service.listSources({
    page: '2',
    limit: '10',
    format: 'yandex_realty',
    developerId,
    objectId,
    isActive: 'true',
  });

  assert.deepEqual(calls[0][1].where, {
    format: 'YANDEX_REALTY',
    developerId,
    OR: [
      { objectId },
      {
        mappings: {
          some: {
            objectId,
          },
        },
      },
    ],
    isActive: true,
  });
  assert.equal(calls[0][1].skip, 10);
  assert.equal(calls[0][1].take, 10);
  assert.equal(result.items[0].developer.name, 'ФСК');
  assert.equal(result.items[0].object.slug, 'zhk-feed');
  assert.equal(result.items[0].createdAt, now.toISOString());
});

test('FeedsService creates and updates feed sources with validation', async () => {
  const calls = [];
  const prisma = {
    developer: {
      count: async (args) => {
        calls.push(['developer.count', args]);
        return args.where.id === developerId ? 1 : 0;
      },
    },
    realEstateObject: {
      count: async (args) => {
        calls.push(['realEstateObject.count', args]);
        return args.where.id === objectId && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedSource: {
      create: async (args) => {
        calls.push(['feedSource.create', args]);
        return sourceRecord({
          url: args.data.url,
          format: args.data.format,
          filterJson: args.data.filterJson,
          isActive: args.data.isActive,
        });
      },
      findUnique: async (args) => {
        calls.push(['feedSource.findUnique', args]);
        return sourceRecord();
      },
      update: async (args) => {
        calls.push(['feedSource.update', args]);
        return sourceRecord({
          url: args.data.url,
          filterJson: args.data.filterJson,
          isActive: args.data.isActive,
        });
      },
    },
  };
  const service = new FeedsService(prisma);

  const created = await service.createSource({
    url: ' https://feeds.example.test/yandex.xml ',
    format: 'yandex_realty',
    filterJson: JSON.stringify({
      buildingNames: ['Нагатино Ай-Лэнд'],
      yandexBuildingIds: ['2133018'],
    }),
    developerId,
    objectId,
    isActive: false,
  });
  const updated = await service.updateSource(sourceId, {
    url: 'https://feeds.example.test/cian.xml',
    filterJson: {
      buildingNames: ['Шагал'],
    },
    isActive: false,
  });

  assert.equal(created.source.url, 'https://feeds.example.test/yandex.xml');
  assert.equal(created.source.sourceKind, 'URL');
  assert.equal(created.source.xmlFile, null);
  assert.equal(created.source.format, 'YANDEX_REALTY');
  assert.deepEqual(created.source.filterJson, {
    buildingNames: ['Нагатино Ай-Лэнд'],
    yandexBuildingIds: ['2133018'],
  });
  assert.equal(created.source.isActive, false);
  assert.equal(updated.source.url, 'https://feeds.example.test/cian.xml');
  assert.deepEqual(updated.source.filterJson, {
    buildingNames: ['Шагал'],
  });
  assert.equal(updated.source.isActive, false);
  assert.equal(calls.some(([name]) => name === 'feedSource.create'), true);
  assert.equal(calls.some(([name]) => name === 'feedSource.update'), true);

  await assert.rejects(
    () =>
      service.createSource({
        url: 'ftp://feeds.example.test/file.xml',
        format: 'YANDEX_REALTY',
        developerId,
        objectId,
      }),
    BadRequestException,
  );
});

test('FeedsService creates feed sources with multi-object mappings and no fallback object', async () => {
  const calls = [];
  const prisma = {
    developer: {
      count: async (args) => {
        calls.push(['developer.count', args]);
        return args.where.id === developerId ? 1 : 0;
      },
    },
    realEstateObject: {
      count: async (args) => {
        calls.push(['realEstateObject.count', args]);
        return [objectId, secondObjectId].includes(args.where.id) && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedSource: {
      create: async (args) => {
        calls.push(['feedSource.create', args]);
        return sourceRecord({
          objectId: null,
          object: null,
          mappings: args.data.mappings.create.map((mapping, index) =>
            sourceMappingRecord({
              ...mapping,
              id: `mapping-${index + 1}`,
              sourceId,
              objectId: mapping.object.connect.id,
              object: objectRecord({
                id: mapping.object.connect.id,
                title: index === 0 ? 'Нагатино Ай-Лэнд' : 'Шагал',
                slug: index === 0 ? 'nagatino' : 'shagal',
              }),
            }),
          ),
        });
      },
    },
  };
  const service = new FeedsService(prisma);

  const created = await service.createSource({
    url: 'https://feeds.example.test/yandex.xml',
    format: 'YANDEX_REALTY',
    developerId,
    objectId,
    mappings: JSON.stringify([
      {
        sourceKey: 'nagatino',
        sourceTitle: 'Нагатино Ай-Лэнд',
        objectId,
        filterJson: {
          buildingNames: ['Нагатино Ай-Лэнд'],
          yandexBuildingIds: ['2133018'],
        },
      },
      {
        sourceKey: 'shagal',
        sourceTitle: 'Шагал',
        objectId: secondObjectId,
        filterJson: {
          buildingNames: ['Шагал'],
          yandexBuildingIds: ['2577904'],
        },
      },
    ]),
  });

  const createCall = calls.find(([name]) => name === 'feedSource.create')[1];

  assert.equal('object' in createCall.data, false);
  assert.equal(createCall.data.mappings.create.length, 2);
  assert.deepEqual(createCall.data.mappings.create[0].object, { connect: { id: objectId } });
  assert.deepEqual(createCall.data.mappings.create[1].object, { connect: { id: secondObjectId } });
  assert.equal(created.source.objectId, null);
  assert.equal(created.source.object, null);
  assert.equal(created.source.mappings.length, 2);
  assert.equal(created.source.mappings[0].object.title, 'Нагатино Ай-Лэнд');
  assert.equal(created.source.mappings[1].objectId, secondObjectId);
});

test('FeedsService creates index URL feed sources with concrete format', async () => {
  const calls = [];
  const prisma = {
    developer: {
      count: async () => 1,
    },
    realEstateObject: {
      count: async () => 1,
    },
    feedSource: {
      create: async (args) => {
        calls.push(['feedSource.create', args]);
        return sourceRecord({
          sourceKind: args.data.sourceKind,
          url: args.data.url,
          xmlFileId: null,
          xmlFile: null,
          format: args.data.format,
        });
      },
    },
  };
  const service = new FeedsService(prisma);

  const created = await service.createSource({
    sourceKind: 'index_url',
    url: 'https://feeds.sminex.test/xml/',
    format: 'CIAN_XML',
    developerId,
    objectId,
  });
  const createCall = calls.find(([name]) => name === 'feedSource.create')[1];

  assert.equal(createCall.data.sourceKind, 'INDEX_URL');
  assert.equal(createCall.data.url, 'https://feeds.sminex.test/xml/');
  assert.equal('xmlFile' in createCall.data, false);
  assert.equal(createCall.data.format, 'CIAN_XML');
  assert.equal(created.source.sourceKind, 'INDEX_URL');
  assert.equal(created.source.url, 'https://feeds.sminex.test/xml/');
});

test('FeedsService rejects persisted auto feed format', async () => {
  const service = new FeedsService({});

  await assert.rejects(
    () =>
      service.createSource({
        sourceKind: 'INDEX_URL',
        url: 'https://feeds.sminex.test/xml/',
        format: 'AUTO',
        developerId,
        objectId,
      }),
    BadRequestException,
  );
});

test('FeedsService creates file feed sources with uploaded XML file', async () => {
  const uploadedFile = {
    buffer: Buffer.from('<?xml version="1.0"?><realty-feed />'),
    originalname: 'developer-feed.xml',
    mimetype: 'application/xml',
    size: 38,
  };
  const xmlFile = fileRecord({
    id: xmlFileId,
    key: 'uploads/2026/05/developer-feed.xml',
    url: 'https://minio.example.test/platforma/uploads/2026/05/developer-feed.xml',
    originalName: 'developer-feed.xml',
    mimeType: 'application/xml',
    sizeBytes: 38n,
  });
  const calls = [];
  const filesService = {
    uploadFile: async (file, currentActor, kind) => {
      calls.push(['files.uploadFile', file, currentActor, kind]);
      return { file: xmlFile };
    },
    serializeFile: (file) => ({
      ...file,
      sizeBytes: file.sizeBytes.toString(),
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    }),
  };
  const prisma = {
    developer: {
      count: async () => 1,
    },
    realEstateObject: {
      count: async () => 1,
    },
    feedSource: {
      create: async (args) => {
        calls.push(['feedSource.create', args]);
        return sourceRecord({
          sourceKind: args.data.sourceKind,
          url: args.data.url,
          xmlFileId,
          xmlFile,
          format: args.data.format,
          isActive: args.data.isActive,
        });
      },
    },
  };
  const service = new FeedsService(prisma, filesService);

  const created = await service.createSource(
    {
      sourceKind: 'file',
      format: 'YANDEX_REALTY',
      developerId,
      objectId,
      isActive: true,
    },
    uploadedFile,
    actor,
  );

  assert.deepEqual(calls[0], ['files.uploadFile', uploadedFile, actor, 'feed-xml']);
  assert.equal(calls[1][1].data.sourceKind, 'FILE');
  assert.equal(calls[1][1].data.url, null);
  assert.deepEqual(calls[1][1].data.xmlFile, { connect: { id: xmlFileId } });
  assert.equal(created.source.sourceKind, 'FILE');
  assert.equal(created.source.url, null);
  assert.equal(created.source.xmlFile.id, xmlFileId);
  assert.equal(created.source.xmlFile.originalName, 'developer-feed.xml');
});

test('FeedsService switches file feed sources to URL without violating source payload constraint', async () => {
  const calls = [];
  const xmlFile = fileRecord({
    id: xmlFileId,
    key: 'uploads/2026/05/old-feed.xml',
    originalName: 'old-feed.xml',
    mimeType: 'application/xml',
  });
  const prisma = {
    developer: {
      count: async () => 1,
    },
    realEstateObject: {
      count: async () => 1,
    },
    feedSource: {
      findUnique: async (args) => {
        calls.push(['feedSource.findUnique', args]);
        return sourceRecord({
          sourceKind: 'FILE',
          url: null,
          xmlFileId,
          xmlFile,
        });
      },
      update: async (args) => {
        calls.push(['feedSource.update', args]);

        if (args.data.sourceKind === 'URL' && args.data.url && args.data.xmlFileId !== null) {
          throw new Error('feed_sources_source_payload_check');
        }

        return sourceRecord({
          sourceKind: args.data.sourceKind,
          url: args.data.url,
          xmlFileId: args.data.xmlFileId,
          xmlFile: null,
        });
      },
    },
  };
  const service = new FeedsService(prisma);

  const updated = await service.updateSource(sourceId, {
    sourceKind: 'URL',
    url: 'https://newfeed.6feeds.ru/feeds/static/muza_mangazey/yandex',
    format: 'YANDEX_REALTY',
    developerId,
    objectId,
    mappings: '[]',
    isActive: true,
  });
  const updateCall = calls.find(([name]) => name === 'feedSource.update')[1];

  assert.equal(updateCall.data.sourceKind, 'URL');
  assert.equal(updateCall.data.url, 'https://newfeed.6feeds.ru/feeds/static/muza_mangazey/yandex');
  assert.equal(updateCall.data.xmlFileId, null);
  assert.equal('xmlFile' in updateCall.data, false);
  assert.equal(updated.source.sourceKind, 'URL');
  assert.equal(updated.source.xmlFileId, null);
});

test('FeedsService clears fallback object when source mappings are provided', async () => {
  const calls = [];
  const prisma = {
    developer: {
      count: async () => 1,
    },
    realEstateObject: {
      count: async () => 1,
    },
    feedSource: {
      findUnique: async (args) => {
        calls.push(['feedSource.findUnique', args]);
        return sourceRecord({
          objectId,
          object: objectRecord({ id: objectId, title: 'ЖК АУРА' }),
          mappings: [],
        });
      },
      update: async (args) => {
        calls.push(['feedSource.update', args]);
        return sourceRecord({
          objectId: args.data.objectId,
          object: null,
          mappings: [
            sourceMappingRecord({
              objectId: secondObjectId,
              object: objectRecord({ id: secondObjectId, title: 'Жилой комплекс Муза' }),
            }),
          ],
        });
      },
    },
  };
  const service = new FeedsService(prisma);

  await service.updateSource(sourceId, {
    sourceKind: 'URL',
    url: 'https://newfeed.6feeds.ru/feeds/static/muza_mangazey/yandex',
    format: 'YANDEX_REALTY',
    developerId,
    objectId,
    mappings: JSON.stringify([
      {
        sourceKey: 'muza',
        sourceTitle: 'МУЗА',
        objectId: secondObjectId,
        filterJson: {
          projectNames: ['МУЗА'],
        },
        isActive: true,
      },
    ]),
    isActive: true,
  });
  const updateCall = calls.find(([name]) => name === 'feedSource.update')[1];

  assert.equal(updateCall.data.objectId, null);
  assert.equal(updateCall.data.mappings.create[0].objectId, secondObjectId);
});

test('FeedsService rejects file source creation without XML upload', async () => {
  const service = new FeedsService({});

  await assert.rejects(
    () =>
      service.createSource({
        sourceKind: 'file',
        format: 'YANDEX_REALTY',
        developerId,
        objectId,
      }),
    BadRequestException,
  );
});

test('FeedsService lists runs, reads a run and lists units with media details', async () => {
  const calls = [];
  const prisma = {
    $transaction: async (queries) => Promise.all(queries),
    feedSource: {
      count: async (args) => {
        calls.push(['feedSource.count', args]);
        return args.where.id === sourceId ? 1 : 0;
      },
    },
    feedImportRun: {
      findMany: async (args) => {
        calls.push(['feedImportRun.findMany', args]);
        return [runRecord()];
      },
      count: async (args) => {
        calls.push(['feedImportRun.count', args]);
        return 1;
      },
      findUnique: async (args) => {
        calls.push(['feedImportRun.findUnique', args]);
        return args.where.id === runId ? runRecord() : null;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.push(['feedUnit.findMany', args]);
        return [unitRecord()];
      },
      count: async (args) => {
        calls.push(['feedUnit.count', args]);
        return 1;
      },
    },
  };
  const service = new FeedsService(prisma);

  const runs = await service.listSourceRuns(sourceId, { mode: 'preview', status: 'success' });
  const run = await service.getRun(runId);
  const units = await service.listUnits({ sourceId, status: 'available', type: 'residential' });

  assert.equal(runs.items[0].summaryJson.unitsParsed, 2);
  assert.equal(run.run.id, runId);
  assert.deepEqual(calls.find(([name]) => name === 'feedUnit.findMany')[1].where, {
    AND: [{ sourceId }, { status: 'AVAILABLE' }, { type: 'RESIDENTIAL' }],
  });
  assert.equal(units.items[0].price, '10000000.00');
  assert.equal(units.items[0].residentialDetails.livingArea, '30.00');
  assert.equal(units.items[0].media[0].file.sizeBytes, '1000');
});

test('FeedsService.listUnits expands search for transliteration and wrong keyboard layout', async () => {
  const calls = {};
  const prisma = {
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [unitRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new FeedsService(prisma);

  await service.listUnits({ search: 'Ifufk' });

  assert.equal(calls.findMany.where.AND.some((filter) => filter.OR?.some((item) => item.title?.contains === 'шагал')), true);
  assert.equal(calls.findMany.where.AND.some((filter) => filter.OR?.some((item) => item.address?.contains === 'shagal')), true);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('FeedsService protects one source from parallel preview/run commands', async () => {
  let resolveCommand;
  const commandStarted = new Promise((resolve) => {
    resolveCommand = resolve;
  });
  let finishCommand;
  const commandFinished = new Promise((resolve) => {
    finishCommand = resolve;
  });
  const prisma = {
    feedSource: {
      findUnique: async () => ({ id: sourceId }),
    },
    feedImportRun: {
      findFirst: async () => runRecord(),
    },
  };
  const service = new FeedsService(prisma);
  service.runFeedImportCli = async () => {
    resolveCommand();
    await commandFinished;
  };

  const first = service.runFeedImportCommand(sourceId, 'preview');
  await commandStarted;

  await assert.rejects(() => service.runFeedImportCommand(sourceId, 'run'), ConflictException);

  finishCommand();
  const result = await first;

  assert.equal(result.run.id, runId);
});

test('FeedsService returns a pending run command before the feed-import CLI finishes', async () => {
  let resolveCommand;
  const commandStarted = new Promise((resolve) => {
    resolveCommand = resolve;
  });
  let finishCommand;
  const commandFinished = new Promise((resolve) => {
    finishCommand = resolve;
  });
  let commandHasStarted = false;
  const runs = [];
  const prisma = {
    feedSource: {
      findUnique: async () => ({ id: sourceId }),
    },
    feedImportRun: {
      create: async ({ data }) => {
        const run = runRecord({
          sourceId: data.sourceId,
          mode: data.mode,
          status: data.status,
          startedAt: data.startedAt,
          finishedAt: null,
          summaryJson: data.summaryJson,
        });
        runs.push(run);
        return run;
      },
      update: async ({ where, data }) => {
        const run = runs.find((currentRun) => currentRun.id === where.id);
        Object.assign(run, data);
        return run;
      },
      findFirst: async () =>
        commandHasStarted
          ? runRecord({
              mode: 'RUN',
              status: 'PENDING',
              finishedAt: null,
              summaryJson: null,
            })
          : null,
    },
  };
  const service = new FeedsService(prisma);
  service.runFeedImportCli = async () => {
    commandHasStarted = true;
    resolveCommand();
    await commandFinished;
  };

  const resultPromise = service.runFeedImportCommand(sourceId, 'run');

  await commandStarted;

  try {
    const resultBeforeCliFinished = await Promise.race([
      resultPromise.then((result) => ({ type: 'resolved', result })),
      new Promise((resolve) => {
        setTimeout(() => resolve({ type: 'pending' }), 20);
      }),
    ]);

    assert.equal(resultBeforeCliFinished.type, 'resolved');
    assert.equal(resultBeforeCliFinished.result.run.mode, 'RUN');
    assert.equal(resultBeforeCliFinished.result.run.status, 'PENDING');
  } finally {
    finishCommand();
    await resultPromise.catch(() => {});
  }
});

test('FeedsService queues feed run commands and starts at most three at once', async () => {
  const sources = Array.from({ length: 4 }, (_, index) => `11111111-1111-4111-8111-11111111111${index + 1}`);
  const runs = [];
  const startedCommands = [];
  const prisma = {
    feedSource: {
      findUnique: async ({ where }) => ({ id: where.id }),
    },
    feedImportRun: {
      create: async ({ data }) => {
        const run = runRecord({
          id: `44444444-4444-4444-8444-44444444444${runs.length + 1}`,
          sourceId: data.sourceId,
          mode: data.mode,
          status: data.status,
          startedAt: data.startedAt,
          finishedAt: null,
          summaryJson: data.summaryJson,
        });
        runs.push(run);
        return run;
      },
      update: async ({ where, data }) => {
        const run = runs.find((currentRun) => currentRun.id === where.id);
        Object.assign(run, data);
        return run;
      },
      findFirst: async ({ where }) => runs.find((run) => run.sourceId === where.sourceId && run.mode === where.mode) ?? null,
    },
  };
  const service = new FeedsService(prisma);
  service.runFeedImportCli = async (mode, queuedSourceId, queuedRunId) => {
    startedCommands.push({ mode, sourceId: queuedSourceId, runId: queuedRunId });
    await new Promise(() => {});
  };

  const results = await Promise.all(sources.map((currentSourceId) => service.runFeedImportCommand(currentSourceId, 'run')));

  assert.equal(results.length, 4);
  assert.equal(runs.length, 4);
  assert.equal(startedCommands.length, 3);
  assert.deepEqual(
    startedCommands.map((command) => command.runId),
    runs.slice(0, 3).map((run) => run.id),
  );
  assert.equal(runs[3].summaryJson.progress.stage, 'QUEUED');
});

test('FeedsService does not overwrite queued run details after the importer records a failure', async () => {
  let resolveStatusChecked;
  const statusChecked = new Promise((resolve) => {
    resolveStatusChecked = resolve;
  });
  const updateCalls = [];
  const prisma = {
    feedSource: {
      findUnique: async () => ({ id: sourceId }),
    },
    feedImportRun: {
      create: async ({ data }) =>
        runRecord({
          sourceId: data.sourceId,
          mode: data.mode,
          status: data.status,
          startedAt: data.startedAt,
          finishedAt: null,
          summaryJson: data.summaryJson,
        }),
      findUnique: async () => {
        resolveStatusChecked();
        return { status: 'FAILED' };
      },
      update: async (args) => {
        updateCalls.push(args);
        return runRecord(args.data);
      },
    },
  };
  const service = new FeedsService(prisma);
  service.runFeedImportCli = async () => {
    throw new Error('importer failed');
  };

  await service.runFeedImportCommand(sourceId, 'run');
  await statusChecked;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.equal(updateCalls.length, 0);
});

test('FeedsService validates missing sources and reports', async () => {
  const prisma = {
    feedSource: {
      count: async () => 0,
      findUnique: async () => null,
    },
    feedImportRun: {
      findUnique: async () => null,
    },
  };
  const service = new FeedsService(prisma);

  await assert.rejects(() => service.listSourceRuns(sourceId, {}), NotFoundException);
  await assert.rejects(() => service.runFeedImportCommand(sourceId, 'preview'), NotFoundException);
  await assert.rejects(() => service.getRun(runId), NotFoundException);
});
