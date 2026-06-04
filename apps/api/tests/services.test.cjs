require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException, ConflictException } = require('@nestjs/common');
const { FeedUnitStatus, FeedUnitType, LocationType, ObjectFileType, ObjectStatus, UserStatus } = require('@prisma/client');

const { DirectoriesService } = require('../dist/directories/directories.service.js');
const { CatalogLinksService } = require('../dist/catalog-links/catalog-links.service.js');
const { AuthService } = require('../dist/auth/auth.service.js');
const { MapService } = require('../dist/map/map.service.js');
const { ObjectsService } = require('../dist/objects/objects.service.js');
const { UsersService } = require('../dist/users/users.service.js');

const ObjectImageSection = {
  ARCHITECTURE: 'ARCHITECTURE',
  INTERIORS: 'INTERIORS',
  FILLING: 'FILLING',
};

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  name: 'Admin',
  status: UserStatus.ACTIVE,
  role: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'admin' },
  permissions: [],
};

const request = {
  headers: {
    'user-agent': 'node-test',
    'x-forwarded-for': '127.0.0.1, 10.0.0.2',
  },
  ip: '10.0.0.1',
};

function decimal(value) {
  return {
    toString: () => value,
    toNumber: () => Number(value),
  };
}

function locationRecord(overrides = {}) {
  const now = new Date('2026-05-01T10:00:00.000Z');

  return {
    id: '66666666-6666-4666-8666-666666666666',
    wpTermId: null,
    name: 'Тверской',
    slug: 'tverskoy',
    type: LocationType.DISTRICT,
    parentId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function objectRecord(overrides = {}) {
  const now = new Date('2026-05-01T10:00:00.000Z');

  return {
    id: '11111111-1111-4111-8111-111111111111',
    wpPostId: null,
    title: 'ЖК Тестовый',
    slug: 'zhk-testovyy',
    status: ObjectStatus.DRAFT,
    description: null,
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
    shortDescription: null,
    mapName: null,
    krtName: null,
    apartmentAreaRange: null,
    ceilingHeight: null,
    propertyClass: null,
    floorRange: null,
    apartmentsCountText: null,
    priceFrom: null,
    pricePerMeterFrom: null,
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: null,
    feedUnitsCountText: null,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
    completionYear: null,
    completionQuarter: null,
    address: null,
    latitude: null,
    longitude: null,
    featuresJson: {},
    developerId: null,
    primaryLocationId: null,
    publishedAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    developer: null,
    primaryLocation: null,
    locations: [],
    metroStations: [],
    images: [],
    files: [],
    auditLogs: [],
    ...overrides,
  };
}

function fileRecord(overrides = {}) {
  const now = new Date('2026-05-01T10:00:00.000Z');

  return {
    id: '55555555-5555-4555-8555-555555555555',
    wpAttachmentId: null,
    storage: 'MINIO',
    bucket: 'objects',
    key: 'objects/image.jpg',
    url: 'https://cdn.example.test/objects/image.jpg',
    originalName: 'image.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 123n,
    checksum: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function objectImageRecord(overrides = {}) {
  const now = new Date('2026-05-01T10:00:00.000Z');
  const fileId = overrides.fileId ?? '55555555-5555-4555-8555-555555555555';

  return {
    id: '22222222-2222-4222-8222-222222222222',
    objectId: '11111111-1111-4111-8111-111111111111',
    fileId,
    sortOrder: 0,
    isCover: false,
    section: null,
    alt: null,
    title: null,
    sourceMetaKey: null,
    createdAt: now,
    updatedAt: now,
    file: fileRecord({ id: fileId }),
    ...overrides,
  };
}

function userRecord(overrides = {}) {
  const now = new Date('2026-05-01T10:00:00.000Z');

  return {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'editor@example.test',
    name: 'Editor',
    passwordHash: 'hash',
    refreshTokenHash: 'refresh-hash',
    refreshTokenExpiresAt: new Date('2026-06-01T10:00:00.000Z'),
    status: UserStatus.ACTIVE,
    roleId: '44444444-4444-4444-8444-444444444444',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    role: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'editor',
      description: 'Editor',
    },
    ...overrides,
  };
}

function catalogQuickLinkRecord(overrides = {}) {
  const now = new Date('2026-05-01T10:00:00.000Z');

  return {
    id: '99999999-9999-4999-8999-999999999999',
    type: 'KRT',
    label: 'Большое Сити',
    sortOrder: 0,
    isEnabled: true,
    developerId: null,
    objectId: null,
    krtName: 'Большое Сити',
    createdAt: now,
    updatedAt: now,
    developer: null,
    object: null,
    ...overrides,
  };
}

test('DirectoriesService.listLocations filters district and area directories by type', async () => {
  const calls = [];
  const prisma = {
    location: {
      findMany: async (args) => {
        calls.push(args);
        const type = args.where.AND.find((filter) => filter.type).type;

        return [locationRecord({ type })];
      },
    },
  };
  const service = new DirectoriesService(prisma);

  const districts = await service.listLocations({ type: 'district', limit: '500' });
  const areas = await service.listLocations({ type: 'AREA', limit: '500' });

  assert.equal(calls[0].where.AND[0].type, LocationType.DISTRICT);
  assert.equal(calls[1].where.AND[0].type, LocationType.AREA);
  assert.equal(districts.items[0].type, LocationType.DISTRICT);
  assert.equal(areas.items[0].type, LocationType.AREA);
  assert.equal(calls[0].take, 500);
});

test('DirectoriesService.listDevelopers expands search for transliteration and wrong keyboard layout', async () => {
  const calls = {};
  const prisma = {
    developer: {
      findMany: async (args) => {
        calls.findMany = args;
        return [];
      },
    },
  };
  const service = new DirectoriesService(prisma);

  await service.listDevelopers({ search: 'Ifufk' });

  const containsValues = calls.findMany.where.OR.map((filter) => filter.name?.contains ?? filter.slug?.contains);
  assert.equal(containsValues.includes('шагал'), true);
  assert.equal(containsValues.includes('shagal'), true);
});

test('CatalogLinksService.listPublic returns enabled links with valid public targets', async () => {
  const developerId = '55555555-5555-4555-8555-555555555555';
  const publishedObject = objectRecord({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Upside Мосфильмовская',
    slug: 'upside-mosfilmovskaya',
    status: ObjectStatus.PUBLISHED,
  });
  const prisma = {
    catalogQuickLink: {
      findMany: async (args) => {
        assert.deepEqual(args.where, { isEnabled: true });
        assert.equal(args.include.developer, true);
        assert.equal(args.include.object, true);

        return [
          catalogQuickLinkRecord({
            type: 'DEVELOPER',
            label: 'ФСК',
            developerId,
            developer: {
              id: developerId,
              wpTermId: null,
              name: 'ФСК',
              slug: 'fsk',
              normalizedName: 'фск',
              createdAt: new Date('2026-05-01T10:00:00.000Z'),
              updatedAt: new Date('2026-05-01T10:00:00.000Z'),
            },
          }),
          catalogQuickLinkRecord(),
          catalogQuickLinkRecord({
            type: 'SALES_START',
            label: publishedObject.title,
            objectId: publishedObject.id,
            object: publishedObject,
          }),
          catalogQuickLinkRecord({
            type: 'DEVELOPER',
            label: 'No target',
            developerId: null,
            developer: null,
          }),
        ];
      },
    },
  };
  const service = new CatalogLinksService(prisma);

  const result = await service.listPublic();

  assert.deepEqual(result.items, [
    {
      id: '99999999-9999-4999-8999-999999999999',
      type: 'DEVELOPER',
      label: 'ФСК',
      sortOrder: 0,
      developerId,
      krtName: null,
      objectSlug: null,
    },
    {
      id: '99999999-9999-4999-8999-999999999999',
      type: 'KRT',
      label: 'Большое Сити',
      sortOrder: 0,
      developerId: null,
      krtName: 'Большое Сити',
      objectSlug: null,
    },
    {
      id: '99999999-9999-4999-8999-999999999999',
      type: 'SALES_START',
      label: 'Upside Мосфильмовская',
      sortOrder: 0,
      developerId: null,
      krtName: null,
      objectSlug: 'upside-mosfilmovskaya',
    },
  ]);
});

test('CatalogLinksService.listAdmin returns editable links with related targets', async () => {
  const developerId = '55555555-5555-4555-8555-555555555555';
  const object = objectRecord({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Upside Мосфильмовская',
    slug: 'upside-mosfilmovskaya',
    status: ObjectStatus.PUBLISHED,
  });
  const prisma = {
    catalogQuickLink: {
      findMany: async (args) => {
        assert.equal(args.include.developer, true);
        assert.equal(args.include.object, true);

        return [
          catalogQuickLinkRecord({
            type: 'SALES_START',
            label: object.title,
            objectId: object.id,
            object,
            developerId,
            developer: {
              id: developerId,
              wpTermId: null,
              name: 'ФСК',
              slug: 'fsk',
              normalizedName: 'фск',
              createdAt: new Date('2026-05-01T10:00:00.000Z'),
              updatedAt: new Date('2026-05-01T10:00:00.000Z'),
            },
          }),
        ];
      },
    },
  };
  const service = new CatalogLinksService(prisma);

  const result = await service.listAdmin();

  assert.equal(result.items[0].type, 'SALES_START');
  assert.equal(result.items[0].object.slug, 'upside-mosfilmovskaya');
  assert.equal(result.items[0].object.status, ObjectStatus.PUBLISHED);
  assert.equal(result.items[0].developer.name, 'ФСК');
  assert.equal(result.items[0].createdAt, '2026-05-01T10:00:00.000Z');
});

test('CatalogLinksService.updateAdmin validates enabled targets and replaces rows', async () => {
  const calls = [];
  const developerId = '55555555-5555-4555-8555-555555555555';
  const objectId = '22222222-2222-4222-8222-222222222222';
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
        return args.where.id === objectId && args.where.status === ObjectStatus.PUBLISHED ? 1 : 0;
      },
    },
    catalogQuickLink: {
      deleteMany: async (args) => {
        calls.push(['catalogQuickLink.deleteMany', args]);
      },
      update: async (args) => {
        calls.push(['catalogQuickLink.update', args]);
      },
      create: async (args) => {
        calls.push(['catalogQuickLink.create', args]);
      },
      findMany: async () => [],
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new CatalogLinksService(prisma);

  await assert.rejects(
    () =>
      service.updateAdmin({
        items: [{ type: 'DEVELOPER', label: 'ФСК', sortOrder: 0, isEnabled: true }],
      }),
    BadRequestException,
  );

  await service.updateAdmin({
    items: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        type: 'DEVELOPER',
        label: ' ФСК ',
        sortOrder: 0,
        isEnabled: true,
        developerId,
      },
      {
        type: 'KRT',
        label: 'Большое Сити',
        sortOrder: 1,
        isEnabled: true,
        krtName: ' Большое Сити ',
      },
      {
        type: 'SALES_START',
        label: 'Upside Мосфильмовская',
        sortOrder: 2,
        isEnabled: true,
        objectId,
      },
    ],
  });

  assert.deepEqual(calls.find((call) => call[0] === 'catalogQuickLink.deleteMany')[1], {
    where: {
      id: {
        notIn: ['99999999-9999-4999-8999-999999999999'],
      },
    },
  });
  assert.equal(calls.some((call) => call[0] === 'catalogQuickLink.update'), true);
  assert.equal(calls.filter((call) => call[0] === 'catalogQuickLink.create').length, 2);
  assert.equal(
    calls.some(
      (call) =>
        call[0] === 'realEstateObject.count' &&
        call[1].where.id === objectId &&
        call[1].where.status === ObjectStatus.PUBLISHED,
    ),
    true,
  );
});

