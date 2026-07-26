import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import type {
  TrainingEvaluationCriterionInput,
  TrainingEvaluationFactFinding,
  TrainingEvaluationFactInput,
  TrainingEvaluationResult,
} from './training-attempt.providers';

export const TRAINING_INCORRECT_FACT_PENALTY = 5;

export type TrainingScoreComponentInput = {
  criterionId?: string;
  factId?: string;
  componentKey: string;
  title: string;
  awardedPoints: number;
  maxPoints: number;
  factVerdict?:
    | 'CORRECT'
    | 'PARTIAL'
    | 'MISSING'
    | 'INCORRECT'
    | 'UNSUPPORTED';
  evidence: Record<string, unknown> | null;
  penaltyPoints: number;
};

export type TrainingScoredEvaluation = {
  aiSuggestedScore: number;
  serverScore: number;
  requiresReview: boolean;
  reviewReasons: string[];
  components: TrainingScoreComponentInput[];
};

export function scoreTrainingEvaluation(input: {
  questionMaxScore: number;
  criteria: TrainingEvaluationCriterionInput[];
  facts: TrainingEvaluationFactInput[];
  evaluation: TrainingEvaluationResult;
}): TrainingScoredEvaluation {
  const criteriaById = new Map(input.criteria.map((criterion) => [criterion.id, criterion]));
  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const scoresByCriterion = new Map<string, number>();

  for (const score of input.evaluation.criterionScores) {
    const criterion = criteriaById.get(score.criterionId);
    if (!criterion) {
      throw new BadRequestException('Fake evaluation returned an unknown criterion');
    }
    if (scoresByCriterion.has(score.criterionId)) {
      throw new BadRequestException('Fake evaluation returned a duplicate criterion');
    }
    scoresByCriterion.set(
      score.criterionId,
      clampFinite(score.awardedPoints, 0, criterion.maxPoints),
    );
  }

  const components: TrainingScoreComponentInput[] = input.criteria.map((criterion) => ({
    criterionId: criterion.id,
    componentKey: `criterion:${criterion.id}`,
    title: criterion.title,
    awardedPoints: scoresByCriterion.get(criterion.id) ?? 0,
    maxPoints: criterion.maxPoints,
    evidence: null,
    penaltyPoints: 0,
  }));
  const incorrectFacts = new Set<string>();
  const unsupportedClaims = new Set<string>();

  for (const finding of input.evaluation.factFindings) {
    validateFactFinding(finding, factsById);

    if (finding.verdict === 'INCORRECT' && finding.factId) {
      incorrectFacts.add(finding.factId);
    }
    if (finding.verdict === 'UNSUPPORTED') {
      const normalizedClaim = normalizeClaim(finding.claim);
      if (normalizedClaim) {
        unsupportedClaims.add(normalizedClaim);
      }
    }
  }

  for (const factId of [...incorrectFacts].sort()) {
    const fact = factsById.get(factId)!;
    const evidence = input.evaluation.factFindings.find(
      (finding) => finding.verdict === 'INCORRECT' && finding.factId === factId,
    )?.evidence;
    components.push({
      factId,
      componentKey: `fact:${factId}:incorrect`,
      title: fact.code,
      awardedPoints: 0,
      maxPoints: 0,
      factVerdict: 'INCORRECT',
      evidence: evidence ? { text: evidence } : null,
      penaltyPoints: TRAINING_INCORRECT_FACT_PENALTY,
    });
  }

  for (const claim of [...unsupportedClaims].sort()) {
    components.push({
      componentKey: `unsupported:${createHash('sha256').update(claim).digest('hex').slice(0, 24)}`,
      title: claim.slice(0, 240),
      awardedPoints: 0,
      maxPoints: 0,
      factVerdict: 'UNSUPPORTED',
      evidence: { claim },
      penaltyPoints: 0,
    });
  }

  const criterionTotal = components
    .filter((component) => component.criterionId)
    .reduce((total, component) => total + component.awardedPoints, 0);
  const penaltyTotal = incorrectFacts.size * TRAINING_INCORRECT_FACT_PENALTY;

  return {
    aiSuggestedScore: clampFinite(
      input.evaluation.aiSuggestedScore,
      0,
      input.questionMaxScore,
    ),
    serverScore: clampFinite(
      criterionTotal - penaltyTotal,
      0,
      input.questionMaxScore,
    ),
    requiresReview: unsupportedClaims.size > 0,
    reviewReasons: [...unsupportedClaims].map((claim) => `UNSUPPORTED:${claim}`),
    components,
  };
}

export function clampTrainingAttemptScore(value: number) {
  return clampFinite(value, 0, 100);
}

function validateFactFinding(
  finding: TrainingEvaluationFactFinding,
  factsById: Map<string, TrainingEvaluationFactInput>,
) {
  if (finding.verdict === 'UNSUPPORTED') {
    if (!normalizeClaim(finding.claim)) {
      throw new BadRequestException('Unsupported claim text is required');
    }
    if (finding.factId) {
      throw new BadRequestException('Unsupported claim cannot reference an approved fact');
    }
    return;
  }

  if (!finding.factId || !factsById.has(finding.factId)) {
    throw new BadRequestException('Fake evaluation returned an unknown fact');
  }
}

function normalizeClaim(value: string | undefined) {
  return value?.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU') ?? '';
}

function clampFinite(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) {
    throw new BadRequestException('Fake evaluation returned a non-finite score');
  }
  return Math.min(maximum, Math.max(minimum, value));
}
