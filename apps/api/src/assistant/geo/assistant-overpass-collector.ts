import { createHash } from 'node:crypto';

import type { AssistantGeoLineGeometry } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { parseAssistantReferenceGeometry } from './assistant-geo-contract';
import {
  AssistantGeoUsageLedgerError,
  type AssistantGeoUsageLedgerService,
  type AssistantGeoUsageReservation,
} from './assistant-geo-usage-ledger.service';

const defaultEndpoint = 'https://overpass-api.de/api/interpreter';
const defaultTimeoutMs = 5_000;
const defaultMaximumResponseBytes = 1_048_576;
const defaultCircuitThreshold = 3;
const defaultCircuitOpenMs = 60_000;
const exactIdentityTagKeys = ['name', 'official_name', 'short_name', 'alt_name', 'ref'] as const;

type OverpassEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type AssistantOverpassRequest = {
  name: string;
  tagValues?: string[];
  city: string;
  cityBounds: [west: number, south: number, east: number, north: number];
};

export type AssistantOverpassResult = {
  geometry: AssistantGeoLineGeometry;
  externalId: string;
  entityType: 'road';
};

export class AssistantOverpassError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = 'AssistantOverpassError';
  }
}

export class AssistantOverpassCollector {
  private readonly enabled: boolean;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly circuitThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly requestsPerSecond: number;
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  private nextRequestAt = 0;
  private rateLimitTail: Promise<void> = Promise.resolve();

  constructor(
    environment: OverpassEnvironment = process.env,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly delay: (milliseconds: number) => Promise<void> = wait,
    private readonly usageLedger?: Pick<AssistantGeoUsageLedgerService, 'reserve' | 'settle'>,
  ) {
    this.enabled = readBoolean(environment.ASSISTANT_OVERPASS_ENABLED, false);
    this.endpoint = readEndpoint(environment.ASSISTANT_OVERPASS_URL ?? defaultEndpoint);
    this.timeoutMs = readInteger(
      environment.ASSISTANT_OVERPASS_TIMEOUT_MS,
      defaultTimeoutMs,
      250,
      30_000,
      'ASSISTANT_OVERPASS_TIMEOUT_INVALID',
    );
    this.maximumResponseBytes = readInteger(
      environment.ASSISTANT_OVERPASS_MAX_RESPONSE_BYTES,
      defaultMaximumResponseBytes,
      1_024,
      8 * 1_024 * 1_024,
      'ASSISTANT_OVERPASS_MAX_RESPONSE_BYTES_INVALID',
    );
    this.circuitThreshold = readInteger(
      environment.ASSISTANT_OVERPASS_CIRCUIT_FAILURE_THRESHOLD,
      defaultCircuitThreshold,
      1,
      20,
      'ASSISTANT_OVERPASS_CIRCUIT_THRESHOLD_INVALID',
    );
    this.circuitOpenMs = readInteger(
      environment.ASSISTANT_OVERPASS_CIRCUIT_OPEN_MS,
      defaultCircuitOpenMs,
      1_000,
      15 * 60_000,
      'ASSISTANT_OVERPASS_CIRCUIT_OPEN_INVALID',
    );
    this.requestsPerSecond = readInteger(
      environment.ASSISTANT_OVERPASS_RPS,
      1,
      1,
      5,
      'ASSISTANT_OVERPASS_RPS_INVALID',
    );
  }

  collect(request: AssistantOverpassRequest): Promise<AssistantOverpassResult> {
    return this.collectOnce(normalizeRequest(request));
  }

