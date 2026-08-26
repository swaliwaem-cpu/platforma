import type * as maplibregl from 'maplibre-gl';

export type OpenMapTilesAmenityCategory = 'education' | 'recreation' | 'healthcare';

const amenityLayerPrefix = 'platforma-amenity-';
const russianNameExpression: maplibregl.ExpressionSpecification = [
  'coalesce',
  ['get', 'name:ru'],
  ['get', 'name:nonlatin'],
  '',
];
const educationPoiFilter: maplibregl.FilterSpecification = [
  'any',
  ['match', ['get', 'class'], ['school', 'kindergarten', 'childcare'], true, false],
  ['match', ['get', 'subclass'], ['school', 'kindergarten', 'childcare'], true, false],
];
const recreationPoiFilter: maplibregl.FilterSpecification = [
  'any',
  ['match', ['get', 'class'], ['park', 'garden'], true, false],
  ['match', ['get', 'subclass'], ['park', 'garden', 'nature_reserve'], true, false],
];
const healthcarePoiFilter: maplibregl.FilterSpecification = [
  'any',
  ['match', ['get', 'class'], ['hospital', 'clinic'], true, false],
  ['match', ['get', 'subclass'], ['hospital', 'clinic', 'doctors'], true, false],
];
const toggleablePoiFilter: maplibregl.FilterSpecification = [
  'any',
  educationPoiFilter,
  recreationPoiFilter,
  healthcarePoiFilter,
];
const embankmentNameFilter: maplibregl.FilterSpecification = [
  '>=',
  [
    'index-of',
    'набережн',
    ['downcase', ['coalesce', ['get', 'name:ru'], ['get', 'name:nonlatin'], '']],
  ],
  0,
];

const poiCategories: Record<OpenMapTilesAmenityCategory, {
  color: string;
  filter: maplibregl.FilterSpecification;
}> = {
  education: { color: '#3f82c5', filter: educationPoiFilter },
  recreation: { color: '#4f9a68', filter: recreationPoiFilter },
  healthcare: { color: '#d75a56', filter: healthcarePoiFilter },
};

