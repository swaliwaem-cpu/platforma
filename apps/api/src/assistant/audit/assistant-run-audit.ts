import type { AssistantAnswer } from '@platforma/shared' with { 'resolution-mode': 'import' };

import type {
  AssistantPlannerTelemetry,
  AssistantSearchFilters,
  AssistantStructuredIntent,
} from '../assistant-query-planner';
import {
  createAssistantSearchRankingTrace,
  type AssistantSearchEvidence,
} from '../assistant-search-ranking';
import type { AssistantKnowledgeEvidence } from '../sources/assistant-knowledge-retrieval.service';
import { isSafeOfficialHttpsUrl } from '../sources/assistant-knowledge-policy';

export const assistantQualityFlags = [
  'HARD_FILTER_VIOLATION',
  'UNSUPPORTED_FACT',
  'STALE_PRICE_UNLABELED',
  'BROKEN_LINK',
  'MODEL_FALLBACK',
  'PROVIDER_ERROR',
  'LATENCY_BREACH',
] as const;

export type AssistantQualityFlag = (typeof assistantQualityFlags)[number];
export type AssistantRunEvidence = AssistantSearchEvidence | AssistantKnowledgeEvidence;

export type AssistantRunAudit = {
  schemaVersion: 1;
  appliedFilters: AssistantSearchFilters;
  softPreferences: AssistantSearchFilters;
  candidateSet: Array<Record<string, unknown> & { evidenceId: string }>;
  rankingDecisions: Array<{
    evidenceId: string;
    outcome: 'PRIMARY' | 'ALTERNATIVE' | 'SELECTED_FACT' | 'REJECTED';
    candidateRank: number | null;
    answerRank: number | null;
    reason: string;
  }>;
  evidenceRevisions: Array<{
    kind: 'PLATFORMA_FEED_UNIT' | 'KNOWLEDGE_SOURCE';
    evidenceId: string;
    revisionId: string;
    observedAt: string;
  }>;
  qualityFlags: AssistantQualityFlag[];
};

export function buildAssistantRunAudit(input: {
  intent: AssistantStructuredIntent;
  answer: AssistantAnswer;
  candidateEvidence: AssistantRunEvidence[];
  selectedEvidence: AssistantRunEvidence[];
  telemetry: AssistantPlannerTelemetry[];
  latencyMs: number;
  now?: Date;
  latencyBreachMs?: number;
}): AssistantRunAudit {
  const now = input.now ?? new Date();
  const latencyBreachMs = input.latencyBreachMs ?? readLatencyBreachMs(process.env.ASSISTANT_LATENCY_BREACH_MS);
  const selected = selectedOutcomes(input.answer);
  const rankingTrace = createRankingTrace(input.intent, input.candidateEvidence);
  const candidateSet = rankingTrace.map(({ evidence, candidateRank, rankingPool, rankingScore }) => ({
    ...serializeCandidate(evidence),
    candidateRank,
    rankingPool,
    rankingScore,
  }));
  const selectedEvidenceIds = new Set(input.selectedEvidence.map(evidenceId));
  const qualityFlags = new Set<AssistantQualityFlag>();

  for (const evidence of input.selectedEvidence) {
    if (isSearchEvidence(evidence) && !matchesFilters(evidence, input.intent.hardFilters)
      && evidence.deviations.length === 0) {
      qualityFlags.add('HARD_FILTER_VIOLATION');
    }
  }
  if ([...selected.keys()].some((id) => !selectedEvidenceIds.has(id))) {
    qualityFlags.add('UNSUPPORTED_FACT');
  }
  if (hasStalePriceWithoutLabel(input.answer, input.selectedEvidence, now)) {
    qualityFlags.add('STALE_PRICE_UNLABELED');
  }
  if (hasBrokenLink(input.answer)) qualityFlags.add('BROKEN_LINK');
  if (input.telemetry.some(({ isFallback }) => isFallback)) qualityFlags.add('MODEL_FALLBACK');
  if (input.telemetry.some(({ outcome }) => outcome === 'PROVIDER_ERROR')) qualityFlags.add('PROVIDER_ERROR');
  if (input.latencyMs > latencyBreachMs) qualityFlags.add('LATENCY_BREACH');

  return {
    schemaVersion: 1,
    appliedFilters: structuredClone(input.intent.hardFilters),
    softPreferences: structuredClone(input.intent.softPreferences),
    candidateSet,
    rankingDecisions: rankingTrace.map(({ evidence, candidateRank, rejectionCodes }) => {
      const evidenceIdValue = evidenceId(evidence);
      const decision = selected.get(evidenceIdValue);
      return decision ? {
        ...decision,
        candidateRank,
      } : {
        evidenceId: evidenceIdValue,
        outcome: 'REJECTED' as const,
        candidateRank,
        answerRank: null,
        reason: rejectionCodes.length > 0
          ? `Rejected before ranking: ${rejectionCodes.join(', ')}`
          : describeRejection(evidence, input.intent.hardFilters),
      };
    }),
    evidenceRevisions: input.selectedEvidence.map((evidence) => isSearchEvidence(evidence)
      ? {
          kind: 'PLATFORMA_FEED_UNIT' as const,
          evidenceId: evidence.unitId,
          revisionId: evidence.unitId,
          observedAt: evidence.updatedAt,
        }
      : {
          kind: 'KNOWLEDGE_SOURCE' as const,
          evidenceId: evidence.factId,
          revisionId: evidence.sourceRevisionId,
          observedAt: evidence.fetchedAt,
        }),
    qualityFlags: assistantQualityFlags.filter((flag) => qualityFlags.has(flag)),
  };
}

