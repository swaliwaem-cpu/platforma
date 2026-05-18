require('reflect-metadata');

const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException } = require('@nestjs/common');
const { FileVariantKind } = require('@prisma/client');

const { FilesController } = require('../dist/files/files.controller.js');
const { FilesService } = require('../dist/files/files.service.js');
const { MediaController } = require('../dist/files/media.controller.js');

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

const validImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHxcCAtItCq8AAAAASUVORK5CYII=',
  'base64',
);

const validImageUpload = {
  originalname: 'Photo.PNG',
  mimetype: 'image/png',
  buffer: validImageBuffer,
  size: validImageBuffer.length,
};

const now = new Date('2026-05-12T10:00:00.000Z');

function createFileRecord(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    wpAttachmentId: null,
    storage: 'MINIO',
    bucket: 'platforma',
    key: 'uploads/2026/05/original.png',
    url: 'https://cdn.test/platforma/uploads/2026/05/original.png',
    originalName: 'Photo.PNG',
    mimeType: 'image/png',
    sizeBytes: BigInt(validImageUpload.size),
    checksum: 'checksum',
    uploadedById: actor.id,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createStorageMock() {
  const uploaded = [];
  const deleted = [];
  const readKeys = [];
  const objects = new Map();

  return {
    uploaded,
    deleted,
    readKeys,
    objects,
    service: {
      getBucket: () => 'platforma',
      getPublicUrl: (key) => `https://cdn.test/platforma/${key}`,
      putObject: async (params) => {
        uploaded.push(params);
      },
      getObject: async (key) => {
        readKeys.push(key);

        return objects.get(key) ?? Buffer.alloc(0);
      },
      deleteObject: async (key) => {
        deleted.push(key);
      },
    },
  };
}

test('FilesService.uploadFile creates WebP variants for uploaded images', async () => {
  const storage = createStorageMock();
  let createArgs;
  const prisma = {
    file: {
      create: async (args) => {
        createArgs = args;

        return createFileRecord({
          key: args.data.key,
          url: args.data.url,
          checksum: args.data.checksum,
        });
      },
    },
  };
  const service = new FilesService(prisma, storage.service);

  const result = await service.uploadFile(validImageUpload, actor, 'image');

  assert.equal(result.file.mimeType, 'image/png');
  assert.equal(storage.uploaded.length, 4);
  assert.equal(storage.uploaded[0].contentType, 'image/png');
  assert.equal(storage.uploaded[1].contentType, 'image/webp');
  assert.equal(storage.uploaded[2].contentType, 'image/webp');
  assert.equal(storage.uploaded[3].contentType, 'image/webp');

  const originalKey = storage.uploaded[0].key;
  assert.match(originalKey, /^uploads\/\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);
  assert.deepEqual(
    storage.uploaded.slice(1).map((upload) => upload.key),
    [
      originalKey.replace(/\.png$/u, '.thumbnail.webp'),
      originalKey.replace(/\.png$/u, '.card.webp'),
      originalKey.replace(/\.png$/u, '.detail.webp'),
    ],
  );

  const variants = createArgs.data.variants.create;
  assert.deepEqual(
    variants.map((variant) => variant.variant),
    [FileVariantKind.THUMBNAIL, FileVariantKind.CARD, FileVariantKind.DETAIL],
  );
  assert.deepEqual(
    variants.map((variant) => variant.key),
    storage.uploaded.slice(1).map((upload) => upload.key),
  );

  for (const variant of variants) {
    assert.equal(variant.storage, 'MINIO');
    assert.equal(variant.bucket, 'platforma');
    assert.equal(variant.mimeType, 'image/webp');
    assert.equal(typeof variant.width, 'number');
    assert.equal(typeof variant.height, 'number');
    assert.equal(typeof variant.sizeBytes, 'bigint');
    assert.equal(typeof variant.checksum, 'string');
    assert.match(variant.url, /^https:\/\/cdn\.test\/platforma\/uploads\//);
  }
});

test('FilesService.delete removes image variants before deleting original object', async () => {
  const storage = createStorageMock();
  const deletedFileIds = [];
  const prisma = {
    file: {
      findUnique: async () => ({
        ...createFileRecord({ key: 'uploads/2026/05/original.png' }),
        variants: [
          { key: 'uploads/2026/05/original.thumbnail.webp' },
          { key: 'uploads/2026/05/original.card.webp' },
          { key: 'uploads/2026/05/original.detail.webp' },
        ],
        _count: {
          profilePhotoUsers: 0,
          objectImages: 0,
          objectFiles: 0,
        },
      }),
      delete: async (args) => {
        deletedFileIds.push(args.where.id);
      },
    },
  };
  const service = new FilesService(prisma, storage.service);

  await service.delete('11111111-1111-4111-8111-111111111111');

  assert.deepEqual(storage.deleted, [
    'uploads/2026/05/original.thumbnail.webp',
    'uploads/2026/05/original.card.webp',
    'uploads/2026/05/original.detail.webp',
    'uploads/2026/05/original.png',
  ]);
  assert.deepEqual(deletedFileIds, ['11111111-1111-4111-8111-111111111111']);
});

test('FilesService.getContent returns requested image variant when it exists', async () => {
  const storage = createStorageMock();
  const variantBuffer = Buffer.from('card variant');
  storage.objects.set('uploads/2026/05/original.card.webp', variantBuffer);
  const prisma = {
    file: {
      findUnique: async () => ({
        ...createFileRecord(),
        variants: [
          {
            variant: FileVariantKind.CARD,
            key: 'uploads/2026/05/original.card.webp',
            mimeType: 'image/webp',
          },
        ],
      }),
    },
  };
  const service = new FilesService(prisma, storage.service);

  const result = await service.getContent('11111111-1111-4111-8111-111111111111', 'card');

  assert.deepEqual(storage.readKeys, ['uploads/2026/05/original.card.webp']);
  assert.equal(result.buffer, variantBuffer);
  assert.equal(result.file.mimeType, 'image/webp');
  assert.equal(result.variant, 'card');
});

test('FilesService.getContent falls back to original when requested variant is missing', async () => {
  const storage = createStorageMock();
  const originalBuffer = Buffer.from('original image');
  storage.objects.set('uploads/2026/05/original.png', originalBuffer);
  const prisma = {
    file: {
      findUnique: async () => ({
        ...createFileRecord(),
        variants: [],
      }),
    },
  };
  const service = new FilesService(prisma, storage.service);

  const result = await service.getContent('11111111-1111-4111-8111-111111111111', 'detail');

  assert.deepEqual(storage.readKeys, ['uploads/2026/05/original.png']);
  assert.equal(result.buffer, originalBuffer);
  assert.equal(result.file.mimeType, 'image/png');
  assert.equal(result.variant, 'original-fallback');
});

test('FilesService.getContent rejects unsupported variants', async () => {
  const service = new FilesService({}, createStorageMock().service);

  await assert.rejects(
    () => service.getContent('11111111-1111-4111-8111-111111111111', 'large'),
    BadRequestException,
  );
});

test('FilesController.getContent passes variant query and sets image cache and variant headers', async () => {
  const calls = [];
  const controller = new FilesController({
    getContent: async (id, variant) => {
      calls.push({ id, variant });

      return {
        file: createFileRecord({
          mimeType: 'image/webp',
          originalName: 'Photo.PNG',
        }),
        buffer: Buffer.from('variant body'),
        variant: 'card',
      };
    },
  });
  const headers = {};
  const response = {
    setHeader: (name, value) => {
      headers[name] = value;
    },
    send: (body) => {
      response.body = body;
    },
  };

  await controller.getContent('11111111-1111-4111-8111-111111111111', 'card', response);

  assert.deepEqual(calls, [{ id: '11111111-1111-4111-8111-111111111111', variant: 'card' }]);
  assert.equal(headers['Content-Type'], 'image/webp');
  assert.equal(headers['Content-Length'], 12);
  assert.equal(headers['Cache-Control'], 'private, max-age=86400');
  assert.equal(headers['X-Platforma-File-Variant'], 'card');
  assert.deepEqual(response.body, Buffer.from('variant body'));
});

test('FilesController.getContent preserves existing cache behavior for PDFs', async () => {
  const controller = new FilesController({
    getContent: async () => ({
      file: createFileRecord({
        mimeType: 'application/pdf',
        originalName: 'presentation.pdf',
      }),
      buffer: Buffer.from('pdf body'),
      variant: 'original',
    }),
  });
  const headers = {};
  const response = {
    setHeader: (name, value) => {
      headers[name] = value;
    },
    send: (body) => {
      response.body = body;
    },
  };

  await controller.getContent('11111111-1111-4111-8111-111111111111', undefined, response);

  assert.equal(headers['Content-Type'], 'application/pdf');
  assert.equal(headers['Cache-Control'], 'private, max-age=300');
  assert.equal(headers['X-Platforma-File-Variant'], undefined);
});

test('MediaController.getContent delegates to FilesService and shares content headers', async () => {
  const calls = [];
  const controller = new MediaController({
    getContent: async (id, variant) => {
      calls.push({ id, variant });

      return {
        file: createFileRecord({
          mimeType: 'image/webp',
          originalName: 'Card.webp',
        }),
        buffer: Buffer.from('media body'),
        variant: 'card',
      };
    },
  });
  const headers = {};
  const response = {
    setHeader: (name, value) => {
      headers[name] = value;
    },
    send: (body) => {
      response.body = body;
    },
  };

  await controller.getContent('11111111-1111-4111-8111-111111111111', 'card', response);

  assert.deepEqual(calls, [{ id: '11111111-1111-4111-8111-111111111111', variant: 'card' }]);
  assert.equal(headers['Content-Type'], 'image/webp');
  assert.equal(headers['Content-Length'], 10);
  assert.equal(headers['Cache-Control'], 'private, max-age=86400');
  assert.equal(headers['X-Platforma-File-Variant'], 'card');
  assert.equal(headers['Content-Disposition'], 'inline; filename="Card.webp"');
  assert.deepEqual(response.body, Buffer.from('media body'));
});

test('MediaController.getContent adds image server timing without changing PDF headers', async () => {
  const imageController = new MediaController({
    getContent: async () => ({
      file: createFileRecord({
        mimeType: 'image/webp',
        originalName: 'Card.webp',
      }),
      buffer: Buffer.from('media body'),
      variant: 'card',
    }),
  });
  const imageHeaders = {};
  const imageResponse = {
    setHeader: (name, value) => {
      imageHeaders[name] = value;
    },
    send: (body) => {
      imageResponse.body = body;
    },
  };

  await imageController.getContent('11111111-1111-4111-8111-111111111111', 'card', imageResponse);

  assert.match(String(imageHeaders['Server-Timing']), /^platforma-media;dur=\d+(\.\d+)?$/);

  const pdfController = new MediaController({
    getContent: async () => ({
      file: createFileRecord({
        mimeType: 'application/pdf',
        originalName: 'presentation.pdf',
      }),
      buffer: Buffer.from('pdf body'),
      variant: 'original',
    }),
  });
  const pdfHeaders = {};
  const pdfResponse = {
    setHeader: (name, value) => {
      pdfHeaders[name] = value;
    },
    send: (body) => {
      pdfResponse.body = body;
    },
  };

  await pdfController.getContent('11111111-1111-4111-8111-111111111111', undefined, pdfResponse);

  assert.equal(pdfHeaders['Content-Type'], 'application/pdf');
  assert.equal(pdfHeaders['Cache-Control'], 'private, max-age=300');
  assert.equal(pdfHeaders['Server-Timing'], undefined);
});
