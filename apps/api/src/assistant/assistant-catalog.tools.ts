import { Injectable } from '@nestjs/common';
import type {
  AssistantFinishing,
  AssistantPlatformLot,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { normalizePropertyClass } from '@platforma/shared/property-class';
import { ObjectStatus, Prisma } from '@prisma/client';

import { findCatalogSearchObjectIds } from '../objects/object-search';
import { PrismaService } from '../prisma/prisma.service';

// Platforma catalog as seen by the assistant: projects by name, their facts and available lots.

const maxProjects = 8;
const maxLotsPerCall = 15;
const defaultLotsPerCall = 10;
const maxDescriptionChars = 1_500;

export const assistantFinishings: readonly AssistantFinishing[] = ['без отделки', 'white box', 'с отделкой', 'с мебелью'];

export type AssistantMetroWalk = { station: string; minutes: number };

export type AssistantProjectMatch = {
  projectId: string;
  title: string;
  slug: string;
  developer: string | null;
  district: string | null;
  metro: string[];
  address: string | null;
  propertyClass: string | null;
  nearestMetroWalk: AssistantMetroWalk | null;
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
  completionYearMin?: number;
  completionYearMax?: number;
  /** true — the completion quarter is already over, false — it is still ahead. */
  completed?: boolean;
  district?: string;
  metro?: string;
  developer?: string;
  /** Canonical classes or synonyms («элитка», «премиум»). */
  propertyClasses?: string[];
  finishing?: AssistantFinishing[];
  pricePerM2Min?: number;
  pricePerM2Max?: number;
  metroWalkMinutesMax?: number;
  commercial?: boolean;
  sort?: 'price_asc' | 'price_desc' | 'area_asc' | 'area_desc';
  limit?: number;
};

export type AssistantLotSearchResult = {
  total: number;
  lots: AssistantPlatformLot[];
  /** With a finishing filter: lots that match everything else but whose feed says nothing about finishing. */
  lotsWithoutFinishingData?: number;
};

type Range = { min: number; max: number };

export type AssistantProjectFacts = {
  projectId: string;
  title: string;
  href: string;
  propertyClass: string | null;
  developer: string | null;
  address: string | null;
  district: string | null;
  metro: string[];
  nearestMetroWalk: AssistantMetroWalk | null;
  completion: string | null;
  availableLots: number;
  priceFromRub: number | null;
  pricePerM2FromRub: number | null;
  ceilingHeight: string | null;
  lotCeilingHeightM: Range | null;
  floors: string | null;
  lotFloors: Range | null;
  areaRange: string | null;
  lotAreaM2: Range | null;
  /** Available lots per finishing; lots whose feed says nothing about it are counted apart. */
  finishing: Array<{ finishing: AssistantFinishing; lots: number }>;
  lotsWithoutFinishingData: number;
  descriptions: {
    filling: string | null;
    architecture: string | null;
    infrastructure: string | null;
    general: string | null;
  };
  cardUpdatedAt: string;
  feedUpdatedAt: string | null;
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
        propertyClass: true,
        developer: { select: { name: true } },
        primaryLocation: { select: { name: true } },
        metroStations: {
          select: { metroStation: { select: { name: true } } },
          orderBy: { sortOrder: 'asc' },
          take: 3,
        },
        assistantMetroRouteFact: metroWalkSelect,
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
        propertyClass: object.propertyClass,
        nearestMetroWalk: toMetroWalk(object.assistantMetroRouteFact),
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

  async getProjectFacts(projectId: string): Promise<AssistantProjectFacts | null> {
    if (!uuidPattern.test(projectId)) return null;
    const object = await this.prisma.realEstateObject.findFirst({
      where: { id: projectId, status: ObjectStatus.PUBLISHED, deletedAt: null },
      select: {
        id: true,
        title: true,
        slug: true,
        address: true,
        propertyClass: true,
        description: true,
        shortDescription: true,
        architectureDescription: true,
        infrastructureDescription: true,
        fillingDescription: true,
        ceilingHeight: true,
        floorRange: true,
        feedFloorRange: true,
        apartmentAreaRange: true,
        feedAreaRange: true,
        priceFrom: true,
        feedPriceFrom: true,
        pricePerMeterFrom: true,
        feedPricePerMeterFrom: true,
        completionYear: true,
        completionQuarter: true,
        feedCompletionYear: true,
        feedCompletionQuarter: true,
        updatedAt: true,
        feedUpdatedAt: true,
        developer: { select: { name: true } },
        primaryLocation: { select: { name: true } },
        metroStations: {
          select: { metroStation: { select: { name: true } } },
          orderBy: { sortOrder: 'asc' },
        },
        assistantMetroRouteFact: metroWalkSelect,
      },
    });
    if (!object) return null;

    const lotsFrom = Prisma.sql`
      FROM feed_units fu
      JOIN feed_sources fs ON fs.id = fu.source_id
      LEFT JOIN feed_residential_unit_details rd ON rd.unit_id = fu.id
      WHERE fu.object_id = ${object.id}::uuid
        AND fu.type = 'residential'::feed_unit_type
        AND ${Prisma.join(availableLotConditions, ' AND ')}
    `;
    const [statsRows, finishingRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        count: bigint;
        priceFrom: Prisma.Decimal | null;
        pricePerM2From: Prisma.Decimal | null;
        areaMin: Prisma.Decimal | null;
        areaMax: Prisma.Decimal | null;
        floorMin: number | null;
        floorMax: number | null;
        ceilingMin: Prisma.Decimal | null;
        ceilingMax: Prisma.Decimal | null;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS count,
          MIN(${lotPrice}) AS "priceFrom",
          MIN(${lotPricePerMeter}) AS "pricePerM2From",
          MIN(fu.area) AS "areaMin",
          MAX(fu.area) AS "areaMax",
          MIN(fu.floor) AS "floorMin",
          MAX(fu.floor) AS "floorMax",
          MIN(${lotCeilingHeight}) AS "ceilingMin",
          MAX(${lotCeilingHeight}) AS "ceilingMax"
        ${lotsFrom}
      `),
      this.prisma.$queryRaw<Array<{ finishing: AssistantFinishing | null; count: bigint }>>(Prisma.sql`
        SELECT ${lotFinishing} AS finishing, COUNT(*)::bigint AS count
        ${lotsFrom}
        GROUP BY 1
      `),
    ]);
    const stats = statsRows[0];
    const finishing = finishingRows
      .flatMap((row) => row.finishing ? [{ finishing: row.finishing, lots: Number(row.count) }] : [])
      .sort((left, right) => right.lots - left.lots);

    return {
      projectId: object.id,
      title: object.title,
      href: `/objects/${encodeURIComponent(object.slug)}`,
      propertyClass: object.propertyClass,
      developer: object.developer?.name ?? null,
      address: object.address,
      district: object.primaryLocation?.name ?? null,
      metro: object.metroStations.map(({ metroStation }) => metroStation.name),
      nearestMetroWalk: toMetroWalk(object.assistantMetroRouteFact),
      completion: formatCompletion(
        object.feedCompletionYear ?? object.completionYear,
        object.feedCompletionYear ? object.feedCompletionQuarter : object.completionQuarter,
      ),
      availableLots: Number(stats?.count ?? 0),
      priceFromRub: toNumber(stats?.priceFrom ?? object.feedPriceFrom ?? object.priceFrom),
      pricePerM2FromRub: toNumber(stats?.pricePerM2From ?? object.feedPricePerMeterFrom ?? object.pricePerMeterFrom),
      ceilingHeight: object.ceilingHeight,
      lotCeilingHeightM: toRange(stats?.ceilingMin, stats?.ceilingMax),
      floors: object.floorRange ?? object.feedFloorRange,
      lotFloors: toRange(stats?.floorMin, stats?.floorMax),
      areaRange: object.apartmentAreaRange ?? object.feedAreaRange,
      lotAreaM2: toRange(stats?.areaMin, stats?.areaMax),
      finishing,
      lotsWithoutFinishingData: Number(finishingRows.find((row) => row.finishing === null)?.count ?? 0),
      descriptions: {
        filling: clip(object.fillingDescription),
        architecture: clip(object.architectureDescription),
        infrastructure: clip(object.infrastructureDescription),
        general: clip(object.description ?? object.shortDescription),
      },
      cardUpdatedAt: object.updatedAt.toISOString(),
      feedUpdatedAt: object.feedUpdatedAt?.toISOString() ?? null,
    };
  }

  async searchLots(input: AssistantLotSearchInput, now = new Date()): Promise<AssistantLotSearchResult> {
    const conditions = createLotConditions(input, now);
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? defaultLotsPerCall), 1), maxLotsPerCall);
    const orderBy = {
      price_asc: Prisma.sql`${lotPrice} ASC`,
      price_desc: Prisma.sql`${lotPrice} DESC`,
      area_asc: Prisma.sql`fu.area ASC NULLS LAST`,
      area_desc: Prisma.sql`fu.area DESC NULLS LAST`,
    }[input.sort ?? 'price_asc'] ?? Prisma.sql`${lotPrice} ASC`;
    const from = lotSearchFrom(conditions);
    const withoutFinishingFrom = input.finishing?.length
      ? lotSearchFrom([...createLotConditions({ ...input, finishing: undefined }, now), Prisma.sql`${lotFinishing} IS NULL`])
      : null;

    const [countRows, withoutFinishingRows, rows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${from}`),
      withoutFinishingFrom
        ? this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${withoutFinishingFrom}`)
        : Promise.resolve(null),
      this.prisma.$queryRaw<LotRow[]>(Prisma.sql`
        SELECT
          fu.id::text AS id,
          o.title AS "projectTitle",
          o.slug AS "projectSlug",
          o.property_class AS "propertyClass",
          d.name AS developer,
          fu.rooms,
          fu.area,
          fu.floor,
          ${lotPrice} AS price,
          ${lotPricePerMeter} AS "pricePerMeter",
          ${lotFinishing} AS finishing,
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
      ...(withoutFinishingRows ? { lotsWithoutFinishingData: Number(withoutFinishingRows[0]?.count ?? 0) } : {}),
    };
  }
}

