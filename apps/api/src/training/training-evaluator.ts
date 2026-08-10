import { Injectable } from '@nestjs/common';

import {
  TRAINING_EVALUATION_SCHEMA_VERSION,
  TRAINING_LEGACY_EVALUATION_SCHEMA_VERSION,
  type TrainingEvaluationSchemaVersion,
  type TrainingProjectSnapshotCriterion,
  type TrainingProjectSnapshotFact,
} from './training-snapshot';
import type { TrainingOpenAIUsage } from './training-openai-usage';

export const TRAINING_EVALUATOR = Symbol('TRAINING_EVALUATOR');
export const TRAINING_FAKE_EVALUATION_VERSION = 'stage1-length-v1';
export const TRAINING_MAIN_MAX_SCORE = 55;
export const TRAINING_FOLLOW_UP_MAX_SCORE = 15;
export const TRAINING_UNSUPPORTED_CLAIM_CATEGORIES = [
  'HARMLESS_EXTRA',
  'MATERIAL_UNVERIFIED',
  'CONTRADICTORY',
  'UNSAFE_TO_SCORE',
] as const;
const TRAINING_TOTAL_MAX_SCORE = 100;

export type TrainingEvaluationOutputLimits = Readonly<{
  evidenceMaxChars: number;
  explanationMaxChars: number;
  summaryMaxChars: number;
  unsupportedClaimsMax: number;
  unsupportedClaimMaxChars: number;
}>;

export const DEFAULT_TRAINING_EVALUATION_OUTPUT_LIMITS: TrainingEvaluationOutputLimits =
  Object.freeze({
    evidenceMaxChars: 500,
    explanationMaxChars: 1_000,
    summaryMaxChars: 1_000,
    unsupportedClaimsMax: 20,
    unsupportedClaimMaxChars: 500,
  });

export type TrainingLegacyEvaluation = {
  score: number;
  outcome: 'SCORED' | 'REQUIRES_REVIEW';
  safeBreakdown: {
    version: typeof TRAINING_FAKE_EVALUATION_VERSION;
    basis: 'TEXT_LENGTH' | 'FAKE_PASS' | 'FAKE_FAIL' | 'FAKE_REVIEW';
    awardedScore: number;
    maxScore: number;
  };
};

export type TrainingObjectiveMetrics = {
  audioDurationSeconds: number;
  segmentCount: number;
  wordCount: number;
  wordsPerMinute: number;
  fillerWordsCount: number;
  fillerWordsFound: string[];
};

export type TrainingFactAssessment = {
  fact_id: string;
  verdict: 'CORRECT' | 'PARTIAL' | 'MISSING' | 'INCORRECT';
  evidence: string | null;
  explanation: string;
};

export type TrainingCriterionAssessment = {
  criterion_id: string;
  awarded_points: number;
  evidence: string | null;
  explanation: string;
};

export type TrainingUnsupportedClaimCategory =
  (typeof TRAINING_UNSUPPORTED_CLAIM_CATEGORIES)[number];

export type TrainingUnsupportedClaim = {
  claim: string;
  evidence: string;
  category?: TrainingUnsupportedClaimCategory;
};

export type TrainingStructuredEvaluation = {
  schema_version: TrainingEvaluationSchemaVersion;
  fact_assessments: TrainingFactAssessment[];
  criterion_assessments: TrainingCriterionAssessment[];
  unsupported_claims: TrainingUnsupportedClaim[];
  summary: string;
  requires_review: boolean;
};

export type TrainingEvaluationInput = {
  projectId: string;
  attemptId: string;
  questionId: string;
  projectKnowledgeVersion: number;
  questionText: string;
  questionType: 'MAIN' | 'FOLLOW_UP';
  transcript: string;
  facts: TrainingProjectSnapshotFact[];
  criteria: TrainingProjectSnapshotCriterion[];
  objectiveMetrics: TrainingObjectiveMetrics;
  maxScore: number;
  evaluationSchemaVersion?: TrainingEvaluationSchemaVersion;
  harmlessExtraRoutingEnabled?: boolean;
};

