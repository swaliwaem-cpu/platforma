import { createHash } from 'node:crypto';
import {
  AssistantKnowledgeSourceType,
  AssistantSourceFactKind,
} from '@prisma/client';

import {
  assistantKnowledgeAuthorityScore,
  assistantKnowledgeSemanticConflictKey,
  normalizeAssistantKnowledgeRegistryKey,
} from '../sources/assistant-knowledge-policy';
import {
  createAssistantComparisonTargetVariants,
  parseAssistantStructuredIntent,
  type AssistantStructuredIntent,
} from '../assistant-query-planner';
import { parseAssistantComparisonSummary } from '../assistant-comparison-answer';
import {
  isValidAssistantAlternativeEvidence,
  isValidAssistantSearchEvidence,
  matchesAssistantSearchFilters,
  type AssistantSearchEvidence,
} from '../assistant-search-ranking';
import { assistantBudgetRelaxationRub } from '../assistant-search.service';
import {
  parseAssistantGeoStoredContext,
  parseAssistantReferenceGeometry,
} from '../geo/assistant-geo-contract';

export const assistantEvalCategories = [
  'FACTUAL',
  'STRUCTURED_SEARCH',
  'COMPARISON',
  'MORTGAGE_INSTALLMENT',
  'NO_DATA',
  'SOURCE_CONFLICT',
  'STALE_PRICE',
  'EXTERNAL_LOT',
  'GEOSEARCH',
  'CLARIFICATION',
  'ALTERNATIVES',
] as const;

export const assistantEvalEvaluatorVersion = 'assistant-evaluator-v1';

export const assistantEvalZeroToleranceViolations = [
  'AUTH_VIOLATION',
  'HARD_FILTER_VIOLATION',
  'SOURCE_PRIORITY_VIOLATION',
  'INVENTED_PRICE_OR_AVAILABILITY',
  'UNSUPPORTED_LINK',
  'EVIDENCE_LEAKAGE',
] as const;

type AssistantEvalCategory = (typeof assistantEvalCategories)[number];
type AssistantEvalViolation = (typeof assistantEvalZeroToleranceViolations)[number];
type AssistantAnswerKind = 'SEARCH_RESULTS' | 'COMPARISON_RESULTS' | 'KNOWLEDGE_RESULTS' | 'CLARIFICATION' | 'REFUSAL' | 'SAFE_BOUNDARY';

type AssistantEvalExpectation = {
  answerKinds: AssistantAnswerKind[];
  requiredEvidence?: boolean;
  sourcePriority?: 'OFFICIAL_PROJECT' | 'OFFICIAL_DEVELOPER_OR_BANK';
  hardFiltersRequired?: boolean;
  maximumPrimaryResults?: number;
  maximumAlternativeResults?: number;
  inventedFactsForbidden?: boolean;
  deterministicSourcePriorityRequired?: boolean;
  staleLabelRequired?: boolean;
  externalHttpsLinkRequired?: boolean;
  freshnessRequired?: boolean;
  radiusHardFilterRequired?: boolean;
  distanceRequired?: boolean;
  maximumPrimaryMarkers?: number;
  maximumAlternativeMarkers?: number;
  clarificationRequired?: boolean;
  explicitDeviationRequired?: boolean;
  noResultsRequired?: boolean;
  expectedUnitExternalId?: string;
  expectedKnowledge?: {
    projectKey: string;
    factKinds: AssistantSourceFactKind[];
    requiredTextFragments: string[];
  };
  expectedIntent?: AssistantStructuredIntent;
  expectedGeo?: {
    radiusMeters: number;
    anchorLabel: string;
    latitude: number;
    longitude: number;
    maximumAnchorErrorMeters: number;
  };
};

type AssistantEvalThresholds = {
  minimumOverallPassRate: number;
  minimumCategoryPassRate: number;
  minimumAverageQualityScore: number;
  maximumP95LatencyMs: number;
  maximumAverageModelAttempts: number;
  maximumAverageTotalTokens: number;
  maximumAverageGeoProviderCalls: number;
};

type AssistantEvalCase = {
  id: string;
  category: AssistantEvalCategory;
  query: string;
  expected: AssistantEvalExpectation;
};

export type AssistantEvalDataset = {
  version: string;
  frozenAt: string;
  thresholds: AssistantEvalThresholds;
  zeroTolerance: AssistantEvalViolation[];
  cases: AssistantEvalCase[];
};

export type AssistantEvalResult = {
  id: string;
  passed: boolean;
  qualityScore: number;
  latencyMs: number;
  modelAttempts: number;
  totalTokens: number;
  geoProviderCalls: number;
  violations: AssistantEvalViolation[];
};

export type AssistantEvalGate = {
  code: string;
  passed: boolean;
  actual: number;
  threshold: number;
};

export type AssistantEvalSummary = {
  datasetVersion: string;
  passed: boolean;
  caseCount: number;
  overallPassRate: number;
  averageQualityScore: number;
  p95LatencyMs: number;
  averageModelAttempts: number;
  averageTotalTokens: number;
  averageGeoProviderCalls: number;
  categoryPassRates: Record<AssistantEvalCategory, number>;
  gates: AssistantEvalGate[];
};

export type AssistantEvalRunRecord = {
  id: string;
  ownerUserId: string;
  conversationOwnerUserId: string;
  ownerPermissions: string[];
  status: string;
  createdAt: string;
  completedAt: string | null;
  query: string;
  context: unknown;
  geoContext: unknown;
  answer: unknown;
  evidence: unknown;
  intent: unknown;
  audit: unknown;
  qualityFlags: string[];
  latencyMs: number | null;
  telemetry: unknown;
  geoProviderCalls: number;
};

export type AssistantEvalProvenance = {
  id: string;
  runId: string;
  answerDigest: string;
  evidenceDigest: string;
};

type AssistantEvalObservation = {
  answerKind: AssistantAnswerKind;
  authorizationPreserved: boolean;
  hardFiltersSatisfied: boolean;
  sourcePriority: 'OFFICIAL_PROJECT' | 'OFFICIAL_DEVELOPER_OR_BANK' | 'DETERMINISTIC' | null;
  priceAvailabilityGrounded: boolean;
  evidencePresent: boolean;
  evidenceLeaked: boolean;
  links: Array<{ url: string; supported: boolean }>;
  staleLabelPresent: boolean;
  freshnessPresent: boolean;
  clarificationPresented: boolean;
  distancePresented: boolean;
  explicitDeviationPresented: boolean;
  selectedAnswerCount: number;
  primaryResultCount: number;
  alternativeResultCount: number;
  primaryMarkerCount: number;
  alternativeMarkerCount: number;
  latencyMs: number;
  modelAttempts: number;
  totalTokens: number;
  geoProviderCalls: number;
};

const expectedCaseCount = 200;
const expectedDatasetVersion = 'assistant-eval-v1';
const expectedDatasetSha256 = 'dc1c1ca5b52df1a440553b9879e8b10ecebe5c286a10c86d667957132cfcf8aa';
const maximumArtifactAgeMs = 24 * 60 * 60 * 1_000;
const caseIdPattern = /^[A-Z_]+-\d{3}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const answerKinds = new Set<AssistantAnswerKind>([
  'SEARCH_RESULTS',
  'COMPARISON_RESULTS',
  'KNOWLEDGE_RESULTS',
  'CLARIFICATION',
  'REFUSAL',
  'SAFE_BOUNDARY',
]);
const completedRunTelemetryOutcomes = new Set([
  'ACCEPTED',
  'LOCAL_VALIDATION_FAILED',
  'PROVIDER_ERROR',
]);

export function loadAssistantEvalDataset(value: unknown): AssistantEvalDataset {
  if (computeAssistantEvalDatasetSha256(value) !== expectedDatasetSha256) {
    throw new Error('ASSISTANT_EVAL_DATASET_SHA256_INVALID');
  }
  if (!isRecord(value)) throw new Error('ASSISTANT_EVAL_DATASET_INVALID');
  if (value.version !== expectedDatasetVersion) {
    throw new Error('ASSISTANT_EVAL_DATASET_VERSION_INVALID');
  }
  if (typeof value.frozenAt !== 'string' || !isIsoTimestamp(value.frozenAt)) {
    throw new Error('ASSISTANT_EVAL_DATASET_FROZEN_AT_INVALID');
  }
  const thresholds = parseThresholds(value.thresholds);
  const zeroTolerance = parseZeroTolerance(value.zeroTolerance);
  if (!Array.isArray(value.cases) || value.cases.length !== expectedCaseCount) {
    throw new Error('ASSISTANT_EVAL_DATASET_CASE_COUNT_INVALID');
  }
  const cases = value.cases.map(parseCase);
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) {
    throw new Error('ASSISTANT_EVAL_DATASET_CASE_IDS_DUPLICATED');
  }
  const coveredCategories = new Set(cases.map(({ category }) => category));
  if (assistantEvalCategories.some((category) => !coveredCategories.has(category))) {
    throw new Error('ASSISTANT_EVAL_DATASET_CATEGORY_COVERAGE_INVALID');
  }

  return {
    version: value.version,
    frozenAt: value.frozenAt,
    thresholds,
    zeroTolerance,
    cases,
  };
}

