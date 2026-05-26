import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/CatalogLinksAdminPage.tsx'), 'utf8');

test('catalog links admin page loads editable data and saves via catalog-links admin API', () => {
  assert.match(source, /apiRequest<AdminCatalogLinksResponse>\('\/catalog-links\/admin'/);
  assert.match(source, /apiRequest<AdminCatalogLinksResponse>\('\/catalog-links\/admin'[\s\S]*method:\s*'PUT'/);
  assert.match(source, /apiRequest<DevelopersResponse>\('\/developers\?limit=500'/);
  assert.match(source, /loadPublishedCatalogObjects\(accessToken\)/);
});

test('sales start object options load every published object page', () => {
  assert.match(source, /const catalogLinkObjectPageSize = 100;/);
  assert.match(source, /async function loadPublishedCatalogObjects\(accessToken: string\)/);
  assert.match(source, /status:\s*'PUBLISHED'/);
  assert.match(source, /limit:\s*String\(catalogLinkObjectPageSize\)/);
  assert.match(source, /const firstPage = await apiRequest<ObjectsResponse>\(`\/objects\?\$\{createParams\(1\)\.toString\(\)\}`/);
  assert.match(source, /for \(let page = 2; page <= firstPage\.totalPages; page \+= 1\)/);
  assert.match(source, /return \[firstPage, \.\.\.remainingPages\][\s\S]*?\.flatMap\(\(page\) => page\.items\)/);
});

test('catalog links admin page renders three editable columns with row controls', () => {
  assert.match(source, /type:\s*'DEVELOPER'[\s\S]*title:\s*'Крупные застройщики'/);
  assert.match(source, /type:\s*'KRT'[\s\S]*title:\s*'Основные локации КРТ'/);
  assert.match(source, /type:\s*'SALES_START'[\s\S]*title:\s*'Старты продаж'/);
  assert.match(source, /className="catalog-links-columns"/);
  assert.match(source, /className="catalog-link-row"/);
  assert.match(source, /aria-label=\{`Название ссылки/);
  assert.match(source, /aria-label=\{`Порядок ссылки/);
  assert.match(source, /aria-label=\{`Включить ссылку/);
  assert.match(source, /onAddLink=\{addLink\}/);
  assert.match(source, /onDeleteLink=\{deleteLink\}/);
});

test('sales start rows use published object targets and expose object detail links', () => {
  assert.match(source, /row\.type === 'SALES_START'/);
  assert.match(source, /const selectedObject = publishedObjects\.find\(\(object\) => object\.id === row\.objectId\) \?\? null;/);
  assert.match(source, /selectedId=\{row\.objectId \?\? ''\}/);
  assert.match(source, /onSelectedIdChange=\{\(objectId\) =>/);
  assert.match(source, /\/objects\/\$\{encodeURIComponent\(selectedObject\.slug\)\}/);
});

test('catalog links target fields use normalized searchable entity pickers', () => {
  assert.match(source, /import \{ matchesQuickEditSearch \} from '\.\/objectQuickEditTransforms';/);
  assert.match(source, /const catalogLinkSearchResultLimit = 24;/);
  assert.match(source, /function CatalogLinkSearchSelect/);
  assert.match(source, /matchesQuickEditSearch\(query,\s*getSearchValues\(option\)\)/);
  assert.doesNotMatch(source, /<select[\s>]/);

  assert.match(source, /options=\{developers\}/);
  assert.match(source, /placeholder="Найти застройщика"/);
  assert.match(source, /getSearchValues=\{\(developer\) => \[developer\.name,\s*developer\.slug\]\}/);

  assert.match(source, /const krtOptions = useMemo\(\(\) => mergeKrtOptions\(publishedObjects,\s*links\), \[links,\s*publishedObjects\]\);/);
  assert.match(source, /options=\{krtOptions\}/);
  assert.match(source, /placeholder="Найти КРТ"/);
  assert.match(source, /getSearchValues=\{\(krt\) => \[krt\.name\]\}/);

  assert.match(source, /options=\{publishedObjects\}/);
  assert.match(source, /placeholder="Найти объект"/);
  assert.match(source, /getSearchValues=\{\(object\) => \[object\.title,\s*object\.slug\]\}/);
});
