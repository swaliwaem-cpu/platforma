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
  assert.match(source, /value=\{row\.objectId \?\? ''\}/);
  assert.match(source, /publishedObjects\.map\(\(object\)/);
  assert.match(source, /\/objects\/\$\{encodeURIComponent\(selectedObject\.slug\)\}/);
});
