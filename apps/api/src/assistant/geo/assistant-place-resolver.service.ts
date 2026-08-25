import { createHash } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import { AssistantKnowledgeSourceState, AssistantSourceFactKind, Prisma } from '@prisma/client';
import type {
  AssistantGeoCandidate,
  AssistantGeoResolution,
  AssistantGeoResolveInput,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';
import { parseAssistantGeoSearchInput } from './assistant-geo-contract';
import { AssistantGeoProviderError } from './assistant-geo-provider';
import { AssistantGeoProviderPolicyService } from './assistant-geo-provider-policy.service';

type ParsedResolveInput = {
  placeQuery: string;
  radiusMeters: number | null;
  locale: string;
  country: string | null;
  viewbox: [number, number, number, number] | null;
};

@Injectable()
export class AssistantPlaceResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AssistantGeoProviderPolicyService,
  ) {}

  async resolve(body: unknown): Promise<AssistantGeoResolution> {
    const input = parseResolveInput(body);
    if (!input) return { status: 'NOT_APPLICABLE' };
    if (input.radiusMeters === null) {
      return { status: 'RADIUS_REQUIRED', placeQuery: input.placeQuery, actions: ['REFINE'] };
    }

    const alias = await this.findAlias(input);
    if (alias) return resolved(input, [alias]);

    const cacheKey = createCacheKey(input);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      const candidates = cached.map((candidate) => ({ ...candidate, source: 'PLACE' as const }));
      if (candidates.length > 0) return resolved(input, candidates);
      return this.resolveFromKnowledgeOrNotFound(input);
    }

    try {
      const providerCandidates = await this.provider.search({
        query: input.placeQuery,
        locale: input.locale,
        country: input.country,
        viewbox: input.viewbox,
      });
      await this.writeCache(cacheKey, input, providerCandidates);
      if (providerCandidates.length > 0) {
        return resolved(input, providerCandidates.map((candidate) => ({
          ...candidate,
          source: 'PLACE' as const,
        })));
      }
      return this.resolveFromKnowledgeOrNotFound(input);
    } catch (error) {
      if (!(error instanceof AssistantGeoProviderError)) throw error;
      const knowledge = await this.findKnowledgeAddresses(input.placeQuery);
      return knowledge.length > 0
        ? resolved(input, knowledge)
        : unavailable(input);
    }
  }

  private async findAlias(input: ParsedResolveInput): Promise<AssistantGeoCandidate | null> {
    const alias = await this.prisma.assistantGeoAlias.findUnique({
      where: {
        normalizedQuery_locale_country: {
          normalizedQuery: normalizePlaceQuery(input.placeQuery),
          locale: input.locale,
          country: input.country ?? '',
        },
      },
    });
    return alias ? {
      id: alias.id,
      label: alias.label,
      latitude: Number(alias.latitude),
      longitude: Number(alias.longitude),
      city: alias.city,
      countryCode: alias.countryCode,
      source: 'ALIAS',
    } : null;
  }

  private async readCache(cacheKey: string) {
    const cache = await this.prisma.assistantGeoCache.findFirst({
      where: { cacheKey, expiresAt: { gt: new Date() } },
      select: { candidatesJson: true },
    });
    return cache ? parseStoredCandidates(cache.candidatesJson) : null;
  }

  private async writeCache(
    cacheKey: string,
    input: ParsedResolveInput,
    candidates: Array<{
      id: string;
      label: string;
      latitude: number;
      longitude: number;
      city: string | null;
      countryCode: string | null;
    }>,
  ) {
    const expiresAt = new Date(Date.now() + this.provider.getCacheRetentionMs());
    await this.prisma.assistantGeoCache.upsert({
      where: { cacheKey },
      update: { candidatesJson: candidates, expiresAt },
      create: {
        cacheKey,
        normalizedQuery: normalizePlaceQuery(input.placeQuery),
        locale: input.locale,
        country: input.country ?? '',
        viewboxKey: createViewboxKey(input.viewbox),
        provider: this.provider.getProviderName(),
        candidatesJson: candidates,
        expiresAt,
      },
    });
  }

  private async resolveFromKnowledgeOrNotFound(input: ParsedResolveInput): Promise<AssistantGeoResolution> {
    const candidates = await this.findKnowledgeAddresses(input.placeQuery);
    return candidates.length > 0 ? resolved(input, candidates) : notFound(input);
  }

  private async findKnowledgeAddresses(query: string): Promise<AssistantGeoCandidate[]> {
    const facts = await this.prisma.assistantSourceFact.findMany({
      where: {
        kind: AssistantSourceFactKind.ADDRESS,
        isActive: true,
        searchText: { contains: query, mode: 'insensitive' },
        source: { state: AssistantKnowledgeSourceState.ACTIVE },
      },
      orderBy: [{ source: { priority: 'desc' } }, { observedAt: 'desc' }, { id: 'asc' }],
      take: 3,
      select: { id: true, label: true, valueJson: true },
    });
    return facts.flatMap((fact) => {
      const parsed = parseKnowledgeAddress(fact.valueJson);
      return parsed ? [{ id: fact.id, source: 'KNOWLEDGE' as const, ...parsed }] : [];
    }).slice(0, 3);
  }
}

