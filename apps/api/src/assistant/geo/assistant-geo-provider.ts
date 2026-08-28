import type {
  AssistantGeoAreaGeometry,
  AssistantGeoKind,
  AssistantGeoLineGeometry,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { parseAssistantReferenceGeometry } from './assistant-geo-contract';

const defaultLocationIqUrl = 'https://us1.locationiq.com/v1/search';
const defaultTimeoutMs = 3_000;
const defaultMaximumRetries = 1;
const maximumResponseBytes = 256 * 1_024;
const maximumCandidates = 3;

type GeoProviderEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type FetchLike = typeof fetch;

export type AssistantGeoProviderRequest = {
  query: string;
  locale: string;
  country: string | null;
  viewbox: [west: number, south: number, east: number, north: number] | null;
};

export type AssistantGeoProviderCandidate = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  city: string | null;
  countryCode: string | null;
  geometryKind?: AssistantGeoKind;
  referenceGeometry?: AssistantGeoLineGeometry | AssistantGeoAreaGeometry;
  geometryComplete?: boolean;
  entityClass?: string | null;
  entityType?: string | null;
  osmType?: string | null;
  osmId?: string | null;
  boundingBox?: [west: number, south: number, east: number, north: number] | null;
};

export type AssistantGeoProvider = {
  search(request: AssistantGeoProviderRequest): Promise<AssistantGeoProviderCandidate[]>;
};

export class AssistantGeoProviderError extends Error {
  providerCallCount = 0;

  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
    this.name = 'AssistantGeoProviderError';
  }
}

export class LocationIqGeoProvider implements AssistantGeoProvider {
  private readonly apiKey: string;
  private readonly apiUrl: URL;
  private readonly timeoutMs: number;
  private readonly maximumRetries: number;
  private beforeRequest: () => Promise<unknown> = async () => undefined;
  private afterRequest: (
    reservation: unknown,
    outcome: 'SUCCESS' | 'ERROR',
    durationMs: number,
    errorCode: string | null,
  ) => Promise<void> = async () => {};

  constructor(
    environment: GeoProviderEnvironment = process.env,
    private readonly fetcher: FetchLike = fetch,
    private readonly delay: (milliseconds: number) => Promise<void> = wait,
  ) {
    this.apiKey = readRequiredSecret(environment.LOCATIONIQ_API_KEY, 'LOCATIONIQ_API_KEY_REQUIRED');
    this.apiUrl = readProviderUrl(environment.LOCATIONIQ_API_URL ?? defaultLocationIqUrl);
    this.timeoutMs = readInteger(
      environment.ASSISTANT_GEO_PROVIDER_TIMEOUT_MS,
      defaultTimeoutMs,
      100,
      30_000,
      'ASSISTANT_GEO_PROVIDER_TIMEOUT_MS_INVALID',
    );
    this.maximumRetries = readInteger(
      environment.ASSISTANT_GEO_PROVIDER_MAX_RETRIES,
      defaultMaximumRetries,
      0,
      3,
      'ASSISTANT_GEO_PROVIDER_MAX_RETRIES_INVALID',
    );
  }

  async search(request: AssistantGeoProviderRequest) {
    const normalized = normalizeProviderRequest(request);
    let lastError: AssistantGeoProviderError | null = null;

    for (let attempt = 0; attempt <= this.maximumRetries; attempt += 1) {
      try {
        return await this.searchOnce(normalized);
      } catch (error) {
        const providerError = normalizeProviderError(error);
        lastError = providerError;
        if (!providerError.retryable || attempt >= this.maximumRetries) throw providerError;
        await this.delay(readRetryDelay(providerError));
      }
    }

    throw lastError ?? new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_FAILED', true);
  }

  setRequestLifecycle(
    beforeRequest: () => Promise<unknown>,
    afterRequest: (
      reservation: unknown,
      outcome: 'SUCCESS' | 'ERROR',
      durationMs: number,
      errorCode: string | null,
    ) => Promise<void>,
  ) {
    this.beforeRequest = beforeRequest;
    this.afterRequest = afterRequest;
  }

