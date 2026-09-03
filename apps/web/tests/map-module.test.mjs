import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(currentDir, '..');
const contractPath = resolve(webRoot, 'src/map/mapContract.ts');
const yandexRendererPath = resolve(webRoot, 'src/map/YandexMap.tsx');
const catalogSource = readFileSync(resolve(webRoot, 'src/catalog/CatalogPage.tsx'), 'utf8');
const mapLibreSource = readFileSync(resolve(webRoot, 'src/map/MapLibreMap.tsx'), 'utf8');
const mapTypesSource = readFileSync(resolve(webRoot, 'src/map/mapTypes.ts'), 'utf8');
const objectDetailSource = readFileSync(resolve(webRoot, 'src/objects/ObjectDetailPage.tsx'), 'utf8');
const styles = readFileSync(resolve(webRoot, 'src/styles.css'), 'utf8');
const dockerfile = readFileSync(resolve(webRoot, 'Dockerfile'), 'utf8');
const composeFile = readFileSync(resolve(webRoot, '../../docker-compose.yml'), 'utf8');
const envExample = readFileSync(resolve(webRoot, '.env.example'), 'utf8');
const rootEnvExample = readFileSync(resolve(webRoot, '../../.env.example'), 'utf8');
const indexHtml = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
const runtimeConfigSource = readFileSync(resolve(webRoot, 'public/runtime-config.js'), 'utf8');
const serverSource = readFileSync(resolve(webRoot, 'server.mjs'), 'utf8');
const viteConfigSource = readFileSync(resolve(webRoot, 'vite.config.ts'), 'utf8');
const browserTestSource = readFileSync(resolve(webRoot, 'tests/map-module.browser.mjs'), 'utf8');
const manualQaSource = readFileSync(resolve(webRoot, '../../docs/manual-qa-checklist.md'), 'utf8');
const productionChecklistSource = readFileSync(resolve(webRoot, '../../docs/staging-production-env-checklist.md'), 'utf8');

const {
  DEFAULT_MAP_STYLE_URL,
  formatMapDistance,
  getMapDistanceMeters,
  getValidMapCoordinate,
  getMapPointBounds,
  isValidMapCoordinatePair,
  resolveMapRuntimeConfig,
} = await import(pathToFileURL(contractPath).href);

test('map runtime config enables OpenFreeMap by default and supports provider overrides', () => {
  assert.equal(DEFAULT_MAP_STYLE_URL, 'https://tiles.openfreemap.org/styles/liberty');
  assert.deepEqual(resolveMapRuntimeConfig({}), {
    enabled: true,
    styleUrl: DEFAULT_MAP_STYLE_URL,
  });
  assert.deepEqual(
    resolveMapRuntimeConfig({
      mapProviderEnabled: 'false',
      mapStyleUrl: 'https://maps.example.test/styles/platforma.json',
    }),
    {
      enabled: false,
      styleUrl: 'https://maps.example.test/styles/platforma.json',
    },
  );
});

test('provider-neutral map geometry keeps latitude and longitude in canonical order', () => {
  const points = [
    { coordinates: [55.6, 37.4] },
    { coordinates: [55.9, 37.8] },
    { coordinates: [55.7, 37.2] },
  ];

  assert.deepEqual(getMapPointBounds(points), [
    [55.6, 37.2],
    [55.9, 37.8],
  ]);
  assert.equal(isValidMapCoordinatePair(55.751244, 37.618423), true);
  assert.equal(isValidMapCoordinatePair(null, 37.618423), false);
  assert.equal(isValidMapCoordinatePair(91, 37.618423), false);
  assert.equal(isValidMapCoordinatePair(55.751244, -181), false);
  assert.deepEqual(getValidMapCoordinate(55.751244, 37.618423), [55.751244, 37.618423]);
  assert.equal(getValidMapCoordinate(55.751244, null), null);
});

test('map distance uses geographic coordinates and readable metric formatting', () => {
  const distance = getMapDistanceMeters([55.751244, 37.618423], [55.760186, 37.618423]);

  assert.ok(distance > 990 && distance < 1_010);
  assert.equal(formatMapDistance(742), '750 м');
  assert.equal(formatMapDistance(1_000), '1 км');
  assert.equal(formatMapDistance(1_240), '1,2 км');
  assert.equal(formatMapDistance(12_540), '12,5 км');
});

test('web production runtime uses provider-neutral MapLibre configuration without Yandex Maps', () => {
  assert.equal(existsSync(yandexRendererPath), false);
  assert.match(catalogSource, /PlatformMap/);
  assert.match(objectDetailSource, /PlatformMap/);

  const productionRuntime = [catalogSource, objectDetailSource, styles, dockerfile, composeFile, envExample, indexHtml, serverSource].join('\n');

  assert.doesNotMatch(productionRuntime, /VITE_YANDEX_MAPS_API_KEY|api-maps\.yandex\.ru|\bymaps\b|YandexMap/);
  assert.doesNotMatch(dockerfile, /VITE_MAP_PROVIDER_ENABLED|VITE_MAP_STYLE_URL/);
  assert.match(composeFile, /MAP_PROVIDER_ENABLED: \$\{MAP_PROVIDER_ENABLED:-true\}/);
  assert.match(composeFile, /MAP_STYLE_URL: \$\{MAP_STYLE_URL:-https:\/\/tiles\.openfreemap\.org\/styles\/liberty\}/);
  assert.match(rootEnvExample, /MAP_PROVIDER_ENABLED=true/);
  assert.match(rootEnvExample, /MAP_STYLE_URL=https:\/\/tiles\.openfreemap\.org\/styles\/liberty/);
  assert.doesNotMatch(rootEnvExample, /VITE_YANDEX_MAPS_API_KEY/);
  assert.match(viteConfigSource, /exclude:\s*\['maplibre-gl'\]/);
  assert.match(viteConfigSource, /chunkSizeWarningLimit:\s*1_100/);
  assert.match(viteConfigSource, /name:\s*'maplibre'/);
  assert.match(viteConfigSource, /test:\s*\/node_modules\[\\\\\/\]maplibre-gl/);
  assert.match(viteConfigSource, /includeDependenciesRecursively:\s*true/);
});

