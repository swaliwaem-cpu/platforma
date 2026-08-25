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

const DEFAULT_OPENROUTESERVICE_API_URL = 'https://api.openrouteservice.org';
const DEFAULT_OPENROUTESERVICE_TIMEOUT_MS = 5_000;
const DEFAULT_OPENROUTESERVICE_CACHE_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1_000;
const DEFAULT_OPENROUTESERVICE_MAX_RETRIES = 2;
const MAX_OPENROUTESERVICE_RETRIES = 5;
const MAX_OPENROUTESERVICE_RETRY_DELAY_MS = 2_000;
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
    const calculatedAt = new Date();

    await this.prisma.$transaction(
      response.routes.map((route) => {
        const destination = request.destinations[route.destinationIndex];

        if (!destination) {
          throw new BadGatewayException('Walking route provider returned an invalid destination index');
        }

        const cacheKey = this.createRouteCacheKey(request.origin, destination);
        const data = {
          provider: ROUTING_CACHE_PROVIDER,
          profile: ROUTING_CACHE_PROFILE,
          originLatitude: this.normalizeCoordinate(request.origin[0]),
          originLongitude: this.normalizeCoordinate(request.origin[1]),
          destinationLatitude: this.normalizeCoordinate(destination[0]),
          destinationLongitude: this.normalizeCoordinate(destination[1]),
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
    const requestBody = JSON.stringify({
      destinations: request.destinations.map((_, index) => index + 1),
      locations: [request.origin, ...request.destinations].map(([latitude, longitude]) => [longitude, latitude]),
      metrics: ['distance', 'duration'],
      sources: [0],
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

      const distances = this.readMatrixRow(payload.distances);
      const durations = this.readMatrixRow(payload.durations);

      if (distances.length !== request.destinations.length || durations.length !== request.destinations.length) {
        throw new BadGatewayException('Walking route provider returned an invalid matrix');
      }

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

  private readMatrixRow(value: unknown) {
    if (!Array.isArray(value) || !Array.isArray(value[0])) {
      throw new BadGatewayException('Walking route provider returned an invalid matrix');
    }

    const row = value[0];

    if (!row.every((item) => item === null || (typeof item === 'number' && Number.isFinite(item) && item >= 0))) {
      throw new BadGatewayException('Walking route provider returned an invalid matrix');
    }

    return row as Array<number | null>;
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