  private async collectOnce(request: AssistantOverpassRequest) {
    if (!this.enabled) throw new AssistantOverpassError('ASSISTANT_OVERPASS_DISABLED', false);
    const now = this.now();
    if (this.circuitOpenedAt > 0 && now - this.circuitOpenedAt < this.circuitOpenMs) {
      throw new AssistantOverpassError('ASSISTANT_OVERPASS_CIRCUIT_OPEN', true);
    }
    if (this.circuitOpenedAt > 0) {
      this.circuitOpenedAt = 0;
      this.consecutiveFailures = 0;
    }

    await this.waitForRateSlot();
    const startedAt = this.now();
    let reservation: AssistantGeoUsageReservation | undefined;
    if (this.usageLedger) {
      try {
        reservation = await this.usageLedger.reserve('overpass');
      } catch (error) {
        if (error instanceof AssistantGeoUsageLedgerError) {
          throw new AssistantOverpassError(error.code, false);
        }
        throw error;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    let outcome: 'SUCCESS' | 'ERROR' = 'ERROR';
    let errorCode: string | null = null;
    try {
      const query = createOverpassQuery(request, this.timeoutMs, this.maximumResponseBytes);
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({ data: query }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AssistantOverpassError(
          response.status === 429 ? 'ASSISTANT_OVERPASS_RATE_LIMITED' : 'ASSISTANT_OVERPASS_HTTP_ERROR',
          response.status === 429 || response.status >= 500,
        );
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > this.maximumResponseBytes) {
        throw new AssistantOverpassError('ASSISTANT_OVERPASS_RESPONSE_TOO_LARGE', false);
      }
      const body = await readBoundedBody(response, this.maximumResponseBytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new AssistantOverpassError('ASSISTANT_OVERPASS_RESPONSE_INVALID', false);
      }
      const result = parseOverpassResult(payload, request);
      this.consecutiveFailures = 0;
      outcome = 'SUCCESS';
      return result;
    } catch (error) {
      const normalized = error instanceof AssistantOverpassError
        ? error
        : controller.signal.aborted
          ? new AssistantOverpassError('ASSISTANT_OVERPASS_TIMEOUT', true)
          : new AssistantOverpassError('ASSISTANT_OVERPASS_UNAVAILABLE', true);
      errorCode = normalized.code;
      if (normalized.retryable) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.circuitThreshold) this.circuitOpenedAt = this.now();
      }
      throw normalized;
    } finally {
      clearTimeout(timeout);
      if (reservation && this.usageLedger) {
        try {
          await this.usageLedger.settle(reservation, {
            outcome,
            errorCode,
            durationMs: Math.max(0, this.now() - startedAt),
          });
        } catch (error) {
          const code = error instanceof AssistantGeoUsageLedgerError
            ? error.code
            : 'ASSISTANT_GEO_USAGE_SETTLEMENT_FAILED';
          throw new AssistantOverpassError(code, false);
        }
      }
    }
  }

  private async waitForRateSlot() {
    let release = () => {};
    const previous = this.rateLimitTail;
    this.rateLimitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const minimumInterval = Math.ceil(1_000 / this.requestsPerSecond);
      const now = this.now();
      const waitFor = Math.max(0, this.nextRequestAt - now);
      if (waitFor > 0) await this.delay(waitFor);
      this.nextRequestAt = this.now() + minimumInterval;
    } finally {
      release();
    }
  }
}

export function createOverpassQuery(
  request: AssistantOverpassRequest,
  timeoutMs = defaultTimeoutMs,
  maximumBytes = defaultMaximumResponseBytes,
) {
  const normalized = normalizeRequest(request);
  const [west, south, east, north] = normalized.cityBounds;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const selectors = normalized.tagValues!.flatMap((value) => exactIdentityTagKeys.flatMap((key) => {
    const tag = `["${key}"=${JSON.stringify(value)}]`;
    const bounds = `(${south},${west},${north},${east})`;
    return [
      `relation${tag}["type"="route"]["route"="road"]${bounds};`,
      `relation${tag}["type"="road"]${bounds};`,
    ];
  }));
  return [
    `[out:json][timeout:${timeoutSeconds}][maxsize:${maximumBytes}];`,
    '(',
    ...selectors,
    ');',
    'out geom;',
  ].join('');
}

function parseOverpassResult(value: unknown, request: AssistantOverpassRequest): AssistantOverpassResult {
  if (!isRecord(value) || typeof value.remark === 'string' || !Array.isArray(value.elements)) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_RESPONSE_INVALID', false);
  }
  const expectedValues = new Set(normalizeRequest(request).tagValues!.map(normalizeText));
  const relations = new Map<string, { lines: [number, number][][]; fingerprint: string }>();
  let sawExpectedWay = false;
  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.type !== 'string') {
      throw new AssistantOverpassError('ASSISTANT_OVERPASS_RESPONSE_INVALID', false);
    }
    if (element.type === 'way') {
      const tags = isRecord(element.tags) ? element.tags : null;
      if (tags && hasExpectedIdentityTag(tags, expectedValues)) sawExpectedWay = true;
      continue;
    }
    if (element.type !== 'relation') continue;
    if (!readOsmId(element.id)) {
      throw new AssistantOverpassError('ASSISTANT_OVERPASS_RESPONSE_INVALID', false);
    }
    const tags = isRecord(element.tags) ? element.tags : null;
    if (!tags || !isRoadRelation(tags) || !hasExpectedIdentityTag(tags, expectedValues)) continue;
    if (!Array.isArray(element.members) || element.members.length === 0) {
      throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE', false);
    }
    const members = new Map<string, [number, number][]>();
    for (const member of element.members) {
      const memberRef = isRecord(member) ? readOsmId(member.ref) : null;
      if (!isRecord(member) || member.type !== 'way' || !memberRef || !Array.isArray(member.geometry)) {
        throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE', false);
      }
      const memberId = `way/${memberRef}`;
      const line = parseOverpassLine(member.geometry);
      const previous = members.get(memberId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(line)) {
        throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_AMBIGUOUS', false);
      }
      members.set(memberId, line);
    }
    const fingerprint = [...members.keys()].sort().join('|');
    const lines = [...members.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, line]) => line);
    assertClosedMemberGraph(lines);
    const previous = relations.get(fingerprint);
    if (previous && JSON.stringify(previous.lines) !== JSON.stringify(lines)) {
      throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_AMBIGUOUS', false);
    }
    relations.set(fingerprint, { lines, fingerprint });
  }
  if (relations.size === 0) {
    throw new AssistantOverpassError(
      sawExpectedWay ? 'ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE' : 'ASSISTANT_OVERPASS_GEOMETRY_NOT_FOUND',
      false,
    );
  }
  if (relations.size > 1) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_AMBIGUOUS', false);
  }
  const relation = [...relations.values()][0]!;
  const uniqueLines = [...new Map(relation.lines.map((line) => [JSON.stringify(line), line])).values()];
  const raw = uniqueLines.length === 1
    ? { type: 'LineString' as const, coordinates: uniqueLines[0]! }
    : { type: 'MultiLineString' as const, coordinates: uniqueLines };
  const geometry = parseAssistantReferenceGeometry(raw, 'LINE') as AssistantGeoLineGeometry;
  return {
    geometry,
    externalId: createHash('sha256').update(relation.fingerprint).digest('hex'),
    entityType: 'road',
  };
}