test('web loads map provider settings from a no-cache runtime config before the application bundle', () => {
  const runtimeConfigIndex = indexHtml.indexOf('<script src="/runtime-config.js"></script>');
  const applicationIndex = indexHtml.indexOf('<script type="module" src="/src/main.tsx"></script>');

  assert.ok(runtimeConfigIndex > -1);
  assert.ok(applicationIndex > runtimeConfigIndex);
  assert.match(runtimeConfigSource, /window\.__PLATFORMA_RUNTIME_CONFIG__ \?\?= \{\};/);
  assert.match(serverSource, /pathname === '\/runtime-config\.js'/);
  assert.match(serverSource, /process\.env\.MAP_PROVIDER_ENABLED/);
  assert.match(serverSource, /process\.env\.MAP_STYLE_URL/);
  assert.match(serverSource, /'Cache-Control': 'no-store'/);
  assert.doesNotMatch(serverSource, /defaultMapStyleUrl|getMapProviderEnabled/);
});

test('provider-neutral map contract exposes coordinate selection without leaking MapLibre test selectors', () => {
  assert.match(mapTypesSource, /onMapClick\?: \(coordinate: MapCoordinate\) => void/);
  assert.match(mapLibreSource, /onMapClick\?\.\(\[event\.lngLat\.lat, event\.lngLat\.lng\]\)/);
  assert.doesNotMatch(browserTestSource, /\.maplibregl-/);
});

test('catalog map honors the explicit central Moscow viewport on first render', () => {
  assert.match(
    catalogSource,
    /const catalogMapInitialViewport: MapViewport = \{\s*center: \[55\.751244, 37\.618423\],\s*zoom: 11,\s*\};/,
  );
  assert.match(catalogSource, /<PlatformMap[\s\S]*?initialViewport=\{catalogMapInitialViewport\}/);
  assert.match(mapLibreSource, /const shouldSkipInitialContentFitRef = useRef\(initialViewport !== undefined\)/);
  assert.match(
    mapLibreSource,
    /if \(shouldSkipInitialContentFitRef\.current\) \{\s*if \(points\.length > 0 \|\| geometries\.length > 0\) \{\s*shouldSkipInitialContentFitRef\.current = false;\s*\}\s*return;\s*\}/,
  );
});

test('catalog map places navigation and fullscreen controls on the left below its primary tools', () => {
  assert.match(mapTypesSource, /export type MapControlsPosition = 'top-left' \| 'top-right'/);
  assert.match(mapTypesSource, /controlsPosition\?: MapControlsPosition/);
  assert.match(catalogSource, /<PlatformMap[\s\S]*?controlsPosition="top-left"/);
  assert.match(mapLibreSource, /controlsPosition = 'top-right'/);
  assert.match(
    mapLibreSource,
    /map\.addControl\(new maplibregl\.NavigationControl\([^;]+?\), controlsPosition\)/,
  );
  assert.match(mapLibreSource, /map\.addControl\(fullscreenControl, controlsPosition\)/);
  assert.match(mapLibreSource, /data-map-controls-position=\{controlsPosition\}/);
  assert.match(
    styles,
    /\.catalog-map-panel \.platform-map-shell\[data-map-controls-position='top-left'\] \.maplibregl-ctrl-top-left\s*\{\s*top:\s*120px;/,
  );
  assert.match(
    styles,
    /\.platform-map-shell\[data-map-controls-position='top-left'\] \.catalog-map-list\s*\{\s*left:\s*64px;/,
  );
});

test('map operations checklists document provider-neutral runtime configuration', () => {
  const operationsDocs = `${manualQaSource}\n${productionChecklistSource}`;

  assert.doesNotMatch(operationsDocs, /VITE_YANDEX_MAPS_API_KEY|no-key Yandex|JS API mode/);
  assert.match(operationsDocs, /MAP_PROVIDER_ENABLED/);
  assert.match(operationsDocs, /MAP_STYLE_URL/);
});

test('MapLibre styles preserve marker focus, reduced motion, responsive controls, and visible attribution', () => {
  assert.match(styles, /\.platform-map-shell\s*\{/);
  assert.match(styles, /\.platform-map-canvas\s*\{/);
  assert.match(styles, /\.platform-map--markers-expanded \.map-price-marker-dot\s*\{/);
  assert.match(styles, /\.map-price-marker:focus-visible\s*\{/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.platform-map-shell \.maplibregl-ctrl-attrib\s*\{/);
  assert.doesNotMatch(styles, /\.platform-map-shell \.maplibregl-ctrl-attrib[^}]*display:\s*none/s);
  assert.doesNotMatch(styles, /\.map-price-marker-anchor/);
  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.platform-map-shell \.maplibregl-ctrl-group button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/,
  );
});
