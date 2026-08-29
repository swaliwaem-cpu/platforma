import { BadRequestException } from '@nestjs/common';
import type {
  AssistantGeoAnchor,
  AssistantGeoAreaGeometry,
  AssistantGeoBrowserConstraint,
  AssistantGeoBrowserInput,
  AssistantGeoConstraint,
  AssistantGeoKind,
  AssistantGeoLineGeometry,
  AssistantGeoPointGeometry,
  AssistantGeoReferenceGeometry,
  AssistantGeoSearchContext,
  AssistantGeoSearchSelection,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

const defaultMinimumDistanceMeters = 100;
const defaultMaximumDistanceMeters = 20_000;
export const assistantGeoDefaultPointDistanceMeters = 2_000;
export const assistantGeoDefaultLandmarkDistanceMeters = 5_000;
const maximumLabelLength = 160;
const maximumGeometryVertices = 20_000;
export const assistantGeoMaximumConstraints = 5;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type AssistantGeoEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type Position = [longitude: number, latitude: number];

export type ParsedAssistantGeoBrowserConstraint =
  | {
      referenceType: 'LANDMARK';
      landmarkId: string;
      mode: 'NEAR' | 'INSIDE';
      distanceMeters: number | null;
      slotId?: string;
      sourceSpan?: { start: number; end: number };
    }
  | {
      referenceType: 'MANUAL_POINT';
      point: { latitude: number; longitude: number; label: string };
      mode: 'NEAR';
      distanceMeters: number;
      slotId?: string;
      sourceSpan?: { start: number; end: number };
    };

export type ParsedAssistantGeoBrowserInput = ParsedAssistantGeoBrowserConstraint;
export type ParsedAssistantGeoBrowserContext = ParsedAssistantGeoBrowserConstraint | {
  operator: 'ALL';
  constraints: ParsedAssistantGeoBrowserConstraint[];
};

export type AssistantGeoLegacySearchContext = {
  anchor: AssistantGeoAnchor;
  radiusMeters: number;
};

export type { AssistantGeoAnchor };

export class AssistantGeoConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantGeoConfigError';
  }
}

/** Strict public ingress. Full geometry, kind and labels for landmarks remain server-owned. */
export function parseAssistantGeoBrowserContext(
  value: unknown,
  environment: AssistantGeoEnvironment = process.env,
): ParsedAssistantGeoBrowserContext {
  if (!isRecord(value)) throw invalidInput();

  if (value.operator === 'ALL') {
    assertExactKeys(value, ['operator', 'constraints']);
    if (!Array.isArray(value.constraints)
      || value.constraints.length < 1
      || value.constraints.length > assistantGeoMaximumConstraints) throw invalidInput();
    const constraints = value.constraints.map((constraint) => parseAssistantGeoBrowserConstraint(
      constraint,
      environment,
    ));
    assertUniqueConstraints(constraints, invalidInput);
    return { operator: 'ALL', constraints };
  }

  return parseAssistantGeoBrowserConstraint(value, environment);
}

export function parseAssistantGeoBrowserInput(
  value: unknown,
  environment: AssistantGeoEnvironment = process.env,
): ParsedAssistantGeoBrowserInput {
  return parseAssistantGeoBrowserConstraint(value, environment);
}

