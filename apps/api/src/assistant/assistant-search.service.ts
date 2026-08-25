import { Injectable } from '@nestjs/common';
import {
  FeedUnitStatus,
  LocationType,
  ObjectFileType,
  Prisma,
} from '@prisma/client';
import type {
  AssistantAlternativeDeviation,
  AssistantPageContext,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import { findCatalogSearchObjectIds } from '../objects/object-search';
import {
  createAssistantComparisonTargetVariants,
  type AssistantComparisonTargetMode,
  type AssistantSearchFilters,
  type AssistantStructuredIntent,
} from './assistant-query-planner';
import type {
  AssistantGeoPolygon,
  AssistantGeoSearchInput,
} from './geo/assistant-geo-contract';
import type { AssistantSearchEvidence } from './assistant-search-ranking';

const candidateLimit = 120;
const budgetRelaxationRub = 7_000_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const candidateSelect = {
  id: true,
  status: true,
  effectivePrice: true,
  discountPrice: true,
  price: true,
  title: true,
  rooms: true,
  completionYear: true,
  completionQuarter: true,
  area: true,
  floor: true,
  updatedAt: true,
  object: {
    select: {
      id: true,
      type: true,
      title: true,
      slug: true,
      feedCompletionYear: true,
      completionYear: true,
      feedCompletionQuarter: true,
      completionQuarter: true,
      propertyClass: true,
      latitude: true,
      longitude: true,
      developer: { select: { name: true } },
      primaryLocation: { select: { name: true, type: true } },
      locations: {
        select: { location: { select: { name: true, type: true } } },
        orderBy: { sortOrder: 'asc' as const },
      },
      metroStations: {
        select: { metroStation: { select: { name: true } } },
        orderBy: { sortOrder: 'asc' as const },
      },
      files: {
        where: {
          type: { in: [ObjectFileType.PRESENTATION, ObjectFileType.FLOOR_PLAN] },
          file: {
            OR: [
              { mimeType: { equals: 'application/pdf', mode: 'insensitive' as const } },
              { originalName: { endsWith: '.pdf', mode: 'insensitive' as const } },
            ],
          },
        },
        select: {
          type: true,
          title: true,
          file: { select: { id: true, mimeType: true, originalName: true } },
        },
        orderBy: { sortOrder: 'asc' as const },
      },
    },
  },
  media: {
    where: {
      mediaAsset: {
        OR: [
          { contentType: { equals: 'application/pdf', mode: 'insensitive' as const } },
          {
            file: {
              is: {
                OR: [
                  { mimeType: { equals: 'application/pdf', mode: 'insensitive' as const } },
                  { originalName: { endsWith: '.pdf', mode: 'insensitive' as const } },
                ],
              },
            },
          },
        ],
      },
    },
    select: {
      label: true,
      mediaAsset: {
        select: {
          contentType: true,
          file: { select: { id: true, mimeType: true, originalName: true } },
        },
      },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.FeedUnitSelect;

type CandidateRecord = Prisma.FeedUnitGetPayload<{ select: typeof candidateSelect }>;
type SearchOptions = {
  nearbyDistrictParentIds?: string[];
  catalogSearchObjectIds?: string[];
  comparisonTargets?: string[];
  comparisonTargetModes?: AssistantComparisonTargetMode[];
  softPreferences?: AssistantSearchFilters;
  geo?: AssistantGeoSearchInput | null;
};

export type AssistantGeoSearchResult = AssistantGeoSearchInput & {
  polygon: AssistantGeoPolygon;
};

@Injectable()
export class AssistantSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    intent: AssistantStructuredIntent,
    context: AssistantPageContext | null,
    geo: AssistantGeoSearchInput | null = null,
  ): Promise<{
    exact: AssistantSearchEvidence[];
    alternatives: AssistantSearchEvidence[];
    geo: AssistantGeoSearchResult | null;
  }> {
    const [contextOptions, geoResult] = await Promise.all([
      this.resolveContextOptions(context),
      geo ? this.createGeoResult(geo) : Promise.resolve(null),
    ]);
    const searchOptions = {
      ...contextOptions,
      comparisonTargets: intent.comparisonTargets,
      comparisonTargetModes: intent.comparisonTargetModes,
      softPreferences: intent.softPreferences,
      geo,
    };
    const exact = await this.findEvidence(intent.hardFilters, context, searchOptions);
    if (exact.length > 0) return { exact, alternatives: [], geo: geoResult };

    const relaxationRequests: Array<Promise<AssistantSearchEvidence[]>> = [];
    if (intent.hardFilters.district) {
      relaxationRequests.push(this.findNearbyDistrictAlternatives(intent.hardFilters, context, searchOptions));
    }
    if (intent.hardFilters.developer) {
      relaxationRequests.push(this.findRelaxedEvidence(
        { ...intent.hardFilters, developer: null },
        context,
        (candidate) => candidate.developer
          ? { type: 'DEVELOPER', label: `Другой застройщик: ${candidate.developer}` }
          : null,
        searchOptions,
      ));
    }
    if (intent.hardFilters.rooms.length > 0) {
      const requestedRooms = intent.hardFilters.rooms.join(' или ');
      relaxationRequests.push(this.findRelaxedEvidence(
        { ...intent.hardFilters, rooms: [] },
        context,
        (candidate) => candidate.rooms === null
          ? null
          : { type: 'ROOMS', label: `${formatRooms(candidate.rooms)} вместо ${requestedRooms}` },
        searchOptions,
      ));
    }
    if (intent.hardFilters.budgetMinRub !== null || intent.hardFilters.budgetMaxRub !== null) {
      const expandedFilters = {
        ...intent.hardFilters,
        budgetMinRub: intent.hardFilters.budgetMinRub === null
          ? null
          : Math.max(0, intent.hardFilters.budgetMinRub - budgetRelaxationRub),
        budgetMaxRub: intent.hardFilters.budgetMaxRub === null
          ? null
          : intent.hardFilters.budgetMaxRub + budgetRelaxationRub,
      };
      relaxationRequests.push(this.findRelaxedEvidence(
        expandedFilters,
        context,
        (candidate) => createBudgetDeviation(candidate, intent.hardFilters),
        searchOptions,
      ));
    }

    const relaxedGroups = await Promise.all(relaxationRequests);
    const alternativesByUnitId = new Map<string, AssistantSearchEvidence>();
    for (const group of relaxedGroups) {
      for (const candidate of group) {
        if (!alternativesByUnitId.has(candidate.unitId)) alternativesByUnitId.set(candidate.unitId, candidate);
      }
    }
    return { exact: [], alternatives: [...alternativesByUnitId.values()], geo: geoResult };
  }

  private async createGeoResult(geo: AssistantGeoSearchInput): Promise<AssistantGeoSearchResult> {
    const rows = await this.prisma.$queryRaw<Array<{ polygon: string }>>(Prisma.sql`
      SELECT ST_AsGeoJSON(
        ST_Buffer(
          ST_SetSRID(ST_MakePoint(${geo.anchor.longitude}, ${geo.anchor.latitude}), 4326)::geography,
          ${geo.radiusMeters}
        )::geometry,
        7
      ) AS polygon
    `);
    const polygon = rows[0]?.polygon ? JSON.parse(rows[0].polygon) as unknown : null;
    if (!isGeoPolygon(polygon)) throw new Error('ASSISTANT_GEO_POLYGON_INVALID');
    return { ...geo, polygon };
  }

  private async findNearbyDistrictAlternatives(
    filters: AssistantSearchFilters,
    context: AssistantPageContext | null,
    contextOptions: SearchOptions,
  ) {
    const normalizedDistrict = filters.district!;
    const districtRows = await this.prisma.location.findMany({
      where: {
        type: LocationType.DISTRICT,
        name: { contains: normalizedDistrict, mode: 'insensitive' },
        parentId: { not: null },
      },
      select: { parentId: true },
      take: 20,
    });
    const parentIds = [...new Set(districtRows.map(({ parentId }) => parentId).filter((id): id is string => Boolean(id)))];
    if (parentIds.length === 0) return [];

    return this.findRelaxedEvidence(
      { ...filters, district: null },
      context,
      (candidate) => candidate.district && !containsNormalized(candidate.district, normalizedDistrict)
        ? { type: 'DISTRICT', label: `Близкий район: ${candidate.district}` }
        : null,
      { ...contextOptions, nearbyDistrictParentIds: parentIds },
    );
  }

  private async findRelaxedEvidence(
    filters: AssistantSearchFilters,
    context: AssistantPageContext | null,
    createDeviation: (candidate: AssistantSearchEvidence) => AssistantAlternativeDeviation | null,
    options: SearchOptions = {},
  ) {
    const candidates = await this.findEvidence(filters, context, options);
    return candidates.flatMap((candidate) => {
      const deviation = createDeviation(candidate);
      return deviation ? [{ ...candidate, deviations: [deviation] }] : [];
    });
  }

  private async findEvidence(
    filters: AssistantSearchFilters,
    context: AssistantPageContext | null,
    options: SearchOptions = {},
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const comparisonGroups = options.comparisonTargets?.length === 2
        ? options.comparisonTargets.map((target, index) => ({
            targets: [target],
            modes: [options.comparisonTargetModes?.[index] ?? 'EXACT'] as AssistantComparisonTargetMode[],
          }))
        : [{
            targets: options.comparisonTargets,
            modes: options.comparisonTargetModes,
          }];
      const groupLimit = comparisonGroups.length === 2 ? Math.ceil(candidateLimit / 2) : candidateLimit;
      const rowIds: string[] = [];
      const rowDistances = new Map<string, number | null>();
      const seenRowIds = new Set<string>();

      for (const comparisonGroup of comparisonGroups) {
        const rows = await this.findCandidateRows(
          transaction,
          filters,
          context,
          {
            ...options,
            comparisonTargets: comparisonGroup.targets,
            comparisonTargetModes: comparisonGroup.modes,
          },
          groupLimit,
        );
        for (const { id, distanceMeters } of rows) {
          if (seenRowIds.has(id)) continue;
          seenRowIds.add(id);
          rowIds.push(id);
          rowDistances.set(id, distanceMeters);
        }
      }
      if (rowIds.length === 0) return [];

      const records = await transaction.feedUnit.findMany({
        where: { id: { in: rowIds } },
        select: candidateSelect,
      });
      const recordsById = new Map(records.map((record) => [record.id, record]));
      return rowIds.flatMap((id) => {
        const record = recordsById.get(id);
        const evidence = record ? this.toEvidence(record) : null;
        return evidence ? [{ ...evidence, distanceMeters: rowDistances.get(id) ?? null }] : [];
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private async findCandidateRows(
    transaction: Prisma.TransactionClient,
    filters: AssistantSearchFilters,
    context: AssistantPageContext | null,
    options: SearchOptions,
    limit: number,
  ) {
    const conditions = this.createSqlConditions(filters, context, options);
    const softPreferenceScore = this.createSoftPreferenceScore(options.softPreferences);
    const comparisonTargetPriority = this.createComparisonTargetPriority(options);
    const distance = options.geo
      ? Prisma.sql`ST_Distance(
          o.search_point,
          ST_SetSRID(ST_MakePoint(${options.geo.anchor.longitude}, ${options.geo.anchor.latitude}), 4326)::geography
        )`
      : Prisma.sql`NULL::double precision`;
    return transaction.$queryRaw<Array<{ id: string; distanceMeters: number | null }>>(Prisma.sql`
      SELECT fu.id::text AS id
        , ${distance} AS "distanceMeters"
      FROM feed_units fu
      JOIN feed_sources fs ON fs.id = fu.source_id
      JOIN real_estate_objects o ON o.id = fu.object_id
      LEFT JOIN developers d ON d.id = o.developer_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY
        ${comparisonTargetPriority} DESC,
        ${softPreferenceScore} DESC,
        ${distance} ASC NULLS LAST,
        COALESCE(fu.effective_price, fu.discount_price, fu.price) ASC NULLS LAST,
        fu.updated_at DESC,
        fu.id ASC
      LIMIT ${limit}
    `);
  }

  private createSoftPreferenceScore(filters: AssistantSearchFilters | undefined) {
    if (!filters) return Prisma.sql`CAST(0 AS integer)`;
    const price = Prisma.sql`COALESCE(fu.effective_price, fu.discount_price, fu.price)`;
    const completionYear = Prisma.sql`COALESCE(fu.completion_year, o.feed_completion_year, o.completion_year)`;
    const completionQuarter = Prisma.sql`COALESCE(fu.completion_quarter, o.feed_completion_quarter, o.completion_quarter)`;
    const terms: Prisma.Sql[] = [];
    const addTerm = (condition: Prisma.Sql) => {
      terms.push(Prisma.sql`CASE WHEN ${condition} THEN 1 ELSE 0 END`);
    };

    if (filters.budgetMinRub !== null) addTerm(Prisma.sql`${price} >= ${filters.budgetMinRub}`);
    if (filters.budgetMaxRub !== null) addTerm(Prisma.sql`${price} <= ${filters.budgetMaxRub}`);
    if (filters.rooms.length > 0) addTerm(Prisma.sql`fu.rooms IN (${Prisma.join(filters.rooms)})`);
    if (filters.district) addTerm(this.createDistrictCondition(filters.district));
    if (filters.metro) addTerm(Prisma.sql`EXISTS (
      SELECT 1
      FROM object_metro_stations oms
      JOIN metro_stations ms ON ms.id = oms.metro_station_id
      WHERE oms.object_id = o.id
        AND ${createNormalizedContains(Prisma.sql`ms.name`, filters.metro)}
    )`);
    if (filters.developer) addTerm(createNormalizedContains(Prisma.sql`d.name`, filters.developer));
    if (filters.completionYearMin !== null) addTerm(Prisma.sql`${completionYear} >= ${filters.completionYearMin}`);
    if (filters.completionYearMax !== null) addTerm(Prisma.sql`${completionYear} <= ${filters.completionYearMax}`);
    if (filters.completionQuarter !== null) addTerm(Prisma.sql`${completionQuarter} = ${filters.completionQuarter}`);
    if (filters.propertyClass) addTerm(createNormalizedContains(Prisma.sql`o.property_class`, filters.propertyClass));
    if (filters.areaMin !== null) addTerm(Prisma.sql`fu.area >= ${filters.areaMin}`);
    if (filters.areaMax !== null) addTerm(Prisma.sql`fu.area <= ${filters.areaMax}`);
    if (filters.floorMin !== null) addTerm(Prisma.sql`fu.floor >= ${filters.floorMin}`);
    if (filters.floorMax !== null) addTerm(Prisma.sql`fu.floor <= ${filters.floorMax}`);
    return terms.length > 0
      ? Prisma.sql`(${Prisma.join(terms, ' + ')})`
      : Prisma.sql`CAST(0 AS integer)`;
  }

  private createComparisonTargetPriority(options: SearchOptions) {
    if (options.comparisonTargets?.length !== 1) return Prisma.sql`CAST(0 AS integer)`;
    const target = options.comparisonTargets[0]!;
    const rawMatch = Prisma.sql`(
      ${createNormalizedPhraseMatch(Prisma.sql`o.title`, target)}
      OR ${createNormalizedPhraseMatch(Prisma.sql`d.name`, target)}
    )`;
    return Prisma.sql`CASE WHEN ${rawMatch} THEN 1 ELSE 0 END`;
  }

  private createSqlConditions(
    filters: AssistantSearchFilters,
    context: AssistantPageContext | null,
    options: SearchOptions,
  ) {
    const price = Prisma.sql`COALESCE(fu.effective_price, fu.discount_price, fu.price)`;
    const completionYear = Prisma.sql`COALESCE(fu.completion_year, o.feed_completion_year, o.completion_year)`;
    const completionQuarter = Prisma.sql`COALESCE(fu.completion_quarter, o.feed_completion_quarter, o.completion_quarter)`;
    const conditions: Prisma.Sql[] = [
      Prisma.sql`fu.status = 'available'::feed_unit_status`,
      Prisma.sql`fu.archived_at IS NULL`,
      Prisma.sql`${price} IS NOT NULL`,
      Prisma.sql`fs.deleted_at IS NULL`,
      Prisma.sql`fs.is_active = TRUE`,
      Prisma.sql`o.status = 'published'::object_status`,
      Prisma.sql`o.deleted_at IS NULL`,
      Prisma.sql`fu.type = ${filters.objectType === 'RESIDENTIAL' ? 'residential' : 'commercial'}::feed_unit_type`,
      Prisma.sql`o.type = ${filters.objectType === 'RESIDENTIAL' ? 'residential' : 'commercial'}::real_estate_object_type`,
    ];

    if (filters.budgetMinRub !== null) conditions.push(Prisma.sql`${price} >= ${filters.budgetMinRub}`);
    if (filters.budgetMaxRub !== null) conditions.push(Prisma.sql`${price} <= ${filters.budgetMaxRub}`);
    if (filters.rooms.length > 0) conditions.push(Prisma.sql`fu.rooms IN (${Prisma.join(filters.rooms)})`);
    if (filters.district) conditions.push(this.createDistrictCondition(filters.district));
    if (filters.metro) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1
        FROM object_metro_stations oms
        JOIN metro_stations ms ON ms.id = oms.metro_station_id
        WHERE oms.object_id = o.id
          AND ${createNormalizedContains(Prisma.sql`ms.name`, filters.metro)}
      )`);
    }
    if (filters.developer) conditions.push(createNormalizedContains(Prisma.sql`d.name`, filters.developer));
    if (filters.completionYearMin !== null) {
      conditions.push(Prisma.sql`${completionYear} >= ${filters.completionYearMin}`);
    }
    if (filters.completionYearMax !== null) {
      conditions.push(Prisma.sql`${completionYear} <= ${filters.completionYearMax}`);
    }
    if (filters.completionQuarter !== null) {
      conditions.push(Prisma.sql`${completionQuarter} = ${filters.completionQuarter}`);
    }
    if (filters.propertyClass) {
      conditions.push(createNormalizedContains(Prisma.sql`o.property_class`, filters.propertyClass));
    }
    if (filters.areaMin !== null) conditions.push(Prisma.sql`fu.area >= ${filters.areaMin}`);
    if (filters.areaMax !== null) conditions.push(Prisma.sql`fu.area <= ${filters.areaMax}`);
    if (filters.floorMin !== null) conditions.push(Prisma.sql`fu.floor >= ${filters.floorMin}`);
    if (filters.floorMax !== null) conditions.push(Prisma.sql`fu.floor <= ${filters.floorMax}`);

    if (options.geo) {
      const anchor = Prisma.sql`ST_SetSRID(
        ST_MakePoint(${options.geo.anchor.longitude}, ${options.geo.anchor.latitude}),
        4326
      )::geography`;
      conditions.push(Prisma.sql`o.search_point IS NOT NULL`);
      conditions.push(Prisma.sql`ST_DWithin(o.search_point, ${anchor}, ${options.geo.radiusMeters})`);
    }

    if (options.nearbyDistrictParentIds?.length) {
      const parentIds = Prisma.join(options.nearbyDistrictParentIds.map((id) => Prisma.sql`${id}::uuid`));
      conditions.push(Prisma.sql`(
        EXISTS (
          SELECT 1
          FROM locations pl
          WHERE pl.id = o.primary_location_id
            AND pl.type = 'district'::location_type
            AND pl.parent_id IN (${parentIds})
        ) OR EXISTS (
          SELECT 1
          FROM object_locations ol
          JOIN locations l ON l.id = ol.location_id
          WHERE ol.object_id = o.id
            AND l.type = 'district'::location_type
            AND l.parent_id IN (${parentIds})
        )
      )`);
    }
    if (options.catalogSearchObjectIds) {
      conditions.push(options.catalogSearchObjectIds.length > 0
        ? Prisma.sql`o.id IN (${Prisma.join(options.catalogSearchObjectIds.map((id) => Prisma.sql`${id}::uuid`))})`
        : Prisma.sql`FALSE`);
    }
    if (options.comparisonTargets?.length) {
      const targetConditions = options.comparisonTargets.flatMap((target, index) =>
        createAssistantComparisonTargetVariants(
          target,
          options.comparisonTargetModes?.[index] ?? 'EXACT',
        ).map((variant) => Prisma.sql`(
          ${createNormalizedPhraseMatch(Prisma.sql`o.title`, variant)}
          OR ${createNormalizedPhraseMatch(Prisma.sql`d.name`, variant)}
        )`));
      conditions.push(Prisma.sql`(${Prisma.join(targetConditions, ' OR ')})`);
    }
    this.applyContextConditions(conditions, context);
    return conditions;
  }

  private async resolveContextOptions(context: AssistantPageContext | null): Promise<SearchOptions> {
    if (context?.kind !== 'CATALOG_FILTERS') return {};
    const search = new URLSearchParams(context.key).get('search')?.trim() ?? '';
    if (!search) return {};
    return { catalogSearchObjectIds: await findCatalogSearchObjectIds(this.prisma, search.slice(0, 240)) };
  }

  private createDistrictCondition(district: string) {
    return Prisma.sql`(
      EXISTS (
        SELECT 1 FROM locations pl
        WHERE pl.id = o.primary_location_id
          AND pl.type = 'district'::location_type
          AND ${createNormalizedContains(Prisma.sql`pl.name`, district)}
      ) OR EXISTS (
        SELECT 1
        FROM object_locations ol
        JOIN locations l ON l.id = ol.location_id
        WHERE ol.object_id = o.id
          AND l.type = 'district'::location_type
          AND ${createNormalizedContains(Prisma.sql`l.name`, district)}
      )
    )`;
  }

  private applyContextConditions(conditions: Prisma.Sql[], context: AssistantPageContext | null) {
    if (!context) return;
    if (context.kind === 'OBJECT') {
      conditions.push(Prisma.sql`o.slug = ${context.key}`);
      return;
    }
    if (context.kind === 'LOT') {
      conditions.push(uuidPattern.test(context.key) ? Prisma.sql`fu.id = ${context.key}::uuid` : Prisma.sql`FALSE`);
      return;
    }
    if (context.kind === 'DEVELOPER') {
      conditions.push(uuidPattern.test(context.key) ? Prisma.sql`o.developer_id = ${context.key}::uuid` : Prisma.sql`FALSE`);
      return;
    }
    this.applyCatalogContextConditions(conditions, context.key);
  }

  private applyCatalogContextConditions(conditions: Prisma.Sql[], key: string) {
    const params = new URLSearchParams(key);
    addUuidListCondition(conditions, params.get('developerId'), (ids) =>
      Prisma.sql`o.developer_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`);
    addUuidListCondition(conditions, params.get('locationId'), (ids) => Prisma.sql`(
      o.primary_location_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      OR EXISTS (
        SELECT 1 FROM object_locations ol
        WHERE ol.object_id = o.id
          AND ol.location_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      )
    )`);
    addUuidListCondition(conditions, params.get('areaId'), (ids) => Prisma.sql`EXISTS (
      SELECT 1
      FROM object_locations ol
      JOIN locations l ON l.id = ol.location_id
      WHERE ol.object_id = o.id
        AND l.type = 'area'::location_type
        AND l.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    )`);
    addUuidListCondition(conditions, params.get('metroStationId'), (ids) => Prisma.sql`EXISTS (
      SELECT 1 FROM object_metro_stations oms
      WHERE oms.object_id = o.id
        AND oms.metro_station_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    )`);
    const catalogYear = parseInteger(params.get('completionYear'), 1900, 2200);
    if (catalogYear !== null) {
      conditions.push(Prisma.sql`COALESCE(fu.completion_year, o.feed_completion_year, o.completion_year) = ${catalogYear}`);
    }
    const rooms = parseIntegerList(params.get('lotRooms'), 0, 10);
    if (rooms.length > 0) conditions.push(Prisma.sql`fu.rooms IN (${Prisma.join(rooms)})`);
    const floorMinimum = parseInteger(params.get('lotFloorMin'), -20, 500);
    const floorMaximum = parseInteger(params.get('lotFloorMax'), -20, 500);
    if (floorMinimum !== null) conditions.push(Prisma.sql`fu.floor >= ${floorMinimum}`);
    if (floorMaximum !== null) conditions.push(Prisma.sql`fu.floor <= ${floorMaximum}`);
    const minimum = parseNumber(params.get('lotPriceMin'), 0, 1_000_000_000_000);
    const maximum = parseNumber(params.get('lotPriceMax'), 0, 1_000_000_000_000);
    const price = Prisma.sql`COALESCE(fu.effective_price, fu.discount_price, fu.price)`;
    if (minimum !== null) conditions.push(Prisma.sql`${price} >= ${minimum}`);
    if (maximum !== null) conditions.push(Prisma.sql`${price} <= ${maximum}`);
    const pricePerMeter = Prisma.sql`COALESCE(fu.effective_price_per_meter, fu.discount_price_per_meter, fu.price_per_meter)`;
    const pricePerMeterMinimum = parseNumber(params.get('lotPricePerMeterMin'), 0, 1_000_000_000_000);
    const pricePerMeterMaximum = parseNumber(params.get('lotPricePerMeterMax'), 0, 1_000_000_000_000);
    if (pricePerMeterMinimum !== null) conditions.push(Prisma.sql`${pricePerMeter} >= ${pricePerMeterMinimum}`);
    if (pricePerMeterMaximum !== null) conditions.push(Prisma.sql`${pricePerMeter} <= ${pricePerMeterMaximum}`);
    const objectType = params.get('type');
    if (objectType === 'RESIDENTIAL' || objectType === 'COMMERCIAL') {
      const databaseValue = objectType === 'RESIDENTIAL' ? 'residential' : 'commercial';
      conditions.push(Prisma.sql`o.type = ${databaseValue}::real_estate_object_type`);
      conditions.push(Prisma.sql`fu.type = ${databaseValue}::feed_unit_type`);
    }
    const krtName = params.get('krtName')?.trim();
    if (krtName) conditions.push(Prisma.sql`lower(o.krt_name) = lower(${krtName.slice(0, 240)})`);
  }

  private toEvidence(record: CandidateRecord): AssistantSearchEvidence | null {
    if (record.status !== FeedUnitStatus.AVAILABLE) return null;
    const priceRub = toFiniteNumber(record.effectivePrice ?? record.discountPrice ?? record.price);
    if (priceRub === null || priceRub <= 0) return null;
    const district = record.object.primaryLocation?.type === LocationType.DISTRICT
      ? record.object.primaryLocation.name
      : record.object.locations.find(({ location }) => location.type === LocationType.DISTRICT)?.location.name ?? null;
    const updatedAt = record.updatedAt;

    return {
      unitId: record.id,
      objectId: record.object.id,
      objectType: record.object.type,
      objectTitle: record.object.title,
      objectSlug: record.object.slug,
      lotTitle: record.title,
      priceRub,
      availability: 'AVAILABLE',
      updatedAt: updatedAt.toISOString(),
      rooms: record.rooms,
      district,
      metros: record.object.metroStations.map(({ metroStation }) => metroStation.name),
      developer: record.object.developer?.name ?? null,
      completionYear: record.completionYear ?? record.object.feedCompletionYear ?? record.object.completionYear,
      completionQuarter: record.completionQuarter
        ?? record.object.feedCompletionQuarter
        ?? record.object.completionQuarter,
      propertyClass: record.object.propertyClass,
      area: toFiniteNumber(record.area),
      floor: record.floor,
      latitude: toFiniteNumber(record.object.latitude),
      longitude: toFiniteNumber(record.object.longitude),
      distanceMeters: null,
      pdfs: collectPdfs(record),
      deviations: [],
    };
  }
}

function createNormalizedContains(field: Prisma.Sql, value: string) {
  const normalized = normalize(value);
  const pattern = `%${escapeLikePattern(normalized)}%`;
  return Prisma.sql`replace(lower(coalesce(${field}, '')), 'ё', 'е') LIKE ${pattern} ESCAPE '\\'`;
}

function createNormalizedPhraseMatch(field: Prisma.Sql, value: string) {
  const normalized = normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const pattern = `% ${escapeLikePattern(normalized)} %`;
  return Prisma.sql`(
    ' ' || regexp_replace(replace(lower(coalesce(${field}, '')), 'ё', 'е'), '[^[:alnum:]]+', ' ', 'g') || ' '
  ) LIKE ${pattern} ESCAPE '\\'`;
}

function collectPdfs(record: CandidateRecord) {
  const pdfs = [
    ...record.object.files.flatMap(({ type, title, file }) => isPdf(file.mimeType, file.originalName)
      ? [{
          fileId: file.id,
          title: (title?.trim() || (type === ObjectFileType.PRESENTATION ? 'Презентация проекта' : 'Планировки')),
        }]
      : []),
    ...record.media.flatMap(({ label, mediaAsset }) => mediaAsset.file
      && isPdf(mediaAsset.contentType ?? mediaAsset.file.mimeType, mediaAsset.file.originalName)
      ? [{
          fileId: mediaAsset.file.id,
          title: label?.trim() || mediaAsset.file.originalName?.trim() || 'PDF по лоту',
        }]
      : []),
  ];
  const seen = new Set<string>();
  return pdfs.filter(({ fileId }) => {
    if (seen.has(fileId)) return false;
    seen.add(fileId);
    return true;
  }).slice(0, 4);
}

function createBudgetDeviation(
  candidate: AssistantSearchEvidence,
  filters: AssistantSearchFilters,
): AssistantAlternativeDeviation | null {
  if (filters.budgetMaxRub !== null && candidate.priceRub > filters.budgetMaxRub) {
    const difference = candidate.priceRub - filters.budgetMaxRub;
    if (difference > budgetRelaxationRub) return null;
    return { type: 'BUDGET', label: `Бюджет выше на ${formatRubMillions(difference)}` };
  }
  if (filters.budgetMinRub !== null && candidate.priceRub < filters.budgetMinRub) {
    const difference = filters.budgetMinRub - candidate.priceRub;
    if (difference > budgetRelaxationRub) return null;
    return { type: 'BUDGET', label: `Бюджет ниже на ${formatRubMillions(difference)}` };
  }
  return null;
}

function formatRubMillions(value: number) {
  const millions = value / 1_000_000;
  return `${millions.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
}

function formatRooms(value: number) {
  return value === 0 ? 'студия' : `${value} ${pluralize(value, 'комната', 'комнаты', 'комнат')}`;
}

function pluralize(value: number, one: string, few: string, many: string) {
  const modulo100 = value % 100;
  const modulo10 = value % 10;
  if (modulo100 >= 11 && modulo100 <= 14) return many;
  if (modulo10 === 1) return one;
  if (modulo10 >= 2 && modulo10 <= 4) return few;
  return many;
}

function addUuidListCondition(
  conditions: Prisma.Sql[],
  value: string | null,
  createCondition: (ids: string[]) => Prisma.Sql,
) {
  if (!value) return;
  const ids = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !uuidPattern.test(id))) {
    conditions.push(Prisma.sql`FALSE`);
    return;
  }
  conditions.push(createCondition([...new Set(ids)]));
}

function parseIntegerList(value: string | null, minimum: number, maximum: number) {
  if (!value) return [];
  return [...new Set(value.split(',').flatMap((item) => {
    const parsed = parseInteger(item, minimum, maximum);
    return parsed === null ? [] : [parsed];
  }))];
}

function parseInteger(value: string | null, minimum: number, maximum: number) {
  if (value === null || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function parseNumber(value: string | null, minimum: number, maximum: number) {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function isPdf(mimeType: string | null, originalName: string | null) {
  return mimeType?.toLocaleLowerCase('en-US') === 'application/pdf'
    || originalName?.toLocaleLowerCase('en-US').endsWith('.pdf') === true;
}

function toFiniteNumber(value: { toString(): string } | number | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function containsNormalized(value: string, expected: string) {
  return normalize(value).includes(normalize(expected));
}

function normalize(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function isGeoPolygon(value: unknown): value is AssistantGeoPolygon {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const polygon = value as { type?: unknown; coordinates?: unknown };
  if (polygon.type !== 'Polygon' || !Array.isArray(polygon.coordinates) || polygon.coordinates.length !== 1) {
    return false;
  }
  const ring = polygon.coordinates[0];
  return Array.isArray(ring) && ring.length >= 4 && ring.every((coordinate) =>
    Array.isArray(coordinate)
    && coordinate.length === 2
    && coordinate.every((part) => typeof part === 'number' && Number.isFinite(part)));
}
