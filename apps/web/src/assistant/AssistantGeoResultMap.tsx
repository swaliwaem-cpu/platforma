import type { AssistantGeoSearchView } from '@platforma/shared';

import { PlatformMap, type MapPoint } from '../map/PlatformMap';

export function AssistantGeoResultMap({ geo }: { geo: AssistantGeoSearchView }) {
  const points: MapPoint[] = [
    {
      id: 'assistant-geo-anchor',
      title: geo.anchor.label,
      hint: `Точка поиска: ${geo.anchor.label}`,
      coordinates: [geo.anchor.latitude, geo.anchor.longitude],
      markerLabel: 'Точка',
      variant: 'ANCHOR',
    },
    ...geo.markers.map((marker) => ({
      id: `assistant-geo-result-${marker.unitId}`,
      title: marker.kind === 'PRIMARY' ? 'Лучшее предложение' : 'Альтернатива',
      hint: `${marker.kind === 'PRIMARY' ? 'Лучшее предложение' : 'Альтернатива'}, ${formatDistance(marker.distanceMeters)}`,
      coordinates: [marker.latitude, marker.longitude] as [number, number],
      markerLabel: formatDistance(marker.distanceMeters),
      variant: marker.kind,
    })),
  ];

  return (
    <div className="assistant-geo-result-map">
      <PlatformMap
        ariaLabel={`Результаты в радиусе ${formatDistance(geo.radiusMeters)}`}
        enableFullscreen={false}
        enableMeasurement={false}
        points={points}
        polygons={[{ id: 'assistant-radius', coordinates: geo.polygon.coordinates, variant: 'RADIUS' }]}
      />
      <div className="assistant-geo-map-legend" aria-label="Обозначения карты">
        <span data-marker-kind="primary">Лучшие</span>
        <span data-marker-kind="alternative">Альтернативы</span>
      </div>
    </div>
  );
}

export function formatDistance(value: number) {
  return value >= 1_000
    ? `${(value / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
    : `${Math.round(value).toLocaleString('ru-RU')} м`;
}
