import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '../../..');
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const stylesSource = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const themeSource = readFileSync(resolve(currentDir, '../src/app-theme.css'), 'utf8');
const fluffyWhiteSource = readFileSync(resolve(currentDir, '../src/fluffy-white-theme.css'), 'utf8');
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
    /hasImportedLotsBadge \? \([\s\S]*className="catalog-card-floor-plan-badge"[\s\S]*aria-label="Есть импортированные лоты"[\s\S]*<span[\s\S]*className="catalog-card-floor-plan-icon"[\s\S]*style=\{getCatalogCardIconMaskStyle\(floorPlanIconUrl\)\}/,
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
    /hasAerotourBadge \? \([\s\S]*className="catalog-card-aerotour-badge"[\s\S]*aria-label="Есть аэротур"[\s\S]*title="Есть аэротур"[\s\S]*<span[\s\S]*className="catalog-card-aerotour-icon"[\s\S]*style=\{getCatalogCardIconMaskStyle\(aerotourIconUrl\)\}/,
  );
});

test('catalog photo indicators share one 36px square and paint glyphs in currentColor', () => {
  assert.ok(existsSync(resolve(repoRoot, 'floor-plan.svg')), 'floor-plan.svg should exist in the repo root');
  assert.ok(existsSync(aerotourIconPath), 'aerotour-icon.png should exist in the repo root');
  assert.match(dockerfile, /COPY floor-plan\.svg \.\/floor-plan\.svg/);
  assert.match(dockerfile, /COPY aerotour-icon\.png \.\/aerotour-icon\.png/);
  assert.match(catalogSource, /function getCatalogCardIconMaskStyle\(iconUrl: string\): CSSProperties \{[\s\S]*?return \{ maskImage, WebkitMaskImage: maskImage \};/);
  assert.match(stylesSource, /\.catalog-card-document-badges\s*\{[\s\S]*?margin-left:\s*auto;[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*8px;/);
  assert.match(
    stylesSource,
    /\.catalog-card-pdf-badge,\n\.catalog-card-floor-plan-badge,\n\.catalog-card-aerotour-badge\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?align-items:\s*center;[\s\S]*?border-radius:\s*11px;[\s\S]*?\}/,
  );
  assert.match(
    stylesSource,
    /\.catalog-card-media \.catalog-card-floor-plan-icon,\n\.catalog-card-media \.catalog-card-aerotour-icon\s*\{[\s\S]*?background-color:\s*currentColor;[\s\S]*?mask-size:\s*contain;/,
  );
  assert.doesNotMatch(stylesSource, /--catalog-(floor-plan|aerotour)-(badge-bg|icon-filter)/);
  assert.doesNotMatch(themeSource, /--catalog-(floor-plan|aerotour)-(badge-bg|icon-filter)/);

  const indicators = '\\.catalog-card-pdf-badge, \\.catalog-card-floor-plan-badge, \\.catalog-card-aerotour-badge';
  assert.match(
    fluffyWhiteSource,
    new RegExp(`\\.catalog-card :is\\(${indicators}\\) \\{[\\s\\S]*?border-radius: 11px;[\\s\\S]*?background: rgb\\(255 255 255 \\/ 28%\\);[\\s\\S]*?color: rgb\\(34 35 31\\);`),
  );
  assert.match(
    themeSource,
    new RegExp(`html\\[data-app-theme="dark-premium"\\] \\.catalog-card :is\\(${indicators}\\):hover \\{[\\s\\S]*?border-color: var\\(--app-theme-primary\\);[\\s\\S]*?color: var\\(--app-theme-primary\\);`),
  );
});

test('catalog card marks a PDF presentation with the Fluffy White document icon', () => {
  assert.match(
    catalogSource,
    /hasPresentation \? \([\s\S]*?className="catalog-card-pdf-badge" aria-label="Есть PDF-презентация" role="img"[\s\S]*?<CatalogDocumentIcon \/>/,
  );
  assert.doesNotMatch(catalogSource, />PDF<\/span>/);
  assert.match(catalogSource, /<path d="M14 2H6a2 2 0 0 0-2 2v16h16V8Z" \/>/);
  assert.match(catalogSource, /<path d="M14 2v6h6M8 13h8M8 17h6" \/>/);
  assert.match(stylesSource, /\.catalog-card-media \.catalog-card-pdf-icon,[\s\S]*?\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
  assert.match(
    fluffyWhiteSource,
    /\.catalog-card :is\(\.catalog-card-pdf-badge, [^)]*\) \{[\s\S]*?width: 36px;[\s\S]*?backdrop-filter: blur\(14px\);[\s\S]*?pointer-events: auto;/,
  );
  assert.match(
    fluffyWhiteSource,
    /\.catalog-card :is\(\.catalog-card-pdf-badge, [^)]*\):hover \{[\s\S]*?border-color: var\(--fw-hover-line\);[\s\S]*?background: var\(--fw-hover-bg\);[\s\S]*?transform: translateY\(var\(--fw-lift\)\);/,
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