export type TrainingEvaluationResult = {
  evaluation: TrainingStructuredEvaluation;
  model: string;
  requestId: string | null;
  latencyMs: number;
  attempts: number;
  responseId: string | null;
  usage: TrainingOpenAIUsage | null;
};

export interface TrainingEvaluator {
  readonly version: string;
  evaluate(
    input: TrainingEvaluationInput,
    options?: { signal?: AbortSignal },
  ): Promise<TrainingEvaluationResult>;
}

@Injectable()
export class DeterministicFakeTrainingEvaluator implements TrainingEvaluator {
  readonly version = TRAINING_FAKE_EVALUATION_VERSION;

  async evaluate(input: TrainingEvaluationInput): Promise<TrainingEvaluationResult> {
    const marker = input.transcript.trim().toLocaleLowerCase('ru-RU');
    const pass = marker === '[fake:pass]';
    const review = marker === '[fake:review]';
    const harmless = marker === '[fake:harmless]';
    const schemaVersion = resolveEvaluationSchemaVersion(input);
    const unsupportedClaims: TrainingUnsupportedClaim[] = review || harmless
      ? [{
          claim: review ? 'fake review' : 'fake harmless extra',
          evidence: input.transcript,
          ...(schemaVersion === TRAINING_EVALUATION_SCHEMA_VERSION
            ? { category: review ? 'MATERIAL_UNVERIFIED' as const : 'HARMLESS_EXTRA' as const }
            : {}),
        }]
      : [];
    const requiresReview = schemaVersion === TRAINING_LEGACY_EVALUATION_SCHEMA_VERSION
      ? unsupportedClaims.length > 0
      : unsupportedClaims.some((claim) => claim.category !== 'HARMLESS_EXTRA') ||
        (!input.harmlessExtraRoutingEnabled && unsupportedClaims.length > 0);
    const evaluation: TrainingStructuredEvaluation = {
      schema_version: schemaVersion,
      fact_assessments: input.facts.map((fact) => ({
        fact_id: fact.id,
        verdict: 'MISSING',
        evidence: null,
        explanation: pass ? 'Детерминированный fake pass.' : 'Факт не оценивался fake provider.',
      })),
      criterion_assessments: input.criteria.map((criterion) => ({
        criterion_id: criterion.id,
        awarded_points: pass ? criterion.maxPoints : 0,
        evidence: pass ? input.transcript : null,
        explanation: 'Детерминированная fake evaluation.',
      })),
      unsupported_claims: unsupportedClaims,
      summary: review
        ? 'Требуется проверка fake результата.'
        : harmless
          ? 'Детерминированная безобидная дополнительная информация.'
          : 'Детерминированный fake результат.',
      requires_review: requiresReview,
    };

    return {
      evaluation: validateTrainingStructuredEvaluation(evaluation, input),
      model: 'deterministic-fake-evaluator',
      requestId: null,
      latencyMs: 0,
      attempts: 1,
      responseId: null,
      usage: null,
    };
  }
}

export function evaluateLegacyTrainingText(
  text: string,
  maxScore: number,
): TrainingLegacyEvaluation {
  const boundedMaxScore = clampScore(maxScore, TRAINING_MAIN_MAX_SCORE);
  const normalizedText = text.trim().toLocaleLowerCase('ru-RU');
  let basis: TrainingLegacyEvaluation['safeBreakdown']['basis'] = 'TEXT_LENGTH';
  let outcome: TrainingLegacyEvaluation['outcome'] = 'SCORED';
  let score = Math.min(boundedMaxScore, normalizedText.length);

  if (normalizedText === '[fake:pass]') {
    basis = 'FAKE_PASS';
    score = boundedMaxScore;
  } else if (normalizedText === '[fake:fail]') {
    basis = 'FAKE_FAIL';
    score = 0;
  } else if (normalizedText === '[fake:review]') {
    basis = 'FAKE_REVIEW';
    outcome = 'REQUIRES_REVIEW';
    score = 0;
  }

  return {
    score: clampScore(score, boundedMaxScore),
    outcome,
    safeBreakdown: {
      version: TRAINING_FAKE_EVALUATION_VERSION,
      basis,
      awardedScore: clampScore(score, boundedMaxScore),
      maxScore: boundedMaxScore,
    },
  };
}

