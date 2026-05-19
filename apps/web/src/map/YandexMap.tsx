import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type YandexMapPoint = {
  id: string;
  title: string;
  coordinates: [number, number];
  hint: string;
  balloonHtml: string;
  markerLabel?: string;
};

export type YandexMapBounds = [[number, number], [number, number]];

type YandexMapViewport = {
  center: [number, number];
  zoom: number;
};

type YandexMapFallbackState = {
  eyebrow: string;
  title: string;
  description: string;
};

type YandexMapProps = {
  children?: ReactNode;
  points: YandexMapPoint[];
  emptyState?: YandexMapFallbackState;
  selectedPointId?: string | null;
  onBoundsChange?: (bounds: YandexMapBounds) => void;
  onOpenPoint?: (point: YandexMapPoint) => void;
  onSelectPoint?: (point: YandexMapPoint) => void;
};

type YandexGeoObject = unknown;

type YandexPlacemark = {
  events: {
    add: (eventName: string, handler: (event?: unknown) => void) => void;
  };
};

type YandexEventManager = {
  add: (eventName: string, handler: () => void) => void;
  remove: (eventName: string, handler: () => void) => void;
};

type YandexMapInstance = {
  events: YandexEventManager;
  container: {
    events: YandexEventManager;
    fitToViewport: (preservePixelPosition?: boolean) => void;
    getElement: () => HTMLElement;
  };
  geoObjects: {
    add: (object: YandexGeoObject) => void;
  };
  getBounds: () => number[][] | null;
  getCenter: () => number[] | null;
  getZoom: () => number;
  setBounds: (bounds: number[][], options?: Record<string, unknown>) => void;
  setCenter: (center: [number, number], zoom?: number, options?: Record<string, unknown>) => void;
  destroy: () => void;
};

type YandexMapsApi = {
  ready: (callback: () => void) => void;
  Map: new (
    element: HTMLElement,
    state: { center: [number, number]; zoom: number; controls?: string[]; behaviors?: string[] },
    options?: Record<string, unknown>,
  ) => YandexMapInstance;
  Placemark: new (
    coordinates: [number, number],
    properties: Record<string, string>,
    options?: Record<string, unknown>,
  ) => YandexPlacemark;
  templateLayoutFactory: {
    createClass: (template: string) => unknown;
  };
};

declare global {
  interface Window {
    platformaYandexMapsPromise?: Promise<YandexMapsApi>;
    ymaps?: YandexMapsApi;
  }
}

const yandexMapsScriptId = 'platforma-yandex-maps-js-api';
const expandedMarkerZoom = 14;
const defaultEmptyState: YandexMapFallbackState = {
  eyebrow: 'Яндекс.Карта',
  title: 'Нет объектов с координатами',
  description: 'Для отображения на карте у объекта должны быть широта и долгота.',
};

export function YandexMap({
  children,
  emptyState = defaultEmptyState,
  points,
  selectedPointId = null,
  onBoundsChange,
  onOpenPoint,
  onSelectPoint,
}: YandexMapProps) {
  const apiKey = (import.meta.env.VITE_YANDEX_MAPS_API_KEY ?? '').trim();

  if (points.length === 0) {
    return (
      <div className="map-fallback">
        <p className="eyebrow">{emptyState.eyebrow}</p>
        <h2>{emptyState.title}</h2>
        <p className="muted-text">{emptyState.description}</p>
      </div>
    );
  }

  return (
    <YandexMapApi
      apiKey={apiKey}
      points={points}
      selectedPointId={selectedPointId}
      onBoundsChange={onBoundsChange}
      onOpenPoint={onOpenPoint}
      onSelectPoint={onSelectPoint}
    >
      {children}
    </YandexMapApi>
  );
}