export function computeAssistantEvalDatasetSha256(value: unknown) {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

export function readAssistantEvalArtifactRunIds(
  dataset: AssistantEvalDataset,
  value: unknown,
  now = new Date(),
): string[] {
  return parseAssistantEvalArtifact(dataset, value, now).references.map(({ runId }) => runId);
}

export function evaluateAssistantEvalArtifact(
  dataset: AssistantEvalDataset,
  value: unknown,
  runRecords: AssistantEvalRunRecord[],
  now = new Date(),
): { datasetVersion: string; results: AssistantEvalResult[]; provenance: AssistantEvalProvenance[] } {
  const artifact = parseAssistantEvalArtifact(dataset, value, now);
  const recordById = new Map(runRecords.map((record) => [record.id, record]));
  if (recordById.size !== runRecords.length
    || recordById.size !== artifact.references.length
    || artifact.references.some(({ runId }) => !recordById.has(runId))) {
    throw new Error('ASSISTANT_EVAL_RUNS_INCOMPLETE');
  }
  const evaluatedAt = artifact.evaluatedAt.getTime();
  const provenance: AssistantEvalProvenance[] = [];
  const results = artifact.references.map(({ caseId, runId }) => {
    const evalCase = dataset.cases.find(({ id }) => id === caseId) as AssistantEvalCase;
    const record = recordById.get(runId) as AssistantEvalRunRecord;
    validateAssistantEvalRunRecord(evalCase, record, evaluatedAt);
    const observation = observeAssistantEvalRun(record, evalCase.expected);
    provenance.push({
      id: caseId,
      runId,
      answerDigest: digest(record.answer),
      evidenceDigest: digest(record.evidence),
    });
    return evaluateObservation(evalCase, observation);
  });
  return {
    datasetVersion: dataset.version,
    results,
    provenance,
  };
}

export function scoreAssistantEval(
  dataset: AssistantEvalDataset,
  report: { datasetVersion: string; results: AssistantEvalResult[] },
): AssistantEvalSummary {
  if (report.datasetVersion !== dataset.version) {
    throw new Error('ASSISTANT_EVAL_DATASET_VERSION_MISMATCH');
  }
  if (!Array.isArray(report.results)) throw new Error('ASSISTANT_EVAL_RESULTS_INVALID');
  const resultById = new Map<string, AssistantEvalResult>();
  for (const rawResult of report.results) {
    const result = parseResult(rawResult);
    if (resultById.has(result.id)) throw new Error('ASSISTANT_EVAL_RESULT_IDS_DUPLICATED');
    resultById.set(result.id, result);
  }
  const caseIds = new Set(dataset.cases.map(({ id }) => id));
  if (resultById.size !== dataset.cases.length
    || dataset.cases.some(({ id }) => !resultById.has(id))
    || [...resultById.keys()].some((id) => !caseIds.has(id))) {
    throw new Error('ASSISTANT_EVAL_RESULTS_INCOMPLETE');
  }

  const results = dataset.cases.map(({ id }) => resultById.get(id) as AssistantEvalResult);
  const overallPassRate = average(results.map(({ passed }) => passed ? 1 : 0));
  const averageQualityScore = average(results.map(({ qualityScore }) => qualityScore));
  const p95LatencyMs = percentile(results.map(({ latencyMs }) => latencyMs), 0.95);
  const averageModelAttempts = average(results.map(({ modelAttempts }) => modelAttempts));
  const averageTotalTokens = average(results.map(({ totalTokens }) => totalTokens));
  const averageGeoProviderCalls = average(results.map(({ geoProviderCalls }) => geoProviderCalls));
  const categoryPassRates = Object.fromEntries(assistantEvalCategories.map((category) => {
    const categoryResults = dataset.cases
      .map((item, index) => item.category === category ? results[index] : null)
      .filter((item): item is AssistantEvalResult => item !== null);
    return [category, average(categoryResults.map(({ passed }) => passed ? 1 : 0))];
  })) as Record<AssistantEvalCategory, number>;
  const gates: AssistantEvalGate[] = [
    minimumGate('OVERALL_PASS_RATE', overallPassRate, dataset.thresholds.minimumOverallPassRate),
    minimumGate('AVERAGE_QUALITY_SCORE', averageQualityScore, dataset.thresholds.minimumAverageQualityScore),
    maximumGate('P95_LATENCY', p95LatencyMs, dataset.thresholds.maximumP95LatencyMs),
    maximumGate('AVERAGE_MODEL_ATTEMPTS', averageModelAttempts, dataset.thresholds.maximumAverageModelAttempts),
    maximumGate('AVERAGE_TOTAL_TOKENS', averageTotalTokens, dataset.thresholds.maximumAverageTotalTokens),
    maximumGate(
      'AVERAGE_GEO_PROVIDER_CALLS',
      averageGeoProviderCalls,
      dataset.thresholds.maximumAverageGeoProviderCalls,
    ),
    ...assistantEvalCategories.map((category) => minimumGate(
      `CATEGORY_${category}_PASS_RATE`,
      categoryPassRates[category],
      dataset.thresholds.minimumCategoryPassRate,
    )),
    ...assistantEvalZeroToleranceViolations.map((violation) => maximumGate(
      `ZERO_TOLERANCE_${violation}`,
      results.filter((result) => result.violations.includes(violation)).length,
      0,
    )),
  ];

  return {
    datasetVersion: dataset.version,
    passed: gates.every((gate) => gate.passed),
    caseCount: results.length,
    overallPassRate,
    averageQualityScore,
    p95LatencyMs,
    averageModelAttempts,
    averageTotalTokens,
    averageGeoProviderCalls,
    categoryPassRates,
    gates,
  };
}

function evaluateObservation(
  evalCase: AssistantEvalCase,
  observation: AssistantEvalObservation,
): AssistantEvalResult {
  const expected = evalCase.expected;
  const sourcePriorityRequired = expected.sourcePriority !== undefined
    || expected.deterministicSourcePriorityRequired === true;
  const sourcePriorityPassed = expected.sourcePriority !== undefined
    ? observation.sourcePriority === expected.sourcePriority
    : !expected.deterministicSourcePriorityRequired || observation.sourcePriority === 'DETERMINISTIC';
  const hardFiltersRequired = expected.hardFiltersRequired === true
    || expected.radiusHardFilterRequired === true
    || expected.expectedIntent !== undefined
    || expected.expectedUnitExternalId !== undefined
    || expected.expectedKnowledge !== undefined;
  const linksSupported = observation.links.every(({ supported }) => supported);
  const checks = [
    expected.answerKinds.includes(observation.answerKind)
      || (observation.answerKind === 'COMPARISON_RESULTS'
        && expected.answerKinds.includes('SEARCH_RESULTS')
        && expected.expectedIntent?.taskType === 'COMPARE'),
    observation.authorizationPreserved,
    observation.priceAvailabilityGrounded,
    !observation.evidenceLeaked,
    linksSupported,
    !hardFiltersRequired || observation.hardFiltersSatisfied,
    !sourcePriorityRequired || sourcePriorityPassed,
    !expected.requiredEvidence || observation.evidencePresent,
    !expected.staleLabelRequired || observation.staleLabelPresent,
    !expected.freshnessRequired || observation.freshnessPresent,
    !expected.clarificationRequired || observation.clarificationPresented,
    !expected.distanceRequired || observation.distancePresented,
    !expected.explicitDeviationRequired || observation.explicitDeviationPresented,
    !expected.noResultsRequired || observation.selectedAnswerCount === 0,
    expected.maximumPrimaryResults === undefined
      || observation.primaryResultCount <= expected.maximumPrimaryResults,
    expected.maximumAlternativeResults === undefined
      || observation.alternativeResultCount <= expected.maximumAlternativeResults,
    expected.maximumPrimaryMarkers === undefined
      || observation.primaryMarkerCount <= expected.maximumPrimaryMarkers,
    expected.maximumAlternativeMarkers === undefined
      || observation.alternativeMarkerCount <= expected.maximumAlternativeMarkers,
    !expected.externalHttpsLinkRequired || observation.links.some(({ url, supported }) => (
      supported && url.startsWith('https://')
    )),
  ];
  const violations: AssistantEvalViolation[] = [];
  if (!observation.authorizationPreserved) violations.push('AUTH_VIOLATION');
  if (hardFiltersRequired && !observation.hardFiltersSatisfied) {
    violations.push('HARD_FILTER_VIOLATION');
  }
  if (sourcePriorityRequired && !sourcePriorityPassed) {
    violations.push('SOURCE_PRIORITY_VIOLATION');
  }
  if (!observation.priceAvailabilityGrounded) {
    violations.push('INVENTED_PRICE_OR_AVAILABILITY');
  }
  if (!linksSupported) violations.push('UNSUPPORTED_LINK');
  if (observation.evidenceLeaked) violations.push('EVIDENCE_LEAKAGE');

  return {
    id: evalCase.id,
    passed: checks.every(Boolean) && violations.length === 0,
    qualityScore: average(checks.map((passed) => passed ? 1 : 0)),
    latencyMs: observation.latencyMs,
    modelAttempts: observation.modelAttempts,
    totalTokens: observation.totalTokens,
    geoProviderCalls: observation.geoProviderCalls,
    violations,
  };
}

function parseAssistantEvalArtifact(
  dataset: AssistantEvalDataset,
  value: unknown,
  now: Date,
) {
  if (!isRecord(value)
    || value.datasetVersion !== dataset.version
    || value.datasetSha256 !== computeAssistantEvalDatasetSha256(dataset)
    || value.evaluatorVersion !== assistantEvalEvaluatorVersion
    || typeof value.evaluatedAt !== 'string'
    || !isIsoTimestamp(value.evaluatedAt)
    || !Array.isArray(value.runs)) {
    throw new Error('ASSISTANT_EVAL_ARTIFACT_INVALID');
  }
  const evaluatedAt = new Date(value.evaluatedAt);
  const ageMs = now.getTime() - evaluatedAt.getTime();
  if (ageMs < 0 || ageMs > maximumArtifactAgeMs) {
    throw new Error('ASSISTANT_EVAL_ARTIFACT_STALE');
  }
  const references = value.runs.map((reference) => {
    if (!isRecord(reference)
      || typeof reference.caseId !== 'string'
      || typeof reference.runId !== 'string'
      || !uuidPattern.test(reference.runId)) {
      throw new Error('ASSISTANT_EVAL_RUN_REFERENCE_INVALID');
    }
    return { caseId: reference.caseId, runId: reference.runId };
  });
  const caseIds = new Set(dataset.cases.map(({ id }) => id));
  if (references.length !== dataset.cases.length
    || new Set(references.map(({ caseId }) => caseId)).size !== references.length
    || new Set(references.map(({ runId }) => runId)).size !== references.length
    || references.some(({ caseId }) => !caseIds.has(caseId))) {
    throw new Error('ASSISTANT_EVAL_RUN_REFERENCES_INCOMPLETE');
  }
  return { evaluatedAt, references };
}

function validateAssistantEvalRunRecord(
  evalCase: AssistantEvalCase,
  record: AssistantEvalRunRecord,
  evaluatedAt: number,
) {
  const createdAt = Date.parse(record.createdAt);
  const completedAt = record.completedAt === null ? Number.NaN : Date.parse(record.completedAt);
  if (!uuidPattern.test(record.id)
    || !uuidPattern.test(record.ownerUserId)
    || record.ownerUserId !== record.conversationOwnerUserId
    || record.status !== 'COMPLETED'
    || record.query !== evalCase.query
    || !Number.isFinite(createdAt)
    || !Number.isFinite(completedAt)
    || completedAt < createdAt
    || completedAt > evaluatedAt
    || completedAt < evaluatedAt - maximumArtifactAgeMs
    || !Array.isArray(record.ownerPermissions)
    || record.ownerPermissions.some((permission) => typeof permission !== 'string')
    || !Array.isArray(record.qualityFlags)
    || record.qualityFlags.some((flag) => typeof flag !== 'string')
    || !Number.isInteger(record.geoProviderCalls)
    || record.geoProviderCalls < 0) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_RUN_INVALID');
  }
}

