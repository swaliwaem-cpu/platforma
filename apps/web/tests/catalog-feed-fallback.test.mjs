import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');

test('catalog cards, list and map prefer feed aggregate values for public price and area display', () => {
  assert.match(source, /function getCatalogPriceFrom\([\s\S]*?return object\.feedPriceFrom \?\? object\.priceFrom;/);
  assert.match(
    source,
    /function getCatalogPricePerMeterFrom\([\s\S]*?return object\.feedPricePerMeterFrom \?\? object\.pricePerMeterFrom;/,
  );
  assert.match(source, /function getCatalogAreaRange\([\s\S]*?return object\.feedAreaRange \?\? object\.apartmentAreaRange;/);
  assert.match(source, /formatPrice\(getCatalogPriceFrom\(object\)\)/);
  assert.match(source, /formatPricePerMeter\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /formatRequestedPrice\(getCatalogPriceFrom\(object\)\)/);
  assert.match(source, /formatRequestedPrice\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /formatMapListPricePerMeter\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /formatMapCardPricePerMeter\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /markerLabel: formatMapMarkerPrice\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /const areaLabel = getCatalogAreaRange\(object\) \?\? 'Не указано';/);
});
