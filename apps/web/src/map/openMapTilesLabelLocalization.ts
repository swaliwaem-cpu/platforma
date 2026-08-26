import type * as maplibregl from 'maplibre-gl';

const russianLabelExpression: maplibregl.ExpressionSpecification = [
  'coalesce',
  ['get', 'name:ru'],
  ['get', 'name:nonlatin'],
  '',
];

export function localizeOpenMapTilesLabels(map: maplibregl.Map) {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') {
      continue;
    }

    const textField = layer.layout?.['text-field'];

    if (usesLatinName(textField)) {
      map.setLayoutProperty(layer.id, 'text-field', russianLabelExpression);
    }
  }
}

function usesLatinName(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes('name:latin') || value.includes('name_en');
  }

  return Array.isArray(value) && value.some(usesLatinName);
}
