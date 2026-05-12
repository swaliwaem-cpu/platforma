import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('catalog page loads public quick links only outside the map route', () => {
  assert.match(source, /CatalogLinksResponse/);
  assert.match(source, /const isCatalogRoute = pathname === '\/catalog';/);
  assert.match(source, /apiRequest<CatalogLinksResponse>\('\/catalog-links', catalogLinksAccessToken\)/);
  assert.match(source, /if \(!accessToken \|\| !isCatalogRoute\) \{\s*setCatalogLinks\(\[\]\);[\s\S]*return;\s*\}[\s\S]*void loadCatalogLinks\(\);/);
  assert.match(source, /\}, \[accessToken, isCatalogRoute\]\);/);
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

test('catalog quick links use calm responsive columns without new UI dependencies', () => {
  assert.match(styles, /\.catalog-quick-links\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /@media \(max-width:\s*1100px\)\s*\{[\s\S]*\.catalog-quick-links\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /@media \(max-width:\s*700px\)\s*\{[\s\S]*\.catalog-quick-links\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.catalog-quick-links-column\s*\{[\s\S]*border:\s*1px solid var\(--catalog-border\)/);
});
