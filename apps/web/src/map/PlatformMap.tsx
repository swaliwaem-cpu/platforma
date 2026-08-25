import { lazy, Suspense, useEffect, type ReactNode } from 'react';

import { resolveMapRuntimeConfig, type MapRuntimeConfigSource } from './mapContract';
import type { MapFallbackState, MapStatus, PlatformMapProps } from './mapTypes';

declare global {
  interface Window {
    __PLATFORMA_RUNTIME_CONFIG__?: MapRuntimeConfigSource;
  }
}

const MapLibreMap = lazy(() => import('./MapLibreMap'));

const defaultEmptyState: MapFallbackState = {
  eyebrow: 'Карта',
  title: 'Нет объектов с координатами',
  description: 'Для отображения на карте у объекта должны быть широта и долгота.',
};

const disabledState: MapFallbackState = {
  eyebrow: 'Карта',
  title: 'Карта временно отключена',
  description: 'Данные объектов и рабочие ссылки остаются доступны без картографической подложки.',
};

export function PlatformMap({
  ariaLabel,
  children,
  emptyState = defaultEmptyState,
  points,
  renderWithoutPoints = false,
  onStatusChange,
  ...mapProps
}: PlatformMapProps) {
  const config = resolveMapRuntimeConfig(window.__PLATFORMA_RUNTIME_CONFIG__ ?? {});

  if (points.length === 0 && !renderWithoutPoints) {
    return <MapFallback ariaLabel={ariaLabel} fallback={emptyState} onStatusChange={onStatusChange} status="empty" />;
  }

  if (!config.enabled) {
    return (
      <MapFallbackShell ariaLabel={ariaLabel} fallback={disabledState} onStatusChange={onStatusChange} status="disabled">
        {children}
      </MapFallbackShell>
    );
  }

  return (
    <Suspense
      fallback={
        <MapLoadingShell ariaLabel={ariaLabel} onStatusChange={onStatusChange}>
          {children}
        </MapLoadingShell>
      }
    >
      <MapLibreMap
        {...mapProps}
        ariaLabel={ariaLabel}
        points={points}
        styleUrl={config.styleUrl}
        onStatusChange={onStatusChange}
      >
        {children}
      </MapLibreMap>
    </Suspense>
  );
}

function MapLoadingShell({
  ariaLabel,
  children,
  onStatusChange,
}: Pick<PlatformMapProps, 'ariaLabel' | 'children' | 'onStatusChange'>) {
  useMapStatusNotification('loading', onStatusChange);

  return (
    <div aria-busy="true" aria-label={ariaLabel} className="platform-map-shell" data-map-status="loading" role={ariaLabel ? 'region' : undefined}>
      <div className="map-loading" role="status">
        Загрузка карты
      </div>
      <div className="platform-map-overlay-root">{children}</div>
    </div>
  );
}

function MapFallbackShell({
  ariaLabel,
  children,
  fallback,
  onStatusChange,
  status,
}: Pick<PlatformMapProps, 'ariaLabel' | 'children' | 'onStatusChange'> & {
  fallback: MapFallbackState;
  status: Extract<MapStatus, 'disabled' | 'error'>;
}) {
  useMapStatusNotification(status, onStatusChange);

  return (
    <div aria-label={ariaLabel} className="platform-map-shell" data-map-status={status} role={ariaLabel ? 'region' : undefined}>
      <MapFallbackContent fallback={fallback} overlay />
      <div className="platform-map-overlay-root">{children}</div>
    </div>
  );
}

function MapFallback({
  ariaLabel,
  fallback,
  onStatusChange,
  status,
}: Pick<PlatformMapProps, 'ariaLabel' | 'onStatusChange'> & {
  fallback: MapFallbackState;
  status: Extract<MapStatus, 'empty'>;
}) {
  useMapStatusNotification(status, onStatusChange);

  return (
    <div aria-label={ariaLabel} className="map-fallback" data-map-status={status} role={ariaLabel ? 'region' : undefined}>
      <MapFallbackContent fallback={fallback} />
    </div>
  );
}

function MapFallbackContent({ fallback, overlay = false }: { fallback: MapFallbackState; overlay?: boolean }) {
  const content: ReactNode = (
    <>
      <p className="eyebrow">{fallback.eyebrow}</p>
      <h2>{fallback.title}</h2>
      <p className="muted-text">{fallback.description}</p>
    </>
  );

  return overlay ? <div className="map-fallback map-fallback--overlay">{content}</div> : content;
}

function useMapStatusNotification(status: MapStatus, onStatusChange: PlatformMapProps['onStatusChange']) {
  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);
}

export type {
  MapBounds,
  MapCoordinate,
  MapFallbackState,
  MapNearbyTransitResult,
  MapNearbyTransitStation,
  MapPoint,
  MapStatus,
  MapViewport,
  PlatformMapProps,
} from './mapTypes';