function observeAssistantEvalRun(
  record: AssistantEvalRunRecord,
  expected: AssistantEvalExpectation,
): AssistantEvalObservation {
  if (!isRecord(record.answer)
    || typeof record.answer.kind !== 'string'
    || !answerKinds.has(record.answer.kind as AssistantAnswerKind)
    || readString(record.answer.content) === null) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
  }
  const answerKind = record.answer.kind as AssistantAnswerKind;
  if (!Array.isArray(record.evidence) || record.evidence.some((item) => !isRecord(item))) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_EVIDENCE_INVALID');
  }
  const evidence = record.evidence as Record<string, unknown>[];
  if (!Array.isArray(record.telemetry) || record.telemetry.some((attempt) => !isRecord(attempt))) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_TELEMETRY_INVALID');
  }
  const telemetry = record.telemetry as Record<string, unknown>[];
  if (telemetry.length === 0 || telemetry.some((attempt) => (
    typeof attempt.outcome !== 'string'
    || !completedRunTelemetryOutcomes.has(attempt.outcome)
    || !isNonNegativeInteger(attempt.totalTokens)
  )) || telemetry.at(-1)?.outcome !== 'ACCEPTED') {
    throw new Error('ASSISTANT_EVAL_PERSISTED_TELEMETRY_INVALID');
  }
  const audit = isRecord(record.audit) ? record.audit : {};
  const qualityFlags = new Set(record.qualityFlags);
  const comparisonGroups = answerKind === 'COMPARISON_RESULTS'
    ? readPersistedComparisonGroups(record.answer.groups)
    : [];
  const exactResults = answerKind === 'SEARCH_RESULTS'
    ? readPersistedAnswerArray(record.answer.exactResults)
    : comparisonGroups.flatMap((group) => [
        ...readPersistedAnswerArray(group.exactResults),
        ...readPersistedAnswerArray(group.additionalExactResults),
      ]);
  const hasTotalExactResults = answerKind === 'SEARCH_RESULTS'
    && record.answer.totalExactResults !== undefined;
  const hasAdditionalExactResults = answerKind === 'SEARCH_RESULTS'
    && record.answer.additionalExactResults !== undefined;
  if (hasTotalExactResults !== hasAdditionalExactResults) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
  }
  const additionalExactResults = hasAdditionalExactResults
    ? readPersistedAnswerArray(record.answer.additionalExactResults)
    : [];
  const alternatives = answerKind === 'SEARCH_RESULTS'
    ? readPersistedAnswerArray(record.answer.alternatives)
    : [];
  if (hasTotalExactResults) {
    if (!isNonNegativeInteger(record.answer.totalExactResults)) {
      throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
    }
    const totalExactResults = record.answer.totalExactResults as number;
    const resultIds = [...exactResults, ...additionalExactResults, ...alternatives]
      .map((item) => readString(item.unitId));
    if (exactResults.length !== Math.min(totalExactResults, 3)
      || additionalExactResults.length !== Math.min(5, Math.max(totalExactResults - 3, 0))
      || ((exactResults.length > 0 || additionalExactResults.length > 0) && alternatives.length > 0)
      || (alternatives.length > 0 && totalExactResults !== 0)
      || resultIds.some((id) => id === null)
      || new Set(resultIds).size !== resultIds.length) {
      throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
    }
  }
  const allExactResults = [...exactResults, ...additionalExactResults];
  const resultCards = [...allExactResults, ...alternatives];
  const facts = answerKind === 'KNOWLEDGE_RESULTS'
    ? readPersistedAnswerArray(record.answer.facts)
    : [];
  const externalLots = answerKind === 'KNOWLEDGE_RESULTS'
    ? readPersistedAnswerArray(record.answer.externalLots)
    : [];
  const selectedIds = [...resultCards, ...facts, ...externalLots]
    .map((item) => readString(item.unitId) ?? readString(item.id))
    .filter((id): id is string => id !== null);
  const evidenceIds = evidence.map((item) => readString(item.unitId) ?? readString(item.factId));
  const evidenceById = new Map(evidence.flatMap((item) => {
    const id = readString(item.unitId) ?? readString(item.factId);
    return id === null ? [] : [[id, item] as const];
  }));
  const allEvidenceIdentifiedOnce = evidenceIds.every((id): id is string => id !== null)
    && new Set(evidenceIds).size === evidenceIds.length;
  const allSelectedGrounded = allEvidenceIdentifiedOnce
    && selectedIds.length === resultCards.length + facts.length + externalLots.length
    && new Set(selectedIds).size === selectedIds.length
    && selectedIds.every((id) => evidenceById.has(id));
  const pricesAndAvailabilityGrounded = resultCards.every((item) => {
    const evidenceItem = evidenceById.get(readString(item.unitId) ?? '');
    const answerPrice = readFiniteNumber(item.priceRub);
    const evidencePrice = evidenceItem ? readFiniteNumber(evidenceItem.priceRub) : null;
    return evidenceItem !== undefined
      && answerPrice !== null
      && evidencePrice !== null
      && answerPrice === evidencePrice
      && evidenceItem.availability === 'AVAILABLE'
      && item.availabilityLabel === 'В продаже';
  }) && externalLots.every((item) => {
    const evidenceItem = evidenceById.get(readString(item.id) ?? '');
    const value = evidenceItem && isRecord(evidenceItem.value) ? evidenceItem.value : null;
    const answerPrice = readFiniteNumber(item.priceRub);
    const evidencePrice = value ? readFiniteNumber(value.priceRub) : null;
    return value !== null
      && answerPrice !== null
      && evidencePrice !== null
      && answerPrice === evidencePrice
      && value.availability === 'AVAILABLE'
      && item.availabilityLabel === 'В продаже на официальном сайте';
  }) && facts.every((item) => {
    const evidenceItem = evidenceById.get(readString(item.id) ?? '');
    return evidenceItem !== undefined
      && readString(item.label) === readString(evidenceItem.label)
      && typeof item.value === 'string'
      && item.value === evidenceItem.value;
  });
  const answerContent = readString(record.answer.content)!;
  const freeTextFactsGrounded = persistedFreeTextFactsAreGrounded(answerContent, evidence);
  const answerContentGrounded = persistedAnswerContentMatchesProductionContract(
    answerKind,
    answerContent,
    record.intent,
    exactResults,
    alternatives,
    facts,
    externalLots,
  );
  const geo = (answerKind === 'SEARCH_RESULTS' || answerKind === 'COMPARISON_RESULTS')
    && isRecord(record.answer.geo) ? record.answer.geo : null;
  if (geo && (!Array.isArray(geo.markers) || geo.markers.some((marker) => !isRecord(marker)))) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
  }
  const markers = geo ? geo.markers as Record<string, unknown>[] : [];
  const requiredSearchResultMissing = (answerKind === 'SEARCH_RESULTS' || answerKind === 'COMPARISON_RESULTS')
    && resultCards.length === 0
    && (expected.hardFiltersRequired === true
      || expected.radiusHardFilterRequired === true
      || expected.explicitDeviationRequired === true);
  const radiusSatisfied = !expected.radiusHardFilterRequired || (
    expected.expectedGeo !== undefined && persistedGeoSatisfiesExpectation(
      geo,
      record.geoContext,
      expected.expectedGeo,
      [...allExactResults, ...alternatives],
      [...exactResults, ...alternatives],
      markers,
      evidenceById,
    )
  );
  const nonGeoHardFiltersSatisfied = (!expected.hardFiltersRequired && !expected.expectedIntent)
    || persistedIntentAndResultsSatisfyExpectation(
      allExactResults,
      alternatives,
      evidenceById,
      record.intent,
      expected,
      comparisonGroups,
    );
  const knowledgeExpectationSatisfied = persistedKnowledgeSatisfiesExpectation(
    facts,
    externalLots,
    evidenceById,
    expected.expectedKnowledge,
  );
  const expectedUnitSatisfied = persistedSearchUnitSatisfiesExpectation(
    resultCards,
    evidenceById,
    expected.expectedUnitExternalId,
  );
  const sourcePriority = deriveSourcePriority(evidence, audit, expected, selectedIds, evidenceById);
  const links = [
    ...collectAnswerLinks(resultCards, facts, externalLots).map(({ url, evidenceId }) => ({
      url,
      supported: !qualityFlags.has('BROKEN_LINK')
        && isSupportedPersistedLink(url, evidenceById.get(evidenceId)),
    })),
    ...collectFreeTextLinks(answerContent).map((url) => ({
      url,
      supported: !qualityFlags.has('BROKEN_LINK')
        && evidence.some((item) => isSupportedPersistedLink(url, item)),
    })),
  ];
  if (qualityFlags.has('BROKEN_LINK') && links.length === 0) {
    links.push({ url: 'persisted://broken-link', supported: false });
  }
  const freshnessCards = [...resultCards, ...facts, ...externalLots];
  const completedAt = Date.parse(record.completedAt ?? '');

  return {
    answerKind,
    authorizationPreserved: record.ownerUserId === record.conversationOwnerUserId
      && record.ownerPermissions.includes('objects:read'),
    hardFiltersSatisfied: !requiredSearchResultMissing
      && !qualityFlags.has('HARD_FILTER_VIOLATION')
      && radiusSatisfied
      && nonGeoHardFiltersSatisfied
      && knowledgeExpectationSatisfied
      && expectedUnitSatisfied,
    sourcePriority,
    priceAvailabilityGrounded: allSelectedGrounded
      && pricesAndAvailabilityGrounded
      && freeTextFactsGrounded
      && answerContentGrounded
      && !qualityFlags.has('UNSUPPORTED_FACT'),
    evidencePresent: evidence.length > 0,
    evidenceLeaked: containsPrivateEvidenceKey(record.answer),
    links,
    staleLabelPresent: freshnessCards.some((item) => {
      const id = readString(item.unitId) ?? readString(item.id);
      const evidenceItem = id ? evidenceById.get(id) : undefined;
      return evidenceItem !== undefined
        && isPersistedEvidenceStale(evidenceItem, completedAt)
        && item.isStale === true
        && /устарев/iu.test(readString(item.freshnessLabel) ?? '');
    }),
    freshnessPresent: freshnessCards.some((item) => (readString(item.freshnessLabel) ?? '').trim().length > 0),
    clarificationPresented: answerKind === 'CLARIFICATION',
    distancePresented: resultCards.length > 0
      && resultCards.every((item) => readFiniteNumber(item.distanceMeters) !== null),
    explicitDeviationPresented: alternatives.length > 0 && alternatives.every((item) => (
      Array.isArray(item.deviations) && item.deviations.length > 0
    )),
    selectedAnswerCount: selectedIds.length,
    primaryResultCount: exactResults.length,
    alternativeResultCount: alternatives.length,
    primaryMarkerCount: markers.filter((marker) => marker.kind === 'PRIMARY').length,
    alternativeMarkerCount: markers.filter((marker) => marker.kind === 'ALTERNATIVE').length,
    latencyMs: readNonNegativeNumber(record.latencyMs),
    modelAttempts: telemetry.length,
    totalTokens: telemetry.reduce((total, item) => total + (readFiniteNumber(item.totalTokens) ?? 0), 0),
    geoProviderCalls: record.geoProviderCalls,
  };
}

function readPersistedAnswerArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
  }
  return value as Record<string, unknown>[];
}

function readPersistedComparisonGroups(value: unknown) {
  if (!Array.isArray(value) || value.length !== 2 || value.some((group) => !isRecord(group))) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
  }
  const groups = value as Record<string, unknown>[];
  const targets = groups.map((group) => readString(group.target));
  for (const group of groups) {
    const status = group.status;
    if ((status !== 'MATCHED' && status !== 'NO_MATCH')
      || !isNonNegativeInteger(group.totalExactResults)
      || !Array.isArray(group.exactResults) || group.exactResults.length > 3
      || !Array.isArray(group.additionalExactResults) || group.additionalExactResults.length > 5
      || !isRecord(group.summary)) {
      throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
    }
    const summary = parseAssistantComparisonSummary(group.summary, status);
    if (!summary) throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
    const cards = [
      ...readPersistedAnswerArray(group.exactResults),
      ...readPersistedAnswerArray(group.additionalExactResults),
    ];
    const total = group.totalExactResults as number;
    const matched = status === 'MATCHED';
    const cardPrices = cards.map(({ priceRub }) => readFiniteNumber(priceRub));
    if (matched !== (total > 0)
      || matched !== (cards.length > 0)
      || total < cards.length) {
      throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
    }
    if (matched && (summary.minimumPriceRub === null
      || cardPrices.some((price) => price === null || price <= 0)
      || summary.minimumPriceRub > Math.min(...cardPrices as number[]))) {
      throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
    }
  }
  if (targets.some((target) => target === null) || targets[0] === targets[1]) {
    throw new Error('ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID');
  }
  return groups;
}

