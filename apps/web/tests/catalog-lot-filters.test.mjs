import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');

test('catalog global filters include lot price rooms and floor URL and API params', () => {
  assert.match(source, /lotPriceMin:\s*string;/);
  assert.match(source, /lotPriceMax:\s*string;/);
  assert.match(source, /lotRooms:\s*string;/);
  assert.match(source, /lotFloorMin:\s*string;/);
  assert.match(source, /lotFloorMax:\s*string;/);
  assert.match(source, /lotRooms:\s*parseCatalogRoomsParam\(params\.get\('lotRooms'\)\)/);
  assert.match(source, /setParam\(params,\s*'lotPriceMin',\s*filters\.lotPriceMin\);/);
  assert.match(source, /setParam\(params,\s*'lotPriceMax',\s*filters\.lotPriceMax\);/);
  assert.match(source, /setParam\(params,\s*'lotRooms',\s*filters\.lotRooms\);/);
  assert.match(source, /setParam\(params,\s*'lotFloorMin',\s*filters\.lotFloorMin\);/);
  assert.match(source, /setParam\(params,\s*'lotFloorMax',\s*filters\.lotFloorMax\);/);
});

test('catalog global lot filters render controls and count as active advanced filters', () => {
  assert.match(source, /const catalogRoomOptions = \[/);
  assert.match(source, /\{ value:\s*'0',\s*label:\s*'Студия'\s*\}/);
  assert.match(source, /\{ value:\s*'4',\s*label:\s*'4 спальни'\s*\}/);
  assert.match(source, /\{ value:\s*'5',\s*label:\s*'5 спален'\s*\}/);
  assert.match(source, />\s*Цена лота от\s*</);
  assert.match(source, />\s*Цена лота до\s*</);
  assert.match(source, />\s*Сколько комнат\s*</);
  assert.match(source, />\s*Этаж от\s*</);
  assert.match(source, />\s*Этаж до\s*</);
  assert.match(source, /filters\.lotPriceMin,/);
  assert.match(source, /filters\.lotPriceMax,/);
  assert.match(source, /filters\.lotRooms,/);
  assert.match(source, /filters\.lotFloorMin,/);
  assert.match(source, /filters\.lotFloorMax,/);
});

test('catalog passes active lot filters through object links', () => {
  assert.match(source, /function buildCatalogObjectHref\(slug: string, filters: CatalogFilters\)/);
  assert.match(source, /function buildCatalogLotFilterQuery\(filters: CatalogFilters\)/);
  assert.match(source, /setParam\(params,\s*'lotPriceMin',\s*filters\.lotPriceMin\);/);
  assert.match(source, /setParam\(params,\s*'lotPriceMax',\s*filters\.lotPriceMax\);/);
  assert.match(source, /setParam\(params,\s*'lotRooms',\s*filters\.lotRooms\);/);
  assert.match(source, /setParam\(params,\s*'lotFloorMin',\s*filters\.lotFloorMin\);/);
  assert.match(source, /setParam\(params,\s*'lotFloorMax',\s*filters\.lotFloorMax\);/);
  assert.match(source, /const objectHref = buildCatalogObjectHref\(object\.slug, filters\);/);
  assert.match(source, /<CatalogListItem[\s\S]*?filters=\{filters\}/);
  assert.match(source, /<CatalogCard[\s\S]*?filters=\{filters\}/);
  assert.match(source, /<MapObjectCard[\s\S]*?filters=\{filters\}/);
  assert.match(source, /balloonHtml: buildMapBalloon\(object, filters\)/);
});

test('catalog result cards show matched lot count only for lot-filtered results', () => {
  assert.match(source, /matchedFeedUnitsCount/);
  assert.match(source, /function hasActiveCatalogLotFilters\(filters: CatalogFilters\)/);
  assert.match(source, /function getCatalogMatchedLotsLabel\(object: RealEstateObjectSummary, filters: CatalogFilters\)/);
  assert.match(source, /Найдено лотов: \$\{formatNumber\(object\.matchedFeedUnitsCount\)\}/);
  assert.match(source, /className="catalog-matched-lots-badge"/);
  assert.match(source, /const matchedLotsLabel = getCatalogMatchedLotsLabel\(object, filters\);/);
});