type LotRow = {
  id: string;
  projectTitle: string;
  projectSlug: string;
  propertyClass: string | null;
  developer: string | null;
  rooms: number | null;
  area: Prisma.Decimal | null;
  floor: number | null;
  price: Prisma.Decimal;
  pricePerMeter: Prisma.Decimal | null;
  finishing: AssistantFinishing | null;
  building: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  updatedAt: Date;
};

const lotPrice = Prisma.sql`COALESCE(fu.effective_price, fu.discount_price, fu.price)`;
const lotPricePerMeter = Prisma.sql`COALESCE(fu.effective_price_per_meter, fu.discount_price_per_meter, fu.price_per_meter)`;
const lotCompletionYear = Prisma.sql`COALESCE(fu.completion_year, o.feed_completion_year, o.completion_year)`;
const lotCompletionQuarter = Prisma.sql`COALESCE(fu.completion_quarter, o.feed_completion_quarter, o.completion_quarter)`;
const lotCeilingHeight = Prisma.sql`CASE
  WHEN rd.details_json->>'ceilingHeight' ~ '^[0-9]+([.,][0-9]+)?$'
  THEN replace(rd.details_json->>'ceilingHeight', ',', '.')::numeric
END`;

// Feeds describe finishing in their own words; every value seen in the feeds (checked on
// 2026-09-26) maps to one of four answers. FSK sends codes: 0 — без отделки, 30 — предчистовая
// (matched against fsk.ru), 10 — чистовая (not confirmed on the site yet).
const finishingByFeedValue: ReadonlyArray<readonly [string, AssistantFinishing]> = [
  ['без отделки', 'без отделки'],
  ['черновая отделка', 'без отделки'],
  ['требуетремонта', 'без отделки'],
  ['0', 'без отделки'],
  ['whitebox', 'white box'],
  ['white box', 'white box'],
  ['wb', 'white box'],
  ['предчистовая отделка', 'white box'],
  ['30', 'white box'],
  ['чистовая отделка', 'с отделкой'],
  ['с отделкой', 'с отделкой'],
  ['отделка', 'с отделкой'],
  ['под ключ', 'с отделкой'],
  ['10', 'с отделкой'],
];

