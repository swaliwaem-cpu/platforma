import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MapRoutingService } from '../../map/map-routing.service';
import { PrismaService } from '../../prisma/prisma.service';

export const assistantMetroNearestAccessPointLimit = 3;
export const assistantMetroOnDemandObjectLimit = 3;
export const assistantMetroRoutingProfile = 'foot-walking-v1';

type RouteObject = {
  id: string;
  latitude: number | Prisma.Decimal | null;
  longitude: number | Prisma.Decimal | null;
};

type AccessPointRow = {
  id: string;
  stationName: string;
  datasetVersion: string;
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
};

type MetroGeoJson = {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string | number;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
};

export class AssistantMetroTravelTimeUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantMetroTravelTimeUnavailableError';
  }
}

@Injectable()
export class AssistantMetroTravelTimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: MapRoutingService,
  ) {}

  async ensureFacts(objects: RouteObject[], deadlineAt?: Date, onDemandObjectIds = new Set<string>()) {
    const uniqueObjects = [...new Map(objects.map((object) => [object.id, object])).values()];
    const reserved = new Set([...onDemandObjectIds, ...uniqueObjects.map(({ id }) => id)]);
    if (reserved.size > assistantMetroOnDemandObjectLimit) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_ROUTE_COVERAGE_GAP');
    }
    for (const id of reserved) onDemandObjectIds.add(id);
    for (const object of uniqueObjects) {
      this.assertDeadline(deadlineAt);
      await this.refreshObject(object, deadlineAt);
    }
  }

  async importAccessPoints(value: unknown, datasetVersion: string) {
    const document = parseMetroGeoJson(value);
    const version = datasetVersion.trim();
    if (!version || version.length > 80) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_DATASET_VERSION_INVALID');
    }
    const features = document.features.map((feature) => {
      const sourceExternalId = readExternalId(feature);
      const stationName = readStationName(feature.properties);
      const [longitude, latitude] = feature.geometry.coordinates;
      return {
        source_external_id: sourceExternalId,
        station_name: stationName,
        longitude: normalizeDatasetCoordinate(longitude),
        latitude: normalizeDatasetCoordinate(latitude),
        properties: feature.properties,
      };
    });
    if (new Set(features.map(({ source_external_id }) => source_external_id)).size !== features.length) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_DUPLICATE_ACCESS_POINT');
    }

    const serializedFeatures = JSON.stringify(features);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended('assistant-metro-import', 0))::text
      `);
      const existing = await transaction.assistantMetroAccessPoint.findMany({
        where: { datasetVersion: version },
        select: {
          sourceExternalId: true,
          stationName: true,
          latitude: true,
          longitude: true,
          sourceProperties: true,
        },
      });
      if (existing.length > 0 && !sameMetroDataset(existing, features)) {
        throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_DATASET_VERSION_CONFLICT');
      }
      await transaction.assistantMetroAccessPoint.updateMany({ data: { isActive: false } });
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO assistant_metro_access_points (
          id, source_external_id, station_name, dataset_version,
          latitude, longitude, location, source_properties,
          is_active, created_at, updated_at
        )
        SELECT
          gen_random_uuid(), imported.source_external_id, imported.station_name, ${version},
          imported.latitude, imported.longitude,
          ST_SetSRID(ST_MakePoint(imported.longitude, imported.latitude), 4326)::geography,
          imported.properties, TRUE, NOW(), NOW()
        FROM jsonb_to_recordset(${serializedFeatures}::jsonb) AS imported(
          source_external_id text,
          station_name text,
          longitude double precision,
          latitude double precision,
          properties jsonb
        )
        ON CONFLICT (dataset_version, source_external_id) DO UPDATE SET
          is_active = TRUE,
          updated_at = NOW()
      `);
    });
    return { datasetVersion: version, accessPoints: features.length };
  }

  async refreshPublishedObjects(deadlineAt?: Date) {
    const withoutCoordinates = await this.prisma.realEstateObject.findFirst({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        OR: [{ latitude: null }, { longitude: null }],
      },
      select: { id: true },
    });
    if (withoutCoordinates) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_PUBLISHED_COORDINATES_INCOMPLETE');
    }

    let refreshed = 0;
    let afterId: string | undefined;
    while (true) {
      const batch = await this.prisma.realEstateObject.findMany({
        where: {
          status: 'PUBLISHED',
          deletedAt: null,
          latitude: { not: null },
          longitude: { not: null },
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: assistantMetroOnDemandObjectLimit,
        select: { id: true, latitude: true, longitude: true },
      });
      if (batch.length === 0) break;
      await this.ensureFacts(batch, deadlineAt);
      refreshed += batch.length;
      afterId = batch.at(-1)!.id;
    }
    this.assertDeadline(deadlineAt);
    const coverageGap = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT o.id::text AS id
      FROM real_estate_objects o
      WHERE o.status = 'published'::object_status
        AND o.deleted_at IS NULL
        AND (
          o.latitude IS NULL
          OR o.longitude IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM assistant_object_metro_route_facts fact
            JOIN assistant_metro_access_points access
              ON access.id = fact.metro_access_point_id
            WHERE fact.object_id = o.id
              AND fact.object_latitude = o.latitude
              AND fact.object_longitude = o.longitude
              AND fact.access_dataset_version = access.dataset_version
              AND fact.routing_profile = ${assistantMetroRoutingProfile}
              AND access.is_active = TRUE
          )
        )
      LIMIT 1
    `);
    this.assertDeadline(deadlineAt);
    if (coverageGap.length > 0) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_ROUTE_COVERAGE_GAP');
    }
    return { publishedObjects: refreshed, refreshed };
  }

  private async refreshObject(object: RouteObject, deadlineAt?: Date) {
    const latitude = toCoordinate(object.latitude, -90, 90);
    const longitude = toCoordinate(object.longitude, -180, 180);
    const accessPoints = await this.prisma.$queryRaw<AccessPointRow[]>(Prisma.sql`
      SELECT
        id::text AS id,
        station_name AS "stationName",
        dataset_version AS "datasetVersion",
        latitude,
        longitude
      FROM assistant_metro_access_points
      WHERE is_active = TRUE
      ORDER BY location <-> ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
      LIMIT ${assistantMetroNearestAccessPointLimit}
    `);
    if (accessPoints.length === 0) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_DIRECTORY_EMPTY');
    }

    let response;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.assertDeadline(deadlineAt);
      const routes = this.routing.getWalkingRoutes({
        origin: [latitude, longitude],
        destinations: accessPoints.map((point) => [Number(point.latitude), Number(point.longitude)]),
      });
      response = await (deadlineAt ? Promise.race([
        routes,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new AssistantMetroTravelTimeUnavailableError(
            'ASSISTANT_EXECUTION_DEADLINE_EXCEEDED',
          )), Math.max(0, deadlineAt.getTime() - Date.now()));
        }),
      ]) : routes);
    } catch (error) {
      if (error instanceof AssistantMetroTravelTimeUnavailableError) throw error;
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_ROUTER_UNAVAILABLE');
    } finally {
      clearTimeout(deadlineTimer);
    }
    this.assertDeadline(deadlineAt);
    const routes = response.routes.flatMap((route) => {
      const accessPoint = accessPoints[route.destinationIndex];
      const durationSeconds = route.durationSeconds;
      const distanceMeters = route.distanceMeters;
      return accessPoint
        && typeof durationSeconds === 'number'
        && Number.isInteger(durationSeconds) && durationSeconds > 0
        && typeof distanceMeters === 'number'
        && Number.isInteger(distanceMeters) && distanceMeters >= 0
        ? [{ accessPoint, durationSeconds, distanceMeters }]
        : [];
    });
    routes.sort((left, right) => left.durationSeconds - right.durationSeconds
      || left.distanceMeters - right.distanceMeters
      || left.accessPoint.id.localeCompare(right.accessPoint.id));
    const best = routes[0];
    if (!best) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_ROUTE_INVALID');
    }
    const data = {
      metroAccessPointId: best.accessPoint.id,
      objectLatitude: latitude,
      objectLongitude: longitude,
      accessDatasetVersion: best.accessPoint.datasetVersion,
      routingProfile: assistantMetroRoutingProfile,
      durationSeconds: best.durationSeconds,
      distanceMeters: best.distanceMeters,
      calculatedAt: new Date(),
    };
    await this.prisma.assistantObjectMetroRouteFact.upsert({
      where: { objectId: object.id },
      create: { objectId: object.id, ...data },
      update: data,
    });
  }

  private assertDeadline(deadlineAt?: Date) {
    if (deadlineAt && deadlineAt.getTime() <= Date.now()) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_EXECUTION_DEADLINE_EXCEEDED');
    }
  }
}

function parseMetroGeoJson(value: unknown): MetroGeoJson {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)
    || value.features.length === 0 || value.features.length > 20_000) {
    throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_GEOJSON_INVALID');
  }
  for (const feature of value.features) {
    if (!isRecord(feature) || feature.type !== 'Feature' || !isRecord(feature.geometry)
      || feature.geometry.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)
      || feature.geometry.coordinates.length !== 2 || !isRecord(feature.properties)) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_GEOJSON_INVALID');
    }
    const [longitude, latitude] = feature.geometry.coordinates;
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_GEOJSON_INVALID');
    }
  }
  return value as MetroGeoJson;
}

function readExternalId(feature: MetroGeoJson['features'][number]) {
  const raw = feature.properties.osm_id ?? feature.properties.id ?? feature.id;
  const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!value || value.length > 160) {
    throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_ACCESS_POINT_ID_INVALID');
  }
  return value;
}

function readStationName(properties: Record<string, unknown>) {
  const raw = properties.station_name ?? properties.name;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 200) {
    throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_METRO_STATION_NAME_INVALID');
  }
  return value;
}

function toCoordinate(value: number | Prisma.Decimal | null, minimum: number, maximum: number) {
  if (value === null) {
    throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_OBJECT_COORDINATES_UNAVAILABLE');
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < minimum || numberValue > maximum) {
    throw new AssistantMetroTravelTimeUnavailableError('ASSISTANT_OBJECT_COORDINATES_UNAVAILABLE');
  }
  return Number(numberValue.toFixed(6));
}

function normalizeDatasetCoordinate(value: number) {
  return Number(value.toFixed(6));
}

function sameMetroDataset(
  existing: Array<{
    sourceExternalId: string;
    stationName: string;
    latitude: Prisma.Decimal;
    longitude: Prisma.Decimal;
    sourceProperties: Prisma.JsonValue;
  }>,
  imported: Array<{
    source_external_id: string;
    station_name: string;
    latitude: number;
    longitude: number;
    properties: Record<string, unknown>;
  }>,
) {
  if (existing.length !== imported.length) return false;
  const importedById = new Map(imported.map((point) => [point.source_external_id, point]));
  return existing.every((point) => {
    const candidate = importedById.get(point.sourceExternalId);
    return Boolean(candidate
      && candidate.station_name === point.stationName
      && candidate.latitude === Number(point.latitude)
      && candidate.longitude === Number(point.longitude)
      && stableJson(candidate.properties) === stableJson(point.sourceProperties));
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
