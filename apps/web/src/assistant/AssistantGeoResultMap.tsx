import type { AssistantGeoSearchView } from '@platforma/shared';

import { PlatformMap, type MapGeometry, type MapPoint } from '../map/PlatformMap';

export function AssistantGeoResultMap({ geo }: { geo: AssistantGeoSearchView }) {
  const points: MapPoint[] = [
    ...(geo.kind === 'POINT' ? [{
      id: 'assistant-geo-anchor',
      title: geo.label,
      hint: `Точка поиска: ${geo.label}`,
      coordinates: [geo.point.latitude, geo.point.longitude] as [number, number],
      markerLabel: 'Точка',
      variant: 'ANCHOR' as const,
    }] : []),
    ...geo.markers.map((marker) => ({
      id: `assistant-geo-result-${marker.unitId}`,
      title: marker.kind === 'PRIMARY' ? 'Лучшее предложение' : 'Альтернатива',
      hint: typeof marker.distanceMeters === 'number'
        ? `${marker.kind === 'PRIMARY' ? 'Лучшее предложение' : 'Альтернатива'}, ${formatDistance(marker.distanceMeters)}`
        : marker.kind === 'PRIMARY' ? 'Лучшее предложение внутри выбранной области' : 'Альтернатива внутри выбранной области',
      coordinates: [marker.latitude, marker.longitude] as [number, number],
      markerLabel: typeof marker.distanceMeters === 'number' ? formatDistance(marker.distanceMeters) : undefined,
      variant: marker.kind,
    })),
  ];
  const geometries: MapGeometry[] = [
    { id: 'assistant-search-area', geometry: geo.searchArea, variant: 'SEARCH_AREA' },
    { id: 'assistant-reference', geometry: geo.referenceGeometry, variant: 'REFERENCE' },
  ];

  return (
    <div
      className="assistant-geo-result-map"
      data-geo-mode={geo.mode}
      data-reference-geometry={geo.referenceGeometry.type}
      data-search-area-geometry={geo.searchArea.type}
    >
      <PlatformMap
        ariaLabel={formatMapAriaLabel(geo)}
        enableFullscreen={false}
        enableMeasurement={false}
        geometries={geometries}
        points={points}
        renderWithoutPoints
      />
      <div className="assistant-geo-map-legend" aria-label="Обозначения карты">
        <span data-geometry-kind="reference">Ориентир</span>
        <span data-geometry-kind="search-area">Зона поиска</span>
        <span data-marker-kind="primary">Лучшие</span>
        <span data-marker-kind="alternative">Альтернативы</span>
      </div>
    </div>
  );
}

function formatMapAriaLabel(geo: AssistantGeoSearchView) {
  if (geo.mode === 'INSIDE') return `Результаты внутри области ${geo.label}`;
  if (geo.kind === 'LINE') return `Результаты до ${formatDistance(geo.distanceMeters)} от всей дороги ${geo.label}`;
  if (geo.kind === 'AREA') return `Результаты до ${formatDistance(geo.distanceMeters)} от границы ${geo.label}`;
  return `Результаты до ${formatDistance(geo.distanceMeters)} от точки ${geo.label}`;
}

export function formatDistance(value: number) {
  return value >= 1_000
    ? `${(value / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
    : `${Math.round(value).toLocaleString('ru-RU')} м`;
}
