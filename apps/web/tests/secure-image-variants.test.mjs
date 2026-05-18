import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const secureImagePath = resolve(currentDir, '../src/files/SecureImage.tsx');
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const detailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const adminSource = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('web has shared secure image helper with variant-aware file content URL', () => {
  assert.equal(existsSync(secureImagePath), true);

  const secureImageSource = readFileSync(secureImagePath, 'utf8');

  assert.match(secureImageSource, /export function SecureImage/);
  assert.match(secureImageSource, /export function useSecureImageObjectUrl/);
  assert.match(secureImageSource, /export function buildMediaFileContentUrl/);
  assert.match(secureImageSource, /\/media\/files\/\$\{encodeURIComponent\(fileId\)\}\/content/);
  assert.match(secureImageSource, /params\.set\('variant', variant\)/);
  assert.match(secureImageSource, /IntersectionObserver/);
  assert.doesNotMatch(secureImageSource, /fetchSecureImageObjectUrl/);
  assert.doesNotMatch(secureImageSource, /response\.blob\(\)/);
  assert.doesNotMatch(secureImageSource, /URL\.createObjectURL/);
});

test('secure image default loading state does not show visible copy', () => {
  const secureImageSource = readFileSync(secureImagePath, 'utf8');

  assert.match(secureImageSource, /loadingFallback = null/);
  assert.doesNotMatch(secureImageSource, /loadingFallback = 'Загрузка изображения'/);
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

test('detail page opens files through media URL without blob fetches', () => {
  const secureFileButtonSource = extractFunctionSource(detailSource, 'function SecureFileButton');

  assert.match(detailSource, /buildMediaFileContentUrl/);
  assert.match(secureFileButtonSource, /window\.open\(buildMediaFileContentUrl\(fileId\), '_blank', 'noopener,noreferrer'\)/);
  assert.doesNotMatch(secureFileButtonSource, /\bfetch\(/);
  assert.doesNotMatch(secureFileButtonSource, /response\.blob\(\)/);
  assert.doesNotMatch(secureFileButtonSource, /URL\.createObjectURL/);
});

test('profile photo uses media thumbnail URL without legacy profile content fetch', () => {
  const secureProfileImageSource = extractFunctionSource(appSource, 'function SecureProfileImage');

  assert.doesNotMatch(appSource, /\/users\/me\/profile-photo\/content/);
  assert.match(secureProfileImageSource, /buildMediaFileContentUrl\(fileId, 'thumbnail'\)/);
  assert.doesNotMatch(secureProfileImageSource, /\bfetch\(/);
  assert.doesNotMatch(secureProfileImageSource, /response\.blob\(\)/);
  assert.doesNotMatch(secureProfileImageSource, /URL\.createObjectURL/);
});

test('admin object media uses smaller variants for preview and gallery thumbnails', () => {
  assert.match(adminSource, /variant="card"/);
  assert.match(adminSource, /variant="thumbnail"/);
});

function extractFunctionSource(source, marker) {
  const markerIndex = source.indexOf(marker);

  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const nextFunctionIndex = source.indexOf('\nfunction ', markerIndex + marker.length);

  return source.slice(markerIndex, nextFunctionIndex === -1 ? source.length : nextFunctionIndex);
}
