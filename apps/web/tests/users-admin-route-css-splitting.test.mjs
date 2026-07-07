import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '../src');
const appSource = readFileSync(resolve(srcDir, 'App.tsx'), 'utf8');
const baseStyles = readFileSync(resolve(srcDir, 'styles.css'), 'utf8');
const usersRouteStylesPath = resolve(srcDir, 'admin/users-admin-route.css');
const usersRouteStyles = existsSync(usersRouteStylesPath) ? readFileSync(usersRouteStylesPath, 'utf8') : '';
const usersSource = readFileSync(resolve(srcDir, 'admin/UsersAdminPage.tsx'), 'utf8');
const objectsSource = readFileSync(resolve(srcDir, 'admin/ObjectsAdminPage.tsx'), 'utf8');
const presentationsSource = readFileSync(resolve(srcDir, 'presentations/LotPresentationsPage.tsx'), 'utf8');

function selectorRulePattern(selector) {
  return new RegExp(`\\.${selector}(?:\\s*\\{|\\s*,|\\s+|:)`);
}

test('users admin route owns its route-local CSS', () => {
  assert.equal(existsSync(usersRouteStylesPath), true);
  assert.match(usersSource, /import '\.\/users-admin-route\.css';/);
  assert.doesNotMatch(appSource, /users-admin-route\.css/);
  assert.doesNotMatch(objectsSource, /users-admin-route\.css/);
  assert.doesNotMatch(presentationsSource, /users-admin-route\.css/);
});

test('users admin CSS is split out of the global stylesheet', () => {
  assert.doesNotMatch(baseStyles, /\.admin-users\s*\{/);
  assert.doesNotMatch(baseStyles, /\.admin-users\s+\.page-header/);
  assert.doesNotMatch(baseStyles, /\.admin-users\s+\.toolbar/);
  assert.doesNotMatch(baseStyles, /\.admin-users\s+table/);
  assert.match(usersRouteStyles, /\.admin-users\s*\{/);
  assert.match(usersRouteStyles, /\.admin-users\s+\.page-header/);
  assert.match(usersRouteStyles, /\.admin-users\s+\.toolbar/);
  assert.match(usersRouteStyles, /\.admin-users\s+table/);

  for (const selector of [
    'user-toolbar-main',
    'user-toolbar-actions',
    'users-layout',
    'user-email-column',
    'user-name-column',
    'user-role-column',
    'user-status-column',
    'user-created-column',
    'user-action-column',
    'user-identity-cell',
    'user-status-cell',
    'user-row--deactivated',
    'user-form',
    'user-form-fields',
    'user-form-sections',
    'user-form-section',
    'user-form-section-header',
    'role-pill--table',
    'role-pill--panel',
    'role-permissions-panel',
    'role-permissions-header',
    'role-permissions-title',
    'permission-groups',
    'permission-group',
    'permission-group-title',
    'permission-chip-list--grid',
    'permission-chip--role',
    'deactivation-confirm',
    'deactivation-confirm-actions',
    'action-hint-list',
  ]) {
    assert.doesNotMatch(baseStyles, selectorRulePattern(selector));
    assert.match(usersRouteStyles, selectorRulePattern(selector));
  }
});

test('users admin split keeps shared and protected styles global', () => {
  assert.match(baseStyles, /\.workspace:has\(\.admin-users\)/);
  assert.match(baseStyles, /\.toolbar\s*\{/);
  assert.match(baseStyles, /\.toolbar-field\s*\{/);
  assert.match(baseStyles, /\.toolbar-input-shell\s*\{/);
  assert.match(baseStyles, /\.table-panel\s*,/);
  assert.match(baseStyles, /\.editor-panel\s*,/);
  assert.match(baseStyles, /\.admin-table\s+\[data-slot="table-cell"\]/);
  assert.match(baseStyles, /\.status-pill\s*\{/);
  assert.match(baseStyles, /\.role-pill\s*,\s*\.permission-chip\s*\{/);
  assert.match(baseStyles, /\.permission-chip-list\s*\{/);
  assert.match(baseStyles, /\.form-grid\s*\{/);

  assert.doesNotMatch(usersRouteStyles, /lot-presentations-/);
  assert.doesNotMatch(usersRouteStyles, /\.object-detail-/);
  assert.doesNotMatch(usersRouteStyles, /\.object-feed-/);
  assert.doesNotMatch(usersRouteStyles, /\.object-lot-/);
  assert.doesNotMatch(usersRouteStyles, /\.catalog-/);
  assert.doesNotMatch(usersRouteStyles, /\.map-/);
  assert.doesNotMatch(usersRouteStyles, /\.yandex-map/);
  assert.doesNotMatch(usersRouteStyles, /\.gallery-/);
  assert.doesNotMatch(usersRouteStyles, /\.file-list/);
  assert.doesNotMatch(usersRouteStyles, /\.quick-edit-/);
  assert.doesNotMatch(usersRouteStyles, /\.admin-objects/);
  assert.doesNotMatch(usersRouteStyles, /\.admin-catalog-links/);
  assert.doesNotMatch(usersRouteStyles, /\.admin-feeds/);
  assert.doesNotMatch(usersRouteStyles, /\.admin-import/);
});
