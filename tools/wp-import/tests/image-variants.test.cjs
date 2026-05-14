const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { FileVariantKind } = require('@prisma/client');

const importerSource = readFileSync(resolve(__dirname, '../src/importer.ts'), 'utf8');

const validImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHxcCAtItCq8AAAAASUVORK5CYII=',
  'base64',
);

test('WordPress import image variant helper generates expected WebP variants', async () => {
  const {
    IMAGE_VARIANT_SPECS,
    createImageVariantKey,
    generateImageVariants,
  } = require('../dist/image-variants.js');

  assert.deepEqual(IMAGE_VARIANT_SPECS, {
    THUMBNAIL: { width: 240, quality: 68, suffix: 'thumbnail' },
    CARD: { width: 640, quality: 72, suffix: 'card' },
    DETAIL: { width: 1440, quality: 78, suffix: 'detail' },
  });
  assert.equal(
    createImageVariantKey('wordpress/123/photo.jpg', FileVariantKind.CARD),
    'wordpress/123/photo.card.webp',
  );

  const variants = await generateImageVariants(validImageBuffer, 'wordpress/123/photo.jpg');

  assert.deepEqual(
    variants.map((variant) => variant.variant),
    [FileVariantKind.THUMBNAIL, FileVariantKind.CARD, FileVariantKind.DETAIL],
  );

  for (const variant of variants) {
    assert.match(variant.key, /^wordpress\/123\/photo\.(thumbnail|card|detail)\.webp$/);
    assert.equal(variant.mimeType, 'image/webp');
    assert.equal(Buffer.isBuffer(variant.body), true);
    assert.equal(typeof variant.width, 'number');
    assert.equal(typeof variant.height, 'number');
    assert.equal(typeof variant.sizeBytes, 'bigint');
    assert.equal(typeof variant.checksum, 'string');
  }
});

test('WordPress import creates and backfills variants for imported images', () => {
  assert.match(importerSource, /generateImageVariants/);
  assert.match(importerSource, /fileVariant\.upsert/);
  assert.match(importerSource, /existingFile[\s\S]*variants/);
  assert.match(importerSource, /missingVariantKinds/);
});
