require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} = require('@nestjs/common');
const { Reflector } = require('@nestjs/core');
const { ProjectPresentationDocumentStatus } = require('@prisma/client');
const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');
const {
  ProjectPresentationsController,
} = require('../dist/project-presentations/project-presentations.controller.js');
const {
  ProjectPresentationsService,
} = require('../dist/project-presentations/project-presentations.service.js');

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const loadTemplate = () => import('@platforma/shared/project-presentation-template');
const actor = {
  id: uuid(3),
  email: 'generator@example.com',
  name: 'Ирина Генерирующая',
  brokerPhone: '+7 900 000-00-03',
  brokerEmail: 'irina@example.com',
};
const image = (number) => ({ id: uuid(100 + number), fileId: uuid(200 + number), file: { checksum: `checksum-${number}` } });

function createContext(permissions) {
  return {
    getHandler: () => ProjectPresentationsController.prototype.listDrafts,
    getClass: () => ProjectPresentationsController,
    switchToHttp() {
      return {
        getRequest() {
          return { user: permissions ? { permissions } : null };
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
    templateVersion: 'project-catalog-editorial-a-3x4-v2',
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
  const fourthImage = image(4);
  const fifthImage = image(5);
  const sixthImage = image(6);

  return {
    id: uuid(1),
    ownerUserId: uuid(2),
    title: 'Рабочий черновик',
    coverTitle: 'Три проекта для жизни',
    coverSubtitle: 'Москва, 2026',
    clientName: 'Анна',
    issueLabel: 'Персональная подборка',
    mapTitle: 'Москва рядом с парком',
    coverFeatures: null,
    coverImageId: secondImage.id,
    coverFileId: null,
    coverFile: null,
    templateVersion: 'project-catalog-editorial-a-3x4-v2',
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
        advantages: ['Рядом с парком', 'Закрытый двор', 'Школа', 'Метро'],
        imageIds: [secondImage.id, firstImage.id, fourthImage.id],
        object: {
          status: 'PUBLISHED',
          type: 'RESIDENTIAL',
          deletedAt: null,
          title: 'Название из каталога 1',
          shortDescription: '<p>Описание из каталога</p>',
          description: null,
          propertyClass: 'Премиум',
          completionYear: 2028,
          completionQuarter: 2,
          feedPriceFrom: null,
          priceFrom: null,
          latitude: { toString: () => '55.735' },
          longitude: { toString: () => '37.545' },
          primaryLocation: { name: 'ЦАО' },
          developer: { name: 'Каталожный девелопер' },
          metroStations: [{ metroStation: { name: 'Лужники' } }],
          images: [firstImage, secondImage, fourthImage],
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
        advantages: ['Парк', 'Пруд', 'Набережная', 'Рассрочка'],
        imageIds: [thirdImage.id, fifthImage.id, sixthImage.id],
        object: {
          status: 'PUBLISHED',
          type: 'RESIDENTIAL',
          deletedAt: null,
          title: 'Второй ЖК',
          shortDescription: '<p>Каталожное <strong>описание</strong></p>',
          description: null,
          propertyClass: 'Комфорт',
          completionYear: 2029,
          completionQuarter: 1,
          feedPriceFrom: null,
          priceFrom: null,
          latitude: null,
          longitude: null,
          primaryLocation: { name: 'САО' },
          developer: { name: 'Девелопер Б' },
          metroStations: [{ metroStation: { name: 'Динамо' } }, { metroStation: { name: 'Петровский парк' } }],
          images: [thirdImage, fifthImage, sixthImage, image(7)],
        },
      },
    ],
  };
}

test('project presentation routes require the project presentation permission', () => {
  assert.deepEqual(
    Reflect.getMetadata(PERMISSIONS_KEY, ProjectPresentationsController),
    ['presentations:projects:manage'],
  );

  const guard = new PermissionsGuard(new Reflector());
  const previousNodeEnv = process.env.NODE_ENV;

  try {
    for (const nodeEnv of ['development', 'production']) {
      process.env.NODE_ENV = nodeEnv;

      assert.equal(
        guard.canActivate(createContext(['objects:read', 'presentations:projects:manage'])),
        true,
      );

      for (const permissions of [['objects:read', 'training:participate'], [], null]) {
        assert.throws(() => guard.canActivate(createContext(permissions)), ForbiddenException);
      }
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
      advantages: ['1', '2', '3', '4', '5'],
    }]),
    (error) => error instanceof BadRequestException && /Advantages is invalid/.test(error.message),
  );
});

test('snapshot freezes chosen order, manual content, image order, generating broker and Telegram CTA', async () => {
  const service = new ProjectPresentationsService({}, {});
  const draft = createSnapshotDraft();

  const snapshot = service.createSnapshot(draft, 'PDF для Анны', actor, await loadTemplate());

  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.templateVersion, 'project-catalog-fw-html-3x4-v4');
  assert.deepEqual(snapshot.map, { title: 'Москва рядом с парком' });
  assert.deepEqual(snapshot.cover.features, [
    { title: 'Локация и факты', caption: 'Район, метро и класс' },
    { title: 'Преимущества', caption: 'Главное о каждом ЖК' },
    { title: 'Старты продаж', caption: 'Новые предложения' },
    { title: 'Условия покупки', caption: 'Стоимость и рассрочка' },
  ]);
  assert.equal(snapshot.page.width / snapshot.page.height, 3 / 4);
  assert.equal(snapshot.title, 'PDF для Анны');
  assert.equal(snapshot.cover.title, 'Три проекта для жизни');
  assert.equal(snapshot.cover.image.fileId, uuid(202));
  assert.deepEqual(snapshot.objects.map((item) => item.sourceObjectId), [uuid(21), uuid(22)]);
  assert.deepEqual(snapshot.objects.map((item) => item.sortOrder), [0, 1]);
  assert.equal(snapshot.objects[0].title, 'Первый ЖК');
  assert.equal(snapshot.objects[0].description, 'Ручное описание первого проекта');
  assert.equal(snapshot.objects[0].latitude, 55.735);
  assert.equal(snapshot.objects[0].longitude, 37.545);
  assert.deepEqual(snapshot.objects[0].images.map((image) => image.fileId), [uuid(202), uuid(201), uuid(204)]);
  assert.equal(snapshot.objects[1].title, 'Второй ЖК');
  assert.equal(snapshot.objects[1].description, 'Каталожное описание');
  assert.equal(snapshot.objects[1].metro, 'Динамо');
  assert.deepEqual(snapshot.objects[1].images.map((image) => image.fileId), [uuid(203), uuid(205), uuid(206)]);
  assert.deepEqual(snapshot.broker, {
    name: 'Ирина Генерирующая',
    phone: '+7 900 000-00-03',
    email: 'irina@example.com',
    profilePhoto: null,
  });
  assert.deepEqual(snapshot.cta, {
    label: '@svetlana_fluffywhite',
    url: 'https://t.me/svetlana_fluffywhite',
  });

  draft.objects[0].manualTitle = 'Изменено после запуска';
  draft.objects[0].object.images[1].file.checksum = 'changed';
  assert.equal(snapshot.objects[0].title, 'Первый ЖК');
  assert.equal(snapshot.objects[0].images[0].checksum, 'checksum-second');
});

