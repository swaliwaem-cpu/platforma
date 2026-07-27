import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type {
  TrainingEvaluationCriterionInput,
  TrainingEvaluationFactFinding,
  TrainingEvaluationFactInput,
  TrainingEvaluationResult,
} from './training-attempt.providers';
import {
  canonicalTrainingScore,
  clampTrainingScore,
  subtractTrainingScore,
  sumTrainingScores,
} from './training-score-decimal';

export const TRAINING_INCORRECT_FACT_PENALTY = canonicalTrainingScore(5);

export type TrainingScoreComponentInput = {
  criterionId?: string;
  factId?: string;
  componentKey: string;
  title: string;
  awardedPoints: Prisma.Decimal;
  maxPoints: Prisma.Decimal;
  factVerdict?:
    | 'CORRECT'
    | 'PARTIAL'
    | 'MISSING'
    | 'INCORRECT'
    | 'UNSUPPORTED';
  evidence: Record<string, unknown> | null;
  penaltyPoints: Prisma.Decimal;
};

export type TrainingScoredEvaluation = {
  aiSuggestedScore: Prisma.Decimal;
  serverScore: Prisma.Decimal;
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
  const scoresByCriterion = new Map<string, Prisma.Decimal>();
  const evidenceByCriterion = new Map<string, Record<string, unknown>>();

  for (const score of input.evaluation.criterionScores) {
    const criterion = criteriaById.get(score.criterionId);
    if (!criterion) {
      throw new BadRequestException('Evaluation returned an unknown criterion');
    }
    if (scoresByCriterion.has(score.criterionId)) {
      throw new BadRequestException('Evaluation returned a duplicate criterion');
    }
    const anchor = score.anchorId
      ? criterion.anchors.find((candidate) => candidate.id === score.anchorId)
      : undefined;
    if (score.anchorId && !anchor) {
      throw new BadRequestException('Evaluation returned an unknown anchor');
    }
    if (!anchor && score.awardedPoints === undefined) {
      throw new BadRequestException(
        'Evaluation did not select an approved anchor',
      );
    }
    scoresByCriterion.set(
      score.criterionId,
      clampTrainingScore(
        anchor?.points ?? score.awardedPoints ?? 0,
        0,
        criterion.maxPoints,
      ),
    );
    evidenceByCriterion.set(score.criterionId, {
      ...(score.evidenceSource ? { source: score.evidenceSource } : {}),
      ...(score.evidence ? { text: score.evidence } : {}),
      ...(score.metricId ? { metricId: score.metricId } : {}),
      ...(score.anchorId ? { anchorId: score.anchorId } : {}),
      ...(score.explanation ? { explanation: score.explanation } : {}),
    });
  }

  const components: TrainingScoreComponentInput[] = input.criteria.map((criterion) => ({
    criterionId: criterion.id,
    componentKey: `criterion:${criterion.id}`,
    title: criterion.title,
    awardedPoints:
      scoresByCriterion.get(criterion.id) ?? canonicalTrainingScore(0),
    maxPoints: canonicalTrainingScore(criterion.maxPoints),
    evidence: evidenceByCriterion.get(criterion.id) ?? null,
    penaltyPoints: canonicalTrainingScore(0),
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
      awardedPoints: canonicalTrainingScore(0),
      maxPoints: canonicalTrainingScore(0),
      factVerdict: 'INCORRECT',
      evidence: evidence ? { text: evidence } : null,
      penaltyPoints: TRAINING_INCORRECT_FACT_PENALTY,
    });
  }

  for (const claim of [...unsupportedClaims].sort()) {
    components.push({
      componentKey: `unsupported:${createHash('sha256').update(claim).digest('hex').slice(0, 24)}`,
      title: claim.slice(0, 240),
      awardedPoints: canonicalTrainingScore(0),
      maxPoints: canonicalTrainingScore(0),
      factVerdict: 'UNSUPPORTED',
      evidence: { claim },
      penaltyPoints: canonicalTrainingScore(0),
    });
  }

  const criterionTotal = sumTrainingScores(
    components
      .filter((component) => component.criterionId)
      .map((component) => component.awardedPoints),
  );
  const penaltyTotal = canonicalTrainingScore(
    TRAINING_INCORRECT_FACT_PENALTY.mul(incorrectFacts.size),
  );

  return {
    aiSuggestedScore: clampTrainingScore(
      criterionTotal,
      0,
      input.questionMaxScore,
    ),
    serverScore: clampTrainingScore(
      subtractTrainingScore(criterionTotal, penaltyTotal),
      0,
      input.questionMaxScore,
    ),
    requiresReview:
      unsupportedClaims.size > 0 ||
      (input.evaluation.requiresManualReview ?? false),
    reviewReasons: [
      ...new Set([
        ...[...unsupportedClaims].map((claim) => `UNSUPPORTED:${claim}`),
        ...(input.evaluation.reviewReasons ?? []).map(
          (reason) => `PROVIDER_REVIEW:${reason}`,
        ),
      ]),
    ],
    components,
  };
}

export function clampTrainingAttemptScore(
  value: Prisma.Decimal | number | string,
) {
  return clampTrainingScore(value, 0, 100);
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
    throw new BadRequestException('Evaluation returned an unknown fact');
  }
}

function normalizeClaim(value: string | undefined) {
  return value?.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU') ?? '';
}
