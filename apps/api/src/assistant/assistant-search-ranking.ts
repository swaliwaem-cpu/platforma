import type {
  AssistantAlternativeDeviation,
  AssistantSearchResultCard,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  AssistantPlannerFallbackValidationError,
  createAssistantComparisonTargetVariants,
  type AssistantComparisonTargetMode,
  type AssistantSearchFilters,
  type AssistantStructuredIntent,
} from './assistant-query-planner';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedDeviationTypes = ['BUDGET', 'DISTRICT', 'DEVELOPER', 'ROOMS'] as const;

export type AssistantCandidatePdf = {
  fileId: string;
  title: string;
};

export type AssistantSearchEvidence = {
  unitId: string;
  unitExternalId?: string;
  objectId: string;
  objectType: 'RESIDENTIAL' | 'COMMERCIAL';
  objectTitle: string;
  objectSlug: string;
  lotTitle: string | null;
  priceRub: number;
  availability: 'AVAILABLE';
  updatedAt: string;
  rooms: number | null;
  district: string | null;
  metros: string[];
  developer: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  propertyClass: string | null;
  area: number | null;
  floor: number | null;
  latitude?: number | null;
  longitude?: number | null;
  distanceMeters?: number | null;
  walkingMetro?: {
    stationName: string;
    durationSeconds: number;
  } | null;
  pdfs: AssistantCandidatePdf[];
  deviations: AssistantAlternativeDeviation[];
};

export type AssistantSearchAnswer = {
  kind: 'SEARCH_RESULTS';
  content: string;
  totalExactResults: number;
  exactResults: AssistantSearchResultCard[];
  additionalExactResults: AssistantSearchResultCard[];
  alternatives: AssistantSearchResultCard[];
};

export type AssistantSearchRankingTrace = {
  evidence: AssistantSearchEvidence;
  candidateRank: number | null;
  rankingPool: 'EXACT' | 'ALTERNATIVE' | 'REJECTED';
  rankingScore: {
    deviationCount: number;
    softPreferenceScore: number;
    distanceMeters: number | null;
    priceRub: number;
    freshnessTimestamp: number | null;
  };
  rejectionCodes: string[];
};

export class AssistantAnswerValidationError extends AssistantPlannerFallbackValidationError {
  constructor(code = 'ASSISTANT_ANSWER_EVIDENCE_INVALID') {
    super(code);
    this.name = 'AssistantAnswerValidationError';
  }
}

export function buildAssistantSearchAnswer(
  intent: AssistantStructuredIntent,
  exactEvidence: AssistantSearchEvidence[],
  alternativeEvidence: AssistantSearchEvidence[],
  now = new Date(),
  totalExactResults?: number,
): AssistantSearchAnswer {
  const rankedExactCandidates = rankCandidates(
    uniqueCandidatesByUnitId(exactEvidence.filter((candidate) =>
      isValidAssistantSearchEvidence(candidate)
      && hasRequiredFacts(candidate, intent.requiredFacts)
      && matchesAssistantSearchFilters(candidate, intent.hardFilters))),
    intent.softPreferences,
  );
  const exactSelection = selectComparisonCandidates(
    rankedExactCandidates,
    intent.comparisonTargets,
    intent.comparisonTargetModes,
    8,
  );
  const selectedExactCandidates = exactSelection.selected;
  const exactResults = selectedExactCandidates
    .slice(0, 3)
    .map((candidate) => createResultCard(candidate, now));
  const additionalExactResults = selectedExactCandidates
    .slice(3, 8)
    .map((candidate) => createResultCard(candidate, now));
  if (totalExactResults !== undefined
    && (!Number.isSafeInteger(totalExactResults) || totalExactResults < 0)) {
    throw new AssistantAnswerValidationError('ASSISTANT_SEARCH_TOTAL_INVALID');
  }
  const comparesExplicitTargets = intent.comparisonTargets.length === 2;
  const incompleteComparison = comparesExplicitTargets
    && rankedExactCandidates.length > 0
    && selectedExactCandidates.length === 0;
  const resolvedTotalExactResults = incompleteComparison
    ? 0
    : totalExactResults ?? exactSelection.eligibleCount;
  if (!incompleteComparison
    && totalExactResults !== undefined
    && selectedExactCandidates.length !== Math.min(resolvedTotalExactResults, 8)) {
    throw new AssistantAnswerValidationError('ASSISTANT_SEARCH_TOTAL_INVALID');
  }
  const rankedAlternatives = rankCandidates(
    uniqueCandidatesByUnitId(alternativeEvidence.filter((candidate) =>
      isValidAssistantAlternativeEvidence(candidate) && hasRequiredFacts(candidate, intent.requiredFacts))),
    intent.softPreferences,
  );
  const alternatives = exactResults.length === 0
    ? selectComparisonCandidates(
        rankedAlternatives,
        intent.comparisonTargets,
        intent.comparisonTargetModes,
        2,
      ).selected.map((candidate) => createResultCard(candidate, now))
    : [];

  return {
    kind: 'SEARCH_RESULTS',
    content: exactResults.length > 0
      ? intent.taskType === 'COMPARE' && intent.comparisonTargets.length === 2
        ? 'Сравнил подтверждённые предложения по двум выбранным вариантам.'
        : 'Нашёл точные предложения по указанным критериям.'
      : alternatives.length > 0
        ? 'Точных совпадений нет. Показываю ближайшие альтернативы с явными отклонениями.'
        : 'Не могу подтвердить подходящие предложения по текущим данным Platforma.',
    totalExactResults: resolvedTotalExactResults,
    exactResults,
    additionalExactResults,
    alternatives,
  };
}

