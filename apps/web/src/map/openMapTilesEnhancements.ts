import { VectorTile } from '@mapbox/vector-tile';
import type * as maplibregl from 'maplibre-gl';
import { PbfReader } from 'pbf';

import { getMapDistanceMeters } from './mapContract';
import { ensureOpenMapTilesAmenityLayers } from './openMapTilesAmenities';
import { localizeOpenMapTilesLabels } from './openMapTilesLabelLocalization';
import type { MapCoordinate, MapNearbyTransitStation } from './mapTypes';

export const NEARBY_TRANSIT_SEARCH_ZOOM = 14;

const subwayFilter: maplibregl.FilterSpecification = [
  'all',
  ['==', ['get', 'class'], 'transit'],
  ['==', ['get', 'subclass'], 'subway'],
];
const tramFilter: maplibregl.FilterSpecification = [
  'all',
  ['==', ['get', 'class'], 'transit'],
  ['match', ['get', 'subclass'], ['tram', 'light_rail'], true, false],
];
const railwayFilter: maplibregl.FilterSpecification = ['==', ['get', 'class'], 'rail'];
const mcdRouteExpression: maplibregl.ExpressionSpecification = [
  'upcase',
  [
    'to-string',
    [
      'coalesce',
      ['get', 'route_1'],
      ['get', 'route_2'],
      ['get', 'route_3'],
      ['get', 'route_4'],
      ['get', 'ref'],
      ['get', 'name'],
      '',
    ],
  ],
];
const mcdRouteValues = [
  'D1',
  'МЦД-1',
  'MCD-1',
  'D2',
  'МЦД-2',
  'MCD-2',
  'D3',
  'МЦД-3',
  'MCD-3',
  'D4',
  'МЦД-4',
  'MCD-4',
];
const mcdFilter: maplibregl.FilterSpecification = ['in', mcdRouteExpression, ['literal', mcdRouteValues]];
const mcdColorExpression: maplibregl.ExpressionSpecification = [
  'match',
  mcdRouteExpression,
  ['D1', 'МЦД-1', 'MCD-1'],
  '#f4a900',
  ['D2', 'МЦД-2', 'MCD-2'],
  '#e94287',
  ['D3', 'МЦД-3', 'MCD-3'],
  '#e76945',
  ['D4', 'МЦД-4', 'MCD-4'],
  '#45bda7',
  '#7d8490',
];
const fallbackPoiImage = createFallbackPoiImage();

export function enhanceOpenMapTilesStyle(map: maplibregl.Map) {
  localizeOpenMapTilesLabels(map);
  setLayerZoomRange(map, 'poi_r1', 13);
  setLayerZoomRange(map, 'poi_r7', 15);
  setLayerZoomRange(map, 'poi_r20', 16);
  enhanceTransitStationLayer(map);
  ensureOpenMapTilesAmenityLayers(map);

  const style = map.getStyle();
  const labelLayerId = style.layers.find((layer) => layer.type === 'symbol')?.id;
  const poiSourceIds = getSourceIdsForSourceLayer(map, 'poi');

  if (poiSourceIds.length > 0) {
    map.setMissingStyleImageResolver((imageId) => {
      if (!map.hasImage(imageId)) {
        map.addImage(imageId, fallbackPoiImage, { pixelRatio: 2 });
      }
    });
  }

  for (const sourceId of getSourceIdsForSourceLayer(map, 'transportation')) {
    const suffix = sanitizeLayerId(sourceId);

    addLineLayer(
      map,
      {
        id: `platforma-railways-${suffix}`,
        source: sourceId,
        filter: railwayFilter,
        minzoom: 8,
        paint: {
          'line-color': '#747b86',
          'line-opacity': 0.66,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 12, 1.5, 16, 2.8],
        },
      },
      labelLayerId,
    );
    addLineLayer(
      map,
      {
        id: `platforma-tram-lines-${suffix}`,
        source: sourceId,
        filter: tramFilter,
        minzoom: 12,
        paint: {
          'line-color': '#d98532',
          'line-opacity': 0.82,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 3.2],
        },
      },
      labelLayerId,
    );
    addLineLayer(
      map,
      {
        id: `platforma-subway-lines-${suffix}`,
        source: sourceId,
        filter: subwayFilter,
        minzoom: 11,
        paint: {
          'line-color': '#d84a44',
          'line-opacity': 0.82,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 15, 3.8, 18, 6],
        },
      },
      labelLayerId,
    );
    addLineLayer(
      map,
      {
        id: `platforma-mcd-casing-${suffix}`,
        source: sourceId,
        filter: mcdFilter,
        minzoom: 8,
        paint: {
          'line-color': mcdColorExpression,
          'line-opacity': 0.95,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.4, 12, 4.5, 16, 7],
        },
      },
      labelLayerId,
    );
    addLineLayer(
      map,
      {
        id: `platforma-mcd-center-${suffix}`,
        source: sourceId,
        filter: mcdFilter,
        minzoom: 8,
        paint: {
          'line-color': '#ffffff',
          'line-opacity': 0.94,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 12, 1.6, 16, 2.6],
        },
      },
      labelLayerId,
    );
  }
}

