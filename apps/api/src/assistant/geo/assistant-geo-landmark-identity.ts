import type { AssistantGeoKind } from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  AssistantGeoProviderError,
  type AssistantGeoProviderCandidate,
} from './assistant-geo-provider';

export type AssistantGeoLandmarkIdentity = {
  version: 2;
  label: string;
  normalizedQuery: string;
  userAlias: string;
  aliases: string[];
  providerQuery: string;
  expectedKind: AssistantGeoKind | null;
  expectedCity: string | null;
  expectedCountry: string | null;
  providerViewbox: [west: number, south: number, east: number, north: number] | null;
  candidatePolicy: AssistantGeoCandidateIdentityPolicy | null;
  overpassTagValues: string[];
  overpassRelationIds: string[] | null;
};

export type AssistantGeoCandidateIdentityPolicy = {
  allowMissingCity: boolean;
  allowedEntityClasses: string[];
  allowedEntityTypes: string[] | null;
  allowedOsmTypes: string[];
  allowedOsmIds: string[] | null;
  requireNumericOsmId: boolean;
};

type FixedIdentity = Omit<AssistantGeoLandmarkIdentity, 'userAlias'> & {
  inputAliases: readonly string[];
};

export const assistantGeoMoscowViewbox = [37.3, 55.5, 37.9, 55.9] as const;

export const assistantGeoMoscowBoundaryIdentity = Object.freeze({
  names: ['Москва'],
  osmType: 'relation',
  osmIds: ['2555133'],
});

const moscowScope = {
  expectedCity: 'Москва',
  expectedCountry: 'ru',
  providerViewbox: [...assistantGeoMoscowViewbox] as [number, number, number, number],
};

const moscowRoadScope = {
  expectedKind: 'LINE' as const,
  ...moscowScope,
  candidatePolicy: {
    allowMissingCity: true,
    allowedEntityClasses: ['highway'],
    allowedEntityTypes: null,
    allowedOsmTypes: ['way'],
    allowedOsmIds: null,
    requireNumericOsmId: true,
  },
};

