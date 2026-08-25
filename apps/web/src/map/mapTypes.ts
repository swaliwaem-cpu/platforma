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
};

export type MapFallbackState = {
  eyebrow: string;
  title: string;
  description: string;
};

export type MapStatus = 'loading' | 'ready' | 'error' | 'disabled' | 'empty';

export type PlatformMapProps = {
  ariaLabel?: string;
  children?: ReactNode;
  emptyState?: MapFallbackState;
  enableFullscreen?: boolean;
  initialViewport?: MapViewport;
  points: MapPoint[];
  renderWithoutPoints?: boolean;
  selectedPointId?: string | null;
  onBoundsChange?: (bounds: MapBounds) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  onMapClick?: (coordinate: MapCoordinate) => void;
  onOpenPoint?: (point: MapPoint) => void;
  onSelectPoint?: (point: MapPoint) => void;
  onStatusChange?: (status: MapStatus) => void;
  onViewportChange?: (viewport: MapViewport) => void;
};
