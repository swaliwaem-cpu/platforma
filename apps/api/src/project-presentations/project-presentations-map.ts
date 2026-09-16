import { dirname, join } from 'node:path';

import type { Browser } from 'playwright-core';

import type { ProjectPresentationTemplateModule } from './project-presentation-template';

export type ProjectPresentationMapPoint = { latitude: number; longitude: number };
export type ProjectPresentationMapSnapshot = {
  image: Buffer;
  markers: Array<{ x: number; y: number }>;
};

type MapView = ProjectPresentationTemplateModule['PROJECT_PRESENTATION_MAP_VIEW'];
type MapSize = ProjectPresentationTemplateModule['PROJECT_PRESENTATION_MAP_SIZE'];
type BrowserMapArgs = {
  styleUrl: string;
  points: ProjectPresentationMapPoint[];
  view: MapView;
  timeoutMs: number;
};
type StyleLayer = { id: string; type: string; layout?: Record<string, unknown> };
type BrowserMap = {
  once(event: string, listener: (event?: { error?: { message?: string } }) => void): void;
  on(event: string, listener: (event?: { error?: { message?: string } }) => void): void;
  project(point: [number, number]): { x: number; y: number };
  isStyleLoaded(): boolean;
  areTilesLoaded(): boolean;
};
type MapLibreGlobal = { Map: new (options: Record<string, unknown>) => BrowserMap };

const defaultStyleUrl = 'https://tiles.openfreemap.org/styles/liberty';
// MapLibre 6 ships ES modules only: the page and the library are served from a virtual https origin,
// so module imports and the module worker resolve next to maplibre-gl.mjs.
const mapOrigin = 'https://map.invalid';
const libraryFiles = new Map([
  ['maplibre-gl.mjs', 'text/javascript'],
  ['maplibre-gl-shared.mjs', 'text/javascript'],
  ['maplibre-gl-worker.mjs', 'text/javascript'],
  ['maplibre-gl.css', 'text/css'],
]);

export function getProjectPresentationMapConfig(environment: NodeJS.ProcessEnv = process.env) {
  const enabled = environment.PROJECT_PRESENTATIONS_MAP_ENABLED?.trim().toLowerCase() !== 'false';
  const styleUrl = environment.PROJECT_PRESENTATIONS_MAP_STYLE_URL?.trim() || defaultStyleUrl;
  // Per phase (page, style, render). A normal render takes ~6 s, so a stalled phase is retried on a fresh page.
  const timeoutMs = Number(environment.PROJECT_PRESENTATIONS_MAP_TIMEOUT_MS) || 20_000;
  const rawAttempts = Number.parseInt(environment.PROJECT_PRESENTATIONS_MAP_ATTEMPTS ?? '', 10);
  const attempts = Number.isFinite(rawAttempts) ? Math.max(1, rawAttempts) : 2;
  return { enabled, styleUrl, timeoutMs, attempts };
}

export type ProjectPresentationMapStage = 'page' | 'map';
type MapRenderConfig = ReturnType<typeof getProjectPresentationMapConfig>;
type MapRenderHooks = {
  onStage?: (stage: ProjectPresentationMapStage) => Promise<void>;
  onRetry?: (error: unknown, attempt: number) => void;
};

// Renders the OpenFreeMap style with MapLibre in the same Chromium and returns a screenshot
// plus the pixel positions of the projects, so the template can draw crisp vector markers.
export async function renderProjectPresentationMap(
  browser: Browser,
  template: ProjectPresentationTemplateModule,
  points: ProjectPresentationMapPoint[],
  config: MapRenderConfig,
  hooks: MapRenderHooks = {},
): Promise<ProjectPresentationMapSnapshot> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    try {
      return await renderMapOnce(browser, template, points, config, hooks);
    } catch (error) {
      lastError = error;
      if (attempt < config.attempts) hooks.onRetry?.(error, attempt);
    }
  }
  throw lastError;
}

