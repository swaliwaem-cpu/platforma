import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const numberInputSource = readFileSync(resolve(currentDir, '../src/lib/numberInput.ts'), 'utf8');

test('public price search inputs display grouped numbers but keep raw filter values', () => {
  assert.match(numberInputSource, /export function formatGroupedNumberInputValue\(value: string\)/);
  assert.match(numberInputSource, /replace\(\/\\B\(\?=\(\\d\{3\}\)\+\(\?!\\d\)\)\/g,\s*' '\)/);

  assert.match(catalogSource, /import \{ formatGroupedNumberInputValue \} from '\.\.\/lib\/numberInput';/);
  assert.match(catalogSource, /value=\{formatGroupedNumberInputValue\(filters\.lotPriceMin\)\}/);
  assert.match(catalogSource, /value=\{formatGroupedNumberInputValue\(filters\.lotPriceMax\)\}/);
  assert.match(catalogSource, /onChange=\{\(event\) => onChange\(\{ lotPriceMin: sanitizeDecimalText\(event\.target\.value\) \}\)\}/);
  assert.match(catalogSource, /onChange=\{\(event\) => onChange\(\{ lotPriceMax: sanitizeDecimalText\(event\.target\.value\) \}\)\}/);

  assert.match(objectDetailSource, /import \{ formatGroupedNumberInputValue \} from '\.\.\/lib\/numberInput';/);
  assert.match(objectDetailSource, /value=\{formatGroupedNumberInputValue\(priceMinFilter\)\}/);
  assert.match(objectDetailSource, /value=\{formatGroupedNumberInputValue\(priceMaxFilter\)\}/);
  assert.match(objectDetailSource, /value=\{formatGroupedNumberInputValue\(pricePerMeterMinFilter\)\}/);
  assert.match(objectDetailSource, /value=\{formatGroupedNumberInputValue\(pricePerMeterMaxFilter\)\}/);
  assert.match(objectDetailSource, /setOptionalParam\(params,\s*'priceMin',\s*priceMinFilter\);/);
  assert.match(objectDetailSource, /setOptionalParam\(params,\s*'pricePerMeterMax',\s*pricePerMeterMaxFilter\);/);
});