function selectComparisonCandidates(
  candidates: AssistantSearchEvidence[],
  comparisonTargets: string[],
  comparisonTargetModes: AssistantComparisonTargetMode[] | undefined,
  limit: number,
) {
  if (comparisonTargets.length !== 2) {
    return { selected: candidates.slice(0, limit), eligibleCount: candidates.length };
  }
  const selected: AssistantSearchEvidence[] = [];
  const resolvedTargets = comparisonTargets.map((target, index) => {
    const rawMatches = candidates.filter((item) => matchesComparisonTarget(item, target));
    if (rawMatches.length > 0) return [target];
    return createAssistantComparisonTargetVariants(
      target,
      comparisonTargetModes?.[index] ?? 'EXACT',
    ).slice(1);
  });
  const candidatesByTarget = resolvedTargets.map((variants) => candidates.filter((candidate) =>
    variants.some((variant) => matchesComparisonTarget(candidate, variant))));
  for (const firstCandidate of candidatesByTarget[0]!) {
    const secondCandidate = candidatesByTarget[1]!.find(({ unitId }) => unitId !== firstCandidate.unitId);
    if (!secondCandidate) continue;
    selected.push(firstCandidate, secondCandidate);
    break;
  }
  if (selected.length !== 2) return { selected: [], eligibleCount: 0 };
  const eligibleCandidates = candidates.filter((candidate) => resolvedTargets.some((variants) =>
    variants.some((variant) => matchesComparisonTarget(candidate, variant))));
  for (const candidate of eligibleCandidates) {
    if (selected.length >= limit) break;
    if (!selected.some(({ unitId }) => unitId === candidate.unitId)) selected.push(candidate);
  }
  return { selected, eligibleCount: eligibleCandidates.length };
}

function uniqueCandidatesByUnitId(candidates: AssistantSearchEvidence[]) {
  const seen = new Set<string>();
  return candidates.filter(({ unitId }) => {
    if (seen.has(unitId)) return false;
    seen.add(unitId);
    return true;
  });
}

function matchesComparisonTarget(candidate: AssistantSearchEvidence, target: string) {
  return containsNormalizedPhrase(candidate.objectTitle, target)
    || containsNormalizedPhrase(candidate.developer, target);
}

function containsNormalizedPhrase(value: string | null, expected: string) {
  const normalizePhrase = (text: string) => normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const normalizedValue = normalizePhrase(value ?? '');
  const normalizedExpected = normalizePhrase(expected);
  return normalizedExpected.length > 0 && ` ${normalizedValue} `.includes(` ${normalizedExpected} `);
}

export function validateAssistantSearchAnswer(
  answer: AssistantSearchAnswer,
  evidence: AssistantSearchEvidence[],
  intent: AssistantStructuredIntent,
  now = new Date(),
  totalExactResults?: number,
) {
  const exactEvidence = evidence.filter((candidate) => candidate.deviations.length === 0);
  const alternativeEvidence = evidence.filter((candidate) => candidate.deviations.length > 0);
  const expected = buildAssistantSearchAnswer(
    intent,
    exactEvidence,
    alternativeEvidence,
    now,
    totalExactResults,
  );
  if (JSON.stringify(answer) !== JSON.stringify(expected)) {
    throw new AssistantAnswerValidationError();
  }
}