function persistedGeoSatisfiesExpectation(
  geo: Record<string, unknown> | null,
  geoContextValue: unknown,
  expected: NonNullable<AssistantEvalExpectation['expectedGeo']>,
  allResults: Record<string, unknown>[],
  markerResults: Record<string, unknown>[],
  markers: Record<string, unknown>[],
  evidenceById: Map<string, Record<string, unknown>>,
) {
  const answerGeo = readPersistedEvalPointGeo(geo, 'ANSWER');
  const contextGeo = readPersistedEvalPointGeo(geoContextValue, 'CONTEXT');
  if (!answerGeo || !contextGeo
    || answerGeo.distanceMeters !== expected.radiusMeters
    || contextGeo.distanceMeters !== expected.radiusMeters
    || normalize(answerGeo.label) !== normalize(expected.anchorLabel)
    || normalize(contextGeo.label) !== normalize(expected.anchorLabel)
    || !anchorMatchesExpected(answerGeo.point, expected)
    || !anchorMatchesExpected(contextGeo.point, expected)
    || assistantGeoDistanceMeters(
      answerGeo.point.latitude,
      answerGeo.point.longitude,
      contextGeo.point.latitude,
      contextGeo.point.longitude,
    ) > 5
    || allResults.length === 0
    || markers.length !== markerResults.length) return false;
  const markerResultIds = markerResults.map((result) => readString(result.unitId));
  const markerIds = markers.map((marker) => readString(marker.unitId));
  if (markerResultIds.some((id) => id === null)
    || markerIds.some((id) => id === null)
    || !sameStringSet(markerResultIds as string[], markerIds as string[])) return false;
  const anchorLatitude = answerGeo.point.latitude;
  const anchorLongitude = answerGeo.point.longitude;
  return allResults.every((result) => {
    const evidence = evidenceById.get(readString(result.unitId) ?? '');
    if (!evidence) return false;
    const actualDistance = assistantGeoDistanceMeters(
      anchorLatitude,
      anchorLongitude,
      readFiniteNumber(evidence.latitude) ?? Number.NaN,
      readFiniteNumber(evidence.longitude) ?? Number.NaN,
    );
    return actualDistance <= expected.radiusMeters
      && distanceMatches(readFiniteNumber(result.distanceMeters), actualDistance);
  }) && markers.every((marker) => {
    const evidence = evidenceById.get(readString(marker.unitId) ?? '');
    if (!evidence) return false;
    const evidenceLatitude = readFiniteNumber(evidence.latitude);
    const evidenceLongitude = readFiniteNumber(evidence.longitude);
    const actualDistance = assistantGeoDistanceMeters(
      anchorLatitude,
      anchorLongitude,
      evidenceLatitude ?? Number.NaN,
      evidenceLongitude ?? Number.NaN,
    );
    return assistantGeoDistanceMeters(
      readFiniteNumber(marker.latitude),
      readFiniteNumber(marker.longitude),
      evidenceLatitude ?? Number.NaN,
      evidenceLongitude ?? Number.NaN,
    ) <= 5 && distanceMatches(readFiniteNumber(marker.distanceMeters), actualDistance);
  });
}

type PersistedEvalPointGeo = {
  label: string;
  point: { latitude: number; longitude: number };
  distanceMeters: number;
};

function readPersistedEvalPointGeo(
  value: unknown,
  role: 'ANSWER' | 'CONTEXT',
): PersistedEvalPointGeo | null {
  if (!isRecord(value)) return null;

  if (isRecord(value.anchor)) {
    const label = readString(value.anchor.label);
    const latitude = readCoordinate(value.anchor.latitude, -90, 90);
    const longitude = readCoordinate(value.anchor.longitude, -180, 180);
    const distanceMeters = readFiniteNumber(value.radiusMeters);
    const source = readString(value.anchor.source);
    if (!label || latitude === null || longitude === null || distanceMeters === null
      || (role === 'CONTEXT' && !['MANUAL', 'PLACE', 'ALIAS', 'KNOWLEDGE'].includes(source ?? ''))) {
      return null;
    }
    return { label, point: { latitude, longitude }, distanceMeters };
  }

  const storedContext = {
    kind: value.kind,
    mode: value.mode,
    label: value.label,
    point: value.point,
    distanceMeters: value.distanceMeters,
    source: value.source,
    ...(Object.hasOwn(value, 'landmarkId') ? { landmarkId: value.landmarkId } : {}),
  };
  let parsed;
  try {
    parsed = parseAssistantGeoStoredContext(storedContext);
  } catch {
    return null;
  }
  if (parsed.kind !== 'POINT' || parsed.mode !== 'NEAR') return null;

  if (role === 'ANSWER') {
    try {
      const referenceGeometry = parseAssistantReferenceGeometry(value.referenceGeometry, 'POINT');
      parseAssistantReferenceGeometry(value.searchArea, 'AREA');
      if (referenceGeometry.type !== 'Point'
        || assistantGeoDistanceMeters(
          parsed.point.latitude,
          parsed.point.longitude,
          referenceGeometry.coordinates[1],
          referenceGeometry.coordinates[0],
        ) > 5) return null;
    } catch {
      return null;
    }
  }

  return {
    label: parsed.label,
    point: parsed.point,
    distanceMeters: parsed.distanceMeters,
  };
}

function anchorMatchesExpected(
  anchor: { latitude: number; longitude: number },
  expected: NonNullable<AssistantEvalExpectation['expectedGeo']>,
) {
  return assistantGeoDistanceMeters(
    anchor.latitude,
    anchor.longitude,
    expected.latitude,
    expected.longitude,
  ) <= expected.maximumAnchorErrorMeters;
}

function distanceMatches(reported: number | null, actual: number) {
  return reported !== null && Number.isFinite(actual) && Math.abs(reported - actual) <= 10;
}

function persistedIntentAndResultsSatisfyExpectation(
  exactResults: Record<string, unknown>[],
  alternatives: Record<string, unknown>[],
  evidenceById: Map<string, Record<string, unknown>>,
  intentValue: unknown,
  expected: AssistantEvalExpectation,
  comparisonGroups: Record<string, unknown>[],
) {
  let intent;
  try {
    intent = parseAssistantStructuredIntent(intentValue);
  } catch {
    return false;
  }
  if (!expected.expectedIntent || !intentMatchesFrozenExpectation(intent, expected.expectedIntent)) {
    return false;
  }
  const exactPassed = exactResults.every((result) => {
    const evidence = evidenceById.get(readString(result.unitId) ?? '');
    if (!evidence) return false;
    try {
      return isValidAssistantSearchEvidence(evidence as unknown as AssistantSearchEvidence)
        && matchesAssistantSearchFilters(
          evidence as unknown as AssistantSearchEvidence,
          intent.hardFilters,
        );
    } catch {
      return false;
    }
  });
  const alternativesPassed = alternatives.every((result) => {
    const evidence = evidenceById.get(readString(result.unitId) ?? '');
    if (!evidence) return false;
    try {
      return isValidAssistantAlternativeEvidence(evidence as unknown as AssistantSearchEvidence)
        && alternativeMatchesPersistedDeviation(
          result,
          evidence as unknown as AssistantSearchEvidence,
          intent.hardFilters,
        );
    } catch {
      return false;
    }
  });
  const selectedEvidence = [...exactResults, ...alternatives].flatMap((result) => {
    const evidence = evidenceById.get(readString(result.unitId) ?? '');
    return evidence ? [evidence] : [];
  });
  const comparisonModes = intent.comparisonTargetModes
    ?? intent.comparisonTargets.map(() => 'EXACT' as const);
  const comparisonPassed = intent.taskType !== 'COMPARE'
    || (comparisonGroups.length > 0
      ? comparisonGroupsGrounded(
          comparisonGroups,
          evidenceById,
          intent.comparisonTargets,
          comparisonModes,
        )
      : comparisonTargetsGrounded(selectedEvidence, intent.comparisonTargets, comparisonModes));
  return exactPassed && alternativesPassed && comparisonPassed;
}

function comparisonGroupsGrounded(
  groups: Record<string, unknown>[],
  evidenceById: Map<string, Record<string, unknown>>,
  targets: string[],
  modes: Array<'EXACT' | 'INSTRUMENTAL'>,
) {
  if (groups.length !== 2 || targets.length !== 2 || modes.length !== 2) return false;
  return groups.every((group, index) => {
    if (readString(group.target) !== targets[index]) return false;
    if (group.status === 'NO_MATCH') return group.totalExactResults === 0;
    const cards = [
      ...readPersistedAnswerArray(group.exactResults),
      ...readPersistedAnswerArray(group.additionalExactResults),
    ];
    const variants = createAssistantComparisonTargetVariants(targets[index]!, modes[index]);
    return cards.length > 0 && cards.every((card) => {
      const evidence = evidenceById.get(readString(card.unitId) ?? '');
      return evidence !== undefined
        && variants.some((variant) => evidenceMatchesComparisonTarget(evidence, variant));
    });
  });
}

function comparisonTargetsGrounded(
  evidence: Record<string, unknown>[],
  targets: string[],
  modes: Array<'EXACT' | 'INSTRUMENTAL'>,
) {
  if (targets.length !== 2 || modes.length !== targets.length) return false;
  const usedEvidence = new Set<number>();
  return targets.every((target, targetIndex) => {
    const variants = createAssistantComparisonTargetVariants(target, modes[targetIndex]);
    const evidenceIndex = evidence.findIndex((item, index) => !usedEvidence.has(index)
      && variants.some((variant) => evidenceMatchesComparisonTarget(item, variant)));
    if (evidenceIndex < 0) return false;
    usedEvidence.add(evidenceIndex);
    return true;
  });
}

function evidenceMatchesComparisonTarget(evidence: Record<string, unknown>, target: string) {
  const normalizedTarget = normalizePhrase(target);
  return normalizedTarget.length > 0 && ['objectTitle', 'developer']
    .map((key) => readString(evidence[key]))
    .filter((value): value is string => value !== null)
    .some((value) => ` ${normalizePhrase(value)} `.includes(` ${normalizedTarget} `));
}