function YandexMapApi({
  apiKey,
  children,
  points,
  selectedPointId,
  onBoundsChange,
  onOpenPoint,
  onSelectPoint,
}: {
  apiKey: string;
  children?: ReactNode;
  points: YandexMapPoint[];
  selectedPointId: string | null;
  onBoundsChange?: (bounds: YandexMapBounds) => void;
  onOpenPoint?: (point: YandexMapPoint) => void;
  onSelectPoint?: (point: YandexMapPoint) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);
  const center = useMemo(() => getMapCenter(points), [points]);
  const pointsById = useMemo(() => new Map(points.map((point) => [point.id, point])), [points]);
  const handlePointClick = onSelectPoint ?? onOpenPoint;

  useEffect(() => {
    const container = containerRef.current;
    const handleOpenPoint = handlePointClick;

    if (!container || !handleOpenPoint) {
      return;
    }

    const handleMapClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const trigger = event.target.closest<HTMLElement>('[data-map-point-id]');
      const pointId = trigger?.dataset.mapPointId;

      if (!pointId) {
        return;
      }

      const point = pointsById.get(pointId);

      if (!point) {
        return;
      }

      event.preventDefault();
      handleOpenPoint(point);
    };

    container.addEventListener('click', handleMapClick);

    return () => container.removeEventListener('click', handleMapClick);
  }, [handlePointClick, pointsById]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    container.querySelectorAll<HTMLElement>('[data-yandex-point-id]').forEach((marker) => {
      const isSelected = Boolean(selectedPointId) && marker.dataset.yandexPointId === selectedPointId;

      marker.classList.toggle('map-price-marker--selected', isSelected);
    });
  }, [points, selectedPointId, status]);

  useEffect(() => {
    if (points.length === 0 || !containerRef.current) {
      return;
    }

    let isCancelled = false;
    let map: YandexMapInstance | null = null;
    let handleBoundsChange: (() => void) | null = null;
    let handleFullscreenEnter: (() => void) | null = null;
    let handleFullscreenExit: (() => void) | null = null;
    let viewportBeforeFullscreen: YandexMapViewport | null = null;
    let yandexMapContainer: HTMLElement | null = null;
    let yandexMapElement: HTMLElement | null = null;
    let nextOverlayRoot: HTMLElement | null = null;
    let resizeFrameId: number | null = null;

    setStatus('loading');
    setOverlayRoot(null);

    void loadYandexMaps(apiKey)
      .then((ymaps) => {
        if (isCancelled || !containerRef.current) {
          return;
        }

        const mapContainer = containerRef.current;

        yandexMapContainer = mapContainer;

        const nextMap = new ymaps.Map(
          mapContainer,
          {
            center,
            zoom: points.length > 1 ? 11 : 15,
            controls: ['zoomControl', 'fullscreenControl'],
            behaviors: ['drag', 'scrollZoom', 'dblClickZoom', 'multiTouch'],
          },
          {
            suppressMapOpenBlock: true,
          },
        );
        map = nextMap;

        const mapElement = nextMap.container.getElement();
        yandexMapElement = mapElement;

        nextOverlayRoot = document.createElement('div');
        nextOverlayRoot.className = 'yandex-map-overlay-root';
        mapElement.appendChild(nextOverlayRoot);
        setOverlayRoot(nextOverlayRoot);

        const markerLayout = ymaps.templateLayoutFactory.createClass(
          [
            '<div class="map-price-marker-anchor">',
            '<button class="map-price-marker" type="button"',
            ' data-map-point-id="$[properties.pointId]"',
            ' data-yandex-point-id="$[properties.pointId]"',
            ' aria-label="$[properties.hintContent]">',
            '</button>',
            '<span class="map-price-marker-label" aria-hidden="true">',
            '<span>$[properties.markerLabel]</span>',
            '</span>',
            '</div>',
          ].join(''),
        );
        const placemarks = points.map((point) => {
          const placemark = new ymaps.Placemark(
            point.coordinates,
            {
              balloonContent: point.balloonHtml,
              hintContent: point.hint,
              markerLabel: point.markerLabel ?? point.title,
              pointId: point.id,
            },
            {
              iconLayout: markerLayout,
              iconOffset: [-18, -18],
              iconShape: {
                type: 'Circle',
                coordinates: [18, 18],
                radius: 18,
              },
              openBalloonOnClick: false,
            },
          );

          placemark.events.add('click', () => {
            handlePointClick?.(point);
          });

          return placemark;
        });

        placemarks.forEach((placemark) => nextMap.geoObjects.add(placemark));

        const notifyBoundsChange = () => {
          if (!onBoundsChange) {
            return;
          }

          const nextBounds = normalizeYandexBounds(nextMap.getBounds());

          if (nextBounds) {
            onBoundsChange(nextBounds);
          }
        };
        const syncMarkerExpansion = () => {
          const shouldExpandMarkers = nextMap.getZoom() >= expandedMarkerZoom;

          mapContainer.classList.toggle('yandex-map--markers-expanded', shouldExpandMarkers);
          yandexMapElement?.classList.toggle('yandex-map--markers-expanded', shouldExpandMarkers);
        };
        handleBoundsChange = () => {
          syncMarkerExpansion();
          notifyBoundsChange();
        };
        const scheduleViewportUpdate = (viewportToRestore: YandexMapViewport | null) => {
          if (resizeFrameId !== null) {
            window.cancelAnimationFrame(resizeFrameId);
          }

          resizeFrameId = window.requestAnimationFrame(() => {
            resizeFrameId = null;

            nextMap.container.fitToViewport();

            if (viewportToRestore) {
              restoreMapViewport(nextMap, viewportToRestore);
            }

            handleBoundsChange?.();
          });
        };
        handleFullscreenEnter = () => {
          viewportBeforeFullscreen = getCurrentMapViewport(nextMap);
          scheduleViewportUpdate(viewportBeforeFullscreen);
        };
        handleFullscreenExit = () => {
          const viewportToRestore = getCurrentMapViewport(nextMap) ?? viewportBeforeFullscreen;

          viewportBeforeFullscreen = null;
          scheduleViewportUpdate(viewportToRestore);
        };

        nextMap.events.add('boundschange', handleBoundsChange);
        nextMap.container.events.add('fullscreenenter', handleFullscreenEnter);
        nextMap.container.events.add('fullscreenexit', handleFullscreenExit);

        const bounds = getPointsBounds(points);

        if (bounds && points.length > 1) {
          nextMap.setBounds(bounds, {
            checkZoomRange: true,
            zoomMargin: 48,
          });
        }

        handleBoundsChange();
        setStatus('ready');
      })
      .catch(() => {
        if (!isCancelled) {
          setStatus('error');
        }
      });

    return () => {
      isCancelled = true;

      if (map) {
        if (handleBoundsChange) {
          map.events.remove('boundschange', handleBoundsChange);
        }

        if (handleFullscreenEnter) {
          map.container.events.remove('fullscreenenter', handleFullscreenEnter);
        }

        if (handleFullscreenExit) {
          map.container.events.remove('fullscreenexit', handleFullscreenExit);
        }

        if (resizeFrameId !== null) {
          window.cancelAnimationFrame(resizeFrameId);
        }

        if (nextOverlayRoot) {
          nextOverlayRoot.remove();
        }

        yandexMapContainer?.classList.remove('yandex-map--markers-expanded');
        yandexMapElement?.classList.remove('yandex-map--markers-expanded');
        setOverlayRoot(null);
        map.destroy();
      }
    };
  }, [apiKey, center, handlePointClick, onBoundsChange, points]);

  return (
    <div className="yandex-map-shell">
      {status === 'loading' ? <div className="map-loading">Загрузка карты</div> : null}
      {status === 'error' ? (
        <div className="map-fallback map-fallback--overlay">
          <p className="eyebrow">Яндекс.Карта</p>
          <h2>Карта не загрузилась</h2>
          <p className="muted-text">Проверьте доступность Yandex Maps JS API.</p>
        </div>
      ) : null}
      <div ref={containerRef} className="yandex-map" />
      {overlayRoot ? createPortal(children, overlayRoot) : null}
    </div>
  );
}

