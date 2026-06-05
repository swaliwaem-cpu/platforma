import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const numberInputSource = readFileSync(resolve(currentDir, '../src/lib/numberInput.ts'), 'utf8');

test('public price search inputs display ruble masks but keep raw filter values', () => {
  assert.match(numberInputSource, /export function formatGroupedNumberInputValue\(value: string\)/);
  assert.match(numberInputSource, /export function formatCurrencyInputValue\(value: string\)/);
  assert.match(numberInputSource, /export function getCurrencyInputBackspaceValue\(/);
  assert.match(numberInputSource, /replace\(\/\\B\(\?=\(\\d\{3\}\)\+\(\?!\\d\)\)\/g,\s*' '\)/);
  assert.match(numberInputSource, /return groupedValue \? `\$\{groupedValue\} ₽` : '';/);
  assert.match(numberInputSource, /const currencyIndex = value\.indexOf\('₽'\);/);
  assert.match(numberInputSource, /return rawValue\.slice\(0, -1\);/);

  assert.match(catalogSource, /import \{ formatCurrencyInputValue, getCurrencyInputBackspaceValue \} from '\.\.\/lib\/numberInput';/);
  assert.match(catalogSource, /placeholder="0 ₽"/);
  assert.match(catalogSource, /placeholder="50 000 000 ₽"/);
  assert.match(catalogSource, /placeholder="500 000 ₽"/);
  assert.match(catalogSource, /value=\{formatCurrencyInputValue\(filters\.lotPriceMin\)\}/);
  assert.match(catalogSource, /value=\{formatCurrencyInputValue\(filters\.lotPriceMax\)\}/);
  assert.match(catalogSource, /value=\{formatCurrencyInputValue\(filters\.lotPricePerMeterMin\)\}/);
  assert.match(catalogSource, /value=\{formatCurrencyInputValue\(filters\.lotPricePerMeterMax\)\}/);
  assert.match(catalogSource, /onChange=\{\(event\) => onChange\(\{ lotPriceMin: sanitizeDecimalText\(event\.target\.value\) \}\)\}/);
  assert.match(catalogSource, /onChange=\{\(event\) => onChange\(\{ lotPriceMax: sanitizeDecimalText\(event\.target\.value\) \}\)\}/);
  assert.match(catalogSource, /onChange=\{\(event\) => onChange\(\{ lotPricePerMeterMin: sanitizeDecimalText\(event\.target\.value\) \}\)\}/);
  assert.match(catalogSource, /onChange=\{\(event\) => onChange\(\{ lotPricePerMeterMax: sanitizeDecimalText\(event\.target\.value\) \}\)\}/);
  assert.match(catalogSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, 'lotPriceMin'\)\}/);
  assert.match(catalogSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, 'lotPriceMax'\)\}/);
  assert.match(catalogSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, 'lotPricePerMeterMin'\)\}/);
  assert.match(catalogSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, 'lotPricePerMeterMax'\)\}/);

  assert.match(objectDetailSource, /import \{ formatCurrencyInputValue, getCurrencyInputBackspaceValue \} from '\.\.\/lib\/numberInput';/);
  assert.match(objectDetailSource, /placeholder="0 ₽"/);
  assert.match(objectDetailSource, /placeholder="50 000 000 ₽"/);
  assert.match(objectDetailSource, /placeholder="500 000 ₽"/);
  assert.match(objectDetailSource, /value=\{formatCurrencyInputValue\(priceMinFilter\)\}/);
  assert.match(objectDetailSource, /value=\{formatCurrencyInputValue\(priceMaxFilter\)\}/);
  assert.match(objectDetailSource, /value=\{formatCurrencyInputValue\(pricePerMeterMinFilter\)\}/);
  assert.match(objectDetailSource, /value=\{formatCurrencyInputValue\(pricePerMeterMaxFilter\)\}/);
  assert.match(objectDetailSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, setPriceMinFilter\)\}/);
  assert.match(objectDetailSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, setPriceMaxFilter\)\}/);
  assert.match(objectDetailSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, setPricePerMeterMinFilter\)\}/);
  assert.match(objectDetailSource, /onKeyDown=\{\(event\) => handleCurrencyInputBackspace\(event, setPricePerMeterMaxFilter\)\}/);
  assert.match(objectDetailSource, /setOptionalParam\(params,\s*'priceMin',\s*priceMinFilter\);/);
  assert.match(objectDetailSource, /setOptionalParam\(params,\s*'pricePerMeterMax',\s*pricePerMeterMaxFilter\);/);
});