export function ensureOpenMapTilesAmenityLayers(map: maplibregl.Map) {
  const style = map.getStyle();
  const supportsLabels = Boolean(style.glyphs);

  excludeToggleableAmenitiesFromBaseLayers(map, style.layers);

  for (const sourceId of getSourceIdsForSourceLayer(style.layers, 'poi')) {
    const suffix = sanitizeLayerId(sourceId);

    for (const [category, config] of Object.entries(poiCategories) as Array<[
      OpenMapTilesAmenityCategory,
      (typeof poiCategories)[OpenMapTilesAmenityCategory],
    ]>) {
      addLayer(map, {
        id: `${amenityLayerPrefix}${category}-point-${suffix}`,
        type: 'circle',
        source: sourceId,
        'source-layer': 'poi',
        filter: config.filter,
        minzoom: 11,
        layout: { visibility: 'none' },
        paint: {
          'circle-color': config.color,
          'circle-opacity': 0.94,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7, 18, 9],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });

      if (supportsLabels && category !== 'recreation') {
        addPointLabelLayer(map, {
          category,
          filter: config.filter,
          sourceId,
          suffix,
        });
      }
    }
  }

  for (const sourceId of getSourceIdsForSourceLayer(style.layers, 'park')) {
    const suffix = sanitizeLayerId(sourceId);

    addLayer(map, {
      id: `${amenityLayerPrefix}recreation-park-fill-${suffix}`,
      type: 'fill',
      source: sourceId,
      'source-layer': 'park',
      minzoom: 10,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': '#4f9a68',
        'fill-opacity': 0.2,
        'fill-outline-color': '#347a4e',
      },
    });

    if (supportsLabels) {
      addLayer(map, {
        id: `${amenityLayerPrefix}recreation-park-label-${suffix}`,
        type: 'symbol',
        source: sourceId,
        'source-layer': 'park',
        minzoom: 11,
        layout: {
          visibility: 'none',
          'text-anchor': 'center',
          'text-field': russianNameExpression,
          'text-font': ['Noto Sans Regular'],
          'text-max-width': 14,
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 15, 14],
        },
        paint: {
          'text-color': '#2f7248',
          'text-halo-blur': 0.5,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
    }
  }

  for (const sourceId of getSourceIdsForSourceLayer(style.layers, 'transportation_name')) {
    const suffix = sanitizeLayerId(sourceId);

    addLayer(map, {
      id: `${amenityLayerPrefix}recreation-embankment-line-${suffix}`,
      type: 'line',
      source: sourceId,
      'source-layer': 'transportation_name',
      filter: embankmentNameFilter,
      minzoom: 11,
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#319a82',
        'line-opacity': 0.9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 5],
      },
    });

    if (supportsLabels) {
      addLayer(map, {
        id: `${amenityLayerPrefix}recreation-embankment-label-${suffix}`,
        type: 'symbol',
        source: sourceId,
        'source-layer': 'transportation_name',
        filter: embankmentNameFilter,
        minzoom: 11,
        layout: {
          visibility: 'none',
          'symbol-placement': 'line',
          'text-field': russianNameExpression,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 16, 14],
        },
        paint: {
          'text-color': '#247764',
          'text-halo-blur': 0.5,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
    }
  }
}

export function setOpenMapTilesAmenityVisibility(
  map: maplibregl.Map,
  category: OpenMapTilesAmenityCategory,
  isVisible: boolean,
) {
  const categoryPrefix = `${amenityLayerPrefix}${category}-`;

  for (const layer of map.getStyle().layers) {
    if (layer.id.startsWith(categoryPrefix)) {
      map.setLayoutProperty(layer.id, 'visibility', isVisible ? 'visible' : 'none');
    }
  }
}

function addPointLabelLayer(
  map: maplibregl.Map,
  {
    category,
    filter,
    sourceId,
    suffix,
  }: {
    category: OpenMapTilesAmenityCategory;
    filter: maplibregl.FilterSpecification;
    sourceId: string;
    suffix: string;
  },
) {
  addLayer(map, {
    id: `${amenityLayerPrefix}${category}-label-${suffix}`,
    type: 'symbol',
    source: sourceId,
    'source-layer': 'poi',
    filter,
    minzoom: 12,
    layout: {
      visibility: 'none',
      'text-anchor': 'top',
      'text-field': russianNameExpression,
      'text-font': ['Noto Sans Regular'],
      'text-max-width': 14,
      'text-offset': [0, 1.1],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 13],
    },
    paint: {
      'text-color': '#27323f',
      'text-halo-blur': 0.5,
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  });
}

function excludeToggleableAmenitiesFromBaseLayers(
  map: maplibregl.Map,
  layers: maplibregl.LayerSpecification[],
) {
  for (const layer of layers) {
    if (
      layer.id.startsWith(amenityLayerPrefix)
      || !('source-layer' in layer)
      || layer['source-layer'] !== 'poi'
    ) {
      continue;
    }

    const currentFilter = map.getFilter(layer.id);
    const exclusionFilter: maplibregl.ExpressionSpecification = [
      '!',
      toggleablePoiFilter as maplibregl.ExpressionSpecification,
    ];
    const nextFilter = currentFilter
      ? ['all', currentFilter, exclusionFilter]
      : exclusionFilter;

    map.setFilter(layer.id, nextFilter as maplibregl.FilterSpecification);
  }
}

function getSourceIdsForSourceLayer(layers: maplibregl.LayerSpecification[], sourceLayer: string) {
  const sourceIds = new Set<string>();

  for (const layer of layers) {
    if ('source-layer' in layer && layer['source-layer'] === sourceLayer && typeof layer.source === 'string') {
      sourceIds.add(layer.source);
    }
  }

  return [...sourceIds];
}

function addLayer(map: maplibregl.Map, layer: maplibregl.LayerSpecification) {
  if (!map.getLayer(layer.id)) {
    map.addLayer(layer);
  }
}

function sanitizeLayerId(sourceId: string) {
  return sourceId.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
