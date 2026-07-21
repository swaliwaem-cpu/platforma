const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} = require('@nestjs/common');
const { ProjectPresentationDocumentStatus } = require('@prisma/client');
const {
  ProjectPresentationsAdminGuard,
} = require('../dist/project-presentations/project-presentations-admin.guard.js');
const {
  ProjectPresentationsService,
} = require('../dist/project-presentations/project-presentations.service.js');

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function createContext(roleName) {
  return {
    switchToHttp() {
      return {
        getRequest() {
          return { user: roleName ? { role: { name: roleName } } : null };
        },
      };
    },
  };
}

function createDocumentRecord(overrides = {}) {
  return {
    id: uuid(900),
    ownerUserId: uuid(901),
    draftId: uuid(902),
    title: 'Подборка для клиента',
    status: ProjectPresentationDocumentStatus.PENDING,
    templateVersion: 'project-catalog-4x5-v1',
    objectsCount: 2,
    progress: 0,
    attempts: 0,
    errorMessage: null,
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T10:00:01.000Z'),
    startedAt: null,
    finishedAt: null,
    fileId: null,
    owner: { id: uuid(901), name: 'Администратор', email: 'admin@example.com' },
    ...overrides,
  };
}

function createSnapshotDraft() {
  const firstImage = {
    id: uuid(101),
    fileId: uuid(201),
    file: { checksum: 'checksum-first' },
  };
  const secondImage = {
    id: uuid(102),
    fileId: uuid(202),
    file: { checksum: 'checksum-second' },
  };
  const thirdImage = {
    id: uuid(103),
    fileId: uuid(203),
    file: { checksum: 'checksum-third' },
  };

  return {
    id: uuid(1),
    ownerUserId: uuid(2),
    title: 'Рабочий черновик',
    coverTitle: 'Три проекта для жизни',
    coverSubtitle: 'Москва, 2026',
    clientName: 'Анна',
    issueLabel: 'Персональная подборка',
    coverImageId: secondImage.id,
    templateVersion: 'project-catalog-4x5-v1',
    version: 7,
    owner: {
      id: uuid(2),
      name: 'Мария Брокер',
      email: 'admin@example.com',
      brokerPhone: '+7 999 111-22-33',
      brokerEmail: 'broker@example.com',
      profilePhotoFile: null,
    },
    createdAt: new Date('2026-07-20T09:00:00.000Z'),
    updatedAt: new Date('2026-07-20T09:30:00.000Z'),
    objects: [
      {
        id: uuid(11),
        objectId: uuid(21),
        sortOrder: 0,
        manualTitle: 'Первый ЖК',
        manualDescription: 'Ручное описание первого проекта',
        manualPropertyClass: 'Бизнес',
        manualCompletion: '4 кв. 2027',
        manualPrice: 'от 25 000 000 ₽',
        manualDistrict: 'Хамовники',
        manualDeveloper: 'Девелопер А',
        manualMetro: 'Спортивная',
        advantages: ['Рядом с парком', 'Закрытый двор'],
        imageIds: [secondImage.id, firstImage.id],
        object: {
          title: 'Название из каталога 1',
          shortDescription: '<p>Описание из каталога</p>',
          description: null,
          propertyClass: 'Премиум',
          completionYear: 2028,
          completionQuarter: 2,
          feedPriceFrom: null,
          priceFrom: null,
          primaryLocation: { name: 'ЦАО' },
          developer: { name: 'Каталожный девелопер' },
          metroStations: [{ metroStation: { name: 'Лужники' } }],
          images: [firstImage, secondImage],
        },
      },
      {
        id: uuid(12),
        objectId: uuid(22),
        sortOrder: 1,
        manualTitle: null,
        manualDescription: null,
        manualPropertyClass: null,
        manualCompletion: null,
        manualPrice: null,
        manualDistrict: null,
        manualDeveloper: null,
        manualMetro: null,
        advantages: [],
        imageIds: [thirdImage.id],
        object: {
          title: 'Второй ЖК',
          shortDescription: '<p>Каталожное <strong>описание</strong></p>',
          description: null,
          propertyClass: 'Комфорт',
          completionYear: 2029,
          completionQuarter: 1,
          feedPriceFrom: null,
          priceFrom: null,
          primaryLocation: { name: 'САО' },
          developer: { name: 'Девелопер Б' },
          metroStations: [{ metroStation: { name: 'Динамо' } }],
          images: [thirdImage],
        },
      },
    ],
  };
}

