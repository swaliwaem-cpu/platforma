import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '../src');
const appSource = readFileSync(resolve(srcDir, 'App.tsx'), 'utf8');
const baseStyles = readFileSync(resolve(srcDir, 'styles.css'), 'utf8');
const catalogRouteStylesPath = resolve(srcDir, 'catalog/catalog-route.css');
const catalogRouteStyles = existsSync(catalogRouteStylesPath) ? readFileSync(catalogRouteStylesPath, 'utf8') : '';
const catalogSource = readFileSync(resolve(srcDir, 'catalog/CatalogPage.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(srcDir, 'objects/ObjectDetailPage.tsx'), 'utf8');
const presentationsSource = readFileSync(resolve(srcDir, 'presentations/LotPresentationsPage.tsx'), 'utf8');

function selectorRulePattern(selector) {
  return new RegExp(`\\.${selector}(?:\\s*\\{|\\s*,)`);
}

test('catalog route keeps global shell styles at the app root', () => {
  assert.match(appSource, /import '\.\/styles\.css';/);
  assert.match(appSource, /import '\.\/app-theme\.css';/);
});

test('lazy catalog route owns its route-local CSS', () => {
  assert.equal(existsSync(catalogRouteStylesPath), true);
  assert.match(catalogSource, /import '\.\/catalog-route\.css';/);
  assert.doesNotMatch(appSource, /catalog-route\.css/);
  assert.doesNotMatch(objectDetailSource, /catalog-route\.css/);
  assert.doesNotMatch(presentationsSource, /catalog-route\.css/);
});

test('catalog route CSS is split out of the global stylesheet', () => {
  for (const selector of [
    'catalog-page',
    'catalog-view-actions',
    'catalog-count',
    'catalog-view-toggle',
    'catalog-map-button',
    'catalog-filters',
    'catalog-filter-search-row',
    'catalog-filter-header-actions',
    'catalog-filter-toggle',
    'catalog-filter-reset',
    'catalog-filter-fields',
    'catalog-filter-range',
    'catalog-sort-bar',
    'catalog-sort-row',
    'catalog-sort-button',
    'catalog-quick-links',
    'catalog-grid',
    'catalog-list',
    'catalog-list-item',
    'catalog-card',
    'catalog-card-media',
    'catalog-card-document-badges',
    'catalog-card-floor-plan-badge',
    'catalog-card-aerotour-badge',
    'catalog-pagination',
    'catalog-pagination-more',
    'catalog-pagination-arrow',
    'catalog-pagination-select',
    'catalog-map-layout',
    'catalog-map-panel',
    'catalog-map-list',
    'catalog-map-list-toggle',
    'catalog-map-empty',
    'map-object-card',
    'map-object-card-gallery',
    'map-object-card-gallery-button',
  ]) {
    assert.doesNotMatch(baseStyles, selectorRulePattern(selector));
    assert.match(catalogRouteStyles, selectorRulePattern(selector));
  }

  assert.doesNotMatch(baseStyles, /@keyframes catalog-media-loading/);
  assert.match(catalogRouteStyles, /@keyframes catalog-media-loading/);

  assert.match(baseStyles, /\.yandex-map\s*\{/);
  assert.match(baseStyles, /\.yandex-map-shell\s*\{/);
  assert.match(baseStyles, /\.map-price-marker\s*\{/);
  assert.match(baseStyles, /\.map-fallback\s*\{/);
  assert.match(baseStyles, /\.map-balloon\s*\{/);

  assert.doesNotMatch(catalogRouteStyles, /\.yandex-map\s*\{/);
  assert.doesNotMatch(catalogRouteStyles, /\.yandex-map-shell\s*\{/);
  assert.doesNotMatch(catalogRouteStyles, /\.map-price-marker/);
  assert.doesNotMatch(catalogRouteStyles, /\.map-fallback/);
  assert.doesNotMatch(catalogRouteStyles, /\.map-balloon/);
  assert.doesNotMatch(catalogRouteStyles, /lot-presentations-/);
  assert.doesNotMatch(catalogRouteStyles, /\.object-detail-/);
  assert.doesNotMatch(catalogRouteStyles, /\.object-feed-/);
  assert.doesNotMatch(catalogRouteStyles, /\.object-lot-/);
  assert.doesNotMatch(catalogRouteStyles, /\.object-image-carousel/);
  assert.doesNotMatch(catalogRouteStyles, /\.media-gallery-/);
  assert.doesNotMatch(catalogRouteStyles, /\.carousel-/);
  assert.doesNotMatch(catalogRouteStyles, /\.detail-/);
  assert.doesNotMatch(catalogRouteStyles, /\.admin-/);
  assert.doesNotMatch(catalogRouteStyles, /\.catalog-links-/);
  assert.doesNotMatch(catalogRouteStyles, /\.catalog-link-/);
  assert.doesNotMatch(catalogRouteStyles, /\.object-gallery/);
  assert.doesNotMatch(catalogRouteStyles, /\.gallery-thumb/);
  assert.doesNotMatch(catalogRouteStyles, /\.file-list/);
  assert.doesNotMatch(catalogRouteStyles, /\.quick-edit-/);
});