export function createAssistantSearchRankingTrace(
  intent: AssistantStructuredIntent,
  candidates: AssistantSearchEvidence[],
): AssistantSearchRankingTrace[] {
  const exact: AssistantSearchEvidence[] = [];
  const alternatives: AssistantSearchEvidence[] = [];
  const rejected: AssistantSearchRankingTrace[] = [];

  for (const candidate of candidates) {
    const rejectionCodes: string[] = [];
    if (candidate.deviations.length === 0) {
      if (!isValidAssistantSearchEvidence(candidate)) rejectionCodes.push('INVALID_EVIDENCE');
      if (!hasRequiredFacts(candidate, intent.requiredFacts)) rejectionCodes.push('MISSING_REQUIRED_FACTS');
      if (!matchesAssistantSearchFilters(candidate, intent.hardFilters)) rejectionCodes.push('HARD_FILTER_MISMATCH');
      if (rejectionCodes.length === 0) exact.push(candidate);
    } else {
      if (!isValidAssistantAlternativeEvidence(candidate)) rejectionCodes.push('INVALID_ALTERNATIVE_EVIDENCE');
      if (!hasRequiredFacts(candidate, intent.requiredFacts)) rejectionCodes.push('MISSING_REQUIRED_FACTS');
      if (rejectionCodes.length === 0) alternatives.push(candidate);
    }
    if (rejectionCodes.length > 0) {
      rejected.push(createRankingTraceEntry(candidate, null, 'REJECTED', intent, rejectionCodes));
    }
  }

  return [
    ...rankCandidates(exact, intent.softPreferences).map((candidate, index) =>
      createRankingTraceEntry(candidate, index + 1, 'EXACT', intent)),
    ...rankCandidates(alternatives, intent.softPreferences).map((candidate, index) =>
      createRankingTraceEntry(candidate, index + 1, 'ALTERNATIVE', intent)),
    ...rejected,
  ];
}

function createRankingTraceEntry(
  evidence: AssistantSearchEvidence,
  candidateRank: number | null,
  rankingPool: AssistantSearchRankingTrace['rankingPool'],
  intent: AssistantStructuredIntent,
  rejectionCodes: string[] = [],
): AssistantSearchRankingTrace {
  const freshnessTimestamp = Date.parse(evidence.updatedAt);
  return {
    evidence,
    candidateRank,
    rankingPool,
    rankingScore: {
      deviationCount: evidence.deviations.length,
      softPreferenceScore: scoreSoftPreferences(evidence, intent.softPreferences),
      distanceMeters: evidence.distanceMeters ?? null,
      priceRub: evidence.priceRub,
      freshnessTimestamp: Number.isFinite(freshnessTimestamp) ? freshnessTimestamp : null,
    },
    rejectionCodes,
  };
}

function rankCandidates(candidates: AssistantSearchEvidence[], softPreferences: AssistantSearchFilters) {
  return [...candidates].sort((left, right) => {
    const deviationDifference = left.deviations.length - right.deviations.length;
    if (deviationDifference !== 0) return deviationDifference;
    const softDifference = scoreSoftPreferences(right, softPreferences)
      - scoreSoftPreferences(left, softPreferences);
    if (softDifference !== 0) return softDifference;
    const leftDistance = left.distanceMeters ?? Number.POSITIVE_INFINITY;
    const rightDistance = right.distanceMeters ?? Number.POSITIVE_INFINITY;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    const priceDifference = left.priceRub - right.priceRub;
    if (priceDifference !== 0) return priceDifference;
    const freshnessDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (freshnessDifference !== 0) return freshnessDifference;
    return left.unitId.localeCompare(right.unitId, 'en-US');
  });
}

