import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const localizationPath = resolve(currentDir, '../src/map/openMapTilesLabelLocalization.ts');
const { localizeOpenMapTilesLabels } = await import(pathToFileURL(localizationPath).href);

test('map labels use Russian names without Latin transliteration', () => {
  const changes = [];
  const map = {
    getStyle() {
      return {
        layers: [
          {
            id: 'city-label',
            type: 'symbol',
            layout: {
              'text-field': [
                'concat',
                ['get', 'name:nonlatin'],
                '\n',
                ['get', 'name:latin'],
              ],
            },
          },
          {
            id: 'poi-label',
            type: 'symbol',
            layout: { 'text-field': '{name_en}' },
          },
          {
            id: 'house-number',
            type: 'symbol',
            layout: { 'text-field': '{housenumber}' },
          },
          {
            id: 'road-ref',
            type: 'symbol',
            layout: { 'text-field': ['get', 'ref'] },
          },
          {
            id: 'not-a-label',
            type: 'circle',
          },
        ],
      };
    },
    setLayoutProperty(...args) {
      changes.push(args);
    },
  };

  localizeOpenMapTilesLabels(map);

  const russianLabelExpression = [
    'coalesce',
    ['get', 'name:ru'],
    ['get', 'name:nonlatin'],
    '',
  ];
  assert.deepEqual(changes, [
    ['city-label', 'text-field', russianLabelExpression],
    ['poi-label', 'text-field', russianLabelExpression],
  ]);
});