test('snapshot cuts long catalog descriptions to 430 characters', async () => {
  const service = new ProjectPresentationsService({}, {});
  const draft = createSnapshotDraft();
  draft.objects[1].object.shortDescription = `<p>${'Большой зелёный квартал у воды. '.repeat(30)}</p>`;

  const snapshot = service.createSnapshot(draft, 'PDF', actor, await loadTemplate());

  assert.ok(snapshot.objects[1].description.length <= 430);
  assert.ok(snapshot.objects[1].description.endsWith('…'));
});

test('custom cover file takes priority and is marked for safe lifecycle cleanup', async () => {
  const service = new ProjectPresentationsService({}, {});
  const draft = createSnapshotDraft();
  draft.coverFileId = uuid(299);
  draft.coverFile = { id: uuid(299), checksum: 'checksum-custom-cover' };

  const snapshot = service.createSnapshot(draft, 'PDF со своей обложкой', actor, await loadTemplate());
  const assets = service.collectSnapshotAssets(snapshot, draft.coverFileId);

  assert.equal(snapshot.cover.image.fileId, uuid(299));
  assert.equal(snapshot.cover.image.checksum, 'checksum-custom-cover');
  assert.equal(assets.find((asset) => asset.fileId === uuid(299)).role, 'CUSTOM_COVER');
});