function parseAssistantGeoBrowserConstraint(
  value: unknown,
  environment: AssistantGeoEnvironment,
): ParsedAssistantGeoBrowserConstraint {
  if (!isRecord(value)) throw invalidInput();

  if (value.referenceType === 'LANDMARK') {
    assertExactKeys(value, ['referenceType', 'landmarkId', 'mode', 'distanceMeters', 'slotId', 'sourceSpan']);
    if (typeof value.landmarkId !== 'string' || !uuidPattern.test(value.landmarkId)) throw invalidInput();
    if (value.mode !== 'NEAR' && value.mode !== 'INSIDE') throw invalidInput();
    if (value.mode === 'INSIDE' && value.distanceMeters !== undefined && value.distanceMeters !== null) {
      throw invalidInput();
    }
    return {
      referenceType: 'LANDMARK',
      landmarkId: value.landmarkId,
      mode: value.mode,
      distanceMeters: value.mode === 'NEAR'
        ? parseOptionalDistance(value.distanceMeters, environment)
        : null,
      ...parseSlotMetadata(value),
    };
  }

  if (value.referenceType === 'MANUAL_POINT') {
    assertExactKeys(value, ['referenceType', 'point', 'mode', 'distanceMeters', 'slotId', 'sourceSpan']);
    if (value.mode !== 'NEAR' || !isRecord(value.point)) throw invalidInput();
    assertExactKeys(value.point, ['latitude', 'longitude', 'label']);
    return {
      ...parseManualPoint(value.point, value.distanceMeters, environment),
      ...parseSlotMetadata(value),
    };
  }

  // A short compatibility window for the old manual picker. Provider-labelled points stay rejected.
  if (isRecord(value.anchor) && value.anchor.source === 'MANUAL') {
    assertExactKeys(value, ['anchor', 'radiusMeters']);
    assertExactKeys(value.anchor, ['latitude', 'longitude', 'label', 'source']);
    return parseManualPoint(value.anchor, value.radiusMeters, environment);
  }

  throw invalidInput();
}