function persistedKnowledgeSatisfiesExpectation(
  facts: Record<string, unknown>[],
  externalLots: Record<string, unknown>[],
  evidenceById: Map<string, Record<string, unknown>>,
  expectation: AssistantEvalExpectation['expectedKnowledge'],
) {
  if (expectation === undefined) return true;
  const selected = [...facts, ...externalLots];
  return selected.length > 0 && selected.every((item) => {
    const id = readString(item.id);
    const evidence = id === null ? undefined : evidenceById.get(id);
    const kind = evidence ? readString(evidence.kind) : null;
    const evidenceText = evidence === undefined ? '' : normalize([
      readString(evidence.label) ?? '',
      typeof evidence.value === 'string' ? evidence.value : stableSerialize(evidence.value),
    ].join(' '));
    return evidence !== undefined
      && readString(evidence.projectKey) === expectation.projectKey
      && kind !== null
      && expectation.factKinds.includes(kind as AssistantSourceFactKind)
      && expectation.requiredTextFragments.every((fragment) => evidenceText.includes(normalize(fragment)));
  });
}

function persistedSearchUnitSatisfiesExpectation(
  resultCards: Record<string, unknown>[],
  evidenceById: Map<string, Record<string, unknown>>,
  expectedExternalId: string | undefined,
) {
  if (expectedExternalId === undefined) return true;
  return resultCards.length > 0 && resultCards.every((item) => {
    const id = readString(item.unitId);
    const evidence = id === null ? undefined : evidenceById.get(id);
    return evidence !== undefined && readString(evidence.unitExternalId) === expectedExternalId;
  });
}

function persistedAnswerContentMatchesProductionContract(
  answerKind: AssistantAnswerKind,
  content: string,
  intentValue: unknown,
  exactResults: Record<string, unknown>[],
  alternatives: Record<string, unknown>[],
  facts: Record<string, unknown>[],
  externalLots: Record<string, unknown>[],
) {
  if (answerKind === 'SEARCH_RESULTS') {
    const intent = isRecord(intentValue) ? intentValue : {};
    const expectedContent = exactResults.length > 0
      ? intent.taskType === 'COMPARE'
        ? 'Сравнил подтверждённые предложения по двум выбранным вариантам.'
        : 'Нашёл точные предложения по указанным критериям.'
      : alternatives.length > 0
        ? 'Точных совпадений нет. Показываю ближайшие альтернативы с явными отклонениями.'
        : 'Не могу подтвердить подходящие предложения по текущим данным Platforma.';
    return content === expectedContent;
  }
  if (answerKind === 'COMPARISON_RESULTS') {
    return content === (exactResults.length > 0
      ? 'Сравнил подтверждённые предложения отдельно по каждому выбранному ЖК.'
      : 'По каждому выбранному ЖК показываю отдельный результат: подтверждённых предложений нет.');
  }
  if (answerKind === 'KNOWLEDGE_RESULTS') {
    const expectedContent = facts.length > 0 && externalLots.length > 0
      ? 'Нашёл подтверждённые факты и доступные лоты по официальным данным.'
      : externalLots.length > 0
        ? 'В Platforma подходящего лота нет, но он найден на официальном сайте застройщика.'
        : 'Нашёл подтверждённую информацию по официальным данным.';
    return content === expectedContent
      || content.startsWith(`${expectedContent} Источники расходятся; выбраны данные `);
  }
  if (answerKind === 'CLARIFICATION') {
    const intent = isRecord(intentValue) ? intentValue : null;
    return intent !== null
      && intent.needsClarification === true
      && readString(intent.clarificationQuestion) === content;
  }
  if (answerKind === 'REFUSAL') {
    return content === 'Не могу подтвердить ответ по доступным источникам.'
      || content === 'Не могу подтвердить подходящие предложения по текущим данным Platforma.'
      || content === 'Для этого объекта не найден доверенный зарегистрированный источник.'
      || content === 'Не удалось подтвердить текущие условия по зарегистрированному источнику.';
  }
  const intent = isRecord(intentValue) ? intentValue : null;
  return intent?.taskType === 'LEGAL_TAX' && content === [
    'Я могу помочь найти и сравнить объекты по подтверждённым данным Platforma,',
    'но ответ по налогам или правовым условиям не заменяет консультацию профильного специалиста.',
  ].join(' ');
}

function intentMatchesFrozenExpectation(
  intent: ReturnType<typeof parseAssistantStructuredIntent>,
  expected: NonNullable<AssistantEvalExpectation['expectedIntent']>,
) {
  return stableSerialize(intent) === stableSerialize(expected);
}

function alternativeMatchesPersistedDeviation(
  answer: Record<string, unknown>,
  evidence: AssistantSearchEvidence,
  hardFilters: ReturnType<typeof parseAssistantStructuredIntent>['hardFilters'],
) {
  if (!Array.isArray(answer.deviations)
    || stableSerialize(answer.deviations) !== stableSerialize(evidence.deviations)
    || evidence.deviations.length !== 1) return false;
  const type = evidence.deviations[0]?.type;
  const relaxedFilters = structuredClone(hardFilters);
  if (type === 'BUDGET') {
    const aboveMaximum = hardFilters.budgetMaxRub !== null
      ? evidence.priceRub - hardFilters.budgetMaxRub
      : 0;
    const belowMinimum = hardFilters.budgetMinRub !== null
      ? hardFilters.budgetMinRub - evidence.priceRub
      : 0;
    const difference = Math.max(aboveMaximum, belowMinimum);
    if (difference <= 0 || difference > assistantBudgetRelaxationRub) return false;
    relaxedFilters.budgetMinRub = null;
    relaxedFilters.budgetMaxRub = null;
  } else if (type === 'DISTRICT') {
    return false;
  } else if (type === 'DEVELOPER') {
    relaxedFilters.developer = null;
  } else if (type === 'ROOMS') {
    relaxedFilters.rooms = [];
  } else {
    return false;
  }
  return !matchesAssistantSearchFilters(evidence, hardFilters)
    && matchesAssistantSearchFilters(evidence, relaxedFilters);
}

function deriveSourcePriority(
  evidence: Record<string, unknown>[],
  audit: Record<string, unknown>,
  expected: AssistantEvalExpectation,
  selectedAnswerIds: string[],
  evidenceById: Map<string, Record<string, unknown>>,
): AssistantEvalObservation['sourcePriority'] {
  if (expected.deterministicSourcePriorityRequired) {
    return hasDeterministicHighestAuthoritySelection(audit, selectedAnswerIds, evidenceById)
      ? 'DETERMINISTIC'
      : null;
  }
  const sourceTypes = evidence.map((item) => readString(item.sourceType));
  const everySourceHasAuthorityMetadata = evidence.length > 0 && evidence.every((item, index) => (
    sourceTypes[index] !== null
    && Object.values(AssistantKnowledgeSourceType).includes(
      sourceTypes[index] as AssistantKnowledgeSourceType,
    )
    && isNonNegativeInteger(item.sourcePriority)
    && readString(item.sourceId) !== null
  ));
  if (expected.sourcePriority === 'OFFICIAL_PROJECT') {
    return everySourceHasAuthorityMetadata
      && sourceTypes.every((type) => type === 'DEVELOPMENT_PAGE')
      ? 'OFFICIAL_PROJECT'
      : null;
  }
  if (expected.sourcePriority === 'OFFICIAL_DEVELOPER_OR_BANK') {
    const official = new Set(['DEVELOPMENT_PAGE', 'DEVELOPER_PROMOTION', 'BANK_PROMOTION']);
    return everySourceHasAuthorityMetadata && sourceTypes.every((type) => official.has(type!))
      ? 'OFFICIAL_DEVELOPER_OR_BANK'
      : null;
  }
  return null;
}

