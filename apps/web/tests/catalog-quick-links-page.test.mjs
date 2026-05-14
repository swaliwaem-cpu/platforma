import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

function getStandaloneStyleBlock(selector) {
  const lines = styles.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== `${selector} {`) {
      continue;
    }

    let previousIndex = index - 1;
    while (previousIndex >= 0 && lines[previousIndex].trim() === '') {
      previousIndex -= 1;
    }

    if (lines[previousIndex]?.trim().endsWith(',')) {
      continue;
    }

    const blockLines = [];
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      if (lines[blockIndex].trim() === '}') {
        return blockLines.join('\n');
      }

      blockLines.push(lines[blockIndex]);
    }
  }

  assert.fail(`Expected to find standalone style block for ${selector}`);
}

test('catalog page loads public quick links on catalog and map routes', () => {
  assert.match(source, /CatalogLinksResponse/);
  assert.match(source, /const isCatalogRoute = pathname === '\/catalog';/);
  assert.match(source, /const isMapView = pathname === '\/catalog\/map';/);
  assert.match(source, /const canShowCatalogQuickLinks = isCatalogRoute \|\| isMapView;/);
  assert.match(source, /apiRequest<CatalogLinksResponse>\('\/catalog-links', catalogLinksAccessToken\)/);
  assert.match(source, /if \(!accessToken \|\| !canShowCatalogQuickLinks\) \{\s*setCatalogLinks\(\[\]\);[\s\S]*return;\s*\}[\s\S]*void loadCatalogLinks\(\);/);
  assert.match(source, /\}, \[accessToken, canShowCatalogQuickLinks\]\);/);
  assert.match(source, /\{canShowCatalogQuickLinks \? \(\s*<CatalogQuickLinks/);
});

test('catalog quick link clicks reset filters and preserve the current list view', () => {
  assert.match(source, /function openCatalogDeveloperLink\(developerId: string\)/);
  assert.match(source, /const nextFilters = \{\s*\.\.\.defaultFilters,\s*developerId,\s*\};[\s\S]*buildCatalogQuery\(nextFilters, viewMode\)/);
  assert.match(source, /function openCatalogKrtLink\(krtName: string\)/);
  assert.match(source, /const nextFilters = \{\s*\.\.\.defaultFilters,\s*krtName,\s*\};[\s\S]*buildCatalogQuery\(nextFilters, viewMode\)/);
});

