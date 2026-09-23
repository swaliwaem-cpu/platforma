import { Injectable } from '@nestjs/common';
import type { AssistantPlatformLot } from '@platforma/shared' with { 'resolution-mode': 'import' };
import { ObjectStatus, Prisma } from '@prisma/client';

import { findCatalogSearchObjectIds } from '../objects/object-search';
import { PrismaService } from '../prisma/prisma.service';

// Platforma catalog as seen by the assistant: projects by name and their available lots.

const maxProjects = 8;
const maxLotsPerCall = 15;
const defaultLotsPerCall = 10;

export type AssistantProjectMatch = {
  projectId: string;
  title: string;
  slug: string;
  developer: string | null;
  district: string | null;
  metro: string[];
  address: string | null;
  availableLots: number;
  priceFromRub: number | null;
  roomsAvailable: number[];
};

export type AssistantLotSearchInput = {
  projectIds?: string[];
  rooms?: number[];
  budgetMinRub?: number;
  budgetMaxRub?: number;
  areaMin?: number;
  areaMax?: number;
  floorMin?: number;
  floorMax?: number;
  completionYearMax?: number;
  district?: string;
  metro?: string;
  developer?: string;
  commercial?: boolean;
  sort?: 'price_asc' | 'price_desc' | 'area_asc' | 'area_desc';
  limit?: number;
};

export type AssistantLotSearchResult = {
  total: number;
  lots: AssistantPlatformLot[];
};

@Injectable()
export class AssistantCatalogTools {
  constructor(private readonly prisma: PrismaService) {}

  async findProjects(query: string): Promise<{ projects: AssistantProjectMatch[]; partialMatch: boolean }> {
    const reference = stripProjectPrefix(query);
    if (!reference) return { projects: [], partialMatch: false };

    let ids = await findCatalogSearchObjectIds(this.prisma, reference);
    let partialMatch = false;
    if (ids.length === 0) {
      const longestWord = reference.split(/\s+/u).sort((left, right) => right.length - left.length)[0] ?? '';
      if (longestWord.length >= 4 && longestWord !== reference) {
        ids = await findCatalogSearchObjectIds(this.prisma, longestWord);
        partialMatch = ids.length > 0;
      }
    }
    if (ids.length === 0) return { projects: [], partialMatch: false };

    const objects = await this.prisma.realEstateObject.findMany({
      where: { id: { in: ids }, status: ObjectStatus.PUBLISHED, deletedAt: null },
      select: {
        id: true,
        title: true,
        slug: true,
        address: true,
        developer: { select: { name: true } },
        primaryLocation: { select: { name: true } },
        metroStations: {
          select: { metroStation: { select: { name: true } } },
          orderBy: { sortOrder: 'asc' },
          take: 3,
        },
      },
      take: 60,
    });
    if (objects.length === 0) return { projects: [], partialMatch: false };

    const stats = await this.prisma.$queryRaw<Array<{
      objectId: string;
      count: bigint;
      priceFrom: Prisma.Decimal | null;
      rooms: number[] | null;
    }>>(Prisma.sql`
      SELECT
        fu.object_id::text AS "objectId",
        COUNT(*)::bigint AS count,
        MIN(${lotPrice}) AS "priceFrom",
        ARRAY_AGG(DISTINCT fu.rooms) FILTER (WHERE fu.rooms IS NOT NULL) AS rooms
      FROM feed_units fu
      JOIN feed_sources fs ON fs.id = fu.source_id
      WHERE fu.object_id IN (${Prisma.join(objects.map(({ id }) => Prisma.sql`${id}::uuid`))})
        AND ${Prisma.join(availableLotConditions, ' AND ')}
      GROUP BY fu.object_id
    `);
    const statsByObjectId = new Map(stats.map((row) => [row.objectId, row]));
    const normalizedReference = normalizeTitle(reference);

    const projects = objects.map((object): AssistantProjectMatch & { rank: number } => {
      const stat = statsByObjectId.get(object.id);
      const title = normalizeTitle(object.title);
      return {
        projectId: object.id,
        title: object.title,
        slug: object.slug,
        developer: object.developer?.name ?? null,
        district: object.primaryLocation?.name ?? null,
        metro: object.metroStations.map(({ metroStation }) => metroStation.name),
        address: object.address,
        availableLots: Number(stat?.count ?? 0),
        priceFromRub: stat?.priceFrom ? Number(stat.priceFrom) : null,
        roomsAvailable: [...(stat?.rooms ?? [])].sort((left, right) => left - right),
        rank: title === normalizedReference ? 0 : title.includes(normalizedReference) ? 1 : 2,
      };
    });
    projects.sort((left, right) => left.rank - right.rank || right.availableLots - left.availableLots);
    return {
      projects: projects.slice(0, maxProjects).map(({ rank: _rank, ...project }) => project),
      partialMatch,
    };
  }

