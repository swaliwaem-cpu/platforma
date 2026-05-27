import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '../src');

test('app theme module defines the production theme model', () => {
  const appThemeSourcePath = resolve(srcDir, 'appTheme.ts');

  assert.ok(existsSync(appThemeSourcePath), 'appTheme.ts should exist');

  const appThemeSource = readFileSync(appThemeSourcePath, 'utf8');

  assert.match(appThemeSource, /export type AppTheme = 'minimal-luxury' \| 'dark-premium';/);
  assert.match(appThemeSource, /defaultAppTheme: AppTheme = 'minimal-luxury'/);
  assert.match(appThemeSource, /appThemeStorageKey = 'platforma\.theme'/);
  assert.match(appThemeSource, /c:\s*'dark-premium'/);
  assert.match(appThemeSource, /d:\s*'minimal-luxury'/);
  assert.match(appThemeSource, /new URLSearchParams\(search\)/);
  assert.match(appThemeSource, /localStorage/);
  assert.match(appThemeSource, /document\.documentElement\.dataset\.appTheme/);
  assert.doesNotMatch(appThemeSource, /'a'/);
  assert.doesNotMatch(appThemeSource, /'b'/);
});

test('app theme stylesheet exposes only minimal luxury and dark premium themes', () => {
  const stylesPath = resolve(srcDir, 'app-theme.css');

  assert.ok(existsSync(stylesPath), 'app-theme.css should exist');

  const styles = readFileSync(stylesPath, 'utf8');

  assert.match(styles, /html\[data-app-theme="minimal-luxury"\]/);
  assert.match(styles, /html\[data-app-theme="dark-premium"\]/);
  assert.doesNotMatch(styles, /data-design-preview/);
  assert.doesNotMatch(styles, /data-app-theme="a"/);
  assert.doesNotMatch(styles, /data-app-theme="b"/);

  assert.match(styles, /\.catalog-card/);
  assert.match(styles, /\.admin-table/);
  assert.match(styles, /\.object-detail-hero/);
  assert.match(styles, /:focus-visible/);
});

test('app theme stylesheet covers contrast-sensitive dark theme selectors', () => {
  const styles = readFileSync(resolve(srcDir, 'app-theme.css'), 'utf8');

  [
    '.permission-group-title',
    '.permission-chip--role code',
    '.object-description',
    '.object-content-section-text',
    '.object-content-section-text--empty',
    '.object-feed-unit-cell strong',
    '.object-feed-unit-cell span',
    '.object-feed-media-button',
    '.object-feed-media-empty',
    '.object-feed-media-carousel',
    '.object-feed-media-fullscreen',
    '.object-feed-status--available',
    '.feed-details dd',
    '.metro-list strong',
    '.carousel-thumbnail',
    '.gallery-close-confirm strong',
    '.gallery-close-confirm span',
  ].forEach((selector) => {
    assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('app theme suppresses pressed-state flicker for interactive controls', () => {
  const themeStyles = readFileSync(resolve(srcDir, 'app-theme.css'), 'utf8');
  const baseStyles = readFileSync(resolve(srcDir, 'styles.css'), 'utf8');
  const buttonSource = readFileSync(resolve(srcDir, 'components/ui/button.tsx'), 'utf8');

  assert.match(
    baseStyles,
    /button\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*transparent;[\s\S]*?-webkit-tap-highlight-color:\s*transparent;[\s\S]*?touch-action:\s*manipulation;[\s\S]*?\}/,
  );
  assert.match(
    themeStyles,
    /html\[data-app-theme\] :is\(button, \[role="button"\], \[data-slot="button"\], summary\)\s*\{[\s\S]*?-webkit-tap-highlight-color:\s*transparent;[\s\S]*?\}/,
  );
  assert.match(
    themeStyles,
    /html\[data-app-theme\] :is\(button, \[role="button"\], \[data-slot="button"\]\):active\s*\{[\s\S]*?transform:\s*none;[\s\S]*?translate:\s*none;[\s\S]*?\}/,
  );
  assert.match(
    themeStyles,
    /html\[data-app-theme\] :is\(\[data-slot="skeleton"\], \.feed-table-skeleton, \.import-table-skeleton, \.object-feed-units-skeleton\)\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--app-theme-surface-muted\) 78%,\s*var\(--app-theme-border-soft\)\);[\s\S]*?\}/,
  );
  assert.match(buttonSource, /transition-colors/);
  assert.doesNotMatch(buttonSource, /active:not-aria-\[haspopup\]:translate-y-px/);
  assert.doesNotMatch(buttonSource, /transition-all/);
});