function scoreSoftPreferences(candidate: AssistantSearchEvidence, filters: AssistantSearchFilters) {
  let score = 0;
  if (filters.budgetMinRub !== null && candidate.priceRub >= filters.budgetMinRub) score += 1;
  if (filters.budgetMaxRub !== null && candidate.priceRub <= filters.budgetMaxRub) score += 1;
  if (filters.rooms.length > 0 && candidate.rooms !== null && filters.rooms.includes(candidate.rooms)) score += 1;
  if (filters.district && containsNormalized(candidate.district, filters.district)) score += 1;
  if (filters.metro && candidate.metros.some((metro) => containsNormalized(metro, filters.metro!))) score += 1;
  if (filters.developer && containsNormalized(candidate.developer, filters.developer)) score += 1;
  if (filters.completionYearMin !== null && candidate.completionYear !== null
    && candidate.completionYear >= filters.completionYearMin) score += 1;
  if (filters.completionYearMax !== null && candidate.completionYear !== null
    && candidate.completionYear <= filters.completionYearMax) score += 1;
  if (filters.completionQuarter !== null && candidate.completionQuarter === filters.completionQuarter) score += 1;
  if (candidate.objectType === filters.objectType) score += 1;
  if (filters.propertyClass && containsNormalized(candidate.propertyClass, filters.propertyClass)) score += 1;
  if (filters.areaMin !== null && candidate.area !== null && candidate.area >= filters.areaMin) score += 1;
  if (filters.areaMax !== null && candidate.area !== null && candidate.area <= filters.areaMax) score += 1;
  if (filters.floorMin !== null && candidate.floor !== null && candidate.floor >= filters.floorMin) score += 1;
  if (filters.floorMax !== null && candidate.floor !== null && candidate.floor <= filters.floorMax) score += 1;
  return score;
}

export function matchesAssistantSearchFilters(
  candidate: AssistantSearchEvidence,
  filters: AssistantSearchFilters,
) {
  return candidate.objectType === filters.objectType
    && (filters.budgetMinRub === null || candidate.priceRub >= filters.budgetMinRub)
    && (filters.budgetMaxRub === null || candidate.priceRub <= filters.budgetMaxRub)
    && (filters.rooms.length === 0 || (candidate.rooms !== null && filters.rooms.includes(candidate.rooms)))
    && (!filters.district || containsNormalized(candidate.district, filters.district))
    && (!filters.metro || candidate.metros.some((metro) => containsNormalized(metro, filters.metro!)))
    && (!filters.developer || containsNormalized(candidate.developer, filters.developer))
    && (filters.completionYearMin === null
      || (candidate.completionYear !== null && candidate.completionYear >= filters.completionYearMin))
    && (filters.completionYearMax === null
      || (candidate.completionYear !== null && candidate.completionYear <= filters.completionYearMax))
    && (filters.completionQuarter === null || candidate.completionQuarter === filters.completionQuarter)
    && (!filters.propertyClass || containsNormalized(candidate.propertyClass, filters.propertyClass))
    && (filters.areaMin === null || (candidate.area !== null && candidate.area >= filters.areaMin))
    && (filters.areaMax === null || (candidate.area !== null && candidate.area <= filters.areaMax))
    && (filters.floorMin === null || (candidate.floor !== null && candidate.floor >= filters.floorMin))
    && (filters.floorMax === null || (candidate.floor !== null && candidate.floor <= filters.floorMax));
}

function createResultCard(candidate: AssistantSearchEvidence, now: Date): AssistantSearchResultCard {
  const freshness = createFreshness(candidate.updatedAt, now);
  return {
    unitId: candidate.unitId,
    title: candidate.objectTitle,
    subtitle: candidate.lotTitle?.trim() || createLotSubtitle(candidate),
    priceRub: candidate.priceRub,
    availabilityLabel: 'В продаже',
    freshnessLabel: freshness.label,
    isStale: freshness.isStale,
    href: `/objects/${encodeURIComponent(candidate.objectSlug)}/lots/${candidate.unitId}`,
    facts: createFacts(candidate),
    pdfs: deduplicatePdfs(candidate.pdfs).map((pdf) => ({
      title: pdf.title,
      href: `/media/files/${pdf.fileId}/content?download=true`,
    })),
    deviations: candidate.deviations.map((deviation) => ({ ...deviation })),
    ...(typeof candidate.distanceMeters === 'number'
      ? { distanceMeters: candidate.distanceMeters }
      : {}),
  };
}