export function validateTrainingStructuredEvaluation(
  value: unknown,
  input: TrainingEvaluationInput,
  limits: TrainingEvaluationOutputLimits = DEFAULT_TRAINING_EVALUATION_OUTPUT_LIMITS,
): TrainingStructuredEvaluation {
  if (!isRecord(value)) throw new Error('INVALID_EVALUATION_OBJECT');
  const schemaVersion = resolveEvaluationSchemaVersion(input);
  assertExactKeys(value, [
    'schema_version',
    'fact_assessments',
    'criterion_assessments',
    'unsupported_claims',
    'summary',
    'requires_review',
  ]);

  if (
    value.schema_version !== schemaVersion ||
    !Array.isArray(value.fact_assessments) ||
    !Array.isArray(value.criterion_assessments) ||
    !Array.isArray(value.unsupported_claims) ||
    typeof value.summary !== 'string' ||
    value.summary.trim().length < 1 ||
    value.summary.length > limits.summaryMaxChars ||
    typeof value.requires_review !== 'boolean'
  ) {
    throw new Error('INVALID_EVALUATION_SCHEMA');
  }

  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const criteriaById = new Map(input.criteria.map((criterion) => [criterion.id, criterion]));
  const factAssessments = value.fact_assessments.map((item) =>
    parseFactAssessment(item, input, limits),
  );
  const criterionAssessments = value.criterion_assessments.map((item) =>
    parseCriterionAssessment(item, input, criteriaById, limits),
  );
  assertExactIds(factAssessments.map((item) => item.fact_id), factsById, 'FACT');
  assertExactIds(
    criterionAssessments.map((item) => item.criterion_id),
    criteriaById,
    'CRITERION',
  );

  if (value.unsupported_claims.length > limits.unsupportedClaimsMax) {
    throw new Error('TOO_MANY_UNSUPPORTED_CLAIMS');
  }
  const approvedClaims = new Set(
    input.facts.flatMap((fact) => [fact.statement, ...fact.aliases]).map(canonicalizeClaim),
  );
  const unsupportedClaims = value.unsupported_claims.map((item): TrainingUnsupportedClaim => {
    if (!isRecord(item)) throw new Error('INVALID_UNSUPPORTED_CLAIM');
    assertExactKeys(
      item,
      schemaVersion === TRAINING_EVALUATION_SCHEMA_VERSION
        ? ['claim', 'evidence', 'category']
        : ['claim', 'evidence'],
    );

    if (
      typeof item.claim !== 'string' ||
      item.claim.trim().length < 1 ||
      item.claim.length > limits.unsupportedClaimMaxChars ||
      typeof item.evidence !== 'string' ||
      item.evidence.trim().length < 1 ||
      item.evidence.length > limits.evidenceMaxChars ||
      (schemaVersion === TRAINING_EVALUATION_SCHEMA_VERSION &&
        !TRAINING_UNSUPPORTED_CLAIM_CATEGORIES.includes(
          item.category as TrainingUnsupportedClaimCategory,
        ))
    ) {
      throw new Error('INVALID_UNSUPPORTED_CLAIM');
    }

    assertTranscriptEvidence(item.evidence, input.transcript);
    if (approvedClaims.has(canonicalizeClaim(item.claim))) {
      throw new Error('UNSUPPORTED_CLAIM_IS_APPROVED');
    }

    return {
      claim: item.claim,
      evidence: item.evidence,
      ...(schemaVersion === TRAINING_EVALUATION_SCHEMA_VERSION
        ? { category: item.category as TrainingUnsupportedClaimCategory }
        : {}),
    };
  });
  const requiresReview = requiresTrainingReview(
    unsupportedClaims,
    schemaVersion,
    input.harmlessExtraRoutingEnabled === true,
  );

  if (
    schemaVersion === TRAINING_EVALUATION_SCHEMA_VERSION &&
    value.requires_review !== requiresReview
  ) {
    throw new Error('REVIEW_ROUTING_MISMATCH');
  }

  return {
    schema_version: schemaVersion,
    fact_assessments: factAssessments,
    criterion_assessments: criterionAssessments,
    unsupported_claims: unsupportedClaims,
    summary: value.summary.trim(),
    requires_review: schemaVersion === TRAINING_LEGACY_EVALUATION_SCHEMA_VERSION
      ? value.requires_review || requiresReview
      : requiresReview,
  };
}