  async searchLots(input: AssistantLotSearchInput): Promise<AssistantLotSearchResult> {
    const conditions = createLotConditions(input);
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? defaultLotsPerCall), 1), maxLotsPerCall);
    const orderBy = {
      price_asc: Prisma.sql`${lotPrice} ASC`,
      price_desc: Prisma.sql`${lotPrice} DESC`,
      area_asc: Prisma.sql`fu.area ASC NULLS LAST`,
      area_desc: Prisma.sql`fu.area DESC NULLS LAST`,
    }[input.sort ?? 'price_asc'] ?? Prisma.sql`${lotPrice} ASC`;
    const from = Prisma.sql`
      FROM feed_units fu
      JOIN feed_sources fs ON fs.id = fu.source_id
      JOIN real_estate_objects o ON o.id = fu.object_id
      LEFT JOIN developers d ON d.id = o.developer_id
      WHERE ${Prisma.join(conditions, ' AND ')}
    `;

    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${from}`),
      this.prisma.$queryRaw<LotRow[]>(Prisma.sql`
        SELECT
          fu.id::text AS id,
          o.title AS "projectTitle",
          o.slug AS "projectSlug",
          d.name AS developer,
          fu.rooms,
          fu.area,
          fu.floor,
          ${lotPrice} AS price,
          fu.building,
          COALESCE(fu.completion_year, o.feed_completion_year, o.completion_year) AS "completionYear",
          COALESCE(fu.completion_quarter, o.feed_completion_quarter, o.completion_quarter) AS "completionQuarter",
          fu.updated_at AS "updatedAt"
        ${from}
        ORDER BY ${orderBy}, fu.id
        LIMIT ${limit}
      `),
    ]);

    return {
      total: Number(countRows[0]?.count ?? 0),
      lots: rows.map(toPlatformLot),
    };
  }
}

type LotRow = {
  id: string;
  projectTitle: string;
  projectSlug: string;
  developer: string | null;
  rooms: number | null;
  area: Prisma.Decimal | null;
  floor: number | null;
  price: Prisma.Decimal;
  building: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  updatedAt: Date;
};

const lotPrice = Prisma.sql`COALESCE(fu.effective_price, fu.discount_price, fu.price)`;

const availableLotConditions = [
  Prisma.sql`fu.status = 'available'::feed_unit_status`,
  Prisma.sql`fu.archived_at IS NULL`,
  Prisma.sql`${lotPrice} > 0`,
  Prisma.sql`fs.deleted_at IS NULL`,
  Prisma.sql`fs.is_active = TRUE`,
];

function createLotConditions(input: AssistantLotSearchInput) {
  const type = input.commercial ? 'commercial' : 'residential';
  const conditions = [
    ...availableLotConditions,
    Prisma.sql`o.status = 'published'::object_status`,
    Prisma.sql`o.deleted_at IS NULL`,
    Prisma.sql`fu.type = ${type}::feed_unit_type`,
  ];
  const projectIds = (input.projectIds ?? []).filter((id) => uuidPattern.test(id)).slice(0, 20);
  if (input.projectIds?.length) {
    conditions.push(projectIds.length
      ? Prisma.sql`o.id IN (${Prisma.join(projectIds.map((id) => Prisma.sql`${id}::uuid`))})`
      : Prisma.sql`FALSE`);
  }
  const rooms = (input.rooms ?? []).filter((value) => Number.isInteger(value) && value >= 0 && value <= 10);
  if (rooms.length) conditions.push(Prisma.sql`fu.rooms IN (${Prisma.join(rooms)})`);
  if (isNumber(input.budgetMinRub)) conditions.push(Prisma.sql`${lotPrice} >= ${input.budgetMinRub}`);
  if (isNumber(input.budgetMaxRub)) conditions.push(Prisma.sql`${lotPrice} <= ${input.budgetMaxRub}`);
  if (isNumber(input.areaMin)) conditions.push(Prisma.sql`fu.area >= ${input.areaMin}`);
  if (isNumber(input.areaMax)) conditions.push(Prisma.sql`fu.area <= ${input.areaMax}`);
  if (isNumber(input.floorMin)) conditions.push(Prisma.sql`fu.floor >= ${Math.trunc(input.floorMin)}`);
  if (isNumber(input.floorMax)) conditions.push(Prisma.sql`fu.floor <= ${Math.trunc(input.floorMax)}`);
  if (isNumber(input.completionYearMax)) {
    conditions.push(Prisma.sql`COALESCE(fu.completion_year, o.feed_completion_year, o.completion_year) <= ${Math.trunc(input.completionYearMax)}`);
  }
  const district = cleanText(input.district);
  if (district) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM locations l
      WHERE (l.id = o.primary_location_id OR l.id IN (SELECT ol.location_id FROM object_locations ol WHERE ol.object_id = o.id))
        AND ${normalizedContains(Prisma.sql`l.name`, district)}
    )`);
  }
  const metro = cleanText(input.metro);
  if (metro) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM object_metro_stations oms
      JOIN metro_stations ms ON ms.id = oms.metro_station_id
      WHERE oms.object_id = o.id AND ${normalizedContains(Prisma.sql`ms.name`, metro)}
    )`);
  }
  const developer = cleanText(input.developer);
  if (developer) conditions.push(normalizedContains(Prisma.sql`d.name`, developer));
  return conditions;
}

function toPlatformLot(row: LotRow): AssistantPlatformLot {
  const projectHref = `/objects/${encodeURIComponent(row.projectSlug)}`;
  return {
    source: 'PLATFORMA',
    unitId: row.id,
    projectTitle: row.projectTitle,
    href: `${projectHref}/lots/${encodeURIComponent(row.id)}`,
    projectHref,
    developer: row.developer,
    rooms: row.rooms,
    areaM2: row.area === null ? null : Number(row.area),
    floor: row.floor,
    priceRub: Number(row.price),
    building: row.building,
    completion: formatCompletion(row.completionYear, row.completionQuarter),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatCompletion(year: number | null, quarter: number | null) {
  if (!year) return null;
  return quarter ? `${quarter} кв. ${year}` : String(year);
}

function normalizedContains(field: Prisma.Sql, value: string) {
  const pattern = `%${normalizeText(value).replace(/[\\%_]/gu, '\\$&')}%`;
  return Prisma.sql`replace(lower(coalesce(${field}, '')), 'ё', 'е') LIKE ${pattern} ESCAPE '\\'`;
}

const projectPrefixPattern =
  /^(?:жк|ж\/к|жилой\s+комплекс|жилой\s+квартал|квартал|клубный\s+дом|клубный\s+квартал|дом|резиденция|апарт-?комплекс|мфк|бц)\s+/iu;

export function stripProjectPrefix(value: string) {
  const trimmed = value.replace(/[«»"“”„]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return trimmed.replace(projectPrefixPattern, '').trim() || trimmed;
}

function normalizeTitle(value: string) {
  return normalizeText(stripProjectPrefix(value)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').trim();
}

function cleanText(value: string | undefined) {
  const normalized = value?.replace(/\s+/gu, ' ').trim() ?? '';
  return normalized.length > 0 && normalized.length <= 120 ? normalized : null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
