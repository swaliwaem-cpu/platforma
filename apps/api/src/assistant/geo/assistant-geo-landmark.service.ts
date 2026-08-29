import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AssistantGeoBrowserConstraint,
  AssistantGeoBrowserInput,
  AssistantGeoKind,
  AssistantGeoReferenceGeometry,
  AssistantGeoSearchContext,
  AssistantGeoSearchSelection,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';
import {
  assertAssistantGeoUniqueConstraints,
  assistantGeoDefaultLandmarkDistanceMeters,
  assistantGeoDefaultPointDistanceMeters,
  parseAssistantGeoBrowserContext,
  parseAssistantGeoBrowserInput,
  parseAssistantReferenceGeometry,
  type ParsedAssistantGeoBrowserContext,
  type ParsedAssistantGeoBrowserInput,
} from './assistant-geo-contract';
import { normalizeAssistantGeoIdentityText } from './assistant-geo-landmark-identity';

type LandmarkWriteClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export class AssistantGeoLandmarkGeometryError extends Error {
  constructor() {
    super('ASSISTANT_GEO_LANDMARK_GEOMETRY_INVALID');
    this.name = 'AssistantGeoLandmarkGeometryError';
  }
}

type LandmarkRow = {
  id: string;
  kind: 'point' | 'line' | 'area';
  label: string;
  city: string | null;
  country: string;
  sourceProvider: string;
  latitude: number | string | null;
  longitude: number | string | null;
  referenceGeometry?: string;
};

export type AssistantTrustedLandmark = {
  id: string;
  kind: AssistantGeoKind;
  label: string;
  city: string | null;
  countryCode: string | null;
  source: 'ALIAS' | 'PLACE';
  point?: { latitude: number; longitude: number };
};

export type AssistantVerifiedLandmarkInput = {
  kind: AssistantGeoKind;
  label: string;
  normalizedQuery: string;
  aliases: string[];
  locale: string;
  country: string | null;
  city: string | null;
  geometry: AssistantGeoReferenceGeometry;
  sourceProvider: 'locationiq' | 'overpass' | 'fake';
  sourceExternalId: string;
  retentionMs?: number;
  expiresAt?: Date;
  sourceMetadata: {
    entityType: string | null;
    fetchedAt: string;
    version: 1;
    identityVersion?: 1;
    userAlias?: string;
    providerQuery?: string;
  };
};

@Injectable()
export class AssistantGeoLandmarkService {
  constructor(private readonly prisma: PrismaService) {}

  parseBrowserInput(value: unknown) {
    return parseAssistantGeoBrowserInput(value);
  }

  async materializeBrowserInput(
    value: AssistantGeoBrowserConstraint | ParsedAssistantGeoBrowserInput,
  ): Promise<AssistantGeoSearchContext> {
    const input = parseAssistantGeoBrowserInput(value);
    if (input.referenceType === 'MANUAL_POINT') {
      return {
        kind: 'POINT',
        mode: 'NEAR',
        label: input.point.label,
        point: { latitude: input.point.latitude, longitude: input.point.longitude },
        distanceMeters: input.distanceMeters,
        source: 'MANUAL',
      };
    }

    const landmark = await this.findTrustedById(input.landmarkId);
    if (!landmark) throw new NotFoundException('ASSISTANT_GEO_LANDMARK_NOT_FOUND');
    if (input.mode === 'INSIDE' && landmark.kind !== 'AREA') {
      throw new BadRequestException('ASSISTANT_GEO_MODE_INVALID');
    }
    if (input.mode === 'INSIDE') {
      return {
        kind: 'AREA',
        mode: 'INSIDE',
        label: landmark.label,
        landmarkId: landmark.id,
        source: 'LANDMARK',
      };
    }

    const distanceMeters = input.distanceMeters
      ?? (landmark.kind === 'POINT'
        ? assistantGeoDefaultPointDistanceMeters
        : assistantGeoDefaultLandmarkDistanceMeters);
    if (landmark.kind === 'POINT') {
      if (!landmark.point) throw new Error('ASSISTANT_GEO_LANDMARK_POINT_INVALID');
      return {
        kind: 'POINT',
        mode: 'NEAR',
        label: landmark.label,
        landmarkId: landmark.id,
        point: landmark.point,
        distanceMeters,
        source: 'LANDMARK',
      };
    }
    return landmark.kind === 'LINE'
      ? {
          kind: 'LINE',
          mode: 'NEAR',
          label: landmark.label,
          landmarkId: landmark.id,
          distanceMeters,
          source: 'LANDMARK',
        }
      : {
          kind: 'AREA',
          mode: 'NEAR',
          label: landmark.label,
          landmarkId: landmark.id,
          distanceMeters,
          source: 'LANDMARK',
        };
  }

