import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import {
  formatMapDistance,
  getMapPathDistanceMeters,
  getMapPointBounds,
  getMapPointCenter,
  isValidMapCoordinatePair,
} from './mapContract';
import {
  enhanceOpenMapTilesStyle,
  findNearestSubwayStations,
  hasOpenMapTilesPoiSource,
  NEARBY_TRANSIT_SEARCH_ZOOM,
} from './openMapTilesEnhancements';
import type { MapBounds, MapCoordinate, MapPoint, MapPolygon, MapStatus, MapViewport, PlatformMapProps } from './mapTypes';

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
  | 'onBoundsChange'
  | 'onFullscreenChange'
  | 'onMapClick'
  | 'onNearbyTransitChange'
  | 'onOpenPoint'
  | 'onSelectPoint'
  | 'onStatusChange'
  | 'onViewportChange'
>;

const MAP_LOAD_TIMEOUT_MS = 15_000;
const NEARBY_TRANSIT_LOOKUP_TIMEOUT_MS = 4_000;
const MEASUREMENT_SOURCE_ID = 'platforma-measurement';
const MEASUREMENT_LINE_LAYER_ID = 'platforma-measurement-line';
const MEASUREMENT_POINT_LAYER_ID = 'platforma-measurement-points';
const ASSISTANT_GEO_SOURCE_ID = 'platforma-assistant-geo-polygons';
const ASSISTANT_GEO_FILL_LAYER_ID = 'platforma-assistant-geo-fill';
const ASSISTANT_GEO_LINE_LAYER_ID = 'platforma-assistant-geo-line';

const providerErrorState = {
  eyebrow: 'Карта',
  title: 'Карта временно недоступна',
  description: 'Не удалось загрузить картографическую подложку. Данные объектов и рабочие ссылки остаются доступны.',
};

maplibregl.setWorkerUrl(mapLibreWorkerUrl);

