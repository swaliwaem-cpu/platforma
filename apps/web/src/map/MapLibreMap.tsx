import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { getMapPointBounds, getMapPointCenter, isValidMapCoordinatePair } from './mapContract';
import type { MapBounds, MapPoint, MapStatus, MapViewport, PlatformMapProps } from './mapTypes';

type MapLibreMapProps = Omit<PlatformMapProps, 'emptyState' | 'renderWithoutPoints'> & {
  styleUrl: string;
};

type MarkerRecord = {
  marker: maplibregl.Marker;
  pointSignature: string;
  removeClickListener: () => void;
};

type MapCallbacks = Pick<
  PlatformMapProps,
  'onBoundsChange' | 'onFullscreenChange' | 'onOpenPoint' | 'onSelectPoint' | 'onStatusChange' | 'onViewportChange'
>;

const providerErrorState = {
  eyebrow: 'Карта',
  title: 'Карта временно недоступна',
  description: 'Не удалось загрузить картографическую подложку. Данные объектов и рабочие ссылки остаются доступны.',
};

export default function MapLibreMap({
  ariaLabel,
  children,
  enableFullscreen = true,
  initialViewport,
  points,
  selectedPointId = null,
  styleUrl,
  onBoundsChange,
  onFullscreenChange,
  onOpenPoint,
  onSelectPoint,
  onStatusChange,
  onViewportChange,
}: MapLibreMapProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef(new Map<string, MarkerRecord>());
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pointsByIdRef = useRef(new Map<string, MapPoint>());
  const callbacksRef = useRef<MapCallbacks>({});
  const initialViewportRef = useRef<MapViewport>(initialViewport ?? createInitialViewport(points));
  const [status, setStatus] = useState<MapStatus>('loading');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pointCoordinatesKey = useMemo(
    () => points.map((point) => `${point.id}:${point.coordinates[0]}:${point.coordinates[1]}`).join('|'),
    [points],
  );
  const prefersReducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  pointsByIdRef.current = new Map(points.map((point) => [point.id, point]));
  callbacksRef.current = {
    onBoundsChange,
    onFullscreenChange,
    onOpenPoint,
    onSelectPoint,
    onStatusChange,
    onViewportChange,
  };

  useEffect(() => {
    const container = containerRef.current;
    const shell = shellRef.current;

    if (!container || !shell) {
      return;
    }

    let isDisposed = false;
    let fullscreenControl: maplibregl.FullscreenControl | null = null;
    let resizeFrameId: number | null = null;
    const initial = initialViewportRef.current;
    let map: maplibregl.Map;

    try {
      map = new maplibregl.Map({
        attributionControl: false,
        center: toMapLibreCoordinate(initial.center),
        container,
        doubleClickZoom: true,
        dragPan: true,
        dragRotate: false,
        fadeDuration: prefersReducedMotion ? 0 : 300,
        keyboard: true,
        locale: {
          'AttributionControl.ToggleAttribution': 'Показать источники карты',
          'AttributionControl.MapFeedback': 'Сообщить об ошибке карты',
          'FullscreenControl.Enter': 'Открыть карту на весь экран',
          'FullscreenControl.Exit': 'Закрыть полноэкранную карту',
          'NavigationControl.ResetBearing': 'Сбросить направление карты',
          'NavigationControl.ZoomIn': 'Увеличить масштаб',
          'NavigationControl.ZoomOut': 'Уменьшить масштаб',
        },
        maxPitch: 0,
        pitchWithRotate: false,
        scrollZoom: true,
        style: styleUrl,
        touchZoomRotate: true,
        zoom: initial.zoom,
      });
    } catch {
      setStatus('error');
      callbacksRef.current.onStatusChange?.('error');
      return;
    }

    mapRef.current = map;
    setStatus('loading');
    callbacksRef.current.onStatusChange?.('loading');

    map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
      }),
      'bottom-right',
    );

    const scheduleResize = () => {
      if (resizeFrameId !== null) {
        window.cancelAnimationFrame(resizeFrameId);
      }

      resizeFrameId = window.requestAnimationFrame(() => {
        resizeFrameId = null;
        map.resize();
        notifyMapPosition(map, callbacksRef.current);
      });
    };
    const handleFullscreenStart = () => {
      setIsFullscreen(true);
      callbacksRef.current.onFullscreenChange?.(true);
      scheduleResize();
    };
    const handleFullscreenEnd = () => {
      setIsFullscreen(false);
      callbacksRef.current.onFullscreenChange?.(false);
      scheduleResize();
    };

    if (enableFullscreen) {
      fullscreenControl = new maplibregl.FullscreenControl({ container: shell });
      fullscreenControl.on('fullscreenstart', handleFullscreenStart);
      fullscreenControl.on('fullscreenend', handleFullscreenEnd);
      map.addControl(fullscreenControl, 'top-right');
    }

    const handleLoad = () => {
      if (isDisposed) {
        return;
      }

      setStatus('ready');
      callbacksRef.current.onStatusChange?.('ready');
      notifyMapPosition(map, callbacksRef.current);
    };
    const handleError = () => {
      if (isDisposed) {
        return;
      }

      setStatus('error');
      callbacksRef.current.onStatusChange?.('error');
    };
    const handleMoveEnd = () => notifyMapPosition(map, callbacksRef.current);
    const handleZoom = () => {
      shell.classList.toggle('platform-map--markers-expanded', map.getZoom() >= 14);
    };

    map.on('load', handleLoad);
    map.on('error', handleError);
    map.on('moveend', handleMoveEnd);
    map.on('zoom', handleZoom);
    handleZoom();

    return () => {
      isDisposed = true;

      if (resizeFrameId !== null) {
        window.cancelAnimationFrame(resizeFrameId);
      }

      if (fullscreenControl) {
        fullscreenControl.off('fullscreenstart', handleFullscreenStart);
        fullscreenControl.off('fullscreenend', handleFullscreenEnd);
      }

      popupRef.current?.remove();
      popupRef.current = null;
      removeAllMarkers(markersRef.current);
      map.remove();
      mapRef.current = null;
      shell.classList.remove('platform-map--markers-expanded');
    };
  }, [enableFullscreen, prefersReducedMotion, styleUrl]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    syncMarkers({
      callbacksRef,
      map,
      markers: markersRef.current,
      points,
      pointsByIdRef,
      popupRef,
      selectedPointId,
    });
  }, [points, selectedPointId]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || status !== 'ready') {
      return;
    }

    fitMapToPoints(map, points, prefersReducedMotion);
  }, [pointCoordinatesKey, points, prefersReducedMotion, status]);

  return (
    <div
      ref={shellRef}
      aria-busy={status === 'loading'}
      aria-label={ariaLabel}
      className="platform-map-shell"
      data-map-fullscreen={isFullscreen ? 'true' : 'false'}
      data-map-status={status}
      role={ariaLabel ? 'region' : undefined}
    >
      {status === 'loading' ? (
        <div className="map-loading" role="status">
          Загрузка карты
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="map-fallback map-fallback--overlay" role="status">
          <p className="eyebrow">{providerErrorState.eyebrow}</p>
          <h2>{providerErrorState.title}</h2>
          <p className="muted-text">{providerErrorState.description}</p>
        </div>
      ) : null}
      <div ref={containerRef} className="platform-map-canvas" />
      <div className="platform-map-overlay-root">{children}</div>
    </div>
  );
}