export function scoreTrainingEvaluation(
  evaluation: TrainingStructuredEvaluation,
  input: Pick<TrainingEvaluationInput, 'criteria' | 'maxScore'>,
) {
  const maximum = input.maxScore === TRAINING_MAIN_MAX_SCORE
    ? TRAINING_MAIN_MAX_SCORE
    : TRAINING_FOLLOW_UP_MAX_SCORE;
  const criteriaPoints = evaluation.criterion_assessments.reduce(
    (total, assessment) => total + assessment.awarded_points,
    0,
  );
  const incorrectFactCount = new Set(
    evaluation.fact_assessments
      .filter((assessment) => assessment.verdict === 'INCORRECT')
      .map((assessment) => assessment.fact_id),
  ).size;
  const penaltyPoints = incorrectFactCount * 5;
  const score = clampScore(Math.min(criteriaPoints, maximum) - penaltyPoints, maximum);

  return {
    score,
    requiresReview: evaluation.requires_review,
    safeBreakdown: {
      version: evaluation.schema_version,
      basis: 'AI_CRITERIA' as const,
      criteriaPoints: clampScore(criteriaPoints, maximum),
      incorrectFactCount,
      penaltyPoints,
      awardedScore: score,
      maxScore: maximum,
    },
  };
}

export function requiresTrainingReview(
  claims: readonly TrainingUnsupportedClaim[],
  schemaVersion: TrainingEvaluationSchemaVersion,
  harmlessExtraRoutingEnabled: boolean,
) {
  if (schemaVersion === TRAINING_LEGACY_EVALUATION_SCHEMA_VERSION) {
    return claims.length > 0;
  }

  return claims.some((claim) => claim.category !== 'HARMLESS_EXTRA') ||
    (!harmlessExtraRoutingEnabled && claims.length > 0);
}

const FILLER_PHRASES = ['ээ', 'эм', 'ну', 'как бы', 'типа', 'короче', 'в общем'] as const;

export function calculateTrainingObjectiveMetrics(input: {
  transcript: string;
  audioDurationSeconds: number;
  segmentCount: number;
}): TrainingObjectiveMetrics {
  const normalized = normalizeTrainingEvidence(input.transcript).toLocaleLowerCase('ru-RU');
  const words = normalized.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  const found: string[] = [];
  let fillerWordsCount = 0;

  for (const phrase of FILLER_PHRASES) {
    const phraseWords = phrase.split(' ');
    let matches = 0;

    for (let index = 0; index <= words.length - phraseWords.length; index += 1) {
      if (phraseWords.every((word, offset) => words[index + offset] === word)) matches += 1;
    }

    if (matches > 0) {
      found.push(phrase);
      fillerWordsCount += matches;
    }
  }

  const duration = Math.max(0, Math.trunc(input.audioDurationSeconds));

  return {
    audioDurationSeconds: duration,
    segmentCount: Math.max(0, Math.trunc(input.segmentCount)),
    wordCount: words.length,
    wordsPerMinute: duration > 0 ? Math.round((words.length * 60 * 10) / duration) / 10 : 0,
    fillerWordsCount,
    fillerWordsFound: found,
  };
}