export default function MapLibreMap({
  ariaLabel,
  children,
  enableFullscreen = true,
  enableMeasurement = true,
  initialViewport,
  points,
  polygons = [],
  selectedPointId = null,
  styleUrl,
  onBoundsChange,
  onFullscreenChange,
  onMapClick,
  onNearbyTransitChange,
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
  const nearbyTransitRequestRef = useRef(0);
  const measurementActiveRef = useRef(false);
  const initialViewportRef = useRef<MapViewport>(initialViewport ?? createInitialViewport(points));
  const [status, setStatus] = useState<MapStatus>('loading');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMeasurementActive, setIsMeasurementActive] = useState(false);
  const [measurementPoints, setMeasurementPoints] = useState<MapCoordinate[]>([]);
  const pointCoordinatesKey = useMemo(
    () => points.map((point) => `${point.id}:${point.coordinates[0]}:${point.coordinates[1]}`).join('|'),
    [points],
  );
  const polygonCoordinatesKey = useMemo(
    () => polygons.map((polygon) => `${polygon.id}:${JSON.stringify(polygon.coordinates)}`).join('|'),
    [polygons],
  );
  const prefersReducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const measurementDistance = useMemo(() => getMapPathDistanceMeters(measurementPoints), [measurementPoints]);

  pointsByIdRef.current = new Map(points.map((point) => [point.id, point]));
  measurementActiveRef.current = isMeasurementActive;
  callbacksRef.current = {
    onBoundsChange,
    onFullscreenChange,
    onMapClick,
    onNearbyTransitChange,
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
    let loadTimeoutId: number | null = null;
    let resizeFrameId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
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
    resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(shell);
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

      if (loadTimeoutId !== null) {
        window.clearTimeout(loadTimeoutId);
        loadTimeoutId = null;
      }

      enhanceOpenMapTilesStyle(map);
      ensureMeasurementLayers(map);
      ensureAssistantGeoLayers(map);

      setStatus('ready');
      callbacksRef.current.onStatusChange?.('ready');
      notifyMapPosition(map, callbacksRef.current);
    };
    const handleError = () => {
      if (isDisposed) {
        return;
      }

      if (loadTimeoutId !== null) {
        window.clearTimeout(loadTimeoutId);
        loadTimeoutId = null;
      }

      setStatus('error');
      callbacksRef.current.onStatusChange?.('error');
    };
    const handleMoveEnd = () => notifyMapPosition(map, callbacksRef.current);
    const handleMapClick = (event: maplibregl.MapMouseEvent) => {
      if (enableMeasurement && measurementActiveRef.current) {
        setMeasurementPoints((currentPoints) => [...currentPoints, [event.lngLat.lat, event.lngLat.lng]]);
        return;
      }

      callbacksRef.current.onMapClick?.([event.lngLat.lat, event.lngLat.lng]);
    };
    const handleZoom = () => {
      shell.classList.toggle('platform-map--markers-expanded', map.getZoom() >= 14);
    };

    map.on('load', handleLoad);
    map.on('error', handleError);
    map.on('click', handleMapClick);
    map.on('moveend', handleMoveEnd);
    map.on('zoom', handleZoom);
    loadTimeoutId = window.setTimeout(handleError, MAP_LOAD_TIMEOUT_MS);
    handleZoom();

    return () => {
      isDisposed = true;

      if (resizeFrameId !== null) {
        window.cancelAnimationFrame(resizeFrameId);
      }
      resizeObserver?.disconnect();

      if (loadTimeoutId !== null) {
        window.clearTimeout(loadTimeoutId);
      }

      if (fullscreenControl) {
        fullscreenControl.off('fullscreenstart', handleFullscreenStart);
        fullscreenControl.off('fullscreenend', handleFullscreenEnd);
      }

      map.off('click', handleMapClick);

      popupRef.current?.remove();
      popupRef.current = null;
      removeAllMarkers(markersRef.current);
      map.remove();
      mapRef.current = null;
      shell.classList.remove('platform-map--markers-expanded');
      shell.classList.remove('platform-map--measuring');
    };
  }, [enableFullscreen, enableMeasurement, prefersReducedMotion, styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    const source = map.getSource(ASSISTANT_GEO_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) void source.setData(createPolygonGeoJson(polygons));
  }, [polygonCoordinatesKey, polygons, status]);

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

    fitMapToContent(map, points, polygons, prefersReducedMotion);
  }, [pointCoordinatesKey, points, polygonCoordinatesKey, polygons, prefersReducedMotion, status]);

  useEffect(() => {
    const map = mapRef.current;
    const shell = shellRef.current;

    if (!map || !shell || status !== 'ready') {
      return;
    }

    shell.classList.toggle('platform-map--measuring', isMeasurementActive);

    if (isMeasurementActive) {
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
    }

    return () => {
      shell.classList.remove('platform-map--measuring');
    };
  }, [isMeasurementActive, status]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || status !== 'ready') {
      return;
    }

    const source = map.getSource(MEASUREMENT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;

    if (source) {
      void source.setData(createMeasurementGeoJson(measurementPoints));
    }
  }, [measurementPoints, status]);

  useEffect(() => {
    if (!isMeasurementActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMeasurementActive(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMeasurementActive]);

  useEffect(() => {
    const map = mapRef.current;
    const point = selectedPointId ? pointsByIdRef.current.get(selectedPointId) : null;
    const requestId = nearbyTransitRequestRef.current + 1;

    nearbyTransitRequestRef.current = requestId;

    if (!point) {
      callbacksRef.current.onNearbyTransitChange?.({ pointId: null, status: 'idle', stations: [] });
      return;
    }

    if (!map || status !== 'ready') {
      callbacksRef.current.onNearbyTransitChange?.({
        pointId: point.id,
        status: status === 'error' ? 'unavailable' : 'loading',
        stations: [],
      });
      return;
    }

    callbacksRef.current.onNearbyTransitChange?.({ pointId: point.id, status: 'loading', stations: [] });
    map.easeTo({
      center: toMapLibreCoordinate(point.coordinates),
      duration: prefersReducedMotion ? 0 : 320,
      zoom: Math.max(map.getZoom(), NEARBY_TRANSIT_SEARCH_ZOOM),
    });

    let timeoutId: number | null = null;
    let isComplete = false;
    const finishLookup = () => {
      if (isComplete || nearbyTransitRequestRef.current !== requestId) {
        return;
      }

      isComplete = true;

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      const supportsNearbyTransit = hasOpenMapTilesPoiSource(map);
      const stations = supportsNearbyTransit ? findNearestSubwayStations(map, point.coordinates, 3) : [];

      callbacksRef.current.onNearbyTransitChange?.({
        pointId: point.id,
        status: supportsNearbyTransit && stations.length > 0 ? 'ready' : 'unavailable',
        stations,
      });
    };

    map.once('idle', finishLookup);
    timeoutId = window.setTimeout(finishLookup, NEARBY_TRANSIT_LOOKUP_TIMEOUT_MS);

    return () => {
      map.off('idle', finishLookup);

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [points, prefersReducedMotion, selectedPointId, status]);

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
      <div ref={containerRef} className="platform-map-canvas" data-map-surface />
      {enableMeasurement && status === 'ready' ? (
        <div className="map-measurement-tools" aria-label="Линейка расстояния">
          <button
            aria-label={isMeasurementActive ? 'Завершить измерение' : 'Измерить расстояние'}
            aria-pressed={isMeasurementActive}
            className="map-measurement-button"
            type="button"
            onClick={() => setIsMeasurementActive((isActive) => !isActive)}
          >
            {isMeasurementActive ? 'Готово' : measurementPoints.length > 0 ? 'Продолжить' : 'Линейка'}
          </button>
          {isMeasurementActive || measurementPoints.length > 0 ? (
            <output className="map-measurement-result" aria-live="polite">
              {measurementPoints.length === 0 ? (
                'Выберите начальную точку'
              ) : measurementPoints.length === 1 ? (
                'Выберите следующую точку'
              ) : (
                <span className="map-measurement-distance">{formatMapDistance(measurementDistance)}</span>
              )}
            </output>
          ) : null}
          {measurementPoints.length > 0 ? (
            <button
              aria-label="Очистить измерение"
              className="map-measurement-clear"
              type="button"
              onClick={() => setMeasurementPoints([])}
            >
              Очистить
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="platform-map-overlay-root">{children}</div>
    </div>
  );
}

function ensureMeasurementLayers(map: maplibregl.Map) {
  if (!map.getSource(MEASUREMENT_SOURCE_ID)) {
    map.addSource(MEASUREMENT_SOURCE_ID, {
      type: 'geojson',
      data: createMeasurementGeoJson([]),
    });
  }

  if (!map.getLayer(MEASUREMENT_LINE_LAYER_ID)) {
    map.addLayer({
      id: MEASUREMENT_LINE_LAYER_ID,
      type: 'line',
      source: MEASUREMENT_SOURCE_ID,
      paint: {
        'line-color': '#c8862f',
        'line-opacity': 0.95,
        'line-width': 4,
      },
    });
  }

  if (!map.getLayer(MEASUREMENT_POINT_LAYER_ID)) {
    map.addLayer({
      id: MEASUREMENT_POINT_LAYER_ID,
      type: 'circle',
      source: MEASUREMENT_SOURCE_ID,
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': 6,
        'circle-stroke-color': '#c8862f',
        'circle-stroke-width': 3,
      },
    });
  }
}

function ensureAssistantGeoLayers(map: maplibregl.Map) {
  if (!map.getSource(ASSISTANT_GEO_SOURCE_ID)) {
    map.addSource(ASSISTANT_GEO_SOURCE_ID, {
      type: 'geojson',
      data: createPolygonGeoJson([]),
    });
  }
  if (!map.getLayer(ASSISTANT_GEO_FILL_LAYER_ID)) {
    map.addLayer({
      id: ASSISTANT_GEO_FILL_LAYER_ID,
      type: 'fill',
      source: ASSISTANT_GEO_SOURCE_ID,
      paint: { 'fill-color': '#e85a18', 'fill-opacity': 0.12 },
    });
  }
  if (!map.getLayer(ASSISTANT_GEO_LINE_LAYER_ID)) {
    map.addLayer({
      id: ASSISTANT_GEO_LINE_LAYER_ID,
      type: 'line',
      source: ASSISTANT_GEO_SOURCE_ID,
      paint: { 'line-color': '#d84f12', 'line-opacity': 0.88, 'line-width': 2.5 },
    });
  }
}

function createPolygonGeoJson(polygons: MapPolygon[]) {
  return {
    type: 'FeatureCollection' as const,
    features: polygons.map((polygon) => ({
      type: 'Feature' as const,
      properties: { id: polygon.id, variant: polygon.variant ?? 'RADIUS' },
      geometry: { type: 'Polygon' as const, coordinates: polygon.coordinates },
    })),
  };
}

type MeasurementGeoJson = Exclude<Parameters<maplibregl.GeoJSONSource['setData']>[0], string>;

function createMeasurementGeoJson(points: MapCoordinate[]): MeasurementGeoJson {
  const coordinates = points.map(toMapLibreCoordinate);
  const features: Array<{
    type: 'Feature';
    properties: Record<string, number>;
    geometry:
      | { type: 'Point'; coordinates: [number, number] }
      | { type: 'LineString'; coordinates: [number, number][] };
  }> = points.map((point, index) => ({
    type: 'Feature',
    properties: { index },
    geometry: {
      type: 'Point',
      coordinates: toMapLibreCoordinate(point),
    },
  }));

  if (coordinates.length > 1) {
    features.unshift({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates,
      },
    });
  }

  return { type: 'FeatureCollection', features } as MeasurementGeoJson;
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
      const handleClick = (event: MouseEvent) => {
        event.stopPropagation();
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
          popupRef.current = new maplibregl.Popup({
            className: 'platform-map-popup',
            closeButton: true,
            closeOnClick: false,
            maxWidth: '320px',
            offset: 34,
          })
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
  element.className = `map-price-marker map-price-marker--${(point.variant ?? 'DEFAULT').toLocaleLowerCase('en-US')}`;
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
    padding: { top: 96, right: 48, bottom: 48, left: 120 },
  });
}

function fitMapToContent(
  map: maplibregl.Map,
  points: MapPoint[],
  polygons: MapPolygon[],
  prefersReducedMotion: boolean,
) {
  const polygonPoints: MapPoint[] = polygons.flatMap((polygon) => polygon.coordinates.flatMap((ring) => (
    ring.map(([longitude, latitude], index) => ({
      id: `${polygon.id}-${index}-${latitude}-${longitude}`,
      title: polygon.id,
      hint: polygon.id,
      coordinates: [latitude, longitude],
    }))
  )));
  fitMapToPoints(map, [...points, ...polygonPoints], prefersReducedMotion);
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
    point.variant ?? 'DEFAULT',
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
