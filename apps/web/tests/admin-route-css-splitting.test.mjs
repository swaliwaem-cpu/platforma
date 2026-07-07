import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '../src');
const appSource = readFileSync(resolve(srcDir, 'App.tsx'), 'utf8');
const baseStyles = readFileSync(resolve(srcDir, 'styles.css'), 'utf8');
const adminRouteStylesPath = resolve(srcDir, 'admin/admin-route-pages.css');
const adminRouteStyles = existsSync(adminRouteStylesPath) ? readFileSync(adminRouteStylesPath, 'utf8') : '';
const catalogLinksSource = readFileSync(resolve(srcDir, 'admin/CatalogLinksAdminPage.tsx'), 'utf8');
const feedsSource = readFileSync(resolve(srcDir, 'admin/FeedsAdminPage.tsx'), 'utf8');
const importSource = readFileSync(resolve(srcDir, 'admin/ImportAdminPage.tsx'), 'utf8');
const presentationsSource = readFileSync(resolve(srcDir, 'presentations/LotPresentationsPage.tsx'), 'utf8');

test('app keeps global shell and theme styles at the routing root', () => {
  assert.match(appSource, /import '\.\/styles\.css';/);
  assert.match(appSource, /import '\.\/app-theme\.css';/);
});

test('lazy admin route pages own their route-local CSS', () => {
  assert.equal(existsSync(adminRouteStylesPath), true);

  for (const source of [catalogLinksSource, feedsSource, importSource]) {
    assert.match(source, /import '\.\/admin-route-pages\.css';/);
  }

  assert.doesNotMatch(presentationsSource, /admin-route-pages\.css/);
});

test('admin route CSS is split out of the global stylesheet', () => {
  for (const selector of [
    'catalog-links-form',
    'catalog-links-columns',
    'catalog-link-row-settings',
    'feed-source-form',
    'feed-source-run-header',
    'feed-units-toolbar-main',
    'import-layout',
    'import-toolbar-main',
    'import-report-heading',
  ]) {
    assert.doesNotMatch(baseStyles, new RegExp(`\\.${selector}\\s*\\{`));
    assert.match(adminRouteStyles, new RegExp(`\\.${selector}\\s*\\{`));
  }

  assert.doesNotMatch(adminRouteStyles, /lot-presentations-/);
  assert.doesNotMatch(adminRouteStyles, /\.catalog-map-/);
  assert.doesNotMatch(adminRouteStyles, /\.object-/);
  assert.doesNotMatch(adminRouteStyles, /\.object-detail-/);
  assert.doesNotMatch(adminRouteStyles, /\.admin-objects/);
  assert.doesNotMatch(adminRouteStyles, /\.admin-users/);
  assert.doesNotMatch(adminRouteStyles, /\.user-/);
  assert.doesNotMatch(adminRouteStyles, /\.role-permissions-/);
  assert.doesNotMatch(adminRouteStyles, /\.permission-group/);
  assert.doesNotMatch(adminRouteStyles, /\.gallery-/);
  assert.doesNotMatch(adminRouteStyles, /\.object-quick-edit-/);
});
