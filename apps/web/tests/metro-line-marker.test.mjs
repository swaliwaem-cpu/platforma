import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const markerModulePath = resolve(currentDir, '../src/map/metroLineMarker.ts');
const {
  buildMetroLineLookup,
  normalizeMetroStationName,
  resolveMetroLineMarker,
} = await import(pathToFileURL(markerModulePath).href);

test('metro station normalization matches case, ё and punctuation variants', () => {
  assert.equal(normalizeMetroStationName('  Щёлковская  '), 'щелковская');
  assert.equal(normalizeMetroStationName('Охотный-Ряд'), 'охотныйряд');
  assert.equal(normalizeMetroStationName('Охотный ряд'), 'охотныйряд');
});

test('single-line stations use one solid validated line color', () => {
  const lookup = buildMetroLineLookup([
    {
      name: 'Ломоносовский проспект',
      lineName: 'Солнцевская',
      lineColor: '#ffcd1c',
    },
  ]);

  assert.deepEqual(resolveMetroLineMarker('ломоносовский проспект', lookup), {
    background: '#FFCD1C',
    label: 'Солнцевская',
  });
});

test('transfer stations split the circle into deterministic line-color sectors', () => {
  const lookup = buildMetroLineLookup([
    {
      name: 'Парк Победы',
      lineName: 'Солнцевская',
      lineColor: '#FFCD1C',
    },
    {
      name: 'Парк Победы',
      lineName: 'Арбатско-Покровская',
      lineColor: '#0072BA',
    },
    {
      name: 'Парк Победы',
      lineName: 'Служебная запись',
      lineColor: 'not-a-color',
    },
  ]);

  assert.deepEqual(resolveMetroLineMarker('ПАРК ПОБЕДЫ', lookup), {
    background: 'conic-gradient(#0072BA 0% 50%, #FFCD1C 50% 100%)',
    label: 'Арбатско-Покровская, Солнцевская',
  });
});

test('missing and invalid directory colors keep the neutral marker fallback', () => {
  const lookup = buildMetroLineLookup([
    {
      name: 'Неизвестная',
      lineName: 'Тестовая',
      lineColor: null,
    },
  ]);

  assert.deepEqual(resolveMetroLineMarker('Неизвестная', lookup), {
    background: null,
    label: null,
  });
});