  async materializeBrowserContext(
    value: AssistantGeoBrowserInput | ParsedAssistantGeoBrowserContext,
  ): Promise<AssistantGeoSearchSelection> {
    const input = parseAssistantGeoBrowserContext(value);
    if (!('operator' in input)) return this.materializeBrowserInput(input);
    const constraints = [];
    for (const constraint of input.constraints) {
      constraints.push(await this.materializeBrowserInput(constraint));
    }
    assertAssistantGeoUniqueConstraints(constraints);
    return { operator: 'ALL', constraints };
  }

  async findTrustedByQuery(input: {
    normalizedQuery: string;
    normalizedQueries?: string[];
    mode: 'NEAR' | 'INSIDE';
    locale: string;
    country: string | null;
    viewbox?: [west: number, south: number, east: number, north: number] | null;
  }): Promise<AssistantTrustedLandmark[]> {
    const normalizedQueries = [...new Set([
      input.normalizedQuery,
      ...(input.normalizedQueries ?? []),
    ].map((value) => value.trim()).filter(Boolean))].slice(0, 20);
    const rows = await this.prisma.$queryRaw<LandmarkRow[]>(Prisma.sql`
      SELECT
        l."id"::text AS id,
        l."kind"::text AS kind,
        l."label" AS label,
        l."city" AS city,
        l."country" AS country,
        l."source_provider" AS "sourceProvider",
        CASE WHEN l."kind" = 'point' THEN ST_Y(l."geometry") ELSE NULL END AS latitude,
        CASE WHEN l."kind" = 'point' THEN ST_X(l."geometry") ELSE NULL END AS longitude
      FROM "assistant_geo_landmarks" l
      WHERE (
        l."normalized_query" = ANY(ARRAY[${Prisma.join(normalizedQueries)}]::text[])
        OR l."aliases" && ARRAY[${Prisma.join(normalizedQueries)}]::text[]
      )
        AND l."locale" = ${input.locale}
        AND (${input.country ?? ''} = '' OR l."country" = ${input.country ?? ''})
        AND (${input.mode} = 'NEAR' OR l."kind" = 'area')
        ${input.viewbox
          ? Prisma.sql`AND ST_Intersects(
              l."geometry",
              ST_MakeEnvelope(
                ${input.viewbox[0]}, ${input.viewbox[1]}, ${input.viewbox[2]}, ${input.viewbox[3]}, 4326
              )
            )`
          : Prisma.empty}
        AND (
          l."confirmation_state" = 'confirmed'
          OR (l."confirmation_state" = 'verified' AND l."expires_at" > CURRENT_TIMESTAMP)
        )
      ORDER BY
        (l."confirmation_state" = 'confirmed') DESC,
        (l."normalized_query" = ${input.normalizedQuery}) DESC,
        l."updated_at" DESC,
        l."id" ASC
      LIMIT 3
    `);
    return rows.map(toTrustedLandmark);
  }

