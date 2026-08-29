import type { AssistantGeoView } from '@platforma/shared';

import { PlatformMap, type MapGeometry, type MapPoint } from '../map/PlatformMap';

export function AssistantGeoResultMap({ geo }: { geo: AssistantGeoView }) {
  const constraints = 'operator' in geo ? geo.constraints : [geo];
  const isComposite = 'operator' in geo;
  const points: MapPoint[] = [
    ...constraints.flatMap((constraint, index) => constraint.kind === 'POINT' ? [{
      id: `assistant-geo-anchor-${index}`,
      title: constraint.label,
      hint: `Точка поиска: ${constraint.label}`,
      coordinates: [constraint.point.latitude, constraint.point.longitude] as [number, number],
      markerLabel: 'Точка',
      variant: 'ANCHOR' as const,
    }] : []),
    ...geo.markers.map((marker) => ({
      id: `assistant-geo-result-${marker.unitId}`,
      title: marker.kind === 'PRIMARY' ? 'Лучшее предложение' : 'Альтернатива',
      hint: typeof marker.distanceMeters === 'number'
        ? `${marker.kind === 'PRIMARY' ? 'Лучшее предложение' : 'Альтернатива'}, ${formatDistance(marker.distanceMeters)}`
        : isComposite
          ? marker.kind === 'PRIMARY'
            ? 'Лучшее предложение, подходит под все географические условия'
            : 'Альтернатива, подходит под все географические условия'
          : marker.kind === 'PRIMARY'
            ? 'Лучшее предложение внутри выбранной области'
            : 'Альтернатива внутри выбранной области',
      coordinates: [marker.latitude, marker.longitude] as [number, number],
      markerLabel: typeof marker.distanceMeters === 'number' ? formatDistance(marker.distanceMeters) : undefined,
      variant: marker.kind,
    })),
  ];
  const geometries: MapGeometry[] = constraints.flatMap((constraint, index) => [
    { id: `assistant-search-area-${index}`, geometry: constraint.searchArea, variant: 'SEARCH_AREA' as const },
    { id: `assistant-reference-${index}`, geometry: constraint.referenceGeometry, variant: 'REFERENCE' as const },
  ]);
  const single = constraints.length === 1 ? constraints[0]! : null;

  return (
    <div
      className="assistant-geo-result-map"
      data-geo-constraint-count={constraints.length}
      data-geo-mode={single?.mode ?? 'ALL'}
      data-reference-geometry={single?.referenceGeometry.type ?? 'Multiple'}
      data-search-area-geometry={single?.searchArea.type ?? 'Multiple'}
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

function formatMapAriaLabel(geo: AssistantGeoView) {
  if ('operator' in geo) {
    return `Результаты по всем ${geo.constraints.length} географическим условиям: ${geo.constraints.map(({ label }) => label).join(', ')}`;
  }
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
