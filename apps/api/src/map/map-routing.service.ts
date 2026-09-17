import {
  BadRequestException,
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  MapRoutingCoordinate,
  MapWalkingRoutesRequest,
  MapWalkingRoutesResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';

type OpenRouteServiceMatrixResponse = {
  distances?: unknown;
  durations?: unknown;
};

type CachedWalkingRoutes = {
  response: MapWalkingRoutesResponse;
  isStale: boolean;
};

type WalkingRoutePair = {
  cacheKey: string;
  origin: MapRoutingCoordinate;
  destination: MapRoutingCoordinate;
};

type WalkingRouteMatrix = {
  distances: Array<Array<number | null>>;
  durations: Array<Array<number | null>>;
};

export type MapWalkingRoutesWarmup = {
  requests: number;
  pairs: number;
  fetched: number;
  providerCalls: number;
};

const DEFAULT_OPENROUTESERVICE_API_URL = 'https://api.openrouteservice.org';
const DEFAULT_OPENROUTESERVICE_TIMEOUT_MS = 5_000;
const DEFAULT_OPENROUTESERVICE_CACHE_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1_000;
const DEFAULT_OPENROUTESERVICE_MAX_RETRIES = 2;
// The public matrix endpoint accepts up to 3500 routes (sources × destinations) per request; the
// default keeps a margin so a bulk warm-up never burns a daily-quota request on a rejected call.
const DEFAULT_OPENROUTESERVICE_MATRIX_MAX_ROUTES = 2_500;
const MAX_OPENROUTESERVICE_MATRIX_MAX_ROUTES = 3_500;
const MAX_OPENROUTESERVICE_RETRIES = 5;
const MAX_OPENROUTESERVICE_RETRY_DELAY_MS = 2_000;
const ROUTING_CACHE_PERSIST_CHUNK = 100;
const ROUTING_CACHE_PROVIDER = 'openrouteservice';
const ROUTING_CACHE_PROFILE = 'foot-walking';
const ROUTING_CACHE_VERSION = 'v1';

@Injectable()
export class MapRoutingService {
  private readonly logger = new Logger(MapRoutingService.name);
  private readonly apiKey = process.env.OPENROUTESERVICE_API_KEY?.trim() ?? '';
  private readonly apiUrl = (process.env.OPENROUTESERVICE_API_URL?.trim() || DEFAULT_OPENROUTESERVICE_API_URL).replace(
    /\/+$/u,
    '',
  );
  private readonly timeoutMs = this.parsePositiveInteger(
    process.env.OPENROUTESERVICE_TIMEOUT_MS,
    DEFAULT_OPENROUTESERVICE_TIMEOUT_MS,
  );
  private readonly cacheStaleAfterMs = this.parsePositiveInteger(
    process.env.OPENROUTESERVICE_CACHE_STALE_AFTER_MS,
    DEFAULT_OPENROUTESERVICE_CACHE_STALE_AFTER_MS,
  );
  private readonly maxRetries = this.parseNonNegativeInteger(
    process.env.OPENROUTESERVICE_MAX_RETRIES,
    DEFAULT_OPENROUTESERVICE_MAX_RETRIES,
  );
  private readonly matrixMaxRoutes = Math.min(
    this.parsePositiveInteger(
      process.env.OPENROUTESERVICE_MATRIX_MAX_ROUTES,
      DEFAULT_OPENROUTESERVICE_MATRIX_MAX_ROUTES,
    ),
    MAX_OPENROUTESERVICE_MATRIX_MAX_ROUTES,
  );
  private readonly inFlightRequests = new Map<string, Promise<MapWalkingRoutesResponse>>();

  constructor(private readonly prisma: PrismaService) {}

  async getWalkingRoutes(input: unknown): Promise<MapWalkingRoutesResponse> {
    const request = this.parseRequest(input);
    const cached = await this.readCachedRoutes(request);

    if (cached) {
      if (cached.isStale && this.apiKey) {
        this.refreshStaleRoutes(request);
      }

      return cached.response;
    }

    if (!this.apiKey) {
      throw new ServiceUnavailableException('Walking routes are not configured');
    }

    return this.fetchAndPersistRoutes(request);
  }

  async refreshWalkingRoutes(input: unknown): Promise<MapWalkingRoutesResponse> {
    const request = this.parseRequest(input);

    if (!this.apiKey) {
      throw new ServiceUnavailableException('Walking routes are not configured');
    }

    return this.fetchAndPersistRoutes(request);
  }

  // Bulk cache warm-up: every origin→destination pair that is missing or stale is fetched through
  // multi-source matrix requests (many origins × the union of their destinations per call), so a
  // directory-wide refresh costs a handful of provider requests instead of one per origin. Only
  // the requested pairs are persisted; later getWalkingRoutes calls for them are cache hits.
  async warmWalkingRoutes(inputs: unknown[]): Promise<MapWalkingRoutesWarmup> {
    if (!Array.isArray(inputs)) {
      throw new BadRequestException('Walking routes warm-up input is invalid');
    }
    const requests = inputs.map((input) => this.parseRequest(input));
    const pairsByKey = new Map<string, WalkingRoutePair>();
    for (const request of requests) {
      for (const destination of request.destinations) {
        const cacheKey = this.createRouteCacheKey(request.origin, destination);
        if (!pairsByKey.has(cacheKey)) pairsByKey.set(cacheKey, { cacheKey, origin: request.origin, destination });
      }
    }
    const pending = await this.readMissingPairs([...pairsByKey.values()]);
    const summary: MapWalkingRoutesWarmup = {
      requests: requests.length,
      pairs: pairsByKey.size,
      fetched: 0,
      providerCalls: 0,
    };
    if (pending.length === 0) return summary;
    if (!this.apiKey) {
      throw new ServiceUnavailableException('Walking routes are not configured');
    }

    for (const group of this.groupPairsForMatrix(pending)) {
      const matrix = await this.requestMatrix(group.origins, group.destinations);
      summary.providerCalls += 1;
      const routes = group.pairs.map((pair) => {
        const originIndex = group.originIndexByKey.get(this.coordinateKey(pair.origin));
        const destinationIndex = group.destinationIndexByKey.get(this.coordinateKey(pair.destination));
        const distance = originIndex === undefined || destinationIndex === undefined
          ? undefined
          : matrix.distances[originIndex]?.[destinationIndex];
        const duration = originIndex === undefined || destinationIndex === undefined
          ? undefined
          : matrix.durations[originIndex]?.[destinationIndex];
        if (distance === undefined || duration === undefined) {
          throw new BadGatewayException('Walking route provider returned an invalid matrix');
        }
        return {
          origin: pair.origin,
          destination: pair.destination,
          distanceMeters: distance === null ? null : Math.round(distance),
          durationSeconds: duration === null ? null : Math.round(duration),
        };
      });
      await this.persistRoutePairs(routes);
      summary.fetched += routes.length;
    }

    return summary;
  }

  private async readMissingPairs(pairs: WalkingRoutePair[]) {
    const fresh = new Set<string>();
    const staleAfter = Date.now() - this.cacheStaleAfterMs;
    for (let index = 0; index < pairs.length; index += ROUTING_CACHE_PERSIST_CHUNK * 5) {
      const chunk = pairs.slice(index, index + ROUTING_CACHE_PERSIST_CHUNK * 5);
      const cachedRoutes = await this.prisma.mapWalkingRouteCache.findMany({
        where: { cacheKey: { in: chunk.map(({ cacheKey }) => cacheKey) } },
        select: { cacheKey: true, calculatedAt: true },
      });
      for (const route of cachedRoutes) {
        if (route.calculatedAt.getTime() > staleAfter) fresh.add(route.cacheKey);
      }
    }
    return pairs.filter(({ cacheKey }) => !fresh.has(cacheKey));
  }

  private groupPairsForMatrix(pairs: WalkingRoutePair[]) {
    const pairsByOrigin = new Map<string, { origin: MapRoutingCoordinate; pairs: WalkingRoutePair[] }>();
    for (const pair of pairs) {
      const originKey = this.coordinateKey(pair.origin);
      const entry = pairsByOrigin.get(originKey) ?? { origin: pair.origin, pairs: [] };
      entry.pairs.push(pair);
      pairsByOrigin.set(originKey, entry);
    }

    const groups: Array<{
      origins: MapRoutingCoordinate[];
      destinations: MapRoutingCoordinate[];
      originIndexByKey: Map<string, number>;
      destinationIndexByKey: Map<string, number>;
      pairs: WalkingRoutePair[];
    }> = [];
    let current = this.createMatrixGroup();
    for (const entry of pairsByOrigin.values()) {
      const newDestinations = entry.pairs
        .map(({ destination }) => this.coordinateKey(destination))
        .filter((key, index, keys) => keys.indexOf(key) === index && !current.destinationIndexByKey.has(key));
      const routes = (current.origins.length + 1) * (current.destinations.length + newDestinations.length);
      if (current.origins.length > 0 && routes > this.matrixMaxRoutes) {
        groups.push(current);
        current = this.createMatrixGroup();
      }
      current.originIndexByKey.set(this.coordinateKey(entry.origin), current.origins.length);
      current.origins.push(entry.origin);
      for (const pair of entry.pairs) {
        const destinationKey = this.coordinateKey(pair.destination);
        if (!current.destinationIndexByKey.has(destinationKey)) {
          current.destinationIndexByKey.set(destinationKey, current.destinations.length);
          current.destinations.push(pair.destination);
        }
        current.pairs.push(pair);
      }
    }
    if (current.origins.length > 0) groups.push(current);

    return groups;
  }

  private createMatrixGroup() {
    return {
      origins: [] as MapRoutingCoordinate[],
      destinations: [] as MapRoutingCoordinate[],
      originIndexByKey: new Map<string, number>(),
      destinationIndexByKey: new Map<string, number>(),
      pairs: [] as WalkingRoutePair[],
    };
  }

  private coordinateKey(coordinate: MapRoutingCoordinate) {
    return `${this.normalizeCoordinate(coordinate[0])}:${this.normalizeCoordinate(coordinate[1])}`;
  }

  private async fetchAndPersistRoutes(request: MapWalkingRoutesRequest) {
    const requestKey = JSON.stringify(request);
    const inFlightRequest = this.inFlightRequests.get(requestKey);

    if (inFlightRequest) {
      return inFlightRequest;
    }

    const requestPromise = this.requestWalkingRoutes(request).then(async (value) => {
      await this.persistRoutes(request, value);
      return value;
    });
    this.inFlightRequests.set(requestKey, requestPromise);

    try {
      return await requestPromise;
    } finally {
      if (this.inFlightRequests.get(requestKey) === requestPromise) {
        this.inFlightRequests.delete(requestKey);
      }
    }
  }

  private async readCachedRoutes(request: MapWalkingRoutesRequest): Promise<CachedWalkingRoutes | null> {
    const destinations = request.destinations.map((destination, destinationIndex) => ({
      cacheKey: this.createRouteCacheKey(request.origin, destination),
      destinationIndex,
    }));
    const uniqueCacheKeys = [...new Set(destinations.map(({ cacheKey }) => cacheKey))];
    const cachedRoutes = await this.prisma.mapWalkingRouteCache.findMany({
      where: { cacheKey: { in: uniqueCacheKeys } },
      select: {
        cacheKey: true,
        calculatedAt: true,
        distanceMeters: true,
        durationSeconds: true,
      },
    });

    if (cachedRoutes.length !== uniqueCacheKeys.length) {
      return null;
    }

    const cachedByKey = new Map(cachedRoutes.map((route) => [route.cacheKey, route]));

    return {
      isStale: cachedRoutes.some(
        (route) => route.calculatedAt.getTime() <= Date.now() - this.cacheStaleAfterMs,
      ),
      response: {
        routes: destinations.map(({ cacheKey, destinationIndex }) => {
          const route = cachedByKey.get(cacheKey);

          if (!route) {
            throw new ServiceUnavailableException('Walking route cache is inconsistent');
          }

          return {
            destinationIndex,
            distanceMeters: route.distanceMeters,
            durationSeconds: route.durationSeconds,
          };
        }),
      },
    };
  }

  private refreshStaleRoutes(request: MapWalkingRoutesRequest) {
    void this.fetchAndPersistRoutes(request).catch(() => {
      this.logger.warn('Background walking route cache refresh failed; stale data remains available');
    });
  }

  private async persistRoutes(request: MapWalkingRoutesRequest, response: MapWalkingRoutesResponse) {
    await this.persistRoutePairs(response.routes.map((route) => {
      const destination = request.destinations[route.destinationIndex];

      if (!destination) {
        throw new BadGatewayException('Walking route provider returned an invalid destination index');
      }

      return {
        origin: request.origin,
        destination,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
      };
    }));
  }

  private async persistRoutePairs(routes: Array<{
    origin: MapRoutingCoordinate;
    destination: MapRoutingCoordinate;
    distanceMeters: number | null;
    durationSeconds: number | null;
  }>) {
    const calculatedAt = new Date();
    const uniqueRoutes = [...new Map(routes.map((route) => [
      this.createRouteCacheKey(route.origin, route.destination),
      route,
    ])).entries()];

    for (let index = 0; index < uniqueRoutes.length; index += ROUTING_CACHE_PERSIST_CHUNK) {
      await this.prisma.$transaction(
        uniqueRoutes.slice(index, index + ROUTING_CACHE_PERSIST_CHUNK).map(([cacheKey, route]) => {
          const data = {
            provider: ROUTING_CACHE_PROVIDER,
            profile: ROUTING_CACHE_PROFILE,
            originLatitude: this.normalizeCoordinate(route.origin[0]),
            originLongitude: this.normalizeCoordinate(route.origin[1]),
            destinationLatitude: this.normalizeCoordinate(route.destination[0]),
            destinationLongitude: this.normalizeCoordinate(route.destination[1]),
            distanceMeters: route.distanceMeters,
            durationSeconds: route.durationSeconds,
            calculatedAt,
          };

          return this.prisma.mapWalkingRouteCache.upsert({
            where: { cacheKey },
            create: { cacheKey, ...data },
            update: data,
          });
        }),
      );
    }
  }

  private createRouteCacheKey(origin: MapRoutingCoordinate, destination: MapRoutingCoordinate) {
    const key = [
      ROUTING_CACHE_VERSION,
      ROUTING_CACHE_PROVIDER,
      ROUTING_CACHE_PROFILE,
      this.normalizeCoordinate(origin[0]),
      this.normalizeCoordinate(origin[1]),
      this.normalizeCoordinate(destination[0]),
      this.normalizeCoordinate(destination[1]),
    ].join(':');

    return createHash('sha256').update(key).digest('hex');
  }

  private normalizeCoordinate(value: number) {
    return value.toFixed(6);
  }

  private async requestWalkingRoutes(request: MapWalkingRoutesRequest): Promise<MapWalkingRoutesResponse> {
    const matrix = await this.requestMatrix([request.origin], request.destinations);
    const distances = matrix.distances[0] ?? [];
    const durations = matrix.durations[0] ?? [];

    return {
      routes: request.destinations.map((_, destinationIndex) => ({
        destinationIndex,
        distanceMeters:
          distances[destinationIndex] === null ? null : Math.round(distances[destinationIndex] as number),
        durationSeconds:
          durations[destinationIndex] === null ? null : Math.round(durations[destinationIndex] as number),
      })),
    };
  }

  private async requestMatrix(
    origins: MapRoutingCoordinate[],
    destinations: MapRoutingCoordinate[],
  ): Promise<WalkingRouteMatrix> {
    const requestBody = JSON.stringify({
      destinations: destinations.map((_, index) => origins.length + index),
      locations: [...origins, ...destinations].map(([latitude, longitude]) => [longitude, latitude]),
      metrics: ['distance', 'duration'],
      sources: origins.map((_, index) => index),
      units: 'm',
    });

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;

      try {
        response = await fetch(`${this.apiUrl}/v2/matrix/foot-walking`, {
          body: requestBody,
          headers: {
            Authorization: this.apiKey,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: controller.signal,
        });
      } catch {
        if (attempt < this.maxRetries) {
          await this.waitBeforeRetry(null, attempt);
          continue;
        }

        if (controller.signal.aborted) {
          throw new GatewayTimeoutException('Walking route provider timed out');
        }

        throw new BadGatewayException('Walking route provider is unavailable');
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        if (this.isRetryableStatus(response.status) && attempt < this.maxRetries) {
          await response.arrayBuffer().catch(() => undefined);
          await this.waitBeforeRetry(response.headers.get('retry-after'), attempt);
          continue;
        }

        throw this.classifyProviderStatus(response.status);
      }

      let payload: OpenRouteServiceMatrixResponse;

      try {
        payload = (await response.json()) as OpenRouteServiceMatrixResponse;
      } catch {
        throw new BadGatewayException('Walking route provider returned an invalid matrix');
      }

      return {
        distances: this.readMatrixRows(payload.distances, origins.length, destinations.length),
        durations: this.readMatrixRows(payload.durations, origins.length, destinations.length),
      };
    }

    throw new BadGatewayException('Walking route provider is unavailable');
  }

  private isRetryableStatus(status: number) {
    return status === 408 || status === 429 || status >= 500;
  }

  private classifyProviderStatus(status: number) {
    if (status === 401 || status === 403) {
      return new ServiceUnavailableException('Walking routes are not configured correctly');
    }

    if (status === 408 || status === 504) {
      return new GatewayTimeoutException('Walking route provider timed out');
    }

    if (status === 429) {
      return new ServiceUnavailableException('Walking route provider is temporarily rate limited');
    }

    if (status >= 500) {
      return new BadGatewayException('Walking route provider is unavailable');
    }

    return new BadGatewayException('Walking route provider rejected the request');
  }

  private async waitBeforeRetry(retryAfter: string | null, attempt: number) {
    const parsedRetryAfter = this.parseRetryAfter(retryAfter);
    const fallbackDelay = Math.min(100 * 2 ** attempt, MAX_OPENROUTESERVICE_RETRY_DELAY_MS);
    const delayMs = Math.min(parsedRetryAfter ?? fallbackDelay, MAX_OPENROUTESERVICE_RETRY_DELAY_MS);

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  private parseRetryAfter(value: string | null) {
    if (!value) {
      return null;
    }

    const seconds = Number(value);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }

    const date = Date.parse(value);

    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  private parseRequest(input: unknown): MapWalkingRoutesRequest {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Walking routes request is invalid');
    }

    const request = input as Record<string, unknown>;
    const origin = this.parseCoordinate(request.origin, 'Origin coordinates are invalid');

    if (!Array.isArray(request.destinations) || request.destinations.length === 0) {
      throw new BadRequestException('At least one destination is required');
    }

    if (request.destinations.length > 3) {
      throw new BadRequestException('Up to three destinations are allowed');
    }

    return {
      origin,
      destinations: request.destinations.map((coordinate) =>
        this.parseCoordinate(coordinate, 'Destination coordinates are invalid'),
      ),
    };
  }

  private parseCoordinate(value: unknown, message: string): MapRoutingCoordinate {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'number' ||
      !Number.isFinite(value[0]) ||
      value[0] < -90 ||
      value[0] > 90 ||
      typeof value[1] !== 'number' ||
      !Number.isFinite(value[1]) ||
      value[1] < -180 ||
      value[1] > 180
    ) {
      throw new BadRequestException(message);
    }

    return [value[0], value[1]];
  }

  private readMatrixRows(value: unknown, rows: number, columns: number) {
    if (!Array.isArray(value) || value.length !== rows) {
      throw new BadGatewayException('Walking route provider returned an invalid matrix');
    }

    return value.map((row) => {
      if (
        !Array.isArray(row) ||
        row.length !== columns ||
        !row.every((item) => item === null || (typeof item === 'number' && Number.isFinite(item) && item >= 0))
      ) {
        throw new BadGatewayException('Walking route provider returned an invalid matrix');
      }

      return row as Array<number | null>;
    });
  }

  private parsePositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number(value);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private parseNonNegativeInteger(value: string | undefined, fallback: number) {
    const parsed = Number(value);

    return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, MAX_OPENROUTESERVICE_RETRIES) : fallback;
  }
}