/** Dual-read persistence boundary: canonical v2 plus legacy point/radius history. */
export function parseAssistantGeoStoredValue(
  value: unknown,
  environment: AssistantGeoEnvironment = process.env,
): AssistantGeoSearchSelection {
  if (!isRecord(value)) throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
  if (value.operator === 'ALL') {
    assertExactKeys(value, ['operator', 'constraints']);
    if (!Array.isArray(value.constraints)
      || value.constraints.length < 1
      || value.constraints.length > assistantGeoMaximumConstraints) {
      throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
    }
    const constraints = value.constraints.map((constraint) => parseAssistantGeoStoredConstraint(
      constraint,
      environment,
    ));
    assertUniqueConstraints(constraints, () => new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID'));
    return { operator: 'ALL', constraints };
  }
  return parseAssistantGeoStoredConstraint(value, environment);
}

export function parseAssistantGeoStoredContext(
  value: unknown,
  environment: AssistantGeoEnvironment = process.env,
): AssistantGeoSearchContext {
  return parseAssistantGeoStoredConstraint(value, environment);
}

function parseAssistantGeoStoredConstraint(
  value: unknown,
  environment: AssistantGeoEnvironment,
): AssistantGeoConstraint {
  if (!isRecord(value)) throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
  if (isRecord(value.anchor)) {
    const legacy = parseLegacyPointContext(value, environment);
    return {
      kind: 'POINT',
      mode: 'NEAR',
      label: legacy.anchor.label,
      point: {
        latitude: legacy.anchor.latitude,
        longitude: legacy.anchor.longitude,
      },
      distanceMeters: legacy.radiusMeters,
      source: legacy.anchor.source === 'MANUAL' ? 'MANUAL' : 'LANDMARK',
    };
  }

  const kind = value.kind;
  const mode = value.mode;
  const label = readBoundedString(value.label, maximumLabelLength);
  const source = value.source;
  if (!label || (source !== 'MANUAL' && source !== 'LANDMARK')) {
    throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
  }

  if (kind === 'POINT' && mode === 'NEAR') {
    assertExactKeys(value, ['kind', 'mode', 'label', 'point', 'distanceMeters', 'source', 'landmarkId', 'slotId', 'sourceSpan']);
    if (!isRecord(value.point)) throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
    assertExactKeys(value.point, ['latitude', 'longitude']);
    const point = readPoint(value.point);
    const distanceMeters = parseRequiredDistance(value.distanceMeters, environment);
    const landmarkId = readOptionalUuid(value.landmarkId);
    if (!point || (source === 'LANDMARK' && value.landmarkId !== undefined && !landmarkId)
      || (source === 'MANUAL' && landmarkId)) {
      throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
    }
    return {
      kind,
      mode,
      label,
      point,
      distanceMeters,
      source,
      ...(landmarkId ? { landmarkId } : {}),
      ...parseSlotMetadata(value),
    };
  }

  if (kind === 'LINE' && mode === 'NEAR') {
    assertExactKeys(value, ['kind', 'mode', 'label', 'landmarkId', 'distanceMeters', 'source', 'slotId', 'sourceSpan']);
    const landmarkId = readOptionalUuid(value.landmarkId);
    if (!landmarkId || source !== 'LANDMARK') throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
    return {
      kind,
      mode,
      label,
      landmarkId,
      distanceMeters: parseRequiredDistance(value.distanceMeters, environment),
      source,
      ...parseSlotMetadata(value),
    };
  }

  if (kind === 'AREA' && (mode === 'NEAR' || mode === 'INSIDE')) {
    const allowed = mode === 'NEAR'
      ? ['kind', 'mode', 'label', 'landmarkId', 'distanceMeters', 'source', 'slotId', 'sourceSpan']
      : ['kind', 'mode', 'label', 'landmarkId', 'source', 'slotId', 'sourceSpan'];
    assertExactKeys(value, allowed);
    const landmarkId = readOptionalUuid(value.landmarkId);
    if (!landmarkId || source !== 'LANDMARK') throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
    return mode === 'NEAR'
      ? {
          kind,
          mode,
          label,
          landmarkId,
          distanceMeters: parseRequiredDistance(value.distanceMeters, environment),
          source,
          ...parseSlotMetadata(value),
        }
      : { kind, mode, label, landmarkId, source, ...parseSlotMetadata(value) };
  }

  throw new BadRequestException('ASSISTANT_GEO_CONTEXT_INVALID');
}

/** @deprecated Legacy parser kept only for old tests/readers. New HTTP ingress uses parseAssistantGeoBrowserInput. */
export function parseAssistantGeoSearchInput(
  value: unknown,
  environment: AssistantGeoEnvironment = process.env,
): AssistantGeoLegacySearchContext {
  return parseLegacyPointContext(value, environment);
}

export function parseAssistantReferenceGeometry(
  value: unknown,
  expectedKind: AssistantGeoKind,
): AssistantGeoReferenceGeometry {
  if (!isRecord(value)) throw invalidGeometry();
  assertExactGeometryKeys(value);
  const coordinates = value.coordinates;
  let vertexCount = 0;
  const position = (candidate: unknown): Position => {
    if (!Array.isArray(candidate) || candidate.length !== 2) throw invalidGeometry();
    const [longitude, latitude] = candidate;
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw invalidGeometry();
    }
    vertexCount += 1;
    if (vertexCount > maximumGeometryVertices) throw invalidGeometry();
    return [longitude, latitude];
  };
  const line = (candidate: unknown): Position[] => {
    if (!Array.isArray(candidate) || candidate.length < 2) throw invalidGeometry();
    const result = candidate.map(position);
    if (result.every(([longitude, latitude]) => longitude === result[0]![0] && latitude === result[0]![1])) {
      throw invalidGeometry();
    }
    return result;
  };
  const ring = (candidate: unknown): Position[] => {
    if (!Array.isArray(candidate) || candidate.length < 4) throw invalidGeometry();
    const result = candidate.map(position);
    const first = result[0]!;
    const last = result[result.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]
      || new Set(result.slice(0, -1).map(([longitude, latitude]) => `${longitude}:${latitude}`)).size < 3) {
      throw invalidGeometry();
    }
    return result;
  };
  const polygon = (candidate: unknown): Position[][] => {
    if (!Array.isArray(candidate) || candidate.length < 1) throw invalidGeometry();
    return candidate.map(ring);
  };

  if (expectedKind === 'POINT' && value.type === 'Point') {
    return { type: 'Point', coordinates: position(coordinates) } satisfies AssistantGeoPointGeometry;
  }
  if (expectedKind === 'LINE' && value.type === 'LineString') {
    return { type: 'LineString', coordinates: line(coordinates) } satisfies AssistantGeoLineGeometry;
  }
  if (expectedKind === 'LINE' && value.type === 'MultiLineString') {
    if (!Array.isArray(coordinates) || coordinates.length < 1) throw invalidGeometry();
    return { type: 'MultiLineString', coordinates: coordinates.map(line) } satisfies AssistantGeoLineGeometry;
  }
  if (expectedKind === 'AREA' && value.type === 'Polygon') {
    return { type: 'Polygon', coordinates: polygon(coordinates) } satisfies AssistantGeoAreaGeometry;
  }
  if (expectedKind === 'AREA' && value.type === 'MultiPolygon') {
    if (!Array.isArray(coordinates) || coordinates.length < 1) throw invalidGeometry();
    return { type: 'MultiPolygon', coordinates: coordinates.map(polygon) } satisfies AssistantGeoAreaGeometry;
  }
  throw invalidGeometry();
}