test('the cover tiles keep their four slots and fall back to the catalog wording', async () => {
  const service = new ProjectPresentationsService({}, {});
  const template = await loadTemplate();
  const draft = createSnapshotDraft();
  draft.coverFeatures = [{ title: 'Локации', caption: '' }, { title: '  ', caption: 'Что важно' }];

  const snapshot = service.createSnapshot(draft, 'PDF', actor, template);

  assert.deepEqual(snapshot.cover.features, [
    { title: 'Локации', caption: '' },
    { title: 'Преимущества', caption: 'Что важно' },
    { title: 'Старты продаж', caption: 'Новые предложения' },
    { title: 'Условия покупки', caption: 'Стоимость и рассрочка' },
  ]);
  assert.deepEqual(
    service.parseCoverFeatures([{ title: ' Локации ', caption: ' Район ' }]),
    [{ title: 'Локации', caption: 'Район' }],
  );
  assert.equal(service.parseCoverFeatures(null), null);
  assert.throws(
    () => service.parseCoverFeatures([{}, {}, {}, {}, {}]),
    (error) => error instanceof BadRequestException && /Cover features are invalid/.test(error.message),
  );
});

test('generation requires the map title, four advantages and three gallery photos per project', async () => {
  const service = new ProjectPresentationsService({}, {});
  const template = await loadTemplate();
  const cases = [
    [(draft) => { draft.mapTitle = null; }, /Map title is required/],
    [(draft) => { draft.mapTitle = 'М'.repeat(61); }, /Map title is longer than 60/],
    [(draft) => { draft.coverSubtitle = 'П'.repeat(121); }, /Cover subtitle is longer than 120/],
    [(draft) => { draft.objects[0].advantages = ['Один', 'Два', 'Три', ' ']; }, /Первый ЖК needs 4 advantages/],
    [(draft) => { draft.objects[0].advantages[3] = 'Д'.repeat(41); }, /longer than 40/],
    [(draft) => { draft.objects[1].imageIds = [uuid(103), uuid(105)]; }, /Второй ЖК needs 3 photos/],
    [(draft) => { draft.objects[1].imageIds = [uuid(103), uuid(105), uuid(199)]; }, /Второй ЖК needs 3 photos/],
    [(draft) => { draft.objects[0].manualDescription = 'О'.repeat(431); }, /Description of Первый ЖК is longer than 430/],
    [(draft) => { draft.objects[1].object.shortDescription = '<p> </p>'; }, /Description of Второй ЖК is required/],
    [(draft) => { draft.coverFeatures = [{ title: 'Л'.repeat(25), caption: '' }]; }, /Cover feature title is longer than 24/],
    [(draft) => { draft.coverFeatures = [{ title: 'Локация', caption: 'П'.repeat(33) }]; }, /Cover feature caption is longer than 32/],
  ];

  assert.doesNotThrow(() => service.ensureDraftIsComplete(createSnapshotDraft(), template));
  for (const [mutate, message] of cases) {
    const draft = createSnapshotDraft();
    mutate(draft);
    assert.throws(
      () => service.ensureDraftIsComplete(draft, template),
      (error) => error instanceof BadRequestException && message.test(error.message),
    );
  }
});

