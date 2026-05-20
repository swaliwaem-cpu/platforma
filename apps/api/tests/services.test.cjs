require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException, ConflictException } = require('@nestjs/common');
const { LocationType, ObjectFileType, ObjectStatus, UserStatus } = require('@prisma/client');

const { DirectoriesService } = require('../dist/directories/directories.service.js');
const { CatalogLinksService } = require('../dist/catalog-links/catalog-links.service.js');
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
    krtName: null,
    apartmentAreaRange: null,
    ceilingHeight: null,
    propertyClass: null,
    floorRange: null,
    apartmentsCountText: null,
    priceFrom: null,
    pricePerMeterFrom: null,
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
  assert.deepEqual(calls.findMany.orderBy, [{ priceFrom: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }]);
  assert.deepEqual(calls.count.where, calls.findMany.where);

  const filters = calls.findMany.where.AND;
  assert.equal(filters.some((filter) => filter.status === ObjectStatus.PUBLISHED), true);
  assert.equal(
    filters.some((filter) => filter.priceFrom?.gte === '1000000' && filter.priceFrom?.lte === '2000000'),
    true,
  );
  assert.equal(filters.some((filter) => filter.files?.none?.type === ObjectFileType.PRESENTATION), true);
  assert.equal(filters.some((filter) => filter.OR?.some((item) => item.latitude === null)), true);
  assert.equal(filters.some((filter) => filter.id?.in?.includes(objectId)), true);
  assert.equal(calls.searchQuery.values.every((value) => value === '%центр%'), true);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(o\.title, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(d\.name, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /replace\(lower\(coalesce\(o\.address, ''\)\), '\.', ''\)/);
  assert.match(calls.searchQuery.strings.join('?'), /object_locations ol/);
  assert.match(calls.searchQuery.strings.join('?'), /l\.type::text = 'district'/);
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

  assert.equal(calls.searchQuery.values.every((value) => value === '%ул новая%'), true);
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

  assert.equal(calls.searchQuery.values.every((value) => value === '%жк ари%'), true);
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
    search: 'editor',
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
  assert.equal(calls.findMany.where.OR[0].email.contains, 'editor');
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
  assert.equal(calls.auditLog.data.action, 'user.deactivate');
});
