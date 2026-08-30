import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AssistantKnowledgeSourceState,
  AssistantSourceFactKind,
  Prisma,
} from '@prisma/client';
import type {
  AssistantGeoCandidate,
  AssistantGeoKind,
  AssistantGeoResolution,
  AssistantGeoResolutionSlot,
  AssistantGeoSingleResolution,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';
import { extractAssistantDistrictFromText } from './assistant-district-query';
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
  isExpectedAssistantGeoAdministrativeBounds,
  normalizeAssistantGeoIdentityText,
  resolveAssistantGeoLandmarkIdentity,
  selectAssistantGeoProviderCandidates,
  type AssistantGeoCandidateIdentityPolicy,
} from './assistant-geo-landmark-identity';
import { AssistantGeoUsageLedgerService } from './assistant-geo-usage-ledger.service';
import {
  AssistantGeoProviderError,
  type AssistantGeoProviderCandidate,
} from './assistant-geo-provider';
import { AssistantGeoProviderPolicyService } from './assistant-geo-provider-policy.service';
import {
  AssistantOverpassCollector,
  AssistantOverpassError,
} from './assistant-overpass-collector';

export type ParsedResolveInput = {
  slotId: string;
  sourceText: string;
  sourceSpan: { start: number; end: number };
  category: AssistantGeoCategory | null;
  resolutionPolicy: 'LOOKUP' | 'REFINE_REQUIRED';
  placeQuery: string;
  normalizedQuery: string;
  userAlias: string;
  aliases: string[];
  providerQuery: string;
  expectedKind: AssistantGeoKind | null;
  expectedCity: string | null;
  expectedCountry: string | null;
  providerViewbox: [west: number, south: number, east: number, north: number] | null;
  candidatePolicy: AssistantGeoCandidateIdentityPolicy | null;
  version: 2;
  overpassTagValues: string[];
  overpassRelationIds: string[] | null;
  mode: 'NEAR' | 'INSIDE';
  explicitDistanceMeters: number | null;
  /** @deprecated Temporary compatibility for T05 callers. */
  radiusMeters: number | null;
  locale: string;
  country: string | null;
  viewbox: [number, number, number, number] | null;
};

type AssistantGeoCategory = 'WATER' | 'RIVER' | 'PARK' | 'BRIDGE' | 'SCHOOL';

export type ParsedResolveInputs = {
  operator: 'ALL';
  constraints: ParsedResolveInput[];
};

type ParsedDistrictFallback = {
  district: string;
  input: ParsedResolveInput;
};