const identities: readonly FixedIdentity[] = [
  {
    version: 2,
    label: 'Белорусский вокзал',
    normalizedQuery: 'белорусский вокзал',
    aliases: ['белорусский вокзал'],
    inputAliases: [
      'белорусский вокзал',
      'белорусского вокзала',
      'белорусскому вокзалу',
      'белорусским вокзалом',
      'белорусском вокзале',
    ],
    providerQuery: 'Белорусский вокзал',
    expectedKind: 'POINT',
    ...moscowScope,
    candidatePolicy: {
      allowMissingCity: true,
      allowedEntityClasses: ['railway'],
      allowedEntityTypes: ['station'],
      allowedOsmTypes: ['node', 'way', 'relation'],
      allowedOsmIds: null,
      requireNumericOsmId: true,
    },
    overpassTagValues: ['Белорусский вокзал'],
    overpassRelationIds: null,
  },
  {
    version: 2,
    label: 'Москва-Сити',
    normalizedQuery: 'москва-сити',
    aliases: ['москва-сити', 'московский международный деловой центр'],
    inputAliases: ['москва-сити', 'москва сити', 'московского международного делового центра'],
    providerQuery: 'Москва-Сити',
    expectedKind: 'POINT',
    ...moscowScope,
    candidatePolicy: null,
    overpassTagValues: ['Москва-Сити'],
    overpassRelationIds: null,
  },
  {
    version: 2,
    label: 'Садовое кольцо',
    normalizedQuery: 'садовое кольцо',
    aliases: ['садовое кольцо'],
    inputAliases: [
      'садовое кольцо',
      'садового кольца',
      'садовому кольцу',
      'садовым кольцом',
      'садовом кольце',
    ],
    providerQuery: 'садовое кольцо',
    ...moscowRoadScope,
    overpassTagValues: ['Садовое кольцо'],
    overpassRelationIds: ['2094267'],
  },
  {
    version: 2,
    label: 'ТТК',
    normalizedQuery: 'третье транспортное кольцо',
    aliases: ['ттк', 'третье транспортное кольцо'],
    inputAliases: [
      'ттк',
      'третье транспортное кольцо',
      'третьего транспортного кольца',
      'третьему транспортному кольцу',
      'третьим транспортным кольцом',
      'третьем транспортном кольце',
    ],
    providerQuery: 'третье транспортное кольцо',
    ...moscowRoadScope,
    overpassTagValues: ['ТТК', 'Третье транспортное кольцо'],
    overpassRelationIds: ['2094286'],
  },
  {
    version: 2,
    label: 'МКАД',
    normalizedQuery: 'московская кольцевая автодорога',
    aliases: [
      'мкад',
      'московская кольцевая автодорога',
      'московская кольцевая автомобильная дорога',
    ],
    inputAliases: [
      'мкад',
      'московская кольцевая автодорога',
      'московской кольцевой автодороги',
      'московской кольцевой автодороге',
      'московскую кольцевую автодорогу',
      'московской кольцевой автодорогой',
      'московская кольцевая автомобильная дорога',
      'московской кольцевой автомобильной дороги',
      'московской кольцевой автомобильной дороге',
      'московскую кольцевую автомобильную дорогу',
      'московской кольцевой автомобильной дорогой',
    ],
    providerQuery: 'московская кольцевая автодорога',
    ...moscowRoadScope,
    overpassTagValues: ['МКАД', 'Московская кольцевая автодорога', 'Московская кольцевая автомобильная дорога'],
    overpassRelationIds: ['2094222'],
  },
  {
    version: 2,
    label: 'район Арбат',
    normalizedQuery: 'район арбат',
    aliases: ['арбат', 'район арбат'],
    inputAliases: ['арбат', 'район арбат', 'района арбат'],
    providerQuery: 'район арбат',
    expectedKind: 'AREA',
    ...moscowScope,
    candidatePolicy: {
      allowMissingCity: true,
      allowedEntityClasses: ['boundary'],
      allowedEntityTypes: ['administrative'],
      allowedOsmTypes: ['relation'],
      allowedOsmIds: ['1255910'],
      requireNumericOsmId: true,
    },
    overpassTagValues: [],
    overpassRelationIds: null,
  },
];

export function resolveAssistantGeoLandmarkIdentity(value: string): AssistantGeoLandmarkIdentity {
  const label = normalizeDisplayText(value);
  const userAlias = normalizeAssistantGeoIdentityText(label);
  const fixed = identities.find(({ inputAliases }) => inputAliases.includes(userAlias));
  if (!fixed) {
    return {
      version: 2,
      label,
      normalizedQuery: userAlias,
      userAlias,
      aliases: [userAlias],
      providerQuery: label,
      expectedKind: null,
      expectedCity: null,
      expectedCountry: null,
      providerViewbox: null,
      candidatePolicy: null,
      overpassTagValues: [label],
      overpassRelationIds: null,
    };
  }
  return {
    version: fixed.version,
    label: fixed.label,
    normalizedQuery: fixed.normalizedQuery,
    userAlias,
    aliases: [...fixed.aliases],
    providerQuery: fixed.providerQuery,
    expectedKind: fixed.expectedKind,
    expectedCity: fixed.expectedCity,
    expectedCountry: fixed.expectedCountry,
    providerViewbox: fixed.providerViewbox,
    candidatePolicy: fixed.candidatePolicy ? {
      ...fixed.candidatePolicy,
      allowedEntityClasses: [...fixed.candidatePolicy.allowedEntityClasses],
      allowedEntityTypes: fixed.candidatePolicy.allowedEntityTypes
        ? [...fixed.candidatePolicy.allowedEntityTypes]
        : null,
      allowedOsmTypes: [...fixed.candidatePolicy.allowedOsmTypes],
      allowedOsmIds: fixed.candidatePolicy.allowedOsmIds ? [...fixed.candidatePolicy.allowedOsmIds] : null,
    } : null,
    overpassTagValues: [...fixed.overpassTagValues],
    overpassRelationIds: fixed.overpassRelationIds ? [...fixed.overpassRelationIds] : null,
  };
}

export function normalizeAssistantGeoIdentityText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е');
}