test('custom cover upload is versioned, replaces the previous file and clears catalog selection', async () => {
  const calls = [];
  const prisma = {
    projectPresentationDraft: {
      updateMany: async (args) => {
        calls.push(['update', args]);
        return { count: 1 };
      },
    },
  };
  const filesService = {
    uploadFile: async (_file, _actor, kind) => {
      calls.push(['upload', kind]);
      return { file: { id: uuid(205) } };
    },
    deleteUnlinkedFile: async (fileId) => calls.push(['delete-unlinked-file', fileId]),
  };
  const service = new ProjectPresentationsService(prisma, filesService);
  service.findDraft = async () => ({ version: 7, coverFileId: uuid(204) });
  service.getDraft = async () => ({ draft: { id: uuid(1), coverFileId: uuid(205) } });

  const response = await service.uploadDraftCover(
    uuid(1),
    '7',
    { buffer: Buffer.from('image'), originalname: 'cover.jpg', mimetype: 'image/jpeg', size: 5 },
    { id: uuid(2) },
  );

  assert.equal(response.draft.coverFileId, uuid(205));
  assert.deepEqual(calls[0], ['upload', 'image']);
  assert.deepEqual(calls[1][1], {
    where: { id: uuid(1), version: 7 },
    data: { coverFileId: uuid(205), coverImageId: null, version: { increment: 1 } },
  });
  assert.deepEqual(calls[2], ['delete-unlinked-file', uuid(204)]);
});

test('custom cover upload removes the new file when optimistic locking fails', async () => {
  const calls = [];
  const prisma = {
    projectPresentationDraft: {
      updateMany: async () => ({ count: 0 }),
    },
  };
  const filesService = {
    uploadFile: async () => ({ file: { id: uuid(205) } }),
    deleteUnlinkedFile: async (fileId) => calls.push(fileId),
  };
  const service = new ProjectPresentationsService(prisma, filesService);
  service.findDraft = async () => ({ version: 7, coverFileId: uuid(204) });

  await assert.rejects(
    () => service.uploadDraftCover(
      uuid(1),
      '7',
      { buffer: Buffer.from('image'), originalname: 'cover.jpg', mimetype: 'image/jpeg', size: 5 },
      { id: uuid(2) },
    ),
    (error) => error instanceof ConflictException,
  );
  assert.deepEqual(calls, [uuid(205)]);
});

test('draft deletion cleans the cover returned by the atomic delete', async () => {
  const calls = [];
  const prisma = {
    projectPresentationDraft: {
      delete: async (args) => {
        calls.push(['delete-draft', args]);
        return { coverFileId: uuid(205) };
      },
    },
  };
  const filesService = {
    deleteUnlinkedFile: async (fileId) => calls.push(['delete-unlinked-file', fileId]),
  };
  const service = new ProjectPresentationsService(prisma, filesService);

  await service.deleteDraft(uuid(1));

  assert.deepEqual(calls, [
    ['delete-draft', { where: { id: uuid(1) }, select: { coverFileId: true } }],
    ['delete-unlinked-file', uuid(205)],
  ]);
});

test('document snapshot locks the draft until the custom cover asset is linked', async () => {
  const calls = [];
  const draft = createSnapshotDraft();
  draft.coverFileId = uuid(299);
  draft.coverFile = { id: uuid(299), checksum: 'checksum-custom-cover' };
  const tx = {
    $queryRaw: async (strings) => calls.push(['lock', strings.join('')]),
    projectPresentationDraft: {
      findUnique: async () => {
        calls.push(['read-draft']);
        return draft;
      },
    },
    projectPresentationDocument: {
      create: async (args) => {
        calls.push(['create-document', args]);
        return { id: uuid(900) };
      },
    },
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
  };
  const service = new ProjectPresentationsService(prisma, {});
  service.getDocument = async (id) => ({ document: { id } });

  const response = await service.createDocument(
    draft.id,
    { version: draft.version, title: 'Зафиксированный снимок' },
    actor,
  );

  assert.equal(response.document.id, uuid(900));
  assert.match(calls[0][1], /FOR SHARE/u);
  assert.deepEqual(calls.slice(0, 3).map(([name]) => name), ['lock', 'read-draft', 'create-document']);
  assert.equal(
    calls[2][1].data.assets.create.find((asset) => asset.fileId === uuid(299)).role,
    'CUSTOM_COVER',
  );
  assert.equal(calls[2][1].data.ownerUserId, actor.id);
  assert.equal(calls[2][1].data.snapshotVersion, 3);
  assert.equal(calls[2][1].data.snapshotJson.broker.phone, actor.brokerPhone);
});