test('app initialization uses the production theme before mounting React', () => {
  const mainSource = readFileSync(resolve(srcDir, 'main.tsx'), 'utf8');

  assert.match(mainSource, /import \{ initAppTheme \} from '\.\/appTheme';/);
  assert.doesNotMatch(mainSource, /designPreview|initDesignPreviewTheme/);
  assert.ok(
    mainSource.indexOf('initAppTheme();') < mainSource.indexOf('createRoot('),
    'initAppTheme should run before createRoot',
  );
});

test('sidebar exposes an icon-only theme toggle wired to app theme helpers', () => {
  const appSource = readFileSync(resolve(srcDir, 'App.tsx'), 'utf8');
  const styles = readFileSync(resolve(srcDir, 'styles.css'), 'utf8');
  const themeStyles = readFileSync(resolve(srcDir, 'app-theme.css'), 'utf8');

  assert.match(appSource, /import \{ MenuIcon,\s*MoonIcon,\s*SunIcon \} from 'lucide-react';/);
  assert.match(appSource, /import \{[\s\S]*getAppliedAppTheme[\s\S]*getNextAppTheme[\s\S]*setAppTheme[\s\S]*\} from '\.\/appTheme';/);
  assert.match(appSource, /import '\.\/app-theme\.css';/);
  assert.doesNotMatch(appSource, /design-preview\.css/);
  assert.match(appSource, /const \[appTheme,\s*setAppThemeState\] = useState/);
  assert.match(appSource, /getAppliedAppTheme\(\)/);
  assert.match(appSource, /getNextAppTheme\(appTheme\)/);
  assert.match(appSource, /setAppTheme\(nextTheme\)/);
  assert.match(appSource, /setAppThemeState\(nextTheme\)/);
  assert.match(appSource, /className="theme-toggle"/);
  assert.match(appSource, /type="button"/);
  assert.match(appSource, /aria-label=\{themeToggleLabel\}/);
  assert.match(appSource, /title=\{themeToggleLabel\}/);
  assert.match(appSource, /tabIndex=\{isSidebarOpen \? 0 : -1\}/);
  assert.match(appSource, /<MoonIcon aria-hidden="true" \/>/);
  assert.match(appSource, /<SunIcon aria-hidden="true" \/>/);
  assert.ok(
    appSource.indexOf('className="theme-toggle"') > appSource.indexOf('className="sidebar-brand"'),
    'theme toggle should render after sidebar brand',
  );
  assert.ok(
    appSource.indexOf('className="theme-toggle"') < appSource.indexOf('<nav className="nav-list">'),
    'theme toggle should render before nav list',
  );
  assert.match(styles, /\.theme-toggle/);
  assert.match(styles, /\.theme-toggle svg/);
  assert.match(themeStyles, /:is\([^)]*\.theme-toggle[^)]*\)/);
});

test('sidebar opens as an overlay without shifting the workspace', () => {
  const appSource = readFileSync(resolve(srcDir, 'App.tsx'), 'utf8');
  const styles = readFileSync(resolve(srcDir, 'styles.css'), 'utf8');

  assert.doesNotMatch(appSource, /app-shell--sidebar-open/);
  assert.match(styles, /\.app-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?\}/);
  assert.doesNotMatch(styles, /\.app-shell--sidebar-open/);
  assert.match(
    styles,
    /\.workspace\s*\{[\s\S]*?display:\s*grid;[\s\S]*?justify-items:\s*center;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.sidebar\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?width:\s*var\(--sidebar-toggle-size\);[\s\S]*?height:\s*var\(--sidebar-toggle-size\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.sidebar--open\s*\{[\s\S]*?width:\s*var\(--sidebar-width\);[\s\S]*?height:\s*auto;[\s\S]*?max-height:\s*calc\(100vh - 32px\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\) \{[\s\S]*?\.workspace:has\(\.catalog-page\)[\s\S]*?padding:\s*80px 20px 20px;[\s\S]*?\}/,
  );
});