type AssistantGeoCandidateSelectionInput = Pick<
  AssistantGeoLandmarkIdentity,
  | 'aliases'
  | 'candidatePolicy'
  | 'expectedCity'
  | 'expectedCountry'
  | 'expectedKind'
  | 'providerQuery'
  | 'providerViewbox'
> & {
  placeQuery: string;
  mode: 'NEAR' | 'INSIDE';
};

export function selectAssistantGeoProviderCandidates(
  candidates: AssistantGeoProviderCandidate[],
  input: AssistantGeoCandidateSelectionInput,
  providerName: 'fake' | 'locationiq',
) {
  if (providerName === 'fake') return selectLegacyGeometryCandidates(candidates, input.mode);
  if (input.candidatePolicy && input.expectedKind) {
    return selectStrictIdentityCandidates(candidates, input);
  }
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
      [...input.aliases, input.providerQuery].map(normalizeAssistantGeoIdentityText),
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

export function isExpectedAssistantGeoAdministrativeBounds(
  candidate: AssistantGeoProviderCandidate,
  input: {
    expectedCity: string;
    expectedCountry: string | null;
    expectedBounds: [west: number, south: number, east: number, north: number] | null;
  },
) {
  const isMoscow = normalizeAssistantGeoIdentityText(input.expectedCity)
    === normalizeAssistantGeoIdentityText(assistantGeoMoscowBoundaryIdentity.names[0]!);
  return candidate.geometryKind === 'AREA'
    && candidate.geometryComplete === false
    && candidate.referenceGeometry === undefined
    && Boolean(candidate.boundingBox)
    && candidateMatchesAdministrativeRelationIdentity(candidate, {
      expectedNames: isMoscow ? [...assistantGeoMoscowBoundaryIdentity.names] : [input.expectedCity],
      expectedCity: input.expectedCity,
      expectedCountry: input.expectedCountry,
      allowMissingCity: true,
      expectedBounds: input.expectedBounds,
      allowedOsmIds: isMoscow ? [...assistantGeoMoscowBoundaryIdentity.osmIds] : null,
    });
}

function selectStrictIdentityCandidates(
  candidates: AssistantGeoProviderCandidate[],
  input: AssistantGeoCandidateSelectionInput,
) {
  const expectedKind = input.expectedKind;
  const policy = input.candidatePolicy;
  if (!expectedKind || !policy) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_IDENTITY_REJECTED', false);
  }
  const expectedNames = new Set(
    [...input.aliases, input.providerQuery, input.placeQuery].map(normalizeAssistantGeoIdentityText),
  );
  const identityMatches = candidates.filter((candidate) => (
    candidateHasExpectedName(candidate, expectedNames)
    && candidateMatchesIdentityPolicy(candidate, policy)
  ));
  if (identityMatches.length === 0) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_IDENTITY_REJECTED', false);
  }
  const scopeMatches = identityMatches.filter((candidate) => matchesExpectedScope(
    candidate,
    input.expectedCity,
    input.expectedCountry,
    policy.allowMissingCity,
    input.providerViewbox,
  ));
  if (scopeMatches.length === 0) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_SCOPE_REJECTED', false);
  }
  const shapeMatches = scopeMatches.filter((candidate) => candidateMatchesExpectedShape(candidate, expectedKind));
  if (shapeMatches.length === 0) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_SHAPE_REJECTED', false);
  }
  if (expectedKind !== 'LINE' && shapeMatches.length !== 1) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_IDENTITY_AMBIGUOUS', false);
  }
  return shapeMatches;
}

function candidateHasExpectedName(candidate: AssistantGeoProviderCandidate, expectedNames: Set<string>) {
  const candidateNames = [candidate.label.split(',')[0]!, ...(candidate.names ?? [])]
    .map(normalizeAssistantGeoIdentityText);
  return candidateNames.some((name) => expectedNames.has(name));
}

