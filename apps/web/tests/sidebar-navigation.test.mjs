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
  assert.match(appSource, /className="sidebar-user"[\s\S]*?onClick=\{\(\) => navigateFromMenu\('\/cabinet'\)\}/);
});

test('phone tab bar lists real estate, presentations, search, profile and then the menu', () => {
  const tabBarSource = readFileSync(resolve(currentDir, '../src/navigation/MobileTabBar.tsx'), 'utf8');
  const mobileTabsStart = appSource.indexOf('const mobileTabs: MobileTab[] = [');
  const mobileTabsSource = appSource.slice(mobileTabsStart, appSource.indexOf('\n  ];', mobileTabsStart));
  const tabIds = Array.from(mobileTabsSource.matchAll(/id: '([^']+)', label: '([^']+)'|id: '([^']+)',\n\s+label: '([^']+)'/g), (match) => [
    match[1] ?? match[3],
    match[2] ?? match[4],
  ]);

  assert.deepEqual(tabIds, [
    ['catalog', 'Недвижимость'],
    ['presentations', 'Подборки'],
    ['search', 'Поиск'],
    ['profile', 'Профиль'],
  ]);
  assert.match(tabBarSource, /\{tabs\.map\([\s\S]*?\)\}\s*<button\s+aria-controls="main-sidebar-content"\s+aria-expanded=\{isMenuOpen\}[\s\S]*?<span>Меню<\/span>/);
  assert.match(appSource, /<MobileTabBar[\s\S]*?onToggleMenu=\{\(\) => setIsSidebarOpen\(\(isOpen\) => !isOpen\)\}/);
});

test('phone search tab opens the catalog with the search field focused', () => {
  const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');

  assert.match(appSource, /setIsCatalogSearchFocusRequested\(true\);\s*if \(!isCatalogSearchPathname\(pathname\)\) \{\s*navigate\(catalogNavItem\.path\);/);
  assert.match(appSource, /isSearchFocusRequested=\{isCatalogSearchFocusRequested\}/);
  assert.match(catalogSource, /useLayoutEffect\(\(\) => \{\s*if \(!isSearchFocusRequested\) \{\s*return;\s*\}\s*searchInputRef\.current\?\.focus\(\);\s*onSearchFocused\(\);/);
  assert.match(catalogSource, /ref=\{searchInputRef\}\s*placeholder="Название, адрес, застройщик"/);
});

test('roles are rendered with russian labels, including the marketing role', () => {
  assert.match(roleLabelsSource, /marketing: 'Маркетинг'/);
  assert.match(roleLabelsSource, /admin: 'Администратор'/);
  assert.match(roleLabelsSource, /user: 'Пользователь'/);
  assert.match(roleLabelsSource, /return roleLabels\[name\] \?\? name;/);
  assert.match(appSource, /formatRoleName\(user\.role\.name\)/);
  assert.doesNotMatch(appSource, /\{user\.role\.name\}/);
});