function loadYandexMaps(apiKey: string) {
  if (window.ymaps) {
    return waitForYandexReady(window.ymaps);
  }

  if (window.platformaYandexMapsPromise) {
    return window.platformaYandexMapsPromise;
  }

  window.platformaYandexMapsPromise = new Promise<YandexMapsApi>((resolve, reject) => {
    const existingScript = document.getElementById(yandexMapsScriptId) as HTMLScriptElement | null;

    function handleLoad() {
      if (!window.ymaps) {
        reject(new Error('Yandex Maps API is unavailable'));
        return;
      }

      void waitForYandexReady(window.ymaps).then(resolve, reject);
    }

    function handleError() {
      window.platformaYandexMapsPromise = undefined;
      reject(new Error('Yandex Maps API script failed'));
    }

    if (existingScript) {
      existingScript.addEventListener('load', handleLoad, { once: true });
      existingScript.addEventListener('error', handleError, { once: true });
      return;
    }

    const script = document.createElement('script');
    const params = new URLSearchParams({ lang: 'ru_RU' });

    if (apiKey) {
      params.set('apikey', apiKey);
    }

    script.id = yandexMapsScriptId;
    script.async = true;
    script.src = `https://api-maps.yandex.ru/2.1/?${params.toString()}`;
    script.type = 'text/javascript';
    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });

    document.head.appendChild(script);
  });

  return window.platformaYandexMapsPromise;
}

