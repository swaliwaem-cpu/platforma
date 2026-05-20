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
  assert.match(mapSource, /yandexMapElement\?\.classList\.toggle\('yandex-map--markers-expanded'/);
  assert.match(mapSource, /\w+\.events\.add\('boundschange', handleBoundsChange\);/);
});

test('yandex map preserves viewport after fullscreen size changes', () => {
  assert.match(mapSource, /container:\s*\{[\s\S]*fitToViewport:/);
  assert.match(mapSource, /type YandexMapViewport = \{\s*center: \[number, number\];\s*zoom: number;\s*\};/);
  assert.match(mapSource, /getCenter: \(\) => number\[\] \| null;/);
  assert.match(mapSource, /setCenter: \(center: \[number, number\], zoom\?: number, options\?: Record<string, unknown>\) => void;/);
  assert.match(mapSource, /let viewportBeforeFullscreen: YandexMapViewport \| null = null;/);
  assert.match(mapSource, /viewportBeforeFullscreen = getCurrentMapViewport\(nextMap\);/);
  assert.match(mapSource, /const viewportToRestore = getCurrentMapViewport\(nextMap\) \?\? viewportBeforeFullscreen;/);
  assert.match(mapSource, /nextMap\.container\.events\.add\('fullscreenenter', handleFullscreenEnter\);/);
  assert.match(mapSource, /nextMap\.container\.events\.add\('fullscreenexit', handleFullscreenExit\);/);
  assert.match(mapSource, /nextMap\.container\.fitToViewport\(\);[\s\S]*?restoreMapViewport\(nextMap, viewportToRestore\);/);
  assert.match(mapSource, /function getCurrentMapViewport\(map: YandexMapInstance\): YandexMapViewport \| null/);
  assert.match(mapSource, /function restoreMapViewport\(map: YandexMapInstance, viewport: YandexMapViewport\)/);
  assert.match(mapSource, /\w+\.container\.events\.remove\('fullscreenexit', handleFullscreenExit\);/);
});

test('catalog map overlays render through the yandex map element for fullscreen', () => {
  assert.match(mapSource, /children\?: ReactNode;/);
  assert.match(mapSource, /import \{ createPortal \} from 'react-dom';/);
  assert.match(mapSource, /getElement: \(\) => HTMLElement;/);
  assert.doesNotMatch(mapSource, /nextMap\.panes\.get\('controls'\)/);
  assert.match(mapSource, /const mapElement = nextMap\.container\.getElement\(\);/);
  assert.match(mapSource, /nextOverlayRoot = document\.createElement\('div'\);/);
  assert.match(mapSource, /nextOverlayRoot\.className = 'yandex-map-overlay-root';/);
  assert.match(mapSource, /mapElement\.appendChild\(nextOverlayRoot\);/);
  assert.match(mapSource, /createPortal\(children, overlayRoot\)/);
  assert.match(mapSource, /<div ref=\{containerRef\} className="yandex-map" \/>/);
  assert.match(
    catalogSource,
    /<YandexMap[\s\S]*?onSelectPoint=\{handleSelectPoint\}[\s\S]*?>\s*\{shouldRenderOverlayInsideMap \? mapOverlay : null\}\s*<\/YandexMap>/,
  );
  assert.match(catalogSource, /const mapOverlay = \([\s\S]*?<MapObjectCard[\s\S]*?<aside className="catalog-map-list"/);
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
    /\.map-price-marker\s*\{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?background:\s*transparent;[\s\S]*?overflow:\s*visible;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.map-price-marker::before\s*\{[\s\S]*?width:\s*36px;[\s\S]*?border-radius:\s*50%;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.map-price-marker-label\s*\{[\s\S]*?pointer-events:\s*none;[\s\S]*?transform-origin:\s*left center;[\s\S]*?scaleX\(0\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.map-price-marker-label span\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?transform:\s*translateX\(-10px\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.yandex-map--markers-expanded \.map-price-marker-label\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*translateY\(-50%\) scaleX\(1\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.yandex-map--markers-expanded \.map-price-marker-label span\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*translateX\(0\);[\s\S]*?\}/,
  );
});

test('map marker click target stays limited to the visible circle', () => {
  assert.match(mapSource, /'<div class="map-price-marker-anchor">',/);
  assert.match(mapSource, /'<button class="map-price-marker" type="button"',/);
  assert.match(mapSource, /'<\/button>',\s*'<span class="map-price-marker-label" aria-hidden="true">',\s*'<span>\$\[properties\.markerLabel\]<\/span>',\s*'<\/span>',\s*'<\/div>',/);
  assert.match(
    mapSource,
    /iconOffset:\s*\[-18,\s*-18\],\s*iconShape:\s*\{\s*type:\s*'Circle',\s*coordinates:\s*\[18,\s*18\],\s*radius:\s*18,\s*\}/,
  );
  assert.doesNotMatch(mapSource, /\[128,\s*18\]/);
  assert.match(styles, /\.map-price-marker-anchor\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*124px;[\s\S]*?height:\s*36px;[\s\S]*?\}/);
  assert.match(styles, /\.map-price-marker\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*0;[\s\S]*?top:\s*0;[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?\}/);
  assert.match(styles, /\.map-price-marker-label\s*\{[\s\S]*?left:\s*18px;[\s\S]*?width:\s*104px;[\s\S]*?height:\s*34px;[\s\S]*?pointer-events:\s*none;[\s\S]*?\}/);
  assert.doesNotMatch(styles, /\.yandex-map--markers-expanded \.map-price-marker\s*\{[\s\S]*?width:\s*124px;[\s\S]*?\}/);
});

test('catalog map layout stays bounded after fullscreen exits', () => {
  assert.match(styles, /\.catalog-page\s*\{[\s\S]*?width:\s*min\(100%,\s*1360px\);[\s\S]*?min-width:\s*0;/);
  assert.match(styles, /\.catalog-map-layout\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
  assert.match(styles, /\.catalog-map-panel\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
  assert.match(styles, /\.yandex-map-shell\s*\{[\s\S]*?height:\s*640px;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.yandex-map\s*\{[\s\S]*?position:\s*relative;[\s\S]*?height:\s*640px;[\s\S]*?overflow:\s*hidden;/);
  assert.match(
    styles,
    /\.yandex-map-overlay-root\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?z-index:\s*2147483000;[\s\S]*?inset:\s*0;[\s\S]*?pointer-events:\s*none;/,
  );
  assert.match(styles, /\.yandex-map-overlay-root > \*\s*\{[\s\S]*?pointer-events:\s*auto;/);
  assert.match(styles, /\.catalog-map-list\s*\{[\s\S]*?z-index:\s*20;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/);
  assert.match(styles, /\.catalog-map-list-toggle\s*\{[\s\S]*?z-index:\s*20;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/);
  assert.match(styles, /\.map-object-card\s*\{[\s\S]*?z-index:\s*21;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/);
  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.yandex-map-shell,\s*[\s\S]*?\.yandex-map,\s*[\s\S]*?\.map-fallback\s*\{[\s\S]*?height:\s*420px;/,
  );
});

test('catalog map list leaves room for yandex fullscreen control', () => {
  assert.match(styles, /\.catalog-map-list\s*\{[\s\S]*?top:\s*64px;[\s\S]*?right:\s*24px;[\s\S]*?max-height:\s*calc\(100% - 88px\);/);
  assert.match(styles, /\.catalog-map-list-toggle\s*\{[\s\S]*?top:\s*64px;[\s\S]*?right:\s*24px;/);
});
