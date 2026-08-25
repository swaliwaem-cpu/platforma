import type { MapBounds, MapCoordinate, MapPoint } from './mapTypes';

export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export type MapRuntimeConfigSource = {
  mapProviderEnabled?: boolean | string;
  mapStyleUrl?: string;
};

export type MapRuntimeConfig = {
  enabled: boolean;
  styleUrl: string;
};

export function resolveMapRuntimeConfig(environment: MapRuntimeConfigSource): MapRuntimeConfig {
  const rawEnabled = environment.mapProviderEnabled;
  const normalizedEnabled = typeof rawEnabled === 'string' ? rawEnabled.trim().toLowerCase() : rawEnabled;
  const enabled = !(
    normalizedEnabled === false ||
    normalizedEnabled === '0' ||
    normalizedEnabled === 'false' ||
    normalizedEnabled === 'off' ||
    normalizedEnabled === 'disabled'
  );
  const styleUrl = environment.mapStyleUrl?.trim() || DEFAULT_MAP_STYLE_URL;

  return { enabled, styleUrl };
}

export function isValidMapCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  return isValidMapCoordinate([latitude, longitude]);
}

export function getValidMapCoordinate(latitude: unknown, longitude: unknown): MapCoordinate | null {
  const coordinate: [unknown, unknown] = [latitude, longitude];

  return isValidMapCoordinate(coordinate) ? coordinate : null;
}

function isValidMapCoordinate(coordinate: [unknown, unknown]): coordinate is MapCoordinate {
  const [latitude, longitude] = coordinate;

  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function getMapPointBounds(points: Array<Pick<MapPoint, 'coordinates'>>): MapBounds | null {
  const validCoordinates = points
    .map((point) => point.coordinates)
    .filter((coordinates): coordinates is MapCoordinate => isValidMapCoordinatePair(coordinates[0], coordinates[1]));

  const [firstCoordinates, ...remainingCoordinates] = validCoordinates;

  if (!firstCoordinates) {
    return null;
  }

  let minLatitude = firstCoordinates[0];
  let maxLatitude = firstCoordinates[0];
  let minLongitude = firstCoordinates[1];
  let maxLongitude = firstCoordinates[1];

  for (const [latitude, longitude] of remainingCoordinates) {
    minLatitude = Math.min(minLatitude, latitude);
    maxLatitude = Math.max(maxLatitude, latitude);
    minLongitude = Math.min(minLongitude, longitude);
    maxLongitude = Math.max(maxLongitude, longitude);
  }

  return [
    [minLatitude, minLongitude],
    [maxLatitude, maxLongitude],
  ];
}

export function getMapPointCenter(points: Array<Pick<MapPoint, 'coordinates'>>): MapCoordinate {
  const bounds = getMapPointBounds(points);

  if (!bounds) {
    return [55.751574, 37.573856];
  }

  return [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
}
