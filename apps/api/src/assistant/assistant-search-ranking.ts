import type {
  AssistantAlternativeDeviation,
  AssistantSearchResultCard,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  AssistantPlannerFallbackValidationError,
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
  latitude: number | null;
  longitude: number | null;
  pdfs: AssistantCandidatePdf[];
  deviations: AssistantAlternativeDeviation[];
};

export type AssistantSearchAnswer = {
  kind: 'SEARCH_RESULTS';
  content: string;
  exactResults: AssistantSearchResultCard[];
  alternatives: AssistantSearchResultCard[];
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
): AssistantSearchAnswer {
  const exactResults = rankCandidates(
    exactEvidence.filter((candidate) =>
      isValidEvidence(candidate)
      && hasRequiredFacts(candidate, intent.requiredFacts)
      && matchesFilters(candidate, intent.hardFilters)),
    intent.softPreferences,
  )
    .slice(0, 3)
    .map((candidate) => createResultCard(candidate, now));
  const alternatives = exactResults.length === 0
    ? rankCandidates(
        alternativeEvidence.filter((candidate) =>
          isValidAlternativeEvidence(candidate) && hasRequiredFacts(candidate, intent.requiredFacts)),
        intent.softPreferences,
      )
        .slice(0, 2)
        .map((candidate) => createResultCard(candidate, now))
    : [];

  return {
    kind: 'SEARCH_RESULTS',
    content: exactResults.length > 0
      ? 'Нашёл точные предложения по указанным критериям.'
      : alternatives.length > 0
        ? 'Точных совпадений нет. Показываю ближайшие альтернативы с явными отклонениями.'
        : 'Не могу подтвердить подходящие предложения по текущим данным Platforma.',
    exactResults,
    alternatives,
  };
}

export function validateAssistantSearchAnswer(
  answer: AssistantSearchAnswer,
  evidence: AssistantSearchEvidence[],
  intent: AssistantStructuredIntent,
  now = new Date(),
) {
  const exactEvidence = evidence.filter((candidate) => candidate.deviations.length === 0);
  const alternativeEvidence = evidence.filter((candidate) => candidate.deviations.length > 0);
  const expected = buildAssistantSearchAnswer(intent, exactEvidence, alternativeEvidence, now);
  if (JSON.stringify(answer) !== JSON.stringify(expected)) {
    throw new AssistantAnswerValidationError();
  }
}

function rankCandidates(candidates: AssistantSearchEvidence[], softPreferences: AssistantSearchFilters) {
  return [...candidates].sort((left, right) => {
    const deviationDifference = left.deviations.length - right.deviations.length;
    if (deviationDifference !== 0) return deviationDifference;
    const softDifference = scoreSoftPreferences(right, softPreferences)
      - scoreSoftPreferences(left, softPreferences);
    if (softDifference !== 0) return softDifference;
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

function matchesFilters(candidate: AssistantSearchEvidence, filters: AssistantSearchFilters) {
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

function isValidEvidence(candidate: AssistantSearchEvidence) {
  return uuidPattern.test(candidate.unitId)
    && uuidPattern.test(candidate.objectId)
    && candidate.objectTitle.trim().length > 0
    && candidate.objectSlug.trim().length > 0
    && Number.isFinite(candidate.priceRub)
    && candidate.priceRub > 0
    && candidate.availability === 'AVAILABLE'
    && Number.isFinite(Date.parse(candidate.updatedAt))
    && candidate.deviations.length === 0;
}

function isValidAlternativeEvidence(candidate: AssistantSearchEvidence) {
  return isValidEvidence({ ...candidate, deviations: [] })
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
    if (fact === 'LOCATION') return Boolean(candidate.district) || candidate.metros.length > 0;
    if (fact === 'DEVELOPER') return Boolean(candidate.developer);
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
