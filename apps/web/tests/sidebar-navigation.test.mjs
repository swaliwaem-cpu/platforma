import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const navItemsStart = appSource.indexOf('const navItems: readonly NavItem[] = [');
const navItemsEnd = appSource.indexOf('\n];', navItemsStart);
const navItemsSource = appSource.slice(navItemsStart, navItemsEnd);

test('sidebar keeps cabinet navigation available for the plain user role', () => {
  assert.match(
    appSource,
    /id:\s*'cabinet',[\s\S]*?label:\s*'Кабинет',[\s\S]*?requiredPermissions:\s*\[\]/,
  );
  assert.doesNotMatch(appSource, /user\.role\.name\s*===\s*'user'[\s\S]*?item\.id\s*===\s*'cabinet'/);
});

test('sidebar catalog navigation exposes residential commercial and all sections', () => {
  assert.match(appSource, /children:\s*\[[\s\S]*id:\s*'catalog-life'[\s\S]*label:\s*'Жилая'[\s\S]*path:\s*'\/catalog\/life'/);
  assert.match(appSource, /children:\s*\[[\s\S]*id:\s*'catalog-comm'[\s\S]*label:\s*'Коммерция'[\s\S]*path:\s*'\/catalog\/comm'/);
  assert.match(appSource, /children:\s*\[[\s\S]*id:\s*'catalog-all'[\s\S]*label:\s*'Все'[\s\S]*path:\s*'\/catalog'/);
  assert.match(appSource, /className="nav-group"/);
  assert.match(appSource, /className="nav-submenu" role="menu" aria-label="Разделы каталога"/);
  assert.match(appSource, /className=\{pathname === child\.path \? 'nav-subitem nav-subitem--active' : 'nav-subitem'\}/);
});

test('sidebar keeps catalog as the final navigation item', () => {
  const topLevelNavItemIds = Array.from(
    navItemsSource.matchAll(/^ {4}id: '([^']+)'/gm),
    (match) => match[1],
  );

  assert.equal(topLevelNavItemIds.at(-1), 'catalog');
});