function createLotSubtitle(candidate: AssistantSearchEvidence) {
  const parts = [
    candidate.rooms === 0 ? 'Студия' : candidate.rooms === null ? null : `${candidate.rooms}-комнатная`,
    candidate.area === null ? null : `${formatNumber(candidate.area)} м²`,
    candidate.floor === null ? null : `${candidate.floor} этаж`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ') || 'Лот';
}

function createFacts(candidate: AssistantSearchEvidence) {
  const completion = candidate.completionYear === null
    ? null
    : candidate.completionQuarter === null
      ? `${candidate.completionYear} год`
      : `${candidate.completionQuarter} кв. ${candidate.completionYear}`;
  return [
    candidate.walkingMetro
      ? `${Math.ceil(candidate.walkingMetro.durationSeconds / 60)} мин пешком до метро «${candidate.walkingMetro.stationName}»`
      : null,
    candidate.district,
    candidate.metros.length > 0 ? `м. ${candidate.metros.join(', ')}` : null,
    candidate.developer,
    completion,
  ].filter((fact): fact is string => Boolean(fact));
}

function createFreshness(updatedAtValue: string, now: Date) {
  const updatedAt = new Date(updatedAtValue);
  const differenceMs = Math.max(0, now.getTime() - updatedAt.getTime());
  const hours = Math.floor(differenceMs / 3_600_000);
  if (hours < 1) return { label: 'обновлено менее часа назад', isStale: false };
  if (hours < 24) {
    return { label: `обновлено ${hours} ${pluralize(hours, 'час', 'часа', 'часов')} назад`, isStale: false };
  }
  const days = Math.floor(hours / 24);
  return {
    label: `данные могут быть устаревшими · обновлено ${days} ${pluralize(days, 'день', 'дня', 'дней')} назад`,
    isStale: true,
  };
}

function pluralize(value: number, one: string, few: string, many: string) {
  const modulo100 = value % 100;
  const modulo10 = value % 10;
  if (modulo100 >= 11 && modulo100 <= 14) return many;
  if (modulo10 === 1) return one;
  if (modulo10 >= 2 && modulo10 <= 4) return few;
  return many;
}

function deduplicatePdfs(pdfs: AssistantCandidatePdf[]) {
  const seen = new Set<string>();
  return pdfs.filter((pdf) => {
    if (!uuidPattern.test(pdf.fileId) || !pdf.title.trim() || seen.has(pdf.fileId)) return false;
    seen.add(pdf.fileId);
    return true;
  }).slice(0, 4);
}

export function isValidAssistantSearchEvidence(candidate: AssistantSearchEvidence) {
  return uuidPattern.test(candidate.unitId)
    && uuidPattern.test(candidate.objectId)
    && candidate.objectTitle.trim().length > 0
    && candidate.objectSlug.trim().length > 0
    && Number.isFinite(candidate.priceRub)
    && candidate.priceRub > 0
    && candidate.availability === 'AVAILABLE'
    && Number.isFinite(Date.parse(candidate.updatedAt))
    && (candidate.distanceMeters === undefined
      || candidate.distanceMeters === null
      || (Number.isFinite(candidate.distanceMeters) && candidate.distanceMeters >= 0))
    && candidate.deviations.length === 0;
}

export function isValidAssistantAlternativeEvidence(candidate: AssistantSearchEvidence) {
  return isValidAssistantSearchEvidence({ ...candidate, deviations: [] })
    && candidate.deviations.length === 1
    && candidate.deviations.every((deviation) =>
      allowedDeviationTypes.includes(deviation.type) && deviation.label.trim().length > 0,
    );
}

function hasRequiredFacts(
  candidate: AssistantSearchEvidence,
  requiredFacts: AssistantStructuredIntent['requiredFacts'],
) {
  return requiredFacts.every((fact) => {
    if (fact === 'PRICE') return Number.isFinite(candidate.priceRub) && candidate.priceRub > 0;
    if (fact === 'AVAILABILITY') return candidate.availability === 'AVAILABLE';
    if (fact === 'FRESHNESS') return Number.isFinite(Date.parse(candidate.updatedAt));
    if (fact === 'LINK') return uuidPattern.test(candidate.unitId) && candidate.objectSlug.trim().length > 0;
    if (fact === 'ROOMS') return candidate.rooms !== null;
    if (fact === 'LOCATION') return Boolean(candidate.district?.trim())
      || candidate.metros.some((metro) => metro.trim().length > 0);
    if (fact === 'DEVELOPER') return Boolean(candidate.developer?.trim());
    if (fact === 'COMPLETION') return candidate.completionYear !== null;
    if (fact === 'AREA') return candidate.area !== null;
    if (fact === 'FLOOR') return candidate.floor !== null;
    return candidate.pdfs.some((pdf) => uuidPattern.test(pdf.fileId));
  });
}

function containsNormalized(value: string | null, expected: string) {
  if (!value) return false;
  return normalize(value).includes(normalize(expected));
}

function normalize(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}
