import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');

test('admin catalog links route is registered in app routing and admin home', () => {
  assert.match(appSource, /const CatalogLinksAdminPage = lazy\(\(\) => import\('\.\/admin\/CatalogLinksAdminPage'\)\.then\(\(module\) => \(\{ default: module\.CatalogLinksAdminPage \}\)\)\);/);
  assert.match(appSource, /pathname\.startsWith\('\/admin\/catalog-links'\)/);
  assert.match(appSource, /<CatalogLinksAdminPage onBack=\{\(\) => navigate\('\/admin'\)\} \/>/);
  assert.match(appSource, /onOpenCatalogLinks=\{\(\) => navigate\('\/admin\/catalog-links'\)\}/);
  assert.match(appSource, /id:\s*'admin-catalog-links'[\s\S]*label:\s*'Ссылки каталога'[\s\S]*path:\s*'\/admin\/catalog-links'[\s\S]*requiredPermissions:\s*\['admin:access', 'objects:update'\]/);
});

test('admin home exposes catalog links card for object editors', () => {
  assert.match(appSource, /label:\s*'Ссылки каталога'/);
  assert.match(appSource, /canAccess:\s*hasPermission\('objects:update'\)/);
  assert.match(appSource, /onClick:\s*onOpenCatalogLinks/);
});