  private async searchOnce(request: AssistantGeoProviderRequest) {
    const startedAt = Date.now();
    const reservation = await this.beforeRequest();
    let outcome: 'SUCCESS' | 'ERROR' = 'ERROR';
    let errorCode: string | null = null;
    const url = new URL(this.apiUrl);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('q', request.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('normalizeaddress', '1');
    url.searchParams.set('normalizecity', '1');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('polygon_geojson', '1');
    url.searchParams.set('limit', String(maximumCandidates));
    url.searchParams.set('accept-language', request.locale);
    if (request.country) url.searchParams.set('countrycodes', request.country);
    if (request.viewbox) {
      url.searchParams.set('viewbox', request.viewbox.join(','));
      url.searchParams.set('bounded', '1');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetcher(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 404) {
        outcome = 'SUCCESS';
        return [];
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new AssistantGeoProviderError(
          response.status === 429 ? 'ASSISTANT_GEO_PROVIDER_RATE_LIMITED' : 'ASSISTANT_GEO_PROVIDER_HTTP_ERROR',
          retryable,
          response.status,
        );
        Object.defineProperty(error, 'retryAfterMs', {
          configurable: false,
          enumerable: false,
          value: parseRetryAfter(response.headers.get('retry-after')),
        });
        throw error;
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
        throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_TOO_LARGE', false, response.status);
      }
      const body = await readBoundedResponseBody(response, maximumResponseBytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_INVALID', false, response.status);
      }
      const candidates = normalizeProviderCandidates(payload);
      outcome = 'SUCCESS';
      return candidates;
    } catch (error) {
      const normalized = error instanceof AssistantGeoProviderError
        ? error
        : controller.signal.aborted
          ? new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_TIMEOUT', true)
          : new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_UNAVAILABLE', true);
      errorCode = normalized.code;
      throw normalized;
    } finally {
      clearTimeout(timeout);
      try {
        await this.afterRequest(reservation, outcome, Math.max(0, Date.now() - startedAt), errorCode);
      } catch (error) {
        if (error instanceof AssistantGeoProviderError) throw error;
        throw new AssistantGeoProviderError('ASSISTANT_GEO_USAGE_SETTLEMENT_FAILED', false);
      }
    }
  }
}

export class FakeAssistantGeoProvider implements AssistantGeoProvider {
  async search(request: AssistantGeoProviderRequest): Promise<AssistantGeoProviderCandidate[]> {
    const normalized = normalizeText(request.query);
    if (/timeout|unavailable|error/u.test(normalized)) {
      throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_UNAVAILABLE', true);
    }
    if (/none|missing|unknown|нет такого/u.test(normalized)) return [];
    const city = extractCity(request.query);
    if (/ambiguous|неоднознач/u.test(normalized)) {
      return [0, 1, 2].map((index) => ({
        id: `fake-${index + 1}`,
        label: `${request.query} · вариант ${index + 1}`,
        latitude: 55.75 + index * 0.01,
        longitude: 37.61 + index * 0.01,
        city,
        countryCode: request.country,
        geometryKind: 'POINT' as const,
        geometryComplete: true,
      }));
    }
    if (/садов.*кольц|ттк|треть.*транспортн.*кольц|мкад/u.test(normalized)) {
      const coordinates: [number, number][] = [
        [37.5804, 55.7663],
        [37.6216, 55.7765],
        [37.6576, 55.7554],
        [37.6427, 55.7243],
        [37.6004, 55.7175],
        [37.5741, 55.7412],
        [37.5804, 55.7663],
      ];
      return [{
        id: `fake-${normalized.includes('мкад') ? 'mkad' : normalized.includes('ттк') ? 'ttk' : 'sadovoe-ring'}`,
        label: normalized.includes('мкад') ? 'МКАД' : normalized.includes('ттк') ? 'Третье транспортное кольцо' : 'Садовое кольцо',
        latitude: 55.748,
        longitude: 37.615,
        city: 'Москва',
        countryCode: request.country ?? 'ru',
        geometryKind: 'LINE',
        referenceGeometry: { type: 'LineString', coordinates },
        geometryComplete: true,
        entityClass: 'highway',
        entityType: 'ring_road',
        osmType: 'relation',
        osmId: `fake-${normalized}`,
        boundingBox: [37.5741, 55.7175, 37.6576, 55.7765],
      }];
    }
    if (/район\s+арбат|^арбат$/u.test(normalized)) {
      return [{
        id: 'fake-arbat-area',
        label: 'район Арбат',
        latitude: 55.7522,
        longitude: 37.5906,
        city: 'Москва',
        countryCode: request.country ?? 'ru',
        geometryKind: 'AREA',
        referenceGeometry: {
          type: 'Polygon',
          coordinates: [[
            [37.565, 55.744], [37.603, 55.744], [37.606, 55.763], [37.571, 55.765], [37.565, 55.744],
          ]],
        },
        geometryComplete: true,
        entityClass: 'boundary',
        entityType: 'administrative',
        osmType: 'relation',
        osmId: 'fake-arbat-area',
        boundingBox: [37.565, 55.744, 37.606, 55.765],
      }];
    }
    const knownMoscowPlace = readFakeMoscowPlace(normalized);
    if (knownMoscowPlace) {
      return [{
        id: `fake-${knownMoscowPlace.id}`,
        label: knownMoscowPlace.label,
        latitude: knownMoscowPlace.latitude,
        longitude: knownMoscowPlace.longitude,
        city: 'Москва',
        countryCode: request.country,
        geometryKind: 'POINT',
        geometryComplete: true,
      }];
    }
    return [{
      id: 'fake-1',
      label: request.query,
      latitude: city?.toLocaleLowerCase('ru-RU').includes('екатеринбург') ? 56.8377 : 55.751244,
      longitude: city?.toLocaleLowerCase('ru-RU').includes('екатеринбург') ? 60.603753 : 37.618423,
      city,
      countryCode: request.country,
      geometryKind: 'POINT',
      geometryComplete: true,
    }];
  }
}

function readFakeMoscowPlace(normalizedQuery: string) {
  const fixtures = [
    {
      pattern: /белорусск.*вокзал/u,
      id: 'belorussky-station',
      label: 'Белорусский вокзал',
      latitude: 55.7763,
      longitude: 37.5801,
    },
    {
      pattern: /москва[ -]сити/u,
      id: 'moscow-city',
      label: 'Москва-Сити',
      latitude: 55.7503,
      longitude: 37.537,
    },
    {
      pattern: /спортивн/u,
      id: 'sportivnaya',
      label: 'Спортивная',
      latitude: 55.7226,
      longitude: 37.562,
    },
    {
      pattern: /павелецк.*плаза/u,
      id: 'paveletskaya-plaza',
      label: 'Павелецкая Плаза',
      latitude: 55.7312,
      longitude: 37.6364,
    },
  ];
  return fixtures.find(({ pattern }) => pattern.test(normalizedQuery)) ?? null;
}

function normalizeProviderRequest(request: AssistantGeoProviderRequest): AssistantGeoProviderRequest {
  const query = readBoundedText(request.query, 240);
  if (!query) throw new AssistantGeoProviderError('ASSISTANT_GEO_QUERY_INVALID', false);
  const locale = typeof request.locale === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(request.locale)
    ? request.locale
    : null;
  if (!locale) throw new AssistantGeoProviderError('ASSISTANT_GEO_LOCALE_INVALID', false);
  const country = request.country === null
    ? null
    : typeof request.country === 'string' && /^[a-z]{2}$/u.test(request.country)
      ? request.country
      : undefined;
  if (country === undefined) throw new AssistantGeoProviderError('ASSISTANT_GEO_COUNTRY_INVALID', false);
  const viewbox = request.viewbox === null ? null : normalizeViewbox(request.viewbox);
  if (request.viewbox !== null && !viewbox) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_VIEWBOX_INVALID', false);
  }
  return { query, locale, country, viewbox };
}

