const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { FileVariantKind } = require('@prisma/client');

const validImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHxcCAtItCq8AAAAASUVORK5CYII=',
  'base64',
);

function createFile(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    storage: 'MINIO',
    bucket: 'platforma',
    key: 'uploads/2026/05/original.png',
    url: 'https://cdn.test/platforma/uploads/2026/05/original.png',
    mimeType: 'image/png',
    variants: [],
    ...overrides,
  };
}

function createStorageMock() {
  const uploaded = [];
  const readKeys = [];
  const objects = new Map();

  return {
    uploaded,
    readKeys,
    objects,
    service: {
      getBucket: () => 'platforma',
      getPublicUrl: (key) => `https://cdn.test/platforma/${key}`,
      getObject: async (key) => {
        readKeys.push(key);

        if (!objects.has(key)) {
          throw new Error(`Missing object ${key}`);
        }

        return objects.get(key);
      },
      putObject: async (params) => {
        uploaded.push(params);
      },
    },
  };
}

test('api package exposes media variants backfill script', () => {
  const apiPackage = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));

  assert.equal(apiPackage.scripts['media:variants:backfill'], 'pnpm build && node dist/files/backfill-image-variants.js');
});

test('backfillImageVariants creates only missing image variants and skips complete files', async () => {
  const {
    backfillImageVariants,
  } = require('../dist/files/backfill-image-variants.js');
  const completeFile = createFile({
    id: '11111111-1111-4111-8111-111111111111',
    key: 'uploads/2026/05/complete.png',
    variants: [
      { variant: FileVariantKind.THUMBNAIL },
      { variant: FileVariantKind.CARD },
      { variant: FileVariantKind.DETAIL },
    ],
  });
  const partialFile = createFile({
    id: '22222222-2222-4222-8222-222222222222',
    key: 'uploads/2026/05/partial.png',
    variants: [
      { variant: FileVariantKind.THUMBNAIL },
    ],
  });
  const storage = createStorageMock();
  storage.objects.set(partialFile.key, validImageBuffer);

  const upserts = [];
  const prisma = {
    file: {
      findMany: async (args) => {
        assert.deepEqual(args.where, {
          mimeType: {
            in: ['image/jpeg', 'image/png', 'image/webp'],
          },
        });
        assert.equal(args.include.variants.select.variant, true);

        return [completeFile, partialFile];
      },
    },
    fileVariant: {
      upsert: async (args) => {
        upserts.push(args);
      },
    },
  };

  const summary = await backfillImageVariants({
    prisma,
    storage: storage.service,
    logger: {
      info: () => undefined,
      error: () => undefined,
    },
  });

  assert.deepEqual(summary, {
    processed: 2,
    created: 2,
    skipped: 1,
    failed: 0,
  });
  assert.deepEqual(storage.readKeys, [partialFile.key]);
  assert.deepEqual(
    storage.uploaded.map((upload) => upload.key),
    [
      'uploads/2026/05/partial.card.webp',
      'uploads/2026/05/partial.detail.webp',
    ],
  );
  assert.deepEqual(
    upserts.map((upsert) => upsert.where.fileId_variant),
    [
      { fileId: partialFile.id, variant: FileVariantKind.CARD },
      { fileId: partialFile.id, variant: FileVariantKind.DETAIL },
    ],
  );
});

test('backfillImageVariants records failed files and maps failures to non-zero exit code', async () => {
  const {
    backfillImageVariants,
    getBackfillExitCode,
  } = require('../dist/files/backfill-image-variants.js');
  const failedFile = createFile({
    id: '33333333-3333-4333-8333-333333333333',
    key: 'uploads/2026/05/missing.png',
  });
  const errors = [];
  const prisma = {
    file: {
      findMany: async () => [failedFile],
    },
    fileVariant: {
      upsert: async () => assert.fail('Failed files must not write variants'),
    },
  };

  const summary = await backfillImageVariants({
    prisma,
    storage: createStorageMock().service,
    logger: {
      info: () => undefined,
      error: (message) => errors.push(message),
    },
  });

  assert.deepEqual(summary, {
    processed: 1,
    created: 0,
    skipped: 0,
    failed: 1,
  });
  assert.equal(errors.length, 1);
  assert.equal(getBackfillExitCode(summary), 1);
  assert.equal(getBackfillExitCode({ ...summary, failed: 0 }), 0);
});