function syncMarkers({
  callbacksRef,
  map,
  markers,
  points,
  pointsByIdRef,
  popupRef,
  selectedPointId,
}: {
  callbacksRef: MutableRefObject<MapCallbacks>;
  map: maplibregl.Map;
  markers: Map<string, MarkerRecord>;
  points: MapPoint[];
  pointsByIdRef: MutableRefObject<Map<string, MapPoint>>;
  popupRef: MutableRefObject<maplibregl.Popup | null>;
  selectedPointId: string | null;
}) {
  const validPoints = points.filter((point) => isValidMapCoordinatePair(point.coordinates[0], point.coordinates[1]));
  const nextPointIds = new Set(validPoints.map((point) => point.id));

  for (const [pointId, record] of markers) {
    if (!nextPointIds.has(pointId)) {
      record.removeClickListener();
      record.marker.remove();
      markers.delete(pointId);
    }
  }

  for (const point of validPoints) {
    const pointSignature = createPointSignature(point);
    let record = markers.get(point.id);

    if (record && record.pointSignature !== pointSignature) {
      record.removeClickListener();
      record.marker.remove();
      markers.delete(point.id);
      record = undefined;
    }

    if (!record) {
      const element = createMarkerElement(point);
      const handleClick = () => {
        const currentPoint = pointsByIdRef.current.get(point.id);

        if (!currentPoint) {
          return;
        }

        if (callbacksRef.current.onSelectPoint) {
          callbacksRef.current.onSelectPoint(currentPoint);
          return;
        }

        if (callbacksRef.current.onOpenPoint) {
          callbacksRef.current.onOpenPoint(currentPoint);
          return;
        }

        if (currentPoint.popupHtml) {
          popupRef.current?.remove();
          popupRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '320px', offset: 34 })
            .setLngLat(toMapLibreCoordinate(currentPoint.coordinates))
            .setHTML(currentPoint.popupHtml)
            .addTo(map);
        }
      };

      element.addEventListener('click', handleClick);
      const marker = new maplibregl.Marker({ anchor: 'bottom', element })
        .setLngLat(toMapLibreCoordinate(point.coordinates))
        .addTo(map);

      record = {
        marker,
        pointSignature,
        removeClickListener: () => element.removeEventListener('click', handleClick),
      };
      markers.set(point.id, record);
    }

    const element = record.marker.getElement();
    const isSelected = Boolean(selectedPointId) && selectedPointId === point.id;

    element.classList.toggle('map-price-marker--selected', isSelected);
    element.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  }
}