function waitForYandexReady(ymaps: YandexMapsApi) {
  return new Promise<YandexMapsApi>((resolve) => {
    ymaps.ready(() => resolve(ymaps));
  });
}

function getMapCenter(points: YandexMapPoint[]): [number, number] {
  if (points.length === 0) {
    return [55.751574, 37.573856];
  }

  const totals = points.reduce(
    (result, point) => ({
      latitude: result.latitude + point.coordinates[0],
      longitude: result.longitude + point.coordinates[1],
    }),
    {
      latitude: 0,
      longitude: 0,
    },
  );

  return [totals.latitude / points.length, totals.longitude / points.length];
}

function getPointsBounds(points: YandexMapPoint[]) {
  if (points.length === 0) {
    return null;
  }

  const latitudes = points.map((point) => point.coordinates[0]);
  const longitudes = points.map((point) => point.coordinates[1]);

  return [
    [Math.min(...latitudes), Math.min(...longitudes)],
    [Math.max(...latitudes), Math.max(...longitudes)],
  ];
}

function normalizeYandexBounds(bounds: number[][] | null): YandexMapBounds | null {
  const firstPoint = bounds?.[0];
  const secondPoint = bounds?.[1];

  if (!firstPoint || !secondPoint) {
    return null;
  }

  const firstLatitude = firstPoint[0];
  const firstLongitude = firstPoint[1];
  const secondLatitude = secondPoint[0];
  const secondLongitude = secondPoint[1];

  if (
    typeof firstLatitude !== 'number' ||
    typeof firstLongitude !== 'number' ||
    typeof secondLatitude !== 'number' ||
    typeof secondLongitude !== 'number' ||
    !Number.isFinite(firstLatitude) ||
    !Number.isFinite(firstLongitude) ||
    !Number.isFinite(secondLatitude) ||
    !Number.isFinite(secondLongitude)
  ) {
    return null;
  }

  return [
    [firstLatitude, firstLongitude],
    [secondLatitude, secondLongitude],
  ];
}

function getCurrentMapViewport(map: YandexMapInstance): YandexMapViewport | null {
  const center = normalizeYandexCenter(map.getCenter());
  const zoom = map.getZoom();

  if (!center || !Number.isFinite(zoom)) {
    return null;
  }

  return { center, zoom };
}

function restoreMapViewport(map: YandexMapInstance, viewport: YandexMapViewport) {
  map.setCenter(viewport.center, viewport.zoom, {
    checkZoomRange: true,
  });
}

function normalizeYandexCenter(center: number[] | null): [number, number] | null {
  const latitude = center?.[0];
  const longitude = center?.[1];

  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  return [latitude, longitude];
}