test('ObjectsService.list builds catalog filters for status, price, presentation and missing coordinates', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    $queryRaw: async (query) => {
      calls.searchQuery = query;
      return [{ id: objectId }];
    },
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [
          objectRecord({
            id: objectId,
            images: [
              objectImageRecord({
                isCover: true,
                section: ObjectImageSection.FILLING,
              }),
            ],
          }),
        ];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.list({
    page: '2',
    limit: '5',
    search: 'центр',
    status: 'published',
    priceFromMin: '1 000 000',
    priceFromMax: '2 000 000',
    hasCoordinates: 'false',
    hasPresentation: 'false',
    sortBy: 'priceFrom',
    sortDirection: 'asc',
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].coverImage.section, ObjectImageSection.FILLING);
  assert.equal(result.page, 2);
  assert.equal(result.limit, 5);
  assert.equal(calls.findMany.skip, 5);
  assert.equal(calls.findMany.take, 5);
  assert.deepEqual(calls.findMany.orderBy, [
    { feedPriceFrom: { sort: 'asc', nulls: 'last' } },
    { priceFrom: { sort: 'asc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(calls.count.where, calls.findMany.where);

  const filters = calls.findMany.where.AND;
  assert.equal(filters.some((filter) => filter.status === ObjectStatus.PUBLISHED), true);
  assert.equal(
    filters.some(
      (filter) =>
        filter.OR?.some(
          (item) =>
            item.feedPriceFrom?.gte === '1000000' &&
            item.feedPriceFrom?.lte === '2000000' &&
            item.feedPriceFrom?.not === null,
        ) &&
        filter.OR?.some(
          (item) =>
            item.feedPriceFrom === null && item.priceFrom?.gte === '1000000' && item.priceFrom?.lte === '2000000',
        ),
    ),
    true,
  );
  assert.equal(filters.some((filter) => filter.files?.none?.type === ObjectFileType.PRESENTATION), true);
  assert.equal(filters.some((filter) => filter.OR?.some((item) => item.latitude === null)), true);
  assert.equal(filters.some((filter) => filter.id?.in?.includes(objectId)), true);
  assert.equal(calls.searchQuery.values.includes('%центр%'), true);
  assert.equal(calls.searchQuery.values.includes('%tsentr%'), true);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(o\.title, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(d\.name, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(o\.address, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /object_locations ol/);
  assert.match(calls.searchQuery.strings.join('?'), /l\.type::text = 'district'/);
});

test('ObjectsService.list serializes feed aggregates and uses feed price for catalog fallback filters and sort', async () => {
  const calls = {};
  const feedUpdatedAt = new Date('2026-05-02T12:00:00.000Z');
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;

        return [
          objectRecord({
            priceFrom: decimal('15000000'),
            pricePerMeterFrom: decimal('300000'),
            feedPriceFrom: decimal('12000000'),
            feedPricePerMeterFrom: decimal('250000'),
            feedAreaRange: '35-80 м²',
            feedFloorRange: '2-12',
            feedUnitsCount: 7,
            feedUnitsCountText: '7 лотов',
            feedCompletionYear: 2028,
            feedCompletionQuarter: 3,
            feedUpdatedAt,
          }),
        ];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.list({
    priceFromMin: '10 000 000',
    priceFromMax: '13 000 000',
    sortBy: 'priceFrom',
    sortDirection: 'asc',
  });

  assert.equal(result.items[0].feedPriceFrom, '12000000');
  assert.equal(result.items[0].feedPricePerMeterFrom, '250000');
  assert.equal(result.items[0].feedAreaRange, '35-80 м²');
  assert.equal(result.items[0].feedFloorRange, '2-12');
  assert.equal(result.items[0].feedUnitsCount, 7);
  assert.equal(result.items[0].feedUnitsCountText, '7 лотов');
  assert.equal(result.items[0].feedCompletionYear, 2028);
  assert.equal(result.items[0].feedCompletionQuarter, 3);
  assert.equal(result.items[0].feedUpdatedAt, feedUpdatedAt.toISOString());
  assert.deepEqual(calls.findMany.orderBy, [
    { feedPriceFrom: { sort: 'asc', nulls: 'last' } },
    { priceFrom: { sort: 'asc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(
    calls.findMany.where.AND.find((filter) => Array.isArray(filter.OR) && filter.OR.some((item) => item.feedPriceFrom)),
    {
      OR: [
        {
          feedPriceFrom: {
            not: null,
            gte: '10000000',
            lte: '13000000',
          },
        },
        {
          feedPriceFrom: null,
          priceFrom: {
            gte: '10000000',
            lte: '13000000',
          },
        },
      ],
    },
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.list filters objects by matching lot price rooms and floor', async () => {
  const calls = {};
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    feedUnit: {
      groupBy: async (args) => {
        calls.feedUnitGroupBy = args;

        return [
          {
            objectId: '11111111-1111-4111-8111-111111111111',
            _count: { _all: 3 },
          },
        ];
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.list({
    lotPriceMin: '10 000 000',
    lotPriceMax: '12 500 000',
    lotRooms: '5',
    lotFloorMin: '5',
    lotFloorMax: '12',
  });

  const filters = calls.findMany.where.AND;
  const lotFilter = filters.find((filter) => filter.feedUnits?.some);

  assert.deepEqual(lotFilter, {
    feedUnits: {
      some: {
        source: {
          deletedAt: null,
        },
        effectivePrice: {
          gte: '10000000',
          lte: '12500000',
        },
        rooms: 5,
        floor: {
          gte: 5,
          lte: 12,
        },
      },
    },
  });
  assert.equal(
    filters.some((filter) => Array.isArray(filter.OR) && filter.OR.some((item) => item.feedPriceFrom || item.priceFrom)),
    false,
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
  assert.deepEqual(calls.feedUnitGroupBy, {
    by: ['objectId'],
    where: {
      objectId: {
        in: ['11111111-1111-4111-8111-111111111111'],
      },
      source: {
        deletedAt: null,
      },
      effectivePrice: {
        gte: '10000000',
        lte: '12500000',
      },
      rooms: 5,
      floor: {
        gte: 5,
        lte: 12,
      },
    },
    _count: {
      _all: true,
    },
  });
  assert.equal(result.items[0].matchedFeedUnitsCount, 3);
});

test('ObjectsService.list filters objects by several selected lot rooms', async () => {
  const calls = {};
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    feedUnit: {
      groupBy: async (args) => {
        calls.feedUnitGroupBy = args;

        return [];
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({ lotRooms: '2,3' });

  const lotWhere = calls.findMany.where.AND.find((filter) => filter.feedUnits?.some).feedUnits.some;

  assert.deepEqual(lotWhere, {
    source: {
      deletedAt: null,
    },
    rooms: {
      in: [2, 3],
    },
  });
  assert.deepEqual(calls.feedUnitGroupBy.where, {
    objectId: {
      in: ['11111111-1111-4111-8111-111111111111'],
    },
    source: {
      deletedAt: null,
    },
    rooms: {
      in: [2, 3],
    },
  });
});

test('ObjectsService.list combines selected studios with other lot rooms', async () => {
  const calls = {};
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async () => 1,
    },
    feedUnit: {
      groupBy: async () => [],
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({ lotRooms: '0,2' });

  const lotWhere = calls.findMany.where.AND.find((filter) => filter.feedUnits?.some).feedUnits.some;

  assert.equal(lotWhere.OR.some((filter) => filter.rooms === 0), true);
  assert.equal(lotWhere.OR.some((filter) => filter.rooms === 2), true);
  assert.equal(
    lotWhere.OR.some((filter) => filter.residentialDetails?.is?.layoutType?.equals === 'раздельные'),
    true,
  );
});

test('ObjectsService.list treats Aura separate-room layouts as studios in lot filters', async () => {
  const calls = {};
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    feedUnit: {
      groupBy: async (args) => {
        calls.feedUnitGroupBy = args;

        return [];
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({ lotRooms: '0' });

  const lotWhere = calls.findMany.where.AND.find((filter) => filter.feedUnits?.some).feedUnits.some;

  assert.deepEqual(lotWhere, {
    source: {
      deletedAt: null,
    },
    OR: [
      {
        rooms: 0,
      },
      {
        rooms: null,
        residentialDetails: {
          is: {
            layoutType: {
              equals: 'раздельные',
              mode: 'insensitive',
            },
          },
        },
        object: {
          OR: [
            {
              title: {
                contains: 'аура',
                mode: 'insensitive',
              },
            },
            {
              developer: {
                is: {
                  name: {
                    contains: 'мангазея',
                    mode: 'insensitive',
                  },
                },
              },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(calls.feedUnitGroupBy.where.OR, lotWhere.OR);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.list ignores dots in object catalog search', async () => {
  const calls = {};
  const prisma = {
    $queryRaw: async (query) => {
      calls.searchQuery = query;
      return [{ id: '11111111-1111-4111-8111-111111111111' }];
    },
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async () => 1,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({ search: ' ул. Новая ' });

  assert.equal(calls.searchQuery.values.includes('%ул новая%'), true);
  assert.equal(calls.searchQuery.values.includes('%ul novaya%'), true);
  assert.equal(
    calls.findMany.where.AND.some((filter) =>
      filter.id?.in?.includes('11111111-1111-4111-8111-111111111111'),
    ),
    true,
  );
});

test('ObjectsService.list expands catalog search for transliteration and wrong keyboard layout', async () => {
  const calls = {};
  const prisma = {
    $queryRaw: async (query) => {
      calls.searchQuery = query;
      return [{ id: '11111111-1111-4111-8111-111111111111' }];
    },
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async () => 1,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({ search: 'Ifufk' });

  assert.equal(calls.searchQuery.values.includes('%шагал%'), true);
  assert.equal(calls.searchQuery.values.includes('%shagal%'), true);
  assert.equal(
    calls.findMany.where.AND.some((filter) =>
      filter.id?.in?.includes('11111111-1111-4111-8111-111111111111'),
    ),
    true,
  );
});

test('ObjectsService.list sorts catalog price per meter and completion date with empty values last', async () => {
  const calls = [];
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.push(args);
        return [objectRecord()];
      },
      count: async () => 1,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({
    sortBy: 'pricePerMeterFrom',
    sortDirection: 'desc',
  });
  await service.list({
    sortBy: 'completionDate',
    sortDirection: 'asc',
  });
  await service.list({
    sortBy: 'completionYear',
    sortDirection: 'desc',
  });

  assert.deepEqual(calls[0].orderBy, [
    { feedPricePerMeterFrom: { sort: 'desc', nulls: 'last' } },
    { pricePerMeterFrom: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(calls[1].orderBy, [
    { completionYear: { sort: 'asc', nulls: 'last' } },
    { completionQuarter: { sort: 'asc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(calls[2].orderBy, [
    { completionYear: { sort: 'desc', nulls: 'last' } },
    { completionQuarter: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
});

test('ObjectsService.list filters locationId and areaId through linked locations', async () => {
  const calls = {};
  const districtId = '66666666-6666-4666-8666-666666666666';
  const areaId = '77777777-7777-4777-8777-777777777777';
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({ locationId: districtId, areaId });

  const filters = calls.findMany.where.AND;
  const locationFilter = filters.find((filter) =>
    filter.OR?.some((item) => item.locations?.some?.locationId === districtId),
  );
  const areaFilter = filters.find((filter) => filter.locations?.some?.locationId === areaId);

  assert.equal(locationFilter.OR.some((item) => item.primaryLocationId === districtId), true);
  assert.equal(locationFilter.OR.some((item) => item.locations?.some?.locationId === districtId), true);
  assert.equal(areaFilter.locations.some.location.type, LocationType.AREA);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.list supports multiple catalog directory ids in comma-separated filters', async () => {
  const calls = {};
  const firstDeveloperId = '55555555-5555-4555-8555-555555555555';
  const secondDeveloperId = '88888888-8888-4888-8888-888888888888';
  const firstDistrictId = '66666666-6666-4666-8666-666666666666';
  const secondDistrictId = '99999999-9999-4999-8999-999999999999';
  const firstAreaId = '77777777-7777-4777-8777-777777777777';
  const secondAreaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const firstMetroId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const secondMetroId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({
    developerId: encodeURIComponent(`${firstDeveloperId},${secondDeveloperId}`),
    locationId: encodeURIComponent(`${firstDistrictId},${secondDistrictId}`),
    areaId: encodeURIComponent(`${firstAreaId},${secondAreaId}`),
    metroStationId: encodeURIComponent(`${firstMetroId},${secondMetroId}`),
  });

  const filters = calls.findMany.where.AND;
  const developerFilter = filters.find((filter) => filter.developerId?.in);
  const locationFilter = filters.find((filter) => filter.OR?.some((item) => item.primaryLocationId?.in));
  const areaFilter = filters.find((filter) => filter.locations?.some?.location?.type === LocationType.AREA);
  const metroFilter = filters.find((filter) => filter.metroStations?.some?.metroStationId?.in);

  assert.deepEqual(developerFilter.developerId.in, [firstDeveloperId, secondDeveloperId]);
  assert.deepEqual(locationFilter.OR.find((item) => item.primaryLocationId?.in).primaryLocationId.in, [
    firstDistrictId,
    secondDistrictId,
  ]);
  assert.deepEqual(locationFilter.OR.find((item) => item.locations?.some?.locationId?.in).locations.some.locationId.in, [
    firstDistrictId,
    secondDistrictId,
  ]);
  assert.deepEqual(areaFilter.locations.some.locationId.in, [firstAreaId, secondAreaId]);
  assert.deepEqual(metroFilter.metroStations.some.metroStationId.in, [firstMetroId, secondMetroId]);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.list accepts repeated and double encoded catalog directory filters', async () => {
  const calls = {};
  const firstDeveloperId = '55555555-5555-4555-8555-555555555555';
  const secondDeveloperId = '88888888-8888-4888-8888-888888888888';
  const firstDistrictId = '66666666-6666-4666-8666-666666666666';
  const secondDistrictId = '99999999-9999-4999-8999-999999999999';
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({
    developerId: encodeURIComponent(encodeURIComponent(`${firstDeveloperId},${secondDeveloperId}`)),
    locationId: [firstDistrictId, secondDistrictId],
  });

  const filters = calls.findMany.where.AND;
  const developerFilter = filters.find((filter) => filter.developerId?.in);
  const locationFilter = filters.find((filter) => filter.OR?.some((item) => item.primaryLocationId?.in));

  assert.deepEqual(developerFilter.developerId.in, [firstDeveloperId, secondDeveloperId]);
  assert.deepEqual(locationFilter.OR.find((item) => item.primaryLocationId?.in).primaryLocationId.in, [
    firstDistrictId,
    secondDistrictId,
  ]);
});

test('ObjectsService.list filters admin object locations and metro by unified text search', async () => {
  const calls = {};
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord()];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({
    districtSearch: 'Ifufk',
    areaSearch: 'Shagal',
    metroSearch: 'Ifufk',
  });

  const filters = calls.findMany.where.AND;
  const districtFilter = filters.find((filter) =>
    filter.OR?.some((item) => item.primaryLocation?.is?.type === LocationType.DISTRICT),
  );
  const areaFilter = filters.find((filter) => filter.locations?.some?.location?.type === LocationType.AREA);
  const metroFilter = filters.find((filter) => filter.metroStations?.some?.metroStation?.OR);

  assert.equal(
    districtFilter.OR.some((item) =>
      item.primaryLocation?.is?.OR?.some((condition) => condition.name?.contains === 'шагал'),
    ),
    true,
  );
  assert.equal(
    districtFilter.OR.some((item) =>
      item.locations?.some?.location?.OR?.some((condition) => condition.slug?.contains === 'shagal'),
    ),
    true,
  );
  assert.equal(areaFilter.locations.some.location.OR.some((condition) => condition.name?.contains === 'шагал'), true);
  assert.equal(
    metroFilter.metroStations.some.metroStation.OR.some((condition) => condition.lineName?.contains === 'shagal'),
    true,
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.list filters krtName by exact case-insensitive trimmed value', async () => {
  const calls = {};
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [objectRecord({ krtName: 'Большое Сити' })];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.list({ krtName: '  большое сити  ' });

  const filters = calls.findMany.where.AND;
  assert.equal(
    filters.some((filter) => filter.krtName?.equals === 'большое сити' && filter.krtName?.mode === 'insensitive'),
    true,
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('MapService.listObjects returns linked locations with type and supports areaId', async () => {
  const calls = {};
  const district = locationRecord();
  const area = locationRecord({
    id: '77777777-7777-4777-8777-777777777777',
    name: 'На Патриарших',
    slug: 'na-patriarshih',
    type: LocationType.AREA,
  });
  const mapObject = objectRecord({
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
    primaryLocation: district,
    locations: [
      {
        objectId: '11111111-1111-4111-8111-111111111111',
        locationId: district.id,
        isPrimary: true,
        sortOrder: 0,
        location: district,
      },
      {
        objectId: '11111111-1111-4111-8111-111111111111',
        locationId: area.id,
        isPrimary: false,
        sortOrder: 1,
        location: area,
      },
    ],
    images: [
      objectImageRecord({
        isCover: true,
        section: ObjectImageSection.ARCHITECTURE,
      }),
    ],
  });
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [mapObject];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  const result = await service.listObjects({ locationId: district.id, areaId: area.id });

  const filters = calls.findMany.where.AND;
  const areaFilter = filters.find((filter) => filter.locations?.some?.locationId === area.id);

  assert.equal(calls.findMany.include.locations.include.location, true);
  assert.equal(areaFilter.locations.some.location.type, LocationType.AREA);
  assert.equal(result.items[0].coverImage.section, ObjectImageSection.ARCHITECTURE);
  assert.deepEqual(
    result.items[0].locations.map((location) => [location.name, location.type, location.isPrimary]),
    [
      ['Тверской', LocationType.DISTRICT, true],
      ['На Патриарших', LocationType.AREA, false],
    ],
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('MapService.listObjects supports multiple catalog directory ids in comma-separated filters', async () => {
  const calls = {};
  const firstDeveloperId = '55555555-5555-4555-8555-555555555555';
  const secondDeveloperId = '88888888-8888-4888-8888-888888888888';
  const firstDistrictId = '66666666-6666-4666-8666-666666666666';
  const secondDistrictId = '99999999-9999-4999-8999-999999999999';
  const firstAreaId = '77777777-7777-4777-8777-777777777777';
  const secondAreaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const firstMetroId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const secondMetroId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [
          objectRecord({
            latitude: decimal('55.751244'),
            longitude: decimal('37.618423'),
          }),
        ];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  await service.listObjects({
    developerId: encodeURIComponent(`${firstDeveloperId},${secondDeveloperId}`),
    locationId: encodeURIComponent(`${firstDistrictId},${secondDistrictId}`),
    areaId: encodeURIComponent(`${firstAreaId},${secondAreaId}`),
    metroStationId: encodeURIComponent(`${firstMetroId},${secondMetroId}`),
  });

  const filters = calls.findMany.where.AND;
  const developerFilter = filters.find((filter) => filter.developerId?.in);
  const locationFilter = filters.find((filter) => filter.OR?.some((item) => item.primaryLocationId?.in));
  const areaFilter = filters.find((filter) => filter.locations?.some?.location?.type === LocationType.AREA);
  const metroFilter = filters.find((filter) => filter.metroStations?.some?.metroStationId?.in);

  assert.deepEqual(developerFilter.developerId.in, [firstDeveloperId, secondDeveloperId]);
  assert.deepEqual(locationFilter.OR.find((item) => item.primaryLocationId?.in).primaryLocationId.in, [
    firstDistrictId,
    secondDistrictId,
  ]);
  assert.deepEqual(locationFilter.OR.find((item) => item.locations?.some?.locationId?.in).locations.some.locationId.in, [
    firstDistrictId,
    secondDistrictId,
  ]);
  assert.deepEqual(areaFilter.locations.some.locationId.in, [firstAreaId, secondAreaId]);
  assert.deepEqual(metroFilter.metroStations.some.metroStationId.in, [firstMetroId, secondMetroId]);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('MapService.listObjects accepts repeated and double encoded catalog directory filters', async () => {
  const calls = {};
  const firstDeveloperId = '55555555-5555-4555-8555-555555555555';
  const secondDeveloperId = '88888888-8888-4888-8888-888888888888';
  const firstDistrictId = '66666666-6666-4666-8666-666666666666';
  const secondDistrictId = '99999999-9999-4999-8999-999999999999';
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [
          objectRecord({
            latitude: decimal('55.751244'),
            longitude: decimal('37.618423'),
          }),
        ];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  await service.listObjects({
    developerId: encodeURIComponent(encodeURIComponent(`${firstDeveloperId},${secondDeveloperId}`)),
    locationId: [firstDistrictId, secondDistrictId],
  });

  const filters = calls.findMany.where.AND;
  const developerFilter = filters.find((filter) => filter.developerId?.in);
  const locationFilter = filters.find((filter) => filter.OR?.some((item) => item.primaryLocationId?.in));

  assert.deepEqual(developerFilter.developerId.in, [firstDeveloperId, secondDeveloperId]);
  assert.deepEqual(locationFilter.OR.find((item) => item.primaryLocationId?.in).primaryLocationId.in, [
    firstDistrictId,
    secondDistrictId,
  ]);
});

test('MapService.listObjects serializes feed aggregates and filters price by feed fallback', async () => {
  const calls = {};
  const feedUpdatedAt = new Date('2026-05-02T12:00:00.000Z');
  const mapObject = objectRecord({
    mapName: 'Ария',
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
    priceFrom: decimal('15000000'),
    pricePerMeterFrom: decimal('300000'),
    apartmentAreaRange: '40-90 м²',
    feedPriceFrom: decimal('12000000'),
    feedPricePerMeterFrom: decimal('250000'),
    feedAreaRange: '35-80 м²',
    feedFloorRange: '2-12',
    feedUnitsCount: 7,
    feedUnitsCountText: '7 лотов',
    feedCompletionYear: 2028,
    feedCompletionQuarter: 3,
    feedUpdatedAt,
  });
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [mapObject];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  const result = await service.listObjects({
    priceFromMin: '10 000 000',
    priceFromMax: '13 000 000',
  });

  assert.equal(result.items[0].feedPriceFrom, '12000000');
  assert.equal(result.items[0].mapName, 'Ария');
  assert.equal(result.items[0].feedPricePerMeterFrom, '250000');
  assert.equal(result.items[0].apartmentAreaRange, '40-90 м²');
  assert.equal(result.items[0].feedAreaRange, '35-80 м²');
  assert.equal(result.items[0].feedFloorRange, '2-12');
  assert.equal(result.items[0].feedUnitsCount, 7);
  assert.equal(result.items[0].feedUnitsCountText, '7 лотов');
  assert.equal(result.items[0].feedCompletionYear, 2028);
  assert.equal(result.items[0].feedCompletionQuarter, 3);
  assert.equal(result.items[0].feedUpdatedAt, feedUpdatedAt.toISOString());
  assert.deepEqual(
    calls.findMany.where.AND.find((filter) => Array.isArray(filter.OR) && filter.OR.some((item) => item.feedPriceFrom)),
    {
      OR: [
        {
          feedPriceFrom: {
            not: null,
            gte: '10000000',
            lte: '13000000',
          },
        },
        {
          feedPriceFrom: null,
          priceFrom: {
            gte: '10000000',
            lte: '13000000',
          },
        },
      ],
    },
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('MapService.listObjects filters objects by matching lot price rooms and floor', async () => {
  const calls = {};
  const mapObject = objectRecord({
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
  });
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [mapObject];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  await service.listObjects({
    lotPriceMin: '10 000 000',
    lotPriceMax: '12 500 000',
    lotRooms: '5',
    lotFloorMin: '5',
    lotFloorMax: '12',
  });

  const filters = calls.findMany.where.AND;
  const lotFilter = filters.find((filter) => filter.feedUnits?.some);

  assert.deepEqual(lotFilter, {
    feedUnits: {
      some: {
        effectivePrice: {
          gte: '10000000',
          lte: '12500000',
        },
        rooms: 5,
        floor: {
          gte: 5,
          lte: 12,
        },
      },
    },
  });
  assert.equal(filters.some((filter) => filter.latitude?.not === null && filter.longitude?.not === null), true);
  assert.equal(
    filters.some((filter) => Array.isArray(filter.OR) && filter.OR.some((item) => item.feedPriceFrom || item.priceFrom)),
    false,
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('MapService.listObjects filters objects by several selected lot rooms', async () => {
  const calls = {};
  const mapObject = objectRecord({
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
  });
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [mapObject];
      },
      count: async () => 1,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  await service.listObjects({ lotRooms: '2,3' });

  const lotWhere = calls.findMany.where.AND.find((filter) => filter.feedUnits?.some).feedUnits.some;

  assert.deepEqual(lotWhere, {
    rooms: {
      in: [2, 3],
    },
  });
});

test('MapService.listObjects treats Aura separate-room layouts as studios in lot filters', async () => {
  const calls = {};
  const mapObject = objectRecord({
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
  });
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [mapObject];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  await service.listObjects({ lotRooms: '0' });

  const lotWhere = calls.findMany.where.AND.find((filter) => filter.feedUnits?.some).feedUnits.some;

  assert.equal(lotWhere.OR.some((filter) => filter.rooms === 0), true);
  assert.equal(
    lotWhere.OR.some((filter) => filter.residentialDetails?.is?.layoutType?.equals === 'раздельные'),
    true,
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.listFeedUnits returns feed units for one object with filters and media', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const unitId = '55555555-5555-4555-8555-555555555555';
  const now = new Date('2026-05-23T10:00:00.000Z');
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.objectCount = args;
        return args.where.id === objectId && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [
          {
            id: unitId,
            sourceId: '22222222-2222-4222-8222-222222222222',
            objectId,
            externalId: 'flat-1',
            type: FeedUnitType.RESIDENTIAL,
            status: FeedUnitStatus.AVAILABLE,
            title: 'Квартира 1',
            address: 'Москва',
            building: 'Корпус 1',
            section: '1',
            floor: 7,
            rooms: 2,
            price: decimal('10000000'),
            discountPrice: decimal('8000000'),
            effectivePrice: decimal('8000000'),
            currency: 'RUR',
            area: decimal('50'),
            pricePerMeter: decimal('200000'),
            discountPricePerMeter: decimal('160000'),
            effectivePricePerMeter: decimal('160000'),
            completionYear: 2028,
            completionQuarter: 4,
            rawPayload: { externalId: 'flat-1' },
            archivedAt: null,
            residentialDetails: {
              unitId,
              apartmentNumber: '11',
              layoutType: '2k',
              livingArea: decimal('30'),
              kitchenArea: decimal('10'),
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
          },
        ];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.listFeedUnits(objectId, {
    page: '2',
    limit: '5',
    status: 'available',
    type: 'residential',
    search: 'Ifufk',
  });

  assert.deepEqual(calls.objectCount, {
    where: {
      id: objectId,
      deletedAt: null,
    },
  });
  assert.equal(calls.findMany.skip, 5);
  assert.equal(calls.findMany.take, 5);
  assert.equal(calls.findMany.include.media.include.mediaAsset.include.file, true);
  assert.deepEqual(calls.findMany.where.AND[0], { objectId });
  assert.equal(calls.findMany.where.AND.some((filter) => filter.status === FeedUnitStatus.AVAILABLE), true);
  assert.equal(calls.findMany.where.AND.some((filter) => filter.type === FeedUnitType.RESIDENTIAL), true);
  assert.equal(
    calls.findMany.where.AND.some((filter) => filter.OR?.some((item) => item.externalId?.contains === 'шагал')),
    true,
  );
  assert.equal(
    calls.findMany.where.AND.some((filter) => filter.OR?.some((item) => item.externalId?.contains === 'shagal')),
    true,
  );
  assert.equal(result.items[0].price, '10000000');
  assert.equal(result.items[0].discountPrice, '8000000');
  assert.equal(result.items[0].effectivePrice, '8000000');
  assert.equal(result.items[0].area, '50');
  assert.equal(result.items[0].discountPricePerMeter, '160000');
  assert.equal(result.items[0].effectivePricePerMeter, '160000');
  assert.equal(result.hasDiscountPrices, true);
  assert.equal(result.items[0].residentialDetails.livingArea, '30');
  assert.equal(result.items[0].media[0].file.id, '55555555-5555-4555-8555-555555555555');
  assert.equal(result.total, 1);
  assert.equal(result.page, 2);
  assert.equal(result.limit, 5);
  assert.equal(result.totalPages, 1);
});

test('ObjectsService.listFeedUnits calculates discount flag from object scope instead of current page', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const unitId = '55555555-5555-4555-8555-555555555555';
  const now = new Date('2026-05-23T10:00:00.000Z');
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.objectCount = args;
        return 1;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [
          {
            id: unitId,
            sourceId: '22222222-2222-4222-8222-222222222222',
            objectId,
            externalId: 'flat-1',
            type: FeedUnitType.RESIDENTIAL,
            status: FeedUnitStatus.AVAILABLE,
            title: 'Квартира 1',
            address: 'Москва',
            building: 'Корпус 1',
            section: '1',
            floor: 7,
            rooms: 2,
            price: decimal('10000000'),
            discountPrice: null,
            effectivePrice: decimal('10000000'),
            currency: 'RUR',
            area: decimal('50'),
            pricePerMeter: decimal('200000'),
            discountPricePerMeter: null,
            effectivePricePerMeter: decimal('200000'),
            completionYear: 2028,
            completionQuarter: 4,
            rawPayload: { externalId: 'flat-1' },
            archivedAt: null,
            residentialDetails: null,
            commercialDetails: null,
            media: [],
            createdAt: now,
            updatedAt: now,
          },
        ];
      },
      count: async (args) => {
        if (JSON.stringify(args.where).includes('discountPrice')) {
          calls.discountCount = args;
          return 1;
        }

        calls.count = args;
        return 2;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.listFeedUnits(objectId, {
    page: '1',
    limit: '1',
    status: 'booked',
  });

  assert.equal(result.items[0].discountPrice, null);
  assert.equal(result.hasDiscountPrices, true);
  assert.deepEqual(calls.discountCount.where, {
    AND: [
      { objectId },
      {
        source: {
          deletedAt: null,
        },
      },
      {
        discountPrice: {
          not: null,
        },
      },
    ],
  });
});

test('ObjectsService.getFeedUnit returns one feed unit for an object with media', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const unitId = '55555555-5555-4555-8555-555555555555';
  const now = new Date('2026-05-23T10:00:00.000Z');
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.objectCount = args;
        return args.where.id === objectId && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedUnit: {
      findFirst: async (args) => {
        calls.findFirst = args;
        return {
          id: unitId,
          sourceId: '22222222-2222-4222-8222-222222222222',
          objectId,
          externalId: 'flat-1',
          type: FeedUnitType.RESIDENTIAL,
          status: FeedUnitStatus.AVAILABLE,
          title: 'Квартира 1',
          address: 'Москва',
          building: 'Корпус 1',
          section: '1',
          floor: 7,
          rooms: 2,
          price: decimal('10000000'),
          discountPrice: decimal('8000000'),
          effectivePrice: decimal('8000000'),
          currency: 'RUR',
          area: decimal('50'),
          pricePerMeter: decimal('200000'),
          discountPricePerMeter: decimal('160000'),
          effectivePricePerMeter: decimal('160000'),
          completionYear: 2028,
          completionQuarter: 4,
          rawPayload: { externalId: 'flat-1' },
          archivedAt: null,
          residentialDetails: {
            unitId,
            apartmentNumber: '11',
            layoutType: '2k',
            livingArea: decimal('30'),
            kitchenArea: decimal('10'),
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
        };
      },
    },
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.getFeedUnit(objectId, unitId);

  assert.deepEqual(calls.objectCount, {
    where: {
      id: objectId,
      deletedAt: null,
    },
  });
  assert.deepEqual(calls.findFirst.where, {
    id: unitId,
    objectId,
    source: {
      deletedAt: null,
    },
  });
  assert.equal(calls.findFirst.include.media.include.mediaAsset.include.file, true);
  assert.equal(result.unit.id, unitId);
  assert.equal(result.unit.objectId, objectId);
  assert.equal(result.unit.price, '10000000');
  assert.equal(result.unit.discountPrice, '8000000');
  assert.equal(result.unit.effectivePrice, '8000000');
  assert.equal(result.unit.area, '50');
  assert.equal(result.unit.discountPricePerMeter, '160000');
  assert.equal(result.unit.effectivePricePerMeter, '160000');
  assert.equal(result.unit.media[0].file.id, '55555555-5555-4555-8555-555555555555');
});

test('ObjectsService.listFeedUnits accepts comma separated feed unit statuses', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.objectCount = args;
        return args.where.id === objectId && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [];
      },
      count: async (args) => {
        calls.count = args;
        return 0;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.listFeedUnits(objectId, {
    status: 'available,booked,reserved',
  });

  assert.deepEqual(calls.objectCount, {
    where: {
      id: objectId,
      deletedAt: null,
    },
  });
  assert.equal(
    calls.findMany.where.AND.some((filter) =>
      Array.isArray(filter.status?.in) &&
      filter.status.in.includes(FeedUnitStatus.AVAILABLE) &&
      filter.status.in.includes(FeedUnitStatus.BOOKED) &&
      filter.status.in.includes(FeedUnitStatus.RESERVED)
    ),
    true,
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.listFeedUnits filters by numeric ranges rooms floor and completion', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.objectCount = args;
        return args.where.id === objectId && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [];
      },
      count: async (args) => {
        calls.count = args;
        return 0;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.listFeedUnits(objectId, {
    priceMin: '10 000 000',
    priceMax: '12 500 000',
    pricePerMeterMin: '200 000',
    pricePerMeterMax: '300 000',
    areaMin: '42.5',
    areaMax: '76',
    rooms: '5',
    floorMin: '5',
    floorMax: '12',
    completionYear: '2028',
    completionQuarter: '4',
  });

  const filters = calls.findMany.where.AND;

  assert.deepEqual(filters.find((filter) => filter.effectivePrice), {
    effectivePrice: {
      gte: '10000000',
      lte: '12500000',
    },
  });
  assert.deepEqual(filters.find((filter) => filter.effectivePricePerMeter), {
    effectivePricePerMeter: {
      gte: '200000',
      lte: '300000',
    },
  });
  assert.deepEqual(filters.find((filter) => filter.area), {
    area: {
      gte: '42.5',
      lte: '76',
    },
  });
  assert.equal(filters.some((filter) => filter.rooms === 5), true);
  assert.deepEqual(filters.find((filter) => filter.floor), {
    floor: {
      gte: 5,
      lte: 12,
    },
  });
  assert.equal(filters.some((filter) => filter.completionYear === 2028), true);
  assert.equal(filters.some((filter) => filter.completionQuarter === 4), true);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.listFeedUnits filters by several selected rooms', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    realEstateObject: {
      count: async () => 1,
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [];
      },
      count: async (args) => {
        calls.count = args;
        return 0;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.listFeedUnits(objectId, { rooms: '2,3' });

  assert.deepEqual(calls.findMany.where.AND.find((filter) => filter.rooms), {
    rooms: {
      in: [2, 3],
    },
  });
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.listFeedUnits treats Aura separate-room layouts as studios', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.objectCount = args;
        return args.where.id === objectId && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [];
      },
      count: async (args) => {
        calls.count = args;
        return 0;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.listFeedUnits(objectId, { rooms: '0' });

  const roomsFilter = calls.findMany.where.AND.find((filter) => filter.OR?.some((item) => item.rooms === 0));

  assert.deepEqual(roomsFilter, {
    OR: [
      {
        rooms: 0,
      },
      {
        rooms: null,
        residentialDetails: {
          is: {
            layoutType: {
              equals: 'раздельные',
              mode: 'insensitive',
            },
          },
        },
        object: {
          OR: [
            {
              title: {
                contains: 'аура',
                mode: 'insensitive',
              },
            },
            {
              developer: {
                is: {
                  name: {
                    contains: 'мангазея',
                    mode: 'insensitive',
                  },
                },
              },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.listFeedUnits rejects invalid range filters and quarter without year', async () => {
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    realEstateObject: {
      count: async () => 1,
    },
    feedUnit: {
      findMany: async () => [],
      count: async () => 0,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () => service.listFeedUnits(objectId, { priceMin: '12', priceMax: '10' }),
    BadRequestException,
  );
  await assert.rejects(
    () => service.listFeedUnits(objectId, { floorMin: '12', floorMax: '5' }),
    BadRequestException,
  );
  await assert.rejects(
    () => service.listFeedUnits(objectId, { completionQuarter: '4' }),
    BadRequestException,
  );
});

test('ObjectsService.listFeedUnits applies sortable order for feed unit columns', async () => {
  const calls = [];
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.push({ model: 'object', args });
        return 1;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.push({ model: 'feedUnit.findMany', args });
        return [];
      },
      count: async (args) => {
        calls.push({ model: 'feedUnit.count', args });
        return 0;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new ObjectsService(prisma, {});

  await service.listFeedUnits(objectId, {
    sortBy: 'price',
    sortDirection: 'desc',
  });
  await service.listFeedUnits(objectId, {
    sortBy: 'discountPrice',
    sortDirection: 'asc',
  });
  await service.listFeedUnits(objectId, {
    sortBy: 'pricePerMeter',
    sortDirection: 'asc',
  });
  await service.listFeedUnits(objectId, {
    sortBy: 'area',
    sortDirection: 'asc',
  });
  await service.listFeedUnits(objectId, {
    sortBy: 'building',
    sortDirection: 'desc',
  });

  const orderByCalls = calls.filter((call) => call.model === 'feedUnit.findMany').map((call) => call.args.orderBy);

  assert.deepEqual(orderByCalls[0], [
    { effectivePrice: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(orderByCalls[1], [
    { effectivePrice: { sort: 'asc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(orderByCalls[2], [
    { effectivePricePerMeter: { sort: 'asc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(orderByCalls[3], [
    { area: { sort: 'asc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.deepEqual(orderByCalls[4], [
    { building: { sort: 'desc', nulls: 'last' } },
    { section: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
});

test('ObjectsService.listFeedUnitGroups returns completion and room groups across all filtered units', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const now = new Date('2026-05-23T10:00:00.000Z');
  const makeUnit = (overrides) => ({
    id: overrides.id,
    sourceId: '22222222-2222-4222-8222-222222222222',
    objectId,
    externalId: overrides.externalId ?? overrides.id,
    type: overrides.type ?? FeedUnitType.RESIDENTIAL,
    status: overrides.status ?? FeedUnitStatus.AVAILABLE,
    title: overrides.title ?? null,
    address: null,
    building: overrides.building ?? null,
    section: overrides.section ?? null,
    floor: overrides.floor ?? null,
    rooms: overrides.rooms ?? null,
    price: overrides.price ? decimal(overrides.price) : null,
    discountPrice: null,
    effectivePrice: overrides.effectivePrice ? decimal(overrides.effectivePrice) : null,
    currency: 'RUR',
    area: overrides.area ? decimal(overrides.area) : null,
    pricePerMeter: null,
    discountPricePerMeter: null,
    effectivePricePerMeter: overrides.effectivePricePerMeter ? decimal(overrides.effectivePricePerMeter) : null,
    completionYear: overrides.completionYear ?? null,
    completionQuarter: overrides.completionQuarter ?? null,
    rawPayload: {},
    archivedAt: null,
    residentialDetails: null,
    commercialDetails: null,
    media: [],
    createdAt: now,
    updatedAt: now,
  });
  const units = [
    makeUnit({
      id: '55555555-5555-4555-8555-555555555551',
      title: 'Квартира 1',
      building: 'Корпус 2',
      rooms: 2,
      area: '58.4',
      effectivePrice: '12000000',
      completionYear: 2027,
      completionQuarter: 3,
    }),
    makeUnit({
      id: '55555555-5555-4555-8555-555555555552',
      title: 'Квартира 2',
      building: 'Корпус 10',
      rooms: 2,
      area: '62.1',
      effectivePrice: '14000000',
      completionYear: 2027,
      completionQuarter: 3,
    }),
    makeUnit({
      id: '55555555-5555-4555-8555-555555555553',
      title: 'Студия',
      building: 'Корпус 1',
      rooms: 0,
      area: '28',
      effectivePrice: '7000000',
      completionYear: 2027,
      completionQuarter: 3,
    }),
    makeUnit({
      id: '55555555-5555-4555-8555-555555555554',
      title: 'Офис',
      type: FeedUnitType.COMMERCIAL,
      building: null,
      rooms: null,
      area: '80',
      effectivePrice: '20000000',
      completionYear: 2028,
      completionQuarter: null,
    }),
    makeUnit({
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Без срока',
      building: null,
      rooms: null,
      area: null,
      effectivePrice: null,
      completionYear: null,
      completionQuarter: null,
    }),
  ];
  const prisma = {
    realEstateObject: {
      count: async (args) => {
        calls.objectCount = args;
        return args.where.id === objectId && args.where.deletedAt === null ? 1 : 0;
      },
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return units;
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.listFeedUnitGroups(objectId, {
    status: 'available,reserved',
    priceMin: '5 000 000',
    sortBy: 'price',
    sortDirection: 'desc',
  });

  assert.deepEqual(calls.objectCount, {
    where: {
      id: objectId,
      deletedAt: null,
    },
  });
  assert.equal(calls.findMany.skip, undefined);
  assert.equal(calls.findMany.take, undefined);
  assert.equal(calls.findMany.include.media.include.mediaAsset.include.file, true);
  assert.deepEqual(calls.findMany.orderBy, [
    { effectivePrice: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
  assert.equal(calls.findMany.where.AND.some((filter) => filter.effectivePrice?.gte === '5000000'), true);
  assert.deepEqual(result.groups.map((group) => group.label), ['3 кв. 2027', '2028', 'Срок не указан']);
  assert.deepEqual(result.groups[0].buildings, ['Корпус 1', 'Корпус 2', 'Корпус 10']);
  assert.equal(result.groups[0].total, 3);
  assert.deepEqual(result.groups[0].roomGroups.map((group) => group.label), ['Студии', '2-к.кв']);
  assert.deepEqual(result.groups[0].roomGroups[1], {
    key: 'rooms-2',
    label: '2-к.кв',
    total: 2,
    areaMin: '58.4',
    areaMax: '62.1',
    priceMin: '12000000',
    priceMax: '14000000',
    items: [result.groups[0].roomGroups[1].items[0], result.groups[0].roomGroups[1].items[1]],
  });
  assert.deepEqual(result.groups[1].roomGroups.map((group) => group.label), ['Коммерция']);
  assert.deepEqual(result.groups[2].buildings, []);
  assert.deepEqual(result.groups[2].roomGroups.map((group) => group.label), ['Тип не указан']);
  assert.equal(result.total, 5);
  assert.equal(result.hasDiscountPrices, true);
});

test('ObjectsService.listFeedUnitGroups applies room and completion filters before grouping', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    realEstateObject: {
      count: async () => 1,
    },
    feedUnit: {
      findMany: async (args) => {
        calls.findMany = args;
        return [];
      },
      count: async (args) => {
        calls.count = args;
        return 0;
      },
    },
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.listFeedUnitGroups(objectId, {
    rooms: '0,3',
    completionYear: '2028',
    completionQuarter: '4',
  });

  const filters = calls.findMany.where.AND;

  assert.deepEqual(filters.find((filter) => filter.OR?.some((item) => item.rooms === 0)), {
    OR: [
      {
        rooms: 3,
      },
      {
        rooms: 0,
      },
      {
        rooms: null,
        residentialDetails: {
          is: {
            layoutType: {
              equals: 'раздельные',
              mode: 'insensitive',
            },
          },
        },
        object: {
          OR: [
            {
              title: {
                contains: 'аура',
                mode: 'insensitive',
              },
            },
            {
              developer: {
                is: {
                  name: {
                    contains: 'мангазея',
                    mode: 'insensitive',
                  },
                },
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(filters.some((filter) => filter.completionYear === 2028), true);
  assert.equal(filters.some((filter) => filter.completionQuarter === 4), true);
  assert.equal(result.total, 0);
});

test('MapService.listObjects serializes all map gallery images for popup previews', async () => {
  const coverImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    fileId: '55555555-5555-4555-8555-555555555555',
    isCover: true,
    sortOrder: 0,
    title: 'Обложка',
  });
  const galleryImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '77777777-7777-4777-8777-777777777777',
    sortOrder: 1,
    title: 'Галерея',
  });
  const mapObject = objectRecord({
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
    images: [coverImage, galleryImage],
  });
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        assert.equal(args.include.images.take, undefined);
        return [mapObject];
      },
      count: async () => 1,
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  const result = await service.listObjects({});

  assert.equal(result.items[0].coverImage.id, coverImage.id);
  assert.deepEqual(
    result.items[0].images.map((image) => [image.id, image.file.id, image.title]),
    [
      [coverImage.id, coverImage.file.id, 'Обложка'],
      [galleryImage.id, galleryImage.file.id, 'Галерея'],
    ],
  );
});

test('MapService.listObjects filters krtName by exact case-insensitive trimmed value', async () => {
  const calls = {};
  const mapObject = objectRecord({
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
    krtName: 'Большое Сити',
  });
  const prisma = {
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [mapObject];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  await service.listObjects({ krtName: '  большое сити  ' });

  const filters = calls.findMany.where.AND;
  assert.equal(
    filters.some((filter) => filter.krtName?.equals === 'большое сити' && filter.krtName?.mode === 'insensitive'),
    true,
  );
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('MapService.listObjects uses dot-insensitive search for map catalog objects', async () => {
  const calls = {};
  const objectId = '11111111-1111-4111-8111-111111111111';
  const mapObject = objectRecord({
    id: objectId,
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
  });
  const prisma = {
    $queryRaw: async (query) => {
      calls.searchQuery = query;
      return [{ id: objectId }];
    },
    realEstateObject: {
      findMany: async (args) => {
        calls.findMany = args;
        return [mapObject];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new MapService(prisma);

  await service.listObjects({ search: ' ж.к. Ари ' });

  assert.equal(calls.searchQuery.values.includes('%жк ари%'), true);
  assert.equal(calls.searchQuery.values.includes('%zhk ari%'), true);
  assert.equal(calls.findMany.where.AND.some((filter) => filter.id?.in?.includes(objectId)), true);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(o\.title, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(d\.name, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(o\.address, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /object_locations ol/);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('ObjectsService.create rejects incomplete coordinate pairs before writing an object', async () => {
  const prisma = {
    realEstateObject: {
      findUnique: async () => null,
      create: async () => assert.fail('Object must not be created with incomplete coordinates'),
    },
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () => service.create({ title: 'ЖК Координаты', latitude: '55.1' }, actor, request),
    BadRequestException,
  );
});

test('ObjectsService.create saves manual detail parameters and serializes them', async () => {
  const manualDetailParameters = {
    krtName: 'Большое Сити',
    apartmentAreaRange: 'От 35 м²',
    ceilingHeight: '3,1 метра',
    propertyClass: 'Премиум-класс',
    floorRange: '8 - 25 этажей',
    apartmentsCountText: '672 квартиры',
  };
  const calls = {};
  const createdObject = objectRecord(manualDetailParameters);
  const prisma = {
    realEstateObject: {
      findUnique: async () => null,
      create: async (args) => {
        calls.create = args;

        return objectRecord({ id: createdObject.id });
      },
      findFirst: async () => createdObject,
    },
    objectLocation: {
      deleteMany: async () => {},
    },
    objectMetroStation: {
      deleteMany: async () => {},
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.create(
    {
      title: 'ЖК Большое Сити',
      ...manualDetailParameters,
    },
    actor,
    request,
  );

  assert.equal(calls.create.data.krtName, manualDetailParameters.krtName);
  assert.equal(calls.create.data.apartmentAreaRange, manualDetailParameters.apartmentAreaRange);
  assert.equal(calls.create.data.ceilingHeight, manualDetailParameters.ceilingHeight);
  assert.equal(calls.create.data.propertyClass, manualDetailParameters.propertyClass);
  assert.equal(calls.create.data.floorRange, manualDetailParameters.floorRange);
  assert.equal(calls.create.data.apartmentsCountText, manualDetailParameters.apartmentsCountText);
  assert.equal(result.object.krtName, manualDetailParameters.krtName);
  assert.equal(result.object.apartmentAreaRange, manualDetailParameters.apartmentAreaRange);
  assert.equal(result.object.ceilingHeight, manualDetailParameters.ceilingHeight);
  assert.equal(result.object.propertyClass, manualDetailParameters.propertyClass);
  assert.equal(result.object.floorRange, manualDetailParameters.floorRange);
  assert.equal(result.object.apartmentsCountText, manualDetailParameters.apartmentsCountText);
});

test('ObjectsService.create saves content sections and serializes them', async () => {
  const contentSections = {
    architectureDescription: 'Архитектура корпуса',
    infrastructureDescription: 'Инфраструктура квартала',
    fillingDescription: 'Наполнение апартаментов',
  };
  const calls = {};
  const createdObject = objectRecord(contentSections);
  const prisma = {
    realEstateObject: {
      findUnique: async () => null,
      create: async (args) => {
        calls.create = args;

        return objectRecord({ id: createdObject.id });
      },
      findFirst: async () => createdObject,
    },
    objectLocation: {
      deleteMany: async () => {},
    },
    objectMetroStation: {
      deleteMany: async () => {},
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.create(
    {
      title: 'ЖК Содержательный',
      ...contentSections,
    },
    actor,
    request,
  );

  assert.equal(calls.create.data.architectureDescription, contentSections.architectureDescription);
  assert.equal(calls.create.data.infrastructureDescription, contentSections.infrastructureDescription);
  assert.equal(calls.create.data.fillingDescription, contentSections.fillingDescription);
  assert.equal(result.object.architectureDescription, contentSections.architectureDescription);
  assert.equal(result.object.infrastructureDescription, contentSections.infrastructureDescription);
  assert.equal(result.object.fillingDescription, contentSections.fillingDescription);
  assert.equal(calls.auditLog.data.metadata.after.architectureDescription, contentSections.architectureDescription);
  assert.equal(calls.auditLog.data.metadata.after.infrastructureDescription, contentSections.infrastructureDescription);
  assert.equal(calls.auditLog.data.metadata.after.fillingDescription, contentSections.fillingDescription);
});

test('ObjectsService.update clears empty manual detail parameters', async () => {
  const calls = {};
  const existingObject = objectRecord({
    krtName: 'Большое Сити',
    apartmentAreaRange: 'От 35 м²',
    ceilingHeight: '3,1 метра',
    propertyClass: 'Премиум-класс',
    floorRange: '8 - 25 этажей',
    apartmentsCountText: '672 квартиры',
  });
  const updatedObject = objectRecord({
    krtName: null,
    apartmentAreaRange: null,
    ceilingHeight: null,
    propertyClass: null,
    floorRange: null,
    apartmentsCountText: null,
  });
  let findFirstCount = 0;
  const prisma = {
    realEstateObject: {
      findFirst: async () => {
        findFirstCount += 1;

        return findFirstCount === 1 ? existingObject : updatedObject;
      },
      update: async (args) => {
        calls.update = args;

        return updatedObject;
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  await service.update(
    existingObject.id,
    {
      krtName: '',
      apartmentAreaRange: '',
      ceilingHeight: '',
      propertyClass: '',
      floorRange: '',
      apartmentsCountText: '',
    },
    actor,
    request,
  );

  assert.ok(calls.update, 'Object update must be called for cleared manual detail parameters');
  assert.equal(calls.update.data.krtName, null);
  assert.equal(calls.update.data.apartmentAreaRange, null);
  assert.equal(calls.update.data.ceilingHeight, null);
  assert.equal(calls.update.data.propertyClass, null);
  assert.equal(calls.update.data.floorRange, null);
  assert.equal(calls.update.data.apartmentsCountText, null);
});

test('ObjectsService.update saves and clears map name', async () => {
  const calls = {};
  const existingObject = objectRecord({
    mapName: null,
  });
  const updatedObject = objectRecord({
    mapName: 'Ария',
  });
  let findFirstCount = 0;
  const prisma = {
    realEstateObject: {
      findFirst: async () => {
        findFirstCount += 1;

        return findFirstCount === 1 ? existingObject : updatedObject;
      },
      update: async (args) => {
        calls.update = args;

        return updatedObject;
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.update(existingObject.id, { mapName: ' Ария ' }, actor, request);

  assert.ok(calls.update, 'Object update must be called for map name');
  assert.equal(calls.update.data.mapName, 'Ария');
  assert.equal(result.object.mapName, 'Ария');
  assert.deepEqual(calls.auditLog.data.metadata.changes.mapName, { from: null, to: 'Ария' });

  const clearedCalls = {};
  const objectWithMapName = objectRecord({
    mapName: 'Ария',
  });
  const clearedObject = objectRecord({
    mapName: null,
  });
  let clearFindFirstCount = 0;
  const clearPrisma = {
    realEstateObject: {
      findFirst: async () => {
        clearFindFirstCount += 1;

        return clearFindFirstCount === 1 ? objectWithMapName : clearedObject;
      },
      update: async (args) => {
        clearedCalls.update = args;

        return clearedObject;
      },
    },
    auditLog: {
      create: async (args) => {
        clearedCalls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(clearPrisma),
  };
  const clearService = new ObjectsService(clearPrisma, {});

  const clearedResult = await clearService.update(objectWithMapName.id, { mapName: '' }, actor, request);

  assert.ok(clearedCalls.update, 'Object update must be called for cleared map name');
  assert.equal(clearedCalls.update.data.mapName, null);
  assert.equal(clearedResult.object.mapName, null);
});

test('ObjectsService.update rejects too long map name', async () => {
  const prisma = {
    realEstateObject: {
      findFirst: async () => objectRecord(),
      update: async () => assert.fail('Object must not be updated with too long map name'),
    },
    auditLog: {
      create: async () => assert.fail('Audit log must not be written for invalid map name'),
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () => service.update('11111111-1111-4111-8111-111111111111', { mapName: 'Слишком длинное имя' }, actor, request),
    /Map name is too long/,
  );
});

test('ObjectsService.update clears empty content sections', async () => {
  const calls = {};
  const existingObject = objectRecord({
    architectureDescription: 'Архитектура корпуса',
    infrastructureDescription: 'Инфраструктура квартала',
    fillingDescription: 'Наполнение апартаментов',
  });
  const updatedObject = objectRecord({
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
  });
  let findFirstCount = 0;
  const prisma = {
    realEstateObject: {
      findFirst: async () => {
        findFirstCount += 1;

        return findFirstCount === 1 ? existingObject : updatedObject;
      },
      update: async (args) => {
        calls.update = args;

        return updatedObject;
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  await service.update(
    existingObject.id,
    {
      architectureDescription: '',
      infrastructureDescription: '',
      fillingDescription: '',
    },
    actor,
    request,
  );

  assert.ok(calls.update, 'Object update must be called for cleared content sections');
  assert.equal(calls.update.data.architectureDescription, null);
  assert.equal(calls.update.data.infrastructureDescription, null);
  assert.equal(calls.update.data.fillingDescription, null);
  assert.deepEqual(calls.auditLog.data.metadata.changes.architectureDescription, {
    from: 'Архитектура корпуса',
    to: null,
  });
  assert.deepEqual(calls.auditLog.data.metadata.changes.infrastructureDescription, {
    from: 'Инфраструктура квартала',
    to: null,
  });
  assert.deepEqual(calls.auditLog.data.metadata.changes.fillingDescription, {
    from: 'Наполнение апартаментов',
    to: null,
  });
});

test('ObjectsService.update allows fixing coordinates on already incomplete published imported objects', async () => {
  const calls = {};
  const district = locationRecord({
    id: 'cc0580d8-a670-47ff-8f10-d5c4d2522184',
  });
  const locationLink = {
    objectId: '11111111-1111-4111-8111-111111111111',
    locationId: district.id,
    isPrimary: true,
    sortOrder: 0,
    location: district,
  };
  const existingObject = objectRecord({
    status: ObjectStatus.PUBLISHED,
    developerId: 'f114fdfc-0478-47c8-a1ed-e614a8499108',
    primaryLocationId: district.id,
    primaryLocation: district,
    locations: [locationLink],
    address: null,
    latitude: decimal('59.841541'),
    longitude: decimal('30.225039'),
    completionYear: 2025,
  });
  const updatedObject = objectRecord({
    ...existingObject,
    latitude: decimal('55.761614'),
    longitude: decimal('37.64136'),
  });
  let findFirstCount = 0;
  const prisma = {
    realEstateObject: {
      findFirst: async () => {
        findFirstCount += 1;

        return findFirstCount === 1 ? existingObject : updatedObject;
      },
      update: async (args) => {
        calls.update = args;

        return updatedObject;
      },
    },
    location: {
      findMany: async (args) => {
        calls.locationFindMany = args;

        return [district];
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.update(
    existingObject.id,
    {
      latitude: '55.761614',
      longitude: '37.64136',
    },
    actor,
    request,
  );

  assert.ok(calls.update, 'Object update must be called for coordinate fixes');
  assert.equal(calls.update.data.latitude, '55.761614');
  assert.equal(calls.update.data.longitude, '37.64136');
  assert.equal(result.object.latitude, 55.761614);
  assert.deepEqual(calls.auditLog.data.metadata.changes.latitude, {
    from: '59.841541',
    to: '55.761614',
  });
});

test('ObjectsService.create rejects too long manual detail parameters', async () => {
  const createService = () => {
    const prisma = {
      realEstateObject: {
        findUnique: async () => null,
        create: async () => objectRecord(),
        findFirst: async () => objectRecord(),
      },
      objectLocation: {
        deleteMany: async () => {},
      },
      objectMetroStation: {
        deleteMany: async () => {},
      },
      auditLog: {
        create: async () => {},
      },
      $transaction: async (callback) => callback(prisma),
    };

    return new ObjectsService(prisma, {});
  };

  await assert.rejects(
    () =>
      createService().create(
        {
          title: 'ЖК Длинное КРТ',
          krtName: 'а'.repeat(241),
        },
        actor,
        request,
      ),
    BadRequestException,
  );

  await assert.rejects(
    () =>
      createService().create(
        {
          title: 'ЖК Длинная высота',
          ceilingHeight: 'а'.repeat(121),
        },
        actor,
        request,
      ),
    BadRequestException,
  );
});

test('ObjectsService.create rejects too long content sections', async () => {
  const createService = () => {
    const prisma = {
      realEstateObject: {
        findUnique: async () => null,
        create: async () => objectRecord(),
        findFirst: async () => objectRecord(),
      },
      objectLocation: {
        deleteMany: async () => {},
      },
      objectMetroStation: {
        deleteMany: async () => {},
      },
      auditLog: {
        create: async () => {},
      },
      $transaction: async (callback) => callback(prisma),
    };

    return new ObjectsService(prisma, {});
  };

  await assert.rejects(
    () =>
      createService().create(
        {
          title: 'ЖК Длинная архитектура',
          architectureDescription: 'а'.repeat(10001),
        },
        actor,
        request,
      ),
    BadRequestException,
  );
});

test('ObjectsService.publish validates required fields and logs successful publication', async () => {
  const draftObject = objectRecord({
    developerId: '55555555-5555-4555-8555-555555555555',
    primaryLocationId: '66666666-6666-4666-8666-666666666666',
    address: 'Екатеринбург, ул. Ленина, 1',
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
    completionYear: 2027,
    completionQuarter: 2,
  });
  const publishedObject = objectRecord({
    ...draftObject,
    status: ObjectStatus.PUBLISHED,
    publishedAt: new Date('2026-05-02T10:00:00.000Z'),
  });
  const calls = {};
  const prisma = {
    realEstateObject: {
      findFirst: async (args) => {
        calls.findFirst = args;
        return draftObject;
      },
      update: async (args) => {
        calls.update = args;
        return publishedObject;
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.publish(draftObject.id, actor, request);

  assert.equal(result.object.status, ObjectStatus.PUBLISHED);
  assert.equal(result.object.latitude, 55.751244);
  assert.equal(calls.findFirst.where.deletedAt, null);
  assert.equal(calls.update.data.status, ObjectStatus.PUBLISHED);
  assert.equal(calls.update.data.publishedAt instanceof Date, true);
  assert.equal(calls.auditLog.data.action, 'object.publish');
  assert.equal(calls.auditLog.data.ipAddress, '127.0.0.1');
});

test('ObjectsService.publish rejects objects without coordinates', async () => {
  const service = new ObjectsService(
    {
      realEstateObject: {
        findFirst: async () =>
          objectRecord({
            developerId: '55555555-5555-4555-8555-555555555555',
            primaryLocationId: '66666666-6666-4666-8666-666666666666',
            address: 'Екатеринбург, ул. Ленина, 1',
            completionYear: 2027,
          }),
      },
    },
    {},
  );

  await assert.rejects(
    () => service.publish('11111111-1111-4111-8111-111111111111', actor, request),
    /Missing fields: coordinates/,
  );
});

test('ObjectsService.updateStatus publishes through existing publication checks', async () => {
  const draftObject = objectRecord({
    developerId: '55555555-5555-4555-8555-555555555555',
    primaryLocationId: '66666666-6666-4666-8666-666666666666',
    address: 'Екатеринбург, ул. Ленина, 1',
    latitude: decimal('55.751244'),
    longitude: decimal('37.618423'),
    completionYear: 2027,
    completionQuarter: 2,
  });
  const publishedObject = objectRecord({
    ...draftObject,
    status: ObjectStatus.PUBLISHED,
    publishedAt: new Date('2026-05-02T10:00:00.000Z'),
  });
  const calls = {};
  const prisma = {
    realEstateObject: {
      findFirst: async (args) => {
        calls.findFirst = args;
        return draftObject;
      },
      update: async (args) => {
        calls.update = args;
        return publishedObject;
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.updateStatus(draftObject.id, { status: ObjectStatus.PUBLISHED }, actor, request);

  assert.equal(result.object.status, ObjectStatus.PUBLISHED);
  assert.equal(calls.update.data.status, ObjectStatus.PUBLISHED);
  assert.equal(calls.update.data.publishedAt instanceof Date, true);
  assert.equal(calls.auditLog.data.action, 'object.publish');
});

test('ObjectsService.updateStatus archives without clearing publishedAt or requiring publish fields', async () => {
  const publishedAt = new Date('2026-05-02T10:00:00.000Z');
  const incompleteObject = objectRecord({
    status: ObjectStatus.PUBLISHED,
    publishedAt,
    developerId: null,
    primaryLocationId: null,
    address: null,
    latitude: null,
    longitude: null,
    completionYear: null,
    completionQuarter: null,
  });
  const archivedObject = objectRecord({
    ...incompleteObject,
    status: ObjectStatus.ARCHIVED,
  });
  const calls = {};
  const prisma = {
    realEstateObject: {
      findFirst: async (args) => {
        calls.findFirst = args;
        return incompleteObject;
      },
      update: async (args) => {
        calls.update = args;
        return archivedObject;
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.updateStatus(incompleteObject.id, { status: ObjectStatus.ARCHIVED }, actor, request);

  assert.equal(result.object.status, ObjectStatus.ARCHIVED);
  assert.equal(calls.update.data.status, ObjectStatus.ARCHIVED);
  assert.equal('publishedAt' in calls.update.data, false);
  assert.equal(calls.auditLog.data.action, 'object.archive');
  assert.equal(calls.auditLog.data.metadata.before.publishedAt, publishedAt.toISOString());
  assert.equal(calls.auditLog.data.metadata.after.publishedAt, publishedAt.toISOString());
});

test('ObjectsService.updateStatus rejects draft status in quick status endpoint', async () => {
  const service = new ObjectsService(
    {
      realEstateObject: {
        findFirst: async () => assert.fail('Object lookup should not run for invalid status'),
      },
    },
    {},
  );

  await assert.rejects(
    () => service.updateStatus('11111111-1111-4111-8111-111111111111', { status: ObjectStatus.DRAFT }, actor, request),
    /Status must be PUBLISHED or ARCHIVED/,
  );
});

test('ObjectsService.updateGalleryLayout assigns cover and image order', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    fileId: '55555555-5555-4555-8555-555555555555',
    sortOrder: 0,
    isCover: true,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
  });
  const thirdImage = objectImageRecord({
    id: '44444444-4444-4444-8444-444444444444',
    fileId: '77777777-7777-4777-8777-777777777777',
    sortOrder: 2,
  });
  const calls = {
    updates: [],
  };
  const updatedObject = objectRecord({
    images: [
      { ...secondImage, sortOrder: 0, isCover: false },
      { ...firstImage, sortOrder: 1, isCover: false },
      { ...thirdImage, sortOrder: 2, isCover: true },
    ],
  });
  let findFirstCount = 0;
  const prisma = {
    realEstateObject: {
      findFirst: async () => {
        findFirstCount += 1;

        return findFirstCount === 1
          ? objectRecord({ images: [firstImage, secondImage, thirdImage] })
          : updatedObject;
      },
    },
    objectImage: {
      update: async (args) => {
        calls.updates.push(args);
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.updateGalleryLayout(
    '11111111-1111-4111-8111-111111111111',
    {
      imageIds: [secondImage.id, firstImage.id, thirdImage.id],
      coverImageId: thirdImage.id,
    },
    actor,
    request,
  );

  assert.deepEqual(
    calls.updates.map((call) => [call.where.id, call.data.sortOrder, call.data.isCover]),
    [
      [secondImage.id, 0, false],
      [firstImage.id, 1, false],
      [thirdImage.id, 2, true],
    ],
  );
  assert.deepEqual(
    result.object.images.map((image) => [image.id, image.sortOrder, image.isCover]),
    [
      [secondImage.id, 0, false],
      [firstImage.id, 1, false],
      [thirdImage.id, 2, true],
    ],
  );
  assert.equal(calls.auditLog.data.action, 'object.gallery.layout');
  assert.deepEqual(calls.auditLog.data.metadata.before, {
    imageIds: [firstImage.id, secondImage.id, thirdImage.id],
    coverImageId: firstImage.id,
  });
  assert.deepEqual(calls.auditLog.data.metadata.after, {
    imageIds: [secondImage.id, firstImage.id, thirdImage.id],
    coverImageId: thirdImage.id,
  });
});

test('ObjectsService.updateGalleryLayout updates image sections without order or cover changes', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    fileId: '55555555-5555-4555-8555-555555555555',
    sortOrder: 0,
    isCover: true,
    section: null,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
    section: ObjectImageSection.INTERIORS,
  });
  const calls = {
    updates: [],
  };
  const updatedObject = objectRecord({
    images: [
      { ...firstImage, section: ObjectImageSection.ARCHITECTURE },
      { ...secondImage, section: null },
    ],
  });
  let findFirstCount = 0;
  const prisma = {
    realEstateObject: {
      findFirst: async () => {
        findFirstCount += 1;

        return findFirstCount === 1
          ? objectRecord({ images: [firstImage, secondImage] })
          : updatedObject;
      },
    },
    objectImage: {
      update: async (args) => {
        calls.updates.push(args);
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  const result = await service.updateGalleryLayout(
    '11111111-1111-4111-8111-111111111111',
    {
      imageIds: [firstImage.id, secondImage.id],
      coverImageId: firstImage.id,
      imageSections: {
        [firstImage.id]: ObjectImageSection.ARCHITECTURE,
        [secondImage.id]: null,
      },
    },
    actor,
    request,
  );

  assert.deepEqual(
    calls.updates.map((call) => [call.where.id, call.data.section]),
    [
      [firstImage.id, ObjectImageSection.ARCHITECTURE],
      [secondImage.id, null],
    ],
  );
  assert.deepEqual(
    result.object.images.map((image) => [image.id, image.section]),
    [
      [firstImage.id, ObjectImageSection.ARCHITECTURE],
      [secondImage.id, null],
    ],
  );
  assert.deepEqual(calls.auditLog.data.metadata.before, {
    imageIds: [firstImage.id, secondImage.id],
    coverImageId: firstImage.id,
    imageSections: {
      [firstImage.id]: null,
      [secondImage.id]: ObjectImageSection.INTERIORS,
    },
  });
  assert.deepEqual(calls.auditLog.data.metadata.after, {
    imageIds: [firstImage.id, secondImage.id],
    coverImageId: firstImage.id,
    imageSections: {
      [firstImage.id]: ObjectImageSection.ARCHITECTURE,
      [secondImage.id]: null,
    },
  });
});

test('ObjectsService.updateGalleryLayout preserves image sections when omitted', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    fileId: '55555555-5555-4555-8555-555555555555',
    sortOrder: 0,
    isCover: true,
    section: ObjectImageSection.ARCHITECTURE,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
    section: ObjectImageSection.INTERIORS,
  });
  const calls = {
    updates: [],
  };
  const updatedObject = objectRecord({
    images: [
      { ...secondImage, sortOrder: 0, isCover: false },
      { ...firstImage, sortOrder: 1, isCover: true },
    ],
  });
  let findFirstCount = 0;
  const prisma = {
    realEstateObject: {
      findFirst: async () => {
        findFirstCount += 1;

        return findFirstCount === 1
          ? objectRecord({ images: [firstImage, secondImage] })
          : updatedObject;
      },
    },
    objectImage: {
      update: async (args) => {
        calls.updates.push(args);
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  const service = new ObjectsService(prisma, {});

  await service.updateGalleryLayout(
    '11111111-1111-4111-8111-111111111111',
    {
      imageIds: [secondImage.id, firstImage.id],
      coverImageId: firstImage.id,
    },
    actor,
    request,
  );

  assert.deepEqual(
    calls.updates.map((call) => call.data.section),
    [undefined, undefined],
  );
  assert.equal('imageSections' in calls.auditLog.data.metadata.before, false);
  assert.equal('imageSections' in calls.auditLog.data.metadata.after, false);
});

test('ObjectsService.updateGalleryLayout rejects image sections with unknown image ids', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    isCover: true,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
  });
  const prisma = {
    realEstateObject: {
      findFirst: async () => objectRecord({ images: [firstImage, secondImage] }),
    },
    objectImage: {
      update: async () => assert.fail('Gallery layout must not update unknown section image ids'),
    },
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () =>
      service.updateGalleryLayout(
        '11111111-1111-4111-8111-111111111111',
        {
          imageIds: [firstImage.id, secondImage.id],
          coverImageId: firstImage.id,
          imageSections: {
            [firstImage.id]: ObjectImageSection.ARCHITECTURE,
            '44444444-4444-4444-8444-444444444444': ObjectImageSection.FILLING,
          },
        },
        actor,
        request,
      ),
    BadRequestException,
  );
});

test('ObjectsService.updateGalleryLayout rejects invalid image sections', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    isCover: true,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
  });
  const prisma = {
    realEstateObject: {
      findFirst: async () => objectRecord({ images: [firstImage, secondImage] }),
    },
    objectImage: {
      update: async () => assert.fail('Gallery layout must not update invalid image sections'),
    },
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () =>
      service.updateGalleryLayout(
        '11111111-1111-4111-8111-111111111111',
        {
          imageIds: [firstImage.id, secondImage.id],
          coverImageId: firstImage.id,
          imageSections: {
            [firstImage.id]: 'AMENITIES',
            [secondImage.id]: ObjectImageSection.INTERIORS,
          },
        },
        actor,
        request,
      ),
    BadRequestException,
  );
});

test('ObjectsService.updateGalleryLayout rejects incomplete image ids', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    isCover: true,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
  });
  const prisma = {
    realEstateObject: {
      findFirst: async () => objectRecord({ images: [firstImage, secondImage] }),
    },
    objectImage: {
      update: async () => assert.fail('Gallery layout must not update incomplete image ids'),
    },
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () =>
      service.updateGalleryLayout(
        '11111111-1111-4111-8111-111111111111',
        {
          imageIds: [firstImage.id],
          coverImageId: firstImage.id,
        },
        actor,
        request,
      ),
    BadRequestException,
  );
});

test('ObjectsService.updateGalleryLayout rejects extra image ids', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    isCover: true,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
  });
  const prisma = {
    realEstateObject: {
      findFirst: async () => objectRecord({ images: [firstImage, secondImage] }),
    },
    objectImage: {
      update: async () => assert.fail('Gallery layout must not update extra image ids'),
    },
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () =>
      service.updateGalleryLayout(
        '11111111-1111-4111-8111-111111111111',
        {
          imageIds: [
            firstImage.id,
            secondImage.id,
            '44444444-4444-4444-8444-444444444444',
          ],
          coverImageId: firstImage.id,
        },
        actor,
        request,
      ),
    BadRequestException,
  );
});

test('ObjectsService.updateGalleryLayout rejects cover image outside layout ids', async () => {
  const firstImage = objectImageRecord({
    id: '22222222-2222-4222-8222-222222222222',
    isCover: true,
  });
  const secondImage = objectImageRecord({
    id: '33333333-3333-4333-8333-333333333333',
    fileId: '66666666-6666-4666-8666-666666666666',
    sortOrder: 1,
  });
  const prisma = {
    realEstateObject: {
      findFirst: async () => objectRecord({ images: [firstImage, secondImage] }),
    },
    objectImage: {
      update: async () => assert.fail('Gallery layout must not update an invalid cover'),
    },
  };
  const service = new ObjectsService(prisma, {});

  await assert.rejects(
    () =>
      service.updateGalleryLayout(
        '11111111-1111-4111-8111-111111111111',
        {
          imageIds: [firstImage.id, secondImage.id],
          coverImageId: '44444444-4444-4444-8444-444444444444',
        },
        actor,
        request,
      ),
    BadRequestException,
  );
});

test('UsersService.list builds filters for search, status and role', async () => {
  const calls = {};
  const prisma = {
    user: {
      findMany: async (args) => {
        calls.findMany = args;
        return [userRecord({ status: UserStatus.BLOCKED })];
      },
      count: async (args) => {
        calls.count = args;
        return 1;
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
  const service = new UsersService(prisma);

  const result = await service.list({
    page: '3',
    limit: '10',
    search: 'Ifufk',
    status: 'blocked',
    roleId: '44444444-4444-4444-8444-444444444444',
  });

  assert.equal(result.total, 1);
  assert.equal(result.page, 3);
  assert.equal(result.limit, 10);
  assert.equal(calls.findMany.skip, 20);
  assert.equal(calls.findMany.take, 10);
  assert.equal(calls.findMany.where.status, UserStatus.BLOCKED);
  assert.equal(calls.findMany.where.roleId, '44444444-4444-4444-8444-444444444444');
  assert.equal(calls.findMany.where.OR.some((filter) => filter.email?.contains === 'шагал'), true);
  assert.equal(calls.findMany.where.OR.some((filter) => filter.name?.contains === 'shagal'), true);
  assert.deepEqual(calls.count.where, calls.findMany.where);
});

test('UsersService.create rejects duplicate emails', async () => {
  const prisma = {
    role: {
      findUnique: async () => ({ id: '44444444-4444-4444-8444-444444444444' }),
    },
    user: {
      findUnique: async () => ({ id: '33333333-3333-4333-8333-333333333333' }),
    },
  };
  const service = new UsersService(prisma);

  await assert.rejects(
    () =>
      service.create(
        {
          email: 'Editor@Example.Test',
          password: 'strong-password',
          roleId: '44444444-4444-4444-8444-444444444444',
        },
        actor,
        request,
      ),
    ConflictException,
  );
});

test('UsersService.deactivate archives access by status and clears refresh session', async () => {
  const calls = {};
  const prisma = {
    user: {
      findFirst: async (args) => {
        calls.findFirst = args;
        return userRecord();
      },
      update: async (args) => {
        calls.update = args;
        return userRecord({
          status: UserStatus.DEACTIVATED,
          refreshTokenHash: null,
          refreshTokenExpiresAt: null,
        });
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditLog = args;
      },
    },
  };
  const service = new UsersService(prisma);

  const result = await service.deactivate('33333333-3333-4333-8333-333333333333', actor, request);

  assert.equal(result.user.status, UserStatus.DEACTIVATED);
  assert.equal(calls.findFirst.where.deletedAt, null);
  assert.equal(calls.update.data.status, UserStatus.DEACTIVATED);
  assert.equal(calls.update.data.refreshTokenHash, null);
  assert.equal(calls.update.data.refreshTokenExpiresAt, null);
  assert.deepEqual(calls.update.data.sessions, { deleteMany: {} });
  assert.equal(calls.auditLog.data.action, 'user.deactivate');
});

test('AuthService.requestEmailRegistration creates invited user role and sends activation email', async () => {
  const calls = {};
  const userRole = { id: '55555555-5555-4555-8555-555555555555' };
  const createdUser = userRecord({
    id: '66666666-6666-4666-8666-666666666666',
    email: 'new@example.test',
    name: null,
    status: UserStatus.INVITED,
    roleId: userRole.id,
    role: {
      id: userRole.id,
      name: 'user',
      description: 'User role',
      permissions: [],
    },
  });
  const prisma = {
    role: {
      findUnique: async (args) => {
        calls.roleFindUnique = args;

        return userRole;
      },
    },
    user: {
      findFirst: async (args) => {
        calls.userFindFirst = args;

        return null;
      },
      create: async (args) => {
        calls.userCreate = args;

        return createdUser;
      },
    },
    emailAuthChallenge: {
      create: async (args) => {
        calls.challengeCreate = args;

        return { id: '77777777-7777-4777-8777-777777777777' };
      },
    },
  };
  const mailer = {
    sendEmailRegistrationActivation: async (message) => {
      calls.mailer = message;
    },
  };
  const previousPublicAppUrl = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = 'https://broker.fluffywhite.moscow';

  try {
    const service = new AuthService(prisma, {}, mailer);
    const result = await service.requestEmailRegistration(
      {
        email: 'new@example.test',
        password: 'Strong!1',
        passwordConfirmation: 'Strong!1',
      },
      request,
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls.roleFindUnique, { where: { name: 'user' }, select: { id: true } });
    assert.equal(calls.userCreate.data.email, 'new@example.test');
    assert.match(calls.userCreate.data.passwordHash, /^\$argon2/);
    assert.notEqual(calls.userCreate.data.passwordHash, 'Strong!1');
    assert.equal(calls.userCreate.data.roleId, userRole.id);
    assert.equal(calls.userCreate.data.status, UserStatus.INVITED);
    assert.equal(calls.challengeCreate.data.email, 'new@example.test');
    assert.equal(calls.challengeCreate.data.userId, createdUser.id);
    assert.match(calls.challengeCreate.data.tokenHash, /^[a-f0-9]{64}$/);
    assert.match(calls.challengeCreate.data.codeHash, /^[a-f0-9]{64}$/);
    assert.equal(calls.challengeCreate.data.ipAddress, '127.0.0.1');
    assert.equal(calls.challengeCreate.data.userAgent, 'node-test');
    assert.equal(calls.mailer.to, 'new@example.test');
    assert.equal('code' in calls.mailer, false);
    assert.equal('password' in calls.mailer, false);
    assert.match(calls.mailer.activationUrl, /^https:\/\/broker\.fluffywhite\.moscow\/login\?auth_token=/);
  } finally {
    if (previousPublicAppUrl === undefined) {
      delete process.env.PUBLIC_APP_URL;
    } else {
      process.env.PUBLIC_APP_URL = previousPublicAppUrl;
    }
  }
});

test('AuthService.verifyEmailRegistration consumes magic token and activates invited user', async () => {
  const calls = [];
  const now = new Date();
  const invitedUser = userRecord({
    email: 'new@example.test',
    status: UserStatus.INVITED,
    role: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'user',
      description: 'User role',
      permissions: [
        {
          permission: {
            key: 'objects:read',
          },
        },
      ],
    },
    profilePhotoFile: null,
  });
  const activeUser = {
    ...invitedUser,
    status: UserStatus.ACTIVE,
  };
  const prisma = {
    emailAuthChallenge: {
      findFirst: async (args) => {
        calls.push(['challenge.findFirst', args]);

        return {
          id: '77777777-7777-4777-8777-777777777777',
          email: 'new@example.test',
          userId: invitedUser.id,
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
          consumedAt: null,
          user: invitedUser,
        };
      },
      update: async (args) => {
        calls.push(['challenge.update', args]);

        return {};
      },
    },
    user: {
      update: async (args) => {
        calls.push(['user.update', args]);

        if (args.data.status === UserStatus.ACTIVE) {
          return activeUser;
        }

        return activeUser;
      },
    },
    userSession: {
      create: async (args) => {
        calls.push(['session.create', args]);

        return {};
      },
    },
  };
  const signCalls = [];
  const jwtService = {
    signAsync: async (payload, options) => {
      signCalls.push({ payload, options });

      return `${payload.type}-token`;
    },
  };
  const service = new AuthService(prisma, jwtService, { sendEmailRegistrationActivation: async () => {} });

  const result = await service.verifyEmailRegistration({
    token: 'magic-token',
  });

  assert.equal(result.accessToken, 'access-token');
  assert.equal(result.refreshToken, 'refresh-token');
  assert.equal(result.mediaToken, 'media-token');
  assert.equal(result.user.status, UserStatus.ACTIVE);
  assert.equal(calls[0][0], 'challenge.findFirst');
  assert.match(calls[0][1].where.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(calls[1][0], 'challenge.update');
  assert.equal(calls[1][1].data.consumedAt instanceof Date, true);
  assert.equal(calls[2][0], 'user.update');
  assert.deepEqual(calls[2][1].data, { status: UserStatus.ACTIVE });
  assert.equal(calls[3][0], 'session.create');
  assert.equal(calls[3][1].data.userId, activeUser.id);
  assert.match(calls[3][1].data.refreshTokenHash, /^\$argon2/);
  const refreshSignCall = signCalls.find(({ payload }) => payload.type === 'refresh');
  assert.equal('expiresIn' in refreshSignCall.options, false);
});

test('AuthService.refresh updates only the current user session and keeps another device signed in', async () => {
  const argon2 = require('argon2');
  const user = userRecord({
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
    role: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'editor',
      description: 'Editor',
      permissions: [
        {
          permission: {
            key: 'objects:read',
          },
        },
      ],
    },
    profilePhotoFile: null,
  });
  const sessionAId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const sessionBId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const tokenA = 'refresh-token-device-a';
  const tokenB = 'refresh-token-device-b';
  const sessions = {
    [sessionAId]: {
      id: sessionAId,
      userId: user.id,
      refreshTokenHash: await argon2.hash(tokenA, { type: argon2.argon2id }),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lastUsedAt: new Date('2026-05-01T10:00:00.000Z'),
    },
    [sessionBId]: {
      id: sessionBId,
      userId: user.id,
      refreshTokenHash: await argon2.hash(tokenB, { type: argon2.argon2id }),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lastUsedAt: new Date('2026-05-01T10:00:00.000Z'),
    },
  };
  const prisma = {
    user: {
      findFirst: async () => user,
      update: async () => user,
      updateMany: async () => ({}),
    },
    userSession: {
      findFirst: async (args) => sessions[args.where.id],
      update: async (args) => {
        sessions[args.where.id] = {
          ...sessions[args.where.id],
          ...args.data,
        };

        return sessions[args.where.id];
      },
      deleteMany: async () => ({}),
    },
  };
  const jwtService = {
    verifyAsync: async (token) => ({
      sub: user.id,
      email: user.email,
      type: 'refresh',
      sessionId: token === tokenB ? sessionBId : sessionAId,
    }),
    signAsync: async (payload) => (payload.type === 'refresh' ? `new-refresh-${payload.sessionId}` : `${payload.type}-token`),
  };
  const service = new AuthService(prisma, jwtService, { sendEmailRegistrationActivation: async () => {} });

  const refreshedA = await service.refresh({ headers: { cookie: `platforma_refresh_token=${tokenA}` } });
  const refreshedB = await service.refresh({ headers: { cookie: `platforma_refresh_token=${tokenB}` } });

  assert.equal(refreshedA.refreshToken, tokenA);
  assert.equal(refreshedB.refreshToken, tokenB);
  assert.equal(await argon2.verify(sessions[sessionAId].refreshTokenHash, tokenA), true);
  assert.equal(await argon2.verify(sessions[sessionBId].refreshTokenHash, tokenB), true);
  assert.notEqual(sessions[sessionAId].lastUsedAt.toISOString(), '2026-05-01T10:00:00.000Z');
});

test('AuthService.refresh accepts repeated refreshes from the same browser session', async () => {
  const argon2 = require('argon2');
  const user = userRecord({
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
    role: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'editor',
      description: 'Editor',
      permissions: [
        {
          permission: {
            key: 'objects:read',
          },
        },
      ],
    },
    profilePhotoFile: null,
  });
  const sessionId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const currentToken = 'current-refresh-token';
  const session = {
    id: sessionId,
    userId: user.id,
    refreshTokenHash: await argon2.hash(currentToken, { type: argon2.argon2id }),
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    lastUsedAt: new Date('2026-05-01T10:00:00.000Z'),
  };
  const prisma = {
    user: {
      findFirst: async () => user,
      update: async () => user,
      updateMany: async () => ({}),
    },
    userSession: {
      findFirst: async () => session,
      update: async (args) => {
        Object.assign(session, args.data);

        return session;
      },
      deleteMany: async () => ({}),
    },
  };
  const jwtService = {
    verifyAsync: async () => ({
      sub: user.id,
      email: user.email,
      type: 'refresh',
      sessionId,
    }),
    signAsync: async (payload) => (payload.type === 'refresh' ? 'new-refresh-token' : `${payload.type}-token`),
  };
  const service = new AuthService(prisma, jwtService, { sendEmailRegistrationActivation: async () => {} });

  const first = await service.refresh({ headers: { cookie: `platforma_refresh_token=${currentToken}` } });
  const second = await service.refresh({ headers: { cookie: `platforma_refresh_token=${currentToken}` } });

  assert.equal(first.refreshToken, currentToken);
  assert.equal(second.refreshToken, currentToken);
  assert.equal(await argon2.verify(session.refreshTokenHash, currentToken), true);
});
