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
type BrowserMap = {
  once(event: string, listener: (event?: { error?: { message?: string } }) => void): void;
  on(event: string, listener: (event?: { error?: { message?: string } }) => void): void;
  getStyle(): { layers: Array<{ id: string; type: string; layout?: Record<string, unknown> }> };
  setLayoutProperty(layerId: string, name: string, value: unknown): void;
  jumpTo(options: { center: [number, number]; zoom: number }): void;
  fitBounds(bounds: [[number, number], [number, number]], options: Record<string, unknown>): void;
  project(point: [number, number]): { x: number; y: number };
  isStyleLoaded(): boolean;
  triggerRepaint(): void;
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
  const timeoutMs = Number(environment.PROJECT_PRESENTATIONS_MAP_TIMEOUT_MS) || 30_000;
  return { enabled, styleUrl, timeoutMs };
}

// Renders the OpenFreeMap style with MapLibre in the same Chromium and returns a screenshot
// plus the pixel positions of the projects, so the template can draw crisp vector markers.
export async function renderProjectPresentationMap(
  browser: Browser,
  template: ProjectPresentationTemplateModule,
  points: ProjectPresentationMapPoint[],
  config: { styleUrl: string; timeoutMs: number },
): Promise<ProjectPresentationMapSnapshot> {
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
    const args: BrowserMapArgs = {
      styleUrl: config.styleUrl,
      points,
      view: template.PROJECT_PRESENTATION_MAP_VIEW,
      timeoutMs: config.timeoutMs,
    };
    const markers = await page.evaluate(drawMapInBrowser, args);
    const image = await page.locator('#map').screenshot({ type: 'jpeg', quality: 88, timeout: config.timeoutMs });
    return { image, markers };
  } finally {
    await context.close();
  }
}

async function drawMapInBrowser({ styleUrl, points, view, timeoutMs }: BrowserMapArgs) {
  const maplibre = (window as unknown as { maplibregl: MapLibreGlobal }).maplibregl;
  const withTimeout = <T>(promise: Promise<T>, label: string) => Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Map ${label} timed out`)), timeoutMs)),
  ]);
  const map = new maplibre.Map({
    container: 'map',
    style: styleUrl,
    center: view.defaultCenter,
    zoom: view.defaultZoom,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: 2,
  });
  await withTimeout(new Promise<void>((resolve, reject) => {
    map.once('load', () => resolve());
    map.on('error', (event) => {
      if (!map.isStyleLoaded()) reject(new Error(event?.error?.message || 'Map style failed to load'));
    });
  }), 'style');

  // Same Russian labels as the platform map (openMapTilesLabelLocalization.ts).
  const usesLatinName = (value: unknown): boolean => typeof value === 'string'
    ? value.includes('name:latin') || value.includes('name_en')
    : Array.isArray(value) && value.some(usesLatinName);
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol' && usesLatinName(layer.layout?.['text-field'])) {
      map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:ru'], ['get', 'name:nonlatin'], '']);
    }
  }

  const coordinates = points.map((point) => [point.longitude, point.latitude] as [number, number]);
  const idle = new Promise<void>((resolve) => map.once('idle', () => resolve()));
  const [single] = coordinates;
  if (coordinates.length === 1 && single) {
    map.jumpTo({ center: single, zoom: view.singlePointZoom });
  } else if (coordinates.length > 1) {
    const longitudes = coordinates.map(([longitude]) => longitude);
    const latitudes = coordinates.map(([, latitude]) => latitude);
    map.fitBounds(
      [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
      { padding: view.padding, maxZoom: view.maxZoom, animate: false },
    );
  }
  // Guarantees a fresh render (and an idle event) even when the camera did not move.
  map.triggerRepaint();
  await withTimeout(idle, 'tiles');
  return coordinates.map((coordinate) => {
    const { x, y } = map.project(coordinate);
    return { x, y };
  });
}
