import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const catalogFiltersSource = readFileSync(resolve(currentDir, '../src/catalog/catalogFilters.ts'), 'utf8');
const source = `${pageSource}\n${catalogFiltersSource}`;
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

function extractSourceBetween(sourceText, startMarker, endMarker) {
  const startIndex = sourceText.indexOf(startMarker);
  const endIndex = sourceText.indexOf(endMarker, startIndex + startMarker.length);

  assert.notEqual(startIndex, -1, `${startMarker} should exist`);
  assert.notEqual(endIndex, -1, `${endMarker} should exist after ${startMarker}`);

  return sourceText.slice(startIndex, endIndex);
}

function countMatches(sourceText, pattern) {
  return sourceText.match(pattern)?.length ?? 0;
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

test('catalog object detail links open in new browser tabs', () => {
  const quickLinkSource = extractSourceBetween(source, 'function CatalogQuickLinkItem', 'function CatalogFilters');
  const listItemSource = extractSourceBetween(source, 'function CatalogListItem', 'function CatalogCard');
  const cardSource = extractSourceBetween(source, 'function CatalogCard', 'function CatalogCardMetroLabel');
  const mapCardSource = extractSourceBetween(source, 'function MapObjectCard', 'function CatalogListItem');
  const mapBalloonSource = extractSourceBetween(source, 'function buildMapBalloon', 'type CatalogObjectWithLocations');

  assert.equal(countMatches(quickLinkSource, /target="_blank"/g), 1);
  assert.equal(countMatches(quickLinkSource, /rel="noopener noreferrer"/g), 1);
  assert.doesNotMatch(quickLinkSource, /event\.preventDefault/);

  assert.equal(countMatches(listItemSource, /target="_blank"/g), 3);
  assert.equal(countMatches(listItemSource, /rel="noopener noreferrer"/g), 3);
  assert.doesNotMatch(listItemSource, /event\.preventDefault/);

  assert.equal(countMatches(cardSource, /target="_blank"/g), 3);
  assert.equal(countMatches(cardSource, /rel="noopener noreferrer"/g), 3);
  assert.doesNotMatch(cardSource, /event\.preventDefault/);

  assert.equal(countMatches(mapCardSource, /target="_blank"/g), 2);
  assert.equal(countMatches(mapCardSource, /rel="noopener noreferrer"/g), 2);
  assert.match(
    mapCardSource,
    /<h3>\s*<a className="map-object-card-title-link" href=\{objectHref\} rel="noopener noreferrer" target="_blank">[\s\S]*?\{object\.title\}[\s\S]*?<\/a>\s*<\/h3>/,
  );
  assert.match(mapCardSource, /<a className="catalog-card-link map-object-card-link" href=\{objectHref\}/);
  assert.doesNotMatch(mapCardSource, /<button className="catalog-card-link map-object-card-link"/);

  assert.match(mapBalloonSource, /target="_blank"/);
  assert.match(mapBalloonSource, /rel="noopener noreferrer"/);
  assert.doesNotMatch(mapBalloonSource, /data-map-point-id/);
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

test('catalog search keeps typed spaces while syncing URL and API params', () => {
  assert.match(source, /search: parseSearchParam\(params\.get\('search'\)\)/);
  assert.match(source, /setSearchParam\(params, 'search', filters\.search\)/);
  assert.match(source, /function setSearchParam\(params: URLSearchParams, key: string, value: string\)/);
  assert.match(source, /if \(value\.trim\(\)\) \{[\s\S]*?params\.set\(key, value\);[\s\S]*?\}/);
});

test('catalog search clears stale results and shows loading before URL fetch finishes', () => {
  assert.match(source, /const shouldResetSearchResults = 'search' in patch && patch\.search !== filters\.search;/);
  assert.match(source, /if \(shouldResetSearchResults\) \{[\s\S]*?setObjects\(\[\]\);[\s\S]*?setTotal\(0\);[\s\S]*?setTotalPages\(1\);[\s\S]*?setLoadedThroughPage\(nextFilters\.page\);[\s\S]*?setError\(null\);[\s\S]*?setLoadMoreError\(null\);[\s\S]*?setIsLoading\(true\);[\s\S]*?\}/);
  assert.match(source, /if \(shouldResetSearchResults && isMapView\) \{[\s\S]*?setMapObjects\(\[\]\);[\s\S]*?setMapTotal\(0\);[\s\S]*?setMapError\(null\);[\s\S]*?setIsMapLoading\(nextFilters\.hasCoordinates !== 'false'\);[\s\S]*?\}/);
});

test('catalog keeps current results visible while directory filters reload', () => {
  assert.match(source, /const showInitialCatalogLoading = isLoading && objects\.length === 0;/);
  assert.match(source, /if \(showInitialCatalogLoading\) \{/);
  assert.match(source, /if \(!isLoading && objects\.length === 0\) \{/);
  assert.doesNotMatch(source, /if \(isLoading\) \{[\s\S]*?<h2>Загрузка<\/h2>[\s\S]*?\}/);
});

test('catalog search ignores stale object responses from previous characters', () => {
  assert.match(source, /useRef/);
  assert.match(source, /const objectsRequestIdRef = useRef\(0\);/);
  assert.match(source, /const mapObjectsRequestIdRef = useRef\(0\);/);
  assert.match(source, /const requestId = objectsRequestIdRef\.current \+ 1;[\s\S]*?objectsRequestIdRef\.current = requestId;/);
  assert.match(source, /if \(objectsRequestIdRef\.current !== requestId\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?setObjects\(data\.items\);/);
  assert.match(source, /if \(objectsRequestIdRef\.current === requestId\) \{[\s\S]*?setIsLoading\(false\);[\s\S]*?\}/);
  assert.match(source, /objectsRequestIdRef\.current \+= 1;[\s\S]*?setObjects\(\[\]\);/);
  assert.match(source, /const requestId = mapObjectsRequestIdRef\.current \+ 1;[\s\S]*?mapObjectsRequestIdRef\.current = requestId;/);
  assert.match(source, /if \(mapObjectsRequestIdRef\.current !== requestId\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?setMapObjects\(data\.items\);/);
  assert.match(source, /mapObjectsRequestIdRef\.current \+= 1;[\s\S]*?setMapObjects\(\[\]\);/);
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