export function parseResolveInput(value: unknown): ParsedResolveInput | null {
  if (!isRecord(value)) throw new BadRequestException('ASSISTANT_GEO_RESOLVE_INPUT_INVALID');
  const content = readText(value.content, 2_000);
  if (!content) throw new BadRequestException('ASSISTANT_GEO_CONTENT_INVALID');
  const placeQuery = extractPlaceQuery(content);
  if (!placeQuery) return null;
  const radiusMeters = extractRadiusMeters(content);
  if (radiusMeters !== null) {
    parseAssistantGeoSearchInput({
      anchor: { latitude: 0, longitude: 0, label: placeQuery, source: 'PLACE' },
      radiusMeters,
    });
  }
  const locale = typeof value.locale === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(value.locale)
    ? value.locale
    : 'ru';
  const country = value.country === undefined || value.country === null || value.country === ''
    ? null
    : typeof value.country === 'string' && /^[a-z]{2}$/u.test(value.country)
      ? value.country
      : undefined;
  if (country === undefined) throw new BadRequestException('ASSISTANT_GEO_COUNTRY_INVALID');
  const viewbox = value.viewbox === undefined || value.viewbox === null
    ? null
    : parseViewbox(value.viewbox);
  return { placeQuery, radiusMeters, locale, country, viewbox };
}

export function normalizePlaceQuery(value: string) {
  return value.normalize('NFKC').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru-RU');
}

export function createCacheKey(input: Pick<ParsedResolveInput, 'placeQuery' | 'locale' | 'country' | 'viewbox'>) {
  return createHash('sha256').update(JSON.stringify({
    query: normalizePlaceQuery(input.placeQuery),
    locale: input.locale,
    country: input.country ?? '',
    viewbox: createViewboxKey(input.viewbox),
  })).digest('hex');
}

function extractRadiusMeters(content: string) {
  const match = content.match(/(?:в\s+радиусе|радиус(?:ом)?|не\s+дальше)\s*(\d+(?:[.,]\d+)?)\s*(км|километр(?:а|ов)?|м|метр(?:а|ов)?)/iu);
  if (!match) return null;
  const value = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) throw new BadRequestException('ASSISTANT_GEO_RADIUS_INVALID');
  return Math.round(value * (/^(?:км|километр)/iu.test(match[2]!) ? 1_000 : 1));
}

function extractPlaceQuery(content: string) {
  const withoutRadius = content.replace(
    /(?:в\s+радиусе|радиус(?:ом)?|не\s+дальше)\s*\d+(?:[.,]\d+)?\s*(?:км|километр(?:а|ов)?|м|метр(?:а|ов)?)/giu,
    ' ',
  );
  const match = withoutRadius.match(/(?:рядом\s+с|возле|около|вокруг|(?:^|\s)от)\s+(.+)$/iu);
  if (!match) return null;
  const query = match[1]!
    .replace(/\s+(?:найди|покажи|подбери)\b.*$/iu, '')
    .replace(/[.!?;]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!query || /^\d/u.test(query)) return null;
  return readText(query, 240);
}

function parseViewbox(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new BadRequestException('ASSISTANT_GEO_VIEWBOX_INVALID');
  }
  const coordinates = value.map(Number) as [number, number, number, number];
  const [west, south, east, north] = coordinates;
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))
    || west < -180 || east > 180 || south < -90 || north > 90
    || west >= east || south >= north) {
    throw new BadRequestException('ASSISTANT_GEO_VIEWBOX_INVALID');
  }
  return coordinates;
}

function createViewboxKey(viewbox: ParsedResolveInput['viewbox']) {
  return viewbox ? viewbox.map((coordinate) => coordinate.toFixed(6)).join(',') : '';
}

function resolved(input: ParsedResolveInput, candidates: AssistantGeoCandidate[]): AssistantGeoResolution {
  return {
    status: candidates.length === 1 ? 'RESOLVED' : 'AMBIGUOUS',
    placeQuery: input.placeQuery,
    radiusMeters: input.radiusMeters as number,
    candidates: candidates.slice(0, 3),
  };
}

function notFound(input: ParsedResolveInput): AssistantGeoResolution {
  return {
    status: 'NOT_FOUND',
    placeQuery: input.placeQuery,
    radiusMeters: input.radiusMeters as number,
    actions: ['MANUAL', 'REFINE'],
  };
}

function unavailable(input: ParsedResolveInput): AssistantGeoResolution {
  return {
    status: 'UNAVAILABLE',
    placeQuery: input.placeQuery,
    radiusMeters: input.radiusMeters as number,
    actions: ['MANUAL', 'REFINE'],
  };
}

function parseStoredCandidates(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = readText(candidate.id, 120);
    const label = readText(candidate.label, 300);
    const latitude = readCoordinate(candidate.latitude, -90, 90);
    const longitude = readCoordinate(candidate.longitude, -180, 180);
    if (!id || !label || latitude === null || longitude === null) return [];
    return [{
      id,
      label,
      latitude,
      longitude,
      city: readText(candidate.city, 160),
      countryCode: readCountryCode(candidate.countryCode),
    }];
  }).slice(0, 3);
}

function parseKnowledgeAddress(value: Prisma.JsonValue) {
  if (!isRecord(value)) return null;
  const label = readText(value.label, 300);
  const latitude = readCoordinate(value.latitude, -90, 90);
  const longitude = readCoordinate(value.longitude, -180, 180);
  if (!label || latitude === null || longitude === null) return null;
  return {
    label,
    latitude,
    longitude,
    city: readText(value.city, 160),
    countryCode: readCountryCode(value.countryCode),
  };
}

function readCoordinate(value: unknown, minimum: number, maximum: number) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function readCountryCode(value: unknown) {
  return typeof value === 'string' && /^[a-z]{2}$/u.test(value) ? value : null;
}

function readText(value: unknown, maximum: number) {
  return typeof value === 'string' && value.trim() && value.trim().length <= maximum ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
