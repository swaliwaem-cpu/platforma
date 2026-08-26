import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const amenitiesPath = resolve(currentDir, '../src/map/openMapTilesAmenities.ts');
const {
  ensureOpenMapTilesAmenityLayers,
  setOpenMapTilesAmenityVisibility,
} = await import(pathToFileURL(amenitiesPath).href);

test('amenity overlays use separate education, recreation and healthcare map layers', () => {
  const style = {
    version: 8,
    glyphs: 'https://maps.example.test/fonts/{fontstack}/{range}.pbf',
    sources: {},
    layers: [
      {
        id: 'poi_r1',
        type: 'symbol',
        source: 'local-vector',
        'source-layer': 'poi',
        filter: ['<', ['get', 'rank'], 7],
      },
      {
        id: 'park',
        type: 'fill',
        source: 'local-vector',
        'source-layer': 'park',
      },
      {
        id: 'highway-name-major',
        type: 'symbol',
        source: 'local-vector',
        'source-layer': 'transportation_name',
      },
    ],
  };
  const filterChanges = [];
  const layoutChanges = [];
  const map = {
    addLayer(layer) {
      style.layers.push(layer);
    },
    getFilter(layerId) {
      return style.layers.find((layer) => layer.id === layerId)?.filter;
    },
    getLayer(layerId) {
      return style.layers.find((layer) => layer.id === layerId);
    },
    getStyle() {
      return style;
    },
    setFilter(layerId, filter) {
      filterChanges.push([layerId, filter]);
    },
    setLayoutProperty(layerId, property, value) {
      layoutChanges.push([layerId, property, value]);
    },
  };

  ensureOpenMapTilesAmenityLayers(map);

  const layerIds = new Set(style.layers.map((layer) => layer.id));
  assert.equal(layerIds.has('platforma-amenity-education-point-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-education-label-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-recreation-point-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-recreation-park-fill-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-recreation-park-label-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-recreation-embankment-line-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-recreation-embankment-label-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-healthcare-point-local-vector'), true);
  assert.equal(layerIds.has('platforma-amenity-healthcare-label-local-vector'), true);

  const addedLayers = style.layers.filter((layer) => layer.id.startsWith('platforma-amenity-'));
  assert.equal(addedLayers.every((layer) => layer.layout?.visibility === 'none'), true);
  assert.match(JSON.stringify(addedLayers), /kindergarten/);
  assert.match(JSON.stringify(addedLayers), /school/);
  assert.match(JSON.stringify(addedLayers), /hospital/);
  assert.match(JSON.stringify(addedLayers), /clinic/);
  assert.match(JSON.stringify(addedLayers), /набережн/);
  assert.match(JSON.stringify(addedLayers), /name:ru/);
  assert.doesNotMatch(JSON.stringify(addedLayers), /name:latin|name_en/);

  assert.equal(filterChanges.length, 1);
  assert.equal(filterChanges[0][0], 'poi_r1');
  assert.equal(filterChanges[0][1][0], 'all');

  setOpenMapTilesAmenityVisibility(map, 'recreation', true);

  const recreationVisibilityChanges = layoutChanges.filter(([layerId]) => (
    layerId.startsWith('platforma-amenity-recreation-')
  ));
  assert.equal(recreationVisibilityChanges.length, 5);
  assert.equal(recreationVisibilityChanges.every(([, property, value]) => (
    property === 'visibility' && value === 'visible'
  )), true);
  assert.equal(layoutChanges.some(([layerId]) => layerId.includes('education')), false);
  assert.equal(layoutChanges.some(([layerId]) => layerId.includes('healthcare')), false);
});