function createRankingTrace(intent: AssistantStructuredIntent, evidence: AssistantRunEvidence[]) {
  if (evidence.every(isSearchEvidence)) {
    return createAssistantSearchRankingTrace(intent, evidence);
  }
  return evidence.map((item, index) => ({
    evidence: item,
    candidateRank: index + 1,
    rankingPool: 'KNOWLEDGE' as const,
    rankingScore: isSearchEvidence(item) ? null : {
      retrievalScore: item.retrievalScore,
      sourcePriority: item.sourcePriority,
    },
    rejectionCodes: [] as string[],
  }));
}

function selectedOutcomes(answer: AssistantAnswer) {
  const outcomes = new Map<string, Omit<AssistantRunAudit['rankingDecisions'][number], 'candidateRank'>>();
  if (answer.kind === 'SEARCH_RESULTS') {
    answer.exactResults.forEach(({ unitId }, index) => outcomes.set(unitId, {
      evidenceId: unitId,
      outcome: 'PRIMARY',
      answerRank: index + 1,
      reason: 'Passed hard filters, evidence validation and deterministic ranking',
    }));
    answer.alternatives.forEach(({ unitId, deviations }, index) => outcomes.set(unitId, {
      evidenceId: unitId,
      outcome: 'ALTERNATIVE',
      answerRank: index + 1,
      reason: deviations.map(({ label }) => label).join('; ') || 'Selected bounded alternative',
    }));
  } else if (answer.kind === 'KNOWLEDGE_RESULTS') {
    [...answer.facts, ...answer.externalLots].forEach(({ id }, index) => outcomes.set(id, {
      evidenceId: id,
      outcome: 'SELECTED_FACT',
      answerRank: index + 1,
      reason: 'Selected from grounded retrieval evidence',
    }));
  }
  return outcomes;
}

function serializeCandidate(evidence: AssistantRunEvidence): Record<string, unknown> & { evidenceId: string } {
  if (isSearchEvidence(evidence)) {
    return {
      evidenceId: evidence.unitId,
      kind: 'PLATFORMA_FEED_UNIT',
      unitExternalId: evidence.unitExternalId ?? null,
      objectId: evidence.objectId,
      objectType: evidence.objectType,
      objectTitle: evidence.objectTitle,
      objectSlug: evidence.objectSlug,
      lotTitle: evidence.lotTitle,
      priceRub: evidence.priceRub,
      availability: evidence.availability,
      rooms: evidence.rooms,
      district: evidence.district,
      metros: [...evidence.metros],
      developer: evidence.developer,
      completionYear: evidence.completionYear,
      completionQuarter: evidence.completionQuarter,
      propertyClass: evidence.propertyClass,
      area: evidence.area,
      floor: evidence.floor,
      updatedAt: evidence.updatedAt,
      distanceMeters: evidence.distanceMeters ?? null,
      pdfs: structuredClone(evidence.pdfs),
      deviations: structuredClone(evidence.deviations),
    };
  }
  return {
    evidenceId: evidence.factId,
    kind: 'KNOWLEDGE_SOURCE',
    sourceId: evidence.sourceId,
    sourceRevisionId: evidence.sourceRevisionId,
    sourceType: evidence.sourceType,
    sourcePriority: evidence.sourcePriority,
    factKind: evidence.kind,
    label: evidence.label,
    value: structuredClone(evidence.value),
    canonicalUrl: evidence.canonicalUrl,
    projectKey: evidence.projectKey,
    developerKey: evidence.developerKey,
    observedAt: evidence.observedAt,
    fetchedAt: evidence.fetchedAt,
    retrievalChannels: [...evidence.retrievalChannels],
    retrievalScore: evidence.retrievalScore,
  };
}

function evidenceId(evidence: AssistantRunEvidence) {
  return isSearchEvidence(evidence) ? evidence.unitId : evidence.factId;
}

function isSearchEvidence(evidence: AssistantRunEvidence): evidence is AssistantSearchEvidence {
  return 'unitId' in evidence;
}