function parseManualPoint(
  value: Record<string, unknown>,
  distanceValue: unknown,
  environment: AssistantGeoEnvironment,
): Extract<ParsedAssistantGeoBrowserInput, { referenceType: 'MANUAL_POINT' }> {
  const point = readPoint(value);
  const label = value.label === undefined
    ? 'Точка на карте'
    : readBoundedString(value.label, maximumLabelLength);
  if (!point || !label) throw invalidInput();
  return {
    referenceType: 'MANUAL_POINT',
    point: { ...point, label },
    mode: 'NEAR',
    distanceMeters: parseOptionalDistance(distanceValue, environment) ?? assistantGeoDefaultPointDistanceMeters,
  };
}

function parseLegacyPointContext(
  value: unknown,
  environment: AssistantGeoEnvironment,
): AssistantGeoLegacySearchContext {
  if (!isRecord(value) || !isRecord(value.anchor)) {
    throw new BadRequestException('ASSISTANT_GEO_ANCHOR_INVALID');
  }
  const point = readPoint(value.anchor);
  const label = readBoundedString(value.anchor.label, maximumLabelLength);
  const source = ['MANUAL', 'PLACE', 'ALIAS', 'KNOWLEDGE'].includes(String(value.anchor.source))
    ? value.anchor.source as AssistantGeoAnchor['source']
    : null;
  if (!point || !label || !source) throw new BadRequestException('ASSISTANT_GEO_ANCHOR_INVALID');
  return {
    anchor: { ...point, label, source },
    radiusMeters: parseRequiredDistance(value.radiusMeters, environment, 'ASSISTANT_GEO_RADIUS_INVALID'),
  };
}

function parseOptionalDistance(value: unknown, environment: AssistantGeoEnvironment) {
  if (value === undefined || value === null) return null;
  return parseRequiredDistance(value, environment);
}

function parseRequiredDistance(
  value: unknown,
  environment: AssistantGeoEnvironment,
  errorCode = 'ASSISTANT_GEO_DISTANCE_INVALID',
) {
  const minimum = readConfiguredInteger(
    environment.ASSISTANT_GEO_RADIUS_MIN_METERS,
    defaultMinimumDistanceMeters,
    1,
    100_000,
    'ASSISTANT_GEO_RADIUS_MIN_METERS_INVALID',
  );
  const maximum = readConfiguredInteger(
    environment.ASSISTANT_GEO_RADIUS_MAX_METERS,
    defaultMaximumDistanceMeters,
    minimum,
    100_000,
    'ASSISTANT_GEO_RADIUS_MAX_METERS_INVALID',
  );
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BadRequestException(errorCode);
  }
  return value;
}

function readPoint(value: Record<string, unknown>) {
  const latitude = readCoordinate(value.latitude, -90, 90);
  const longitude = readCoordinate(value.longitude, -180, 180);
  return latitude === null || longitude === null ? null : { latitude, longitude };
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

function readOptionalUuid(value: unknown) {
  if (value === undefined) return null;
  return typeof value === 'string' && uuidPattern.test(value) ? value : null;
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

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidInput();
}

function assertExactGeometryKeys(value: Record<string, unknown>) {
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'type') || !Object.hasOwn(value, 'coordinates')) {
    throw invalidGeometry();
  }
}

