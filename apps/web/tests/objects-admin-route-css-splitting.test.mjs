import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '../src');
const appSource = readFileSync(resolve(srcDir, 'App.tsx'), 'utf8');
const baseStyles = readFileSync(resolve(srcDir, 'styles.css'), 'utf8');
const objectsRouteStylesPath = resolve(srcDir, 'admin/objects-admin-route.css');
const objectsRouteStyles = existsSync(objectsRouteStylesPath) ? readFileSync(objectsRouteStylesPath, 'utf8') : '';
const objectsSource = readFileSync(resolve(srcDir, 'admin/ObjectsAdminPage.tsx'), 'utf8');
const presentationsSource = readFileSync(resolve(srcDir, 'presentations/LotPresentationsPage.tsx'), 'utf8');

function selectorRulePattern(selector) {
  return new RegExp(`\\.${selector}(?:\\s*\\{|\\s*,)`);
}

test('objects admin route keeps global shell styles at the app root', () => {
  assert.match(appSource, /import '\.\/styles\.css';/);
  assert.match(appSource, /import '\.\/app-theme\.css';/);
});

test('lazy objects admin route owns its route-local CSS', () => {
  assert.equal(existsSync(objectsRouteStylesPath), true);
  assert.match(objectsSource, /import '\.\/objects-admin-route\.css';/);
  assert.doesNotMatch(appSource, /objects-admin-route\.css/);
  assert.doesNotMatch(presentationsSource, /objects-admin-route\.css/);
});

test('objects admin route CSS is split out of the global stylesheet', () => {
  for (const selector of [
    'admin-objects',
    'admin-objects--editor',
    'object-toolbar-main',
    'object-toolbar-actions',
    'object-toolbar-advanced',
    'object-quick-edit-table',
    'object-quick-column--title',
    'object-quick-column--developer',
    'object-quick-column--metro',
    'object-quick-column--coordinates',
    'quick-edit-input',
    'quick-edit-select',
    'quick-edit-cell-button',
    'quick-edit-error',
    'object-title-open',
    'object-title-edit-button',
    'object-editor-layout',
    'object-form-section',
    'panel-title-row',
    'object-preview',
    'preview-media',
    'media-panel',
    'file-upload-fields',
    'upload-row',
    'upload-file-button',
    'file-list',
    'file-main',
    'file-actions',
    'gallery-modal-backdrop',
    'gallery-modal',
    'gallery-close-confirm',
    'gallery-cover-slot',
    'gallery-upload-dropzone',
    'gallery-tile-grid',
    'gallery-tile',
    'gallery-tile-button',
    'gallery-modal-progress',
  ]) {
    assert.doesNotMatch(baseStyles, selectorRulePattern(selector));
    assert.match(objectsRouteStyles, selectorRulePattern(selector));
  }

  assert.doesNotMatch(objectsRouteStyles, /lot-presentations-/);
  assert.doesNotMatch(objectsRouteStyles, /\.object-detail-/);
  assert.doesNotMatch(objectsRouteStyles, /\.object-feed-/);
  assert.doesNotMatch(objectsRouteStyles, /\.object-lot-/);
  assert.doesNotMatch(objectsRouteStyles, /\.object-image-carousel/);
  assert.doesNotMatch(objectsRouteStyles, /\.media-gallery-/);
  assert.doesNotMatch(objectsRouteStyles, /\.carousel-/);
  assert.doesNotMatch(objectsRouteStyles, /\.detail-/);
  assert.doesNotMatch(objectsRouteStyles, /\.catalog-map-/);
  assert.doesNotMatch(objectsRouteStyles, /\.catalog-card/);
  assert.doesNotMatch(objectsRouteStyles, /\.catalog-list/);
  assert.doesNotMatch(objectsRouteStyles, /\.catalog-filter/);
  assert.doesNotMatch(objectsRouteStyles, /\.map-object-card/);
  assert.doesNotMatch(objectsRouteStyles, /\.map-price-marker/);
  assert.doesNotMatch(objectsRouteStyles, /\.yandex-map/);
  assert.doesNotMatch(objectsRouteStyles, /\.admin-feeds/);
  assert.doesNotMatch(objectsRouteStyles, /\.admin-import/);
  assert.doesNotMatch(objectsRouteStyles, /\.admin-catalog-links/);
  assert.doesNotMatch(objectsRouteStyles, /\.feed-source-/);
  assert.doesNotMatch(objectsRouteStyles, /\.feed-unit/);
  assert.doesNotMatch(objectsRouteStyles, /\.import-/);
  assert.doesNotMatch(objectsRouteStyles, /\.catalog-links-/);
  assert.doesNotMatch(objectsRouteStyles, /\.admin-users/);
  assert.doesNotMatch(objectsRouteStyles, /\.user-form-/);
  assert.doesNotMatch(objectsRouteStyles, /\.user-toolbar-/);
  assert.doesNotMatch(objectsRouteStyles, /\.permission-group/);
});