function matchesFilters(candidate: AssistantSearchEvidence, filters: AssistantSearchFilters) {
  return readFilterViolations(candidate, filters).length === 0;
}

function readFilterViolations(candidate: AssistantSearchEvidence, filters: AssistantSearchFilters) {
  const contains = (value: string | null, expected: string) => Boolean(value)
    && normalize(value!).includes(normalize(expected));
  const violations: string[] = [];
  if (candidate.objectType !== filters.objectType) violations.push('OBJECT_TYPE');
  if (filters.budgetMinRub !== null && candidate.priceRub < filters.budgetMinRub) violations.push('BUDGET_MIN');
  if (filters.budgetMaxRub !== null && candidate.priceRub > filters.budgetMaxRub) violations.push('BUDGET_MAX');
  if (filters.rooms.length > 0 && (candidate.rooms === null || !filters.rooms.includes(candidate.rooms))) {
    violations.push('ROOMS');
  }
  if (filters.district && !contains(candidate.district, filters.district)) violations.push('DISTRICT');
  if (filters.metro && !candidate.metros.some((metro) => contains(metro, filters.metro!))) violations.push('METRO');
  if (filters.developer && !contains(candidate.developer, filters.developer)) violations.push('DEVELOPER');
  if (filters.completionYearMin !== null
    && (candidate.completionYear === null || candidate.completionYear < filters.completionYearMin)) {
    violations.push('COMPLETION_YEAR_MIN');
  }
  if (filters.completionYearMax !== null
    && (candidate.completionYear === null || candidate.completionYear > filters.completionYearMax)) {
    violations.push('COMPLETION_YEAR_MAX');
  }
  if (filters.completionQuarter !== null && candidate.completionQuarter !== filters.completionQuarter) {
    violations.push('COMPLETION_QUARTER');
  }
  if (filters.propertyClass && !contains(candidate.propertyClass, filters.propertyClass)) {
    violations.push('PROPERTY_CLASS');
  }
  if (filters.areaMin !== null && (candidate.area === null || candidate.area < filters.areaMin)) violations.push('AREA_MIN');
  if (filters.areaMax !== null && (candidate.area === null || candidate.area > filters.areaMax)) violations.push('AREA_MAX');
  if (filters.floorMin !== null && (candidate.floor === null || candidate.floor < filters.floorMin)) violations.push('FLOOR_MIN');
  if (filters.floorMax !== null && (candidate.floor === null || candidate.floor > filters.floorMax)) violations.push('FLOOR_MAX');
  return violations;
}

function describeRejection(evidence: AssistantRunEvidence, filters: AssistantSearchFilters) {
  if (!isSearchEvidence(evidence)) {
    return `Ranked outside bounded grounded answer (retrievalScore=${evidence.retrievalScore}, sourcePriority=${evidence.sourcePriority})`;
  }
  if (evidence.deviations.length > 0) {
    return `Alternative not selected: ${evidence.deviations.map(({ label }) => label).join('; ')}`;
  }
  const violations = readFilterViolations(evidence, filters);
  if (violations.length > 0) return `Rejected by hard filters: ${violations.join(', ')}`;
  return 'Ranked outside bounded top results after deterministic evidence validation';
}

function hasStalePriceWithoutLabel(
  answer: AssistantAnswer,
  evidence: AssistantRunEvidence[],
  now: Date,
) {
  if (answer.kind !== 'SEARCH_RESULTS') return false;
  const updatedById = new Map(evidence.flatMap((item) => isSearchEvidence(item)
    ? [[item.unitId, Date.parse(item.updatedAt)] as const]
    : []));
  return [...answer.exactResults, ...answer.alternatives].some((result) => {
    const updatedAt = updatedById.get(result.unitId);
    const staleByEvidence = updatedAt !== undefined && now.getTime() - updatedAt >= 24 * 60 * 60 * 1_000;
    return (result.isStale || staleByEvidence)
      && !/устарев|обновлено/iu.test(result.freshnessLabel);
  });
}

function hasBrokenLink(answer: AssistantAnswer) {
  if (answer.kind === 'SEARCH_RESULTS') {
    return [...answer.exactResults, ...answer.alternatives].some((result) =>
      !/^\/objects\/[^/]+\/lots\/[0-9a-f-]+$/iu.test(result.href)
      || result.pdfs.some(({ href }) => !/^\/media\/files\/[0-9a-f-]+\/content\?download=true$/iu.test(href)));
  }
  if (answer.kind === 'KNOWLEDGE_RESULTS') {
    return answer.externalLots.some(({ href }) => !isSafeOfficialHttpsUrl(href));
  }
  return false;
}

function normalize(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function readLatencyBreachMs(value: string | undefined) {
  if (value === undefined || value.trim() === '') return 15_000;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 120_000 ? parsed : 15_000;
}
