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
  assert.match(source, /formatPriceFrom\(getCatalogPriceFrom\(object\)\)/);
  assert.match(source, /formatPricePerMeterFrom\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /formatRequestedPriceFrom\(getCatalogPriceFrom\(object\)\)/);
  assert.match(source, /formatRequestedPricePerMeterFrom\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /formatMapListPricePerMeter\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /formatMapCardPricePerMeter\(getCatalogPricePerMeterFrom\(object\)\)/);
  assert.match(source, /markerLabel: resolveMapMarkerLabel\(object\)/);
  assert.match(source, /const areaLabel = getCatalogAreaRange\(object\) \?\? 'Не указано';/);
  assert.match(source, /function formatPriceFrom/);
  assert.match(source, /return value \? `от \$\{formatPrice\(value\)\}` : 'Не указана';/);
  assert.match(source, /return value \? `от \$\{formatPrice\(value\)\}\/м²` : 'за м² не указана';/);
});
