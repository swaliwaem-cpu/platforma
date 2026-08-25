import {
  BadRequestException,
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  MapRoutingCoordinate,
  MapWalkingRoutesRequest,
  MapWalkingRoutesResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

type OpenRouteServiceMatrixResponse = {
  distances?: unknown;
  durations?: unknown;
};

type CachedWalkingRoutes = {
  expiresAt: number;
  value: MapWalkingRoutesResponse;
};

const DEFAULT_OPENROUTESERVICE_API_URL = 'https://api.openrouteservice.org';
const DEFAULT_OPENROUTESERVICE_TIMEOUT_MS = 5_000;
const DEFAULT_OPENROUTESERVICE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_OPENROUTESERVICE_MAX_RETRIES = 2;
const MAX_OPENROUTESERVICE_RETRIES = 5;
const MAX_OPENROUTESERVICE_RETRY_DELAY_MS = 2_000;

@Injectable()
export class MapRoutingService {
  private readonly apiKey = process.env.OPENROUTESERVICE_API_KEY?.trim() ?? '';
  private readonly apiUrl = (process.env.OPENROUTESERVICE_API_URL?.trim() || DEFAULT_OPENROUTESERVICE_API_URL).replace(
    /\/+$/u,
    '',
  );
  private readonly timeoutMs = this.parsePositiveInteger(
    process.env.OPENROUTESERVICE_TIMEOUT_MS,
    DEFAULT_OPENROUTESERVICE_TIMEOUT_MS,
  );
  private readonly cacheTtlMs = this.parsePositiveInteger(
    process.env.OPENROUTESERVICE_CACHE_TTL_MS,
    DEFAULT_OPENROUTESERVICE_CACHE_TTL_MS,
  );
  private readonly maxRetries = this.parseNonNegativeInteger(
    process.env.OPENROUTESERVICE_MAX_RETRIES,
    DEFAULT_OPENROUTESERVICE_MAX_RETRIES,
  );
  private readonly cache = new Map<string, CachedWalkingRoutes>();
  private readonly inFlightRequests = new Map<string, Promise<MapWalkingRoutesResponse>>();

  async getWalkingRoutes(input: unknown): Promise<MapWalkingRoutesResponse> {
    const request = this.parseRequest(input);

    if (!this.apiKey) {
      throw new ServiceUnavailableException('Walking routes are not configured');
    }

    const cacheKey = JSON.stringify(request);
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (cached) {
      this.cache.delete(cacheKey);
    }

    const inFlightRequest = this.inFlightRequests.get(cacheKey);

    if (inFlightRequest) {
      return inFlightRequest;
    }

    const requestPromise = this.requestWalkingRoutes(request).then((value) => {
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + this.cacheTtlMs,
        value,
      });

      return value;
    });
    this.inFlightRequests.set(cacheKey, requestPromise);

    try {
      return await requestPromise;
    } finally {
      if (this.inFlightRequests.get(cacheKey) === requestPromise) {
        this.inFlightRequests.delete(cacheKey);
      }
    }
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
