import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');

test('app code-splits heavy route pages with React lazy', () => {
  const reactImport = appSource.match(/import \{ (?<imports>[^}]+) \} from 'react';/)?.groups?.imports ?? '';

  assert.match(reactImport, /\blazy\b/);
  assert.match(reactImport, /\bSuspense\b/);

  for (const routeImport of [
    /import \{ CatalogPage \} from '\.\/catalog\/CatalogPage';/,
    /import \{ ObjectDetailPage, ObjectLotDetailPage \} from '\.\/objects\/ObjectDetailPage';/,
    /import \{ UsersAdminPage \} from '\.\/admin\/UsersAdminPage';/,
    /import \{ ObjectsAdminPage \} from '\.\/admin\/ObjectsAdminPage';/,
    /import \{ CatalogLinksAdminPage \} from '\.\/admin\/CatalogLinksAdminPage';/,
    /import \{ FeedsAdminPage \} from '\.\/admin\/FeedsAdminPage';/,
    /import \{ ImportAdminPage \} from '\.\/admin\/ImportAdminPage';/,
  ]) {
    assert.doesNotMatch(appSource, routeImport);
  }

  assert.match(appSource, /const CatalogPage = lazy\(\(\) => import\('\.\/catalog\/CatalogPage'\)\.then\(\(module\) => \(\{ default: module\.CatalogPage \}\)\)\);/);
  assert.match(appSource, /const ObjectDetailPage = lazy\(\(\) => import\('\.\/objects\/ObjectDetailPage'\)\.then\(\(module\) => \(\{ default: module\.ObjectDetailPage \}\)\)\);/);
  assert.match(appSource, /const ObjectLotDetailPage = lazy\(\(\) => import\('\.\/objects\/ObjectDetailPage'\)\.then\(\(module\) => \(\{ default: module\.ObjectLotDetailPage \}\)\)\);/);
  assert.match(appSource, /const UsersAdminPage = lazy\(\(\) => import\('\.\/admin\/UsersAdminPage'\)\.then\(\(module\) => \(\{ default: module\.UsersAdminPage \}\)\)\);/);
  assert.match(appSource, /const ObjectsAdminPage = lazy\(\(\) => import\('\.\/admin\/ObjectsAdminPage'\)\.then\(\(module\) => \(\{ default: module\.ObjectsAdminPage \}\)\)\);/);
  assert.match(appSource, /const CatalogLinksAdminPage = lazy\(\(\) => import\('\.\/admin\/CatalogLinksAdminPage'\)\.then\(\(module\) => \(\{ default: module\.CatalogLinksAdminPage \}\)\)\);/);
  assert.match(appSource, /const FeedsAdminPage = lazy\(\(\) => import\('\.\/admin\/FeedsAdminPage'\)\.then\(\(module\) => \(\{ default: module\.FeedsAdminPage \}\)\)\);/);
  assert.match(appSource, /const ImportAdminPage = lazy\(\(\) => import\('\.\/admin\/ImportAdminPage'\)\.then\(\(module\) => \(\{ default: module\.ImportAdminPage \}\)\)\);/);
});

test('app keeps presentations route out of this code-splitting step', () => {
  assert.match(appSource, /import \{ LotPresentationsPage \} from '\.\/presentations\/LotPresentationsPage';/);
  assert.doesNotMatch(appSource, /const LotPresentationsPage = lazy/);
});

test('lazy route pages render inside the workspace suspense boundary', () => {
  assert.match(appSource, /<Suspense fallback=\{<RouteLoadingFallback \/>\}>[\s\S]*?activeSection === 'admin'/);
  assert.match(appSource, /function RouteLoadingFallback\(\)/);
});
