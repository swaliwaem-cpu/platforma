require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException, ConflictException } = require('@nestjs/common');
const { LocationType, ObjectFileType, ObjectStatus, UserStatus } = require('@prisma/client');

const { DirectoriesService } = require('../dist/directories/directories.service.js');
const { MapService } = require('../dist/map/map.service.js');
const { ObjectsService } = require('../dist/objects/objects.service.js');
const { UsersService } = require('../dist/users/users.service.js');

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
    shortDescription: null,
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

test('ObjectsService.list builds catalog filters for status, price, presentation and missing coordinates', async () => {
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
  assert.equal(result.page, 2);
  assert.equal(result.limit, 5);
  assert.equal(calls.findMany.skip, 5);
  assert.equal(calls.findMany.take, 5);
  assert.deepEqual(calls.findMany.orderBy, [{ priceFrom: 'asc' }, { createdAt: 'desc' }]);
  assert.deepEqual(calls.count.where, calls.findMany.where);

  const filters = calls.findMany.where.AND;
  assert.equal(filters.some((filter) => filter.status === ObjectStatus.PUBLISHED), true);
  assert.equal(
    filters.some((filter) => filter.priceFrom?.gte === '1000000' && filter.priceFrom?.lte === '2000000'),
    true,
  );
  assert.equal(filters.some((filter) => filter.files?.none?.type === ObjectFileType.PRESENTATION), true);
  assert.equal(filters.some((filter) => filter.OR?.some((item) => item.latitude === null)), true);
  assert.equal(filters.some((filter) => filter.OR?.some((item) => item.title?.contains === 'центр')), true);
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
  assert.deepEqual(
    result.items[0].locations.map((location) => [location.name, location.type, location.isPrimary]),
    [
      ['Тверской', LocationType.DISTRICT, true],
      ['На Патриарших', LocationType.AREA, false],
    ],
  );
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
