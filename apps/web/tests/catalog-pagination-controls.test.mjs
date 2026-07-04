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

function extractFunctionSource(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);

  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const openBraceIndex = sourceText.indexOf('{', markerIndex);

  assert.notEqual(openBraceIndex, -1, `${marker} should have a body`);

  let depth = 0;

  for (let index = openBraceIndex; index < sourceText.length; index += 1) {
    if (sourceText[index] === '{') {
      depth += 1;
    }

    if (sourceText[index] === '}') {
      depth -= 1;
    }

    if (depth === 0) {
      return sourceText.slice(markerIndex, index + 1);
    }
  }

  assert.fail(`Expected to find end of ${marker}`);
}

function extractSourceBetween(sourceText, startMarker, endMarker) {
  const startIndex = sourceText.indexOf(startMarker);
  const endIndex = sourceText.indexOf(endMarker, startIndex + startMarker.length);

  assert.notEqual(startIndex, -1, `${startMarker} should exist`);
  assert.notEqual(endIndex, -1, `${endMarker} should exist after ${startMarker}`);

  return sourceText.slice(startIndex, endIndex);
}

test('catalog page supports configurable page size and preserves map request limit', () => {
  assert.match(source, /type CatalogPageSize = 25 \| 50 \| 75;/);
  assert.match(source, /const catalogPageSizeOptions = \[25, 50, 75\] as const;/);
  assert.match(source, /limit: CatalogPageSize;/);
  assert.match(source, /limit: 25,/);
  assert.match(source, /limit: parseCatalogPageSize\(params\.get\('limit'\)\)/);
  assert.match(source, /if \(filters\.limit !== defaultFilters\.limit\) \{\s*params\.set\('limit', String\(filters\.limit\)\);/);
  assert.match(source, /limit: includePage \? String\(filters\.limit\) : '1000'/);
});

test('catalog page can append the next page without changing the URL', () => {
  assert.match(source, /const \[loadedThroughPage,\s*setLoadedThroughPage\] = useState\(filters\.page\);/);
  assert.match(source, /const \[isLoadingMore,\s*setIsLoadingMore\] = useState\(false\);/);
  assert.match(source, /async function loadMoreObjects\(\)/);
  assert.match(source, /const nextPage = loadedThroughPage \+ 1;/);
  assert.match(source, /const nextFilters = \{\s*\.\.\.filters,\s*page: nextPage,\s*\};/);
  assert.match(source, /setObjects\(\(currentObjects\) => appendUniqueCatalogObjects\(currentObjects, data\.items\)\);/);

  const loadMoreSource = extractFunctionSource(source, 'async function loadMoreObjects()');

  assert.doesNotMatch(loadMoreSource, /window\.history\.pushState/);
});

test('catalog pagination renders show more, arrow buttons, page select, and page size select', () => {
  const listViewSource = extractSourceBetween(source, 'function CatalogListView', 'function CatalogMapView');

  assert.match(listViewSource, />\s*\{isLoadingMore \? 'Загрузка' : 'Показать еще'\}\s*</);
  assert.match(listViewSource, /className="catalog-pagination-arrow"/);
  assert.match(listViewSource, /aria-label="Предыдущая страница"/);
  assert.match(listViewSource, /aria-label="Следующая страница"/);
  assert.match(listViewSource, /<ChevronLeftIcon aria-hidden="true" \/>/);
  assert.match(listViewSource, /<ChevronRightIcon aria-hidden="true" \/>/);
  assert.match(listViewSource, /aria-label="Выбор страницы каталога"/);
  assert.match(listViewSource, /aria-label="Количество объектов на странице"/);
  assert.match(listViewSource, /catalogPageSizeOptions\.map/);
  assert.match(listViewSource, /Показано: \{objects\.length\} из \{total\}/);
  assert.doesNotMatch(listViewSource, />\s*Назад\s*</);
  assert.doesNotMatch(listViewSource, />\s*Вперёд\s*</);
});

test('catalog pagination styles keep controls compact and responsive', () => {
  assert.match(styles, /\.catalog-pagination\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:/);
  assert.match(styles, /\.catalog-pagination-more\s*\{[\s\S]*min-height:\s*42px;[\s\S]*border:\s*1px solid var\(--catalog-blue\)/);
  assert.match(styles, /\.catalog-pagination-arrow\s*\{[\s\S]*width:\s*42px;[\s\S]*height:\s*42px;[\s\S]*border-radius:\s*var\(--catalog-radius-sm\)/);
  assert.match(styles, /\.catalog-pagination-select\s*\{[\s\S]*min-height:\s*42px;[\s\S]*width:\s*auto/);
  assert.match(styles, /@media \(max-width:\s*700px\)\s*\{[\s\S]*\.catalog-pagination\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});