export function normalizeTrainingEvidence(value: string) {
  return value.normalize('NFC').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function clampTrainingTotalScore(score: number) {
  return clampScore(score, TRAINING_TOTAL_MAX_SCORE);
}

function parseFactAssessment(
  value: unknown,
  input: TrainingEvaluationInput,
  limits: TrainingEvaluationOutputLimits,
) {
  if (!isRecord(value)) throw new Error('INVALID_FACT_ASSESSMENT');
  assertExactKeys(value, ['fact_id', 'verdict', 'evidence', 'explanation']);
  const verdicts = new Set(['CORRECT', 'PARTIAL', 'MISSING', 'INCORRECT']);

  if (
    typeof value.fact_id !== 'string' ||
    !verdicts.has(String(value.verdict)) ||
    (value.evidence !== null && typeof value.evidence !== 'string') ||
    typeof value.explanation !== 'string' ||
    value.explanation.trim().length < 1 ||
    value.explanation.length > limits.explanationMaxChars
  ) {
    throw new Error('INVALID_FACT_ASSESSMENT');
  }

  if (value.verdict !== 'MISSING') {
    if (!value.evidence || value.evidence.length > limits.evidenceMaxChars) {
      throw new Error('FACT_EVIDENCE_REQUIRED');
    }
    assertTranscriptEvidence(value.evidence, input.transcript);
  } else if (value.evidence !== null) {
    if (value.evidence.length > limits.evidenceMaxChars) {
      throw new Error('FACT_EVIDENCE_REQUIRED');
    }
    assertTranscriptEvidence(value.evidence, input.transcript);
  }

  return {
    fact_id: value.fact_id,
    verdict: value.verdict as TrainingFactAssessment['verdict'],
    evidence: value.evidence,
    explanation: value.explanation.trim(),
  };
}

function parseCriterionAssessment(
  value: unknown,
  input: TrainingEvaluationInput,
  criteriaById: Map<string, TrainingProjectSnapshotCriterion>,
  limits: TrainingEvaluationOutputLimits,
) {
  if (!isRecord(value)) throw new Error('INVALID_CRITERION_ASSESSMENT');
  assertExactKeys(value, ['criterion_id', 'awarded_points', 'evidence', 'explanation']);
  const criterion = typeof value.criterion_id === 'string'
    ? criteriaById.get(value.criterion_id)
    : undefined;

  if (
    !criterion ||
    !Number.isInteger(value.awarded_points) ||
    (value.evidence !== null && typeof value.evidence !== 'string') ||
    typeof value.explanation !== 'string' ||
    value.explanation.trim().length < 1 ||
    value.explanation.length > limits.explanationMaxChars
  ) {
    throw new Error('INVALID_CRITERION_ASSESSMENT');
  }

  if (
    (value.awarded_points as number) < 0 ||
    (value.awarded_points as number) > criterion.maxPoints
  ) {
    throw new Error('CRITERION_POINTS_OUT_OF_RANGE');
  }

  if (typeof value.evidence === 'string') {
    if (!value.evidence.trim() || value.evidence.length > limits.evidenceMaxChars) {
      throw new Error('INVALID_CRITERION_EVIDENCE');
    }
    assertTranscriptEvidence(value.evidence, input.transcript);
  }

  return {
    criterion_id: criterion.id,
    awarded_points: value.awarded_points as number,
    evidence: value.evidence,
    explanation: value.explanation.trim(),
  };
}

function assertTranscriptEvidence(evidence: string, transcript: string) {
  const normalizedEvidence = normalizeTrainingEvidence(evidence);

  if (!normalizedEvidence || !normalizeTrainingEvidence(transcript).includes(normalizedEvidence)) {
    throw new Error('EVIDENCE_NOT_IN_TRANSCRIPT');
  }
}

function assertExactIds<T>(ids: string[], records: Map<string, T>, kind: string) {
  if (
    ids.length !== records.size ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !records.has(id))
  ) {
    throw new Error(`${kind}_IDS_MISMATCH`);
  }
}

function canonicalizeClaim(value: string) {
  return normalizeTrainingEvidence(value).toLocaleLowerCase('ru-RU');
}

function resolveEvaluationSchemaVersion(
  input: Pick<TrainingEvaluationInput, 'evaluationSchemaVersion'>,
): TrainingEvaluationSchemaVersion {
  return input.evaluationSchemaVersion ?? TRAINING_LEGACY_EVALUATION_SCHEMA_VERSION;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('EVALUATION_ADDITIONAL_PROPERTIES');
  }
}

function clampScore(score: number, maximum: number) {
  return Math.max(0, Math.min(maximum, Math.trunc(score)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
