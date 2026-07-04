import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const catalogFiltersSource = readFileSync(resolve(currentDir, '../src/catalog/catalogFilters.ts'), 'utf8');
const source = `${pageSource}\n${catalogFiltersSource}`;

test('catalog directory filters use searchable dropdowns with normalized matching', () => {
  assert.match(source, /import \{ matchesSearchVariants \} from '@platforma\/shared\/search-normalization';/);
  assert.match(source, /const catalogFilterSearchResultLimit = 24;/);
  assert.match(source, /function CatalogFilterSearchSelect/);
  assert.match(source, /matchesSearchVariants\(query,\s*getSearchValues\(option\)\)/);
  assert.match(source, /aria-multiselectable=\{true\}/);
  assert.match(source, /function getCatalogFilterIdValues\(value: string\)/);
  assert.match(source, /function formatCatalogFilterIdValues\(values: string\[\]\)/);
  assert.match(source, /developerId:\s*parseCatalogFilterIdParam\(params\.get\('developerId'\)\)/);
  assert.match(source, /setParam\(params,\s*'developerId',\s*filters\.developerId\);/);

  const toggleOptionBody = source.match(/function toggleOption\(optionId: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.doesNotMatch(toggleOptionBody, /setQuery\(''\)/);
  assert.doesNotMatch(toggleOptionBody, /searchInputRef\.current\?\.focus/);

  assert.match(source, /ariaLabel="Фильтр каталога по застройщику"[\s\S]*?placeholder="Все застройщики"[\s\S]*?searchPlaceholder="Поиск застройщика"[\s\S]*?selectedIds=\{getCatalogFilterIdValues\(filters\.developerId\)\}[\s\S]*?onSelectedIdsChange=\{\(developerIds\) =>[\s\S]*?onChange\(\{ developerId: formatCatalogFilterIdValues\(developerIds\) \}\)[\s\S]*?\}/);
  assert.match(source, /ariaLabel="Фильтр каталога по району"[\s\S]*?placeholder="Все районы"[\s\S]*?searchPlaceholder="Поиск района"[\s\S]*?selectedIds=\{getCatalogFilterIdValues\(filters\.locationId\)\}[\s\S]*?onSelectedIdsChange=\{\(locationIds\) =>[\s\S]*?onChange\(\{ locationId: formatCatalogFilterIdValues\(locationIds\) \}\)[\s\S]*?\}/);
  assert.match(source, /ariaLabel="Фильтр каталога по окружению"[\s\S]*?placeholder="Все окружения"[\s\S]*?searchPlaceholder="Поиск окружения"[\s\S]*?selectedIds=\{getCatalogFilterIdValues\(filters\.areaId\)\}[\s\S]*?onSelectedIdsChange=\{\(areaIds\) => onChange\(\{ areaId: formatCatalogFilterIdValues\(areaIds\) \}\)\}/);
  assert.match(source, /ariaLabel="Фильтр каталога по метро"[\s\S]*?placeholder="Все станции"[\s\S]*?searchPlaceholder="Поиск метро"[\s\S]*?selectedIds=\{getCatalogFilterIdValues\(filters\.metroStationId\)\}[\s\S]*?onSelectedIdsChange=\{\(metroStationIds\) =>[\s\S]*?onChange\(\{ metroStationId: formatCatalogFilterIdValues\(metroStationIds\) \}\)[\s\S]*?\}/);

  assert.doesNotMatch(source, /<select[\s\S]{0,180}value=\{filters\.developerId\}/);
  assert.doesNotMatch(source, /<select[\s\S]{0,180}value=\{filters\.locationId\}/);
  assert.doesNotMatch(source, /<select[\s\S]{0,180}value=\{filters\.areaId\}/);
  assert.doesNotMatch(source, /<select[\s\S]{0,180}value=\{filters\.metroStationId\}/);
});
