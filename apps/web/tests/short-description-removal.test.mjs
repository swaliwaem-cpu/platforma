import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const adminSource = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');

test('objects admin editor does not expose short description editing or preview copy', () => {
  assert.doesNotMatch(adminSource, /object-short-description/);
  assert.doesNotMatch(adminSource, /Короткое описание/);
  assert.doesNotMatch(adminSource, /shortDescription:\s*emptyToNull/);
});

test('catalog card does not render short description text', () => {
  assert.doesNotMatch(catalogSource, /catalog-card-description/);
  assert.doesNotMatch(catalogSource, /shortDescription\?\.trim/);
});

test('object detail text falls back to imported feature sections, not short description', () => {
  assert.doesNotMatch(objectDetailSource, /object\.shortDescription/);
});