test('document history query is global for authenticated users and serializes creator and status', async () => {
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
      deleteMany: async ({ where }) => {
        calls.push(['delete-record', where.id]);
        return { count: 1 };
      },
    },
    projectPresentationDocumentAsset: {
      findMany: async () => [],
    },
  };
  const filesService = {
    delete: async (fileId) => calls.push(['delete-file', fileId]),
    deleteUnlinkedFile: async (fileId) => calls.push(['delete-unlinked-file', fileId]),
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

test('document deletion releases a custom cover after snapshot assets are removed', async () => {
  const calls = [];
  const currentDocument = createDocumentRecord({
    status: ProjectPresentationDocumentStatus.READY,
    fileId: null,
  });
  const prisma = {
    projectPresentationDocument: {
      findUnique: async () => currentDocument,
      deleteMany: async ({ where }) => {
        calls.push(['delete-record', where.id]);
        return { count: 1 };
      },
    },
    projectPresentationDocumentAsset: {
      findMany: async () => [{ fileId: uuid(204) }, { fileId: uuid(204) }],
    },
  };
  const filesService = {
    deleteUnlinkedFile: async (fileId) => calls.push(['delete-unlinked-file', fileId]),
  };
  const service = new ProjectPresentationsService(prisma, filesService);

  await service.deleteDocument(currentDocument.id);

  assert.deepEqual(calls, [
    ['delete-record', currentDocument.id],
    ['delete-unlinked-file', uuid(204)],
  ]);
});

test('document deletion still releases a custom cover when PDF cleanup fails', async () => {
  const calls = [];
  const currentDocument = createDocumentRecord({
    status: ProjectPresentationDocumentStatus.READY,
    fileId: uuid(950),
  });
  const prisma = {
    projectPresentationDocument: {
      findUnique: async () => currentDocument,
      deleteMany: async ({ where }) => {
        calls.push(['delete-record', where.id]);
        return { count: 1 };
      },
    },
    projectPresentationDocumentAsset: {
      findMany: async () => [{ fileId: uuid(204) }],
    },
  };
  const filesService = {
    delete: async (fileId) => {
      calls.push(['delete-file', fileId]);
      throw new Error('storage unavailable');
    },
    deleteUnlinkedFile: async (fileId) => calls.push(['delete-unlinked-file', fileId]),
  };
  const service = new ProjectPresentationsService(prisma, filesService);

  await assert.rejects(() => service.deleteDocument(currentDocument.id), /storage unavailable/);
  assert.deepEqual(calls, [
    ['delete-record', currentDocument.id],
    ['delete-file', uuid(950)],
    ['delete-unlinked-file', uuid(204)],
  ]);
});

test('document deletion loses the race when a pending worker starts running', async () => {
  const calls = [];
  const currentDocument = createDocumentRecord({
    status: ProjectPresentationDocumentStatus.PENDING,
    fileId: null,
  });
  const prisma = {
    projectPresentationDocument: {
      findUnique: async () => currentDocument,
      deleteMany: async () => ({ count: 0 }),
    },
    projectPresentationDocumentAsset: {
      findMany: async () => [{ fileId: uuid(204) }],
    },
  };
  const filesService = {
    deleteUnlinkedFile: async (fileId) => calls.push(fileId),
  };
  const service = new ProjectPresentationsService(prisma, filesService);

  await assert.rejects(
    () => service.deleteDocument(currentDocument.id),
    (error) => error instanceof ConflictException && /Running document/.test(error.message),
  );
  assert.deepEqual(calls, []);
});