function normalizeProviderCandidates(value: unknown): AssistantGeoProviderCandidate[] {
  if (!Array.isArray(value)) throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_INVALID', false);
  if (value.length > maximumCandidates) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_INVALID', false);
  }
  const candidates: AssistantGeoProviderCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_INVALID', false);
    }
    const idValue = typeof entry.place_id === 'number' || typeof entry.place_id === 'string'
      ? String(entry.place_id)
      : '';
    const id = readBoundedText(idValue, 120);
    const label = readBoundedText(entry.display_name, 300);
    const latitude = readCoordinate(entry.lat, -90, 90);
    const longitude = readCoordinate(entry.lon, -180, 180);
    if (!id || !label || latitude === null || longitude === null) {
      throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_INVALID', false);
    }
    const address = isRecord(entry.address) ? entry.address : {};
    const geometry = parseLocationIqGeometry(entry.geojson);
    const entityClass = readBoundedText(entry.class, 80);
    const entityType = readBoundedText(entry.type, 80);
    const osmType = readBoundedText(entry.osm_type, 24);
    const osmId = typeof entry.osm_id === 'number' || typeof entry.osm_id === 'string'
      ? readBoundedText(String(entry.osm_id), 80)
      : null;
    const geometryKind = normalizeText(entityClass ?? '') === 'highway' ? 'LINE' : geometry.kind;
    const candidate: AssistantGeoProviderCandidate = {
      id,
      label,
      latitude,
      longitude,
      city: readBoundedText(address.city ?? address.town ?? address.village ?? address.municipality, 160),
      countryCode: typeof address.country_code === 'string' && /^[a-z]{2}$/u.test(address.country_code)
        ? address.country_code
        : null,
      geometryKind,
      ...(geometry.referenceGeometry && geometry.kind === geometryKind
        ? { referenceGeometry: geometry.referenceGeometry }
        : {}),
      geometryComplete: geometryKind !== 'LINE',
      entityClass,
      entityType,
      osmType,
      osmId,
      boundingBox: parseLocationIqBoundingBox(entry.boundingbox),
    };
    const key = osmType && osmId
      ? `osm:${normalizeText(osmType)}/${osmId}`
      : `place:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (candidates.length < maximumCandidates) candidates.push(candidate);
  }
  return candidates;
}

function parseLocationIqGeometry(value: unknown): {
  kind: AssistantGeoKind;
  referenceGeometry?: AssistantGeoLineGeometry | AssistantGeoAreaGeometry;
} {
  if (value === undefined || value === null) return { kind: 'POINT' };
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_GEOMETRY_INVALID', false);
  }
  try {
    if (value.type === 'Point') {
      parseAssistantReferenceGeometry(value, 'POINT');
      return { kind: 'POINT' };
    }
    if (value.type === 'LineString' || value.type === 'MultiLineString') {
      return {
        kind: 'LINE',
        referenceGeometry: parseAssistantReferenceGeometry(value, 'LINE') as AssistantGeoLineGeometry,
      };
    }
    if (value.type === 'Polygon' || value.type === 'MultiPolygon') {
      return {
        kind: 'AREA',
        referenceGeometry: parseAssistantReferenceGeometry(value, 'AREA') as AssistantGeoAreaGeometry,
      };
    }
  } catch {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_GEOMETRY_INVALID', false);
  }
  throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_GEOMETRY_INVALID', false);
}

function parseLocationIqBoundingBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const south = readCoordinate(value[0], -90, 90);
  const north = readCoordinate(value[1], -90, 90);
  const west = readCoordinate(value[2], -180, 180);
  const east = readCoordinate(value[3], -180, 180);
  return south !== null && north !== null && west !== null && east !== null && south < north && west < east
    ? [west, south, east, north]
    : null;
}

function readProviderUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AssistantGeoProviderError('LOCATIONIQ_API_URL_INVALID', false);
  }
  const localHttp = url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new AssistantGeoProviderError('LOCATIONIQ_API_URL_INVALID', false);
  }
  return url;
}

function readRequiredSecret(value: string | undefined, code: string) {
  if (!value?.trim()) throw new AssistantGeoProviderError(code, false);
  return value.trim();
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AssistantGeoProviderError(code, false);
  }
  return parsed;
}

function normalizeViewbox(value: AssistantGeoProviderRequest['viewbox']) {
  if (!Array.isArray(value) || value.length !== 4
    || value.some((part) => typeof part !== 'number' || !Number.isFinite(part))) return null;
  const [west, south, east, north] = value;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return [west, south, east, north] as AssistantGeoProviderRequest['viewbox'];
}

function readCoordinate(value: unknown, minimum: number, maximum: number) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

async function readBoundedResponseBody(response: Response, maximumBytes: number) {
  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
      throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_TOO_LARGE', false, response.status);
    }
    return body;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_RESPONSE_TOO_LARGE', false, response.status);
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function readBoundedText(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function normalizeProviderError(error: unknown) {
  return error instanceof AssistantGeoProviderError
    ? error
    : new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_UNAVAILABLE', true);
}

function readRetryDelay(error: AssistantGeoProviderError) {
  const retryAfterMs = (error as AssistantGeoProviderError & { retryAfterMs?: unknown }).retryAfterMs;
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
    ? Math.min(Math.max(retryAfterMs, 0), 1_000)
    : 25;
}

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

function extractCity(value: string) {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.at(-1)! : null;
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