/**
 * Reads subway stations straight from the vector tiles around the origin, so
 * the lookup neither depends on nor changes the zoom the user is looking at.
 * Resolves to null when the style has no tiled POI source to read from.
 */
export async function loadNearestSubwayStations(
  map: maplibregl.Map,
  origin: MapCoordinate,
  signal: AbortSignal,
  limit = 3,
): Promise<MapNearbyTransitStation[] | null> {
  const sources = getSourceIdsForSourceLayer(map, 'poi')
    .map((sourceId) => map.getSource(sourceId))
    .filter((source): source is maplibregl.VectorTileSource => (
      source?.type === 'vector' && (source as maplibregl.VectorTileSource).tiles?.length > 0
    ));

  if (sources.length === 0) {
    return null;
  }

  const stationsByName = new Map<string, MapNearbyTransitStation>();

  for (const source of sources) {
    const zoom = Math.min(NEARBY_TRANSIT_SEARCH_ZOOM, source.maxzoom);
    const tiles = await Promise.all(
      getTilesAround(origin, zoom).map(async (tile) => ({ tile, data: await fetchVectorTile(source, tile, signal) })),
    );

    for (const { tile, data } of tiles) {
      const layer = data?.layers.poi;

      if (!layer) {
        continue;
      }

      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);

        if (feature.type !== 1 || feature.properties.class !== 'railway' || feature.properties.subclass !== 'subway') {
          continue;
        }

        const { geometry } = feature.toGeoJSON(tile.x, tile.y, tile.z);
        const name = getStationName(feature.properties);

        if (!name || geometry.type !== 'Point') {
          continue;
        }

        const [longitude, latitude] = geometry.coordinates;

        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
          continue;
        }

        const coordinates: MapCoordinate = [latitude, longitude];
        const station: MapNearbyTransitStation = {
          name,
          coordinates,
          distanceMeters: getMapDistanceMeters(origin, coordinates),
        };
        const key = name.trim().toLocaleLowerCase('ru-RU');
        const current = stationsByName.get(key);

        if (!current || station.distanceMeters < current.distanceMeters) {
          stationsByName.set(key, station);
        }
      }
    }
  }

  return [...stationsByName.values()].sort((left, right) => left.distanceMeters - right.distanceMeters).slice(0, limit);
}

type TileAddress = { x: number; y: number; z: number };