test('admin guard allows local development and keeps exact admin role in production', () => {
  const guard = new ProjectPresentationsAdminGuard();
  const previousNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = 'development';
    for (const roleName of ['admin', 'broker', 'manager', null]) {
      assert.equal(guard.canActivate(createContext(roleName)), true);
    }

    process.env.NODE_ENV = 'production';
    assert.equal(guard.canActivate(createContext('admin')), true);
    for (const roleName of ['ADMIN', 'broker', 'manager', null]) {
      assert.throws(
        () => guard.canActivate(createContext(roleName)),
        (error) => error instanceof ForbiddenException,
      );
    }
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test('draft object parser accepts exactly 12 unique projects and preserves manual order', () => {
  const service = new ProjectPresentationsService({}, {});
  const input = Array.from({ length: 12 }, (_, index) => ({
    objectId: uuid(index + 1),
    manualTitle: `Проект ${index + 1}`,
    advantages: index === 0 ? ['Парк', 'Метро', 'Школа'] : [],
    imageIds: index === 0 ? [uuid(101), uuid(102), uuid(103)] : [],
  }));

  const parsed = service.parseDraftObjects(input);

  assert.equal(parsed.length, 12);
  assert.deepEqual(parsed.map((item) => item.objectId), input.map((item) => item.objectId));
  assert.deepEqual(parsed[0].advantages, ['Парк', 'Метро', 'Школа']);
  assert.deepEqual(parsed[0].imageIds, [uuid(101), uuid(102), uuid(103)]);
});

test('draft object parser rejects the thirteenth project, duplicates and oversized card data', () => {
  const service = new ProjectPresentationsService({}, {});

  assert.throws(
    () => service.parseDraftObjects(
      Array.from({ length: 13 }, (_, index) => ({ objectId: uuid(index + 1) })),
    ),
    (error) => error instanceof BadRequestException && /0 to 12 projects/.test(error.message),
  );
  assert.throws(
    () => service.parseDraftObjects([{ objectId: uuid(1) }, { objectId: uuid(1) }]),
    (error) => error instanceof BadRequestException && /unique/.test(error.message),
  );
  assert.throws(
    () => service.parseDraftObjects([{
      objectId: uuid(1),
      imageIds: [uuid(101), uuid(102), uuid(103), uuid(104)],
    }]),
    (error) => error instanceof BadRequestException && /Images is invalid/.test(error.message),
  );
  assert.throws(
    () => service.parseDraftObjects([{
      objectId: uuid(1),
      advantages: ['1', '2', '3', '4'],
    }]),
    (error) => error instanceof BadRequestException && /Advantages is invalid/.test(error.message),
  );
});

test('snapshot freezes chosen order, manual content, image order, broker and Telegram CTA', () => {
  const service = new ProjectPresentationsService({}, {});
  const draft = createSnapshotDraft();

  const snapshot = service.createSnapshot(draft, 'PDF для Анны');

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.page.width / snapshot.page.height, 4 / 5);
  assert.equal(snapshot.title, 'PDF для Анны');
  assert.equal(snapshot.cover.title, 'Три проекта для жизни');
  assert.equal(snapshot.cover.image.fileId, uuid(202));
  assert.deepEqual(snapshot.objects.map((item) => item.sourceObjectId), [uuid(21), uuid(22)]);
  assert.deepEqual(snapshot.objects.map((item) => item.sortOrder), [0, 1]);
  assert.equal(snapshot.objects[0].title, 'Первый ЖК');
  assert.equal(snapshot.objects[0].description, 'Ручное описание первого проекта');
  assert.deepEqual(snapshot.objects[0].images.map((image) => image.fileId), [uuid(202), uuid(201)]);
  assert.equal(snapshot.objects[1].title, 'Второй ЖК');
  assert.equal(snapshot.objects[1].description, 'Каталожное описание');
  assert.deepEqual(snapshot.broker, {
    name: 'Мария Брокер',
    phone: '+7 999 111-22-33',
    email: 'broker@example.com',
    profilePhoto: null,
  });
  assert.deepEqual(snapshot.cta, {
    label: '@FluffyWhite',
    url: 'https://t.me/FluffyWhite',
  });

  draft.objects[0].manualTitle = 'Изменено после запуска';
  draft.objects[0].object.images[1].file.checksum = 'changed';
  assert.equal(snapshot.objects[0].title, 'Первый ЖК');
  assert.equal(snapshot.objects[0].images[0].checksum, 'checksum-second');
});

test('document history query is global for admins and serializes creator and status', async () => {
  let findManyArgs;
  const readyDocument = createDocumentRecord({
    status: ProjectPresentationDocumentStatus.READY,
    progress: 100,
    fileId: uuid(950),
    finishedAt: new Date('2026-07-20T10:01:00.000Z'),
  });
  const prisma = {
    projectPresentationDocument: {
      findMany: async (args) => {
        findManyArgs = args;
        return [readyDocument];
      },
      count: async () => 1,
    },
    $transaction: async (promises) => Promise.all(promises),
  };
  const service = new ProjectPresentationsService(prisma, {});

  const response = await service.listDocuments({ page: '1', limit: '20' });

  assert.equal(findManyArgs.where, undefined);
  assert.deepEqual(findManyArgs.orderBy, { createdAt: 'desc' });
  assert.deepEqual(findManyArgs.include.owner.select, { id: true, name: true, email: true });
  assert.equal(response.total, 1);
  assert.equal(response.items[0].createdBy.email, 'admin@example.com');
  assert.equal(response.items[0].status, 'READY');
  assert.equal(response.items[0].canDownload, true);
});

test('document deletion removes history and unlinked PDF but blocks a running job', async () => {
  const calls = [];
  let currentDocument = createDocumentRecord({
    status: ProjectPresentationDocumentStatus.RUNNING,
    fileId: uuid(950),
  });
  const prisma = {
    projectPresentationDocument: {
      findUnique: async () => currentDocument,
      delete: async ({ where }) => calls.push(['delete-record', where.id]),
    },
  };
  const filesService = {
    delete: async (fileId) => calls.push(['delete-file', fileId]),
  };
  const service = new ProjectPresentationsService(prisma, filesService);

  await assert.rejects(
    () => service.deleteDocument(currentDocument.id),
    (error) => error instanceof ConflictException && /Running document/.test(error.message),
  );
  assert.deepEqual(calls, []);

  currentDocument = { ...currentDocument, status: ProjectPresentationDocumentStatus.READY };
  await service.deleteDocument(currentDocument.id);
  assert.deepEqual(calls, [
    ['delete-record', currentDocument.id],
    ['delete-file', uuid(950)],
  ]);
});
