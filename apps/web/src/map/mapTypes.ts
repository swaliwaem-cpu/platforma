import type { ReactNode } from 'react';

export type MapCoordinate = [latitude: number, longitude: number];

export type MapBounds = [southWest: MapCoordinate, northEast: MapCoordinate];

export type MapViewport = {
  center: MapCoordinate;
  zoom: number;
};

export type MapPoint = {
  id: string;
  title: string;
  coordinates: MapCoordinate;
  hint: string;
  popupHtml?: string;
  markerLabel?: string;
  variant?: 'DEFAULT' | 'ANCHOR' | 'PRIMARY' | 'ALTERNATIVE';
};

export type MapPolygon = {
  id: string;
  coordinates: [longitude: number, latitude: number][][];
  variant?: 'RADIUS';
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
  enableFullscreen?: boolean;
  enableMeasurement?: boolean;
  initialViewport?: MapViewport;
  points: MapPoint[];
  polygons?: MapPolygon[];
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