function candidateMatchesIdentityPolicy(
  candidate: AssistantGeoProviderCandidate,
  policy: AssistantGeoCandidateIdentityPolicy,
) {
  const entityClass = normalizeAssistantGeoIdentityText(candidate.entityClass ?? '');
  const entityType = normalizeAssistantGeoIdentityText(candidate.entityType ?? '');
  const osmType = normalizeAssistantGeoIdentityText(candidate.osmType ?? '');
  const osmId = candidate.osmId ?? '';
  return policy.allowedEntityClasses.includes(entityClass)
    && (policy.allowedEntityTypes === null || policy.allowedEntityTypes.includes(entityType))
    && policy.allowedOsmTypes.includes(osmType)
    && (!policy.requireNumericOsmId || /^[1-9]\d*$/u.test(osmId))
    && (policy.allowedOsmIds === null || policy.allowedOsmIds.includes(osmId));
}

function candidateMatchesExpectedShape(candidate: AssistantGeoProviderCandidate, expectedKind: AssistantGeoKind) {
  if (candidate.geometryKind !== expectedKind) return false;
  if (expectedKind === 'POINT') return candidate.geometryComplete === true && !candidate.referenceGeometry;
  if (expectedKind === 'LINE') return candidate.geometryComplete === false && !candidate.referenceGeometry;
  return candidate.geometryComplete === true && Boolean(candidate.referenceGeometry && candidate.boundingBox);
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
  return candidate.geometryKind === 'AREA'
    && candidate.geometryComplete === true
    && Boolean(candidate.referenceGeometry && candidate.boundingBox)
    && candidateMatchesAdministrativeRelationIdentity(candidate, {
      expectedNames: input.expectedNames,
      expectedCity: input.expectedCity,
      expectedCountry: input.expectedCountry,
      allowMissingCity: false,
      expectedBounds: null,
      allowedOsmIds: null,
    });
}

function candidateMatchesAdministrativeRelationIdentity(
  candidate: AssistantGeoProviderCandidate,
  input: {
    expectedNames?: string[];
    expectedCity: string | null;
    expectedCountry: string | null;
    allowMissingCity: boolean;
    expectedBounds: [west: number, south: number, east: number, north: number] | null;
    allowedOsmIds: string[] | null;
  },
) {
  if (normalizeAssistantGeoIdentityText(candidate.entityClass ?? '') !== 'boundary'
    || normalizeAssistantGeoIdentityText(candidate.entityType ?? '') !== 'administrative'
    || normalizeAssistantGeoIdentityText(candidate.osmType ?? '') !== 'relation'
    || (input.allowedOsmIds !== null && !input.allowedOsmIds.includes(candidate.osmId ?? ''))
    || !matchesExpectedScope(
      candidate,
      input.expectedCity,
      input.expectedCountry,
      input.allowMissingCity,
      input.expectedBounds,
    )) return false;
  if (!input.expectedNames) return true;
  const expectedNames = new Set(input.expectedNames.map(normalizeAssistantGeoIdentityText));
  return candidateHasExpectedName(candidate, expectedNames);
}

function matchesExpectedScope(
  candidate: AssistantGeoProviderCandidate,
  expectedCity: string | null,
  expectedCountry: string | null,
  allowMissingCity = false,
  expectedBounds: [west: number, south: number, east: number, north: number] | null = null,
) {
  if (expectedCity) {
    if (candidate.city !== null
      && normalizeAssistantGeoIdentityText(candidate.city) !== normalizeAssistantGeoIdentityText(expectedCity)) return false;
    if (candidate.city === null && !allowMissingCity) return false;
  }
  if (expectedCountry
    && normalizeAssistantGeoIdentityText(candidate.countryCode ?? '') !== normalizeAssistantGeoIdentityText(expectedCountry)) {
    return false;
  }
  if (expectedBounds && !pointIsInsideBounds(candidate.longitude, candidate.latitude, expectedBounds)) return false;
  return true;
}

function pointIsInsideBounds(
  longitude: number,
  latitude: number,
  bounds: [west: number, south: number, east: number, north: number],
) {
  return longitude >= bounds[0] && longitude <= bounds[2]
    && latitude >= bounds[1] && latitude <= bounds[3];
}

function normalizeDisplayText(value: string) {
  return value.normalize('NFC').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}
