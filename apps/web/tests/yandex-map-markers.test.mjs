import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const mapSource = readFileSync(resolve(currentDir, '../src/map/YandexMap.tsx'), 'utf8');
const catalogSource = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

function getFunctionBody(source, functionName) {
  const functionStart = source.indexOf(`function ${functionName}`);

  assert.notEqual(functionStart, -1, `${functionName} should exist`);

  const bodyStart = source.indexOf('{', functionStart);

  assert.notEqual(bodyStart, -1, `${functionName} should have a body`);

  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    }

    if (source[index] === '}') {
      depth -= 1;
    }

    if (depth === 0) {
      return source.slice(bodyStart + 1, index);
    }
  }

  assert.fail(`${functionName} body should be closed`);
}

test('yandex map adds individual placemarks without clusterer aggregation', () => {
  assert.doesNotMatch(mapSource, /new ymaps\.Clusterer/);
  assert.doesNotMatch(mapSource, /clusterer\.(add|getBounds)/);
  assert.doesNotMatch(mapSource, /map\.geoObjects\.add\(clusterer\)/);
  assert.match(mapSource, /placemarks\.forEach\(\(placemark\) => \w+\.geoObjects\.add\(placemark\)\);/);
});

test('yandex map expands marker labels only on close zoom', () => {
  assert.match(mapSource, /const expandedMarkerZoom = 14;/);
  assert.match(mapSource, /\w+\.getZoom\(\)/);
  assert.match(mapSource, /\.classList\.toggle\('yandex-map--markers-expanded'/);
  assert.match(mapSource, /\w+\.events\.add\('boundschange', handleBoundsChange\);/);
});

test('yandex map refits viewport after fullscreen size changes', () => {
  assert.match(mapSource, /container:\s*\{[\s\S]*fitToViewport:/);
  assert.match(mapSource, /let boundsBeforeFullscreen: YandexMapBounds \| null = null;/);
  assert.match(mapSource, /boundsBeforeFullscreen = normalizeYandexBounds\(nextMap\.getBounds\(\)\);/);
  assert.match(mapSource, /nextMap\.container\.events\.add\('fullscreenenter', handleFullscreenEnter\);/);
  assert.match(mapSource, /nextMap\.container\.events\.add\('fullscreenexit', handleFullscreenExit\);/);
  assert.match(mapSource, /nextMap\.container\.fitToViewport\(\);[\s\S]*?nextMap\.setBounds\(boundsBeforeFullscreen, \{/);
  assert.match(mapSource, /\w+\.container\.events\.remove\('fullscreenexit', handleFullscreenExit\);/);
});

test('map marker labels omit price-per-meter suffixes', () => {
  const catalogMarkerFormatter = getFunctionBody(catalogSource, 'formatMapMarkerPrice');
  const objectMarkerFormatter = getFunctionBody(objectDetailSource, 'formatObjectMapMarkerPrice');

  for (const formatterBody of [catalogMarkerFormatter, objectMarkerFormatter]) {
    assert.doesNotMatch(formatterBody, /\/м²/);
    assert.match(formatterBody, /return 'по запросу';/);
    assert.match(formatterBody, /return `от \$\{formatCompactRussianNumber\(parsed \/ 1000\)\}т`;/);
  }
});

test('map marker CSS starts as a circle and animates an oval label from it', () => {
  assert.match(
    styles,
    /\.map-price-marker\s*\{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?background:\s*transparent;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.map-price-marker::before\s*\{[\s\S]*?width:\s*36px;[\s\S]*?border-radius:\s*50%;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.map-price-marker::after\s*\{[\s\S]*?transform-origin:\s*left center;[\s\S]*?scaleX\(0\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.map-price-marker span\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?transform:\s*translateX\(-10px\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.yandex-map--markers-expanded \.map-price-marker\s*\{[\s\S]*?width:\s*124px;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.yandex-map--markers-expanded \.map-price-marker span\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*translateX\(0\);[\s\S]*?\}/,
  );
});

test('catalog map layout stays bounded after fullscreen exits', () => {
  assert.match(styles, /\.catalog-page\s*\{[\s\S]*?width:\s*min\(100%,\s*1360px\);[\s\S]*?min-width:\s*0;/);
  assert.match(styles, /\.catalog-map-layout\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
  assert.match(styles, /\.catalog-map-panel\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
  assert.match(styles, /\.yandex-map-shell\s*\{[\s\S]*?height:\s*640px;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.yandex-map\s*\{[\s\S]*?height:\s*640px;[\s\S]*?overflow:\s*hidden;/);
  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.yandex-map-shell,\s*[\s\S]*?\.yandex-map,\s*[\s\S]*?\.map-fallback\s*\{[\s\S]*?height:\s*420px;/,
  );
});