type CompositeProviderOperation = {
  operationId: string | null;
  normalizedQuery: string;
  startedAt: number;
  exhausted: boolean;
  errorCode: string | null;
  providerStatuses: Array<Exclude<AssistantGeoSingleResolution, { status: 'NOT_APPLICABLE' }>['status']>;
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
    const parsed = parseResolveInputs(body);
    if (parsed.constraints.length > 1) {
      const startedAt = Date.now();
      const providerOperation = this.provider.getProviderName() === 'locationiq' && this.usageLedger
        ? {
            operationId: null,
            normalizedQuery: createCompositeOperationQuery(parsed.constraints),
            startedAt,
            exhausted: false,
            errorCode: null,
            providerStatuses: [],
          }
        : undefined;
      let constraints: AssistantGeoResolutionSlot[] = [];
      try {
        for (const input of parsed.constraints) {
          const slotStartedAt = Date.now();
          const result = input.resolutionPolicy === 'REFINE_REQUIRED'
            ? refineRequired(input)
            : await this.resolveInput(input, actorUserId, slotStartedAt, providerOperation);
          constraints.push(result);
        }
      } catch (error) {
        if (providerOperation?.operationId) {
          await this.finalizeProviderOperation(
            providerOperation.operationId,
            'UNAVAILABLE',
            providerOperation.startedAt,
            'ASSISTANT_GEO_RESOLUTION_INTERNAL_ERROR',
          );
        }
        throw error;
      }
      if (providerOperation?.operationId) {
        const finalized = await this.finalizeProviderOperation(
          providerOperation.operationId,
          summarizeCompositeOperationStatus(providerOperation.providerStatuses),
          providerOperation.startedAt,
          providerOperation.errorCode,
        );
        if (!finalized) {
          constraints = parsed.constraints.map((input) => (
            input.resolutionPolicy === 'REFINE_REQUIRED' ? refineRequired(input) : unavailable(input)
          ));
        }
      }
      return { status: 'COMPOSITE', operator: 'ALL', constraints };
    }

    const startedAt = Date.now();
    const directInput = parsed.constraints[0] ?? null;
    const districtFallback = directInput ? null : parseDistrictFallbackInput(body);
    const input = directInput ?? districtFallback?.input;
    if (!input) return { status: 'NOT_APPLICABLE' };
    if (districtFallback && await this.findAdministrativeDistrict(districtFallback.district)) {
      return { status: 'NOT_APPLICABLE' };
    }
    if (input.resolutionPolicy === 'REFINE_REQUIRED') return refineRequired(input);
    return this.resolveInput(input, actorUserId, startedAt);
  }

  private async resolveInput(
    input: ParsedResolveInput,
    actorUserId: string | null,
    startedAt: number,
    compositeOperation?: CompositeProviderOperation,
  ): Promise<AssistantGeoResolutionSlot> {
    // Direct unit-test callers from T05 do not inject the new repository. Production always does.
    if (!this.landmarks) return this.resolvePointCompatibility(input, actorUserId, startedAt);

    const confirmed = filterLandmarksForMode(
      await this.landmarks.findTrustedByQuery({
        normalizedQuery: input.normalizedQuery,
        normalizedQueries: [...new Set([input.normalizedQuery, ...input.aliases, input.userAlias])],
        mode: input.mode,
        locale: input.locale,
        country: input.expectedCountry ?? input.country,
        viewbox: input.providerViewbox ?? input.viewbox,
        minimumIdentityVersion: input.candidatePolicy ? input.version : undefined,
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
    if (usageLedger && compositeOperation?.exhausted) return unavailable(input);
    const ownsOperation = Boolean(usageLedger && !compositeOperation);
    const operationId = usageLedger
      ? compositeOperation
        ? compositeOperation.operationId ??= await this.beginProviderOperation(
            input,
            actorUserId,
            compositeOperation.normalizedQuery,
          )
        : await this.beginProviderOperation(input, actorUserId)
      : null;
    if (usageLedger && !operationId) {
      if (compositeOperation) {
        compositeOperation.exhausted = true;
        compositeOperation.errorCode = 'ASSISTANT_GEO_OPERATION_CREATE_FAILED';
      }
      return unavailable(input);
    }
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
      compositeOperation?.providerStatuses.push(result.status);
      if (operationId && ownsOperation) {
        const finalized = await this.finalizeProviderOperation(
          operationId,
          result.status,
          startedAt,
          null,
        );
        if (!finalized) return unavailable(input);
      } else if (!operationId) {
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
        if (operationId && ownsOperation) {
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
      if (compositeOperation) {
        compositeOperation.providerStatuses.push(result.status);
        compositeOperation.exhausted ||= shouldExhaustCompositeProviderOperation(error.code);
        compositeOperation.errorCode ??= error.code;
      }
      if (operationId && ownsOperation) {
        await this.finalizeProviderOperation(operationId, result.status, startedAt, error.code);
      } else if (!operationId) {
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
      purpose: input.expectedKind === 'AREA' || (input.expectedKind === null && input.mode === 'INSIDE')
        ? 'FULL_GEOMETRY'
        : 'METADATA',
      expectedKind: input.expectedKind ?? (input.mode === 'INSIDE' ? 'AREA' : null),
      query: input.providerQuery,
      locale: input.locale,
      country: input.expectedCountry ?? input.country,
      viewbox: input.providerViewbox ?? input.viewbox,
    });
    let calls = lookup.providerCallCount;
    if (lookup.candidates.length === 0) {
      return {
        landmarks: [], calls, provider: this.provider.getProviderName(),
        cacheExpiresAt: new Date(Date.now() + this.provider.getCacheRetentionMs()),
      };
    }
    const providerCandidates = selectAssistantGeoProviderCandidates(
      lookup.candidates,
      input,
      this.provider.getProviderName(),
    );
    const saved: AssistantTrustedLandmark[] = [];
    const savedExpiries: Date[] = [];
    let finalProvider: 'fake' | 'locationiq' | 'overpass' = this.provider.getProviderName();
    let cityLookupPromise: Promise<AssistantGeoProviderCandidate | null> | null = null;
    let overpassPromise: ReturnType<AssistantOverpassCollector['collect']> | null = null;
    const resolveCityArea = (city: string) => {
      cityLookupPromise ??= this.provider.searchWithTelemetry({
        purpose: 'BOUNDS',
        expectedKind: 'AREA',
        query: city,
        locale: input.locale,
        country: input.expectedCountry ?? input.country,
        viewbox: input.providerViewbox,
      }).then((cityLookup) => {
        calls += cityLookup.providerCallCount;
        const areas = cityLookup.candidates.filter((item) => isExpectedAssistantGeoAdministrativeBounds(item, {
          expectedCity: city,
          expectedCountry: input.expectedCountry ?? input.country,
          expectedBounds: input.providerViewbox,
        }));
        return areas.length === 1 ? areas[0]! : null;
      });
      return cityLookupPromise;
    };
    const collectRoad = (candidate: AssistantGeoProviderCandidate) => {
      const city = input.expectedCity ?? candidate.city;
      if (!city || !this.overpass) {
        throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_UNAVAILABLE', false);
      }
      overpassPromise ??= resolveCityArea(city).then((cityArea) => {
        if (!cityArea?.boundingBox) {
          throw new AssistantOverpassError('ASSISTANT_OVERPASS_CITY_AREA_UNAVAILABLE', false);
        }
        calls += 1;
        return this.overpass!.collect({
          name: input.providerQuery,
          tagValues: input.overpassTagValues,
          relationIds: input.overpassRelationIds,
          city,
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
      country: candidate.countryCode ?? input.expectedCountry ?? input.country,
      city: candidate.city ?? input.expectedCity,
      geometry,
      sourceProvider,
      sourceExternalId,
      expiresAt,
      sourceMetadata: {
        entityType,
        fetchedAt: new Date().toISOString(),
        version: 2,
        identityVersion: input.version,
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
        country: input.expectedCountry ?? input.country ?? '',
        viewboxKey: createViewboxKey(input.providerViewbox ?? input.viewbox),
        provider: `${this.provider.getProviderName()}-geometry-v3`,
        candidatesJson,
        expiresAt,
      },
    });
  }

  private async beginProviderOperation(
    input: ParsedResolveInput,
    actorUserId: string | null,
    normalizedQuery = input.normalizedQuery,
  ) {
    const id = randomUUID();
    try {
      await this.prisma.assistantGeoOperation.create({
        data: {
          id,
          actorUserId,
          normalizedQuery,
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
  ): Promise<AssistantGeoResolutionSlot> {
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
        purpose: 'METADATA',
        expectedKind: 'POINT',
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

  async findAdministrativeDistrict(name: string) {
    const normalizedName = normalizeAssistantGeoIdentityText(name);
    const pattern = `%${escapeLikePattern(normalizedName)}%`;
    const districts = await this.prisma.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
      SELECT "id"::text AS id, "name"
      FROM "locations"
      WHERE "type"::text = 'district' AND (
        replace(lower(coalesce("name", '')), 'ё', 'е') LIKE ${pattern} ESCAPE '\\'
        OR to_tsvector('russian', replace(lower(coalesce("name", '')), 'ё', 'е'))
          @@ plainto_tsquery('russian', ${normalizedName})
      )
      ORDER BY
        (replace(lower(coalesce("name", '')), 'ё', 'е') = ${normalizedName}) DESC,
        length("name") ASC,
        "id" ASC
      LIMIT 1
    `);
    return districts[0] ?? null;
  }

  async matchesTrustedLandmark(id: string, query: string) {
    if (!this.landmarks) return false;
    const identity = resolveAssistantGeoLandmarkIdentity(query);
    return this.landmarks.matchesTrustedIdentity(id, [
      identity.userAlias,
      identity.normalizedQuery,
      ...identity.aliases,
    ]);
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

const geoClauseMarkerPattern = /(?:^|[\s,;])(?:(?<distance>(?:в\s+радиусе|радиус(?:ом)?|не\s+дальше|в\s+пределах|на\s+расстоянии(?:\s+не\s+более)?|до|в)\s*(?<amount>\d+(?:[.,]\d+)?)\s*(?<unit>км|километр(?:а|ов)?|метр(?:а|ов)?|м)(?!\p{L})\s+от)|(?<inside>внутри)|(?<near>рядом\s+с|возле|около|вокруг)|(?<at>у))\s+/giu;
const trailingGeoDistancePattern = /\s+(?:(?:в\s+радиусе|радиус(?:ом)?|не\s+дальше|в\s+пределах|на\s+расстоянии(?:\s+не\s+более)?|до)\s*)(?<amount>\d+(?:[.,]\d+)?)\s*(?<unit>км|километр(?:а|ов)?|метр(?:а|ов)?|м)(?!\p{L})\s*$/iu;
const genericGeoPlaceholderSequencePattern = /^(?:(?:(?:так|как)\p{L}*(?:-|\s+)(?:то|нибудь)|ближайш\p{L}*|люб\p{L}*)(?:\s+|$))+$/iu;
const nonGeoAtSubjectPattern = /^(?:жк|метро|застройщик\p{L}*|собственник\p{L}*|владелец\p{L}*|ри[еэ]лтор\p{L}*|агент\p{L}*|девелопер\p{L}*|брокер\p{L}*|меня|нас|вас|него|нее|неё|них|кого|чего|котор\p{L}*)(?=$|[^\p{L}\p{N}_])/iu;
const genericGeoCategories: Array<{ category: AssistantGeoCategory; pattern: RegExp; canonical: string }> = [
  { category: 'WATER', pattern: /^(?:вода|воды|водоем\p{L}*|водоём\p{L}*)$/iu, canonical: 'вода' },
  { category: 'RIVER', pattern: /^(?:река|реки|реке|реку|рекой|рекою)$/iu, canonical: 'река' },
  { category: 'PARK', pattern: /^(?:парк|парка|парке|парком|сквер|сквера|сквере|сквером)$/iu, canonical: 'парк' },
  { category: 'BRIDGE', pattern: /^(?:мост|моста|мосте|мостом)$/iu, canonical: 'мост' },
  { category: 'SCHOOL', pattern: /^(?:школа|школы|школе|школу|школой|гимнази\p{L}*|лице\p{L}*)$/iu, canonical: 'школа' },
];

export function parseResolveInputs(value: unknown): ParsedResolveInputs {
  if (!isRecord(value)) throw new BadRequestException('ASSISTANT_GEO_RESOLVE_INPUT_INVALID');
  const content = typeof value.content === 'string'
    ? normalizeAssistantMessageContent(value.content)
    : '';
  if (!content || content.length > 4_000) throw new BadRequestException('ASSISTANT_GEO_CONTENT_INVALID');
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
  const markers = [...content.matchAll(geoClauseMarkerPattern)].flatMap((match) => {
    if (match.index === undefined || isInsideQuotedText(content, match.index)) return [];
    const bodyStart = match.index + match[0].length;
    const groups = match.groups ?? {};
    if (groups.at && nonGeoAtSubjectPattern.test(content.slice(bodyStart).trimStart())) {
      return [{ start: match.index, bodyStart, isGeo: false, mode: 'NEAR' as const, distanceMeters: null }];
    }
    const distanceMeters = groups.distance
      ? parseDistance(groups.amount ?? '', groups.unit ?? '')
      : null;
    return [{
      start: match.index,
      bodyStart,
      isGeo: true,
      mode: groups.inside ? 'INSIDE' as const : 'NEAR' as const,
      distanceMeters,
    }];
  });

  const constraints: ParsedResolveInput[] = [];
  for (const [markerIndex, marker] of markers.entries()) {
    if (!marker.isGeo) continue;
    const nextMarker = markers.slice(markerIndex + 1).find(({ start }) => start >= marker.bodyStart);
    const rawSource = content.slice(marker.bodyStart, nextMarker?.start ?? content.length);
    if (nextMarker && hasTrailingUnquotedDisjunction(rawSource)) {
      throw new BadRequestException('ASSISTANT_GEO_BOOLEAN_OPERATOR_UNSUPPORTED');
    }
    const rawTrailingDistance = extractTrailingGeoDistance(rawSource);
    const cleanedSource = cleanGeoClauseText(rawTrailingDistance.placeQuery);
    const trailingDistance = extractTrailingGeoDistance(cleanedSource);
    const suffixDistanceMeters = rawTrailingDistance.distanceMeters ?? trailingDistance.distanceMeters;
    if (marker.distanceMeters !== null && suffixDistanceMeters !== null) {
      throw new BadRequestException('ASSISTANT_GEO_CLAUSE_INVALID');
    }
    const sourceText = trailingDistance.placeQuery;
    if (!sourceText) throw new BadRequestException('ASSISTANT_GEO_CLAUSE_INVALID');
    if (/^(?:выбранн\p{L}*\s+точк\p{L}*|точк\p{L}*\s+на\s+карт\p{L}*)$/iu.test(sourceText)) continue;
    const normalized = normalizeGeoCategoryPhrase(sourceText);
    const placeQuery = readText(normalized.placeQuery, 240);
    if (!placeQuery || /^\d/u.test(placeQuery)) {
      throw new BadRequestException('ASSISTANT_GEO_CLAUSE_INVALID');
    }
    const distanceMeters = marker.distanceMeters ?? suffixDistanceMeters;
    if (distanceMeters !== null) {
      parseAssistantGeoSearchInput({
        anchor: { latitude: 0, longitude: 0, label: placeQuery, source: 'PLACE' },
        radiusMeters: distanceMeters,
      });
    }
    const identity = resolveAssistantGeoLandmarkIdentity(placeQuery);
    const sourceSpan = createGeoSourceSpan(content, marker, rawSource, sourceText, suffixDistanceMeters);
    constraints.push({
      slotId: `geo-${constraints.length + 1}`,
      sourceText,
      sourceSpan,
      category: normalized.category,
      resolutionPolicy: isGenericGeoPhrase(normalized.placeQuery, normalized.category)
        ? 'REFINE_REQUIRED'
        : 'LOOKUP',
      ...identity,
      placeQuery: identity.label,
      mode: marker.mode,
      explicitDistanceMeters: distanceMeters,
      radiusMeters: distanceMeters,
      locale,
      country,
      viewbox,
    });
    if (constraints.length > 5) {
      throw new BadRequestException('ASSISTANT_GEO_TOO_MANY_CONSTRAINTS');
    }
  }
  return { operator: 'ALL', constraints };
}

export function parseResolveInput(value: unknown): ParsedResolveInput | null {
  return parseResolveInputs(value).constraints[0] ?? null;
}

export function stripAssistantGeoClauses(content: string): string {
  if (content.length > 4_000) {
    return content.split('\n').map((message) => stripAssistantGeoClauses(message)).join('\n');
  }
  const normalizedContent = normalizeAssistantMessageContent(content);
  const spans = parseResolveInputs({ content: normalizedContent }).constraints
    .map(({ sourceSpan }) => sourceSpan)
    .sort((left, right) => right.start - left.start);
  const stripped = spans.reduce(
    (result, span) => `${result.slice(0, span.start)} ${result.slice(span.end)}`,
    normalizedContent,
  ).replace(/\s+/gu, ' ').trim();
  return stripped.replace(/^(?:и|,)\s+/iu, '').replace(/\s+(?:и|,)$/iu, '').trim();
}

function createGeoSourceSpan(
  content: string,
  marker: { start: number; bodyStart: number },
  rawSource: string,
  sourceText: string,
  trailingDistanceMeters: number | null,
) {
  const markerPrefix = content.slice(marker.start, marker.bodyStart);
  const leadingDelimiterLength = /^[\s,;]/u.test(markerPrefix) ? 1 : 0;
  const sourceOffset = rawSource.toLocaleLowerCase('ru-RU').indexOf(sourceText.toLocaleLowerCase('ru-RU'));
  let bodyLength = sourceOffset >= 0 ? sourceOffset + sourceText.length : rawSource.trimEnd().length;
  if (trailingDistanceMeters !== null) {
    const trailing = trailingGeoDistancePattern.exec(rawSource);
    if (trailing?.index !== undefined) bodyLength = trailing.index + trailing[0].length;
  }
  return {
    start: marker.start + leadingDelimiterLength,
    end: Math.min(content.length, marker.bodyStart + bodyLength),
  };
}

function parseDistrictFallbackInput(value: unknown): ParsedDistrictFallback | null {
  if (!isRecord(value)) throw new BadRequestException('ASSISTANT_GEO_RESOLVE_INPUT_INVALID');
  const content = typeof value.content === 'string'
    ? normalizeAssistantMessageContent(value.content)
    : '';
  if (!content || content.length > 2_000) throw new BadRequestException('ASSISTANT_GEO_CONTENT_INVALID');
  const district = extractAssistantDistrictFromText(content, true);
  if (!district) return null;
  const input = parseResolveInput({ ...value, content: `возле ${district}` });
  return input ? { district, input } : null;
}

export function normalizePlaceQuery(value: string) {
  return normalizeAssistantGeoIdentityText(value);
}

export function createCacheKey(
  input: Pick<ParsedResolveInput, 'placeQuery' | 'mode' | 'locale' | 'country' | 'viewbox'>
    & Partial<Pick<ParsedResolveInput, 'normalizedQuery' | 'expectedCountry' | 'providerViewbox'>>,
) {
  return createHash('sha256').update(JSON.stringify({
    version: 'geometry-v3',
    query: input.normalizedQuery ?? normalizePlaceQuery(input.placeQuery),
    mode: input.mode,
    locale: input.locale,
    country: input.expectedCountry ?? input.country ?? '',
    viewbox: createViewboxKey(input.providerViewbox ?? input.viewbox),
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

function parseDistance(amount: string, unit: string) {
  const value = Number(amount.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) throw new BadRequestException('ASSISTANT_GEO_RADIUS_INVALID');
  return Math.round(value * (/^(?:км|километр)/iu.test(unit) ? 1_000 : 1));
}

function cleanGeoClauseText(value: string) {
  const quoted = protectQuotedText(value);
  const cleaned = quoted.value
    .replace(/[.!?;]+$/gu, '')
    .replace(/^\s*(?:(?:и)(?=\s|,)|,)+\s*/iu, '')
    .replace(/\s+и\s*$/iu, '')
    .replace(/\s+(?:найди|покажи|подбери)(?=$|[^\p{L}\p{N}_]).*$/iu, '')
    .split(/[,;]\s*(?=(?:в\s+)?район(?:е)?\s+)/iu, 1)[0]!
    .split(/,\s*(?=(?:например(?=\s|,|$)|бюджет(?=\s|,|$)|(?:до|не\s+дороже|максимум)\s+\d|\d{1,2}\s*[- ]?\s*комн|студи\p{L}*|однуш\p{L}*|однокомнат\p{L}*|двуш\p{L}*|двухкомнат\p{L}*|треш\p{L}*|трехкомнат\p{L}*))/iu, 1)[0]!
    .replace(/\s+(?=(?:в\s+район(?:е)?(?=\s)|у\s+метро(?=\s)|(?<!станции\s)(?<!станция\s)(?<!станцию\s)(?<!станцией\s)(?<!ст\.\s)метро(?=\s)|(?:от\s+)?застройщик\p{L}*|бюджет(?=\s|,|$)|(?:до|не\s+дороже|максимум)\s+\d|(?:от|не\s+дешевле|минимум)\s+\d+(?:[.,]\d+)?(?:\s+до\s+\d+(?:[.,]\d+)?)?\s*(?:млн\p{L}*|миллион\p{L}*|тыс\p{L}*|руб\p{L}*)|(?:от|не\s+ниже|не\s+выше)\s+-?\d+\s*этаж\p{L}*|(?:от|до|не\s+меньше|не\s+больше)\s+\d+(?:[.,]\d+)?\s*(?:м2|м²|кв)|(?:комфорт|бизнес|премиум|элит)\s*[- ]?класс\p{L}*|\d{1,2}\s*[- ]?\s*комн|студи\p{L}*|однуш\p{L}*|однокомнат\p{L}*|двуш\p{L}*|двухкомнат\p{L}*|треш\p{L}*|трехкомнат\p{L}*|жил\p{L}*|коммерчес\p{L}*|квартир\p{L}*|апартамент\p{L}*|площад\p{L}*|этаж\p{L}*|сдач\p{L}*|готов\p{L}*|класс\p{L}*))[^,;.!?]*$/iu, '')
    .replace(/\s+и\s*$/iu, '')
    .replace(/[,\s.!?;]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return unwrapQuotedClause(quoted.restore(cleaned));
}

function normalizeGeoCategoryPhrase(value: string) {
  const parts = value.split(/\s+/u);
  const matches = parts.flatMap((part, index) => {
    const category = genericGeoCategories.find(({ pattern }) => pattern.test(part));
    return category ? [{ category, index }] : [];
  });
  const match = matches.find(({ index }) => index === 0)
    ?? matches.find(({ index }) => isGenericGeoPlaceholderText(parts.slice(0, index).join(' ')))
    ?? null;
  if (match) parts[match.index] = match.category.canonical;
  return {
    category: match?.category.category ?? null,
    placeQuery: match ? parts.join(' ') : value,
  };
}

function isGenericGeoPhrase(value: string, category: AssistantGeoCategory | null) {
  if (!category) return false;
  const categoryPattern = genericGeoCategories.find((entry) => entry.category === category)?.pattern;
  const remainder = value
    .split(/\s+/u)
    .filter((part) => !categoryPattern?.test(part))
    .join(' ')
    .trim();
  return remainder.length === 0 || isGenericGeoPlaceholderText(remainder);
}

function isInsideQuotedText(value: string, index: number) {
  return findQuotedSpans(value).some(({ start, end }) => index > start && index < end);
}

function hasTrailingUnquotedDisjunction(value: string) {
  const quoted = protectQuotedText(value);
  return /(?:^|[^\p{L}\p{N}_])(?:или|либо)(?:\s+же)?[\s,;—–-]*$/iu.test(quoted.value);
}

function extractTrailingGeoDistance(value: string) {
  const quoted = protectQuotedText(value);
  const match = trailingGeoDistancePattern.exec(quoted.value);
  if (!match?.groups || match.index === undefined) {
    return { placeQuery: value, distanceMeters: null };
  }
  return {
    placeQuery: trimTrailingGeoConnector(
      unwrapQuotedClause(quoted.restore(quoted.value.slice(0, match.index)).trim()),
    ),
    distanceMeters: parseDistance(match.groups.amount ?? '', match.groups.unit ?? ''),
  };
}

function trimTrailingGeoConnector(value: string) {
  return value
    .replace(/[,;—–\s-]+$/gu, '')
    .replace(/\s+и$/iu, '')
    .replace(/[,;—–\s-]+$/gu, '')
    .trim();
}

function isGenericGeoPlaceholderText(value: string) {
  const withoutPerspective = value
    .replace(/(?:^|\s+)ко\s+мне(?=$|\s+)/iu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return withoutPerspective.length > 0
    && genericGeoPlaceholderSequencePattern.test(withoutPerspective);
}

function protectQuotedText(value: string) {
  const spans = findQuotedSpans(value);
  let cursor = 0;
  let protectedValue = '';
  const replacements: string[] = [];
  for (const { start, end } of spans) {
    protectedValue += value.slice(cursor, start);
    const token = `\uE000${replacements.length}\uE001`;
    replacements.push(value.slice(start, end + 1));
    protectedValue += token;
    cursor = end + 1;
  }
  protectedValue += value.slice(cursor);
  return {
    value: protectedValue,
    restore(input: string) {
      return input.replace(/\uE000(\d+)\uE001/gu, (_token, index: string) => replacements[Number(index)] ?? '');
    },
  };
}

function findQuotedSpans(value: string) {
  const spans: Array<{ start: number; end: number }> = [];
  const quotePairs: Record<string, string> = { '«': '»', '"': '"', '“': '”', '„': '”' };
  for (let index = 0; index < value.length; index += 1) {
    const close = quotePairs[value[index] ?? ''];
    if (!close) continue;
    const end = value.indexOf(close, index + 1);
    if (end < 0) continue;
    spans.push({ start: index, end });
    index = end;
  }
  return spans;
}

function unwrapQuotedClause(value: string) {
  const pairs: Array<[string, string]> = [['«', '»'], ['"', '"'], ['“', '”'], ['„', '”']];
  const pair = pairs.find(([open, close]) => value.startsWith(open) && value.endsWith(close));
  return pair ? value.slice(pair[0].length, -pair[1].length).trim() : value;
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

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function resolved(
  input: ParsedResolveInput,
  candidates: AssistantGeoCandidate[],
  compatibilityRadius?: number,
): AssistantGeoResolutionSlot {
  return {
    status: candidates.length === 1 ? 'RESOLVED' : 'AMBIGUOUS',
    placeQuery: input.placeQuery,
    ...(compatibilityRadius ? { radiusMeters: compatibilityRadius } : {}),
    candidates: candidates.slice(0, 3),
    slotId: input.slotId,
    sourceText: input.sourceText,
    sourceSpan: input.sourceSpan,
    mode: input.mode,
    ...(input.explicitDistanceMeters !== null ? { distanceMeters: input.explicitDistanceMeters } : {}),
  };
}

function notFound(
  input: ParsedResolveInput,
  compatibilityRadius?: number,
): AssistantGeoResolutionSlot {
  return {
    status: 'NOT_FOUND',
    placeQuery: input.placeQuery,
    ...(compatibilityRadius ? { radiusMeters: compatibilityRadius } : {}),
    actions: ['MANUAL', 'REFINE'],
    slotId: input.slotId,
    sourceText: input.sourceText,
    sourceSpan: input.sourceSpan,
    mode: input.mode,
    ...(input.explicitDistanceMeters !== null ? { distanceMeters: input.explicitDistanceMeters } : {}),
  };
}

function unavailable(
  input: ParsedResolveInput,
  compatibilityRadius?: number,
): AssistantGeoResolutionSlot {
  return {
    status: 'UNAVAILABLE',
    placeQuery: input.placeQuery,
    ...(compatibilityRadius ? { radiusMeters: compatibilityRadius } : {}),
    actions: ['MANUAL', 'REFINE'],
    slotId: input.slotId,
    sourceText: input.sourceText,
    sourceSpan: input.sourceSpan,
    mode: input.mode,
    ...(input.explicitDistanceMeters !== null ? { distanceMeters: input.explicitDistanceMeters } : {}),
  };
}

function refineRequired(
  input: ParsedResolveInput,
): AssistantGeoResolutionSlot {
  return {
    status: 'REFINE_REQUIRED',
    placeQuery: input.placeQuery,
    actions: ['REFINE', 'MANUAL'],
    slotId: input.slotId,
    sourceText: input.sourceText,
    sourceSpan: input.sourceSpan,
    mode: input.mode,
    ...(input.explicitDistanceMeters !== null ? { distanceMeters: input.explicitDistanceMeters } : {}),
  };
}

function summarizeCompositeOperationStatus(
  statuses: Array<Exclude<AssistantGeoSingleResolution, { status: 'NOT_APPLICABLE' }>['status']>,
): Exclude<AssistantGeoSingleResolution, { status: 'NOT_APPLICABLE' }>['status'] {
  if (statuses.includes('UNAVAILABLE')) return 'UNAVAILABLE';
  if (statuses.includes('NOT_FOUND')) return 'NOT_FOUND';
  if (statuses.includes('REFINE_REQUIRED')) return 'REFINE_REQUIRED';
  if (statuses.includes('AMBIGUOUS')) return 'AMBIGUOUS';
  return 'RESOLVED';
}

function createCompositeOperationQuery(constraints: ParsedResolveInput[]) {
  const providerQueries = constraints
    .filter(({ resolutionPolicy }) => resolutionPolicy === 'LOOKUP')
    .map(({ normalizedQuery }) => normalizedQuery);
  const fingerprint = createHash('sha256').update(JSON.stringify(providerQueries)).digest('hex');
  return `composite-all:${fingerprint}`;
}

function shouldExhaustCompositeProviderOperation(code: string) {
  return code === 'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED'
    || code === 'ASSISTANT_GEO_TOTAL_RESOLUTION_BUDGET_EXHAUSTED'
    || code === 'ASSISTANT_GEO_PROVIDER_DISABLED'
    || code === 'ASSISTANT_GEO_PROVIDER_CIRCUIT_OPEN'
    || code.startsWith('ASSISTANT_GEO_PROVIDER_MINUTE_BUDGET_EXHAUSTED')
    || code.startsWith('ASSISTANT_GEO_PROVIDER_DAILY_BUDGET_EXHAUSTED')
    || code.startsWith('ASSISTANT_GEO_OPERATION_')
    || code === 'ASSISTANT_GEO_RESOLUTION_CONTEXT_REQUIRED'
    || code.startsWith('ASSISTANT_GEO_USAGE_');
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

export function normalizeAssistantMessageContent(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