// A 3x3 block of z14 tiles covers roughly 2 km around the origin in Moscow.
function getTilesAround([latitude, longitude]: MapCoordinate, zoom: number): TileAddress[] {
  const tileCount = 2 ** zoom;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const centerX = Math.floor(((longitude + 180) / 360) * tileCount);
  const centerY = Math.floor(
    ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) * tileCount,
  );
  const tiles: TileAddress[] = [];

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    const y = centerY + offsetY;

    if (y < 0 || y >= tileCount) {
      continue;
    }

    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      tiles.push({ x: (centerX + offsetX + tileCount) % tileCount, y, z: zoom });
    }
  }

  return tiles;
}

async function fetchVectorTile(source: maplibregl.VectorTileSource, tile: TileAddress, signal: AbortSignal) {
  const [template] = source.tiles;
  const y = source.scheme === 'tms' ? 2 ** tile.z - 1 - tile.y : tile.y;

  if (!template) {
    return null;
  }

  try {
    const response = await fetch(
      template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(y)),
      { signal },
    );

    return response.ok ? new VectorTile(new PbfReader(await response.arrayBuffer())) : null;
  } catch {
    // A missing or unreachable tile only narrows the search; the caller checks the signal.
    return null;
  }
}

function enhanceTransitStationLayer(map: maplibregl.Map) {
  const layer = map.getLayer('poi_transit');

  if (!layer) {
    return;
  }

  map.setLayerZoomRange('poi_transit', 12, 24);
  map.setFilter('poi_transit', [
    'any',
    ['match', ['get', 'class'], ['airport', 'bus', 'rail'], true, false],
    [
      'all',
      ['==', ['get', 'class'], 'railway'],
      ['match', ['get', 'subclass'], ['subway', 'station', 'halt', 'train'], true, false],
    ],
  ]);

  if (layer.type === 'symbol') {
    map.setLayoutProperty('poi_transit', 'icon-image', [
      'case',
      ['==', ['get', 'subclass'], 'subway'],
      'railway_metro',
      ['==', ['get', 'class'], 'railway'],
      'railway',
      ['to-string', ['get', 'class']],
    ]);
    map.setLayoutProperty('poi_transit', 'icon-size', [
      'interpolate',
      ['linear'],
      ['zoom'],
      12,
      0.72,
      16,
      0.92,
    ]);
  }
}

function setLayerZoomRange(map: maplibregl.Map, layerId: string, minzoom: number) {
  if (map.getLayer(layerId)) {
    map.setLayerZoomRange(layerId, minzoom, 24);
  }
}

function getSourceIdsForSourceLayer(map: maplibregl.Map, sourceLayer: string) {
  const sourceIds = new Set<string>();

  for (const layer of map.getStyle().layers) {
    if ('source-layer' in layer && layer['source-layer'] === sourceLayer && typeof layer.source === 'string') {
      sourceIds.add(layer.source);
    }
  }

  return [...sourceIds];
}

function addLineLayer(
  map: maplibregl.Map,
  layer: Omit<maplibregl.LineLayerSpecification, 'source-layer' | 'type'>,
  beforeId?: string,
) {
  if (map.getLayer(layer.id)) {
    return;
  }

  map.addLayer(
    {
      ...layer,
      type: 'line',
      'source-layer': 'transportation',
    },
    beforeId,
  );
}

function getStationName(properties: Record<string, unknown>) {
  const candidate = properties?.['name:ru'] ?? properties?.name ?? properties?.['name:nonlatin'] ?? properties?.name_en;

  return typeof candidate === 'string' ? candidate.trim() : '';
}

function sanitizeLayerId(sourceId: string) {
  return sourceId.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function createFallbackPoiImage(): maplibregl.StyleImageSource {
  const width = 16;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  const center = (width - 1) / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - center, y - center);

      if (distance > 6.5) {
        continue;
      }

      const offset = (y * width + x) * 4;
      const isBorder = distance > 5.2;

      data[offset] = isBorder ? 255 : 200;
      data[offset + 1] = isBorder ? 255 : 134;
      data[offset + 2] = isBorder ? 255 : 47;
      data[offset + 3] = 255;
    }
  }

  return { width, height, data };
}
