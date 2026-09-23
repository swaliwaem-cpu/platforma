import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const roleLabelsSource = readFileSync(resolve(currentDir, '../src/auth/roleLabels.ts'), 'utf8');
const navItemsStart = appSource.indexOf('const navItems: readonly NavItem[] = [');
const navItemsEnd = appSource.indexOf('\n];', navItemsStart);
const navItemsSource = appSource.slice(navItemsStart, navItemsEnd);

test('sidebar opens with the residential catalog in place of the cabinet', () => {
  const topLevelNavItemIds = Array.from(
    navItemsSource.matchAll(/^ {4}id: '([^']+)'/gm),
    (match) => match[1],
  );

  assert.deepEqual(topLevelNavItemIds, ['catalog', 'presentations', 'training', 'admin']);
  assert.match(
    navItemsSource,
    /id: 'catalog',\n {4}label: 'Каталог',\n {4}path: '\/catalog\/life',\n {4}section: 'catalog'/,
  );
  assert.doesNotMatch(navItemsSource, /label: 'Кабинет'/);
  assert.doesNotMatch(navItemsSource, /children:/);
});

test('cabinet stays reachable from the sidebar user card', () => {
  assert.match(appSource, /className="sidebar-user"[\s\S]*?onClick=\{\(\) => navigate\('\/cabinet'\)\}/);
});

test('roles are rendered with russian labels, including the marketing role', () => {
  assert.match(roleLabelsSource, /marketing: 'Маркетинг'/);
  assert.match(roleLabelsSource, /admin: 'Администратор'/);
  assert.match(roleLabelsSource, /user: 'Пользователь'/);
  assert.match(roleLabelsSource, /return roleLabels\[name\] \?\? name;/);
  assert.match(appSource, /formatRoleName\(user\.role\.name\)/);
  assert.doesNotMatch(appSource, /\{user\.role\.name\}/);
});