function parseOverpassLine(value: unknown): [number, number][] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE', false);
  }
  const parsed = value.map((point) => {
    if (!isRecord(point) || typeof point.lat !== 'number' || typeof point.lon !== 'number'
      || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)
      || point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) {
      throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_INVALID', false);
    }
    return [point.lon, point.lat] as [number, number];
  });
  const deduplicated = parsed.filter((point, index) => index === 0
    || point[0] !== parsed[index - 1]![0]
    || point[1] !== parsed[index - 1]![1]);
  if (deduplicated.length < 2) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE', false);
  }
  return deduplicated;
}

function isRoadRelation(tags: Record<string, unknown> | null) {
  if (!tags) return false;
  return tags.type === 'road' || (tags.type === 'route' && tags.route === 'road');
}

function hasExpectedIdentityTag(tags: Record<string, unknown>, expectedValues: Set<string>) {
  return exactIdentityTagKeys.some((key) => (
    typeof tags[key] === 'string' && expectedValues.has(normalizeText(tags[key]))
  ));
}

function assertClosedMemberGraph(lines: [number, number][][]) {
  const degrees = new Map<string, number>();
  for (const line of lines) {
    const first = coordinateKey(line[0]!);
    const last = coordinateKey(line.at(-1)!);
    degrees.set(first, (degrees.get(first) ?? 0) + (first === last ? 2 : 1));
    if (first !== last) degrees.set(last, (degrees.get(last) ?? 0) + 1);
  }
  if ([...degrees.values()].some((degree) => degree === 1)) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_GEOMETRY_INCOMPLETE', false);
  }
}

function coordinateKey(point: [number, number]) {
  return `${point[0]},${point[1]}`;
}

function readOsmId(value: unknown) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' && /^[1-9]\d*$/u.test(value)
      ? value
      : null;
  return normalized;
}

async function readBoundedBody(response: Response, maximumBytes: number) {
  if (!response.body) throw new AssistantOverpassError('ASSISTANT_OVERPASS_RESPONSE_INVALID', false);
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
        throw new AssistantOverpassError('ASSISTANT_OVERPASS_RESPONSE_TOO_LARGE', false);
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function normalizeRequest(request: AssistantOverpassRequest): AssistantOverpassRequest {
  const name = readText(request.name, 240);
  const city = readText(request.city, 160);
  if (!name || !city || !Array.isArray(request.cityBounds) || request.cityBounds.length !== 4) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_INPUT_INVALID', false);
  }
  const [west, south, east, north] = request.cityBounds;
  if (![west, south, east, north].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_INPUT_INVALID', false);
  }
  const requestedTagValues = request.tagValues === undefined
    ? [name]
    : request.tagValues.map((value) => readText(value, 240));
  const tagValues: Array<string | null> = [];
  const normalizedTagValues = new Set<string>();
  for (const value of requestedTagValues) {
    if (value === null) {
      tagValues.push(null);
      continue;
    }
    const normalizedValue = normalizeText(value);
    if (normalizedTagValues.has(normalizedValue)) continue;
    normalizedTagValues.add(normalizedValue);
    tagValues.push(value);
  }
  tagValues.sort((left, right) => String(left).localeCompare(String(right), 'ru'));
  if (tagValues.length === 0 || tagValues.length > 10 || tagValues.some((value) => value === null)) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_INPUT_INVALID', false);
  }
  return { name, tagValues: tagValues as string[], city, cityBounds: [west, south, east, north] };
}

function readEndpoint(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_URL_INVALID', false);
  }
  const localHttp = endpoint.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !localHttp) {
    throw new AssistantOverpassError('ASSISTANT_OVERPASS_URL_INVALID', false);
  }
  return endpoint;
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, code: string) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AssistantOverpassError(code, false);
  }
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AssistantOverpassError('ASSISTANT_OVERPASS_ENABLED_INVALID', false);
}

function readText(value: unknown, maximum: number) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized && normalized.length <= maximum ? normalized : null;
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
