import { Injectable } from '@nestjs/common';
import {
  LocationType,
  ObjectFileType,
  ObjectStatus,
  Prisma,
  RealEstateObjectType,
} from '@prisma/client';
import type { AssistantPageContext } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { findCatalogSearchObjectIds } from '../../objects/object-search';
import { PrismaService } from '../../prisma/prisma.service';
import type { AssistantStructuredIntent } from '../assistant-query-planner';
import {
  createEmptyAssistantSearchFilters,
  extractAssistantExplicitHardFilters,
} from '../assistant-query-planner';
import {
  extractAssistantKnowledgeProjectReferenceClause,
  hasExplicitAssistantKnowledgeProjectReference,
} from '../sources/assistant-knowledge-policy';
import type { AssistantObjectEvidence } from './assistant-object-answer';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/iu;
const commercialPattern = /(?:коммерческ\p{L}*|бц|бизнес[- ]центр|мфк)/iu;
const residentialPattern = /(?:жк|жилой\s+комплекс|жил\p{L}*\s+объект\p{L}*)/iu;

const objectSelect = {
  id: true,
  type: true,
  title: true,
  slug: true,
  description: true,
  architectureDescription: true,
  infrastructureDescription: true,
  fillingDescription: true,
  completionYear: true,
  completionQuarter: true,
  propertyClass: true,
  address: true,
  latitude: true,
  longitude: true,
  updatedAt: true,
  developer: { select: { name: true } },
  primaryLocation: { select: { name: true, type: true } },
  locations: {
    select: { location: { select: { name: true, type: true } } },
    orderBy: [{ sortOrder: 'asc' as const }, { locationId: 'asc' as const }],
  },
  metroStations: {
    select: { metroStation: { select: { name: true } } },
    orderBy: [{ sortOrder: 'asc' as const }, { metroStationId: 'asc' as const }],
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
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.RealEstateObjectSelect;

type ObjectRecord = Prisma.RealEstateObjectGetPayload<{ select: typeof objectSelect }>;

export type AssistantPlatformCatalogResult = {
  evidence: AssistantObjectEvidence[];
  totalObjects: number;
};

@Injectable()
export class AssistantPlatformCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async ground(input: {
    query: string;
    intent: AssistantStructuredIntent;
    context: AssistantPageContext | null;
  }): Promise<AssistantPlatformCatalogResult> {
    const reference = explicitProjectReference(input.query);
    const where = await this.createWhere(input, reference);

    if (reference) {
      const candidates = await this.prisma.realEstateObject.findMany({
        where,
        select: objectSelect,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
      });
      const exact = candidates.filter((candidate) => objectMatchesReference(candidate, reference));
      return {
        evidence: exact.slice(0, 8).map(toEvidence),
        totalObjects: exact.length,
      };
    }

    const [totalObjects, records] = await this.prisma.$transaction([
      this.prisma.realEstateObject.count({ where }),
      this.prisma.realEstateObject.findMany({
        where,
        select: objectSelect,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        take: 8,
      }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return {
      evidence: records.map(toEvidence),
      totalObjects,
    };
  }

  private async createWhere(
    input: {
      query: string;
      intent: AssistantStructuredIntent;
      context: AssistantPageContext | null;
    },
    reference: string | null,
  ): Promise<Prisma.RealEstateObjectWhereInput> {
    const filters: Prisma.RealEstateObjectWhereInput[] = [{
      status: ObjectStatus.PUBLISHED,
      archivedAt: null,
      deletedAt: null,
    }];
    const objectType = explicitObjectType(input.query, reference ? null : input.context);
    if (objectType) filters.push({ type: objectType });

    const hardFilters = reference
      ? {
          ...createEmptyAssistantSearchFilters(),
          ...extractAssistantExplicitHardFilters([input.query]),
        }
      : input.intent.hardFilters;
    if (hardFilters.developer) {
      filters.push({ developer: { name: { contains: hardFilters.developer, mode: 'insensitive' } } });
    }
    if (hardFilters.district) {
      filters.push({ OR: [
        {
          primaryLocation: {
            type: LocationType.DISTRICT,
            name: { contains: hardFilters.district, mode: 'insensitive' },
          },
        },
        {
          locations: { some: { location: {
            type: LocationType.DISTRICT,
            name: { contains: hardFilters.district, mode: 'insensitive' },
          } } },
        },
      ] });
    }
    if (hardFilters.metro) {
      filters.push({ metroStations: { some: {
        metroStation: { name: { contains: hardFilters.metro, mode: 'insensitive' } },
      } } });
    }
    if (hardFilters.completionYearMin !== null || hardFilters.completionYearMax !== null) {
      filters.push({ completionYear: {
        ...(hardFilters.completionYearMin !== null ? { gte: hardFilters.completionYearMin } : {}),
        ...(hardFilters.completionYearMax !== null ? { lte: hardFilters.completionYearMax } : {}),
      } });
    }
    if (hardFilters.completionQuarter !== null) {
      filters.push({ completionQuarter: hardFilters.completionQuarter });
    }
    if (hardFilters.propertyClass) {
      filters.push({ propertyClass: { contains: hardFilters.propertyClass, mode: 'insensitive' } });
    }

    if (reference) {
      const searchObjectIds = await findCatalogSearchObjectIds(this.prisma, reference);
      filters.push({ id: { in: searchObjectIds } });
    }
    if (!reference) await this.addContextFilters(filters, input.context);
    return { AND: filters };
  }

  private async addContextFilters(
    filters: Prisma.RealEstateObjectWhereInput[],
    context: AssistantPageContext | null,
  ) {
    if (!context) return;
    if (context.kind === 'OBJECT') {
      filters.push(uuidPattern.test(context.key)
        ? { id: context.key }
        : { slug: context.key });
      return;
    }
    if (context.kind === 'DEVELOPER') {
      filters.push(uuidPattern.test(context.key)
        ? { developerId: context.key }
        : { id: { in: [] } });
      return;
    }
    if (context.kind === 'LOT' && uuidPattern.test(context.key)) {
      filters.push({ feedUnits: { some: { id: context.key } } });
      return;
    }
    if (context.kind !== 'CATALOG_FILTERS') return;

    const params = new URLSearchParams(context.key);
    const search = boundedParam(params.get('search'));
    if (search) {
      const searchObjectIds = await findCatalogSearchObjectIds(this.prisma, search);
      filters.push({ id: { in: searchObjectIds } });
    }
    const developerIds = uuidParams(params, 'developerId');
    if (developerIds.length > 0) filters.push({ developerId: { in: developerIds } });
    const locationIds = [...uuidParams(params, 'locationId'), ...uuidParams(params, 'areaId')];
    if (locationIds.length > 0) {
      filters.push({ OR: [
        { primaryLocationId: { in: locationIds } },
        { locations: { some: { locationId: { in: locationIds } } } },
      ] });
    }
    const metroStationIds = uuidParams(params, 'metroStationId');
    if (metroStationIds.length > 0) {
      filters.push({ metroStations: { some: { metroStationId: { in: metroStationIds } } } });
    }
    const krtName = boundedParam(params.get('krtName'));
    if (krtName) filters.push({ krtName: { equals: krtName, mode: 'insensitive' } });
    const completionYear = boundedInteger(params.get('completionYear'), 1900, 2200);
    if (completionYear !== null) filters.push({ completionYear });
  }
}

function explicitObjectType(query: string, context: AssistantPageContext | null) {
  if (commercialPattern.test(query)) return RealEstateObjectType.COMMERCIAL;
  if (residentialPattern.test(query)) return RealEstateObjectType.RESIDENTIAL;
  if (context?.kind === 'CATALOG_FILTERS') {
    const value = new URLSearchParams(context.key).get('type');
    if (value === RealEstateObjectType.COMMERCIAL || value === RealEstateObjectType.RESIDENTIAL) return value;
  }
  return null;
}

function explicitProjectReference(query: string) {
  if (hasExplicitAssistantKnowledgeProjectReference(query)) {
    return extractAssistantKnowledgeProjectReferenceClause(query);
  }
  const match = query.match(
    /(?:^|[^\p{L}\p{N}])(?<marker>бц|бизнес[- ]центр|мфк|проект|объект)(?![\p{L}\p{N}])\s+(?<reference>[^\n\r?!.,;:]{1,180})/iu,
  );
  const rawReference = match?.groups?.reference?.trim();
  if (!rawReference) return null;
  const delimited = rawReference.match(
    /^(?:«([^»]{1,180})»|“([^”]{1,180})”|„([^“]{1,180})“|"([^"]{1,180})"|'([^']{1,180})'|\(([^)]{1,180})\))/u,
  );
  const candidate = delimited?.slice(1).find((value) => value !== undefined)?.trim()
    ?? rawReference;
  const normalized = candidate.replace(/\s+/gu, ' ').trim();
  const marker = match?.groups?.marker ?? '';
  return normalized.length > 0
    && normalized.length <= 180
    && (delimited !== null
      || /^(?:бц|бизнес[- ]центр|мфк)$/iu.test(marker)
      || /^\p{Lu}/u.test(normalized))
    ? normalized
    : null;
}

function objectMatchesReference(record: ObjectRecord, reference: string) {
  const normalizedReference = normalizeObjectIdentity(reference);
  return normalizeObjectIdentity(record.title) === normalizedReference
    || normalizeObjectIdentity(record.slug) === normalizedReference;
}

function normalizeObjectIdentity(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(/^(?:жк|жилой\s+комплекс|бц|бизнес[- ]центр|мфк)\s+/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function toEvidence(record: ObjectRecord): AssistantObjectEvidence {
  const districts = uniqueText([
    record.primaryLocation?.type === LocationType.DISTRICT ? record.primaryLocation.name : null,
    ...record.locations.map(({ location }) => location.type === LocationType.DISTRICT ? location.name : null),
  ]);
  return {
    evidenceType: 'PLATFORMA_OBJECT',
    objectId: record.id,
    objectType: record.type,
    title: record.title,
    slug: record.slug,
    description: cleanText(record.description),
    architectureDescription: cleanText(record.architectureDescription),
    infrastructureDescription: cleanText(record.infrastructureDescription),
    fillingDescription: cleanText(record.fillingDescription),
    developer: cleanText(record.developer?.name ?? null),
    districts,
    metros: uniqueText(record.metroStations.map(({ metroStation }) => metroStation.name)),
    completionYear: record.completionYear,
    completionQuarter: record.completionQuarter,
    propertyClass: cleanText(record.propertyClass),
    address: cleanText(record.address),
    latitude: record.latitude === null ? null : Number(record.latitude),
    longitude: record.longitude === null ? null : Number(record.longitude),
    pdfs: record.files.map(({ type, title, file }) => ({
      fileId: file.id,
      title: cleanText(title)
        ?? (type === ObjectFileType.PRESENTATION ? 'Презентация проекта' : 'Планировки'),
    })),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function cleanText(value: string | null) {
  const normalized = value?.replace(/\s+/gu, ' ').trim() ?? '';
  return normalized || null;
}

function uniqueText(values: Array<string | null>) {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return [];
    const key = cleaned.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
    if (seen.has(key)) return [];
    seen.add(key);
    return [cleaned];
  });
}

function boundedParam(value: string | null) {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 && normalized.length <= 300 ? normalized : null;
}

function boundedInteger(value: string | null, minimum: number, maximum: number) {
  if (!value || !/^-?\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function uuidParams(params: URLSearchParams, key: string) {
  return [...new Set(params.getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => uuidPattern.test(value)))];
}