// Needs `rd` (feed_residential_unit_details) joined to `fu`.
const lotFinishing = Prisma.sql`(CASE
  WHEN fu.raw_payload->>'@_Furniture' = '1' THEN 'с мебелью'
  ELSE CASE lower(btrim(COALESCE(NULLIF(rd.details_json->>'decoration', ''), rd.details_json->>'renovation')))
    ${Prisma.join(finishingByFeedValue.map(([value, finishing]) => Prisma.sql`WHEN ${value} THEN ${finishing}`), ' ')}
  END
END)`;

const availableLotConditions = [
  Prisma.sql`fu.status = 'available'::feed_unit_status`,
  Prisma.sql`fu.archived_at IS NULL`,
  Prisma.sql`${lotPrice} > 0`,
  Prisma.sql`fs.deleted_at IS NULL`,
  Prisma.sql`fs.is_active = TRUE`,
];

const metroWalkSelect = {
  select: { durationSeconds: true, metroAccessPoint: { select: { stationName: true } } },
} as const;

function lotSearchFrom(conditions: Prisma.Sql[]) {
  return Prisma.sql`
    FROM feed_units fu
    JOIN feed_sources fs ON fs.id = fu.source_id
    JOIN real_estate_objects o ON o.id = fu.object_id
    LEFT JOIN developers d ON d.id = o.developer_id
    LEFT JOIN feed_residential_unit_details rd ON rd.unit_id = fu.id
    WHERE ${Prisma.join(conditions, ' AND ')}
  `;
}

