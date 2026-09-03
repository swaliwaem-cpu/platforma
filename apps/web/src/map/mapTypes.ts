import type { ReactNode } from 'react';

export type MapCoordinate = [latitude: number, longitude: number];

export type MapBounds = [southWest: MapCoordinate, northEast: MapCoordinate];

export type MapViewport = {
  center: MapCoordinate;
  zoom: number;
};

export type MapControlsPosition = 'top-left' | 'top-right';

export type MapPoint = {
  id: string;
  title: string;
  coordinates: MapCoordinate;
  hint: string;
  popupHtml?: string;
  markerLabel?: string;
  variant?: 'DEFAULT' | 'ANCHOR' | 'PRIMARY' | 'ALTERNATIVE';
};

export type MapGeometry = {
  id: string;
  geometry:
    | { type: 'Point'; coordinates: [longitude: number, latitude: number] }
    | { type: 'LineString'; coordinates: [longitude: number, latitude: number][] }
    | { type: 'MultiLineString'; coordinates: [longitude: number, latitude: number][][] }
    | { type: 'Polygon'; coordinates: [longitude: number, latitude: number][][] }
    | { type: 'MultiPolygon'; coordinates: [longitude: number, latitude: number][][][] };
  variant: 'REFERENCE' | 'SEARCH_AREA';
};

export type MapFallbackState = {
  eyebrow: string;
  title: string;
  description: string;
};

export type MapNearbyTransitStation = {
  name: string;
  coordinates: MapCoordinate;
  distanceMeters: number;
};

export type MapNearbyTransitResult = {
  pointId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  stations: MapNearbyTransitStation[];
};

export type MapStatus = 'loading' | 'ready' | 'error' | 'disabled' | 'empty';

export type PlatformMapProps = {
  ariaLabel?: string;
  children?: ReactNode;
  emptyState?: MapFallbackState;
  controlsPosition?: MapControlsPosition;
  enableFullscreen?: boolean;
  enableMeasurement?: boolean;
  initialViewport?: MapViewport;
  points: MapPoint[];
  geometries?: MapGeometry[];
  renderWithoutPoints?: boolean;
  selectedPointId?: string | null;
  onBoundsChange?: (bounds: MapBounds) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  onMapClick?: (coordinate: MapCoordinate) => void;
  onNearbyTransitChange?: (result: MapNearbyTransitResult) => void;
  onOpenPoint?: (point: MapPoint) => void;
  onSelectPoint?: (point: MapPoint) => void;
  onStatusChange?: (status: MapStatus) => void;
  onViewportChange?: (viewport: MapViewport) => void;
};
