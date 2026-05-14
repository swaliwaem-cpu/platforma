import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const secureImagePath = resolve(currentDir, '../src/files/SecureImage.tsx');
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const detailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const adminSource = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('web has shared secure image helper with variant-aware file content URL', () => {
  assert.equal(existsSync(secureImagePath), true);

  const secureImageSource = readFileSync(secureImagePath, 'utf8');

  assert.match(secureImageSource, /export function SecureImage/);
  assert.match(secureImageSource, /export function useSecureImageObjectUrl/);
  assert.match(secureImageSource, /params\.set\('variant', variant\)/);
  assert.match(secureImageSource, /IntersectionObserver/);
});

test('catalog loads cover images lazily as card variants', () => {
  assert.match(catalogSource, /from '\.\.\/files\/SecureImage'/);
  assert.match(catalogSource, /variant="card"/);
  assert.match(catalogSource, /lazy/);
});

test('catalog map no longer preloads every object cover', () => {
  assert.doesNotMatch(catalogSource, /useMapObjectImageUrls/);
  assert.doesNotMatch(catalogSource, /Promise\.all\(\s*imageFiles\.map/);
  assert.doesNotMatch(catalogSource, /balloonImageUrls/);
});

test('detail page requests detail image for main photo and thumbnail image for carousel thumbs', () => {
  assert.match(detailSource, /variant="detail"/);
  assert.match(detailSource, /variant="thumbnail"/);
});

test('admin object media uses smaller variants for preview and gallery thumbnails', () => {
  assert.match(adminSource, /variant="card"/);
  assert.match(adminSource, /variant="thumbnail"/);
});
