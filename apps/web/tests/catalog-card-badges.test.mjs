import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '../../..');
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const baseStylesSource = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const catalogRouteStylesSource = readFileSync(resolve(currentDir, '../src/catalog/catalog-route.css'), 'utf8');
const stylesSource = `${baseStylesSource}\n${catalogRouteStylesSource}`;
const themeSource = readFileSync(resolve(currentDir, '../src/app-theme.css'), 'utf8');
const dockerfile = readFileSync(resolve(currentDir, '../Dockerfile'), 'utf8');
const floorPlanSvg = readFileSync(resolve(repoRoot, 'floor-plan.svg'), 'utf8');
const aerotourIconPath = resolve(repoRoot, 'aerotour-icon.png');

test('catalog card shows a floor plan badge only when imported lots exist', () => {
  const hasImportedLotsHelper =
    catalogSource.match(/function hasImportedLots\(object: RealEstateObjectSummary\)[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(catalogSource, /import floorPlanIconUrl from '\.\.\/\.\.\/\.\.\/\.\.\/floor-plan\.svg';/);
  assert.match(hasImportedLotsHelper, /typeof object\.feedUnitsCount !== 'number'/);
  assert.match(hasImportedLotsHelper, /Number\.isFinite\(object\.feedUnitsCount\)/);
  assert.match(hasImportedLotsHelper, /object\.feedUnitsCount > 0/);
  assert.match(catalogSource, /const hasImportedLotsBadge = hasImportedLots\(object\);/);
  assert.match(
    catalogSource,
    /const hasVisibleBadges = object\.status !== 'PUBLISHED' \|\| hasPresentation \|\| hasImportedLotsBadge \|\| hasAerotourBadge;/,
  );
  assert.match(catalogSource, /className="catalog-card-document-badges"/);
  assert.match(
    catalogSource,
    /hasImportedLotsBadge \? \([\s\S]*className="catalog-card-floor-plan-badge"[\s\S]*aria-label="Есть импортированные лоты"[\s\S]*<img[\s\S]*className="catalog-card-floor-plan-icon"[\s\S]*src=\{floorPlanIconUrl\}/,
  );
  assert.doesNotMatch(catalogSource, /--catalog-card-floor-plan-icon-url/);
});

test('catalog card shows an aerotour badge only when aerotour url exists', () => {
  assert.match(catalogSource, /import aerotourIconUrl from '\.\.\/\.\.\/\.\.\/\.\.\/aerotour-icon\.png';/);
  assert.match(catalogSource, /const hasAerotourBadge = hasExternalObjectUrl\(object\.aerotourUrl\);/);
  assert.match(
    catalogSource,
    /function hasExternalObjectUrl\(value: string \| null\) \{[\s\S]*?const trimmedValue = value\?\.trim\(\);[\s\S]*?if \(!trimmedValue\) \{[\s\S]*?return false;[\s\S]*?url\.protocol === 'http:' \|\| url\.protocol === 'https:';[\s\S]*?\}/,
  );
  assert.match(
    catalogSource,
    /const hasVisibleBadges = object\.status !== 'PUBLISHED' \|\| hasPresentation \|\| hasImportedLotsBadge \|\| hasAerotourBadge;/,
  );
  assert.match(
    catalogSource,
    /hasAerotourBadge \? \([\s\S]*className="catalog-card-aerotour-badge"[\s\S]*aria-label="Есть аэротур"[\s\S]*title="Есть аэротур"[\s\S]*<img[\s\S]*className="catalog-card-aerotour-icon"[\s\S]*src=\{aerotourIconUrl\}/,
  );
});

test('catalog floor plan badge uses a root svg asset and theme-aware colors', () => {
  assert.ok(existsSync(resolve(repoRoot, 'floor-plan.svg')), 'floor-plan.svg should exist in the repo root');
  assert.match(dockerfile, /COPY floor-plan\.svg \.\/floor-plan\.svg/);
  assert.match(stylesSource, /\.catalog-card-document-badges\s*\{[\s\S]*?margin-left:\s*auto;[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*8px;/);
  assert.match(
    stylesSource,
    /\.catalog-card-pdf-badge,\n\.catalog-card-floor-plan-badge,\n\.catalog-card-aerotour-badge\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?\}/,
  );
  assert.match(
    stylesSource,
    /\.catalog-card-floor-plan-badge\s*\{[\s\S]*?background:\s*var\(--catalog-floor-plan-badge-bg\);[\s\S]*?color:\s*var\(--catalog-floor-plan-badge-color\);[\s\S]*?\}/,
  );
  assert.match(
    stylesSource,
    /\.catalog-card-media\s+\.catalog-card-floor-plan-icon\s*\{[\s\S]*?width:\s*14\.4px;[\s\S]*?height:\s*14\.4px;[\s\S]*?filter:\s*var\(--catalog-floor-plan-icon-filter\);[\s\S]*?object-fit:\s*contain;[\s\S]*?\}/,
  );
  assert.match(
    themeSource,
    /html\[data-app-theme\]\s+\.catalog-card-media\s+\.catalog-card-floor-plan-icon\s*\{[\s\S]*?filter:\s*var\(--catalog-floor-plan-icon-filter\);[\s\S]*?object-fit:\s*contain;[\s\S]*?\}/,
  );
  assert.match(
    themeSource,
    /html\[data-app-theme="minimal-luxury"\]\s*\.catalog-card-floor-plan-badge\s*\{[\s\S]*?--catalog-floor-plan-badge-bg:\s*var\(--app-theme-accent\);[\s\S]*?--catalog-floor-plan-badge-color:\s*#fffefa;[\s\S]*?--catalog-floor-plan-icon-filter:\s*brightness\(0\) invert\(1\);/,
  );
  assert.match(
    themeSource,
    /html\[data-app-theme="dark-premium"\]\s*\.catalog-card-floor-plan-badge\s*\{[\s\S]*?--catalog-floor-plan-badge-bg:\s*var\(--app-theme-primary\);[\s\S]*?--catalog-floor-plan-badge-color:\s*#000000;[\s\S]*?--catalog-floor-plan-icon-filter:\s*brightness\(0\);/,
  );
});

test('catalog aerotour badge uses the provided root png asset and theme-aware colors', () => {
  assert.ok(existsSync(aerotourIconPath), 'aerotour-icon.png should exist in the repo root');
  assert.match(dockerfile, /COPY aerotour-icon\.png \.\/aerotour-icon\.png/);
  assert.match(
    stylesSource,
    /\.catalog-card-pdf-badge,\n\.catalog-card-floor-plan-badge,\n\.catalog-card-aerotour-badge\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?\}/,
  );
  assert.match(
    stylesSource,
    /\.catalog-card-aerotour-badge\s*\{[\s\S]*?background:\s*var\(--catalog-aerotour-badge-bg\);[\s\S]*?color:\s*var\(--catalog-aerotour-badge-color\);[\s\S]*?\}/,
  );
  assert.match(
    stylesSource,
    /\.catalog-card-media\s+\.catalog-card-aerotour-icon\s*\{[\s\S]*?width:\s*14\.4px;[\s\S]*?height:\s*14\.4px;[\s\S]*?filter:\s*var\(--catalog-aerotour-icon-filter\);[\s\S]*?object-fit:\s*contain;[\s\S]*?\}/,
  );
  assert.match(
    themeSource,
    /html\[data-app-theme\]\s+\.catalog-card-media\s+\.catalog-card-aerotour-icon\s*\{[\s\S]*?filter:\s*var\(--catalog-aerotour-icon-filter\);[\s\S]*?object-fit:\s*contain;[\s\S]*?\}/,
  );
  assert.match(
    themeSource,
    /html\[data-app-theme="minimal-luxury"\]\s*\.catalog-card-aerotour-badge\s*\{[\s\S]*?--catalog-aerotour-badge-bg:\s*var\(--app-theme-accent\);[\s\S]*?--catalog-aerotour-badge-color:\s*#fffefa;[\s\S]*?--catalog-aerotour-icon-filter:\s*brightness\(0\) invert\(1\);/,
  );
  assert.match(
    themeSource,
    /html\[data-app-theme="dark-premium"\]\s*\.catalog-card-aerotour-badge\s*\{[\s\S]*?--catalog-aerotour-badge-bg:\s*var\(--app-theme-primary\);[\s\S]*?--catalog-aerotour-badge-color:\s*#000000;[\s\S]*?--catalog-aerotour-icon-filter:\s*brightness\(0\);/,
  );
});

test('catalog floor plan svg uses the provided noun floor plan silhouette', () => {
  assert.match(floorPlanSvg, /viewBox="0 0 64 64"/);
  assert.match(floorPlanSvg, /<path fill="#000" d="M0 0h64v1H0z/);
  assert.match(floorPlanSvg, /M25 4h4v1H25z/);
  assert.match(floorPlanSvg, /M18 25h21v1H18z/);
  assert.match(floorPlanSvg, /M47 25h17v1H47z/);
  assert.match(floorPlanSvg, /M41 57h6v1H41z/);
  assert.doesNotMatch(floorPlanSvg, /stroke=/);
});