function createMarkerElement(point: MapPoint) {
  const element = document.createElement('button');
  const dot = document.createElement('span');
  const pin = document.createElement('span');
  const label = document.createElement('span');

  element.type = 'button';
  element.className = 'map-price-marker';
  element.dataset.mapPointId = point.id;
  element.setAttribute('aria-label', point.hint);
  element.setAttribute('aria-pressed', 'false');

  dot.className = 'map-price-marker-dot';
  dot.setAttribute('aria-hidden', 'true');
  pin.className = 'map-price-marker-pin';
  pin.setAttribute('aria-hidden', 'true');
  label.className = 'map-price-marker-pin-label';
  label.textContent = point.markerLabel ?? point.title;

  pin.appendChild(label);
  element.append(dot, pin);

  return element;
}

function fitMapToPoints(map: maplibregl.Map, points: MapPoint[], prefersReducedMotion: boolean) {
  const validPoints = points.filter((point) => isValidMapCoordinatePair(point.coordinates[0], point.coordinates[1]));
  const duration = prefersReducedMotion ? 0 : 300;

  if (validPoints.length === 0) {
    return;
  }

  if (validPoints.length === 1) {
    const [point] = validPoints;

    if (point) {
      map.easeTo({ center: toMapLibreCoordinate(point.coordinates), duration, zoom: 15 });
    }

    return;
  }

  const bounds = getMapPointBounds(validPoints);

  if (!bounds) {
    return;
  }

  map.fitBounds([toMapLibreCoordinate(bounds[0]), toMapLibreCoordinate(bounds[1])], {
    duration,
    linear: true,
    maxZoom: 15,
    padding: 48,
  });
}

function notifyMapPosition(map: maplibregl.Map, callbacks: MapCallbacks) {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const normalizedBounds: MapBounds = [
    [bounds.getSouth(), bounds.getWest()],
    [bounds.getNorth(), bounds.getEast()],
  ];
  const viewport: MapViewport = {
    center: [center.lat, center.lng],
    zoom: map.getZoom(),
  };

  callbacks.onBoundsChange?.(normalizedBounds);
  callbacks.onViewportChange?.(viewport);
}

function createInitialViewport(points: MapPoint[]): MapViewport {
  return {
    center: getMapPointCenter(points),
    zoom: points.length > 1 ? 11 : 15,
  };
}

function createPointSignature(point: MapPoint) {
  return [
    point.coordinates[0],
    point.coordinates[1],
    point.hint,
    point.markerLabel ?? '',
    point.popupHtml ?? '',
    point.title,
  ].join('|');
}

function toMapLibreCoordinate([latitude, longitude]: [number, number]): [number, number] {
  return [longitude, latitude];
}

function removeAllMarkers(markers: Map<string, MarkerRecord>) {
  for (const record of markers.values()) {
    record.removeClickListener();
    record.marker.remove();
  }

  markers.clear();
}