test('catalog view controls render below quick links instead of inside the header', () => {
  const quickLinksIndex = source.indexOf('<CatalogQuickLinks');
  const viewActionsIndex = source.indexOf('<CatalogViewActions');
  const filtersIndex = source.indexOf('\n      <CatalogFilters');

  assert.match(source, /function CatalogViewActions\(/);
  assert.ok(quickLinksIndex > -1, 'quick links should render on the catalog page');
  assert.ok(viewActionsIndex > quickLinksIndex, 'view controls should render after quick links');
  assert.ok(filtersIndex > viewActionsIndex, 'filters should render after view controls');
  assert.doesNotMatch(
    source,
    /<header className="page-header">[\s\S]*catalog-view-toggle[\s\S]*<\/header>/,
  );
  assert.doesNotMatch(
    source,
    /<header className="page-header">[\s\S]*catalog-map-button[\s\S]*<\/header>/,
  );
});

test('catalog filters include krtName in URL and API requests', () => {
  assert.match(source, /krtName: string;/);
  assert.match(source, /krtName: '',/);
  assert.match(source, /krtName: parseTextParam\(params\.get\('krtName'\)\)/);
  assert.match(source, /setParam\(params, 'krtName', filters\.krtName\)/);
});

test('catalog sorting renders below filters and drives URL and object request params', () => {
  const filtersIndex = source.indexOf('\n      <CatalogFilters');
  const sortIndex = source.indexOf('<CatalogSortBar');

  assert.match(source, /type CatalogSortField = 'createdAt' \| 'priceFrom' \| 'pricePerMeterFrom' \| 'completionDate';/);
  assert.match(source, /type SortDirection = 'asc' \| 'desc';/);
  assert.match(source, /sortBy: CatalogSortField;/);
  assert.match(source, /sortDirection: SortDirection;/);
  assert.match(source, /sortBy: parseCatalogSortBy\(params\.get\('sortBy'\)\)/);
  assert.match(source, /sortDirection: parseCatalogSortDirection\(params\.get\('sortDirection'\)\)/);
  assert.match(source, /setCatalogSortParams\(params, filters\)/);
  assert.match(source, /sortBy: filters\.sortBy,/);
  assert.match(source, /sortDirection: filters\.sortDirection,/);
  assert.match(source, /function CatalogSortBar\(/);
  assert.match(source, /function CatalogSortButton\(/);
  assert.match(source, /onSortChange\('priceFrom'\)/);
  assert.match(source, /onSortChange\('pricePerMeterFrom'\)/);
  assert.match(source, /onSortChange\('completionDate'\)/);
  assert.match(source, /onSortChange\('createdAt'\)/);
  assert.match(source, />\s*Цена\s*</);
  assert.match(source, />\s*Цена м²\s*</);
  assert.match(source, />\s*Срок\s*</);
  assert.match(source, />\s*Добавлен\s*</);
  assert.doesNotMatch(source, /<span>Сортировка<\/span>/);
  assert.doesNotMatch(source, /<strong>\{activeSortLabel\}<\/strong>/);
  assert.doesNotMatch(source, /Порядок по умолчанию/);
  assert.ok(filtersIndex > -1, 'filters should render on the catalog page');
  assert.ok(sortIndex > filtersIndex, 'sort controls should render below filters');
});

test('catalog quick links use calm responsive columns without new UI dependencies', () => {
  assert.match(styles, /\.catalog-quick-links\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.catalog-quick-links\s*\{[\s\S]*border:\s*1px solid var\(--catalog-border\)/);
  assert.match(styles, /\.catalog-quick-links\s*\{[\s\S]*box-shadow:\s*var\(--catalog-shadow-panel\)/);
  assert.match(styles, /@media \(max-width:\s*1100px\)\s*\{[\s\S]*\.catalog-quick-links\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /@media \(max-width:\s*700px\)\s*\{[\s\S]*\.catalog-quick-links\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.catalog-quick-links-column \+ \.catalog-quick-links-column\s*\{[\s\S]*border-left:\s*1px solid var\(--catalog-border-soft\)/);
});

test('catalog action buttons use ink instead of forest green', () => {
  const mapButtonStyles = getStandaloneStyleBlock('.catalog-map-button');
  const cardLinkStyles = getStandaloneStyleBlock('.catalog-card-link');
  const listLinkHoverStyles = styles.match(/\.catalog-list-item-link:hover,\s*\.catalog-list-item-link:focus-visible\s*\{([^}]*)\}/)?.[1];

  assert.ok(listLinkHoverStyles, 'Expected to find catalog list item link hover styles');
  assert.match(mapButtonStyles, /background:\s*var\(--catalog-ink-900\)/);
  assert.match(cardLinkStyles, /background:\s*var\(--catalog-ink-900\)/);
  assert.match(listLinkHoverStyles, /background:\s*var\(--catalog-ink-900\)/);
  assert.doesNotMatch(mapButtonStyles, /catalog-forest/);
  assert.doesNotMatch(cardLinkStyles, /catalog-forest/);
  assert.doesNotMatch(listLinkHoverStyles, /catalog-forest/);
});

test('catalog sorting controls keep catalog panel styling and responsive wrapping', () => {
  assert.match(styles, /\.catalog-sort-bar\s*\{[\s\S]*display:\s*grid;[\s\S]*border:\s*1px solid var\(--catalog-border\)/);
  assert.match(styles, /\.catalog-sort-row\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) repeat\(4,\s*minmax\(118px,\s*auto\)\)/);
  assert.match(styles, /\.catalog-sort-button\s*\{[\s\S]*border:\s*0;[\s\S]*background:\s*transparent/);
  assert.match(styles, /\.catalog-sort-button--active\s*\{[\s\S]*color:\s*var\(--catalog-blue-deep\)/);
  assert.doesNotMatch(styles, /\.catalog-sort-heading/);
  assert.doesNotMatch(styles, /\.catalog-sort-reset/);
  assert.match(styles, /@media \(max-width:\s*700px\)\s*\{[\s\S]*\.catalog-sort-row\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});
