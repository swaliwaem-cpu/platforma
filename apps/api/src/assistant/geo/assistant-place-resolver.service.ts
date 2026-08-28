import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import { AssistantKnowledgeSourceState, AssistantSourceFactKind, Prisma } from '@prisma/client';
import type {
  AssistantGeoCandidate,
  AssistantGeoKind,
  AssistantGeoResolution,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';
import {
  assistantGeoDefaultLandmarkDistanceMeters,
  assistantGeoDefaultPointDistanceMeters,
  parseAssistantGeoSearchInput,
} from './assistant-geo-contract';
import {
  AssistantGeoLandmarkGeometryError,
  AssistantGeoLandmarkService,
  type AssistantTrustedLandmark,
} from './assistant-geo-landmark.service';
import {
  normalizeAssistantGeoIdentityText,
  resolveAssistantGeoLandmarkIdentity,
} from './assistant-geo-landmark-identity';
import { AssistantGeoUsageLedgerService } from './assistant-geo-usage-ledger.service';
import { parseAssistantGeoDistanceClause } from './assistant-geo-query';
import {
  AssistantGeoProviderError,
  type AssistantGeoProviderCandidate,
} from './assistant-geo-provider';
import { AssistantGeoProviderPolicyService } from './assistant-geo-provider-policy.service';
import {
  AssistantOverpassCollector,
  AssistantOverpassError,
} from './assistant-overpass-collector';

type ParsedResolveInput = {
  placeQuery: string;
  normalizedQuery: string;
  userAlias: string;
  aliases: string[];
  providerQuery: string;
  expectedKind: AssistantGeoKind | null;
  expectedCity: string | null;
  expectedCountry: string | null;
  overpassTagValues: string[];
  mode: 'NEAR' | 'INSIDE';
  explicitDistanceMeters: number | null;
  /** @deprecated Temporary compatibility for T05 callers. */
  radiusMeters: number | null;
  locale: string;
  country: string | null;
  viewbox: [number, number, number, number] | null;
};

type CachedLandmark = {
  id: string;
  kind: AssistantGeoKind;
  label: string;
  city: string | null;
  countryCode: string | null;
  source: 'ALIAS' | 'PLACE';
  point?: { latitude: number; longitude: number };
};

const overpassGeometryRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class AssistantPlaceResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AssistantGeoProviderPolicyService,
    private readonly landmarks?: AssistantGeoLandmarkService,
    private readonly overpass?: AssistantOverpassCollector,
    private readonly usageLedger?: AssistantGeoUsageLedgerService,
  ) {}

  async resolve(body: unknown, actorUserId: string | null = null): Promise<AssistantGeoResolution> {
    const startedAt = Date.now();
    const input = parseResolveInput(body);
    if (!input) return { status: 'NOT_APPLICABLE' };

    // Direct unit-test callers from T05 do not inject the new repository. Production always does.
    if (!this.landmarks) return this.resolvePointCompatibility(input, actorUserId, startedAt);

    const confirmed = filterLandmarksForMode(
      await this.landmarks.findTrustedByQuery({
        normalizedQuery: input.normalizedQuery,
        normalizedQueries: [...new Set([input.normalizedQuery, ...input.aliases, input.userAlias])],
        mode: input.mode,
        locale: input.locale,
        country: input.country,
        viewbox: input.viewbox,
      }),
      input.mode,
    );
    if (confirmed.length > 0) {
      const result = resolved(input, confirmed.map((landmark) => toCandidate(input, landmark)));
      await this.recordOperation(input, actorUserId, 'landmark_db', result.status, startedAt, false, 0, null);
      return result;
    }

    const cacheKey = createCacheKey(input);
    const cached = await this.readLandmarkCache(cacheKey);
    if (cached !== null) {
      if (cached.length === 0) {
        const result = notFound(input);
        await this.recordOperation(input, actorUserId, this.provider.getProviderName(), result.status, startedAt, true, 0, null);
        return result;
      }
      const trusted = filterLandmarksForMode(await this.rehydrateCached(cached), input.mode);
      if (trusted.length > 0) {
        const result = resolved(input, trusted.map((landmark) => toCandidate(input, landmark)));
        await this.recordOperation(input, actorUserId, this.provider.getProviderName(), result.status, startedAt, true, 0, null);
        return result;
      }
      await this.prisma.assistantGeoCache.deleteMany({ where: { cacheKey } });
    }

    const usageLedger = this.provider.getProviderName() === 'locationiq' ? this.usageLedger : undefined;
    const operationId = usageLedger
      ? await this.beginProviderOperation(input, actorUserId)
      : null;
    if (usageLedger && !operationId) return unavailable(input);
    try {
      const providerTask = () => this.resolveFromProviders(input);
      const providerResult = operationId && usageLedger
        ? await usageLedger.runResolution(operationId, providerTask)
        : await providerTask();
      await this.writeLandmarkCache(cacheKey, input, providerResult.landmarks, providerResult.cacheExpiresAt);
      const compatible = filterLandmarksForMode(providerResult.landmarks, input.mode);
      const result = compatible.length > 0
        ? resolved(input, compatible.map((landmark) => toCandidate(input, landmark)))
        : notFound(input);
      if (operationId) {
        const finalized = await this.finalizeProviderOperation(
          operationId,
          result.status,
          startedAt,
          null,
        );
        if (!finalized) return unavailable(input);
      } else {
        await this.recordOperation(
          input,
          actorUserId,
          providerResult.provider,
          result.status,
          startedAt,
          false,
          providerResult.calls,
          null,
        );
      }
      return result;
    } catch (error) {
      if (!(error instanceof AssistantGeoProviderError)) {
        if (operationId) {
          await this.finalizeProviderOperation(
            operationId,
            'UNAVAILABLE',
            startedAt,
            'ASSISTANT_GEO_RESOLUTION_INTERNAL_ERROR',
          );
        }
        throw error;
      }
      const result = unavailable(input);
      const errorProvider = error.code.startsWith('ASSISTANT_OVERPASS') ? 'overpass' : this.provider.getProviderName();
      if (operationId) {
        await this.finalizeProviderOperation(operationId, result.status, startedAt, error.code);
      } else {
        await this.recordOperation(
          input,
          actorUserId,
          errorProvider,
          result.status,
          startedAt,
          false,
          error.providerCallCount,
          error.code,
        );
      }
      return result;
    }
  }

  private async resolveFromProviders(input: ParsedResolveInput) {
    if (!this.landmarks) return {
      landmarks: [], calls: 0, provider: this.provider.getProviderName(),
      cacheExpiresAt: new Date(Date.now() + this.provider.getCacheRetentionMs()),
    };
    const lookup = await this.provider.searchWithTelemetry({
      query: input.providerQuery,
      locale: input.locale,
      country: input.country,
      viewbox: input.viewbox,
    });
    let calls = lookup.providerCallCount;
    if (lookup.candidates.length === 0) {
      return {
        landmarks: [], calls, provider: this.provider.getProviderName(),
        cacheExpiresAt: new Date(Date.now() + this.provider.getCacheRetentionMs()),
      };
    }
    const providerCandidates = selectGeometryCandidates(lookup.candidates, input, this.provider.getProviderName());
    const saved: AssistantTrustedLandmark[] = [];
    const savedExpiries: Date[] = [];
    let finalProvider: 'fake' | 'locationiq' | 'overpass' = this.provider.getProviderName();
    let cityLookupPromise: Promise<AssistantGeoProviderCandidate | null> | null = null;
    let overpassPromise: ReturnType<AssistantOverpassCollector['collect']> | null = null;
    const resolveCityArea = (city: string) => {
      cityLookupPromise ??= this.provider.searchWithTelemetry({
        query: city,
        locale: input.locale,
        country: input.expectedCountry ?? input.country,
        viewbox: null,
      }).then((cityLookup) => {
        calls += cityLookup.providerCallCount;
        const areas = cityLookup.candidates.filter((item) => isExpectedAdministrativeArea(item, {
          expectedCity: city,
          expectedCountry: input.expectedCountry ?? input.country,
        }));
        return areas.length === 1 ? areas[0]! : null;
      });
      return cityLookupPromise;
    };
    const collectRoad = (candidate: AssistantGeoProviderCandidate) => {
      if (!candidate.city || !this.overpass) {
        throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_UNAVAILABLE', false);
      }
      overpassPromise ??= resolveCityArea(candidate.city).then((cityArea) => {
        if (!cityArea?.boundingBox) {
          throw new AssistantOverpassError('ASSISTANT_OVERPASS_CITY_AREA_UNAVAILABLE', false);
        }
        calls += 1;
        return this.overpass!.collect({
          name: input.providerQuery,
          tagValues: input.overpassTagValues,
          city: candidate.city!,
          cityBounds: cityArea.boundingBox,
        });
      });
      return overpassPromise;
    };
    for (const candidate of providerCandidates) {
      try {
        const persisted = await this.persistProviderCandidate(input, candidate, collectRoad);
        if (persisted) {
          saved.push(persisted.landmark);
          savedExpiries.push(persisted.expiresAt);
          if (persisted.provider === 'overpass') finalProvider = 'overpass';
        }
      } catch (error) {
        if (error instanceof AssistantGeoLandmarkGeometryError) {
          throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_GEOMETRY_REJECTED', false);
        }
        if (error instanceof AssistantGeoProviderError) {
          error.providerCallCount += calls;
          throw error;
        }
        if (error instanceof AssistantOverpassError) {
          const providerError = new AssistantGeoProviderError(error.code, error.retryable);
          providerError.providerCallCount = calls;
          throw providerError;
        }
        throw error;
      }
    }
    if (saved.length === 0) {
      throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_IDENTITY_REJECTED', false);
    }
    const providerCacheExpiry = new Date(Date.now() + this.provider.getCacheRetentionMs());
    const earliestLandmarkExpiry = Math.min(...savedExpiries.map((expiry) => expiry.getTime()));
    return {
      landmarks: deduplicateLandmarks(saved).slice(0, 3), calls, provider: finalProvider,
      cacheExpiresAt: new Date(Math.min(providerCacheExpiry.getTime(), earliestLandmarkExpiry)),
    };
  }

  private async persistProviderCandidate(
    input: ParsedResolveInput,
    candidate: AssistantGeoProviderCandidate,
    collectRoad: (candidate: AssistantGeoProviderCandidate) => ReturnType<AssistantOverpassCollector['collect']>,
  ) {
    if (!this.landmarks) return null;
    const kind = candidate.geometryKind ?? 'POINT';
    let geometry = kind === 'POINT'
      ? { type: 'Point' as const, coordinates: [candidate.longitude, candidate.latitude] as [number, number] }
      : candidate.referenceGeometry;
    let sourceProvider: 'locationiq' | 'overpass' | 'fake' = this.provider.getProviderName() === 'fake'
      ? 'fake'
      : 'locationiq';
    let sourceExternalId = candidate.osmType && candidate.osmId
      ? `${candidate.osmType}/${candidate.osmId}`
      : candidate.id;
    let entityType = candidate.entityType ?? null;

    if (kind === 'LINE' && !candidate.geometryComplete) {
      const collected = await collectRoad(candidate);
      geometry = collected.geometry;
      sourceProvider = 'overpass';
      sourceExternalId = collected.externalId;
      entityType = collected.entityType;
    }
    if (!geometry) return null;

    const expiresAt = sourceProvider === 'overpass'
      ? new Date(Date.now() + overpassGeometryRetentionMs)
      : new Date(Date.now() + this.provider.getCacheRetentionMs());
    const landmark = await this.landmarks.saveVerified({
      kind,
      label: input.placeQuery,
      normalizedQuery: input.normalizedQuery,
      aliases: [...new Set([...input.aliases, input.userAlias])],
      locale: input.locale,
      country: candidate.countryCode ?? input.country,
      city: candidate.city,
      geometry,
      sourceProvider,
      sourceExternalId,
      expiresAt,
      sourceMetadata: {
        entityType,
        fetchedAt: new Date().toISOString(),
        version: 1,
        identityVersion: 1,
        userAlias: input.userAlias,
        providerQuery: input.providerQuery,
      },
    });
    return { landmark, provider: sourceProvider, expiresAt };
  }

  private async rehydrateCached(cached: CachedLandmark[]) {
    if (!this.landmarks) return [];
    const rows = await Promise.all(cached.map(({ id }) => this.landmarks!.findTrustedById(id)));
    if (rows.some((row) => row === null)) return [];
    return rows as AssistantTrustedLandmark[];
  }

  private async readLandmarkCache(cacheKey: string): Promise<CachedLandmark[] | null> {
    const cache = await this.prisma.assistantGeoCache.findFirst({
      where: { cacheKey, expiresAt: { gt: new Date() } },
      select: { candidatesJson: true },
    });
    return cache ? parseCachedLandmarks(cache.candidatesJson) : null;
  }

  private async writeLandmarkCache(
    cacheKey: string,
    input: ParsedResolveInput,
    landmarks: AssistantTrustedLandmark[],
    expiresAt: Date,
  ) {
    const candidatesJson = landmarks.map((landmark) => ({
      id: landmark.id,
      kind: landmark.kind,
      label: landmark.label,
      city: landmark.city,
      countryCode: landmark.countryCode,
      source: landmark.source,
      ...(landmark.point ? { point: landmark.point } : {}),
    }));
    await this.prisma.assistantGeoCache.upsert({
      where: { cacheKey },
      update: { candidatesJson, expiresAt },
      create: {
        cacheKey,
        normalizedQuery: input.normalizedQuery,
        locale: input.locale,
        country: input.country ?? '',
        viewboxKey: createViewboxKey(input.viewbox),
        provider: `${this.provider.getProviderName()}-geometry-v2`,
        candidatesJson,
        expiresAt,
      },
    });
  }

  private async beginProviderOperation(input: ParsedResolveInput, actorUserId: string | null) {
    const id = randomUUID();
    try {
      await this.prisma.assistantGeoOperation.create({
        data: {
          id,
          actorUserId,
          normalizedQuery: input.normalizedQuery,
          provider: this.provider.getProviderName(),
          status: 'RUNNING',
          durationMs: 0,
          cacheHit: false,
          providerCallCount: 0,
          errorCode: null,
        },
      });
      return id;
    } catch {
      return null;
    }
  }

  private async finalizeProviderOperation(
    id: string,
    status: AssistantGeoResolution['status'],
    startedAt: number,
    errorCode: string | null,
  ) {
    try {
      await this.prisma.assistantGeoOperation.update({
        where: { id },
        data: {
          status,
          durationMs: Math.max(0, Date.now() - startedAt),
          cacheHit: false,
          errorCode,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async resolvePointCompatibility(
    input: ParsedResolveInput,
    actorUserId: string | null,
    startedAt: number,
  ): Promise<AssistantGeoResolution> {
    const radiusMeters = input.explicitDistanceMeters ?? assistantGeoDefaultPointDistanceMeters;
    const alias = await this.findLegacyAlias(input);
    if (alias) {
      const result = resolved(input, [alias], radiusMeters);
      await this.recordOperation(input, actorUserId, 'alias', result.status, startedAt, false, 0, null);
      return result;
    }
    const cacheKey = createLegacyCacheKey(input);
    const cached = await this.readLegacyCache(cacheKey);
    if (cached) {
      const result = cached.length > 0 ? resolved(input, cached, radiusMeters) : notFound(input, radiusMeters);
      await this.recordOperation(input, actorUserId, this.provider.getProviderName(), result.status, startedAt, true, 0, null);
      return result;
    }
    try {
      const response = await this.provider.searchWithTelemetry({
        query: input.providerQuery,
        locale: input.locale,
        country: input.country,
        viewbox: input.viewbox,
      });
      const candidates = response.candidates.map((candidate) => legacyCandidate(input, candidate, radiusMeters));
      await this.writeLegacyCache(cacheKey, input, response.candidates);
      const result = candidates.length > 0
        ? resolved(input, candidates, radiusMeters)
        : await this.resolveLegacyKnowledge(input, radiusMeters);
      await this.recordOperation(
        input,
        actorUserId,
        this.provider.getProviderName(),
        result.status,
        startedAt,
        false,
        response.providerCallCount,
        null,
      );
      return result;
    } catch (error) {
      if (!(error instanceof AssistantGeoProviderError)) throw error;
      const knowledge = await this.findLegacyKnowledge(input, radiusMeters);
      const result = knowledge.length > 0 ? resolved(input, knowledge, radiusMeters) : unavailable(input, radiusMeters);
      await this.recordOperation(
        input,
        actorUserId,
        this.provider.getProviderName(),
        result.status,
        startedAt,
        false,
        error.providerCallCount,
        error.code,
      );
      return result;
    }
  }

  private async findLegacyAlias(input: ParsedResolveInput): Promise<AssistantGeoCandidate | null> {
    const alias = await this.prisma.assistantGeoAlias.findUnique({
      where: {
        normalizedQuery_locale_country: {
          normalizedQuery: input.normalizedQuery,
          locale: input.locale,
          country: input.country ?? '',
        },
      },
    });
    const radius = input.explicitDistanceMeters ?? assistantGeoDefaultPointDistanceMeters;
    return alias ? {
      id: alias.id,
      label: alias.label,
      kind: 'POINT',
      mode: 'NEAR',
      distanceMeters: radius,
      point: { latitude: Number(alias.latitude), longitude: Number(alias.longitude) },
      latitude: Number(alias.latitude),
      longitude: Number(alias.longitude),
      city: alias.city,
      countryCode: alias.countryCode,
      source: 'ALIAS',
    } : null;
  }

  private async readLegacyCache(cacheKey: string) {
    const cache = await this.prisma.assistantGeoCache.findFirst({
      where: { cacheKey, expiresAt: { gt: new Date() } },
      select: { candidatesJson: true },
    });
    return cache ? parseLegacyCandidates(cache.candidatesJson) : null;
  }

  private async writeLegacyCache(
    cacheKey: string,
    input: ParsedResolveInput,
    candidates: AssistantGeoProviderCandidate[],
  ) {
    const expiresAt = new Date(Date.now() + this.provider.getCacheRetentionMs());
    const safeCandidates = candidates.map(({ id, label, latitude, longitude, city, countryCode }) => ({
      id, label, latitude, longitude, city, countryCode,
    }));
    await this.prisma.assistantGeoCache.upsert({
      where: { cacheKey },
      update: { candidatesJson: safeCandidates, expiresAt },
      create: {
        cacheKey,
        normalizedQuery: input.normalizedQuery,
        locale: input.locale,
        country: input.country ?? '',
        viewboxKey: createViewboxKey(input.viewbox),
        provider: this.provider.getProviderName(),
        candidatesJson: safeCandidates,
        expiresAt,
      },
    });
  }

  private async resolveLegacyKnowledge(input: ParsedResolveInput, radiusMeters: number) {
    const candidates = await this.findLegacyKnowledge(input, radiusMeters);
    return candidates.length > 0 ? resolved(input, candidates, radiusMeters) : notFound(input, radiusMeters);
  }

  private async findLegacyKnowledge(input: ParsedResolveInput, radiusMeters: number): Promise<AssistantGeoCandidate[]> {
    const facts = await this.prisma.assistantSourceFact.findMany({
      where: {
        kind: AssistantSourceFactKind.ADDRESS,
        isActive: true,
        searchText: { contains: input.placeQuery, mode: 'insensitive' },
        source: { state: AssistantKnowledgeSourceState.ACTIVE },
      },
      orderBy: [{ source: { priority: 'desc' } }, { observedAt: 'desc' }, { id: 'asc' }],
      take: 3,
      select: { id: true, label: true, valueJson: true },
    });
    return facts.flatMap((fact) => {
      const point = parseKnowledgeAddress(fact.valueJson);
      return point ? [{
        id: fact.id,
        label: point.label,
        kind: 'POINT' as const,
        mode: 'NEAR' as const,
        distanceMeters: radiusMeters,
        point: { latitude: point.latitude, longitude: point.longitude },
        latitude: point.latitude,
        longitude: point.longitude,
        city: point.city,
        countryCode: point.countryCode,
        source: 'KNOWLEDGE' as const,
      }] : [];
    }).slice(0, 3);
  }

  private async recordOperation(
    input: ParsedResolveInput,
    actorUserId: string | null,
    provider: string,
    status: AssistantGeoResolution['status'],
    startedAt: number,
    cacheHit: boolean,
    providerCallCount: number,
    errorCode: string | null,
  ) {
    try {
      await this.prisma.assistantGeoOperation.create({
        data: {
          actorUserId,
          normalizedQuery: input.normalizedQuery,
          provider,
          status,
          durationMs: Math.max(0, Date.now() - startedAt),
          cacheHit,
          providerCallCount,
          errorCode,
        },
      });
    } catch {
      // Operational telemetry persistence must not change a geo resolution result.
    }
  }
}

export function parseResolveInput(value: unknown): ParsedResolveInput | null {
  if (!isRecord(value)) throw new BadRequestException('ASSISTANT_GEO_RESOLVE_INPUT_INVALID');
  const content = readText(value.content, 2_000);
  if (!content) throw new BadRequestException('ASSISTANT_GEO_CONTENT_INVALID');
  const radiusMeters = extractDistanceMeters(content);
  const place = extractPlaceQuery(content, radiusMeters !== null);
  if (!place) return null;
  if (radiusMeters !== null) {
    parseAssistantGeoSearchInput({
      anchor: { latitude: 0, longitude: 0, label: place.placeQuery, source: 'PLACE' },
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
  const viewbox = value.viewbox === undefined || value.viewbox === null ? null : parseViewbox(value.viewbox);
  return {
    ...place.identity,
    placeQuery: place.identity.label,
    mode: place.mode,
    explicitDistanceMeters: radiusMeters,
    radiusMeters,
    locale,
    country,
    viewbox,
  };
}

export function normalizePlaceQuery(value: string) {
  return normalizeAssistantGeoIdentityText(value);
}

export function createCacheKey(
  input: Pick<ParsedResolveInput, 'placeQuery' | 'mode' | 'locale' | 'country' | 'viewbox'>
    & Partial<Pick<ParsedResolveInput, 'normalizedQuery'>>,
) {
  return createHash('sha256').update(JSON.stringify({
    version: 'geometry-v2',
    query: input.normalizedQuery ?? normalizePlaceQuery(input.placeQuery),
    mode: input.mode,
    locale: input.locale,
    country: input.country ?? '',
    viewbox: createViewboxKey(input.viewbox),
  })).digest('hex');
}

function createLegacyCacheKey(
  input: Pick<ParsedResolveInput, 'placeQuery' | 'locale' | 'country' | 'viewbox'>
    & Partial<Pick<ParsedResolveInput, 'normalizedQuery'>>,
) {
  return createHash('sha256').update(JSON.stringify({
    query: input.normalizedQuery ?? normalizePlaceQuery(input.placeQuery),
    locale: input.locale,
    country: input.country ?? '',
    viewbox: createViewboxKey(input.viewbox),
  })).digest('hex');
}

function extractDistanceMeters(content: string) {
  const match = content.match(/(?:в\s+радиусе|радиус(?:ом)?|не\s+дальше|в\s+пределах|на\s+расстоянии(?:\s+не\s+более)?|до|в)\s*(\d+(?:[.,]\d+)?)\s*(км|километр(?:а|ов)?|метр(?:а|ов)?|м)(?!\p{L})/iu);
  if (!match) return null;
  const value = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) throw new BadRequestException('ASSISTANT_GEO_RADIUS_INVALID');
  return Math.round(value * (/^(?:км|километр)/iu.test(match[2]!) ? 1_000 : 1));
}

function extractPlaceQuery(content: string, hasExplicitDistance: boolean) {
  const explicitClause = hasExplicitDistance ? parseAssistantGeoDistanceClause(content) : null;
  const contentWithoutDistance = hasExplicitDistance && explicitClause === null
      ? content.replace(
        /(?:в\s+радиусе|радиус(?:ом)?|не\s+дальше|в\s+пределах|на\s+расстоянии(?:\s+не\s+более)?|до|в)\s*\d+(?:[.,]\d+)?\s*(?:км|километр(?:а|ов)?|метр(?:а|ов)?|м)(?!\p{L})/giu,
        ' ',
      )
    : content;
  const insideMatch = explicitClause === null ? contentWithoutDistance.match(/(?:^|\s)внутри\s+(.+)$/iu) : null;
  const nearbyMatch = explicitClause === null && !insideMatch
    ? contentWithoutDistance.match(/(?:рядом\s+с|возле|около|вокруг)\s+(.+)$/iu)
    : null;
  const candidate = explicitClause?.anchor ?? insideMatch?.[1] ?? nearbyMatch?.[1];
  if (!candidate) return null;
  const query = candidate
    .replace(/\s+(?:найди|покажи|подбери)\b.*$/iu, '')
    .split(/,\s*(?=(?:например(?=\s|,|$)|бюджет(?=\s|,|$)|\d{1,2}\s*[- ]?\s*комн|студи\p{L}*|однуш\p{L}*|однокомнат\p{L}*|двуш\p{L}*|двухкомнат\p{L}*|треш\p{L}*|трехкомнат\p{L}*))/iu, 1)[0]!
    .replace(/\s+(?=(?:бюджет(?=\s|,|$)|\d{1,2}\s*[- ]?\s*комн|студи\p{L}*|однуш\p{L}*|однокомнат\p{L}*|двуш\p{L}*|двухкомнат\p{L}*|треш\p{L}*|трехкомнат\p{L}*))[^,;.!?]*$/iu, '')
    .replace(/[,\s.!?;]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!query || /^\d/u.test(query)) return null;
  const placeQuery = readText(query, 240);
  return placeQuery ? {
    placeQuery,
    identity: resolveAssistantGeoLandmarkIdentity(placeQuery),
    mode: insideMatch ? 'INSIDE' as const : 'NEAR' as const,
  } : null;
}

function parseViewbox(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) throw new BadRequestException('ASSISTANT_GEO_VIEWBOX_INVALID');
  if (value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
    throw new BadRequestException('ASSISTANT_GEO_VIEWBOX_INVALID');
  }
  const coordinates = value as [number, number, number, number];
  const [west, south, east, north] = coordinates;
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))
    || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new BadRequestException('ASSISTANT_GEO_VIEWBOX_INVALID');
  }
  return coordinates;
}

function createViewboxKey(viewbox: ParsedResolveInput['viewbox']) {
  return viewbox ? viewbox.map((coordinate) => coordinate.toFixed(6)).join(',') : '';
}

function resolved(
  input: ParsedResolveInput,
  candidates: AssistantGeoCandidate[],
  compatibilityRadius?: number,
): AssistantGeoResolution {
  return {
    status: candidates.length === 1 ? 'RESOLVED' : 'AMBIGUOUS',
    placeQuery: input.placeQuery,
    ...(compatibilityRadius ? { radiusMeters: compatibilityRadius } : {}),
    candidates: candidates.slice(0, 3),
  };
}

function notFound(input: ParsedResolveInput, compatibilityRadius?: number): AssistantGeoResolution {
  return {
    status: 'NOT_FOUND',
    placeQuery: input.placeQuery,
    ...(compatibilityRadius ? { radiusMeters: compatibilityRadius } : {}),
    actions: ['MANUAL', 'REFINE'],
  };
}

function unavailable(input: ParsedResolveInput, compatibilityRadius?: number): AssistantGeoResolution {
  return {
    status: 'UNAVAILABLE',
    placeQuery: input.placeQuery,
    ...(compatibilityRadius ? { radiusMeters: compatibilityRadius } : {}),
    actions: ['MANUAL', 'REFINE'],
  };
}

function toCandidate(input: ParsedResolveInput, landmark: AssistantTrustedLandmark): AssistantGeoCandidate {
  const distanceMeters = input.mode === 'NEAR'
    ? input.explicitDistanceMeters
      ?? (landmark.kind === 'POINT' ? assistantGeoDefaultPointDistanceMeters : assistantGeoDefaultLandmarkDistanceMeters)
    : undefined;
  return {
    id: landmark.id,
    label: landmark.label,
    kind: landmark.kind,
    mode: input.mode,
    ...(distanceMeters ? { distanceMeters } : {}),
    ...(landmark.point ? {
      point: landmark.point,
      latitude: landmark.point.latitude,
      longitude: landmark.point.longitude,
    } : {}),
    city: landmark.city,
    countryCode: landmark.countryCode,
    source: landmark.source,
  };
}

function legacyCandidate(
  input: ParsedResolveInput,
  candidate: AssistantGeoProviderCandidate,
  radiusMeters: number,
): AssistantGeoCandidate {
  return {
    id: candidate.id,
    label: candidate.label,
    kind: 'POINT',
    mode: 'NEAR',
    distanceMeters: radiusMeters,
    point: { latitude: candidate.latitude, longitude: candidate.longitude },
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    city: candidate.city,
    countryCode: candidate.countryCode,
    source: 'PLACE',
  };
}

function selectGeometryCandidates(
  candidates: AssistantGeoProviderCandidate[],
  input: ParsedResolveInput,
  providerName: 'fake' | 'locationiq',
) {
  if (providerName === 'fake') return selectLegacyGeometryCandidates(candidates, input.mode);
  if (input.expectedKind === 'AREA') {
    const areas = candidates.filter((candidate) => isExpectedAdministrativeArea(candidate, {
      expectedCity: input.expectedCity,
      expectedCountry: input.expectedCountry,
      expectedNames: [...input.aliases, input.providerQuery, input.placeQuery],
    }));
    if (areas.length !== 1) {
      throw new AssistantGeoProviderError(
        areas.length > 1 ? 'ASSISTANT_GEO_AREA_AMBIGUOUS' : 'ASSISTANT_GEO_AREA_IDENTITY_REJECTED',
        false,
      );
    }
    return areas;
  }
  if (input.expectedKind === 'LINE') {
    const expectedNames = new Set(
      [...input.aliases, input.providerQuery, ...input.overpassTagValues].map(normalizeAssistantGeoIdentityText),
    );
    const lines = candidates.filter((candidate) => (
      candidate.geometryKind === 'LINE'
      && normalizeAssistantGeoIdentityText(candidate.entityClass ?? '') === 'highway'
      && matchesExpectedScope(candidate, input.expectedCity, input.expectedCountry)
      && expectedNames.has(normalizeAssistantGeoIdentityText(candidate.label.split(',')[0]!))
    ));
    if (lines.length === 0) {
      throw new AssistantGeoProviderError('ASSISTANT_GEO_ROAD_IDENTITY_REJECTED', false);
    }
    return lines;
  }
  return selectLegacyGeometryCandidates(candidates, input.mode);
}

function selectLegacyGeometryCandidates(
  candidates: AssistantGeoProviderCandidate[],
  mode: 'NEAR' | 'INSIDE',
) {
  if (mode === 'INSIDE') return candidates.filter((candidate) => candidate.geometryKind === 'AREA');
  const lines = candidates.filter((candidate) => candidate.geometryKind === 'LINE');
  if (lines.length > 0) return lines;
  const areas = candidates.filter((candidate) => candidate.geometryKind === 'AREA');
  if (areas.length > 0) return areas;
  return candidates.filter((candidate) => (candidate.geometryKind ?? 'POINT') === 'POINT');
}

function isExpectedAdministrativeArea(
  candidate: AssistantGeoProviderCandidate,
  input: {
    expectedCity: string | null;
    expectedCountry: string | null;
    expectedNames?: string[];
  },
) {
  if (candidate.geometryKind !== 'AREA'
    || candidate.geometryComplete !== true
    || !candidate.referenceGeometry
    || !candidate.boundingBox
    || normalizeAssistantGeoIdentityText(candidate.entityClass ?? '') !== 'boundary'
    || normalizeAssistantGeoIdentityText(candidate.entityType ?? '') !== 'administrative'
    || normalizeAssistantGeoIdentityText(candidate.osmType ?? '') !== 'relation'
    || !matchesExpectedScope(candidate, input.expectedCity, input.expectedCountry)) return false;
  if (!input.expectedNames) return true;
  const expectedNames = new Set(input.expectedNames.map(normalizeAssistantGeoIdentityText));
  return expectedNames.has(normalizeAssistantGeoIdentityText(candidate.label.split(',')[0]!));
}

function matchesExpectedScope(
  candidate: AssistantGeoProviderCandidate,
  expectedCity: string | null,
  expectedCountry: string | null,
) {
  return (!expectedCity
      || normalizeAssistantGeoIdentityText(candidate.city ?? '') === normalizeAssistantGeoIdentityText(expectedCity))
    && (!expectedCountry
      || normalizeAssistantGeoIdentityText(candidate.countryCode ?? '') === normalizeAssistantGeoIdentityText(expectedCountry));
}

function filterLandmarksForMode(landmarks: AssistantTrustedLandmark[], mode: 'NEAR' | 'INSIDE') {
  return mode === 'INSIDE' ? landmarks.filter(({ kind }) => kind === 'AREA') : landmarks;
}

function deduplicateLandmarks(landmarks: AssistantTrustedLandmark[]) {
  return [...new Map(landmarks.map((landmark) => [landmark.id, landmark])).values()];
}

function parseCachedLandmarks(value: Prisma.JsonValue): CachedLandmark[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: CachedLandmark[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || !uuidPattern.test(candidate.id)
      || !['POINT', 'LINE', 'AREA'].includes(String(candidate.kind))
      || !['ALIAS', 'PLACE'].includes(String(candidate.source))) return null;
    const label = readText(candidate.label, 300);
    if (!label) return null;
    let point: CachedLandmark['point'];
    if (candidate.kind === 'POINT') {
      if (!isRecord(candidate.point)) return null;
      const latitude = readCoordinate(candidate.point.latitude, -90, 90);
      const longitude = readCoordinate(candidate.point.longitude, -180, 180);
      if (latitude === null || longitude === null) return null;
      point = { latitude, longitude };
    }
    parsed.push({
      id: candidate.id,
      kind: candidate.kind as AssistantGeoKind,
      label,
      city: readText(candidate.city, 160),
      countryCode: readCountryCode(candidate.countryCode),
      source: candidate.source as CachedLandmark['source'],
      ...(point ? { point } : {}),
    });
  }
  return parsed.slice(0, 3);
}

function parseLegacyCandidates(value: Prisma.JsonValue): AssistantGeoCandidate[] {
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
      kind: 'POINT' as const,
      mode: 'NEAR' as const,
      distanceMeters: assistantGeoDefaultPointDistanceMeters,
      point: { latitude, longitude },
      latitude,
      longitude,
      city: readText(candidate.city, 160),
      countryCode: readCountryCode(candidate.countryCode),
      source: 'PLACE' as const,
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
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
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