function createLotConditions(input: AssistantLotSearchInput, now: Date) {
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
  if (isNumber(input.completionYearMin)) {
    conditions.push(Prisma.sql`${lotCompletionYear} >= ${Math.trunc(input.completionYearMin)}`);
  }
  if (isNumber(input.completionYearMax)) {
    conditions.push(Prisma.sql`${lotCompletionYear} <= ${Math.trunc(input.completionYearMax)}`);
  }
  if (typeof input.completed === 'boolean') {
    // A quarter counts as over once the next one has started in Moscow (UTC+3, no DST);
    // a year without a quarter ends in Q4.
    const moscow = new Date(now.getTime() + 3 * 60 * 60_000);
    const currentQuarter = moscow.getUTCFullYear() * 10 + Math.floor(moscow.getUTCMonth() / 3) + 1;
    const lotQuarter = Prisma.sql`(${lotCompletionYear} * 10 + COALESCE(${lotCompletionQuarter}, 4))`;
    conditions.push(input.completed
      ? Prisma.sql`${lotQuarter} < ${currentQuarter}`
      : Prisma.sql`${lotQuarter} >= ${currentQuarter}`);
  }
  if (isNumber(input.pricePerM2Min)) conditions.push(Prisma.sql`${lotPricePerMeter} >= ${input.pricePerM2Min}`);
  if (isNumber(input.pricePerM2Max)) conditions.push(Prisma.sql`${lotPricePerMeter} <= ${input.pricePerM2Max}`);
  if (input.propertyClasses?.length) {
    const classes = normalizePropertyClasses(input.propertyClasses);
    conditions.push(classes.length ? Prisma.sql`o.property_class IN (${Prisma.join(classes)})` : Prisma.sql`FALSE`);
  }
  if (input.finishing?.length) {
    const finishing = [...new Set(input.finishing.filter((value) => assistantFinishings.includes(value)))];
    // A furnished lot is finished too.
    if (finishing.includes('с отделкой') && !finishing.includes('с мебелью')) finishing.push('с мебелью');
    conditions.push(finishing.length ? Prisma.sql`${lotFinishing} IN (${Prisma.join(finishing)})` : Prisma.sql`FALSE`);
  }
  if (isNumber(input.metroWalkMinutesMax)) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM assistant_object_metro_route_facts mf
      WHERE mf.object_id = o.id AND mf.duration_seconds <= ${Math.round(input.metroWalkMinutesMax * 60)}
    )`);
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

export function normalizePropertyClasses(values: string[]) {
  return [...new Set(values.flatMap((value) => normalizePropertyClass(value) ?? []))];
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
    propertyClass: row.propertyClass,
    rooms: row.rooms,
    areaM2: row.area === null ? null : Number(row.area),
    floor: row.floor,
    priceRub: Number(row.price),
    pricePerM2Rub: row.pricePerMeter === null ? null : Math.round(Number(row.pricePerMeter)),
    finishing: row.finishing,
    building: row.building,
    completion: formatCompletion(row.completionYear, row.completionQuarter),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMetroWalk(fact: { durationSeconds: number; metroAccessPoint: { stationName: string } } | null): AssistantMetroWalk | null {
  return fact ? { station: fact.metroAccessPoint.stationName, minutes: Math.max(1, Math.round(fact.durationSeconds / 60)) } : null;
}

function toNumber(value: Prisma.Decimal | number | null | undefined) {
  return value === null || value === undefined ? null : Math.round(Number(value));
}

function toRange(min: Prisma.Decimal | number | null | undefined, max: Prisma.Decimal | number | null | undefined): Range | null {
  if (min === null || min === undefined || max === null || max === undefined) return null;
  return { min: Number(min), max: Number(max) };
}

// Cuts long card texts at a sentence or word boundary so the prompt stays small.
function clip(value: string | null) {
  const text = value?.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  if (text.length <= maxDescriptionChars) return text;
  const cut = text.slice(0, maxDescriptionChars);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${cut.slice(0, boundary > maxDescriptionChars * 0.6 ? boundary + 1 : maxDescriptionChars).trim()}…`;
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