function invalidInput() {
  return new BadRequestException('ASSISTANT_GEO_INPUT_INVALID');
}

function invalidGeometry() {
  return new BadRequestException('ASSISTANT_GEO_GEOMETRY_INVALID');
}

function parseSlotMetadata(value: Record<string, unknown>) {
  const slotId = value.slotId === undefined || value.slotId === null ? null : value.slotId;
  if (slotId !== null && (typeof slotId !== 'string' || !/^geo-[1-5]$/u.test(slotId))) throw invalidInput();
  const sourceSpan = value.sourceSpan === undefined || value.sourceSpan === null ? null : value.sourceSpan;
  if (sourceSpan !== null && (!isRecord(sourceSpan)
    || Object.keys(sourceSpan).sort().join(',') !== 'end,start'
    || !Number.isInteger(sourceSpan.start)
    || !Number.isInteger(sourceSpan.end)
    || Number(sourceSpan.start) < 0
    || Number(sourceSpan.end) <= Number(sourceSpan.start)
    || Number(sourceSpan.end) > 4_000)) throw invalidInput();
  if ((slotId === null) !== (sourceSpan === null)) throw invalidInput();
  return slotId === null ? {} : {
    slotId,
    sourceSpan: sourceSpan as { start: number; end: number },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toAssistantGeoBrowserContext(context: AssistantGeoSearchSelection): AssistantGeoBrowserInput {
  if ('operator' in context) {
    return {
      operator: 'ALL',
      constraints: context.constraints.map(toAssistantGeoBrowserConstraint),
    };
  }
  return toAssistantGeoBrowserConstraint(context);
}

export function toAssistantGeoBrowserInput(context: AssistantGeoSearchContext): AssistantGeoBrowserConstraint {
  return toAssistantGeoBrowserConstraint(context);
}

function toAssistantGeoBrowserConstraint(context: AssistantGeoConstraint): AssistantGeoBrowserConstraint {
  if (context.source === 'LANDMARK' && context.landmarkId) {
    return {
      referenceType: 'LANDMARK',
      landmarkId: context.landmarkId,
      mode: context.mode,
      ...(context.mode === 'NEAR' ? { distanceMeters: context.distanceMeters } : {}),
      ...(context.slotId ? { slotId: context.slotId, sourceSpan: context.sourceSpan } : {}),
    };
  }
  if (context.kind !== 'POINT') throw new Error('ASSISTANT_GEO_LANDMARK_ID_REQUIRED');
  return {
    referenceType: 'MANUAL_POINT',
    point: { ...context.point, label: context.label },
    mode: 'NEAR',
    distanceMeters: context.distanceMeters,
    ...(context.slotId ? { slotId: context.slotId, sourceSpan: context.sourceSpan } : {}),
  };
}

function assertUniqueConstraints(
  constraints: Array<ParsedAssistantGeoBrowserConstraint | AssistantGeoConstraint>,
  createError: () => Error,
) {
  const keys = constraints.map((constraint) => {
    if ('referenceType' in constraint) {
      return constraint.referenceType === 'LANDMARK'
        ? `LANDMARK:${constraint.landmarkId}:${constraint.mode}:${constraint.distanceMeters ?? ''}`
        : `MANUAL:${constraint.point.latitude}:${constraint.point.longitude}:${constraint.distanceMeters}`;
    }
    if (constraint.source === 'LANDMARK' && constraint.landmarkId) {
      return `LANDMARK:${constraint.landmarkId}:${constraint.mode}:${constraint.mode === 'NEAR' ? constraint.distanceMeters : ''}`;
    }
    return constraint.kind === 'POINT'
      ? `MANUAL:${constraint.point.latitude}:${constraint.point.longitude}:${constraint.distanceMeters}`
      : `${constraint.kind}:${constraint.label}:${constraint.mode}`;
  });
  if (new Set(keys).size !== keys.length) throw createError();
}

export function assertAssistantGeoUniqueConstraints(constraints: AssistantGeoConstraint[]) {
  assertUniqueConstraints(constraints, invalidInput);
}