  async findTrustedById(id: string): Promise<AssistantTrustedLandmark | null> {
    const rows = await this.prisma.$queryRaw<LandmarkRow[]>(Prisma.sql`
      SELECT
        l."id"::text AS id,
        l."kind"::text AS kind,
        l."label" AS label,
        l."city" AS city,
        l."country" AS country,
        l."source_provider" AS "sourceProvider",
        CASE WHEN l."kind" = 'point' THEN ST_Y(l."geometry") ELSE NULL END AS latitude,
        CASE WHEN l."kind" = 'point' THEN ST_X(l."geometry") ELSE NULL END AS longitude
      FROM "assistant_geo_landmarks" l
      WHERE l."id" = ${id}::uuid
        AND (
          l."confirmation_state" = 'confirmed'
          OR (l."confirmation_state" = 'verified' AND l."expires_at" > CURRENT_TIMESTAMP)
        )
      LIMIT 1
    `);
    return rows[0] ? toTrustedLandmark(rows[0]) : null;
  }

  async matchesTrustedIdentity(id: string, queries: string[]) {
    const normalizedQueries = [...new Set(queries
      .map(normalizeAssistantGeoIdentityText)
      .filter(Boolean))]
      .slice(0, 20);
    if (normalizedQueries.length === 0) return false;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT l."id"::text AS id
      FROM "assistant_geo_landmarks" l
      WHERE l."id" = ${id}::uuid
        AND (
          ARRAY[l."normalized_query"::text] || coalesce(l."aliases", ARRAY[]::text[])
        ) && ARRAY[${Prisma.join(normalizedQueries)}]::text[]
        AND (
          l."confirmation_state" = 'confirmed'
          OR (l."confirmation_state" = 'verified' AND l."expires_at" > CURRENT_TIMESTAMP)
        )
      LIMIT 1
    `);
    return rows.length > 0;
  }

  async loadReferenceGeometry(context: AssistantGeoSearchContext): Promise<AssistantGeoReferenceGeometry> {
    if (context.kind === 'POINT') {
      return {
        type: 'Point',
        coordinates: [context.point.longitude, context.point.latitude],
      };
    }
    if (!context.landmarkId) throw new Error('ASSISTANT_GEO_LANDMARK_ID_REQUIRED');
    const rows = await this.prisma.$queryRaw<LandmarkRow[]>(Prisma.sql`
      SELECT
        l."id"::text AS id,
        l."kind"::text AS kind,
        l."label" AS label,
        l."city" AS city,
        l."country" AS country,
        l."source_provider" AS "sourceProvider",
        NULL::double precision AS latitude,
        NULL::double precision AS longitude,
        ST_AsGeoJSON(l."geometry", 7) AS "referenceGeometry"
      FROM "assistant_geo_landmarks" l
      WHERE l."id" = ${context.landmarkId}::uuid
        AND l."kind" = ${context.kind.toLocaleLowerCase('en-US')}::assistant_geo_landmark_kind
        AND (
          l."confirmation_state" = 'confirmed'
          OR (l."confirmation_state" = 'verified' AND l."expires_at" > CURRENT_TIMESTAMP)
        )
      LIMIT 1
    `);
    const encoded = rows[0]?.referenceGeometry;
    if (!encoded) throw new Error('ASSISTANT_GEO_LANDMARK_UNAVAILABLE');
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw new Error('ASSISTANT_GEO_LANDMARK_GEOMETRY_INVALID');
    }
    return parseAssistantReferenceGeometry(decoded, context.kind);
  }

  async saveVerified(input: AssistantVerifiedLandmarkInput): Promise<AssistantTrustedLandmark> {
    const geometry = parseAssistantReferenceGeometry(input.geometry, input.kind);
    const expiresAt = readVerifiedExpiry(input);
    const aliases = [...new Set([
      input.normalizedQuery,
      ...input.aliases,
    ].map((alias) => alias.trim()).filter(Boolean))].slice(0, 20);
    const metadata = JSON.stringify({
      entityType: input.sourceMetadata.entityType,
      fetchedAt: input.sourceMetadata.fetchedAt,
      version: 1,
      ...(input.sourceMetadata.identityVersion ? { identityVersion: input.sourceMetadata.identityVersion } : {}),
      ...(input.sourceMetadata.userAlias ? { userAlias: input.sourceMetadata.userAlias } : {}),
      ...(input.sourceMetadata.providerQuery ? { providerQuery: input.sourceMetadata.providerQuery } : {}),
    });
    let rows: LandmarkRow[];
    try {
      rows = await this.prisma.$queryRaw<LandmarkRow[]>(Prisma.sql`
        INSERT INTO "assistant_geo_landmarks" (
        "kind", "label", "normalized_query", "aliases", "locale", "country", "city", "geometry",
        "source_provider", "source_external_id", "source_metadata", "confirmation_state", "expires_at"
        ) VALUES (
        ${input.kind.toLocaleLowerCase('en-US')}::assistant_geo_landmark_kind,
        ${input.label},
        ${input.normalizedQuery},
        ARRAY[${Prisma.join(aliases)}]::text[],
        ${input.locale},
        ${input.country ?? ''},
        ${input.city},
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326),
        ${input.sourceProvider},
        ${input.sourceExternalId},
        ${metadata}::jsonb,
        'verified',
        ${expiresAt}
      )
        ON CONFLICT ("source_provider", "source_external_id") WHERE "source_external_id" IS NOT NULL
        DO UPDATE SET
        "kind" = EXCLUDED."kind",
        "label" = EXCLUDED."label",
        "normalized_query" = EXCLUDED."normalized_query",
        "aliases" = ARRAY(
          SELECT DISTINCT alias
          FROM unnest("assistant_geo_landmarks"."aliases" || EXCLUDED."aliases") AS merged_alias(alias)
          ORDER BY alias
          LIMIT 20
        ),
        "locale" = EXCLUDED."locale",
        "country" = EXCLUDED."country",
        "city" = EXCLUDED."city",
        "geometry" = EXCLUDED."geometry",
        "source_metadata" = EXCLUDED."source_metadata",
        "confirmation_state" = 'verified',
        "confirmed_by_user_id" = NULL,
        "confirmed_at" = NULL,
        "expires_at" = EXCLUDED."expires_at",
        "updated_at" = CURRENT_TIMESTAMP
        WHERE "assistant_geo_landmarks"."confirmation_state" <> 'confirmed'
        RETURNING
        "id"::text AS id,
        "kind"::text AS kind,
        "label",
        "city",
        "country",
        "source_provider" AS "sourceProvider",
        CASE WHEN "kind" = 'point' THEN ST_Y("geometry") ELSE NULL END AS latitude,
        CASE WHEN "kind" = 'point' THEN ST_X("geometry") ELSE NULL END AS longitude
      `);
    } catch (error) {
      if (isLandmarkGeometryConstraintError(error)) throw new AssistantGeoLandmarkGeometryError();
      throw error;
    }
    if (rows[0]) return toTrustedLandmark(rows[0]);
    const existing = await this.findBySourceIdentity(input.sourceProvider, input.sourceExternalId);
    if (!existing) throw new Error('ASSISTANT_GEO_LANDMARK_PERSIST_FAILED');
    return existing;
  }

  async confirmManualAlias(input: {
    id: string;
    query: string;
    normalizedQuery: string;
    label: string;
    locale: string;
    country: string | null;
    city: string | null;
    latitude: number;
    longitude: number;
    actorId: string;
  }, database: LandmarkWriteClient = this.prisma) {
    await database.$executeRaw(Prisma.sql`
      INSERT INTO "assistant_geo_landmarks" (
        "id", "kind", "label", "normalized_query", "aliases", "locale", "country", "city", "geometry",
        "source_provider", "source_external_id", "source_metadata", "confirmation_state",
        "confirmed_by_user_id", "confirmed_at", "expires_at"
      ) VALUES (
        ${input.id}::uuid, 'point', ${input.label}, ${input.normalizedQuery},
        ARRAY[${input.normalizedQuery}]::text[], ${input.locale}, ${input.country ?? ''}, ${input.city},
        ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326),
        'manual_alias', ${input.id}, '{"version":1}'::jsonb, 'confirmed', ${input.actorId}::uuid,
        CURRENT_TIMESTAMP, NULL
      )
      ON CONFLICT ("id") DO UPDATE SET
        "label" = EXCLUDED."label",
        "normalized_query" = EXCLUDED."normalized_query",
        "aliases" = EXCLUDED."aliases",
        "locale" = EXCLUDED."locale",
        "country" = EXCLUDED."country",
        "city" = EXCLUDED."city",
        "geometry" = EXCLUDED."geometry",
        "confirmation_state" = 'confirmed',
        "confirmed_by_user_id" = EXCLUDED."confirmed_by_user_id",
        "confirmed_at" = CURRENT_TIMESTAMP,
        "expires_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
    `);
  }

  async rejectManualAlias(id: string, database: LandmarkWriteClient = this.prisma) {
    await database.$executeRaw(Prisma.sql`
      UPDATE "assistant_geo_landmarks"
      SET "confirmation_state" = 'rejected',
          "confirmed_by_user_id" = NULL,
          "confirmed_at" = NULL,
          "expires_at" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}::uuid AND "source_provider" = 'manual_alias'
    `);
  }

  private async findBySourceIdentity(sourceProvider: string, sourceExternalId: string) {
    const rows = await this.prisma.$queryRaw<LandmarkRow[]>(Prisma.sql`
      SELECT
        "id"::text AS id,
        "kind"::text AS kind,
        "label",
        "city",
        "country",
        "source_provider" AS "sourceProvider",
        CASE WHEN "kind" = 'point' THEN ST_Y("geometry") ELSE NULL END AS latitude,
        CASE WHEN "kind" = 'point' THEN ST_X("geometry") ELSE NULL END AS longitude
      FROM "assistant_geo_landmarks"
      WHERE "source_provider" = ${sourceProvider} AND "source_external_id" = ${sourceExternalId}
      LIMIT 1
    `);
    return rows[0] ? toTrustedLandmark(rows[0]) : null;
  }
}

function readRetentionMs(value: number) {
  const minimum = 60 * 1_000;
  const maximum = 365 * 24 * 60 * 60 * 1_000;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('ASSISTANT_GEO_LANDMARK_RETENTION_INVALID');
  }
  return value;
}

function readVerifiedExpiry(input: Pick<AssistantVerifiedLandmarkInput, 'expiresAt' | 'retentionMs'>) {
  if (input.expiresAt !== undefined) {
    const timestamp = input.expiresAt.getTime();
    const remainingMs = timestamp - Date.now();
    if (!Number.isFinite(timestamp) || remainingMs < 30_000 || remainingMs > 365 * 24 * 60 * 60 * 1_000) {
      throw new Error('ASSISTANT_GEO_LANDMARK_EXPIRY_INVALID');
    }
    return input.expiresAt;
  }
  if (input.retentionMs === undefined) throw new Error('ASSISTANT_GEO_LANDMARK_RETENTION_REQUIRED');
  return new Date(Date.now() + readRetentionMs(input.retentionMs));
}

function toTrustedLandmark(row: LandmarkRow): AssistantTrustedLandmark {
  const kind = row.kind.toLocaleUpperCase('en-US') as AssistantGeoKind;
  const latitude = row.latitude === null ? null : Number(row.latitude);
  const longitude = row.longitude === null ? null : Number(row.longitude);
  if (!['POINT', 'LINE', 'AREA'].includes(kind)
    || (kind === 'POINT' && (!Number.isFinite(latitude) || !Number.isFinite(longitude)))) {
    throw new Error('ASSISTANT_GEO_LANDMARK_ROW_INVALID');
  }
  return {
    id: row.id,
    kind,
    label: row.label,
    city: row.city,
    countryCode: row.country || null,
    source: row.sourceProvider === 'manual_alias' ? 'ALIAS' : 'PLACE',
    ...(kind === 'POINT' ? { point: { latitude: latitude!, longitude: longitude! } } : {}),
  };
}

function isLandmarkGeometryConstraintError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return false;
  const metadata = JSON.stringify(error.meta ?? {});
  return metadata.includes('assistant_geo_landmarks_geometry_valid')
    || metadata.includes('assistant_geo_landmarks_kind_geometry');
}