async function renderMapOnce(
  browser: Browser,
  template: ProjectPresentationTemplateModule,
  points: ProjectPresentationMapPoint[],
  config: MapRenderConfig,
  hooks: MapRenderHooks,
) {
  const size: MapSize = template.PROJECT_PRESENTATION_MAP_SIZE;
  const libraryDir = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.css'));
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/maplibre/maplibre-gl.css">'
    + `<style>html,body{margin:0;overflow:hidden}#map{position:relative;width:${size.width}px;height:${size.height}px}</style></head>`
    + '<body><div id="map"></div><script type="module">import * as maplibregl from "/maplibre/maplibre-gl.mjs"; window.maplibregl = maplibregl;</script></body></html>';
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 2,
  });
  try {
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === mapOrigin) {
        if (url.pathname === '/') return route.fulfill({ body: html, contentType: 'text/html' });
        const file = url.pathname.replace(/^\/maplibre\//u, '');
        const contentType = libraryFiles.get(file);
        return contentType
          ? route.fulfill({ path: join(libraryDir, file), contentType })
          : route.fulfill({ status: 404, body: '' });
      }
      return url.protocol === 'https:' ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.goto(`${mapOrigin}/`, { timeout: config.timeoutMs });
    await page.waitForFunction(() => 'maplibregl' in window, undefined, { timeout: config.timeoutMs });
    await hooks.onStage?.('page');
    const markers = await page.evaluate(drawMapInBrowser, {
      styleUrl: config.styleUrl,
      points,
      view: template.PROJECT_PRESENTATION_MAP_VIEW,
      timeoutMs: config.timeoutMs,
    });
    await hooks.onStage?.('map');
    const image = await page.locator('#map').screenshot({ type: 'jpeg', quality: 88, timeout: config.timeoutMs });
    return { image, markers };
  } finally {
    await context.close();
  }
}

// Runs inside the page (serialized by Playwright). The style is localized before the map is created
// and the camera starts on the projects, so MapLibre loads and renders the tiles in a single pass.
async function drawMapInBrowser({ styleUrl, points, view, timeoutMs }: BrowserMapArgs) {
  const deadline = <T>(promise: Promise<T>, message: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  };
  const response = await deadline(fetch(styleUrl), 'Map style request timed out');
  if (!response.ok) throw new Error(`Map style request failed: ${response.status}`);
  const style = await deadline(response.json() as Promise<{ layers: StyleLayer[] }>, 'Map style request timed out');

  // Same Russian labels as the platform map (openMapTilesLabelLocalization.ts).
  const usesLatinName = (value: unknown): boolean => typeof value === 'string'
    ? value.includes('name:latin') || value.includes('name_en')
    : Array.isArray(value) && value.some(usesLatinName);
  for (const layer of style.layers) {
    if (layer.type === 'symbol' && layer.layout && usesLatinName(layer.layout['text-field'])) {
      layer.layout['text-field'] = ['coalesce', ['get', 'name:ru'], ['get', 'name:nonlatin'], ''];
    }
  }

  const coordinates = points.map((point) => [point.longitude, point.latitude] as [number, number]);
  const [single] = coordinates;
  const camera: Record<string, unknown> = { center: view.defaultCenter, zoom: view.defaultZoom };
  if (coordinates.length === 1 && single) {
    Object.assign(camera, { center: single, zoom: view.singlePointZoom });
  } else if (coordinates.length > 1) {
    const longitudes = coordinates.map(([longitude]) => longitude);
    const latitudes = coordinates.map(([, latitude]) => latitude);
    Object.assign(camera, {
      bounds: [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
      fitBoundsOptions: { padding: view.padding, maxZoom: view.maxZoom },
    });
  }

  const maplibre = (window as unknown as { maplibregl: MapLibreGlobal }).maplibregl;
  const map = new maplibre.Map({
    container: 'map',
    style,
    ...camera,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: 2,
  });
  await deadline(new Promise<void>((resolve, reject) => {
    map.once('load', () => resolve());
    map.on('error', (event) => {
      if (!map.isStyleLoaded()) reject(new Error(event?.error?.message || 'Map style failed to load'));
    });
  }), 'Map rendering timed out');
  if (!map.areTilesLoaded()) {
    await deadline(new Promise<void>((resolve) => map.once('idle', () => resolve())), 'Map tiles timed out');
  }
  return coordinates.map((coordinate) => {
    const { x, y } = map.project(coordinate);
    return { x, y };
  });
}
