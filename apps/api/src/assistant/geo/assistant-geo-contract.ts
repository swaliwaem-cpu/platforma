import { BadRequestException } from '@nestjs/common';
import type {
  AssistantGeoAnchor,
  AssistantGeoPolygon,
  AssistantGeoSearchContext,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

const defaultMinimumRadiusMeters = 100;
const defaultMaximumRadiusMeters = 20_000;
const maximumAnchorLabelLength = 160;
const anchorSources = new Set(['MANUAL', 'PLACE', 'ALIAS', 'KNOWLEDGE']);

type AssistantGeoEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type AssistantGeoSearchInput = AssistantGeoSearchContext;
export type { AssistantGeoAnchor, AssistantGeoPolygon };

export class AssistantGeoConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantGeoConfigError';
  }
}

export function parseAssistantGeoSearchInput(
  value: unknown,
  environment: AssistantGeoEnvironment = process.env,
): AssistantGeoSearchInput {
  if (!isRecord(value) || !isRecord(value.anchor)) {
    throw new BadRequestException('ASSISTANT_GEO_ANCHOR_INVALID');
  }

  const latitude = readCoordinate(value.anchor.latitude, -90, 90);
  const longitude = readCoordinate(value.anchor.longitude, -180, 180);
  const label = readBoundedString(value.anchor.label, maximumAnchorLabelLength);
  const source = typeof value.anchor.source === 'string' && anchorSources.has(value.anchor.source)
    ? value.anchor.source as AssistantGeoAnchor['source']
    : null;
  if (latitude === null || longitude === null || !label || !source) {
    throw new BadRequestException('ASSISTANT_GEO_ANCHOR_INVALID');
  }

  const minimum = readConfiguredInteger(
    environment.ASSISTANT_GEO_RADIUS_MIN_METERS,
    defaultMinimumRadiusMeters,
    1,
    100_000,
    'ASSISTANT_GEO_RADIUS_MIN_METERS_INVALID',
  );
  const maximum = readConfiguredInteger(
    environment.ASSISTANT_GEO_RADIUS_MAX_METERS,
    defaultMaximumRadiusMeters,
    minimum,
    100_000,
    'ASSISTANT_GEO_RADIUS_MAX_METERS_INVALID',
  );
  const radiusMeters = typeof value.radiusMeters === 'number' ? value.radiusMeters : Number.NaN;
  if (!Number.isInteger(radiusMeters)
    || radiusMeters < minimum
    || radiusMeters > maximum) {
    throw new BadRequestException('ASSISTANT_GEO_RADIUS_INVALID');
  }

  return {
    anchor: { latitude, longitude, label, source },
    radiusMeters,
  };
}

function readCoordinate(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function readBoundedString(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function readConfiguredInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  errorCode: string,
) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AssistantGeoConfigError(errorCode);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