function hasDeterministicHighestAuthoritySelection(
  audit: Record<string, unknown>,
  selectedAnswerIds: string[],
  evidenceById: Map<string, Record<string, unknown>>,
) {
  const candidates = Array.isArray(audit.candidateSet) ? audit.candidateSet.filter(isRecord) : [];
  const decisions = Array.isArray(audit.rankingDecisions) ? audit.rankingDecisions.filter(isRecord) : [];
  const candidateIds = candidates.map((candidate) => readString(candidate.evidenceId));
  const decisionIds = decisions.map((decision) => readString(decision.evidenceId));
  const selectedDecisionIds = decisions.filter((decision) => (
    decision.outcome === 'PRIMARY'
    || decision.outcome === 'ALTERNATIVE'
    || decision.outcome === 'SELECTED_FACT'
  )).map((decision) => readString(decision.evidenceId));
  if (candidates.length < 2
    || candidates.length !== decisions.length
    || candidateIds.some((id) => id === null)
    || decisionIds.some((id) => id === null)
    || selectedDecisionIds.some((id) => id === null)
    || new Set(candidateIds).size !== candidateIds.length
    || new Set(decisionIds).size !== decisionIds.length
    || !sameStringSet(candidateIds as string[], decisionIds as string[])
    || selectedAnswerIds.length === 0
    || new Set(selectedAnswerIds).size !== selectedAnswerIds.length
    || !sameStringSet(selectedAnswerIds, selectedDecisionIds as string[])) return false;
  const selectedIds = new Set(selectedAnswerIds);
  const highestAuthorityByFact = new Map<string, number>();
  const candidatesByFact = new Map<string, Array<{
    authority: number;
    sourceId: string;
    valueKey: string;
  }>>();
  for (const candidate of candidates) {
    const parsed = parseKnowledgeCandidate(candidate);
    if (parsed === null) return false;
    const key = assistantKnowledgeSemanticConflictKey(parsed);
    const authority = assistantKnowledgeAuthorityScore(parsed);
    highestAuthorityByFact.set(key, Math.max(highestAuthorityByFact.get(key) ?? Number.NEGATIVE_INFINITY, authority));
    candidatesByFact.set(key, [
      ...(candidatesByFact.get(key) ?? []),
      {
        authority,
        sourceId: parsed.sourceId,
        valueKey: typeof parsed.value === 'string'
          ? normalize(parsed.value)
          : stableSerialize(parsed.value),
      },
    ]);
  }
  const actualConflictKeys = new Set([...candidatesByFact.entries()].flatMap(([key, group]) => (
    group.length >= 2
      && new Set(group.map(({ authority }) => authority)).size >= 2
      && new Set(group.map(({ sourceId }) => sourceId)).size >= 2
      && new Set(group.map(({ valueKey }) => valueKey)).size >= 2
      ? [key]
      : []
  )));
  if (actualConflictKeys.size === 0) return false;
  const selectedCandidates = candidates.filter((candidate) => selectedIds.has(readString(candidate.evidenceId) ?? ''));
  return selectedCandidates.length === selectedIds.size && selectedCandidates
    .every((candidate) => {
      const evidenceRecord = evidenceById.get(readString(candidate.evidenceId) ?? '');
      const parsed = parseKnowledgeCandidate(candidate);
      const parsedEvidence = evidenceRecord === undefined
        ? null
        : parseKnowledgeCandidate({ ...evidenceRecord, factKind: evidenceRecord.kind });
      if (parsed === null
        || parsedEvidence === null
        || stableSerialize(parsed) !== stableSerialize(parsedEvidence)) return false;
      const key = assistantKnowledgeSemanticConflictKey(parsed);
      return actualConflictKeys.has(key)
        && assistantKnowledgeAuthorityScore(parsed) === highestAuthorityByFact.get(key);
    });
}

function parseKnowledgeCandidate(candidate: Record<string, unknown>) {
  const kind = readString(candidate.factKind);
  const sourceType = readString(candidate.sourceType);
  const sourcePriority = readFiniteNumber(candidate.sourcePriority);
  const label = readString(candidate.label);
  const sourceId = readString(candidate.sourceId);
  if (!kind
    || !Object.values(AssistantSourceFactKind).includes(kind as AssistantSourceFactKind)
    || !sourceType
    || !Object.values(AssistantKnowledgeSourceType).includes(sourceType as AssistantKnowledgeSourceType)
    || sourcePriority === null
    || !Number.isInteger(sourcePriority)
    || sourcePriority < 0
    || !label
    || !sourceId) return null;
  return {
    kind: kind as AssistantSourceFactKind,
    sourceType: sourceType as AssistantKnowledgeSourceType,
    sourcePriority,
    label,
    sourceId,
    projectKey: readString(candidate.projectKey),
    developerKey: readString(candidate.developerKey),
    value: candidate.value,
    canonicalUrl: readString(candidate.canonicalUrl),
  };
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function collectAnswerLinks(
  results: Record<string, unknown>[],
  facts: Record<string, unknown>[],
  externalLots: Record<string, unknown>[],
) {
  return [
    ...results.flatMap((item) => [
      { url: readString(item.href), evidenceId: readString(item.unitId) },
      ...(Array.isArray(item.pdfs)
        ? item.pdfs.filter(isRecord).map((pdf) => ({
            url: readString(pdf.href),
            evidenceId: readString(item.unitId),
          }))
        : []),
    ]),
    ...externalLots.map((item) => ({
      url: readString(item.href),
      evidenceId: readString(item.id),
    })),
    ...facts.map((item) => ({
      url: readString(item.sourceUrl),
      evidenceId: readString(item.id),
    })),
  ].filter((item): item is { url: string; evidenceId: string } => (
    item.url !== null && item.evidenceId !== null
  ));
}

function collectFreeTextLinks(content: string) {
  const links = content.match(
    /https?:\/\/[^\s<>"']+|\/objects\/[^\s/]+\/lots\/[0-9a-f-]{36}|\/media\/files\/[0-9a-f-]{36}\/content\?download=true/giu,
  ) ?? [];
  return [...new Set(links.map((url) => url.replace(/[),.;!?]+$/gu, '')))];
}

function isSupportedPersistedLink(
  url: string,
  evidence: Record<string, unknown> | undefined,
) {
  if (!evidence) return false;
  const lot = url.match(/^\/objects\/([^/]+)\/lots\/([0-9a-f-]{36})$/iu);
  if (lot) {
    try {
      return readString(evidence.unitId) === lot[2]
        && readString(evidence.objectSlug) === decodeURIComponent(lot[1]!);
    } catch {
      return false;
    }
  }
  const pdf = url.match(/^\/media\/files\/([0-9a-f-]{36})\/content\?download=true$/iu);
  if (pdf) {
    return Array.isArray(evidence.pdfs) && evidence.pdfs.some((candidate) => (
      isRecord(candidate) && readString(candidate.fileId) === pdf[1]
    ));
  }
  return /^https:\/\//u.test(url)
    && (readString(evidence.canonicalUrl) === url || readString(evidence.sourceUrl) === url);
}

function isPersistedEvidenceStale(evidence: Record<string, unknown>, completedAt: number) {
  const timestamp = readString(evidence.updatedAt)
    ?? readString(evidence.verifiedAt)
    ?? readString(evidence.fetchedAt);
  if (!timestamp || !Number.isFinite(completedAt)) return false;
  const observedAt = Date.parse(timestamp);
  return Number.isFinite(observedAt) && completedAt - observedAt >= 24 * 60 * 60 * 1_000;
}

function persistedFreeTextFactsAreGrounded(
  content: string,
  evidence: Record<string, unknown>[],
) {
  const evidencePrices = new Set(evidence.flatMap((item) => {
    const direct = readFiniteNumber(item.priceRub);
    const nested = isRecord(item.value) ? readFiniteNumber(item.value.priceRub) : null;
    return [direct, nested].filter((value): value is number => value !== null);
  }));
  const priceClaims = [...content.matchAll(
    /(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|миллион(?:а|ов)?|тыс\p{L}*|тысяч(?:а|и)?|руб\p{L}*|рубл(?:ь|я|ей)|₽)/giu,
  )].map((match) => {
    const value = Number(match[1]!.replace(/\s/gu, '').replace(',', '.'));
    const unit = match[2]!.toLocaleLowerCase('ru-RU');
    return Math.round(value * (
      unit.startsWith('млн') || unit.startsWith('миллион')
        ? 1_000_000
        : unit.startsWith('тыс') ? 1_000 : 1
    ));
  });
  const availabilitySubject = '(?:квартир\\p{L}*|лот\\p{L}*|вариант\\p{L}*)';
  const availabilityPredicate = '(?:доступн\\p{L}*|в\\s+продаже|найден\\p{L}*|имеетс\\p{L}*)';
  const availabilityClaimPattern = new RegExp(
    `(?:${availabilitySubject}[^.!?\\r\\n]{0,80}${availabilityPredicate}`
      + `|${availabilityPredicate}[^.!?\\r\\n]{0,80}${availabilitySubject}`
      + `|(?:есть|наш(?:е[лд]|ла|ли))[^.!?\\r\\n]{0,80}${availabilitySubject})`,
    'iu',
  );
  const availableClaim = content.split(/[.!?\r\n]+/u).some((sentence) => (
    availabilityClaimPattern.test(sentence)
      && !/(?:^|[^\p{L}])(?:нет(?:$|[^\p{L}])|не\s+(?:в\s+продаже|найден\p{L}*|доступн\p{L}*)|недоступн\p{L}*|отсутств\p{L}*)/iu.test(sentence)
  ));
  const availableEvidencePresent = evidence.some((item) => item.availability === 'AVAILABLE'
    || (isRecord(item.value) && item.value.availability === 'AVAILABLE'));
  return priceClaims.every((price) => evidencePrices.has(price))
    && (!availableClaim || availableEvidencePresent);
}

function containsPrivateEvidenceKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateEvidenceKey);
  if (!isRecord(value)) return false;
  const privateKeys = new Set(['evidence', 'evidenceJson', 'telemetry', 'telemetryJson', 'audit', 'auditJson']);
  return Object.entries(value).some(([key, nested]) => privateKeys.has(key) || containsPrivateEvidenceKey(nested));
}

function readString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCoordinate(value: unknown, minimum: number, maximum: number) {
  const parsed = readFiniteNumber(value);
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function isNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function digest(value: unknown) {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function normalize(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function normalizePhrase(value: string) {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function assistantGeoDistanceMeters(
  latitude: number | null,
  longitude: number | null,
  expectedLatitude: number,
  expectedLongitude: number,
) {
  if (latitude === null || longitude === null) return Number.POSITIVE_INFINITY;
  const toRadians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = toRadians(expectedLatitude - latitude);
  const longitudeDelta = toRadians(expectedLongitude - longitude);
  const left = toRadians(latitude);
  const right = toRadians(expectedLatitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left) * Math.cos(right) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function parseThresholds(value: unknown): AssistantEvalThresholds {
  if (!isRecord(value)) throw new Error('ASSISTANT_EVAL_THRESHOLDS_INVALID');
  return {
    minimumOverallPassRate: readRatio(value.minimumOverallPassRate),
    minimumCategoryPassRate: readRatio(value.minimumCategoryPassRate),
    minimumAverageQualityScore: readRatio(value.minimumAverageQualityScore),
    maximumP95LatencyMs: readNonNegativeNumber(value.maximumP95LatencyMs),
    maximumAverageModelAttempts: readNonNegativeNumber(value.maximumAverageModelAttempts),
    maximumAverageTotalTokens: readNonNegativeNumber(value.maximumAverageTotalTokens),
    maximumAverageGeoProviderCalls: readNonNegativeNumber(value.maximumAverageGeoProviderCalls),
  };
}

function parseZeroTolerance(value: unknown): AssistantEvalViolation[] {
  if (!Array.isArray(value)
    || value.length !== assistantEvalZeroToleranceViolations.length
    || value.some((item, index) => item !== assistantEvalZeroToleranceViolations[index])) {
    throw new Error('ASSISTANT_EVAL_ZERO_TOLERANCE_INVALID');
  }
  return [...assistantEvalZeroToleranceViolations];
}

function parseCase(value: unknown): AssistantEvalCase {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !caseIdPattern.test(value.id)
    || !assistantEvalCategories.includes(value.category as AssistantEvalCategory)
    || typeof value.query !== 'string'
    || value.query.trim().length < 3
    || value.query.length > 2_000
    || !isRecord(value.expected)) {
    throw new Error('ASSISTANT_EVAL_CASE_INVALID');
  }
  return {
    id: value.id,
    category: value.category as AssistantEvalCategory,
    query: value.query,
    expected: parseExpectation(value.expected),
  };
}

function parseExpectation(value: Record<string, unknown>): AssistantEvalExpectation {
  if (!Array.isArray(value.answerKinds)
    || value.answerKinds.length === 0
    || value.answerKinds.some((kind) => typeof kind !== 'string'
      || !answerKinds.has(kind as AssistantAnswerKind))) {
    throw new Error('ASSISTANT_EVAL_EXPECTATION_INVALID');
  }
  const expectedIntent = value.expectedIntent === undefined
    ? undefined
    : parseExpectedIntent(value.expectedIntent);
  const expectedGeo = value.expectedGeo === undefined
    ? undefined
    : parseExpectedGeo(value.expectedGeo);
  const expectedKnowledge = value.expectedKnowledge === undefined
    ? undefined
    : parseExpectedKnowledge(value.expectedKnowledge);
  if (value.hardFiltersRequired === true && expectedIntent === undefined) {
    throw new Error('ASSISTANT_EVAL_EXPECTED_INTENT_REQUIRED');
  }
  if (value.radiusHardFilterRequired === true && expectedGeo === undefined) {
    throw new Error('ASSISTANT_EVAL_EXPECTED_GEO_REQUIRED');
  }
  const expectedUnitExternalId = value.expectedUnitExternalId === undefined
    ? undefined
    : parseExpectedUnitExternalId(value.expectedUnitExternalId);
  return {
    ...(structuredClone(value) as AssistantEvalExpectation),
    ...(expectedIntent ? { expectedIntent } : {}),
    ...(expectedGeo ? { expectedGeo } : {}),
    ...(expectedKnowledge ? { expectedKnowledge } : {}),
    ...(expectedUnitExternalId ? { expectedUnitExternalId } : {}),
  };
}

function parseExpectedUnitExternalId(value: unknown) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 255) {
    throw new Error('ASSISTANT_EVAL_EXPECTED_UNIT_EXTERNAL_ID_INVALID');
  }
  return value;
}

function parseExpectedKnowledge(value: unknown) {
  if (!isRecord(value)
    || Object.keys(value).length !== 3
    || typeof value.projectKey !== 'string'
    || normalizeAssistantKnowledgeRegistryKey(value.projectKey) !== value.projectKey
    || !Array.isArray(value.factKinds)
    || value.factKinds.length === 0
    || new Set(value.factKinds).size !== value.factKinds.length
    || value.factKinds.some((kind) => !Object.values(AssistantSourceFactKind).includes(
      kind as AssistantSourceFactKind,
    ))
    || !Array.isArray(value.requiredTextFragments)
    || value.requiredTextFragments.length === 0
    || new Set(value.requiredTextFragments).size !== value.requiredTextFragments.length
    || value.requiredTextFragments.some((fragment) => (
      typeof fragment !== 'string'
      || fragment.trim() !== fragment
      || fragment.length === 0
      || fragment.length > 120
    ))) {
    throw new Error('ASSISTANT_EVAL_EXPECTED_KNOWLEDGE_INVALID');
  }
  return {
    projectKey: value.projectKey,
    factKinds: value.factKinds as AssistantSourceFactKind[],
    requiredTextFragments: value.requiredTextFragments as string[],
  };
}

function parseExpectedIntent(value: unknown) {
  try {
    return parseAssistantStructuredIntent(value);
  } catch {
    throw new Error('ASSISTANT_EVAL_EXPECTED_INTENT_INVALID');
  }
}

function parseExpectedGeo(value: unknown) {
  if (!isRecord(value)
    || Object.keys(value).length !== 5
    || !Object.hasOwn(value, 'radiusMeters')
    || !Object.hasOwn(value, 'anchorLabel')
    || !Object.hasOwn(value, 'latitude')
    || !Object.hasOwn(value, 'longitude')
    || !Object.hasOwn(value, 'maximumAnchorErrorMeters')
    || !isPositiveInteger(value.radiusMeters)
    || value.radiusMeters < 100
    || value.radiusMeters > 20_000
    || typeof value.anchorLabel !== 'string'
    || value.anchorLabel.trim() === ''
    || readCoordinate(value.latitude, -90, 90) === null
    || readCoordinate(value.longitude, -180, 180) === null
    || !isPositiveInteger(value.maximumAnchorErrorMeters)
    || value.maximumAnchorErrorMeters > 1_000) {
    throw new Error('ASSISTANT_EVAL_EXPECTED_GEO_INVALID');
  }
  return {
    radiusMeters: value.radiusMeters,
    anchorLabel: value.anchorLabel,
    latitude: value.latitude as number,
    longitude: value.longitude as number,
    maximumAnchorErrorMeters: value.maximumAnchorErrorMeters,
  };
}

function parseResult(value: unknown): AssistantEvalResult {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.passed !== 'boolean'
    || !Array.isArray(value.violations)
    || value.violations.some((violation) =>
      !assistantEvalZeroToleranceViolations.includes(violation as AssistantEvalViolation))) {
    throw new Error('ASSISTANT_EVAL_RESULT_INVALID');
  }
  return {
    id: value.id,
    passed: value.passed,
    qualityScore: readRatio(value.qualityScore),
    latencyMs: readNonNegativeNumber(value.latencyMs),
    modelAttempts: readNonNegativeNumber(value.modelAttempts),
    totalTokens: readNonNegativeNumber(value.totalTokens),
    geoProviderCalls: readNonNegativeNumber(value.geoProviderCalls),
    violations: value.violations as AssistantEvalViolation[],
  };
}

function minimumGate(code: string, actual: number, threshold: number): AssistantEvalGate {
  return { code, passed: actual >= threshold, actual, threshold };
}

function maximumGate(code: string, actual: number, threshold: number): AssistantEvalGate {
  return { code, passed: actual <= threshold, actual, threshold };
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

function readRatio(value: unknown) {
  const parsed = readNonNegativeNumber(value);
  if (parsed > 1) throw new Error('ASSISTANT_EVAL_RATIO_INVALID');
  return parsed;
}

function readNonNegativeNumber(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('ASSISTANT_EVAL_NUMBER_INVALID');
  }
  return value;
}

function readNonNegativeInteger(value: unknown) {
  const parsed = readNonNegativeNumber(value);
  if (!Number.isInteger(parsed)) throw new Error('ASSISTANT_EVAL_INTEGER_INVALID');
  return parsed;
}

function isIsoTimestamp(value: string) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}
